/**
 * Where a struct argument and a struct result live during a call: a step trace on the shared memory machine.
 *
 *   struct D3 { double x, y, z; };                  // also D2 (x, y), L3 and L2 with long long fields
 *   struct D3 scale(struct D3 v, double k) { v.x *= k; v.y *= k; v.z *= k; return v; }
 *   int main(void) { struct D3 a = {1, 2, 3}; struct D3 r = scale(a, 2); }
 *
 * The machine (src/sims/sys/mem) has stack frames but no registers, so each step also lists the argument registers
 * as text. Memory that a convention needs is a local of main: the outgoing stack-argument area (System V), or the
 * caller's temporary copy (Microsoft x64, AAPCS64, RISC-V). The callee's own frame holds its spilled register
 * arguments, as at -O0. The hidden result pointer is the local `ret` of scale.
 *
 * Which convention does what comes from callconv.ts (checked against clang); this file only plays it out. A real
 * compiler at -O2 keeps more in registers and may write the result straight into r (copy elision), but the places and
 * the bytes copied are the ones the psABIs require. `copied` counts the bytes that the caller copies for the argument
 * and the bytes that the callee writes through the result pointer.
 */
import { Machine, T, struct, type Snapshot, type Ptr } from "../mem";
import { classify, FIELD_NAMES, type Chunk, type ConvId } from "./callconv";

export type BigConv = Extract<ConvId, "sysv" | "win64" | "aapcs64" | "rv64">;
export const BIG_CONVS: BigConv[] = ["sysv", "win64", "aapcs64", "rv64"];

export interface BigStep {
  /** The source line now running (index into BIG_SOURCE lines). */
  line: number;
  text: string;
  snap: Snapshot;
  /** Argument and result registers: name → value text. */
  regs: [string, string][];
  /** Bytes copied to memory so far for the argument and the result. */
  copied: number;
}

export type BigField = "double" | "long long";
export interface BigShape { field: BigField; n: 2 | 3 }

const tname = (sh: BigShape) => `${sh.field === "double" ? "D" : "L"}${sh.n}`;

export const bigSource = (sh: BigShape) => [
  `struct ${tname(sh)} { ${sh.field} x, y${sh.n === 3 ? ", z" : ""}; };`,
  `struct ${tname(sh)} scale(struct ${tname(sh)} v, ${sh.field} k) {`,
  `  v.x *= k; v.y *= k;${sh.n === 3 ? " v.z *= k;" : ""}`,
  "  return v;",
  "}",
  "int main(void) {",
  `  struct ${tname(sh)} a = {1, 2${sh.n === 3 ? ", 3" : ""}};`,
  `  struct ${tname(sh)} r = scale(a, 2);`,
  "}",
];

const hx = (p: Ptr) => "0x" + p.addr.toString(16);

/** The register that carries k, the argument after the struct. */
function kRegister(conv: BigConv, sh: BigShape, sret: boolean, used: string[]): string {
  const fp = sh.field === "double";
  const isFp = (r: string) => /^(xmm|v|fa)/.test(r);
  const nf = used.filter(isFp).length, ni = used.length - nf;
  switch (conv) {
    case "sysv": return fp ? `xmm${nf}` : ["rdi", "rsi", "rdx", "rcx", "r8", "r9"][(sret ? 1 : 0) + ni]!;
    case "win64": { const pos = (sret ? 1 : 0) + 1; return fp ? `xmm${pos}` : ["rcx", "rdx", "r8", "r9"][pos]!; }
    case "aapcs64": return fp ? `v${nf}` : `x${ni}`;
    case "rv64": return fp ? `fa${nf}` : `a${(sret ? 1 : 0) + ni}`;
  }
}

