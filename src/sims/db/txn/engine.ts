/**
 * A small transactional engine that runs scripted transactions one operation at a time under a chosen
 * isolation level, plus an exhaustive explorer of all interleavings.
 *
 * Levels:
 * - NONE     no concurrency control: one shared copy, no locks (to show what each anomaly looks like).
 * - RU       READ UNCOMMITTED with locks: long X locks on writes, no read locks.
 * - RC       READ COMMITTED with locks: long X locks, a read waits while another transaction holds X.
 * - RC-MVCC  READ COMMITTED as in PostgreSQL and Oracle: a new snapshot for every statement; a write waits for an
 *            uncommitted writer of the same row and then writes on top of the new version.
 * - RR       REPEATABLE READ with locks: long S and X locks on rows, no predicate locks.
 * - SER      SERIALIZABLE with strict two-phase locking and predicate (group) locks: a scan takes S on the group,
 *            a write takes IX on the group and X on the row.
 * - SI       snapshot isolation: one snapshot per transaction, first-updater-wins on write-write conflicts.
 * - SSI      serializable snapshot isolation: SI plus rw-antidependency tracking with SIREAD marks; it aborts a
 *            transaction in a dangerous structure T_in →rw T_pivot →rw T_out where T_out commits first.
 * - SSI-BASIC the first SSI rule of Cahill et al.: abort as soon as a transaction has both an incoming and an
 *            outgoing rw edge, with no commit-order test (more false positives). Not part of LEVELS.
 *
 * Lock-based levels keep one version per row and an undo list per transaction. MVCC levels keep a version
 * chain per row. A blocked transaction waits until every transaction that it waits for has finished; a cycle of
 * waits is a deadlock, and the transaction that closes the cycle aborts.
 *
 * An outcome is an anomaly when the reads and the final state of the committed transactions do not equal those
 * of any serial execution of the same committed transactions.
 */
import { permutations } from "./schedule";

export type Level = "NONE" | "RU" | "RC" | "RC-MVCC" | "RR" | "SER" | "SI" | "SSI" | "SSI-BASIC";

export const LEVELS: { id: Level; short: string; name: string; mvcc: boolean }[] = [
  { id: "NONE", short: "none", name: "No control", mvcc: false },
  { id: "RU", short: "RU", name: "Read uncommitted (locks)", mvcc: false },
  { id: "RC", short: "RC", name: "Read committed (locks)", mvcc: false },
  { id: "RC-MVCC", short: "RC-s", name: "Read committed (snapshot per statement)", mvcc: true },
  { id: "RR", short: "RR", name: "Repeatable read (locks)", mvcc: false },
  { id: "SER", short: "2PL", name: "Serializable (2PL + predicate locks)", mvcc: false },
  { id: "SI", short: "SI", name: "Snapshot isolation", mvcc: true },
  { id: "SSI", short: "SSI", name: "Serializable snapshot isolation", mvcc: true },
];
export const isMvcc = (l: Level) => l === "RC-MVCC" || l === "SI" || l === "SSI" || l === "SSI-BASIC";
const isSsi = (l: Level) => l === "SSI" || l === "SSI-BASIC";
/** Levels that keep SIREAD marks. SI keeps them only so that demos can draw rw edges; it never acts on them. */
const marksReads = (l: Level) => l === "SI" || isSsi(l);

export type Locals = Record<string, number>;
export type TOp =
  | { k: "r"; key: string }
  | { k: "w"; key: string; f: (l: Locals) => number; expr: string; when?: (l: Locals) => boolean; whenText?: string }
  | { k: "scan"; group: string; as: string }
  | { k: "c" }
  | { k: "a" };

export interface TxnProg { ops: TOp[]; readOnly?: boolean }

export interface Scenario {
  id: string;
  name: string;
  /** The anomaly code from Berenson et al. 1995 (P0, A1, ...) or a short tag. */
  code: string;
  init: Record<string, number>;
  txns: TxnProg[];
  /** The classic interleaving: the transaction to run at each step. */
  classic: number[];
  /** One sentence: what goes wrong. */
  bad: string;
}

