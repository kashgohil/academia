/**
 * Interior routing: distance vector (Bellman-Ford, as in RIP) and link state (flooding plus Dijkstra, as in OSPF
 * and IS-IS).
 *
 * - `dvRun`: a distance-vector run, one advertisement at a time, in a fixed order. It shows count to infinity,
 *   and what split horizon and poison reverse fix (two-node loops) and do not fix (longer loops).
 * - `dijkstraSteps`: Dijkstra's algorithm, one settled node per frame.
 * - `convergenceRun`: both protocols as real packet protocols on IpNet. A link is cut, the routers detect it after
 *   a delay, and data packets show what users see until the tables agree again.
 */
import type { NodeId } from "../packet";
import { IpNet, type IpPacket } from "./ipnet";

export interface Topo {
  names: string[];
  links: { a: number; b: number; cost: number }[];
  /** Positions in [0, 1] for drawing. */
  pos: [number, number][];
}

/** RIP's infinity (RFC 2453): a metric of 16 means unreachable. */
export const RIP_INFINITY = 16;

// ---------------------------------------------------------------- distance vector, step by step

export interface DvOptions {
  splitHorizon: boolean;
  poisonReverse: boolean;
  infinity?: number;
}

export interface DvFrame {
  /** The advertisement just delivered: from → to, and what it said about the destination. */
  msg?: { from: number; to: number; said: number | null };
  dist: number[];
  via: (number | null)[];
  changed: number[];
}

export interface DvRun {
  frames: DvFrame[];
  /** True if the run ended with every table stable. */
  converged: boolean;
  /** Advertisements delivered after the cut until the end. */
  messages: number;
  /** Router pairs that point at each other (a two-node loop) at some step. */
  loopSeen: boolean;
}

/**
 * Each router keeps the last vector it heard from each neighbour (RIP keeps only the best route, but the effect is
 * the same) and recomputes `cost(link) + neighbour's distance`. Starting from the converged tables, link `cut`
 * fails; its two ends drop what they heard over it. Then advertisements are delivered in the order `schedule`
 * gives, over and over, until a whole pass changes nothing.
 */
