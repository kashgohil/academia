/** Demos for the two-phase commit lesson: a hold-mode stepper, in-doubt time against recovery time, and 3PC. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Legend, Line, Param, Plot, RuleX, SectionLabel, Stats, StepCaption, Area, Dots,
  fixed, int, range, seg, toggle, useChunked, useParams, sig,
} from "../../kit";
import { SpaceTime, type StMark } from "./SpaceTime";
import { LogStrip, NodeCard, crashMarks, stMessages, stateColor } from "./DistTxnUi";
import { replayTpc, tpcLabel, inDoubtRun, TwoPc, type TpcAction, type TpcMode, type Vote } from "../../sims/dist/transactions/twopc";
import { inDoubtReplicated } from "../../sims/dist/transactions/replicated";
import { threePcScenario, t3Label, type T3Msg, type T3Scenario } from "../../sims/dist/transactions/threepc";
import type { Message } from "../../sims/dist/net";

const NAMES = ["C", "P1", "P2"];

// ============================================================================ 1. The stepper: you are the network

const STEP = {
  mode: seg<TpcMode>("Logging", [["pa", "presumed abort"], ["basic", "basic 2PC"]], "pa"),
  vote2: seg<Vote>("P2 votes", [["yes", "YES"], ["no", "NO"], ["ro", "READ-ONLY"]], "yes"),
  coop: toggle({ label: "Cooperative termination (in-doubt participants ask each other)", default: false }),
};

function describe(x: TwoPc, last: TpcAction | undefined): { text: string; tone: "good" | "bad" | "warn" | "info" | "plain" } {
  const doubt = x.parts.filter((p) => p.state === "prepared" && x.net.isUp(p.id));
  const cDown = !x.net.isUp(0);
  if (x.violations.length) return { text: `Atomicity broke: ${x.violations[0]}.`, tone: "bad" };
  if (doubt.length && cDown)
    return { text: `${doubt.map((p) => `P${p.id}`).join(" and ")} voted YES and the coordinator is down. ${doubt.length > 1 ? "They" : "It"} cannot commit or abort alone, and ${doubt.length > 1 ? "they hold their" : "it holds its"} locks. This is the blocking problem: recover C, or wait.`, tone: "bad" };
  if (doubt.length) return { text: `${doubt.map((p) => `P${p.id}`).join(" and ")} ${doubt.length > 1 ? "are" : "is"} in doubt: prepared, locks held, waiting for the outcome. Every 100 ms ${doubt.length > 1 ? "each asks" : "it asks"} again (QUERY).`, tone: "warn" };
  if (x.allDecided()) {
    const o = x.parts.some((p) => p.state === "committed") ? "committed" : x.parts.every((p) => p.state === "readonly") ? "finished (read-only)" : "aborted";
    return { text: `Every participant knows the outcome: the transaction ${o} everywhere. Locks are free.`, tone: o === "aborted" ? "info" : "good" };
  }
  if (!last) return { text: "C has sent PREPARE to both participants. The messages wait for you: deliver or drop each one, crash a node, or let time pass.", tone: "plain" };
  if (cDown) return { text: "The coordinator is down. Participants that have not voted can still abort on their own after their timeout (400 ms).", tone: "warn" };
  return { text: "Deliver the next message, or try a failure.", tone: "plain" };
}

export function DistTxnTwoPcStepperDemo() {
  const P = useParams("dist-txn-2pc", STEP);
  const v = P.values;
  const [acts, setActs] = useState<TpcAction[]>([]);
  const cfgKey = `${v.mode}|${v.vote2}|${v.coop}`;
  const [key, setKey] = useState(cfgKey);
  if (key !== cfgKey) {
    setKey(cfgKey);
    setActs([]);
  }
  const x = useMemo(() => replayTpc({ participants: 2, mode: v.mode, votes: ["yes", v.vote2], cooperative: v.coop }, acts), [v.mode, v.vote2, v.coop, acts]);
  const push = (a: TpcAction) => setActs((s) => [...s, a]);
  const held = x.net.held();
  const heldIds = new Set(held.map((m) => m.id));
  const now = x.net.now;
  const tEnd = Math.max(70, Math.ceil((now * 1.25 + 10) / 10) * 10);
  const messages = stMessages(x.net.messages, (m) => tpcLabel(m.payload), now, heldIds, (m) => (m.payload.k === "commit" ? "var(--c3)" : m.payload.k === "abort" ? "var(--c4)" : undefined));
  const marks: StMark[] = [
    ...crashMarks(x.net.trace as { kind: string; t: number; node?: number }[]),
    ...x.parts.flatMap((p) => p.doubt.map((d) => ({ node: p.id, t: d.from, until: d.to ?? now, shape: "bar" as const, color: "var(--c2)" }))),
    ...x.parts.filter((p) => p.decidedAt !== undefined && p.state !== "readonly").map((p) => ({ node: p.id, t: p.decidedAt!, color: stateColor(p.state) })),
    ...(x.coord.decidedAt !== undefined ? [{ node: 0, t: x.coord.decidedAt, color: stateColor(x.coord.state === "done" && x.parts.some((p) => p.state === "aborted") ? "aborted" : "committed"), label: "decides" }] : []),
  ];
  const d = describe(x, acts[acts.length - 1]);
  const nodes = [0, 1, 2];
  return (
    <Demo
      title="Two-phase commit, with you as the network"
      actions={<><Btn onClick={() => setActs((s) => s.slice(0, -1))} disabled={!acts.length}>Back</Btn><Btn ghost onClick={() => setActs([])} disabled={!acts.length}>Reset</Btn></>}
      controls={<><Param spec={STEP.mode} value={v.mode} onChange={(y) => P.set("mode", y as TpcMode)} /><Param spec={STEP.vote2} value={v.vote2} onChange={(y) => P.set("vote2", y as Vote)} /><Param spec={STEP.coop} value={v.coop} onChange={(y) => P.set("coop", y as boolean)} /></>}
    >
      <SpaceTime nodes={NAMES} tEnd={tEnd} messages={messages} marks={marks} cursor={now} />
      <Legend items={[{ label: "in doubt: prepared, locks held", color: "var(--c2)" }, { label: "in flight (waits for you)", color: "var(--muted)" }]} />
      <SectionLabel>Messages in flight ({held.length})</SectionLabel>
      <div style={{ display: "grid", gap: 4, minHeight: 28 }}>
        {held.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>none: press Wait to let timers fire</span>}
        {held.map((m) => (
          <div key={m.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <Chip color={m.payload.k === "commit" ? "var(--c3)" : m.payload.k === "abort" ? "var(--c4)" : "var(--fg)"}>{tpcLabel(m.payload)}</Chip>
            <span style={{ fontSize: 12.5 }}>{NAMES[m.from]} → {NAMES[m.to]}</span>
            <Btn onClick={() => push({ a: "deliver", id: m.id })}>Deliver</Btn>
            <Btn ghost onClick={() => push({ a: "drop", id: m.id })}>Drop</Btn>
          </div>
        ))}
      </div>
      <ButtonRow style={{ marginTop: 8 }}>
        <Btn onClick={() => push({ a: "wait", ms: 100 })}>Wait 100 ms</Btn>
        <span className="muted" style={{ fontSize: 12 }}>time {int(now)} ms</span>
      </ButtonRow>
      <StepCaption tone={d.tone} label={`${acts.length} actions`}>{d.text}</StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginTop: 10 }}>
        {nodes.map((i) => {
          const up = x.net.isUp(i);
          const nd = i === 0 ? x.coord : x.part(i);
          const state = i === 0 ? x.coord.state : x.part(i).state;
          return (
            <NodeCard key={i} name={i === 0 ? "C (coordinator)" : `P${i}`} state={state} up={up}
              actions={<Btn ghost onClick={() => push({ a: up ? "crash" : "recover", node: i })}>{up ? "Crash" : "Recover"}</Btn>}>
              {i > 0 && <div>locks: <b style={{ color: x.part(i).locks ? "var(--c2)" : "var(--muted)" }}>{x.part(i).locks ? "held" : "free"}</b>{x.part(i).doubt.length > 0 && <> · in doubt {int(x.inDoubtOf(i))} ms</>}</div>}
              <div className="muted" style={{ fontSize: 11.5 }}>log (solid: forced to disk; dashed: in memory)</div>
              <LogStrip log={nd.log} buffer={nd.buffer} />
            </NodeCard>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "forced log writes", value: x.coord.forcedWrites + x.parts.reduce((a, p) => a + p.forcedWrites, 0) },
          { label: "messages sent", value: x.net.messages.length },
          { label: "longest in-doubt time", value: `${int(x.maxInDoubt())} ms` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. In-doubt time against coordinator recovery time

const REC = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000];
const LOCK = {
  repair: range({ label: "Coordinator repair time", min: 10, max: 30000, log: true, default: 2000, format: (x) => (x >= 1000 ? `${fixed(x / 1000, 1)} s` : `${x} ms`) }),
  rate: range({ label: "Writes per second to the locked rows (model input)", min: 1, max: 1000, log: true, default: 50, format: (x) => `${x}/s` }),
};
const SEEDS = 8;

export function DistTxnInDoubtDemo() {
  const P = useParams("dist-txn-indoubt", LOCK);
  const v = P.values;
  const jobs = useMemo((): (() => { kind: "single" | "raft"; r: number; d: number })[] => [
    ...REC.map((r) => () => ({ kind: "single" as const, r, d: inDoubtRun({ recoverAfter: r, retry: 100, cooperative: true, seed: 1 }).inDoubt })),
    ...Array.from({ length: SEEDS }, (_, s) => () => ({ kind: "raft" as const, r: s, d: inDoubtReplicated(s + 1, 100).inDoubt })),
  ], []);
  const res = useChunked("indoubt", jobs);
  const single = res.filter((x) => x?.kind === "single").map((x) => [x!.r, x!.d] as [number, number]);
  const raft = res.filter((x) => x?.kind === "raft").map((x) => x!.d);
  const raftMean = raft.length ? raft.reduce((a, b) => a + b, 0) / raft.length : NaN;
  const raftMax = raft.length ? Math.max(...raft) : NaN, raftMin = raft.length ? Math.min(...raft) : NaN;
  const here = inDoubtRun({ recoverAfter: v.repair, retry: 100, cooperative: true, seed: 1 }).inDoubt;
  const queued = (here / 1000) * v.rate;
  return (
    <Demo title="How long participants hold locks in doubt" controls={<><Param spec={LOCK.repair} value={v.repair} onChange={(y) => P.set("repair", y as number)} /><Param spec={LOCK.rate} value={v.rate} onChange={(y) => P.set("rate", y as number)} /></>}>
      <Plot x={[10, 30000]} y={[10, 60000]} logX logY height={250} xTicks={[10, 100, 1000, 10000]} yTicks={[10, 100, 1000, 10000]} xLabel="time to repair the coordinator" yLabel="longest in-doubt time (ms)" xFormat={(t) => (t >= 1000 ? `${t / 1000} s` : `${t}`)} yFormat={(t) => (t >= 1000 ? `${t / 1000} s` : `${t}`)}>
        {raft.length === SEEDS && <Area points={[[10, raftMax], [30000, raftMax]]} base={raftMin} color="var(--c3)" opacity={0.15} />}
        {raft.length === SEEDS && <Line points={[[10, raftMean], [30000, raftMean]]} color="var(--c3)" />}
        <Line points={single} color="var(--c4)" />
        <Dots points={single} color="var(--c4)" />
        <RuleX at={v.repair} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "one coordinator: wait for its repair", color: "var(--c4)" }, { label: "coordinator log in a 3-node Raft group: wait for an election", color: "var(--c3)" }]} />
      <Banner tone={here > 1000 ? "bad" : "warn"}>
        The coordinator crashed at the commit point. All three participants are prepared, so even cooperative termination finds nobody who knows. They hold their locks for {int(here)} ms. At {v.rate} writes per second, about {int(queued)} transactions queue behind those locks.
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "in doubt, one coordinator", value: `${int(here)} ms` },
          { label: "in doubt, Raft group (mean of 8 runs)", value: Number.isFinite(raftMean) ? `${sig(raftMean)} ms` : "…" },
          { label: "Raft range over 8 runs", value: Number.isFinite(raftMin) ? `${int(raftMin)}–${int(raftMax)} ms` : "…" },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. 2PC blocks; 3PC does not, until the network splits

const T3 = { sc: seg<"2pc" | T3Scenario>("Run", [["2pc", "2PC, C crashes"], ["crash", "3PC, C crashes"], ["partition", "3PC, partition"]], "crash") };

/** Labels only one message of each broadcast, so that the diagram stays readable. */
function t3Label3(m: Message<T3Msg>): string {
  const k = m.payload.k;
  if (k === "cancommit" || k === "precommit" || k === "docommit" || k === "abort") return m.to === 1 || (k === "precommit" && m.to === 2) ? t3Label(m.payload) : "";
  if (k === "yes" || k === "ackpre") return m.from === 1 ? t3Label(m.payload) : "";
  if (k === "statereq") return m.from === 2 && m.to === 3 ? "STATE?" : "";
  return m.to === 2 ? t3Label(m.payload) : "";
}

