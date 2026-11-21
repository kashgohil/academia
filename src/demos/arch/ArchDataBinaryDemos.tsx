/** Demos for the lesson on binary and hexadecimal. */
import { useMemo, useState } from "react";
import { Demo, Line, Dots, Param, Plot, RuleY, Stats, Legend, range, seg, select, useParams, Btn, ButtonRow, Note, SectionLabel, Banner, mono, Rich } from "../../kit";
import {
  BIT_OPS, COUNTERS, ELF_FIELDS, applyOp, intArrayBytes, intArrayFields, clz, ctz, decimalDigits, digits, elfHeaderBytes, flipBit, group3, groups, humanDuration, isPow2, mask, opOperand,
  popcount, readLe, textBytes, wrap, wrapSeconds, type BitOp, type Width,
} from "../../sims/arch/data";
import { BitRow, Readout, TextField, cellsOf } from "./ArchDataUi";

const NIBBLE = (i: number) => (Math.floor(i / 4) % 2 === 0 ? "var(--c1)" : "var(--c5)");

/** Parses 123, 0x7b, 0o173 or 0b1111011 (underscores allowed). */
function parseWord(s: string): bigint | null {
  const t = s.trim().replace(/_/g, "");
  if (!/^(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+)$/.test(t)) return null;
  try { return BigInt(t); } catch { return null; }
}

// ---------------------------------------------------------------- flip bits

