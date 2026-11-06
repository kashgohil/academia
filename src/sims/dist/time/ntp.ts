/**
 * Clock synchronization: Cristian's algorithm (1989) and the NTP on-wire exchange (RFC 5905), on the shared Net.
 *
 * NTP names four timestamps. t0: the client sends (client clock). t1: the server receives (server clock).
 * t2: the server replies (server clock). t3: the client receives (client clock).
 *   offset θ = ((t1 − t0) + (t2 − t3)) / 2   (add θ to the client clock to match the server)
 *   delay  δ = (t3 − t0) − (t2 − t1)          (the round trip, less the time spent in the server)
 * If the path out takes d_out and the path back takes d_back, the error of θ is (d_out − d_back) / 2 exactly
 * (with no drift during the exchange). The client cannot see the asymmetry, so the only safe bound is |error| ≤ δ / 2.
 */
import { Net } from "../net";
import { PPM } from "./clocks";

export interface NtpSample {
  t0: number; t1: number; t2: number; t3: number;
  theta: number;
  delta: number;
  /** The real offset (server clock − client clock) at the moment of t3. */
  trueTheta: number;
  /** theta − trueTheta. */
  error: number;
}

export const ntpOffset = (t0: number, t1: number, t2: number, t3: number) => ((t1 - t0) + (t2 - t3)) / 2;
export const ntpDelay = (t0: number, t1: number, t2: number, t3: number) => (t3 - t0) - (t2 - t1);

/** Cristian: the client asks at T0, gets server time S, receives at T1 (own clock). It sets its clock to S + (T1 − T0)/2. */
export const cristianEstimate = (T0: number, S: number, T1: number) => S + (T1 - T0) / 2;

type NtpMsg = { k: "req"; t0: number } | { k: "resp"; t0: number; t1: number; t2: number };

/** Sends one message with a fixed one-way latency. */
function sendFixed<P>(net: Net<P>, from: number, to: number, payload: P, d: number) {
  net.send(from, to, payload, { delay: d });
}

export interface ExchangeCfg {
  /** Client clock − server clock, in ms, at time 0. */
  clientOffset: number;
  /** One-way latencies in ms. */
  out: number;
  back: number;
  /** Time the server takes between t1 and t2. */
  proc: number;
  /** Client clock drift in ppm (the server is perfect). */
  driftPpm?: number;
  start?: number;
}

/** One NTP exchange between client (node 0) and server (node 1). Returns the sample and the Net for drawing. */
export function ntpExchange(c: ExchangeCfg): { sample: NtpSample; net: Net<NtpMsg> } {
  let sample: NtpSample | null = null;
  const net: Net<NtpMsg> = new Net<NtpMsg>(2, { seed: 1 }, {
    onMessage(node, m, x) {
      const p = m.payload;
      if (node === 1 && p.k === "req") {
        const t1 = x.clock(1);
        x.setTimer(1, c.proc, `reply:${p.t0}:${t1}`);
      } else if (node === 0 && p.k === "resp") {
        const t3 = x.clock(0);
        const theta = ntpOffset(p.t0, p.t1, p.t2, t3);
        const trueTheta = x.clock(1) - x.clock(0);
        sample = { t0: p.t0, t1: p.t1, t2: p.t2, t3, theta, delta: ntpDelay(p.t0, p.t1, p.t2, t3), trueTheta, error: theta - trueTheta };
      }
    },
    onTimer(node, tag, x) {
      if (node === 1 && tag.startsWith("reply:")) {
        const [, t0, t1] = tag.split(":");
        sendFixed(x, 1, 0, { k: "resp", t0: Number(t0), t1: Number(t1), t2: x.clock(1) }, c.back);
      } else if (node === 0 && tag === "go") sendFixed(x, 0, 1, { k: "req", t0: x.clock(0) }, c.out);
    },
  });
  net.offset[0] = c.clientOffset;
  net.drift[0] = (c.driftPpm ?? 0) * PPM;
  net.setTimer(0, c.start ?? 0, "go");
  net.runAll();
  return { sample: sample!, net };
}

// ---------------------------------------------------------------- many samples: the wedge and the clock filter

export interface WedgeCfg {
  seed: number;
  samples: number;
  /** The fixed part of each one-way path, in ms. */
  base: number;
  /** Mean of the random queueing delay added to each direction, in ms (exponential). */
  queue: number;
  clientOffset: number;
}

export const WEDGE_DEFAULT: WedgeCfg = { seed: 5, samples: 200, base: 10, queue: 8, clientOffset: 30 };

/**
 * Many exchanges with random queueing on each direction. Plotted as error against delay, the points fill a wedge
 * with its point at the minimum delay: |error| ≤ (δ − δ_min) / 2. NTP's clock filter keeps the last 8 samples and
 * uses the one with the lowest delay, which sits near the point of the wedge.
 */
