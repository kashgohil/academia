/** Demos for "Raft membership changes and snapshots": a configuration change stepper and a lagging follower that needs a snapshot. */
import { useMemo } from "react";
import {
  Banner, Demo, Legend, Line, Note, Panel, Param, Plot, RuleX, SmallLabel, StepButtons, StepCaption, StepSlider, Stats,
  bytes, int, mono, range, seg, toggle, useParams, useStepper,
} from "../../kit";
import { SpaceTime } from "./SpaceTime";
import { LogGrid, ROLE_COLOR, frameSpan, sname, stMessages } from "./ConsensusRaftUi";
import { membership, snapshotRun, type MembershipMode } from "../../sims/dist/consensus/raft/scenarios";

// ============================================================================ 1. membership stepper

const MEM = {
  mode: seg("Change", [["direct", "direct switch"], ["joint", "joint consensus"], ["single", "one at a time"], ["bug2015", "2015 bug"]], "direct"),
  rule: toggle({ label: "2015 rule: commit an entry of your term first", default: false }),
};

const SIDE = ["var(--c1)", "var(--c5)", "var(--c2)", "var(--c3)", "var(--c4)"];

export function ConsensusRaftMembershipDemo() {
  const P = useParams("raft-member", MEM);
  const mode = P.values.mode as MembershipMode;
  const frames = useMemo(() => membership(mode, P.values.rule), [mode, P.values.rule]);
  const s = useStepper(frames.length, 0.6);
  const f = frames[s.i]!;
  const bad = f.violations;
  const sideOf = (i: number) => (f.groups ? f.groups.findIndex((g) => g.includes(i)) : -1);
  return (
    <Demo
      title="Changing the members of a cluster"
      actions={<StepButtons s={s} />}
      controls={<>
        <StepSlider s={s} />
        <Param spec={MEM.mode} value={mode} onChange={(v) => P.set("mode", v as never)} />
        {mode === "bug2015" && <Param spec={MEM.rule} value={P.values.rule} onChange={(v) => P.set("rule", v as boolean)} />}
      </>}
    >
      <StepCaption label={`${s.i + 1}/${frames.length}`} tone={bad.length ? "bad" : null}>{f.caption}</StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 6, marginTop: 10 }}>
        {f.nodes.map((n) => {
          const side = sideOf(n.id);
          const lead = n.up && n.role === "leader";
          return (
            <Panel key={n.id} active={lead} accent={side >= 0 ? SIDE[side] : undefined} style={{ opacity: n.up ? 1 : 0.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                <b>{sname(n.id)}</b>
                <span style={{ ...mono, fontSize: 11.5, color: n.up ? ROLE_COLOR[n.role] : "var(--faint)", fontWeight: lead ? 700 : 400 }}>{n.up ? `${n.role === "follower" ? "" : `${n.role} `}t${n.term}` : "down"}</span>
              </div>
              <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>uses</div>
              <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.3, wordBreak: "break-word", color: n.voter ? "var(--fg)" : "var(--faint)" }}>{n.config.replace("+", " + ")}</div>
            </Panel>
          );
        })}
      </div>
      <SmallLabel style={{ marginTop: 4 }}>A colored top edge marks each side of a network split. A server uses the newest configuration in its log, committed or not.</SmallLabel>
      <div style={{ marginTop: 8 }}>
        <LogGrid nodes={f.nodes} from={1} cols={7} applied={f.applied} />
      </div>
      <SpaceTime nodes={f.nodes.map((n) => sname(n.id))} tStart={frameSpan(f)[0]} tEnd={frameSpan(f)[1]} messages={stMessages(f.msgs, { heartbeats: false })} rowHeight={26} />
      {bad.length > 0
        ? <Banner tone="bad" label={bad.some((v) => v.property === "Election Safety") ? "two leaders" : "broken"}>{[...bad].sort((a, b) => Number(b.property === "Election Safety") - Number(a.property === "Election Safety")).slice(0, 3).map((v) => `${v.property}: ${v.detail}.`).join(" ")}</Banner>
        : <Banner tone="good" label="safe">Every pair of quorums so far shares a server, so no two leaders share a term and no committed entry is lost.</Banner>}
    </Demo>
  );
}

