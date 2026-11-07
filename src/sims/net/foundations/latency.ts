/**
 * Latency, bandwidth and the bandwidth-delay product.
 *
 * - Light in fiber: the speed of light in vacuum is exact (SI); the fiber's group index is a model input (about
 *   1.47 for standard single-mode fiber). `greatCircleKm` gives the shortest distance on a sphere (haversine);
 *   real cables are longer, so a fiber RTT over the great circle is a lower bound.
 * - `geoAltitudeKm`: the geostationary altitude from Kepler's third law, and the RTT it forces.
 * - `pathBreakdown` / `pathRun`: one packet over a multi-hop path, split into propagation, serialization,
 *   processing (a model input per router) and queueing (measured in PacketNet with cross traffic).
 * - `windowRun`: an ack-clocked sender in PacketNet with a fixed window or slow start, over a bottleneck.
 * - `transferMs`: the same slow-start transfer in closed form, for sweeps over sizes too large to simulate.
 */
import { mulberry32 } from "../../rng";
import { PacketNet, bdpBytes, serializationMs } from "../packet";

/** The speed of light in vacuum: 299,792,458 m/s, exact by the SI definition of the metre. */
export const C_KM_PER_MS = 299.792458;
/** Model input: the group index of standard single-mode fiber near 1550 nm. */
export const FIBER_INDEX = 1.468;
export const fiberKmPerMs = (index = FIBER_INDEX) => C_KM_PER_MS / index;
/** One-way propagation in fiber, ms. */
export const fiberMs = (km: number, index = FIBER_INDEX) => km / fiberKmPerMs(index);
/** Microseconds per km of fiber: about 4.9, the usual "5 µs per km". */
export const fiberUsPerKm = (index = FIBER_INDEX) => 1000 / fiberKmPerMs(index);

/** Model input: the mean radius of the Earth, km. */
export const EARTH_RADIUS_KM = 6371;

export interface City {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

/** City centers, degrees (north and east positive). */
export const CITIES: City[] = [
  { id: "nyc", name: "New York", lat: 40.7128, lon: -74.006 },
  { id: "sfo", name: "San Francisco", lat: 37.7749, lon: -122.4194 },
  { id: "lon", name: "London", lat: 51.5074, lon: -0.1278 },
  { id: "fra", name: "Frankfurt", lat: 50.1109, lon: 8.6821 },
  { id: "tyo", name: "Tokyo", lat: 35.6762, lon: 139.6503 },
  { id: "syd", name: "Sydney", lat: -33.8688, lon: 151.2093 },
  { id: "sgp", name: "Singapore", lat: 1.3521, lon: 103.8198 },
];

export const city = (id: string) => CITIES.find((c) => c.id === id)!;

export function greatCircleKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }, r = EARTH_RADIUS_KM): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The smallest possible RTT in fiber between two cities: there and back along the great circle. */
export const fiberRttMs = (a: string, b: string, index = FIBER_INDEX) => 2 * fiberMs(greatCircleKm(city(a), city(b)), index);
/** The same in vacuum: the bound that no signal can beat. */
export const vacuumRttMs = (a: string, b: string) => (2 * greatCircleKm(city(a), city(b))) / C_KM_PER_MS;

/** Earth's GM (km³/s²) and the sidereal day (s): physical constants. Equatorial radius 6378.137 km (WGS 84). */
const GM = 398600.4418, SIDEREAL_DAY_S = 86164.0905, EQ_RADIUS_KM = 6378.137;

/** Kepler's third law: the orbit whose period is one sidereal day, minus the Earth's radius. */
export const geoAltitudeKm = () => Math.cbrt((GM * SIDEREAL_DAY_S ** 2) / (4 * Math.PI ** 2)) - EQ_RADIUS_KM;

/** A request and its answer via a geostationary satellite: up and down twice, with the ground station right below. */
export const geoRttMs = () => (4 * geoAltitudeKm()) / C_KM_PER_MS;

// ------------------------------------------------------------------------------------------- one packet, many hops

export interface PathHop {
  name: string;
  /** A short name for the link that leaves this node. */
  link: string;
  /** Rate of the link that leaves this node, bit/s (model input). */
  rate: number;
  /** Length of that link, km (model input). */
  km: number;
  /** Processing time in this node before the packet can be queued: lookup, checks, copies. Model input. */
  procUs: number;
}

