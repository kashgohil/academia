/**
 * Hardware as code: the sims of the hw-design module of the architecture track.
 *
 * - verilog.ts: a lexer, parser and elaborator for a small, documented Verilog subset (one module, wires and regs up
 *   to 32 bits, memories, assign, always @(posedge clk) and always @*, if, case, the common operators, $signed). It
 *   applies the width and sign rules of IEEE 1364-2005 and reports errors with line numbers. Also: latch inference.
 * - rtl.ts: `RtlSim`, a two-phase cycle simulator (settle the combinational logic, then one clock edge with blocking
 *   and nonblocking semantics), and `simulate(src, cycles, stim)` → a waveform.
 * - logic.ts: Quine-McCluskey minimization, K-map layout and two-level gate cost (2 to 4 inputs).
 * - netlist.ts: `synthesize(src, { adder })` → a netlist of 2-input gates and MUXes (structural hashing, constant
 *   folding, ripple or Kogge-Stone adders, barrel shifters, latches as held inputs); `timing` (critical path with
 *   MODEL INPUT gate delays); `evalNet`.
 * - lut.ts: `mapLuts(net, k)`, cut-based depth-oriented mapping to K-input LUTs; `lutTable`, `evalMapped`.
 * - place.ts: a toy FPGA placer (simulated annealing on half-perimeter wire length) with a LUT and wire delay model
 *   (MODEL INPUTS).
 * - core.ts: `CORE_SRC`, a single-cycle RV32I core in the subset; `cosim`, lockstep co-simulation against the hart of
 *   src/sims/arch/rv; `BUGS` to inject; `DIRECTED` tests in the style of riscv-tests.
 */
export * from "./verilog";
export * from "./rtl";
export * from "./logic";
export * from "./netlist";
export * from "./lut";
export * from "./place";
export * from "./core";
export * from "./examples";
