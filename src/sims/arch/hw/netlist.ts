/**
 * Gate-level synthesis of the Verilog subset: the elaborated IR of verilog.ts becomes a netlist of 2-input gates.
 *
 * - Gates: NOT, AND, OR, XOR (2 inputs) and MUX (select, if-1, if-0). Structural hashing shares equal gates, and
 *   constants fold (x & 0 = 0, x ^ x = 0, ...), as a real synthesizer's first clean-up does.
 * - Every `assign` and `always @*` block becomes logic. An `if` becomes a MUX per bit that the branches assign
 *   differently; a `case` becomes a chain of them. A signal that some path does not assign keeps its old value, so its
 *   old value becomes an input named "q (held)": that feedback is the latch that synthesis infers.
 * - A reg written in `always @(posedge clk)` becomes flip-flops: its output is a start point ("q") and the value that
 *   reaches it is an end point ("q.D"). So the paths that timing analysis measures run between inputs, flip-flops and
 *   outputs.
 * - `+` and `-` build either a ripple-carry adder or a Kogge-Stone parallel-prefix adder (Kogge and Stone 1973).
 *   Comparisons use a subtractor's carry; variable shifts build a barrel shifter (one MUX row per shift bit).
 * - Memories are left out of the gate view (a real flow maps them to RAM blocks).
 *
 * Timing (`timing`): the arrival time of each gate is the latest arrival of its inputs plus its own delay. The delays
 * are MODEL INPUTS in units of τ, one simple gate delay: NOT 0.5, AND and OR 1, XOR and MUX 1.5. They are not the
 * numbers of any real cell library. The longest path is the critical path, and it sets the shortest clock period.
 */
import { topoOrder } from "./rtl";
import { elaborate, VerilogError, type Design, type IR, type IStmt, type LV, type VError } from "./verilog";

export type GateOp = "in" | "c0" | "c1" | "not" | "and" | "or" | "xor" | "mux";
export interface Gate { op: GateOp; a: number; b: number; c: number; name: string }

/** MODEL INPUTS: gate delays in units of τ. */
export const GATE_DELAY: Record<GateOp, number> = { in: 0, c0: 0, c1: 0, not: 0.5, and: 1, or: 1, xor: 1.5, mux: 1.5 };

export class Netlist {
  gates: Gate[] = [{ op: "c0", a: -1, b: -1, c: -1, name: "0" }, { op: "c1", a: -1, b: -1, c: -1, name: "1" }];
  private hash = new Map<string, number>();
  outputs: { name: string; node: number }[] = [];
  inputs: number[] = [];