export function dvRun(t: Topo, dest: number, opts: DvOptions, cut: number, schedule: [number, number][], maxSteps = 400): DvRun {
  const INF = opts.infinity ?? RIP_INFINITY;
  const n = t.names.length;
  const up = t.links.map(() => true);
  const linkOf = (a: number, b: number) => t.links.findIndex((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  const nbrs = (v: number) => t.links.flatMap((l, i) => (!up[i] ? [] : l.a === v ? [l.b] : l.b === v ? [l.a] : []));
  // heard[v].get(u) = distance u last advertised to v
  const heard = Array.from({ length: n }, () => new Map<number, number>());
  const dist = new Array<number>(n).fill(INF);
  const via = new Array<number | null>(n).fill(null);
  const recompute = (v: number) => {
    if (v === dest) {
      dist[v] = 0;
      via[v] = null;
      return false;
    }
    let best = INF, hop: number | null = null;
    for (const u of nbrs(v)) {
      const d = heard[v]!.get(u);
      if (d === undefined) continue;
      const c = Math.min(INF, t.links[linkOf(v, u)]!.cost + d);
      if (c < best) {
        best = c;
        hop = u;
      }
    }
    const changed = best !== dist[v] || hop !== via[v];
    dist[v] = best;
    via[v] = best >= INF ? null : hop;
    return changed;
  };
  const advertise = (from: number, to: number): number | null => {
    if (opts.splitHorizon && via[from] === to) return opts.poisonReverse ? INF : null;
    return dist[from]!;
  };
  // Converge before the cut: plain synchronous Bellman-Ford over the full graph.
  dist[dest] = 0;
  for (let k = 0; k < n + 2; k++) {
    for (let v = 0; v < n; v++) for (const u of nbrs(v)) heard[v]!.set(u, advertise(u, v) ?? INF);
    for (let v = 0; v < n; v++) recompute(v);
  }
  for (let v = 0; v < n; v++) for (const u of nbrs(v)) {
    const s = advertise(u, v);
    if (s === null) heard[v]!.delete(u);
    else heard[v]!.set(u, s);
  }
  const frames: DvFrame[] = [{ dist: [...dist], via: [...via], changed: [] }];
  // The cut.
  const c = t.links[cut]!;
  up[cut] = false;
  heard[c.a]!.delete(c.b);
  heard[c.b]!.delete(c.a);
  const ch0 = [c.a, c.b].filter((v) => recompute(v));
  frames.push({ dist: [...dist], via: [...via], changed: ch0 });
  let messages = 0, quiet = 0, loopSeen = false, k = 0;
  const live = () => schedule.filter(([a, b]) => linkOf(a, b) >= 0 && up[linkOf(a, b)]!);
  const sched = live();
  while (messages < maxSteps && sched.length) {
    const [from, to] = sched[k % sched.length]!;
    k++;
    const said = advertise(from, to);
    if (said === null) heard[to]!.delete(from);
    else heard[to]!.set(from, said);
    messages++;
    const changed = recompute(to) ? [to] : [];
    frames.push({ msg: { from, to, said }, dist: [...dist], via: [...via], changed });
    for (let v = 0; v < n; v++) if (via[v] !== null && via[via[v]!] === v) loopSeen = true;
    quiet = changed.length ? 0 : quiet + 1;
    if (quiet >= sched.length) break;
  }
  return { frames, converged: quiet >= sched.length, messages, loopSeen };
}

/** Three routers in a line, A–B–C. The destination is C; the cut is B–C. */
export const DV_LINE: Topo = {
  names: ["A", "B", "C"],
  links: [{ a: 0, b: 1, cost: 1 }, { a: 1, b: 2, cost: 1 }],
  pos: [[0.1, 0.5], [0.5, 0.5], [0.9, 0.5]],
};
/** The race that lets A's old news reach B before B's bad news reaches A. */
export const DV_LINE_SCHEDULE: [number, number][] = [[0, 1], [1, 0], [1, 2], [2, 1]];

/** A triangle A, B, C with D behind C. The destination is D; the cut is C–D. */
export const DV_TRIANGLE: Topo = {
  names: ["A", "B", "C", "D"],
  links: [{ a: 0, b: 1, cost: 1 }, { a: 0, b: 2, cost: 1 }, { a: 1, b: 2, cost: 1 }, { a: 2, b: 3, cost: 1 }],
  pos: [[0.12, 0.2], [0.12, 0.8], [0.55, 0.5], [0.9, 0.5]],
};
/**
 * C's news reaches B, but A advertises its old route to B before C's news reaches A. This is the timing in which
 * split horizon and poison reverse fail: the loop A → C → B → A has three routers.
 */
export const DV_TRIANGLE_SCHEDULE: [number, number][] = [[2, 1], [0, 1], [2, 0], [1, 2], [2, 0], [0, 1], [1, 0], [0, 2], [1, 2], [2, 1]];

// ---------------------------------------------------------------- Dijkstra

export interface DijkstraFrame {
  /** The node settled in this frame, or -1 for the start. */
  settled: number;
  done: boolean[];
  dist: number[];
  prev: (number | null)[];
  /** Links relaxed in this frame, as link indexes, and whether each one improved a distance. */
  relaxed: { link: number; improved: boolean }[];
}

/** Dijkstra from `src`, ties to the lower node index. One frame per settled node. */
export function dijkstraSteps(t: Topo, src: number, costOf: (link: number) => number = (i) => t.links[i]!.cost, upOf: (link: number) => boolean = () => true): DijkstraFrame[] {
  const n = t.names.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number | null>(n).fill(null);
  const done = new Array<boolean>(n).fill(false);
  dist[src] = 0;
  const frames: DijkstraFrame[] = [{ settled: -1, done: [...done], dist: [...dist], prev: [...prev], relaxed: [] }];
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0) break;
    done[u] = true;
    const relaxed: DijkstraFrame["relaxed"] = [];
    t.links.forEach((l, i) => {
      if (!upOf(i) || (l.a !== u && l.b !== u)) return;
      const v = l.a === u ? l.b : l.a;
      if (done[v]) return;
      const d = dist[u]! + costOf(i);
      const improved = d < dist[v]!;
      if (improved) {
        dist[v] = d;
        prev[v] = u;
      }
      relaxed.push({ link: i, improved });
    });
    frames.push({ settled: u, done: [...done], dist: [...dist], prev: [...prev], relaxed });
  }
  return frames;
}

