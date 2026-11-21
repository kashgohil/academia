/**
 * Calling conventions at the machine level.
 *
 * Part 1, frames: run a recursive function on the shared hart and label every stack word by the frame that owns it
 * and what the program stored there (saved ra, saved s0, or padding that keeps sp 16-byte aligned, as the RISC-V
 * psABI requires).
 *
 * Part 2, the split: why a convention has both caller-saved and callee-saved registers. A generator writes a real
 * RV32 program for a hypothetical convention in which the first `calleeSaved` registers of POOL are callee-saved and
 * the rest are caller-saved. f keeps `live` values across `calls` calls to a leaf g, and g needs `temps` registers.
 * The hart runs it, and the trace counts every load and store: in this program, all of them are saves and restores.
 */
import { assemble, Hart, REG_ABI, type Program } from "../rv";

// ---------------------------------------------------------------- part 1: frames

export const factSource = (n: number) => `# fact(n) by recursion; the result is the exit code.
        .text
_start:
        li   a0, ${n}
        call fact
        li   a7, 93         # exit(fact(n))
        ecall

# fact(n) = n <= 1 ? 1 : n * fact(n - 1)
fact:
        addi sp, sp, -16    # prologue: a 16-byte frame
        sw   ra, 12(sp)     # save the return address
        sw   s0, 8(sp)      # save the caller's s0
        mv   s0, a0         # s0 = n survives the call
        li   t0, 1
        ble  a0, t0, base
        addi a0, a0, -1
        call fact           # a0 = fact(n - 1)
        mul  a0, s0, a0
        j    out
base:
        li   a0, 1
out:
        lw   s0, 8(sp)      # epilogue: restore
        lw   ra, 12(sp)
        addi sp, sp, 16
        ret
`;

export interface StackWord { addr: number; value: number; frame: number; what: string; live: boolean }

export interface FrameView {
  /** Steps run so far. */
  step: number;
  pc: number;
  sp: number;
  depth: number;
  regs: number[];
  words: StackWord[];
  status: string;
  exitCode: number | null;
  lastText: string;
}

export interface FactRun { program: Program; steps: number; minSp: number; top: number; exitCode: number | null }

export function factRun(n: number): FactRun {
  const asm = assemble(factSource(n));
  const h = new Hart(asm.program, { trace: false });
  const top = h.regs[2]!;
  let minSp = top;
  while (h.step()) minSp = Math.min(minSp, h.regs[2]!);
  return { program: asm.program, steps: h.instret, minSp, top, exitCode: h.exitCode };
}

/** The stack after k steps, with each word labelled. `span` = bytes below the top to show. */
export function frameView(program: Program, k: number, span: number): FrameView {
  // Every address that the whole run ever stores to, and what: a slot that is empty now may be filled later.
  const ever = new Map<number, string>();
  const full = new Hart(program, { trace: false, onInst: (d) => { if (d.cls === "store" && d.memAddr !== undefined) ever.set(d.memAddr, REG_ABI[d.inst.rs2]!); } });
  full.run({ maxSteps: 100_000 });
  const h = new Hart(program);
  const top = h.regs[2]!;
  // Labels: for each address, what the last store wrote there; frames: each addi sp, sp, -N opens one.
  const label = new Map<number, string>();
  const frames: { lo: number; hi: number }[] = [];
  for (let i = 0; i < k && h.step(); i++) {
    const s = h.snapshot();
    const d = s.last!;
    if (d.inst.op === "addi" && d.rd === 2 && d.inst.rs1 === 2) {
      if (d.inst.imm < 0) frames.push({ lo: h.regs[2]!, hi: h.regs[2]! - d.inst.imm });
      else frames.pop();
    }
    if (d.cls === "store" && d.memAddr !== undefined) label.set(d.memAddr, `saved ${REG_ABI[d.inst.rs2]}`);
  }
  const sp = h.regs[2]!;
  const words: StackWord[] = [];
  for (let a = top - 4; a >= top - span; a -= 4) {
    const f = frames.findIndex((fr) => a >= fr.lo && a < fr.hi);
    words.push({ addr: a, value: h.peek(a, 4, true), frame: f, what: f >= 0 ? label.get(a) ?? (ever.has(a) ? `empty: ${ever.get(a)} goes here` : "padding") : label.has(a) ? `old: ${label.get(a)}` : "", live: a >= sp });
  }
  const last = h.trace.length ? h.trace[h.trace.length - 1]! : null;
  return {
    step: h.instret, pc: h.pc, sp, depth: frames.length, regs: Array.from(h.regs), words, status: h.status, exitCode: h.exitCode,
    lastText: last ? program.lines[program.src[(last.pc - program.textBase) / 4]! - 1]?.trim() ?? "" : "",
  };
}

// ---------------------------------------------------------------- part 2: the caller/callee split

/** Registers that the generator may allocate: x8, x9, x18..x27 (s0..s11), then x5..x7, x28..x31 (t0..t6), then x12..x17 (a2..a7). */
export const POOL = [8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 5, 6, 7, 28, 29, 30, 31, 12, 13, 14, 15, 16, 17];
/** The RISC-V psABI: s0..s11 are callee-saved, so the first 12 of POOL. */
export const RISCV_SPLIT = 12;

