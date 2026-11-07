/**
 * Ready-made LAN runs for the link-layer lessons. Each builds a small topology on Lan (lan.ts), runs a script and
 * returns what a demo draws and a test pins. Link rates and delays here are model inputs, chosen so that frames
 * are visible on a space-time diagram.
 */
import { formatIpv4, parseIpv4 } from "../bytes";
import type { Packet, Port } from "../packet";
import { Lan, mac, setLinkUp, type Frame, type HostDef, type NeighState, type NodeDef, type PortRole, type PortState, type SwitchDef, type SwitchPortCfg } from "./lan";

const ip = (s: string) => parseIpv4(s);

// ============================================================================ ARP on one switch

export type ArpAction =
  | { kind: "ping"; from: number; to: number }
  | { kind: "garp"; host: number }
  | { kind: "newnic"; host: number }
  | { kind: "flush"; host: number };

/** Model input: a slow LAN (10 Mb/s, 50 µs of cable) so that every frame is visible. Actions are 2 ms apart. */
export const ARP_LAN = { rate: 10e6, delay: 0.05, gapMs: 2 } as const;
export const ARP_HOSTS = ["A", "B", "C", "D"];
export const arpHostIp = (i: number) => ip(`10.0.0.${i + 1}`);

/** Hosts 0..3 (10.0.0.1 .. 10.0.0.4) on switch 4. Action k starts at k × 2 ms. */
export function arpRun(actions: ArpAction[]) {
  const defs: NodeDef[] = [
    ...ARP_HOSTS.map((name, i): HostDef => ({ kind: "host", name, mac: mac(0xa0 + i), ip: arpHostIp(i) })),
    { kind: "switch", name: "switch", mac: mac(0xf0) },
  ];
  const lan = new Lan(defs);
  for (let i = 0; i < 4; i++) lan.link(i, 4, { rate: ARP_LAN.rate, delay: ARP_LAN.delay });
  let nic = 0;
  actions.forEach((a, k) => {
    lan.at(k * ARP_LAN.gapMs, (l) => {
      if (a.kind === "ping") l.ping(a.from, arpHostIp(a.to));
      else if (a.kind === "garp") l.host(a.host).announce(l);
      else if (a.kind === "flush") l.host(a.host).flush();
      else {
        l.host(a.host).setMac(mac(0xb0 + a.host + 16 * ++nic));
        l.log(a.host, `${ARP_HOSTS[a.host]} gets a new network card: ${l.host(a.host).mac}`, "warn");
      }
    });
  });
  lan.net.runUntil(actions.length * ARP_LAN.gapMs);
  return lan;
}

// ============================================================================ the neighbour cache over time

export interface NudOpts {
  /** A pings B every this many ms. */
  intervalMs: number;
  untilMs: number;
  baseReachableMs?: number;
  /** B's cable is cut at this time. */
  dieAtMs?: number;
  /** TCP-like upper-layer confirmations: each pong confirms B. */
  confirm: boolean;
  seed?: number;
}

export interface NudResult {
  history: { t: number; state: NeighState }[];
  /** ARP requests A sent: time and whether it was a broadcast or a unicast probe. */
  arp: { t: number; broadcast: boolean }[];
  pings: number;
  pongs: number;
  /** Pings dropped because the entry failed. */
  unresolved: number;
  reachableMs: number;
}

