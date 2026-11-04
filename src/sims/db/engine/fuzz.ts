/**
 * A crash fuzzer for TinyKv, in the style of real engine test harnesses.
 *
 * A trace is a list of client operations plus crash points. A crash point names an operation and
 * the n-th I/O point (write or fsync) inside it, counting the I/O of the recovery that follows a
 * crash, so a second crash point in the same operation can hit recovery itself.
 *
 * The oracle (what must be true after every recovery):
 * - state:   the recovered key/value state equals the result of the first j commit attempts, for
 *            some j with acked <= j <= attempts. Acknowledged commits survive; a commit that was in
 *            flight may or may not survive; nothing else appears.
 * - wal:     no page on disk has a pageLSN past the durable end of the log.
 * - tree:    the B+ tree invariants hold.
 * - read:    every get() returns the value of its transaction's snapshot (plus its own writes).
 * - error:   the engine throws nothing unexpected.
 * A CorruptPageError is "detected": the engine stopped instead of returning wrong data.
 *
 * `shrink` reduces a failing trace to a small one that still fails (delta debugging).
 */
import { mulberry32 } from "../../rng";
import {
  TinyKv, reopen, oracleState, sameMap, CrashSignal, ConflictError, CorruptPageError,
  type KvConfig, type IoKind, type IoCtx, type DurableImage,
} from "./kv";

export type Op =
  | { k: "begin"; c: number }
  | { k: "put"; c: number; key: string; val: string }
  | { k: "del"; c: number; key: string }
  | { k: "get"; c: number; key: string }
  | { k: "commit"; c: number }
  | { k: "abort"; c: number }
  | { k: "ckpt" }
  | { k: "sync" }
  | { k: "crash" };

export interface CrashPoint { op: number; io: number }
export interface Trace { ops: Op[]; crashes: CrashPoint[]; seed: number }

export type ViolationKind = "state" | "lost-ack" | "wal" | "tree" | "read" | "error";
export interface Violation { kind: ViolationKind; op: number; text: string }

export interface RunResult {
  ok: boolean;
  violations: Violation[];
  /** The engine stopped on a page it could not trust. */
  detected: string | null;
  crashes: number;
  recoveries: number;
  /** (I/O kind, context) of every crash that fired. */
  crashCells: { kind: IoKind; ctx: IoCtx }[];
  /** I/O points per operation, when run without crashes. */
  ioPerOp: number[];
  /** Every I/O point of the run: the operation, its index inside the operation, kind and context. */
  ioEvents: { op: number; io: number; kind: IoKind; ctx: IoCtx }[];
  /** Human-readable replay (when verbose). */
  lines: TraceLine[];
}

export interface TraceLine { op: number; text: string; tone?: "crash" | "bad" | "ok" | "note" }

export const clientName = (c: number) => "ABCDEFGH"[c] ?? `C${c}`;

export function opText(o: Op): string {
  switch (o.k) {
    case "begin": return `${clientName(o.c)}: begin`;
    case "put": return `${clientName(o.c)}: put ${o.key} = ${o.val}`;
    case "del": return `${clientName(o.c)}: delete ${o.key}`;
    case "get": return `${clientName(o.c)}: get ${o.key}`;
    case "commit": return `${clientName(o.c)}: commit`;
    case "abort": return `${clientName(o.c)}: abort`;
    case "ckpt": return "checkpoint";
    case "sync": return "flush the log";
    case "crash": return "power cut";
  }
}

/** Engine settings that the fuzzer uses: small pages and a small pool, so splits and evictions happen often. */
export const FUZZ_CFG: Partial<KvConfig> = { leafCap: 4, innerCap: 8, frames: 8, groupCommit: 1, faults: { torn: true } };

