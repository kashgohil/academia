/** Demos for "model checking": the state explosion, the interleaving grid with traces, and a bug hunt. */
import { useMemo, useState } from "react";
import { Btn, ButtonRow, Demo, Tex, IndexButtons, Meter, MiniTable, Note, Param, SectionLabel, Stats, int, pct, range, seg, useChunked, useParams, useWidth, MONO, tint } from "../../kit";
import {
  countStates, explosionProg, huntBfs, huntPct, huntPreemption, huntRandom, pctBound, schedulesExact, sleepSetSearch,
  ticketProg, ticketTotalSteps, traceSummary, tracesFormula, GRID_PRESETS, dependent,
  type Access, type ExplosionKind, type HuntResult, type StepProg,
} from "../../sims/conc/verification";
import { SyncStepper, TC } from "../os/SyncShared";

// ---------------------------------------------------------------- 1. the explosion

const EXP = {
  n: range({ label: "Threads n", min: 1, max: 4, step: 1, default: 3 }),
  k: range({ label: "Steps per thread k", min: 1, max: 6, step: 1, default: 4 }),
  kind: seg<ExplosionKind>("Each step writes", [["private", "its own variable"], ["mixed", "x on even steps"], ["shared", "x"]], "mixed"),
};

const big = (v: bigint) => (v < 1_000_000_000n ? Number(v).toLocaleString("en-US") : Number(v).toExponential(2).replace("e+", " × 10^"));

