/** Demos for external sorting and aggregation: a sort stepper, passes vs memory, replacement selection, sort vs hash aggregation. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Plot, Line, Dots, RuleX, Legend, range, select, toggle, si, bytes, BAD, GOOD, MONO, Note, StepButtons, StepCaption, StepSlider, int, useStepper } from "../../kit";
import {
  externalSort, sortPasses, sortPassesWithRuns, sortPassesFormula, replacementSelection, sortInput, hashAggIO, sortAggIO, hashAggregate, twoPassBuffer, type InputOrder,
} from "../../sims/db/query/extsort";
import { uniformKeys } from "../../sims/db/query/joins";
import { ACC, ALT, WARM, useLater } from "./QueryUi";

// ============================================================================ 1. external sort stepper

const RUN_COLORS = [ACC, WARM, GOOD, ALT, BAD, "var(--muted)"];

function PageBox({ items, color, faint, dashed, hot }: { items: number[]; color: string; faint?: boolean; dashed?: boolean; hot?: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 2, padding: 2, borderRadius: 4, border: `1.5px ${dashed ? "dashed" : "solid"} ${color}`, opacity: faint ? 0.3 : 1, minWidth: 20, minHeight: 20, transition: "opacity 0.2s" }}>
      {items.map((x, i) => (
        <span key={i} style={{ fontFamily: MONO, fontSize: 11, minWidth: 17, textAlign: "center", borderRadius: 2, background: x === hot ? color : undefined, color: x === hot ? "var(--bg)" : "var(--fg)" }}>{x}</span>
      ))}
    </span>
  );
}

export function ExternalSortDemo() {
  const [B, setB] = useState(3);
  const keys = useMemo(() => uniformKeys(36, 99, 21).map((k) => k + 1), []);
  const input = useMemo(() => { const p: number[][] = []; for (let i = 0; i < keys.length; i += 3) p.push(keys.slice(i, i + 3)); return p; }, [keys]);
  const res = useMemo(() => externalSort(input, B, (x) => x, true), [input, B]);
  const s = useStepper(res.frames.length, 5);
  const f = res.frames[s.i]!;
  const N = input.length;
  return (
    <Demo
      title={`External merge sort: ${N} pages, B = ${B} frames`}
      actions={<StepButtons s={s} />}
      controls={
        <>
          <StepSlider s={s} label="Step" />
          <Param spec={range({ label: "Buffer frames B", min: 3, max: 6, step: 1, default: 3 })} value={B} onChange={(v) => { setB(v as number); s.reset(); }} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Disk: input ({f.inputLeft} pages left to read in pass 0)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        {input.map((p, i) => <PageBox key={i} items={p} color="var(--border)" faint={i < N - f.inputLeft} />)}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Memory: {B} frames</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${B}, minmax(0, 1fr))`, gap: 6, marginBottom: 8 }}>
        {f.mem.map((m, i) => {
          const col = m.role === "output" ? GOOD : m.role === "input" ? RUN_COLORS[((m.run ?? 1) - 1) % RUN_COLORS.length]! : m.role === "load" ? ACC : "var(--border)";
          return (
            <div key={i} style={{ border: `1.5px solid ${col}`, borderRadius: 6, padding: 4, minHeight: 46, background: "var(--subtle)" }}>
              <div style={{ fontSize: 10.5, color: col, fontWeight: 600 }}>{m.role === "output" ? "output" : m.role === "input" ? `input: run ${m.run}` : m.role === "load" ? "sort area" : "free"}</div>
              <div style={{ fontFamily: MONO, fontSize: 12, display: "flex", flexWrap: "wrap", gap: 3 }}>{m.items.map((x, j) => <span key={j} style={{ fontWeight: x === f.moved ? 800 : 400, color: x === f.moved ? col : undefined }}>{x}</span>)}</div>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Disk: runs</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minHeight: 60 }}>
        {f.runs.length === 0 && <span className="muted" style={{ fontSize: 12 }}>none yet</span>}
        {f.runs.map((r, i) => {
          const col = RUN_COLORS[i % RUN_COLORS.length]!;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, width: 64, flexShrink: 0, color: r.pass === f.pass && f.pass > 0 ? GOOD : "var(--muted)" }}>{r.pass === f.pass && f.pass > 0 ? `new run ${i + 1 - f.runs.filter((x) => x.pass < f.pass).length}` : `run ${i + 1}`}</span>
              {r.pages.map((p, j) => <PageBox key={j} items={p} color={r.pass === f.pass && f.pass > 0 ? GOOD : col} faint={r.pass < f.pass && j < r.read} />)}
            </div>
          );
        })}
      </div>
      <StepCaption label={`${s.i + 1}/${res.frames.length}`}>{f.text}</StepCaption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "page reads", value: f.reads },
        { label: "page writes", value: f.writes },
        { label: "runs after pass 0", value: res.runsAfterPass0 },
        { label: "passes in total", value: res.passes },
        { label: `2N × passes = 2 × ${N} × ${res.passes}`, value: 2 * N * res.passes },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. passes vs memory

const PASS_SCHEMA = {
  n: range({ label: "Data size N (8 KiB pages)", min: 1e3, max: 1e9, log: true, default: 1e6, format: (v) => `${si(Math.round(v))} (${bytes(Math.round(v) * 8192)})` }),
  b: range({ label: "Memory B (frames)", min: 3, max: 1e6, log: true, default: 512, format: (v) => `${int(v)} (${bytes(Math.round(v) * 8192)})` }),
  rs: toggle({ label: "Replacement selection: runs of 2B pages", default: false }),
};

export function SortPassesDemo() {
  const [v, setV] = useState({ n: 1e6, b: 512, rs: false });
  const n = Math.round(v.n), b = Math.round(v.b);
  const xs = useMemo(() => Array.from({ length: 241 }, (_, i) => Math.round(3 * Math.pow(1e6 / 3, i / 240))), []);
  const passes = (nn: number, bb: number) => (v.rs ? sortPassesWithRuns(nn, bb, 2 * bb) : sortPasses(nn, bb));
  const sizes = [{ n: 1e3, c: "var(--muted)" }, { n: 1e6, c: ALT }, { n: 1e9, c: WARM }];
  const p = passes(n, b);
  return (
    <Demo
      title="Passes of external merge sort"
      controls={
        <>
          <Param spec={PASS_SCHEMA.n} value={v.n} onChange={(x) => setV({ ...v, n: x as number })} />
          <Param spec={PASS_SCHEMA.b} value={v.b} onChange={(x) => setV({ ...v, b: x as number })} />
          <Param spec={PASS_SCHEMA.rs} value={v.rs} onChange={(x) => setV({ ...v, rs: x as boolean })} />
        </>
      }
    >
      <Plot x={[3, 1e6]} y={[0, 22]} logX height={240} xLabel="memory B (frames)" yLabel="passes" xTicks={[3, 10, 100, 1e3, 1e4, 1e5, 1e6]} xFormat={(x) => si(x)} yTicks={[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]}>
        {sizes.map((z) => <Line key={z.n} points={xs.map((x) => [x, passes(z.n, x)] as const)} color={z.c} width={1.4} dash="4 3" />)}
        <Line points={xs.map((x) => [x, passes(n, x)] as const)} color={ACC} width={2.6} />
        <Dots points={[[b, p]]} color={BAD} r={5} />
        <RuleX at={b} />
      </Plot>
      <Legend items={[{ label: `your N = ${si(n)} pages`, color: ACC }, ...sizes.map((z) => ({ label: `N = ${si(z.n)} pages`, color: z.c }))]} />
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "runs after pass 0", value: int(Math.ceil(n / (v.rs ? 2 * b : b))) },
        { label: "passes", value: p },
        { label: "page I/Os = 2N × passes", value: si(2 * n * p) },
        { label: "B for 2 passes (B(B−1) ≥ N)", value: `${int(twoPassBuffer(n))} (${bytes(twoPassBuffer(n) * 8192)})` },
      ]} />
      <Note>Each pass reads and writes all N pages. Formula: passes = 1 + ⌈log<sub>B−1</sub>⌈N / B⌉⌉ = {sortPassesFormula(n, b)} for load-and-sort runs. The default memory, 512 frames of 8 KiB, is 4 MiB: the PostgreSQL default work_mem.</Note>
    </Demo>
  );
}

// ============================================================================ 3. replacement selection

const RS_ORDERS: { value: InputOrder; label: string }[] = [
  { value: "random", label: "random" },
  { value: "nearly", label: "nearly sorted" },
  { value: "sorted", label: "sorted" },
  { value: "reverse", label: "reverse" },
];

export function ReplacementSelectionDemo() {
  const [m, setM] = useState(6);
  const [order, setOrder] = useState<InputOrder>("random");
  const keys = useMemo(() => sortInput(48, order, 4).map((x) => x + 1), [order]);
  const run = useMemo(() => replacementSelection(keys, m, true), [keys, m]);
  const big = useLater(() => {
    const r = replacementSelection(sortInput(100_000, order, 9), 1000);
    return { order, runs: r.runs.length, mean: 100_000 / r.runs.length };
  }, [order]);
  const s = useStepper(run.frames.length + 1, 4);
  const f = s.i > 0 ? run.frames[s.i - 1]! : null;
  const outRuns = useMemo(() => {
    const done: number[][] = [];
    for (let i = 0; i < s.i; i++) { const fr = run.frames[i]!; done[fr.run] = fr.out; }
    return done;
  }, [run, s.i]);
  const curRun = f?.run ?? 0;
  return (
    <Demo
      title="Replacement selection: runs longer than memory"
      actions={<StepButtons s={s} />}
      controls={
        <>
          <StepSlider s={s} label="Output key" />
          <Param spec={range({ label: "Memory M (records)", min: 3, max: 12, step: 1, default: 6 })} value={m} onChange={(v) => { setM(v as number); s.reset(); }} />
          <Param spec={select({ label: "Input order", options: RS_ORDERS, default: "random", segmented: true })} value={order} onChange={(v) => { setOrder(v as InputOrder); s.reset(); }} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Heap in memory ({m} records). Solid: current run. Dashed: waits for the next run.</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 26, marginBottom: 8 }}>
        {(f ? f.heap : keys.slice(0, m).map((k) => ({ key: k, run: 0 })).sort((a, b) => a.key - b.key)).map((h, i) => (
          <span key={i} style={{ fontFamily: MONO, fontSize: 12, padding: "1px 6px", borderRadius: 4, border: `1.5px ${h.run > curRun ? "dashed" : "solid"} ${RUN_COLORS[h.run % RUN_COLORS.length]}`, color: RUN_COLORS[h.run % RUN_COLORS.length], fontWeight: i === 0 && h.run === curRun ? 800 : 400 }}>{h.key}</span>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Runs written</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minHeight: 50 }}>
        {outRuns.map((r, i) => r && (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: RUN_COLORS[i % RUN_COLORS.length], width: 76, flexShrink: 0 }}>run {i + 1}: {r.length} keys</span>
            <span style={{ fontFamily: MONO, fontSize: 11.5, wordBreak: "break-all" }}>{r.join(" ")}</span>
          </div>
        ))}
      </div>
      <StepCaption label={`${s.i}/${run.frames.length}`}>{f ? f.text : `Fill the heap with the first ${m} keys, then repeat: write the smallest key that can still go into the current run.`}</StepCaption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "runs for these 48 keys", value: run.runs.length },
        { label: "load-and-sort runs (48 / M)", value: Math.ceil(48 / m) },
        { label: `mean run length, 100,000 ${order} keys, M = 1,000`, value: big && big.order === order ? `${int(big.mean)} (${(big.mean / 1000).toFixed(2)} M)` : "…" },
      ]} />
    </Demo>
  );
}

// ============================================================================ 4. sort vs hash aggregation

const AGG = { rows: 50_000, perPage: 50, B: 100, cap: 5_000 };

export function AggregationDemo() {
  const [g, setG] = useState(20_000);
  const G = Math.round(g);
  const N = AGG.rows / AGG.perPage;
  const xs = useMemo(() => Array.from({ length: 121 }, (_, i) => Math.round(100 * Math.pow(500, i / 120))), []);
  const exec = useLater(() => [200, 1000, 5000, 10000, 20000, 50000].map((gg) => {
    const r = hashAggregate(uniformKeys(AGG.rows, gg, 5), AGG.cap, AGG.perPage, 32);
    return [gg, N + r.spillWrites + r.spillReads] as const;
  }), [N]);
  const mine = useMemo(() => {
    const keys = uniformKeys(AGG.rows, G, 5);
    return hashAggregate(keys, AGG.cap, AGG.perPage, 32);
  }, [G]);
  return (
    <Demo
      title="GROUP BY: hash aggregation against sort aggregation"
      controls={<Param spec={range({ label: "Distinct groups G", min: 100, max: 50000, log: true, default: 20000, format: (v) => int(v) })} value={g} onChange={(v) => setG(v as number)} />}
    >
      <Plot x={[100, 50000]} y={[0, 3400]} logX height={230} xLabel="distinct groups G" yLabel="page I/Os" xTicks={[100, 1000, 10000, 50000]} xFormat={(x) => si(x)}>
        <Line points={xs.map((x) => [x, sortAggIO(N, AGG.B)] as const)} color={WARM} width={2.2} />
        <Line points={xs.map((x) => [x, hashAggIO(N, x, AGG.cap)] as const)} color={ACC} width={2.2} />
        {exec && <Dots points={exec} color={ACC} r={3.5} />}
        <RuleX at={AGG.cap} label="groups that fit" />
        <RuleX at={G} color={BAD} />
      </Plot>
      <Legend items={[{ label: "sort aggregation (formula)", color: WARM }, { label: "hash aggregation (formula; dots: executed sim)", color: ACC }]} />
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "groups", value: int(mine.groups.size) },
        { label: "rows written to partitions", value: int(mine.spilledRows) },
        { label: "hash aggregation page I/Os", value: int(N + mine.spillWrites + mine.spillReads) },
        { label: "sort aggregation page I/Os", value: int(sortAggIO(N, AGG.B)) },
      ]} />
      <Note>Model: {int(AGG.rows)} rows in {int(N)} pages, B = {AGG.B} frames. The hash table holds {int(AGG.cap)} groups. Sort aggregation sorts with {sortPasses(N, AGG.B)} passes and aggregates in the last merge. Hash aggregation keeps aggregating the groups it holds; rows of new groups go to 32 partitions on disk.</Note>
    </Demo>
  );
}