/** "doc:alice" belongs to group "doc"; keys without a colon have no group. */
export const groupOf = (key: string): string | null => (key.includes(":") ? key.split(":")[0]! : null);
const G = (g: string) => `g:${g}`;

// ---------------------------------------------------------------- state

export type Mode = "S" | "X" | "IS" | "IX";
const COMPAT: Record<Mode, Mode[]> = { S: ["S", "IS"], X: [], IS: ["S", "IS", "IX"], IX: ["IS", "IX"] };
const compatible = (a: Mode, b: Mode) => COMPAT[a].includes(b);

export type Status = "active" | "blocked" | "committed" | "aborted";
export interface TxnState {
  id: number;
  pc: number;
  status: Status;
  waitFor: number[];
  locals: Locals;
  obs: string[];
  started: boolean;
  /** Snapshot time (SI, SSI) and start time for every level. */
  snap: number;
  commitTs: number | null;
  doomed: boolean;
  abortReason: string | null;
  blockedEver: boolean;
}
export interface Version { value: number; txn: number; commitTs: number | null }
export interface DepEdge { from: number; to: number; kind: "rw" | "wr" | "ww"; key: string }
export interface EEvent { t: number; kind: "read" | "write" | "skip" | "block" | "abort" | "commit" | "edge" | "doom"; text: string }

export interface EState {
  level: Level;
  clock: number;
  txns: TxnState[];
  /** Lock-based levels: the single current value of each row. */
  store: Record<string, number>;
  undo: { t: number; key: string; before: number | null }[];
  locks: Record<string, Record<number, Mode[]>>;
  /** MVCC levels: version chain of each row, oldest first. */
  versions: Record<string, Version[]>;
  /** SSI: which transactions read each row or group. */
  siread: Record<string, number[]>;
  edges: DepEdge[];
  events: EEvent[];
}

export const tname = (t: number) => (t < 0 ? "init" : `T${t + 1}`);

export function initState(sc: Scenario, level: Level): EState {
  const versions: Record<string, Version[]> = {};
  for (const [k, v] of Object.entries(sc.init)) versions[k] = [{ value: v, txn: -1, commitTs: 0 }];
  return {
    level,
    clock: 0,
    txns: sc.txns.map((_, id) => ({
      id, pc: 0, status: "active", waitFor: [], locals: {}, obs: [], started: false, snap: 0, commitTs: null,
      doomed: false, abortReason: null, blockedEver: false,
    })),
    store: { ...sc.init },
    undo: [],
    locks: {},
    versions,
    siread: {},
    edges: [],
    events: [],
  };
}

export const cloneState = (s: EState): EState => structuredClone(s);

const finished = (x: TxnState) => x.status === "committed" || x.status === "aborted";

/** Transactions that can take a step now. */
export function runnable(st: EState, sc: Scenario): number[] {
  return st.txns
    .filter((x) => {
      if (finished(x)) return false;
      if (x.pc >= sc.txns[x.id]!.ops.length) return false;
      if (x.status === "blocked") return x.waitFor.every((w) => finished(st.txns[w]!));
      return true;
    })
    .map((x) => x.id);
}

export const isDone = (st: EState) => st.txns.every(finished);

// ---------------------------------------------------------------- locks

/** Other transactions that hold a mode incompatible with `mode` on `res`. */
function lockBlockers(st: EState, t: number, res: string, mode: Mode): number[] {
  const holders = st.locks[res] ?? {};
  const out: number[] = [];
  for (const [h, modes] of Object.entries(holders)) {
    const id = Number(h);
    if (id !== t && modes.some((m) => !compatible(m, mode))) out.push(id);
  }
  return out;
}

/** Tries to take all locks at once. Returns the blockers (empty means granted). */
function acquire(st: EState, t: number, req: [string, Mode][]): number[] {
  const blockers = new Set<number>();
  for (const [res, mode] of req) for (const b of lockBlockers(st, t, res, mode)) blockers.add(b);
  if (blockers.size) return [...blockers].sort();
  for (const [res, mode] of req) {
    const h = (st.locks[res] ??= {});
    const m = (h[t] ??= []);
    if (!m.includes(mode)) m.push(mode);
  }
  return [];
}

