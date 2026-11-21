/** Demos for the lesson on two's complement. */
import { useState } from "react";
import { Demo, Param, Stats, Legend, range, seg, useParams, Btn, ButtonRow, Note, SectionLabel, Banner, Chip, MiniTable, Arrow, mono, useWidth } from "../../kit";
import {
  add, divide, langAdd, LANGS, maxSigned, maxUnsigned, minSigned, rvSignedAddCheck, sra, srl, signExtend, zeroExtend, toSigned, toUnsigned, walk, wheel,
  divTrunc, divFloor, type DivPlatform,
} from "../../sims/arch/data";
import { BitRow, Readout, TextField, cellsOf } from "./ArchDataUi";

const bin = (x: bigint, w: number) => toUnsigned(x, w).toString(2).padStart(w, "0");

// ---------------------------------------------------------------- the wheel

export function ArchDataWheelDemo() {
  const p = useParams("wheel", {
    a: range({ label: "a (as unsigned)", min: 0, max: 255, step: 1, default: 6 }),
    b: range({ label: "b (as signed)", min: -128, max: 127, step: 1, default: 3 }),
    w: seg<"3" | "4" | "8">("Width", [["3", "3 bits"], ["4", "4 bits"], ["8", "8 bits"]], "4"),
  });
  const w = Number(p.values.w);
  const N = 1 << w;
  const a = BigInt(Math.min(p.values.a, N - 1));
  const b = BigInt(Math.max(Math.min(p.values.b, N / 2 - 1), -N / 2));
  const r = add(a, b, w);
  const wk = walk(a, b, w);
  const pts = wheel(w);
  const [ref, width] = useWidth<HTMLDivElement>(360);
  const S = Math.max(260, Math.min(400, width));
  const c = S / 2, R = S / 2 - (w <= 4 ? 44 : 22);
  const at = (i: number | bigint, rad: number): [number, number] => { const t = (2 * Math.PI * Number(i)) / N; return [c + rad * Math.sin(t), c - rad * Math.cos(t)]; };
  const arc = (from: bigint, steps: bigint, rad: number) => {
    const s = Number(steps);
    if (s === 0) return "";
    const [x0, y0] = at(from, rad), [x1, y1] = at(Number(from) + s, rad);
    const large = Math.abs(s) > N / 2 ? 1 : 0;
    return `M${x0},${y0} A${rad},${rad} 0 ${large} ${s > 0 ? 1 : 0} ${x1},${y1}`;
  };
  const seam = (i: number, color: string, text: string) => {
    const [x0, y0] = at(i - 0.5, R - 12), [x1, y1] = at(i - 0.5, R + 12);
    return <g><title>{text}</title><line x1={x0} y1={y0} x2={x1} y2={y1} stroke={color} strokeWidth={3} /></g>;
  };
  const resultIdx = Number(r.bits);
  return (
    <Demo
      title="One adder, two readings: the number wheel"
      controls={<>
        <Param spec={{ ...p.schema.a, max: N - 1 }} value={Number(a)} onChange={(v) => p.set("a", v as number)} />
        <Param spec={{ ...p.schema.b, min: -N / 2, max: N / 2 - 1 }} value={Number(b)} onChange={(v) => p.set("b", v as number)} />
        <Param spec={p.schema.w} value={p.values.w} onChange={(v) => p.set("w", v as "3" | "4" | "8")} />
      </>}
    >
      <div ref={ref} style={{ display: "flex", justifyContent: "center" }}>
        <svg width={S} height={S} role="img" aria-label="number wheel">
          <defs><Arrow id="wh-u" color="var(--c1)" /><Arrow id="wh-s" color="var(--c5)" /></defs>
          <circle cx={c} cy={c} r={R} fill="none" stroke="var(--border)" />
          {pts.map((pt, i) => {
            const [x, y] = at(i, R);
            const hot = i === Number(a) || i === resultIdx;
            const label = w <= 4 || i === 0 || i === N / 2 || i === N / 2 - 1 || i === N - 1 || hot;
            const [lx, ly] = at(i, R + (w <= 4 ? 24 : 14));
            const [ix, iy] = at(i, R - 22);
            return (
              <g key={i}>
                <circle cx={x} cy={y} r={hot ? 6 : w <= 4 ? 4 : 1.6} fill={i === resultIdx ? "var(--c3)" : i === Number(a) ? "var(--fg)" : "var(--muted)"} />
                {label && w <= 4 && <text x={lx} y={ly} fontSize={10.5} textAnchor="middle" dy="0.32em" fill="var(--fg)" style={mono}>{bin(pt.bits, w)}</text>}
                {label && w <= 4 && <text x={ix} y={iy} fontSize={9.5} textAnchor="middle" dy="0.32em" fill="var(--muted)">{`${pt.unsigned}|${pt.signed}`}</text>}
                {label && w > 4 && <text x={lx} y={ly} fontSize={9.5} textAnchor="middle" dy="0.32em" fill={hot ? "var(--fg)" : "var(--muted)"}>{`${pt.unsigned}|${pt.signed}`}</text>}
              </g>
            );
          })}
          {seam(0, "var(--c2)", "carry seam")}
          {seam(N / 2, "var(--c4)", "overflow seam")}
          <path d={arc(wk.from, wk.unsignedSteps, R * 0.62)} fill="none" stroke="var(--c1)" strokeWidth={2.5} markerEnd="url(#wh-u)" />
          <path d={arc(wk.from, wk.signedSteps, R * 0.48)} fill="none" stroke="var(--c5)" strokeWidth={2.5} strokeDasharray="5 3" markerEnd="url(#wh-s)" />
          <text x={c} y={c - 8} textAnchor="middle" fontSize={12} fill="var(--fg)" style={mono}>{bin(r.bits, w)}</text>
          <text x={c} y={c + 10} textAnchor="middle" fontSize={10.5} fill="var(--muted)">{`u ${r.unsigned} | s ${r.signed}`}</text>
        </svg>
      </div>
      <Legend items={[{ label: "carry seam: max → 0", color: "var(--c2)" }, { label: "overflow seam: MAX → MIN", color: "var(--c4)" }, { label: "adder (unsigned walk)", color: "var(--c1)" }, { label: "signed reading", color: "var(--c5)" }]} />
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", margin: "4px 0 6px" }}>
        {(["cf", "of", "sf", "zf"] as const).map((f) => <Chip key={f} filled={r[f]} color={f === "cf" ? "var(--c2)" : f === "of" ? "var(--c4)" : "var(--c1)"}>{f.toUpperCase()} = {r[f] ? 1 : 0}</Chip>)}
      </div>
      <Readout label="bits" >{bin(a, w)} + {bin(b, w)} = {bin(r.bits, w)}</Readout>
      <Readout label="unsigned" color={r.cf ? "var(--c4)" : undefined}>{toUnsigned(a, w).toString()} + {toUnsigned(b, w).toString()} = {r.trueUnsigned.toString()} → {r.unsigned.toString()}{r.cf ? " (wrong: carry out)" : ""}</Readout>
      <Readout label="signed" color={r.of ? "var(--c4)" : undefined}>{toSigned(a, w).toString()} + {b.toString()} = {r.trueSigned.toString()} → {r.signed.toString()}{r.of ? " (wrong: overflow)" : ""}</Readout>
      <Note>Labels read unsigned|signed. The solid arc is the adder: it always walks clockwise by the unsigned value of b. The dashed arc is the signed reading. CF is set when the solid arc crosses the carry seam. OF is set when the dashed arc crosses the overflow seam.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- widen a byte

export function ArchDataExtendDemo() {
  const p = useParams("extend", { byte: range({ label: "Byte in memory", min: 0, max: 255, step: 1, default: 0xf6, format: (v) => `0x${v.toString(16).padStart(2, "0").toUpperCase()}` }) });
  const x = BigInt(p.values.byte);
  const sx = signExtend(x, 8, 32), zx = zeroExtend(x, 8, 32);
  const top = (color: string) => (i: number) => (i >= 8 ? color : "var(--c1)");
  return (
    <Demo title="Load one byte into a 32-bit register" controls={<Param spec={p.schema.byte} value={p.values.byte} onChange={(v) => p.set("byte", v as number)} />}>
      <BitRow label={<>the byte: unsigned {Number(x)}, signed {toSigned(x, 8).toString()}</>} cells={cellsOf(x, 8, () => "var(--c1)")} />
      <SectionLabel>Sign extension: RISC-V lb, x86 movsx, Arm LDRSB</SectionLabel>
      <BitRow cells={cellsOf(sx, 32, top("var(--c4)"))} />
      <Readout label="register">0x{sx.toString(16).padStart(8, "0")} = {toSigned(sx, 32).toString()} as signed</Readout>
      <SectionLabel>Zero extension: RISC-V lbu, x86 movzx, Arm LDRB</SectionLabel>
      <BitRow cells={cellsOf(zx, 32, top("var(--c3)"))} />
      <Readout label="register">0x{zx.toString(16).padStart(8, "0")} = {zx.toString()}</Readout>
      <Banner ok={sx === zx}>{sx === zx ? "Bit 7 is 0, so both loads give the same register." : "Bit 7 is 1. Sign extension copies it into all 24 upper bits, so the signed value stays the same. Zero extension keeps the unsigned value."}</Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- shifts round down

export function ArchDataShiftDemo() {
  const p = useParams("sra", {
    x: range({ label: "x (8-bit signed)", min: -128, max: 127, step: 1, default: -7 }),
    k: range({ label: "Shift k", min: 0, max: 7, step: 1, default: 1 }),
  });
  const x = BigInt(p.values.x), k = p.values.k;
  const ar = sra(x, k, 8), lr = srl(x, k, 8);
  const pow = 2n ** BigInt(k);
  const trunc = divTrunc(x, pow), floor = divFloor(x, pow);
  const fixed = toSigned(sra(x + (x < 0n ? pow - 1n : 0n), k, 8), 8);
  return (
    <Demo
      title="Shift right: arithmetic, logical, and division"
      controls={<>
        <Param spec={p.schema.x} value={p.values.x} onChange={(v) => p.set("x", v as number)} />
        <Param spec={p.schema.k} value={k} onChange={(v) => p.set("k", v as number)} />
      </>}
    >
      <BitRow label={<>x = {x.toString()}</>} cells={cellsOf(toUnsigned(x, 8), 8, () => "var(--c1)")} />
      <BitRow label={<>arithmetic: <span style={mono}>sra</span> / <span style={mono}>sar</span> = {toSigned(ar, 8).toString()}</>} cells={cellsOf(ar, 8, (i) => (i >= 8 - k ? "var(--c4)" : "var(--c1)"))} />
      <BitRow label={<>logical: <span style={mono}>srl</span> / <span style={mono}>shr</span> = {lr.toString()}</>} cells={cellsOf(lr, 8, (i) => (i >= 8 - k ? "var(--c3)" : "var(--c1)"))} />
      <Stats items={[
        { label: "x >> k (arithmetic)", value: String(toSigned(ar, 8)) },
        { label: "$\\lfloor x / 2^k \\rfloor$", value: String(floor) },
        { label: "C, Rust, Go: $x / 2^k$", value: String(trunc) },
        { label: "compiler fix: (x + bias) >> k", value: String(fixed) },
      ]} />
      <Banner ok={trunc === floor}>
        {trunc === floor
          ? "Here the shift and the division agree."
          : `The shift rounds toward −∞ and gives ${floor}. Division rounds toward zero and gives ${trunc}. So a compiler cannot turn x / ${pow} into one shift for a signed x. It adds ${pow - 1n} first when x is negative.`}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- the edge cases

type Op = "add" | "div";
const PRESETS: Record<Op, { label: string; a: (w: number) => bigint; b: (w: number) => bigint }[]> = {
  add: [
    { label: "MAX + 1", a: maxSigned, b: () => 1n },
    { label: "MIN + (−1)", a: minSigned, b: () => -1n },
    { label: "100 + 27", a: () => 100n, b: () => 27n },
    { label: "−1 + 1", a: () => -1n, b: () => 1n },
  ],
  div: [
    { label: "MIN / −1", a: minSigned, b: () => -1n },
    { label: "7 / 0", a: () => 7n, b: () => 0n },
    { label: "−7 / 2", a: () => -7n, b: () => 2n },
  ],
};
const DIV_ROWS: [DivPlatform, string, string][] = [
  ["x86", "x86-64", "idiv"], ["riscv", "RISC-V", "div / rem"], ["arm64", "AArch64", "sdiv"],
  ["c", "C", "a / b"], ["rust", "Rust", "a / b"], ["go", "Go", "a / b"], ["zig", "Zig", "@divTrunc(a, b)"],
];
const tone = (kind: string) => (kind === "value" ? undefined : kind === "none" ? "var(--c2)" : "var(--c4)");

export function ArchDataOverflowDemo() {
  const p = useParams("ovf", {
    op: seg<Op>("Operation", [["add", "a + b"], ["div", "a / b"]], "add"),
    w: seg<"8" | "16" | "32" | "64">("Width", [["8", "8"], ["16", "16"], ["32", "32"], ["64", "64"]], "32"),
  });
  const w = Number(p.values.w), op = p.values.op;
  const [ta, setTa] = useState("2147483647");
  const [tb, setTb] = useState("1");
  const parse = (s: string) => { try { return /^\s*-?\d+\s*$/.test(s) ? BigInt(s.trim()) : null; } catch { return null; } };
  const A = parse(ta), B = parse(tb);
  const fits = (v: bigint | null) => v !== null && v >= minSigned(w) && v <= maxSigned(w);
  const ok = fits(A) && fits(B);
  const preset = (i: number) => { const pr = PRESETS[op][i]!; setTa(pr.a(w).toString()); setTb(pr.b(w).toString()); };
  const r = ok ? add(A!, B!, w) : null;
  const rv = ok ? rvSignedAddCheck(A!, B!, w) : null;
  return (
    <Demo
      title="The edge cases: what each language and ISA does"
      actions={<ButtonRow>{PRESETS[op].map((pr, i) => <Btn key={pr.label} onClick={() => preset(i)}>{pr.label}</Btn>)}</ButtonRow>}
      controls={<>
        <Param spec={p.schema.op} value={op} onChange={(v) => { p.set("op", v as Op); const pr = PRESETS[v as Op][0]!; setTa(pr.a(w).toString()); setTb(pr.b(w).toString()); }} />
        <Param spec={p.schema.w} value={p.values.w} onChange={(v) => { p.set("w", v as typeof p.values.w); const nw = Number(v); const pr = PRESETS[op][0]!; setTa(pr.a(nw).toString()); setTb(pr.b(nw).toString()); }} />
      </>}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <TextField label="a" value={ta} onChange={setTa} bad={!fits(A)} width={190} />
        <TextField label="b" value={tb} onChange={setTb} bad={!fits(B)} width={190} />
      </div>
      <Note>Signed {w}-bit range: {minSigned(w).toString()} to {maxSigned(w).toString()}. Unsigned maximum: {maxUnsigned(w).toString()}.</Note>
      {!ok ? <Banner ok={false}>Enter two integers in the signed {w}-bit range.</Banner> : op === "add" ? (
        <>
          <SectionLabel>The hardware</SectionLabel>
          <Readout label="x86 add">{`result ${r!.signed}; CF=${+r!.cf} OF=${+r!.of} SF=${+r!.sf} ZF=${+r!.zf}`}</Readout>
          <Readout label="RISC-V">{`add t0 → ${rv!.t0}; slti t3 → ${rv!.t3}; slt t4 → ${rv!.t4}; bne t3, t4 → ${rv!.overflow ? "branch: overflow" : "no branch"}`}</Readout>
          <SectionLabel>The languages</SectionLabel>
          <MiniTable head={["language", "code", "result"]} rows={LANGS.map((l) => { const o = langAdd(A!, B!, w, l.lang); return [l.label, <span style={mono}>{l.code}</span>, <span style={{ color: tone(o.kind) }}>{o.text}</span>]; })} />
        </>
      ) : (
        <>
          <SectionLabel>Signed division</SectionLabel>
          <MiniTable head={["platform", "code", "result"]} rows={DIV_ROWS.map(([pl, name, code]) => {
            const o = divide(A!, B!, w, pl);
            return [name, <span style={mono}>{code}</span>, <span style={{ color: tone(o.kind) }}>{o.kind === "value" ? `q = ${o.q}, r = ${o.r}${o.text !== "normal result" ? ` (${o.text})` : ""}` : o.text}</span>];
          })} />
        </>
      )}
    </Demo>
  );
}
