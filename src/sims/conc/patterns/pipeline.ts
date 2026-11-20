/**
 * A pipeline on the shared Runtime: a source, stages connected by bounded channels, and a sink.
 *
 * - The source emits `items` items as fast as the first channel accepts them (or one every `sourceNs`).
 * - Each stage has `replicas` threads. A replica receives a batch, works `costNs` per item (times a random factor when
 *   `jitter` > 0), pays `handoffNs` once per batch, and sends the batch on. The last replica of a stage to finish
 *   closes the next channel.
 * - The sink records when each item leaves. With `ordered`, it holds items in a reorder buffer and lets them out in
 *   sequence order, as a serial_in_order filter of oneTBB does.
 * - With `tokens` > 0, a semaphore bounds the items in flight: the source takes a token per batch, and the sink
 *   gives it back when the batch leaves (oneTBB's max_number_of_live_tokens).
 *
 * Model inputs: stage costs, `handoffNs` (the cost of one channel handoff: a lock, a few cache misses, sometimes a
 * wake-up), and the Runtime's wakeNs and switchNs. With enough cores, the throughput is the minimum over stages of
 * replicas / (cost per item + handoffNs / batch), and the latency of one item is at least the sum of the stage costs.
 */
import { Runtime, type RunResult } from "../runtime";

export interface StageSpec {
  name: string;
  costNs: number;
  replicas: number;
  /** 0: every item costs costNs. j > 0: cost = costNs × ((1 − j) + j × Exp(1)), the same mean, a long tail. */
  jitter?: number;
}

export interface PipelineConfig {
  stages: StageSpec[];
  items: number;
  /** Capacity of each channel, in batches. 0 is a rendezvous. */
  capacity: number;
  /** Cores. Default: one per thread. */
  cores?: number;
  ordered: boolean;
  /** Live-token limit in batches; 0: no limit. */
  tokens: number;
  /** Items per message. */
  batch: number;
  /** Core time that each send costs the sender, once per batch (model input). */
  handoffNs: number;
  /** Time between two items at the source; 0: as fast as the pipeline takes them. */
  sourceNs: number;
  seed: number;
  record: boolean;
  /** Override the Runtime's wake-up delay (model input, default 5 µs). */
  wakeNs?: number;
}

export const PIPE_DEFAULTS: PipelineConfig = {
  stages: [
    { name: "parse", costNs: 20_000, replicas: 1 },
    { name: "resize", costNs: 60_000, replicas: 1 },
    { name: "encode", costNs: 30_000, replicas: 1 },
    { name: "write", costNs: 10_000, replicas: 1 },
  ],
  items: 40, capacity: 2, ordered: false, tokens: 0, batch: 1, handoffNs: 0, sourceNs: 0, seed: 1, record: true,
};

interface Msg { seq: number; items: number[]; born: number[] }

export interface PipelineResult {
  run: RunResult;
  /** Items per second, measured from the first to the last item out. */
  throughput: number;
  /** Items per second that the slowest stage allows (the model's prediction with enough cores). */
  predicted: number;
  /** The stage with the lowest capacity. */
  bottleneck: number;
  /** Latency per item (from the source's send to the sink's output), by sequence number. */
  latency: number[];
  meanLatency: number;
  p99Latency: number;
  maxLatency: number;
  /** Sum of the stage costs: the latency of one item in an empty pipeline. */
  minLatency: number;
  /** The most batches that the reorder buffer held. */
  reorderMax: number;
  /** Batches that reached the sink while an earlier batch was still missing. */
  outOfOrder: number;
  /** The output order of batch numbers at the sink, before the reorder buffer. */
  arrival: number[];
  /** Mean utilization of each stage (busy time / (replicas × makespan)). */
  util: number[];
  /** The most batches each channel held. */
  maxQueue: number[];
  makespan: number;
}

/** Items per second for a stage: replicas / (cost + handoff / batch). */
export const stageRate = (s: StageSpec, batch: number, handoffNs: number) => (s.replicas * 1e9) / (s.costNs + handoffNs / batch);

