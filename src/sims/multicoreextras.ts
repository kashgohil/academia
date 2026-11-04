/**
 * Extra models for the multicore lessons: a coherence state machine seen from one cache,
 * false sharing by byte offset, routes on on-chip networks, directory messages, a store-buffer
 * timeline, schedule counting for litmus tests, and NUMA data flows.
 * Pure TypeScript, no React. The numbers the lessons quote are pinned in tests/unit/multicoreextras.test.ts.
 */
import { Coherence, runWorkload, WORKLOADS, LAT, type Protocol, type St, type Access } from "./coherence";
import { avgHops, links, coherenceMessages, type Topology, type SharingPattern } from "./interconnect";
import { simulateNuma, socketOf, NUMA_DEFAULTS, type NumaConfig, type NumaResult, type Placement } from "./numa";
import { initial, exec, drain, drainable, blocked, finished, outcomeOf, type Mode, type SBState } from "./storebuffer";
import type { Program } from "./memmodel/ast";

export { LAT, NUMA_DEFAULTS };

// =====================================================================================
// Coherence: one line, seen from core 0's cache
// =====================================================================================

/**
 * The state of a line in one cache. Coherence.state() returns the first entry for the address,
 * which can be an old Invalid entry when the line came back later; this looks for the valid one.
 */
export function lineState(c: Coherence, core: number, addr: number): St {
  return c.caches[core]!.find((l) => l.addr === addr && l.st !== "I")?.st ?? "I";
}

export type CohEvent = "myRead" | "myWrite" | "otherRead" | "otherWrite";
export const COH_EVENTS: CohEvent[] = ["myRead", "myWrite", "otherRead", "otherWrite"];
export const COH_EVENT_LABEL: Record<CohEvent, string> = {
  myRead: "This core reads",
  myWrite: "This core writes",
  otherRead: "Other core reads",
  otherWrite: "Other core writes",
};

export interface CohStep {
  ev: CohEvent;
  /** State of the line in this core's cache (core 0) before and after. */
  from: St;
  to: St;
  /** State in the other core's cache (core 1) before and after. */
  otherFrom: St;
  otherTo: St;
  bus: "BusRd" | "BusRdX" | "BusUpgr" | null;
  text: string;
}

/** Replays events on line A with two cores: core 0 is "this core", core 1 is "the other core". */
export function replayEvents(protocol: Protocol, events: CohEvent[]) {
  const c = new Coherence(2, 4, protocol);
  const steps: CohStep[] = [];
  let v = 0;
  for (const ev of events) {
    const from = lineState(c, 0, 0), otherFrom = lineState(c, 1, 0);
    const before = c.log.length;
    const core = ev === "myRead" || ev === "myWrite" ? 0 : 1;
    if (ev === "myRead" || ev === "otherRead") c.read(core, 0);
    else c.write(core, 0, ++v);
    const e = c.log.slice(before).at(-1);
    const bus = e && e.bus && e.bus !== "WB" ? e.bus : null;
    steps.push({ ev, from, to: lineState(c, 0, 0), otherFrom, otherTo: lineState(c, 1, 0), bus, text: e?.text ?? "" });
  }
  return { coh: c, steps };
}

export interface CohEdge { from: St; to: St; ev: CohEvent; bus: CohStep["bus"] }

/**
 * Every transition of this core's state that the protocol can make, found by exploring all
 * reachable (this core, other core) state pairs with the real protocol code.
 */
export function transitionEdges(protocol: Protocol): CohEdge[] {
  const seen = new Set<string>();
  const edges = new Map<string, CohEdge>();
  let frontier: CohEvent[][] = [[]];
  while (frontier.length) {
    const next: CohEvent[][] = [];
    for (const seq of frontier) {
      const { coh } = replayEvents(protocol, seq);
      const key = lineState(coh, 0, 0) + lineState(coh, 1, 0);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const ev of COH_EVENTS) {
        const s = replayEvents(protocol, [...seq, ev]).steps.at(-1)!;
        const k = `${s.from}${s.to}${ev}${s.bus}`;
        if (!edges.has(k)) edges.set(k, { from: s.from, to: s.to, ev, bus: s.bus });
        next.push([...seq, ev]);
      }
    }
    frontier = next;
  }
  return [...edges.values()];
}

