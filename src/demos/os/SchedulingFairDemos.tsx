/** Demos for "CFS and EEVDF". */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Controls, Param, Plot, Line, Legend, RuleX, range, toggle, useParams, useSim, useWidth, pct, Note, SmallLabel, mono, seg } from "../../kit";
import {
  FairSim, SCHED_PRIO_TO_WEIGHT, expectedShares, fairStats, latencyScenario, niceToWeight, schedPeriod, sleeperScenario,
  type FairEntity, type FairTaskSpec, type VruntimeSample,
} from "../../sims/os/scheduling";
import { Gantt, SmallTable, cpuRow, f1, f2, jobColor } from "./SchedulingGantt";

// ------------------------------------------------------------------------------------------------
// Nice to weight
// ------------------------------------------------------------------------------------------------

export function NiceRatioDemo() {
  const p = useParams("sched-nice", {
    a: range({ label: "Nice of task A", min: -20, max: 19, step: 1, default: 0 }),
    b: range({ label: "Nice of task B", min: -20, max: 19, step: 1, default: 1 }),
  });
  const { a, b } = p.values;
  const wa = niceToWeight(a), wb = niceToWeight(b);
  const [sa, sb] = expectedShares([wa, wb]) as [number, number];
  const [ref, w] = useWidth<HTMLDivElement>();
  const logMax = Math.log(SCHED_PRIO_TO_WEIGHT[0]!), logMin = Math.log(15);
  const barH = (v: number) => 6 + 54 * ((Math.log(v) - logMin) / (logMax - logMin));
  const n = SCHED_PRIO_TO_WEIGHT.length;
  const bw = (w - 2) / n;
  return (
    <Demo title="Nice value, weight and CPU share" controls={<Controls params={p} />}>
      <div style={{ display: "flex", height: 26, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)", fontSize: 12, fontWeight: 600, color: "var(--bg)" }}>
        <div style={{ width: `${sa * 100}%`, background: "var(--c1)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", whiteSpace: "nowrap", transition: "width .2s" }}>{sa > 0.14 ? `A ${pct(sa)}` : ""}</div>
        <div style={{ width: `${sb * 100}%`, background: "var(--c2)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", whiteSpace: "nowrap", transition: "width .2s" }}>{sb > 0.14 ? `B ${pct(sb)}` : ""}</div>
      </div>
      <SmallLabel><span style={{ display: "block", marginTop: 10 }}>The weight table, on a log scale. Nice -20 is on the left, nice 19 on the right.</span></SmallLabel>
      <div ref={ref}>
        <svg width={w} height={68} style={{ display: "block" }}>
          {SCHED_PRIO_TO_WEIGHT.map((v, i) => {
            const nice = i - 20;
            const h = barH(v);
            return <rect key={i} x={1 + i * bw} y={66 - h} width={Math.max(1, bw - 1)} height={h} fill={nice === a ? "var(--c1)" : nice === b ? "var(--c2)" : "var(--faint)"} opacity={nice === a || nice === b ? 1 : 0.5} />;
          })}
        </svg>
      </div>
      <Stats items={[
        { label: "weight of A", value: wa },
        { label: "weight of B", value: wb },
        { label: "A's CPU over B's", value: `${f2(wa / wb)} times` },
        { label: "vruntime rate of A", value: `${f2(1024 / wa)} per ms` },
        { label: "vruntime rate of B", value: `${f2(1024 / wb)} per ms` },
      ]} />
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// CFS simulator: number line, tree, shares
// ------------------------------------------------------------------------------------------------

function VruntimeLine({ sim }: { sim: FairSim }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const run = sim.runnable();
  const vs = run.map((e) => e.vruntime);
  const mid = sim.minVruntime;
  const hi = Math.max(mid + 24, ...vs);
  const lo = mid - 2;
  const x = (v: number) => 12 + ((v - lo) / (hi - lo)) * (w - 24);
  // Labels of close dots go on separate tiers, so they stay readable.
  const tier = new Map<number, number>();
  let lastX = -Infinity, t = 0;
  for (const e of [...run].sort((a, b) => a.vruntime - b.vruntime)) {
    t = x(e.vruntime) - lastX < 14 ? (t + 1) % 3 : 0;
    tier.set(e.id, t);
    lastX = x(e.vruntime);
  }
  return (
    <div ref={ref}>
      <svg width={w} height={78} style={{ display: "block" }}>
        <line x1={8} x2={w - 8} y1={54} y2={54} stroke="var(--border)" />
        <line x1={x(mid)} x2={x(mid)} y1={46} y2={62} stroke="var(--fg)" strokeWidth={1.5} />
        <text x={Math.max(50, x(mid))} y={74} textAnchor="middle" style={{ fontSize: 10.5, fill: "var(--muted)" }}>min_vruntime {f1(mid)}</text>
        {run.map((e) => {
          const isCurr = e === sim.curr;
          return (
            <g key={e.id} transform={`translate(${x(e.vruntime)},54)`} style={{ transition: "transform .12s linear" }}>
              <circle r={isCurr ? 8 : 6.5} fill={jobColor(e.id)} stroke={isCurr ? "var(--fg)" : "none"} strokeWidth={2} />
              <text y={-12 - 13 * (tier.get(e.id) ?? 0)} textAnchor="middle" style={{ fontSize: 11, fontWeight: 600, fill: "var(--fg)" }}>{e.name}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TreeView({ sim }: { sim: FairSim }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const nodes = sim.tree.layout();
  const n = Math.max(1, nodes.length);
  const depth = Math.max(1, ...nodes.map((d) => d.depth + 1));
  const dy = 38;
  const px = (x: number) => ((x + 0.5) / n) * w;
  const py = (d: number) => 18 + d * dy;
  const h = Math.max(46, depth * dy + 4);
  return (
    <div ref={ref}>
      <svg width={w} height={h} style={{ display: "block" }}>
        {nodes.map((d) => d.parentX !== null && <line key={`e${d.value.id}`} x1={px(d.x)} y1={py(d.depth)} x2={px(d.parentX)} y2={py(d.parentDepth!)} stroke="var(--border)" strokeWidth={1.5} />)}
        {nodes.map((d) => (
          <g key={d.value.id} transform={`translate(${px(d.x)},${py(d.depth)})`}>
            <circle r={14} fill={d.color === "red" ? "var(--c4)" : "var(--fg)"} stroke={d.x === 0 ? "var(--c3)" : "none"} strokeWidth={3} />
            <text dy="0.32em" textAnchor="middle" style={{ fontSize: 11, fontWeight: 700, fill: "var(--bg)" }}>{d.value.name}</text>
          </g>
        ))}
        {!nodes.length && <text x={w / 2} y={22} textAnchor="middle" style={{ fontSize: 12, fill: "var(--muted)" }}>The tree is empty. The only task is on the CPU.</text>}
      </svg>
    </div>
  );
}

const CFS_START: FairTaskSpec[] = [{ name: "A", nice: 0 }, { name: "B", nice: 0 }, { name: "C", nice: 5 }];
const LETTERS = "ABCDEFGHIJKL";

function makeCfs(specs: FairTaskSpec[]) {
  const s = new FairSim({ policy: "cfs", keep: 120 });
  for (const x of specs) s.add(x);
  return s;
}

export function CfsSimDemo() {
  const [nice, setNice] = useState(0);
  const specs = useRef<FairTaskSpec[]>(CFS_START);
  const simRef = useRef<FairSim>(makeCfs(CFS_START));
  const [speed, setSpeed] = useState(16);
  const [, force] = useState(0);
  const sim = simRef.current;
  const loop = useSim({
    step: (dt) => sim.advance(dt * speed),
    reset: () => { simRef.current = makeCfs(specs.current); },
    dt: 1 / 60,
  });
  const live = sim.entities.filter((e) => e.state !== "gone");
  const shares = useMemo(() => expectedShares(live.map((e) => e.weight)), [live.map((e) => e.weight).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = live.reduce((a, e) => a + e.sumExec, 0);
  const add = () => {
    const name = LETTERS[sim.entities.length % LETTERS.length]!;
    const spec = { name, nice };
    specs.current = [...specs.current, spec];
    sim.add(spec);
    force((x) => x + 1);
  };
  const remove = (e: FairEntity) => { sim.remove(e.id); specs.current = specs.current.filter((x) => x.name !== e.name); force((x) => x + 1); };
  const nextPick = () => {
    const c = sim.curr;
    for (let i = 0; i < 400 && (sim.curr === c || !sim.curr); i++) sim.advance(0.25);
    force((x) => x + 1);
  };
  const reset = () => loop.reset();
  const clearShares = () => { for (const e of sim.entities) e.sumExec = 0; force((x) => x + 1); };
  const window = 96;
  const nr = sim.runnable().length;
  const period = schedPeriod(sim.cfs, nr);
  return (
    <Demo
      title="CFS: the task with the smallest vruntime runs next"
      actions={<><button className="btn" onClick={loop.toggle}>{loop.running ? "Pause" : "Play"}</button><button className="btn" onClick={nextPick} disabled={loop.running}>Next pick</button><button className="btn ghost" onClick={reset}>Reset</button></>}
      controls={
        <>
          <Param spec={range({ label: "Nice of the next task", min: -20, max: 19, step: 1, default: 0, format: (v) => `${v} (weight ${niceToWeight(v)})` })} value={nice} onChange={(v) => setNice(v as number)} />
          <Param spec={range({ label: "Speed", min: 2, max: 200, default: 16, log: true, format: (v) => `${Math.round(v)} ms/s` })} value={speed} onChange={(v) => setSpeed(v as number)} />
          <div className="row"><button className="btn primary" onClick={add} disabled={live.length >= 10}>Add a task</button><button className="btn" onClick={clearShares}>Clear the CPU counters</button></div>
        </>
      }
    >
      <SmallLabel>vruntime number line. A dark ring marks the task on the CPU.</SmallLabel>
      <VruntimeLine sim={sim} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <SmallLabel>Red-black tree of waiting tasks. The running task is not in the tree. The green ring marks the leftmost node, which runs next.</SmallLabel>
          <TreeView sim={sim} />
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>CPU share against the weight share (dark tick)</SmallLabel>
          {live.map((e, i) => {
            const got = total > 0 ? e.sumExec / total : 0;
            return (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginBottom: 3, ...mono }}>
                <b style={{ width: 14, color: jobColor(e.id) }}>{e.name}</b>
                <span className="muted" style={{ width: 62, whiteSpace: "nowrap" }}>nice {e.nice}</span>
                <div style={{ flex: 1, height: 12, position: "relative", background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 2, minWidth: 40 }}>
                  <div style={{ width: `${got * 100}%`, height: "100%", background: jobColor(e.id) }} />
                  <div style={{ position: "absolute", top: -2, bottom: -2, left: `${shares[i]! * 100}%`, width: 2, background: "var(--fg)" }} />
                </div>
                <span style={{ width: 92, textAlign: "right", whiteSpace: "nowrap" }}>{pct(got)} / {pct(shares[i]!)}</span>
                <button className="btn ghost" style={{ padding: "0 4px" }} aria-label={`Remove ${e.name}`} onClick={() => remove(e)} disabled={live.length <= 1}>x</button>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <Gantt rows={[cpuRow(sim.trace(), "CPU")]} start={Math.max(0, sim.now - window)} end={Math.max(window, sim.now)} labelW={34} />
      </div>
      <Stats items={[
        { label: "simulated time", value: `${f1(sim.now)} ms` },
        { label: "sched period", value: `${f1(period)} ms` },
        { label: `slice of ${sim.curr?.name ?? "–"}`, value: sim.curr ? `${f2(sim.idealSlice(sim.curr))} ms` : "–" },
        { label: "runnable", value: nr },
      ]} />
      <Note>The model uses the tunables of a machine with 8 or more CPUs: 24 ms latency and 3 ms minimum granularity.</Note>
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Sleeper fairness
// ------------------------------------------------------------------------------------------------

export function SleeperDemo() {
  const p = useParams("sched-sleeper", {
    sleep: range({ label: "How long B sleeps", min: 20, max: 300, step: 10, default: 200, format: (v) => `${v} ms` }),
    clamp: toggle({ label: "Limit the credit of a sleeper (GENTLE_FAIR_SLEEPERS)", default: true }),
  });
  const { sleep, clamp } = p.values;
  const r = useMemo(() => sleeperScenario(clamp, sleep, 500), [clamp, sleep]);
  const sm = r.sim.samples;
  const line = (i: number) => sm.map((s) => [s.t, s.v[i]!] as [number, number]);
  const maxV = Math.max(...sm.map((s) => Math.max(...s.v)));
  const color = (id: number) => (id === 0 ? "var(--c1)" : "var(--c2)");
  return (
    <Demo title="A task wakes after a long sleep" controls={<Controls params={p} />}>
      <Plot x={[0, 500]} y={[0, maxV * 1.05]} height={180} xLabel="time (ms)" yLabel="vruntime">
        <Line points={line(0)} color="var(--c1)" />
        <Line points={line(1)} color="var(--c2)" />
        <RuleX at={r.wokeAt} color="var(--faint)" label="B wakes" />
      </Plot>
      <Legend items={[{ label: "A (always runnable)", color: "var(--c1)" }, { label: "B (sleeps once)", color: "var(--c2)" }]} />
      <Gantt rows={[cpuRow(r.sim.trace(), "CPU", 0, color)]} end={500} labelW={34} />
      <Stats items={[
        { label: "B runs without a break after it wakes", value: `${f1(r.longestRun)} ms` },
        { label: "A's share of the CPU in 500 ms", value: pct(r.sim.shares()[0]!) },
      ]} />
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// CFS and EEVDF side by side
// ------------------------------------------------------------------------------------------------

const SAMPLE_UNTIL = 120;

function sampleAt(ss: VruntimeSample[], t: number): VruntimeSample | null {
  let best: VruntimeSample | null = null;
  for (const s of ss) { if (s.t <= t + 1e-9) best = s; else break; }
  return best;
}

function VirtualTimeLine({ sample, names, color }: { sample: VruntimeSample; names: string[]; color: (id: number) => string }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const labelW = 26;
  const live = names.map((_, i) => i).filter((i) => sample.state[i] === "queued" || sample.state[i] === "running");
  const lo = Math.min(sample.V, ...live.map((i) => sample.v[i]!)) - 0.5;
  const hi = Math.max(sample.V, ...live.map((i) => sample.deadline[i]!)) + 0.5;
  const x = (v: number) => labelW + ((v - lo) / (hi - lo)) * (w - labelW - 8);
  const rowH = 20;
  const h = names.length * rowH + 22;
  const firstDeadline = Math.min(...live.filter((i) => sample.v[i]! <= sample.V + 1e-7).map((i) => sample.deadline[i]!));
  return (
    <div ref={ref}>
      <svg width={w} height={h} style={{ display: "block" }}>
        <rect x={0} y={0} width={Math.max(0, x(sample.V))} height={h - 18} fill="var(--c3)" opacity={0.1} />
        <line x1={x(sample.V)} x2={x(sample.V)} y1={0} y2={h - 18} stroke="var(--c3)" strokeWidth={1.5} />
        <text x={2} y={h - 5} style={{ fontSize: 10.5, fill: "var(--c3)" }}>The green line is V. A task to its left is eligible.</text>
        {names.map((n, i) => {
          const y = i * rowH + 3;
          const on = live.includes(i);
          const isNext = on && sample.v[i]! <= sample.V + 1e-7 && sample.deadline[i] === firstDeadline;
          return (
            <g key={n} opacity={on ? 1 : 0.35}>
              <text x={labelW - 6} y={y + 7} dy="0.32em" textAnchor="end" style={{ fontSize: 11, fill: "var(--muted)" }}>{n}</text>
              {on && (
                <>
                  <line x1={x(sample.v[i]!)} x2={x(sample.deadline[i]!)} y1={y + 7} y2={y + 7} stroke={color(i)} strokeWidth={isNext ? 3 : 1.5} />
                  <circle cx={x(sample.v[i]!)} cy={y + 7} r={4.5} fill={color(i)} stroke={sample.running === i ? "var(--fg)" : "none"} strokeWidth={1.5} />
                  <line x1={x(sample.deadline[i]!)} x2={x(sample.deadline[i]!)} y1={y + 1} y2={y + 13} stroke={color(i)} strokeWidth={2} />
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function CfsEevdfDemo() {
  const p = useParams("sched-eevdf", {
    hogs: range({ label: "CPU hogs", min: 1, max: 6, step: 1, default: 3 }),
    slice: range({ label: "Slice that L requests", min: 0.5, max: 6, step: 0.5, default: 1, format: (v) => `${v} ms` }),
    at: range({ label: "Show virtual time at", min: 0, max: SAMPLE_UNTIL, step: 0.5, default: 24, format: (v) => `${v} ms` }),
    mode: seg("L", [["steady", "always runnable"], ["periodic", "1 ms of work, then 7 ms asleep"]], "steady"),
    delayed: toggle({ label: "EEVDF: Linux 6.12 delayed dequeue", default: false }),
  });
  const { hogs, slice, at, mode, delayed } = p.values;
  const r = useMemo(
    () => latencyScenario({ hogs, latencySlice: slice, mode: mode as "steady" | "periodic", delayedDequeue: delayed, sampleUntil: SAMPLE_UNTIL + 1 }),
    [hogs, slice, mode, delayed],
  );
  const color = (id: number) => (id === 0 ? "var(--c4)" : ["var(--c1)", "var(--c5)", "var(--c3)"][(id - 1) % 3]!);
  const a = fairStats(r.cfs), b = fairStats(r.eevdf);
  const sample = sampleAt(r.eevdf.samples, at) ?? r.eevdf.samples[0]!;
  const names = r.tasks.map((t) => t.name);
  const end = 72;
  const start = Math.max(0, Math.min(at - end / 2, SAMPLE_UNTIL + 1 - end));
  return (
    <Demo title="L asks for a short slice" controls={<Controls params={p} />}>
      <SmallLabel>The same tasks under each scheduler. L is red. The dark line is the moment below.</SmallLabel>
      <Gantt rows={[cpuRow(r.cfs.trace(), "CFS", 0, color), cpuRow(r.eevdf.trace(), "EEVDF", 0, color)]} start={start} end={start + end} cursor={at} labelW={46} />
      <SmallTable
        right
        head={["Task L, 1 s", "Share", "Mean wait", "Longest wait"]}
        rows={[
          ["CFS", pct(a[0]!.share), `${f2(a[0]!.meanWait)} ms`, `${f2(a[0]!.maxWait)} ms`],
          ["EEVDF", pct(b[0]!.share), `${f2(b[0]!.meanWait)} ms`, `${f2(b[0]!.maxWait)} ms`],
        ]}
      />
      <Note>The fair share with {hogs + 1} equal tasks is {pct(1 / (hogs + 1))}.</Note>
      <div style={{ marginTop: 10 }}>
        <SmallLabel>EEVDF virtual time at {f1(at)} ms. A dot is a task's vruntime. A tick is its virtual deadline. The thick line is the next pick: eligible, with the earliest deadline.</SmallLabel>
        <VirtualTimeLine sample={sample} names={names} color={color} />
      </div>
    </Demo>
  );
}
