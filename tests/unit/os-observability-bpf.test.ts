/** The eBPF subset: encoding, bounds arithmetic, the verifier's verdicts, and the safety property against the interpreter. */
import { describe, expect, test } from "vitest";
import { mulberry32, type Rng } from "@/sims/rng";
import {
  BPF, BPF_PRESETS, BpfMaps, BpfVm, CMP_NEGATE, HELPERS, JMP_SEQ_LIMIT, LINUX_COMPLEXITY_LIMIT, LOG2_HIST_SOURCE, PT_REGS, SIM_COMPLEXITY_LIMIT, STACK_SIZE, U64_MAX, XDP_ACTION, XDP_MD,
  aluEval, assemble, branchKnown, cmpEval, decodeInsns, encodeInsns, formatInsn, fromBytes, hexOf, presetById, refine, scalarAlu, scalarBits, scalarConst, scalarContains, scalarIsConst, scalarUnknown, syncBounds, tnumAdd, tnumAnd, tnumContains, tnumMul, tnumOr, tnumRange, tnumSub, tnumXor, u64, verify, VM_BASES,
  type AluName, type BpfProgram, type CmpName, type MapDef, type Reg, type Scalar, type Tnum, type VState, type VmInput,
} from "@/sims/os/observability";

const asm = (src: string): BpfProgram => {
  const a = assemble(src);
  if (!a.ok) throw new Error(`line ${a.line}: ${a.error}`);
  return a.prog;
};

