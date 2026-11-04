/**
 * Join ordering on a query graph.
 *
 * Relations are bits 0..n-1; a set of relations is a bitmask. The cardinality of a set is the
 * product of its base cardinalities and of the selectivities of the edges inside it (the
 * independence assumption), and at least 1 row, as PostgreSQL's clamp_row_est(). The cost of a
 * plan is C_out: the sum of the sizes of all join results it produces (Cluet & Moerkotte 1995; used by Leis et al. 2015). C_out obeys the principle of
 * optimality, so dynamic programming over subsets finds the true optimum.
 *
 * - makeGraph(): chain, star, cycle or clique, with seeded cardinalities and selectivities
 * - dpBushy() / dpLeftDeep(): Selinger-style DP over subsets, with a step-by-step trace
 * - dpWorst(): the same DP, maximizing (the worst plan)
 * - greedy(): GOO, Greedy Operator Ordering (Fegaras 1998): join the pair with the smallest result
 * - randomLeftDeep(): best of k random left-deep orders (a stand-in for randomized search)
 * - enumerateTrees(): every bushy tree, for brute-force checks on small graphs
 * - leftDeepCount / bushyCount / ccpCount: the size of the search space
 */
import { mulberry32 } from "../../rng";

export type Shape = "chain" | "star" | "cycle" | "clique";
export const SHAPES: Shape[] = ["chain", "star", "cycle", "clique"];

export interface Edge { a: number; b: number; sel: number }
export interface JoinGraph { n: number; names: string[]; rows: number[]; edges: Edge[]; shape: Shape }

export type Plan = { mask: number; card: number; cost: number; left?: Plan; right?: Plan; rel?: number };

export const popcount = (m: number) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
export const bitsOf = (m: number) => { const out: number[] = []; for (let i = 0; m >> i; i++) if ((m >> i) & 1) out.push(i); return out; };

/** A seeded query graph. Cardinalities are log-uniform in 10..10^6; a join of tables A and B keeps about |A||B| / max(|A|, |B|) rows, times a filter factor. */
export function makeGraph(shape: Shape, n: number, seed = 1): JoinGraph {
  const rng = mulberry32(seed * 7919 + n * 31 + SHAPES.indexOf(shape));
  const names = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  const rows = names.map((_, i) => (shape === "star" && i === 0 ? Math.round(10 ** (5.5 + rng() * 1)) : Math.round(10 ** (1 + rng() * 5))));
  const pairs: [number, number][] = [];
  if (shape === "chain" || shape === "cycle") for (let i = 0; i + 1 < n; i++) pairs.push([i, i + 1]);
  if (shape === "cycle" && n > 2) pairs.push([n - 1, 0]);
  if (shape === "star") for (let i = 1; i < n; i++) pairs.push([0, i]);
  if (shape === "clique") for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  const edges = pairs.map(([a, b]) => {
    const f = 10 ** (-2 + rng() * 3.5);
    return { a, b, sel: Math.min(1, f / Math.max(rows[a]!, rows[b]!)) };
  });
  return { n, names, rows, edges, shape };
}

/** Precomputed cardinality and connectivity of every subset. */
export class GraphInfo {
  readonly card: Float64Array;
  readonly adj: number[];
  readonly full: number;
  constructor(readonly g: JoinGraph) {
    const N = 1 << g.n;
    this.full = N - 1;
    this.adj = Array.from({ length: g.n }, () => 0);
    for (const e of g.edges) { this.adj[e.a]! |= 1 << e.b; this.adj[e.b]! |= 1 << e.a; }
    this.card = new Float64Array(N);
    for (let m = 1; m < N; m++) {
      let c = 1;
      for (const i of bitsOf(m)) c *= g.rows[i]!;
      for (const e of g.edges) if ((m >> e.a) & 1 && (m >> e.b) & 1) c *= e.sel;
      this.card[m] = Math.max(1, c); // like clamp_row_est(): never fewer than one row
    }
  }
  neighbors(m: number) { let r = 0; for (const i of bitsOf(m)) r |= this.adj[i]!; return r & ~m; }
  connected(m: number) {
    if (m === 0) return false;
    let seen = m & -m, frontier = seen;
    while (frontier) { const nb = this.neighbors(seen) & m; frontier = nb & ~seen; seen |= nb; }
    return seen === m;
  }
  /** True if some edge joins the two sets. */
  linked(a: number, b: number) { return (this.neighbors(a) & b) !== 0; }
  name(m: number) { return bitsOf(m).map((i) => this.g.names[i]).join(""); }
}

export interface DpOpts { crossProducts?: boolean; leftDeep?: boolean; maximize?: boolean }
export interface DpStep { mask: number; candidates: { left: number; right: number; cost: number }[]; best?: Plan }
export interface DpResult { best: Plan; table: Map<number, Plan>; trace: DpStep[]; pairsConsidered: number }

const leaf = (gi: GraphInfo, i: number): Plan => ({ mask: 1 << i, card: gi.g.rows[i]!, cost: 0, rel: i });

