/**
 * Small helpers on top of the shared RISC-V toolkit: assemble a source, run it on the hart (the golden model) and
 * time it with the shared five-stage pipeline model. Also the code snippets that the pipelining lessons show.
 */
import { assemble, Hart, pipeline, type DynInst, type PipelineOptions, type PipelineResult, type Program } from "../rv";

export interface Run {
  ok: boolean;
  program: Program;
  trace: DynInst[];
  hart: Hart | null;
  errors: { line: number; message: string }[];
}

/** Assemble and run a source to its end (exit, ebreak or a trap), keeping the trace. */
export function runSource(source: string, maxSteps = 200_000): Run {
  const a = assemble(source);
  if (!a.ok) return { ok: false, program: a.program, trace: [], hart: null, errors: a.errors };
  const hart = new Hart(a.program);
  hart.run({ maxSteps });
  return { ok: hart.error === null, program: a.program, trace: hart.trace, hart, errors: [] };
}

/** Assemble, run and time a source. Throws on an assembly error or a trap (for sims and tests with fixed code). */
export function timeSource(source: string, opts: PipelineOptions = {}): PipelineResult & { run: Run } {
  const run = runSource(source);
  if (!run.ok) throw new Error(run.errors[0]?.message ?? run.hart?.error?.message ?? "run failed");
  return { ...pipeline(run.trace, run.program, opts), run };
}

/** Cycles that are not the ideal 1 per instruction, as a share of each instruction: CPI - 1 without the fill time. */
export const stallCpi = (r: PipelineResult) => (r.retired ? (r.cycles - 4 - r.retired) / r.retired : 0);

/** n independent instructions, then ebreak: the ideal pipeline. */
export const independent = (n: number) =>
  Array.from({ length: n - 1 }, (_, i) => `addi a${i % 6}, zero, ${i + 1}`).join("\n") + "\nebreak\n";

/** A counted loop of n iterations with a bnez back-edge: the control-hazards example. */
export const loopSource = (n: number) => `_start:
        li   t1, ${n}
        li   a0, 0
loop:
        addi a0, a0, 3
        addi t1, t1, -1
        bnez t1, loop
        addi a1, a0, 1
        ebreak
`;
