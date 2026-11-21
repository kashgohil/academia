/**
 * A single-cycle RV32I core, written in the Verilog subset of verilog.ts, and a lockstep co-simulation that checks it
 * against the hart of src/sims/arch/rv (the golden model).
 *
 * - CORE_SRC: the core. One instruction per clock: fetch, decode, read registers, compute, access memory and write
 *   back, all in one combinational path, then one clock edge. 64 KiB of memory holds code and data (as in the hart).
 *   It implements RV32I without fence semantics, CSRs or traps; ecall is passed to the testbench, which plays the
 *   kernel (exit and write, as the hart does). An instruction outside RV32I raises the `illegal` output.
 * - The core reports each retired instruction on a trace port (pc, register write, memory write), in the spirit of
 *   RVFI, the RISC-V Formal Interface of riscv-formal. The testbench compares this port with the hart's DynInst after
 *   every instruction and stops at the first difference.
 * - BUGS: realistic one-line mistakes as text edits of CORE_SRC, for the bug-injection demo.
 * - DIRECTED: small self-checking test programs in the style of riscv-tests, with edge values (negative numbers, high
 *   bytes), because the sample programs do not exercise every instruction.
 */
import { assemble, disasm, Hart, PROGRAMS, REG_ABI, type DynInst, type Program } from "../rv";
import { RtlSim } from "./rtl";
import { elaborate, VerilogError, type VError } from "./verilog";

