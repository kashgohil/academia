/** Demos for "Cardinality estimation": histogram builder, correlated columns, error growth through joins. */
import { useMemo } from "react";
import { Demo, Param, Plot, Line, Bars, RuleX, RuleY, Legend, Stats, range, toggle, useParams, usePlot, Note, SectionLabel, fixed, int, mono, seg, useChunked } from "../../kit";
import {
  skewedColumn, valueCounts, dataQueries, buildStats, estimateRange, trueRange, histErrors, qError,
  correlatedReport, MODE_LABEL, qErrorCurve, errorSamples, type EstMode,
} from "../../sims/db/optimizer";
import { Code, num, once, LogBar, logTicks } from "./OptimizerUi";

const column = () => once("opt-skewed", () => { const c = skewedColumn(); return { col: c, counts: valueCounts(c), queries: dataQueries(c) }; });

function Shade({ lo, hi }: { lo: number; hi: number }) {
  const { x, h } = usePlot();
  return <rect x={x(lo)} y={0} width={Math.max(1, x(hi) - x(lo))} height={h} fill="var(--c1)" opacity={0.1} />;
}

const SWEEP = [2, 4, 6, 8, 10, 15, 20, 30, 40, 60, 80, 100];

export function HistogramDemo() {
  const p = useParams("hist", {
    buckets: range({ label: "Buckets (statistics target)", min: 2, max: 100, step: 1, default: 20 }),
    kind: seg<"width" | "depth">("Histogram", [["width", "equi-width"], ["depth", "equi-depth"]], "depth"),
    mcv: toggle({ label: "Keep a most-common-values list (as many values as buckets)", default: false }),
    sample: seg("Built from", [["100000", "all 100,000 rows"], ["30000", "30,000-row sample"], ["3000", "3,000-row sample"]], "30000"),
    lo: range({ label: "Predicate: amount ≥", min: 0, max: 999, step: 1, default: 10 }),
    hi: range({ label: "Predicate: amount ≤", min: 0, max: 999, step: 1, default: 19 }),
    view: seg("View", [["200", "values 0–199"], ["1000", "values 0–999"]], "200"),
  });
  const v = p.values;
  const { col, counts, queries } = column();
  const lo = Math.min(v.lo, v.hi), hi = Math.max(v.lo, v.hi);
  const setup = { kind: v.kind, buckets: v.buckets, mcv: v.mcv, sample: Number(v.sample) };
  const h = useMemo(() => buildStats(col, setup), [v.kind, v.buckets, v.mcv, v.sample]); // eslint-disable-line react-hooks/exhaustive-deps
  const est = estimateRange(h, lo, hi), truth = trueRange(counts, lo, hi);
  const errs = useMemo(() => histErrors(h, counts, queries), [h, counts, queries]);
  const view = Number(v.view);
  const { trueBars, estLine, yMax } = useMemo(() => {
    const tb = [], el: [number, number][] = [];
    let m = 0;
    for (let x = 0; x < view; x++) {
      tb.push({ x0: x, x1: x + 1, y: counts[x]! });
      const e = estimateRange(h, x, x);
      el.push([x, e], [x + 1, e]);
      m = Math.max(m, counts[x]!, e);
    }
    return { trueBars: tb, estLine: el, yMax: m * 1.08 };
  }, [h, counts, view]);
  const jobs = useMemo(() => (["width", "depth"] as const).flatMap((kind) => SWEEP.map((b) => () => histErrors(buildStats(col, { ...setup, kind, buckets: b }), counts, queries).median)), [v.mcv, v.sample]); // eslint-disable-line react-hooks/exhaustive-deps
  const sweep = useChunked(`hist:${v.mcv}:${v.sample}`, jobs, { keep: true });
  const line = (k: number) => SWEEP.map((b, i) => [b, sweep[k * SWEEP.length + i]] as const).filter((x): x is readonly [number, number] => x[1] !== undefined);
  const q = qError(est, truth);
  return (
    <Demo
      title={`SELECT count(*) FROM orders WHERE amount BETWEEN ${lo} AND ${hi}`}
      controls={<>
        <Param spec={p.schema.buckets} value={v.buckets} onChange={(x) => p.set("buckets", x as number)} />
        <Param spec={p.schema.kind} value={v.kind} onChange={(x) => p.set("kind", x as "width" | "depth")} />
        <Param spec={p.schema.mcv} value={v.mcv} onChange={(x) => p.set("mcv", x as boolean)} />
        <Param spec={p.schema.sample} value={v.sample} onChange={(x) => p.set("sample", x as string)} />
        <Param spec={p.schema.lo} value={v.lo} onChange={(x) => p.set("lo", x as number)} />
        <Param spec={p.schema.hi} value={v.hi} onChange={(x) => p.set("hi", x as number)} />
        <Param spec={p.schema.view} value={v.view} onChange={(x) => p.set("view", x as string)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", alignItems: "baseline" }}>
        <span>true <b style={mono}>{int(truth)}</b> rows</span>
        <span>estimate <b style={{ ...mono, color: "var(--c1)" }}>{int(est)}</b> rows</span>
        <span>q-error <b style={{ ...mono, color: q > 2 ? "var(--c4)" : "var(--fg)" }}>{fixed(q, 2)}</b></span>
      </div>
      <Plot x={[0, view]} y={[0, yMax]} height={220} xLabel="amount" yLabel="rows per value">
        <Shade lo={lo} hi={hi + 1} />
        <Bars bins={trueBars} color="var(--faint)" opacity={0.9} />
        <Line points={estLine} color="var(--c1)" width={1.6} />
        {h.kind === "depth" && h.bounds.filter((b) => b < view).map((b, i) => <RuleX key={i} at={b} color="var(--c2)" dash="1 3" />)}
      </Plot>
      <Legend items={[{ label: "true rows per value", color: "var(--faint)" }, { label: "what the statistics say", color: "var(--c1)" }, ...(h.kind === "depth" ? [{ label: "bucket bounds", color: "var(--c2)" }] : [])]} />
      <Stats items={[
        { label: "300 range queries: median q-error", value: fixed(errs.median, 2) },
        { label: "90th percentile", value: fixed(errs.p90, 2) },
        { label: "worst", value: fixed(errs.max, 1) },
        { label: "MCV values · their share", value: `${h.mcv.length} · ${fixed((1 - h.histFrac) * 100, 1)}%` },
      ]} />
      <SectionLabel>Median q-error against the number of buckets (same MCV and sample setting)</SectionLabel>
      <Plot x={[2, 100]} y={[1, 3]} logX height={170} xLabel="buckets" yLabel="median q-error" xTicks={[2, 5, 10, 20, 50, 100]}>
        <Line points={line(0)} color="var(--c3)" />
        <Line points={line(1)} color="var(--c1)" />
        <RuleX at={v.buckets} />
      </Plot>
      <Legend items={[{ label: "equi-width", color: "var(--c3)" }, { label: "equi-depth", color: "var(--c1)" }]} />
      <Note>The column: 100,000 order amounts, a long-tailed body plus price points at 0, 99, 199 and 499. The test queries are 300 ranges centred on values that occur in the data.</Note>
    </Demo>
  );
}

// ---------------- correlated columns ----------------

const MODES: EstMode[] = ["indep", "deps", "mcv"];
const SHORT: Record<EstMode, string> = { indep: "per-column", deps: "+ deps", mcv: "+ mcv" };

function EstCell({ est, truth }: { est: number; truth: number }) {
  const q = qError(est, truth);
  const color = q >= 10 ? "var(--c4)" : q >= 2 ? "var(--c5)" : "var(--c3)";
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ ...mono, fontSize: 13 }}>{int(Math.max(0, est))} <span style={{ color, fontSize: 11.5 }}>{q < 1.005 ? "exact" : `${est > truth ? "↑" : "↓"}${fixed(q, q < 10 ? 1 : 0)}×`}</span></div>
      <LogBar value={Math.max(1, est)} lo={1} hi={1e5} color={color} height={7} />
    </div>
  );
}