/** DP over subsets in order of size (DPsize/DPsub). Considers each unordered split once: C_out is symmetric. */
export function dp(g: JoinGraph, o: DpOpts = {}): DpResult {
  const gi = new GraphInfo(g);
  const table = new Map<number, Plan>();
  const trace: DpStep[] = [];
  for (let i = 0; i < g.n; i++) table.set(1 << i, leaf(gi, i));
  const bySize: number[][] = Array.from({ length: g.n + 1 }, () => []);
  for (let m = 1; m <= gi.full; m++) bySize[popcount(m)]!.push(m);
  let pairs = 0;
  const better = (a: number, b: number) => (o.maximize ? a > b : a < b);
  for (let size = 2; size <= g.n; size++) {
    for (const m of bySize[size]!) {
      if (!o.crossProducts && !gi.connected(m)) continue;
      const step: DpStep = { mask: m, candidates: [] };
      let best: Plan | undefined;
      // Enumerate splits m = s ∪ (m \ s).
      for (let s = (m - 1) & m; s > 0; s = (s - 1) & m) {
        const r = m ^ s;
        if (o.leftDeep) { if (popcount(r) !== 1) continue; }
        else if (s < r) continue; // each unordered pair once
        const L = table.get(s), R = table.get(r);
        if (!L || !R) continue;
        if (!o.crossProducts && !gi.linked(s, r)) continue;
        pairs++;
        const cost = L.cost + R.cost + gi.card[m]!;
        step.candidates.push({ left: s, right: r, cost });
        if (!best || better(cost, best.cost)) {
          const [a, b] = !o.leftDeep && R.card > L.card ? [R, L] : [L, R]; // larger input on the left (probe side)
          best = { mask: m, card: gi.card[m]!, cost, left: a, right: b };
        }
      }
      if (best) { table.set(m, best); step.best = best; trace.push(step); }
    }
  }
  const best = table.get(gi.full);
  if (!best) throw new Error("graph is not connected and cross products are off");
  return { best, table, trace, pairsConsidered: pairs };
}

export const dpBushy = (g: JoinGraph, crossProducts = false) => dp(g, { crossProducts });
export const dpLeftDeep = (g: JoinGraph, crossProducts = false) => dp(g, { crossProducts, leftDeep: true });
export const dpWorst = (g: JoinGraph, crossProducts = false) => dp(g, { crossProducts, maximize: true });

/** GOO: start with one tree per relation; repeatedly join the two linked trees whose result is smallest. */
export function greedy(g: JoinGraph, crossProducts = false): Plan {
  const gi = new GraphInfo(g);
  let trees: Plan[] = Array.from({ length: g.n }, (_, i) => leaf(gi, i));
  while (trees.length > 1) {
    let bi = -1, bj = -1, bc = Infinity;
    for (let pass = 0; pass < 2 && bi < 0; pass++) {
      for (let i = 0; i < trees.length; i++) for (let j = i + 1; j < trees.length; j++) {
        const a = trees[i]!, b = trees[j]!;
        if (pass === 0 && !crossProducts && !gi.linked(a.mask, b.mask)) continue;
        const c = gi.card[a.mask | b.mask]!;
        if (c < bc) { bc = c; bi = i; bj = j; }
      }
    }
    const a = trees[bi]!, b = trees[bj]!;
    const m = a.mask | b.mask;
    const big = a.card >= b.card ? a : b, small = big === a ? b : a;
    const t: Plan = { mask: m, card: gi.card[m]!, cost: a.cost + b.cost + gi.card[m]!, left: big, right: small };
    trees = trees.filter((_, k) => k !== bi && k !== bj).concat([t]);
  }
  return trees[0]!;
}

/** Left-deep plan for a given order of relations. */
export function leftDeepPlan(g: JoinGraph, order: number[]): Plan {
  const gi = new GraphInfo(g);
  let p = leaf(gi, order[0]!);
  for (const r of order.slice(1)) {
    const m = p.mask | (1 << r);
    p = { mask: m, card: gi.card[m]!, cost: p.cost + gi.card[m]!, left: p, right: leaf(gi, r) };
  }
  return p;
}

/** Best of k random left-deep orders that avoid cross products (each next relation is a neighbor). */
export function randomLeftDeep(g: JoinGraph, k: number, seed = 1): Plan {
  const gi = new GraphInfo(g);
  const rng = mulberry32(seed);
  let best: Plan | undefined;
  for (let t = 0; t < k; t++) {
    const order = [Math.floor(rng() * g.n)];
    let m = 1 << order[0]!;
    while (order.length < g.n) {
      let cand = bitsOf(gi.neighbors(m));
      if (cand.length === 0) cand = bitsOf(gi.full & ~m);
      const r = cand[Math.floor(rng() * cand.length)]!;
      order.push(r); m |= 1 << r;
    }
    const p = leftDeepPlan(g, order);
    if (!best || p.cost < best.cost) best = p;
  }
  return best!;
}