function releaseLocks(st: EState, t: number) {
  for (const res of Object.keys(st.locks)) {
    delete st.locks[res]![t];
    if (Object.keys(st.locks[res]!).length === 0) delete st.locks[res];
  }
}

/** Waits-for cycle through t, or null. */
function waitCycle(st: EState, t: number): number[] | null {
  const path: number[] = [];
  const seen = new Set<number>();
  const dfs = (u: number): number[] | null => {
    path.push(u);
    seen.add(u);
    const x = st.txns[u]!;
    if (x.status === "blocked") {
      for (const w of x.waitFor) {
        if (finished(st.txns[w]!)) continue;
        if (w === t) return [...path, t];
        if (!seen.has(w)) {
          const c = dfs(w);
          if (c) return c;
        }
      }
    }
    path.pop();
    return null;
  };
  return dfs(t);
}

// ---------------------------------------------------------------- MVCC helpers

function visibleVersion(st: EState, key: string, t: number, snap: number): Version | null {
  const vs = st.versions[key] ?? [];
  for (let i = vs.length - 1; i >= 0; i--) {
    const v = vs[i]!;
    if (v.txn === t) return v;
    if (v.commitTs !== null && v.commitTs <= snap) return v;
  }
  return null;
}

function concurrent(a: TxnState, b: TxnState): boolean {
  if (!a.started || !b.started) return false;
  return (a.commitTs === null || a.commitTs > b.snap) && (b.commitTs === null || b.commitTs > a.snap);
}

function addEdge(st: EState, e: DepEdge) {
  if (e.from === e.to || e.from < 0) return;
  if (st.edges.some((x) => x.from === e.from && x.to === e.to && x.kind === e.kind && x.key === e.key)) return;
  st.edges.push(e);
  if (e.kind === "rw") st.events.push({ t: e.to, kind: "edge", text: `rw edge ${tname(e.from)} → ${tname(e.to)} on ${e.key}: ${tname(e.from)} did not see the write of ${tname(e.to)}.` });
}

/** SSI read tracking: mark the SIREAD and add rw edges to writers of newer versions that this reader does not see. */
function trackRead(st: EState, t: number, key: string, seen: Version | null) {
  const vs = st.versions[key] ?? [];
  const idx = seen ? vs.indexOf(seen) : -1;
  for (const v of vs.slice(idx + 1)) if (v.txn !== t) addEdge(st, { from: t, to: v.txn, kind: "rw", key });
  if (seen && seen.txn !== t) addEdge(st, { from: seen.txn, to: t, kind: "wr", key });
}

function mark(st: EState, res: string, t: number) {
  const l = (st.siread[res] ??= []);
  if (!l.includes(t)) l.push(t);
}

export interface Dangerous { tin: number; pivot: number; tout: number }

/**
 * Dangerous structures T_in →rw T_pivot →rw T_out among transactions that did not abort, where T_out committed
 * before T_pivot and T_in committed. If T_in is declared read-only (and is not T_out), T_out must also have
 * committed before T_in took its snapshot (the PostgreSQL read-only rule).
 */
export function dangerousStructures(st: EState, sc: Scenario, commitOrderRule = true): Dangerous[] {
  const rw = st.edges.filter((e) => e.kind === "rw");
  const alive = (t: number) => st.txns[t]!.status !== "aborted";
  const out: Dangerous[] = [];
  for (const a of rw) for (const b of rw) {
    if (a.to !== b.from) continue;
    const tin = a.from, pivot = a.to, tout = b.from === pivot ? b.to : -1;
    if (tout < 0 || !alive(tin) || !alive(pivot) || !alive(tout)) continue;
    if (out.some((d) => d.tin === tin && d.pivot === pivot && d.tout === tout)) continue;
    if (commitOrderRule) {
      const o = st.txns[tout]!;
      if (o.commitTs === null) continue;
      const p = st.txns[pivot]!, i = st.txns[tin]!;
      if (p.commitTs !== null && p.commitTs < o.commitTs) continue;
      if (tin !== tout && i.commitTs !== null && i.commitTs < o.commitTs) continue;
      if (tin !== tout && sc.txns[tin]!.readOnly && o.commitTs > i.snap) continue;
    }
    out.push({ tin, pivot, tout });
  }
  return out;
}

