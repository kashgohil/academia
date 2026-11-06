/** Demos for "Raft log replication": a live log view, the Figure 8 stepper, throughput with batching and pipelining, and client sessions. */
import { useMemo, useRef } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Dots, Legend, Line, Note, Param, Plot, SmallLabel, StepButtons, StepCaption, StepSlider, Stats,
  int, pct, range, seg, toggle, useChunked, useParams, useStepper,
} from "../../kit";
import { SpaceTime } from "./SpaceTime";
import { LogGrid, frameSpan, sname, stMarks, stMessages, useLiveCluster } from "./ConsensusRaftUi";
import { RaftCluster } from "../../sims/dist/consensus/raft/raft";
import { LOAD_CLIENTS, LOAD_MODES, figure8, loadRun, sessionRun, type Frame, type LoadResult } from "../../sims/dist/consensus/raft/scenarios";
import type { KvCmd } from "../../sims/dist/consensus/raft/machine";

// ============================================================================ 1. live log view

const LIVE = {
  drop: range({ label: "Messages lost", min: 0, max: 0.5, step: 0.01, default: 0, format: (v) => pct(v, 0) }),
  speed: seg("Speed", [["40", "slow"], ["120", "normal"], ["400", "fast"]], "120"),
  writes: toggle({ label: "A client writes every 80 ms", default: true }),
  hb: toggle({ label: "Show heartbeats", default: false }),
};

const WINDOW = 500;

export function ConsensusRaftReplicationDemo() {
  const P = useParams("raft-log", LIVE);
  const make = () => {
    const c = new RaftCluster<KvCmd>({
      servers: 5,
      net: { seed: 11, latency: { min: 5, max: 15 } },
      raft: { electionTimeout: { min: 300, max: 500 }, heartbeat: 60, retransmit: 120, maxInflight: 2, maxBatch: 4 },
    });
    c.runUntilTrue(() => c.leader() !== null, 3000); // start with a leader in place
    return c;
  };
  // A client that writes x=1, x=2, ... through every server that thinks it leads (an old leader may not know it lost).
  const seq = useRef({ next: 1, last: 0 });
  const writeTo = (x: RaftCluster<KvCmd>) => {
    const v = seq.current.next++;
    for (const n of x.nodes) if (x.isUp(n.id) && n.role === "leader") x.propose(n.id, { op: "set", key: "x", value: v });
  };
  const L = useLiveCluster(make, Number(P.values.speed), (x) => {
    x.net.cfg.dropRate = P.values.drop;
    if (P.values.writes && x.now - seq.current.last >= 80) {
      seq.current.last = x.now;
      writeTo(x);
    }
  });
  const c = L.c;

  const nodes = L.nodes();
  const leader = c.leader();
  const t0 = Math.max(0, c.now - WINDOW);
  const truncs = c.events.filter((e) => e.kind === "truncate");
  const lost = c.net.messages.filter((m) => m.lost === "dropped").length;
  const others = (x: number) => [0, 1, 2, 3, 4].filter((i) => i !== x);
  return (
    <Demo
      title="Five logs, one leader"
      actions={<><Btn onClick={L.toggle}>{L.playing ? "Pause" : "Play"}</Btn><Btn onClick={() => L.step(20)} disabled={L.playing}>+20 ms</Btn><Btn ghost onClick={() => { seq.current = { next: 1, last: 0 }; L.reset(); }}>Reset</Btn></>}
      controls={<>
        <Param spec={LIVE.drop} value={P.values.drop} onChange={(v) => P.set("drop", v as number)} />
        <Param spec={LIVE.speed} value={P.values.speed} onChange={(v) => P.set("speed", v as never)} />
        <Param spec={LIVE.writes} value={P.values.writes} onChange={(v) => P.set("writes", v as boolean)} />
        <Param spec={LIVE.hb} value={P.values.hb} onChange={(v) => P.set("hb", v as boolean)} />
      </>}
    >
      <ButtonRow>
        <Btn onClick={() => L.act(writeTo)}>Write once</Btn>
        <Btn onClick={() => L.act((x) => { const a = leader ?? 0; x.partition([[a, others(a)[0]!], others(a).slice(1)]); })} disabled={leader === null}>Cut the leader off with one follower</Btn>
        <Btn onClick={() => L.act((x) => x.heal())}>Heal</Btn>
        <Btn onClick={() => L.act((x) => leader !== null && x.crash(leader))} disabled={leader === null}>Crash the leader</Btn>
      </ButtonRow>
      <ButtonRow style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Crash or recover:</span>
        {nodes.map((n) => <Chip key={n.id} color={n.up ? "var(--fg)" : "var(--c4)"} dashed={!n.up} onClick={() => L.act((x) => (n.up ? x.crash(n.id) : x.recover(n.id)))}>{sname(n.id)} {n.up ? "up" : "down"}</Chip>)}
      </ButtonRow>
      <div style={{ marginTop: 10 }}>
        <LogGrid nodes={nodes} />
      </div>
      <SmallLabel style={{ marginTop: 4 }}>The number is the term. Solid: committed on that server. Dashed: not yet. A dot: applied to its state machine. Grey: inside a snapshot.</SmallLabel>
      <SpaceTime nodes={nodes.map((n) => sname(n.id))} tStart={t0} tEnd={Math.max(WINDOW, c.now)} messages={stMessages(L.recent(WINDOW), { heartbeats: P.values.hb })} marks={stMarks(c, t0, c.now)} rowHeight={30} />
      <Stats items={[
        { label: "leader", value: leader === null ? "none" : `${sname(leader)}, term ${nodes[leader]!.term}` },
        { label: "commit index (leader)", value: leader === null ? "–" : nodes[leader]!.commitIndex },
        { label: "entries deleted by followers", value: truncs.reduce((a, e) => a + (e.kind === "truncate" ? e.removed : 0), 0) },
        { label: "messages lost", value: int(lost) },
      ]} />
      {truncs.length > 0 && (() => {
        const e = truncs[truncs.length - 1]!;
        return e.kind === "truncate" ? <Note>Last deletion: at {int(e.t)} ms, {sname(e.node)} deleted {e.removed} entr{e.removed === 1 ? "y" : "ies"} from index {e.from}, because they conflicted with the leader's log.</Note> : null;
      })()}
    </Demo>
  );
}

