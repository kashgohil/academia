/** Demos for the lesson on IEEE 754 floating point. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Legend, range, seg, toggle, useParams, Btn, ButtonRow, Note, SectionLabel, Banner, MiniTable, Bar, mono, useWidth, useChunked, Rich, fixed } from "../../kit";
import {
  BINARY32, BINARY64, FORMATS, MODES, SUM_ORDERS, decode, decimalOf, decimalOfExact, emin, enumerate, exactSum32, fields, fromNumber, infBits, maxFiniteBits, nanBits,
  neighbours, operate, parseDecimal, round, stats, sum32, sumData, toyFormat, ulp, ulpsOff32, relError, width, E4M3,
  type Decoded, type Exact, type FloatFormat, type Mode, type Op, type SumData,
} from "../../sims/arch/data";
import { BitRow, Readout, TextField, cellsOf } from "./ArchDataUi";

const fmtOf = (id: string) => FORMATS.find((f) => f.id === id) ?? BINARY32;
const SHORT: Record<string, string> = { binary64: "binary64", binary32: "binary32", binary16: "binary16", bfloat16: "bfloat16", e4m3: "E4M3", e5m2: "E5M2" };

/** The shortest decimal that rounds back to the same value in the format. */
function shortest(f: FloatFormat, d: Decoded): string {
  if (d.kind === "nan") return "NaN";
  if (d.kind === "inf") return d.sign ? "−∞" : "+∞";
  if (f.id === "binary64") return String(d.value);
  for (let p = 1; p <= 17; p++) {
    const s = d.value.toPrecision(p);
    const back = round(f, parseDecimal(s)!).bits;
    if (back === d.bits) return String(Number(s));
  }
  return String(d.value);
}

