/**
 * Demos of the lesson "HDLs and Verilog basics":
 * - ArchHwPlayground: edit a small design, simulate it for N cycles, read the waveform.
 * - ArchHwSwapDemo: the swap with <= or =, in one or two blocks; step through one clock edge event by event.
 * - ArchHwFsmDemo: drive the input of a sequence detector bit by bit and watch the state machine move.
 */
import { useMemo, useState } from "react";
import { Btn, ButtonRow, Demo, IndexButtons, MiniTable, Param, SectionLabel, Stats, StepCaption, mono, range, seg, select, tint } from "../../kit";
import { DETECT_BITS, DETECT_NEXT, DETECT_STATES, EXAMPLES, RtlSim, elaborate, simulate, swapSrc, type EdgeEvent } from "../../sims/arch/hw";
import { VerilogEditor, Waveform, waveRows } from "./ArchHwUi";

// ---------------------------------------------------------------- playground

const PRESET = select({ label: "Design", options: EXAMPLES.map((e) => ({ value: e.id, label: e.title })), default: "counter" });

export function ArchHwPlayground() {
  const [id, setId] = useState("counter");
  const [src, setSrc] = useState(EXAMPLES[0]!.source);
  const [cycles, setCycles] = useState(20);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const ex = EXAMPLES.find((e) => e.id === id)!;
  const run = useMemo(() => simulate(src, cycles, ex.stim), [src, cycles, ex]);
  const flops = run.design ? run.design.procs.filter((p) => p.kind === "seq").flatMap((p) => p.writes).reduce((t, s) => t + run.design!.signals[s]!.width, 0) : 0;
  const comb = run.design ? run.design.procs.filter((p) => p.kind !== "seq").length : 0;
  const pick = (v: string) => { setId(v); setSrc(EXAMPLES.find((e) => e.id === v)!.source); setCursor(undefined); };
  const fmt = id === "detect" ? { st: (v: number) => DETECT_STATES[v] ?? String(v) } : undefined;
  return (
    <Demo
      title="Verilog playground: edit, simulate, read the waveform"
      actions={<Btn ghost onClick={() => pick(id)}>Reset code</Btn>}
      controls={
        <>
          <Param spec={range({ label: "Cycles to simulate", min: 4, max: 40, step: 1, default: 20 })} value={cycles} onChange={(v) => setCycles(v as number)} />
          <Param spec={PRESET} value={id} onChange={(v) => pick(v as string)} />
        </>
      }
    >
      <StepCaption tone={run.error ? "bad" : run.warnings.length ? "warn" : "good"} label={run.error ? "error" : `${cycles} cycles`}>
        {run.error ? `Line ${run.error.line}: ${run.error.message}` : ex.about}
      </StepCaption>
      {run.wave && (
        <>
          <SectionLabel>Waveform (click a cycle)</SectionLabel>
          <Waveform rows={waveRows(run.wave, undefined, fmt)} cycles={run.wave.cycles} cursor={cursor} onCursor={setCursor} />
          {cursor !== undefined && cursor < run.wave.cycles && (
            <div style={{ fontSize: 12.5, marginTop: 6, ...mono }}>
              <span className="muted">cycle {cursor}: </span>
              {run.wave.signals.map((s, i) => `${s.name}=${fmt?.[s.name as "st"]?.(run.wave!.values[i]![cursor]!) ?? run.wave!.values[i]![cursor]}`).join("  ")}
            </div>
          )}
        </>
      )}
      <Stats items={[
        { label: "flip-flops", value: run.design ? String(flops) : "–" },
        { label: "combinational processes", value: run.design ? String(comb) : "–" },
        { label: "process runs", value: run.sim ? String(run.sim.evals) : "–" },
      ]} />
      <SectionLabel>Source (edit it: the waveform follows)</SectionLabel>
      <VerilogEditor value={src} onChange={(v) => { setSrc(v); setCursor(undefined); }} error={run.error} warnings={run.warnings} rows={13} />
    </Demo>
  );
}

// ---------------------------------------------------------------- swap

const OP = seg("Assignment", [["<=", "nonblocking <="], ["=", "blocking ="]], "<=");
const LAYOUT = seg("Code", [["one", "one always block"], ["two", "two always blocks"]], "one");

interface SwapStep { text: string; a: number; b: number; line: number; pending: string[] }

