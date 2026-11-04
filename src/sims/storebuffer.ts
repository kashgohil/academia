/**
 * An interactive store-buffer machine for litmus programs.
 * - sc:  stores go straight to memory.
 * - tso: each core has a FIFO store buffer (x86). Loads forward from the core's own buffer.
 * - pso: stores to *different* addresses may drain in any order (store→store reordering, as on
 *        SPARC PSO and, in effect, ARM/POWER), unless a release fence separates them.
 * seq_cst stores, RMWs and seq_cst fences wait for an empty buffer (x86: XCHG / LOCK / MFENCE).
 */
import { evalVal, type Program } from "./memmodel/ast";
import { outcomeKey } from "./memmodel/explore";

export type Mode = "sc" | "tso" | "pso";
export interface Entry { loc: string; val: number; epoch: number }
export interface Core { pc: number; regs: Record<string, number>; buf: Entry[]; epoch: number }
export interface SBState { mem: Record<string, number>; cores: Core[] }

export function initial(p: Program): SBState {
  return {
    mem: Object.fromEntries(p.locs.map((l) => [l, p.init[l] ?? 0])),
    cores: p.threads.map(() => ({ pc: 0, regs: {}, buf: [], epoch: 0 })),
  };
}

const clone = (s: SBState): SBState => ({ mem: { ...s.mem }, cores: s.cores.map((c) => ({ ...c, regs: { ...c.regs }, buf: [...c.buf] })) });

/** Why the core's next instruction can't run now, or null if it can. */
export function blocked(p: Program, s: SBState, i: number): string | null {
  const c = s.cores[i]!;
  const ins = p.threads[i]![c.pc];
  if (!ins) return "finished";
  const needsEmpty = ins.op === "rmw" || (ins.op === "fence" && ins.ord === "sc") || (ins.op === "store" && ins.ord === "sc");
  if (needsEmpty && c.buf.length) return "waits for its store buffer to drain";
  if (ins.op === "load" && ins.await !== null && read(s, i, ins.loc) !== ins.await) return `waits for ${ins.loc} == ${ins.await}`;
  if (ins.op === "rmw" && ins.blocking && read(s, i, ins.loc) !== evalVal(ins.a, c.regs)) return `waits for ${ins.loc} == ${evalVal(ins.a, c.regs)}`;
  return null;
}

function read(s: SBState, i: number, loc: string): number {
  const buf = s.cores[i]!.buf;
  for (let k = buf.length - 1; k >= 0; k--) if (buf[k]!.loc === loc) return buf[k]!.val;
  return s.mem[loc]!;
}

export function exec(p: Program, s: SBState, i: number, mode: Mode): SBState {
  if (blocked(p, s, i)) return s;
  const n = clone(s);
  const c = n.cores[i]!;
  const ins = p.threads[i]![c.pc]!;
  c.pc++;
  switch (ins.op) {
    case "load": {
      const v = read(n, i, ins.loc);
      if (ins.reg) c.regs[ins.reg] = v;
      break;
    }
    case "store": {
      const v = evalVal(ins.val, c.regs);
      if (mode === "sc" || ins.ord === "sc") n.mem[ins.loc] = v;
      else c.buf.push({ loc: ins.loc, val: v, epoch: c.epoch });
      break;
    }
    case "rmw": {
      const old = n.mem[ins.loc]!;
      let nv: number | null;
      if (ins.kind === "add") nv = old + evalVal(ins.a, c.regs);
      else if (ins.kind === "xchg") nv = evalVal(ins.a, c.regs);
      else nv = old === evalVal(ins.a, c.regs) ? evalVal(ins.b, c.regs) : null;
      if (nv !== null) n.mem[ins.loc] = nv;
      if (ins.reg) c.regs[ins.reg] = ins.kind === "cas" ? +(nv !== null) : old;
      break;
    }
    case "fence":
      // A release-type fence keeps earlier stores ahead of later ones (matters only for PSO).
      if (ins.ord === "rel" || ins.ord === "acq_rel" || ins.ord === "sc") c.epoch++;
      break;
  }
  return n;
}

/** Indices of buffer entries that may be written to memory next. */
export function drainable(s: SBState, i: number, mode: Mode): number[] {
  const buf = s.cores[i]!.buf;
  if (!buf.length) return [];
  if (mode !== "pso") return [0];
  return buf
    .map((e, k) => ({ e, k }))
    .filter(({ e, k }) => buf.slice(0, k).every((x) => x.loc !== e.loc && x.epoch >= e.epoch))
    .map(({ k }) => k);
}

export function drain(s: SBState, i: number, k: number, mode: Mode): SBState {
  if (!drainable(s, i, mode).includes(k)) return s;
  const n = clone(s);
  const [e] = n.cores[i]!.buf.splice(k, 1);
  n.mem[e!.loc] = e!.val;
  return n;
}

export function finished(p: Program, s: SBState) {
  return s.cores.every((c, i) => c.pc >= p.threads[i]!.length && c.buf.length === 0);
}

export function outcomeOf(p: Program, s: SBState) {
  return outcomeKey(p, Object.assign({}, ...s.cores.map((c) => c.regs)), s.mem, false);
}

/** All outcomes reachable in a mode (exhaustive), for showing which ones are "weak". */
export function allOutcomes(p: Program, mode: Mode): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  const stack = [initial(p)];
  while (stack.length) {
    const s = stack.pop()!;
    const key = JSON.stringify(s);
    if (seen.has(key)) continue;
    seen.add(key);
    if (finished(p, s)) { out.add(outcomeOf(p, s)); continue; }
    s.cores.forEach((_, i) => {
      if (!blocked(p, s, i)) stack.push(exec(p, s, i, mode));
      for (const k of drainable(s, i, mode)) stack.push(drain(s, i, k, mode));
    });
  }
  return out;
}