  input(name: string): number {
    this.gates.push({ op: "in", a: -1, b: -1, c: -1, name });
    const id = this.gates.length - 1;
    this.inputs.push(id);
    return id;
  }
  private make(op: GateOp, a: number, b = -1, c = -1): number {
    const key = `${op}:${a}:${b}:${c}`;
    const hit = this.hash.get(key);
    if (hit !== undefined) return hit;
    this.gates.push({ op, a, b, c, name: "" });
    const id = this.gates.length - 1;
    this.hash.set(key, id);
    return id;
  }
  isConst(x: number) { return x === 0 || x === 1; }
  not(a: number): number {
    if (a === 0) return 1;
    if (a === 1) return 0;
    const g = this.gates[a]!;
    if (g.op === "not") return g.a;
    return this.make("not", a);
  }
  and(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    if (a === 1) return b;
    if (b === 1) return a;
    if (a === b) return a;
    if (this.isNotOf(a, b)) return 0;
    return a < b ? this.make("and", a, b) : this.make("and", b, a);
  }
  or(a: number, b: number): number {
    if (a === 1 || b === 1) return 1;
    if (a === 0) return b;
    if (b === 0) return a;
    if (a === b) return a;
    if (this.isNotOf(a, b)) return 1;
    return a < b ? this.make("or", a, b) : this.make("or", b, a);
  }
  xor(a: number, b: number): number {
    if (a === 0) return b;
    if (b === 0) return a;
    if (a === 1) return this.not(b);
    if (b === 1) return this.not(a);
    if (a === b) return 0;
    if (this.isNotOf(a, b)) return 1;
    return a < b ? this.make("xor", a, b) : this.make("xor", b, a);
  }
  mux(s: number, t: number, f: number): number {
    if (s === 1) return t;
    if (s === 0) return f;
    if (t === f) return t;
    if (t === 1 && f === 0) return s;
    if (t === 0 && f === 1) return this.not(s);
    if (f === 0) return this.and(s, t);
    if (t === 1) return this.or(s, f);
    if (t === 0) return this.and(this.not(s), f);
    if (f === 1) return this.or(this.not(s), t);
    return this.make("mux", s, t, f);
  }
  private isNotOf(a: number, b: number) {
    const ga = this.gates[a]!, gb = this.gates[b]!;
    return (ga.op === "not" && ga.a === b) || (gb.op === "not" && gb.a === a);
  }
  fanins(id: number): number[] {
    const g = this.gates[id]!;
    return g.op === "not" ? [g.a] : g.op === "mux" ? [g.a, g.b, g.c] : g.op === "and" || g.op === "or" || g.op === "xor" ? [g.a, g.b] : [];
  }
  /** The gates that some output needs (the live cone), in topological order (ids are already topological). */
  live(): number[] {
    const seen = new Uint8Array(this.gates.length);
    const stack = this.outputs.map((o) => o.node);
    while (stack.length) {
      const x = stack.pop()!;
      if (seen[x]) continue;
      seen[x] = 1;
      stack.push(...this.fanins(x));
    }
    return this.gates.map((_, i) => i).filter((i) => seen[i] && this.gates[i]!.op !== "c0" && this.gates[i]!.op !== "c1");
  }
}

type Bits = number[]; // bit 0 first

export type AdderKind = "ripple" | "prefix";

export interface SynthResult {
  ok: boolean;
  error: VError | null;
  net: Netlist | null;
  /** Signals that became latches. */
  latches: string[];
  flops: number;
  design: Design | null;
}

