/** Demos for "Byzantine fault tolerance": PBFT with a traitor, and message counts as n grows. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, Panel, Param, Plot, RuleX, SmallLabel, Stats, BAD, GOOD, MONO, range, seg, sig, useParams } from "../../kit";
import { CLIENT_VALUE, OTHER_VALUE, linearMessages, pbftMessages, runPbft, type Behavior } from "../../sims/dist/consensus/paxos/pbft";
import { SpaceTime } from "./SpaceTime";

// ============================================================================ 1. PBFT with a traitor

type Who = "none" | "0" | "1" | "2" | "3";
const B_SCHEMA = {
  n: seg<"4" | "3">("Replicas (f = 1)", [["4", "4 = 3f + 1"], ["3", "3"]], "4"),
  who: seg<Who>("Traitor", [["none", "none"], ["0", "R0 (primary)"], ["1", "R1"], ["2", "R2"], ["3", "R3"]], "0"),
  how: seg<Exclude<Behavior, "honest">>("It", [["equivocate", "lies"], ["silent", "stays silent"], ["garbage", "sends garbage"]], "equivocate"),
  seed: range({ label: "Network seed", min: 1, max: 20, step: 1, default: 1 }),
};

const dcol = (d: string) => (d === CLIENT_VALUE ? "var(--c1)" : d === OTHER_VALUE ? "var(--c5)" : "var(--c4)");

export function ConsensusPaxosPbftDemo() {
  const P = useParams("cp-pbft", B_SCHEMA);
  const n = Number(P.values.n);
  const who = P.values.who === "3" && n === 3 ? "none" : P.values.who;
  const behavior: Behavior[] = [];
  if (who !== "none") behavior[Number(who)] = P.values.how;
  const r = useMemo(() => runPbft({ n, f: 1, behavior, seed: P.values.seed }), [n, who, P.values.how, P.values.seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const names = [...Array.from({ length: n }, (_, i) => `R${i}${i === 0 ? " pri" : ""}`), "client"];
  const tEnd = Math.max(60, ...r.net.messages.map((m) => m.deliveredAt ?? m.lostAt ?? m.sentAt)) + 4;
  return (
    <Demo
      title="PBFT with one traitor"
      controls={<>
        <Param spec={B_SCHEMA.n} value={P.values.n} onChange={(v) => P.set("n", v as "4" | "3")} />
        <Param spec={{ ...B_SCHEMA.who, options: B_SCHEMA.who.options.filter((o) => Number(o.value) < n || o.value === "none") }} value={who} onChange={(v) => P.set("who", v as Who)} />
        <Param spec={B_SCHEMA.how} value={P.values.how} onChange={(v) => P.set("how", v as Exclude<Behavior, "honest">)} />
        <Param spec={B_SCHEMA.seed} value={P.values.seed} onChange={(v) => P.set("seed", v as number)} />
      </>}
    >
      <SpaceTime nodes={names} tEnd={tEnd} rowHeight={34}
        messages={r.net.messages.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, color: dcol(m.payload.d), dashed: m.payload.t === "prepare", label: m.payload.t === "pre-prepare" ? `pre ${m.payload.d}` : undefined }))}
        marks={r.replicas.flatMap((x, i) => (x.committed && x.committedAt !== null ? [{ node: i, t: x.committedAt, label: `commit ${x.committed}`, color: dcol(x.committed) }] : []))} />
      <Legend items={[{ label: `digest ${CLIENT_VALUE}`, color: dcol(CLIENT_VALUE) }, { label: `digest ${OTHER_VALUE}`, color: dcol(OTHER_VALUE) }, { label: "garbage", color: "var(--c4)" }]} />
      <SmallLabel>Dashed: PREPARE. Solid: PRE-PREPARE, COMMIT, REPLY. Each replica needs n − f = {n - 1} matching votes.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 5, marginTop: 6 }}>
        {r.replicas.map((x, i) => {
          const traitor = behavior[i] !== undefined;
          const votes = (m: Map<string, Set<number>>) => [...m.entries()].map(([d, s]) => `${d}:${s.size}`).join(" ") || "–";
          return (
            <Panel key={i} title={`R${i}${traitor ? " traitor" : ""}`} accent={traitor ? BAD : x.committed ? dcol(x.committed) : undefined}>
              <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.55, overflowWrap: "anywhere" }}>
                {traitor ? <div className="muted">{P.values.how === "equivocate" ? "lies to each replica" : P.values.how === "silent" ? "sends nothing" : "sends random digests"}</div> : <>
                  <div>pre {x.prePrepared ?? "–"}</div>
                  <div>prep {votes(x.prepares)}</div>
                  <div>com {votes(x.commits)}</div>
                  <div style={{ color: x.committed ? dcol(x.committed) : "var(--muted)", fontWeight: 600 }}>{x.committed ? `commit ${x.committed}` : "no commit"}</div>
                </>}
              </div>
            </Panel>
          );
        })}
      </div>
      <Stats items={[
        { label: "honest replicas agree", value: <span style={{ color: r.agreement ? GOOD : BAD }}>{r.agreement ? "yes" : "no"}</span> },
        { label: "every honest replica committed", value: r.live ? "yes" : "no" },
        { label: "client result (f + 1 replies)", value: r.clientResult ?? "none" },
        { label: "messages", value: r.messages },
      ]} />
      <Banner ok={!r.agreement ? false : r.live ? true : null}>
        {!r.agreement
          ? `Honest replicas committed ${r.honestValues.join(" and ")}. With 3 replicas, two quorums of 2 can share only the traitor.`
          : r.live
            ? "Every honest replica committed the client's value."
            : "No honest replica committed a wrong value, but some did not commit at all. In PBFT, their timers would now start a view change to replace the primary."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Messages as n grows

const M_SCHEMA = { f: range({ label: "Faults tolerated f", min: 1, max: 33, step: 1, default: 1 }) };
const FS = Array.from({ length: 33 }, (_, i) => i + 1);

export function ConsensusPaxosBftCountDemo() {
  const P = useParams("cp-bftcount", M_SCHEMA);
  const f = P.values.f;
  const n = 3 * f + 1;
  // The formulas are checked against runs on the simulated network in the unit tests. Small n runs here too.
  const measured = useMemo(() => (n <= 31 ? { pbft: runPbft({ n, f }).messages, lin: runPbft({ n, f, linear: true }).messages } : null), [n, f]);
  const pb = FS.map((k) => [3 * k + 1, pbftMessages(3 * k + 1)] as [number, number]);
  const li = FS.map((k) => [3 * k + 1, linearMessages(3 * k + 1)] as [number, number]);
  return (
    <Demo title="Messages per request" controls={<Param spec={M_SCHEMA.f} value={f} onChange={(v) => P.set("f", v as number)} />}>
      <Plot x={[4, 100]} y={[10, 30000]} logY height={220} xLabel="replicas n = 3f + 1" yLabel="messages per request (log scale)" yTicks={[10, 100, 1000, 10000]} yFormat={(v) => sig(v)}>
        <RuleX at={n} />
        <Line points={pb} color="var(--c4)" />
        <Line points={li} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "PBFT: all-to-all prepare and commit", color: "var(--c4)" }, { label: "linear: votes go through the leader", color: "var(--c3)" }]} />
      <Stats items={[
        { label: "replicas n", value: n },
        { label: "PBFT messages", value: pbftMessages(n).toLocaleString("en-US") },
        { label: "linear messages", value: linearMessages(n).toLocaleString("en-US") },
        { label: "ratio", value: `${(pbftMessages(n) / linearMessages(n)).toFixed(1)}×` },
        { label: "measured on the network", value: measured ? `${measured.pbft} and ${measured.lin}` : "n > 31: formula only" },
      ]} />
    </Demo>
  );
}