/** A (10.0.0.1) pings B (10.0.0.2) through a switch. Returns A's neighbour entry for B over time. */
export function nudRun(o: NudOpts): NudResult {
  const neigh = o.baseReachableMs ? { baseReachableMs: o.baseReachableMs } : undefined;
  const lan = new Lan([
    { kind: "host", name: "A", mac: mac(0xa0), ip: ip("10.0.0.1"), upperConfirm: o.confirm, neigh },
    { kind: "host", name: "B", mac: mac(0xa1), ip: ip("10.0.0.2"), neigh },
    { kind: "switch", name: "S", mac: mac(0xf0) },
  ], { seed: o.seed ?? 1 });
  lan.link(0, 2);
  const lb = lan.link(1, 2);
  for (let t = 0; t < o.untilMs; t += o.intervalMs) lan.at(t, (l) => l.ping(0, ip("10.0.0.2")));
  if (o.dieAtMs !== undefined) lan.at(o.dieAtMs, (l) => setLinkUp(l, lb, false));
  lan.net.runUntil(o.untilMs);
  const a = lan.host(0);
  const e = a.neigh.get(ip("10.0.0.2"));
  const arp: NudResult["arp"] = [];
  for (const ev of lan.net.trace) {
    if (ev.kind === "tx" && lan.net.ports[ev.port]!.node === 0 && ev.pkt.payload.body.kind === "arp" && ev.pkt.payload.body.arp.op === 1) arp.push({ t: ev.t, broadcast: ev.pkt.payload.dst === "ff:ff:ff:ff:ff:ff" });
  }
  return {
    history: (e?.history ?? []).map((h) => ({ t: h.t, state: h.state })),
    arp,
    pings: a.stats.sent,
    pongs: a.stats.delivered,
    unresolved: a.stats.unresolved,
    reachableMs: a.reachableMs,
  };
}

// ============================================================================ ARP spoofing

export interface SpoofOpts {
  attack: boolean;
  /** The attacker passes the traffic on to the real gateway (a man in the middle). */
  forward: boolean;
  /** The victim has a static entry for the gateway. */
  staticArp: boolean;
  /** The switch runs dynamic ARP inspection. */
  inspect: boolean;
  untilMs?: number;
}

export type SpoofPath = "direct" | "via attacker" | "lost";

export const SPOOF = { victim: 0, gateway: 1, attacker: 2, switch: 3, attackAt: 2_000, every: 1_000, pingEvery: 250 } as const;

/**
 * The victim (10.0.0.10) sends a packet to 8.8.8.8 every 250 ms through the gateway (10.0.0.1). From 2 s on, the
 * attacker (10.0.0.66) sends a forged ARP reply every second: "10.0.0.1 is at the attacker's MAC".
 */
export function spoofRun(o: SpoofOpts) {
  const V = mac(0x10), G = mac(0x01), M = mac(0x66);
  const vIp = ip("10.0.0.10"), gIp = ip("10.0.0.1"), mIp = ip("10.0.0.66");
  const arrivals = new Map<string, SpoofPath>();
  const lan = new Lan([
    { kind: "host", name: "victim", mac: V, ip: vIp, gateway: gIp, statics: o.staticArp ? [[gIp, G]] : undefined },
    { kind: "host", name: "gateway", mac: G, ip: gIp, internet: true },
    { kind: "host", name: "attacker", mac: M, ip: mIp, gateway: gIp, forward: o.forward },
    { kind: "switch", name: "switch", mac: mac(0xf0), inspect: o.inspect ? { bindings: [[V, vIp], [G, gIp], [M, mIp]], trusted: [] } : undefined },
  ], {
    onFrame: (node, pkt) => {
      const b = pkt.payload.body;
      if (node === SPOOF.gateway && b.kind === "ip" && pkt.payload.dst === G) arrivals.set(b.ip.data, pkt.payload.src === M ? "via attacker" : "direct");
    },
  });
  for (let i = 0; i < 3; i++) lan.link(i, 3, { rate: 100e6, delay: 0.001 });
  const until = o.untilMs ?? 8_000;
  const sent: { t: number; data: string }[] = [];
  for (let t = 0, k = 0; t < until; t += SPOOF.pingEvery, k++) {
    const data = `p${k}`;
    sent.push({ t, data });
    lan.at(t, (l) => l.host(0).sendIp(l, ip("8.8.8.8"), data, 84));
  }
  if (o.attack) {
    for (let t = SPOOF.attackAt; t < until; t += SPOOF.every) {
      lan.at(t, (l) => {
        l.log(SPOOF.attacker, "forged reply: 10.0.0.1 is at the attacker", "bad");
        l.host(SPOOF.attacker).sendArp(l, { op: 2, sha: M, spa: gIp, tha: V, tpa: vIp }, V);
      });
    }
  }
  lan.net.runUntil(until + 50);
  const path = sent.map((s) => ({ t: s.t, path: arrivals.get(s.data) ?? ("lost" as SpoofPath) }));
  const entry = lan.host(0).neigh.get(gIp);
  return {
    lan,
    path,
    count: (p: SpoofPath) => path.filter((x) => x.path === p).length,
    /** The victim's entry for the gateway over time: which MAC it maps to. */
    entry: (entry?.history ?? []).map((h) => ({ t: h.t, state: h.state, poisoned: h.mac === M })),
    macs: { victim: V, gateway: G, attacker: M },
  };
}

