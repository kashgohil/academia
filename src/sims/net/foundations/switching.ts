/**
 * Circuit switching against packet switching, store-and-forward against cut-through, and a queue at a router.
 * Every run here is a PacketNet run, so the timing rules are the track's rules: a hop costs queueing +
 * serialization + propagation, and a router forwards a packet only after its last bit has arrived.
 *
 * - `shareRun`: k users send files to one server. "circuit" gives each user a reserved 1/k of the link (TDM);
 *   "packet" lets all users share the whole link through one router queue (statistical multiplexing).
 * - `overflowProb`: the binomial chance that more users are active than a circuit network could admit.
 * - `pipelineRun` / `storeForwardMs` / `cutThroughMs`: a message cut into packets crosses h equal links.
 * - `queueRun`: Poisson arrivals and bursts into one router output port, with a drop-tail buffer.
 * - `holThroughput`: head-of-line blocking in an input-queued switch (Karol, Hluchyj and Morgan, 1987).
 */
import { mulberry32 } from "../../rng";
import { PacketNet, serializationMs, type Hop } from "../packet";

// ------------------------------------------------------------------------------------------- circuit vs packet

export type ShareMode = "circuit" | "packet";

export interface ShareOpts {
  users: number;
  /** Link rate in bit/s (model input). */
  rate: number;
  /** Bytes per file (model input). */
  fileBytes: number;
  /** Offered load: the bits that all users want to send per second, divided by the link rate. */
  load: number;
  durationMs: number;
  seed: number;
  mode: ShareMode;
  /** Bytes per packet on the wire. */
  pktBytes?: number;
}

export interface Transfer {
  user: number;
  start: number;
  end: number;
}

export interface ShareResult {
  transfers: Transfer[];
  /** Busy intervals per lane: one lane per user for circuits, one shared lane for packets. */
  busy: { lane: number; user: number; t0: number; t1: number }[];
  lanes: number;
  meanMs: number;
  p95Ms: number;
  /** The time to send one file over the whole link alone: the best case. */
  aloneMs: number;
  /** Fraction of the total capacity that carried data in the window. */
  utilization: number;
}

/** File start times per user, from the seed. Both modes use the same schedule, so they compare fairly. */
export function fileSchedule(o: Pick<ShareOpts, "users" | "rate" | "fileBytes" | "load" | "durationMs" | "seed">): { user: number; t: number }[] {
  const rng = mulberry32(o.seed * 7919 + 13);
  const perUserPerMs = (o.load * o.rate) / 1000 / (o.fileBytes * 8) / o.users;
  const out: { user: number; t: number }[] = [];
  for (let u = 0; u < o.users; u++) {
    let t = -Math.log(1 - rng()) / perUserPerMs;
    while (t < o.durationMs) {
      out.push({ user: u, t });
      t += -Math.log(1 - rng()) / perUserPerMs;
    }
  }
  return out.sort((a, b) => a.t - b.t || a.user - b.user);
}

interface FilePkt {
  user: number;
  file: number;
  last: boolean;
}