export const CORE_SRC = `// A single-cycle RV32I core. One instruction per clock cycle.
module rv32i(input clk, input rst,
  // trace port: what the instruction of this cycle does
  output [31:0] pc_out, output [31:0] instr_out, output [31:0] pc_wdata,
  output rf_we, output [4:0] rf_rd, output [31:0] rf_wdata,
  output mem_we, output [31:0] mem_addr, output [31:0] mem_wdata, output [3:0] mem_mask,
  output is_ecall, output illegal);

  localparam LUI = 7'b0110111, AUIPC = 7'b0010111, JAL = 7'b1101111,
             JALR = 7'b1100111, BRANCH = 7'b1100011, LOAD = 7'b0000011,
             STORE = 7'b0100011, OPIMM = 7'b0010011, OP = 7'b0110011,
             FENCE = 7'b0001111, SYSTEM = 7'b1110011;

  reg [31:0] pc;
  reg [31:0] mem [0:16383];   // 64 KiB: code and data
  reg [31:0] regs [0:31];     // x0 is never written, so it reads 0

  // ---- fetch and decode
  wire [31:0] instr = mem[pc[15:2]];
  wire [6:0] opcode = instr[6:0];
  wire [4:0] rd = instr[11:7];
  wire [2:0] funct3 = instr[14:12];
  wire [4:0] rs1 = instr[19:15];
  wire [4:0] rs2 = instr[24:20];
  wire [6:0] funct7 = instr[31:25];

  // ---- immediates: the sign bit is always instr[31]
  wire [31:0] imm_i = {{20{instr[31]}}, instr[31:20]};
  wire [31:0] imm_s = {{20{instr[31]}}, instr[31:25], instr[11:7]};
  wire [31:0] imm_b = {{20{instr[31]}}, instr[7], instr[30:25], instr[11:8], 1'b0};
  wire [31:0] imm_u = {instr[31:12], 12'b0};
  wire [31:0] imm_j = {{12{instr[31]}}, instr[19:12], instr[20], instr[30:21], 1'b0};

  // ---- register file read
  wire [31:0] a = regs[rs1];
  wire [31:0] b = regs[rs2];

  // ---- ALU (OP and OP-IMM)
  wire [31:0] op2 = (opcode == OPIMM) ? imm_i : b;
  wire [4:0] shamt = op2[4:0];
  wire [31:0] sra = $signed(a) >>> shamt;
  reg [31:0] alu;
  always @* begin
    case (funct3)
      3'b000: alu = (opcode == OP && funct7[5]) ? a - op2 : a + op2;
      3'b001: alu = a << shamt;
      3'b010: alu = {31'b0, $signed(a) < $signed(op2)};
      3'b011: alu = {31'b0, a < op2};
      3'b100: alu = a ^ op2;
      3'b101: alu = funct7[5] ? sra : a >> shamt;
      3'b110: alu = a | op2;
      default: alu = a & op2;
    endcase
  end

  // ---- branch condition
  reg take;
  always @* begin
    case (funct3)
      3'b000: take = a == b;
      3'b001: take = a != b;
      3'b100: take = $signed(a) < $signed(b);
      3'b101: take = $signed(a) >= $signed(b);
      3'b110: take = a < b;
      3'b111: take = a >= b;
      default: take = 0;
    endcase
  end

  // ---- data memory: loads and stores
  wire [31:0] addr = a + ((opcode == STORE) ? imm_s : imm_i);
  wire [31:0] word = mem[addr[15:2]];
  wire [31:0] shifted = word >> {addr[1:0], 3'b000};
  reg [31:0] load;
  always @* begin
    case (funct3)
      3'b000: load = {{24{shifted[7]}}, shifted[7:0]};     // lb
      3'b001: load = {{16{shifted[15]}}, shifted[15:0]};   // lh
      3'b100: load = {24'b0, shifted[7:0]};                // lbu
      3'b101: load = {16'b0, shifted[15:0]};               // lhu
      default: load = word;                                // lw
    endcase
  end
  wire [3:0] mask = (funct3 == 3'b000) ? 4'b0001 << addr[1:0]
                  : (funct3 == 3'b001) ? 4'b0011 << addr[1:0]
                  : 4'b1111;
  wire [31:0] bytes = {{8{mask[3]}}, {8{mask[2]}}, {8{mask[1]}}, {8{mask[0]}}};
  wire [31:0] wdata = b << {addr[1:0], 3'b000};
  wire store = (opcode == STORE) && !rst;

  // ---- write back
  reg [31:0] wb;
  reg we;
  always @* begin
    we = 1;
    wb = alu;
    case (opcode)
      LUI: wb = imm_u;
      AUIPC: wb = pc + imm_u;
      JAL, JALR: wb = pc + 4;
      LOAD: wb = load;
      OP, OPIMM: wb = alu;
      default: we = 0;
    endcase
  end
  wire wen = we && (rd != 0) && !rst;

  // ---- next pc
  wire [31:0] next_pc = (opcode == JAL) ? pc + imm_j
                      : (opcode == JALR) ? (a + imm_i) & ~32'd1
                      : (opcode == BRANCH && take) ? pc + imm_b
                      : pc + 4;

  // ---- the clock edge: the only place where state changes
  always @(posedge clk) begin
    if (rst) pc <= 0;
    else pc <= next_pc;
    if (wen) regs[rd] <= wb;
    if (store) mem[addr[15:2]] <= (word & ~bytes) | (wdata & bytes);
  end

  // ---- trace port
  assign pc_out = pc;
  assign instr_out = instr;
  assign pc_wdata = next_pc;
  assign rf_we = wen;
  assign rf_rd = rd;
  assign rf_wdata = wb;
  assign mem_we = store;
  assign mem_addr = addr;
  assign mem_wdata = wdata;
  assign mem_mask = mask;
  assign is_ecall = instr == 32'h00000073;
  assign illegal = !(opcode == LUI || opcode == AUIPC || opcode == JAL || opcode == JALR
                  || opcode == BRANCH || opcode == LOAD || opcode == STORE || opcode == OPIMM
                  || opcode == FENCE || opcode == SYSTEM
                  || (opcode == OP && (funct7 == 7'b0000000 || funct7 == 7'b0100000)));
endmodule
`;

export interface Bug {
  id: string;
  title: string;
  /** What the mistake is, in one sentence. */
  about: string;
  find: string;
  replace: string;
}