// ============================================================================ a learning switch

export type LearnAction = { kind: "send"; from: number; to: number | "all" } | { kind: "wait"; ms: number };

export const LEARN_HOSTS = ["A", "B", "C", "D"];

export interface LearnStep {
  t: number;
  action: LearnAction;
  /** Hosts whose link carried a copy of the frame. */
  reached: number[];
  flooded: boolean;
  /** MAC table after the step: host index → port (host index), with age in ms. */
  table: { host: number; ageMs: number }[];
}

/** Hosts 0..3 on one switch (node 4). Each send happens 1 ms after the previous action; a wait adds time. */
export function learnRun(actions: LearnAction[], agingMs: number): LearnStep[] {
  const defs: NodeDef[] = [...LEARN_HOSTS.map((name, i): HostDef => ({ kind: "host", name, mac: mac(0xa0 + i), ip: ip(`10.0.0.${i + 1}`) })), { kind: "switch", name: "switch", mac: mac(0xf0), agingMs }];
  let current: Set<number> = new Set();
  const lan = new Lan(defs, { record: false, onFrame: (node) => current.add(node) });
  for (let i = 0; i < 4; i++) lan.link(i, 4, { rate: 1e9, delay: 0.001 });
  const sw = lan.sw(4);
  const steps: LearnStep[] = [];
  let t = 0;
  for (const a of actions) {
    if (a.kind === "wait") {
      t += a.ms;
      lan.net.runUntil(t);
    } else {
      t += 1;
      lan.net.runUntil(t);
      current = new Set();
      const before = sw.stats.flooded;
      const dst = a.to === "all" ? "ff:ff:ff:ff:ff:ff" : mac(0xa0 + a.to);
      lan.emit(a.from, lan.net.portsAt(a.from)[0]!, { dst, src: mac(0xa0 + a.from), body: { kind: "data", text: "data", size: 100 } });
      lan.net.runUntil(t + 0.5);
      current.delete(4);
      steps.push({ t, action: a, reached: [...current].sort(), flooded: sw.stats.flooded > before, table: [] });
    }
    const last = steps[steps.length - 1];
    const tbl = sw.entries(lan.now).map((e) => ({ host: lan.net.ports[e.port]!.peer, ageMs: lan.now - e.seen }));
    if (a.kind === "wait") steps.push({ t, action: a, reached: [], flooded: false, table: tbl });
    else if (last) last.table = tbl;
  }
  return steps;
}

// ============================================================================ loops and broadcast storms

export type StormTopo = "line" | "triangle" | "mesh";

export interface StormOpts {
  topo: StormTopo;
  stp: boolean;
  /** How long to watch after the one broadcast, in ms. */
  watchMs: number;
  /** Model input: switch-to-switch link rate. */
  rate?: number;
  /** Model input: queue limit per port, in frames. */
  queue?: number;
}

export interface StormResult {
  switches: number;
  /** Frames that arrived at switches in each bucket. */
  buckets: { t: number; frames: number }[];
  bucketMs: number;
  /** Copies of the single broadcast that host H2 received. */
  copiesAtH2: number;
  /** Times a switch saw H1's MAC move to another port. */
  moves: number;
  /** Busy fraction of the busiest switch-to-switch port during the watch. */
  utilization: number;
  /** Frames dropped at full queues. */
  queueDrops: number;
  /** Switch ports that STP blocked. */
  blocked: number;
  /** Switch-to-switch links with a blocked end, as [a, b]. */
  blockedLinks: [number, number][];
  /** Time STP needed before the broadcast was sent, in ms (0 without STP). */
  startMs: number;
}

