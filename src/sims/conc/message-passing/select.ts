/**
 * Sims for "Go channels and select", on the shared Runtime.
 *
 * - runSelectFairness: one consumer serves two channels, "high" and "low", fed by two open-loop producers. Mode
 *   "random" is Go's select: it picks uniformly among the ready cases. Mode "priority" is the Go idiom of a select on
 *   high with a default case, and then a select on both. Under load, the priority idiom starves low.
 * - runLeak: requests that call a slow backend in a new goroutine and wait for the result or a timeout. With an
 *   unbuffered result channel, a worker that finishes after the timeout blocks on its send forever: a goroutine leak.
 *   A buffer of 1, or a select on a done channel (what context cancellation does), removes the leak.
 *
 * GO_COSTS are the cost model inputs for goroutines. A goroutine switch and wake-up stay in user space and are much
 * cheaper than the thread defaults of the Runtime. The values are an order of magnitude, not a measurement.
 */
import { Runtime, type Channel, type RunResult, type Thread } from "../runtime";

export const GO_COSTS = { switchNs: 200, wakeNs: 500, lockNs: 20, transferNs: 100 } as const;

const exp = (mean: number, u: number) => -mean * Math.log(1 - u);

// ---------------------------------------------------------------- select fairness

export interface FairConfig {
  mode: "random" | "priority";
  /** Offered load of each producer, as a fraction of the consumer's capacity. */
  hiLoad: number;
  loLoad: number;
  /** Consumer work per item. */
  serviceNs: number;
  durationNs: number;
  seed: number;
}

export const FAIR_DEFAULTS: FairConfig = { mode: "random", hiLoad: 0.9, loLoad: 0.3, serviceNs: 10_000, durationNs: 20_000_000, seed: 3 };

export interface FairResult {
  hiMade: number;
  loMade: number;
  hiServed: number;
  loServed: number;
  /** The oldest low item at the end: the longest wait of a served one, or the age of the oldest unserved one. */
  loMaxWaitNs: number;
  hiMaxWaitNs: number;
}

export function runSelectFairness(cfg: Partial<FairConfig> = {}): FairResult {
  const c = { ...FAIR_DEFAULTS, ...cfg };
  const rt = new Runtime({ cores: 3, seed: c.seed, record: false, ...GO_COSTS });
  // Unbounded buffers keep the producers open loop: items are born on their Poisson schedule and wait in the channel.
  const hi = rt.channel<number>("high", Infinity), lo = rt.channel<number>("low", Infinity);
  const made = [0, 0];
  const producer = (ch: Channel<number>, load: number, k: number) =>
    function* (t: Thread) {
      if (load <= 0) return;
      for (;;) {
        yield* t.sleep(exp(c.serviceNs / load, t.rand()));
        if (t.now() > c.durationNs) return;
        made[k]!++;
        t.trySend(ch, t.now());
      }
    };
  rt.spawn("high producer", producer(hi, c.hiLoad, 0));
  rt.spawn("low producer", producer(lo, c.loLoad, 1));
  const served = [0, 0], maxWait = [0, 0];
  rt.spawn("consumer", function* (t) {
    const both = [{ recv: hi }, { recv: lo }] as const;
    while (t.now() < c.durationNs) {
      // The priority idiom: take high if it is ready now; only otherwise wait on both.
      let s = c.mode === "priority" ? yield* t.select([{ recv: hi }] as const, { default: true }) : { index: -1 };
      if (s.index === -1) s = yield* t.select(both);
      const k = s.index;
      served[k]!++;
      maxWait[k] = Math.max(maxWait[k]!, t.now() - (s as { value?: number }).value!);
      yield* t.work(c.serviceNs);
    }
  });
  rt.run({ untilNs: c.durationNs });
  const age = (ch: Channel<number>) => (ch.buf.length ? c.durationNs - ch.buf[0]! : 0);
  return {
    hiMade: made[0]!, loMade: made[1]!, hiServed: served[0]!, loServed: served[1]!,
    hiMaxWaitNs: Math.max(maxWait[0]!, age(hi)), loMaxWaitNs: Math.max(maxWait[1]!, age(lo)),
  };
}

