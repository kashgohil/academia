/** Demos for "Multi-Paxos": a log through a leader change, and messages per command. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, IndexButtons, IndexSlider, Legend, Line, Param, Plot, RuleX, StepCaption, Stats, MONO, range, tint, useParams } from "../../kit";
import { MP_SLOTS, NOOP, leaderChangeScenario, messagesBasic, messagesMulti, type MpMsg } from "../../sims/dist/consensus/paxos/multipaxos";
import { ballotName } from "../../sims/dist/consensus/paxos/paxos";
import { flexibleQ1, majority } from "../../sims/dist/consensus/paxos/quorum";
import type { Message } from "../../sims/dist/net";
import { SpaceTime } from "./SpaceTime";

// ============================================================================ 1. The log through a leader change

const label = (m: Message<MpMsg>) => {
  const p = m.payload;
  if (p.t === "p2a") return `${p.slot}:${p.v === NOOP ? "noop" : p.v}`;
  if (p.t === "p1a") return "prepare";
  if (p.t === "p1b") return "promise";
  return undefined;
};

export function ConsensusPaxosLogDemo() {
  const [quorum, setQuorum] = useState<number[]>([2, 3]);
  const [k, setK] = useState(0);
  const frames = useMemo(() => leaderChangeScenario(quorum), [quorum]);
  const fr = frames[Math.min(k, frames.length - 1)]!;
  const electStep = frames.length - 2;
  const toggle = (i: number) => {
    const next = quorum.includes(i) ? quorum.filter((x) => x !== i) : [...quorum, i].sort();
    if (next.length >= 2) setQuorum(next);
  };
  return (
    <Demo title="A Multi-Paxos log through a leader change" actions={<ButtonRow><IndexButtons k={k} n={frames.length} set={setK} /></ButtonRow>} controls={<IndexSlider k={k} n={frames.length} set={setK} />}>
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>N5 will hear phase 1 from:</span>
        {[1, 2, 3].map((i) => <Btn key={i} on={quorum.includes(i)} onClick={() => toggle(i)}>N{i + 1}</Btn>)}
      </ButtonRow>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 3, fontFamily: MONO, fontSize: 12, width: "100%", minWidth: 300 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", color: "var(--muted)", fontWeight: 500, width: 56 }}>slot</th>
              {Array.from({ length: MP_SLOTS }, (_, s) => <th key={s} style={{ color: "var(--muted)", fontWeight: 500 }}>{s + 1}</th>)}
            </tr>
          </thead>
          <tbody>
            {fr.logs.map((row, i) => {
              const down = fr.down.includes(i);
              return (
                <tr key={i} style={{ opacity: down ? 0.45 : 1 }}>
                  <td style={{ color: fr.leader === i ? "var(--c2)" : "var(--muted)", whiteSpace: "nowrap" }}>N{i + 1}{fr.leader === i ? " ★" : ""}{down ? " ✕" : ""}</td>
                  {row.map((e, s) => {
                    const ch = fr.chosen[s];
                    const isChosen = ch !== null && e.v === ch && e.v !== "";
                    return (
                      <td key={s} style={{ textAlign: "center", padding: "3px 2px", borderRadius: 4, border: `1.5px solid ${e.v ? (isChosen ? "var(--c3)" : "var(--c2)") : "var(--border)"}`, background: isChosen ? tint("var(--c3)", 22) : undefined }}>
                        {e.v ? <>{e.v === NOOP ? "noop" : e.v}<span style={{ color: "var(--muted)", fontSize: 10 }}> {ballotName(e.b)}</span></> : <span style={{ color: "var(--faint)" }}>·</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr>
              <td style={{ color: "var(--muted)" }}>chosen</td>
              {fr.chosen.map((c, s) => <td key={s} style={{ textAlign: "center", color: c ? "var(--c3)" : "var(--faint)" }}>{c ? (c === NOOP ? "noop" : c) : "–"}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
      <Legend items={[{ label: "accepted, chosen", color: "var(--c3)" }, { label: "accepted, not chosen", color: "var(--c2)" }]} />
      <StepCaption label={`${Math.min(k, frames.length - 1) + 1}/${frames.length}`} tone={k === electStep ? "warn" : undefined}>{fr.title}</StepCaption>
      {fr.messages.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <SpaceTime nodes={["N1", "N2", "N3", "N4", "N5"]} tStart={fr.tStart} tEnd={Math.max(fr.tEnd, fr.tStart + 20)} rowHeight={32}
            messages={fr.messages.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost && m.lost !== "dropped" ? m.lostAt : undefined, label: fr.messages.length <= 10 || m.payload.t === "p1a" ? label(m) : undefined, color: m.payload.t === "p1a" || m.payload.t === "p1b" ? "var(--c2)" : "var(--fg)" }))} />
        </div>
      )}
    </Demo>
  );
}

// ============================================================================ 2. Messages per command

const C_SCHEMA = {
  n: range({ label: "Nodes n", min: 3, max: 15, step: 2, default: 5 }),
  q2: range({ label: "Flexible: phase-2 quorum", min: 2, max: 8, step: 1, default: 2 }),
};
const NS = [3, 5, 7, 9, 11, 13, 15];

export function ConsensusPaxosCountDemo() {
  const P = useParams("cp-count", C_SCHEMA);
  const { n } = P.values;
  const q2 = Math.min(P.values.q2, majority(n));
  const data = useMemo(() => NS.map((m) => ({ n: m, basic: messagesBasic(m, 4), multi: messagesMulti(m, 4), flex: messagesMulti(m, 4, Math.min(q2, majority(m)), true) })), [q2]);
  const cur = useMemo(() => ({ basic: messagesBasic(n, 4), multi: messagesMulti(n, 4), flex: messagesMulti(n, 4, q2, true) }), [n, q2]);
  const q1 = flexibleQ1(n, q2);
  return (
    <Demo
      title="Messages per committed command"
      controls={<>
        <Param spec={C_SCHEMA.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={{ ...C_SCHEMA.q2, max: majority(n) }} value={q2} onChange={(v) => P.set("q2", v as number)} />
      </>}
    >
      <Plot x={[3, 15]} y={[0, 60]} height={210} xLabel="nodes n" yLabel="messages per command" xTicks={NS}>
        <RuleX at={n} />
        <Line points={data.map((d) => [d.n, d.basic])} color="var(--c4)" />
        <Line points={data.map((d) => [d.n, d.multi])} color="var(--c1)" />
        <Line points={data.map((d) => [d.n, d.flex])} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "basic Paxos per command", color: "var(--c4)" }, { label: "Multi-Paxos, stable leader", color: "var(--c1)" }, { label: `Flexible, thrifty, phase-2 quorum ${q2}`, color: "var(--c3)" }]} />
      <Stats items={[
        { label: `basic, n = ${n}`, value: cur.basic },
        { label: "Multi-Paxos", value: cur.multi },
        { label: "Flexible, thrifty", value: cur.flex },
        { label: "phase-1 quorum it needs", value: `${q1} of ${n}` },
        { label: "crashes a leader change survives", value: n - q1 },
      ]} />
      <Banner tone="info">Measured on the simulated network: the leader is one of the n nodes, so it sends to n − 1 others. A smaller phase-2 quorum makes each command cheaper, but a leader change must then hear from {q1} nodes.</Banner>
    </Demo>
  );
}