/** The states a protocol uses. */
export const protocolStates = (p: Protocol): St[] => (p === "MSI" ? ["M", "S", "I"] : p === "MESI" ? ["M", "E", "S", "I"] : ["M", "O", "E", "S", "I"]);

// =====================================================================================
// False sharing by byte distance
// =====================================================================================

export const LINE_BYTES = 64;

/** Two cores take turns to increment their own 8-byte counter. Counter A is at byte 0, counter B at `distance`. */
export function falseSharingTrace(distance: number, increments: number): Access[] {
  const lineB = Math.floor(distance / LINE_BYTES);
  const out: Access[] = [];
  for (let i = 0; i < increments; i++)
    out.push({ core: 0, op: "R", addr: 0 }, { core: 0, op: "W", addr: 0 }, { core: 1, op: "R", addr: lineB }, { core: 1, op: "W", addr: lineB });
  return out;
}

export interface FalseSharingResult { sameLine: boolean; bus: number; invalidations: number; c2c: number; cycles: number; hits: number; accesses: number }

export function falseSharing(distance: number, increments = 8, protocol: Protocol = "MESI"): FalseSharingResult {
  const tr = falseSharingTrace(distance, increments);
  const c = runWorkload(tr, 2, protocol);
  return { sameLine: distance < LINE_BYTES, bus: c.busTransactions, invalidations: c.c.invalidations, c2c: c.c.c2c, cycles: c.c.cycles, hits: c.c.hits, accesses: tr.length };
}

export interface FsFrame { access: Access; hit: boolean; bus: string | null; a: [St, St]; b: [St, St] }

/** The same run, one access at a time, with each core's state for the lines that hold A and B. */
export function falseSharingFrames(distance: number, increments = 8, protocol: Protocol = "MESI"): FsFrame[] {
  const tr = falseSharingTrace(distance, increments);
  const lineB = Math.floor(distance / LINE_BYTES);
  const c = new Coherence(2, 4, protocol);
  let v = 0;
  return tr.map((a) => {
    const n = c.log.length;
    if (a.op === "R") c.read(a.core, a.addr);
    else c.write(a.core, a.addr, ++v);
    const e = c.log.slice(n).at(-1);
    return {
      access: a,
      hit: !e?.bus,
      bus: e?.bus ?? null,
      a: [lineState(c, 0, 0), lineState(c, 1, 0)],
      b: [lineState(c, 0, lineB), lineState(c, 1, lineB)],
    };
  });
}

/** Bus transactions and cycles for a named workload of the coherence lesson. */
export function workloadStats(id: string, cores: number, protocol: Protocol) {
  const w = WORKLOADS.find((x) => x.id === id);
  if (!w) throw new Error(`unknown workload ${id}`);
  const c = runWorkload(w.gen(cores), cores, protocol);
  return { bus: c.busTransactions, memWrites: c.c.memWrites, cycles: c.c.cycles };
}

// =====================================================================================
// On-chip networks: routes and hop counts
// =====================================================================================

/** Closest-to-square factorization rows × cols = n (the same rule as sims/interconnect). */
export function gridDims(n: number): [number, number] {
  let r = Math.floor(Math.sqrt(n));
  while (n % r) r--;
  return [r, n / r];
}

export type NetTopology = Extract<Topology, "ring" | "mesh" | "torus">;

/** Nodes visited from a to b (both included). Ring: the shorter way. Mesh and torus: X first, then Y (dimension-order routing). */
export function route(t: NetTopology, n: number, a: number, b: number): number[] {
  const path = [a];
  if (a === b) return path;
  if (t === "ring") {
    const fwd = (b - a + n) % n;
    const dir = fwd <= n - fwd ? 1 : -1;
    let x = a;
    while (x !== b) { x = (x + dir + n) % n; path.push(x); }
    return path;
  }
  const [r, c] = gridDims(n);
  let row = Math.floor(a / c), col = a % c;
  const tr = Math.floor(b / c), tc = b % c;
  const stepToward = (from: number, to: number, size: number) => {
    if (t === "mesh") return from < to ? 1 : -1;
    const fwd = (to - from + size) % size;
    return fwd <= size - fwd ? 1 : -1;
  };
  while (col !== tc) { col = (col + stepToward(col, tc, c) + c) % c; path.push(row * c + col); }
  while (row !== tr) { row = (row + stepToward(row, tr, r) + r) % r; path.push(row * c + col); }
  return path;
}

