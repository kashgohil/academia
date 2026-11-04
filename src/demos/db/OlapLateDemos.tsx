/** Demos for "Late materialization": a plan stepper with position lists, and the early vs late crossover. */
import { useMemo, useState, type CSSProperties } from "react";
import { Demo, Stats, Param, Legend, range, toggle, Plot, Line, RuleX, Dots } from "../../kit";
import {
  stepperTable, runPlan, earlyCost, lateCost, crossover, STEPPER_ROWS,
  type Strategy, type ColName, type CostParams,
} from "../../sims/db/olap";
import { seg, mono, Note, Caption, Btn, ButtonRow, MiniTable, fx } from "./OlapShared";

const COLS: ColName[] = ["id", "region", "qty", "price", "discount"];
const STRAT: [Strategy, string][] = [["early", "early"], ["late", "late, position lists"], ["bitmap", "late, bitmaps"]];

export function PlanStepperDemo() {
  const [threshold, setThreshold] = useState(25);
  const [strategy, setStrategy] = useState<Strategy>("late");
  const [at, setAt] = useState(0);
  const t = useMemo(() => stepperTable(), []);
  const steps = useMemo(() => runPlan(strategy, t, threshold), [strategy, t, threshold]);
  const all = useMemo(() => STRAT.map(([s]) => runPlan(s, t, threshold).at(-1)!.counters), [t, threshold]);
  const i = Math.min(at, steps.length - 1);
  const step = steps[i]!;
  const before = new Map<ColName, Set<number>>();
  for (const s of steps.slice(0, i)) for (const [c, rows] of Object.entries(s.touched)) {
    const set = before.get(c as ColName) ?? new Set<number>();
    for (const r of rows!) set.add(r);
    before.set(c as ColName, set);
  }
  const pos = new Set(step.positions ?? []);
  const cell = (c: ColName, r: number): CSSProperties => {
    const now = step.touched[c]?.includes(r);
    const was = before.get(c)?.has(r);
    return {
      padding: "0 4px", height: 17, lineHeight: "17px", borderRadius: 2, fontSize: 11, textAlign: "right",
      background: now ? "var(--c1)" : was ? "var(--subtle)" : "transparent",
      color: now ? "var(--bg)" : was ? "var(--fg)" : "var(--muted)",
      outline: was && !now ? "1px solid var(--c1)" : undefined, outlineOffset: -1,
    };
  };
  const reset = (s?: Strategy) => { if (s) setStrategy(s); setAt(0); };
  return (
    <Demo
      title="SELECT id, price WHERE region = 'EU' AND qty > t"
      controls={
        <>
          <Param spec={range({ label: "Threshold t", min: 0, max: 50, step: 1, default: 25 })} value={threshold} onChange={(v) => setThreshold(v as number)} />
          <Param spec={seg<Strategy>("Plan", STRAT, "late")} value={strategy} onChange={(v) => reset(v as Strategy)} />
          <ButtonRow>
            <Btn onClick={() => setAt(Math.max(0, i - 1))} disabled={i === 0}>Back</Btn>
            <Btn onClick={() => setAt(Math.min(steps.length - 1, i + 1))} disabled={i === steps.length - 1}>Next step</Btn>
            <Btn ghost onClick={() => reset()}>Restart</Btn>
          </ButtonRow>
        </>
      }
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>Step {i + 1} of {steps.length}: {step.title}</div>
      <p style={{ fontSize: 12.5, margin: "2px 0 8px", minHeight: 34 }}>{step.detail}</p>
      <div style={{ display: "grid", gridTemplateColumns: `28px repeat(${COLS.length}, minmax(0, 1fr))`, gap: "1px 4px", ...mono }}>
        <span />
        {COLS.map((c) => <span key={c} style={{ fontSize: 11, fontWeight: 600, textAlign: "right", padding: "0 4px", color: step.touched[c] ? "var(--c1)" : "var(--muted)" }}>{c}</span>)}
        {Array.from({ length: STEPPER_ROWS }, (_, r) => (
          <div key={r} style={{ display: "contents" }}>
            <span style={{ fontSize: 10.5, textAlign: "right", lineHeight: "17px", color: pos.has(r) ? "var(--c3)" : "var(--faint)", fontWeight: pos.has(r) ? 700 : 400 }}>{r}</span>
            {COLS.map((c) => <span key={c} style={cell(c, r)}>{c === "price" ? (t[c][r] as number).toFixed(2) : String(t[c][r])}</span>)}
          </div>
        ))}
      </div>
      {step.bitmaps.length > 0 && (
        <>
          <Caption>Bitmaps, one bit per row</Caption>
          <div style={{ ...mono, fontSize: 11.5, display: "grid", gap: 2 }}>
            {step.bitmaps.map((b) => (
              <div key={b.name} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ minWidth: 92 }}>{b.name}</span>
                <span style={{ letterSpacing: 1.5, wordBreak: "break-all" }}>{b.bits.map((x) => (x ? "1" : "0")).join("")}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <Caption>{strategy === "early" ? "Surviving tuples (row numbers)" : "Position list passed to the next operator"}</Caption>
      <div style={{ ...mono, fontSize: 12, color: "var(--c3)", minHeight: 18 }}>{step.positions ? `[${step.positions.join(", ")}]` : "not built yet: the plan keeps bitmaps"}</div>
      {step.tuples.length > 0 && (
        <>
          <Caption>Row tuples in memory ({step.tupleCols.join(", ")})</Caption>
          <div style={{ ...mono, fontSize: 11, display: "flex", flexWrap: "wrap", gap: 4 }}>
            {step.tuples.map((x) => (
              <span key={x.row} style={{ border: "1px solid var(--border)", borderRadius: 3, padding: "0 4px", color: x.alive ? "var(--fg)" : "var(--faint)", textDecoration: x.alive ? undefined : "line-through" }}>
                ({x.values.map((v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(2) : v)).join(", ")})
              </span>
            ))}
          </div>
        </>
      )}
      <Stats
        items={[
          { label: "values read from columns", value: step.counters.read },
          { label: "values copied into tuples", value: step.counters.copied },
          { label: "predicate checks", value: step.counters.checks },
        ]}
      />
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: "read in this step", color: "var(--c1)" }, { label: "position in the current list", color: "var(--c3)" }]} />
      </div>
      <Caption>All three plans at t = {threshold}, after the last step</Caption>
      <MiniTable head={["plan", "read", "copied", "checks"]} highlight={STRAT.findIndex(([s]) => s === strategy)} rows={STRAT.map(([, l], k) => [l, all[k]!.read, all[k]!.copied, all[k]!.checks])} />
    </Demo>
  );
}

