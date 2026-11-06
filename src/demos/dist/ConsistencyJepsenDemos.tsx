/** Demos for the lesson on checking histories like Jepsen: a mini-Jepsen run with an animated checker, and its cost. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, Param, Plot, SmallLabel, StepButtons, StepCaption, StepSlider, Stats, int, range, seg, sig, useChunked, useParams, useStepper } from "../../kit";
import {
  checkerCostOne, linearizationPoints, miniJepsen, opLabel, registerModel,
  type CostPoint, type HOp, type Nemesis, type ReadPath, type SearchEvent,
} from "../../sims/dist/consistency";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { HistoryView, type OpMark } from "./ConsistencyUi";

const JEPSEN_SCHEMA = {
  run: range({ label: "Run", min: 1, max: 30, step: 1, default: 3 }),
  path: seg<ReadPath>("Store", [["follower", "buggy: any replica reads"], ["readindex", "fixed: ReadIndex"]], "follower"),
  nemesis: seg<Nemesis>("Nemesis", [["none", "none"], ["isolate", "cut off f2"], ["crash", "crash f1"]], "isolate"),
};

const fmt = (o: HOp) => opLabel(o, false).replace(/^w\((\d+)\)$/, "w $1").replace(/^r\(\)=/, "r → ");

/** The search state after `k` trace events: the placed stack and the register value. */
function searchState(trace: SearchEvent[], k: number, byId: Map<number, HOp>) {
  const stack: number[] = [];
  for (let i = 0; i <= k && i < trace.length; i++) {
    const e = trace[i]!;
    if (e.kind === "place") stack.push(e.op);
    else if (e.kind === "back") stack.pop();
  }
  const model = registerModel();
  let x = model.init();
  for (const id of stack) x = model.step(x, byId.get(id)!) ?? x;
  return { stack, x };
}

