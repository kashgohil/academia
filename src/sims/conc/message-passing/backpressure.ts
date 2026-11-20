/**
 * Sims for "Backpressure", on the shared Runtime.
 *
 * - runOverload: an open-loop source (Poisson arrivals that do not wait for anyone) feeds one consumer through a
 *   queue, with a policy for a full queue: unbounded, block the source, drop the newest item, or drop the oldest one.
 *   When arrivals outrun service, an unbounded queue grows by (λ − μ) items per unit of time, and so does the latency.
 * - runPipeline: a source and three stages joined by channels. With bounded channels, a slow stage fills the channel
 *   before it, then the stage before that blocks, and so on back to the source: backpressure travels upstream, and the
 *   items in flight stay below the sum of the capacities plus one item per stage.
 * - runCredits: a publisher and a subscriber on a link with a one-way delay. The subscriber grants credits (Reactive
 *   Streams `request(n)`); the publisher sends only while it has credit. Throughput is about min(1/service,
 *   window/RTT): a window smaller than service rate × round trip leaves the subscriber idle.
 */
import { Runtime, type RunResult, type Thread } from "../runtime";

const exp = (mean: number, u: number) => -mean * Math.log(1 - u);

/** The q-quantile of a list of numbers (nearest rank). */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

// ---------------------------------------------------------------- overload and full-queue policies

export type Policy = "unbounded" | "block" | "drop-newest" | "drop-oldest";

export interface OverloadConfig {
  policy: Policy;
  /** Queue capacity (ignored by "unbounded"). */
  capacity: number;
  /** Offered load: arrival rate / service rate. */
  load: number;
  serviceNs: number;
  durationNs: number;
  sampleNs: number;
  seed: number;
}

export const OVERLOAD_DEFAULTS: OverloadConfig = { policy: "unbounded", capacity: 50, load: 1.2, serviceNs: 100_000, durationNs: 200_000_000, sampleNs: 1_000_000, seed: 11 };

export interface OverloadResult {
  /** [time, items in the queue, items that arrived but wait at the source]. */
  samples: [number, number, number][];
  /** [completion time, latency from arrival to completion], one point per delivered item. */
  latency: [number, number][];
  arrived: number;
  delivered: number;
  dropped: number;
  maxQueue: number;
  p50: number;
  p99: number;
}

export function runOverload(cfg: Partial<OverloadConfig> = {}): OverloadResult {
  const c = { ...OVERLOAD_DEFAULTS, ...cfg };
  const rt = new Runtime({ cores: 2, seed: c.seed, record: false });
  // The arrival schedule does not depend on the policy: draw it first.
  const draw = new Runtime({ seed: c.seed });
  const arrivals: number[] = [];
  for (let t = exp(c.serviceNs / c.load, draw.random()); t < c.durationNs; t += exp(c.serviceNs / c.load, draw.random())) arrivals.push(t);
  const cap = c.policy === "unbounded" ? Infinity : c.capacity;
  const q = rt.channel<number>("queue", cap);
  let handed = 0, dropped = 0;
  rt.spawn("source", function* (t) {
    for (const born of arrivals) {
      if (born > t.now()) yield* t.sleep(born - t.now());
      if (c.policy === "block" || c.policy === "unbounded") yield* t.send(q, born);
      else if (!t.trySend(q, born)) {
        dropped++;
        // Drop newest: this item is lost. Drop oldest: the head is lost, and this item takes its place.
        if (c.policy === "drop-oldest") {
          t.tryRecv(q);
          t.trySend(q, born);
        }
      }
      handed++;
    }
    t.close(q);
  });
  const latency: [number, number][] = [];
  rt.spawn("consumer", function* (t) {
    for (;;) {
      const r = yield* t.recv(q);
      if (!r.ok) return;
      yield* t.work(c.serviceNs);
      latency.push([t.now(), t.now() - r.value]);
    }
  });
  const samples: [number, number, number][] = [];
  rt.spawn("sampler", function* (t) {
    let k = 0;
    while (t.now() <= c.durationNs) {
      while (k < arrivals.length && arrivals[k]! <= t.now()) k++;
      samples.push([t.now(), q.buf.length, Math.max(0, k - handed)]);
      yield* t.sleep(c.sampleNs);
    }
  });
  const res = rt.run({ untilNs: c.durationNs });
  const lats = latency.map((p) => p[1]);
  // Drop-oldest counts the evicted item when it is evicted; drop-newest counts the refused one.
  return {
    samples, latency, arrived: arrivals.length, delivered: latency.length, dropped,
    maxQueue: res.channels[0]!.maxLen, p50: quantile(lats, 0.5), p99: quantile(lats, 0.99),
  };
}