export function bigTrace(conv: BigConv, sh: BigShape): BigStep[] {
  const ft = sh.field === "double" ? T.double : T["long long"];
  const S = struct(tname(sh), ["x", "y", "z"].slice(0, sh.n).map((f) => [f, ft]));
  const n = sh.n;
  const names = ["x", "y", "z"].slice(0, n);
  const init = Object.fromEntries(names.map((f, i) => [f, i + 1]));
  const size = n * 8;
  const kinds = Array(n).fill(sh.field);
  const sret = classify(conv, kinds).ret.how === "sret";
  const r = classify(conv, kinds, { intBefore: sret && conv !== "aapcs64" ? 1 : 0, fpBefore: 0 });
  const inRegs = r.arg.how === "regs";
  const kReg = kRegister(conv, sh, sret, inRegs ? r.arg.regs : r.arg.regs);
  /** "a.x = 1" for the fields in one register (classify names fields a, b, c; this program names them x, y, z). */
  const chunkText = (v: string, c: Chunk, mul: number) => c.fields.map((f) => { const i = FIELD_NAMES.indexOf(f); return `${v}.${names[i]} = ${(i + 1) * mul}`; }).join(", ");
  const m = new Machine({ target: "x86_64-linux" });
  const steps: BigStep[] = [];
  let copied = 0;
  let regs: [string, string][] = [];
  const push = (line: number, text: string) => steps.push({ line, text, snap: m.snapshot(), regs: regs.slice(), copied });
  const memName = conv === "sysv" ? "stack arg" : "copy of a";
  const locals = [{ name: "a", type: S }, { name: "r", type: S }];
  if (!inRegs) locals.push({ name: memName, type: S });
  m.call("main", locals);
  m.set("a", init);
  push(6, `main has a = {${names.map((_, i) => i + 1).join(", ")}} and r, which is not set yet.${inRegs ? "" : conv === "sysv" ? " Its frame also reserves room at the bottom for stack arguments." : " Its frame also reserves room for a temporary copy of a."}`);

  const addrA = m.addrOf("a"), addrR = m.addrOf("r");
  const mem = inRegs ? undefined : m.addrOf(memName);
  // 1. The caller places the argument.
  if (inRegs) {
    regs = r.arg.chunks.map((c) => [c.reg!, chunkText("a", c, 1)]);
    regs.push([kReg, "k = 2"]);
    push(7, `${r.arg.why} Nothing is copied to memory.`);
  } else {
    m.memcpy(mem!, addrA, size);
    copied += size;
    if (conv === "sysv") {
      regs = [[kReg, "k = 2"]];
      push(7, `Class MEMORY: the caller copies all ${size} bytes of a into the stack-argument area, just above the return address that call will push. k still goes in a register: ${kReg}.`);
    } else {
      const pReg = r.arg.regs[0]!;
      regs = [[pReg, `&copy = ${hx(mem!)}`], [kReg, "k = 2"]];
      push(7, `The caller copies a to a temporary (${size} bytes) and passes its address in ${pReg}. The callee may change the copy, so the caller cannot pass &a itself.`);
    }
  }
  // 2. The result location.
  if (sret) {
    regs = [[r.ret.sretReg!, `&r = ${hx(addrR)}`], ...regs];
    push(7, `The result is too big for registers. The caller passes &r in ${r.ret.sretReg}${conv === "win64" ? ", as argument 1. The other arguments move one place to the right" : conv === "sysv" ? ", as a hidden first argument" : conv === "aapcs64" ? ", the indirect result register. x0 stays free for the arguments" : ", as an implicit first argument"}.`);
  }
  // 3. The call.
  const ptrS = { k: "ptr" as const, to: S, own: "raw" as const };
  const calleeLocals = [
    ...(sret ? [{ name: "ret", type: ptrS, value: addrR }] : []),
    ...(inRegs ? [{ name: "v", type: S, value: init }] : conv === "sysv" ? [] : [{ name: "v", type: ptrS, value: mem! }]),
    { name: "k", type: ft, value: 2 },
  ];
  m.call("scale", calleeLocals);
  push(1, inRegs
    ? "scale starts. Unoptimized code spills its register arguments to its own frame: v and k."
    : conv === "sysv"
      ? `scale starts. It spills ${sret ? "ret and " : ""}k to its frame. It reads v in the caller's stack-argument area, at rbp+16.`
      : `scale starts. It spills ${sret ? "ret, " : ""}the pointer v and k. Here v is a pointer: the struct stays in main's frame.`);
  // 4. v.x *= k ...
  const vAt = inRegs ? m.addrOf("v") : mem!;
  for (const [i, f] of names.entries()) m.store(m.field(vAt, S, f), ft, (i + 1) * 2);
  push(2, inRegs ? "The callee scales its own copy of v." : conv === "sysv" ? "The callee scales v in place, in the stack-argument area. That memory belongs to this call, so this is allowed." : "The callee scales v through the pointer. It changes the caller's temporary copy, never a.");
  // 5. return v
  if (sret) {
    m.memcpy(m.get("ret") as Ptr, vAt, size);
    copied += size;
    regs = conv === "sysv" || conv === "win64" ? [["rax", `&r = ${hx(addrR)}`]] : [];
    push(3, `return v: the callee writes ${size} bytes through the result pointer, straight into r in main's frame.${regs.length ? " It also returns the same address in rax." : ""}`);
  } else {
    regs = r.ret.chunks.map((c) => [c.reg!, chunkText("v", c, 2)]);
    push(3, `return v: the fields come back in ${r.ret.regs.join(", ")}.`);
  }
  m.ret();
  if (!sret) m.set("r", Object.fromEntries(names.map((f, i) => [f, (i + 1) * 2])));
  push(7, sret
    ? `scale returned. The callee wrote r = {${names.map((_, i) => (i + 1) * 2).join(", ")}}, and a is unchanged. Bytes copied to memory for this call: ${copied}.`
    : `scale returned. main stores the result registers into r. Bytes copied to memory for this call: ${copied}.`);
  void addrA;
  return steps;
}
