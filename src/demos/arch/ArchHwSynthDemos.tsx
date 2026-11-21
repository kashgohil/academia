/**
 * Demos of the lesson "Synthesis":
 * - ArchHwKmapDemo: click a truth table into a Karnaugh map; Quine-McCluskey gives the smallest sum of products.
 * - ArchHwAdderTimingDemo: an N-bit adder as gates, ripple-carry or Kogge-Stone; the critical path and its growth.
 * - ArchHwLatchDemo: an always @* block with a path that does not assign y; the waveform holds and the netlist feeds back.
 */
import { useMemo, useState } from "react";
import { Btn, ButtonRow, Demo, Dots, Legend, Line, MiniTable, Param, Plot, SectionLabel, Stats, StepCaption, mono, range, seg, tint, toggle, useChunked } from "../../kit";
import {
  adderSrc, adderStats, canonicalCost, covers, kmapLayout, latchSrc, latchStim, minimize, simulate, sopCost, synthesize, termText, timing, VARS,
  type AdderKind,
} from "../../sims/arch/hw";
import { LUT_COLORS, NetView, VerilogEditor, Waveform, waveRows } from "./ArchHwUi";

// ---------------------------------------------------------------- K-map

type Cell = 0 | 1 | 2; // 2 = don't care
const N_SEG = seg("Inputs", [["2", "2"], ["3", "3"], ["4", "4"]], "4");
const EXAMPLE4 = [0, 1, 2, 5, 6, 7, 8, 9, 10, 14];
const table = (n: number, on: number[], dc: number[] = []): Cell[] => Array.from({ length: 1 << n }, (_, m) => (on.includes(m) ? 1 : dc.includes(m) ? 2 : 0));