/** One-line mistakes. Each `find` occurs exactly once in CORE_SRC (a test checks this). */
export const BUGS: Bug[] = [
  {
    id: "imm-i-zero", title: "I-immediate zero-extended",
    about: "The I-type immediate is padded with zeros, so addi x, x, -1 adds 4095.",
    find: "wire [31:0] imm_i = {{20{instr[31]}}, instr[31:20]};", replace: "wire [31:0] imm_i = {20'b0, instr[31:20]};",
  },
  {
    id: "sub-as-add", title: "sub decoded as add",
    about: "The ALU ignores funct7, so sub adds.",
    find: "3'b000: alu = (opcode == OP && funct7[5]) ? a - op2 : a + op2;", replace: "3'b000: alu = a + op2;",
  },
  {
    id: "x0-written", title: "x0 can be written",
    about: "The write enable forgets rd != 0, so jal x0 (the j pseudo-instruction) writes x0.",
    find: "wire wen = we && (rd != 0) && !rst;", replace: "wire wen = we && !rst;",
  },
  {
    id: "imm-b-half", title: "B-immediate without its low 0",
    about: "The branch offset forgets that the encoding drops bit 0, so every taken branch goes half as far.",
    find: "wire [31:0] imm_b = {{20{instr[31]}}, instr[7], instr[30:25], instr[11:8], 1'b0};",
    replace: "wire [31:0] imm_b = {{21{instr[31]}}, instr[7], instr[30:25], instr[11:8]};",
  },
  {
    id: "sb-word", title: "sb writes a whole word",
    about: "The byte mask of sb is 1111, so a byte store also overwrites the 3 other bytes of the word.",
    find: "wire [3:0] mask = (funct3 == 3'b000) ? 4'b0001 << addr[1:0]", replace: "wire [3:0] mask = (funct3 == 3'b000) ? 4'b1111",
  },
  {
    id: "blt-unsigned", title: "blt compares unsigned",
    about: "The $signed casts are missing, so blt treats -1 as 4294967295.",
    find: "3'b100: take = $signed(a) < $signed(b);", replace: "3'b100: take = a < b;",
  },
  {
    id: "lb-zero", title: "lb zero-extends",
    about: "lb pads with zeros, as lbu does, so a byte of 0x80 or more loads as a positive number.",
    find: "3'b000: load = {{24{shifted[7]}}, shifted[7:0]};     // lb", replace: "3'b000: load = {24'b0, shifted[7:0]};                 // lb",
  },
  {
    id: "sra-mixed", title: "sra inside a mixed ?:",
    about: "The arithmetic shift moves into a ?: whose other arm is unsigned, so Verilog makes the whole expression unsigned and >>> shifts in zeros.",
    find: "3'b101: alu = funct7[5] ? sra : a >> shamt;", replace: "3'b101: alu = funct7[5] ? $signed(a) >>> shamt : a >> shamt;",
  },
];

export const withBug = (bugId: string | null, src = CORE_SRC): string => {
  const b = BUGS.find((x) => x.id === bugId);
  return b ? src.replace(b.find, b.replace) : src;
};

/** Directed tests in the style of riscv-tests: each one exits with 0 when every check passes on a correct machine. */
export const DIRECTED: { id: string; title: string; source: string }[] = [
  {
    id: "t-alu", title: "add, sub, addi with negatives",
    source: `_start:
        li   t0, -5
        addi t1, t0, -1        # -6
        li   t2, 7
        sub  t3, t0, t2        # -12
        add  t4, t3, t1        # -18
        addi a0, t4, 18        # 0 if correct
        li   a7, 93
        ecall
`,
  },
  {
    id: "t-slt", title: "slt, sltu, slti, sltiu",
    source: `_start:
        li   t0, -1
        li   t1, 1
        slt  t2, t0, t1        # 1: -1 < 1 signed
        sltu t3, t0, t1        # 0: 0xffffffff > 1 unsigned
        slti t4, t0, 0         # 1
        sltiu t5, t1, -1       # 1: 1 < 0xffffffff
        add  a0, t2, t4
        add  a0, a0, t5
        sub  a0, a0, t3
        addi a0, a0, -3        # 0 if correct
        li   a7, 93
        ecall
`,
  },
  {
    id: "t-shift", title: "sll, srl, sra and immediates",
    source: `_start:
        li   t0, -16           # 0xfffffff0
        srai t1, t0, 2         # -4
        srli t2, t0, 28        # 15
        li   t3, 3
        sll  t4, t3, t3        # 24
        sra  t5, t0, t3        # -2
        add  a0, t1, t5        # -6
        add  a0, a0, t2        # 9
        add  a0, a0, t4        # 33
        addi a0, a0, -33       # 0 if correct
        li   a7, 93
        ecall
`,
  },
  {
    id: "t-branch", title: "blt, bge, bltu, bgeu with negatives",
    source: `_start:
        li   a0, 0
        li   t0, -1
        li   t1, 1
        blt  t0, t1, ok1
        addi a0, a0, 1
ok1:
        bge  t1, t0, ok2
        addi a0, a0, 2
ok2:
        bltu t1, t0, ok3       # 1 < 0xffffffff
        addi a0, a0, 4
ok3:
        bgeu t0, t1, ok4
        addi a0, a0, 8
ok4:
        li   a7, 93            # a0 = 0 if every branch was taken
        ecall
`,
  },
  {
    id: "t-load", title: "lb, lh, lbu, lhu of high bytes",
    source: `        .data
val:    .word 0x8081f0ff
        .text
_start:
        la   t0, val
        lb   t1, 0(t0)         # 0xff -> -1
        lbu  t2, 0(t0)         # 255
        lh   t3, 2(t0)         # 0x8081 -> -32639
        lhu  t4, 2(t0)         # 32897
        add  a0, t1, t2        # 254
        add  t5, t3, t4        # 258
        add  a0, a0, t5        # 512
        addi a0, a0, -512      # 0 if correct
        li   a7, 93
        ecall
`,
  },
  {
    id: "t-store", title: "sb and sh at every offset",
    source: `        .data
buf:    .word 0, 0
        .text
_start:
        la   t0, buf
        li   t1, 0x11
        sb   t1, 1(t0)
        li   t1, 0x2233
        sh   t1, 2(t0)
        li   t1, 0x44
        sb   t1, 4(t0)
        lw   t2, 0(t0)         # 0x22331100
        lw   t3, 4(t0)         # 0x00000044
        li   t4, 0x22331100
        sub  a0, t2, t4
        addi t3, t3, -0x44
        or   a0, a0, t3        # 0 if correct
        li   a7, 93
        ecall
`,
  },
  {
    id: "t-jump", title: "lui, auipc, jal, jalr",
    source: `_start:
        lui  t0, 0x12345       # 0x12345000
        auipc t1, 0            # t1 = this pc (8)
        jal  ra, sub1          # ra = 12
        addi t2, ra, -12       # 0
        li   t3, 0x12345000
        sub  t3, t0, t3        # 0
        addi t1, t1, -4        # auipc was at 4: 0
        or   a0, t2, t3
        or   a0, a0, t1
        li   a7, 93
        ecall
sub1:
        jalr x0, 0(ra)
`,
  },
  {
    id: "t-logic", title: "and, or, xor and immediates",
    source: `_start:
        li   t0, 0x0ff0
        andi t1, t0, -16       # 0x0ff0
        ori  t2, t0, 0x00f     # 0x0fff
        xori t3, t0, -1        # ~0x0ff0
        xor  t4, t3, t0        # -1
        and  t5, t1, t2        # 0x0ff0
        sub  a0, t5, t0        # 0
        addi t4, t4, 1         # 0
        or   a0, a0, t4
        li   a7, 93
        ecall
`,
  },
];

