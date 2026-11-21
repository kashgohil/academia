/** Tests for src/sims/arch/isa: every number that the ISA lessons quote is pinned here. */
import { describe, expect, test } from "vitest";
import {
  CHANGES, CONDS, COMPARE_IDS, DISPS, LISTINGS, MODE_IDS, POOL, RISCV_SPLIT, cmp8, compress, decodeAt, decodeStream, density, effAddr,
  factRun, frameView, listingById, lowerArm, lowerRv, lowerX86, muxInputs, naiveWiring, realWiring, resyncAt, retiredBy, runListing,
  runLowered, runOnCores, runSplit, runUnderChange, splitExpect, splitSweep, stateAfter, totalMuxInputs, type Addr,
} from "../../src/sims/arch/isa";
import { PROGRAMS, assemble, encode, programById, type Inst } from "../../src/sims/arch/rv";

// ---------------------------------------------------------------- what an ISA is

describe("contract: one binary, three cores", () => {
  test("sum: 46 instructions, exit 31; cycles 100, 72 and 50", () => {
    const r = runOnCores(programById("sum").source);
    expect(r.retired).toBe(46);
    expect(r.exitCode).toBe(31);
    expect(r.runs.map((x) => x.cycles)).toEqual([100, 72, 50]);
  });
  test("fact: 151 instructions; cycles 564, 215 and 138", () => {
    const r = runOnCores(programById("fact").source);
    expect(r.retired).toBe(151);
    expect(r.runs.map((x) => x.cycles)).toEqual([564, 215, 138]);
  });
  test("write-back is in program order, and every core retires every instruction", () => {
    for (const p of PROGRAMS) {
      const r = runOnCores(p.source);
      for (const run of r.runs) {
        expect(run.wb.every((c, i) => c > 0 && (i === 0 || c >= run.wb[i - 1]!))).toBe(true);
        expect(retiredBy(run, run.cycles)).toBe(r.retired);
      }
    }
  });
  test("the state after k instructions does not depend on the core (it comes from the hart alone)", () => {
    const r = runOnCores(programById("sum").source);
    const c = 40;
    const ks = r.runs.map((x) => retiredBy(x, c));
    expect(ks).toEqual([18, 24, 38]);
    expect(stateAfter(r.program, 46).status).toBe("exited");
  });
  test("contract changes: no M breaks fact and dot; RV32E traps on a7; add/sub swap gives -31 for sum", () => {
    const res = (id: string) => CHANGES.map((c) => runUnderChange(programById(id).source, c.id));
    const fact = res("fact");
    expect(fact[0]!.exitCode).toBe(3628800);
    expect(fact[1]!.error).toMatch(/not an RV32IM instruction/);
    expect(fact[1]!.retired).toBe(95);
    expect(fact[2]!.error).not.toBeNull();
    expect(fact[3]!.exitCode).toBe(3628800);
    expect(res("dot")[1]!.error).not.toBeNull();
    const sum = res("sum");
    expect(sum[1]!.exitCode).toBe(31);
    expect(sum[3]!.exitCode).toBe(-31);
    for (const p of PROGRAMS) expect(runUnderChange(p.source, "rv32e").error, p.id).not.toBeNull();
  });
});

// ---------------------------------------------------------------- RISC-V basics