/** Access links are 10× faster than the shared link, and add 0.1 ms. The shared link (or each circuit) adds 1 ms. */
export function shareRun(o: ShareOpts): ShareResult {
  const pkt = o.pktBytes ?? 1500;
  const k = o.users;
  const sched = fileSchedule(o);
  const starts = sched.map((s) => s.t);
  const ends = new Map<number, number>();
  const handlers = { onDeliver: (_n: number, p: { payload: FilePkt }, net: PacketNet<FilePkt>) => { if (p.payload.last) ends.set(p.payload.file, net.now); } };
  let net: PacketNet<FilePkt>;
  const names = [...Array.from({ length: k }, (_, i) => `U${i + 1}`)];
  if (o.mode === "packet") {
    net = new PacketNet<FilePkt>([...names, "router", "server"], { seed: o.seed }, handlers);
    for (let u = 0; u < k; u++) net.connect(u, k, { rate: o.rate * 10, delay: 0.1 });
    net.connect(k, k + 1, { rate: o.rate, delay: 1 });
  } else {
    net = new PacketNet<FilePkt>([...names, "server"], { seed: o.seed }, handlers);
    for (let u = 0; u < k; u++) net.connect(u, k, { rate: o.rate / k, delay: 1.1 });
  }
  net.computeRoutes();
  const server = o.mode === "packet" ? k + 1 : k;
  sched.forEach((s, file) => {
    net.at(s.t, () => {
      let left = o.fileBytes;
      while (left > 0) {
        const size = Math.min(pkt, left);
        left -= size;
        net.send(s.user, server, size, { user: s.user, file, last: left === 0 });
      }
    });
  });
  net.runAll();
  const transfers: Transfer[] = sched.map((s, i) => ({ user: s.user, start: starts[i]!, end: ends.get(i) ?? NaN })).filter((t) => Number.isFinite(t.end));
  const pktOf = new Map<number, FilePkt>();
  for (const e of net.trace) if (e.kind === "send") pktOf.set(e.pkt.id, e.pkt.payload);
  const sharedPort = o.mode === "packet" ? net.portTo(k, k + 1).id : -1;
  const busy: ShareResult["busy"] = [];
  for (const h of net.hops) {
    const user = pktOf.get(h.pkt)?.user ?? 0;
    if (o.mode === "packet" && h.port === sharedPort) busy.push({ lane: 0, user, t0: h.txStart, t1: h.txEnd });
    if (o.mode === "circuit" && h.to === server) busy.push({ lane: h.from, user: h.from, t0: h.txStart, t1: h.txEnd });
  }
  const durs = transfers.filter((t) => t.start < o.durationMs).map((t) => t.end - t.start).sort((a, b) => a - b);
  // Circuits: k lanes, each 1/k of the capacity, so busy time per lane counts 1/k.
  const busyMs = busy.filter((b) => b.t0 < o.durationMs).reduce((s, b) => s + Math.min(b.t1, o.durationMs) - b.t0, 0) / (o.mode === "packet" ? 1 : k);
  return {
    transfers,
    busy,
    lanes: o.mode === "packet" ? 1 : k,
    meanMs: durs.length ? durs.reduce((s, x) => s + x, 0) / durs.length : NaN,
    p95Ms: durs.length ? durs[Math.min(durs.length - 1, Math.floor(0.95 * durs.length))]! : NaN,
    aloneMs: serializationMs(o.fileBytes, o.rate),
    utilization: busyMs / o.durationMs,
  };
}

/** P(more than `slots` of `n` independent users are active), each active with probability p. */
export function overflowProb(n: number, p: number, slots: number): number {
  let s = 0;
  for (let j = slots + 1; j <= n; j++) s += binom(n, j) * p ** j * (1 - p) ** (n - j);
  return s;
}

/** The binomial pmf of the number of active users, for a chart. */
export const activePmf = (n: number, p: number) => Array.from({ length: n + 1 }, (_, j) => binom(n, j) * p ** j * (1 - p) ** (n - j));

/** The largest number of users that packet switching can admit while P(overflow) stays at or under `eps`. */
export function maxUsers(p: number, slots: number, eps: number, limit = 10_000): number {
  let n = slots;
  while (n < limit && overflowProb(n + 1, p, slots) <= eps) n++;
  return n;
}

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// ------------------------------------------------------------------------------------------- store-and-forward

export interface PipeOpts {
  /** Links between source and destination. */
  hops: number;
  /** Application bytes to move. */
  msgBytes: number;
  /** Data bytes per packet. */
  pktData: number;
  /** Header bytes per packet. */
  header: number;
  /** Rate of every link, bit/s. */
  rate: number;
  /** Propagation delay of every link, ms. */
  delay: number;
  /** Bytes a cut-through switch reads before it starts to send (the destination MAC is in the first 6). */
  lookahead?: number;
}

export const packetCount = (o: PipeOpts) => Math.max(1, Math.ceil(o.msgBytes / o.pktData));

/** One packet = the whole message: h serializations of the full message. */
export const oneBigPacketMs = (o: PipeOpts) => o.hops * (serializationMs(o.msgBytes + o.header, o.rate) + o.delay);

/**
 * The per-packet hops of a run over equal links, in the shape of PacketNet hops. Each node sends packets in order
 * and one at a time. Store-and-forward: a node may start a packet once its last bit has arrived. Cut-through: once
 * the first `lookahead` bytes have arrived.
 */
export function chainHops(o: PipeOpts, cutThrough: boolean): Hop[] {
  const P = packetCount(o);
  const look = serializationMs(o.lookahead ?? 14, o.rate);
  const hops: Hop[] = [];
  const free = new Array<number>(o.hops).fill(0);
  for (let j = 0; j < P; j++) {
    const data = Math.min(o.pktData, o.msgBytes - j * o.pktData);
    const t = serializationMs(data + o.header, o.rate);
    let prevStart = 0;
    for (let i = 0; i < o.hops; i++) {
      // The first bit of packet j reaches node i at prevStart + delay; the last bit one serialization later.
      const ready = i === 0 ? 0 : prevStart + o.delay + (cutThrough ? look : t);
      const start = Math.max(ready, free[i]!);
      free[i] = start + t;
      hops.push({ pkt: j + 1, from: i, to: i + 1, port: i, txStart: start, txEnd: start + t, arriveAt: start + t + o.delay });
      prevStart = start;
    }
  }
  return hops;
}