// ---------------------------------------------------------------- a pipeline of stages

export interface PipelineConfig {
  /** Work per item of each stage, in order. */
  stageNs: number[];
  /** Work per item of the source. */
  sourceNs: number;
  /** Capacity of every channel. */
  capacity: number;
  /** Unbounded channels instead. */
  unbounded: boolean;
  items: number;
  seed: number;
}

export const PIPELINE_DEFAULTS: PipelineConfig = { stageNs: [10_000, 10_000, 40_000], sourceNs: 5_000, capacity: 2, unbounded: false, items: 30, seed: 1 };

export interface PipelineResult {
  result: RunResult;
  /** The most items that had left the source but not the last stage. */
  maxInFlight: number;
  /** Per channel, the most items it held. */
  maxLens: number[];
  latencies: number[];
  meanLatency: number;
  maxLatency: number;
  makespan: number;
  /** Items per ms over the run. */
  throughputPerMs: number;
}

/** In-flight bound with bounded channels: every channel full, every stage holds one item, the source holds one. */
export const inFlightBound = (stages: number, capacity: number) => stages * capacity + stages + 1;

export function runPipeline(cfg: Partial<PipelineConfig> = {}): PipelineResult {
  const c = { ...PIPELINE_DEFAULTS, ...cfg };
  const n = c.stageNs.length;
  const rt = new Runtime({ cores: n + 1, seed: c.seed });
  type Item = { i: number; born: number };
  const chans = c.stageNs.map((_, k) => rt.channel<Item>(`c${k}`, c.unbounded ? Infinity : c.capacity));
  let made = 0, finished = 0, maxInFlight = 0;
  const latencies: number[] = [];
  rt.spawn("source", function* (t) {
    for (let i = 0; i < c.items; i++) {
      // The item exists from the moment the source starts to make it.
      const born = t.now();
      made++;
      maxInFlight = Math.max(maxInFlight, made - finished);
      yield* t.work(c.sourceNs, `${i}`);
      yield* t.send(chans[0]!, { i, born });
    }
    t.close(chans[0]!);
  });
  c.stageNs.forEach((ns, k) => {
    rt.spawn(`stage ${k + 1}`, function* (t) {
      for (;;) {
        const r = yield* t.recv(chans[k]!);
        if (!r.ok) break;
        yield* t.work(ns, `${r.value.i}`);
        if (k + 1 < n) yield* t.send(chans[k + 1]!, r.value);
        else {
          finished++;
          latencies.push(t.now() - r.value.born);
        }
      }
      if (k + 1 < n) t.close(chans[k + 1]!);
    });
  });
  const result = rt.run();
  const mean = latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);
  return {
    result, maxInFlight, maxLens: result.channels.map((ch) => ch.maxLen), latencies, meanLatency: mean,
    maxLatency: Math.max(0, ...latencies), makespan: result.makespan, throughputPerMs: (c.items / result.makespan) * 1e6,
  };
}

// ---------------------------------------------------------------- credit-based flow control

export interface CreditConfig {
  /** Credits the subscriber keeps outstanding: request(window) at the start, then request(1) per item it finishes. */
  window: number;
  /** One-way link delay. */
  delayNs: number;
  /** Subscriber work per item. */
  serviceNs: number;
  /** Publisher work per item. */
  publishNs: number;
  items: number;
  seed: number;
  record?: boolean;
}

export const CREDIT_DEFAULTS: CreditConfig = { window: 4, delayNs: 50_000, serviceNs: 10_000, publishNs: 1_000, items: 60, seed: 1 };

