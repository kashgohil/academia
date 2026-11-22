/**
 * The ABI module's sims: struct passing in five conventions (golden: clang LLVM IR via zig cc 0.17.1, and Go 1.25.6
 * assembly), a big struct through a call, ABI compatibility of a header change, and the FFI sims.
 */
import { describe, expect, test } from "vitest";
import {
  CHANGES, CROSSING, argText, bigTrace, breakEven, classify, compareAll, compatTrace, crossCost, retText, strTrace, unwindTrace,
  type ConvId, type FieldKind,
} from "../../src/sims/sys/abi";

/**
 * kinds|intBefore|fpBefore|sysv|aapcs64|win64|rv64, each "argument>return". Argument: registers, "stack", "ref:<reg>",
 * "split:<reg>". Return: registers or "sret". sysv and rv64 use the prefix arguments; aapcs64 and win64 were compiled
 * with the struct as the only argument. Read from `define` lines of clang's IR (-O0) for random structs.
 */
const GOLDEN = [
  "double,double|0|0|xmm0,xmm1>xmm0,xmm1|v0,v1>v0,v1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "double,double,double|0|0|stack>sret|v0,v1,v2>v0,v1,v2|ref:rcx>sret|ref:a0>sret",
  "double,long|0|0|xmm0,rdi>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|fa0,a0>fa0,a0",
  "char,float,double|0|0|rdi,xmm0>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "float,float,float,float|0|0|xmm0,xmm1>xmm0,xmm1|v0,v1,v2,v3>v0,v1,v2,v3|ref:rcx>sret|a0,a1>a0,a1",
  "ptr,long,long|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long double|0|0|stack>st0|v0>v0|rcx>rax|a0,a1>a0,a1",
  "int[3]|0|0|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "float|0|0|xmm0>xmm0|v0>v0|rcx>rax|fa0>fa0",
  "float,int|0|0|rdi>rax|x0>x0|rcx>rax|fa0,a0>fa0,a0",
  "char|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "int,float|0|0|rdi>rax|x0>x0|rcx>rax|a0,fa0>a0,fa0",
  "double[2]|0|0|xmm0,xmm1>xmm0,xmm1|v0,v1>v0,v1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "float[2],float|0|0|xmm0,xmm1>xmm0,xmm1|v0,v1,v2>v0,v1,v2|ref:rcx>sret|a0,a1>a0,a1",
  "char[3]|0|0|rdi>rax|x0>x0|ref:rcx>sret|a0>a0",
  "long double,int|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long,short,char|1|6|rsi,rdx>rax,rdx|x0,x1>x0,x1|rcx>rax|a1,a2>a0,a1",
  "float,float[2],int,ptr|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int[3],short,double,char[3]|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int[3],double|0|1|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int|8|0|stack>rax|x0>x0|rcx>rax|stack>a0",
  "int,short,char,double|7|0|stack>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|split:a7>a0,a1",
  "char,int,char|0|0|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "short,int|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "char|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "char,int|7|6|stack>rax|x0>x0|rcx>rax|a7>a0",
  "double|5|0|xmm0>xmm0|v0>v0|rcx>rax|fa0>fa0",
  "int,ptr|5|0|stack>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a5,a6>a0,a1",
  "float,float[2],char[3]|0|8|stack>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "long,char|5|0|stack>rax,rdx|x0,x1>x0,x1|rcx>rax|a5,a6>a0,a1",
  "double,int,char,double|2|3|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a2>sret",
  "double,char|7|5|stack>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|fa5,a7>fa0,a0",
  "float,double,long,long|6|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a6>sret",
  "char[3],short,ptr|0|3|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "float,float|0|0|xmm0>xmm0|v0,v1>v0,v1|rcx>rax|fa0,fa1>fa0,fa1",
  "double[2]|4|7|stack>xmm0,xmm1|v0,v1>v0,v1|ref:rcx>sret|a4,a5>fa0,fa1",
  "int,float|3|0|rcx>rax|x0>x0|rcx>rax|a3,fa0>a0,fa0",
  "float,float,float|0|6|xmm6,xmm7>xmm0,xmm1|v0,v1,v2>v0,v1,v2|ref:rcx>sret|a0,a1>a0,a1",
  "double,int,short|0|0|xmm0,rdi>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "short,double,double,long|2|2|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a2>sret",
  "long,char,long,char|2|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a2>sret",
  "float,int,int,int|5|3|stack>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a5,a6>a0,a1",
  "long,double|8|3|stack>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|stack>a0,fa0",
  "float,int,int,short|0|0|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "short,double|6|7|stack>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|a6,fa7>a0,fa0",
  "int[3],long|5|5|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a5>sret",
  "char[3]|0|2|rdi>rax|x0>x0|ref:rcx>sret|a0>a0",
  "double[2],ptr,int[3],int|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long,long,int[3],float[2]|6|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a6>sret",
  "float[2],int,short,short|0|0|xmm0,rdi>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "float,double|8|0|xmm0,xmm1>xmm0,xmm1|x0,x1>x0,x1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "char|0|5|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "double|5|0|xmm0>xmm0|v0>v0|rcx>rax|fa0>fa0",
  "ptr|3|0|rcx>rax|x0>x0|rcx>rax|a3>a0",
  "float[2],int,int,char[3]|3|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a3>sret",
  "double,char[3],ptr,ptr|6|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a6>sret",
  "float,short|0|0|rdi>rax|x0>x0|rcx>rax|fa0,a0>fa0,a0",
  "short|5|7|r9>rax|x0>x0|rcx>rax|a5>a0",
  "double[2],long double,char[3]|0|3|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "short,int,float|1|0|rsi,xmm0>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|a1,a2>a0,a1",
  "int,float,short,int|8|6|stack>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|stack>a0,a1",
  "char,float|0|3|rdi>rax|x0>x0|rcx>rax|a0,fa3>a0,fa0",
  "long,short,short,long double|5|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a5>sret",
  "float,double|0|0|xmm0,xmm1>xmm0,xmm1|x0,x1>x0,x1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "int,short,float,char|3|0|rcx,r8>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a3,a4>a0,a1",
  "char|5|0|r9>rax|x0>x0|rcx>rax|a5>a0",
  "char,float|0|0|rdi>rax|x0>x0|rcx>rax|a0,fa0>a0,fa0",
  "int,float|0|0|rdi>rax|x0>x0|rcx>rax|a0,fa0>a0,fa0",
  "float[2],int,char|0|7|xmm7,rdi>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "long,short|0|4|rdi,rsi>rax,rdx|x0,x1>x0,x1|rcx>rax|a0,a1>a0,a1",
  "long,long|0|7|rdi,rsi>rax,rdx|x0,x1>x0,x1|rcx>rax|a0,a1>a0,a1",
  "float,double,short,ptr|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int,char,short,int|0|0|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "double[2],double[2],double[2],short|6|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a6>sret",
  "short,double|0|0|rdi,xmm0>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|a0,fa0>a0,fa0",
  "float,char,double,short|0|3|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "double|0|4|xmm4>xmm0|v0>v0|rcx>rax|fa4>fa0",
  "char[3],double[2],float[2]|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int,float,short|7|4|stack>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|split:a7>a0,a1",
  "char,double[2],short|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int,int|7|0|stack>rax|x0>x0|rcx>rax|a7>a0",
  "long,float,int,int|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long double,int[3]|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int,double,char,short|0|1|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long,float,double|0|2|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "float[2]|5|1|xmm1>xmm0|v0,v1>v0,v1|rcx>rax|fa1,fa2>fa0,fa1",
  "long,char,float,long|0|5|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long|5|6|r9>rax|x0>x0|rcx>rax|a5>a0",
  "double[2]|2|0|xmm0,xmm1>xmm0,xmm1|v0,v1>v0,v1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "int|3|2|rcx>rax|x0>x0|rcx>rax|a3>a0",
  "long double,double|0|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "short,char|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "double,char[3],char|0|0|xmm0,rdi>xmm0,rax|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "float[2],int,char[3],double|0|8|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "short,float,long,char|5|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a5>sret",
  "long double,char[3]|1|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a1>sret",
  "long double,float,double|8|4|stack>sret|ref:x0>sret|ref:rcx>sret|ref:stack>sret",
  "long double|0|0|stack>st0|v0>v0|rcx>rax|a0,a1>a0,a1",
  "int[3]|2|6|rdx,rcx>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a2,a3>a0,a1",
  "long|3|0|rcx>rax|x0>x0|rcx>rax|a3>a0",
  "int,double,long|0|7|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "double[2]|7|0|xmm0,xmm1>xmm0,xmm1|v0,v1>v0,v1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "int,int|1|2|rsi>rax|x0>x0|rcx>rax|a1>a0",
  "ptr,float[2],ptr,double[2]|3|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a3>sret",
  "float|2|3|xmm3>xmm0|v0>v0|rcx>rax|fa3>fa0",
  "char,long,short|0|4|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "short|7|0|stack>rax|x0>x0|rcx>rax|a7>a0",
  "int[3],char[3],ptr,int[3]|6|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a6>sret",
  "int|0|2|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "long|0|3|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "char|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "long,char|1|0|rsi,rdx>rax,rdx|x0,x1>x0,x1|rcx>rax|a1,a2>a0,a1",
  "double,long,long|0|7|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "double[2]|5|0|xmm0,xmm1>xmm0,xmm1|v0,v1>v0,v1|ref:rcx>sret|fa0,fa1>fa0,fa1",
  "short,float,double|0|0|rdi,xmm0>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "char,long double|1|8|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a1>sret",
  "long|0|4|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "short,char,float,int[3]|0|6|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "char[3],int[3],ptr|0|1|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "int|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "float|3|7|xmm7>xmm0|v0>v0|rcx>rax|fa7>fa0",
  "int,char|1|0|rsi>rax|x0>x0|rcx>rax|a1>a0",
  "int[3]|0|0|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "short|0|0|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "int[3],float|3|2|rcx,r8>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a3,a4>a0,a1",
  "int|0|8|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "double[2],float|0|1|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "long,double,long|1|0|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a1>sret",
  "double|7|2|xmm2>xmm0|v0>v0|rcx>rax|fa2>fa0",
  "char|7|2|stack>rax|x0>x0|rcx>rax|a7>a0",
  "char,char,float|7|3|stack>rax|x0>x0|rcx>rax|a7>a0",
  "double,float,float,char|0|5|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
  "float,char,short,int|0|0|rdi,rsi>rax,rdx|x0,x1>x0,x1|ref:rcx>sret|a0,a1>a0,a1",
  "int,char,double|5|0|r9,xmm0>rax,xmm0|x0,x1>x0,x1|ref:rcx>sret|a5,a6>a0,a1",
  "long|0|2|rdi>rax|x0>x0|rcx>rax|a0>a0",
  "float,short,long,int|0|7|stack>sret|ref:x0>sret|ref:rcx>sret|ref:a0>sret",
];