/** Synthesize the module in `src` to gates. */
export function synthesize(src: string, opts: { adder?: AdderKind } = {}): SynthResult {
  const adder = opts.adder ?? "ripple";
  let d: Design;
  try { d = elaborate(src); } catch (e) {
    if (e instanceof VerilogError) return { ok: false, error: { line: e.line, message: e.message }, net: null, latches: [], flops: 0, design: null };
    throw e;
  }
  try {
    const net = new Netlist();
    const env = new Map<number, Bits>();
    const name = (id: number) => d.signals[id]!.name;
    const vec = (n: string, w: number) => Array.from({ length: w }, (_, i) => net.input(w > 1 ? `${n}[${i}]` : n));
    for (const s of d.signals) {
      if (s.depth) {
        if (d.procs.some((p) => p.readsMem.includes(s.id) || p.writesMem.includes(s.id))) throw new VerilogError(s.line, `${s.name} is a memory: the gate view leaves memories out (a real flow maps them to RAM blocks)`);
        continue;
      }
      if (s.kind === "input" && s !== d.clock) env.set(s.id, vec(s.name, s.width));
    }
    // flip-flop outputs are start points
    const seqWrites = new Set(d.procs.filter((p) => p.kind === "seq").flatMap((p) => p.writes));
    let flops = 0;
    for (const id of seqWrites) { env.set(id, vec(`${name(id)}.Q`, d.signals[id]!.width)); flops += d.signals[id]!.width; }
    const ctx = new Blaster(net, adder, d);
    const comb = d.procs.filter((p) => p.kind !== "seq");
    const order = topoOrder(comb.map((p) => ({ reads: p.reads, writes: p.writes })));
    const latches: string[] = [];
    // a combinational cycle cannot become plain gates
    {
      const pos = new Map(order.map((p, i) => [p, i] as const));
      comb.forEach((p, i) => {
        for (const r of p.reads) for (let j = 0; j < comb.length; j++) {
          if (j !== i && comb[j]!.writes.includes(r) && pos.get(j)! > pos.get(i)!) throw new VerilogError(p.line, `combinational loop through ${name(r)}`);
        }
      });
    }
    for (const pi of order) {
      const p = comb[pi]!;
      // a comb block starts with the old value of what it writes; an unassigned path keeps it (a latch)
      const before = new Map<number, Bits>();
      for (const w of p.writes) {
        if (!env.has(w)) {
          const held = vec(`${name(w)} (held)`, d.signals[w]!.width);
          before.set(w, held);
          env.set(w, held);
        }
      }
      ctx.stmt(p.body, env);
      for (const [w, held] of before) {
        const now = env.get(w)!;
        if (now.some((b, i) => dependsOn(net, b, held[i]!))) latches.push(name(w));
      }
    }
    // clocked blocks: their next-state logic
    for (const p of d.procs.filter((q) => q.kind === "seq")) {
      const local = new Map(env);
      ctx.stmt(p.body, local, true);
      for (const w of p.writes) (local.get(-(w + 1)) ?? local.get(w)!).forEach((b, i, all) => net.outputs.push({ name: `${name(w)}.D${all.length > 1 ? `[${i}]` : ""}`, node: b }));
    }
    for (const s of d.signals) {
      if (s.kind !== "output" || seqWrites.has(s.id)) continue;
      const bits = env.get(s.id);
      if (!bits) throw new VerilogError(s.line, `the output ${s.name} is never driven`);
      bits.forEach((b, i) => net.outputs.push({ name: s.width > 1 ? `${s.name}[${i}]` : s.name, node: b }));
    }
    return { ok: true, error: null, net, latches: [...new Set(latches)], flops, design: d };
  } catch (e) {
    if (e instanceof VerilogError) return { ok: false, error: { line: e.line, message: e.message }, net: null, latches: [], flops: 0, design: d };
    throw e;
  }
}

function dependsOn(net: Netlist, root: number, leaf: number): boolean {
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === leaf) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...net.fanins(x));
  }
  return false;
}

class Blaster {
  constructor(private n: Netlist, private adder: AdderKind, private d: Design) {}

  stmt(s: IStmt, env: Map<number, Bits>, clocked = false): void {
    const n = this.n;
    switch (s.k) {
      case "block": for (const b of s.body) this.stmt(b, env, clocked); return;
      case "if": {
        const c = this.truth(this.expr(s.cond, env));
        const t = new Map(env), f = new Map(env);
        this.stmt(s.then, t, clocked);
        if (s.else) this.stmt(s.else, f, clocked);
        this.merge(env, c, t, f);
        return;
      }
      case "case": {
        const sel = this.expr(s.sel, env);
        // build from the last item up: case = if (match0) body0 else if (match1) ...
        const branches = s.items.map((it) => ({ c: it.labels ? it.labels.map((l) => this.eq(sel, this.expr(l, env))).reduce((a, b) => n.or(a, b), 0) : 1, body: it.body }));
        const run = (i: number, e: Map<number, Bits>): void => {
          if (i >= branches.length) return;
          const br = branches[i]!;
          if (br.c === 1) { this.stmt(br.body, e, clocked); return; }
          const t = new Map(e), f = new Map(e);
          this.stmt(br.body, t, clocked);
          run(i + 1, f);
          this.merge(e, br.c, t, f);
        };
        run(0, env);
        return;
      }
      case "assign": {
        // a nonblocking write in a clocked block reads the old values: env holds them, as the edge does
        const v = this.expr(s.rhs, env);
        this.assignLv(s.lhs, v, env, s.nb && clocked);
        return;
      }
    }
  }

