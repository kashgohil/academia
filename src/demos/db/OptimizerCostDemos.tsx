/** Demos for "Cost models": an access-path calculator, plan flips, and join methods vs outer rows. */
import { useMemo } from "react";
import { Demo, Param, Plot, Line, RuleX, RuleY, Dots, Legend, Stats, range, toggle, useParams, usePlot, pct, Note, SectionLabel, fixed, int, mono, seg, Tex } from "../../kit";
import {
  PG_DEFAULTS, TENK1, TENK1_UNIQUE1, EVENTS, EVENTS_TS, accessPaths, planFlips, limitedCost, PATH_LABEL, joinMethods, joinCrossover, JOIN_LABEL,
  type AccessPath, type CostParams, type PathCost, type JoinMethod,
} from "../../sims/db/optimizer";
import { num, logTicks, PATH_COLOR } from "./OptimizerUi";

const TABLES = {
  tenk1: { t: TENK1, idx: TENK1_UNIQUE1, pred: (n: number) => `unique1 < ${int(n)}` },
  events: { t: EVENTS, idx: EVENTS_TS, pred: (n: number) => `ts < t0  -- matches ${int(n)} rows` },
};
type TableId = keyof typeof TABLES;
const ECS: [string, string][] = [["16384", "128 MB"], ["524288", "4 GB"], ["8388608", "64 GB"]];
const PATHS: AccessPath[] = ["seq", "index", "bitmap"];