// ---------------------------------------------------------------- co-simulation

export interface TraceRow {
  seq: number;
  pc: number;
  text: string;
  /** The hart: register written (0 = none) and value; store address, size and value. */
  hart: { rd: number; value: number; store: { addr: number; size: number; value: number } | null };
  /** The core's trace port. `we` with rd 0 is a write to x0, which the ISA forbids. */
  core: { we: boolean; rd: number; value: number; store: { addr: number; mask: number; value: number } | null; pc: number; next: number };
  /** The pc after this instruction, by the hart. */
  next: number;
}

export interface Mismatch {
  seq: number;
  pc: number;
  text: string;
  /** Which part of the trace differs. */
  what: "pc" | "next pc" | "register write" | "store" | "illegal";
  expected: string;
  got: string;
}

export interface CosimResult {
  /** Verilog parse or elaboration error. */
  error: VError | null;
  status: "pass" | "mismatch" | "limit" | "hart-error" | "boot";
  retired: number;
  cycles: number;
  mismatch: Mismatch | null;
  exitCode: number | null;
  output: string;
  /** The last rows of the trace, up to and with the mismatch. */
  rows: TraceRow[];
  /** Registers of the core at the end (for the register view). */
  regs: number[];
}

const hex = (v: number) => "0x" + (v >>> 0).toString(16);

