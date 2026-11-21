/**
 * Page faults as precise exceptions in a 5-stage in-order pipeline (IF ID EX MEM WB), modelled cycle by cycle.
 *
 * - A fetch page fault is detected in IF, a load or store page fault in MEM. The pipeline marks the
 *   instruction and lets it flow on.
 * - "precise": the trap is taken when the marked instruction reaches WB, the commit point. Every older
 *   instruction has committed; every younger one is flushed. All architectural effects (register writes and
 *   stores) happen at commit, in program order. If two instructions fault, the older one is reported.
 * - "drain": the trap is taken as soon as a fault is detected, and the younger instructions already in the
 *   pipeline are allowed to finish. This is the wrong design. It shows why precise traps matter.
 *
 * The handler writes sepc, scause and stval as RISC-V does (codes 12, 13, 15), maps the page, executes
 * sfence.vma and sret, and the faulting instruction runs again. The handler body is one pipeline slot here.
 */

export const STAGES = ["IF", "ID", "EX", "MEM", "WB"] as const;
export const PAGE = 0x1000;
export const STVEC = 0x8000;

export type Regs = Record<string, number>;

export interface Instr {
  pc: number;
  text: string;
  kind: "alu" | "load" | "store" | "csr" | "map" | "sfence" | "sret";
  rd?: string;
  /** Computes the result from committed registers; for loads and stores also the address. */
  eval: (r: Regs) => { value?: number; addr?: number };
  handler?: boolean;
}

export interface Slot {
  seq: number;
  instr: Instr;
  cause?: number;
  tval?: number;
  /** Younger than a trap, but allowed to finish (drain policy). */
  drained?: boolean;
  /** In this cycle: "trap" = the trap is taken on it; "flushed" = discarded. It is gone in the next cycle. */
  fate?: "trap" | "flushed";
}

export interface CycleView {
  cycle: number;
  stages: (Slot | null)[];
  events: string[];
  /** Registers and memory words after this cycle. */
  regs: Regs;
  mem: Record<number, number>;
  csr: { sepc: number | null; scause: number | null; stval: number | null };
  flushed: number[];
}

export type TrapPolicy = "precise" | "drain";
export type TrapScenario = "one" | "two";

const PROGRAM_BASE = 0x0ff8;

/** The user program and the handler. In scenario "two", the page of the third instruction is not mapped. */
export function trapProgram(): Instr[] {
  const user: Omit<Instr, "pc">[] = [
    { text: "lw   a1, 0(s0)", kind: "load", rd: "a1", eval: (r) => ({ addr: r.s0! }) },
    { text: "addi a0, a0, 1", kind: "alu", rd: "a0", eval: (r) => ({ value: r.a0! + 1 }) },
    { text: "add  a2, a1, a0", kind: "alu", rd: "a2", eval: (r) => ({ value: r.a1! + r.a0! }) },
    { text: "sw   a2, 0(s1)", kind: "store", eval: (r) => ({ addr: r.s1!, value: r.a2! }) },
  ];
  const handler: Omit<Instr, "pc">[] = [
    { text: "csrr t0, scause", kind: "csr", rd: "t0", eval: () => ({}) },
    { text: "csrr t1, stval", kind: "csr", rd: "t1", eval: () => ({}) },
    { text: "(map the page of t1)", kind: "map", eval: () => ({}) },
    { text: "sfence.vma t1, x0", kind: "sfence", eval: () => ({}) },
    { text: "sret", kind: "sret", eval: () => ({}) },
  ];
  return [
    ...user.map((x, i) => ({ ...x, pc: PROGRAM_BASE + 4 * i })),
    ...handler.map((x, i) => ({ ...x, pc: STVEC + 4 * i, handler: true })),
  ];
}

export const INITIAL_REGS: Regs = { a0: 5, a1: 0, a2: 0, s0: 0x4000, s1: 0x5000, t0: 0, t1: 0 };
export const INITIAL_MEM: Record<number, number> = { 0x4000: 37, 0x5000: 0 };