export function CorrelatedDemo() {
  const p = useParams("corr", {
    zpc: range({ label: "Zip codes per city", min: 1, max: 60, step: 1, default: 5 }),
    cities: range({ label: "Cities", min: 2, max: 50, step: 1, default: 20 }),
    noise: range({ label: "Rows with a wrong city (dirty data)", min: 0, max: 0.2, step: 0.01, default: 0, format: (x) => `${Math.round(x * 100)}%` }),
    target: seg("MCV list size (statistics target)", [["10", "10"], ["100", "100"], ["1000", "1,000"]], "100"),
  });
  const v = p.values;
  const rep = useMemo(() => correlatedReport({ rows: 100000, cities: v.cities, zipsPerCity: v.zpc, noise: v.noise }, Number(v.target)), [v.zpc, v.cities, v.noise, v.target]);
  const rows = [
    { q: `city = '${rep.match.city}' AND zip = '${rep.match.zip}'`, r: rep.match },
    ...(rep.mismatch ? [{ q: `city = '${rep.mismatch.city}' AND zip = '${rep.mismatch.zip}'`, r: rep.mismatch }] : []),
  ];
  return (
    <Demo
      title="addresses: 100,000 rows; each zip code belongs to one city"
      controls={<>
        <Param spec={p.schema.zpc} value={v.zpc} onChange={(x) => p.set("zpc", x as number)} />
        <Param spec={p.schema.cities} value={v.cities} onChange={(x) => p.set("cities", x as number)} />
        <Param spec={p.schema.noise} value={v.noise} onChange={(x) => p.set("noise", x as number)} />
        <Param spec={p.schema.target} value={v.target} onChange={(x) => p.set("target", x as string)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) repeat(4, minmax(0, 1fr))", gap: "8px 10px", fontSize: 12.5, alignItems: "end" }}>
        <span className="muted">WHERE …</span>
        <b>true rows</b>
        {MODES.map((m) => <b key={m} title={MODE_LABEL[m]}>{SHORT[m]}</b>)}
        {rows.map(({ q, r }) => (
          <div key={q} style={{ display: "contents" }}>
            <span style={{ ...mono, fontSize: 11.5, overflowWrap: "anywhere" }}>{q}</span>
            <span style={{ ...mono, fontSize: 13 }}>{int(r.truth)}</span>
            {MODES.map((m) => <EstCell key={m} est={r.est[m]} truth={r.truth} />)}
          </div>
        ))}
        <span style={{ ...mono, fontSize: 11.5 }}>GROUP BY city, zip (groups)</span>
        <span style={{ ...mono, fontSize: 13 }}>{int(rep.groups.truth)}</span>
        <EstCell est={rep.groups.indep} truth={rep.groups.truth} />
        <span className="muted" style={{ fontSize: 11.5 }}>(no effect)</span>
        <div><span className="muted" style={{ fontSize: 11 }}>ndistinct:</span><EstCell est={rep.groups.ndistinct} truth={rep.groups.truth} /></div>
      </div>
      <Stats items={[
        { label: "dependency degree zip ⇒ city", value: fixed(rep.degree, 3) },
        { label: "distinct (city, zip) pairs", value: int(rep.pairs) },
        { label: "MCV items · rows they cover", value: `${rep.mcvItems} · ${fixed(rep.mcvTotal * 100, 1)}%` },
        { label: "per-column: P(city) × P(zip)", value: `1/${v.cities} × 1/${v.cities * v.zpc}` },
      ]} />
      <SectionLabel>The fix in PostgreSQL 14 and later</SectionLabel>
      <Code>{`CREATE STATISTICS addr_geo (dependencies, ndistinct, mcv) ON city, zip FROM addresses;\nALTER STATISTICS addr_geo SET STATISTICS ${v.target};\nANALYZE addresses;`}</Code>
      <Note>"+ deps" adds dependencies statistics; "+ mcv" adds a multi-column MCV list. "↓20×" means the estimate is 20 times too small. The bars use a log scale from 1 to 100,000 rows. A true count of 0 is compared as 1 row, as the planner never estimates fewer than 1 row.</Note>
    </Demo>
  );
}

// ---------------- error growth ----------------

export function ErrorGrowthDemo() {
  const p = useParams("qerr", {
    sigma: range({ label: "Spread of each estimate's error (σ of ln error)", min: 0.05, max: 1.5, step: 0.05, default: 0.5, format: (x) => `${x.toFixed(2)} (×${Math.exp(x).toFixed(2)})` }),
    bias: range({ label: "Bias of each estimate (mean ln error; < 0 is under)", min: -1, max: 1, step: 0.05, default: -0.2, format: (x) => x.toFixed(2) }),
    joins: range({ label: "Joins in the query", min: 0, max: 10, step: 1, default: 5 }),
  });
  const v = p.values;
  const curve = useMemo(() => qErrorCurve(10, { sigma: v.sigma, bias: v.bias }), [v.sigma, v.bias]);
  const hist = useMemo(() => {
    const xs = errorSamples(v.joins, { sigma: v.sigma, bias: v.bias });
    const lo = -6, hi = 6, w = 0.25, bins = Array.from({ length: (hi - lo) / w }, (_, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, y: 0 }));
    for (const x of xs) { const l = x / Math.LN10; const i = Math.floor((Math.max(lo, Math.min(hi - 1e-9, l)) - lo) / w); bins[i]!.y++; }
    return bins;
  }, [v.joins, v.sigma, v.bias]);
  const at = curve[v.joins]!;
  const pts = (k: "median" | "p90" | "p99") => curve.map((r) => [r.joins, r[k]] as const);
  const yTop = Math.max(10, curve[10]!.p99 * 1.5);
  return (
    <Demo
      title="Each base table and each join adds one estimate; their errors multiply"
      controls={<>
        <Param spec={p.schema.sigma} value={v.sigma} onChange={(x) => p.set("sigma", x as number)} />
        <Param spec={p.schema.bias} value={v.bias} onChange={(x) => p.set("bias", x as number)} />
        <Param spec={p.schema.joins} value={v.joins} onChange={(x) => p.set("joins", x as number)} />
      </>}
    >
      <Plot x={[0, 10]} y={[1, yTop]} logY height={220} xLabel="joins" yLabel="q-error of the final estimate" yTicks={logTicks(1, yTop)} yFormat={(y) => num(y, 1)}>
        <Line points={pts("p99")} color="var(--c4)" />
        <Line points={pts("p90")} color="var(--c5)" />
        <Line points={pts("median")} color="var(--c1)" />
        <RuleX at={v.joins} />
        <RuleY at={10} label="10×" />
      </Plot>
      <Legend items={[{ label: "median", color: "var(--c1)" }, { label: "90th percentile", color: "var(--c5)" }, { label: "99th percentile", color: "var(--c4)" }]} />
      <SectionLabel>2,000 queries with {v.joins} join{v.joins === 1 ? "" : "s"}: log₁₀(estimate / true)</SectionLabel>
      <Plot x={[-6, 6]} y={[0, Math.max(...hist.map((b) => b.y)) * 1.1]} height={150} xLabel="log₁₀(estimate / true)" xFormat={(x) => (x === 0 ? "exact" : x < 0 ? `÷10^${-x}` : `×10^${x}`)} xTicks={[-6, -4, -2, 0, 2, 4, 6]}>
        <Bars bins={hist} color="var(--c2)" />
        <RuleX at={0} color="var(--fg)" />
      </Plot>
      <Stats items={[
        { label: "estimates in the product", value: 2 * v.joins + 1 },
        { label: "median q-error", value: fixed(at.median, 1) },
        { label: "90th percentile", value: num(at.p90, 3) },
        { label: "under-estimates", value: `${Math.round(at.under * 100)}%` },
      ]} />
      <Note>Model: each of the {2 * v.joins + 1} estimates (one per base table, one per join predicate) is off by a log-normal factor. The log errors add, so their spread grows with the square root of the count and any bias grows linearly.</Note>
    </Demo>
  );
}
