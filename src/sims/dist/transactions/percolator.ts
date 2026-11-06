/**
 * Percolator (Peng and Dabek, "Large-scale Incremental Processing Using Distributed Transactions and
 * Notifications", OSDI 2010): snapshot isolation on top of a versioned key-value store that has only single-row
 * transactions (Bigtable).
 *
 * Every key has three columns, each a map from timestamp to value:
 * - data[startTs]  = the value a transaction wrote,
 * - lock[startTs]  = a lock, which names the transaction's primary key,
 * - write[commitTs] = startTs: a pointer that makes data[startTs] visible from commitTs on.
 *
 * A timestamp oracle hands out strictly increasing timestamps.
 * - Get at startTs: if a lock in [0, startTs] exists, wait or clean it up; else follow the newest write record in
 *   [0, startTs] to its data.
 * - Prewrite (primary first): abort if a write record exists at or after startTs, or a lock at any timestamp;
 *   else write data[startTs] and lock[startTs].
 * - Commit: take commitTs from the oracle. On the primary, check that the lock is still there, write the write
 *   record and erase the lock, in one row transaction. That is the commit point. Then do the same on each secondary.
 * - Cleanup by a reader that finds a lock of a dead client: look at the primary. If its lock is still there, the
 *   transaction did not commit: erase the primary's lock, then this one (roll back). If the primary has a write
 *   record that points at the lock's startTs, it committed: write the same record here and erase the lock (roll
 *   forward).
 *
 * Each method is one row transaction, so it is atomic, as in Bigtable.
 */
import { mulberry32 } from "../../rng";

export interface PRow {
  data: Map<number, number>;
  lock: Map<number, { primary: string }>;
  write: Map<number, number>;
}

export type TxnStatus = "active" | "committed" | "aborted" | "crashed";

export interface PTxn {
  id: number;
  name: string;
  startTs: number;
  commitTs?: number;
  /** Buffered writes; the first one is the primary. */
  writes: [string, number][];
  reads: { key: string; value: number | null; from: number }[];
  status: TxnStatus;
  /** The keys it has prewritten (locked). */
  locked: string[];
  /** The secondaries it has committed. */
  done: string[];
  why?: string;
}

export type GetResult =
  | { kind: "value"; value: number | null; from: number }
  | { kind: "locked"; key: string; lockTs: number; primary: string };

export type Resolution = { how: "rolled back" | "rolled forward" | "already rolled back"; key: string; lockTs: number; primary: string; commitTs?: number };

export class Percolator {
  readonly rows = new Map<string, PRow>();
  readonly txns: PTxn[] = [];
  private ts = 0;
  /** Every cleanup that a reader did. */
  readonly resolutions: Resolution[] = [];

  /** The timestamp oracle. */
  oracle() {
    return ++this.ts;
  }
  peekTs() {
    return this.ts;
  }

  row(k: string): PRow {
    let r = this.rows.get(k);
    if (!r) this.rows.set(k, (r = { data: new Map(), lock: new Map(), write: new Map() }));
    return r;
  }

  /** Loads committed initial values with one setup transaction. */
  load(init: Record<string, number>) {
    const s = this.oracle(), c = this.oracle();
    for (const [k, v] of Object.entries(init)) {
      const r = this.row(k);
      r.data.set(s, v);
      r.write.set(c, s);
    }
  }

  begin(name = `T${this.txns.length + 1}`): PTxn {
    const t: PTxn = { id: this.txns.length, name, startTs: this.oracle(), writes: [], reads: [], status: "active", locked: [], done: [] };
    this.txns.push(t);
    return t;
  }

  /** The newest committed version at or before ts: its value and the startTs of the transaction that wrote it. */
  private visible(r: PRow, ts: number): { value: number | null; from: number } {
    let best = -1;
    for (const c of r.write.keys()) if (c <= ts && c > best) best = c;
    if (best < 0) return { value: null, from: 0 };
    const s = r.write.get(best)!;
    return { value: r.data.get(s) ?? null, from: s };
  }