/** Runs the SSI check; returns true if the acting transaction was aborted. */
function ssiCheck(st: EState, sc: Scenario, actor: number): boolean {
  if (!isSsi(st.level)) return false;
  for (const d of dangerousStructures(st, sc, st.level === "SSI")) {
    const p = st.txns[d.pivot]!, i = st.txns[d.tin]!;
    const victim = p.status !== "committed" && p.status !== "aborted" ? p : i.status !== "committed" && i.status !== "aborted" ? i : null;
    if (!victim) continue;
    const s = `${tname(d.tin)} → ${tname(d.pivot)} → ${tname(d.tout)}`;
    if (victim.id === actor) {
      abort(st, actor, `dangerous structure ${s}`);
      return true;
    }
    if (!victim.doomed) {
      victim.doomed = true;
      st.events.push({ t: victim.id, kind: "doom", text: `Dangerous structure ${s}, and ${tname(d.tout)} committed first. ${tname(victim.id)} must abort at its next step.` });
    }
  }
  return false;
}

// ---------------------------------------------------------------- operations

function abort(st: EState, t: number, reason: string) {
  const x = st.txns[t]!;
  x.status = "aborted";
  x.abortReason = reason;
  x.waitFor = [];
  if (isMvcc(st.level)) {
    for (const k of Object.keys(st.versions)) {
      st.versions[k] = st.versions[k]!.filter((v) => v.txn !== t);
      if (st.versions[k]!.length === 0) delete st.versions[k];
    }
  } else {
    for (let i = st.undo.length - 1; i >= 0; i--) {
      const u = st.undo[i]!;
      if (u.t !== t) continue;
      if (u.before === null) delete st.store[u.key];
      else st.store[u.key] = u.before;
    }
    st.undo = st.undo.filter((u) => u.t !== t);
  }
  releaseLocks(st, t);
  st.events.push({ t, kind: "abort", text: reason === "scripted" ? `${tname(t)} rolls back (part of the script).` : `${tname(t)} aborts: ${reason}.` });
}

function block(st: EState, t: number, on: number[], why: string) {
  const x = st.txns[t]!;
  x.status = "blocked";
  x.waitFor = on;
  x.blockedEver = true;
  st.events.push({ t, kind: "block", text: `${tname(t)} waits for ${on.map(tname).join(", ")}: ${why}.` });
  const cyc = waitCycle(st, t);
  if (cyc) abort(st, t, `deadlock (${cyc.map(tname).join(" waits for ")})`);
}

function rowsInGroup(st: EState, g: string): string[] {
  const keys = isMvcc(st.level) ? Object.keys(st.versions) : Object.keys(st.store);
  return keys.filter((k) => groupOf(k) === g).sort();
}