/**
 * OSPF interface cost as many routers compute it: reference bandwidth / interface bandwidth, at least 1.
 * The reference is a configuration value; 100 Mbit/s is a common default, so every link of 100 Mbit/s or faster costs 1.
 */
export const ospfCost = (bps: number, refBps = 100e6) => Math.max(1, Math.floor(refBps / bps));

// ---------------------------------------------------------------- convergence on packets

/** Six routers: the short path A–B–C–F and a longer one A–D–E–F. */
export const CONV_TOPO: Topo = {
  names: ["A", "B", "C", "D", "E", "F"],
  links: [
    { a: 0, b: 1, cost: 1 }, { a: 1, b: 2, cost: 1 }, { a: 2, b: 5, cost: 1 },
    { a: 0, b: 3, cost: 1 }, { a: 3, b: 4, cost: 1 }, { a: 4, b: 5, cost: 2 },
  ],
  pos: [[0.06, 0.5], [0.36, 0.18], [0.66, 0.18], [0.36, 0.82], [0.66, 0.82], [0.94, 0.5]],
};

export type Proto = "dv" | "ls";

export interface ConvOptions {
  proto: Proto;
  /** Links to cut (indexes into CONV_TOPO.links). */
  cut: number[];
  cutAt: number;
  /** Time from the cut until both ends notice it, in ms (a model input: loss of light, or BFD). */
  detectMs: number;
  /** Link-state: wait after a new LSA before running SPF, in ms (a model input; real routers throttle SPF). */
  spfDelayMs: number;
  /** Distance vector: what a router tells the neighbour it routes through. */
  dvMode: "plain" | "split" | "poison";
  /** Distance vector: send an update as soon as a route changes. Off: only the periodic updates. */
  triggered: boolean;
  /** Distance vector: period of the full updates, in ms (a model input; RIP uses 30 s, scaled down here). */
  periodMs: number;
  /** One-way delay of every link, in ms (a model input). */
  linkDelayMs: number;
  /** Data from A to F: one packet every this many ms. */
  dataEveryMs: number;
  until: number;
  record?: boolean;
}

export const CONV_DEFAULTS: ConvOptions = { proto: "ls", cut: [2], cutAt: 20, detectMs: 10, spfDelayMs: 5, dvMode: "poison", triggered: true, periodMs: 30, linkDelayMs: 2, dataEveryMs: 1, until: 120 };

type Ctl = { kind: "dv"; vec: [number, number][] } | { kind: "lsa"; origin: number; seq: number; links: [number, number][] } | { kind: "data" };

export interface ConvResult {
  ip: IpNet<Ctl>;
  /** Each data packet: when it left A and what happened to it. */
  data: { t: number; fate: string; id: number }[];
  /** The last time a forwarding table changed after the cut. */
  convergedAt: number;
  controlPackets: number;
  /** Data packets sent after the cut that did not arrive. */
  lost: number;
  /** Of those, how many died with TTL 0 (they went round a loop). */
  looped: number;
}

const DATA_TTL = 32;