  /** Snapshot read. `cleanup` decides what to do with a lock in [0, startTs]: clean it, or report it. */
  get(t: PTxn, key: string, cleanup: (lockTs: number, primary: string) => boolean): GetResult {
    const r = this.row(key);
    for (;;) {
      let lockTs = -1;
      for (const [ts] of r.lock) if (ts <= t.startTs && ts > lockTs) lockTs = ts;
      if (lockTs < 0) break;
      const primary = r.lock.get(lockTs)!.primary;
      if (!cleanup(lockTs, primary)) return { kind: "locked", key, lockTs, primary };
      this.resolve(key, lockTs);
    }
    const v = this.visible(r, t.startTs);
    t.reads.push({ key, ...v });
    return { kind: "value", ...v };
  }

  set(t: PTxn, key: string, value: number) {
    const w = t.writes.find(([k]) => k === key);
    if (w) w[1] = value;
    else t.writes.push([key, value]);
  }

  /** Prewrite of one key. Returns false and aborts the transaction on a conflict. */
  prewrite(t: PTxn, key: string): boolean {
    if (t.status !== "active") return false;
    const r = this.row(key);
    const value = t.writes.find(([k]) => k === key)![1];
    for (const c of r.write.keys())
      if (c >= t.startTs) return this.abort(t, `write-write conflict on ${key}: a write committed at ${c}, after its start ${t.startTs}`);
    if (r.lock.size) return this.abort(t, `${key} is locked by another transaction (lock at ${[...r.lock.keys()][0]})`);
    r.data.set(t.startTs, value);
    r.lock.set(t.startTs, { primary: t.writes[0]![0] });
    t.locked.push(key);
    return true;
  }

  /** The commit point: take commitTs, then write the primary's write record if its lock is still there. */
  commitPrimary(t: PTxn): boolean {
    if (t.status !== "active") return false;
    if (!t.writes.length) {
      // A read-only transaction has nothing to write: it commits at its snapshot.
      t.status = "committed";
      t.commitTs = t.startTs;
      return true;
    }
    const pk = t.writes[0]![0];
    const r = this.row(pk);
    const ts = this.oracle();
    if (!r.lock.has(t.startTs)) return this.abort(t, `its primary lock on ${pk} is gone: a reader rolled it back`);
    t.commitTs = ts;
    r.write.set(ts, t.startTs);
    r.lock.delete(t.startTs);
    t.status = "committed";
    t.done.push(pk);
    return true;
  }

  commitSecondary(t: PTxn, key: string) {
    if (t.status !== "committed" || t.done.includes(key)) return;
    const r = this.row(key);
    if (!r.lock.has(t.startTs)) return; // a reader already rolled it forward
    r.write.set(t.commitTs!, t.startTs);
    r.lock.delete(t.startTs);
    t.done.push(key);
  }

  /** The client aborts and erases its own locks. */
  private abort(t: PTxn, why: string): false {
    t.status = "aborted";
    t.why = why;
    for (const k of t.locked) {
      const r = this.row(k);
      if (r.lock.delete(t.startTs)) r.data.delete(t.startTs);
    }
    return false;
  }

  crash(t: PTxn) {
    if (t.status === "active") t.status = "crashed";
    else if (t.status === "committed") t.why = "crashed after its commit point";
  }