export interface SplitParams { calleeSaved: number; live: number; temps: number; calls: number }

const sum1 = (n: number) => (n * (n + 1)) / 2;
/** What the program returns, whatever the split: f's live values 1..live, plus g's sum 1..temps for each call. */
export const splitExpect = (p: SplitParams) => sum1(p.live) + p.calls * sum1(p.temps);

/** The RV32 program for one convention. Live values go to callee-saved registers first; g's temps to caller-saved first. */
export function splitProgram(p: SplitParams): string {
  const R = (r: number) => REG_ABI[r]!;
  const callee = POOL.slice(0, p.calleeSaved), caller = POOL.slice(p.calleeSaved);
  if (p.live > POOL.length || p.temps > POOL.length) throw new RangeError("too many values");
  // f: live values
  const fLive = [...callee, ...caller].slice(0, p.live);
  const fSaved = fLive.filter((r) => callee.includes(r)); // f must save these once (it is a callee too)
  const fAround = fLive.filter((r) => caller.includes(r)); // f must save these around every call
  const fFrame = Math.ceil((4 + 4 * fSaved.length + 4 * fAround.length) / 16) * 16;
  const L: string[] = [];
  const e = (s: string) => L.push(`        ${s}`);
  L.push("        .text", "_start:");
  e("call f"); e("li   a7, 93"); e("ecall");
  L.push("f:");
  e(`addi sp, sp, -${fFrame}`);
  e(`sw   ra, ${fFrame - 4}(sp)`);
  fSaved.forEach((r, i) => e(`sw   ${R(r)}, ${fFrame - 8 - 4 * i}(sp)     # callee-saved: f saves it once`));
  fLive.forEach((r, i) => e(`li   ${R(r)}, ${i + 1}`));
  const aroundOff = (i: number) => 4 * i;
  for (let c = 0; c < p.calls; c++) {
    fAround.forEach((r, i) => e(`sw   ${R(r)}, ${aroundOff(i)}(sp)     # caller-saved and live: save before the call`));
    e("call g");
    fAround.forEach((r, i) => e(`lw   ${R(r)}, ${aroundOff(i)}(sp)     # restore after the call`));
    if (fLive.length) e(`add  ${R(fLive[0]!)}, ${R(fLive[0]!)}, a0`);
    else e("add  a1, a1, a0");
  }
  e(fLive.length ? `mv   a0, ${R(fLive[0]!)}` : "mv   a0, a1");
  fLive.slice(1).forEach((r) => e(`add  a0, a0, ${R(r)}`));
  fSaved.forEach((r, i) => e(`lw   ${R(r)}, ${fFrame - 8 - 4 * i}(sp)`));
  e(`lw   ra, ${fFrame - 4}(sp)`);
  e(`addi sp, sp, ${fFrame}`);
  e("ret");
  // g: a leaf that needs `temps` registers
  const gRegs = [...caller, ...callee].slice(0, p.temps);
  const gSaved = gRegs.filter((r) => callee.includes(r));
  const gFrame = Math.ceil((4 * gSaved.length) / 16) * 16;
  L.push("g:");
  if (gFrame) e(`addi sp, sp, -${gFrame}`);
  gSaved.forEach((r, i) => e(`sw   ${R(r)}, ${4 * i}(sp)     # callee-saved: g must save it before use`));
  gRegs.forEach((r, i) => e(`li   ${R(r)}, ${i + 1}`));
  e("li   a0, 0");
  gRegs.forEach((r) => e(`add  a0, a0, ${R(r)}`));
  gSaved.forEach((r, i) => e(`lw   ${R(r)}, ${4 * i}(sp)`));
  if (gFrame) e(`addi sp, sp, ${gFrame}`);
  e("ret");
  // f with no live values still needs an accumulator: a1 starts at 0 (the hart starts registers at 0)
  return L.join("\n") + "\n";
}

export interface SplitResult { params: SplitParams; loads: number; stores: number; memOps: number; instret: number; exitCode: number | null; ok: boolean; source: string }

export function runSplit(p: SplitParams): SplitResult {
  const source = splitProgram(p);
  const asm = assemble(source);
  if (!asm.ok) throw new Error(asm.errors.map((x) => `${x.line}: ${x.message}`).join("; "));
  const h = new Hart(asm.program, { trace: false });
  h.run({ maxSteps: 100_000 });
  const loads = h.counts.load, stores = h.counts.store;
  return { params: p, loads, stores, memOps: loads + stores, instret: h.instret, exitCode: h.exitCode, ok: h.exitCode === splitExpect(p), source };
}

/** The cost for every split 0..POOL.length, for the plot. */
export const splitSweep = (p: Omit<SplitParams, "calleeSaved">) =>
  Array.from({ length: POOL.length + 1 }, (_, s) => runSplit({ ...p, calleeSaved: s }));
