/**
 * Technology mapping to K-input lookup tables (LUTs), the step that turns gates into FPGA logic.
 *
 * A K-feasible cut of a gate is a set of at most K nodes such that every path from an input to the gate passes
 * through the set. The gate's function of the cut nodes then fits in one K-LUT. The mapper:
 * 1. enumerates cuts bottom-up: the cuts of a gate are the merges of one cut from each fanin, plus the gate alone;
 *    it keeps the best few per gate (the "priority cuts" idea of Mishchenko et al., ICCAD 2007);
 * 2. labels each gate with its best depth: 1 + the largest label among the leaves of its best cut (inputs are 0).
 *    With all cuts kept, this is the depth-optimal labelling that FlowMap (Cong and Ding, 1994) computes;
 * 3. recovers area: it covers the netlist from the outputs in reverse topological order. Each needed gate becomes one
 *    LUT over the cut with the smallest "area flow" (the LUT count of its cone, with shared leaves split among their
 *    users) among the cuts that still meet the gate's required level. So the LUT depth stays optimal for the kept
 *    cuts, and the LUT count drops. Area flow is a heuristic: the count is small, not proven minimal.
 *    The priority-cuts paper follows area flow with an exact local area pass; this mapper stops after area flow.
 */
import { evalNet, type Netlist } from "./netlist";

export const MAX_CUTS = 10;

export interface Lut {
  /** The gate whose value the LUT computes. */
  root: number;
  /** The LUT inputs: primary inputs or roots of other LUTs. */
  leaves: number[];
  /** The gates inside the LUT (its cone). */
  cone: number[];
  /** Levels of LUTs from the inputs to this one. */
  level: number;
}

export interface Mapping {
  k: number;
  luts: Lut[];
  /** Levels of LUTs on the longest path. */
  depth: number;
  /** For each gate, the index of the LUT whose cone holds it (-1 if none). */
  owner: Int32Array;
}