/** One clock edge of the swap, after reset, as a list of steps with the values of a and b after each step. */
function swapEdge(op: "<=" | "=", layout: "one" | "two") {
  const src = swapSrc(op, layout);
  const sim = new RtlSim(elaborate(src));
  sim.set("rst", 1); sim.settle(); sim.edge(); sim.set("rst", 0); sim.settle();
  const a0 = sim.get("a"), b0 = sim.get("b");
  sim.edgeLog = [];
  sim.edge();
  const log: EdgeEvent[] = sim.edgeLog;
  const steps: SwapStep[] = [{ text: `Before the edge: a = ${a0}, b = ${b0}.`, a: a0, b: b0, line: 0, pending: [] }];
  let a = a0, b = b0;
  const pending: string[] = [];
  for (const e of log) {
    if (e.phase === "eval" && e.nb) {
      pending.push(`${e.target} ← ${e.value}`);
      steps.push({ text: `Line ${e.line}: read the right side (${e.value}) and queue ${e.target} <= ${e.value}. Nothing changes yet.`, a, b, line: e.line, pending: pending.slice() });
    } else if (e.phase === "eval") {
      if (e.target === "a") a = e.value; else b = e.value;
      steps.push({ text: `Line ${e.line}: ${e.target} = ${e.value} at once. Later statements see the new value.`, a, b, line: e.line, pending: pending.slice() });
    } else {
      if (e.target === "a") a = e.value; else b = e.value;
      pending.shift();
      steps.push({ text: `After all blocks ran: apply the queued write ${e.target} = ${e.value}.`, a, b, line: e.line, pending: pending.slice() });
    }
  }
  const swapped = a === b0 && b === a0;
  return { src, steps, swapped, a, b };
}