const sigDec = (d: Decoded, f: FloatFormat) => String(Number((Number(d.sig) / 2 ** f.m).toPrecision(12)));
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}… (${s.replace(/[^0-9]/g, "").length} digits)` : s);
const fieldColor = (f: FloatFormat) => (i: number) => (i === f.e + f.m ? "var(--c4)" : i >= f.m ? "var(--c2)" : "var(--c1)");

// ---------------------------------------------------------------- the bit editor

export function ArchDataFloatBitsDemo() {
  const p = useParams("fbits", { fmt: seg<string>("Format", FORMATS.map((f) => [f.id, SHORT[f.id]!]), "binary32") });
  const f = fmtOf(p.values.fmt);
  const [bits, setBits] = useState<bigint>(() => fromNumber(fmtOf(p.values.fmt), 0.1).bits);
  const [text, setText] = useState("0.1");
  const [full, setFull] = useState(false);
  const W = width(f);
  const b = BigInt.asUintN(W, bits);
  const d = decode(f, b);
  const emax = (1 << f.e) - 1;
  const setExp = (e: number) => { setBits(fields(f, d.sign, e, d.frac)); setText(""); };
  const presets: [string, () => bigint][] = [
    ["0.1", () => fromNumber(f, 0.1).bits],
    ["1", () => fromNumber(f, 1).bits],
    ["−2.5", () => fromNumber(f, -2.5).bits],
    ["max", () => maxFiniteBits(f)],
    ["min normal", () => fields(f, 0, 1, 0n)],
    ["min subnormal", () => 1n],
    ["−0", () => fields(f, 1, 0, 0n)],
    ...(infBits(f, 0) !== null ? [["+∞", () => infBits(f, 0)!] as [string, () => bigint]] : []),
    ["NaN", () => nanBits(f)],
  ];
  const kindText: Record<string, string> = {
    zero: "zero: exponent field 0, fraction 0",
    subnormal: "subnormal: exponent field 0, so the leading bit is 0 and the exponent is fixed at emin",
    normal: "normal: the leading 1 is implicit",
    inf: "infinity: exponent all ones, fraction 0",
    nan: d.quiet ? "NaN, quiet: the top fraction bit is 1" : f.special === "fn" ? "NaN: E4M3 has only this pattern (S.1111.111)" : "NaN, signaling: the top fraction bit is 0",
  };
  const dec = decimalOf(d);
  const lead = d.kind === "normal" ? "1" : "0";
  const fracBits = d.frac.toString(2).padStart(f.m, "0");
  const scale = d.kind === "normal" ? d.unbiased : emin(f);
  return (
    <Demo
      title="Edit the bits of a floating-point number"
      controls={<>
        <Param spec={p.schema.fmt} value={p.values.fmt} onChange={(v) => { const nf = fmtOf(v as string); p.set("fmt", v as string); setBits(fromNumber(nf, Number.isNaN(d.value) ? NaN : d.value).bits); setText(""); }} />
        <Param spec={{ kind: "range", label: "Exponent field E", min: 0, max: emax, step: 1, default: f.bias - 4, format: (v) => `${v}, scale 2${sup(Math.max(v, 1) - f.bias)}` }} value={d.expField} onChange={(v) => setExp(v as number)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>{presets.map(([l, fn]) => <Btn key={l} onClick={() => { setBits(fn()); setText(""); }}>{l}</Btn>)}</ButtonRow>
      <BitRow cells={cellsOf(b, W, fieldColor(f))} onFlip={(i) => { setBits(b ^ (1n << BigInt(i))); setText(""); }} group={W <= 16 ? 4 : 4} />
      <Legend items={[{ label: `sign (1 bit)`, color: "var(--c4)" }, { label: `exponent (${f.e} bits, bias ${f.bias})`, color: "var(--c2)" }, { label: `fraction (${f.m} bits)`, color: "var(--c1)" }]} />
      <div style={{ margin: "8px 0" }}>
        <TextField label="Type a decimal" value={text} bad={!!text && !parseDecimal(text)} onChange={(s) => { setText(s); const x = parseDecimal(s); if (x) setBits(round(f, x).bits); }} />
      </div>
      <Banner tone={d.kind === "normal" ? "info" : d.kind === "subnormal" ? "warn" : d.kind === "zero" ? "plain" : "bad"}>{kindText[d.kind]}</Banner>
      <div style={{ marginTop: 8 }}>
        <Readout label="fields">sign {d.sign}, E = {d.expField}, fraction = {fracBits || "(none)"}</Readout>
        {(d.kind === "normal" || d.kind === "subnormal") && (
          <>
            <Readout label="significand">{lead}.{fracBits} in binary</Readout>
            <Readout label="value"><Rich text={`$(-1)^{${d.sign}} \\times ${sigDec(d, f)} \\times 2^{${scale}}$`} /></Readout>
          </>
        )}
        <Readout label="exact value">
          <span>{full ? dec : clip(dec)}</span>
          {dec.length > 90 && <button className="btn ghost" style={{ marginLeft: 6, padding: "0 6px", fontSize: 11.5 }} onClick={() => setFull(!full)}>{full ? "less" : "all digits"}</button>}
        </Readout>
        <Readout label="shortest">{shortest(f, d)}</Readout>
      </div>
      <Stats items={[
        { label: "bits (hex)", value: `0x${b.toString(16).toUpperCase().padStart(Math.ceil(W / 4), "0")}` },
        { label: "ULP here", value: d.kind === "normal" || d.kind === "subnormal" || d.kind === "zero" ? `$2^{${Math.log2(ulp(f, d))}}$` : "–" },
        { label: "significant decimal digits", value: `about ${fixed((f.m + 1) * Math.log10(2), 1)}` },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- density on a number line

export function ArchDataDensityDemo() {
  const p = useParams("density", {
    e: range({ label: "Exponent bits", min: 2, max: 4, step: 1, default: 3 }),
    m: range({ label: "Fraction bits", min: 1, max: 4, step: 1, default: 2 }),
    axis: seg<"lin" | "log">("Axis", [["lin", "linear"], ["log", "log"]], "lin"),
    ftz: toggle({ label: "Flush subnormals to zero (FTZ)", default: false }),
  });
  const f = toyFormat(p.values.e, p.values.m);
  const vals = useMemo(() => enumerate(f), [f.e, f.m]); // eslint-disable-line react-hooks/exhaustive-deps
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const W = Math.max(280, w), H = 120, pad = 14;
  const st = stats(f);
  const log = p.values.axis === "log";
  const lo = st.minSubnormal / 2;
  const X = (v: number) => pad + (log ? (Math.log2(Math.max(v, lo)) - Math.log2(lo)) / (Math.log2(st.maxFinite) - Math.log2(lo)) : v / st.maxFinite) * (W - 2 * pad);
  const binades: { k: number; count: number; gap: number }[] = [];
  for (let k = emin(f); 2 ** k <= st.maxFinite; k++) binades.push({ k, count: 2 ** f.m, gap: 2 ** (k - f.m) });
  return (
    <Demo
      title="Where the floating-point values are"
      controls={<>
        <Param spec={p.schema.e} value={p.values.e} onChange={(v) => p.set("e", v as number)} />
        <Param spec={p.schema.m} value={p.values.m} onChange={(v) => p.set("m", v as number)} />
        <Param spec={p.schema.axis} value={p.values.axis} onChange={(v) => p.set("axis", v as "lin" | "log")} />
        <Param spec={p.schema.ftz} value={p.values.ftz} onChange={(v) => p.set("ftz", v as boolean)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg width={W} height={H} role="img" aria-label="number line of every value">
          <line x1={pad} x2={W - pad} y1={70} y2={70} stroke="var(--border)" />
          {binades.map((bd) => {
            const x = X(2 ** bd.k);
            return <g key={bd.k}><line x1={x} x2={x} y1={40} y2={92} stroke="var(--faint)" strokeDasharray="3 3" />{(log || bd.k >= emin(f) + Math.max(0, binades.length - 4)) && <text x={x} y={106} fontSize={10} textAnchor="middle" fill="var(--muted)">{`2${sup(bd.k)}`}</text>}</g>;
          })}
          {vals.map((v) => {
            const gone = p.values.ftz && v.kind === "subnormal";
            const x = log && v.value === 0 ? pad : X(v.value);
            return <line key={String(v.bits)} x1={x} x2={x} y1={v.kind === "subnormal" ? 56 : 52} y2={88} stroke={v.kind === "subnormal" ? "var(--c2)" : v.kind === "zero" ? "var(--fg)" : "var(--c1)"} strokeWidth={1.5} opacity={gone ? 0.15 : 1} />;
          })}
          {p.values.ftz && <rect x={X(0)} y={60} width={Math.max(2, X(st.minNormal) - X(0))} height={20} fill="var(--c4)" opacity={0.2} />}
          <text x={pad} y={22} fontSize={11} fill="var(--muted)">{`0 … ${st.maxFinite} (largest finite value)`}</text>
        </svg>
      </div>
      <Legend items={[{ label: "normal values", color: "var(--c1)" }, { label: "subnormal values", color: "var(--c2)" }, ...(p.values.ftz ? [{ label: "gap with FTZ", color: "var(--c4)" }] : [])]} />
      <MiniTable
        head={["binade", "values", "gap between neighbours"]}
        rows={[
          ...(p.values.ftz ? [] : [[<span>subnormal [0, <Rich text={`$2^{${emin(f)}}$`} />)</span>, String(2 ** f.m - 1), <Rich text={`$2^{${emin(f) - f.m}}$`} />]]),
          ...binades.map((bd) => [<Rich text={`$[2^{${bd.k}}, 2^{${bd.k + 1}})$`} />, String(bd.count), <Rich text={`$2^{${bd.k - f.m}}$`} />]),
        ]}
      />
      <Note>Every binade (the values from one power of two up to the next) holds the same number of values, so the gap doubles at each power of two. The subnormals fill the hole near zero with the smallest gap.</Note>
    </Demo>
  );
}
const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
const sup = (k: number) => String(k).split("").map((c) => SUP[c] ?? c).join("");

// ---------------------------------------------------------------- one rounding, exactly

type Preset = { label: string; a: string; b: string; c?: string; op: Op; cmp: string };
const ROUND_PRESETS: Preset[] = [
  { label: "0.1 + 0.2", a: "0.1", b: "0.2", op: "add", cmp: "0.3" },
  { label: "1e16 + 1", a: "1e16", b: "1", op: "add", cmp: "10000000000000001" },
  { label: "0.1 × 3", a: "0.1", b: "3", op: "mul", cmp: "0.3" },
  { label: "fma vs. mul then add", a: "1.0000000009313225746154785", b: "1.0000000009313225746154785", c: "-1.0000000018626451492309570", op: "fma", cmp: "0" },
];

function Line5({ lo, hi, x, chosen }: { lo: number; hi: number; x: number; chosen: "lo" | "hi" | "x" }) {
  const [ref, w] = useWidth<HTMLDivElement>(500);
  const W = Math.max(260, w), pad = 30;
  const X = (t: number) => pad + t * (W - 2 * pad);
  const t = (x - lo) / (hi - lo || 1);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={W} height={66} role="img" aria-label="the exact result between its two neighbours">
        <line x1={X(0)} x2={X(1)} y1={34} y2={34} stroke="var(--border)" strokeWidth={2} />
        <line x1={X(0.5)} x2={X(0.5)} y1={26} y2={42} stroke="var(--faint)" strokeDasharray="2 2" />
        <text x={X(0.5)} y={58} fontSize={10} textAnchor="middle" fill="var(--faint)">midpoint</text>
        {[0, 1].map((k) => <circle key={k} cx={X(k)} cy={34} r={7} fill={(chosen === "lo" && k === 0) || (chosen === "hi" && k === 1) ? "var(--c3)" : "var(--bg)"} stroke="var(--fg)" />)}
        <text x={X(0)} y={58} fontSize={11} textAnchor="middle" fill="var(--fg)">below</text>
        <text x={X(1)} y={58} fontSize={11} textAnchor="middle" fill="var(--fg)">above</text>
        <path d={`M${X(Math.max(0, Math.min(1, t)))},26 l-5,-8 h10 z`} fill="var(--c4)" />
        <text x={X(Math.max(0, Math.min(1, t)))} y={9} fontSize={10.5} textAnchor="middle" fill="var(--c4)">{chosen === "x" ? "exact (no rounding)" : "exact result"}</text>
      </svg>
    </div>
  );
}

export function ArchDataRoundDemo() {
  const p = useParams("fround", {
    fmt: seg<"binary64" | "binary32">("Format", [["binary64", "binary64"], ["binary32", "binary32"]], "binary64"),
    mode: seg<Mode>("Rounding", MODES.map((m) => [m.mode, m.label]), "rne"),
  });
  const f = p.values.fmt === "binary64" ? BINARY64 : BINARY32;
  const [pi, setPi] = useState(0);
  const [ta, setTa] = useState(ROUND_PRESETS[0]!.a), [tb, setTb] = useState(ROUND_PRESETS[0]!.b), [tc, setTc] = useState("0"), [cmp, setCmp] = useState("0.3");
  const [op, setOp] = useState<Op>("add");
  const pick = (i: number) => { const pr = ROUND_PRESETS[i]!; setPi(i); setTa(pr.a); setTb(pr.b); setTc(pr.c ?? "0"); setOp(pr.op); setCmp(pr.cmp); };
  const ea = parseDecimal(ta), eb = parseDecimal(tb), ec = parseDecimal(tc), ek = parseDecimal(cmp);
  if (!ea || !eb || !ec) {
    return <Demo title="Watch one operation round"><Banner ok={false}>Type decimal numbers, for example 0.1 or 1e16.</Banner><ButtonRow>{ROUND_PRESETS.map((pr, i) => <Btn key={pr.label} onClick={() => pick(i)}>{pr.label}</Btn>)}</ButtonRow></Demo>;
  }
  const A = round(f, ea).bits, B = round(f, eb).bits, C = round(f, ec).bits;
  const r = operate(f, op, A, B, C, p.values.mode);
  const dA = decode(f, A), dB = decode(f, B), dR = decode(f, r.bits);
  const ex = r.exact;
  let line: { lo: number; hi: number; x: number; chosen: "lo" | "hi" | "x"; tie: boolean; loBits: bigint; hiBits: bigint } | null = null;
  if (ex && dR.kind !== "inf" && dR.kind !== "nan") {
    const [lo, hi] = neighbours(f, ex);
    const dl = decode(f, lo), dh = decode(f, hi);
    const frac = lo === hi ? 0 : Number(fracOf(ex, dl, dh));
    const tie = lo !== hi && Math.abs(frac - 0.5) < 1e-12;
    line = { lo: 0, hi: 1, x: lo === hi ? 0 : frac, chosen: lo === hi ? "x" : r.bits === lo ? "lo" : "hi", tie, loBits: lo, hiBits: hi };
  }
  // the separate product, rounded, then the add: for the fma comparison
  const twoStep = op === "fma" ? decode(f, operate(f, "add", operate(f, "mul", A, B, 0n, p.values.mode).bits, C, 0n, p.values.mode).bits) : null;
  const dK = ek ? decode(f, round(f, ek).bits) : null;
  const opText = op === "add" ? "a + b" : op === "mul" ? "a × b" : "fma(a, b, c) = a × b + c";
  return (
    <Demo
      title="Watch one operation round"
      actions={<ButtonRow>{ROUND_PRESETS.map((pr, i) => <Btn key={pr.label} on={i === pi} onClick={() => pick(i)}>{pr.label}</Btn>)}</ButtonRow>}
      controls={<>
        <Param spec={p.schema.fmt} value={p.values.fmt} onChange={(v) => p.set("fmt", v as "binary64" | "binary32")} />
        <Param spec={p.schema.mode} value={p.values.mode} onChange={(v) => p.set("mode", v as Mode)} />
      </>}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <TextField label="a" value={ta} onChange={(s) => { setTa(s); setPi(-1); }} width={200} />
        <TextField label="b" value={tb} onChange={(s) => { setTb(s); setPi(-1); }} width={200} />
        {op === "fma" && <TextField label="c" value={tc} onChange={(s) => { setTc(s); setPi(-1); }} width={200} />}
      </div>
      <SectionLabel>Step 1: each literal is rounded when it is stored</SectionLabel>
      <Readout label="a is stored as">{clip(decimalOf(dA), 70)}</Readout>
      <Readout label="b is stored as">{clip(decimalOf(dB), 70)}</Readout>
      <SectionLabel>Step 2: {opText}, computed exactly, then rounded once</SectionLabel>
      <Readout label="exact result">{ex ? clip(decimalOfExact(ex), 70) : "–"}</Readout>
      {line && (
        <>
          <Line5 {...line} />
          <Readout label="below">{clip(decimalOf(decode(f, line.loBits)), 70)} (last bit {Number(line.loBits & 1n)})</Readout>
          <Readout label="above">{clip(decimalOf(decode(f, line.hiBits)), 70)} (last bit {Number(line.hiBits & 1n)})</Readout>
        </>
      )}
      <Banner tone={line?.tie ? "warn" : "info"}>
        Result: <b style={mono}>{shortest(f, dR)}</b>.{" "}
        {line?.chosen === "x" ? "The exact result fits, so nothing is rounded." : line?.tie ? `The exact result is exactly halfway: a tie. ${p.values.mode === "rne" ? "Ties to even picks the neighbour whose last bit is 0." : "This mode does not look at the last bit."}` : `The mode "${MODES.find((m) => m.mode === p.values.mode)!.label}" picks the neighbour ${line?.chosen === "lo" ? "below" : "above"}.`}
      </Banner>
      {twoStep && <Banner tone="plain">Without fma, a × b is rounded first, and the sum is <b style={mono}>{shortest(f, twoStep)}</b>. The fused operation keeps the low bits of the product, and gives <b style={mono}>{shortest(f, dR)}</b>.</Banner>}
      <div style={{ marginTop: 8 }}>
        <TextField label="Compare with" value={cmp} onChange={setCmp} bad={!ek} width={200} />
        {dK && <Readout label="stored as">{clip(decimalOf(dK), 70)} → {dK.bits === dR.bits ? "equal (==)" : "not equal (!=)"}</Readout>}
      </div>
    </Demo>
  );
}
/** Where the exact value sits between its two neighbours, from 0 to 1. */
function fracOf(x: Exact, lo: Decoded, hi: Decoded): number {
  const toE = (d: Decoded): Exact => (d.exp >= 0 ? { sign: d.sign, num: d.sig << BigInt(d.exp), den: 1n } : { sign: d.sign, num: d.sig, den: 1n << BigInt(-d.exp) });
  const L = toE(lo), H = toE(hi);
  // (x − L) / (H − L), with magnitudes (all three share a sign)
  const xs = x.num * L.den * H.den, ls = L.num * H.den * x.den, hs = H.num * L.den * x.den;
  const num = xs - ls, d = hs - ls;
  return d === 0n ? 0 : Number((num * 1000000n) / d) / 1e6;
}

// ---------------------------------------------------------------- sum order

export function ArchDataSumOrderDemo() {
  const p = useParams("sumorder", {
    data: seg<SumData>("Numbers", [["bigSmall", "1 then many 1e−8"], ["mixed", "mixed signs and sizes"], ["harmonic", "1 + 1/2 + 1/3 + …"]], "bigSmall"),
    n: range({ label: "How many numbers", min: 10, max: 30000, log: true, default: 10000, format: (v) => Math.round(v).toLocaleString("en-US") }),
  });
  const n = Math.round(p.values.n);
  const xs = useMemo(() => sumData(p.values.data, n), [p.values.data, n]);
  const key = `${p.values.data}:${n}`;
  const res = useChunked(key, [() => exactSum32(xs), ...SUM_ORDERS.map((o) => () => sum32(xs, o.order))], { keep: true });
  const exact = res[0];
  const errs = SUM_ORDERS.map((o, i) => ({ o, v: res[i + 1], e: exact !== undefined && res[i + 1] !== undefined ? ulpsOff32(res[i + 1]!, exact) : undefined }));
  const maxE = Math.max(1, ...errs.map((x) => x.e ?? 0));
  return (
    <Demo
      title="The same numbers, summed in different orders (binary32)"
      controls={<>
        <Param spec={p.schema.data} value={p.values.data} onChange={(v) => p.set("data", v as SumData)} />
        <Param spec={p.schema.n} value={p.values.n} onChange={(v) => p.set("n", v as number)} />
      </>}
    >
      <Readout label="correct sum">{exact === undefined ? "…" : `${exact} (the exact sum, rounded once)`}</Readout>
      <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
        {errs.map(({ o, v, e }) => (
          <div key={o.order} style={{ display: "grid", gridTemplateColumns: "minmax(96px, 120px) minmax(0, 1fr)", gap: 8, alignItems: "center", fontSize: 12.5 }}>
            <span>{o.label}</span>
            <div style={{ minWidth: 0 }}>
              <Bar frac={(e ?? 0) / maxE} color={e === undefined ? "var(--faint)" : e < 1 ? "var(--c3)" : e < 10 ? "var(--c2)" : "var(--c4)"} />
              <div className="muted" style={{ fontSize: 11.5, ...mono, overflowWrap: "anywhere" }}>{v === undefined ? "…" : `${v}, off by ${fixed(e ?? 0, 1)} ULP`}</div>
            </div>
          </div>
        ))}
      </div>
      <Note>Every sum uses the same binary32 values, and every addition rounds to nearest even. Only the order changes. An ULP here is the gap between the correct sum and its neighbour.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- range vs precision

export function ArchDataFormatsDemo() {
  const p = useParams("formats", {
    x: range({ label: "Value to store", min: 1e-9, max: 1e6, log: true, default: 70000, format: (v) => String(v) }),
    sat: toggle({ label: "E4M3: saturate on overflow", default: false }),
  });
  const x = p.values.x;
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const W = Math.max(280, w), lo = -48, hi = 42, padL = 64, padR = 10;
  const X = (l10: number) => padL + ((Math.max(lo, Math.min(hi, l10)) - lo) / (hi - lo)) * (W - padL - padR);
  const rowH = 26;
  return (
    <Demo
      title="Range against precision: six formats"
      controls={<>
        <Param spec={p.schema.x} value={x} onChange={(v) => p.set("x", v as number)} />
        <Param spec={p.schema.sat} value={p.values.sat} onChange={(v) => p.set("sat", v as boolean)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg width={W} height={FORMATS.length * rowH + 30} role="img" aria-label="range of each format on a log scale">
          {(W < 520 ? [-40, -20, 0, 20, 40] : [-40, -30, -20, -10, 0, 10, 20, 30, 40]).map((t) => (
            <g key={t}><line x1={X(t)} x2={X(t)} y1={0} y2={FORMATS.length * rowH} stroke="var(--border)" /><text x={X(t)} y={FORMATS.length * rowH + 14} fontSize={10} textAnchor="middle" fill="var(--muted)">{t === 0 ? "1" : `1e${t}`}</text></g>
          ))}
          {FORMATS.map((f, i) => {
            const s = stats(f);
            const y = i * rowH + 6;
            const a = X(Math.log10(s.minSubnormal)), bN = X(Math.log10(s.minNormal)), c = X(Math.log10(s.maxFinite));
            return (
              <g key={f.id}>
                <text x={0} y={y + 9} fontSize={11} fill="var(--fg)" dy="0.2em">{SHORT[f.id]}</text>
                <rect x={a} y={y} width={Math.max(1, bN - a)} height={14} fill="var(--c2)" opacity={0.35} />
                <rect x={bN} y={y} width={Math.max(1, c - bN)} height={14} fill="var(--c1)" opacity={0.75} />
                {f.id === "binary64" && <text x={W - padR} y={y + 11} fontSize={10} textAnchor="end" fill="var(--bg)">→ 1e308</text>}
              </g>
            );
          })}
          <line x1={X(Math.log10(x))} x2={X(Math.log10(x))} y1={0} y2={FORMATS.length * rowH} stroke="var(--c4)" strokeWidth={2} />
        </svg>
      </div>
      <Legend items={[{ label: "normal range", color: "var(--c1)" }, { label: "subnormal range", color: "var(--c2)" }, { label: "your value", color: "var(--c4)" }]} />
      <MiniTable
        head={["format", "bits s/e/f", "stored as", "relative error", "precision ε"]}
        highlight={(i) => FORMATS[i]!.id === "bfloat16" || FORMATS[i]!.id === "binary16"}
        rows={FORMATS.map((f) => {
          const r = relError(f, x, f === E4M3 && p.values.sat);
          const stored = r.kind === "nan" ? "NaN (overflow)" : r.kind === "inf" ? "∞ (overflow)" : r.kind === "zero" ? "0 (underflow)" : sigStr(r.stored);
          return [SHORT[f.id], `1/${f.e}/${f.m}`, <span style={{ color: r.kind === "normal" ? undefined : "var(--c4)" }}>{stored}{r.kind === "subnormal" ? " (subnormal)" : ""}</span>, r.kind === "normal" || r.kind === "subnormal" ? `${sigStr(r.rel * 100, 2)}%` : "–", <Rich text={`$2^{-${f.m}}$`} />, ];
        })}
      />
      <Note>The exponent bits set the range: the width of each bar. The fraction bits set the precision: ε is the gap after 1. bfloat16 keeps the 8 exponent bits of binary32 and gives up precision. binary16 does the opposite.</Note>
      <Stats items={[{ label: "E4M3 largest", value: String(stats(E4M3).maxFinite) }, { label: "binary16 largest", value: String(stats(FORMATS[2]!).maxFinite) }, { label: "bfloat16 largest", value: sigStr(stats(FORMATS[3]!).maxFinite) }]} />
    </Demo>
  );
}
const sigStr = (v: number, d = 6) => (v === 0 ? "0" : Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4 ? v.toExponential(d - 1).replace(/\.?0+e/, "e") : String(Number(v.toPrecision(d))));