// ============================================================================ 2. snapshots and a lagging follower

const SNAP = {
  threshold: range({ label: "Snapshot after this many applied entries", min: 0, max: 60, step: 5, default: 20, format: (v) => (v === 0 ? "never" : `${v}`) }),
  chunk: range({ label: "InstallSnapshot chunk size", min: 50, max: 400, step: 50, default: 100, format: (v) => `${v} B` }),
  rejoin: range({ label: "The follower comes back at", min: 400, max: 1400, step: 50, default: 900, format: (v) => `${v} ms` }),
};
const SERVER_COLOR = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];

export function ConsensusRaftSnapshotDemo() {
  const P = useParams("raft-snap", SNAP);
  const { threshold, chunk, rejoin } = P.values;
  const run = useMemo(() => snapshotRun({ threshold, chunk, rejoinAt: rejoin }), [threshold, chunk, rejoin]);
  const lag = run.lag;
  const maxLen = Math.max(10, ...run.series.map((p) => Math.max(...p.len)));
  const lines = [0, 1, 2, 3, 4].map((i) => run.series.map((p) => [p.t, p.len[i]!] as [number, number]));
  const tFirst = run.msgs.length ? run.msgs[0]!.sentAt : 0;
  return (
    <Demo title="Log compaction and a follower that falls behind" controls={<>
      <Param spec={SNAP.threshold} value={threshold} onChange={(v) => P.set("threshold", v as number)} />
      <Param spec={SNAP.chunk} value={chunk} onChange={(v) => P.set("chunk", v as number)} />
      <Param spec={SNAP.rejoin} value={rejoin} onChange={(v) => P.set("rejoin", v as number)} />
    </>}>
      <Plot x={[0, 1600]} y={[0, maxLen * 1.08]} height={220} xLabel="time (ms)" yLabel="entries kept in the log">
        <RuleX at={200} label="cut off" />
        <RuleX at={rejoin} label="back" />
        {lines.map((pts, i) => <Line key={i} points={pts} color={SERVER_COLOR[i]} width={i === lag ? 3 : 1.5} />)}
      </Plot>
      <Legend items={[0, 1, 2, 3, 4].map((i) => ({ label: i === lag ? `${sname(i)} (falls behind)` : sname(i), color: SERVER_COLOR[i]! }))} />
      <SmallLabel style={{ marginTop: 8 }}>Messages between the leader and {sname(lag)} in the 120 ms after it comes back</SmallLabel>
      <SpaceTime nodes={[0, 1, 2, 3, 4].map(sname)} tStart={tFirst} tEnd={tFirst + 120} messages={stMessages(run.msgs.map((m) => ({ ...m, label: m.label && m.type !== "AppendEntriesReply" ? " " : m.label })), { heartbeats: false }).map((m) => ({ ...m, label: undefined }))} rowHeight={26} />
      <Legend items={[{ label: "InstallSnapshot chunk and reply", color: "var(--c5)" }, { label: "AppendEntries with entries", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "catch-up data sent", value: bytes(run.catchupBytes) },
        { label: "catch-up messages", value: run.catchupMessages },
        { label: "catch-up time", value: Number.isFinite(run.catchupMs) ? `${int(run.catchupMs)} ms` : "–" },
        { label: "snapshots installed", value: run.installs },
        { label: "snapshot size", value: run.snapshotBytes ? bytes(run.snapshotBytes) : "–" },
      ]} />
      {run.violations.length > 0
        ? <Banner tone="bad">{run.violations[0]!.detail}</Banner>
        : <Banner tone="good">{run.converged ? `${sname(lag)} ends with the same state machine as the leader.` : `${sname(lag)} has not caught up yet.`}</Banner>}
      <Note>A client writes one entry every 8 ms to 10 counters, so the state stays small while the log grows. Sizes are the bytes of the JSON that the simulation sends.</Note>
    </Demo>
  );
}