  /** Cleans up the lock at (key, lockTs) by looking at its primary. */
  resolve(key: string, lockTs: number): Resolution {
    const r = this.row(key);
    const lk = r.lock.get(lockTs);
    if (!lk) return { how: "already rolled back", key, lockTs, primary: key };
    const p = this.row(lk.primary);
    let res: Resolution;
    if (p.lock.has(lockTs)) {
      // Not committed: roll back the primary first, so a late commit attempt of the owner fails.
      p.lock.delete(lockTs);
      p.data.delete(lockTs);
      if (key !== lk.primary) {
        r.lock.delete(lockTs);
        r.data.delete(lockTs);
      }
      res = { how: "rolled back", key, lockTs, primary: lk.primary };
      const owner = this.txns.find((x) => x.startTs === lockTs);
      if (owner && owner.status !== "committed") {
        owner.status = "aborted";
        owner.why = "rolled back by a reader";
      }
    } else {
      const commit = [...p.write].find(([, s]) => s === lockTs)?.[0];
      r.lock.delete(lockTs);
      if (commit !== undefined) {
        r.write.set(commit, lockTs);
        res = { how: "rolled forward", key, lockTs, primary: lk.primary, commitTs: commit };
      } else {
        r.data.delete(lockTs);
        res = { how: "already rolled back", key, lockTs, primary: lk.primary };
      }
    }
    this.resolutions.push(res);
    return res;
  }

  /** Cleans every lock left in the table (as readers would over time). */
  resolveAll() {
    for (const [k, r] of this.rows) for (const ts of [...r.lock.keys()]) this.resolve(k, ts);
  }

  /** The committed value of each key as of `ts` (default: the latest). */
  snapshot(ts = Infinity): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const [k, r] of this.rows) out[k] = this.visible(r, ts).value;
    return out;
  }
}

// ============================================================================ a snapshot isolation checker

export interface SiTxn {
  name: string;
  startTs: number;
  commitTs: number;
  reads: { key: string; from: number }[];
  writes: string[];
}

/**
 * Checks a history of committed transactions against snapshot isolation:
 * 1. Snapshot reads: each read returns the version of the transaction with the newest commitTs <= startTs that wrote
 *    the key (or the initial value, from = `initFrom`). So no read sees an aborted or a later transaction, and all the
 *    reads of a transaction come from one snapshot.
 * 2. First committer wins: two transactions whose [start, commit] intervals overlap do not write the same key. This
 *    is what rules out lost updates.
 */
export function checkSI(h: SiTxn[], initFrom: number): string[] {
  const bad: string[] = [];
  for (const t of h)
    for (const r of t.reads) {
      let best: SiTxn | null = null;
      for (const u of h) if (u !== t && u.writes.includes(r.key) && u.commitTs <= t.startTs && (!best || u.commitTs > best.commitTs)) best = u;
      const want = best ? best.startTs : initFrom;
      if (r.from !== want) bad.push(`${t.name} read ${r.key} from the version of start ${r.from}; its snapshot ${t.startTs} has ${want}`);
    }
  for (let i = 0; i < h.length; i++)
    for (let j = i + 1; j < h.length; j++) {
      const a = h[i]!, b = h[j]!;
      const overlap = a.startTs < b.commitTs && b.startTs < a.commitTs;
      const both = a.writes.filter((k) => b.writes.includes(k));
      if (overlap && both.length) bad.push(`${a.name} and ${b.name} overlap and both wrote ${both.join(", ")}: a lost update`);
    }
  return bad;
}

/** The committed transactions of a run, for checkSI. A read-only transaction "commits" at its start. */
export function siHistory(p: Percolator): SiTxn[] {
  return p.txns
    .filter((t) => t.status === "committed" || (t.writes.length === 0 && t.status !== "aborted"))
    .map((t) => ({ name: t.name, startTs: t.startTs, commitTs: t.commitTs ?? t.startTs, reads: t.reads.map((r) => ({ key: r.key, from: r.from })), writes: t.writes.map(([k]) => k) }));
}

// ============================================================================ random concurrent transfers

export interface RandomCfg {
  seed: number;
  clients: number;
  accounts: number;
  /** Transactions started per client. */
  perClient: number;
  /** Probability that a client crashes at a given step. */
  crashRate: number;
  /** Share of read-only audit transactions, which sum all accounts. */
  audits: number;
}

export interface RandomResult {
  p: Percolator;
  violations: string[];
  /** Sums seen by audits (each must equal the total). */
  auditSums: number[];
  total: number;
  committed: number;
  aborted: number;
  crashed: number;
}

