/** Demos for the lesson on character encoding and UTF-8. */
import { useState } from "react";
import { Demo, Param, Stats, range, seg, useParams, Btn, ButtonRow, Note, SectionLabel, Banner, MiniTable, Chip, mono, useStepper, StepButtons, StepSlider, StepCaption } from "../../kit";
import {
  encodeUtf8, encodeUtf16, isSurrogate, hexCp, lengths, graphemesOf, codePointsOf, utf8Length, LENGTH_APIS, decodeUtf8, parseHexBytes, hexBytes, charStart, type Lengths,
} from "../../sims/arch/data";
import { BitRow, ByteBox, Readout, TextField, cellsOf } from "./ArchDataUi";

const BYTE_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

// ---------------------------------------------------------------- the encoder

const ENC_PRESETS: [string, number][] = [["A", 0x41], ["é", 0xe9], ["€", 0x20ac], ["世", 0x4e16], ["😀", 0x1f600], ["U+10FFFF", 0x10ffff]];

export function ArchDataUtf8EncoderDemo() {
  const p = useParams("utf8enc", { cp: range({ label: "Code point", min: 0, max: 0x10ffff, step: 1, default: 0x20ac, format: (v) => hexCp(v) }) });
  const cp = p.values.cp;
  const [text, setText] = useState("");
  if (isSurrogate(cp)) {
    return (
      <Demo title="Encode one code point in UTF-8, bit by bit" controls={<Param spec={p.schema.cp} value={cp} onChange={(v) => p.set("cp", v as number)} />}>
        <Banner ok={false}>{hexCp(cp)} is a surrogate code point (D800–DFFF). It is not a Unicode scalar value, so no UTF encodes it. UTF-16 uses these numbers only in pairs, for other code points.</Banner>
        <ButtonRow style={{ marginTop: 8 }}>{ENC_PRESETS.map(([l, c]) => <Btn key={l} onClick={() => p.set("cp", c)}>{l}</Btn>)}</ButtonRow>
      </Demo>
    );
  }
  const slots = encodeUtf8(cp);
  const n = slots.length;
  const payload = [7, 11, 16, 21][n - 1]!;
  const owner = (bit: number) => slots.findIndex((s) => s.bits.includes(bit));
  const u16 = encodeUtf16(cp);
  return (
    <Demo
      title="Encode one code point in UTF-8, bit by bit"
      actions={<ButtonRow>{ENC_PRESETS.map(([l, c]) => <Btn key={l} on={c === cp} onClick={() => { p.set("cp", c); setText(""); }}>{l}</Btn>)}</ButtonRow>}
      controls={<Param spec={p.schema.cp} value={cp} onChange={(v) => { p.set("cp", v as number); setText(""); }} />}
    >
      <div style={{ marginBottom: 8 }}>
        <TextField label="Type a character" value={text} width={120} onChange={(s) => { setText(s); const c = s.codePointAt(0); if (c !== undefined) p.set("cp", c); }} />
      </div>
      <Readout label="code point">{hexCp(cp)} = {cp}{cp >= 0x20 && cp !== 0x7f ? `  (${String.fromCodePoint(cp)})` : ""}</Readout>
      <BitRow label={`the ${payload} payload bits of the code point`} cells={cellsOf(BigInt(cp), payload, (i) => BYTE_COLORS[owner(i)])} />
      <SectionLabel>{n} byte{n > 1 ? "s" : ""}: grey bits are the fixed prefix</SectionLabel>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {slots.map((s, k) => {
          const prefix = s.template.indexOf("x") === -1 ? 8 : s.template.indexOf("x");
          return (
            <div key={k}>
              <BitRow cells={cellsOf(BigInt(s.byte), 8, (i) => (7 - i < prefix ? "var(--faint)" : BYTE_COLORS[k]), (i) => ({ dim: 7 - i < prefix }))} group={8} size={18} />
              <div style={{ fontSize: 11.5, ...mono }}>{s.template} = 0x{s.byte.toString(16).toUpperCase()}</div>
            </div>
          );
        })}
      </div>
      <Stats items={[
        { label: "UTF-8", value: hexBytes(slots.map((s) => s.byte)) },
        { label: u16.length === 2 ? "UTF-16 (surrogate pair)" : "UTF-16", value: u16.map((u) => u.toString(16).toUpperCase().padStart(4, "0")).join(" ") },
        { label: "UTF-32", value: cp.toString(16).toUpperCase().padStart(8, "0") },
      ]} />
      <Note>The lead byte says how many bytes follow: 0 for one byte, 110 for two, 1110 for three, 11110 for four. Every continuation byte starts with 10. So a byte tells you its role with no context.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- the four lengths

const LEN_PRESETS: [string, string][] = [["hello", "hello"], ["naïve", "naïve"], ["日本語", "日本語"], ["👍🏽", "👍🏽"], ["👨‍👩‍👧", "👨‍👩‍👧"], ["🇯🇵", "🇯🇵"]];
const LEN_NAME: Record<keyof Lengths, string> = { utf8Bytes: "UTF-8 bytes", utf16Units: "UTF-16 code units", codePoints: "code points", graphemes: "grapheme clusters" };

export function ArchDataLengthsDemo() {
  const p = useParams("strlen", { norm: seg<"NFC" | "NFD">("Normalization", [["NFC", "NFC (composed)"], ["NFD", "NFD (decomposed)"]], "NFC") });
  const [raw, setRaw] = useState("naïve 👨‍👩‍👧");
  const s = raw.normalize(p.values.norm);
  const L = lengths(s);
  const gs = graphemesOf(s);
  return (
    <Demo
      title="One string, four lengths"
      actions={<ButtonRow>{LEN_PRESETS.map(([l, v]) => <Btn key={l} onClick={() => setRaw(v)}>{l}</Btn>)}</ButtonRow>}
      controls={<Param spec={p.schema.norm} value={p.values.norm} onChange={(v) => p.set("norm", v as "NFC" | "NFD")} />}
    >
      <TextField label="Text" value={raw} onChange={setRaw} width={300} />
      <MiniTable head={["what you count", "length", "who counts it this way"]} rows={LENGTH_APIS.map((a) => [LEN_NAME[a.counts], String(L[a.counts]), a.api])} />
      <SectionLabel>Grapheme clusters: what a reader sees as one character</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {gs.map((g, i) => {
          const cps = codePointsOf(g);
          return (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px", minWidth: 0 }}>
              <div style={{ fontSize: 18, textAlign: "center" }}>{g === " " ? "␠" : g}</div>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "center" }}>
                {cps.map((c, j) => <Chip key={j} color={BYTE_COLORS[utf8Length(c) - 1]}>{hexCp(c)}</Chip>)}
              </div>
              <div className="muted" style={{ fontSize: 10.5, textAlign: "center", ...mono }}>{cps.reduce((n, c) => n + utf8Length(c), 0)} B</div>
            </div>
          );
        })}
      </div>
      <Note>Chip colors show the UTF-8 length of each code point: 1, 2, 3 or 4 bytes. With NFD, ï becomes i plus U+0308 (combining diaeresis): one more code point, one more byte, the same grapheme.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- the decoder

const DEC_PRESETS: [string, string][] = [
  ["valid: € A", "E2 82 AC 41"],
  ["overlong /", "C0 AF 41"],
  ["surrogate", "ED A0 80 41"],
  ["truncated", "E2 82 41"],
  ["above U+10FFFF", "F4 90 80 80"],
  ["stray continuation", "80 41"],
  ["valid: 😀", "F0 9F 98 80"],
];
const ROLE_COLOR = { ascii: "var(--c3)", lead: "var(--c1)", cont: "var(--c5)", error: "var(--c4)" } as const;

export function ArchDataDecoderDemo() {
  const [text, setText] = useState(DEC_PRESETS[1]![1]);
  const [jump, setJump] = useState<number | null>(null);
  const bytes = parseHexBytes(text) ?? [];
  const d = decodeUtf8(bytes.slice(0, 24));
  const s = useStepper(d.steps.length + 1, 1.5);
  const shown = d.steps.slice(0, s.i);
  const cur = s.i > 0 ? d.steps[s.i - 1] : undefined;
  const out = shown.filter((x) => x.emitted !== null).map((x) => x.emitted!);
  const roleOf = new Map<number, keyof typeof ROLE_COLOR>();
  for (const st of shown) if (st.byte >= 0) roleOf.set(st.index, st.role);
  const start = jump === null ? null : charStart(bytes, jump);
  return (
    <Demo
      title="Decode UTF-8 one byte at a time"
      actions={<StepButtons s={s} />}
      controls={<StepSlider s={s} label="Byte step" />}
    >
      <ButtonRow style={{ marginBottom: 8 }}>{DEC_PRESETS.map(([l, v]) => <Btn key={l} on={v === text} onClick={() => { setText(v); s.reset(); setJump(null); }}>{l}</Btn>)}</ButtonRow>
      <TextField label="Bytes (hex)" value={text} bad={parseHexBytes(text) === null} onChange={(v) => { setText(v); s.reset(); setJump(null); }} width={260} />
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", margin: "10px 0" }}>
        {bytes.slice(0, 24).map((b, i) => (
          <ByteBox key={i} value={b} color={roleOf.has(i) ? ROLE_COLOR[roleOf.get(i)!] : "var(--border)"} on={cur?.index === i || jump === i} caption={i === start ? "start" : `${i}`} onClick={() => setJump(i)} />
        ))}
      </div>
      <StepCaption tone={cur?.role === "error" ? "bad" : cur ? "info" : null} label={cur ? `byte ${cur.index}` : undefined}>
        {cur ? cur.note : "Press Play or Step. The decoder reads each byte and checks it against the range it expects."}
      </StepCaption>
      <Readout label="expects next">{cur && cur.needed > 0 ? `${cur.needed} more continuation byte${cur.needed > 1 ? "s" : ""} in ${cur.lower.toString(16).toUpperCase()}–${cur.upper.toString(16).toUpperCase()}` : "a new character"}</Readout>
      <Readout label="output">{out.length ? out.map((c) => (c === 0xfffd ? "U+FFFD (�)" : `${hexCp(c)} (${String.fromCodePoint(c)})`)).join("  ") : "–"}</Readout>
      {s.atEnd && <Banner ok={d.errors === 0}>{d.errors === 0 ? "Valid UTF-8." : `${d.errors} error${d.errors > 1 ? "s" : ""}: each maximal invalid part became one U+FFFD, as TextDecoder does. A strict decoder (Rust str::from_utf8) rejects the whole input.`}</Banner>}
      {jump !== null && <Banner tone="plain">You jumped to byte {jump}. Skip back over continuation bytes (10xxxxxx): the character starts at byte {start}. It is never more than 3 bytes back.</Banner>}
      <Note>Click any byte to jump into the middle of the text. UTF-8 is self-synchronizing: you can find the next character boundary from any position.</Note>
    </Demo>
  );
}
