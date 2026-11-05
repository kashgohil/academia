/** Demos for "Join ordering": a join graph with strategies, the DP table stepper, search-space size. */
import { useEffect, useMemo, useState } from "react";
import { Demo, Param, Plot, Line, RuleX, Dots, Legend, Stats, range, toggle, useParams, useWidth, Btn, Note, SectionLabel, fixed, mono, seg } from "../../kit";
import {
  makeGraph, bushyExample, compareStrategies, STRATEGY_LABEL, planString, dp, GraphInfo, popcount, leftDeepCount, bushyCount, ccpCount, isLeftDeep,
  type JoinGraph, type Plan, type Shape, type Strategy,
} from "../../sims/db/optimizer";
import { num, LogBar } from "./OptimizerUi";

type GraphId = Shape | "bushy";
const GRAPH_OPTS: [GraphId, string][] = [["chain", "chain"], ["star", "star"], ["cycle", "cycle"], ["clique", "clique"], ["bushy", "bushy wins (fixed)"]];

function graphFor(id: GraphId, n: number, seed: number): JoinGraph { return id === "bushy" ? bushyExample() : makeGraph(id, n, seed); }

function layout(g: JoinGraph): { x: number; y: number }[] {
  if (g.shape === "chain") return g.rows.map((_, i) => ({ x: g.n === 1 ? 0.5 : i / (g.n - 1), y: i % 2 ? 0.8 : 0.2 }));
  if (g.shape === "star") return g.rows.map((_, i) => (i === 0 ? { x: 0.5, y: 0.5 } : { x: 0.5 + 0.46 * Math.cos((2 * Math.PI * (i - 1)) / (g.n - 1) - Math.PI / 2), y: 0.5 + 0.42 * Math.sin((2 * Math.PI * (i - 1)) / (g.n - 1) - Math.PI / 2) }));
  return g.rows.map((_, i) => ({ x: 0.5 + 0.46 * Math.cos((2 * Math.PI * i) / g.n - Math.PI / 2), y: 0.5 + 0.42 * Math.sin((2 * Math.PI * i) / g.n - Math.PI / 2) }));
}

const selText = (s: number) => { const e = Math.floor(Math.log10(s)); const m = s / 10 ** e; return `${m.toFixed(m < 9.95 ? 1 : 0)}e${e}`; };

