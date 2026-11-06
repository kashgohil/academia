/** Demos for "ZooKeeper and etcd": the leader-election recipe with sessions and watches, and an etcd watch that resumes. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Legend, Param, SmallLabel, Stats, BAD, GOOD, MONO, int, range, seg, tint, useParams } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { ELECTION, liveLeaders, zkElection, type ZkAction, type ZkMsg } from "../../sims/dist/coordination/zk";
import { exactlyOnceInOrder, watchRun, type ResumeMode, type WatchMsg } from "../../sims/dist/coordination/etcd";

// ============================================================================ 1. Leader election on a ZooKeeper-like service

const ZE = {
  mode: seg("Each waiter watches", [["pred", "its predecessor"], ["herd", "the parent /election"]], "pred"),
};
const TIMEOUT = 4000;
const MAX = 8;
const short = (name: string) => `…${name.slice(-4)}`;

export function CoordZkElectionDemo() {
  const P = useParams("coord-zk", ZE);
  const { mode } = P.values;
  const [actions, setActions] = useState<ZkAction[]>([]);
  const r = useMemo(() => zkElection({ mode, sessionTimeout: TIMEOUT, maxClients: MAX, actions }), [mode, actions]);
  const nextT = Math.max(600, r.tEnd);
  const leader = liveLeaders(r)[0];
  const kill = (client: number) => setActions([...actions, { t: nextT, kind: "kill", client }]);
  const free = r.clients.find((c) => !c.joined);

  const lastKill = [...actions].reverse().find((a) => a.kind === "kill");
  const lastExpire = [...r.changes].reverse().find((c) => c.what === "expire");
  const lastJoin = [...r.changes].reverse().find((c) => c.what === "create");
  const focus = lastExpire && lastKill ? lastExpire : lastJoin;
  const expiring = focus?.what === "expire";
  const t0 = expiring ? focus!.t - 6 : 0;
  const t1 = expiring ? focus!.t + 60 : 110;
  const joined = r.clients.filter((c) => c.joined);
  const row = (node: number) => (node === 0 ? 0 : joined.findIndex((c) => c.id === node) + 1);
  const labelled = new Set<string>(); // label only the first message of each kind, so that labels do not pile up
  const messages: StMessage[] = r.net.messages
    .filter((m) => m.payload.k !== "ping" && m.payload.k !== "pong" && m.sentAt >= t0 && m.sentAt <= t1)
    .map((m) => {
      const p = m.payload as ZkMsg;
      const first = expiring && !labelled.has(p.k) && labelled.add(p.k) !== undefined;
      const label = !first ? undefined : p.k === "event" ? (p.type === "NodeDeleted" ? "deleted" : "changed") : p.k === "getChildren" ? "list" : p.k === "exists" ? "exists?" : undefined;
      return { from: row(m.from), to: row(m.to), sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lostAt, label, color: p.k === "event" ? "var(--c2)" : p.k === "reply" ? "var(--faint)" : "var(--c1)" };
    });
  const marks: StMark[] = [
    ...r.leaders.filter((l) => l.t >= t0 && l.t <= t1).map((l) => ({ node: row(l.client), t: l.t, label: "leader", color: GOOD })),
    ...(focus && focus.what === "expire" ? [{ node: 0, t: focus.t, label: "session expired", color: BAD }] : []),
  ];
  const kids = r.tree.children(ELECTION);
  const owner = (name: string) => r.clients.find((c) => c.name === name);
  const notifiedLast = focus?.what === "expire" ? focus.notified : null;
  const killedAt = lastKill?.t;
  const newLeader = killedAt !== undefined ? r.leaders.find((l) => l.t > killedAt) : undefined;

  return (
    <Demo
      title="Leader election with ephemeral sequential znodes"
      actions={<Btn ghost onClick={() => setActions([])}>Reset</Btn>}
      controls={<Param spec={ZE.mode} value={mode} onChange={(v) => P.set("mode", v as "pred" | "herd")} />}
    >
      <ButtonRow style={{ marginBottom: 10 }}>
        <Btn onClick={() => leader && kill(leader)} disabled={!leader}>Kill the leader</Btn>
        <Btn onClick={() => free && setActions([...actions, { t: nextT, kind: "join", client: free.id }])} disabled={!free}>Add a client</Btn>
        <span className="muted" style={{ fontSize: 12 }}>or click a client to kill it</span>
      </ButtonRow>
      <SmallLabel>Children of {ELECTION}, in sequence order</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {kids.map((name) => {
          const c = owner(name)!;
          const isLeader = c.leader && c.alive;
          return (
            <button key={name} onClick={() => c.alive && kill(c.id)} disabled={!c.alive} title={c.alive ? `kill c${c.id}` : "dead"}
              style={{ font: "inherit", textAlign: "left", cursor: c.alive ? "pointer" : "default", borderRadius: 6, padding: "4px 8px", minWidth: 92,
                border: `1.5px solid ${isLeader ? GOOD : "var(--border)"}`, background: isLeader ? tint(GOOD, 14) : "var(--bg)", color: "var(--fg)" }}>
              <div style={{ fontFamily: MONO, fontSize: 12 }}>n_{short(name)}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>c{c.id} {isLeader ? "· leader" : c.watching ? `· watches ${c.watching === ELECTION ? ELECTION : short(c.watching)}` : ""}</div>
            </button>
          );
        })}
      </div>
      {r.clients.some((c) => c.joined && !c.alive) && <SmallLabel>Dead clients: {r.clients.filter((c) => c.joined && !c.alive).map((c) => `c${c.id}`).join(", ")}. Their znodes went away when their sessions expired.</SmallLabel>}
      <SmallLabel style={{ marginTop: 8 }}>{focus?.what === "expire" ? `Messages around the last session expiry (pings hidden)` : "Messages as the clients join (pings hidden)"}</SmallLabel>
      <SpaceTime nodes={["ZK", ...joined.map((c) => `c${c.id}`)]} tStart={t0} tEnd={t1} messages={messages} marks={marks} rowHeight={30} />
      <Legend items={[{ label: "watch notification", color: "var(--c2)" }, { label: "request", color: "var(--c1)" }, { label: "reply", color: "var(--faint)" }]} />
      <Stats items={[
        { label: "notifications for the last expiry", value: notifiedLast ?? "–" },
        { label: "all notifications", value: r.notifications },
        { label: "requests and replies (no pings)", value: r.requests },
        { label: "kill to new leader", value: newLeader && killedAt !== undefined ? `${int(newLeader.t - killedAt)} ms` : "–" },
      ]} />
      <Banner tone={notifiedLast === null ? "plain" : notifiedLast > 1 ? "warn" : "good"}>
        {notifiedLast === null
          ? `Kill the leader. Its session times out after ${TIMEOUT} ms (a model input), then its ephemeral znode goes away.`
          : mode === "herd"
            ? `The deletion woke ${notifiedLast} waiters. Each one listed the children again, and all but one learned nothing. With n waiters, each change costs O(n) messages.`
            : `The deletion woke ${notifiedLast} client: the one that watched the deleted znode. Each change costs O(1) messages.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. An etcd watch that resumes from a revision

const EW = {
  cut: range({ label: "Watcher cut off for", min: 0, max: 800, step: 50, default: 400, format: (v) => `${v} ms` }),
  resume: seg("On reconnect, watch from", [["next", "last revision + 1"], ["last", "last revision"], ["now", "now"]], "next"),
  keep: seg("The server keeps", [["all", "all history"], ["5", "the last 5 revisions"]], "all"),
};

export function CoordEtcdWatchDemo() {
  const P = useParams("coord-etcd", EW);
  const { cut, resume, keep } = P.values;
  const r = useMemo(() => watchRun({ cuts: cut ? [{ from: 300, to: 300 + cut }] : [], resume, keep: keep === "all" ? Infinity : 5 }), [cut, resume, keep]);
  // Rows: writer, etcd, watcher, so that puts and events do not cross. Progress notifications are hidden.
  const ROW = [1, 0, 2];
  const messages: StMessage[] = r.net.messages.filter((m) => m.payload.k !== "progress").map((m) => {
    const p = m.payload as WatchMsg;
    const base = { from: ROW[m.from]!, to: ROW[m.to]!, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt };
    if (p.k === "events") return { ...base, color: "var(--c1)", label: p.events.length > 1 ? `${p.events.length} events` : undefined };
    if (p.k === "watch") return { ...base, color: "var(--c2)", label: m.deliveredAt !== undefined ? `from ${p.startRev || "now"}` : undefined };
    if (p.k === "canceled") return { ...base, color: BAD, label: "compacted" };
    if (p.k === "get" || p.k === "kvs") return { ...base, color: "var(--c5)", label: p.k === "get" ? "get" : undefined };
    return { ...base, color: "var(--faint)" };
  });
  const marks: StMark[] = cut ? [{ node: 2, t: 300, until: 300 + cut, shape: "bar", label: "cut off", color: BAD }] : [];
  const seen = new Map<number, number>();
  for (const x of r.received) seen.set(x, (seen.get(x) ?? 0) + 1);
  const ok = exactlyOnceInOrder(r);
  return (
    <Demo
      title="A watch that resumes from a revision"
      controls={<>
        <Param spec={EW.cut} value={cut} onChange={(v) => P.set("cut", v as number)} />
        <Param spec={EW.resume} value={resume} onChange={(v) => P.set("resume", v as ResumeMode)} />
        <Param spec={EW.keep} value={keep} onChange={(v) => P.set("keep", v as "all" | "5")} />
      </>}
    >
      <SpaceTime nodes={["writer", "etcd", "watcher"]} tEnd={r.tEnd} messages={messages} marks={marks} rowHeight={44} />
      <Legend items={[{ label: "event", color: "var(--c1)" }, { label: "watch request", color: "var(--c2)" }, { label: "compacted", color: BAD }, { label: "re-read (get)", color: "var(--c5)" }, { label: "put, created", color: "var(--faint)" }]} />
      <SmallLabel>Progress notifications, every 50 ms, are hidden. While they stop, the watcher counts the stream as broken.</SmallLabel>
      <SmallLabel style={{ marginTop: 8 }}>Each revision the writer made, as the watcher saw it</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {r.expected.map((rev) => {
          const n = seen.get(rev) ?? 0;
          return <Chip key={rev} color={n === 1 ? GOOD : n === 0 ? BAD : "var(--c2)"} filled={n !== 1} title={n === 1 ? "once" : n === 0 ? "missed" : `${n} times`}>{rev}</Chip>;
        })}
      </div>
      <Legend items={[{ label: "received once", color: GOOD }, { label: "missed", color: BAD }, { label: "received twice", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "events written", value: r.expected.length },
        { label: "missed", value: <span style={{ color: r.missed.length ? BAD : undefined }}>{r.missed.length}</span> },
        { label: "duplicates", value: r.duplicates.length },
        { label: "full re-reads", value: r.relists },
        { label: "watcher's copy matches", value: <span style={{ color: r.stateMatches ? GOOD : BAD }}>{r.stateMatches ? "yes" : "no"}</span> },
      ]} />
      <Banner tone={ok ? "good" : r.stateMatches ? "warn" : "bad"}>
        {ok
          ? "Every revision arrived exactly once, in order. The server replayed the gap from its history."
          : r.relists
            ? `The gap was compacted, so the watch was cancelled. The watcher read the whole state again: it skipped ${r.missed.length} events, but its copy is correct.`
            : r.duplicates.length
              ? `start_revision is inclusive, so revision ${r.duplicates[0]} came twice. A put is idempotent here, but a counter of events would be wrong.`
              : `The new watch started at the current revision, so ${r.missed.length} events are gone. ${r.stateMatches ? "" : "The watcher's copy is now wrong."}`}
      </Banner>
    </Demo>
  );
}