export function ArchDataBitFlipperDemo() {
  const p = useParams("bitflip", { w: seg<"8" | "16" | "32" | "64">("Word size", [["8", "8 bits"], ["16", "16 bits"], ["32", "32 bits"], ["64", "64 bits"]], "16") });
  const w = Number(p.values.w) as Width;
  const [x, setX] = useState<bigint>(0x2an);
  const [text, setText] = useState("");
  const v = wrap(x, w);
  const set = (n: bigint) => { setX(wrap(n, w)); setText(""); };
  const hex = digits(v, 16, w);
  const parsed = text ? parseWord(text) : null;
  const terms: string[] = [];
  for (let i = w - 1; i >= 0; i--) if ((v >> BigInt(i)) & 1n) terms.push(String(2n ** BigInt(i)));
  return (
    <Demo
      title="Flip bits and read the value in four bases"
      actions={<ButtonRow>
        <Btn onClick={() => set(v + 1n)}>+1</Btn>
        <Btn onClick={() => set(v - 1n)}>−1</Btn>
        <Btn onClick={() => set(v << 1n)}>× 2</Btn>
        <Btn onClick={() => set(v >> 1n)}>÷ 2</Btn>
        <Btn ghost onClick={() => set(0n)}>Clear</Btn>
        <Btn ghost onClick={() => set(mask(w))}>All ones</Btn>
      </ButtonRow>}
      controls={<Param spec={p.schema.w} value={p.values.w} onChange={(n) => { p.set("w", n as typeof p.values.w); setX(wrap(x, Number(n))); }} />}
    >
      <BitRow
        cells={cellsOf(v, w, NIBBLE)}
        onFlip={(i) => set(flipBit(v, i, w))}
        below={(start) => <div style={{ textAlign: "center", fontSize: 13, fontWeight: 600, ...mono }}>{hex[hex.length - 1 - Math.floor(start / 4)]}</div>}
        ariaLabel="bits of the word"
      />
      <div style={{ marginTop: 8 }}>
        <Readout label="hexadecimal">0x{hex}</Readout>
        <Readout label="decimal">{group3(v)}</Readout>
        <Readout label="octal">0o{digits(v, 8, w)}</Readout>
        <Readout label="binary">0b{groups(digits(v, 2, w), 4).join("_")}</Readout>
        <Readout label="place values">{terms.length === 0 ? "0" : terms.length > 8 ? `${terms.slice(0, 7).join(" + ")} + … (${terms.length} terms)` : terms.join(" + ")}</Readout>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <TextField label="Type a value" value={text} placeholder="42, 0x2A, 0o52 or 0b101010" bad={!!text && parsed === null} onChange={(s) => { setText(s); const n = parseWord(s); if (n !== null) setX(wrap(n, w)); }} />
      </div>
      <Stats items={[
        { label: "bits set (popcount)", value: String(popcount(v)) },
        { label: "hex digits", value: String(w / 4) },
        { label: "decimal digits for the maximum", value: String(decimalDigits(w)) },
        { label: "largest value", value: group3(mask(w)) },
      ]} />
      <Note>Each hex digit under the bits is exactly one group of 4 bits. A decimal digit has no such group: flip one high bit, and most decimal digits change.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- the toolkit

export function ArchDataBitOpsDemo() {
  const p = useParams("bitops", {
    op: select<BitOp>({ label: "Operation", options: BIT_OPS.map((o) => ({ value: o.op, label: `${o.label}:  ${o.expr}` })), default: "clearLowest" }),
    w: seg<"8" | "16" | "32">("Word size", [["8", "8"], ["16", "16"], ["32", "32"]], "16"),
    k: range({ label: "Shift k (or field start)", min: 0, max: 31, step: 1, default: 4 }),
    n: range({ label: "Field width n", min: 1, max: 16, step: 1, default: 4 }),
  });
  const w = Number(p.values.w);
  const { op } = p.values;
  const k = Math.min(p.values.k, w - 1), n = Math.min(p.values.n, w - k);
  const info = BIT_OPS.find((o) => o.op === op)!;
  const [x, setX] = useState<bigint>(0b0110_1000n);
  const [y, setY] = useState<bigint>(0x0fn);
  const X = wrap(x, w), Y = wrap(y, w);
  const r = applyOp(op, X, w, Y, k, n);
  const operand = opOperand(op, X, w, Y, k, n);
  const operandLabel = op === "clearLowest" ? "x − 1" : op === "lowest" ? "−x (invert, add 1)" : op === "field" ? "mask after the shift, shown in place" : "y";
  const changed = (i: number) => (((r ^ X) >> BigInt(i)) & 1n) === 1n;
  return (
    <Demo
      title="The bit toolkit: masks, shifts and tricks"
      actions={<ButtonRow>
        <Btn onClick={() => setX(BigInt(Math.floor(Math.random() * 2 ** Math.min(w, 32))))}>Random x</Btn>
        <Btn ghost onClick={() => setX(1n << BigInt(Math.floor(w / 2)))}>x = power of 2</Btn>
      </ButtonRow>}
      controls={<>
        <Param spec={p.schema.op} value={op} onChange={(v) => p.set("op", v as BitOp)} />
        <Param spec={p.schema.w} value={p.values.w} onChange={(v) => p.set("w", v as typeof p.values.w)} />
        {(info.uses === "k" || info.uses === "field") && <Param spec={{ ...p.schema.k, max: w - 1 }} value={k} onChange={(v) => p.set("k", v as number)} />}
        {info.uses === "field" && <Param spec={{ ...p.schema.n, max: w - k }} value={n} onChange={(v) => p.set("n", v as number)} />}
      </>}
    >
      <BitRow label={<>x = {group3(X)} (click to flip)</>} cells={cellsOf(X, w, () => "var(--c1)")} onFlip={(i) => setX(flipBit(X, i, w))} />
      {operand !== null && (
        <BitRow
          label={<>{operandLabel}{info.uses === "y" ? " (click to flip)" : ""}</>}
          cells={cellsOf(operand, w, () => "var(--c2)")}
          onFlip={info.uses === "y" ? (i) => setY(flipBit(Y, i, w)) : undefined}
        />
      )}
      <BitRow label={<>result: <b style={{ color: "var(--fg)" }}>{info.expr}</b> = {group3(r)}</>} cells={cellsOf(r, w, () => "var(--c3)", (i) => ({ mark: op !== "field" && op !== "nextPow2" && changed(i) }))} />
      <Banner tone="info"><Rich text={info.meaning} /></Banner>
      <Stats items={[
        { label: "popcount(x)", value: String(popcount(X)) },
        { label: "trailing zeros", value: String(ctz(X, w)) },
        { label: "leading zeros", value: String(clz(X, w)) },
        { label: "x is a power of 2", value: isPow2(X) ? "yes" : "no" },
      ]} />
      <Note>A black outline marks a result bit that differs from x.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- growth

const SUPC: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const SUPS = (k: number) => String(k).split("").map((c) => SUPC[c] ?? c).join("");

export function ArchDataGrowthDemo() {
  const p = useParams("growth", {
    bits: range({ label: "Counter width (bits)", min: 8, max: 64, step: 1, default: 32 }),
    unit: select({ label: "One count is", options: COUNTERS.map((c, i) => ({ value: String(i), label: `${c.name} (${c.note})` })), default: "1" }),
  });
  const c = COUNTERS[Number(p.values.unit)]!;
  const n = p.values.bits;
  const t = wrapSeconds(n, c.perSecond);
  const pts = useMemo(() => Array.from({ length: 57 }, (_, i) => [i + 8, wrapSeconds(i + 8, c.perSecond)] as [number, number]), [c.perSecond]);
  const refs: [number, string][] = [[1, "1 second"], [86400, "1 day"], [365.25 * 86400, "1 year"], [1e9 * 365.25 * 86400, "1 billion years"]];
  return (
    <Demo
      title="How long until a counter wraps to 0"
      controls={<>
        <Param spec={p.schema.bits} value={n} onChange={(v) => p.set("bits", v as number)} />
        <Param spec={p.schema.unit} value={p.values.unit} onChange={(v) => p.set("unit", v as string)} />
      </>}
    >
      <Stats items={[
        { label: `$2^{${n}}$ values`, value: group3(2n ** BigInt(n)) },
        { label: "time to wrap", value: humanDuration(t) },
        { label: "one more bit", value: "doubles it" },
      ]} />
      <Plot x={[8, 64]} y={[1e-9, 1e19]} logY height={250} xLabel="counter width (bits)" yLabel="seconds to wrap" yTicks={[1e-9, 1e-6, 1e-3, 1, 1e3, 1e6, 1e9, 1e12, 1e15, 1e18].filter((_, i) => i % 2 === 0)} yFormat={(v) => `10${SUPS(Math.round(Math.log10(v)))}`} xTicks={[8, 16, 24, 32, 40, 48, 56, 64]}>
        {refs.map(([s, l]) => <RuleY key={l} at={s} label={l} />)}
        <Line points={pts} />
        <Dots points={[[n, t]]} r={5} color="var(--c4)" />
      </Plot>
      <Legend items={[{ label: `wrap time, one count = ${c.name}`, color: "var(--c1)" }, { label: "this width", color: "var(--c4)" }]} />
      <Note>Each bit doubles the range, so the line is straight on a log scale. Ten bits are about a factor of 1000.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- hex dumps

export function ArchDataHexDumpDemo() {
  const p = useParams("hexdump", { src: seg<"ints" | "text" | "elf">("Bytes", [["ints", "int32 array"], ["text", "Your text"], ["elf", "ELF header"]], "ints") });
  const [text, setText] = useState("Hi, 世界! 0x41");
  const [sel, setSel] = useState<number>(8);
  const src = p.values.src;
  const bytes = src === "elf" ? elfHeaderBytes() : src === "ints" ? intArrayBytes() : textBytes(text).slice(0, 96);
  const fieldList = src === "elf" ? ELF_FIELDS : src === "ints" ? intArrayFields() : [];
  const field = fieldList.find((f) => sel >= f.offset && sel < f.offset + f.size);
  const inField = (i: number) => !!field && i >= field.offset && i < field.offset + field.size;
  const cols = 8;
  const rows: number[] = [];
  for (let o = 0; o < bytes.length; o += cols) rows.push(o);
  const b = bytes[sel];
  return (
    <Demo
      title="Read a hex dump by eye"
      controls={<Param spec={p.schema.src} value={p.values.src} onChange={(v) => { p.set("src", v as "ints" | "text" | "elf"); setSel(v === "elf" ? 18 : v === "ints" ? 8 : 0); }} />}
    >
      {src === "text" && <div style={{ marginBottom: 8 }}><TextField label="Text" value={text} onChange={setText} width={300} /></div>}
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12.5, ...mono }}>
          <tbody>
            {rows.map((o) => (
              <tr key={o}>
                <td style={{ color: "var(--muted)", paddingRight: 10 }}>{o.toString(16).padStart(8, "0")}:</td>
                {Array.from({ length: cols }, (_, j) => {
                  const i = o + j, v = bytes[i];
                  if (v === undefined) return <td key={j} />;
                  const on = i === sel, inF = inField(i);
                  return (
                    <td key={j} onClick={() => setSel(i)} style={{ padding: "1px 3px", cursor: "pointer", borderRadius: 3, background: on ? "var(--fg)" : inF ? "color-mix(in srgb, var(--c1) 22%, var(--bg))" : undefined, color: on ? "var(--bg)" : undefined, paddingRight: j % 2 === 1 ? 8 : 3 }}>
                      {v.toString(16).padStart(2, "0")}
                    </td>
                  );
                })}
                <td style={{ paddingLeft: 8, color: "var(--muted)", whiteSpace: "pre" }}>
                  {Array.from({ length: cols }, (_, j) => { const v = bytes[o + j]; return v === undefined ? "" : v >= 0x20 && v < 0x7f ? String.fromCharCode(v) : "."; }).join("")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SectionLabel>Byte {sel} (offset 0x{sel.toString(16)})</SectionLabel>
      {b !== undefined && (
        <>
          <Readout label="value">0x{b.toString(16).padStart(2, "0")} = {b} = 0b{b.toString(2).padStart(8, "0")}{b >= 0x20 && b < 0x7f ? ` = '${String.fromCharCode(b)}'` : ""}</Readout>
          {field && (
            <>
              <Readout label="field">{field.name}, {field.size} byte{field.size > 1 ? "s" : ""} at offset {field.offset}</Readout>
              {field.size > 1 && field.name !== "padding" && field.name !== "magic" && <Readout label="read little-endian">0x{readLe(bytes, field.offset, field.size).toString(16).padStart(2 * field.size, "0")} = {readLe(bytes, field.offset, field.size).toString()}</Readout>}
              <Readout label="meaning">{field.meaning}</Readout>
            </>
          )}
          {src === "text" && <Readout label="role">{b < 0x80 ? "ASCII: one byte, one character" : b >= 0xc0 ? "the first byte of a multi-byte UTF-8 character" : "a UTF-8 continuation byte (10xxxxxx)"}</Readout>}
        </>
      )}
      <Note>This is the layout of xxd, shown with 8 bytes per line so that it fits a phone. The right column shows printable ASCII, and a dot for every other byte.</Note>
    </Demo>
  );
}