/** When the last bit of the message reaches the destination, store-and-forward. */
export const storeForwardMs = (o: PipeOpts) => Math.max(...chainHops(o, false).map((h) => h.arriveAt!));

/** The same with cut-through switches (equal link rates). */
export const cutThroughHops = (o: PipeOpts) => chainHops(o, true);

export const cutThroughMs = (o: PipeOpts) => Math.max(...cutThroughHops(o).map((h) => h.arriveAt!));

/** Runs the message over a chain of h + 1 nodes in PacketNet (store-and-forward). */
export function pipelineRun(o: PipeOpts): { net: PacketNet<number>; doneMs: number } {
  const names = Array.from({ length: o.hops + 1 }, (_, i) => (i === 0 ? "src" : i === o.hops ? "dst" : `R${i}`));
  let doneMs = 0;
  const net = new PacketNet<number>(names, { seed: 1 }, { onDeliver: (_n, _p, nt) => (doneMs = Math.max(doneMs, nt.now)) });
  for (let i = 0; i < o.hops; i++) net.connect(i, i + 1, { rate: o.rate, delay: o.delay });
  net.computeRoutes();
  const P = packetCount(o);
  for (let j = 0; j < P; j++) {
    const data = Math.min(o.pktData, o.msgBytes - j * o.pktData);
    net.send(0, o.hops, data + o.header, j + 1);
  }
  net.runAll();
  return { net, doneMs };
}

/** Total time for each data size per packet, for a chart. */
export function pktSizeSweep(o: Omit<PipeOpts, "pktData">, sizes: number[]) {
  return sizes.map((s) => ({ pktData: s, sf: storeForwardMs({ ...o, pktData: s }), ct: cutThroughMs({ ...o, pktData: s }) }));
}

/**
 * The calculus answer: with T(p) ≈ (M/p + h − 1)(p + H)·8/R + h·d, dT/dp = 0 gives p* = √(M·H / (h − 1)).
 * It ignores rounding to whole packets, so it is close to, not equal to, the search result.
 */
export const optimalPktData = (o: Pick<PipeOpts, "msgBytes" | "header" | "hops">) => (o.hops > 1 ? Math.sqrt((o.msgBytes * o.header) / (o.hops - 1)) : o.msgBytes);

/** The data size per packet with the shortest store-and-forward time, by search over whole bytes. */
export function bestPktData(o: Omit<PipeOpts, "pktData">, max = o.msgBytes): { pktData: number; ms: number } {
  let best = { pktData: max, ms: Infinity };
  for (let s = 1; s <= max; s++) {
    const t = storeForwardMs({ ...o, pktData: s });
    if (t < best.ms - 1e-12) best = { pktData: s, ms: t };
  }
  return best;
}

// ------------------------------------------------------------------------------------------- a router queue

export interface QueueOpts {
  /** Offered Poisson load on the output link, 0..1+. */
  load: number;
  /** Output link rate, bit/s (model input). */
  rate: number;
  pktBytes: number;
  /** Buffer in packets that wait (drop-tail). */
  bufferPkts: number;
  /** Input ports that feed the output port. */
  inputs: number;
  durationMs: number;
  seed: number;
  /** Synchronized bursts: at time t every input sends n packets at once (incast). */
  bursts?: { t: number; n: number }[];
  record?: boolean;
}

export interface QueueResult {
  net: PacketNet<number>;
  /** [time, packets waiting] for the output port. */
  qlog: [number, number][];
  /** Queueing wait of each delivered packet: [arrival time at the router, wait ms]. */
  waits: [number, number][];
  drops: number[];
  sent: number;
  meanWaitMs: number;
  p99WaitMs: number;
  dropRate: number;
  /** The time to serialize one packet on the output link: the queue's service time. */
  serviceMs: number;
}

/**
 * Inputs reach the router over links 100× faster than the output link with no delay, so arrivals at the router are
 * close to the Poisson process the inputs generate. The output link has a 1 ms delay.
 */