export function MiniJepsenDemo() {
  const P = useParams("cons-jepsen", JEPSEN_SCHEMA);
  const { run: seed, path, nemesis } = P.values;
  const { run, result } = useMemo(() => miniJepsen(seed, path, nemesis), [seed, path, nemesis]);
  const trace = result.trace!;
  const s = useStepper(trace.length, 8);
  const byId = new Map(run.history.map((o) => [o.id, o]));
  const ev = trace[s.i]!;
  const st = searchState(trace, s.i, byId);
  // At a failed end, show the longest valid start that the search found.
  const failedEnd = ev.kind === "done" && !ev.ok;
  const stack = failedEnd ? result.best : st.stack;
  const x = st.x;
  const done = run.history.filter((o) => Number.isFinite(o.ret));
  const tEnd = Math.ceil(Math.max(...done.map((o) => o.ret)) / 20) * 20 + 10;

  const marks = new Map<number, OpMark>();
  for (const id of stack) marks.set(id, "placed");
  if (ev.kind === "place") marks.set(ev.op, "current");
  if (ev.kind === "reject") marks.set(ev.op, "rejected");
  if (ev.kind === "done" && !ev.ok) for (const id of result.blocked) marks.set(id, "bad");
  const points = linearizationPoints(run.history, stack, tEnd);
  const N = run.cfg.replicas;
  const messages: StMessage[] = run.net.messages.filter((m) => m.sentAt <= tEnd && (m.from >= N || m.to >= N)).map((m) => ({
    from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt,
    color: m.from >= N ? "var(--c1)" : "var(--fg)",
  }));
  const faults: StMark[] = run.cfg.faults.map((f) => ({ node: f.node, t: f.at, until: f.until, shape: "bar", label: f.kind === "crash" ? "crashed" : "cut off", color: "var(--c4)" }));

  const caption = (() => {
    const depth = `(${stack.length} placed)`;
    if (ev.kind === "place") return `Try ${fmt(byId.get(ev.op)!)} next: real time allows it, and the register agrees. Now x = ${x}. ${depth}`;
    if (ev.kind === "reject") return `${fmt(byId.get(ev.op)!)} may come next in real time, but the register holds ${x}. Reject.`;
    if (ev.kind === "back") return `No order works from here. Undo ${fmt(byId.get(ev.op)!)} and try the next candidate. ${depth}`;
    if (ev.kind === "cached") return `These placed operations, with x = ${x}, failed before. The cache skips this branch.`;
    return ev.ok
      ? `Done: a valid order exists. The history is linearizable.`
      : `Done: every order fails. The longest valid start has ${result.best.length} operations; after it, ${result.blocked.map((id) => fmt(byId.get(id)!)).join(" and ")} cannot be placed.`;
  })();

  return (
    <Demo title="Mini-Jepsen: run, break, record, check" actions={<StepButtons s={s} />} controls={<>{(["run", "path", "nemesis"] as const).map((k) => <Param key={k} spec={JEPSEN_SCHEMA[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}<StepSlider s={s} label="Checker step" /></>}>
      <SmallLabel>1. The run: three clients send requests (blue) and get answers (black). Replica traffic is hidden. Red bars are the nemesis.</SmallLabel>
      <SpaceTime nodes={run.nodes} tEnd={tEnd} messages={messages} marks={faults} rowHeight={30} />
      <SmallLabel style={{ marginTop: 8 }}>2. The history, and the checker's search. Green: placed, numbered in order. Bold: the candidate. Red: rejected or impossible.</SmallLabel>
      <HistoryView ops={run.history} tEnd={tEnd} marks={marks} points={points} order={stack} laneName={(c) => `p${c}`} rowHeight={38} timeLabel="time (ms)" />
      <StepCaption tone={ev.kind === "done" ? (ev.ok ? "good" : "bad") : ev.kind === "reject" ? "warn" : "plain"} label={`${s.i + 1}/${trace.length}`}>{caption}</StepCaption>
      <Stats items={[
        { label: "operations", value: done.length },
        { label: "writes that timed out", value: run.history.filter((o) => o.f === "w" && !Number.isFinite(o.ret)).length },
        { label: "configurations", value: int(result.explored) },
        { label: "verdict", value: result.ok ? "linearizable" : "not linearizable" },
      ]} />
    </Demo>
  );
}

// ============================================================================ checker cost

const CLIENTS = [2, 3, 4, 6];
const OPS = [1, 2, 3, 4, 5, 6, 7, 8];
const SEEDS = 5;
const BUDGET = 5e4;
const COLORS = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)"];

const COST_SCHEMA = {
  how: seg("Checker", [["plain", "plain search"], ["memo", "with cache"], ["split", "cache + split by key"]], "memo"),
};

export function CheckerCostDemo() {
  const P = useParams("cons-cost", COST_SCHEMA);
  const how = P.values.how;
  const jobs = useMemo(() => CLIENTS.flatMap((c) => OPS.flatMap((k) => Array.from({ length: SEEDS }, (_, s) => () => checkerCostOne(s + 1, c, k, 4, BUDGET)))), []);
  const res = useChunked("cost", jobs);
  const doneJobs = res.filter(Boolean).length;
  const series = CLIENTS.map((c, ci) => {
    const pts: [number, number][] = [];
    OPS.forEach((k, ki) => {
      const xs = res.slice((ci * OPS.length + ki) * SEEDS, (ci * OPS.length + ki + 1) * SEEDS) as (CostPoint | undefined)[];
      if (xs.some((v) => !v)) return;
      const vals = xs.map((v) => (how === "plain" ? v!.plain : how === "memo" ? v!.memo : v!.partitioned));
      if (vals.some((v) => v === null)) return;
      pts.push([c * k + 1, (vals as number[]).reduce((a, b) => a + b, 0) / SEEDS]);
    });
    return pts;
  });
  const maxPt = (c: number) => series[CLIENTS.indexOf(c)]!.at(-1);
  const six = maxPt(6), two = maxPt(2);
  return (
    <Demo title="What a check costs" controls={<Param spec={COST_SCHEMA.how} value={how} onChange={(v) => P.set("how", v as "memo" | "plain" | "split")} />}>
      <SmallLabel>Hard histories: valid except one stale read at the end, so the checker must rule out every order. Mean over {SEEDS} histories.</SmallLabel>
      <Plot x={[1, 50]} y={[1, BUDGET]} logY height={250} xLabel="operations in the history" yLabel="configurations explored" yFormat={(v) => sig(v, 1)} yTicks={[1, 10, 100, 1000, 10000]}>
        {series.map((pts, i) => <Line key={i} points={pts} color={COLORS[i]} />)}
      </Plot>
      <Legend items={CLIENTS.map((c, i) => ({ label: `${c} clients at once`, color: COLORS[i]! }))} />
      <Banner tone={how === "plain" ? "bad" : "good"}>
        {doneJobs < jobs.length ? `Checking ${int(jobs.length)} histories… ${int(doneJobs)} done.`
          : how === "plain" ? `Without a cache, the cost grows exponentially with the number of operations that overlap. Lines stop where a check passed ${int(BUDGET)} configurations.`
          : how === "memo" ? `With the cache, the same configurations are never searched twice. ${six ? `With 6 clients and ${six[0]} operations, the check needs about ${sig(six[1], 2)} configurations.` : ""}`
          : `Split by key, each register is checked alone, so each search is short. ${two && six ? `It needs about ${sig(six[1], 2)} configurations for 6 clients and ${six[0]} operations.` : ""}`}
      </Banner>
    </Demo>
  );
}