/** The query graph: nodes are tables (with rows), edges are join predicates (with selectivity). */
export function QueryGraph({ g, highlight = 0, height = 200 }: { g: JoinGraph; highlight?: number; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const pos = layout(g);
  const pad = 30, R = 17;
  const px = (x: number) => pad + x * (w - 2 * pad), py = (y: number) => pad + 4 + y * (height - 2 * pad - 8);
  return (
    <div ref={ref}>
      <svg width={w} height={height} style={{ display: "block" }}>
        {g.edges.map((e, i) => {
          const a = pos[e.a]!, b = pos[e.b]!;
          const on = (highlight >> e.a) & 1 && (highlight >> e.b) & 1;
          return (
            <g key={i}>
              <line x1={px(a.x)} y1={py(a.y)} x2={px(b.x)} y2={py(b.y)} stroke={on ? "var(--c1)" : "var(--faint)"} strokeWidth={on ? 2.5 : 1.2} />
              {g.n <= 6 || g.shape !== "clique" ? <text x={(px(a.x) + px(b.x)) / 2} y={(py(a.y) + py(b.y)) / 2 - 4} textAnchor="middle" fontSize={10.5} style={{ fill: "var(--muted)", ...mono }}>{selText(e.sel)}</text> : null}
            </g>
          );
        })}
        {g.rows.map((r, i) => {
          const on = (highlight >> i) & 1;
          return (
            <g key={i} transform={`translate(${px(pos[i]!.x)},${py(pos[i]!.y)})`}>
              <circle r={R} fill={on ? "var(--c1)" : "var(--bg)"} stroke={on ? "var(--c1)" : "var(--fg)"} />
              <text textAnchor="middle" dy="0.35em" fontSize={13} fontWeight={600} style={{ fill: on ? "var(--bg)" : "var(--fg)" }}>{g.names[i]}</text>
              <text textAnchor="middle" y={pos[i]!.y < 0.5 ? -R - 5 : R + 13} fontSize={10.5} style={{ fill: "var(--muted)", ...mono }}>{num(r, 2)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** A plan tree: leaves are tables, inner nodes are joins labelled with their result size. */
export function PlanTree({ g, p }: { g: JoinGraph; p: Plan }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const nodes: { x: number; d: number; label: string; sub?: string; leaf: boolean }[] = [];
  const edges: [number, number][] = [];
  let leafIdx = 0, maxD = 0;
  const go = (q: Plan, d: number): number => {
    maxD = Math.max(maxD, d);
    if (q.rel !== undefined) { nodes.push({ x: leafIdx++, d, label: g.names[q.rel]!, leaf: true }); return nodes.length - 1; }
    const a = go(q.left!, d + 1), b = go(q.right!, d + 1);
    nodes.push({ x: (nodes[a]!.x + nodes[b]!.x) / 2, d, label: "⋈", sub: num(q.card, 2), leaf: false });
    const me = nodes.length - 1;
    edges.push([me, a], [me, b]);
    return me;
  };
  go(p, 0);
  const H = (maxD + 1) * 40 + 16, pad = 22;
  const X = (x: number) => pad + (leafIdx <= 1 ? 0.5 : x / (leafIdx - 1)) * (w - 2 * pad), Y = (d: number) => 16 + d * 40;
  return (
    <div ref={ref}>
      <svg width={w} height={H} style={{ display: "block" }}>
        {edges.map(([a, b], i) => <line key={i} x1={X(nodes[a]!.x)} y1={Y(nodes[a]!.d)} x2={X(nodes[b]!.x)} y2={Y(nodes[b]!.d)} stroke="var(--faint)" />)}
        {nodes.map((n, i) => (
          <g key={i} transform={`translate(${X(n.x)},${Y(n.d)})`}>
            <circle r={n.leaf ? 12 : 10} fill={n.leaf ? "var(--subtle)" : "var(--bg)"} stroke={n.leaf ? "var(--fg)" : "var(--c1)"} />
            <text textAnchor="middle" dy="0.35em" fontSize={12} fontWeight={600} style={{ fill: "var(--fg)" }}>{n.label}</text>
            {n.sub && <text x={14} dy="0.35em" fontSize={10.5} style={{ fill: "var(--muted)", ...mono }}>{n.sub}</text>}
          </g>
        ))}
      </svg>
    </div>
  );
}

const STRATS: Strategy[] = ["bushy", "leftdeep", "greedy", "random", "worst"];
const SCOLOR: Record<Strategy, string> = { bushy: "var(--c1)", leftdeep: "var(--c2)", greedy: "var(--c3)", random: "var(--c5)", worst: "var(--c4)" };

export function JoinGraphDemo() {
  const p = useParams("jgraph", {
    n: range({ label: "Tables", min: 3, max: 7, step: 1, default: 6 }),
    shape: seg<GraphId>("Query graph", GRAPH_OPTS, "chain"),
    seed: range({ label: "Random cardinalities and selectivities (seed)", min: 1, max: 20, step: 1, default: 1 }),
    cross: toggle({ label: "Allow cross products", default: false }),
  });
  const v = p.values;
  const [pick, setPick] = useState<Strategy>("bushy");
  const g = useMemo(() => graphFor(v.shape, v.n, v.seed), [v.shape, v.n, v.seed]);
  const res = useMemo(() => compareStrategies(g, v.cross), [g, v.cross]);
  const best = res.bushy.cost;
  const hi = Math.max(10, res.worst.cost / best);
  return (
    <Demo
      title={`${g.n} tables, ${g.edges.length} join predicates · cost = C_out (sum of intermediate result sizes)`}
      controls={<>
        <Param spec={p.schema.n} value={v.n} onChange={(x) => p.set("n", x as number)} />
        <Param spec={p.schema.shape} value={v.shape} onChange={(x) => p.set("shape", x as GraphId)} />
        <Param spec={p.schema.seed} value={v.seed} onChange={(x) => p.set("seed", x as number)} />
        <Param spec={p.schema.cross} value={v.cross} onChange={(x) => p.set("cross", x as boolean)} />
      </>}
    >
      <QueryGraph g={g} highlight={0} />
      <div className="muted" style={{ fontSize: 12 }}>Numbers under the tables are row counts; numbers on the edges are join selectivities.</div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 2fr) auto minmax(50px, 1fr)", gap: "6px 10px", marginTop: 10, fontSize: 12.5, alignItems: "center" }}>
        <b>strategy</b><b>plan</b><b>C_out</b><b>× optimum</b>
        {STRATS.map((s) => (
          <div key={s} onClick={() => setPick(s)} style={{ display: "contents", cursor: "pointer" }}>
            <span style={{ color: SCOLOR[s], fontWeight: pick === s ? 700 : 400, cursor: "pointer" }}>{pick === s ? "▸ " : ""}{STRATEGY_LABEL[s]}</span>
            <span style={{ ...mono, fontSize: 11.5, overflowWrap: "anywhere", cursor: "pointer" }}>{planString(g, res[s])}</span>
            <span style={{ ...mono }}>{num(res[s].cost, 3)}</span>
            <div style={{ cursor: "pointer" }}>
              <span style={mono}>{fixed(res[s].cost / best, res[s].cost / best < 100 ? 2 : 0)}</span>
              <LogBar value={res[s].cost / best} lo={1} hi={hi} color={SCOLOR[s]} height={6} />
            </div>
          </div>
        ))}
      </div>
      <SectionLabel>{STRATEGY_LABEL[pick]}: {isLeftDeep(res[pick]) ? "a left-deep tree" : "a bushy tree"} (click a row to show another plan)</SectionLabel>
      <PlanTree g={g} p={res[pick]} />
      <Note>Greedy (GOO) joins the pair with the smallest result first. Random search keeps the best of 10 random left-deep orders that avoid cross products.</Note>
    </Demo>
  );
}

// ---------------- DP table ----------------

export function DpTableDemo() {
  const p = useParams("dptab", {
    n: range({ label: "Tables", min: 3, max: 7, step: 1, default: 4 }),
    shape: seg<GraphId>("Query graph", GRAPH_OPTS, "bushy"),
    seed: range({ label: "Seed", min: 1, max: 20, step: 1, default: 1 }),
    leftDeep: toggle({ label: "Left-deep only (System R): the right input is always one table", default: false }),
  });
  const v = p.values;
  const g = useMemo(() => graphFor(v.shape, v.n, v.seed), [v.shape, v.n, v.seed]);
  const res = useMemo(() => dp(g, { leftDeep: v.leftDeep }), [g, v.leftDeep]);
  const gi = useMemo(() => new GraphInfo(g), [g]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = res.trace.length;
  useEffect(() => { setStep(0); setPlaying(false); }, [res]);
  useEffect(() => {
    if (!playing) return;
    if (step >= total) { setPlaying(false); return; }
    const t = window.setTimeout(() => setStep((s) => s + 1), 650);
    return () => window.clearTimeout(t);
  }, [playing, step, total]);
  const cur = step > 0 ? res.trace[step - 1]! : undefined;
  const done = res.trace.slice(0, step);
  const bySize = new Map<number, typeof done>();
  for (const s of done) { const k = popcount(s.mask); bySize.set(k, [...(bySize.get(k) ?? []), s]); }
  return (
    <Demo
      title="Dynamic programming over subsets, smallest first"
      actions={<>
        <Btn onClick={() => setPlaying((x) => !x)} disabled={step >= total}>{playing ? "Pause" : "Play"}</Btn>
        <Btn onClick={() => setStep((s) => Math.min(total, s + 1))} disabled={step >= total || playing}>Step</Btn>
        <Btn ghost onClick={() => { setStep(0); setPlaying(false); }}>Reset</Btn>
      </>}
      controls={<>
        <Param spec={p.schema.n} value={v.n} onChange={(x) => p.set("n", x as number)} />
        <Param spec={p.schema.shape} value={v.shape} onChange={(x) => p.set("shape", x as GraphId)} />
        <Param spec={p.schema.seed} value={v.seed} onChange={(x) => p.set("seed", x as number)} />
        <Param spec={p.schema.leftDeep} value={v.leftDeep} onChange={(x) => p.set("leftDeep", x as boolean)} />
      </>}
    >
      <QueryGraph g={g} highlight={cur?.mask ?? 0} height={170} />
      <div style={{ fontSize: 13, minHeight: 70 }}>
        {!cur && <span className="muted">Step 0 of {total}. Single tables are the base case: each one has cost 0. Press Step.</span>}
        {cur && <>
          <div>Step {step} of {total}: subset <b style={mono}>{gi.name(cur.mask)}</b>, {num(gi.card[cur.mask]!, 3)} rows. {cur.candidates.length} split{cur.candidates.length === 1 ? "" : "s"} into two connected parts with a join predicate between them:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: 4 }}>
            {cur.candidates.map((c, i) => {
              const win = c.cost === cur.best!.cost;
              return <span key={i} style={{ ...mono, fontSize: 12, color: win ? "var(--c1)" : "var(--muted)", fontWeight: win ? 700 : 400 }}>best({gi.name(c.left)}) + best({gi.name(c.right)}) + {num(gi.card[cur.mask]!, 3)} = {num(c.cost, 4)}{win ? " ✓" : ""}</span>;
            })}
          </div>
        </>}
      </div>
      <SectionLabel>The DP table (best plan for each subset so far)</SectionLabel>
      <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto auto", gap: "2px 12px", fontSize: 12, alignItems: "baseline" }}>
          <b>subset</b><b>best plan</b><b>rows</b><b>C_out</b>
          {g.names.map((nm, i) => (
            <div key={nm} style={{ display: "contents" }}>
              <span style={mono}>{nm}</span><span className="muted" style={mono}>scan</span><span style={mono}>{num(g.rows[i]!, 3)}</span><span style={mono}>0</span>
            </div>
          ))}
          {[...bySize.entries()].map(([k, list]) => list.map((s) => (
            <div key={s.mask} style={{ display: "contents" }}>
              <span style={{ ...mono, color: s === cur ? "var(--c1)" : undefined, fontWeight: s === cur ? 700 : 400 }}>{gi.name(s.mask)}</span>
              <span style={{ ...mono, overflowWrap: "anywhere" }}>{planString(g, s.best!)}</span>
              <span style={mono}>{num(s.best!.card, 3)}</span>
              <span style={mono}>{num(s.best!.cost, 4)}{k === g.n ? " ← answer" : ""}</span>
            </div>
          )))}
        </div>
      </div>
      <Note>Splits considered in total: {res.pairsConsidered}. Each subset is solved once, from the best plans of its two parts. That is the principle of optimality: the best plan for a set contains the best plans for its parts.</Note>
    </Demo>
  );
}

// ---------------- search space ----------------

export function SearchSpaceDemo() {
  const p = useParams("space", {
    n: range({ label: "Tables in the query", min: 2, max: 20, step: 1, default: 10 }),
  });
  const n = p.values.n;
  const ns = Array.from({ length: 19 }, (_, i) => i + 2);
  const series: { label: string; color: string; f: (k: number) => number; dash?: string }[] = [
    { label: "bushy trees, Catalan(n−1) × n!", color: "var(--c4)", f: bushyCount },
    { label: "left-deep trees, n!", color: "var(--c5)", f: leftDeepCount },
    { label: "subsets, 2ⁿ (DP table size)", color: "var(--c2)", f: (k) => 2 ** k, dash: "5 3" },
    { label: "DP work, clique (csg-cmp pairs)", color: "var(--c1)", f: (k) => ccpCount("clique", k) },
    { label: "DP work, star", color: "var(--c3)", f: (k) => ccpCount("star", k) },
    { label: "DP work, chain", color: "var(--fg)", f: (k) => ccpCount("chain", k) },
  ];
  return (
    <Demo title="How many plans? (join trees, ignoring the choice of join algorithm)" controls={<Param spec={p.schema.n} value={n} onChange={(x) => p.set("n", x as number)} />}>
      <Plot x={[2, 20]} y={[1, 1e28]} logY height={240} xLabel="tables" yLabel="count" yTicks={[1, 1e4, 1e8, 1e12, 1e16, 1e20, 1e24, 1e28]} yFormat={(y) => (y === 1 ? "1" : `1e${Math.round(Math.log10(y))}`)}>
        {series.map((s) => <Line key={s.label} points={ns.map((k) => [k, s.f(k)] as const)} color={s.color} dash={s.dash} />)}
        <RuleX at={12} label="geqo_threshold" />
        <RuleX at={n} color="var(--fg)" dash="2 2" />
        <Dots points={series.map((s) => [n, s.f(n)] as const)} color="var(--fg)" r={3} />
      </Plot>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <Stats items={series.map((s) => ({ label: s.label, value: num(s.f(n), 4) }))} />
      <Note>PostgreSQL runs its exhaustive DP below geqo_threshold (12 FROM items by default) and switches to the genetic optimizer GEQO at 12 or more.</Note>
    </Demo>
  );
}