/** Replays a trace against a fresh engine and checks the oracle after every recovery and at the end. */
export function replay(trace: Trace, cfg: Partial<KvConfig> = FUZZ_CFG, verbose = false): RunResult {
  const rng = mulberry32(trace.seed);
  let eng = new TinyKv(cfg, undefined, rng);
  const res: RunResult = { ok: true, violations: [], detected: null, crashes: 0, recoveries: 0, crashCells: [], ioPerOp: [], ioEvents: [], lines: [] };
  const line = (op: number, text: string, tone?: TraceLine["tone"]) => { if (verbose) res.lines.push({ op, text, tone }); };
  const bad = (kind: ViolationKind, op: number, text: string) => { res.violations.push({ kind, op, text }); line(op, text, "bad"); };
  const clients = new Map<number, { txn: number; snap: Map<string, string>; writes: Map<string, string | null> }>();
  let visible = new Map<string, string>();
  let opIo = 0;
  let pending: number[] = [];
  let curOp = 0;
  const plan = (e: { kind: IoKind; ctx: IoCtx }) => {
    opIo++;
    res.ioEvents.push({ op: curOp, io: opIo, kind: e.kind, ctx: e.ctx });
    if (pending.length && opIo === pending[0]) {
      pending.shift();
      res.crashCells.push({ kind: e.kind, ctx: e.ctx });
      return true;
    }
    return false;
  };

  /** Crash, then recover (recovery can crash again). Returns false when the run must stop. */
  const crashAndRecover = (i: number): boolean => {
    for (;;) {
      res.crashes++;
      const img: DurableImage = eng.crash(rng);
      const wal = eng.walViolations(img);
      if (wal.length) bad("wal", i, `WAL rule broken on disk: page ${wal.join(", ")} is newer than the durable log (${img.log.length} records).`);
      line(i, `Disk after the crash: ${img.log.length} log records survive (${img.lostLogRecords} lost), ${img.lostPageWrites} unsynced page write(s) lost${img.tornPages.length ? `, page ${img.tornPages.join(", ")} torn` : ""}${img.flippedPage !== null ? `, a bit flipped in page ${img.flippedPage}` : ""}.`, "note");
      const next = reopen(img, rng);
      next.crashPlan = plan;
      eng = next;
      clients.clear();
      try {
        const r = eng.recover();
        res.recoveries++;
        line(i, `Recovery: redo from LSN ${r.redoFrom || "none"}, ${r.redone} record(s) redone, ${r.imagesInstalled} page image(s), ${r.losers.length} loser(s) undone with ${r.clrs} CLR(s).`, "ok");
        break;
      } catch (e) {
        if (e instanceof CrashSignal) { line(i, `Power cut again during recovery, at ${e.at.kind} (${e.at.ctx}).`, "crash"); continue; }
        if (e instanceof CorruptPageError) { res.detected = e.message; line(i, `Recovery stops: ${e.message}.`, "bad"); return false; }
        bad("error", i, `Recovery threw: ${(e as Error).message}`);
        return false;
      }
    }
    // The oracle.
    let state: Map<string, string>;
    try { state = eng.scanAll(); } catch (e) {
      if (e instanceof CorruptPageError) { res.detected = e.message; line(i, `Scan stops: ${e.message}.`, "bad"); return false; }
      bad("error", i, `Scan threw: ${(e as Error).message}`);
      return false;
    }
    const tree = eng.checkTree();
    if (tree.length) bad("tree", i, `B+ tree broken: ${tree[0]}`);
    const o = eng.oracle;
    let j = -1;
    let s = oracleState(o, o.acked);
    if (sameMap(s, state)) j = o.acked;
    for (let x = o.acked; j < 0 && x < o.attempts.length; x++) {
      for (const [k, v] of o.attempts[x]!.writes) { if (v === null) s.delete(k); else s.set(k, v); }
      if (sameMap(s, state)) j = x + 1;
    }
    if (j < 0) {
      let lost = -1;
      for (let x = o.acked - 1; x >= 0 && lost < 0; x--) if (sameMap(oracleState(o, x), state)) lost = x;
      const want = oracleState(o, o.acked);
      const diff = [...new Set([...want.keys(), ...state.keys()])].sort().filter((k) => want.get(k) !== state.get(k)).slice(0, 3).map((k) => `${k} is ${state.get(k) ?? "absent"}, expected ${want.get(k) ?? "absent"}`);
      if (lost >= 0) bad("lost-ack", i, `Acknowledged commit lost: the state is that of ${lost} commit(s), but ${o.acked} were acknowledged. ${diff.join("; ")}.`);
      else bad("state", i, `The state matches no prefix of the commits: ${diff.join("; ")}.`);
      return false;
    }
    line(i, `Oracle: the state equals the first ${j} commit(s) (${o.acked} acknowledged, ${o.attempts.length} attempted).`, "ok");
    o.attempts.length = j;
    o.acked = j;
    visible = oracleState(o, j);
    return true;
  };

  outer: for (let i = 0; i < trace.ops.length; i++) {
    const op = trace.ops[i]!;
    opIo = 0;
    curOp = i;
    pending = trace.crashes.filter((c) => c.op === i).map((c) => c.io).sort((a, b) => a - b);
    eng.crashPlan = plan;
    let crashed = op.k === "crash";
    const cl = "c" in op ? clients.get(op.c) : undefined;
    try {
      switch (op.k) {
        case "begin":
          if (clients.has(op.c)) break;
          clients.set(op.c, { txn: eng.begin(), snap: new Map(visible), writes: new Map() });
          line(i, opText(op));
          break;
        case "put": case "del":
          if (!cl) break;
          line(i, opText(op));
          if (op.k === "put") eng.put(cl.txn, op.key, op.val); else eng.del(cl.txn, op.key);
          cl.writes.set(op.key, op.k === "put" ? op.val : null);
          break;
        case "get": {
          if (!cl) break;
          const got = eng.get(cl.txn, op.key);
          const want = cl.writes.has(op.key) ? cl.writes.get(op.key) ?? undefined : cl.snap.get(op.key);
          line(i, `${opText(op)} → ${got ?? "absent"}`);
          if (got !== want) bad("read", i, `Snapshot read of ${op.key} returned ${got ?? "absent"}, expected ${want ?? "absent"}.`);
          break;
        }
        case "commit": {
          if (!cl) break;
          const n = eng.oracle.attempts.length;
          clients.delete(op.c);
          line(i, opText(op));
          eng.commit(cl.txn);
          if (eng.oracle.attempts.length > n) for (const [k, v] of eng.oracle.attempts[n]!.writes) { if (v === null) visible.delete(k); else visible.set(k, v); }
          break;
        }
        case "abort":
          if (!cl) break;
          clients.delete(op.c);
          line(i, opText(op));
          eng.abort(cl.txn);
          break;
        case "ckpt": line(i, opText(op)); eng.checkpoint(); break;
        case "sync": line(i, opText(op)); eng.sync(); break;
        case "crash": line(i, opText(op), "crash"); break;
      }
    } catch (e) {
      if (e instanceof CrashSignal) { crashed = true; line(i, `Power cut at I/O point ${opIo}: ${e.at.kind} (${e.at.ctx}${e.at.page !== undefined ? `, page ${e.at.page}` : ""}).`, "crash"); }
      else if (e instanceof ConflictError) { if ("c" in op) clients.delete(op.c); line(i, `Write conflict: ${e.why}. The transaction aborts.`, "note"); }
      else if (e instanceof CorruptPageError) { res.detected = e.message; line(i, `The engine stops: ${e.message}.`, "bad"); break outer; }
      else { bad("error", i, `Engine threw: ${(e as Error).message}`); break outer; }
    }
    res.ioPerOp.push(opIo);
    if (crashed && !crashAndRecover(i)) break;
  }
  if (!res.detected && !res.violations.some((v) => v.kind === "error" || v.kind === "state" || v.kind === "lost-ack")) {
    opIo = 0;
    pending = [];
    curOp = trace.ops.length;
    line(trace.ops.length, "Final power cut, then recovery and the oracle.", "crash");
    crashAndRecover(trace.ops.length);
  }
  res.ok = res.violations.length === 0 && res.detected === null;
  return res;
}