  private merge(env: Map<number, Bits>, c: number, t: Map<number, Bits>, f: Map<number, Bits>) {
    // keys below 0 hold the next state of a nonblocking write (-(id + 1)); a branch that has none keeps the old value
    const get = (m: Map<number, Bits>, k: number) => m.get(k) ?? (k < 0 ? m.get(-k - 1) : undefined);
    for (const k of new Set([...t.keys(), ...f.keys()])) {
      const a = get(t, k), b = get(f, k);
      if (!a || !b) throw new VerilogError(0, `${this.d.signals[k]!.name} is used before it has a value`);
      if (a === b) { env.set(k, a); continue; }
      env.set(k, a.map((x, i) => this.n.mux(c, x, b[i]!)));
    }
  }

  /** A nonblocking write (nb) goes to the next-state key -(id + 1), so later reads in the block still see the old value. */
  private assignLv(lv: LV, v: Bits, env: Map<number, Bits>, nb: boolean) {
    const key = (id: number) => (nb ? -(id + 1) : id);
    const cur = (id: number) => (env.get(key(id)) ?? env.get(id)!);
    switch (lv.k) {
      case "sig": env.set(key(lv.id), v.slice(0, lv.w)); return;
      case "slice": {
        const old = cur(lv.id).slice();
        for (let i = 0; i < lv.w; i++) old[lv.lo + i] = v[i]!;
        env.set(key(lv.id), old); return;
      }
      case "bit": {
        const idx = this.expr(lv.idx, env);
        const old = cur(lv.id);
        env.set(key(lv.id), old.map((b, i) => this.n.mux(this.eq(idx, this.constBits(i + lv.off, idx.length)), v[0]!, b)));
        return;
      }
      case "mem": throw new VerilogError(0, "memories are left out of the gate view");
      case "concat": {
        let at = 0;
        for (let i = lv.parts.length - 1; i >= 0; i--) { const p = lv.parts[i]!; this.assignLv(p, v.slice(at, at + p.w), env, nb); at += p.w; }
      }
    }
  }

  constBits(v: number, w: number): Bits { return Array.from({ length: w }, (_, i) => (Math.floor(v / 2 ** i) % 2 ? 1 : 0)); }
  truth(b: Bits): number { return b.reduce((a, x) => this.n.or(a, x), 0); }
  eq(a: Bits, b: Bits): number {
    const w = Math.max(a.length, b.length);
    let r = 1;
    for (let i = 0; i < w; i++) r = this.n.and(r, this.n.not(this.n.xor(a[i] ?? 0, b[i] ?? 0)));
    return r;
  }

  /** a + b + cin, w bits, and the carry out. */
  add(a: Bits, b: Bits, cin: number): { sum: Bits; cout: number } {
    const n = this.n, w = a.length;
    if (this.adder === "ripple") {
      const sum: Bits = [];
      let c = cin;
      for (let i = 0; i < w; i++) {
        const p = n.xor(a[i]!, b[i]!);
        sum.push(n.xor(p, c));
        c = n.or(n.and(a[i]!, b[i]!), n.and(p, c));
      }
      return { sum, cout: c };
    }
    // Kogge-Stone: (G, P) prefix over spans that double in each level
    const p = a.map((x, i) => n.xor(x, b[i]!));
    let G = a.map((x, i) => n.and(x, b[i]!));
    let P = p.slice();
    G[0] = n.or(G[0]!, n.and(P[0]!, cin)); // fold the carry in
    for (let d = 1; d < w; d *= 2) {
      const G2 = G.slice(), P2 = P.slice();
      for (let i = d; i < w; i++) {
        G2[i] = n.or(G[i]!, n.and(P[i]!, G[i - d]!));
        P2[i] = n.and(P[i]!, P[i - d]!);
      }
      G = G2; P = P2;
    }
    const sum = p.map((x, i) => n.xor(x, i === 0 ? cin : G[i - 1]!));
    return { sum, cout: G[w - 1]! };
  }