export const hops = (t: NetTopology, n: number, a: number, b: number) => route(t, n, a, b).length - 1;

/** The largest hop count between any two nodes. */
export function diameter(t: NetTopology, n: number): number {
  let d = 0;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) d = Math.max(d, hops(t, n, a, b));
  return d;
}

export function networkSummary(t: NetTopology, n: number) {
  return { avg: avgHops(t, n), diameter: diameter(t, n), links: links(t, n) };
}

/** Messages per coherence transaction for one sharing pattern (re-exported for the lesson numbers). */
export const messagesPerTransaction = (p: SharingPattern, n: number) => coherenceMessages(p, n);

// =====================================================================================
// Directory protocol: the messages for one access
// =====================================================================================

export type Party = number | "home";
export type DirKind = "request" | "forward" | "data" | "writeback" | "grant" | "invalidate" | "ack";
export interface DirMsg { from: Party; to: Party; kind: DirKind }

export interface DirStep {
  core: number;
  op: "R" | "W";
  msgs: DirMsg[];
  /** A snooping bus would broadcast this access to every other cache. */
  busTransaction: boolean;
  snoopLookups: number;
  hit: boolean;
}

/**
 * Applies one access to `coh` (line A) and lists the messages a directory protocol sends.
 * The list follows the same rules as the message counter in sims/coherence.
 */
export function directoryStep(coh: Coherence, core: number, op: "R" | "W", value: number): DirStep {
  const n = coh.cores;
  const mine = lineState(coh, core, 0);
  const others = Array.from({ length: n }, (_, k) => k).filter((k) => k !== core && lineState(coh, k, 0) !== "I");
  const msgs: DirMsg[] = [];
  const m = (from: Party, to: Party, kind: DirKind) => msgs.push({ from, to, kind });
  const inv = () => others.forEach((k) => { m("home", k, "invalidate"); m(k, core, "ack"); });
  if (op === "R") {
    if (mine === "I") {
      m(core, "home", "request");
      const owner = others.find((k) => { const s = lineState(coh, k, 0); return s === "M" || s === "O" || s === "E"; });
      const os = owner === undefined ? null : lineState(coh, owner, 0);
      if (owner !== undefined && (os === "M" || os === "O" || coh.protocol !== "MSI")) {
        m("home", owner, "forward");
        m(owner, core, "data");
        if (os === "M" && coh.protocol !== "MOESI") m(owner, "home", "writeback");
      } else m("home", core, "data");
    }
    coh.read(core, 0);
  } else {
    if (mine === "S" || mine === "O") {
      m(core, "home", "request");
      m("home", core, "grant");
      inv();
    } else if (mine === "I") {
      m(core, "home", "request");
      const owner = others.find((k) => { const s = lineState(coh, k, 0); return s === "M" || s === "O"; });
      if (owner !== undefined) { m("home", owner, "forward"); m(owner, core, "data"); }
      else m("home", core, "data");
      inv();
    }
    coh.write(core, 0, value);
  }
  const hit = msgs.length === 0;
  const busTransaction = !hit;
  return { core, op, msgs, busTransaction, snoopLookups: busTransaction ? n - 1 : 0, hit };
}

/** Replays a list of accesses on line A and returns every step. */
export function directoryRun(cores: number, protocol: Protocol, accesses: { core: number; op: "R" | "W" }[]) {
  const coh = new Coherence(cores, 4, protocol);
  const steps = accesses.map((a, i) => directoryStep(coh, a.core, a.op, i + 1));
  return { coh, steps, dirMsgs: steps.reduce((s, x) => s + x.msgs.length, 0), snoopLookups: steps.reduce((s, x) => s + x.snoopLookups, 0) };
}