/**
 * Clients run transfers (read two accounts, move 1 from one to the other) and audits (read every account) with
 * their steps interleaved at random. Some clients crash between steps; readers clean up the locks of crashed
 * clients and wait for live ones.
 */
export function randomPercolator(c: RandomCfg): RandomResult {
  const rng = mulberry32(c.seed);
  const p = new Percolator();
  const keys = Array.from({ length: c.accounts }, (_, i) => `a${i}`);
  p.load(Object.fromEntries(keys.map((k) => [k, 10])));
  const total = 10 * c.accounts;
  const initFrom = 1;
  type Job = { t: PTxn | null; plan: string[]; step: number; audit: boolean; left: number; sum: number; dead: boolean };
  const jobs: Job[] = Array.from({ length: c.clients }, () => ({ t: null, plan: [], step: 0, audit: false, left: c.perClient, sum: 0, dead: false }));
  const auditSums: number[] = [];
  const isDead = (lockTs: number) => p.txns.some((x) => x.startTs === lockTs && x.status === "crashed");
  let guard = 0;
  while (jobs.some((j) => j.left > 0 || j.t) && guard++ < 100000) {
    const j = jobs[Math.floor(rng() * jobs.length)]!;
    if (!j.t) {
      if (j.left <= 0) continue;
      j.left--;
      j.t = p.begin();
      j.audit = rng() < c.audits;
      if (j.audit) j.plan = keys.map((k) => `r:${k}`);
      else {
        const a = keys[Math.floor(rng() * keys.length)]!;
        let b = keys[Math.floor(rng() * keys.length)]!;
        if (b === a) b = keys[(keys.indexOf(a) + 1) % keys.length]!;
        j.plan = [`r:${a}`, `r:${b}`, `w:${a}:-1`, `w:${b}:1`, `p:${a}`, `p:${b}`, "c", `s:${b}`];
      }
      j.step = 0;
      j.sum = 0;
      continue;
    }
    const t = j.t;
    if (t.status === "aborted" || t.status === "crashed" || j.step >= j.plan.length) {
      if (j.audit && t.status !== "aborted" && t.status !== "crashed") auditSums.push(j.sum);
      j.t = null;
      continue;
    }
    if (rng() < c.crashRate) {
      p.crash(t);
      j.t = null;
      continue;
    }
    const [op, key, d] = j.plan[j.step]!.split(":");
    if (op === "r") {
      const g = p.get(t, key!, (ts) => isDead(ts));
      if (g.kind === "locked") continue; // a live owner: wait and try again later
      j.sum += g.value ?? 0;
      if (!j.audit) t.reads[t.reads.length - 1]!.value = g.value;
    } else if (op === "w") {
      const read = t.reads.find((r) => r.key === key)!;
      p.set(t, key!, (read.value ?? 0) + Number(d));
    } else if (op === "p") {
      if (!p.prewrite(t, key!)) continue;
    } else if (op === "c") {
      if (!p.commitPrimary(t)) continue;
    } else if (op === "s") p.commitSecondary(t, key!);
    j.step++;
  }
  p.resolveAll();
  const hist = siHistory(p);
  const violations = checkSI(hist, initFrom);
  const snap = p.snapshot();
  const sum = Object.values(snap).reduce<number>((a, v) => a + (v ?? 0), 0);
  if (sum !== total) violations.push(`the final total is ${sum}, not ${total}`);
  for (const s of auditSums) if (s !== total) violations.push(`an audit saw a total of ${s}, not ${total}`);
  // Atomicity: every committed writer has a write record on each of its keys; no other transaction has any.
  for (const t of p.txns) {
    for (const [k] of t.writes) {
      const has = [...p.row(k).write.values()].includes(t.startTs);
      if (t.status === "committed" && !has) violations.push(`${t.name} committed but has no write record on ${k}`);
      if (t.status !== "committed" && has) violations.push(`${t.name} did not commit but has a write record on ${k}`);
    }
  }
  return {
    p, violations, auditSums, total,
    committed: p.txns.filter((t) => t.status === "committed").length,
    aborted: p.txns.filter((t) => t.status === "aborted").length,
    crashed: p.txns.filter((t) => t.status === "crashed").length,
  };
}