/** Executes the next operation of transaction t (or retries it after a wait). Mutates st. */
export function step(st: EState, sc: Scenario, t: number): void {
  const x = st.txns[t]!;
  if (x.status === "blocked") { x.status = "active"; x.waitFor = []; }
  if (x.doomed) { abort(st, t, "it was chosen as the SSI victim"); return; }
  if (!x.started) { x.started = true; x.snap = st.clock; }
  const op = sc.txns[t]!.ops[x.pc]!;
  const L = st.level;
  const mv = isMvcc(L);
  const T = tname(t);

  if (op.k === "r") {
    let v: number;
    if (!mv) {
      if (L === "RC") {
        const b = lockBlockers(st, t, op.key, "S");
        if (b.length) return block(st, t, b, `it holds an X lock on ${op.key}`);
      } else if (L === "RR" || L === "SER") {
        const req: [string, Mode][] = [[op.key, "S"]];
        const g = groupOf(op.key);
        if (L === "SER" && g) req.unshift([G(g), "IS"]);
        const b = acquire(st, t, req);
        if (b.length) return block(st, t, b, `S lock on ${op.key} conflicts`);
      }
      v = st.store[op.key]!;
    } else {
      const snap = L === "RC-MVCC" ? st.clock : x.snap;
      const ver = visibleVersion(st, op.key, t, snap);
      v = ver ? ver.value : NaN;
      trackRead(st, t, op.key, ver);
      if (marksReads(L)) mark(st, op.key, t);
    }
    x.locals[op.key] = v;
    x.obs.push(`${op.key}=${v}`);
    x.pc++;
    st.events.push({ t, kind: "read", text: `${T} reads ${op.key} = ${v}.` });
    if (mv && ssiCheck(st, sc, t)) return;
    return;
  }

  if (op.k === "scan") {
    let rows: [string, number][];
    if (!mv) {
      const keys = rowsInGroup(st, op.group);
      if (L === "RC") {
        const b = [...new Set(keys.flatMap((k) => lockBlockers(st, t, k, "S")))];
        if (b.length) return block(st, t, b, `it holds an X lock on a row in ${op.group}`);
      } else if (L === "RR") {
        const b = acquire(st, t, keys.map((k) => [k, "S"]));
        if (b.length) return block(st, t, b, `S locks on the rows of ${op.group} conflict`);
      } else if (L === "SER") {
        const b = acquire(st, t, [[G(op.group), "S"]]);
        if (b.length) return block(st, t, b, `S lock on the predicate ${op.group} conflicts`);
      }
      rows = keys.map((k) => [k, st.store[k]!]);
    } else {
      const snap = L === "RC-MVCC" ? st.clock : x.snap;
      rows = [];
      for (const k of rowsInGroup(st, op.group)) {
        const ver = visibleVersion(st, k, t, snap);
        trackRead(st, t, k, ver);
        if (ver) rows.push([k, ver.value]);
      }
      if (marksReads(L)) mark(st, G(op.group), t);
    }
    const n = rows.filter(([, v]) => v > 0).length;
    x.locals[op.as] = n;
    x.obs.push(`${op.as}=${n}`);
    x.pc++;
    st.events.push({ t, kind: "read", text: `${T} scans ${op.group}: ${op.as} = ${n}${rows.length ? ` (${rows.map(([k, v]) => `${k.split(":")[1]}=${v}`).join(", ")})` : ""}.` });
    if (mv && ssiCheck(st, sc, t)) return;
    return;
  }

  if (op.k === "w") {
    if (op.when && !op.when(x.locals)) {
      x.pc++;
      st.events.push({ t, kind: "skip", text: `${T} skips the write: ${op.whenText ?? "condition is false"}.` });
      return;
    }
    const v = op.f(x.locals);
    const g = groupOf(op.key);
    if (!mv) {
      if (L !== "NONE") {
        const req: [string, Mode][] = [[op.key, "X"]];
        if (L === "SER" && g) req.unshift([G(g), "IX"]);
        const b = acquire(st, t, req);
        if (b.length) return block(st, t, b, `X lock on ${op.key} conflicts`);
      }
      st.undo.push({ t, key: op.key, before: op.key in st.store ? st.store[op.key]! : null });
      st.store[op.key] = v;
    } else {
      const vs = (st.versions[op.key] ??= []);
      const latest = vs[vs.length - 1];
      if (latest && latest.commitTs === null && latest.txn !== t) return block(st, t, [latest.txn], `it has an uncommitted version of ${op.key}`);
      if ((L === "SI" || isSsi(L)) && latest && latest.commitTs !== null && latest.commitTs > x.snap) {
        abort(st, t, `${op.key} changed after its snapshot (first-updater-wins)`);
        return;
      }
      if (latest && latest.commitTs !== null && latest.txn >= 0 && latest.txn !== t) addEdge(st, { from: latest.txn, to: t, kind: "ww", key: op.key });
      if (latest && latest.txn === t) latest.value = v;
      else vs.push({ value: v, txn: t, commitTs: null });
      // SI keeps the same SIREAD marks so that demos can draw rw edges; only SSI acts on them.
      if (marksReads(L)) {
        const readers = [...(st.siread[op.key] ?? []), ...(g ? st.siread[G(g)] ?? [] : [])];
        for (const r of readers) if (r !== t && st.txns[r]!.status !== "aborted" && concurrent(st.txns[r]!, x)) addEdge(st, { from: r, to: t, kind: "rw", key: op.key });
      }
    }
    x.pc++;
    st.events.push({ t, kind: "write", text: `${T} writes ${op.key} = ${v} (${op.expr}).` });
    if (mv && ssiCheck(st, sc, t)) return;
    return;
  }

  if (op.k === "a") {
    x.pc++;
    abort(st, t, "scripted");
    return;
  }

  // commit
  x.pc++;
  x.commitTs = ++st.clock;
  x.status = "committed";
  if (mv) for (const vs of Object.values(st.versions)) for (const ver of vs) if (ver.txn === t) ver.commitTs = x.commitTs;
  releaseLocks(st, t);
  st.events.push({ t, kind: "commit", text: `${T} commits.` });
  if (mv) ssiCheck(st, sc, t);
}