const key = (r: ReturnType<typeof classify>) => {
  const a = r.arg;
  const arg = a.how === "regs" ? a.regs.join(",") : a.how === "stack" ? "stack" : a.how === "ref" ? (a.refOnStack ? "ref:stack" : `ref:${a.regs[0]}`) : a.how === "split" ? `split:${a.regs[0]}` : "none";
  const ret = r.ret.how === "sret" ? "sret" : r.ret.regs.join(",");
  return `${arg}>${ret}`;
};

describe("struct passing matches clang", () => {
  test("136 structs on four C conventions", () => {
    expect(GOLDEN.length).toBe(136);
    for (const row of GOLDEN) {
      const [kinds, ib, fb, ...want] = row.split("|");
      (["sysv", "aapcs64", "win64", "rv64"] as ConvId[]).forEach((conv, i) => {
        const site = conv === "sysv" || conv === "rv64" ? { intBefore: Number(ib), fpBefore: Number(fb) } : { intBefore: 0, fpBefore: 0 };
        expect(key(classify(conv, kinds!.split(",") as FieldKind[], site)), `${conv} ${row}`).toBe(want[i]);
      });
    }
  });
  test("register exhaustion, checked in clang -O2 assembly", () => {
    // AArch64: struct { long a, b; } after 7 longs goes to the stack, x7 stays unused (rule C.13).
    expect(argText(classify("aapcs64", ["long", "long"], { intBefore: 7, fpBefore: 0 }).arg)).toBe("stack");
    // AArch64: an HFA of 3 doubles after 6 doubles goes to the stack (rule C.3).
    expect(argText(classify("aapcs64", ["double", "double", "double"], { intBefore: 0, fpBefore: 6 }).arg)).toBe("stack");
    // RISC-V: struct { long a, b; } after 7 longs: a7 and the stack.
    expect(argText(classify("rv64", ["long", "long"], { intBefore: 7, fpBefore: 0 }).arg)).toBe("a7 + stack");
  });
  test("Go ABIInternal, read from go build -gcflags=-S (go 1.25.6, GOARCH=amd64)", () => {
    const go = (k: FieldKind[], ib = 0) => classify("go", k, { intBefore: ib, fpBefore: 0 });
    expect(argText(go(["double", "double", "double"]).arg)).toBe("X0, X1, X2");
    expect(retText(go(["double", "double", "double"]).ret)).toBe("X0, X1, X2");
    expect(argText(go(["char", "float", "double"]).arg)).toBe("RAX, X0, X1");
    expect(argText(go(["ptr", "long", "long"]).arg)).toBe("RAX, RBX, RCX");
    expect(argText(go(["int[3]"]).arg)).toBe("stack");
    expect(retText(go(["int[3]"]).ret)).toBe("stack");
    expect(argText(go(["ptr", "long", "long"], 8).arg)).toBe("stack"); // only R11 is left
  });
  test("the lesson's Vec3 and demo claims", () => {
    const v3: FieldKind[] = ["double", "double", "double"];
    expect(classify("sysv", v3).layout.size).toBe(24);
    expect(argText(classify("sysv", v3).arg)).toBe("stack");
    expect(retText(classify("sysv", v3).ret)).toBe("memory, address in rdi");
    expect(argText(classify("aapcs64", v3).arg)).toBe("v0, v1, v2");
    expect(argText(classify("win64", v3).arg)).toBe("pointer in rcx");
    expect(argText(classify("rv64", v3).arg)).toBe("pointer in a0");
    expect(argText(classify("sysv", ["double", "double"]).arg)).toBe("xmm0, xmm1");
    expect(argText(classify("win64", ["double", "double"]).arg)).toBe("pointer in rcx");
    expect(argText(classify("sysv", ["char", "float", "double"]).arg)).toBe("rdi, xmm0");
    expect(argText(classify("rv64", ["char", "float", "double"]).arg)).toBe("a0, a1");
    expect(argText(classify("sysv", ["double", "long"], { intBefore: 6, fpBefore: 0 }).arg)).toBe("stack");
  });
});