export function wedgeSamples(c: Partial<WedgeCfg> = {}): NtpSample[] {
  const w = { ...WEDGE_DEFAULT, ...c };
  const net = new Net<null>(1, { seed: w.seed });
  const exp = () => -Math.log(1 - net.random()) * w.queue;
  const out: NtpSample[] = [];
  for (let i = 0; i < w.samples; i++) {
    const s = ntpExchange({ clientOffset: w.clientOffset, out: w.base + exp(), back: w.base + exp(), proc: 1 }).sample;
    out.push(s);
  }
  return out;
}

/** The sample with the lowest delay among the last `window` samples ending at index i (NTP uses 8). */
export function clockFilter(samples: NtpSample[], i: number, window = 8): NtpSample {
  let best = samples[i]!;
  for (let j = Math.max(0, i - window + 1); j <= i; j++) if (samples[j]!.delta < best.delta) best = samples[j]!;
  return best;
}

// ---------------------------------------------------------------- a drifting clock, corrected now and then

export interface SyncCfg {
  driftPpm: number;
  /** Seconds between two exchanges. */
  interval: number;
  /** Seconds to simulate. */
  duration: number;
  /** One-way base latency and mean random queueing, in ms. */
  base: number;
  queue: number;
  /** Also estimate the drift from successive offsets and correct the rate (as NTP's clock discipline does). */
  freq: boolean;
  /** Take the best of 8 samples per correction (the clock filter) instead of one. */
  filter: boolean;
  seed: number;
  initialOffset: number;
}

export const SYNC_DEFAULT: SyncCfg = { driftPpm: 50, interval: 64, duration: 1024, base: 10, queue: 1, freq: false, filter: false, seed: 7, initialOffset: 20 };

export interface SyncResult {
  /** [seconds, client clock − true time in ms] */
  error: [number, number][];
  /** Corrections: [seconds, applied step in ms]. */
  steps: [number, number][];
  /** Largest |error| after the first correction, in ms. */
  maxAfter: number;
  /** drift × interval: how far the clock walks between corrections, in ms. */
  walk: number;
}

/**
 * A client with a drifting clock (node 0) and a perfect server (node 1). Every `interval` seconds the client runs an
 * exchange (or 8, with the filter) and steps its clock by θ. With `freq`, it also estimates its rate error from two
 * successive corrections and cancels it, so the saw-tooth flattens.
 */
export function syncRun(cfg: Partial<SyncCfg> = {}): SyncResult {
  const c = { ...SYNC_DEFAULT, ...cfg };
  const net = new Net<NtpMsg>(2, { seed: c.seed });
  net.drift[0] = c.driftPpm * PPM;
  net.offset[0] = c.initialOffset;
  const exp = () => -Math.log(1 - net.random()) * c.queue;
  const error: [number, number][] = [];
  const steps: [number, number][] = [];
  const dur = c.duration * 1000, iv = c.interval * 1000;
  const sampleEvery = Math.max(iv / 16, dur / 600);
  let nextSample = 0, nextSync = 0;
  let lastFix: { t: number; theta: number } | null = null;
  let rateFix = 0;
  while (nextSample <= dur || nextSync <= dur) {
    if (nextSample <= nextSync) {
      net.runUntil(nextSample);
      error.push([net.now / 1000, net.clock(0) - net.now]);
      nextSample += sampleEvery;
      continue;
    }
    net.runUntil(nextSync);
    // The exchange itself takes milliseconds: model it from the current clock state.
    const shots = c.filter ? 8 : 1;
    let best: NtpSample | null = null;
    for (let k = 0; k < shots; k++) {
      const out = c.base + exp(), back = c.base + exp();
      const t0 = net.clock(0);
      const tt = net.now;
      const t1 = tt + out, t2 = t1 + 1;
      const t3 = (tt + out + 1 + back) * (1 + net.drift[0]!) + net.offset[0]!;
      const s: NtpSample = { t0, t1, t2, t3, theta: ntpOffset(t0, t1, t2, t3), delta: ntpDelay(t0, t1, t2, t3), trueTheta: 0, error: 0 };
      if (!best || s.delta < best.delta) best = s;
    }
    const theta = best!.theta;
    error.push([net.now / 1000, net.clock(0) - net.now]);
    net.offset[0] = net.offset[0]! + theta;
    steps.push([net.now / 1000, theta]);
    error.push([net.now / 1000, net.clock(0) - net.now]);
    if (c.freq && lastFix) {
      // The clock walked −θ in (t − t_last) since the last fix: that is the residual rate error.
      const dt = net.now - lastFix.t;
      const rate = -theta / dt;
      rateFix += rate;
      // Change the rate, and keep the reading continuous at this instant.
      const before = net.clock(0);
      net.drift[0] = c.driftPpm * PPM - rateFix;
      net.offset[0] = net.offset[0]! + before - net.clock(0);
    }
    lastFix = { t: net.now, theta };
    nextSync += iv;
  }
  const firstFix = steps[0]?.[0] ?? 0;
  const after = error.filter(([t]) => t > firstFix + 1e-9).map(([, e]) => Math.abs(e));
  return { error, steps, maxAfter: Math.max(0, ...after), walk: c.driftPpm * PPM * iv };
}