export function DistTxnThreePcDemo() {
  const P = useParams("dist-txn-3pc", T3);
  const sc = P.values.sc;
  const view = useMemo(() => {
    if (sc === "2pc") {
      const x = new TwoPc({ participants: 3, mode: "pa", workTimeout: 1e9, net: { seed: 1, latency: { min: 10, max: 10 } } });
      x.onDecision = () => x.crash(0);
      x.start();
      x.net.runUntil(250);
      return {
        msgs: stMessages(x.net.messages, (m) => (m.payload.k === "query" ? (m.from === 2 ? "QUERY" : "") : m.to === 1 || m.from === 1 ? tpcLabel(m.payload) : ""), 250),
        marks: [...crashMarks(x.net.trace as { kind: string; t: number; node?: number }[]), ...x.parts.flatMap((p) => p.doubt.map((d) => ({ node: p.id, t: d.from, until: d.to ?? 250, shape: "bar" as const, color: "var(--c2)", label: "in doubt" })))],
        states: x.parts.map((p) => p.state as string),
        split: false,
        text: "C forced its commit record and crashed before it sent COMMIT. All three participants voted YES, so none of them may decide. They ask C every 100 ms and get no answer. They stay blocked until C returns.",
        tone: "bad" as const,
      };
    }
    const x = threePcScenario(sc);
    const st = x.state.slice(1);
    return {
      msgs: stMessages(x.net.messages, (m) => t3Label3(m), x.net.now),
      marks: [...crashMarks(x.net.trace as { kind: string; t: number; node?: number }[]), ...x.decidedAt.flatMap((t, i) => (i > 0 && t !== undefined ? [{ node: i, t, color: stateColor(x.state[i]!), label: x.state[i]! }] : []))],
      states: st as string[],
      split: x.split(),
      text: sc === "crash"
        ? "PRECOMMIT reached P1, then C crashed. P2 and P3 time out and ask the others for their states. P1 answers PRECOMMITTED, so every survivor commits. Nobody blocks."
        : "The same PRECOMMIT reached P1, then a partition cut {C, P1} from {P2, P3}. C commits after its ack timeout, and so does P1. P2 and P3 see only UNCERTAIN states, so their rule says abort.",
      tone: sc === "crash" ? ("good" as const) : ("bad" as const),
    };
  }, [sc]);
  return (
    <Demo title="Blocking in 2PC, and what 3PC trades for it" controls={<Param spec={T3.sc} value={sc} onChange={(y) => P.set("sc", y as typeof sc)} />}>
      <SpaceTime nodes={["C", "P1", "P2", "P3"]} tEnd={sc === "2pc" ? 250 : 170} messages={view.msgs} marks={view.marks} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12.5 }}>
        <span className="muted">final states:</span>
        {view.states.map((st, i) => <Chip key={i} color={stateColor(st)} filled>{`P${i + 1} ${st}`}</Chip>)}
      </div>
      <Banner tone={view.tone}>{view.split ? <b>Atomicity broke. </b> : null}{view.text}</Banner>
    </Demo>
  );
}
