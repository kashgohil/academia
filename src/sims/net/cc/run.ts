/**
 * Bulk flows on PacketNet's dumbbell, sampled for plots. A run can advance in slices (`runTo`), so that a demo can
 * spread a long run over several frames with useChunked.
 *
 * The base RTT of flow 0 is `rttMs`; other flows may have a longer one (their access links are longer). The queue
 * limit is in packets, on the bottleneck. Every number here is a model input of the lessons.
 */
import { dumbbell, type PacketNet } from "..";
import { Bbr } from "./bbr";
import { Cubic, Dctcp, Fixed, Reno, type Controller } from "./controllers";
import { DATA_BYTES, Flow, ccHandlers, type CcMsg } from "./flow";

export type CcKind = "reno" | "cubic" | "bbr" | "dctcp";
export const CC_LABEL: Record<CcKind, string> = { reno: "Reno", cubic: "CUBIC", bbr: "BBR", dctcp: "DCTCP" };

export interface FlowSpec {
  cc: CcKind | { fixed: number };
  /** Base RTT in ms. Default: the scenario's rttMs. Must not be below it. */
  rttMs?: number;
  /** Start time in ms. */
  start?: number;
  /** End time in ms: the flow stops sending. */
  stop?: number;
  legacy?: boolean;
  fixedRtoMs?: number;
}

export interface Scenario {
  /** Bottleneck rate in Mbit/s. */
  mbps: number;
  /** Base RTT of the shortest flow in ms. */
  rttMs: number;
  /** Bottleneck queue limit in packets. */
  queue: number;
  flows: FlowSpec[];
  durationMs: number;
  /** Sample period for plots. */
  sampleMs?: number;
  seed?: number;
  /** Random loss on the bottleneck (both directions). */
  loss?: number;
  /** ECN marking threshold in packets (DCTCP's K). */
  ecnK?: number;
  /** A scripted change of the bottleneck rate: [time ms, Mbit/s]. */
  rateChanges?: [number, number][];
  /** A scripted change of the base RTT of flow 0 (the bottleneck delay changes): [time ms, RTT ms]. */
  rttChanges?: [number, number][];
  /** Random ACK delay at the receivers, 0..jitter ms (see flow.ts). Default 0. */
  jitterMs?: number;
  /** Stats ignore the first part of a run: slow start is not the steady state. */
  warmupMs?: number;
}

export interface FlowSample {
  cwnd: number;
  inflight: number;
  /** Latest RTT sample, ms. */
  rtt: number;
  /** Goodput over the last sample period, Mbit/s (new packets that reached the receiver). */
  mbps: number;
  state: string;
  /** BBR only: its model. */
  btlBwMbps?: number;
  rtPropMs?: number;
  pacingMbps?: number;
}

export interface Sample {
  t: number;
  /** Bottleneck queue in packets. */
  q: number;
  flows: FlowSample[];
}

export interface FlowResult {
  goodputMbps: number;
  /** Fraction of sent packets that were retransmissions. */
  retransFrac: number;
  congestionEvents: number;
  timeouts: number;
  meanRttMs: number;
  sent: number;
  delivered: number;
  duplicates: number;
}

export interface RunResult {
  samples: Sample[];
  flows: FlowResult[];
  /** Fraction of time the bottleneck sent, after the warm-up. */
  utilisation: number;
  /** Total goodput as a fraction of the bottleneck rate, after the warm-up. */
  goodputFrac: number;
  /** Mean queueing delay at the bottleneck, ms (time-averaged from the samples). */
  meanQueueMs: number;
  /** Packets dropped at the bottleneck queue or lost on the wire. */
  drops: number;
  /** Jain's fairness index of the per-flow goodputs, 1 = equal shares. */
  jain: number;
  bdpPackets: number;
}

/** Jain's index: (Σx)² / (n Σx²). */
export const jain = (xs: number[]) => {
  const s = xs.reduce((a, b) => a + b, 0), s2 = xs.reduce((a, b) => a + b * b, 0);
  return s2 > 0 ? (s * s) / (xs.length * s2) : 1;
};

/** Packets in one bandwidth-delay product. */
export const bdpPackets = (mbps: number, rttMs: number) => (mbps * 1e6 * rttMs) / 8000 / DATA_BYTES;

export function makeController(cc: FlowSpec["cc"], net: PacketNet<CcMsg>): Controller {
  if (typeof cc === "object") return new Fixed(cc.fixed);
  switch (cc) {
    case "reno": return new Reno();
    case "cubic": return new Cubic();
    case "dctcp": return new Dctcp();
    case "bbr": return new Bbr(() => net.random());
  }
}

export class CcRun {
  readonly net: PacketNet<CcMsg>;
  readonly flows: Flow[];
  readonly samples: Sample[] = [];
  private lastUnique: number[];
  private uniqueAtWarm: number[] = [];
  private busyAtWarm = 0;
  private qIntegral = 0;
  private qTime = 0;
  readonly bdp: number;
  private port;