// =====================================================================================
// Store buffer timeline (store buffering litmus test, one fixed schedule)
// =====================================================================================

export interface SbTimeline {
  /** Per core: when the store enters the buffer, when it reaches memory, when the load runs. */
  store: [number, number];
  visible: [number, number];
  load: [number, number];
  r: [number, number];
  /** Cycles each load waited for its own store (fence only). */
  stall: [number, number];
  /** r0 = r1 = 0: impossible under sequential consistency. */
  weak: boolean;
  end: number;
}

/**
 * Core 0 runs `x = 1; r0 = y` from cycle 0. Core 1 runs `y = 1; r1 = x` from cycle `gap`.
 * Each instruction takes one cycle. A store reaches memory `drain` cycles after it runs.
 * A load reads memory (no core sees the other core's buffer). With a fence, the load waits
 * until the core's own store has reached memory.
 */
export function sbTimeline(drain: number, gap: number, fence: boolean): SbTimeline {
  const store: [number, number] = [0, gap];
  const visible: [number, number] = [drain, gap + drain];
  const load: [number, number] = [0, 1].map((i) => (fence ? Math.max(store[i]! + 1, visible[i]!) : store[i]! + 1)) as [number, number];
  const r: [number, number] = [visible[1] <= load[0] ? 1 : 0, visible[0] <= load[1] ? 1 : 0];
  const stall: [number, number] = [load[0] - store[0] - 1, load[1] - store[1] - 1];
  return { store, visible, load, r, stall, weak: r[0] === 0 && r[1] === 0, end: Math.max(...visible, ...load) + 1 };
}

// =====================================================================================
// Litmus tests: count every schedule of the store-buffer machine
// =====================================================================================

export type SchedStep = { kind: "exec"; core: number; pc: number } | { kind: "drain"; core: number; loc: string; val: number };
export interface OutcomeCount { key: string; count: number; witness: SchedStep[] }

/**
 * Every order in which the machine can take its steps (run the next instruction of a core,
 * or write a buffered store to memory), grouped by final outcome. `count` is the number of
 * distinct schedules; `witness` is one schedule that gives the outcome.
 */
export function countSchedules(p: Program, mode: Mode): { outcomes: OutcomeCount[]; schedules: number } {
  type Agg = Map<string, { count: number; witness: SchedStep[] }>;
  const memo = new Map<string, Agg>();
  const visit = (s: SBState): Agg => {
    const key = JSON.stringify(s);
    const hit = memo.get(key);
    if (hit) return hit;
    const agg: Agg = new Map();
    if (finished(p, s)) agg.set(outcomeOf(p, s), { count: 1, witness: [] });
    else {
      const moves: [SchedStep, SBState][] = [];
      s.cores.forEach((c, i) => {
        if (!blocked(p, s, i)) moves.push([{ kind: "exec", core: i, pc: c.pc }, exec(p, s, i, mode)]);
        for (const k of drainable(s, i, mode)) {
          const e = c.buf[k]!;
          moves.push([{ kind: "drain", core: i, loc: e.loc, val: e.val }, drain(s, i, k, mode)]);
        }
      });
      for (const [step, ns] of moves)
        for (const [o, v] of visit(ns)) {
          const cur = agg.get(o);
          if (cur) cur.count += v.count;
          else agg.set(o, { count: v.count, witness: [step, ...v.witness] });
        }
    }
    memo.set(key, agg);
    return agg;
  };
  const all = visit(initial(p));
  const outcomes = [...all].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { outcomes, schedules: outcomes.reduce((s, o) => s + o.count, 0) };
}

// =====================================================================================
// NUMA: one access, data flows, and page placement
// =====================================================================================

export const CORES_PER_SOCKET = 16;

/** Where thread t runs: threads go round-robin over sockets, then fill cores in order. */
export const threadSlot = (t: number, sockets: number) => ({ socket: socketOf(t, sockets), core: Math.floor(t / sockets) });