/**
 * The example path, all model inputs: a laptop on a 1 Gbit/s LAN, a home router, an access line, the ISP's
 * edge and core, a long-haul link, and the far data center. The long-haul length comes from the chosen cities.
 */
export function examplePath(accessRate: number, longKm: number): PathHop[] {
  return [
    { name: "laptop", link: "LAN", rate: 1e9, km: 0.01, procUs: 0 },
    { name: "home router", link: "access", rate: accessRate, km: 5, procUs: 30 },
    { name: "ISP edge", link: "metro", rate: 10e9, km: 50, procUs: 10 },
    { name: "ISP core", link: "long haul", rate: 100e9, km: longKm, procUs: 5 },
    { name: "far core", link: "far metro", rate: 10e9, km: 20, procUs: 5 },
    { name: "rack switch", link: "rack", rate: 10e9, km: 0.05, procUs: 2 },
  ];
}

export interface HopCost {
  name: string;
  propMs: number;
  serMs: number;
  procMs: number;
  queueMs: number;
}

/** The fixed costs of each hop for one packet; queueing comes from `queueMs` (per hop), default 0. */
export function pathBreakdown(path: PathHop[], pktBytes: number, queueMs: number[] = []): HopCost[] {
  return path.map((h, i) => ({ name: h.name, propMs: fiberMs(h.km), serMs: serializationMs(pktBytes, h.rate), procMs: h.procUs / 1000, queueMs: queueMs[i] ?? 0 }));
}

export const totalMs = (c: HopCost[]) => c.reduce((s, h) => s + h.propMs + h.serMs + h.procMs + h.queueMs, 0);

export interface PathRun {
  /** Mean and 99th percentile of the queueing wait at each hop, ms. */
  meanQueueMs: number[];
  p99QueueMs: number[];
  /** One-way delay of each probe (PacketNet part only: propagation, serialization and queueing). */
  probeMs: number[];
}

/**
 * Probes cross the path in PacketNet while cross traffic (Poisson, 1500-byte packets) loads the access link
 * (hop 1) to `crossLoad`. The wait of each probe at each hop is measured directly: time it left − time it arrived.
 */
export function pathRun(path: PathHop[], pktBytes: number, crossLoad: number, o: { probes?: number; spacingMs?: number; seed?: number } = {}): PathRun {
  const probes = o.probes ?? 200, spacing = o.spacingMs ?? 5, seed = o.seed ?? 1;
  const n = path.length;
  const names = [...path.map((h) => h.name), "server", "cross"];
  const server = n, cross = n + 1;
  const arrived = new Map<number, number>();
  const waits: number[][] = path.map(() => []);
  const probeMs: number[] = [];
  const net = new PacketNet<"probe" | "x">(names, { seed, record: false }, {
    onReceive: (node, pkt) => {
      if (pkt.payload === "probe") arrived.set(pkt.id * 64 + node, net.now);
      return false;
    },
    onDeliver: (_n, pkt) => {
      if (pkt.payload === "probe") probeMs.push(net.now - pkt.createdAt);
    },
  });
  for (let i = 0; i < n; i++) net.connect(i, i + 1, { rate: path[i]!.rate, delay: fiberMs(path[i]!.km) });
  net.connect(cross, 1, { rate: path[1]!.rate * 100, delay: 0 });
  net.computeRoutes();
  const xSer = serializationMs(1500, path[1]!.rate);
  const rate = crossLoad / xSer; // packets per ms
  const rng = mulberry32(seed * 31 + 5);
  const end = probes * spacing + 10;
  if (rate > 0) for (let t = -Math.log(1 - rng()) / rate; t < end; t += -Math.log(1 - rng()) / rate) net.at(t, () => { net.send(cross, 2, 1500, "x"); });
  // A probe's wait at hop i = (arrival at node i+1) − (arrival at node i) − serialization − propagation of link i.
  const probeIds: [number, number][] = [];
  for (let k = 0; k < probes; k++) net.at(10 + k * spacing, () => { probeIds.push([net.send(0, server, pktBytes, "probe").id, net.now]); });
  net.runAll();
  for (const [id, sent] of probeIds) {
    let prev = sent;
    for (let i = 1; i <= n; i++) {
      const at = arrived.get(id * 64 + i);
      if (at === undefined) break;
      const h = path[i - 1]!;
      waits[i - 1]!.push(Math.max(0, at - prev - serializationMs(pktBytes, h.rate) - fiberMs(h.km)));
      prev = at;
    }
  }
  const q = (xs: number[], f: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))]! : 0;
  };
  return {
    meanQueueMs: waits.map((w) => (w.length ? w.reduce((s, x) => s + x, 0) / w.length : 0)),
    p99QueueMs: waits.map((w) => q(w, 0.99)),
    probeMs,
  };
}

