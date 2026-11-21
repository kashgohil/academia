/**
 * Demos of the lesson "FPGAs":
 * - ArchHwLutDemo: a 4-input LUT is 16 bits of memory and a tree of 2-to-1 muxes. Set the bits, drive the inputs.
 * - ArchHwMapDemo: map a small design to K-input LUTs; K changes the LUT count and the LUT levels.
 * - ArchHwPlaceDemo: place the LUTs on a grid by simulated annealing; wire length and the critical path follow.
 */
import { useMemo, useState } from "react";
import { Btn, ButtonRow, Demo, Dots, Line, MiniTable, Param, Plot, SectionLabel, Stats, StepCaption, fixed, mono, pct, range, select, tint } from "../../kit";
import { anneal, COMB_DESIGNS, LUT_DELAY, lutTable, mapLuts, minimize, pinOf, placeProblem, synthesize, timing } from "../../sims/arch/hw";
import { LUT_COLORS, NetView } from "./ArchHwUi";

// ---------------------------------------------------------------- one LUT

const LUT_PRESETS: { id: string; label: string; f: (a: number, b: number, c: number, d: number) => number }[] = [
  { id: "and", label: "AND", f: (a, b, c, d) => a & b & c & d },
  { id: "xor", label: "XOR (parity)", f: (a, b, c, d) => a ^ b ^ c ^ d },
  { id: "mux", label: "A ? B : C", f: (a, b, c) => (a ? b : c) },
  { id: "maj", label: "at least 3 of 4", f: (a, b, c, d) => (a + b + c + d >= 3 ? 1 : 0) },
  { id: "eq", label: "A=B and C=D", f: (a, b, c, d) => (a === b && c === d ? 1 : 0) },
];
const bitsOf = (f: (a: number, b: number, c: number, d: number) => number) => Array.from({ length: 16 }, (_, m) => f((m >> 3) & 1, (m >> 2) & 1, (m >> 1) & 1, m & 1));
const initHex = (bits: number[]) => bits.reduce((t, b, m) => t + b * 2 ** m, 0).toString(16).toUpperCase().padStart(Math.ceil(bits.length / 4), "0");

