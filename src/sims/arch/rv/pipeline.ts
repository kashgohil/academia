/**
 * A trace-driven timing model of the classic in-order five-stage pipeline IF ID EX MEM WB, after Patterson and
 * Hennessy, "Computer Organization and Design, RISC-V Edition", chapter 4. It reads the hart's DynInst trace (the
 * correct path, already executed by the golden model) and the program (for the wrong-path instructions it fetches),
 * and gives each instruction the cycle at which it enters each stage. It computes timing only; values come from the
 * hart, so the timing can never change a result.
 *
 * Cycles count from 1 (the first IF). Instruction k enters stages at IF_k < ID_k < EX_k < MEM_k < WB_k, by these rules
 * (W = width, 1 or 2; "k-1" is the previous correct-path instruction):
 *
 *   IF_k  = max(fetch ready, IF_{k-1} + [W = 1], IF_{k-W} + 1, ID_{k-W})         in order; a slot in IF is free
 *   ID_k  = max(IF_k + 1, ID_{k-1}, EX_{k-W})                                       a slot in ID is free
 *   EX_k  = max(ID_k + 1, EX_{k-1}, MEM_{k-W}, data rules, pairing rules)            the hazard unit holds k in ID
 *   MEM_k = max(EX_k + latency, MEM_{k-1} (+1 if both access memory), WB_{k-W})
 *   WB_k  = max(MEM_k + 1, WB_{k-1}, WB_{k-W} + 1)
 *
 * Data rules for each source register of k written by an earlier producer p (x0 never counts). The register file is
 * written in the first half of a cycle and read in the second half (P&H's assumption), so an instruction in ID reads a
 * value that p writes back in that same cycle: WB to ID needs no forwarding.
 * - forwarding "none": k reads registers in its last ID cycle, so EX_k ≥ WB_p + 1. Distance 1 stalls 2 cycles,
 *   distance 2 stalls 1, distance 3 none.
 * - forwarding "full" (EX/MEM → EX and MEM/WB → EX): an ALU, mul or div result can be used once p has left EX:
 *   EX_k ≥ MEM_p (no stall for neighbours). A load result exists only after MEM: EX_k ≥ WB_p, so a load followed at
 *   once by a user stalls 1 cycle (the load-use hazard).
 * - `memForward: true` adds MEM/WB → MEM for a store's data: a store whose rs2 comes from a load needs it only in MEM,
 *   EX_k ≥ WB_p - 1, so `lw t0, 0(a0); sw t0, 0(a1)` does not stall. Off by default, as in P&H's hazard unit.
 * - A conditional branch resolved in ID compares its registers in its last ID cycle. With "full" forwarding an ALU
 *   result comes from EX/MEM: EX_k ≥ MEM_p + 1 (1 stall right after an ALU op); a load result comes from the register
 *   file: EX_k ≥ WB_p + 1 (2 stalls right after a load). With "none": EX_k ≥ WB_p + 1.
 * - Structural: EX holds one instruction per slot, so a mul or div that stays in EX for `mulLatency` or `divLatency`
 *   cycles holds the next instruction in ID (EX_k ≥ MEM_{k-W}). The M unit is not pipelined.
 * - Width 2 (in-order dual issue): k can enter EX in the same cycle as k-1 only if they are independent (the data
 *   rules see to that), not both memory operations, not both mul/div, k-1 is not a branch or jump (a branch ends the
 *   pair), and neither is a system instruction. Otherwise EX_k ≥ EX_{k-1} + 1. Fetch takes any two consecutive
 *   instructions; the register file has 4 read and 2 write ports.
 *
 * Stall accounting. A stall is a cycle that k waits in ID beyond max(ID_k + 1, EX_{k-1}). It is counted once, under
 * the rule that binds (ties: loadUse, then raw, then structural): `loadUse` for a load producer with forwarding,
 * `raw` for any other data rule, `structural` for a busy EX or a pair that cannot issue together (and, at width 2,
 * for cycles in EX or MEM spent behind an older instruction). `control` counts cycles when ID gets no correct-path
 * instruction because of a branch or jump: ID_k minus the ID_k that the fetch rules alone would give. At width 1,
 * cycles = retired + 4 + loadUse + raw + structural + control + (latency of the last instruction - 1).
 *
 * Control. Where fetch goes after a branch or jump j:
 * - The redirect cycle (when the correct pc is known): jal at ID_j + 1 (the target is computed in ID); jalr at
 *   EX_j + 1 (always resolved in EX); a conditional branch at EX_j + 1 (resolve "EX") or EX_j (resolve "ID": it
 *   compares in its last ID cycle).
 * - predict "stall": fetch waits for the redirect after every branch and jump (pre-decode in IF spots them). No
 *   instruction is squashed; the lost cycles are control stalls. Cost: 2 cycles per branch (resolve EX) or 1 (ID).
 * - predict "not-taken": fetch goes on at pc + 4. A taken branch squashes what was fetched after it: 2 instructions
 *   with resolve "EX", 1 with "ID". A jal squashes 1 and a jalr 2.
 * - predict "taken": the target is known only in ID, so the fall-through fetched during ID is squashed and fetch goes to
 *   the target at ID_j + 1. A branch that is then not taken squashes the target path and refetches pc + 4.
 * - predict "dynamic": `predictor` (from src/sims/perf/cpu.ts, indexed by pc >>> 2; default a fresh 2-bit table) gives
 *   the direction. Without `btb`, a predicted-taken branch goes to its target at ID_j + 1. With `btb`, a direct-mapped
 *   branch target buffer (`btbEntries`, default 64, tagged by the full pc, filled when a branch or jump is taken) gives
 *   the target already in IF: fetch goes there at IF_j + 1 with no squash. A jalr uses the BTB too (last target).
 *   The predictor and BTB are updated in program order, before the next branch is predicted.
 * - Wrong-path instructions are fetched sequentially from the predicted pc and read from the program (their text is
 *   the real instruction at that address). They are shown as squashed rows and counted in `flushes`.
 *
 * Not modelled: caches and memory latency (MEM always takes 1 cycle), exceptions, the cost of ecall (it is a plain
 * 1-cycle instruction with no sources), instruction alignment for dual fetch. MODEL INPUTS: mulLatency (default 1,
 * a single-cycle multiplier) and divLatency (default 20, an iterative divider of roughly one quotient bit per cycle).
 */
