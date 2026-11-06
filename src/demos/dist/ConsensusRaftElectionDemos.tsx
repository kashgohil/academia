/** Demos for "Raft leader election": a live 5-server cluster you can break, and a sweep of election time vs timeout spread. */
import { useEffect, useMemo } from "react";
import {
  Btn, ButtonRow, Demo, Dots, Legend, Line, Param, Plot, RuleY, SmallLabel, Stats, Note, range, seg, toggle, useChunked, useParams, int,
} from "../../kit";
import { SpaceTime } from "./SpaceTime";
import { Ring, connectedIn, sname, stMarks, stMessages, useLiveCluster } from "./ConsensusRaftUi";
import { RaftCluster } from "../../sims/dist/consensus/raft/raft";
import { SPREADS, electionPoint, type SweepPoint } from "../../sims/dist/consensus/raft/scenarios";
import type { KvCmd } from "../../sims/dist/consensus/raft/machine";

const LIVE = {
  min: range({ label: "Election timeout: minimum", min: 50, max: 400, step: 10, default: 150, format: (v) => `${v} ms` }),
  spread: range({ label: "Random spread above the minimum", min: 0, max: 300, step: 5, default: 150, format: (v) => `${v} ms` }),
  speed: seg("Speed", [["40", "slow"], ["120", "normal"], ["400", "fast"]], "120"),
  preVote: toggle({ label: "Pre-vote", default: false }),
  checkQuorum: toggle({ label: "Check-quorum", default: false }),
};

const WINDOW = 700;