describe("a big struct through a call", () => {
  const last = <T,>(a: T[]) => a[a.length - 1]!;
  test("bytes copied and registers", () => {
    expect(last(bigTrace("sysv", { field: "double", n: 3 })).copied).toBe(48);
    expect(last(bigTrace("aapcs64", { field: "double", n: 3 })).copied).toBe(0);
    expect(last(bigTrace("win64", { field: "double", n: 3 })).copied).toBe(48);
    expect(last(bigTrace("sysv", { field: "double", n: 2 })).copied).toBe(0);
    const win = bigTrace("win64", { field: "double", n: 3 });
    expect(win.find((s) => s.regs.length === 3)!.regs.map((r) => r[0])).toEqual(["rcx", "rdx", "xmm2"]);
    const arm = bigTrace("aapcs64", { field: "long long", n: 3 });
    expect(arm.find((s) => s.regs.length === 3)!.regs.map((r) => r[0])).toEqual(["x8", "x0", "x1"]);
    expect(bigTrace("aapcs64", { field: "double", n: 3 })[1]!.regs.map((r) => r[0])).toEqual(["v0", "v1", "v2", "v3"]);
    for (const c of ["sysv", "win64", "aapcs64", "rv64"] as const) expect(last(bigTrace(c, { field: "double", n: 3 })).snap.ub).toEqual([]);
  });
});