  expr(e: IR, env: Map<number, Bits>): Bits {
    const n = this.n;
    switch (e.k) {
      case "const": return this.constBits(e.v, e.w);
      case "sig": {
        const b = env.get(e.id);
        if (!b) throw new VerilogError(0, `${this.d.signals[e.id]!.name} is read before it has a value`);
        return b;
      }
      case "resize": {
        const a = this.expr(e.a, env);
        if (e.w <= a.length) return a.slice(0, e.w);
        const fill = e.sx ? a[a.length - 1]! : 0;
        return [...a, ...Array.from({ length: e.w - a.length }, () => fill)];
      }
      case "bin": {
        const a = this.expr(e.a, env), b = this.expr(e.b, env);
        if (e.op === "+") return this.add(a, b, 0).sum;
        if (e.op === "-") return this.add(a, b.map((x) => n.not(x)), 1).sum;
        const f = e.op === "&" ? n.and.bind(n) : e.op === "|" ? n.or.bind(n) : n.xor.bind(n);
        return a.map((x, i) => f(x, b[i]!));
      }
      case "not": return this.expr(e.a, env).map((x) => n.not(x));
      case "neg": { const a = this.expr(e.a, env); return this.add(a.map(() => 0), a.map((x) => n.not(x)), 1).sum; }
      case "cmp": {
        const a = this.expr(e.a, env), b = this.expr(e.b, env);
        if (e.op === "==") return [this.eq(a, b)];
        if (e.op === "!=") return [n.not(this.eq(a, b))];
        // x < y  <=>  no carry out of x + ~y + 1 (unsigned); flip the sign bits for a signed compare
        const flip = (v: Bits) => (e.signed ? [...v.slice(0, -1), n.not(v[v.length - 1]!)] : v);
        const lt = (x: Bits, y: Bits) => n.not(this.add(flip(x), flip(y).map((q) => n.not(q)), 1).cout);
        if (e.op === "<") return [lt(a, b)];
        if (e.op === ">") return [lt(b, a)];
        if (e.op === "<=") return [n.not(lt(b, a))];
        return [n.not(lt(a, b))];
      }
      case "logic": {
        const a = this.truth(this.expr(e.a, env)), b = this.truth(this.expr(e.b, env));
        return [e.op === "&&" ? n.and(a, b) : n.or(a, b)];
      }
      case "lnot": return [n.not(this.truth(this.expr(e.a, env)))];
      case "red": {
        const a = this.expr(e.a, env);
        if (e.op === "|") return [this.truth(a)];
        if (e.op === "&") return [a.reduce((t, x) => n.and(t, x), 1)];
        return [a.reduce((t, x) => n.xor(t, x), 0)];
      }
      case "shift": {
        let a = this.expr(e.a, env);
        const b = this.expr(e.b, env), w = e.w;
        const fill = e.op === ">>>" && e.s ? a[w - 1]! : 0;
        for (let k = 0; k < b.length; k++) {
          const sh = 2 ** k;
          if (sh >= w) {
            // shifting by w or more: everything becomes the fill
            a = a.map((x) => n.mux(b[k]!, fill, x));
            continue;
          }
          const moved = e.op === "<<" ? a.map((_, i) => (i - sh >= 0 ? a[i - sh]! : 0)) : a.map((_, i) => (i + sh < w ? a[i + sh]! : fill));
          a = a.map((x, i) => n.mux(b[k]!, moved[i]!, x));
        }
        return a;
      }
      case "cond": {
        const c = this.truth(this.expr(e.c, env));
        const a = this.expr(e.a, env), b = this.expr(e.b, env);
        return a.map((x, i) => n.mux(c, x, b[i]!));
      }
      case "bit": {
        const a = this.expr(e.a, env), idx = this.expr(e.idx, env);
        return [a.reduce((t, x, i) => n.or(t, n.and(this.eq(idx, this.constBits(i + e.off, idx.length)), x)), 0)];
      }
      case "slice": return this.expr(e.a, env).slice(e.lo, e.lo + e.w);
      case "mem": throw new VerilogError(0, "memories are left out of the gate view");
      case "concat": {
        const out: Bits = [];
        for (let i = e.parts.length - 1; i >= 0; i--) out.push(...this.expr(e.parts[i]!, env));
        return out;
      }
    }
  }
}