export function runPipeline(cfg: Partial<PipelineConfig> = {}): PipelineResult {
  const c: PipelineConfig = { ...PIPE_DEFAULTS, ...cfg };
  const batch = Math.max(1, Math.floor(c.batch));
  const nThreads = 2 + c.stages.reduce((a, s) => a + s.replicas, 0);
  const rt = new Runtime({ cores: c.cores ?? nThreads, seed: c.seed, record: c.record, ...(c.wakeNs !== undefined ? { wakeNs: c.wakeNs } : {}) });
  const chans = Array.from({ length: c.stages.length + 1 }, (_, i) => rt.channel<Msg>(`q${i}`, c.capacity));
  const tokens = c.tokens > 0 ? rt.semaphore("tokens", c.tokens) : null;
  const batches = Math.ceil(c.items / batch);
  const out = new Array<number>(c.items).fill(0);
  const born = new Array<number>(c.items).fill(0);
  const arrival: number[] = [];
  let reorderMax = 0, outOfOrder = 0, first = -1, last = 0;

  rt.spawn("source", function* (t) {
    for (let b = 0; b < batches; b++) {
      const items: number[] = [];
      for (let i = b * batch; i < Math.min(c.items, (b + 1) * batch); i++) {
        if (c.sourceNs > 0) yield* t.work(c.sourceNs, "emit");
        items.push(i);
      }
      if (tokens) yield* t.acquire(tokens);
      const now = t.now();
      const msg: Msg = { seq: b, items, born: items.map(() => now) };
      if (c.handoffNs > 0) yield* t.work(c.handoffNs, "send");
      yield* t.send(chans[0]!, msg);
    }
    t.close(chans[0]!);
  });

  c.stages.forEach((s, k) => {
    let left = s.replicas;
    for (let r = 0; r < s.replicas; r++) {
      rt.spawn(s.replicas > 1 ? `${s.name}.${r}` : s.name, function* (t) {
        for (;;) {
          const m = yield* t.recv(chans[k]!);
          if (!m.ok) break;
          let ns = 0;
          for (let i = 0; i < m.value.items.length; i++) {
            const j = s.jitter ?? 0;
            ns += j > 0 ? s.costNs * (1 - j + j * -Math.log(1 - t.rand())) : s.costNs;
          }
          yield* t.work(ns, s.name);
          if (c.handoffNs > 0) yield* t.work(c.handoffNs, "send");
          yield* t.send(chans[k + 1]!, m.value);
        }
        if (--left === 0) t.close(chans[k + 1]!);
      });
    }
  });

  rt.spawn("sink", function* (t) {
    const held = new Map<number, Msg>();
    const arrived = new Set<number>();
    let next = 0, missing = 0;
    const emit = (m: Msg) => {
      const now = t.now();
      m.items.forEach((i, x) => {
        out[i] = now;
        born[i] = m.born[x]!;
      });
      if (first < 0) first = now;
      last = now;
      if (tokens) t.release(tokens);
    };
    for (;;) {
      const m = yield* t.recv(chans[c.stages.length]!);
      if (!m.ok) break;
      arrival.push(m.value.seq);
      // Out of order: an earlier batch has not arrived yet.
      arrived.add(m.value.seq);
      if (m.value.seq !== missing) outOfOrder++;
      while (arrived.has(missing)) missing++;
      if (!c.ordered) {
        emit(m.value);
        next = m.value.seq + 1;
        continue;
      }
      held.set(m.value.seq, m.value);
      reorderMax = Math.max(reorderMax, held.size);
      while (held.has(next)) {
        emit(held.get(next)!);
        held.delete(next);
        next++;
      }
    }
  });

  const run = rt.run();
  const latency = out.map((o, i) => o - born[i]!);
  const sorted = [...latency].sort((a, b) => a - b);
  const rates = c.stages.map((s) => stageRate(s, batch, c.handoffNs));
  const bottleneck = rates.indexOf(Math.min(...rates));
  const span = last - first;
  const makespan = run.makespan;
  const util = c.stages.map((s) => {
    const names = new Set(s.replicas > 1 ? Array.from({ length: s.replicas }, (_, r) => `${s.name}.${r}`) : [s.name]);
    const busy = run.threads.filter((th) => names.has(th.name)).reduce((a, th) => a + th.runNs, 0);
    return makespan > 0 ? busy / (s.replicas * makespan) : 0;
  });
  return {
    run,
    throughput: span > 0 ? ((c.items - Math.min(batch, c.items)) * 1e9) / span : 0,
    predicted: Math.min(...rates),
    bottleneck,
    latency,
    meanLatency: latency.reduce((a, b) => a + b, 0) / Math.max(1, latency.length),
    p99Latency: sorted[Math.min(sorted.length - 1, Math.ceil(0.99 * sorted.length) - 1)] ?? 0,
    maxLatency: sorted[sorted.length - 1] ?? 0,
    minLatency: c.stages.reduce((a, s) => a + s.costNs, 0),
    reorderMax, outOfOrder, arrival, util,
    maxQueue: run.channels.map((ch) => ch.maxLen),
    makespan,
  };
}
