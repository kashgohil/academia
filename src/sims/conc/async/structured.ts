/**
 * Structured concurrency.
 *
 * - runTree(): a request handler starts a tree of tasks. One leaf can fail. Three disciplines:
 *   "unstructured" (spawn and forget, as a bare `go` statement or a detached tokio::spawn): a parent returns at the
 *   first error it sees, and its other children run on as orphans; "structured" (a nursery, errgroup, TaskGroup,
 *   coroutineScope): the first failure cancels the siblings, the scope waits until they stop, and then the error goes
 *   up; "supervisor" (supervisorScope): a failure stays local, the siblings finish.
 *   Cancellation is cooperative: a cancelled task stops at its next checkpoint (an await, or a ctx.Done() check).
 *   `checkMs` is the time between checkpoints of a busy task; 0 means it stops at once.
 * - leakRun(): requests with a client timeout fan out to backends with a long-tailed latency. Without structure,
 *   the backend calls of a timed-out request run on; with it, they are cancelled at the timeout.
 */
import { mulberry32, normal } from "../../rng";

export interface TNode { name: string; ms?: number; children?: TNode[] }

export const REQUEST_TREE: TNode = {
  name: "handler",
  children: [
    { name: "user", ms: 40 },
    { name: "orders", children: [{ name: "orders db", ms: 90 }, { name: "orders cache", ms: 30 }] },
    { name: "ads", ms: 120 },
  ],
};

export type Discipline = "unstructured" | "structured" | "supervisor";

export interface TreeParams { discipline: Discipline; fail: { name: string; at: number } | null; checkMs: number }

export type NodeStatus = "ok" | "failed" | "cancelled" | "partial";

export interface NodeRun {
  name: string;
  depth: number;
  parent: string | null;
  start: number;
  end: number;
  status: NodeStatus;
  /** When the cancel request reached it, if it did. */
  cancelAt?: number;
  /** When its parent returned. Time after that is orphan time. */
  parentEnd?: number;
  /** When the failure happened (for the failed leaf). */
  failAt?: number;
}

export interface TreeResult {
  nodes: NodeRun[];
  /** When the handler returns, and with what. */
  rootEnd: number;
  rootStatus: NodeStatus;
  /** When the last task stops. */
  lastEnd: number;
  /** Leaf time after the handler returned: work that nobody waits for. */
  orphanMs: number;
  /** Tasks still running when the handler returned. */
  orphans: number;
}

const leafEnd = (n: TNode, P: TreeParams) => {
  const failAt = P.fail && P.fail.name === n.name && P.fail.at < n.ms! ? P.fail.at : undefined;
  return { natural: failAt ?? n.ms!, failAt };
};

/** When a busy leaf that started at `start` notices a cancel sent at `c`: its next checkpoint. */
const stopTime = (start: number, c: number, checkMs: number) => (checkMs <= 0 ? c : start + Math.ceil((c - start) / checkMs - 1e-9) * checkMs);

export function runTree(root: TNode, P: TreeParams): TreeResult {
  const out: NodeRun[] = [];
  /** Runs a subtree that starts at `start` and receives a cancel at `cancel` (Infinity: never). */
  const sim = (n: TNode, depth: number, parent: string | null, start: number, cancel: number): { end: number; failed: boolean; idx: number[] } => {
    const idx = out.length;
    out.push({ name: n.name, depth, parent, start, end: start, status: "ok" });
    if (!n.children) {
      const { natural, failAt } = leafEnd(n, P);
      const me = out[idx]!;
      if (cancel < natural && P.discipline === "structured") {
        me.end = Math.min(natural, stopTime(start, cancel, P.checkMs));
        me.cancelAt = cancel;
        me.status = failAt !== undefined && failAt <= me.end ? "failed" : "cancelled";
        if (me.status === "failed") { me.end = failAt!; me.failAt = failAt; }
        return { end: me.end, failed: me.status === "failed", idx: [idx] };
      }
      me.end = natural;
      if (failAt !== undefined) { me.status = "failed"; me.failAt = failAt; }
      return { end: me.end, failed: failAt !== undefined, idx: [idx] };
    }
    // A scope. First run every child with the cancel we got; then, if one fails, cancel the others at that time.
    const runAll = (c: number) => {
      out.length = idx + 1;
      return n.children!.map((ch) => sim(ch, depth + 1, n.name, start, c));
    };
    let kids = runAll(cancel);
    const me = () => out[idx]!;
    if (P.discipline === "structured") {
      const firstFail = Math.min(...kids.filter((k) => k.failed).map((k) => k.end));
      if (firstFail < cancel) kids = runAll(firstFail);
      const failed = kids.some((k) => k.failed);
      me().end = Math.max(...kids.map((k) => k.end));
      const anyCancelled = kids.some((k) => out[k.idx[0]!]!.status === "cancelled");
      me().status = failed ? "failed" : anyCancelled ? "cancelled" : "ok";
      if (cancel < Infinity && anyCancelled) me().cancelAt = cancel;
      return { end: me().end, failed, idx: [idx] };
    }
    if (P.discipline === "supervisor") {
      me().end = Math.max(...kids.map((k) => k.end));
      me().status = kids.some((k) => k.failed || out[k.idx[0]!]!.status === "partial") ? "partial" : "ok";
      return { end: me().end, failed: false, idx: [idx] };
    }
    // Unstructured: return at the first error seen, or when all children have sent their results.
    const firstFail = Math.min(...kids.filter((k) => k.failed).map((k) => k.end));
    const failed = firstFail < Infinity;
    me().end = failed ? firstFail : Math.max(...kids.map((k) => k.end));
    me().status = failed ? "failed" : "ok";
    return { end: me().end, failed, idx: [idx] };
  };
  sim(root, 0, null, 0, Infinity);
  const byName = new Map(out.map((n) => [n.name, n]));
  for (const n of out) if (n.parent) n.parentEnd = byName.get(n.parent)!.end;
  const r = out[0]!;
  const leaves = out.filter((n) => !findNode(root, n.name)!.children);
  return {
    nodes: out,
    rootEnd: r.end,
    rootStatus: r.status,
    lastEnd: Math.max(...out.map((n) => n.end)),
    orphanMs: leaves.reduce((a, n) => a + Math.max(0, n.end - Math.max(n.start, r.end)), 0),
    orphans: out.filter((n) => n !== r && n.end > r.end).length,
  };
}