export function queueRun(o: QueueOpts): QueueResult {
  const k = o.inputs;
  const R = k, S = k + 1;
  const arrivedAt = new Map<number, number>();
  const waits: [number, number][] = [];
  const drops: number[] = [];
  const serviceMs = serializationMs(o.pktBytes, o.rate);
  const names = [...Array.from({ length: k }, (_, i) => `in${i + 1}`), "router", "server"];
  const net = new PacketNet<number>(names, { seed: o.seed, record: o.record ?? true }, {
    onReceive: (node, pkt) => {
      if (node === R) arrivedAt.set(pkt.id, nowOf());
      return false;
    },
    onDeliver: (_n, pkt, nt) => {
      const a = arrivedAt.get(pkt.id)!;
      waits.push([a, Math.max(0, nt.now - a - serviceMs - 1)]);
    },
    onDrop: (_p, reason, _n, nt) => {
      if (reason === "queue") drops.push(nt.now);
    },
  });
  const nowOf = () => net.now;
  for (let i = 0; i < k; i++) net.connect(i, R, { rate: o.rate * 100, delay: 0 });
  net.connect(R, S, { rate: o.rate, delay: 1, queuePackets: o.bufferPkts });
  net.computeRoutes();
  const rng = mulberry32(o.seed * 104729 + 7);
  const perInputPerMs = o.load / serviceMs / k;
  let sent = 0;
  if (perInputPerMs > 0) {
    for (let i = 0; i < k; i++) {
      let t = -Math.log(1 - rng()) / perInputPerMs;
      while (t < o.durationMs) {
        const src = i;
        net.at(t, () => { net.send(src, S, o.pktBytes, 0); });
        sent++;
        t += -Math.log(1 - rng()) / perInputPerMs;
      }
    }
  }
  for (const b of o.bursts ?? []) {
    for (let i = 0; i < k; i++) {
      const src = i;
      net.at(b.t, () => { for (let j = 0; j < b.n; j++) net.send(src, S, o.pktBytes, 1); });
      sent += b.n;
    }
  }
  net.runAll();
  const port = net.portTo(R, S);
  const qlog = port.qlog.map(([t, b]) => [t, b / o.pktBytes] as [number, number]);
  const ws = waits.map((w) => w[1]).sort((a, b) => a - b);
  return {
    net, qlog, waits, drops, sent, serviceMs,
    meanWaitMs: ws.length ? ws.reduce((s, x) => s + x, 0) / ws.length : 0,
    p99WaitMs: ws.length ? ws[Math.min(ws.length - 1, Math.floor(0.99 * ws.length))]! : 0,
    dropRate: sent ? drops.length / sent : 0,
  };
}

/** M/D/1 mean wait in the queue (Poisson arrivals, fixed service time S): ρS / (2(1 − ρ)). */
export const md1WaitMs = (load: number, serviceMs: number) => (load < 1 ? (load * serviceMs) / (2 * (1 - load)) : Infinity);

/** M/M/1 mean wait in the queue, for comparison: ρS / (1 − ρ). Variable sizes wait twice as long. */
export const mm1WaitMs = (load: number, serviceMs: number) => (load < 1 ? (load * serviceMs) / (1 - load) : Infinity);

// ------------------------------------------------------------------------------------------- head-of-line blocking

export interface HolState {
  n: number;
  /** Each input's FIFO, head first: the output that each packet wants. Only the head can be sent. */
  queues: number[][];
  sent: number;
  slots: number;
}

/** `depth` packets per input are kept visible; the destinations are uniform and independent. */
export function holInit(n: number, rng: () => number, depth = 1): HolState {
  return { n, queues: Array.from({ length: n }, () => Array.from({ length: depth }, () => Math.floor(rng() * n))), sent: 0, slots: 0 };
}

/**
 * One time slot of a saturated input-queued switch with FIFO inputs: each output picks one of the inputs whose head
 * packet wants it, at random. Winners send and their next packet moves up; losers are blocked, even if a packet
 * behind their head wants an idle output. Returns the winning input per output (-1: idle output).
 */
export function holStep(s: HolState, rng: () => number): number[] {
  const winners = new Array<number>(s.n).fill(-1);
  for (let out = 0; out < s.n; out++) {
    const want: number[] = [];
    for (let i = 0; i < s.n; i++) if (s.queues[i]![0] === out) want.push(i);
    if (want.length) winners[out] = want[Math.floor(rng() * want.length)]!;
  }
  for (const w of winners) {
    if (w < 0) continue;
    const q = s.queues[w]!;
    q.shift();
    q.push(Math.floor(rng() * s.n));
    s.sent++;
  }
  s.slots++;
  return winners;
}

/** Inputs that lost a slot although a packet behind their head wanted an output that stayed idle. `queues`: before the slot. */
export function holBlocked(queues: number[][], winners: number[]): number[] {
  const idle = new Set(winners.map((w, out) => (w < 0 ? out : -1)).filter((o) => o >= 0));
  return queues.map((q, i) => (!winners.includes(i) && q.slice(1).some((d) => idle.has(d)) ? i : -1)).filter((i) => i >= 0);
}

/** Saturation throughput per input, measured over `slots` slots. */
export function holThroughput(n: number, slots: number, seed = 1): number {
  const rng = mulberry32(seed);
  const s = holInit(n, rng);
  for (let i = 0; i < slots; i++) holStep(s, rng);
  return s.sent / (n * slots);
}

/** The limit for large N from Karol, Hluchyj and Morgan (1987). */
export const HOL_LIMIT = 2 - Math.SQRT2;