  constructor(readonly sc: Scenario) {
    const k = sc.flows.length;
    // RTT = 2 × (access + bottleneck delay + 0.5 ms receiver access). Flow 0 has 0.5 ms access.
    const bDelay = sc.rttMs / 2 - 1;
    if (bDelay <= 0) throw new Error("rttMs must be above 2 ms");
    const access = sc.flows.map((f) => (f.rttMs ?? sc.rttMs) / 2 - bDelay - 0.5);
    let flows: Flow[] = [];
    const d = dumbbell<CcMsg>({
      pairs: k, rate: sc.mbps * 1e6, delay: bDelay, queuePackets: sc.queue, loss: sc.loss,
      ecnBytes: sc.ecnK !== undefined ? sc.ecnK * DATA_BYTES : undefined,
      accessDelay: access, seed: sc.seed ?? 1, record: false, handlers: ccHandlers(() => flows),
    });
    this.net = d.net;
    this.port = d.bottleneckPort;
    flows = sc.flows.map((f, i) => new Flow(d.net, {
      id: i, src: d.senders[i]!, dst: d.receivers[i]!, cc: makeController(f.cc, d.net), ecn: f.cc === "dctcp", legacy: f.legacy, fixedRtoMs: f.fixedRtoMs, ackJitterMs: sc.jitterMs,
    }));
    this.flows = flows;
    this.lastUnique = flows.map(() => 0);
    this.bdp = bdpPackets(sc.mbps, sc.rttMs);
    sc.flows.forEach((f, i) => {
      d.net.at(f.start ?? 0, () => flows[i]!.start());
      if (f.stop !== undefined) d.net.at(f.stop, () => flows[i]!.stop());
    });
    for (const [t, mbps] of sc.rateChanges ?? []) d.net.at(t, () => { this.port.spec.rate = mbps * 1e6; });
    for (const [t, rtt] of sc.rttChanges ?? []) {
      d.net.at(t, () => {
        this.port.spec.delay = rtt / 2 - 1;
        d.net.ports[this.port.peerPort]!.spec.delay = rtt / 2 - 1;
      });
    }
    const sp = sc.sampleMs ?? 20;
    const warm = sc.warmupMs ?? 0;
    d.net.at(warm, () => {
      this.uniqueAtWarm = flows.map((f) => f.rcvUnique);
      this.busyAtWarm = this.busyMs();
    });
    for (let t = 0; t <= sc.durationMs + 1e-9; t += sp) d.net.at(t, () => this.sample(sp, warm));
  }

  /** Busy time of the bottleneck so far; stats.busyMs counts a packet when it starts, so subtract what is left. */
  private busyMs() {
    return this.port.stats.busyMs;
  }

  private sample(sp: number, warm: number) {
    const now = this.net.now;
    const q = this.port.queue.length;
    if (now > warm) {
      this.qIntegral += this.port.qBytes * sp;
      this.qTime += sp;
    }
    this.samples.push({
      t: now, q,
      flows: this.flows.map((f, i) => {
        const u = f.rcvUnique;
        const mbps = now > 0 ? ((u - this.lastUnique[i]!) * DATA_BYTES * 8) / (sp * 1000) : 0;
        this.lastUnique[i] = u;
        const s: FlowSample = { cwnd: f.started && !f.stopped ? f.cc.cwnd : 0, inflight: f.inflight, rtt: f.latestRtt, mbps, state: f.cc.state };
        if (f.cc instanceof Bbr) {
          s.btlBwMbps = (f.cc.btlBw * DATA_BYTES * 8) / 1000;
          s.rtPropMs = Number.isFinite(f.cc.rtProp) ? f.cc.rtProp : 0;
          s.pacingMbps = f.cc.pacingPpms ? (f.cc.pacingPpms * DATA_BYTES * 8) / 1000 : 0;
        }
        return s;
      }),
    });
  }

  runTo(t: number) {
    this.net.runUntil(Math.min(t, this.sc.durationMs));
    return this;
  }

  get finished() {
    return this.net.now >= this.sc.durationMs;
  }

  result(): RunResult {
    const sc = this.sc;
    const warm = sc.warmupMs ?? 0;
    const span = Math.max(1e-9, this.net.now - warm);
    const flows: FlowResult[] = this.flows.map((f, i) => ({
      goodputMbps: ((f.rcvUnique - (this.uniqueAtWarm[i] ?? 0)) * DATA_BYTES * 8) / (span * 1000),
      retransFrac: f.sent ? f.retrans / f.sent : 0,
      congestionEvents: f.congestionEvents,
      timeouts: f.timeouts,
      meanRttMs: f.rttCount ? f.rttSum / f.rttCount : 0,
      sent: f.sent,
      delivered: f.rcvUnique,
      duplicates: f.rcvDup,
    }));
    const total = flows.reduce((a, f) => a + f.goodputMbps, 0);
    const meanRate = sc.mbps * 1e6; // for utilisation, the rate at the end (rate changes are for timelines)
    const busy = Math.min(1, (this.busyMs() - this.busyAtWarm) / span);
    return {
      samples: this.samples,
      flows,
      utilisation: busy,
      goodputFrac: total / sc.mbps,
      meanQueueMs: this.qTime > 0 ? ((this.qIntegral / this.qTime) * 8 * 1000) / meanRate : 0,
      drops: this.port.stats.drops + this.net.ports[this.port.peerPort]!.stats.drops,
      jain: jain(flows.map((f) => f.goodputMbps)),
      bdpPackets: this.bdp,
    };
  }
}

/** Runs a scenario to its end. */
export const runScenario = (sc: Scenario) => new CcRun(sc).runTo(sc.durationMs).result();
