/** Demos for "Leader-follower": crash the leader and promote a follower; split brain under a partition. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Legend, range, seg, useParams, Banner, Btn, ButtonRow, Panel, SectionLabel, fixed } from "../../kit";
import { LF_DEFAULTS, runLeaderFollower, failover, meanCommitMs, runSplitBrain, sbLostAcked, SB_DEFAULTS, type FollowerMode } from "../../sims/dist/replication";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";
import { Entry, LogRow } from "./ReplicationUi";

const MODE: [FollowerMode, string][] = [["sync", "sync"], ["async", "async"]];

const FAIL = {
  crash: range({ label: "Crash the leader at", min: 10, max: 130, step: 1, default: 115, format: (v) => `${v} ms` }),
  f1: seg("Follower F1", MODE, "sync"),
  f2: seg("Follower F2", MODE, "async"),
};

export function ReplicationFailoverDemo() {
  const P = useParams("repl-failover", FAIL);
  const { crash, f1, f2 } = P.values;
  const [promote, setPromote] = useState<1 | 2>(2);
  const cfg = useMemo(() => ({ ...LF_DEFAULTS, modes: [f1, f2] as FollowerMode[] }), [f1, f2]);
  const run = useMemo(() => runLeaderFollower(cfg, crash), [cfg, crash]);
  const fo = failover(run, promote);
  const lost = new Set(fo.lost);
  const disc = new Set(fo.discarded.map((d) => d.index));
  const other = promote === 1 ? 2 : 1;
  const confirmed = run.writes.filter((w) => w.ackedAt !== undefined).length;
  const wait = meanCommitMs(run);
  const tEnd = LF_DEFAULTS.writeEvery * (LF_DEFAULTS.writes + 1) + 30;
  const st = fromTrace(run.net, (m) => (m.payload.k === "append" ? "" : undefined));
  const marks: StMark[] = [
    ...st.marks,
    ...run.writes.map((w) => ({ node: 0, t: w.at, color: w.ackedAt === undefined ? "var(--faint)" : lost.has(w.index) ? "var(--c4)" : "var(--c3)" })),
  ];
  const messages = st.messages.map((m) => (m.label === undefined ? { ...m, color: "var(--faint)" } : m));
  const names = ["leader", "F1", "F2"];
  return (
    <Demo
      title="Crash the leader, promote a follower"
      controls={<>
        <Param spec={FAIL.crash} value={crash} onChange={(v) => P.set("crash", v as number)} />
        <Param spec={FAIL.f1} value={f1} onChange={(v) => P.set("f1", v as FollowerMode)} />
        <Param spec={FAIL.f2} value={f2} onChange={(v) => P.set("f2", v as FollowerMode)} />
      </>}
    >
      <SpaceTime nodes={names} tEnd={tEnd} messages={messages} marks={marks} rowHeight={42} />
      <Legend items={[{ label: "write confirmed to its client", color: "var(--c3)" }, { label: "confirmed, then lost", color: "var(--c4)" }, { label: "never confirmed", color: "var(--faint)" }]} />
      <SectionLabel>Logs after the crash. Pick the new leader:</SectionLabel>
      <ButtonRow style={{ marginBottom: 8 }}>
        <Btn on={promote === 1} onClick={() => setPromote(1)}>Promote F1 ({run.logs[1]!.length} entries)</Btn>
        <Btn on={promote === 2} onClick={() => setPromote(2)}>Promote F2 ({run.logs[2]!.length} entries)</Btn>
      </ButtonRow>
      <div style={{ display: "grid", gap: 5 }}>
        <LogRow label="old leader">
          {run.writes.map((w) => <Entry key={w.index} i={w.index} color={w.ackedAt === undefined ? "var(--muted)" : "var(--fg)"} dashed={w.ackedAt === undefined} title={w.ackedAt === undefined ? "never confirmed" : "confirmed"} />)}
        </LogRow>
        {[1, 2].map((f) => {
          const have = new Set(run.logs[f]!);
          const isNew = f === promote;
          return (
            <LogRow key={f} label={isNew ? `F${f}: leader` : `F${f}`} accent={isNew ? "var(--c1)" : undefined}>
              {run.writes.map((w) => {
                if (have.has(w.index)) return <Entry key={w.index} i={w.index} color={!isNew && disc.has(w.index) ? "var(--c2)" : isNew ? "var(--c1)" : "var(--fg)"} filled={isNew} strike={!isNew && disc.has(w.index)} title={!isNew && disc.has(w.index) ? "thrown away: the new leader does not have it" : undefined} />;
                if (isNew && lost.has(w.index)) return <Entry key={w.index} i={w.index} color="var(--c4)" dashed title="confirmed to a client, but missing" />;
                return <Entry key={w.index} i={w.index} faint dashed color="var(--muted)" />;
              })}
            </LogRow>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "writes confirmed before the crash", value: `${confirmed} of ${run.writes.length}` },
          { label: `confirmed writes lost (F${promote} promoted)`, value: fo.lost.length },
          { label: `entries F${other} must throw away`, value: fo.discarded.length },
          { label: "mean wait for confirmation", value: Number.isFinite(wait) ? `${fixed(wait, 1)} ms` : "–" },
        ]} />
      </div>
      <Banner ok={fo.lost.length === 0}>
        {fo.lost.length === 0
          ? `F${promote} has every confirmed write.${fo.discarded.length ? ` F${other} holds ${fo.discarded.length} entr${fo.discarded.length === 1 ? "y" : "ies"} that the new leader lacks, so it must roll back before it follows F${promote}.` : ""}`
          : `F${promote} lacks write${fo.lost.length === 1 ? "" : "s"} ${fo.lost.join(", ")}. The old leader confirmed ${fo.lost.length === 1 ? "it" : "them"} to clients, and now ${fo.lost.length === 1 ? "it is" : "they are"} gone.${fo.best !== promote ? ` F${fo.best} has the longer log.` : ""}`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ split brain

const SB = {
  partitionMs: range({ label: "Partition length", min: 60, max: 220, step: 10, default: SB_DEFAULTS.partitionMs, format: (v) => `${v} ms` }),
  replication: seg("Old leader confirms", [["async", "at once (async)"], ["sync", "after 1 follower ack"]], "async"),
  guard: seg("Old leader", [["none", "never steps down"], ["lease", "steps down after a 30 ms lease"]], "none"),
};

export function ReplicationSplitBrainDemo() {
  const P = useParams("repl-split", SB);
  const { partitionMs, replication, guard } = P.values;
  const r = useMemo(() => runSplitBrain({ ...SB_DEFAULTS, partitionMs, replication: replication as "async" | "sync", guard: guard as "none" | "lease" }), [partitionMs, replication, guard]);
  const lostAcked = sbLostAcked(r);
  const unconfirmedLost = r.writes.filter((w) => w.lost && w.ackedAt === undefined).length;
  const healAt = SB_DEFAULTS.partitionAt + partitionMs;
  const tEnd = SB_DEFAULTS.end;
  const appends = r.net.messages.filter((m) => m.payload.k === "append");
  const marks: StMark[] = [
    ...r.leaderSpans.map((s) => ({ node: s.node, t: s.from, until: s.to, shape: "bar" as const, color: "var(--c1)", label: s.node === 0 ? "leader, epoch 1" : "leader, epoch 2" })),
    { node: 0, t: SB_DEFAULTS.partitionAt, until: healAt, shape: "bar", color: "var(--c4)" },
    ...r.writes.map((w) => ({ node: w.node, t: w.at, color: w.lost ? (w.ackedAt !== undefined ? "var(--c4)" : "var(--c2)") : w.ackedAt !== undefined ? "var(--c3)" : "var(--faint)" })),
  ];
  const ok = lostAcked.length === 0 && r.twoLeaderMs === 0;
  return (
    <Demo
      title="Split brain: two leaders take writes"
      controls={<>
        <Param spec={SB.partitionMs} value={partitionMs} onChange={(v) => P.set("partitionMs", v as number)} />
        <Param spec={SB.replication} value={replication} onChange={(v) => P.set("replication", v as never)} />
        <Param spec={SB.guard} value={guard} onChange={(v) => P.set("guard", v as never)} />
      </>}
    >
      <SpaceTime
        nodes={["node 0", "node 1", "node 2"]}
        tEnd={tEnd}
        messages={appends.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lostAt, color: m.from === 0 ? "var(--muted)" : "var(--c1)" }))}
        marks={marks}
        rowHeight={48}
      />
      <div className="muted" style={{ fontSize: 12, margin: "2px 0 6px" }}>{`The red band: node 0 is cut off from ${SB_DEFAULTS.partitionAt} to ${healAt} ms. Blue bands: a node that acts as leader.`}</div>
      <Legend items={[{ label: "confirmed, kept", color: "var(--c3)" }, { label: "confirmed, then lost", color: "var(--c4)" }, { label: "never confirmed, lost", color: "var(--c2)" }]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 10 }}>
        <Panel title="Client A writes to node 0">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {r.writes.filter((w) => w.node === 0).map((w) => <Entry key={w.id} i={w.id} color={w.lost ? "var(--c4)" : "var(--fg)"} strike={w.lost} dashed={w.ackedAt === undefined} />)}
          </div>
        </Panel>
        <Panel title="Client B writes to node 1">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {r.writes.filter((w) => w.node === 1).map((w) => <Entry key={w.id} i={w.id} color="var(--c1)" dashed={w.ackedAt === undefined} />)}
            {r.writes.every((w) => w.node !== 1) && <span className="muted" style={{ fontSize: 12 }}>none</span>}
          </div>
        </Panel>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "confirmed writes lost at the heal", value: lostAcked.length },
          { label: "unconfirmed writes thrown away", value: unconfirmedLost },
          { label: "time with two leaders", value: `${Math.round(r.twoLeaderMs)} ms` },
          { label: "node 0 stops leading at", value: r.stepDownAt !== undefined ? `${Math.round(r.stepDownAt)} ms` : "–" },
        ]} />
      </div>
      <Banner ok={ok ? true : lostAcked.length ? false : null}>
        {lostAcked.length > 0
          ? `Node 0 confirmed ${lostAcked.length} write${lostAcked.length === 1 ? "" : "s"} that no other node has. The cluster keeps the log of the epoch 2 leader, so ${lostAcked.length === 1 ? "that write is" : "those writes are"} gone.`
          : r.twoLeaderMs > 0
            ? `No confirmed write is lost, because node 0 cannot get an ack. But for ${Math.round(r.twoLeaderMs)} ms two nodes act as leader. A read from node 0 in that time can return old data.`
            : `Node 0 stops before node 1 takes over, so there is never more than one leader.${unconfirmedLost ? " Its unconfirmed writes are thrown away, and their clients must retry." : ""}`}
      </Banner>
    </Demo>
  );
}