/** Every unordered bushy tree over the full set (cross products allowed or not). Small n only. */
export function enumerateTrees(g: JoinGraph, crossProducts = true): Plan[] {
  const gi = new GraphInfo(g);
  const memo = new Map<number, Plan[]>();
  const go = (m: number): Plan[] => {
    const hit = memo.get(m);
    if (hit) return hit;
    let out: Plan[] = [];
    if (popcount(m) === 1) out = [leaf(gi, Math.log2(m))];
    else for (let s = (m - 1) & m; s > 0; s = (s - 1) & m) {
      const r = m ^ s;
      if (s < r) continue;
      if (!crossProducts && !gi.linked(s, r)) continue;
      for (const L of go(s)) for (const R of go(r)) out.push({ mask: m, card: gi.card[m]!, cost: L.cost + R.cost + gi.card[m]!, left: L, right: R });
    }
    memo.set(m, out);
    return out;
  };
  return go(gi.full);
}

/** Every ordered left-deep tree (permutations), optionally without cross products. */
export function enumerateLeftDeep(g: JoinGraph, crossProducts = true): Plan[] {
  const gi = new GraphInfo(g);
  const out: Plan[] = [];
  const rec = (order: number[], m: number) => {
    if (order.length === g.n) { out.push(leftDeepPlan(g, order)); return; }
    for (let r = 0; r < g.n; r++) {
      if ((m >> r) & 1) continue;
      if (order.length > 0 && !crossProducts && !gi.linked(m, 1 << r)) continue;
      rec([...order, r], m | (1 << r));
    }
  };
  rec([], 0);
  return out;
}

/** Plan as text: ((A ⋈ B) ⋈ C). */
export function planString(g: JoinGraph, p: Plan): string {
  if (p.rel !== undefined) return g.names[p.rel]!;
  return `(${planString(g, p.left!)} ⋈ ${planString(g, p.right!)})`;
}
/** True if every join has a base relation on at least one side (a left-deep tree, up to swapping children). */
export function isLeftDeep(p: Plan): boolean {
  if (p.rel !== undefined) return true;
  if (p.right!.rel !== undefined && isLeftDeep(p.left!)) return true;
  return p.left!.rel !== undefined && isLeftDeep(p.right!);
}

// ---------------------------------------------------------------------------------------
// Search space size
// ---------------------------------------------------------------------------------------

export function factorial(n: number): number { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
export function catalan(n: number): number { let c = 1; for (let k = 0; k < n; k++) c = (c * 2 * (2 * k + 1)) / (k + 2); return Math.round(c); }
/** Left-deep trees with cross products: n!. */
export const leftDeepCount = (n: number) => factorial(n);
/** Bushy trees with cross products, children ordered: Catalan(n − 1) × n! = (2n − 2)! / (n − 1)!. */
export const bushyCount = (n: number) => catalan(n - 1) * factorial(n);
/** Number of (connected subgraph, connected complement) pairs, the work DPccp does (Moerkotte & Neumann 2006). */
export function ccpCount(shape: "chain" | "star" | "clique", n: number): number {
  if (shape === "chain") return (n ** 3 - n) / 6;
  if (shape === "star") return (n - 1) * 2 ** (n - 2);
  return (3 ** n - 2 ** (n + 1) + 1) / 2;
}
/** Counts csg-cmp pairs on a concrete graph by brute force (unordered pairs). */
export function countCcp(g: JoinGraph): number {
  const gi = new GraphInfo(g);
  let k = 0;
  for (let m = 1; m <= gi.full; m++) {
    if (!gi.connected(m)) continue;
    for (let s = (m - 1) & m; s > 0; s = (s - 1) & m) {
      const r = m ^ s;
      if (s < r) continue;
      if (gi.connected(s) && gi.connected(r) && gi.linked(s, r)) k++;
    }
  }
  return k;
}

/** Strategy comparison for the demo. */
export type Strategy = "bushy" | "leftdeep" | "greedy" | "random" | "worst";
export const STRATEGY_LABEL: Record<Strategy, string> = { bushy: "DP, bushy (optimum)", leftdeep: "DP, left-deep only", greedy: "Greedy (GOO)", random: "Best of 10 random left-deep", worst: "Worst plan" };
export function compareStrategies(g: JoinGraph, crossProducts = false) {
  const res: Record<Strategy, Plan> = {
    bushy: dpBushy(g, crossProducts).best,
    leftdeep: dpLeftDeep(g, crossProducts).best,
    greedy: greedy(g, crossProducts),
    random: randomLeftDeep(g, 10, 1),
    worst: dpWorst(g, crossProducts).best,
  };
  return res;
}

/**
 * A chain where bushy beats every left-deep plan: two small dimension tables (A, D) each filter a
 * large table (B, C), and B ⋈ C is many-to-many. Joining A ⋈ B and C ⋈ D first keeps both sides tiny.
 */
export function bushyExample(): JoinGraph {
  return {
    n: 4, names: ["A", "B", "C", "D"], rows: [10, 1e6, 1e6, 10], shape: "chain",
    edges: [{ a: 0, b: 1, sel: 1e-6 }, { a: 1, b: 2, sel: 1e-4 }, { a: 2, b: 3, sel: 1e-6 }],
  };
}