export interface AccessPath { local: boolean; linkHops: number; latency: number; gbps: number; bottleneck: string; path: string[] }

/**
 * One core (or `streams` cores of the same socket) reading memory on `node`.
 * The sockets are fully connected, so a remote access crosses exactly one socket-to-socket link.
 */
export function accessPath(from: number, node: number, streams = 1, d = NUMA_DEFAULTS): AccessPath {
  const local = from === node;
  const limits: [number, string][] = [[streams * d.coreBW, "cores"], [d.memBW, "memory controller"]];
  if (!local) limits.push([d.linkBW, "interconnect link"]);
  const [gbps, bottleneck] = limits.reduce((a, b) => (b[0] < a[0] ? b : a));
  const path = local
    ? [`core on socket ${from}`, `memory controller ${node}`, `memory node ${node}`]
    : [`core on socket ${from}`, `link ${from}–${node}`, `memory controller ${node}`, `memory node ${node}`];
  return { local, linkHops: local ? 0 : 1, latency: local ? d.latLocal : d.latRemote, gbps, bottleneck, path };
}

export interface NumaFlows {
  res: NumaResult;
  /** Fraction of the wanted bandwidth that each thread gets. */
  scale: number;
  threads: { t: number; socket: number; core: number; gbps: number; fromNode: number[] }[];
  /** Directed data flow from memory node `from` to socket `to`. */
  links: { from: number; to: number; gbps: number; util: number }[];
  nodes: { gbps: number; util: number }[];
}

/** The flows behind simulateNuma: how much data each thread pulls from each node, over which link. */
export function numaFlows(cfg: NumaConfig): NumaFlows {
  const res = simulateNuma(cfg);
  const { sockets: s, threads: n } = cfg;
  const scale = n ? res.gbps / (n * cfg.coreBW) : 0;
  const frac = (t: number, j: number) =>
    cfg.placement === "serial-first-touch" ? (j === 0 ? 1 : 0) : cfg.placement === "parallel-first-touch" ? (j === socketOf(t, s) ? 1 : 0) : 1 / s;
  const threads = Array.from({ length: n }, (_, t) => {
    const fromNode = Array.from({ length: s }, (_, j) => cfg.coreBW * scale * frac(t, j));
    return { t, ...threadSlot(t, s), gbps: cfg.coreBW * scale, fromNode };
  });
  const links: NumaFlows["links"] = [];
  for (let j = 0; j < s; j++)
    for (let i = 0; i < s; i++) {
      if (i === j) continue;
      const g = threads.filter((x) => x.socket === i).reduce((a, x) => a + x.fromNode[j]!, 0);
      links.push({ from: j, to: i, gbps: g, util: g / cfg.linkBW });
    }
  const nodes = res.nodeLoad.map((g) => ({ gbps: g, util: g / cfg.memBW }));
  return { res, scale, threads, links, nodes };
}

export interface PageMap { pages: number[]; owner: number[]; remote: boolean[]; remoteFraction: number }

/**
 * Pages of one array: thread t later uses pages [t·k, (t+1)·k). Each page goes to a node by the
 * placement policy: first touch by one thread (node 0), first touch by the thread that uses it,
 * or round-robin interleaving.
 */
export function pageMap(sockets: number, threads: number, placement: Placement, pagesPerThread = 8): PageMap {
  const total = threads * pagesPerThread;
  const owner = Array.from({ length: total }, (_, p) => Math.floor(p / pagesPerThread));
  const pages = owner.map((t, p) => (placement === "serial-first-touch" ? 0 : placement === "parallel-first-touch" ? socketOf(t, sockets) : p % sockets));
  const remote = pages.map((node, p) => node !== socketOf(owner[p]!, sockets));
  return { pages, owner, remote, remoteFraction: total ? remote.filter(Boolean).length / total : 0 };
}

export const PLACEMENT_LABEL: Record<Placement, string> = {
  "serial-first-touch": "One thread initializes",
  "parallel-first-touch": "Each thread initializes its part",
  interleave: "Interleave pages",
};

export type { Placement, Protocol, St, Mode };