// ---------------- crossover ----------------

export function CrossoverDemo() {
  const [outputs, setOutputs] = useState(4);
  const [reaccess, setReaccess] = useState(false);
  const [compressed, setCompressed] = useState(false);
  const [logS, setLogS] = useState(-2);
  const p: CostParams = { outputs, reaccess, compressed };
  const s = Math.pow(10, logS);
  const e = earlyCost(p);
  const xs = useMemo(() => Array.from({ length: 121 }, (_, i) => Math.pow(10, -4 + (4 * i) / 120)), []);
  const late = xs.map((x) => [x, lateCost(p, x)] as [number, number]);
  const early = xs.map((x) => [x, e] as [number, number]);
  const cross = crossover(p);
  const ymax = Math.max(e, lateCost(p, 1)) * 1.1;
  const l = lateCost(p, s);
  return (
    <Demo
      title="Early vs late materialization as selectivity grows"
      controls={
        <>
          <Param spec={range({ label: "Selectivity (rows that pass)", min: -4, max: 0, step: 0.05, default: -2, format: (v) => `${fx(100 * Math.pow(10, v), Math.pow(10, v) < 0.01 ? 2 : 1)}%` })} value={logS} onChange={(v) => setLogS(v as number)} />
          <Param spec={range({ label: "Output columns", min: 1, max: 12, step: 1, default: 4 })} value={outputs} onChange={(v) => setOutputs(v as number)} />
          <Param spec={toggle({ label: "The predicate column is also an output", default: false })} value={reaccess} onChange={(v) => setReaccess(v as boolean)} />
          <Param spec={toggle({ label: "Predicate column is RLE-compressed (runs of 16)", default: false })} value={compressed} onChange={(v) => setCompressed(v as boolean)} />
        </>
      }
    >
      <Plot x={[1e-4, 1]} y={[0, ymax]} logX height={250} xLabel="selectivity" yLabel="cost per input row" xTicks={[1e-4, 1e-3, 1e-2, 1e-1, 1]} xFormat={(v) => (v >= 0.01 ? `${v * 100}%` : `${+(v * 100).toPrecision(1)}%`)}>
        <Line points={early} color="var(--c2)" />
        <Line points={late} color="var(--c1)" />
        {cross !== null && <RuleX at={cross} />}
        <Dots points={[[s, e], [s, l]]} color="var(--fg)" r={3} />
      </Plot>
      <Legend items={[{ label: "early: build every tuple first", color: "var(--c2)" }, { label: "late: positions first, values last", color: "var(--c1)" }]} />
      <Stats
        items={[
          { label: "early cost per row", value: fx(e, 2) },
          { label: "late cost per row", value: fx(l, 2) },
          { label: "late is", value: l < e ? `${fx(e / l, 1)}× cheaper` : `${fx(l / e, 2)}× dearer` },
          { label: "crossover", value: cross === null ? "none: late always wins" : `${fx(cross * 100, 1)}%` },
        ]}
      />
      <Note>Units: one value operation costs 1, one cache-line miss costs 4, a gather by position costs 2. Late pays per surviving row; early pays for every row.</Note>
    </Demo>
  );
}