export function findNode(n: TNode, name: string): TNode | undefined {
  if (n.name === name) return n;
  for (const c of n.children ?? []) {
    const f = findNode(c, name);
    if (f) return f;
  }
  return undefined;
}

// ---------------------------------------------------------------- leaks under timeouts

export interface LeakParams {
  /** Requests per ms. */
  rate: number;
  /** Backend calls per request. */
  fanout: number;
  /** Median and 99th percentile of the backend latency, ms (lognormal). */
  medianMs: number;
  p99Ms: number;
  /** Client timeout, ms. */
  timeoutMs: number;
  /** Run length, ms. */
  durationMs: number;
  seed: number;
}

export const LEAK_DEFAULTS: LeakParams = { rate: 1, fanout: 3, medianMs: 20, p99Ms: 400, timeoutMs: 50, durationMs: 2_000, seed: 11 };

export interface LeakResult {
  /** Live backend calls over time, sampled every ms: [t, unstructured, structured]. */
  series: [number, number, number][];
  peak: { unstructured: number; structured: number };
  /** Mean live calls in the second half (steady state). */
  mean: { unstructured: number; structured: number };
  /** Share of calls still running at the timeout. */
  pastTimeout: number;
  /** Backend ms spent after the client had gone, per second of run. */
  wastedPerSec: number;
}

const Z99 = 2.3263478740408408;

/** Lognormal backend latencies; requests arrive at a fixed rate. */
export function leakRun(over: Partial<LeakParams> = {}): LeakResult {
  const P = { ...LEAK_DEFAULTS, ...over };
  const rng = mulberry32(P.seed);
  const sigma = Math.log(P.p99Ms / P.medianMs) / Z99;
  const T = P.durationMs;
  const du = new Float64Array(T + 2), ds = new Float64Array(T + 2);
  let calls = 0, past = 0, wasted = 0;
  const gap = 1 / P.rate;
  for (let t0 = 0; t0 < T; t0 += gap) {
    for (let k = 0; k < P.fanout; k++) {
      const L = P.medianMs * Math.exp(sigma * normal(rng));
      calls++;
      if (L > P.timeoutMs) { past++; wasted += Math.min(L, T - t0) - P.timeoutMs; }
      const a = Math.floor(t0);
      du[a]! += 1; ds[a]! += 1;
      const eu = Math.min(T + 1, Math.floor(t0 + L)), es = Math.min(T + 1, Math.floor(t0 + Math.min(L, P.timeoutMs)));
      du[eu]! -= 1; ds[es]! -= 1;
    }
  }
  const series: [number, number, number][] = [];
  let u = 0, s = 0, pu = 0, ps = 0, su = 0, ss = 0, n = 0;
  for (let t = 0; t <= T; t++) {
    u += du[t]!; s += ds[t]!;
    series.push([t, u, s]);
    pu = Math.max(pu, u); ps = Math.max(ps, s);
    if (t >= T / 2) { su += u; ss += s; n++; }
  }
  return {
    series,
    peak: { unstructured: pu, structured: ps },
    mean: { unstructured: su / n, structured: ss / n },
    pastTimeout: past / calls,
    wastedPerSec: Math.max(0, wasted) / (T / 1000),
  };
}