// ---------------------------------------------------------------- random traces

export interface GenOptions {
  ops: number;
  keys: number;
  maxLive: number;
  /** Mid-operation crash points (power cuts at an I/O point). */
  crashes: number;
  /** Chance that a crash point also gets a second crash inside the recovery that follows. */
  pRecoveryCrash: number;
}
export const GEN_DEFAULTS: GenOptions = { ops: 60, keys: 64, maxLive: 3, crashes: 1, pRecoveryCrash: 0.4 };

export const keyName = (i: number) => `k${String(i).padStart(2, "0")}`;

/**
 * A random workload; crash points are placed on real I/O points of the workload (a dry run finds
 * them). With `weight`, a point of kind and context (k, c) is chosen with probability proportional
 * to weight(k, c): coverage-guided fuzzing gives rarely hit cells a larger weight.
 */
export function randomTrace(seed: number, o: Partial<GenOptions> = {}, cfg: Partial<KvConfig> = FUZZ_CFG, weight?: (kind: IoKind, ctx: IoCtx) => number): Trace {
  const g = { ...GEN_DEFAULTS, ...o };
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const ops: Op[] = [];
  const live = new Set<number>();
  let val = 0;
  const n = Math.max(4, Math.round(g.ops * (0.5 + rng())));
  for (let i = 0; i < n; i++) {
    const r = rng();
    const pick = () => [...live][Math.floor(rng() * live.size)]!;
    const key = () => keyName(Math.floor(rng() * g.keys));
    if (live.size === 0 || (live.size < g.maxLive && r < 0.12)) {
      let c = 0;
      while (live.has(c)) c++;
      live.add(c);
      ops.push({ k: "begin", c });
    } else if (r < 0.55) ops.push({ k: "put", c: pick(), key: key(), val: `v${++val}` });
    else if (r < 0.6) ops.push({ k: "del", c: pick(), key: key() });
    else if (r < 0.72) ops.push({ k: "get", c: pick(), key: key() });
    else if (r < 0.86) { const c = pick(); live.delete(c); ops.push({ k: "commit", c }); }
    else if (r < 0.92) { const c = pick(); live.delete(c); ops.push({ k: "abort", c }); }
    else if (r < 0.95) ops.push({ k: "ckpt" });
    else if (r < 0.98) ops.push({ k: "sync" });
    else { ops.push({ k: "crash" }); live.clear(); }
  }
  const t: Trace = { ops, crashes: [], seed };
  const dry = replay(t, cfg);
  const points = dry.ioEvents.filter((e) => e.op < ops.length);
  const w = points.map((e) => (weight ? weight(e.kind, e.ctx) : 1));
  const total = w.reduce((a, b) => a + b, 0);
  for (let k = 0; k < g.crashes && points.length; k++) {
    let x = rng() * total, idx = 0;
    while (idx < points.length - 1 && x >= w[idx]!) { x -= w[idx]!; idx++; }
    const p = { op: points[idx]!.op, io: points[idx]!.io };
    if (t.crashes.some((c) => c.op === p.op)) continue;
    t.crashes.push(p);
    if (rng() < g.pRecoveryCrash) t.crashes.push({ op: p.op, io: p.io + 1 + Math.floor(rng() * 30) });
  }
  return t;
}

