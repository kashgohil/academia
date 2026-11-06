/**
 * Retries against an overloaded server, on Net.
 *
 * Node 0 is a server with one worker and a bounded queue. A request costs `serviceMs` of work. When the queue holds
 * `queueCap` requests, a new one is rejected at once with "busy". The server is down during `outage`; on restart its
 * queue is empty.
 *
 * Nodes 1..N are clients. New requests arrive in an open loop: a Poisson stream at `load` times the server capacity,
 * each at a random client, whether or not old requests are done (users and upstream services do not wait).
 * An attempt fails on "busy" or when no answer comes within `timeoutMs`. Then the client waits for the backoff of its
 * policy and tries again, up to `maxAttempts` attempts per request. An answer to an abandoned attempt is ignored,
 * so the server work for it is wasted.
 *
 * Backoff before retry a (a = 1, 2, …), with span c = min(cap, base * 2^(a - 1)):
 *   none: 0;  exponential: c;  full jitter: a uniform random time in [0, c).
 */
import { Net } from "../net";

export type Policy = "none" | "exponential" | "full-jitter";
export const POLICIES: Policy[] = ["none", "exponential", "full-jitter"];
export const POLICY_TEXT: Record<Policy, string> = { none: "no backoff", exponential: "exponential", "full-jitter": "full jitter" };

export interface RetryConfig {
  clients: number;
  policy: Policy;
  seed: number;
  /** New requests per ms, as a fraction of the server capacity 1 / serviceMs. */
  load: number;
  /** Requests that all start at t = 0, in addition to the open loop (for the burst test). */
  burst: number;
  /** Server work per request in ms (model input). */
  serviceMs: number;
  queueCap: number;
  timeoutMs: number;
  baseMs: number;
  capMs: number;
  maxAttempts: number;
  outage: { from: number; to: number } | null;
  horizon: number;
  latency: { min: number; max: number };
  /** Width of a time bucket for the time series, in ms. */
  bucket: number;
  /**
   * A retry budget per client, as in gRPC retry throttling: a client holds up to 10 tokens, a failed attempt costs 1,
   * a success gives back 0.1, and a retry is allowed only while the client holds more than half of the maximum.
   * So in the long run retries are at most about 10% of successes.
   */
  budget: boolean;
}

export const RETRY_DEFAULTS: RetryConfig = {
  clients: 8,
  policy: "none",
  seed: 1,
  load: 0.7,
  burst: 0,
  serviceMs: 1,
  queueCap: 60,
  timeoutMs: 40,
  baseMs: 10,
  capMs: 1000,
  maxAttempts: 6,
  outage: { from: 300, to: 500 },
  horizon: 2000,
  latency: { min: 2, max: 6 },
  bucket: 20,
  budget: false,
};

export const BUDGET = { max: 10, ratio: 0.1 };

type RMsg = { k: "req"; att: number } | { k: "ok"; att: number } | { k: "busy"; att: number };

export interface RetryResult {
  /** Attempts sent per bucket. */
  sent: number[];
  /** Requests that succeeded per bucket. */
  good: number[];
  /** Server work per bucket on attempts that nobody waits for any more. */
  waste: number[];
  /** Server queue length at the end of each bucket. */
  queue: number[];
  requests: number;
  attempts: number;
  succeeded: number;
  gaveUp: number;
  rejected: number;
  /** Server work (ms) on attempts that their client had already abandoned. */
  wastedMs: number;
  /** Server work (ms) in total. */
  workMs: number;
  /** The largest number of attempts in one bucket after the outage ends (the retry storm). */
  peakAfter: number;
  /** Mean attempts per new request. */
  amplification: number;
  /** Send times of retries (attempt >= 2), for the bound test. */
  retryTimes: number[];
  /** Successful requests per ms in the last quarter of the run. */
  goodputEnd: number;
  /** Successful requests per ms before the outage. */
  goodputBefore: number;
}

export function backoff(policy: Policy, retry: number, baseMs: number, capMs: number, rnd: () => number): number {
  const c = Math.min(capMs, baseMs * 2 ** (retry - 1));
  return policy === "none" ? 0 : policy === "exponential" ? c : rnd() * c;
}

