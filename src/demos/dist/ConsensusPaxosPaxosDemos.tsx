/** Demos for "Paxos": a stepper where the learner is the network, and duelling proposers. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Legend, Line, Panel, Param, Plot, RuleX, SmallLabel, Stats, BAD, GOOD, MONO, range, seg, useChunked, useParams } from "../../kit";
import {
  PAXOS_PRESETS, ballotName, msgLabel, nodeName, replayHand, runDuel, scriptToActions,
  type HandAction, type PaxosBugs, type Strategy,
} from "../../sims/dist/consensus/paxos/paxos";
import { SpaceTime, type StMark } from "./SpaceTime";

// ============================================================================ 1. The stepper

const NP = 2;
const VALUES = ["X", "Y"];
const PCOL = ["var(--c1)", "var(--c5)"];
type BugId = "none" | "forget" | "ignore";
const BUGS: Record<BugId, PaxosBugs> = { none: {}, forget: { forget: true }, ignore: { ignoreAccepted: true } };

const S_SCHEMA = {
  na: seg<"3" | "5">("Acceptors", [["3", "3"], ["5", "5"]], "3"),
  bug: seg<BugId>("Implementation", [["none", "Correct"], ["forget", "No fsync"], ["ignore", "Ignores old values"]], "none"),
};

const vcol = (v: string | null | undefined) => (v === "X" ? PCOL[0]! : v === "Y" ? PCOL[1]! : "var(--muted)");

export function ConsensusPaxosStepperDemo() {
  const P = useParams("cp-paxos", S_SCHEMA);
  const na = Number(P.values.na);
  const bug = P.values.bug;
  const [actions, setActions] = useState<HandAction[]>([]);
  const { core, net } = useMemo(() => replayHand(NP, na, VALUES, BUGS[bug], actions), [na, bug, actions]);
  const push = (a: HandAction) => setActions([...actions, a]);
  const pending = net.pending();
  const chosen = core.chosen();
  const values = [...new Set(chosen.map((c) => c.v))];
  const names = Array.from({ length: NP + na }, (_, i) => nodeName(NP, i));
  const loadPreset = (id: string) => {
    const p = PAXOS_PRESETS.find((x) => x.id === id)!;
    const b: BugId = p.bugs.forget ? "forget" : p.bugs.ignoreAccepted ? "ignore" : "none";
    P.set("na", "3");
    P.set("bug", b);
    setActions(scriptToActions(NP, 3, VALUES, p.bugs, p.script));
  };
  const marks: StMark[] = [
    ...net.crashes.map((c) => ({ node: c.node, t: c.t, until: c.until ?? net.now + 1, shape: "bar" as const, color: "var(--c4)", label: "down" })),
    ...core.hist.map((h) => ({ node: NP + h.a, t: h.t, color: vcol(h.v), label: `${ballotName(h.b)} ${h.v}` })),
  ];
  return (
    <Demo
      title="You are the network"
      actions={<ButtonRow><Btn onClick={() => setActions(actions.slice(0, -1))} disabled={!actions.length}>Back</Btn><Btn ghost onClick={() => setActions([])}>Reset</Btn></ButtonRow>}
      controls={<>
        <Param spec={S_SCHEMA.na} value={P.values.na} onChange={(v) => { P.set("na", v as "3" | "5"); setActions([]); }} />
        <Param spec={S_SCHEMA.bug} value={bug} onChange={(v) => P.set("bug", v as BugId)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Presets:</span>
        {PAXOS_PRESETS.map((p) => <Btn key={p.id} ghost onClick={() => loadPreset(p.id)}>{p.label}</Btn>)}
      </ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6 }}>
        {core.prop.map((p, i) => (
          <Panel key={i} title={`${names[i]}, wants ${VALUES[i]}`} accent={PCOL[i]}>
            <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.6 }}>
              <div>ballot {ballotName(p.b)} · {p.phase === "idle" ? "idle" : p.phase === "p1" ? `phase 1: ${Object.keys(p.promises).length}/${core.maj} promises` : p.phase === "p2" ? `phase 2: proposes ${p.v}` : `learned ${p.chosen}`}</div>
            </div>
            <div style={{ marginTop: 4 }}><Btn onClick={() => push({ k: "start", p: i })}>New ballot</Btn></div>
          </Panel>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${na > 3 ? 92 : 120}px, 1fr))`, gap: 6, marginTop: 6 }}>
        {core.acc.map((a, i) => {
          const node = NP + i;
          const down = net.down.has(node);
          return (
            <Panel key={i} title={`${names[node]}${down ? " (down)" : ""}`} style={{ opacity: down ? 0.55 : 1 }}>
              <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.6 }}>
                <div>promised {ballotName(a.promised)}</div>
                <div>accepted <span style={{ color: vcol(a.accepted?.v) }}>{a.accepted ? `${ballotName(a.accepted.b)} ${a.accepted.v}` : "–"}</span></div>
              </div>
              <div style={{ marginTop: 4 }}><Btn ghost onClick={() => push(down ? { k: "recover", node } : { k: "crash", node })}>{down ? "Restart" : "Crash"}</Btn></div>
            </Panel>
          );
        })}
      </div>
      <SmallLabel style={{ marginTop: 10 }}>In flight: click a message to deliver it, or × to lose it. Messages to a crashed acceptor wait. The diagram below shows only delivered and lost messages.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 22 }}>
        {pending.length === 0 && <span className="muted" style={{ fontSize: 12 }}>none. Start a ballot.</span>}
        {pending.map((m) => {
          const blocked = net.down.has(m.to);
          const from = m.from < NP ? m.from : m.to;
          return (
            <span key={m.id} style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
              <Chip color={PCOL[from]} faint={blocked} onClick={blocked ? undefined : () => push({ k: "deliver", id: m.id })}>{names[m.from]}→{names[m.to]} {msgLabel(m.payload)}</Chip>
              <button className="btn ghost" aria-label="lose this message" onClick={() => push({ k: "drop", id: m.id })} style={{ padding: "0 5px", fontSize: 11, lineHeight: "16px" }}>×</button>
            </span>
          );
        })}
      </div>
      {net.messages.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <SpaceTime nodes={names} tEnd={Math.max(10, net.now + 1)} rowHeight={34} timeLabel="step" marks={marks}
            messages={net.messages.filter((m) => m.deliveredAt !== undefined || m.lost).map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, color: PCOL[m.from < NP ? m.from : m.to] }))} />
        </div>
      )}
      <Banner ok={values.length > 1 ? false : values.length === 1 ? true : undefined}>
        {values.length === 0
          ? "Nothing is chosen yet. A value is chosen when a majority of acceptors accept the same ballot."
          : values.length === 1
            ? `${values[0]} is chosen: ballot ${ballotName(chosen[0]!.b)} was accepted by ${core.acceptedBy(chosen[0]!.b).map((a) => names[NP + a]).join(", ")}.${chosen.length > 1 ? ` ${chosen.length - 1} later ballot${chosen.length > 2 ? "s" : ""} chose the same value again.` : ""}`
            : `Two values are chosen: ${chosen.map((c) => `${c.v} at ballot ${ballotName(c.b)}`).join(" and ")}. Safety is broken.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Duelling proposers

const D_SCHEMA = {
  strategy: seg<Strategy>("Retry rule", [["fixed", "Fixed timer"], ["backoff", "Random backoff"], ["leader", "One leader"]], "fixed"),
  timeout: range({ label: "Retry timer", min: 20, max: 80, step: 5, default: 30, format: (v) => `${v} ms` }),
  offset: range({ label: "P2 starts at", min: 0, max: 30, step: 1, default: 15, format: (v) => `${v} ms` }),
  jitter: range({ label: "Latency jitter (10 ms ± j)", min: 0, max: 5, step: 1, default: 0, format: (v) => `± ${v} ms` }),
};
const CDF_T = Array.from({ length: 41 }, (_, i) => i * 10);
const CDF_SEEDS = 200;

export function ConsensusPaxosDuelDemo() {
  const P = useParams("cp-duel", D_SCHEMA);
  const { strategy, timeout, offset, jitter } = P.values;
  const r = useMemo(() => runDuel({ strategy, timeout, offset, jitter, horizon: 400 }), [strategy, timeout, offset, jitter]);
  const jobs = useMemo(() => (["fixed", "backoff", "leader"] as Strategy[]).flatMap((s) => Array.from({ length: CDF_SEEDS }, (_, k) => () => {
    // Each seeded run draws its own start time for P2, so that the curve covers many races.
    const off = (k * 7919) % 31;
    return runDuel({ strategy: s, timeout, offset: off, jitter: Math.max(jitter, 1), seed: k + 1, horizon: 400 }).chosenAt;
  })), [timeout, jitter]);
  const res = useChunked(`${timeout}/${jitter}`, jobs, { keep: true });
  const curve = (k: number) => {
    const xs = res.slice(k * CDF_SEEDS, (k + 1) * CDF_SEEDS).filter((x) => x !== undefined);
    if (!xs.length) return [];
    return CDF_T.map((t) => [t, xs.filter((x) => x !== null && x! <= t).length / xs.length] as [number, number]);
  };
  const names = ["P1", "P2", "A1", "A2", "A3"];
  const starts = r.net.trace.flatMap((e) => (e.kind === "send" && e.msg.payload.t === "prepare" && e.msg.to === 2 ? [{ node: e.msg.from, t: e.t, label: ballotName(e.msg.payload.b), color: PCOL[e.msg.from] }] : []));
  const ch = r.core.chosen()[0];
  const marks: StMark[] = [...starts, ...(ch ? [{ node: 2 + r.core.acceptedBy(ch.b)[0]!, t: ch.t, label: `chosen ${ch.v}`, color: GOOD }] : [])];
  return (
    <Demo
      title="Two proposers, one value"
      controls={<>
        <Param spec={D_SCHEMA.strategy} value={strategy} onChange={(v) => P.set("strategy", v as Strategy)} />
        <Param spec={D_SCHEMA.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} />
        <Param spec={D_SCHEMA.offset} value={offset} onChange={(v) => P.set("offset", v as number)} />
        <Param spec={D_SCHEMA.jitter} value={jitter} onChange={(v) => P.set("jitter", v as number)} />
      </>}
    >
      <SpaceTime nodes={names} tEnd={160} rowHeight={36} marks={marks.filter((m) => m.t <= 160)}
        messages={r.net.messages.filter((m) => m.sentAt <= 150).map((m) => {
          const p = m.from < 2 ? m.from : m.to;
          const t = m.payload.t;
          return { from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, color: t === "nack" ? "var(--c4)" : PCOL[p], dashed: t === "prepare" || t === "promise" };
        })} />
      <Legend items={[{ label: "P1 messages", color: PCOL[0]! }, { label: "P2 messages", color: PCOL[1]! }, { label: "nack", color: "var(--c4)" }]} />
      <SmallLabel>Dashed: phase 1 (prepare, promise). Solid: phase 2 (accept, accepted). A full ballot needs 2 round trips: 40 ms.</SmallLabel>
      <Stats items={[
        { label: "ballots started", value: r.ballots },
        { label: "value chosen at", value: r.chosenAt === null ? <span style={{ color: BAD }}>not by 400 ms</span> : `${Math.round(r.chosenAt)} ms` },
        { label: "values chosen", value: [...r.core.chosenValues()].join(", ") || "none" },
      ]} />
      <SmallLabel style={{ marginTop: 12 }}>{CDF_SEEDS} seeded runs per rule, with P2's start spread over 0 to 30 ms and jitter at least ± 1 ms</SmallLabel>
      <Plot x={[0, 400]} y={[0, 1]} height={190} xLabel="time (ms)" yLabel="share of runs with a chosen value">
        <RuleX at={40} label="one ballot" />
        <Line points={curve(0)} color="var(--c4)" />
        <Line points={curve(1)} color="var(--c2)" />
        <Line points={curve(2)} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "fixed timer", color: "var(--c4)" }, { label: "random backoff", color: "var(--c2)" }, { label: "one leader", color: "var(--c3)" }]} />
    </Demo>
  );
}
