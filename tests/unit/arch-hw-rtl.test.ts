import { describe, expect, test } from "vitest";
import { elaborate } from "../../src/sims/arch/hw/verilog";
import { RtlSim, simulate } from "../../src/sims/arch/hw/rtl";

const col = (r: ReturnType<typeof simulate>, name: string) => {
  const i = r.wave!.signals.findIndex((s) => s.name === name);
  return r.wave!.values[i]!;
};

describe("Verilog subset: parser and elaborator", () => {
  test("errors carry line numbers", () => {
    const r = simulate("module m(input a, output y);\n  assign y = a +;\nendmodule", 1);
    expect(r.ok).toBe(false);
    expect(r.error!.line).toBe(2);
    const d = simulate("module m(input clk, output reg q);\n\n  always @(posedge clk) q <= #1 ~q;\nendmodule", 1);
    expect(d.error!.line).toBe(3);
    expect(d.error!.message).toMatch(/delay/);
    expect(simulate("module m(input a, output y);\n  initial y = 0;\nendmodule", 1).error!.message).toMatch(/initial/);
    expect(simulate("module m(input a, output y);\n  assign y = a;\n  assign y = ~a;\nendmodule", 1).error!.message).toMatch(/two drivers/);
    expect(simulate("module m(input a, output y);\n  always @* y = a;\nendmodule", 1).error!.message).toMatch(/wire/);
  });

  test("context width: the carry of {c, s} = a + b is kept", () => {
    const r = simulate(`module m(input [3:0] a, input [3:0] b, output [3:0] s, output c);
  assign {c, s} = a + b;
endmodule`, 1, () => ({ a: 9, b: 8 }));
    expect(col(r, "s")[0]).toBe(1);
    expect(col(r, "c")[0]).toBe(1);
  });

  test("signedness: $signed compare, arithmetic shift, sign extension", () => {
    const r = simulate(`module m(input [7:0] a, input [7:0] b, output lt_u, output lt_s, output [7:0] sra, output [15:0] sx, output [15:0] zx);
  assign lt_u = a < b;
  assign lt_s = $signed(a) < $signed(b);
  assign sra = $signed(a) >>> 2;
  assign sx = {{8{a[7]}}, a};
  assign zx = a;
endmodule`, 1, () => ({ a: 0xf0, b: 0x10 }));
    expect(col(r, "lt_u")[0]).toBe(0);
    expect(col(r, "lt_s")[0]).toBe(1);
    expect(col(r, "sra")[0]).toBe(0xfc);
    expect(col(r, "sx")[0]).toBe(0xfff0);
    expect(col(r, "zx")[0]).toBe(0x00f0);
  });

  test("a mixed signed and unsigned expression is unsigned", () => {
    // -1 is signed, a is unsigned: the compare is unsigned, so 32'hFFFFFFFF > a.
    const r = simulate("module m(input [7:0] a, output y);\n  assign y = a < -1;\nendmodule", 1, () => ({ a: 5 }));
    expect(col(r, "y")[0]).toBe(1);
  });

  test("latch inference is reported", () => {
    const d = elaborate(`module m(input en, input d, output reg q);
  always @* if (en) q = d;
endmodule`);
    expect(d.warnings.some((w) => /latch inferred for q/.test(w.message))).toBe(true);
    const ok = elaborate(`module m(input en, input d, output reg q);
  always @* begin q = 0; if (en) q = d; end
endmodule`);
    expect(ok.warnings.length).toBe(0);
  });
});

describe("RTL simulator", () => {
  test("a counter with synchronous reset", () => {
    const r = simulate(`module counter(input clk, input rst, output reg [3:0] q);
  always @(posedge clk)
    if (rst) q <= 0;
    else q <= q + 1;
endmodule`, 20, (t) => ({ rst: t === 0 ? 1 : 0 }));
    expect(r.ok).toBe(true);
    expect(col(r, "q").slice(0, 6)).toEqual([0, 0, 1, 2, 3, 4]);
    expect(col(r, "q")[17]).toBe(0); // wraps at 16
  });

  test("the swap: <= swaps, = copies", () => {
    const src = (op: string) => `module swap(input clk, input rst, output reg [3:0] a, output reg [3:0] b);
  always @(posedge clk)
    if (rst) begin a ${op} 1; b ${op} 2; end
    else begin a ${op} b; b ${op} a; end
endmodule`;
    const nb = simulate(src("<="), 4, (t) => ({ rst: t === 0 ? 1 : 0 }));
    expect(col(nb, "a")).toEqual([0, 1, 2, 1]);
    expect(col(nb, "b")).toEqual([0, 2, 1, 2]);
    const bl = simulate(src("="), 4, (t) => ({ rst: t === 0 ? 1 : 0 }));
    expect(col(bl, "a")).toEqual([0, 1, 2, 2]);
    expect(col(bl, "b")).toEqual([0, 2, 2, 2]);
  });

  test("combinational order does not matter; settling is one pass", () => {
    const fwd = `module m(input [3:0] a, output [3:0] y);\n  wire [3:0] t;\n  assign t = a + 1;\n  assign y = t + 1;\nendmodule`;
    const rev = `module m(input [3:0] a, output [3:0] y);\n  wire [3:0] t;\n  assign y = t + 1;\n  assign t = a + 1;\nendmodule`;
    expect(col(simulate(fwd, 1, () => ({ a: 3 })), "y")[0]).toBe(5);
    expect(col(simulate(rev, 1, () => ({ a: 3 })), "y")[0]).toBe(5);
  });

  test("a combinational loop that oscillates is an error", () => {
    const r = simulate("module m(input a, output y);\n  wire t;\n  assign t = ~y;\n  assign y = t;\nendmodule", 1);
    expect(r.ok).toBe(false);
    expect(r.error!.message).toMatch(/combinational loop/);
  });

  test("memories: write on the edge, read combinationally", () => {
    const d = elaborate(`module ram(input clk, input we, input [3:0] addr, input [7:0] wd, output [7:0] rd);
  reg [7:0] mem [0:15];
  always @(posedge clk) if (we) mem[addr] <= wd;
  assign rd = mem[addr];
endmodule`);
    const s = new RtlSim(d);
    s.set("we", 1); s.set("addr", 3); s.set("wd", 0xab); s.settle();
    expect(s.get("rd")).toBe(0);
    s.edge();
    expect(s.get("rd")).toBe(0xab);
    expect(s.peekMem("mem", 3)).toBe(0xab);
  });

  test("case with default and a part-select write", () => {
    const r = simulate(`module m(input [1:0] s, output reg [7:0] y);
  always @* begin
    y = 8'h00;
    case (s)
      2'd0: y[3:0] = 4'hA;
      2'd1, 2'd2: y = 8'h55;
      default: y = 8'hFF;
    endcase
  end
endmodule`, 4, (t) => ({ s: t }));
    expect(col(r, "y")).toEqual([0x0a, 0x55, 0x55, 0xff]);
  });
});