describe("ABI compatibility of a header change", () => {
  const verdicts = (id: string) => Object.fromEntries(compareAll(CHANGES.find((c) => c.id === id)!).map((d) => [d.target, `${d.verdict} ${d.v1.size}->${d.v2.size}`]));
  test("verdicts per platform", () => {
    expect(verdicts("int64")).toEqual({ "x86_64-linux": "same 32->32", "aarch64-linux": "same 32->32", "x86_64-windows": "breaks 32->32", "i386-linux": "breaks 24->28", "riscv64-linux": "same 32->32", "riscv32-linux": "breaks 32->32" });
    expect(verdicts("append")["x86_64-linux"]).toBe("grows 32->40");
    expect(verdicts("append")["riscv32-linux"]).toBe("same 32->32");
    const ld = compareAll(CHANGES.find((c) => c.id === "ldouble")!);
    expect(ld.filter((d) => d.verdict === "breaks").length).toBe(5);
    expect(ld.find((d) => d.target === "x86_64-windows")!.verdict).toBe("same");
    const st = compareAll(CHANGES.find((c) => c.id === "sizet")!);
    expect(st.filter((d) => d.verdict === "breaks").map((d) => d.target)).toEqual(["x86_64-linux", "aarch64-linux", "x86_64-windows", "riscv64-linux"]);
    expect(compareAll(CHANGES.find((c) => c.id === "rename")!).every((d) => d.verdict === "same")).toBe(true);
    const w = compareAll(CHANGES.find((c) => c.id === "int64")!).find((d) => d.target === "x86_64-windows")!;
    expect(w.moved).toEqual(["count: offset 8 → 8, size 4 → 8"]);
  });
  test("old program, new library", () => {
    const last = (d: "public" | "sized" | "opaque", c: "append" | "insert") => { const t = compatTrace(d, c); return t[t.length - 1]!; };
    const budget = (s: ReturnType<typeof last>) => s.snap.frames.find((f) => f.fn === "main")?.slots.find((x) => x.name === "budget")?.text;
    const pa = last("public", "append");
    expect(pa.read).toBe("1.5");
    expect(budget(pa)).toBe("3");
    expect(pa.snap.ub.map((u) => u.kind)).toEqual(["stack-buffer-overflow"]);
    const pi = last("public", "insert");
    expect(pi.read).toBe("5e-323");
    expect(last("sized", "append").read).toBe("1.5");
    expect(last("sized", "append").snap.ub).toEqual([]);
    expect(last("sized", "insert").read).toBe("5e-323");
    expect(compatTrace("opaque", "insert").find((s) => s.read)!.read).toBe("1.5");
    expect(last("opaque", "append").snap.ub).toEqual([]);
    expect(compatTrace("public", "append")[0]!.appView!.size).toBe(32);
  });
});