// ---------------------------------------------------------------- shrinking

/** Violation kinds, most severe first. */
export const SEVERITY: ViolationKind[] = ["lost-ack", "state", "read", "tree", "error", "wal"];

/** Removes ops [a, b) and moves crash points that follow. Returns null if a crash point is inside the range. */
function cut(t: Trace, a: number, b: number): Trace | null {
  if (t.crashes.some((c) => c.op >= a && c.op < b)) return null;
  return { seed: t.seed, ops: [...t.ops.slice(0, a), ...t.ops.slice(b)], crashes: t.crashes.map((c) => (c.op >= b ? { ...c, op: c.op - (b - a) } : c)) };
}

/**
 * Delta debugging: tries to drop crash points, then chunks of operations (halves, quarters, ...,
 * single ops), and keeps any change after which the run still fails. A generator, so a demo can
 * run it in small slices. The return value is the smallest failing trace found.
 */
export function* shrink(t0: Trace, cfg: Partial<KvConfig> = FUZZ_CFG, maxTries = 4000): Generator<{ tries: number; ops: number }, Trace> {
  // Keep the most severe kind of failure of the original run, so the small trace shows the same bug.
  const r0 = replay(t0, cfg);
  const target = SEVERITY.find((k) => r0.violations.some((v) => v.kind === k)) ?? "detected";
  const fails = (t: Trace) => { const r = replay(t, cfg); return target === "detected" ? r.detected !== null : r.violations.some((v) => v.kind === target); };
  let t = t0, tries = 0;
  for (let i = t.crashes.length - 1; i >= 0; i--) {
    const c = { ...t, crashes: t.crashes.filter((_, k) => k !== i) };
    tries++;
    if (fails(c)) t = c;
  }
  let chunk = Math.max(1, Math.floor(t.ops.length / 2));
  while (chunk >= 1 && tries < maxTries) {
    let changed = false;
    for (let a = 0; a < t.ops.length && tries < maxTries; ) {
      const c = cut(t, a, Math.min(t.ops.length, a + chunk));
      if (c) {
        tries++;
        if (fails(c)) { t = c; changed = true; yield { tries, ops: t.ops.length }; continue; }
      }
      a += chunk;
      if (tries % 8 === 0) yield { tries, ops: t.ops.length };
    }
    if (!changed) chunk = Math.floor(chunk / 2);
  }
  // Drop ops that do nothing in the minimal trace (for example a get), one by one.
  for (let a = t.ops.length - 1; a >= 0 && tries < maxTries; a--) {
    const c = cut(t, a, a + 1);
    tries++;
    if (c && fails(c)) t = c;
  }
  return t;
}