// ---------------------------------------------------------------- statistics and timing

export interface Timing {
  /** Live gates by kind. */
  counts: Record<"not" | "and" | "or" | "xor" | "mux", number>;
  gates: number;
  /** Levels of gates on the deepest path (inverters count as a level). */
  depth: number;
  /** The critical path delay in τ (MODEL INPUT delays). */
  delay: number;
  /** The gates of the critical path, from start point to end point. */
  path: number[];
  start: string;
  end: string;
  arrival: number[];
}

export function timing(net: Netlist, delay: Record<GateOp, number> = GATE_DELAY): Timing {
  const live = net.live();
  const arr = new Array<number>(net.gates.length).fill(0);
  const lvl = new Array<number>(net.gates.length).fill(0);
  const from = new Array<number>(net.gates.length).fill(-1);
  const counts = { not: 0, and: 0, or: 0, xor: 0, mux: 0 };
  for (const id of live) {
    const g = net.gates[id]!;
    if (g.op === "in") continue;
    counts[g.op as keyof typeof counts]++;
    let best = -1, t = 0, l = 0;
    for (const f of net.fanins(id)) {
      if (arr[f]! > t || best < 0) { t = arr[f]!; best = f; }
      l = Math.max(l, lvl[f]!);
    }
    arr[id] = t + delay[g.op];
    lvl[id] = l + 1;
    from[id] = best;
  }
  let endOut = net.outputs[0];
  for (const o of net.outputs) if (arr[o.node]! > arr[endOut?.node ?? 0]!) endOut = o;
  const path: number[] = [];
  for (let x = endOut ? endOut.node : -1; x >= 0; x = from[x]!) path.unshift(x);
  const first = path[0];
  return {
    counts, gates: counts.not + counts.and + counts.or + counts.xor + counts.mux,
    depth: Math.max(0, ...net.outputs.map((o) => lvl[o.node]!)),
    delay: endOut ? arr[endOut.node]! : 0,
    path, start: first !== undefined ? net.gates[first]!.name || "a constant" : "", end: endOut?.name ?? "", arrival: arr,
  };
}

/** The N-bit adder module used by the timing demos. */
export const adderSrc = (w: number) => `module add${w}(input [${w - 1}:0] a, input [${w - 1}:0] b, output [${w - 1}:0] s);
  assign s = a + b;
endmodule
`;

/** Gates, depth and delay of a w-bit adder of each kind (for the plot and the tests). */
export function adderStats(w: number, kind: AdderKind) {
  const r = synthesize(adderSrc(w), { adder: kind });
  const t = timing(r.net!);
  return { gates: t.gates, depth: t.depth, delay: t.delay };
}

/** The value of every gate for one input assignment (`input(name)` gives the bit of an input gate). */
export function evalNet(net: Netlist, input: (name: string) => number): Uint8Array {
  const v = new Uint8Array(net.gates.length);
  net.gates.forEach((g, i) => {
    switch (g.op) {
      case "c0": v[i] = 0; break;
      case "c1": v[i] = 1; break;
      case "in": v[i] = input(g.name) & 1; break;
      case "not": v[i] = v[g.a]! ^ 1; break;
      case "and": v[i] = v[g.a]! & v[g.b]!; break;
      case "or": v[i] = v[g.a]! | v[g.b]!; break;
      case "xor": v[i] = v[g.a]! ^ v[g.b]!; break;
      case "mux": v[i] = v[g.a]! ? v[g.b]! : v[g.c]!; break;
    }
  });
  return v;
}

/** Read a multi-bit output (named "y" or "y[i]") from gate values. */
export function outputValue(net: Netlist, v: Uint8Array, name: string): number {
  let r = 0;
  for (const o of net.outputs) {
    if (o.name === name) return v[o.node]!;
    const m = /^(.*)\[(\d+)\]$/.exec(o.name);
    if (m && m[1] === name) r += v[o.node]! * 2 ** Number(m[2]);
  }
  return r;
}