export function convergenceRun(o: ConvOptions): ConvResult {
  const t = CONV_TOPO;
  const ip = new IpNet<Ctl>(t.names, { record: o.record ?? true, ttl: DATA_TTL });
  t.links.forEach((l) => ip.connect(l.a, l.b, { rate: 1e9, delay: o.linkDelayMs }));
  const net = ip.net;
  const n = t.names.length;
  const costOfPort = (port: number) => t.links[net.ports[port]!.link]!.cost;
  const known = new Array<boolean[]>(n).fill([]).map(() => new Array<boolean>(net.ports.length).fill(true)); // [node][port] the node believes the link is up
  const liveports = (v: number) => net.portsAt(v).filter((p) => known[v]![p.id]);
  let controlPackets = 0;
  let lastChange = 0;
  const install = (v: number, dst: number, port: number | null) => {
    const cur = ip.routes(v, dst);
    const next = port === null ? [] : [port];
    if (cur.length === next.length && cur[0] === next[0]) return;
    ip.setRoute(v, dst, next);
    if (net.now >= o.cutAt) lastChange = net.now;
  };

  // ---------- distance vector
  const INF = RIP_INFINITY;
  const heard = Array.from({ length: n }, () => new Map<number, Map<number, number>>()); // [v].get(port) -> vec
  const dv = Array.from({ length: n }, (_, v) => new Map<number, { d: number; port: number | null }>([[v, { d: 0, port: null }]]));
  const pendingDv = new Set<number>();
  const dvRecompute = (v: number) => {
    let changed = false;
    for (let dst = 0; dst < n; dst++) {
      if (dst === v) continue;
      let best = INF, port: number | null = null;
      for (const p of liveports(v)) {
        const d = heard[v]!.get(p.id)?.get(dst);
        if (d === undefined) continue;
        const c = Math.min(INF, costOfPort(p.id) + d);
        if (c < best) { best = c; port = p.id; }
      }
      const cur = dv[v]!.get(dst);
      if (!cur || cur.d !== best || cur.port !== port) {
        dv[v]!.set(dst, { d: best, port: best >= INF ? null : port });
        changed = true;
      }
      install(v, dst, best >= INF ? null : port);
    }
    return changed;
  };
  const dvSend = (v: number) => {
    for (const p of liveports(v)) {
      const vec: [number, number][] = [];
      for (const [dst, r] of dv[v]!) {
        if (r.port === p.id && o.dvMode === "poison") vec.push([dst, INF]);
        else if (r.port !== p.id || o.dvMode === "plain") vec.push([dst, r.d]);
      }
      ip.toNeighbour(v, p.id, 24 + 20 * vec.length, { kind: "dv", vec });
      controlPackets++;
    }
  };
  const dvTrigger = (v: number) => {
    if (!o.triggered || pendingDv.has(v)) return;
    pendingDv.add(v);
    net.at(net.now + 0.1, () => { pendingDv.delete(v); dvSend(v); });
  };

  // ---------- link state
  const lsdb = Array.from({ length: n }, () => new Map<number, { seq: number; links: [number, number][] }>());
  const seq = new Array<number>(n).fill(0);
  const spfPending = new Array<boolean>(n).fill(false);
  const originate = (v: number) => {
    seq[v]!++;
    const links: [number, number][] = liveports(v).map((p) => [p.peer, costOfPort(p.id)]);
    lsdb[v]!.set(v, { seq: seq[v]!, links });
    for (const p of liveports(v)) { ip.toNeighbour(v, p.id, 24 + 12 * links.length, { kind: "lsa", origin: v, seq: seq[v]!, links }); controlPackets++; }
    scheduleSpf(v);
  };
  const scheduleSpf = (v: number) => {
    if (spfPending[v]) return;
    spfPending[v] = true;
    net.at(net.now + o.spfDelayMs, () => { spfPending[v] = false; spf(v); });
  };
  const spf = (v: number) => {
    // Dijkstra over the LSDB, using a link only if both ends list it (the two-way check).
    const has = (a: number, b: number) => lsdb[a]!.get(a) !== undefined && lsdb[a]!.get(a)!.links.some(([x]) => x === b);
    const lists = (a: number) => lsdb[v]!.get(a)?.links ?? [];
    const two = (a: number, b: number) => lists(a).some(([x]) => x === b) && lists(b).some(([x]) => x === a);
    void has;
    const dist = new Array<number>(n).fill(Infinity);
    const first = new Array<number | null>(n).fill(null);
    const done = new Array<boolean>(n).fill(false);
    dist[v] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < Infinity && (u < 0 || dist[i]! < dist[u]!)) u = i;
      if (u < 0) break;
      done[u] = true;
      for (const [w, c] of lists(u)) {
        if (!two(u, w)) continue;
        if (dist[u]! + c < dist[w]!) {
          dist[w] = dist[u]! + c;
          first[w] = u === v ? liveports(v).find((p) => p.peer === w)?.id ?? null : first[u]!;
        }
      }
    }
    for (let d = 0; d < n; d++) if (d !== v) install(v, d, first[d]!);
  };

  ip.onControl = (v, pkt, port) => {
    const m = pkt.payload.app!;
    if (!known[v]![port.id]) return;
    if (m.kind === "dv") {
      heard[v]!.set(port.id, new Map(m.vec));
      if (dvRecompute(v)) dvTrigger(v);
    } else if (m.kind === "lsa") {
      const cur = lsdb[v]!.get(m.origin);
      if (cur && cur.seq >= m.seq) return;
      lsdb[v]!.set(m.origin, { seq: m.seq, links: m.links });
      for (const p of liveports(v)) if (p.id !== port.id) { ip.toNeighbour(v, p.id, pkt.size, m); controlPackets++; }
      scheduleSpf(v);
    }
  };

  // Start converged: run the protocol from scratch before time 0, then reset the clock-free counters.
  for (let v = 0; v < n; v++) {
    if (o.proto === "dv") { dvRecompute(v); dvSend(v); } else originate(v);
  }
  net.runAll();
  controlPackets = 0;
  const t0 = net.now;
  if (o.proto === "dv") {
    // Periodic full updates, each router at its own phase.
    for (let v = 0; v < n; v++) {
      for (let k = 0; t0 + (k + v / n) * o.periodMs < t0 + o.until + 200; k++) net.at(t0 + (k + v / n) * o.periodMs, () => dvSend(v));
    }
  }
  // Data from A to F.
  const sent: { t: number; id: number }[] = [];
  for (let k = 0; t0 + k * o.dataEveryMs < t0 + o.until; k++) {
    net.at(t0 + k * o.dataEveryMs, () => {
      const p = ip.send(0, 5, 100, { proto: "udp", app: { kind: "data" } }, { ttl: DATA_TTL });
      sent.push({ t: net.now - t0, id: p.id });
    });
  }
  ip.listening.set(5, new Set([0]));
  // The cut and its detection.
  const cutAt = t0 + o.cutAt;
  net.at(cutAt, () => { for (const l of o.cut) net.setLinkUp(l, false); });
  net.at(cutAt + o.detectMs, () => {
    for (const l of o.cut) {
      for (const p of net.ports.filter((x) => x.link === l)) known[p.node]![p.id] = false;
    }
    const ends = [...new Set(o.cut.flatMap((l) => [t.links[l]!.a, t.links[l]!.b]))];
    for (const v of ends) {
      if (o.proto === "dv") {
        for (const p of net.portsAt(v)) if (!known[v]![p.id]) heard[v]!.delete(p.id);
        if (dvRecompute(v)) dvTrigger(v);
      } else originate(v);
    }
  });
  lastChange = cutAt;
  net.runUntil(t0 + o.until + 200);
  net.runAll(200_000);
  const data = sent.map((s) => ({ t: s.t, id: s.id, fate: ip.fate.get(s.id) ?? "in flight" }));
  const after = data.filter((d) => d.t >= o.cutAt);
  return {
    ip,
    data,
    convergedAt: lastChange - t0,
    controlPackets,
    lost: after.filter((d) => d.fate !== "delivered").length,
    looped: after.filter((d) => d.fate === "ttl").length,
  };
}

/** True if following the forwarding tables from `src` reaches `dst` without a loop. */
export function pathOf(ip: IpNet<unknown>, src: NodeId, dst: NodeId): { path: NodeId[]; ok: boolean } {
  const path = [src];
  let v = src;
  while (v !== dst && path.length <= ip.net.n) {
    const r = ip.routes(v, dst);
    if (!r.length) return { path, ok: false };
    v = ip.net.ports[r[0]!]!.peer;
    path.push(v);
  }
  return { path, ok: v === dst };
}

export type { IpPacket };