describe("encoding", () => {
  test("real encodings, byte for byte", () => {
    const cases: [string, string][] = [
      ["r0 = 0", "b7 00 00 00 00 00 00 00"],
      ["exit", "95 00 00 00 00 00 00 00"],
      ["r2 = r10", "bf a2 00 00 00 00 00 00"],
      ["r1 += -8", "07 01 00 00 f8 ff ff ff"],
      ["*(u64 *)(r10 - 8) = r1", "7b 1a f8 ff 00 00 00 00"],
      ["*(u32 *)(r10 - 4) = 0", "62 0a fc ff 00 00 00 00"],
      ["r0 = *(u64 *)(r0 + 0)", "79 00 00 00 00 00 00 00"],
      ["r6 = *(u64 *)(r1 + 112)", "79 16 70 00 00 00 00 00"],
      ["r6 &= 63", "57 06 00 00 3f 00 00 00"],
      ["r0 += r6", "0f 60 00 00 00 00 00 00"],
      ["w1 = 3", "b4 01 00 00 03 00 00 00"],
      ["if r0 == 0 goto +1", "15 00 01 00 00 00 00 00"],
      ["if r1 > r2 goto +2", "2d 21 02 00 00 00 00 00"],
      ["goto +3", "05 00 03 00 00 00 00 00"],
      ["call map_lookup_elem", "85 00 00 00 01 00 00 00"],
      ["lock *(u64 *)(r0 + 0) += r1", "db 10 00 00 00 00 00 00"],
      ["r5 = be16 r5", "dc 05 00 00 10 00 00 00"],
    ];
    for (const [text, hex] of cases) {
      const p = asm(`${text}\nexit`);
      expect(hexOf(p.insns[0]!), text).toBe(hex);
    }
  });
  test("a map load takes two slots, with the pseudo source", () => {
    const p = asm(".map m array key=4 value=8 entries=1\nr1 = map[m] ll\nexit");
    expect(p.insns).toHaveLength(3);
    expect(hexOf(p.insns[0]!)).toBe("18 11 00 00 00 00 00 00");
    expect(p.insns[1]!.filler).toBe(true);
  });
  test("a 64-bit constant keeps both halves", () => {
    const p = asm("r0 = 0x1122334455667788 ll\nexit");
    expect(p.insns[0]!.imm64).toBe(0x1122334455667788n);
    expect(new BpfVm(p).run().r0).toBe(0x1122334455667788n);
  });
  test("each preset survives a round trip through bytes and text", () => {
    for (const x of BPF_PRESETS) {
      const p = asm(x.source);
      const again = decodeInsns(encodeInsns(p.insns));
      expect(again.map((i) => formatInsn(i, p.maps))).toEqual(p.insns.map((i) => formatInsn(i, p.maps)));
    }
  });
  test("real constants: helper numbers, pt_regs and xdp_md offsets, XDP actions", () => {
    expect(HELPERS[1]).toBe("map_lookup_elem");
    expect(HELPERS[14]).toBe("get_current_pid_tgid");
    expect(PT_REGS.rdi).toBe(112);
    expect(PT_REGS.size).toBe(168);
    expect(XDP_MD.data_end).toBe(4);
    expect(XDP_ACTION.DROP).toBe(1);
    expect(XDP_ACTION.PASS).toBe(2);
    expect(STACK_SIZE).toBe(512);
    expect(LINUX_COMPLEXITY_LIMIT).toBe(1_000_000);
    expect(JMP_SEQ_LIMIT).toBe(8192);
  });
  test("assembler errors name the line", () => {
    const a = assemble("r0 = 0\nnonsense here\nexit");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.line).toBe(2);
    expect(assemble("goto nowhere").ok).toBe(false);
    expect(assemble("r1 = map[missing] ll").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------- bounds

const BOUNDARY = [0n, 1n, 2n, 7n, 8n, 63n, 64n, 255n, 0xffffn, (1n << 31n) - 1n, 1n << 31n, (1n << 32n) - 1n, 1n << 32n, (1n << 63n) - 1n, 1n << 63n, U64_MAX, U64_MAX - 1n];
const rand64 = (r: Rng) => {
  const kind = r();
  if (kind < 0.35) return BOUNDARY[Math.floor(r() * BOUNDARY.length)]!;
  if (kind < 0.6) return BigInt(Math.floor(r() * 256));
  return (BigInt(Math.floor(r() * 2 ** 32)) << 32n) | BigInt(Math.floor(r() * 2 ** 32));
};
/** A random scalar, with two members that it must hold. */
function randScalar(r: Rng): { s: Scalar; a: bigint; b: bigint } {
  const a = rand64(r), b = rand64(r);
  const mode = r();
  const lo = a < b ? a : b, hi = a < b ? b : a;
  if (mode < 0.3) return { s: scalarConst(a), a, b: a };
  if (mode < 0.6) {
    const s = syncBounds({ ...scalarUnknown(), umin: lo, umax: hi });
    return { s: s!, a, b };
  }
  if (mode < 0.8) {
    const t: Tnum = tnumRange(lo, hi);
    return { s: syncBounds({ ...scalarUnknown(), t })!, a, b };
  }
  return { s: scalarUnknown(), a, b };
}

describe("bounds arithmetic holds each concrete result", () => {
  const OPS: AluName[] = ["add", "sub", "mul", "div", "mod", "or", "and", "xor", "lsh", "rsh", "arsh", "neg"];
  test("tnum operations", () => {
    const r = mulberry32(1);
    for (let i = 0; i < 4000; i++) {
      const x = randScalar(r), y = randScalar(r);
      const pairs: [(a: Tnum, b: Tnum) => Tnum, (a: bigint, b: bigint) => bigint][] = [
        [tnumAdd, (a, b) => a + b], [tnumSub, (a, b) => a - b], [tnumAnd, (a, b) => a & b], [tnumOr, (a, b) => a | b], [tnumXor, (a, b) => a ^ b], [tnumMul, (a, b) => a * b],
      ];
      for (const [f, g] of pairs) expect(tnumContains(f(x.s.t, y.s.t), u64(g(x.a, y.a)))).toBe(true);
    }
  });
  test("each ALU operation, 64-bit and 32-bit", () => {
    const r = mulberry32(2);
    for (let i = 0; i < 12000; i++) {
      const x = randScalar(r), y = randScalar(r);
      const op = OPS[i % OPS.length]!;
      const is32 = r() < 0.4;
      for (const a of [x.a, x.b]) {
        for (const b of [y.a, y.b]) {
          const got = aluEval(op, a, b, is32);
          const abs = scalarAlu(op, x.s, y.s, is32);
          expect(scalarContains(abs, got), `${op} ${is32} ${a} ${b}`).toBe(true);
        }
      }
    }
  });
  test("branchKnown never contradicts a real compare", () => {
    const r = mulberry32(3);
    const ops: CmpName[] = ["eq", "ne", "gt", "ge", "lt", "le", "sgt", "sge", "slt", "sle", "set"];
    for (let i = 0; i < 12000; i++) {
      const x = randScalar(r), y = randScalar(r);
      const op = ops[i % ops.length]!;
      const known = branchKnown(op, x.s, y.s);
      const real = cmpEval(op, x.a, y.a, false);
      if (known === 1) expect(real).toBe(true);
      if (known === 0) expect(real).toBe(false);
    }
  });
  test("refine keeps each pair of values on the correct side", () => {
    const r = mulberry32(4);
    const ops = Object.keys(CMP_NEGATE) as (keyof typeof CMP_NEGATE)[];
    for (let i = 0; i < 12000; i++) {
      const x = randScalar(r), y = randScalar(r);
      const op = ops[i % ops.length]!;
      const side = cmpEval(op, x.a, y.a, false) ? op : CMP_NEGATE[op];
      const n = refine(side, x.s, y.s);
      expect(n, `${side} ${x.a} ${y.a}`).not.toBeNull();
      expect(scalarContains(n![0], x.a)).toBe(true);
      expect(scalarContains(n![1], y.a)).toBe(true);
    }
  });
  test("range examples from the lesson", () => {
    const m = scalarAlu("and", scalarUnknown(), scalarConst(63n), false);
    expect([m.umin, m.umax, m.t.v, m.t.m]).toEqual([0n, 63n, 0n, 0x3fn]);
    const r7 = scalarAlu("sub", scalarBits(3), scalarBits(3), false);
    expect([r7.smin, r7.smax]).toEqual([-7n, 7n]);
    expect(scalarAlu("mod", scalarUnknown(), scalarConst(64n), false).umax).toBe(U64_MAX);
  });
  test("BPF division rules", () => {
    expect(aluEval("div", 5n, 0n, false)).toBe(0n);
    expect(aluEval("mod", 5n, 0n, false)).toBe(5n);
  });
});

// ---------------------------------------------------------------------------- presets

describe("presets", () => {
  test("counts: 7 safe, 20 unsafe, 3 correct but rejected", () => {
    const n = (g: string) => BPF_PRESETS.filter((p) => p.group === g).length;
    expect([n("safe"), n("unsafe"), n("correct")]).toEqual([7, 20, 3]);
  });
  for (const p of BPF_PRESETS) {
    test(`${p.group}: ${p.id}`, () => {
      const r = verify(asm(p.source));
      if (p.group === "safe") {
        expect(r.error).toBeUndefined();
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        expect(r.error).toContain(p.reason!);
        expect(r.errorPc).toBe(p.rejectPc);
      }
    });
  }
  test("the log ends in the verdict", () => {
    for (const p of BPF_PRESETS) {
      const r = verify(asm(p.source));
      const last = r.log[r.log.length - 1]!;
      if (p.id === "bigloop") continue; // Its log stops at the limit.
      expect(last.kind).toBe(r.ok ? "accept" : "error");
    }
  });
  test("each correct-but-rejected program never misbehaves when it runs", () => {
    const r = mulberry32(9);
    for (const id of ["selfsub", "modulo"]) {
      const prog = asm(presetById(id).source);
      for (let i = 0; i < 300; i++) {
        const out = new BpfVm(prog, { regs: { rdi: rand64(r) } }).run();
        expect(out.status).toBe("exit");
      }
    }
  });
  test("each memory-unsafe preset really fails for some input: the rejection is not a false alarm", () => {
    const inputs: [string, VmInput][] = [
      ["nonull", {}],
      ["uninit", {}],
      ["noret", {}],
      ["stackuninit", {}],
      ["stackoob", {}],
      ["derefscalar", { regs: { rdi: 1000n } }],
      ["unbounded", { regs: { rdi: 1n << 40n } }],
      ["offbyone", { regs: { rdi: 64n } }],
      ["negative", { regs: { rdi: u64(-1n) } }],
      ["nopktcheck", { packet: new Uint8Array(4) }],
      ["shortpktcheck", { packet: new Uint8Array(14) }],
      ["jumpout", {}],
      ["falloff", {}],
      ["writefp", {}],
    ];
    for (const [id, input] of inputs) {
      const out = new BpfVm(asm(presetById(id).source), input).run();
      expect(out.status, id).toBe("violation");
    }
  });
  test("each endless preset really runs past any budget", () => {
    for (const id of ["spin", "spinrange"]) {
      expect(new BpfVm(asm(presetById(id).source), { regs: { rdi: 3n } }).run(50_000).status).toBe("budget");
    }
  });
  test("quoted walks: mask 14, bounded loop 37, range loop 7 forks and 7 pruned, long loop 20,001", () => {
    expect(verify(asm(presetById("mask").source)).processed).toBe(14);
    expect(verify(asm(presetById("loop").source)).processed).toBe(37);
    const rl = verify(asm(presetById("rangeloop").source));
    expect([rl.forks, rl.pruned]).toEqual([7, 7]);
    const big = verify(asm(presetById("bigloop").source));
    expect(big.processed).toBe(SIM_COMPLEXITY_LIMIT + 1);
    expect(SIM_COMPLEXITY_LIMIT + 1).toBe(20_001);
  });
  test("with a higher limit, a loop that is long but not endless passes the same way", () => {
    const p = asm(".type kprobe\nr2 = 0\nloop:\nr2 += 1\nif r2 < 2000 goto loop\nr0 = 0\nexit");
    expect(verify(p, { limit: 10_000 }).ok).toBe(true);
    expect(verify(p, { limit: 1000 }).ok).toBe(false);
  });
  test("older kernels refuse any back-edge", () => {
    const r = verify(asm(presetById("loop").source), { noLoops: true });
    expect(r.error).toBe("back-edge from insn 6 to 3");
    expect(r.stage).toBe("load");
    expect(verify(asm(presetById("mask").source), { noLoops: true }).ok).toBe(true);
  });
  test("adding the null check fixes the program", () => {
    const fixed = presetById("nonull").source.replace("  r0 = *(u64 *)(r0 + 0)\n  exit", "  if r0 == 0 goto out\n  r0 = *(u64 *)(r0 + 0)\n  exit\nout:\n  r0 = 0\n  exit");
    expect(verify(asm(fixed)).ok).toBe(true);
  });
  test("a mask fixes the modulo program", () => {
    expect(verify(asm(presetById("modulo").source.replace("r6 %= 64 ", "r6 &= 63 "))).ok).toBe(true);
  });
  test("pruning respects linked registers: a state with r7 = r6 does not cover a state with a separate r7", () => {
    const src = `.type kprobe
.map big array key=4 value=64 entries=1
  r6 = *(u64 *)(r1 + 112)
  r7 = *(u64 *)(r1 + 104)
  r8 = *(u64 *)(r1 + 96)
  *(u32 *)(r10 - 4) = 0
  r2 = r10
  r2 += -4
  r1 = map[big] ll
  call map_lookup_elem
  if r0 == 0 goto out
  if r8 == 0 goto join
  r7 = r6
  r8 = 0                     ; so that only the link between r6 and r7 differs at the join
join:
  if r6 > 7 goto out
  r0 += r7
  r1 = *(u8 *)(r0 + 0)
out:
  r0 = 0
  exit`;
    const prog = asm(src);
    expect(verify(prog).ok).toBe(false);
    // The rejection is correct: with r8 = 0, the index is free.
    expect(new BpfVm(prog, { regs: { rdi: 1n, rsi: 1n << 40n, rdx: 0n } }).run().status).toBe("violation");
    // With the copy on each path, the program is safe, and the check on r6 also narrows r7.
    expect(verify(asm(src.replace("if r8 == 0 goto join\n", ""))).ok).toBe(true);
  });
  test("the check on data_end reaches a copy on the stack", () => {
    const src = `.type xdp
r2 = *(u32 *)(r1 + 0)
r3 = *(u32 *)(r1 + 4)
*(u64 *)(r10 - 8) = r2
r4 = r2
r4 += 8
if r4 > r3 goto out
r5 = *(u64 *)(r10 - 8)
r0 = *(u64 *)(r5 + 0)
r0 = 0
exit
out:
r0 = 0
exit`;
    expect(verify(asm(src)).error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- the safety property

const MAPS = `.map small array key=4 value=16 entries=2
.map big array key=4 value=64 entries=1
.map tab hash key=4 value=8 entries=4
`;

/** Randomly built programs in the shape of real ones. Many pass, and many fail at some late check. */
function randomProgram(r: Rng): string {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const reg = () => `r${pick([6, 7, 8, 9])}`;
  const imm = () => pick([0, 1, 2, 3, 7, 8, 15, 16, 31, 32, 63, 64, 65, -1, -8, 100, 1 << 20]);
  const out: string[] = [];
  const xdp = r() < 0.2;
  out.push(`.type ${xdp ? "xdp" : "kprobe"}`, MAPS);
  let label = 0;
  if (xdp) {
    out.push("r6 = *(u32 *)(r1 + 0)", "r7 = *(u32 *)(r1 + 4)", "r8 = r6", `r8 += ${pick([1, 4, 8, 14, 20])}`);
    out.push("if r8 > r7 goto out0");
    label = 1;
    const n = 1 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const size = pick(["u8", "u16", "u32", "u64"]);
      const off = pick([0, 1, 2, 4, 8, 12, 13, 19]);
      if (r() < 0.8) out.push(`r9 = *(${size} *)(r6 + ${off})`);
      else out.push(`*(${size} *)(r6 + ${off}) = ${pick([0, 1, 255])}`);
    }
    if (r() < 0.3) {
      out.push("r9 &= 7", "r6 += r9", "r5 = r6", `r5 += ${pick([1, 4, 8])}`, "if r5 > r7 goto out0", `r0 = *(u8 *)(r6 + ${pick([0, 1, 3])})`);
    }
    out.push("r0 = 2", "exit", "out0:", "r0 = 1", "exit");
    return out.join("\n");
  }
  out.push("r6 = *(u64 *)(r1 + 112)", "r7 = *(u64 *)(r1 + 104)", "r8 = 0", "r9 = 1");
  const n = 3 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.3) {
      const op = pick(["+=", "-=", "*=", "&=", "|=", "^=", "<<=", ">>=", "s>>=", "/=", "%="]);
      const small = op.includes("<") || op.includes(">");
      const w = r() < 0.15 ? "w" : "r";
      const d = reg().slice(1);
      if (r() < 0.6) out.push(`${w}${d} ${op} ${small ? pick([1, 2, 3, 8, 16, 31]) : Math.abs(imm()) + (op === "/=" || op === "%=" ? 1 : 0)}`);
      else out.push(`${w}${d} ${op} ${w}${reg().slice(1)}`);
    } else if (k < 0.45) {
      const t = `l${label++}`;
      const cmp = pick(["==", "!=", ">", ">=", "<", "<=", "s>", "s>=", "s<", "s<=", "&"]);
      const w = r() < 0.15 ? "w" : "r";
      out.push(`if ${w}${reg().slice(1)} ${cmp} ${r() < 0.7 ? imm() : `${w}${reg().slice(1)}`} goto ${t}`);
      out.push(`${reg()} += ${pick([1, 2, 3])}`);
      out.push(`${t}:`);
    } else if (k < 0.7) {
      // A map value with an index under some check.
      const m = pick(["small", "big", "tab"]);
      const size = pick(["u8", "u16", "u32", "u64"]);
      const idx = reg();
      const t = `l${label++}`;
      out.push(`*(u32 *)(r10 - 4) = ${pick([0, 0, 1, 2])}`, "r2 = r10", "r2 += -4", `r1 = map[${m}] ll`, "call map_lookup_elem");
      if (r() < 0.9) out.push(`if r0 == 0 goto ${t}`);
      const chk = r();
      if (chk < 0.4) out.push(`${idx} &= ${pick([0, 1, 3, 7, 15, 31, 63, 64])}`, `r0 += ${idx}`);
      else if (chk < 0.7) out.push(`if ${idx} > ${pick([7, 8, 15, 56, 63])} goto ${t}`, `r0 += ${idx}`);
      else if (chk < 0.8) out.push(`r0 += ${idx}`);
      out.push(r() < 0.6 ? `${reg()} = *(${size} *)(r0 + ${pick([0, 0, 1, 7, 8])})` : `*(${size} *)(r0 + ${pick([0, 0, 1, 7, 8])}) = ${reg()}`);
      if (r() < 0.2) out.push(`r1 = 1`, `lock *(u64 *)(r0 + 0) += r1`);
      out.push(`${t}:`);
    } else if (k < 0.82) {
      // The stack.
      const off = pick([8, 16, 24, 32, 512]);
      const v = reg();
      out.push(`*(u64 *)(r10 - ${off}) = ${v}`, `${reg()} = *(u64 *)(r10 - ${r() < 0.8 ? off : pick([8, 16, 40])})`);
    } else if (k < 0.92) {
      // A loop with a counter.
      const t = `l${label++}`;
      const c = pick(["r6", "r7"]);
      out.push(`${c} &= ${pick([3, 7])}`, `${t}:`, `${c} += 1`, `r8 += r9`);
      out.push(`if ${c} < ${pick([4, 8, 12])} goto ${t}`);
    } else {
      out.push(`call ${pick(["ktime_get_ns", "get_prandom_u32", "get_smp_processor_id", "get_current_pid_tgid"])}`, `${reg()} = r0`);
    }
  }
  out.push(`r0 = ${r() < 0.5 ? "r8" : "0"}`, "exit");
  return out.join("\n");
}

/** A random change in the raw fields of one instruction of a valid program. */
function mutate(p: BpfProgram, r: Rng): BpfProgram {
  const insns = p.insns.map((i) => ({ ...i }));
  const k = Math.floor(r() * insns.length);
  const i = insns[k]!;
  const which = r();
  if (which < 0.35) i.imm = [0, 1, -1, 8, 63, 64, 512, 100000][Math.floor(r() * 8)]!;
  else if (which < 0.6) i.off = [0, 1, -1, 2, -2, 8, -8, 3][Math.floor(r() * 8)]!;
  else if (which < 0.8) i.dst = Math.floor(r() * 11);
  else i.src = Math.floor(r() * 11);
  return fromBytes(encodeInsns(insns), p.type, p.maps);
}

function randomInput(r: Rng, prog: BpfProgram, maps?: BpfMaps): VmInput {
  return {
    regs: { rdi: rand64(r), rsi: rand64(r) },
    packet: new Uint8Array(Math.floor(r() * 70)),
    rng: r,
    timeNs: rand64(r) >> 8n,
    maps: maps ?? new BpfMaps(prog.maps),
  };
}

const inMaps = (v: bigint) => v >= VM_BASES.map && v < VM_BASES.mapEnd;

/** The concrete register fits this abstract state. A pointer can be out of range here: only a load or store must be inside. */
function holds(st: VState, values: (bigint | undefined)[]): boolean {
  return st.regs.every((reg: Reg, i) => {
    const v = values[i];
    if (reg.k === "none") return true;
    if (v === undefined) return false;
    switch (reg.k) {
      case "scalar": return scalarContains(reg.s, v);
      case "stack": return v === u64(VM_BASES.stackTop + BigInt(reg.off));
      case "ctx": return v === u64(VM_BASES.ctx + BigInt(reg.off));
      case "map_value": return !scalarIsConst(reg.v) || inMaps(u64(v - BigInt(reg.off) - reg.v.umin));
      case "map_value_or_null": return v === 0n || inMaps(v);
      case "pkt": return scalarContains(reg.v, u64(v - VM_BASES.packet - BigInt(reg.off)));
      case "pkt_end": return v >= VM_BASES.packet && v <= VM_BASES.packet + 70n;
      case "map_ptr": return true;
    }
    return false;
  });
}

describe("programs that the verifier accepts", () => {
  function check(prog: BpfProgram, r: Rng, inputs: number): boolean {
    const v = verify(prog, { record: true, limit: 8000, maxLog: 1 });
    if (!v.ok) return false;
    for (let n = 0; n < inputs; n++) {
      const vm = new BpfVm(prog, randomInput(r, prog));
      while (vm.status === "running") {
        const states = v.statesAt!.get(vm.pc);
        // Soundness: each real state fits some abstract state that the walk saw at this instruction.
        if (!states || !states.some((s) => holds(s, vm.regs))) {
          throw new Error(`no state holds pc ${vm.pc}: ${vm.regs.join(",")}\n${prog.insns.map((i) => formatInsn(i, prog.maps)).join("\n")}`);
        }
        vm.step();
        // The bound: a run cannot take more steps than the walk processed.
        if (vm.steps > v.processed) throw new Error(`steps ${vm.steps} > processed ${v.processed}`);
      }
      if (vm.status !== "exit") {
        throw new Error(`${vm.status}: ${vm.violation?.what} at ${vm.violation?.pc}\n${prog.insns.map((i, k) => `${k}: ${formatInsn(i, prog.maps)}`).join("\n")}`);
      }
    }
    return true;
  }

  test("random programs never read out of bounds and never run forever", () => {
    const r = mulberry32(2024);
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 2500; i++) {
      const prog = asm(randomProgram(r));
      if (check(prog, r, 12)) accepted++;
      else rejected++;
    }
    // The test must not be empty: both verdicts must occur often.
    expect(accepted).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(300);
  }, 60_000);

  test("random changes to the raw fields of the safe presets", () => {
    const r = mulberry32(7);
    const safe = [...BPF_PRESETS.filter((p) => p.group === "safe").map((p) => p.source), LOG2_HIST_SOURCE].map(asm);
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      let prog = safe[i % safe.length]!;
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) prog = mutate(prog, r);
      if (check(prog, r, 6)) accepted++;
    }
    expect(accepted).toBeGreaterThan(200);
  }, 60_000);

  test("random bytes are refused, or they run safely", () => {
    const r = mulberry32(11);
    const maps: MapDef[] = [{ name: "m", kind: "array", keySize: 4, valueSize: 8, maxEntries: 1 }];
    const ops = [0xb7, 0xbf, 0x07, 0x0f, 0x57, 0x79, 0x61, 0x7b, 0x63, 0x72, 0x15, 0x1d, 0x25, 0x2d, 0x05, 0x85, 0x95, 0x18, 0xb4, 0xdb, 0x16, 0xff, 0x00];
    for (let i = 0; i < 6000; i++) {
      const n = 2 + Math.floor(r() * 8);
      const bytes = new Uint8Array(n * 8);
      for (let k = 0; k < n; k++) {
        bytes[k * 8] = k === n - 1 ? 0x95 : ops[Math.floor(r() * ops.length)]!;
        if (k < n - 1) {
          bytes[k * 8 + 1] = Math.floor(r() * 11) | (Math.floor(r() * 11) << 4);
          bytes[k * 8 + 2] = Math.floor(r() * 4);
          bytes[k * 8 + 4] = Math.floor(r() * 16);
        }
      }
      check(fromBytes(bytes, "kprobe", maps), r, 3);
    }
  }, 60_000);
});

describe("the histogram program", () => {
  test("it passes the verifier, and each bucket is floor(log2)", () => {
    const prog = asm(LOG2_HIST_SOURCE);
    expect(verify(prog).ok).toBe(true);
    const maps = new BpfMaps(prog.maps);
    const r = mulberry32(5);
    for (let i = 0; i < 400; i++) {
      const x = i < 70 ? 1n << BigInt(i % 64) : rand64(r);
      const before = maps.readU64s(0);
      expect(new BpfVm(prog, { regs: { rdi: x }, maps }).run().status).toBe("exit");
      const after = maps.readU64s(0);
      let b = 0;
      for (let v = u64(x); v > 1n; v >>= 1n) b++;
      expect(after[b]! - before[b]!, `bucket of ${x}`).toBe(1n);
    }
  });
  test("BPF opcode classes are real", () => {
    expect(BPF.LD | BPF.DW | BPF.IMM).toBe(0x18);
    expect(BPF.JMP | BPF.EXIT).toBe(0x95);
    expect(BPF.ALU64 | BPF.MOV | BPF.K).toBe(0xb7);
  });
});