export function ConsensusRaftElectionDemo() {
  const P = useParams("raft-elect", LIVE);
  const { min, spread, preVote, checkQuorum } = P.values;
  const make = () =>
    new RaftCluster<KvCmd>({
      servers: 5,
      net: { seed: 7, latency: { min: 5, max: 15 } },
      raft: { electionTimeout: { min, max: min + spread }, heartbeat: 50, preVote, checkQuorum },
    });
  const L = useLiveCluster(make, Number(P.values.speed));
  const c = L.c;
  useEffect(() => {
    c.setOptions({ electionTimeout: { min, max: min + spread }, preVote, checkQuorum });
  }, [c, min, spread, preVote, checkQuorum]);

  const nodes = L.nodes();
  const leader = c.leader();
  const now = c.now;
  const t0 = Math.max(0, now - WINDOW);
  const msgs = stMessages(L.recent(WINDOW));
  const marks = stMarks(c, t0, now);

  // Elections and split votes, from the event list.
  const candTerms = new Set<number>(), leadTerms = new Set<number>();
  for (const e of c.events) {
    if (e.kind === "role" && e.role === "candidate") candTerms.add(e.term);
    if (e.kind === "role" && e.role === "leader") leadTerms.add(e.term);
  }
  const top = Math.max(...nodes.map((n) => n.term));
  const split = [...candTerms].filter((t) => !leadTerms.has(t) && t < top).length;

  const others = (x: number) => [0, 1, 2, 3, 4].filter((i) => i !== x);
  const follower = () => others(leader ?? -1).find((i) => c.isUp(i)) ?? 0;

  return (
    <Demo
      title="Five servers electing a leader"
      actions={<><Btn onClick={L.toggle}>{L.playing ? "Pause" : "Play"}</Btn><Btn onClick={() => L.step(20)} disabled={L.playing}>+20 ms</Btn><Btn ghost onClick={L.reset}>Reset</Btn></>}
      controls={<>
        <Param spec={LIVE.min} value={min} onChange={(v) => P.set("min", v as number)} />
        <Param spec={LIVE.spread} value={spread} onChange={(v) => P.set("spread", v as number)} />
        <Param spec={LIVE.speed} value={P.values.speed} onChange={(v) => P.set("speed", v as never)} />
        <Param spec={LIVE.preVote} value={preVote} onChange={(v) => P.set("preVote", v as boolean)} />
        <Param spec={LIVE.checkQuorum} value={checkQuorum} onChange={(v) => P.set("checkQuorum", v as boolean)} />
      </>}
    >
      <ButtonRow>
        <Btn onClick={() => L.act((x) => leader !== null && x.crash(leader))} disabled={leader === null}>Crash the leader</Btn>
        <Btn onClick={() => L.act((x) => [0, 1, 2, 3, 4].forEach((i) => x.recover(i)))}>Recover all</Btn>
        <Btn onClick={() => L.act((x) => { const f = follower(); x.partition([[f], others(f)]); })}>Cut off a follower</Btn>
        <Btn onClick={() => L.act((x) => { const a = leader ?? 0; const b = others(a)[0]!; x.partition([[a, b], others(a).slice(1)]); })}>Split 2 | 3</Btn>
        <Btn onClick={() => L.act((x) => x.heal())}>Heal</Btn>
        <Btn onClick={() => L.act((x) => leader !== null && x.propose(leader, { op: "add", key: "x", delta: 1 }))} disabled={leader === null}>Write</Btn>
      </ButtonRow>
      <Ring nodes={nodes} now={now} connected={connectedIn(c)} maxTimeout={min + spread} onNode={(i) => L.act((x) => (x.isUp(i) ? x.crash(i) : x.recover(i)))} sub={(n) => `log ${n.base + n.log.length}`} />
      <SmallLabel>Tap a server to crash or recover it. The orange arc is its election timer. A green arrow is a vote in the newest term.</SmallLabel>
      <SpaceTime nodes={nodes.map((n) => sname(n.id))} tStart={t0} tEnd={Math.max(WINDOW, now)} messages={msgs} marks={marks} rowHeight={34} />
      <Stats items={[
        { label: "time", value: `${int(now)} ms` },
        { label: "leader", value: leader === null ? "none" : `${sname(leader)}, term ${nodes[leader]!.term}` },
        { label: "highest term", value: top },
        { label: "elections started", value: candTerms.size },
        { label: "split or failed rounds", value: split },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- the sweep

const SWEEP = {
  min: range({ label: "Election timeout: minimum", min: 50, max: 300, step: 25, default: 150, format: (v) => `${v} ms` }),
};

export function ConsensusRaftTimeoutSweepDemo() {
  const P = useParams("raft-sweep", SWEEP);
  const min = P.values.min;
  const jobs = useMemo(() => SPREADS.map((s) => () => electionPoint(s, 40, min)), [min]);
  const res = useChunked<SweepPoint>(`sweep-${min}`, jobs, { keep: true });
  const done = res.filter((r): r is SweepPoint => r !== undefined);
  const xOf = (s: number) => SPREADS.indexOf(s);
  const mean = done.map((r) => [xOf(r.spread), r.mean] as [number, number]);
  const p95 = done.map((r) => [xOf(r.spread), r.p95] as [number, number]);
  const at = (s: number) => done.find((r) => r.spread === s);
  const fmt = (v?: number) => (v === undefined ? "…" : v >= 10000 ? "≥ 10 s" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
  return (
    <Demo title="Time to replace a crashed leader" controls={<Param spec={SWEEP.min} value={min} onChange={(v) => P.set("min", v as number)} />}>
      <Plot x={[0, SPREADS.length - 1]} y={[80, 20000]} logY height={250} xTicks={SPREADS.map((_, i) => i)} xFormat={(i) => String(SPREADS[i] ?? "")} yTicks={[100, 300, 1000, 3000, 10000]} yFormat={(v) => (v >= 1000 ? `${v / 1000} s` : `${v}`)} xLabel="random spread above the minimum (ms)" yLabel="ms without a leader">
        <RuleY at={10000} label="cut-off: 10 s" />
        <Line points={p95} color="var(--c2)" dash="5 4" />
        <Line points={mean} color="var(--c1)" />
        <Dots points={mean} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "mean of 40 failovers", color: "var(--c1)" }, { label: "95th percentile", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "no spread: mean", value: fmt(at(0)?.mean) },
        { label: "5 ms spread: mean", value: fmt(at(5)?.mean) },
        { label: "25 ms spread: mean", value: fmt(at(25)?.mean) },
        { label: "150 ms spread: mean", value: fmt(at(150)?.mean) },
        { label: "elections per failover, no spread", value: at(0) ? at(0)!.rounds.toFixed(1) : "…" },
      ]} />
      <Note>Each point crashes the leader of a 5-server cluster 40 times (one-way latency 5–15 ms, heartbeat 50 ms; both are model inputs) and measures the time until a new leader exists.</Note>
    </Demo>
  );
}
