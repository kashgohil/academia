/** Demos for "RISC-V basics": an encoder you can flip bit by bit, the immediate wiring, and the C extension. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Legend, Param, SectionLabel, StackBar, Stats, mono, range, select, seg, tint } from "../../kit";
import { IMM_FORMATS, density, muxInputs, naiveWiring, realWiring, totalMuxInputs, type ImmFormat } from "../../sims/arch/isa";
import { assemble, decode, disasm, encode, formatOfWord, programById, type Inst } from "../../sims/arch/rv";
import { AsmEditor, BitFields, FIELD_COLOR } from "./ArchViews";

// ---------------------------------------------------------------- encoder

const PRESETS = ["add a0, a1, a2", "sub a0, a1, a2", "addi a0, a0, -1", "lw a0, 8(sp)", "sw ra, 12(sp)", "beq a0, a1, 16", "lui a0, 0x12345", "jal ra, 2048", "mul a0, a1, a2"];

function firstWord(line: string): { word: number | null; n: number; error: string | null } {
  const r = assemble(`        .text\n        ${line}\n`);
  if (!r.ok) return { word: null, n: 0, error: r.errors[0]?.message ?? "error" };
  if (!r.program.words.length) return { word: null, n: 0, error: "no instruction" };
  return { word: r.program.words[0]!, n: r.program.words.length, error: null };
}

const BW = 17; // the bit width of BitFields in ArchViews

export function IsaEncoderDemo() {
  const [text, setText] = useState("add a0, a1, a2");
  const [word, setWord] = useState<number>(() => firstWord("add a0, a1, a2").word!);
  const parsed = useMemo(() => firstWord(text), [text]);
  const inst = decode(word);
  const fmt = formatOfWord(word);
  const type = (v: string) => { setText(v); const p = firstWord(v); if (p.word !== null) setWord(p.word); };
  const flip = (bit: number) => { const w = (word ^ (1 << bit)) >>> 0; setWord(w); const i = decode(w); setText(i ? disasm(i) : text); };
  return (
    <Demo title="Encode an instruction, then flip its bits">
      <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12.5 }}>
        <span className="muted">Assembly</span>
        <input aria-label="One RISC-V instruction" value={text} spellCheck={false} onChange={(e) => type(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 0, maxWidth: 300, font: "inherit", padding: "3px 6px", border: `1px solid ${parsed.error ? "var(--c4)" : "var(--border)"}`, borderRadius: 4, background: "var(--bg)", color: "var(--fg)", ...mono }} />
      </label>
      {parsed.error && <div style={{ color: "var(--c4)", fontSize: 12.5, marginTop: 4, ...mono }}>{parsed.error}</div>}
      {parsed.n > 1 && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>This pseudo-instruction expands to {parsed.n} instructions. The demo shows the first one.</div>}
      <ButtonRow style={{ marginTop: 8 }}>
        {PRESETS.map((p) => <Btn key={p} ghost onClick={() => type(p)}>{p.split(" ")[0]}</Btn>)}
      </ButtonRow>
      <SectionLabel>Click a bit to flip it</SectionLabel>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(32, ${BW}px)`, width: 32 * BW, marginBottom: 2 }}>
          {Array.from({ length: 32 }, (_, i) => {
            const bit = 31 - i;
            return (
              <button key={bit} onClick={() => flip(bit)} aria-label={`Flip bit ${bit}`} title={`bit ${bit}`}
                style={{ height: 18, padding: 0, border: "1px solid var(--border)", borderRadius: 2, background: "var(--bg)", color: "var(--muted)", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>
                ↕
              </button>
            );
          })}
        </div>
        <BitFields word={word} caption={inst ? `${disasm(inst)}    (${fmt}-type)` : "not an RV32IM instruction: a core raises illegal instruction"} />
      </div>
      <Legend items={[{ label: "opcode", color: FIELD_COLOR.opcode }, { label: "funct3 / funct7", color: FIELD_COLOR.funct }, { label: "register", color: FIELD_COLOR.reg }, { label: "immediate", color: FIELD_COLOR.imm }]} />
      <Banner tone={inst ? "info" : "bad"} style={{ marginTop: 8 }}>
        {inst
          ? `rd is always bits 11 to 7, rs1 is always bits 19 to 15, and rs2 is always bits 24 to 20, in every format that has them. A decoder can read the registers before it knows the format.`
          : `This word does not decode. Bits 1 and 0 must be 11 for a 32-bit instruction, and the opcode and funct fields must name an instruction.`}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- immediates

const SAMPLE: Record<ImmFormat, (imm: number) => Inst> = {
  I: (imm) => ({ op: "addi", rd: 10, rs1: 10, rs2: 0, imm }),
  S: (imm) => ({ op: "sw", rd: 0, rs1: 10, rs2: 11, imm }),
  B: (imm) => ({ op: "beq", rd: 0, rs1: 10, rs2: 11, imm }),
  U: (imm) => ({ op: "lui", rd: 10, rs1: 0, rs2: 0, imm }),
  J: (imm) => ({ op: "jal", rd: 1, rs1: 0, rs2: 0, imm }),
};
const RANGE: Record<ImmFormat, { min: number; max: number; step: number; def: number }> = {
  I: { min: -2048, max: 2047, step: 1, def: -3 },
  S: { min: -2048, max: 2047, step: 1, def: 100 },
  B: { min: -4096, max: 4094, step: 2, def: -12 },
  U: { min: 0, max: 0xfffff, step: 1, def: 0x12345 },
  J: { min: -(1 << 20), max: (1 << 20) - 2, step: 2, def: 2048 },
};

export function IsaImmediateDemo() {
  const [fmt, setFmt] = useState<ImmFormat>("B");
  const [layout, setLayout] = useState<"real" | "naive">("real");
  const [imm, setImm] = useState(RANGE.B.def);
  const r = RANGE[fmt];
  const v = Math.max(r.min, Math.min(r.max, imm));
  const wiring = layout === "real" ? realWiring(fmt) : naiveWiring(fmt);
  const realWord = encode(SAMPLE[fmt](v));
  // The immediate the core builds (for U: the value shifted left by 12).
  const value = fmt === "U" ? (v << 12) | 0 : v;
  // The word in the chosen layout: the non-immediate bits as in RISC-V, the immediate bits by the wiring.
  const immBits = new Set(realWiring(fmt).filter((s) => s >= 0));
  let word = realWord;
  if (layout === "naive") {
    for (const p of immBits) word &= ~(1 << p);
    wiring.forEach((s, k) => { if (s >= 0 && ((value >>> k) & 1)) word |= 1 << s; });
    word >>>= 0;
  }
  const mux = muxInputs(layout);
  const W = 32 * 18 + 30, H = 186, cx = (bit: number) => 24 + (31 - bit) * 18 + 9;
  const yTop = 26, yBot = 132;
  const colorOf = (k: number) => (k === 0 ? "var(--faint)" : k <= 4 ? "var(--c1)" : k <= 10 ? "var(--c3)" : k === 11 ? "var(--c5)" : k <= 19 ? "var(--c2)" : "var(--c4)");
  return (
    <Demo
      title="Where each immediate bit comes from"
      controls={<>
        <Param spec={range({ label: "Immediate", min: r.min, max: r.max, step: r.step, default: r.def, format: (x) => (fmt === "U" ? `0x${x.toString(16)}` : String(x)) })} value={v} onChange={(x) => setImm(x as number)} />
        <Param spec={seg("Format", IMM_FORMATS.map((f) => [f, f] as [ImmFormat, string]), "B")} value={fmt} onChange={(x) => { setFmt(x as ImmFormat); setImm(RANGE[x as ImmFormat].def); }} />
        <Param spec={seg("Layout", [["real", "RISC-V"], ["naive", "Naive (contiguous)"]], "real")} value={layout} onChange={(x) => setLayout(x as "real" | "naive")} />
      </>}
    >
      <div style={{ fontSize: 12.5, marginBottom: 6, ...mono }}>{disasm(SAMPLE[fmt](v))}: the immediate is {fmt === "U" ? `0x${(value >>> 0).toString(16)}` : value}</div>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <svg width={W} height={H} style={{ display: "block" }} role="img" aria-label="Wires from instruction bits to immediate bits">
          <text x={2} y={yTop - 12} fontSize={10} fill="var(--muted)">instruction bits 31 … 0</text>
          <text x={2} y={yBot + 44} fontSize={10} fill="var(--muted)">immediate bits 31 … 0; under each, its mux inputs across all five formats</text>
          {wiring.map((s, k) => s < 0 || (s === 31 && k > 0 && wiring[k - 1] === 31) ? null : (
            <line key={k} x1={cx(s)} y1={yTop + 16} x2={cx(k)} y2={yBot - 2} stroke={colorOf(k)} strokeWidth={1.4} opacity={0.85} />
          ))}
          {wiring.some((s, k) => s === 31 && k > 0 && wiring[k - 1] === 31) && (
            <text x={cx(31) - 8} y={yBot - 8} fontSize={9.5} fill="var(--c4)">upper bits: copies of bit 31 (the sign)</text>
          )}
          {Array.from({ length: 32 }, (_, i) => {
            const bit = 31 - i, isImm = immBits.has(bit) || wiring.includes(bit);
            const kOf = wiring.findIndex((s) => s === bit);
            return (
              <g key={i}>
                <rect x={24 + i * 18} y={yTop} width={17} height={16} rx={2} fill={isImm ? tint(colorOf(kOf), 30) : "var(--subtle)"} stroke="var(--border)" />
                <text x={cx(bit)} y={yTop + 12} fontSize={10.5} textAnchor="middle" fill={isImm ? "var(--fg)" : "var(--faint)"} fontFamily="ui-monospace, monospace">{(word >>> bit) & 1}</text>
                <rect x={24 + i * 18} y={yBot} width={17} height={16} rx={2} fill={wiring[bit]! < 0 ? "var(--subtle)" : tint(colorOf(bit), 30)} stroke="var(--border)" />
                <text x={cx(bit)} y={yBot + 12} fontSize={10.5} textAnchor="middle" fill="var(--fg)" fontFamily="ui-monospace, monospace">{(value >>> bit) & 1}</text>
                <text x={cx(bit)} y={yBot + 26} fontSize={9.5} textAnchor="middle" fill={mux[bit]! >= 4 ? "var(--c4)" : "var(--muted)"}>{mux[bit]}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <Stats items={[
        { label: "Mux inputs, all immediate bits", value: totalMuxInputs(layout) },
        { label: "Largest mux (inputs)", value: Math.max(...mux) },
      ]} />
      <Banner tone={layout === "real" ? "good" : "warn"} style={{ marginTop: 6 }}>
        {layout === "real"
          ? `RISC-V: immediate bits 10 to 5 come from instruction bits 30 to 25 in I, S, B and J. The B and J layouts rotate a few bits so that this stays true. Total: ${totalMuxInputs("real")} mux inputs.`
          : `Naive: B and J store offset ÷ 2 as contiguous bits, so most low immediate bits now have one more possible source. Total: ${totalMuxInputs("naive")} mux inputs, against ${totalMuxInputs("real")} for RISC-V.`}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- compression

const C_IDS = ["fact", "sum", "memcpy", "bubble", "strlen", "dot", "list"];

export function IsaCompressDemo() {
  const [id, setId] = useState("fact");
  const [src, setSrc] = useState(programById("fact").source);
  const asm = useMemo(() => assemble(src), [src]);
  const d = useMemo(() => (asm.ok ? density(asm.program) : null), [asm]);
  const pick = (v: string) => { setId(v); setSrc(programById(v).source); };
  return (
    <Demo title="Which instructions fit in 16 bits?" controls={<Param spec={select({ label: "Program", options: C_IDS.map((x) => ({ value: x, label: programById(x).title })), default: "fact" })} value={id} onChange={(v) => pick(v as string)} />}>
      {d && (
        <>
          <Stats items={[
            { label: "Instructions", value: d.insts },
            { label: "With a 16-bit form", value: `${d.compressible} (${Math.round((100 * d.compressible) / d.insts)}%)` },
            { label: "Code size: RV32IM", value: `${d.bytes32} B` },
            { label: "Code size: with C", value: `${d.bytesC} B (${Math.round(100 * (1 - d.bytesC / d.bytes32))}% smaller)` },
          ]} />
          <div style={{ display: "grid", gap: 4, margin: "6px 0 10px" }}>
            <StackBar parts={[{ value: d.bytes32, color: "var(--c1)", label: "RV32IM" }]} total={d.bytes32} height={12} />
            <StackBar parts={[{ value: d.bytesC, color: "var(--c3)", label: "with C" }]} total={d.bytes32} height={12} />
          </div>
          <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
            {asm.program.insts.map((inst, i) => {
              const f = d.forms[i]!;
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 30px", gap: 8, padding: "3px 8px", borderBottom: "1px solid var(--border)", background: f.ok ? tint("var(--c3)", 12) : undefined }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...mono, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{disasm(inst)}</div>
                    <div style={{ fontSize: 11.5, color: f.ok ? "var(--fg)" : "var(--muted)" }}>{f.ok ? `${f.form}: ${f.why}` : f.why}</div>
                  </div>
                  <b style={{ alignSelf: "center", textAlign: "right", color: f.ok ? "var(--c3)" : "var(--fg)", ...mono }}>{f.ok ? 2 : 4} B</b>
                </div>
              );
            })}
          </div>
        </>
      )}
      <SectionLabel>Source: edit the registers and offsets</SectionLabel>
      <AsmEditor value={src} onChange={setSrc} errors={asm.errors} rows={8} />
    </Demo>
  );
}
