/**
 * A lock manager: multi-granularity lock modes, a lock table with granted groups and FIFO wait queues,
 * lock conversion (upgrade), a waits-for graph, and four deadlock policies.
 *
 * Policies:
 * - detect      wait; when a wait closes a cycle in the waits-for graph, abort the youngest transaction in it.
 * - wait-die    an older requester waits; a younger requester dies (aborts). Never preempts.
 * - wound-wait  an older requester wounds (aborts) younger holders; a younger requester waits.
 * - no-wait     any conflict aborts the requester.
 * Age is a timestamp given at the first start; a restarted transaction keeps it, so it cannot starve.
 */

export type LMode = "IS" | "IX" | "S" | "SIX" | "X";
export const MODES: LMode[] = ["IS", "IX", "S", "SIX", "X"];

/** Compatibility matrix of Gray et al. (1976): COMPAT[held][requested]. */
export const COMPAT: Record<LMode, Record<LMode, boolean>> = {
  IS: { IS: true, IX: true, S: true, SIX: true, X: false },
  IX: { IS: true, IX: true, S: false, SIX: false, X: false },
  S: { IS: true, IX: false, S: true, SIX: false, X: false },
  SIX: { IS: true, IX: false, S: false, SIX: false, X: false },
  X: { IS: false, IX: false, S: false, SIX: false, X: false },
};
export const compat = (a: LMode, b: LMode) => COMPAT[a][b];

/** The weakest mode that is at least as strong as both (for a conversion). */
export function sup(a: LMode, b: LMode): LMode {
  if (a === b) return a;
  if (a === "X" || b === "X") return "X";
  if (a === "IS") return b;
  if (b === "IS") return a;
  // remaining pairs among IX, S, SIX
  return "SIX";
}

export type Policy = "detect" | "wait-die" | "wound-wait" | "no-wait";

export interface Holder { txn: number; mode: LMode }
export interface Waiter { txn: number; mode: LMode; upgrade: boolean }
export interface LockEntry { granted: Holder[]; queue: Waiter[] }

export interface RequestResult {
  status: "granted" | "waiting" | "aborted";
  /** Transactions aborted by this request (the requester, wounded holders or a deadlock victim). */
  aborted: number[];
  /** Locks granted to other transactions as a side effect (after an abort released locks). */
  grantedOthers: { txn: number; res: string; mode: LMode }[];
  /** Waits-for cycle that a detection found. */
  cycle: number[] | null;
  /** Transactions that the requester conflicted with. */
  blockers: number[];
  note: string;
}

export const tn = (t: number) => `T${t + 1}`;

export class LockManager {
  table = new Map<string, LockEntry>();
  aborted = new Set<number>();
  committed = new Set<number>();
  /** Resources each transaction holds or waits for (an index, so release does not scan the table). */
  private touched = new Map<number, Set<string>>();
  /** The resource each waiting transaction waits for. */
  private waitRes = new Map<number, string>();
  constructor(public policy: Policy, public ts: (t: number) => number = (t) => t) {}

  private touch(txn: number, res: string) {
    let s = this.touched.get(txn);
    if (!s) this.touched.set(txn, (s = new Set()));
    s.add(res);
  }

  holds(txn: number, res: string): LMode | null {
    return this.table.get(res)?.granted.find((h) => h.txn === txn)?.mode ?? null;
  }

  /** The resource that txn waits for, if any. */
  waitingOn(txn: number): string | null {
    return this.waitRes.get(txn) ?? null;
  }