// ---------------------------------------------------------------- outcomes

/** Final committed value of each row. */
export function committedState(st: EState): Record<string, number> {
  if (!isMvcc(st.level)) return Object.fromEntries(Object.entries(st.store).sort());
  const out: Record<string, number> = {};
  for (const [k, vs] of Object.entries(st.versions)) {
    const c = vs.filter((v) => v.commitTs !== null);
    if (c.length) out[k] = c[c.length - 1]!.value;
  }
  return Object.fromEntries(Object.entries(out).sort());
}

export interface SerialRun { order: number[]; obs: string[][]; state: Record<string, number> }

/** Runs the given transactions one after another, with no concurrency. */
export function runSerial(sc: Scenario, order: number[]): SerialRun {
  const st = initState(sc, "NONE");
  for (const t of order) while (!finished(st.txns[t]!) && st.txns[t]!.pc < sc.txns[t]!.ops.length) step(st, sc, t);
  return { order, obs: order.map((t) => st.txns[t]!.obs), state: committedState(st) };
}

export interface Verdict {
  committed: number[];
  anomaly: boolean;
  /** Serial orders of the committed transactions that give the same reads and final state. */
  matches: number[][];
  engineAborts: number[];
  blocked: boolean;
}

export function verdict(st: EState, sc: Scenario): Verdict {
  const committed = st.txns.filter((x) => x.status === "committed").map((x) => x.id);
  const state = committedState(st);
  const obs = committed.map((t) => st.txns[t]!.obs);
  const matches = permutations(committed.length)
    .map((p) => p.map((i) => committed[i]!))
    .filter((order) => {
      const r = runSerial(sc, order);
      const byT = new Map(order.map((t, i) => [t, r.obs[i]!]));
      return JSON.stringify(committed.map((t) => byT.get(t))) === JSON.stringify(obs) && JSON.stringify(r.state) === JSON.stringify(state);
    });
  return {
    committed,
    anomaly: matches.length === 0,
    matches,
    engineAborts: st.txns.filter((x) => x.status === "aborted" && x.abortReason !== "scripted").map((x) => x.id),
    blocked: st.txns.some((x) => x.blockedEver),
  };
}

/** Runs a list of choices; a choice that is not runnable is skipped. Then finishes with the lowest runnable txn. */
export function runPath(sc: Scenario, level: Level, choices: number[], finish = true): EState {
  const st = initState(sc, level);
  for (const t of choices) if (runnable(st, sc).includes(t)) step(st, sc, t);
  if (finish) for (let r = runnable(st, sc); r.length; r = runnable(st, sc)) step(st, sc, r[0]!);
  return st;
}

/**
 * The states along a path: state 0 is the start, state k is after k steps. Choices that are not runnable are
 * skipped. When the choices run out, the lowest runnable transaction runs until all are finished.
 */
export function buildPath(sc: Scenario, level: Level, choices: number[]): { states: EState[]; used: number[] } {
  const st = initState(sc, level);
  const states = [cloneState(st)];
  const used: number[] = [];
  const go = (t: number) => { step(st, sc, t); used.push(t); states.push(cloneState(st)); };
  for (const t of choices) if (runnable(st, sc).includes(t)) go(t);
  for (let r = runnable(st, sc); r.length; r = runnable(st, sc)) go(r[0]!);
  return { states, used };
}

// ---------------------------------------------------------------- exhaustive exploration

