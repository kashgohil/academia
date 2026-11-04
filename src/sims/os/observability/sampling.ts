/**
 * A sampling profiler against a tracer, on the same list of events.
 * The sampler fires at a fixed rate and looks at what runs at that instant. The tracer records each event.
 */
import { mulberry32 } from "../../rng";

/** The usual rate for `perf record -F`. It is not 100, so that the samples do not stay in step with a 100 Hz timer. */
export const PROFILER_HZ = 99;

/** MODEL INPUTS. Round figures, and not measurements. */
export const SAMPLE_INPUTS = {
  /** One sample: an interrupt and a stack walk. */
  sampleNs: 5000,
  /** One traced event: a tracepoint and a record in a buffer. */
  traceEventNs: 200,
} as const;

export interface Workload {
  /** Length of one event. */
  eventMs: number;
  /** Events per second. */
  eventRate: number;
  /** Run length. */
  seconds: number;
  seed?: number;
  /** Events come at exact intervals, and not at random times. */
  periodic?: boolean;
  /** The phase of a periodic event. */
  phase?: number;
}

export interface SampleResult {
  /** Events that really happened. */
  events: number;
  /** Events with at least one sample inside. */
  seen: number;
  /** All samples. */
  samples: number;
  /** Samples that fell inside an event. */
  hits: number;
  trueShare: number;
  estShare: number;
  /** Start and end of the events, in seconds. */
  spans: [number, number][];
  /** Sample times, in seconds. */
  times: number[];
}

/** The events of a workload: non-overlapping intervals. */
export function makeEvents(w: Workload): [number, number][] {
  const d = w.eventMs / 1000;
  const out: [number, number][] = [];
  if (w.periodic) {
    const p = 1 / w.eventRate;
    for (let t = (w.phase ?? 0) * p; t + d <= w.seconds; t += p) out.push([t, t + d]);
    return out;
  }
  const rng = mulberry32(w.seed ?? 1);
  let t = 0;
  for (;;) {
    t += -Math.log(1 - rng()) / w.eventRate;
    if (t + d > w.seconds) break;
    out.push([t, t + d]);
    t += d;
  }
  return out;
}

/** Run the sampler over the events. Both lists are sorted, so this is one merge. */
export function simulateSampler(w: Workload, hz = PROFILER_HZ, phase = 0.37): SampleResult {
  const spans = makeEvents(w);
  const times: number[] = [];
  let hits = 0, seen = 0, k = 0;
  const hitEvents = new Uint8Array(spans.length);
  const period = 1 / hz;
  for (let i = 0; ; i++) {
    const t = (i + phase) * period;
    if (t >= w.seconds) break;
    times.push(t);
    while (k < spans.length && spans[k]![1] <= t) k++;
    const s = spans[k];
    if (s && t >= s[0] && t < s[1]) {
      hits++;
      if (!hitEvents[k]) {
        hitEvents[k] = 1;
        seen++;
      }
    }
  }
  const busy = spans.reduce((a, s) => a + (s[1] - s[0]), 0);
  return { events: spans.length, seen, samples: times.length, hits, trueShare: busy / w.seconds, estShare: times.length ? hits / times.length : 0, spans, times };
}

// ---------------------------------------------------------------------------- the formulas

/** The chance that one event of this length holds a sample. */
export const pSeen = (eventMs: number, hz = PROFILER_HZ) => Math.min(1, (eventMs / 1000) * hz);
/** Expected samples inside events. */
export const expectedHits = (eventMs: number, eventRate: number, seconds: number, hz = PROFILER_HZ) => (eventMs / 1000) * eventRate * seconds * hz;
/** The chance that a whole run has no sample inside any event. */
export const pMissAll = (eventMs: number, eventRate: number, seconds: number, hz = PROFILER_HZ) => Math.pow(1 - pSeen(eventMs, hz), eventRate * seconds);

/** The share of one CPU that each tool takes. */
export const samplerCpuShare = (hz = PROFILER_HZ) => (hz * SAMPLE_INPUTS.sampleNs) / 1e9;
export const tracerCpuShare = (eventRate: number) => (eventRate * SAMPLE_INPUTS.traceEventNs) / 1e9;
/** The event rate at which the tracer costs as much as the sampler. */
export const breakEvenEventRate = (hz = PROFILER_HZ) => (hz * SAMPLE_INPUTS.sampleNs) / SAMPLE_INPUTS.traceEventNs;

/** A periodic task against a sampler: the share that the sampler reports, at the given rate. */
export function lockstepShare(taskHz: number, taskMs: number, samplerHz: number, seconds: number, phase: number): { trueShare: number; estShare: number } {
  const r = simulateSampler({ eventMs: taskMs, eventRate: taskHz, seconds, periodic: true, phase: 0 }, samplerHz, phase);
  return { trueShare: r.trueShare, estShare: r.estShare };
}