export const STORM_LINKS: Record<StormTopo, [number, number][]> = {
  line: [[0, 1], [1, 2]],
  triangle: [[0, 1], [1, 2], [2, 0]],
  mesh: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
};

/**
 * Switches S1..Sk, one host on each. H1 sends ONE broadcast (an ARP request). With STP, the run first waits until
 * every port has settled (2 × forward delay + margin). Then it watches for `watchMs`.
 */
export function stormRun(o: StormOpts): StormResult {
  const k = o.topo === "mesh" ? 4 : 3;
  const rate = o.rate ?? 1e9;
  const defs: NodeDef[] = [];
  for (let i = 0; i < k; i++) defs.push({ kind: "switch", name: `S${i + 1}`, mac: mac(0xf1 + i), stp: o.stp });
  for (let i = 0; i < k; i++) defs.push({ kind: "host", name: `H${i + 1}`, mac: mac(0xa1 + i), ip: ip(`10.0.0.${i + 1}`) });
  const bucketMs = o.watchMs / 40;
  let start = Infinity;
  const counts = new Array<number>(40).fill(0);
  let copies = 0;
  const lan = new Lan(defs, {
    record: false,
    onFrame: (node, pkt) => {
      if (pkt.payload.dst === "01:80:c2:00:00:00") return;
      const t = lan.now - start;
      if (node < k && t >= 0 && t < o.watchMs) counts[Math.floor(t / bucketMs)]!++;
      if (node === k + 1 && pkt.payload.body.kind === "arp") copies++;
    },
  });
  const sw: Port[] = [];
  for (const [a, b] of STORM_LINKS[o.topo]) {
    lan.link(a, b, { rate, delay: 0.001, queuePackets: o.queue ?? 64 });
    sw.push(lan.net.portTo(a, b), lan.net.portTo(b, a));
  }
  for (let i = 0; i < k; i++) lan.link(k + i, i, { rate, delay: 0.001, queuePackets: o.queue ?? 64 });
  lan.start();
  const settle = o.stp ? 2 * 15_000 + 2_000 : 0;
  lan.net.runUntil(settle);
  start = lan.now;
  const busy0 = sw.map((p) => p.stats.busyMs);
  const drops0 = lan.net.ports.reduce((s, p) => s + p.stats.drops, 0);
  const moves0 = defs.slice(0, k).reduce((s, _d, i) => s + lan.sw(i).stats.moves, 0);
  lan.host(k).sendArp(lan, { op: 1, sha: mac(0xa1), spa: ip("10.0.0.1"), tha: "00:00:00:00:00:00", tpa: ip("10.0.0.99") }, "ff:ff:ff:ff:ff:ff");
  lan.net.runUntil(start + o.watchMs);
  const util = Math.max(...sw.map((p, i) => (p.stats.busyMs - busy0[i]!) / o.watchMs));
  let blocked = 0;
  const blockedLinks: [number, number][] = [];
  for (let i = 0; i < k; i++) for (const p of lan.net.portsAt(i)) if (lan.sw(i).portState(p) === "blocking") {
    blocked++;
    blockedLinks.push([Math.min(i, p.peer), Math.max(i, p.peer)]);
  }
  return {
    switches: k,
    buckets: counts.map((frames, i) => ({ t: i * bucketMs, frames })),
    bucketMs,
    copiesAtH2: copies,
    moves: defs.slice(0, k).reduce((s, _d, i) => s + lan.sw(i).stats.moves, 0) - moves0,
    utilization: Math.min(1, util),
    queueDrops: lan.net.ports.reduce((s, p) => s + p.stats.drops, 0) - drops0,
    blocked,
    blockedLinks,
    startMs: settle,
  };
}

// ============================================================================ spanning tree: election and failover

/** Four switches in a square with one diagonal. Links: S1–S2, S1–S3, S2–S4, S3–S4, S2–S3. */
export const STP_LINKS: [number, number][] = [[0, 1], [0, 2], [1, 3], [2, 3], [1, 2]];
export const STP_NAMES = ["S1", "S2", "S3", "S4"];

