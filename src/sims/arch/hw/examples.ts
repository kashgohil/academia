/**
 * Example designs in the Verilog subset, each with the inputs that a demo drives (the clock is implicit).
 */
import type { Stimulus } from "./rtl";

export interface Example {
  id: string;
  title: string;
  about: string;
  source: string;
  stim: Stimulus;
}

/** Input bits for the sequence detector: the pattern 1011 appears at cycles 4 and 7 (overlapping) and 14. */
export const DETECT_BITS = [0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

export const EXAMPLES: Example[] = [
  {
    id: "counter",
    title: "Counter",
    about: "A register that adds 1 on every clock edge, with a synchronous reset and an enable.",
    source: `// A 4-bit counter with a synchronous reset and an enable.
module counter(input clk, input rst, input en,
               output reg [3:0] q, output wrap);
  always @(posedge clk)
    if (rst) q <= 4'd0;
    else if (en) q <= q + 4'd1;

  // combinational: true in the cycle before q goes back to 0
  assign wrap = en && (q == 4'd15);
endmodule
`,
    stim: (t) => ({ rst: t === 0 ? 1 : 0, en: t >= 6 && t <= 8 ? 0 : 1 }),
  },
  {
    id: "lfsr",
    title: "LFSR",
    about: "A shift register whose new bit is the XOR of two old bits: a cheap pseudo-random sequence.",
    source: `// A 4-bit linear-feedback shift register (taps 4 and 3).
// From any non-zero seed it visits all 15 non-zero states.
module lfsr(input clk, input rst, output reg [3:0] s, output out);
  wire fb = s[3] ^ s[2];
  always @(posedge clk)
    if (rst) s <= 4'b0001;
    else s <= {s[2:0], fb};
  assign out = s[3];
endmodule
`,
    stim: (t) => ({ rst: t === 0 ? 1 : 0 }),
  },
  {
    id: "detect",
    title: "FSM: detect 1011",
    about: "A Moore state machine: a state register, next-state logic, and an output that depends only on the state.",
    source: DETECT_SRC(),
    stim: (t) => ({ rst: t === 0 ? 1 : 0, din: DETECT_BITS[t] ?? 0 }),
  },
  {
    id: "swap",
    title: "Swap two registers",
    about: "Two nonblocking assignments that exchange a and b on every edge.",
    source: swapSrc("<=", "one"),
    stim: (t) => ({ rst: t === 0 ? 1 : 0 }),
  },
];

function DETECT_SRC() {
  return `// Moore machine: found is 1 for one cycle after the input was 1, 0, 1, 1.
module detect(input clk, input rst, input din, output found,
              output [2:0] st);
  localparam IDLE = 3'd0, S1 = 3'd1, S10 = 3'd2, S101 = 3'd3, S1011 = 3'd4;
  reg [2:0] state;
  reg [2:0] next;

  // next-state logic: combinational
  always @* begin
    case (state)
      IDLE:    next = din ? S1    : IDLE;
      S1:      next = din ? S1    : S10;
      S10:     next = din ? S101  : IDLE;
      S101:    next = din ? S1011 : S10;
      S1011:   next = din ? S1    : S10;
      default: next = IDLE;
    endcase
  end

  // the state register: the only flip-flops
  always @(posedge clk)
    if (rst) state <= IDLE;
    else state <= next;

  assign found = state == S1011;
  assign st = state;
endmodule
`;
}

export const DETECT_STATES = ["IDLE", "S1", "S10", "S101", "S1011"];
/** The next state for each state and input bit (the table that the case statement encodes). */
export const DETECT_NEXT: [number, number][] = [[0, 1], [2, 1], [0, 3], [2, 4], [2, 1]];

/** The swap in four variants: assignment operator, and one block or two blocks. */
export function swapSrc(op: "<=" | "=", layout: "one" | "two"): string {
  const reset = `if (rst) begin a ${op} 4'd1; b ${op} 4'd2; end`;
  if (layout === "one") {
    return `module swap(input clk, input rst, output reg [3:0] a, output reg [3:0] b);
  always @(posedge clk)
    ${reset}
    else begin
      a ${op} b;
      b ${op} a;
    end
endmodule
`;
  }
  return `module swap(input clk, input rst, output reg [3:0] a, output reg [3:0] b);
  always @(posedge clk)
    if (rst) a ${op} 4'd1;
    else a ${op} b;
  always @(posedge clk)
    if (rst) b ${op} 4'd2;
    else b ${op} a;
endmodule
`;
}

/** The latch example of the synthesis lesson: an if/else-if chain with no final else. */
export function latchSrc(withDefault: boolean): string {
  return `module pick(input [1:0] sel, input [1:0] a, input [1:0] b,
            output reg [1:0] y);
  always @* begin
${withDefault ? "    y = 2'd0;              // a default: every path assigns y\n" : ""}    if (sel == 2'd0) y = a;
    else if (sel == 2'd1) y = b;
    // sel = 2 or 3: no assignment${withDefault ? " here, but y has its default" : ", so y keeps its old value"}
  end
endmodule
`;
}
export const latchStim: Stimulus = (t) => ({ sel: [0, 1, 2, 3, 0, 2, 1, 3, 0, 1, 2, 2][t % 12]!, a: [1, 2, 3, 0, 2, 1, 3, 2, 3, 0, 1, 2][t % 12]!, b: [2, 3, 1, 1, 0, 3, 2, 0, 1, 2, 3, 0][t % 12]! });

/** Small combinational designs for the gate and LUT views. */
export const COMB_DESIGNS: { id: string; title: string; source: string }[] = [
  {
    id: "add4", title: "4-bit adder",
    source: `module add4(input [3:0] a, input [3:0] b, output [3:0] s, output c);
  assign {c, s} = a + b;
endmodule
`,
  },
  {
    id: "mux4", title: "4-to-1 mux, 2 bits",
    source: `module mux4(input [1:0] sel, input [1:0] a, input [1:0] b,
            input [1:0] c, input [1:0] d, output reg [1:0] y);
  always @* begin
    case (sel)
      2'd0: y = a;
      2'd1: y = b;
      2'd2: y = c;
      default: y = d;
    endcase
  end
endmodule
`,
  },
  {
    id: "cmp4", title: "4-bit compare",
    source: `module cmp4(input [3:0] a, input [3:0] b, output lt, output eq);
  assign lt = a < b;
  assign eq = a == b;
endmodule
`,
  },
  {
    id: "parity8", title: "8-bit parity",
    source: `module parity8(input [7:0] d, output p);
  assign p = ^d;
endmodule
`,
  },
  {
    id: "add8", title: "8-bit adder",
    source: `module add8(input [7:0] a, input [7:0] b, output [7:0] s, output c);
  assign {c, s} = a + b;
endmodule
`,
  },
];