// ============================================================================ 2. Figure 8

const F8 = {
  unsafe: toggle({ label: "Remove the current-term rule", default: false }),
  ending: seg("Ending", [["d", "(d) S1 crashes early"], ["e", "(e) S1 spreads a term 4 entry"]], "d"),
};

export function ConsensusRaftFigure8Demo() {
  const P = useParams("raft-fig8", F8);
  const frames = useMemo(() => figure8(!P.values.unsafe, P.values.ending as "d" | "e"), [P.values.unsafe, P.values.ending]);
  const s = useStepper(frames.length, 0.7);
  const f = frames[s.i]!;
  const bad = f.violations;
  return (
    <Demo
      title="Figure 8: why old-term entries do not commit by counting"
      actions={<StepButtons s={s} />}
      controls={<>
        <StepSlider s={s} />
        <Param spec={F8.unsafe} value={P.values.unsafe} onChange={(v) => P.set("unsafe", v as boolean)} />
        <Param spec={F8.ending} value={P.values.ending} onChange={(v) => P.set("ending", v as never)} />
      </>}
    >
      <StepCaption label={`${s.i + 1}/${frames.length}`} tone={bad.length ? "bad" : null}>{f.caption}</StepCaption>
      <div style={{ marginTop: 10 }}>
        <LogGrid nodes={f.nodes} from={1} cols={3} applied={f.applied} ring={new Set(f.nodes.map((n) => `${n.id}:2`))} side={(n) => (n.up && n.role !== "follower" ? <span style={{ color: "var(--c1)", fontSize: 10.5 }}> {n.role === "leader" ? "L" : "C"}</span> : null)} />
      </div>
      <SmallLabel style={{ marginTop: 4 }}>Index 2 is ringed. A black dot: the server applied this entry. A red dot: it applied a different entry at this index earlier.</SmallLabel>
      <FrameMessages f={f} />
      {bad.length > 0
        ? <Banner tone="bad" label="broken">{bad.map((v) => `${v.property}: ${v.detail}.`).join(" ")}</Banner>
        : <Banner tone="good" label="safe">No server has applied a command that another server replaced. Every committed entry is in every later leader's log.</Banner>}
    </Demo>
  );
}

function FrameMessages({ f, rows }: { f: Frame; rows?: string[] }) {
  const names = rows ?? f.nodes.map((n) => sname(n.id));
  const [a, b] = frameSpan(f);
  return <SpaceTime nodes={names} tStart={a} tEnd={b} messages={stMessages(f.msgs, { heartbeats: false })} rowHeight={26} />;
}

// ============================================================================ 3. throughput and latency

const LOAD = {
  latency: range({ label: "One-way network latency (model input)", min: 1, max: 20, step: 1, default: 5, format: (v) => `${v} ms` }),
  disk: range({ label: "Disk write per append (model input)", min: 0.5, max: 10, step: 0.5, default: 2, format: (v) => `${v} ms` }),
};
const MODE_COLOR = ["var(--c4)", "var(--c2)", "var(--c5)", "var(--c1)"];

export function ConsensusRaftThroughputDemo() {
  const P = useParams("raft-load", LOAD);
  const { latency, disk } = P.values;
  const jobs = useMemo(() => LOAD_MODES.flatMap((m) => LOAD_CLIENTS.map((k) => () => loadRun({ latency, diskMs: disk, maxBatch: m.maxBatch, maxInflight: m.maxInflight, clients: k }, 1000))), [latency, disk]);
  const res = useChunked<LoadResult>(`load-${latency}-${disk}`, jobs, { keep: true });
  const series = LOAD_MODES.map((_, mi) => LOAD_CLIENTS.flatMap((_, ki) => { const r = res[mi * LOAD_CLIENTS.length + ki]; return r && Number.isFinite(r.latency) ? [[r.throughput, r.latency] as [number, number]] : []; }));
  const peak = series.map((pts) => (pts.length ? Math.max(...pts.map((p) => p[0])) : NaN));
  return (
    <Demo title="Throughput and latency of one Raft group" controls={<>
      <Param spec={LOAD.latency} value={latency} onChange={(v) => P.set("latency", v as number)} />
      <Param spec={LOAD.disk} value={disk} onChange={(v) => P.set("disk", v as number)} />
    </>}>
      <Plot x={[20, 30000]} y={[2, 3000]} logX logY height={260} xTicks={[30, 100, 300, 1000, 3000, 10000, 30000]} yTicks={[3, 10, 30, 100, 300, 1000]} xFormat={(v) => (v >= 1000 ? `${v / 1000}k` : `${v}`)} xLabel="commands committed per second" yLabel="mean latency (ms)">
        {series.map((pts, i) => <Line key={i} points={pts} color={MODE_COLOR[i]} />)}
        {series.map((pts, i) => <Dots key={`d${i}`} points={pts} color={MODE_COLOR[i]} r={2.5} />)}
      </Plot>
      <Legend items={LOAD_MODES.map((m, i) => ({ label: m.label, color: MODE_COLOR[i]! }))} />
      <Stats items={LOAD_MODES.map((m, i) => ({ label: `peak: ${m.label}`, value: Number.isFinite(peak[i]!) ? `${int(peak[i]!)}/s` : "…" }))} />
      <Note>3 servers. Each dot is a number of clients (1, 2, 4, … 64), each with one command in flight. Batching: up to 64 entries per AppendEntries. Pipelining: up to 16 AppendEntries in flight per follower. A follower writes each AppendEntries to disk before it replies.</Note>
    </Demo>
  );
}

// ============================================================================ 4. client sessions

const SESS = {
  session: toggle({ label: "Client session (id and sequence number)", default: false }),
};

export function ConsensusRaftSessionDemo() {
  const P = useParams("raft-session", SESS);
  const run = useMemo(() => sessionRun(P.values.session), [P.values.session]);
  const s = useStepper(run.frames.length, 0.7);
  const f = run.frames[s.i]!;
  const last = s.i === run.frames.length - 1;
  return (
    <Demo title="A retry after a lost reply" actions={<StepButtons s={s} />} controls={<Param spec={SESS.session} value={P.values.session} onChange={(v) => P.set("session", v as boolean)} />}>
      <StepCaption label={`${s.i + 1}/${run.frames.length}`}>{f.caption}</StepCaption>
      <div style={{ marginTop: 8 }}>
        <LogGrid nodes={f.nodes} from={1} cols={3} applied={f.applied} />
      </div>
      <FrameMessages f={f} rows={["S1", "S2", "S3", "client"]} />
      {last && (
        <Banner tone={run.value === 1 ? "good" : "bad"} label={`x = ${run.value}`}>
          {run.value === 1 ? "The increment happened once. The session table turned the retry into a lookup." : "The increment happened twice. Raft replicated both copies faithfully: it cannot tell a retry from a new command."}
        </Banner>
      )}
    </Demo>
  );
}
