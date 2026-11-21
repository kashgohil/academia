/**
 * The datapath module of the architecture track: RV32IM built from units and wires.
 *
 * - control.ts: the ALU (with the flags Z N V C), branch logic, the immediate generator (and its wiring as data, for
 *   the multiplexer-cost comparison), the main decoder of the single-cycle machine as an editable truth table, the
 *   ALU decoder (with switchable design mistakes), and the size of the control as ROMs.
 * - machine.ts: the architectural state both machines share, loaded exactly as the hart loads a program.
 * - single.ts: `SingleCycle`, one instruction per clock, with the value of every wire; the unit graph (`inputsOf`)
 *   and the wires an instruction uses (`liveEdges`).
 * - multi.ts: `MultiCycle`, an FSM over IF, ID, EX, MEM, WB-like states that reuses one memory and one ALU; the same
 *   FSM as a microprogram (`MICROCODE`, `microcodeSize`).
 * - timing.ts: MODEL INPUT delays per unit, the critical path of each instruction class, both clocks, and the iron law.
 *
 * ```ts
 * import { SingleCycle, MultiCycle, ironLaw, mixOf } from "../../sims/arch/datapath";
 * const m = new SingleCycle(program);          // { table, bugs } break the control
 * m.step(); m.wires;                           // the value on every wire of that cycle
 * const t = ironLaw(mixOf(hart.trace));        // single vs multi-cycle time, in ps
 * ```
 * Tests: tests/unit/arch-datapath.test.ts runs both machines in lockstep with the hart on every sample program.
 */
export * from "./control";
export * from "./machine";
export * from "./single";
export * from "./multi";
export * from "./timing";
export * from "./compare";