export interface StpOpts {
  /** Bridge priority of S1..S4 (multiples of 4096). */
  priorities: number[];
  /** Link rates of STP_LINKS (bit/s). Model inputs. */
  rates?: number[];
  /** Index into STP_LINKS of the link to cut, or -1. */
  cut: number;
  cutAtMs?: number;
  rapid: boolean;
  untilMs?: number;
}

export interface StpPortView {
  sw: number;
  peer: number;
  role: PortRole;
  state: PortState;
}

export interface StpResult {
  root: number;
  /** Port roles and states when the run ends. */
  ports: StpPortView[];
  /** Port roles just before the cut (or at the end, without a cut). */
  before: StpPortView[];
  /** Pings from host A (on S3) to host B (on S4... see the hosts below) every 500 ms: sent time and success. */
  pings: { t: number; ok: boolean }[];
  /** Longest run of lost pings after the cut, in ms (0 if none). */
  outageMs: number;
  /** When the first port reached forwarding after the start (the network starts to carry data). */
  firstForwardMs: number;
  events: { t: number; text: string }[];
  rootCost: number[];
}

/** Hosts: A on S4 and B on S1... A pings B. Hosts sit on edge ports, so their own links forward at once. */
export function stpRun(o: StpOpts): StpResult {
  const until = o.untilMs ?? 110_000;
  const cutAt = o.cutAtMs ?? 40_000;
  const defs: NodeDef[] = STP_NAMES.map((name, i): SwitchDef => ({ kind: "switch", name, mac: mac(0xf1 + i), stp: true, priority: o.priorities[i] ?? 32768, rapid: o.rapid }));
  defs.push({ kind: "host", name: "A", mac: mac(0xa1), ip: ip("10.0.0.1"), upperConfirm: true });
  defs.push({ kind: "host", name: "B", mac: mac(0xa2), ip: ip("10.0.0.2"), upperConfirm: true });
  const got = new Set<string>();
  const lan = new Lan(defs, { onFrame: (node, pkt) => { const b = pkt.payload.body; if (node === 4 && b.kind === "ip" && b.ip.data.startsWith("pong")) got.add(b.ip.data.slice(4)); } });
  const links = STP_LINKS.map(([a, b], i) => lan.link(a, b, { rate: o.rates?.[i] ?? 1e9, delay: 0.001 }));
  lan.link(4, 3);
  lan.link(5, 0);
  lan.start();
  let firstForward = Infinity;
  const sent: { t: number; k: number }[] = [];
  for (let t = 1_000, k = 0; t < until; t += 500, k++) {
    sent.push({ t, k });
    lan.at(t, (l) => l.host(4).sendIp(l, ip("10.0.0.2"), `ping${k}`, 84));
  }
  const view = (): StpPortView[] => {
    const out: StpPortView[] = [];
    for (let i = 0; i < 4; i++) for (const p of lan.net.portsAt(i)) if (p.peer < 4) out.push({ sw: i, peer: p.peer, role: lan.sw(i).portRole(p)!, state: lan.sw(i).portState(p) });
    return out;
  };
  const watch = () => {
    if (firstForward === Infinity && view().some((v) => v.state === "forwarding")) firstForward = lan.now;
  };
  for (let t = 100; t < until; t += 100) lan.at(t, watch);
  let before: StpPortView[] = [];
  lan.at(cutAt - 1, () => (before = view()));
  if (o.cut >= 0) lan.at(cutAt, (l) => { l.log(o.cut, `link ${STP_NAMES[STP_LINKS[o.cut]![0]]}–${STP_NAMES[STP_LINKS[o.cut]![1]]} is cut`, "bad"); setLinkUp(l, links[o.cut]!, false); });
  lan.net.runUntil(until);
  if (!before.length) before = view();
  const pings = sent.map((s) => ({ t: s.t, ok: got.has(String(s.k)) }));
  let outage = 0, runStart = -1;
  for (const p of pings) {
    if (p.t < cutAt || o.cut < 0) continue;
    if (!p.ok && runStart < 0) runStart = p.t;
    if (p.ok && runStart >= 0) {
      outage = Math.max(outage, p.t - runStart);
      runStart = -1;
    }
  }
  if (runStart >= 0) outage = Math.max(outage, until - runStart);
  const roots = STP_NAMES.map((_, i) => lan.sw(i).rootId);
  const rootSw = STP_NAMES.findIndex((_, i) => lan.sw(i).bridgeId === roots[0]);
  return {
    root: rootSw,
    ports: view(),
    before,
    pings,
    outageMs: outage,
    firstForwardMs: firstForward,
    events: lan.events.filter((e) => e.t > 0).map((e) => ({ t: e.t, text: e.text })),
    rootCost: STP_NAMES.map((_, i) => lan.sw(i).rootCost),
  };
}