/** Runs a generator to completion (tests and scripts). */
export function finish<T>(g: Generator<unknown, T>): T {
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

// ---------------------------------------------------------------- a campaign (many runs)

export interface CampaignStats {
  runs: number;
  crashes: number;
  recoveries: number;
  passed: number;
  violations: number;
  detected: number;
  /** Crashes per (I/O kind, context) cell. */
  cells: Map<string, number>;
  /** The first failing trace. */
  firstFail: { trace: Trace; result: RunResult; run: number } | null;
}

export const cellKey = (kind: IoKind, ctx: IoCtx) => `${kind}|${ctx}`;

export class Campaign {
  s: CampaignStats = { runs: 0, crashes: 0, recoveries: 0, passed: 0, violations: 0, detected: 0, cells: new Map(), firstFail: null };
  constructor(readonly cfg: Partial<KvConfig>, readonly gen: Partial<GenOptions> = {}, readonly seed0 = 1, readonly guided = false) {}
  /** Runs `n` more random traces. */
  run(n: number) {
    for (let i = 0; i < n; i++) {
      const seed = this.seed0 + this.s.runs * 7919;
      const t = randomTrace(seed, this.gen, this.cfg, this.guided ? (k, c) => 1 / (1 + (this.s.cells.get(cellKey(k, c)) ?? 0)) ** 2 : undefined);
      const r = replay(t, this.cfg);
      this.s.runs++;
      this.s.crashes += r.crashes;
      this.s.recoveries += r.recoveries;
      for (const c of r.crashCells) { const k = cellKey(c.kind, c.ctx); this.s.cells.set(k, (this.s.cells.get(k) ?? 0) + 1); }
      if (r.ok) this.s.passed++;
      else if (r.violations.length) this.s.violations++;
      else this.s.detected++;
      if (!r.ok && !this.s.firstFail) this.s.firstFail = { trace: t, result: r, run: this.s.runs };
    }
  }
}

/** Runs campaigns until the first failure; returns the run number (1-based) or null within `maxRuns`. */
export function runsToFirstFailure(cfg: Partial<KvConfig>, maxRuns = 400, gen: Partial<GenOptions> = {}, seed0 = 1): number | null {
  const c = new Campaign(cfg, gen, seed0);
  while (c.s.runs < maxRuns) { c.run(1); if (c.s.firstFail) return c.s.firstFail.run; }
  return null;
}

/**
 * Finds the first failing run of a default campaign (seeds as in Campaign) and shrinks its trace.
 * With `want`, only a run that shows one of these violation kinds counts.
 */
export function findAndShrink(cfg: Partial<KvConfig>, maxRuns = 400, want?: ViolationKind[], gen: Partial<GenOptions> = {}, seed0 = 1): { run: number; found: Trace; minimal: Trace } | null {
  for (let run = 1; run <= maxRuns; run++) {
    const t = randomTrace(seed0 + (run - 1) * 7919, gen, cfg);
    const r = replay(t, cfg);
    if (r.ok) continue;
    if (want && !r.violations.some((v) => want.includes(v.kind))) continue;
    const target = want ? { ...t } : t;
    return { run, found: t, minimal: finish(shrink(target, cfg)) };
  }
  return null;
}