import { makePredictor, type Predictor } from "../../perf/cpu";
import type { Program } from "./asm";
import type { DynInst } from "./hart";
import { classOf, decode, disasm, srcRegs, type DisasmOptions, type InstClass } from "./isa";

export type Stage = "IF" | "ID" | "EX" | "MEM" | "WB";
export interface Cell { cycle: number; stage: Stage | "stall" }
export interface Row {
  /** The DynInst seq; -1 for a squashed (wrong-path) instruction. */
  seq: number;
  pc: number;
  text: string;
  squashed: boolean;
  cls: InstClass | null;
  cells: Cell[];
}
export interface Forward { from: "EX/MEM" | "MEM/WB"; to: "EX" | "ID" | "MEM"; seq: number; src: number; reg: number; cycle: number }
export interface Stalls { loadUse: number; raw: number; control: number; structural: number }

export interface BranchOptions {
  resolve?: "EX" | "ID";
  predict?: "stall" | "not-taken" | "taken" | "dynamic";
  /** For "dynamic". It is mutated: pass a fresh one per run. Default: makePredictor("two-bit"). */
  predictor?: Predictor;
  btb?: boolean;
  btbEntries?: number;
}

export interface PipelineOptions {
  forwarding?: "none" | "full";
  memForward?: boolean;
  branch?: BranchOptions;
  /** MODEL INPUT: cycles in EX for mul, mulh, mulhsu, mulhu. */
  mulLatency?: number;
  /** MODEL INPUT: cycles in EX for div, divu, rem, remu. */
  divLatency?: number;
  width?: 1 | 2;
  /** false: statistics only (no rows, no forwards), for long runs. */
  rows?: boolean;
  /** How row text is written (default: pseudo-instructions on, ABI names, targets by label). */
  disasm?: DisasmOptions;
}

export interface PipelineResult {
  rows: Row[];
  cycles: number;
  retired: number;
  cpi: number;
  stalls: Stalls;
  flushes: number;
  forwards: Forward[];
  /** Conditional branches, and those whose direction was predicted wrong (always 0 for "stall"). */
  branches: number;
  mispredicts: number;
}

export const DEFAULT_MUL_LATENCY = 1;
export const DEFAULT_DIV_LATENCY = 20;