/**
 * The bound for full jitter: retry a waits a uniform time over a span of min(cap, base * 2^(a - 1)), so its send time
 * has a density of at most 1 / span, whatever happened before. So the expected number of retries that R requests send
 * in any window of w ms is at most R * (sum over a of min(1, w / span(a))).
 */
export function fullJitterBound(requests: number, w: number, baseMs: number, capMs: number, maxAttempts: number): number {
  let s = 0;
  // Retry a lands in a window of w ms with probability at most min(1, w / span(a)).
  for (let a = 1; a < maxAttempts; a++) s += Math.min(1, w / Math.min(capMs, baseMs * 2 ** (a - 1)));
  return requests * s;
}

interface Req {
  node: number;
  tries: number;
  /** The attempt id the client waits for; 0 when it does not wait. */
  att: number;
  timer: number;
}

export function retrySim(cfgIn: Partial<RetryConfig> = {}): RetryResult {
  const cfg: RetryConfig = { ...RETRY_DEFAULTS, ...cfgIn };
  const { clients, policy, serviceMs, queueCap, timeoutMs, baseMs, capMs, maxAttempts, outage, horizon, bucket } = cfg;
  const nb = Math.ceil(horizon / bucket);
  const zeros = () => new Array<number>(nb).fill(0);
  const res: RetryResult = {
    sent: zeros(), good: zeros(), waste: zeros(), queue: zeros(),
    requests: 0, attempts: 0, succeeded: 0, gaveUp: 0, rejected: 0, wastedMs: 0, workMs: 0, peakAfter: 0, amplification: 0, retryTimes: [], goodputEnd: 0, goodputBefore: 0,
  };
  const reqs: Req[] = [];
  /** Attempt id to request index. */
  const owner = new Map<number, number>();
  let nextAtt = 1;
  const tokens = new Array<number>(clients + 1).fill(BUDGET.max);
  let queue: number[] = [];
  let busy = false;
  const b = (t: number) => Math.min(nb - 1, Math.floor(t / bucket));

  const net: Net<RMsg> = new Net<RMsg>(clients + 1, { seed: cfg.seed, latency: cfg.latency }, {
    onMessage(node, msg, nt) {
      const p = msg.payload;
      if (node === 0) {
        if (p.k !== "req") return;
        if (queue.length >= queueCap) {
          res.rejected++;
          nt.send(0, msg.from, { k: "busy", att: p.att });
          return;
        }
        queue.push(p.att);
        if (!busy) startService(nt);
        return;
      }
      if (p.k === "req") return;
      const ri = owner.get(p.att);
      if (ri === undefined) return;
      const r = reqs[ri]!;
      if (r.att !== p.att) return; // an answer to an abandoned attempt
      nt.cancelTimer(r.timer);
      r.att = 0;
      if (p.k === "ok") {
        tokens[r.node] = Math.min(BUDGET.max, tokens[r.node]! + BUDGET.ratio);
        res.succeeded++;
        res.good[b(nt.now)]! += 1;
      } else fail(ri, nt);
    },
    onTimer(node, tag, nt) {
      if (node === 0) {
        if (tag !== "svc") return;
        const att = queue.shift()!;
        res.workMs += serviceMs;
        const r = reqs[owner.get(att)!]!;
        if (r.att !== att) {
          res.wastedMs += serviceMs;
          res.waste[b(nt.now)]! += serviceMs;
        }
        nt.send(0, r.node, { k: "ok", att });
        busy = false;
        if (queue.length) startService(nt);
        return;
      }
      const [kind, id] = tag.split(":");
      const ri = Number(id);
      if (kind === "retry") attempt(ri, nt);
      else if (kind === "timeout" && reqs[ri]!.att !== 0) {
        reqs[ri]!.att = 0;
        fail(ri, nt);
      }
    },
    onRecover(node) {
      if (node === 0) {
        queue = [];
        busy = false;
      }
    },
  });

  function startService(nt: Net<RMsg>) {
    busy = true;
    nt.setTimer(0, serviceMs, "svc");
  }

  function newRequest(nt: Net<RMsg>) {
    const node = 1 + Math.floor(nt.random() * clients);
    reqs.push({ node, tries: 0, att: 0, timer: 0 });
    res.requests++;
    attempt(reqs.length - 1, nt);
  }

  function attempt(ri: number, nt: Net<RMsg>) {
    const r = reqs[ri]!;
    r.tries++;
    r.att = nextAtt++;
    owner.set(r.att, ri);
    res.attempts++;
    res.sent[b(nt.now)]! += 1;
    if (r.tries >= 2) res.retryTimes.push(nt.now);
    nt.send(r.node, 0, { k: "req", att: r.att });
    r.timer = nt.setTimer(r.node, timeoutMs, `timeout:${ri}`);
  }

  function fail(ri: number, nt: Net<RMsg>) {
    const r = reqs[ri]!;
    tokens[r.node] = Math.max(0, tokens[r.node]! - 1);
    if (r.tries >= maxAttempts || (cfg.budget && tokens[r.node]! <= BUDGET.max / 2)) {
      res.gaveUp++;
      return;
    }
    nt.setTimer(r.node, backoff(policy, r.tries, baseMs, capMs, () => nt.random()), `retry:${ri}`);
  }

  // The arrival times of new requests: a Poisson stream, drawn from the run's seed.
  const rate = cfg.load / serviceMs;
  const arrivals: number[] = [];
  if (rate > 0) for (let t = -Math.log(1 - net.random()) / rate; t < horizon; t += -Math.log(1 - net.random()) / rate) arrivals.push(t);
  const events: { t: number; run: () => void }[] = arrivals.map((t) => ({ t, run: () => newRequest(net) }));
  for (let i = 0; i < cfg.burst; i++) events.push({ t: 0, run: () => newRequest(net) });
  if (outage) events.push({ t: outage.from, run: () => net.crash(0) }, { t: outage.to, run: () => net.recover(0) });
  for (let t = bucket; t <= horizon + 1e-9; t += bucket) events.push({ t: t - 1e-6, run: () => void (res.queue[b(t - 1e-3)] = queue.length) });
  events.sort((x, y) => x.t - y.t);
  for (const e of events) {
    net.runUntil(e.t);
    e.run();
  }

  res.amplification = res.attempts / Math.max(1, res.requests);
  const rateOf = (from: number, to: number) => res.good.slice(b(from), b(to)).reduce((x, y) => x + y, 0) / Math.max(1e-9, to - from);
  res.goodputEnd = rateOf(horizon * 0.75, horizon);
  if (outage) {
    res.goodputBefore = rateOf(Math.max(0, outage.from - 200), outage.from);
    for (let i = b(outage.to); i < nb; i++) res.peakAfter = Math.max(res.peakAfter, res.sent[i]!);
  }
  return res;
}

export type RetryScenario = "burst" | "outage";

/**
 * The two scenarios of the lesson. `size` is in 0..1: the burst holds 300 * size requests; the steady load is
 * `size` times the server capacity.
 *  - burst: every request starts at t = 0 (a cache flush, a restart): short queue (20), up to 10 attempts;
 *  - outage: steady load, the server is down from 300 to 500 ms; a long queue (50) that holds more than a timeout.
 */
export function retryPreset(scenario: RetryScenario, size: number, timeoutMs = 40, baseMs = 10, budget = false): Partial<RetryConfig> {
  return scenario === "burst"
    ? { burst: Math.round(size * 300), load: 0, outage: null, queueCap: 20, maxAttempts: 10, horizon: 3000, bucket: 10, timeoutMs, baseMs, budget }
    : { burst: 0, load: size, outage: { from: 300, to: 500 }, queueCap: 50, maxAttempts: 6, horizon: 2000, bucket: 20, timeoutMs, baseMs, budget };
}

/** Retries multiply across layers: each of `layers` services makes up to `attempts` attempts, so the bottom sees attempts^layers. */
export const layeredAttempts = (attempts: number, layers: number) => attempts ** layers;
