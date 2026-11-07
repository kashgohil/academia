/**
 * Balancing policies and the latency they give: a queueing model of N servers behind one dispatcher.
 *
 * Requests arrive as a Poisson stream. Each server serves its own queue in arrival order (FCFS), one request at a
 * time, with exponential service times (a model input: mean `meanMs`). The model has servers, not links, so it does
 * not use PacketNet. Because each queue is FCFS, a request's departure is max(arrival, last departure) + service,
 * and the number of requests at a server at time t is the number of its departures after t. That makes the
 * simulation exact without an event heap.
 *
 * Policies: random, round robin, least connections (join the shortest queue, with exact counts), and the power of
 * two choices (sample two servers, use the one with fewer requests). With `staleMs` > 0 the dispatcher sees counts
 * that are refreshed only every `staleMs` (a bulletin board, as when many balancers share load reports).
 * `slow` makes server 0 that many times slower (a bad disk, a noisy neighbour).
 *
 * Closed forms (Mitzenmacher, IEEE TPDS 12(10), 2001, the "supermarket model" for many servers): with load λ and d
 * choices, the fraction of queues with at least i requests is λ^((dⁱ−1)/(d−1)), and the mean time in the system is
 * Σ λ^((dⁱ−d)/(d−1)) service times. For d = 1 (random), these are λⁱ and 1/(1−λ).
 */
import { mulberry32 } from "../../rng";

export type Policy = "random" | "rr" | "lc" | "p2c";
export const POLICIES: Policy[] = ["random", "rr", "lc", "p2c"];
export const POLICY_LABEL: Record<Policy, string> = { random: "random", rr: "round robin", lc: "least connections", p2c: "power of two choices" };

export interface PolicyOpts {
  policy: Policy;
  servers?: number;
  /** Offered load: arrival rate over the total nominal capacity (all servers at full speed). */
  load: number;
  requests?: number;
  /** Mean service time in ms (model input). */
  meanMs?: number;
  /** Server 0 is this many times slower. 1: all equal. */
  slow?: number;
  /** Refresh period of the load counts that the dispatcher sees. 0: exact counts. */
  staleMs?: number;
  seed?: number;
}

export interface PolicyResult {
  /** Response times in ms after warm-up, sorted. */
  sorted: Float64Array;
  mean: number;
  p50: number;
  p99: number;
  p999: number;
  /** Requests each server received. */
  perServer: number[];
}

export const quantile = (sorted: ArrayLike<number>, q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;

export function policyRun(o: PolicyOpts): PolicyResult {
  const N = o.servers ?? 10, n = o.requests ?? 60_000, mean = o.meanMs ?? 10, slow = o.slow ?? 1, stale = o.staleMs ?? 0;
  const rng = mulberry32(o.seed ?? 3);
  const lambda = (o.load * N) / mean; // requests per ms
  const deps: number[][] = Array.from({ length: N }, () => []); // departure times still in the future, per server
  const head = new Array<number>(N).fill(0);
  const last = new Array<number>(N).fill(0);
  const perServer = new Array<number>(N).fill(0);
  const count = (s: number, t: number) => {
    const d = deps[s]!;
    let h = head[s]!;
    while (h < d.length && d[h]! <= t) h++;
    head[s] = h;
    if (h > 4096) { d.splice(0, h); head[s] = 0; }
    return d.length - head[s]!;
  };
  let snap = new Array<number>(N).fill(0), snapAt = -Infinity;
  let rr = 0, t = 0;
  const warm = Math.floor(n * 0.1);
  const out = new Float64Array(n - warm);
  for (let i = 0; i < n; i++) {
    t += -Math.log(1 - rng()) / lambda;
    if (stale > 0 && t >= snapAt + stale) {
      // The board is refreshed at multiples of `stale`; a request sees the counts of the last refresh.
      snapAt = Math.floor(t / stale) * stale;
      snap = Array.from({ length: N }, (_, s) => count(s, snapAt));
    }
    const load = (s: number) => (stale > 0 ? snap[s]! : count(s, t));
    let s: number;
    switch (o.policy) {
      case "random": s = Math.floor(rng() * N); break;
      case "rr": s = rr; rr = (rr + 1) % N; break;
      case "lc": {
        // Ties go to a random server among the least loaded, so that no server is favoured.
        let best = Infinity, k = 0;
        s = 0;
        for (let j = 0; j < N; j++) {
          const c = load(j);
          if (c < best) { best = c; s = j; k = 1; }
          else if (c === best && rng() * ++k < 1) s = j;
        }
        break;
      }
      case "p2c": {
        const a = Math.floor(rng() * N);
        let b = Math.floor(rng() * (N - 1));
        if (b >= a) b++;
        const la = load(a), lb = load(b);
        s = la < lb ? a : lb < la ? b : rng() < 0.5 ? a : b;
        break;
      }
    }
    const service = -Math.log(1 - rng()) * mean * (s === 0 ? slow : 1);
    const dep = Math.max(t, last[s]!) + service;
    last[s] = dep;
    deps[s]!.push(dep);
    perServer[s]!++;
    if (i >= warm) out[i - warm] = dep - t;
  }
  const sorted = out.sort();
  let sum = 0;
  for (const x of sorted) sum += x;
  return { sorted, mean: sum / sorted.length, p50: quantile(sorted, 0.5), p99: quantile(sorted, 0.99), p999: quantile(sorted, 0.999), perServer };
}

/** Mean time in the system, in service times, for d random choices in the supermarket model (many servers). */
export function supermarketMean(load: number, d: number): number {
  if (d === 1) return 1 / (1 - load);
  let s = 0;
  for (let i = 1; i < 64; i++) {
    const term = Math.pow(load, (Math.pow(d, i) - d) / (d - 1));
    s += term;
    if (term < 1e-15) break;
  }
  return s;
}

/** The fraction of queues with at least i requests in the supermarket model. */
export const supermarketTail = (load: number, d: number, i: number) => (d === 1 ? Math.pow(load, i) : Math.pow(load, (Math.pow(d, i) - 1) / (d - 1)));

/** p-quantile of the response time of an M/M/1 queue (random dispatch), in service times: −ln(1−p)/(1−λ). */
export const mm1Quantile = (load: number, p: number) => -Math.log(1 - p) / (1 - load);
