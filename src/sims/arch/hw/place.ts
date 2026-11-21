/**
 * A toy placer and timing model for an FPGA: where the LUTs sit decides how long the wires are, and the wires add
 * delay. It follows the shape of the classic simulated-annealing placer of VPR (Betz and Rose, 1997), much reduced.
 *
 * - The device is a G × G grid of LUT sites. Input pads sit on the left edge and output pads on the right edge.
 * - A net is one driver (an input pad or a LUT) and its sinks. Its cost is the half-perimeter of the bounding box of
 *   its pins (HPWL), the usual estimate of the wire that routing will need.
 * - Annealing: swap the contents of two sites (one may be empty). Accept a swap that lowers the total cost; accept a
 *   worse one with probability exp(-Δ / T). T starts at 20 times the standard deviation of Δ over 40 random swaps (VPR uses 20 times the standard deviation
 *   of the cost over N random swaps), is multiplied by 0.8
 *   every round, and the last 3 rounds accept only swaps that do not make the cost worse.
 *   The random choices come from a seeded generator, so a run is the same every time.
 * - Timing: arrival(LUT) = max over its inputs of (arrival(driver) + wire) + LUT delay. MODEL INPUTS: a LUT delay of
 *   1 unit, and a wire delay of 0.3 + 0.25 per grid step of Manhattan distance (a switch and a segment per step). They
 *   are not the numbers of a real device.
 */
import { mulberry32 } from "../../rng";
import type { Mapping } from "./lut";
import type { Netlist } from "./netlist";

export const LUT_DELAY = 1;
export const WIRE_BASE = 0.3;
export const WIRE_PER_STEP = 0.25;
export const wireDelay = (dist: number) => WIRE_BASE + WIRE_PER_STEP * dist;

export interface Pin { x: number; y: number }

export interface PlaceProblem {
  grid: number;
  /** Number of LUTs; LUT i is node i. Input pads are nodes nLuts..nLuts+nIn-1, output pads follow. */
  nLuts: number;
  inPads: Pin[];
  outPads: Pin[];
  /** A connection from a driver node to a sink node (sinks are LUTs or output pads). */
  edges: { from: number; to: number }[];
  /** Nets: a driver and its sinks. */
  nets: { driver: number; sinks: number[] }[];
  /** LUT nodes in topological order. */
  order: number[];
  names: string[];
}

export function placeProblem(net: Netlist, m: Mapping): PlaceProblem {
  const rootIdx = new Map(m.luts.map((l, i) => [l.root, i] as const));
  const usedInputs = [...new Set(m.luts.flatMap((l) => l.leaves).filter((x) => net.gates[x]!.op === "in"))].sort((a, b) => a - b);
  const outs = net.outputs.filter((o) => rootIdx.has(o.node));
  const nL = m.luts.length;
  const grid = Math.max(3, Math.ceil(Math.sqrt(nL * 1.4)));
  const inIdx = new Map(usedInputs.map((g, i) => [g, nL + i] as const));
  const spread = (k: number, n: number) => (n <= 1 ? (grid - 1) / 2 : (k * (grid - 1)) / (n - 1));
  const inPads = usedInputs.map((_, i) => ({ x: -1, y: spread(i, usedInputs.length) }));
  const outPads = outs.map((_, i) => ({ x: grid, y: spread(i, outs.length) }));
  const edges: { from: number; to: number }[] = [];
  m.luts.forEach((l, i) => {
    for (const leaf of l.leaves) {
      const from = rootIdx.get(leaf) ?? inIdx.get(leaf);
      if (from !== undefined) edges.push({ from, to: i });
    }
  });
  outs.forEach((o, j) => edges.push({ from: rootIdx.get(o.node)!, to: nL + usedInputs.length + j }));
  const byDriver = new Map<number, number[]>();
  for (const e of edges) byDriver.set(e.from, [...(byDriver.get(e.from) ?? []), e.to]);
  const nets = [...byDriver].map(([driver, sinks]) => ({ driver, sinks }));
  const order = m.luts.map((_, i) => i); // LUTs are sorted by root id, which is topological
  const names = [...m.luts.map((_, i) => `LUT ${i}`), ...usedInputs.map((g) => net.gates[g]!.name), ...outs.map((o) => o.name)];
  return { grid, nLuts: nL, inPads, outPads, edges, nets, order, names };
}

/** pos[i] = site index (y * grid + x) of LUT i. */
export type Placement = number[];

export function pinOf(p: PlaceProblem, pos: Placement, node: number): Pin {
  if (node < p.nLuts) { const s = pos[node]!; return { x: s % p.grid, y: Math.floor(s / p.grid) }; }
  const k = node - p.nLuts;
  return k < p.inPads.length ? p.inPads[k]! : p.outPads[k - p.inPads.length]!;
}

export function hpwl(p: PlaceProblem, pos: Placement): number {
  let t = 0;
  for (const n of p.nets) t += netCost(p, pos, n);
  return t;
}
function netCost(p: PlaceProblem, pos: Placement, n: { driver: number; sinks: number[] }) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const node of [n.driver, ...n.sinks]) {
    const q = pinOf(p, pos, node);
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  return x1 - x0 + (y1 - y0);
}