export interface Explored {
  runs: number;
  anomalies: number;
  /** Runs where some transaction waited. */
  blocked: number;
  /** Runs where the engine aborted some transaction. */
  aborted: number;
  /** Choices of one run with an anomaly, if any. */
  example: number[] | null;
}

export type CellKind = "allowed" | "aborts" | "blocks" | "clean";
export function cellKind(e: Explored): CellKind {
  return e.anomalies ? "allowed" : e.aborted ? "aborts" : e.blocked ? "blocks" : "clean";
}

/**
 * Visits every interleaving (every sequence of choices among runnable transactions). A generator, so that a demo
 * can run it in small time slices: it yields the running totals after each finished run.
 */
export function* exploreIter(sc: Scenario, level: Level): Generator<Explored, Explored> {
  const res: Explored = { runs: 0, anomalies: 0, blocked: 0, aborted: 0, example: null };
  function* dfs(st: EState, path: number[]): Generator<Explored> {
    const r = runnable(st, sc);
    if (r.length === 0) {
      const v = verdict(st, sc);
      res.runs++;
      if (v.anomaly) { res.anomalies++; res.example ??= path; }
      if (v.blocked) res.blocked++;
      if (v.engineAborts.length) res.aborted++;
      yield res;
      return;
    }
    for (const t of r) {
      const s2 = cloneState(st);
      step(s2, sc, t);
      yield* dfs(s2, [...path, t]);
    }
  }
  yield* dfs(initState(sc, level), []);
  return res;
}

export function explore(sc: Scenario, level: Level): Explored {
  const it = exploreIter(sc, level);
  for (;;) {
    const n = it.next();
    if (n.done) return n.value;
  }
}

// ---------------------------------------------------------------- scenarios

const r = (key: string): TOp => ({ k: "r", key });
const c: TOp = { k: "c" };
const w = (key: string, expr: string, f: (l: Locals) => number, when?: (l: Locals) => boolean, whenText?: string): TOp => ({ k: "w", key, expr, f, when, whenText });
const scan = (group: string, as: string): TOp => ({ k: "scan", group, as });

export const SCENARIOS: Scenario[] = [
  {
    id: "dirty-write", name: "Dirty write", code: "P0",
    init: { x: 0, y: 0 },
    txns: [
      { ops: [w("x", "1", () => 1), w("y", "1", () => 1), c] },
      { ops: [w("x", "2", () => 2), w("y", "2", () => 2), c] },
    ],
    classic: [0, 1, 1, 0, 0, 1],
    bad: "x and y should come from the same transaction, but x = 2 and y = 1.",
  },
  {
    id: "dirty-read", name: "Dirty read", code: "A1",
    init: { x: 10 },
    txns: [
      { ops: [w("x", "99", () => 99), { k: "a" }] },
      { ops: [r("x"), c] },
    ],
    classic: [0, 1, 1, 0],
    bad: "T2 read x = 99, a value that never committed.",
  },
  {
    id: "non-repeatable", name: "Non-repeatable read", code: "A2",
    init: { x: 10 },
    txns: [
      { ops: [r("x"), r("x"), c] },
      { ops: [w("x", "20", () => 20), c] },
    ],
    classic: [0, 1, 1, 0, 0],
    bad: "T1 reads x twice and gets two different values.",
  },
  {
    id: "phantom", name: "Phantom", code: "A3",
    init: { "emp:ann": 1, "emp:bo": 1 },
    txns: [
      { ops: [scan("emp", "n"), scan("emp", "n2"), c] },
      { ops: [w("emp:cy", "1 (insert)", () => 1), c] },
    ],
    classic: [0, 1, 1, 0, 0],
    bad: "T1 runs the same query twice and gets a new row the second time.",
  },
  {
    id: "lost-update", name: "Lost update", code: "P4",
    init: { x: 10 },
    txns: [
      { ops: [r("x"), w("x", "x + 1", (l) => l.x! + 1), c] },
      { ops: [r("x"), w("x", "x + 5", (l) => l.x! + 5), c] },
    ],
    classic: [0, 1, 0, 1, 0, 1],
    bad: "Both increments ran, but x shows only one of them.",
  },
  {
    id: "read-skew", name: "Read skew", code: "A5A",
    init: { x: 50, y: 50 },
    txns: [
      { ops: [r("x"), r("y"), c] },
      { ops: [r("x"), w("x", "x − 10", (l) => l.x! - 10), r("y"), w("y", "y + 10", (l) => l.y! + 10), c] },
    ],
    classic: [0, 1, 1, 1, 1, 1, 0, 0],
    bad: "T1 sees x + y = 110, but the total is always 100.",
  },
  {
    id: "write-skew", name: "Write skew", code: "A5B",
    init: { "doc:alice": 1, "doc:bob": 1 },
    txns: [
      { ops: [scan("doc", "n"), w("doc:alice", "0 (off call)", () => 0, (l) => l.n! >= 2, "fewer than 2 doctors on call"), c] },
      { ops: [scan("doc", "n"), w("doc:bob", "0 (off call)", () => 0, (l) => l.n! >= 2, "fewer than 2 doctors on call"), c] },
    ],
    classic: [0, 1, 0, 1, 0, 1],
    bad: "Each doctor saw 2 on call and went off call. Now no doctor is on call.",
  },
  {
    id: "insert-skew", name: "Write skew by insert", code: "A5B*",
    init: {},
    txns: [
      { ops: [scan("room", "n"), w("room:t1", "1 (insert)", () => 1, (l) => l.n === 0, "the room is booked"), c] },
      { ops: [scan("room", "n"), w("room:t2", "1 (insert)", () => 1, (l) => l.n === 0, "the room is booked"), c] },
    ],
    classic: [0, 1, 0, 1, 0, 1],
    bad: "Each transaction saw a free room and booked it. Now the room has two bookings.",
  },
];