// ------------------------------------------------------------------------------------------- windows and the BDP

/** The throughput that a window of `windowBytes` allows over `rttMs`: one window per round trip. */
export const windowLimitBps = (windowBytes: number, rttMs: number) => (windowBytes * 8 * 1000) / rttMs;

/** The largest TCP window without window scaling (a 16-bit field), and with the largest scale, 14 (RFC 7323). */
export const TCP_WINDOW_UNSCALED = 65535;
export const TCP_WINDOW_MAX_SCALED = 65535 * 2 ** 14;

export interface WindowOpts {
  /** Bottleneck rate, bit/s. */
  rate: number;
  /** One-way propagation delay of the bottleneck, ms. The base RTT is about twice this. */
  owdMs: number;
  /** Data bytes per packet. */
  mss?: number;
  /** Header bytes per data packet and the size of an ACK. */
  header?: number;
  /** Fixed window in packets, or slow start from `iw` packets (one more per ACK). */
  window: number | { iw: number };
  /** Packets to send. */
  packets: number;
  /** Bottleneck buffer in packets. Default: no limit. */
  queuePkts?: number;
  record?: boolean;
}

export interface WindowResult {
  net: PacketNet<{ seq: number; ack: boolean }>;
  /** When the last data packet arrived. */
  doneMs: number;
  /** RTT sample per packet: ACK arrival − send. */
  rttMs: number[];
  /** Data bytes delivered per ms in the second half of the run (steady state). */
  throughputBps: number;
  maxQueuePkts: number;
  /** Data packets in flight (sent, not yet acknowledged) at each send: [time, count]. */
  inflight: [number, number][];
  /** The base RTT with an empty queue. */
  baseRttMs: number;
  bdpPackets: number;
  /** Arrival time of each data packet at the receiver. */
  arrivals: number[];
}

/**
 * sender —(10× rate, 0 ms)— router —(rate, owd)— receiver. The receiver ACKs every data packet; ACKs return the
 * same way. The sender keeps at most `window` packets unacknowledged, or grows its window by one per ACK (slow
 * start, no loss).
 */
export function windowRun(o: WindowOpts): WindowResult {
  const mss = o.mss ?? 1460, hdr = o.header ?? 40;
  type P = { seq: number; ack: boolean };
  const S = 0, R = 1, D = 2;
  let next = 0, inflightN = 0, acked = 0;
  let cwnd = typeof o.window === "number" ? o.window : o.window.iw;
  const sentAt: number[] = [];
  const rttMs: number[] = [];
  const arrivals: number[] = [];
  const inflight: [number, number][] = [];
  let doneMs = 0;
  const net: PacketNet<P> = new PacketNet<P>(["sender", "router", "receiver"], { seed: 1, record: o.record ?? false }, {
    onDeliver: (node, pkt, nt) => {
      if (node === D && !pkt.payload.ack) {
        arrivals[pkt.payload.seq] = nt.now;
        doneMs = Math.max(doneMs, nt.now);
        nt.send(D, S, hdr, { seq: pkt.payload.seq, ack: true });
      } else if (node === S && pkt.payload.ack) {
        rttMs[pkt.payload.seq] = nt.now - sentAt[pkt.payload.seq]!;
        inflightN--;
        acked++;
        if (typeof o.window !== "number") cwnd++;
        pump();
      }
    },
  });
  net.connect(S, R, { rate: o.rate * 10, delay: 0 });
  net.connect(R, D, { rate: o.rate, delay: o.owdMs, queuePackets: o.queuePkts });
  net.computeRoutes();
  function pump() {
    while (inflightN < cwnd && next < o.packets) {
      sentAt[next] = net.now;
      net.send(S, D, mss + hdr, { seq: next, ack: false });
      next++;
      inflightN++;
      inflight.push([net.now, inflightN]);
    }
  }
  pump();
  net.runAll();
  void acked;
  const half = Math.floor(o.packets / 2);
  const t0 = arrivals[half] ?? 0, t1 = arrivals[o.packets - 1] ?? 0;
  const throughputBps = t1 > t0 ? ((o.packets - 1 - half) * mss * 8 * 1000) / (t1 - t0) : 0;
  const baseRttMs = 2 * o.owdMs + serializationMs(mss + hdr, o.rate) + serializationMs(mss + hdr, o.rate * 10) + serializationMs(hdr, o.rate) + serializationMs(hdr, o.rate * 10);
  return {
    net, doneMs, rttMs, throughputBps, inflight, arrivals, baseRttMs,
    maxQueuePkts: net.portTo(R, D).stats.maxQBytes / (mss + hdr),
    bdpPackets: bdpBytes(o.rate, baseRttMs) / (mss + hdr),
  };
}