/** The result of running the user program with no faults, one instruction at a time. */
export function goldenRun(): { regs: Regs; mem: Record<number, number> } {
  const regs = { ...INITIAL_REGS };
  const mem = { ...INITIAL_MEM };
  for (const ins of trapProgram().filter((i) => !i.handler)) commitEffects(ins, regs, mem);
  return { regs, mem };
}

function commitEffects(ins: Instr, regs: Regs, mem: Record<number, number>) {
  const r = ins.eval(regs);
  if (ins.kind === "load") regs[ins.rd!] = mem[r.addr!] ?? 0;
  else if (ins.kind === "store") mem[r.addr!] = r.value!;
  else if (ins.kind === "alu") regs[ins.rd!] = r.value!;
}

export interface TrapRun {
  cycles: CycleView[];
  regs: Regs;
  mem: Record<number, number>;
  correct: boolean;
  traps: { cycle: number; pc: number; cause: number; tval: number }[];
  /** Committed instructions of the user program, in order, by text. */
  committed: string[];
}

/** Runs the pipeline until the user program has finished. */
export function runTrapPipeline(policy: TrapPolicy, scenario: TrapScenario, maxCycles = 80): TrapRun {
  const prog = trapProgram();
  const byPc = new Map(prog.map((i) => [i.pc, i]));
  const userEnd = PROGRAM_BASE + 4 * prog.filter((i) => !i.handler).length;
  const mapped = new Set<number>([PROGRAM_BASE >> 12, STVEC >> 12, 0x5000 >> 12]);
  if (scenario === "one") mapped.add(0x1000 >> 12);
  const regs = { ...INITIAL_REGS };
  const mem = { ...INITIAL_MEM };
  const csr: CycleView["csr"] = { sepc: null, scause: null, stval: null };
  const stages: (Slot | null)[] = [null, null, null, null, null];
  let fetchPc: number | null = PROGRAM_BASE;
  let seq = 0;
  const cycles: CycleView[] = [];
  const traps: TrapRun["traps"] = [];
  const committed: string[] = [];

  const takeTrap = (s: Slot, cycle: number, events: string[], flush: boolean): number[] => {
    csr.sepc = s.instr.pc; csr.scause = s.cause!; csr.stval = s.tval!;
    traps.push({ cycle, pc: s.instr.pc, cause: s.cause!, tval: s.tval! });
    events.push(`Trap: sepc = 0x${s.instr.pc.toString(16)}, scause = ${s.cause}, stval = 0x${s.tval!.toString(16)}. Fetch jumps to stvec.`);
    const flushed: number[] = [];
    s.fate = "trap";
    for (let k = 0; k < stages.length; k++) {
      const x = stages[k];
      if (x && x.seq > s.seq) {
        if (flush) { flushed.push(x.seq); x.fate = "flushed"; } else x.drained = true;
      }
    }
    fetchPc = STVEC;
    return flushed;
  };

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const events: string[] = [];
    let flushed: number[] = [];
    // Advance: WB leaves, everything moves one stage, IF takes a new instruction.
    for (let k = 4; k > 0; k--) stages[k] = stages[k - 1] ?? null;
    stages[0] = null;
    if (fetchPc !== null && (byPc.has(fetchPc))) {
      const ins = byPc.get(fetchPc)!;
      const slot: Slot = { seq: seq++, instr: ins };
      if (!mapped.has(ins.pc >> 12)) { slot.cause = 12; slot.tval = ins.pc; events.push(`IF: no translation for code page 0x${(ins.pc & ~0xfff).toString(16)}. Instruction page fault noted on "${ins.text}".`); }
      stages[0] = slot;
      fetchPc += 4;
    }
    if (fetchPc === null && stages.every((s) => s === null)) break;
    // MEM: data translation.
    const m = stages[3];
    if (m && m.cause === undefined && (m.instr.kind === "load" || m.instr.kind === "store")) {
      const addr = m.instr.eval(regs).addr!;
      if (!mapped.has(addr >> 12)) {
        m.cause = m.instr.kind === "load" ? 13 : 15; m.tval = addr;
        events.push(`MEM: no translation for data page 0x${(addr & ~0xfff).toString(16)}. ${m.instr.kind === "load" ? "Load" : "Store"} page fault noted on "${m.instr.text}".`);
      }
    }
    // Drain policy: trap at detection, in the order the faults appear in time.
    if (policy === "drain") {
      for (const k of [0, 3]) {
        const s = stages[k];
        if (s && s.cause !== undefined && !s.drained && !s.fate) {
          flushed = takeTrap(s, cycle, events, false); // the faulting instruction itself does not complete
          break;
        }
      }
    }
    // WB: commit.
    const w = stages[4];
    if (w) {
      if (w.cause !== undefined) {
        if (policy === "precise") flushed = takeTrap(w, cycle, events, true);
        else if (!w.fate) { events.push(`WB: "${w.instr.text}" faulted while draining. Its fault is lost.`); w.fate = "flushed"; }
      } else {
        const ins = w.instr;
        if (ins.kind === "csr") regs[ins.rd!] = ins.text.includes("scause") ? csr.scause ?? 0 : csr.stval ?? 0;
        else if (ins.kind === "map") { mapped.add(regs.t1! >> 12); events.push(`WB: the handler maps page 0x${(regs.t1! & ~0xfff).toString(16)}.`); }
        else if (ins.kind === "sret") {
          events.push(`WB: sret. Fetch returns to sepc = 0x${csr.sepc!.toString(16)}.`);
          for (let k = 0; k < 4; k++) if (stages[k]) { flushed.push(stages[k]!.seq); stages[k]!.fate = "flushed"; }
          fetchPc = csr.sepc;
        } else if (ins.kind !== "sfence") {
          commitEffects(ins, regs, mem);
          committed.push(ins.text);
          events.push(`WB: "${ins.text}" commits${ins.kind === "store" ? " its store" : ""}.`);
        }
      }
    }
    if (fetchPc !== null && !byPc.has(fetchPc) && fetchPc >= userEnd && fetchPc < STVEC) fetchPc = null;
    cycles.push({ cycle, stages: stages.map((s) => (s ? { ...s } : null)), events, regs: { ...regs }, mem: { ...mem }, csr: { ...csr }, flushed });
    for (let k = 0; k < stages.length; k++) if (stages[k]?.fate) stages[k] = null;
  }
  const g = goldenRun();
  const correct = (["a0", "a1", "a2"] as const).every((r) => regs[r] === g.regs[r]) && mem[0x5000] === g.mem[0x5000];
  return { cycles, regs, mem, correct, traps, committed };
}

/** Cycles the program needs with every page mapped: the fill time plus one per instruction. */
export const faultFreeCycles = () => trapProgram().filter((i) => !i.handler).length + STAGES.length - 1;

// ---------------------------------------------------------------- what a trap costs

/** MODEL INPUTS for the cost of one minor page fault on a deep out-of-order core. */
export const TRAP_COST_MODEL = {
  /** Cycles of work lost in the pipeline at the trap, and again at the return: about its depth. */
  pipelineRefill: 20,
  /** Hardware trap entry and return, privilege switch included. */
  entryExit: 60,
  /** Instructions in the kernel's fault path for a minor fault. */
  handlerInstructions: 1500,
  handlerCpi: 1.0,
};

export function trapCost(m = TRAP_COST_MODEL) {
  const hardware = 2 * m.pipelineRefill + m.entryExit;
  const software = m.handlerInstructions * m.handlerCpi;
  return { hardware, software, total: hardware + software, hardwareShare: hardware / (hardware + software) };
}