export interface CreditResult {
  result: RunResult;
  makespan: number;
  /** Items per ms over the whole run, and in steady state (from the first finished item to the last). */
  throughputPerMs: number;
  steadyPerMs: number;
  /** The most items delivered to the subscriber and not yet processed. */
  maxBuffered: number;
  /** Share of the run that the subscriber spent working. */
  subscriberBusy: number;
}

/** The window that keeps the subscriber busy: its service rate times the round trip of a credit and an item. */
export const windowNeeded = (c: Pick<CreditConfig, "delayNs" | "serviceNs" | "publishNs">) => (2 * c.delayNs + c.publishNs + c.serviceNs) / c.serviceNs;

/** The model's throughput bound: the subscriber's rate, or one window per round trip, whichever is lower (items/ms). */
export const creditBound = (c: Pick<CreditConfig, "window" | "delayNs" | "serviceNs" | "publishNs">) =>
  Math.min(1 / c.serviceNs, c.window / (2 * c.delayNs + c.publishNs + c.serviceNs)) * 1e6;

export function runCredits(cfg: Partial<CreditConfig> = {}): CreditResult {
  const c = { ...CREDIT_DEFAULTS, ...cfg };
  // Costs off: this model is about the link delay, not about thread wake-ups.
  const rt = new Runtime({ cores: 4, seed: c.seed, switchNs: 0, wakeNs: 0, lockNs: 0, transferNs: 0, record: c.record ?? true });
  type Stamped = { v: number; sent: number };
  const upIn = rt.channel<Stamped>("request(n) out", Infinity), upOut = rt.channel<number>("credits", Infinity);
  const downIn = rt.channel<Stamped>("items out", Infinity), downOut = rt.channel<number>("inbox", Infinity);
  // A wire delivers each message `delayNs` after it was sent. The delay is constant, so FIFO order is kept.
  const wire = (from: typeof upIn, to: typeof upOut) =>
    function* (t: Thread) {
      for (;;) {
        const r = yield* t.recv(from);
        if (!r.ok) return;
        const due = r.value.sent + c.delayNs;
        if (due > t.now()) yield* t.sleep(due - t.now());
        yield* t.send(to, r.value.v);
      }
    };
  rt.spawn("publisher", function* (t) {
    let credit = 0;
    for (let i = 0; i < c.items; i++) {
      while (credit === 0) {
        const r = yield* t.recv(upOut);
        if (!r.ok) return;
        credit += r.value;
        // Take every grant that has already arrived.
        for (let x = t.tryRecv(upOut); x?.ok; x = t.tryRecv(upOut)) credit += x.value;
      }
      credit--;
      yield* t.work(c.publishNs, "publish");
      yield* t.send(downIn, { v: i, sent: t.now() });
    }
    t.close(downIn);
  });
  rt.spawn("wire →", wire(downIn, downOut));
  rt.spawn("wire ←", wire(upIn, upOut));
  let maxBuffered = 0;
  const doneAt: number[] = [];
  rt.spawn("subscriber", function* (t) {
    yield* t.send(upIn, { v: c.window, sent: t.now() });
    for (let got = 0; got < c.items; got++) {
      const r = yield* t.recv(downOut);
      if (!r.ok) break;
      maxBuffered = Math.max(maxBuffered, downOut.buf.length + 1);
      yield* t.work(c.serviceNs, "process");
      doneAt.push(t.now());
      if (got + c.window < c.items) yield* t.send(upIn, { v: 1, sent: t.now() });
    }
    t.close(upIn);
  });
  const result = rt.run();
  const sub = result.threads.find((th) => th.name === "subscriber")!;
  return {
    result, makespan: result.makespan, throughputPerMs: (c.items / result.makespan) * 1e6, maxBuffered,
    steadyPerMs: doneAt.length > 1 ? ((doneAt.length - 1) / (doneAt[doneAt.length - 1]! - doneAt[0]!)) * 1e6 : 0,
    subscriberBusy: sub.runNs / result.makespan,
  };
}