export function mapLuts(net: Netlist, k: number): Mapping {
  const live = net.live();
  const isLeaf = (id: number) => net.gates[id]!.op === "in";
  const cuts = new Map<number, number[][]>();
  const label = new Map<number, number>();
  const best = new Map<number, number[]>();
  const depthOf = (cut: number[]) => 1 + Math.max(0, ...cut.map((x) => label.get(x) ?? 0));
  for (const id of live) {
    if (isLeaf(id)) { cuts.set(id, [[id]]); label.set(id, 0); continue; }
    const fan = net.fanins(id).filter((f) => f > 1); // constants are free
    let acc: number[][] = [[]];
    for (const f of fan) {
      const next: number[][] = [];
      for (const a of acc) for (const c of cuts.get(f) ?? [[f]]) {
        const m = [...new Set([...a, ...c])].sort((x, y) => x - y);
        if (m.length <= k) next.push(m);
      }
      const seen = new Set<string>();
      acc = next.filter((c) => { const key = c.join(","); if (seen.has(key)) return false; seen.add(key); return true; });
      acc = prune(acc, depthOf).slice(0, MAX_CUTS * 4);
    }
    const ranked = prune(acc, depthOf).slice(0, MAX_CUTS);
    const b = ranked[0] ?? [];
    best.set(id, b);
    label.set(id, depthOf(b));
    cuts.set(id, [...ranked, [id]]);
  }
  // area flow: the LUTs a gate costs, with a shared leaf's cost split among its users
  const fanout = new Map<number, number>();
  for (const id of live) for (const f of net.fanins(id)) fanout.set(f, (fanout.get(f) ?? 0) + 1);
  for (const o of net.outputs) fanout.set(o.node, (fanout.get(o.node) ?? 0) + 1);
  const af = new Map<number, number>();
  const flowOf = (cut: number[]) => 1 + cut.reduce((t, l) => t + (af.get(l) ?? 0) / Math.max(1, fanout.get(l) ?? 1), 0);
  for (const id of live) if (!isLeaf(id)) af.set(id, Math.min(...(cuts.get(id) ?? []).filter((c) => !(c.length === 1 && c[0] === id)).map(flowOf)));
  // cover from the outputs, in reverse topological order: each needed gate takes the cut with the smallest area flow
  // among those that still meet its required level, so the depth stays optimal
  const D = Math.max(0, ...net.outputs.map((o) => label.get(o.node) ?? 0));
  const req = new Map<number, number>();
  const needSet = new Set<number>();
  for (const o of net.outputs) if (o.node > 1 && !isLeaf(o.node)) { needSet.add(o.node); req.set(o.node, D); }
  const needed: number[] = [];
  for (let id = net.gates.length - 1; id > 1; id--) {
    if (!needSet.has(id)) continue;
    needed.push(id);
    const r = req.get(id)!;
    const options = (cuts.get(id) ?? []).filter((c) => !(c.length === 1 && c[0] === id) && depthOf(c) <= r);
    const pick = options.length ? options.reduce((b, c) => (flowOf(c) < flowOf(b) - 1e-9 ? c : b)) : best.get(id)!;
    best.set(id, pick);
    for (const l of pick) if (!isLeaf(l)) { needSet.add(l); req.set(l, Math.min(req.get(l) ?? Infinity, r - 1)); }
  }
  needed.sort((a, b) => a - b);
  const owner = new Int32Array(net.gates.length).fill(-1);
  const luts: Lut[] = needed.map((root, i) => {
    const leaves = best.get(root)!;
    const cone: number[] = [];
    const st = [root], inCut = new Set(leaves), seen = new Set<number>();
    while (st.length) {
      const x = st.pop()!;
      if (seen.has(x) || inCut.has(x) || x <= 1) continue;
      seen.add(x); cone.push(x);
      st.push(...net.fanins(x));
    }
    cone.sort((a, b) => a - b);
    for (const g of cone) if (owner[g] === -1) owner[g] = i;
    return { root, leaves, cone, level: 0 };
  });
  // the real level of each LUT under the chosen cuts (roots are in topological order)
  const lvl = new Map<number, number>();
  for (const l of luts) { l.level = 1 + Math.max(0, ...l.leaves.map((x) => lvl.get(x) ?? 0)); lvl.set(l.root, l.level); }
  return { k, luts, depth: Math.max(0, ...net.outputs.map((o) => lvl.get(o.node) ?? 0)), owner };
}

function prune(cs: number[][], depthOf: (c: number[]) => number): number[][] {
  return cs.map((c) => ({ c, d: depthOf(c) })).sort((a, b) => a.d - b.d || a.c.length - b.c.length).map((x) => x.c);
}

/** The truth table of a LUT: bit i is the output when leaf j has the value of bit j of i. */
export function lutTable(net: Netlist, lut: Lut): number[] {
  const out: number[] = [];
  for (let i = 0; i < 1 << lut.leaves.length; i++) {
    // force the leaves, then evaluate the cone
    const v = evalNet(net, () => 0);
    lut.leaves.forEach((l, j) => { v[l] = (i >> j) & 1; });
    for (const g of lut.cone) {
      const x = net.gates[g]!;
      v[g] = x.op === "not" ? v[x.a]! ^ 1 : x.op === "and" ? v[x.a]! & v[x.b]! : x.op === "or" ? v[x.a]! | v[x.b]! : x.op === "xor" ? v[x.a]! ^ v[x.b]! : x.op === "mux" ? (v[x.a]! ? v[x.b]! : v[x.c]!) : v[g]!;
    }
    out.push(v[lut.root]!);
  }
  return out;
}

/** Evaluate a mapped design LUT by LUT, using the LUT truth tables only. Returns the value of every LUT root and input. */
export function evalMapped(net: Netlist, m: Mapping, tables: number[][], input: (name: string) => number): Map<number, number> {
  const val = new Map<number, number>([[0, 0], [1, 1]]);
  for (const id of net.inputs) val.set(id, input(net.gates[id]!.name) & 1);
  m.luts.forEach((l, i) => {
    let idx = 0;
    l.leaves.forEach((x, j) => { idx |= (val.get(x) ?? 0) << j; });
    val.set(l.root, tables[i]![idx]!);
  });
  return val;
}