/** Stage entry cycles of one instruction. */
interface Times { IF: number; ID: number; EX: number; MEM: number; WB: number }
const NONE: Times = { IF: 0, ID: 0, EX: 0, MEM: 0, WB: 0 };

interface Producer { seq: number; EX: number; MEM: number; WB: number; load: boolean }

const isMem = (c: InstClass) => c === "load" || c === "store";
const isMD = (c: InstClass) => c === "mul" || c === "div";
const isCtl = (c: InstClass) => c === "branch" || c === "jump";

/**
 * The pipeline as a stream: push the hart's DynInsts in order (for example from `onInst`), then call finish().
 * `pipeline(trace, program, opts)` does both.
 */
export class Pipeline {
  private readonly o: Required<Omit<PipelineOptions, "branch" | "disasm">> & { disasm: DisasmOptions };
  private readonly br: Required<Omit<BranchOptions, "predictor">> & { predictor: Predictor };
  private readonly program: Program;
  private readonly rows: Row[] = [];
  private readonly forwards: Forward[] = [];
  private readonly stalls: Stalls = { loadUse: 0, raw: 0, control: 0, structural: 0 };
  private flushes = 0;
  private branches = 0;
  private mispredicts = 0;
  private retired = 0;
  private lastWB = 0;
  /** The last W correct-path instructions, newest last. */
  private win: { t: Times; cls: InstClass }[] = [];
  private prod: (Producer | undefined)[] = new Array(32);
  private lastMD: Times | null = null;
  /** The earliest cycle the next correct-path instruction can be fetched (set by a branch or jump). */
  private fetchReady = 0;
  private readonly btbTag: Int32Array;
  private readonly btbTarget: Int32Array;

  constructor(program: Program, opts: PipelineOptions = {}) {
    this.program = program;
    this.o = {
      forwarding: opts.forwarding ?? "full", memForward: opts.memForward ?? false,
      mulLatency: opts.mulLatency ?? DEFAULT_MUL_LATENCY, divLatency: opts.divLatency ?? DEFAULT_DIV_LATENCY,
      width: opts.width ?? 1, rows: opts.rows ?? true, disasm: opts.disasm ?? { pseudo: true },
    };
    const names = new Map<number, string>();
    for (const [name, addr] of Object.entries(program.labels)) if (!names.has(addr)) names.set(addr, name);
    if (!opts.disasm) this.o.disasm = { pseudo: true, symbol: (a) => names.get(a) };
    const b = opts.branch ?? {};
    this.br = {
      resolve: b.resolve ?? "EX", predict: b.predict ?? "not-taken", predictor: b.predictor ?? makePredictor("two-bit"),
      btb: b.btb ?? false, btbEntries: b.btbEntries ?? 64,
    };
    this.btbTag = new Int32Array(this.br.btbEntries).fill(-1);
    this.btbTarget = new Int32Array(this.br.btbEntries);
  }

  private back(n: number): Times { return this.win[this.win.length - n]?.t ?? NONE; }

