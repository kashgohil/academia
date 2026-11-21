/**
 * The shared RISC-V toolkit of the computer architecture track: RV32IM encodings, an assembler, a functional hart
 * (the golden model), sample programs, and a trace-driven timing model of the classic five-stage pipeline. Every demo
 * that runs RISC-V code uses it, so the track reads one way.
 *
 * What it models: the RV32I base (2.1) and the M extension, as in the RISC-V Unprivileged ISA manual; GNU-style
 * assembly with the standard pseudo-instructions; a little-endian byte-addressed memory; Linux-style ecall exit and
 * write; and the timing of IF ID EX MEM WB with forwarding, hazards, branch handling and optional dual issue.
 *
 * What it does not model: CSRs, privilege modes, trap handlers, interrupts, the F, D, A, C and V extensions, virtual
 * memory, and caches (memory always hits in 1 cycle). The pipeline is a timing model on a correct functional trace:
 * it never computes values, so its timing cannot change a result.
 *
 * Model inputs (not facts about any one core): `mulLatency` (default 1) and `divLatency` (default 20) of the
 * pipeline, its branch predictor and BTB size, and the memory size of the hart (64 KiB).
 *
 * ```ts
 * import { assemble, Hart, pipeline, programById } from "../../sims/arch/rv";
 * const { ok, program, errors } = assemble(programById("sum").source);   // errors: { line, message }[]
 * const hart = new Hart(program);              // { memBytes, stackTop, regs, trace, onInst, allowMisaligned }
 * hart.run();                                  // or hart.step() + hart.snapshot() for steppers
 * hart.exitCode; hart.output; hart.error;      // 31, "", null
 * const r = pipeline(hart.trace, program, { forwarding: "full", branch: { resolve: "EX", predict: "not-taken" } });
 * r.cycles; r.cpi; r.stalls; r.rows;           // rows feed PipelineDiagram in src/demos/arch/ArchViews.tsx
 * ```
 *
 * - isa.ts: `Inst`, `Mnemonic`, `Format`, `encode`, `decode`, `fields` (bit fields for display), `disasm` (with
 *   pseudo-instructions and labels), `REG_ABI`, `parseReg`, `regName`, `classOf`, `srcRegs`, `dstReg`, `immRange`.
 * - asm.ts: `assemble(source, { textBase, dataBase })` → `{ ok, program, errors }`. Text at 0x0, data at 0x1000.
 * - hart.ts: `Hart` with `step`, `run`, `snapshot`, `peek`, `trace` of `DynInst`, `counts` per class, `instret`.
 * - programs.ts: `PROGRAMS` (sum, fib, fact, strlen, memcpy, dot, bubble, list, branchy, hello) with expected results.
 * - pipeline.ts: `pipeline(trace, program, opts)` and the streaming `Pipeline` (push DynInsts from `onInst`, then
 *   finish) for long runs. Its header lists the exact stall and flush rules.
 */
export * from "./isa";
export * from "./asm";
export * from "./hart";
export * from "./programs";
export * from "./pipeline";