/** Load a program into the core's memory, reset it for one cycle, then run it in lockstep with the hart. */
export function cosim(coreSrc: string, program: Program, opts: { maxInsts?: number; keepRows?: number; onStep?: (sim: RtlSim, row: TraceRow) => void } = {}): CosimResult {
  const maxInsts = opts.maxInsts ?? 5000, keep = opts.keepRows ?? 12;
  const base: CosimResult = { error: null, status: "pass", retired: 0, cycles: 0, mismatch: null, exitCode: null, output: "", rows: [], regs: [] };
  let sim: RtlSim;
  try { sim = new RtlSim(elaborate(coreSrc)); } catch (e) {
    if (e instanceof VerilogError) return { ...base, error: { line: e.line, message: e.message } };
    throw e;
  }
  const regsOf = () => Array.from({ length: 32 }, (_, i) => sim.peekMem("regs", i) | 0);
  if (program.entry !== 0) return { ...base, status: "boot", regs: regsOf() };
  try {
    program.words.forEach((w, i) => sim.pokeMem("mem", (program.textBase >>> 2) + i, w));
    const d = program.data;
    for (let i = 0; i < d.length; i += 4) {
      const w = (d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16) | ((d[i + 3] ?? 0) << 24);
      sim.pokeMem("mem", (program.dataBase + i) >>> 2, w >>> 0);
    }
    let last: DynInst | null = null;
    const h = new Hart(program, { onInst: (x) => { last = x; }, trace: false });
    sim.pokeMem("regs", 2, h.regs[2]!); // sp, as the hart starts it (a boot ROM would do this)
    sim.set("rst", 1); sim.settle(); sim.edge(); sim.set("rst", 0);
    let cycles = 1;
    const rows: TraceRow[] = [];
    let output = "";
    for (let n = 0; n < maxInsts; n++) {
      sim.settle();
      last = null;
      const running = h.step();
      const di = last as DynInst | null;
      if (!di) return { ...base, status: "hart-error", retired: n, cycles, rows, output, regs: regsOf(), mismatch: null };
      const g = (s: string) => sim.get(s);
      const core = {
        pc: g("pc_out"),
        next: g("pc_wdata"),
        we: g("rf_we") === 1,
        rd: g("rf_we") ? g("rf_rd") : 0,
        value: g("rf_wdata"),
        store: g("mem_we") ? { addr: g("mem_addr"), mask: g("mem_mask"), value: g("mem_wdata") } : null,
      };
      const isStore = di.cls === "store";
      const hs = isStore ? { addr: di.memAddr!, size: di.memSize!, value: di.result >>> 0 } : null;
      const row: TraceRow = {
        seq: di.seq, pc: di.pc, next: di.nextPc, text: disasm(di.inst, di.pc, { pseudo: true }),
        hart: { rd: di.cls === "system" ? 0 : di.rd, value: di.result >>> 0, store: hs }, core: { ...core, store: core.store },
      };
      rows.push(row);
      if (rows.length > keep) rows.shift();
      opts.onStep?.(sim, row);
      const mm = compare(row, g("illegal") === 1);
      if (mm) return { ...base, status: "mismatch", retired: n, cycles, mismatch: mm, rows, output, regs: regsOf(), exitCode: null };
      // ecall: the testbench is the kernel. The hart has done the same work.
      let exited = false, wrote = -1;
      if (g("is_ecall")) {
        const a7 = sim.peekMem("regs", 17);
        if (a7 === 93) exited = true;
        else if (a7 === 64) {
          const fd = sim.peekMem("regs", 10), buf = sim.peekMem("regs", 11), len = sim.peekMem("regs", 12);
          const bytes: number[] = [];
          for (let k = 0; k < len; k++) bytes.push((sim.peekMem("mem", (buf + k) >>> 2) >>> (8 * ((buf + k) & 3))) & 0xff);
          if (fd === 1 || fd === 2) output += new TextDecoder().decode(new Uint8Array(bytes));
          wrote = len;
        }
      }
      sim.edge(); cycles++;
      if (wrote >= 0) sim.pokeMem("regs", 10, wrote); // write returns the length in a0
      if (exited || !running) {
        return { ...base, status: h.status === "error" ? "hart-error" : "pass", retired: n + 1, cycles, rows, output, regs: regsOf(), exitCode: sim.peekMem("regs", 10) | 0 };
      }
    }
    return { ...base, status: "limit", retired: maxInsts, cycles, rows, output, regs: regsOf() };
  } catch (e) {
    if (e instanceof VerilogError) return { ...base, error: { line: e.line, message: e.message } };
    throw e;
  }
}

