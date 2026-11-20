/** Demos for "fork-join": a DAG of a parallel sum on P cores, grain size against spawn cost, and the parallelism of algorithms. */
import { useMemo, useState } from "react";
import { Banner, Demo, Dots, Legend, Line, Param, Plot, RuleY, Stats, fixed, int, range, sig, toggle, useChunked, useParams, useWidth } from "../../kit";
import { algoWorkSpan, bounds, grainPoint, grains, greedy, nodeStates, sumDag, workSpan, type Algo, type GrainPoint, type NodeKind } from "../../sims/conc/patterns";
import { Gantt } from "../os/SchedulingGantt";

const KIND_COLOR: Record<NodeKind, string> = { split: "var(--c2)", leaf: "var(--c1)", join: "var(--c3)" };
const N = 32;

const DAG = {
  grain: range({ label: "Grain (elements per leaf)", min: 0, max: 5, step: 1, default: 2, format: (v) => `${2 ** v}` }),
  procs: range({ label: "Cores P", min: 1, max: 8, step: 1, default: 2 }),
  spawn: range({ label: "Cost of a spawn (units)", min: 0, max: 6, step: 1, default: 1 }),
  path: toggle({ label: "Show the span (a longest path)", default: true }),
};

export function ConcPatDagDemo() {
  const P = useParams("conc-fj-dag", DAG);
  const { grain: gExp, procs, spawn, path: showPath } = P.values;
  const grain = 2 ** gExp;
  const { dag, ws, sch, b } = useMemo(() => {
    const dag = sumDag(N, grain, { elem: 1, spawn, join: 1 });
    const ws = workSpan(dag);
    const sch = greedy(dag, procs);
    return { dag, ws, sch, b: bounds(ws, procs) };
  }, [grain, spawn, procs]);
  const [tRaw, setT] = useState(9);
  const t = Math.min(tRaw, sch.makespan);
  const states = nodeStates(dag, sch, t);
  const onPath = new Set(showPath ? ws.path : []);
  const pathEdge = (a: number, c: number) => onPath.has(a) && onPath.has(c) && Math.abs(ws.path.indexOf(a) - ws.path.indexOf(c)) === 1;

  const [ref, w] = useWidth<HTMLDivElement>();
  const leafDepth = Math.max(...dag.nodes.filter((v) => v.kind === "leaf").map((v) => v.depth));
  const rows = 2 * leafDepth + 1;
  const rowH = 30, pad = 12;
  const H = rows * rowH + pad;
  const X = (v: { lo: number; hi: number }) => pad + (((v.lo + v.hi) / 2) / N) * (w - 2 * pad);
  const Y = (v: { kind: NodeKind; depth: number }) => pad + rowH / 2 + (v.kind === "split" ? v.depth : v.kind === "leaf" ? leafDepth : 2 * leafDepth - v.depth) * rowH - 4;
  const r = Math.max(3.5, Math.min(9, (w - 2 * pad) / (N / grain) / 2.6));

  const ganttRows = Array.from({ length: sch.procs }, (_, p) => ({
    label: `core ${p}`,
    segs: sch.slots.filter((s) => s.proc === p && s.end > s.start).map((s) => ({ start: s.start, end: s.end, color: KIND_COLOR[dag.nodes[s.node]!.kind] })),
  }));

  return (
    <Demo
      title="A parallel sum as a DAG, on P cores"
      controls={
        <>
          <Param spec={DAG.grain} value={gExp} onChange={(v) => P.set("grain", v as number)} />
          <Param spec={DAG.procs} value={procs} onChange={(v) => P.set("procs", v as number)} />
          <Param spec={DAG.spawn} value={spawn} onChange={(v) => P.set("spawn", v as number)} />
          <Param spec={range({ label: "Time", min: 0, max: Math.max(1, sch.makespan), step: 1, default: 0, format: (v) => `${v} of ${sch.makespan}` })} value={t} onChange={(v) => setT(v as number)} />
          <Param spec={DAG.path} value={showPath} onChange={(v) => P.set("path", v as boolean)} />
        </>
      }
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg width={w} height={H} style={{ display: "block" }} role="img" aria-label="Task DAG">
          {dag.nodes.flatMap((v) =>
            v.succ.map((s) => {
              const u = dag.nodes[s]!;
              const hot = pathEdge(v.id, s);
              return <line key={`${v.id}-${s}`} x1={X(v)} y1={Y(v)} x2={X(u)} y2={Y(u)} stroke={hot ? "var(--c4)" : "var(--border)"} strokeWidth={hot ? 2.5 : 1.2} />;
            }),
          )}
          {dag.nodes.map((v) => {
            const st = states[v.id]!;
            const c = KIND_COLOR[v.kind];
            const filled = st === "done" || st === "running";
            return (
              <circle
                key={v.id}
                cx={X(v)}
                cy={Y(v)}
                r={st === "running" ? r + 1.5 : r}
                fill={filled ? c : "var(--bg)"}
                stroke={st === "running" ? "var(--fg)" : st === "waiting" ? "var(--faint)" : c}
                strokeWidth={st === "running" ? 2.5 : 1.5}
                strokeDasharray={st === "ready" ? "3 2" : undefined}
                opacity={st === "waiting" ? 0.55 : 1}
              />
            );
          })}
        </svg>
      </div>
      <Legend items={[{ label: "split (spawn)", color: KIND_COLOR.split }, { label: "leaf (adds elements)", color: KIND_COLOR.leaf }, { label: "join (adds two results)", color: KIND_COLOR.join }, { label: "span", color: "var(--c4)" }]} />
      <div style={{ marginTop: 6 }}>
        <Gantt rows={ganttRows} end={Math.max(1, sch.makespan)} cursor={t} unit="units" labelW={50} />
      </div>
      <Stats items={[
        { label: "work $T_1$", value: int(ws.work) },
        { label: "span $T_\\infty$", value: int(ws.span) },
        { label: "parallelism $T_1/T_\\infty$", value: fixed(ws.parallelism, 1) },
        { label: "greedy $T_P$", value: int(sch.makespan) },
        { label: "lower bound", value: fixed(b.lower, 1) },
        { label: "Brent bound", value: fixed(b.brent, 1) },
      ]} />
      <Banner tone={sch.makespan <= b.lower + 1e-9 ? "good" : "info"}>
        Filled nodes are done, a ringed node runs now, a dashed node is ready and waits for a core. {procs > ws.parallelism
          ? `P = ${procs} is more than the parallelism (${fixed(ws.parallelism, 1)}), so the span limits the time and some cores idle.`
          : `The schedule takes ${sch.makespan} units: at least max(T1/P, T∞) = ${fixed(b.lower, 1)}, at most T1/P + T∞ = ${fixed(b.brent, 1)}.`}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- grain size

const GN = 1 << 20;
const GRAINS = grains(GN, 64);
const GRAIN = {
  spawn: range({ label: "Cost of a spawn (model input)", min: 10, max: 20_000, log: true, default: 200, format: (v) => (v >= 1_000 ? `${sig(v / 1_000, 2)} µs` : `${Math.round(v)} ns`) }),
  procs: range({ label: "Cores P", min: 1, max: 64, step: 1, default: 8 }),
};

export function ConcPatGrainDemo() {
  const P = useParams("conc-fj-grain", GRAIN);
  const { spawn, procs } = P.values;
  const jobs = useMemo(() => GRAINS.map((g) => () => grainPoint(GN, g, procs, { elem: 1, spawn, join: 0 })), [spawn, procs]);
  const pts = useChunked<GrainPoint>(`${spawn}/${procs}`, jobs, { keep: true });
  const got = pts.filter((p): p is GrainPoint => !!p);
  const best = got.reduce<GrainPoint | undefined>((a, p) => (!a || p.speedup > a.speedup ? p : a), undefined);
  const ymax = Math.max(procs, 1) * 1.1;
  return (
    <Demo
      title="Grain size: too fine pays for spawns, too coarse starves cores"
      controls={
        <>
          <Param spec={GRAIN.spawn} value={spawn} onChange={(v) => P.set("spawn", v as number)} />
          <Param spec={GRAIN.procs} value={procs} onChange={(v) => P.set("procs", v as number)} />
        </>
      }
    >
      <Plot x={[64, GN]} y={[0, ymax]} logX height={240} xLabel="grain (elements per leaf, log scale)" yLabel="speedup over the serial loop" xTicks={[64, 1024, 16_384, 262_144]} xFormat={(v) => (v >= 1024 ? `${v / 1024}k` : `${v}`)}>
        <RuleY at={procs} label={`P = ${procs}`} />
        <Line points={got.map((p) => [p.grain, p.speedup] as [number, number])} color="var(--c1)" />
        <Dots points={got.map((p) => [p.grain, p.speedup] as [number, number])} color="var(--c1)" />
        {best && <Dots points={[[best.grain, best.speedup]]} color="var(--c4)" r={5} />}
      </Plot>
      <Stats items={[
        { label: "best grain", value: best ? int(best.grain) : "…" },
        { label: "leaf tasks at the best grain", value: best ? int(best.tasks) : "…" },
        { label: "best speedup", value: best ? fixed(best.speedup, 2) : "…" },
        { label: "speedup at grain 64", value: got[0] ? fixed(got[0].speedup, 2) : "…" },
      ]} />
      <Banner>
        A sum of {int(GN)} elements, 1 ns per element (model input), scheduled greedily on {procs} core{procs > 1 ? "s" : ""}. Each split costs one spawn. The red dot is the best grain.
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- parallelism of algorithms

const ALGOS: { algo: Algo; label: string; color: string }[] = [
  { algo: "sum", label: "parallel sum", color: "var(--c1)" },
  { algo: "mergesort-parallel-merge", label: "merge sort, parallel merge", color: "var(--c3)" },
  { algo: "mergesort-serial-merge", label: "merge sort, serial merge", color: "var(--c4)" },
];
const ALGO = {
  logn: range({ label: "Input size n", min: 10, max: 30, step: 1, default: 20, format: (v) => `2 to the ${v} (${sig(2 ** v, 3)})` }),
  procs: range({ label: "Cores P (the rule is 10 P)", min: 2, max: 256, step: 2, default: 64 }),
};

export function ConcPatAlgoDemo() {
  const P = useParams("conc-fj-algo", ALGO);
  const { logn, procs } = P.values;
  const ks = Array.from({ length: 27 }, (_, i) => i + 4);
  const lines = ALGOS.map((a) => ({ ...a, pts: ks.map((k) => [2 ** k, algoWorkSpan(a.algo, 2 ** k).parallelism] as [number, number]) }));
  const at = ALGOS.map((a) => ({ ...a, ws: algoWorkSpan(a.algo, 2 ** logn) }));
  return (
    <Demo
      title="Parallelism T₁/T∞ of three algorithms"
      controls={
        <>
          <Param spec={ALGO.logn} value={logn} onChange={(v) => P.set("logn", v as number)} />
          <Param spec={ALGO.procs} value={procs} onChange={(v) => P.set("procs", v as number)} />
        </>
      }
    >
      <Plot x={[16, 2 ** 30]} y={[1, 1e9]} logX logY height={250} xLabel="n (log scale)" yLabel="parallelism (log scale)" xTicks={[1e2, 1e4, 1e6, 1e8]} yTicks={[1, 1e3, 1e6, 1e9]} xFormat={(v) => `1e${Math.round(Math.log10(v))}`} yFormat={(v) => (v === 1 ? "1" : `1e${Math.round(Math.log10(v))}`)}>
        <RuleY at={10 * procs} label={`10 P = ${10 * procs}`} />
        {lines.map((l) => <Line key={l.algo} points={l.pts} color={l.color} />)}
        {at.map((a) => <Dots key={a.algo} points={[[2 ** logn, a.ws.parallelism]]} color={a.color} r={4.5} />)}
      </Plot>
      <Legend items={ALGOS.map((a) => ({ label: a.label, color: a.color }))} />
      <Stats items={at.map((a) => ({ label: a.label, value: a.ws.parallelism >= 10 * procs ? `${sig(a.ws.parallelism, 3)}` : `${sig(a.ws.parallelism, 3)} (too low)` }))} />
      <Banner tone={at[2]!.ws.parallelism >= 10 * procs ? "good" : "warn"}>
        Unit costs. A rule of thumb asks for parallelism of about 10 P, so that a scheduler has spare work to balance. The serial merge keeps merge sort far below that line for any n.
      </Banner>
    </Demo>
  );
}