  push(d: DynInst): void {
    const W = this.o.width, cls = d.cls, prev = this.back(1), prevW = this.back(W);
    const prevCls = this.win[this.win.length - 1]?.cls;
    const lat = cls === "mul" ? this.o.mulLatency : cls === "div" ? this.o.divLatency : 1;

    // ---- fetch and decode
    const ifNoCtl = Math.max(1, prev.IF + (W === 1 ? 1 : 0), prevW.IF + 1, prevW.ID);
    const IF = Math.max(ifNoCtl, this.fetchReady);
    const ID = Math.max(IF + 1, prev.ID, prevW.EX);
    this.stalls.control += ID - Math.max(ifNoCtl + 1, prev.ID, prevW.EX);

    // ---- issue to EX: the constraints, each with the stall category it would cause
    const base = Math.max(ID + 1, prev.EX);
    const bind: { cycle: number; why: keyof Stalls | null } = { cycle: base, why: null };
    const req = (cycle: number, cat: keyof Stalls) => {
      if (cycle > bind.cycle || (cycle === bind.cycle && bind.why !== null && rank(cat) < rank(bind.why))) bind.cycle = cycle, bind.why = cat;
    };
    req(prevW.MEM, "structural");
    if (W === 2 && prevCls && !canPair(prevCls, cls)) req(prev.EX + 1, "structural");
    if (isMD(cls) && this.lastMD) req(this.lastMD.MEM, "structural");
    const branchInID = cls === "branch" && this.br.resolve === "ID";
    const srcs = srcRegs(d.inst);
    const uses: { r: number; p: Producer; store: boolean }[] = [];
    srcs.forEach((r, i) => {
      const p = r === 0 ? undefined : this.prod[r];
      if (!p) return;
      const storeData = cls === "store" && i === 1 && r !== srcs[0];
      uses.push({ r, p, store: storeData });
      if (this.o.forwarding === "none") req(p.WB + 1, "raw");
      else if (branchInID) req(p.load ? p.WB + 1 : p.MEM + 1, p.load ? "loadUse" : "raw");
      else if (p.load) req(storeData && this.o.memForward ? p.WB - 1 : p.WB, "loadUse");
      else req(p.MEM, "raw");
    });
    const EX = bind.cycle;
    if (bind.why) this.stalls[bind.why] += EX - base;

    // ---- the rest of the pipe
    const MEM = Math.max(EX + lat, prev.MEM + (W === 2 && prevCls && isMem(prevCls) && isMem(cls) ? 1 : 0), prevW.WB);
    const WB = Math.max(MEM + 1, prev.WB, prevW.WB + 1);
    this.stalls.structural += MEM - (EX + lat) + (WB - MEM - 1);
    const t: Times = { IF, ID, EX, MEM, WB };

    // ---- forwarding paths used (for the diagram)
    if (this.o.rows && this.o.forwarding === "full") {
      for (const u of uses) {
        const { p } = u;
        if (branchInID) {
          if (EX - 1 < p.WB) this.forwards.push({ from: "EX/MEM", to: "ID", seq: d.seq, src: p.seq, reg: u.r, cycle: EX - 1 });
        } else if (u.store && this.o.memForward && p.load && EX < p.WB) {
          this.forwards.push({ from: "MEM/WB", to: "MEM", seq: d.seq, src: p.seq, reg: u.r, cycle: MEM });
        } else if (EX <= p.WB) {
          this.forwards.push({ from: EX < p.WB ? "EX/MEM" : "MEM/WB", to: "EX", seq: d.seq, src: p.seq, reg: u.r, cycle: EX });
        }
      }
    }

    if (this.o.rows) this.rows.push({ seq: d.seq, pc: d.pc, text: disasm(d.inst, d.pc, this.o.disasm), squashed: false, cls, cells: cellsOf(t, lat, Infinity) });
    if (d.rd !== 0) this.prod[d.rd] = { seq: d.seq, EX, MEM, WB, load: cls === "load" };
    if (isMD(cls)) this.lastMD = t;
    this.win.push({ t, cls });
    if (this.win.length > 2) this.win.shift();
    this.retired++;
    this.lastWB = WB;
    this.fetchReady = isCtl(cls) ? this.control(d, t) : 0;
  }

  /** Where fetch goes after the branch or jump d: makes squashed rows and returns when the next instruction can be fetched. */
  private control(d: DynInst, t: Times): number {
    const { predict, resolve, predictor, btb } = this.br;
    const pc = d.pc, cond = d.cls === "branch", jalr = d.inst.op === "jalr";
    const target = (pc + d.inst.imm) >>> 0;
    const redirect = cond ? (resolve === "EX" ? t.EX + 1 : t.EX) : jalr ? t.EX + 1 : t.ID + 1;
    if (cond) this.branches++;
    let predTaken = false;
    if (cond && predict === "taken") predTaken = true;
    if (cond && predict === "dynamic") predTaken = predictor.predict(pc >>> 2);
    if (cond) {
      if (predict === "dynamic") predictor.update(pc >>> 2, d.taken === true);
      if (predict !== "stall" && predTaken !== d.taken) this.mispredicts++;
    }
    const slot = (pc >>> 2) % this.br.btbEntries;
    const btbHit = predict === "dynamic" && btb && this.btbTag[slot] === (pc | 0);
    const btbTarget = this.btbTarget[slot]! >>> 0;
    if (btb && d.taken) { this.btbTag[slot] = pc | 0; this.btbTarget[slot] = d.nextPc | 0; }
    if (predict === "stall") return redirect;

    // The fetch stream after d, as segments; every segment but the last is the wrong path.
    const segs: { start: number; pc: number }[] = [];
    if (btbHit && (!cond || predTaken)) segs.push({ start: t.IF + 1, pc: btbTarget });
    else segs.push({ start: t.IF, pc: (pc + 4) >>> 0 });
    const decodeTarget = !jalr && (!cond || predTaken) ? target : null;
    if (decodeTarget !== null && segs[segs.length - 1]!.pc !== decodeTarget) push(segs, { start: t.ID + 1, pc: decodeTarget });
    if (segs[segs.length - 1]!.pc !== d.nextPc) push(segs, { start: redirect, pc: d.nextPc });
    for (let i = 0; i + 1 < segs.length; i++) this.wrongPath(segs[i]!, segs[i + 1]!.start);
    return segs[segs.length - 1]!.start;
  }