describe("immediate wiring", () => {
  test("the wiring read from the decoder matches the spec's format diagrams", () => {
    const B = realWiring("B"), J = realWiring("J"), S = realWiring("S");
    expect(B[11]).toBe(7);
    expect(B.slice(1, 5)).toEqual([8, 9, 10, 11]);
    expect(B.slice(5, 11)).toEqual([25, 26, 27, 28, 29, 30]);
    expect(J[11]).toBe(20);
    expect(J.slice(12, 20)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(S.slice(0, 5)).toEqual([7, 8, 9, 10, 11]);
    for (const f of ["I", "S", "B", "J"] as const) expect(realWiring(f)[31]).toBe(31);
    expect(realWiring("U")[31]).toBe(31);
    expect(realWiring("U").slice(0, 12).every((x) => x === -1)).toBe(true);
    expect(realWiring("U")[12]).toBe(12);
    for (const f of ["I", "S", "B", "J"] as const) expect(realWiring(f).slice(5, 11)).toEqual([25, 26, 27, 28, 29, 30]);
  });
  test("both layouts encode the same value; the naive one needs more mux inputs: 70 against 98", () => {
    expect(totalMuxInputs("real")).toBe(70);
    expect(totalMuxInputs("naive")).toBe(98);
    expect(Math.max(...muxInputs("real"))).toBe(4);
    expect(muxInputs("real")[11]).toBe(4); // imm[11]: inst[31], inst[7], inst[20] or 0
    expect(muxInputs("real").slice(5, 11).every((x) => x === 2)).toBe(true); // imm[10:5]: inst[30:25] or 0
    expect(Math.max(...muxInputs("naive"))).toBe(5);
    expect(naiveWiring("J").slice(1, 21)).toEqual(Array.from({ length: 20 }, (_, k) => 12 + k));
  });
  test("encoding examples quoted in the lesson", () => {
    expect(encode({ op: "add", rd: 10, rs1: 11, rs2: 12, imm: 0 })).toBe(0x00c58533);
    expect(encode({ op: "sub", rd: 10, rs1: 11, rs2: 12, imm: 0 })).toBe(0x40c58533);
    expect((0x00c58533 ^ (1 << 30)) >>> 0).toBe(0x40c58533);
  });
  test("li and la expansions", () => {
    const one = (s: string) => assemble(`        .text\n        ${s}\n`).program;
    expect(one("li a0, 2047").words.length).toBe(1);
    expect(one("li a0, 2048").words.length).toBe(2);
    const p = one("li a0, 0x12345fff");
    expect(p.insts.map((i) => [i.op, i.imm])).toEqual([["lui", 0x12346], ["addi", -1]]);
    expect(one("li a0, 0x12345000").words.length).toBe(1);
    expect(one("la a0, 0").insts.map((i) => i.op)).toEqual(["auipc", "addi"]);
  });
});

describe("C extension", () => {
  const I = (op: Inst["op"], rd = 0, rs1 = 0, rs2 = 0, imm = 0): Inst => ({ op, rd, rs1, rs2, imm });
  test("rules at their limits", () => {
    expect(compress(I("lw", 10, 2, 0, 252)).form).toBe("c.lwsp");
    expect(compress(I("lw", 10, 2, 0, 256)).ok).toBe(false);
    expect(compress(I("lw", 10, 11, 0, 124)).form).toBe("c.lw");
    expect(compress(I("lw", 5, 11, 0, 0)).ok).toBe(false); // t0 is x5, outside x8..x15
    expect(compress(I("beq", 0, 8, 0, 254)).form).toBe("c.beqz");
    expect(compress(I("beq", 0, 8, 0, 256)).ok).toBe(false);
    expect(compress(I("jal", 1, 0, 0, 2046)).form).toBe("c.jal");
    expect(compress(I("addi", 2, 2, 0, -512)).form).toBe("c.addi16sp");
    expect(compress(I("addi", 2, 2, 0, 496)).form).toBe("c.addi16sp");
    expect(compress(I("addi", 10, 0, 0, 31)).form).toBe("c.li");
    expect(compress(I("addi", 10, 0, 0, 32)).ok).toBe(false);
    expect(compress(I("addi", 10, 2, 0, 1020)).form).toBe("c.addi4spn");
    expect(compress(I("lui", 2, 0, 0, 1)).ok).toBe(false);
    expect(compress(I("mul", 10, 11, 12)).ok).toBe(false);
    expect(compress(I("ecall")).ok).toBe(false);
  });
  test("fact: 13 of 21 compress, 84 B to 58 B (31%)", () => {
    const d = density(assemble(programById("fact").source).program);
    expect([d.insts, d.compressible, d.bytes32, d.bytesC]).toEqual([21, 13, 84, 58]);
    expect(Math.round(100 * (1 - d.bytesC / d.bytes32))).toBe(31);
  });
  test("all sample programs: 77 of 148 (52%), 592 B to 438 B (26% smaller)", () => {
    let n = 0, c = 0, b = 0, bc = 0;
    for (const p of PROGRAMS) { const d = density(assemble(p.source).program); n += d.insts; c += d.compressible; b += d.bytes32; bc += d.bytesC; }
    expect([n, c, b, bc]).toEqual([148, 77, 592, 438]);
    expect(Math.round((100 * c) / n)).toBe(52);
    expect(Math.round(100 * (1 - bc / b))).toBe(26);
  });
  test("sum: the lw through t0 does not compress; renamed to a5 it does", () => {
    const d = density(assemble(programById("sum").source).program);
    const lw = assemble(programById("sum").source).program.insts.findIndex((i) => i.op === "lw");
    expect(d.forms[lw]!.ok).toBe(false);
    expect(compress({ op: "lw", rd: 12, rs1: 15, rs2: 0, imm: 0 }).form).toBe("c.lw");
  });
});

// ---------------------------------------------------------------- addressing modes

describe("listings", () => {
  test("every RISC-V listing runs on the hart and gives the C result", () => {
    for (const l of LISTINGS) { const r = runListing(l.id); expect(r.ok, l.id).toBe(true); }
  });
  test("instruction counts without ret (x86 / Arm / RV32)", () => {
    const n = (id: string) => {
      const l = listingById(id);
      const nr = (a: { text: string }[]) => a.filter((m) => !/(^|:\s*)ret$/.test(m.text)).length;
      return [nr(l.x86), nr(l.arm), runListing(id).count];
    };
    expect(n("idx")).toEqual([1, 1, 3]);
    expect(n("fld")).toEqual([1, 1, 1]);
    expect(n("sidx")).toEqual([2, 3, 5]);
    expect(n("glob")).toEqual([1, 2, 2]);
    expect(n("row")).toEqual([3, 2, 5]);
    expect(n("bump")).toEqual([1, 3, 5]);
    expect(n("addf")).toEqual([1, 3, 3]);
    expect(listingById("sidx").rvZba!.length - 1).toBe(3);
    expect(listingById("idx").rvZba!.length - 1).toBe(2);
  });
  test("loop bodies: sum 4/4/4, strlen 3/3/3", () => {
    expect(listingById("sum").perIter).toEqual({ x86: 4, arm: 4, rv: 4 });
    expect(listingById("slen").perIter).toEqual({ x86: 3, arm: 3, rv: 3 });
  });
  test("code sizes of the comparison functions (bytes; x86 / Arm / RV32)", () => {
    const sz = (id: string) => { const l = listingById(id); const b = (a: { bytes: number[] }[]) => a.reduce((s, m) => s + m.bytes.length, 0); return [b(l.x86), b(l.arm), 4 * runListing(id).fnWords]; };
    expect(sz("sum")).toEqual([24, 48, 40]);
    expect([listingById("sum").x86.length, listingById("sum").arm.length, runListing("sum").fnWords]).toEqual([11, 12, 10]);
    expect(sz("max2")).toEqual([8, 12, 12]);
    expect(sz("addf")).toEqual([4, 16, 16]);
    expect(sz("slen")).toEqual([19, 24, 28]);
    for (const id of COMPARE_IDS) for (const m of listingById(id).x86) expect(decodeAt(m.bytes, 0).len, m.text).toBe(m.bytes.length);
  });
  test("ids exist", () => { for (const id of [...MODE_IDS, ...COMPARE_IDS]) expect(listingById(id).id).toBe(id); });
});

describe("lowering one address", () => {
  const all: Addr[] = [];
  for (const scale of [1, 2, 4, 8] as const) for (const index of [false, true]) for (const disp of DISPS) all.push({ scale, index, disp });
  test("the RISC-V sequence reads the effective address, on the hart, in all 192 cases", () => {
    expect(all.length).toBe(192);
    for (const m of all) expect(runLowered(m).addr, JSON.stringify(m)).toBe(effAddr(m));
  });
  test("RISC-V needs 1 to 5 instructions; x86 always 1", () => {
    const counts = all.map((m) => lowerRv(m).length);
    expect(Math.min(...counts)).toBe(1);
    expect(Math.max(...counts)).toBe(5);
    expect(lowerRv({ scale: 1, index: false, disp: 2047 }).length).toBe(1);
    expect(lowerRv({ scale: 1, index: false, disp: 2048 }).length).toBe(3);
    expect(lowerRv({ scale: 4, index: true, disp: 8 }).length).toBe(3);
    expect(lowerRv({ scale: 4, index: true, disp: 2047 }).length).toBe(3);
    expect(lowerRv({ scale: 4, index: true, disp: 2048 }).length).toBe(5);
  });
  test("x86 lengths: 2 to 7 bytes (checked against clang)", () => {
    expect(lowerX86({ scale: 1, index: false, disp: 0 }).bytes).toEqual([0x8b, 0x07]);
    expect(lowerX86({ scale: 4, index: true, disp: 0 }).bytes).toEqual([0x8b, 0x04, 0xb7]);
    expect(lowerX86({ scale: 4, index: true, disp: 4 }).bytes.length).toBe(4);
    expect(lowerX86({ scale: 4, index: true, disp: 128 }).bytes.length).toBe(7);
    expect(lowerX86({ scale: 4, index: true, disp: 127 }).bytes.length).toBe(4);
    expect(lowerX86({ scale: 4, index: true, disp: 8 }).bytes.length).toBe(4);
    expect(lowerX86({ scale: 1, index: false, disp: -128 }).bytes.length).toBe(3);
    expect(lowerX86({ scale: 1, index: false, disp: 128 }).bytes.length).toBe(6);
  });
  test("AArch64 rules", () => {
    expect(lowerArm({ scale: 4, index: true, disp: 0 })).toEqual(["ldr  w0, [x0, x1, lsl #2]"]);
    expect(lowerArm({ scale: 8, index: true, disp: 0 }).length).toBe(2);
    expect(lowerArm({ scale: 4, index: true, disp: 8 }).length).toBe(2);
    expect(lowerArm({ scale: 1, index: false, disp: 16380 }).length).toBe(1);
    expect(lowerArm({ scale: 1, index: false, disp: 16384 }).length).toBe(2);
    expect(lowerArm({ scale: 1, index: false, disp: -256 }).length).toBe(1);
    expect(lowerArm({ scale: 1, index: false, disp: -257 }).length).toBe(2);
    expect(lowerArm({ scale: 1, index: false, disp: 70000 }).length).toBe(3);
  });
});

// ---------------------------------------------------------------- calling conventions

describe("frames", () => {
  test("fact(10): 160 bytes of stack at the deepest point, exit 3628800", () => {
    const r = factRun(10);
    expect(r.top - r.minSp).toBe(160);
    expect(r.exitCode).toBe(3628800);
  });
  test("fact(n) uses 16 n bytes; fact(13) wraps around mod 2^32", () => {
    for (let n = 1; n <= 12; n++) { const r = factRun(n); expect(r.top - r.minSp).toBe(16 * n); }
    expect(factRun(12).exitCode).toBe(479001600);
    expect(factRun(13).exitCode).toBe(1932053504);
  });
  test("fact(4) at its deepest: 4 frames, ra and s0 saved at 12 and 8, 8 bytes of padding each", () => {
    const r = factRun(4);
    let deepest = 0, k = 0;
    for (let i = 0; i <= r.steps; i++) { const v = frameView(r.program, i, 80); if (v.depth > deepest) { deepest = v.depth; k = i; } }
    expect(deepest).toBe(4);
    const v = frameView(r.program, k + 2, 80);
    const f0 = v.words.filter((w) => w.frame === 0).map((w) => w.what);
    expect(f0).toEqual(["saved ra", "saved s0", "padding", "padding"]);
  });
});

test("the hand-written RISC-V keep() of the lesson keeps x across the call", async () => {
  const { Hart } = await import("../../src/sims/arch/rv");
  const src = `        .text
_start: li   a0, 5
        call keep
        li   a7, 93
        ecall
keep:   addi sp, sp, -16
        sw   ra, 12(sp)
        sw   s0, 8(sp)
        mv   s0, a0
        call h
        add  a0, a0, s0
        lw   s0, 8(sp)
        lw   ra, 12(sp)
        addi sp, sp, 16
        ret
h:      li   s0, 99          # h may not change s0... unless it restores it; here it breaks the rule on purpose
        slli a0, a0, 1
        ret
`;
  const ok = src.replace("h:      li   s0, 99          # h may not change s0... unless it restores it; here it breaks the rule on purpose", "h:      li   t0, 99");
  const run = (s: string) => { const h = new Hart(assemble(s).program); h.run(); return h.exitCode; };
  expect(run(ok)).toBe(15);    // h(5) + 5 = 10 + 5
  expect(run(src)).toBe(109);  // a callee that breaks the convention corrupts the caller: 10 + 99
});

describe("caller-saved against callee-saved", () => {
  test("the result never depends on the split", () => {
    for (const p of [{ live: 4, temps: 6, calls: 8 }, { live: 0, temps: 3, calls: 2 }, { live: 12, temps: 12, calls: 3 }])
      for (const r of splitSweep(p)) expect(r.ok, JSON.stringify(r.params)).toBe(true);
  });
  test("live 4, temps 6, 8 calls: 66 at 0, 10 from 4 to 19, 106 at 25", () => {
    const s = splitSweep({ live: 4, temps: 6, calls: 8 }).map((r) => r.memOps);
    expect(s[0]).toBe(66);
    expect(s.slice(4, 20).every((x) => x === 10)).toBe(true);
    expect(s[3]).toBe(24);
    expect(s[20]).toBe(26);
    expect(s[25]).toBe(106);
    expect(s[RISCV_SPLIT]).toBe(10);
  });
  test("live 10, temps 12, 8 calls: the best splits are 10 to 13 callee-saved, and 12 is one of them", () => {
    const s = splitSweep({ live: 10, temps: 12, calls: 8 }).map((r) => r.memOps);
    const best = Math.min(...s);
    expect(best).toBe(22);
    expect(s.map((x, i) => (x === best ? i : -1)).filter((i) => i >= 0)).toEqual([10, 11, 12, 13]);
    expect(s[0]).toBe(162);
  });
  test("pool and expected value", () => {
    expect(POOL.length).toBe(25);
    expect(splitExpect({ calleeSaved: 0, live: 4, temps: 6, calls: 8 })).toBe(10 + 8 * 21);
    expect(runSplit({ calleeSaved: 12, live: 4, temps: 6, calls: 8 }).exitCode).toBe(178);
  });
});

// ---------------------------------------------------------------- x86-64 and Arm compared

const GOLD: { bytes: string; lengths: Record<string, number[]> } = {"bytes": "31c04885ff7415660f1f84000000000048034708488b3f4885ff75f4c30f1f004885f60f84f30000004883fe03770731c0e9d70000000fb6ca4883fe20730431c0eb764889f04883e0e0660f6ec1660f60c0f20f70c000660f70c044660f6f0d000000004531c0660f6f1500000000660f6f1d00000000660f1f840000000000660f6fe1660ffce2660f6fe8660fefe9660fefe0f3420f7f2c07f3420f7f6407104983c020660ffccb4c39c075d24839c6746940f6c61c74544989c04889f04883e0fc660f6ec1660f60c0f20f70c00066410f6ec8660f60c9f20f70c900660feb0d00000000660f6f15000000006690660f6fd8660fefd966420f7e1c074983c004660ffcca4c39c075e5eb0a89d130c1880c0748ffc04839c675f1c30f1f0085d27e164189d04489c083e00383fa04730c660f57c031c9eb5d0f57c0c34181e0fcffff7f660f57c031c90f1f440000f20f100ccff20f1054cf08f20f590ccef20f5954ce08f20f58c8f20f105ccf10f20f595cce10f20f58d1f20f1044cf18f20f5944ce18f20f58daf20f58c34883c1044939c875b94885c0742a488d14ce488d0ccf31f6662e0f1f840000000000f20f100cf1f20f590cf2f20f58c148ffc64839f075eac3660f1f84000000000069ca43420f00c1fa038d827856341239f70f4cc1c366662e0f1f84000000000048b88967452301000000480fafc74883c04dc3666666662e0f1f8400000000004863c60fb70447052c010000c30f1f0089f889f94869c92549922448c1e92089fa29cad1ea01cad1ea83e2fe8d0c5229c8c366666666662e0f1f840000000000b8ffffffff83ff03770c89f8488d0d000000008b0481c3", "lengths": {"0": [2, 3, 2, 9, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "1": [4, 2, 9, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "2": [3, 2, 9, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "3": [2, 2, 9, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "4": [4, 8, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "5": [2, 9, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "6": [5, 2, 2, 3, 4, 1, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1], "7": [9, 4, 3, 3, 2, 1, 3, 3, 6, 4, 2, 2, 5, 3, 4, 2, 2, 2, 3, 4, 4, 4, 5, 5, 8, 3, 8, 8, 9, 4, 4, 4, 4, 4, 6, 7, 4, 4, 3, 2, 3, 2, 4, 2, 3, 3, 4, 4, 4, 5, 5, 4, 5, 8, 8, 2, 4, 4, 6, 4, 4, 3, 2, 2, 2, 2, 3, 3, 3, 2, 1, 3, 2, 2, 3, 3, 3, 3, 2, 4, 2, 2, 3, 1, 7, 4, 2, 5, 5, 6, 5, 6, 4, 6, 6, 4, 6, 6, 4, 4, 4, 3, 2, 3, 2, 4, 4, 2, 10, 5, 5, 4, 3, 3, 2, 1, 9, 6, 3, 6, 2, 3, 1, 11, 10, 4, 4, 1, 13, 3, 4, 5, 1, 3, 2, 2, 7, 4, 2, 2, 2, 2, 2, 3, 3, 2, 1, 14, 5, 3, 2, 2, 7, 3, 1]}};

describe("x86 length decoder", () => {
  const bytes = GOLD.bytes.match(/../g)!.map((h) => parseInt(h, 16));
  test("matches LLVM's disassembler on compiled code from offsets 0 to 7", () => {
    for (const [k, lens] of Object.entries(GOLD.lengths)) expect(decodeStream(bytes.slice(Number(k))).map((d) => d.len), k).toEqual(lens);
  });
  test("prefixes, REX, ModRM, SIB, disp and imm", () => {
    expect(decodeAt([0x66, 0x2e, 0x0f, 0x1f, 0x84, 0, 0, 0, 0, 0], 0).len).toBe(10);
    expect(decodeAt([0x48, 0xb8, 1, 2, 3, 4, 5, 6, 7, 8], 0).len).toBe(10);
    expect(decodeAt([0x48, 0xc7, 0xc0, 0xff, 0xff, 0xff, 0xff], 0).len).toBe(7);
    expect(decodeAt([0xf6, 0x07, 0x01], 0).len).toBe(3);
    expect(decodeAt([0xf7, 0x17], 0).len).toBe(2);
    expect(decodeAt([0x17], 0).valid).toBe(false);
  });
  test("the lesson's stream (sum, max2, addf, slen): 55 bytes, 22 instructions; from byte 1 back in step at 3, from 8 at 18", () => {
    const s = ["sum", "max2", "addf", "slen"].flatMap((id) => listingById(id).x86.flatMap((m) => m.bytes));
    const truth = decodeStream(s);
    expect(s.length).toBe(55);
    expect(truth.length).toBe(22);
    expect(Math.max(...truth.map((t) => t.len))).toBe(7);
    expect(resyncAt(truth, 1, s)).toBe(3);
    expect(decodeStream(s, 1)[0]!.len).toBe(2);
    expect(resyncAt(truth, 8, s)).toBe(18);
    expect(decodeStream(s, 8).filter((d) => d.start < 18).length).toBe(3);
    expect(decodeStream(s, 8).filter((d) => d.start < 18).every((d) => d.valid)).toBe(true);
    expect(Math.min(...truth.map((t) => t.len))).toBe(1);
    expect(s[1]).toBe(0x85);
    expect(s[4]).toBe(0x17);
    expect(decodeStream(s, 4)[0]!.valid).toBe(false);
  });
});

describe("flags", () => {
  test("every condition: x86 flags, Arm flags and the direct compare agree for all 65,536 pairs", () => {
    for (let a = -128; a < 128; a++) for (let b = -128; b < 128; b++) {
      const f = cmp8(a, b);
      for (const c of CONDS) { const t = c.take(a, b); if (c.read(f) !== t || c.armRead(f) !== t) throw new Error(`${c.c} ${a} ${b}`); }
    }
  });
  test("100 - (-100) overflows 8 signed bits; Arm C is the opposite of x86 CF", () => {
    const f = cmp8(100, -100);
    expect(f.of).toBe(true);
    expect(f.sf).toBe(true);
    expect(f.diff).toBe(200);
    for (let a = 0; a < 256; a += 7) for (let b = 0; b < 256; b += 5) { const g = cmp8(a, b); expect(g.c).toBe(!g.cf); }
  });
});