export function ArchHwSwapDemo() {
  const [op, setOp] = useState<"<=" | "=">("<=");
  const [layout, setLayout] = useState<"one" | "two">("one");
  const [k, setK] = useState(0);
  const r = useMemo(() => swapEdge(op, layout), [op, layout]);
  const run = useMemo(() => simulate(r.src, 6, (t) => ({ rst: t === 0 ? 1 : 0 })), [r.src]);
  const step = r.steps[Math.min(k, r.steps.length - 1)]!;
  const lines = r.src.split("\n");
  const last = k >= r.steps.length - 1;
  return (
    <Demo
      title="Blocking and nonblocking: one clock edge, step by step"
      actions={<ButtonRow><IndexButtons k={Math.min(k, r.steps.length - 1)} n={r.steps.length} set={setK} /></ButtonRow>}
      controls={
        <>
          <Param spec={OP} value={op} onChange={(v) => { setOp(v as "<=" | "="); setK(0); }} />
          <Param spec={LAYOUT} value={layout} onChange={(v) => { setLayout(v as "one" | "two"); setK(0); }} />
        </>
      }
    >
      <StepCaption tone={last ? (r.swapped ? "good" : "bad") : "info"} label={`step ${Math.min(k, r.steps.length - 1) + 1} of ${r.steps.length}`}>
        {step.text}{last && (r.swapped ? " The registers swapped." : ` Both registers hold ${r.a}: the old value ${r.a === r.steps[0]!.b ? r.steps[0]!.a : r.steps[0]!.b} is lost.`)}
      </StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Code</SectionLabel>
          <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 0" }}>
            {lines.map((l, i) => (
              <div key={i} style={{ padding: "0 8px", background: step.line === i + 1 ? tint("var(--c1)", 25) : undefined, boxShadow: step.line === i + 1 ? "inset 3px 0 0 var(--c1)" : undefined }}>
                <span className="muted" style={{ display: "inline-block", width: 18 }}>{i + 1}</span>{l || " "}
              </div>
            ))}
          </pre>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Registers now</SectionLabel>
          <MiniTable head={["", "value"]} rows={[["a", String(step.a)], ["b", String(step.b)], ["queued writes", step.pending.length ? step.pending.join(", ") : "none"]]} />
          <SectionLabel>Six cycles</SectionLabel>
          <Waveform rows={waveRows(run.wave!, ["rst", "a", "b"])} cycles={6} cursor={1} />
        </div>
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- FSM

const N_FSM = 16;
const DEFAULT_BITS = DETECT_BITS.slice(0, N_FSM); // the test pins: found in cycles 5, 8 and 15

export function ArchHwFsmDemo() {
  const [bits, setBits] = useState(DEFAULT_BITS);
  const [t, setT] = useState(5);
  const src = EXAMPLES.find((e) => e.id === "detect")!.source;
  const run = useMemo(() => simulate(src, N_FSM, (c) => ({ rst: c === 0 ? 1 : 0, din: bits[c] ?? 0 })), [src, bits]);
  const col = (n: string) => run.wave!.values[run.wave!.signals.findIndex((s) => s.name === n)]!;
  const st = col("st"), found = col("found");
  const cur = st[t] ?? 0, din = bits[t] ?? 0, nxt = t === 0 ? 0 : DETECT_NEXT[cur]![din]!;
  const hits = found.filter(Boolean).length;
  return (
    <Demo
      title="A state machine: you drive the input"
      actions={<ButtonRow><Btn ghost onClick={() => setBits(DEFAULT_BITS)}>Default input</Btn><Btn ghost onClick={() => setBits(bits.map(() => 0))}>All zeros</Btn></ButtonRow>}
      controls={<Param spec={range({ label: "Cycle", min: 0, max: N_FSM - 1, step: 1, default: 5 })} value={t} onChange={(v) => setT(v as number)} />}
    >
      <StepCaption tone={found[t] ? "good" : "info"} label={`cycle ${t}`}>
        {t === 0 ? "Cycle 0: rst is 1, so the next state is IDLE." : `The state is ${DETECT_STATES[cur]} and din is ${din}, so the next-state logic gives ${DETECT_STATES[nxt]}. The edge at the end of the cycle loads it.`}
        {found[t] ? " found = 1: the last four inputs were 1, 0, 1, 1." : ""}
      </StepCaption>
      <StateDiagram cur={cur} next={t === 0 ? -1 : nxt} din={din} />
      <SectionLabel>Input bits (click to flip)</SectionLabel>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {bits.map((b, i) => (
          <button key={i} className="btn" onClick={() => setBits(bits.map((x, j) => (j === i ? x ^ 1 : x)))} disabled={i === 0}
            style={{ minWidth: 30, padding: "2px 0", ...mono, background: b ? tint("var(--c1)", 35) : undefined, outline: i === t ? "2px solid var(--fg)" : undefined, outlineOffset: -2 }}
            title={`din in cycle ${i}`}>{b}</button>
        ))}
      </div>
      <SectionLabel>Waveform</SectionLabel>
      <Waveform rows={waveRows(run.wave!, ["rst", "din", "st", "found"], { st: (v) => DETECT_STATES[v] ?? String(v) })} cycles={N_FSM} cursor={t} onCursor={setT} cw={42} />
      <Stats items={[{ label: "cycles with found = 1", value: String(hits) }, { label: "flip-flops (the state)", value: "3" }]} />
    </Demo>
  );
}

/** The five states of the 1011 detector in a row; forward edges on the line, back edges as arcs. */
function StateDiagram({ cur, next, din }: { cur: number; next: number; din: number }) {
  const X = (i: number) => 44 + i * 98, Y = 78, R = 24;
  const edges: { from: number; to: number; bit: number }[] = [];
  DETECT_NEXT.forEach(([n0, n1], s) => { edges.push({ from: s, to: n0, bit: 0 }); edges.push({ from: s, to: n1, bit: 1 }); });
  return (
    <div style={{ marginTop: 8 }}>
      <svg viewBox="0 0 480 172" width="100%" style={{ maxWidth: 560, display: "block" }} role="img" aria-label="state diagram">
        <defs>
          <marker id="hw-fsm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--muted)" /></marker>
          <marker id="hw-fsm-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--c1)" /></marker>
        </defs>
        {edges.map((e, i) => {
          const on = e.from === cur && e.bit === din && next >= 0;
          const stroke = on ? "var(--c1)" : "var(--faint)";
          const marker = `url(#${on ? "hw-fsm-arrow-on" : "hw-fsm-arrow"})`;
          let d: string, lx: number, ly: number;
          if (e.from === e.to) {
            const x = X(e.from);
            d = `M${x - 10} ${Y - R + 2}C${x - 26} ${Y - 70} ${x + 26} ${Y - 70} ${x + 10} ${Y - R + 2}`; lx = x; ly = Y - 58;
          } else if (e.to === e.from + 1) {
            d = `M${X(e.from) + R} ${Y}L${X(e.to) - R} ${Y}`; lx = (X(e.from) + X(e.to)) / 2; ly = Y - 6;
          } else {
            const x1 = X(e.from), x2 = X(e.to), h = 10 + Math.abs(e.from - e.to) * 14;
            const c = Y + R + h, y0 = Y + R - 3;
            d = `M${x1 - 7} ${y0}C${x1 - 12} ${c} ${x2 + 12} ${c} ${x2 + 7} ${y0}`;
            lx = (x1 + x2) / 2; ly = 0.25 * y0 + 0.75 * c + 12; // below the lowest point of the curve
          }
          return (
            <g key={i}>
              <path d={d} fill="none" stroke={stroke} strokeWidth={on ? 2.2 : 1.2} markerEnd={marker} />
              <text x={lx} y={ly} textAnchor="middle" fontSize={11} fill={on ? "var(--c1)" : "var(--muted)"} style={{ fontWeight: on ? 700 : 400 }}>{e.bit}</text>
            </g>
          );
        })}
        {DETECT_STATES.map((s, i) => (
          <g key={s}>
            <circle cx={X(i)} cy={Y} r={R} fill={i === cur ? tint("var(--c1)", 40) : i === next ? tint("var(--c2)", 30) : "var(--bg)"} stroke={i === 4 ? "var(--c3)" : "var(--fg)"} strokeWidth={i === cur ? 2.4 : 1.2} />
            {i === 4 && <circle cx={X(i)} cy={Y} r={R - 4} fill="none" stroke="var(--c3)" />}
            <text x={X(i)} y={Y + 4} textAnchor="middle" fontSize={11} fill="var(--fg)" style={{ fontWeight: 600 }}>{s}</text>
          </g>
        ))}
      </svg>
      <div className="muted" style={{ fontSize: 12 }}>The thick circle is the state in this cycle, and the thick arrow is the edge that din selects. The shaded circle is the next state. The double circle (S1011) sets found.</div>
    </div>
  );
}
