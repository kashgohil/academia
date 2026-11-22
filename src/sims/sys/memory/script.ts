/**
 * Steppers for this module: a script says, line by line, what a short program does to memory, and `runScript`
 * runs it on the shared abstract machine (src/sims/sys/mem) and keeps one snapshot per step. The machine checks every
 * access, so the UB reports in a step come from the machine, not from the script.
 */
import { Machine, type MachineOptions, type Snapshot, type UbReport } from "../mem";

export interface ScriptStep {
  /** The source line (1-based) that this step runs; 0 before the program starts. */
  line: number;
  caption: string;
  snap: Snapshot;
  /** UB reports that this step made. */
  ub: UbReport[];
}

/** `step(line, caption, run?)`: run one line of the program on the machine. */
export type StepFn = (line: number, caption: string, run?: () => void) => void;

/** Runs `script` on a new machine and returns the first snapshot plus one snapshot per step. */
export function runScript(script: (m: Machine, step: StepFn) => void, opts: MachineOptions = {}, start = "Before the program starts. Press Step."): { steps: ScriptStep[]; machine: Machine } {
  const m = new Machine(opts);
  const steps: ScriptStep[] = [{ line: 0, caption: start, snap: m.snapshot(), ub: [] }];
  const step: StepFn = (line, caption, run) => {
    const before = m.ub.length;
    m.line = line;
    run?.();
    steps.push({ line, caption, snap: m.snapshot(), ub: m.ub.slice(before) });
  };
  script(m, step);
  return { steps, machine: m };
}