describe("FFI", () => {
  test("strings", () => {
    const end = (c: Parameters<typeof strTrace>[0]) => strTrace(c).filter((s) => s.result !== undefined)[0]!;
    expect(end("asptr").result).toBe(7);
    expect(end("asptr").ub!.kind).toBe("global-buffer-overflow");
    expect(end("cstring").result).toBe(5);
    expect(end("cstring").ub).toBeUndefined();
    expect(end("temp").ub!.kind).toBe("heap-use-after-free");
    expect(end("temp").result).toBe(5);
    const leak = strTrace("go-leak");
    expect(leak[leak.length - 1]!.ub!.kind).toBe("memory-leak");
    expect(leak[leak.length - 1]!.ub!.size).toBe(6);
    const ok = strTrace("go-free");
    expect(ok[ok.length - 1]!.snap.ub).toEqual([]);
  });
  test("crossing cost from the measured model inputs", () => {
    expect(CROSSING.go.foreign).toBe(22.8);
    expect(crossCost("go", 10, 1e6).share).toBeCloseTo(0.6951, 3);
    expect(crossCost("go", 10, 1e6).crossing / 1e6).toBeCloseTo(22.8, 6);
    expect(crossCost("go", 10, 1e6, 100).share).toBeCloseTo(0.0223, 3);
    expect(crossCost("python", 10, 1e6).share).toBeCloseTo(0.9383, 3);
    expect(breakEven("go")).toBe(22.8);
    expect(CROSSING.rust.foreign).toBe(CROSSING.rust.native);
  });
  test("unwinding", () => {
    expect(unwindTrace("c").at(-1)!.outcome).toBe("abort");
    expect(unwindTrace("c-unwind").some((s) => s.outcome === "caught")).toBe(true);
    expect(unwindTrace("catch").at(-1)!.snap.ub).toEqual([]);
  });
});