export interface TransferOpts {
  /** Initial window in segments (RFC 6928 allows about 10; Linux uses 10). */
  iw?: number;
  mss?: number;
  header?: number;
  /** Round trips before the first data byte leaves the sender: 1 for the TCP handshake, 2 with TLS 1.3. */
  setupRtts?: number;
}

/**
 * Time to move `bytes` from a sender that starts with `iw` segments and doubles its window each round trip
 * (slow start without loss), over a link of `rate` bit/s and base RTT `rttMs`. Once a window covers the BDP,
 * the rest streams at the link rate. Returns ms from the first SYN to the last byte at the receiver.
 * It matches windowRun with slow start within a few percent (see the tests).
 */
export function transferMs(bytes: number, rate: number, rttMs: number, o: TransferOpts = {}): number {
  const mss = o.mss ?? 1460, hdr = o.header ?? 40, iw = o.iw ?? 10, setup = o.setupRtts ?? 1;
  const segs = Math.max(1, Math.ceil(bytes / mss));
  const ser = serializationMs(mss + hdr, rate);
  let t = setup * rttMs, sent = 0, cwnd = iw;
  for (;;) {
    const n = Math.min(cwnd, segs - sent);
    if (cwnd * ser >= rttMs + ser || sent + n === segs) return t + (segs - sent) * ser + rttMs / 2;
    sent += n;
    t += rttMs + ser;
    cwnd *= 2;
  }
}

/** Round trips a transfer spends before its window covers the path: a measure of how latency-bound it is. */
export function slowStartRounds(bytes: number, rate: number, rttMs: number, o: TransferOpts = {}): number {
  const mss = o.mss ?? 1460, hdr = o.header ?? 40, iw = o.iw ?? 10;
  const segs = Math.max(1, Math.ceil(bytes / mss));
  const ser = serializationMs(mss + hdr, rate);
  let sent = 0, cwnd = iw, rounds = 0;
  while (sent < segs) {
    rounds++;
    if (cwnd * ser >= rttMs + ser) break;
    sent += Math.min(cwnd, segs - sent);
    cwnd *= 2;
  }
  return rounds;
}

/**
 * The transfer size where two links take the same time (bisection on a log scale between 1 kB and 10 GB).
 * Below it the link with the shorter RTT wins; above it the faster link wins. NaN if one link always wins.
 */
export function crossoverBytes(a: { rate: number; rttMs: number }, b: { rate: number; rttMs: number }, o: TransferOpts = {}): number {
  const d = (s: number) => transferMs(s, a.rate, a.rttMs, o) - transferMs(s, b.rate, b.rttMs, o);
  let lo = 1e3, hi = 1e10;
  if (Math.sign(d(lo)) === Math.sign(d(hi))) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if (Math.sign(d(mid)) === Math.sign(d(lo))) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/** Example paths for the BDP table. Rates and RTTs are model inputs. */
export const BDP_EXAMPLES = [
  { name: "data center, same rack row", rate: 100e9, rttMs: 0.05 },
  { name: "home broadband to a nearby CDN", rate: 100e6, rttMs: 20 },
  { name: "New York to London, 10 Gbit/s", rate: 10e9, rttMs: 70 },
  { name: "geostationary satellite", rate: 100e6, rttMs: 600 },
];