export function ArchHwLutDemo() {
  const [bits, setBits] = useState(bitsOf(LUT_PRESETS[2]!.f));
  const [inp, setInp] = useState([1, 0, 1, 0]); // A B C D
  const addr = inp[0]! * 8 + inp[1]! * 4 + inp[2]! * 2 + inp[3]!;
  const out = bits[addr]!;
  const sop = useMemo(() => minimize(4, bits.flatMap((b, m) => (b ? [m] : []))).text, [bits]);
  const W = 16 * 26 + 20;
  const leafX = (i: number) => 10 + i * 26 + 13;
  // node x at level L (L = 0 leaves, 4 = output), index j
  const nodeX = (L: number, j: number) => { const span = 2 ** L; return (leafX(j * span) + leafX(j * span + span - 1)) / 2; };
  const levelY = (L: number) => 36 + L * 38;
  const sel = ["D", "C", "B", "A"];
  return (
    <Demo
      title="A 4-input LUT: 16 bits of memory and a mux tree"
      actions={<ButtonRow>{LUT_PRESETS.map((p) => <Btn key={p.id} ghost onClick={() => setBits(bitsOf(p.f))}>{p.label}</Btn>)}</ButtonRow>}
    >
      <StepCaption tone={out ? "good" : "plain"} label={`address ${addr}`}>
        Inputs A B C D = {inp.join(" ")} select bit {addr} of the memory, so the output is {out}. The LUT computes F = {sop}.
      </StepCaption>
      <div style={{ marginTop: 8 }}>
        <svg viewBox={`0 0 ${W} ${levelY(4) + 34}`} width="100%" style={{ maxWidth: 560, display: "block" }} role="img" aria-label="LUT as memory and mux tree">
          {[1, 2, 3, 4].flatMap((L) => Array.from({ length: 16 >> L }, (_, j) => {
            const on = j === addr >> L;
            const x = nodeX(L, j), y = levelY(L);
            const kids = [nodeX(L - 1, 2 * j), nodeX(L - 1, 2 * j + 1)];
            const pickBit = (addr >> (L - 1)) & 1;
            return (
              <g key={`${L}-${j}`}>
                {kids.map((kx, s) => {
                  const hot = on && s === pickBit;
                  return <line key={s} x1={kx} y1={levelY(L - 1) + (L === 1 ? 10 : 7)} x2={x} y2={y - 7} stroke={hot ? "var(--c1)" : "var(--faint)"} strokeWidth={hot ? 2.2 : 1} />;
                })}
                <rect x={x - 8} y={y - 7} width={16} height={14} rx={3} fill={on ? tint("var(--c1)", 40) : "var(--bg)"} stroke={on ? "var(--c1)" : "var(--muted)"} />
              </g>
            );
          }))}
          {[1, 2, 3, 4].map((L) => <text key={L} x={4} y={levelY(L) + 4} fontSize={10} fill="var(--muted)">{sel[L - 1]}</text>)}
          <line x1={nodeX(4, 0)} y1={levelY(4) + 7} x2={nodeX(4, 0)} y2={levelY(4) + 22} stroke="var(--c1)" strokeWidth={2.2} />
          <text x={nodeX(4, 0) + 8} y={levelY(4) + 24} fontSize={12} fill="var(--fg)" style={{ fontWeight: 700 }}>out = {out}</text>
          {bits.map((b, m) => (
            <g key={m} onClick={() => setBits(bits.map((x, i) => (i === m ? x ^ 1 : x)))} style={{ cursor: "pointer" }}>
              <rect x={leafX(m) - 11} y={14} width={22} height={20} rx={3} fill={m === addr ? tint("var(--c1)", 45) : b ? tint("var(--c3)", 30) : "var(--subtle)"} stroke={m === addr ? "var(--c1)" : "var(--border)"} />
              <text x={leafX(m)} y={28} textAnchor="middle" fontSize={12} fill="var(--fg)" style={{ fontFamily: "ui-monospace, monospace", fontWeight: b ? 700 : 400 }}>{b}</text>
              <text x={leafX(m)} y={10} textAnchor="middle" fontSize={8.5} fill="var(--muted)">{m}</text>
            </g>
          ))}
        </svg>
      </div>
      <SectionLabel>Inputs (each one drives one level of the tree)</SectionLabel>
      <ButtonRow>
        {["A", "B", "C", "D"].map((n, i) => (
          <Btn key={n} on={inp[i] === 1} onClick={() => setInp(inp.map((x, j) => (j === i ? x ^ 1 : x)))}>{n} = {inp[i]}</Btn>
        ))}
      </ButtonRow>
      <Stats items={[
        { label: "the 16 bits as hex (bit 15 first)", value: `16'h${initHex(bits)}` },
        { label: "ones in the table", value: String(bits.filter(Boolean).length) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- technology mapping

const DESIGN = select({ label: "Design", options: COMB_DESIGNS.map((d) => ({ value: d.id, label: d.title })), default: "add4" });

export function ArchHwMapDemo() {
  const [id, setId] = useState("add4");
  const [k, setK] = useState(4);
  const d = COMB_DESIGNS.find((x) => x.id === id)!;
  const syn = useMemo(() => synthesize(d.source), [d]);
  const net = syn.net!;
  const t = useMemo(() => timing(net), [net]);
  const m = useMemo(() => mapLuts(net, k), [net, k]);
  const rootName = new Map(m.luts.map((l, i) => [l.root, `LUT ${i}`] as const));
  const leafName = (x: number) => rootName.get(x) ?? net.gates[x]!.name;
  const outs = new Map<number, string[]>();
  for (const o of net.outputs) outs.set(o.node, [...(outs.get(o.node) ?? []), o.name]);
  return (
    <Demo
      title="Technology mapping: gates into K-input LUTs"
      controls={
        <>
          <Param spec={range({ label: "LUT inputs K", min: 3, max: 6, step: 1, default: 4 })} value={k} onChange={(v) => setK(v as number)} />
          <Param spec={DESIGN} value={id} onChange={(v) => setId(v as string)} />
        </>
      }
    >
      <StepCaption tone="info" label={`K = ${k}`}>
        {t.gates} gates in {t.depth} levels become {m.luts.length} LUTs in {m.depth} level{m.depth === 1 ? "" : "s"}. Each colour is one LUT; a thick border marks its output gate.
      </StepCaption>
      <Stats items={[
        { label: "gates", value: String(t.gates) },
        { label: "gate levels", value: String(t.depth) },
        { label: `${k}-LUTs`, value: String(m.luts.length) },
        { label: "LUT levels", value: String(m.depth) },
      ]} />
      <NetView net={net} mapping={m} maxGates={80} />
      <SectionLabel>The LUTs</SectionLabel>
      <MiniTable
        head={["LUT", "inputs", "gates inside", "drives", `contents (${2 ** k} bits, hex)`]}
        rows={m.luts.map((l, i) => [
          <span key="n" style={{ color: LUT_COLORS[i % LUT_COLORS.length], fontWeight: 700, whiteSpace: "nowrap" }}>LUT {i}</span>,
          <span key="i" style={mono}>{l.leaves.map(leafName).join(" ")}</span>,
          String(l.cone.length),
          <span key="o" style={mono}>{outs.get(l.root)?.join(" ") ?? "–"}</span>,
          <span key="h" style={mono}>{initHex([...lutTable(net, l), ...Array.from({ length: 2 ** k - 2 ** l.leaves.length }, () => 0)].slice(0, 2 ** k))}</span>,
        ])}
      />
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>A LUT with fewer than K inputs leaves the upper bits of its table unused (0 here).</div>
    </Demo>
  );
}

// ---------------------------------------------------------------- placement

const PDESIGN = select({ label: "Design", options: COMB_DESIGNS.map((d) => ({ value: d.id, label: d.title })), default: "add8" });
const ROUNDS = 30;

export function ArchHwPlaceDemo() {
  const [id, setId] = useState("add8");
  const [seed, setSeed] = useState(1);
  const [round, setRound] = useState(0);
  const d = COMB_DESIGNS.find((x) => x.id === id)!;
  const prob = useMemo(() => {
    const syn = synthesize(d.source);
    return placeProblem(syn.net!, mapLuts(syn.net!, 4));
  }, [d]);
  const frames = useMemo(() => anneal(prob, { seed, rounds: ROUNDS }), [prob, seed]);
  const f = frames[Math.min(round, frames.length - 1)]!;
  const G = prob.grid, S = 34, PAD = 30;
  const px = (x: number) => PAD + x * S + S / 2, py = (y: number) => 14 + y * S + S / 2;
  const W = PAD * 2 + G * S, H = G * S + 28;
  const hot = new Set(f.sta.path);
  const levels = f.sta.path.filter((ei) => prob.edges[ei]!.to < prob.nLuts).length;
  return (
    <Demo
      title="Placement: where the LUTs sit sets the wire delay"
      actions={<Btn ghost onClick={() => { setSeed(seed + 1); setRound(0); }}>New random start</Btn>}
      controls={
        <>
          <Param spec={range({ label: "Annealing round", min: 0, max: ROUNDS, step: 1, default: 0 })} value={round} onChange={(v) => setRound(v as number)} />
          <Param spec={PDESIGN} value={id} onChange={(v) => { setId(v as string); setRound(0); }} />
        </>
      }
    >
      <StepCaption tone={round === 0 ? "warn" : "info"} label={round === 0 ? "random" : `round ${round}`}>
        Critical path {fixed(f.sta.delay)} units: {levels} LUTs ({fixed(levels * LUT_DELAY)}) and {fixed(f.sta.wire)} of wire, so wires are {pct(f.sta.wire / Math.max(1e-9, f.sta.delay), 0)} of it.
      </StepCaption>
      <div style={{ marginTop: 8 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 440, display: "block" }} role="img" aria-label="placement grid">
          {Array.from({ length: G * G }, (_, s) => (
            <rect key={s} x={px(s % G) - S / 2 + 2} y={py(Math.floor(s / G)) - S / 2 + 2} width={S - 4} height={S - 4} rx={3} fill="var(--subtle)" stroke="var(--border)" />
          ))}
          {prob.edges.map((e, i) => {
            const a = pinOf(prob, f.pos, e.from), b = pinOf(prob, f.pos, e.to);
            return <line key={i} x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} stroke={hot.has(i) ? "var(--c4)" : "var(--faint)"} strokeWidth={hot.has(i) ? 2.4 : 1} opacity={hot.has(i) ? 1 : 0.8} />;
          })}
          {f.pos.map((s, i) => (
            <g key={i}>
              <rect x={px(s % G) - 12} y={py(Math.floor(s / G)) - 10} width={24} height={20} rx={3} fill={tint("var(--c1)", 40)} stroke="var(--c1)" />
              <text x={px(s % G)} y={py(Math.floor(s / G)) + 4} textAnchor="middle" fontSize={10} fill="var(--fg)">{i}</text>
            </g>
          ))}
          {[...prob.inPads, ...prob.outPads].map((p, i) => (
            <g key={`p${i}`}>
              <circle cx={px(p.x)} cy={py(p.y)} r={4} fill="var(--bg)" stroke="var(--fg)" />
            </g>
          ))}
          <text x={4} y={H - 4} fontSize={10} fill="var(--muted)">inputs</text>
          <text x={W - 4} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor="end">outputs</text>
        </svg>
      </div>
      <Stats items={[
        { label: "LUTs", value: String(prob.nLuts) },
        { label: "wire length (HPWL, grid steps)", value: fixed(f.cost, 1) },
        { label: "critical path (units, model)", value: fixed(f.sta.delay) },
        { label: "swaps tried", value: String(f.moves) },
      ]} />
      <SectionLabel>Critical path delay by round</SectionLabel>
      <Plot x={[0, ROUNDS]} y={[0, Math.ceil(Math.max(...frames.map((x) => x.sta.delay)) + 1)]} height={150} xLabel="round" yLabel="units">
        <Line points={frames.map((x, i) => [i, x.sta.delay] as [number, number])} color="var(--c4)" />
        <Line points={frames.map((x, i) => [i, x.sta.delay - x.sta.wire] as [number, number])} color="var(--c1)" dash="4 3" />
        <Dots points={[[round, f.sta.delay]]} color="var(--c4)" r={5} />
      </Plot>
      <div className="muted" style={{ fontSize: 12 }}>Solid: the whole critical path. Dashed: its LUT delay alone. The gap between them is wire.</div>
    </Demo>
  );
}