  /** Who stands in the way of txn getting `mode` on res. Waiters ahead count only for a new (non-upgrade) request. */
  blockers(txn: number, res: string, mode: LMode, upgrade: boolean, queueLimit = Infinity): number[] {
    const e = this.table.get(res);
    if (!e) return [];
    const out = new Set<number>();
    for (const h of e.granted) if (h.txn !== txn && !compat(h.mode, mode)) out.add(h.txn);
    if (!upgrade) {
      e.queue.slice(0, queueLimit).forEach((w) => { if (w.txn !== txn && !compat(w.mode, mode)) out.add(w.txn); });
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Read-only check: would txn get these locks now? Returns the conflicts. */
  check(txn: number, req: [string, LMode][]): { res: string; mode: LMode; want: LMode; blockers: number[] }[] {
    const out: { res: string; mode: LMode; want: LMode; blockers: number[] }[] = [];
    for (const [res, mode] of req) {
      const held = this.holds(txn, res);
      const want = held ? sup(held, mode) : mode;
      const b = this.blockers(txn, res, want, held !== null);
      if (b.length) out.push({ res, mode, want, blockers: b });
    }
    return out;
  }

  private grant(txn: number, res: string, mode: LMode) {
    const e = this.entry(res);
    if (this.waitRes.get(txn) === res) {
      this.waitRes.delete(txn);
      e.queue = e.queue.filter((w) => w.txn !== txn);
    }
    this.touch(txn, res);
    const h = e.granted.find((x) => x.txn === txn);
    if (h) h.mode = mode;
    else e.granted.push({ txn, mode });
  }

  private entry(res: string): LockEntry {
    let e = this.table.get(res);
    if (!e) this.table.set(res, (e = { granted: [], queue: [] }));
    return e;
  }

  request(txn: number, res: string, mode: LMode): RequestResult {
    const r: RequestResult = { status: "granted", aborted: [], grantedOthers: [], cycle: null, blockers: [], note: "" };
    if (this.aborted.has(txn)) return { ...r, status: "aborted", note: `${tn(txn)} was aborted already.` };
    const held = this.holds(txn, res);
    const want = held ? sup(held, mode) : mode;
    if (held === want) return { ...r, note: `${tn(txn)} already holds ${held} on ${res}.` };
    const upgrade = held !== null;
    let b = this.blockers(txn, res, want, upgrade);
    r.blockers = b;
    if (b.length === 0) {
      this.grant(txn, res, want);
      r.note = upgrade ? `${tn(txn)} converts ${held} to ${want} on ${res}.` : `${tn(txn)} gets ${want} on ${res}.`;
      return r;
    }
    const older = (a: number, c: number) => this.ts(a) < this.ts(c);
    switch (this.policy) {
      case "no-wait":
        this.abort(txn, r);
        r.status = "aborted";
        r.note = `${want} on ${res} conflicts with ${b.map(tn).join(", ")}. No-wait: ${tn(txn)} aborts.`;
        return r;
      case "wait-die":
        if (!b.every((h) => older(txn, h))) {
          this.abort(txn, r);
          r.status = "aborted";
          r.note = `${tn(txn)} is younger than ${b.filter((h) => !older(txn, h)).map(tn).join(", ")}. Wait-die: the younger requester dies.`;
          return r;
        }
        this.enqueue(txn, res, want, upgrade);
        r.status = "waiting";
        r.note = `${tn(txn)} is older than ${b.map(tn).join(", ")}. Wait-die: the older requester waits.`;
        return r;
      case "wound-wait": {
        const young: number[] = [];
        // Wound every younger blocker; an abort can grant locks to queued younger waiters, so repeat.
        for (let y = b.filter((h) => older(txn, h)); y.length; y = b.filter((h) => older(txn, h))) {
          for (const h of y) { young.push(h); this.abort(h, r); }
          b = this.blockers(txn, res, want, upgrade);
        }
        if (b.length === 0) {
          this.grant(txn, res, want);
          r.note = `${tn(txn)} is older: it wounds ${young.map(tn).join(", ")} and gets ${want} on ${res}.`;
          return r;
        }
        this.enqueue(txn, res, want, upgrade);
        r.status = "waiting";
        r.note = young.length
          ? `${tn(txn)} wounds ${young.map(tn).join(", ")} and waits for the older ${b.map(tn).join(", ")}.`
          : `${tn(txn)} is younger than ${b.map(tn).join(", ")}. Wound-wait: the younger requester waits.`;
        return r;
      }
      case "detect": {
        this.enqueue(txn, res, want, upgrade);
        r.status = "waiting";
        r.note = `${tn(txn)} waits for ${b.map(tn).join(", ")}.`;
        const cyc = this.findCycle(txn);
        if (cyc) {
          r.cycle = cyc;
          const ring = cyc.slice(0, -1);
          const victim = ring.reduce((v, x) => (this.ts(x) > this.ts(v) ? x : v));
          this.abort(victim, r);
          if (victim === txn) r.status = "aborted";
          else if (this.holds(txn, res) === want) r.status = "granted";
          r.note = `Cycle ${cyc.map(tn).join(" → ")}. The youngest, ${tn(victim)}, is the victim.`;
        }
        return r;
      }
    }
  }

  private enqueue(txn: number, res: string, mode: LMode, upgrade: boolean) {
    const e = this.entry(res);
    this.touch(txn, res);
    this.waitRes.set(txn, res);
    const w: Waiter = { txn, mode, upgrade };
    if (upgrade) {
      // Conversions go ahead of new requests.
      const i = e.queue.findIndex((x) => !x.upgrade);
      if (i < 0) e.queue.push(w);
      else e.queue.splice(i, 0, w);
    } else e.queue.push(w);
  }

  /** Waits-for edges: each waiter → each holder or earlier waiter that blocks it. */
  waitsFor(): { from: number; to: number; res: string }[] {
    const out: { from: number; to: number; res: string }[] = [];
    for (const [res, e] of this.table) {
      e.queue.forEach((w, i) => {
        for (const b of this.blockers(w.txn, res, w.mode, w.upgrade, i)) out.push({ from: w.txn, to: b, res });
      });
    }
    return out;
  }

  /** A waits-for cycle through txn, as [txn, ..., txn]. */
  findCycle(txn: number): number[] | null {
    const out = (u: number): number[] => {
      const res = this.waitRes.get(u);
      if (res === undefined) return [];
      const e = this.table.get(res)!;
      const i = e.queue.findIndex((w) => w.txn === u);
      const w = e.queue[i]!;
      return this.blockers(u, res, w.mode, w.upgrade, i);
    };
    const path: number[] = [];
    const seen = new Set<number>();
    const dfs = (u: number): number[] | null => {
      path.push(u);
      seen.add(u);
      for (const to of out(u)) {
        if (to === txn) return [...path, txn];
        if (!seen.has(to)) {
          const c = dfs(to);
          if (c) return c;
        }
      }
      path.pop();
      return null;
    };
    return dfs(txn);
  }

  /** Any cycle in the waits-for graph. */
  anyCycle(): number[] | null {
    for (const t of [...this.waitRes.keys()].sort((a, b) => a - b)) {
      const c = this.findCycle(t);
      if (c) return c;
    }
    return null;
  }

  /**
   * Periodic detection: a grant after a release can close a cycle that no request checked.
   * Breaks every cycle by aborting its youngest member. Returns the victims.
   */
  resolveDeadlocks(): number[] {
    const victims: number[] = [];
    for (let c = this.anyCycle(); c; c = this.anyCycle()) {
      const v = c.slice(0, -1).reduce((a, x) => (this.ts(x) > this.ts(a) ? x : a));
      this.abort(v);
      victims.push(v);
    }
    return victims;
  }

  private abort(txn: number, r?: RequestResult) {
    this.aborted.add(txn);
    r?.aborted.push(txn);
    const g = this.releaseAll(txn);
    r?.grantedOthers.push(...g);
  }

  /** Releases every lock and wait of txn (commit or abort) and grants waiters in FIFO order. */
  releaseAll(txn: number): { txn: number; res: string; mode: LMode }[] {
    const granted: { txn: number; res: string; mode: LMode }[] = [];
    const mine = [...(this.touched.get(txn) ?? [])].sort();
    this.touched.delete(txn);
    this.waitRes.delete(txn);
    for (const res of mine) {
      const e = this.table.get(res);
      if (!e) continue;
      e.granted = e.granted.filter((h) => h.txn !== txn);
      e.queue = e.queue.filter((w) => w.txn !== txn);
      while (e.queue.length) {
        const w = e.queue[0]!;
        if (this.blockers(w.txn, res, w.mode, true).length) break;
        this.grant(w.txn, res, w.mode);
        granted.push({ txn: w.txn, res, mode: w.mode });
      }
      if (!e.granted.length && !e.queue.length) this.table.delete(res);
    }
    return granted;
  }

  commit(txn: number) {
    this.committed.add(txn);
    return this.releaseAll(txn);
  }

  /** Aborts txn from outside (for example a timeout). */
  abortTxn(txn: number) {
    const r: RequestResult = { status: "aborted", aborted: [], grantedOthers: [], cycle: null, blockers: [], note: "" };
    this.abort(txn, r);
    return r;
  }
}

// ---------------------------------------------------------------- scripted stepper

export type LockLine = { txn: number; res: string; mode: LMode } | { txn: number; commit: true };

export interface LockScript { id: string; name: string; txns: number; lines: LockLine[] }

const L = (t: number, mode: LMode, res: string): LockLine => ({ txn: t - 1, res, mode });
const C = (t: number): LockLine => ({ txn: t - 1, commit: true });

export const LOCK_SCRIPTS: LockScript[] = [
  { id: "two", name: "Two-way deadlock", txns: 2, lines: [L(1, "X", "A"), L(2, "X", "B"), L(1, "X", "B"), L(2, "X", "A"), C(1), C(2)] },
  { id: "upgrade", name: "Upgrade deadlock", txns: 2, lines: [L(1, "S", "A"), L(2, "S", "A"), L(1, "X", "A"), L(2, "X", "A"), C(1), C(2)] },
  { id: "three", name: "Three-way cycle", txns: 3, lines: [L(1, "X", "A"), L(2, "X", "B"), L(3, "X", "C"), L(1, "X", "B"), L(2, "X", "C"), L(3, "X", "A"), C(1), C(2), C(3)] },
  { id: "queue", name: "FIFO queue, no deadlock", txns: 4, lines: [L(1, "S", "A"), L(2, "S", "A"), L(3, "X", "A"), L(4, "S", "A"), C(1), C(2), C(3), C(4)] },
];

export const lineText = (l: LockLine) => ("commit" in l ? `${tn(l.txn)} commit` : `${tn(l.txn)} ${l.mode}(${l.res})`);

export interface LockFrame {
  /** Index of the script line that ran, or -1 for the start. */
  line: number;
  text: string;
  table: { res: string; granted: Holder[]; queue: Waiter[] }[];
  waits: { from: number; to: number; res: string }[];
  cycle: number[] | null;
  aborted: number[];
  committed: number[];
  /** Lines not run yet, in the order they will run. */
  pending: number[];
  tone: "good" | "bad" | null;
}

function snapshot(m: LockManager): Pick<LockFrame, "table" | "waits" | "aborted" | "committed"> {
  return {
    table: [...m.table.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([res, e]) => ({ res, granted: e.granted.map((h) => ({ ...h })), queue: e.queue.map((w) => ({ ...w })) })),
    waits: m.waitsFor(),
    aborted: [...m.aborted].sort(),
    committed: [...m.committed].sort(),
  };
}

/**
 * Runs a script under a policy. A line of a waiting transaction is deferred until its lock is granted;
 * a line of an aborted transaction is dropped.
 */
export function runLockScript(script: LockScript, policy: Policy): LockFrame[] {
  const m = new LockManager(policy);
  let pending = script.lines.map((_, i) => i);
  const frames: LockFrame[] = [{ line: -1, text: "Start. No transaction holds a lock.", ...snapshot(m), cycle: null, pending: [...pending], tone: null }];
  while (pending.length) {
    const idx = pending.findIndex((i) => {
      const t = script.lines[i]!.txn;
      return m.aborted.has(t) || m.waitingOn(t) === null;
    });
    if (idx < 0) break;
    const i = pending[idx]!;
    pending = pending.filter((_, k) => k !== idx);
    const line = script.lines[i]!;
    if (m.aborted.has(line.txn)) {
      frames.push({ line: i, text: `Skip "${lineText(line)}": ${tn(line.txn)} was aborted. It restarts later with its old timestamp.`, ...snapshot(m), cycle: null, pending: [...pending], tone: null });
      continue;
    }
    if ("commit" in line) {
      const g = m.commit(line.txn);
      frames.push({ line: i, text: `${tn(line.txn)} commits and releases its locks.${g.length ? ` ${g.map((x) => `${tn(x.txn)} gets ${x.mode} on ${x.res}`).join(", ")}.` : ""}`, ...snapshot(m), cycle: null, pending: [...pending], tone: "good" });
      continue;
    }
    const r = m.request(line.txn, line.res, line.mode);
    const extra = r.grantedOthers.length ? ` ${r.grantedOthers.map((x) => `${tn(x.txn)} gets ${x.mode} on ${x.res}`).join(", ")}.` : "";
    frames.push({ line: i, text: r.note + extra, ...snapshot(m), cycle: r.cycle, pending: [...pending], tone: r.aborted.length ? "bad" : r.status === "granted" ? "good" : null });
  }
  return frames;
}

/** Summary of a script run: who aborted and how many frames it took. */
export function scriptSummary(script: LockScript, policy: Policy) {
  const f = runLockScript(script, policy);
  const last = f[f.length - 1]!;
  return { aborted: last.aborted, committed: last.committed, cycles: f.filter((x) => x.cycle).length, steps: f.length - 1 };
}

// ---------------------------------------------------------------- lock hierarchy

/** A table with pages and rows: table → page → row. */
export const HIER = {
  table: "T",
  pages: ["P1", "P2"],
  rows: { P1: ["r1", "r2"], P2: ["r3", "r4"] } as Record<string, string[]>,
};
export const pageOf = (row: string) => Object.entries(HIER.rows).find(([, rs]) => rs.includes(row))![0];

export type HierAction = "read-row" | "write-row" | "scan-table" | "scan-update" | "write-table";
export const HIER_ACTIONS: { id: HierAction; label: string; needsRow: boolean }[] = [
  { id: "read-row", label: "Read one row", needsRow: true },
  { id: "write-row", label: "Update one row", needsRow: true },
  { id: "scan-table", label: "Read the whole table", needsRow: false },
  { id: "scan-update", label: "Read all, update one row", needsRow: true },
  { id: "write-table", label: "Update the whole table", needsRow: false },
];

/** The locks an action takes, from the root down (multi-granularity locking protocol). */
export function hierLocks(action: HierAction, row = "r1"): [string, LMode][] {
  const p = pageOf(row);
  switch (action) {
    case "read-row": return [[HIER.table, "IS"], [p, "IS"], [row, "S"]];
    case "write-row": return [[HIER.table, "IX"], [p, "IX"], [row, "X"]];
    case "scan-table": return [[HIER.table, "S"]];
    case "scan-update": return [[HIER.table, "SIX"], [p, "IX"], [row, "X"]];
    case "write-table": return [[HIER.table, "X"]];
  }
}