// ============================================================================ the lesson's stepper: Bob pays Joe 7

export type PercAction = "w" | "crash" | "rbegin" | "rBob" | "rJoe";

export const WRITER_STEPS = ["begin: get start timestamp", "prewrite Bob (primary)", "prewrite Joe (secondary)", "commit primary Bob", "commit secondary Joe"];

export interface PercFrame {
  p: Percolator;
  writer: PTxn | null;
  reader: PTxn | null;
  wStep: number;
  crashed: boolean;
  /** What the last action did, in words. */
  text: string;
  tone: "good" | "bad" | "warn" | "info" | "plain";
  readerSaw: Partial<Record<"Bob" | "Joe", number | null>>;
}

/** Replays the learner's actions on a fresh table with Bob = 10 and Joe = 2. */
export function replayPercolator(actions: PercAction[]): PercFrame {
  const p = new Percolator();
  p.load({ Bob: 10, Joe: 2 });
  const f: PercFrame = { p, writer: null, reader: null, wStep: 0, crashed: false, text: "Bob has 10 and Joe has 2. The writer will move 7 from Bob to Joe.", tone: "plain", readerSaw: {} };
  for (const a of actions) {
    if (a === "w" && !f.crashed && f.wStep < WRITER_STEPS.length) {
      const s = f.wStep++;
      if (s === 0) {
        f.writer = p.begin("W");
        p.set(f.writer, "Bob", 3);
        p.set(f.writer, "Joe", 9);
        f.text = `The writer gets start timestamp ${f.writer.startTs} from the oracle. It buffers Bob = 3 and Joe = 9 on the client.`;
        f.tone = "info";
      } else if (s === 1 || s === 2) {
        const key = s === 1 ? "Bob" : "Joe";
        const ok = p.prewrite(f.writer!, key);
        f.text = ok
          ? `Prewrite ${key}: no newer write and no lock, so it writes data and a lock at ${f.writer!.startTs}. ${s === 1 ? "Bob is the primary." : "The lock points at the primary, Bob."}`
          : `Prewrite ${key} fails: ${f.writer!.why}. The writer aborts.`;
        f.tone = ok ? "info" : "bad";
        if (!ok) f.wStep = WRITER_STEPS.length;
      } else if (s === 3) {
        const ok = p.commitPrimary(f.writer!);
        f.text = ok
          ? `Commit point: commit timestamp ${f.writer!.commitTs}. On Bob, one row transaction writes write[${f.writer!.commitTs}] = ${f.writer!.startTs} and erases the lock. The transfer is now committed.`
          : `The commit fails: ${f.writer!.why}.`;
        f.tone = ok ? "good" : "bad";
        if (!ok) f.wStep = WRITER_STEPS.length;
      } else {
        p.commitSecondary(f.writer!, "Joe");
        f.text = `Joe gets write[${f.writer!.commitTs}] = ${f.writer!.startTs} and its lock goes. The writer is done.`;
        f.tone = "good";
      }
    } else if (a === "crash" && f.writer && !f.crashed) {
      f.crashed = true;
      p.crash(f.writer);
      f.text = f.writer.status === "committed"
        ? "The writer crashes after its commit point. Joe still has a lock, but Bob's write record says the transfer committed."
        : f.writer.locked.length
          ? `The writer crashes with ${f.writer.locked.length} lock${f.writer.locked.length > 1 ? "s" : ""} in the table and no write record. Nobody will finish its work except a reader.`
          : "The writer crashes before it wrote anything. It leaves no trace.";
      f.tone = "bad";
    } else if (a === "rbegin" && !f.reader) {
      f.reader = p.begin("R");
      f.text = `The reader gets start timestamp ${f.reader.startTs}. It sees the versions committed at or before ${f.reader.startTs}.`;
      f.tone = "info";
    } else if ((a === "rBob" || a === "rJoe") && f.reader) {
      const key = a === "rBob" ? "Bob" : "Joe";
      const before = p.resolutions.length;
      const g = p.get(f.reader, key, (ts) => f.crashed && f.writer?.startTs === ts);
      if (g.kind === "locked") {
        f.text = `${key} has a lock at ${g.lockTs}, below the reader's ${f.reader.startTs}. The writer may still commit, and it is alive, so the reader must wait.`;
        f.tone = "warn";
      } else {
        const res = p.resolutions.slice(before);
        const how = res.map((r) =>
          r.how === "rolled back"
            ? `${key} had a lock at ${r.lockTs}. The reader checked the primary ${r.primary}: its lock is still there, so the writer never committed. The reader erased the locks (roll back).`
            : r.how === "rolled forward"
              ? `${key} had a lock at ${r.lockTs}. The reader checked the primary ${r.primary}: it has write[${r.commitTs}] = ${r.lockTs}, so the writer committed. The reader wrote the same record on ${key} (roll forward).`
              : `${key} had a lock at ${r.lockTs}, but the primary already shows a roll back, so the reader erased it.`).join(" ");
        f.readerSaw[key] = g.value;
        f.text = `${how ? how + " " : ""}The reader reads ${key} = ${g.value}, the version from start ${g.from}.`;
        f.tone = res.length ? "good" : "info";
      }
    }
  }
  return f;
}

