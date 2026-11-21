/**
 * Lockstep comparison of a datapath machine with the hart (the golden model): after each instruction, compare the
 * status, the next PC, all 32 registers, the store (address, size, value) and the output. The first difference is
 * reported with the instruction that caused it. A demo uses this to show what a broken control bit does.
 */
import { disasm, Hart, REG_ABI, type HartError, type HartStatus, type Program } from "../rv";
import type { StoreRecord } from "./machine";

/** What a machine must offer to be compared. Both SingleCycle and MultiCycle do. */
export interface Comparable {
  pc: number;
  regs: Int32Array;
  status: HartStatus;
  error: HartError | null;
  exitCode: number | null;
  output: string;
  lastStore: StoreRecord | null;
  step(): boolean;
}

export interface Divergence {
  /** Instructions completed before the bad one. */
  seq: number;
  pc: number;
  /** The instruction as the hart ran it. */
  text: string;
  /** What differs, in a few words: "a0", "next pc", "store", "status", "output". */
  what: string;
  expected: string;
  got: string;
}

export interface CompareResult {
  ok: boolean;
  /** Instructions compared. */
  steps: number;
  /** "timeout" when both machines still ran after maxSteps. */
  end: HartStatus | "timeout";
  div: Divergence | null;
  exitCode: number | null;
  expectedExit: number | null;
}

const h32 = (v: number) => `0x${(v >>> 0).toString(16)}`;
const st = (s: StoreRecord | null) => (s ? `${s.size} byte${s.size > 1 ? "s" : ""} of ${s.value} at ${h32(s.addr)}` : "no store");
const statusText = (s: HartStatus, e: HartError | null, exit: number | null) =>
  s === "error" ? `trap (${e?.message ?? "?"})` : s === "exited" ? `exit(${exit})` : s;

export function compareWithHart(program: Program, machine: Comparable, maxSteps = 5000): CompareResult {
  let last: { pc: number; text: string; store: StoreRecord | null } | null = null;
  const hart = new Hart(program, {
    trace: false,
    onInst: (d) => {
      last = { pc: d.pc, text: disasm(d.inst, d.pc, { pseudo: true }), store: d.cls === "store" ? { addr: d.memAddr!, size: d.memSize!, value: d.result } : null };
    },
  });
  const done = (div: Divergence | null, steps: number, end: HartStatus | "timeout"): CompareResult =>
    ({ ok: div === null && end !== "timeout", steps, end, div, exitCode: machine.exitCode, expectedExit: hart.exitCode });
  for (let i = 0; i < maxSteps; i++) {
    const pc = hart.pc;
    last = null;
    hart.step();
    machine.step();
    const L = last as { pc: number; text: string; store: StoreRecord | null } | null;
    const text = L?.text ?? disasm(hart.peek(pc), pc, { pseudo: true });
    const div = (what: string, expected: string, got: string): CompareResult => done({ seq: i, pc, text, what, expected, got }, i + 1, machine.status);
    if (hart.status !== machine.status || (hart.status === "error" && hart.error?.kind !== machine.error?.kind)) {
      return div("status", statusText(hart.status, hart.error, hart.exitCode), statusText(machine.status, machine.error, machine.exitCode));
    }
    if (hart.status === "error") return done(null, i + 1, "error");
    const ms = machine.lastStore;
    const hs = L?.store ?? null;
    if ((hs === null) !== (ms === null) || (hs && ms && (hs.addr !== ms.addr || hs.size !== ms.size || hs.value !== ms.value))) return div("store", st(hs), st(ms));
    for (let r = 1; r < 32; r++) if (hart.regs[r] !== machine.regs[r]) return div(REG_ABI[r]!, String(hart.regs[r]), String(machine.regs[r]));
    if (hart.output !== machine.output) return div("output", JSON.stringify(hart.output), JSON.stringify(machine.output));
    if (hart.status !== "running") {
      if (hart.exitCode !== machine.exitCode) return div("exit code", String(hart.exitCode), String(machine.exitCode));
      return done(null, i + 1, hart.status);
    }
    if (hart.pc !== machine.pc) return div("next pc", h32(hart.pc), h32(machine.pc));
  }
  return done(null, maxSteps, "timeout");
}