function PathCard({ id, c, best, limit }: { id: AccessPath; c: PathCost; best: boolean; limit?: number }) {
  const startup = c.terms.filter((t) => t.phase === "startup");
  const run = c.terms.filter((t) => t.phase === "run");
  const row = (t: PathCost["terms"][number], i: number) => (
    <div key={i} style={{ display: "contents" }}>
      <span className="muted" style={{ fontSize: 12 }}>{t.label}</span>
      <span style={{ ...mono, fontSize: 11.5, overflowWrap: "anywhere" }}>{t.expr}</span>
      <span style={{ ...mono, fontSize: 12, textAlign: "right" }}>{fixed(t.value, 2)}</span>
    </div>
  );
  return (
    <div style={{ border: `1px solid ${best ? PATH_COLOR[id] : "var(--border)"}`, boxShadow: best ? `inset 4px 0 0 ${PATH_COLOR[id]}` : undefined, borderRadius: 6, padding: "8px 10px 8px 12px", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <b style={{ color: PATH_COLOR[id] }}>{PATH_LABEL[id]}{best ? "  ✓ cheapest" : ""}</b>
        <span style={{ ...mono, fontSize: 12.5 }}>cost={fixed(c.startup)}..{fixed(c.total)} rows={c.rows}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1.6fr) auto", gap: "2px 10px", marginTop: 6, alignItems: "baseline" }}>
        {startup.length > 0 && <span style={{ gridColumn: "1 / -1", fontSize: 11, fontWeight: 600 }} className="muted">startup (before the first row)</span>}
        {startup.map(row)}
        <span style={{ gridColumn: "1 / -1", fontSize: 11, fontWeight: 600 }} className="muted">run (to the last row)</span>
        {run.map(row)}
      </div>
      {limit !== undefined && <div style={{ fontSize: 12.5, marginTop: 6 }}>first {limit} row{limit > 1 ? "s" : ""}: {fixed(c.startup)} + ({fixed(c.total)} − {fixed(c.startup)}) × {limit}/{c.rows} = <b style={mono}>{fixed(limitedCost(c, limit))}</b></div>}
    </div>
  );
}

export function CostCalculatorDemo() {
  const p = useParams("costcalc", {
    sel: range({ label: "Selectivity of the predicate", min: 0.00001, max: 1, default: 0.01, log: true, format: (v) => pct(v, v < 0.001 ? 3 : v < 0.1 ? 2 : 1) }),
    table: seg<TableId>("Table", [["tenk1", "tenk1 (10,000 rows)"], ["events", "events (100 M rows)"]], "tenk1"),
    rpc: range({ label: "random_page_cost", min: 1, max: 8, step: 0.1, default: 4, format: (v) => v.toFixed(1) }),
    corr: range({ label: "Index correlation", min: 0, max: 1, step: 0.05, default: 0, format: (v) => v.toFixed(2) }),
    ecs: seg("effective_cache_size", ECS, "524288"),
    limit: seg("LIMIT", [["0", "none"], ["1", "1"], ["10", "10"], ["100", "100"]], "0"),
  });
  const v = p.values;
  const T = TABLES[v.table];
  const cp: CostParams = { ...PG_DEFAULTS, randomPageCost: v.rpc, effectiveCacheSize: Number(v.ecs) };
  const idx = { ...T.idx, correlation: v.corr };
  const limit = v.limit === "0" ? undefined : Number(v.limit);
  const { paths, best } = accessPaths(T.t, idx, v.sel, cp, limit);
  const rows = Math.max(1, Math.round(v.sel * T.t.rows));
  const w = paths[best];
  const explain = `${best === "index" ? `Index Scan using ${idx.name} on ${T.t.name}` : `${PATH_LABEL[best]} on ${T.t.name}`}  (cost=${fixed(w.startup)}..${fixed(w.total)} rows=${w.rows} width=${T.t.width})`;
  return (
    <Demo
      title={`SELECT * FROM ${T.t.name} WHERE ${T.pred(rows)}`}
      controls={<>
        <Param spec={p.schema.sel} value={v.sel} onChange={(x) => p.set("sel", x as number)} />
        <Param spec={p.schema.table} value={v.table} onChange={(x) => p.set("table", x as TableId)} />
        <Param spec={p.schema.rpc} value={v.rpc} onChange={(x) => p.set("rpc", x as number)} />
        <Param spec={p.schema.corr} value={v.corr} onChange={(x) => p.set("corr", x as number)} />
        <Param spec={p.schema.ecs} value={v.ecs} onChange={(x) => p.set("ecs", x as string)} />
        <Param spec={p.schema.limit} value={v.limit} onChange={(x) => p.set("limit", x as string)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        {T.t.name}: {int(T.t.rows)} rows in {int(T.t.pages)} pages · index {idx.name}: {int(idx.pages)} pages, height {idx.height}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {PATHS.map((k) => <PathCard key={k} id={k} c={paths[k]} best={k === best} limit={limit} />)}
      </div>
      <SectionLabel>The planner keeps the cheapest path</SectionLabel>
      <pre style={{ ...mono, fontSize: 11.5, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{explain}</pre>
      <Note>Formulas from PostgreSQL's costsize.c and btcostestimate(). The index part charges random_page_cost per leaf page; the heap part interpolates between random fetches and an in-order read with <Tex>{"\\text{correlation}^2"}</Tex>.</Note>
    </Demo>
  );
}

// ---------------- plan flips ----------------

/** Colored cells for a plan diagram, drawn in data coordinates. */
function Cells({ cells }: { cells: { x0: number; x1: number; y0: number; y1: number; path: AccessPath }[] }) {
  const { x, y } = usePlot();
  return (
    <g>
      {cells.map((c, i) => (
        <rect key={i} x={x(c.x0)} y={y(c.y1)} width={Math.max(0, x(c.x1) - x(c.x0))} height={Math.max(0, y(c.y0) - y(c.y1))} fill={PATH_COLOR[c.path]} opacity={0.5} shapeRendering="crispEdges" />
      ))}
    </g>
  );
}

const SEL_LO = 1e-5;

export function PlanFlipDemo() {
  const p = useParams("flips", {
    corr: range({ label: "Index correlation", min: 0, max: 1, step: 0.05, default: 0, format: (v) => v.toFixed(2) }),
    rpc: range({ label: "random_page_cost (line in the diagram)", min: 1, max: 8, step: 0.1, default: 4, format: (v) => v.toFixed(1) }),
    table: seg<TableId>("Table", [["tenk1", "tenk1"], ["events", "events"]], "tenk1"),
    ecs: seg("effective_cache_size", ECS, "524288"),
  });
  const v = p.values;
  const T = TABLES[v.table];
  const idx = useMemo(() => ({ ...T.idx, correlation: v.corr }), [T, v.corr]);
  const cp: CostParams = { ...PG_DEFAULTS, randomPageCost: v.rpc, effectiveCacheSize: Number(v.ecs) };
  const curves = useMemo(() => {
    const xs = Array.from({ length: 81 }, (_, i) => SEL_LO * Math.pow(1 / SEL_LO, i / 80));
    const out: Record<AccessPath, [number, number][]> = { seq: [], index: [], bitmap: [] };
    for (const s of xs) { const a = accessPaths(T.t, idx, s, cp).paths; for (const k of PATHS) out[k].push([s, a[k].total]); }
    return out;
  }, [T, idx, v.rpc, v.ecs]); // eslint-disable-line react-hooks/exhaustive-deps
  const flips = useMemo(() => planFlips(T.t, idx, cp, SEL_LO, 1, 200), [T, idx, v.rpc, v.ecs]); // eslint-disable-line react-hooks/exhaustive-deps
  const cells = useMemo(() => {
    const nx = 48, ny = 28, out: { x0: number; x1: number; y0: number; y1: number; path: AccessPath }[] = [];
    for (let j = 0; j < ny; j++) {
      const y0 = 1 + (7 * j) / ny, y1 = 1 + (7 * (j + 1)) / ny;
      const pc = { ...PG_DEFAULTS, randomPageCost: (y0 + y1) / 2, effectiveCacheSize: Number(v.ecs) };
      let start = 0, prev: AccessPath | null = null;
      for (let i = 0; i <= nx; i++) {
        const s = SEL_LO * Math.pow(1 / SEL_LO, (i + 0.5) / nx);
        const b = i < nx ? accessPaths(T.t, idx, s, pc).best : null;
        if (b !== prev) {
          if (prev) out.push({ x0: SEL_LO * Math.pow(1 / SEL_LO, start / nx), x1: SEL_LO * Math.pow(1 / SEL_LO, i / nx), y0, y1, path: prev });
          start = i; prev = b;
        }
      }
    }
    return out;
  }, [T, idx, v.ecs]);
  const yMin = Math.min(...PATHS.map((k) => curves[k][0]![1])) * 0.5;
  const yMax = Math.max(...PATHS.map((k) => curves[k].at(-1)![1])) * 2;
  const fmtSel = (s: number) => (s >= 0.01 ? pct(s, 0) : s >= 0.001 ? pct(s, 1) : `${Number((s * 100).toPrecision(2))}%`);
  return (
    <Demo
      title={`Which scan wins? ${T.t.name}, B-tree on the predicate column`}
      controls={<>
        <Param spec={p.schema.corr} value={v.corr} onChange={(x) => p.set("corr", x as number)} />
        <Param spec={p.schema.rpc} value={v.rpc} onChange={(x) => p.set("rpc", x as number)} />
        <Param spec={p.schema.table} value={v.table} onChange={(x) => p.set("table", x as TableId)} />
        <Param spec={p.schema.ecs} value={v.ecs} onChange={(x) => p.set("ecs", x as string)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Total cost against selectivity (random_page_cost {v.rpc.toFixed(1)})</SectionLabel>
      <Plot x={[SEL_LO, 1]} y={[yMin, yMax]} logX logY height={220} xLabel="selectivity" yLabel="cost" xTicks={[1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]} yTicks={logTicks(yMin, yMax)} xFormat={fmtSel} yFormat={(y) => num(y, 2)}>
        {PATHS.map((k) => <Line key={k} points={curves[k]} color={PATH_COLOR[k]} />)}
        {flips.map((f, i) => <RuleX key={i} at={f.sel} label={fmtSel(f.sel)} />)}
      </Plot>
      <Legend items={PATHS.map((k) => ({ label: PATH_LABEL[k], color: PATH_COLOR[k] }))} />
      <SectionLabel>Plan diagram: the cheapest scan for each selectivity and random_page_cost</SectionLabel>
      <Plot x={[SEL_LO, 1]} y={[1, 8]} logX height={200} xLabel="selectivity" yLabel="random_page_cost" xTicks={[1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]} xFormat={fmtSel} grid={false}>
        <Cells cells={cells} />
        <RuleY at={v.rpc} color="var(--fg)" />
        <Dots points={flips.map((f) => [f.sel, v.rpc] as const)} color="var(--fg)" r={3.5} />
      </Plot>
      <Stats items={[
        ...flips.map((f) => ({ label: `${PATH_LABEL[f.from]} → ${PATH_LABEL[f.to]}`, value: `${fmtSel(f.sel)} (${int(f.sel * T.t.rows)} rows)` })),
        { label: "plan changes on the line", value: flips.length },
      ]} />
      <Note>Each flip is a point where two cost lines cross. The run time of each plan changes smoothly with the selectivity, but the chosen plan jumps at each crossing.</Note>
    </Demo>
  );
}

// ---------------- join methods ----------------

const JCOLOR: Record<JoinMethod, string> = { hash: "var(--c2)", indexnl: "var(--c1)", nl: "var(--c4)" };

export function JoinMethodDemo() {
  const p = useParams("joinm", {
    k: range({ label: "Customers that pass the filter (outer rows)", min: 1, max: 100000, default: 100, log: true, format: (v) => int(v) }),
    rpc: range({ label: "random_page_cost", min: 1, max: 8, step: 0.1, default: 4, format: (v) => v.toFixed(1) }),
    nl: toggle({ label: "Show a nested loop with no index (a full scan of orders per customer)", default: false }),
  });
  const v = p.values;
  const cp: CostParams = { ...PG_DEFAULTS, randomPageCost: v.rpc };
  const k = Math.max(1, Math.round(v.k));
  const now = joinMethods(k, cp);
  const methods: JoinMethod[] = v.nl ? ["indexnl", "hash", "nl"] : ["indexnl", "hash"];
  const curves = useMemo(() => {
    const xs = Array.from({ length: 61 }, (_, i) => Math.round(Math.pow(1e5, i / 60)));
    const out: Record<JoinMethod, [number, number][]> = { hash: [], indexnl: [], nl: [] };
    for (const x of xs) { const c = joinMethods(x, cp).costs; for (const m of ["hash", "indexnl", "nl"] as JoinMethod[]) out[m].push([x, c[m].total]); }
    return out;
  }, [v.rpc]); // eslint-disable-line react-hooks/exhaustive-deps
  const cross = useMemo(() => joinCrossover(cp), [v.rpc]); // eslint-disable-line react-hooks/exhaustive-deps
  const yMax = v.nl ? 1e9 : Math.max(curves.indexnl.at(-1)![1], curves.hash.at(-1)![1]) * 2;
  const best = (["indexnl", "hash"] as JoinMethod[]).reduce((a, b) => (now.costs[b].total < now.costs[a].total ? b : a));
  return (
    <Demo
      title="customers c JOIN orders o ON o.customer_id = c.id WHERE <filter on c>"
      controls={<>
        <Param spec={p.schema.k} value={v.k} onChange={(x) => p.set("k", x as number)} />
        <Param spec={p.schema.rpc} value={v.rpc} onChange={(x) => p.set("rpc", x as number)} />
        <Param spec={p.schema.nl} value={v.nl} onChange={(x) => p.set("nl", x as boolean)} />
      </>}
    >
      <Plot x={[1, 1e5]} y={[1000, yMax]} logX logY height={230} xLabel="outer rows" yLabel="total cost" xTicks={logTicks(1, 1e5)} yTicks={logTicks(1000, yMax)} xFormat={(x) => num(x, 2)} yFormat={(y) => num(y, 2)}>
        {methods.map((m) => <Line key={m} points={curves[m]} color={JCOLOR[m]} />)}
        {Number.isFinite(cross) && <RuleX at={cross} label={`flip at ${int(cross)}`} />}
        <RuleX at={k} color="var(--fg)" dash="2 2" />
        <Dots points={methods.map((m) => [k, now.costs[m].total] as const)} color="var(--fg)" r={3.5} />
      </Plot>
      <Legend items={methods.map((m) => ({ label: JOIN_LABEL[m], color: JCOLOR[m] }))} />
      <Stats items={[
        { label: "chosen", value: <span style={{ color: JCOLOR[best] }}>{JOIN_LABEL[best]}</span> },
        { label: "Nested Loop + Index Scan", value: fixed(now.costs.indexnl.total, 0) },
        { label: "Hash Join", value: fixed(now.costs.hash.total, 0) },
        { label: "one index probe (amortized)", value: fixed(now.perLoop.total, 2) },
        { label: "joined rows", value: int(now.outRows) },
      ]} />
      <Note>orders: 1,000,000 rows, 9,346 pages, 10 orders per customer, B-tree on customer_id. The hash join reads all of orders once. The nested loop probes the index once per customer; Mackert–Lohman lowers the cost of each probe when many probes share cached pages.</Note>
    </Demo>
  );
}