export function ArchHwKmapDemo() {
  const [n, setN] = useState(4);
  const [cells, setCells] = useState<Cell[]>(table(4, EXAMPLE4));
  const on = cells.flatMap((c, m) => (c === 1 ? [m] : []));
  const dc = cells.flatMap((c, m) => (c === 2 ? [m] : []));
  const r = useMemo(() => minimize(n, on, dc), [n, on.join(), dc.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const cost = sopCost(r.cover, n), raw = canonicalCost(n, on);
  const k = kmapLayout(n);
  const rowName = VARS.slice(0, k.rowVars).join(""), colName = VARS.slice(k.rowVars, n).join("");
  const bin = (v: number, bits: number) => v.toString(2).padStart(bits, "0");
  const setNn = (v: number) => { setN(v); setCells(v === 4 ? table(4, EXAMPLE4) : v === 3 ? table(3, [3, 5, 6, 7]) : table(2, [1, 2])); };
  const flip = (m: number) => setCells(cells.map((c, i) => (i === m ? (((c + 1) % 3) as Cell) : c)));
  return (
    <Demo
      title="From truth table to gates: a Karnaugh map"
      actions={
        <ButtonRow>
          <Btn ghost onClick={() => setCells(n === 4 ? table(4, EXAMPLE4) : n === 3 ? table(3, [3, 5, 6, 7]) : table(2, [1, 2]))}>Example</Btn>
          <Btn ghost onClick={() => setCells(Array.from({ length: 1 << n }, (_, m) => ((popc(m) & 1) as Cell)))}>Parity</Btn>
          <Btn ghost onClick={() => setCells(cells.map(() => 0))}>Clear</Btn>
        </ButtonRow>
      }
      controls={<Param spec={N_SEG} value={String(n)} onChange={(v) => setNn(Number(v))} />}
    >
      <StepCaption tone="info" label="minimal">
        <span style={mono}>F = {r.cover.length ? r.cover.map((p, i) => <span key={i}>{i > 0 && " + "}<span style={{ color: LUT_COLORS[i % LUT_COLORS.length], fontWeight: 700 }}>{termText(p, n)}</span></span>) : r.text}</span>
      </StepCaption>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start", marginTop: 10 }}>
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table style={{ borderCollapse: "collapse", ...mono, fontSize: 13 }}>
            <thead>
              <tr>
                <th className="muted" style={{ fontSize: 11, padding: "2px 6px", fontWeight: 400 }}>{rowName}\{colName}</th>
                {k.cols.map((c) => <th key={c} className="muted" style={{ fontSize: 11.5, padding: "2px 6px", fontWeight: 400 }}>{bin(c, k.colVars)}</th>)}
              </tr>
            </thead>
            <tbody>
              {k.rows.map((rv, ri) => (
                <tr key={rv}>
                  <th className="muted" style={{ fontSize: 11.5, padding: "2px 6px", fontWeight: 400 }}>{k.rowVars ? bin(rv, k.rowVars) : ""}</th>
                  {k.cell[ri]!.map((m) => {
                    const c = cells[m]!;
                    const by = r.cover.map((p, i) => (covers(p, m) ? i : -1)).filter((i) => i >= 0);
                    return (
                      <td key={m} style={{ padding: 0 }}>
                        <button onClick={() => flip(m)} title={`minterm ${m}: click for 0, 1, x`} style={{
                          width: 44, height: 40, border: "1px solid var(--border)", borderRadius: 0, cursor: "pointer", position: "relative", ...mono, fontSize: 15,
                          background: by.length ? tint(LUT_COLORS[by[0]! % LUT_COLORS.length]!, 30) : "var(--bg)", color: c === 0 ? "var(--faint)" : "var(--fg)", fontWeight: c === 1 ? 700 : 400,
                        }}>
                          {c === 2 ? "x" : c}
                          <span style={{ position: "absolute", left: 3, top: 1, fontSize: 9, color: "var(--muted)" }}>{m}</span>
                          <span style={{ position: "absolute", right: 2, bottom: 2, display: "flex", gap: 1 }}>
                            {by.map((i) => <span key={i} style={{ width: 5, height: 5, borderRadius: 3, background: LUT_COLORS[i % LUT_COLORS.length] }} />)}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Rows and columns go in Gray code: neighbours differ in one bit.</div>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <MiniTable head={["", "one AND per 1", "minimized"]} rows={[
            ["product terms", String(raw.terms), String(cost.terms)],
            ["literals", String(raw.literals), String(cost.literals)],
            ["2-input gates", String(raw.gates2), String(cost.gates2)],
            ["gate levels", String(raw.depth), String(cost.depth)],
          ]} />
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {r.primes.length} prime implicants, {r.essential.length} essential. Inverters ({cost.inverters}) are not counted as gates.
          </div>
        </div>
      </div>
    </Demo>
  );
}
const popc = (x: number) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };

// ---------------------------------------------------------------- adder timing

const WIDTHS = [2, 4, 6, 8, 12, 16, 20, 24, 28, 32];
const KIND = seg("Adder", [["ripple", "ripple-carry"], ["prefix", "Kogge-Stone"]], "ripple");

export function ArchHwAdderTimingDemo() {
  const [w, setW] = useState(8);
  const [kind, setKind] = useState<AdderKind>("ripple");
  const sweep = useChunked("adders", WIDTHS.flatMap((x) => (["ripple", "prefix"] as const).map((kd) => () => ({ w: x, kd, ...adderStats(x, kd) }))));
  const syn = useMemo(() => synthesize(adderSrc(w), { adder: kind }), [w, kind]);
  const t = useMemo(() => timing(syn.net!), [syn]);
  const pts = (kd: AdderKind) => sweep.filter((s) => s && s.kd === kd).map((s) => [s!.w, s!.delay] as [number, number]);
  const pathGates = t.path.filter((id) => syn.net!.gates[id]!.op !== "in").length;
  return (
    <Demo
      title="The critical path of an adder"
      controls={
        <>
          <Param spec={range({ label: "Width (bits)", min: 2, max: 32, step: 2, default: 8 })} value={w} onChange={(v) => setW(v as number)} />
          <Param spec={KIND} value={kind} onChange={(v) => setKind(v as AdderKind)} />
        </>
      }
    >
      <StepCaption tone="info" label={`${w}-bit ${kind === "ripple" ? "ripple" : "Kogge-Stone"}`}>
        The longest path runs from {t.start} to {t.end} through {pathGates} gates: {t.delay} τ.
      </StepCaption>
      <Stats items={[
        { label: "gates", value: String(t.gates) },
        { label: "gate levels", value: String(t.depth) },
        { label: "critical path (τ, model)", value: String(t.delay) },
        { label: "XOR / AND / OR", value: `${t.counts.xor} / ${t.counts.and} / ${t.counts.or}` },
      ]} />
      <SectionLabel>Critical path delay against width</SectionLabel>
      <Plot x={[0, 33]} y={[0, 66]} height={200} xLabel="bits" yLabel="delay (τ)">
        <Line points={pts("ripple")} color="var(--c4)" />
        <Line points={pts("prefix")} color="var(--c1)" />
        <Dots points={[[w, t.delay]]} color={kind === "ripple" ? "var(--c4)" : "var(--c1)"} r={5} />
      </Plot>
      <Legend items={[{ label: "ripple-carry", color: "var(--c4)" }, { label: "Kogge-Stone", color: "var(--c1)" }]} />
      <SectionLabel>The gates (the critical path is thick)</SectionLabel>
      <NetView net={syn.net!} path={t.path} maxGates={70} />
    </Demo>
  );
}

// ---------------------------------------------------------------- latch

const DEFAULT_T = toggle({ label: "Assign a default first", default: false });

export function ArchHwLatchDemo() {
  const [fix, setFix] = useState(false);
  const [src, setSrc] = useState(latchSrc(false));
  const run = useMemo(() => simulate(src, 12, latchStim), [src]);
  const syn = useMemo(() => synthesize(src), [src]);
  const wave = run.wave;
  const sel = wave ? wave.values[wave.signals.findIndex((s) => s.name === "sel")]! : [];
  const held = sel.flatMap((v, i) => (v >= 2 ? [i] : []));
  const latch = syn.latches.length > 0;
  const setDefault = (v: boolean) => { setFix(v); setSrc(latchSrc(v)); };
  return (
    <Demo
      title="An incomplete if: the inferred latch"
      controls={<Param spec={DEFAULT_T} value={fix} onChange={(v) => setDefault(v as boolean)} />}
    >
      <StepCaption tone={run.error || syn.error ? "bad" : latch ? "warn" : "good"} label={latch ? "latch" : "no latch"}>
        {run.error ? `Line ${run.error.line}: ${run.error.message}` : latch
          ? `Synthesis infers a latch for ${syn.latches.join(", ")}. In the shaded cycles sel is 2 or 3, no path assigns y, and y keeps its old value.`
          : "Every path assigns y, so y is a pure function of the inputs. In the shaded cycles y is 0."}
      </StepCaption>
      {wave && <Waveform rows={waveRows(wave, ["sel", "a", "b", "y"])} cycles={wave.cycles} mark={held} cw={34} />}
      <SectionLabel>The netlist{latch ? ": the y (held) inputs are the latch's feedback" : ""}</SectionLabel>
      {syn.net && <NetView net={syn.net} maxGates={60} />}
      <SectionLabel>Source</SectionLabel>
      <VerilogEditor value={src} onChange={setSrc} error={run.error ?? syn.error} warnings={run.warnings} rows={10} />
    </Demo>
  );
}