// ============================================================================ VLANs and trunks

export const VLAN_HOSTS = ["A", "B", "C", "D"];
/** A and C are in VLAN 10, B and D in VLAN 20. A and B sit on S1, C and D on S2. */
export const VLAN_OF = [10, 20, 10, 20];

export interface VlanOpts {
  /** Who sends a broadcast. */
  from: number;
  /** "trunk": the S1–S2 link carries VLANs 10 and 20, tagged. "only10": it carries 10 only. "access": both ends are access ports in VLAN 10. */
  uplink: "trunk" | "only10" | "access";
  /** S1 uses native VLAN 10 on the trunk, S2 uses 20 (a misconfiguration). */
  nativeMismatch: boolean;
}

export interface VlanResult {
  /** Hosts whose NIC took the broadcast. */
  heard: number[];
  /** The frame on the S1–S2 link, if one crossed: its VLAN tag (undefined = untagged) and its size in bytes. */
  uplink?: { vid?: number; bytes: number; dir: "S1→S2" | "S2→S1" };
  /** Frames dropped by a switch for a VLAN rule. */
  dropped: number;
}

export function vlanRun(o: VlanOpts): VlanResult {
  // Nodes: S1 = 0, S2 = 1, hosts A..D = 2..5.
  const trunk = (native: number): SwitchPortCfg =>
    o.uplink === "access" ? { mode: "access", vid: 10 } : { mode: "trunk", vid: native, allowed: o.uplink === "only10" ? [10] : [10, 20] };
  const nat1 = o.nativeMismatch ? 10 : 1, nat2 = o.nativeMismatch ? 20 : 1;
  const defs: NodeDef[] = [
    { kind: "switch", name: "S1", mac: mac(0xf1), ports: { 1: trunk(nat1), 2: { mode: "access", vid: VLAN_OF[0]! }, 3: { mode: "access", vid: VLAN_OF[1]! } } },
    { kind: "switch", name: "S2", mac: mac(0xf2), ports: { 0: trunk(nat2), 4: { mode: "access", vid: VLAN_OF[2]! }, 5: { mode: "access", vid: VLAN_OF[3]! } } },
    ...VLAN_HOSTS.map((name, i): HostDef => ({ kind: "host", name, mac: mac(0xa0 + i), ip: ip(`10.0.0.${i + 1}`) })),
  ];
  const heard = new Set<number>();
  let uplink: VlanResult["uplink"];
  const lan = new Lan(defs, {
    onFrame: (node, pkt: Packet<Frame>, port) => {
      if (node >= 2) heard.add(node - 2);
      if (node <= 1 && port.peer <= 1) uplink = { vid: pkt.payload.vid, bytes: pkt.size - 20, dir: node === 1 ? "S1→S2" : "S2→S1" };
    },
  });
  lan.link(0, 1);
  lan.link(2, 0);
  lan.link(3, 0);
  lan.link(4, 1);
  lan.link(5, 1);
  const src = 2 + o.from;
  lan.emit(src, lan.net.portsAt(src)[0]!, { dst: "ff:ff:ff:ff:ff:ff", src: mac(0xa0 + o.from), body: { kind: "data", text: "hello", size: 46 } });
  lan.net.runUntil(1);
  return { heard: [...heard].sort(), uplink, dropped: lan.sw(0).stats.dropped + lan.sw(1).stats.dropped };
}

export { formatIpv4 };