  /** Fetch sequentially from seg.pc, starting at seg.start, until `cut`, behind the correct-path window. */
  private wrongPath(seg: { start: number; pc: number }, cut: number) {
    const W = this.o.width;
    const chain: Times[] = this.win.map((w) => w.t);
    for (let pc = seg.pc; ; pc = (pc + 4) >>> 0) {
      const prev = chain[chain.length - 1] ?? NONE, prevW = chain[chain.length - W] ?? NONE;
      const IF = Math.max(seg.start, prev.IF + (W === 1 ? 1 : 0), prevW.IF + 1, prevW.ID);
      if (IF >= cut) return;
      const ID = Math.max(IF + 1, prev.ID, prevW.EX);
      const t: Times = { IF, ID, EX: ID + 1, MEM: ID + 2, WB: ID + 3 };
      chain.push(t);
      this.flushes++;
      if (this.o.rows) {
        const i = (pc - this.program.textBase) / 4;
        const word = i >= 0 && i < this.program.words.length ? this.program.words[i] : undefined;
        const inst = word === undefined ? null : decode(word);
        this.rows.push({
          seq: -1, pc, squashed: true, cls: inst ? classOf(inst.op) : null, cells: cellsOf(t, 1, cut),
          text: inst ? disasm(inst, pc, this.o.disasm) : "(no instruction here)",
        });
      }
    }
  }

  finish(): PipelineResult {
    const cycles = this.retired ? this.lastWB : 0;
    return {
      rows: this.rows, cycles, retired: this.retired, cpi: this.retired ? cycles / this.retired : 0,
      stalls: { ...this.stalls }, flushes: this.flushes, forwards: this.forwards,
      branches: this.branches, mispredicts: this.mispredicts,
    };
  }
}

/** Run the timing model over a whole trace. */
export function pipeline(trace: readonly DynInst[], program: Program, opts: PipelineOptions = {}): PipelineResult {
  const p = new Pipeline(program, opts);
  for (const d of trace) p.push(d);
  return p.finish();
}

const rank = (c: keyof Stalls) => (c === "loadUse" ? 0 : c === "raw" ? 1 : c === "structural" ? 2 : 3);

function canPair(a: InstClass, b: InstClass): boolean {
  if (isCtl(a) || a === "system" || b === "system") return false;
  if (isMem(a) && isMem(b)) return false;
  if (isMD(a) && isMD(b)) return false;
  return true;
}

/** A later redirect at the same cycle replaces an earlier one. */
function push(segs: { start: number; pc: number }[], s: { start: number; pc: number }) {
  const last = segs[segs.length - 1]!;
  if (segs.length > 1 && last.start >= s.start) segs[segs.length - 1] = s;
  else segs.push(s);
}

/** Cells of one row: each stage at its entry cycle, extra cycles in a stage as "stall" (EX keeps "EX" for its latency). */
function cellsOf(t: Times, lat: number, cut: number): Cell[] {
  const out: Cell[] = [];
  const add = (cycle: number, stage: Cell["stage"]) => { if (cycle < cut) out.push({ cycle, stage }); };
  add(t.IF, "IF");
  for (let c = t.IF + 1; c < t.ID; c++) add(c, "stall");
  add(t.ID, "ID");
  for (let c = t.ID + 1; c < t.EX; c++) add(c, "stall");
  for (let c = t.EX; c < t.MEM; c++) add(c, c < t.EX + lat ? "EX" : "stall");
  add(t.MEM, "MEM");
  for (let c = t.MEM + 1; c < t.WB; c++) add(c, "stall");
  add(t.WB, "WB");
  return out;
}
