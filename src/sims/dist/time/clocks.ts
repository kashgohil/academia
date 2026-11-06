/**
 * Physical clocks: drift, offset, steps and smears, and what last-write-wins does with them.
 * A node's clock reads C(t) = t × (1 + drift) + offset (see Net.clock). Drift is a rate error: 50 ppm = 50e-6.
 *
 * Model inputs (labelled in the lessons): quartz oscillators in servers drift by roughly 1 to 100 ppm, and the drift
 * changes with temperature and age. The sims take the drift as a parameter; they do not claim a value for any part.
 */
import { Net } from "../net";

export const PPM = 1e-6;
export const MS_PER_DAY = 86_400_000;
export const MS_PER_HOUR = 3_600_000;

/** How far a clock with this drift moves away from true time in one day, in ms. 1 ppm gives 86.4 ms. */
export const driftPerDay = (ppm: number) => ppm * PPM * MS_PER_DAY;

/** How long until two clocks with this relative drift are `ms` apart, in hours. */
export const hoursToDiverge = (ms: number, relPpm: number) => ms / (relPpm * PPM) / MS_PER_HOUR;

export interface DriftCfg {
  /** Drift per node in ppm. */
  ppm: number[];
  /** Offset per node in ms at time 0. */
  offset: number[];
  hours: number;
  samples: number;
}

export interface DriftSeries {
  /** Per node: [hours, clock − true time in ms]. */
  error: [number, number][][];
  /** [hours, max − min over nodes] */
  spread: [number, number][];
  /** At the end of the run. */
  finalError: number[];
  finalSpread: number;
}

/** Reads every node's Net clock at evenly spaced times over `hours`. */
export function driftSeries(c: DriftCfg): DriftSeries {
  const n = c.ppm.length;
  const net = new Net<null>(n, { seed: 1 });
  for (let i = 0; i < n; i++) { net.drift[i] = c.ppm[i]! * PPM; net.offset[i] = c.offset[i] ?? 0; }
  const error: [number, number][][] = Array.from({ length: n }, () => []);
  const spread: [number, number][] = [];
  for (let k = 0; k <= c.samples; k++) {
    const t = (c.hours * MS_PER_HOUR * k) / c.samples;
    net.runUntil(t);
    const e = Array.from({ length: n }, (_, i) => net.clock(i) - net.now);
    e.forEach((v, i) => error[i]!.push([t / MS_PER_HOUR, v]));
    spread.push([t / MS_PER_HOUR, Math.max(...e) - Math.min(...e)]);
  }
  const fin = error.map((s) => s[s.length - 1]![1]);
  return { error, spread, finalError: fin, finalSpread: Math.max(...fin) - Math.min(...fin) };
}

// ---------------------------------------------------------------- wall clock versus monotonic clock

export interface DurationCfg {
  /** The real duration of the timed work, in ms. */
  work: number;
  /** When, inside the work, the wall clock is stepped (ms after the start). */
  stepAt: number;
  /** The size of the step in ms; negative steps the clock back (as for a leap second or an NTP correction). */
  step: number;
}

/**
 * Times one piece of work twice: with the time-of-day clock (CLOCK_REALTIME, SystemTime, a Go Time with its monotonic
 * reading stripped) and with the monotonic clock (CLOCK_MONOTONIC, Instant, a Go Time from time.Now). A step changes
 * only the time-of-day clock.
 */
export function measureDuration(c: DurationCfg) {
  const stepped = c.stepAt >= 0 && c.stepAt <= c.work;
  return { wall: c.work + (stepped ? c.step : 0), monotonic: c.work };
}

// ---------------------------------------------------------------- leap smear

/** A 24-hour linear smear (as Google's public NTP does) stretches each second by 1/86400: about 11.6 ppm. */
export const SMEAR_WINDOW_MS = MS_PER_DAY;
export const smearPpm = (windowMs = SMEAR_WINDOW_MS) => (1000 / windowMs) / PPM;

/** How much of the leap second a smeared clock has absorbed at `t` ms after the start of the smear, in ms. */
export const smearAbsorbed = (t: number, windowMs = SMEAR_WINDOW_MS) => 1000 * Math.min(1, Math.max(0, t / windowMs));

// ---------------------------------------------------------------- last-write-wins with skewed clocks

export interface LwwCfg {
  /** How far B's clock is behind A's, in ms. */
  skew: number;
  /** Real time between A's write and B's write, in ms. B writes later. */
  gap: number;
  seed: number;
}

export const LWW_DEFAULT: LwwCfg = { skew: 40, gap: 25, seed: 3 };

export type LwwMsg = { k: "put"; v: string; ts: number } | { k: "ack" };

export interface LwwResult {
  net: Net<LwwMsg>;
  writes: { node: number; v: string; at: number; ts: number }[];
  /** The value that the store keeps. */
  final: string;
  /** The write that came later in real time lost. */
  lost: boolean;
}

/**
 * Node 0 (A) writes x = "A" at time 10. Node 1 (B) writes x = "B" at time 10 + gap. Each write carries the writer's
 * wall clock. The store (node 2) keeps the value with the larger timestamp (ties: larger node id), as Cassandra
 * does with cell timestamps. B's write is later in real time, so it should win. It loses when skew > gap.
 */
export function lwwRun(cfg: Partial<LwwCfg> = {}): LwwResult {
  const c = { ...LWW_DEFAULT, ...cfg };
  let best: { v: string; ts: number; node: number } | null = null;
  const writes: LwwResult["writes"] = [];
  const net: Net<LwwMsg> = new Net<LwwMsg>(3, { seed: c.seed, latency: { min: 5, max: 15 } }, {
    onMessage(node, m, x) {
      const p = m.payload;
      if (node === 2 && p.k === "put") {
        if (!best || p.ts > best.ts || (p.ts === best.ts && m.from > best.node)) best = { v: p.v, ts: p.ts, node: m.from };
        x.send(2, m.from, { k: "ack" });
      }
    },
    onTimer(node, _tag, x) {
      const ts = Math.round(x.clock(node) * 1000) / 1000;
      const v = node === 0 ? "A" : "B";
      writes.push({ node, v, at: x.now, ts });
      x.send(node, 2, { k: "put", v, ts });
    },
  });
  net.offset[1] = -c.skew;
  net.setTimer(0, 10, "write");
  net.setTimer(1, 10 + c.gap, "write");
  net.runAll();
  const final = (best as { v: string } | null)?.v ?? "";
  return { net, writes, final, lost: final !== "B" };
}