/** A consumer selects over two channels that always hold a value, `n` times. Returns how often each case won. */
export function selectBothReady(n: number, seed = 1): [number, number] {
  const rt = new Runtime({ seed, record: false });
  const a = rt.channel<number>("a", 1), b = rt.channel<number>("b", 1);
  const wins: [number, number] = [0, 0];
  rt.spawn("consumer", function* (t) {
    for (let i = 0; i < n; i++) {
      t.trySend(a, 0);
      t.trySend(b, 0);
      const s = yield* t.select([{ recv: a }, { recv: b }]);
      wins[s.index as 0 | 1]++;
    }
  });
  rt.run();
  return wins;
}

// ---------------------------------------------------------------- goroutine leaks

export type LeakMode = "unbuffered" | "buffered" | "context";

export interface LeakConfig {
  mode: LeakMode;
  timeoutNs: number;
  requests: number;
  /** Time between request arrivals. */
  spacingNs: number;
  /** Backend latency, uniform in [min, max]. */
  minLatencyNs: number;
  maxLatencyNs: number;
  seed: number;
}

export const LEAK_DEFAULTS: LeakConfig = { mode: "unbuffered", timeoutNs: 150_000, requests: 5, spacingNs: 40_000, minLatencyNs: 50_000, maxLatencyNs: 300_000, seed: 2 };

export interface LeakResult {
  result: RunResult;
  /** Per request: "ok" (the result came first) or "timeout". */
  outcomes: ("ok" | "timeout")[];
  latencies: number[];
  /** Names of the goroutines still blocked when everything else finished. */
  leaked: string[];
}

export function runLeak(cfg: Partial<LeakConfig> = {}): LeakResult {
  const c = { ...LEAK_DEFAULTS, ...cfg };
  const rt = new Runtime({ cores: 4, seed: c.seed, ...GO_COSTS });
  const draw = new Runtime({ seed: c.seed });
  const latencies = Array.from({ length: c.requests }, () => Math.round(c.minLatencyNs + (c.maxLatencyNs - c.minLatencyNs) * draw.random()));
  const outcomes: ("ok" | "timeout")[] = [];
  // One timer goroutine stands in for the runtime's timers. Every timer has the same timeout and requests arrive in
  // order, so deadlines arrive in order: the timer goroutine can sleep until the oldest one.
  const timers = rt.channel<{ deadline: number; ch: Channel<number> }>("timers", Infinity);
  rt.spawn("timers", function* (t) {
    for (let fired = 0; fired < c.requests; fired++) {
      const r = yield* t.recv(timers);
      if (!r.ok) return;
      if (r.value.deadline > t.now()) yield* t.sleep(r.value.deadline - t.now());
      // Like time.After before Go 1.23: a channel with a buffer of 1, so the timer never blocks.
      t.trySend(r.value.ch, t.now());
    }
  });
  for (let i = 0; i < c.requests; i++) {
    rt.at(i * c.spacingNs, (rt) => {
      rt.spawn(`req ${i}`, function* (t) {
        const res = rt.channel<number>(`res ${i}`, c.mode === "buffered" ? 1 : 0);
        const done = rt.channel<never>(`done ${i}`, 0);
        const after = rt.channel<number>(`after ${i}`, 1);
        t.spawn(`worker ${i}`, function* (w) {
          yield* w.sleep(latencies[i]!);
          if (c.mode === "context") yield* w.select([{ send: res, value: i }, { recv: done }]);
          else yield* w.send(res, i);
        });
        yield* t.send(timers, { deadline: t.now() + c.timeoutNs, ch: after });
        const s = yield* t.select([{ recv: res }, { recv: after }]);
        outcomes[i] = s.index === 0 ? "ok" : "timeout";
        yield* t.work(2_000, s.index === 0 ? "reply" : "504");
        // defer cancel(): closing done releases a worker that selects on it.
        if (c.mode === "context") t.close(done);
      });
    });
  }
  const result = rt.run();
  return { result, outcomes, latencies, leaked: result.deadlock?.blocked.map((b) => b.name) ?? [] };
}