/** Extra scenarios for the SSI lesson (three transactions). */
export const SSI_SCENARIOS: Scenario[] = [
  SCENARIOS.find((s) => s.id === "write-skew")!,
  {
    id: "read-only", name: "Read-only anomaly", code: "RO",
    // Fekete, O'Neil and O'Neil 2004: checking x and savings y; a withdrawal that overdraws pays a penalty of 1.
    init: { x: 0, y: 0 },
    txns: [
      { ops: [r("y"), w("y", "y + 20", (l) => l.y! + 20), c] },
      { ops: [r("x"), r("y"), w("x", "x − 10 − penalty", (l) => l.x! - 10 - (l.x! + l.y! < 10 ? 1 : 0)), c] },
      { ops: [r("x"), r("y"), c], readOnly: true },
    ],
    classic: [1, 1, 0, 0, 0, 2, 2, 2, 1, 1],
    bad: "T3 sees the deposit (y = 20) but x = 0, yet T2 later charges the penalty as if the deposit did not exist.",
  },
  {
    id: "false-positive", name: "False positive", code: "FP",
    init: { x: 0, y: 0, z: 0 },
    txns: [
      { ops: [r("x"), w("z", "1", () => 1), c] },
      { ops: [w("x", "1", () => 1), r("y"), c] },
      { ops: [w("y", "1", () => 1), c] },
    ],
    classic: [0, 1, 1, 2, 2, 1, 0, 0],
    bad: "No anomaly is possible here: the order T1, T2, T3 always explains the result.",
  },
];

export const scenarioById = (id: string) => [...SCENARIOS, ...SSI_SCENARIOS].find((s) => s.id === id)!;

/** The anomaly × level matrix. */
export function anomalyMatrix(levels: Level[] = LEVELS.map((l) => l.id)): Record<string, Record<Level, Explored>> {
  const out: Record<string, Record<Level, Explored>> = {};
  for (const sc of SCENARIOS) {
    out[sc.id] = {} as Record<Level, Explored>;
    for (const l of levels) out[sc.id]![l] = explore(sc, l);
  }
  return out;
}

/** Human description of one operation. */
export function opText(op: TOp): string {
  switch (op.k) {
    case "r": return `read ${op.key}`;
    case "scan": return `count ${op.group} → ${op.as}`;
    case "w": return `${op.when ? "if ok: " : ""}${op.key} = ${op.expr}`;
    case "c": return "commit";
    case "a": return "rollback";
  }
}