function compare(r: TraceRow, illegal: boolean): Mismatch | null {
  const at = { seq: r.seq, pc: r.pc, text: r.text };
  if (r.core.pc !== r.pc) return { ...at, what: "pc", expected: hex(r.pc), got: hex(r.core.pc) };
  if (illegal) return { ...at, what: "illegal", expected: "a legal RV32I instruction", got: "the core raised illegal" };
  if (r.core.next !== r.next && !r.text.startsWith("ecall")) return { ...at, what: "next pc", expected: hex(r.next), got: hex(r.core.next) };
  const want = r.hart.rd ? `${REG_ABI[r.hart.rd]} = ${r.hart.value | 0}` : "no register write";
  const got = !r.core.we ? "no register write" : r.core.rd ? `${REG_ABI[r.core.rd]} = ${r.core.value | 0}` : `zero = ${r.core.value | 0} (a write to x0)`;
  const coreRd = r.core.we ? r.core.rd : -1, hartRd = r.hart.rd || -1;
  if (coreRd !== hartRd || (hartRd > 0 && r.hart.value !== r.core.value >>> 0)) return { ...at, what: "register write", expected: want, got };
  const hs = r.hart.store, cs = r.core.store;
  if (!hs && !cs) return null;
  const off = hs ? hs.addr & 3 : 0;
  const hMask = hs ? (((1 << hs.size) - 1) << off) & 0xf : 0;
  const hVal = hs ? (hs.value * 2 ** (8 * off)) % 2 ** 32 : 0;
  const bytes = (m: number) => [0, 1, 2, 3].filter((k) => (m >> k) & 1);
  const pick = (v: number, m: number) => bytes(m).reduce((t, k) => t + ((v >>> (8 * k)) & 0xff) * 2 ** (8 * k), 0);
  const okStore = !!hs && !!cs && (hs.addr & ~3) === (cs.addr & ~3) && hMask === cs.mask && pick(hVal, hMask) === pick(cs.value, cs.mask);
  if (okStore) return null;
  const desc = (addr: number, m: number, v: number) => `bytes ${bytes(m).map((k) => hex((addr & ~3) + k)).join(" ")} = ${bytes(m).map((k) => ((v >>> (8 * k)) & 0xff).toString(16).padStart(2, "0")).join(" ")}`;
  return {
    ...at, what: "store",
    expected: hs ? desc(hs.addr, hMask, hVal) : "no store",
    got: cs ? desc(cs.addr, cs.mask, cs.value) : "no store",
  };
}

/** The sample programs that use only RV32I (the core has no M extension). */
export const RV32I_PROGRAMS = PROGRAMS.filter((p) => {
  const a = assemble(p.source);
  return a.ok && a.program.insts.every((i) => !["mul", "mulh", "mulhsu", "mulhu", "div", "divu", "rem", "remu"].includes(i.op));
});

export interface MatrixCell { id: string; title: string; kind: "program" | "directed"; status: CosimResult["status"]; retired: number; mismatch: Mismatch | null }

/** Run one test (a sample program or a directed test) on the core with an optional bug. */
export function runTest(id: string, bugId: string | null, coreSrc = CORE_SRC): MatrixCell & { result: CosimResult } {
  const p = RV32I_PROGRAMS.find((x) => x.id === id);
  const t = DIRECTED.find((x) => x.id === id);
  const src = p ? p.source : t!.source;
  const a = assemble(src);
  if (!a.ok) throw new Error(`${id} does not assemble: ${a.errors[0]?.message}`);
  const result = cosim(withBug(bugId, coreSrc), a.program);
  return { id, title: p ? p.title : t!.title, kind: p ? "program" : "directed", status: result.status, retired: result.retired, mismatch: result.mismatch, result };
}

export const ALL_TESTS = [...RV32I_PROGRAMS.map((p) => p.id), ...DIRECTED.map((t) => t.id)];

/** One cycle of the core, for the stepper: the trace port, the decode fields and the registers before the edge. */
export interface CoreCycle {
  pc: number;
  instr: number;
  text: string;
  sig: Record<string, number>;
  regs: number[];
}

/** The signals the stepper shows, in order. */
export const CORE_VIEW_SIGNALS = ["pc_out", "instr_out", "opcode", "rd", "rs1", "rs2", "a", "b", "imm_i", "alu", "addr", "wb", "rf_we", "next_pc", "mem_we"];

/** Run the core (no bug) on a program and keep every cycle, up to `max` instructions. */
export function traceCore(program: Program, max = 400, coreSrc = CORE_SRC): { result: CosimResult; cycles: CoreCycle[] } {
  const cycles: CoreCycle[] = [];
  const result = cosim(coreSrc, program, {
    maxInsts: max,
    onStep: (sim, row) => {
      const sig: Record<string, number> = {};
      for (const n of CORE_VIEW_SIGNALS) sig[n] = sim.get(n);
      cycles.push({ pc: row.pc, instr: sim.get("instr_out"), text: row.text, sig, regs: Array.from({ length: 32 }, (_, i) => sim.peekMem("regs", i) | 0) });
    },
  });
  return { result, cycles };
}