export function ConcVerExplosionDemo() {
  const P = useParams("conc-ver-explosion", EXP);
  const { n, k, kind } = P.values;
  const r = useMemo(() => {
    const prog = explosionProg(kind, n, k);
    const sched = schedulesExact(n, k);
    const traces = tracesFormula(kind, n, k);
    const sleep = traces <= 3000n ? sleepSetSearch(prog, 300_000) : null;
    return { sched, states: countStates(prog), traces, sleep };
  }, [n, k, kind]);
  const max = Number(r.sched);
  const fmt = (v: bigint) => big(v).replace(/ × 10\^(\d+)/, (_, e) => ` × 10${String(e).split("").map((d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]).join("")}`);
  return (
    <Demo
      title="Schedules, states and traces"
      controls={
        <>
          <Param spec={EXP.n} value={n} onChange={(v) => P.set("n", v as number)} />
          <Param spec={EXP.k} value={k} onChange={(v) => P.set("k", v as number)} />
          <Param spec={EXP.kind} value={kind} onChange={(v) => P.set("kind", v as ExplosionKind)} />
        </>
      }
    >
      <Meter label="schedules: (nk)! / (k!)ⁿ" value={max} max={max} color="var(--c4)" text={fmt(r.sched)} log />
      <Meter label="distinct states (search with hashing)" value={r.states} max={max} color="var(--c1)" text={int(r.states)} log />
      <Meter label="traces: one run each with ideal partial order reduction" value={Number(r.traces)} max={max} color="var(--c3)" text={fmt(r.traces)} log />
      <Note>The bars use a log scale. Each bar is a count that a checker must pay for: one run per schedule, one visit per state, or one run per trace.</Note>
      <Stats items={[
        { label: "sleep-set search: complete runs", value: r.sleep ? int(r.sleep.complete) : "too many to run here" },
        { label: "sleep-set search: dead ends", value: r.sleep ? int(r.sleep.blocked) : "–" },
        { label: "schedules per trace", value: r.traces > 0n ? fmt(r.sched / r.traces) : "–" },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- 2. the grid

type GridKey = keyof typeof GRID_PRESETS;
const CYCLE: [string, boolean][] = [["local", true], ["x", true], ["x", false], ["y", true], ["y", false]];
const accName = (a: Access) => (a.v === "a" || a.v === "b" ? "local" : `${a.w ? "write" : "read"} ${a.v}`);
const shortName = (a: Access) => (a.v === "a" || a.v === "b" ? "loc" : `${a.w ? "w" : "r"} ${a.v}`);

export function ConcVerGridDemo() {
  const [prog, setProg] = useState<StepProg>(GRID_PRESETS.message!.prog);
  const [k, setK] = useState(0);
  const sum = useMemo(() => traceSummary(prog), [prog]);
  const sleep = useMemo(() => sleepSetSearch(prog), [prog]);
  const states = useMemo(() => countStates(prog), [prog]);
  const traces = [...sum.byTrace.values()];
  const cur = traces[Math.min(k, traces.length - 1)]!;
  const load = (key: GridKey) => { setProg(GRID_PRESETS[key]!.prog); setK(0); };
  const cycle = (t: number, j: number) => {
    const a = prog.threads[t]![j]!;
    const i = CYCLE.findIndex(([v, w]) => (v === "local" ? a.v === "a" || a.v === "b" : v === a.v && w === a.w));
    const [v, w] = CYCLE[(i + 1) % CYCLE.length]!;
    const threads = prog.threads.map((th) => th.slice());
    threads[t]![j] = { v: v === "local" ? (t === 0 ? "a" : "b") : v, w };
    setProg({ threads });
    setK(0);
  };
  const [ref, width] = useWidth<HTMLDivElement>();
  const size = Math.min(320, Math.max(220, width - 20));
  const pad = 46, cell = (size - pad - 12) / 4;
  const X = (i: number) => pad + i * cell, Y = (j: number) => pad + j * cell;
  const edges = new Set<string>();
  for (const s of cur) {
    let i = 0, j = 0;
    for (const t of s) {
      const [a, b] = t === 0 ? [i + 1, j] : [i, j + 1];
      edges.add(`${i},${j},${a},${b}`);
      [i, j] = [a, b];
    }
  }
  return (
    <Demo
      title="The interleaving grid"
      actions={<ButtonRow>{(Object.keys(GRID_PRESETS) as GridKey[]).map((key) => <Btn key={key} onClick={() => load(key)}>{GRID_PRESETS[key]!.label}</Btn>)}</ButtonRow>}
    >
      <div ref={ref} style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <svg width={size} height={size} style={{ display: "block", flex: "none" }}>
          {[0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => {
            const dep = dependent(prog.threads[0]![i]!, prog.threads[1]![j]!);
            return <rect key={`${i}${j}`} x={X(i) + 2} y={Y(j) + 2} width={cell - 4} height={cell - 4} rx={3} fill={dep ? tint("var(--c4)", 30) : "var(--subtle)"} />;
          }))}
          {[0, 1, 2, 3].map((i) => <text key={`c${i}`} x={X(i) + cell / 2} y={pad - 10} fontSize={10.5} fontFamily={MONO} textAnchor="middle" fill={TC[0]}>{shortName(prog.threads[0]![i]!)}</text>)}
          {[0, 1, 2, 3].map((j) => <text key={`r${j}`} x={pad - 6} y={Y(j) + cell / 2 + 4} fontSize={10.5} fontFamily={MONO} textAnchor="end" fill={TC[1]}>{shortName(prog.threads[1]![j]!)}</text>)}
          <text x={pad} y={12} fontSize={10.5} fill="var(--muted)">T0 steps →</text>
          <text x={4} y={pad + 8} fontSize={10.5} fill="var(--muted)" transform={`rotate(90 4 ${pad + 8})`}>T1 steps →</text>
          {[0, 1, 2, 3, 4].map((i) => [0, 1, 2, 3, 4].map((j) => (
            <g key={`n${i}${j}`}>
              {i < 4 && <line x1={X(i)} y1={Y(j)} x2={X(i + 1)} y2={Y(j)} stroke={edges.has(`${i},${j},${i + 1},${j}`) ? "var(--c1)" : "var(--border)"} strokeWidth={edges.has(`${i},${j},${i + 1},${j}`) ? 3 : 1} />}
              {j < 4 && <line x1={X(i)} y1={Y(j)} x2={X(i)} y2={Y(j + 1)} stroke={edges.has(`${i},${j},${i},${j + 1}`) ? "var(--c1)" : "var(--border)"} strokeWidth={edges.has(`${i},${j},${i},${j + 1}`) ? 3 : 1} />}
            </g>
          )))}
          {[0, 1, 2, 3, 4].map((i) => [0, 1, 2, 3, 4].map((j) => <circle key={`d${i}${j}`} cx={X(i)} cy={Y(j)} r={3} fill="var(--fg)" />))}
        </svg>
        <div style={{ flex: "1 1 180px", minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Program (click a step to change it)</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {[0, 1].map((t) => (
              <div key={t} style={{ display: "grid", gap: 3 }}>
                <span style={{ fontSize: 12, color: TC[t] }}>T{t}</span>
                {prog.threads[t]!.map((a, j) => (
                  <button key={j} className="btn" style={{ fontFamily: MONO, fontSize: 11.5, padding: "2px 6px", textAlign: "left" }} onClick={() => cycle(t, j)}>{j + 1}. {accName(a)}</button>
                ))}
              </div>
            ))}
          </div>
          <SectionLabel>Trace {Math.min(k, traces.length - 1) + 1} of {traces.length}</SectionLabel>
          <ButtonRow><IndexButtons k={Math.min(k, traces.length - 1)} n={traces.length} set={setK} /></ButtonRow>
          <Note>The blue paths are the {cur.length} schedule{cur.length === 1 ? "" : "s"} of this trace. They differ only by swaps across grey squares.</Note>
        </div>
      </div>
      <Stats items={[
        { label: "schedules (paths)", value: int(sum.schedules) },
        { label: "distinct states", value: int(states) },
        { label: "traces", value: int(sum.traces) },
        { label: "different final states", value: int(sum.outcomes) },
        { label: "sleep-set runs + dead ends", value: `${sleep.complete} + ${sleep.blocked}` },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- 3. the bug hunt

const HUNT = {
  n: range({ label: "Threads (the bug needs n − 1 preemptions)", min: 2, max: 4, step: 1, default: 3 }),
  pad: range({ label: "Stagger s (thread t first works t·s steps)", min: 0, max: 6, step: 1, default: 4 }),
};
const RUNS = 1000;
const BUDGET = 60_000;

export function ConcVerBugHuntDemo() {
  const P = useParams("conc-ver-hunt", HUNT);
  const { n, pad } = P.values;
  const prog = useMemo(() => ticketProg(n, pad), [n, pad]);
  const bounds = Array.from({ length: n }, (_, c) => c);
  const jobs = useMemo(() => [
    () => huntBfs(n, pad),
    ...bounds.map((c) => () => huntPreemption(n, pad, c, BUDGET)),
    () => huntRandom(n, pad, RUNS),
    () => huntPct(n, pad, n, RUNS),
  ], [n, pad]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked<HuntResult>(`${n}/${pad}`, jobs);
  const k = ticketTotalSteps(n, pad);
  const bfs = res[0], rnd = res[n + 1], pct2 = res[n + 2];
  const found = (r: HuntResult | undefined, unit: string) => (!r ? "…" : r.firstBug > 0 ? `yes, at ${unit} ${int(r.firstBug)}` : r.truncated ? "not within the budget" : "no");
  const rows = [
    ["Breadth-first, with hashing", bfs ? `${int(bfs.tried)} states` : "…", bfs ? (bfs.counterexample ? `yes: ${bfs.counterexample.length} steps` : "no") : "…"],
    ...bounds.map((c) => {
      const r = res[1 + c];
      return [`At most ${c} preemption${c === 1 ? "" : "s"}`, r ? `${int(r.tried)}${r.truncated ? "+" : ""} schedules` : "…", found(r, "schedule")];
    }),
    ["Random walk", `${RUNS} runs`, rnd ? `${rnd.failures} runs fail (${pct(rnd.failures! / RUNS)})` : "…"],
    [`PCT, depth d = ${n}`, `${RUNS} runs`, pct2 ? `${pct2.failures} runs fail (${pct(pct2.failures! / RUNS)})` : "…"],
  ];
  const scripts = [
    ...(bfs?.counterexample ? [{ label: "Play the shortest counterexample", schedule: bfs.counterexample }] : []),
    ...(pct2?.counterexample ? [{ label: "Play a failing PCT run", schedule: pct2.counterexample }] : []),
  ];
  return (
    <SyncStepper
      title="Hunt a bug: all threads take the same ticket"
      prog={prog}
      scripts={scripts}
      hideRegs={["d"]}
      controls={
        <>
          <Param spec={HUNT.n} value={n} onChange={(v) => P.set("n", v as number)} />
          <Param spec={HUNT.pad} value={pad} onChange={(v) => P.set("pad", v as number)} />
        </>
      }
      verdict={({ finished, s }) => {
        if (!finished) return null;
        const t = s.th.map((th) => th.r.t);
        const same = t.every((x) => x === t[0]);
        return { tone: same ? "bad" : "good", text: same ? `Bug: all ${n} threads hold ticket ${t[0]}.` : `Tickets: ${t.join(", ")}. The property holds in this run.` };
      }}
      footer={
        <>
          <SectionLabel>Four ways to search ({k} steps per run)</SectionLabel>
          <MiniTable head={["Strategy", "Work", "Finds the bug?"]} rows={rows} />
          <Note>PCT guarantees a failing run with probability at least <Tex>{"1/(n k^{d-1})"}</Tex> = {pct(pctBound(n, k, n), 3)} per run here. Bounded search stops at {int(BUDGET)} schedules.</Note>
        </>
      }
    />
  );
}