export interface Sta {
  /** The critical path delay. */
  delay: number;
  /** Of that, the part spent in wires. */
  wire: number;
  /** Edges (indexes into p.edges) on the critical path. */
  path: number[];
}

export function sta(p: PlaceProblem, pos: Placement): Sta {
  const n = p.nLuts + p.inPads.length + p.outPads.length;
  const arr = new Array<number>(n).fill(0), wireArr = new Array<number>(n).fill(0), via = new Array<number>(n).fill(-1);
  const inEdges = new Map<number, number[]>();
  p.edges.forEach((e, i) => inEdges.set(e.to, [...(inEdges.get(e.to) ?? []), i]));
  const visit = (node: number, own: number) => {
    let best = -Infinity, bw = 0, be = -1;
    for (const ei of inEdges.get(node) ?? []) {
      const e = p.edges[ei]!;
      const a = pinOf(p, pos, e.from), b = pinOf(p, pos, node);
      const w = wireDelay(Math.abs(a.x - b.x) + Math.abs(a.y - b.y));
      if (arr[e.from]! + w > best) { best = arr[e.from]! + w; bw = wireArr[e.from]! + w; be = ei; }
    }
    arr[node] = (be < 0 ? 0 : best) + own; wireArr[node] = bw; via[node] = be;
  };
  for (const i of p.order) visit(i, LUT_DELAY);
  let end = -1;
  for (let j = 0; j < p.outPads.length; j++) {
    const node = p.nLuts + p.inPads.length + j;
    visit(node, 0);
    if (end < 0 || arr[node]! > arr[end]!) end = node;
  }
  const path: number[] = [];
  for (let x = end; x >= 0 && via[x]! >= 0; x = p.edges[via[x]!]!.from) path.unshift(via[x]!);
  return { delay: end < 0 ? 0 : arr[end]!, wire: end < 0 ? 0 : wireArr[end]!, path };
}

/** A random legal placement. */
export function randomPlacement(p: PlaceProblem, seed: number): Placement {
  const r = mulberry32(seed);
  const sites = Array.from({ length: p.grid * p.grid }, (_, i) => i);
  for (let i = sites.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [sites[i], sites[j]] = [sites[j]!, sites[i]!]; }
  return sites.slice(0, p.nLuts);
}

export interface Frame { pos: Placement; cost: number; sta: Sta; moves: number; temp: number }

/** Anneal from a random placement. Returns `rounds + 1` frames: the start and the state after each round. */
export function anneal(p: PlaceProblem, { seed = 1, rounds = 30, movesPerRound = 0 }: { seed?: number; rounds?: number; movesPerRound?: number } = {}): Frame[] {
  const r = mulberry32(seed ^ 0x9e3779b9);
  let pos = randomPlacement(p, seed);
  const per = movesPerRound || Math.max(50, 10 * p.nLuts);
  const S = p.grid * p.grid;
  const at = new Int32Array(S).fill(-1);
  pos.forEach((s, i) => { at[s] = i; });
  const netsOf: number[][] = Array.from({ length: p.nLuts }, () => []);
  p.nets.forEach((n, k) => { for (const node of [n.driver, ...n.sinks]) if (node < p.nLuts) netsOf[node]!.push(k); });
  let cost = hpwl(p, pos);
  const frames: Frame[] = [{ pos: pos.slice(), cost, sta: sta(p, pos), moves: 0, temp: 0 }];
  // starting temperature: 20 times the standard deviation of random swap deltas (after VPR's rule)
  const trial: number[] = [];
  const delta = (a: number, b: number) => {
    const la = at[a]!, lb = at[b]!;
    const touched = new Set<number>([...(la >= 0 ? netsOf[la]! : []), ...(lb >= 0 ? netsOf[lb]! : [])]);
    let before = 0;
    for (const k of touched) before += netCost(p, pos, p.nets[k]!);
    if (la >= 0) pos[la] = b;
    if (lb >= 0) pos[lb] = a;
    let after = 0;
    for (const k of touched) after += netCost(p, pos, p.nets[k]!);
    return { d: after - before, undo: () => { if (la >= 0) pos[la] = a; if (lb >= 0) pos[lb] = b; }, commit: () => { at[a] = lb; at[b] = la; } };
  };
  const pick = () => {
    const i = Math.floor(r() * p.nLuts);
    const a = pos[i]!;
    let b = Math.floor(r() * S);
    if (b === a) b = (b + 1) % S;
    return [a, b] as const;
  };
  for (let i = 0; i < 40; i++) { const [a, b] = pick(); const m = delta(a, b); trial.push(m.d); m.undo(); }
  const mean = trial.reduce((s, x) => s + x, 0) / trial.length;
  let T = 20 * Math.sqrt(trial.reduce((s, x) => s + (x - mean) ** 2, 0) / trial.length) || 1;
  let moves = 0;
  for (let round = 0; round < rounds; round++) {
    for (let k = 0; k < per; k++) {
      const [a, b] = pick();
      const m = delta(a, b);
      if (m.d <= 0 || r() < Math.exp(-m.d / T)) { m.commit(); cost += m.d; } else m.undo();
      moves++;
    }
    frames.push({ pos: pos.slice(), cost, sta: sta(p, pos), moves, temp: T });
    T *= round < rounds - 3 ? 0.8 : 0;
  }
  return frames;
}