// ============================================================================ write skew under snapshot isolation

export interface SkewRun {
  p: Percolator;
  t1: PTxn;
  t2: PTxn;
  /** Doctors on call at the end. */
  onCall: number;
  /** Edges of the dependency graph: an rw edge Ti → Tj means Ti read a version that Tj overwrote. */
  edges: { from: number; to: number; kind: "rw" | "ww" | "wr"; key: string }[];
}

/**
 * Two doctors, x and y, are on call (1). Each transaction checks that two are on call, then takes its own doctor
 * off call. `order` gives the interleaving: "concurrent" (both read, then both commit) or "serial". With
 * `materialize`, both also write a shared row, which turns the hidden conflict into a write-write conflict.
 */
export function writeSkew(order: "concurrent" | "serial", materialize: boolean): SkewRun {
  const p = new Percolator();
  p.load({ x: 1, y: 1, shift: 0 });
  const run = (t: PTxn, mine: string) => {
    const sum = (p.get(t, "x", () => true) as { value: number }).value + (p.get(t, "y", () => true) as { value: number }).value;
    if (sum >= 2) {
      p.set(t, mine, 0);
      if (materialize) p.set(t, "shift", t.id);
    }
  };
  const commit = (t: PTxn) => {
    for (const [k] of t.writes) if (!p.prewrite(t, k)) return;
    if (p.commitPrimary(t)) for (const [k] of t.writes.slice(1)) p.commitSecondary(t, k);
  };
  let t1: PTxn, t2: PTxn;
  if (order === "concurrent") {
    t1 = p.begin("T1");
    t2 = p.begin("T2");
    run(t1, "x");
    run(t2, "y");
    commit(t1);
    commit(t2);
  } else {
    t1 = p.begin("T1");
    run(t1, "x");
    commit(t1);
    t2 = p.begin("T2");
    run(t2, "y");
    commit(t2);
  }
  const snap = p.snapshot();
  const edges: SkewRun["edges"] = [];
  const both = [t1, t2].filter((t) => t.status === "committed");
  for (const a of both)
    for (const b of both) {
      if (a === b) continue;
      for (const r of a.reads)
        if (b.writes.some(([k]) => k === r.key)) {
          // a read r.key; b wrote it. If b's version is newer than what a saw: a → b (rw). Else b → a (wr).
          if (b.commitTs! > a.startTs) edges.push({ from: a.id, to: b.id, kind: "rw", key: r.key });
          else edges.push({ from: b.id, to: a.id, kind: "wr", key: r.key });
        }
    }
  return { p, t1, t2, onCall: (snap.x ?? 0) + (snap.y ?? 0), edges };
}
