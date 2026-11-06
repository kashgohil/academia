/** Demos for the Calvin lesson: a sequencer with deterministic replicas, and one multi-partition transaction. */
import { useMemo, useState } from "react";
import { Banner, Btn, Chip, Demo, Meter, MiniTable, Param, SectionLabel, Stats, fixed, int, range, toggle, useParams } from "../../kit";
import { SpaceTime, type StMark } from "./SpaceTime";
import { stMessages } from "./DistTxnUi";
import { calvinRun, CALVIN_OPS, CALVIN_INIT, DEFAULT_CALVIN, mp2pc, mpCalvin } from "../../sims/dist/transactions/calvin";

// ============================================================================ 1. Sequencer and replicas

const REP = {
  epoch: range({ label: "Epoch length", min: 2, max: 30, step: 1, default: 10, format: (x) => `${x} ms` }),
  race: toggle({ label: "Nondeterministic execution (threads race inside a batch)", default: false }),
  lag: toggle({ label: "Delay batches to replica 3 by 25 ms", default: false }),
};

export function DistTxnCalvinReplicasDemo() {
  const P = useParams("dist-txn-calvin", REP);
  const v = P.values;
  const [seed, setSeed] = useState(1);
  const r = useMemo(() => calvinRun({ ...DEFAULT_CALVIN, epoch: v.epoch, race: v.race, lagLast: v.lag ? 25 : 0, seed }), [v.epoch, v.race, v.lag, seed]);
  const tEnd = Math.max(70, ...r.replicas.flatMap((x) => x.at)) + 5;
  const msgs = stMessages(r.net.messages, (m) => (m.payload.k === "req" ? CALVIN_OPS[m.payload.op]!.id : m.to === 2 ? `#${m.payload.seq}: ${m.payload.ops.map((o) => CALVIN_OPS[o]!.id).join(" ")}` : ""), tEnd);
  const marks: StMark[] = [
    ...r.batches.map((b) => ({ node: 1, t: b.t, color: "var(--c1)" })),
    ...r.replicas.flatMap((x, i) => [...new Set(x.at)].map((t) => ({ node: i + 2, t, color: r.identical ? "var(--c3)" : "var(--c4)" }))),
  ];
  return (
    <Demo
      title="One input log, three replicas"
      actions={v.race ? <Btn onClick={() => setSeed((s) => s + 1)}>Run the threads again</Btn> : undefined}
      controls={<><Param spec={REP.epoch} value={v.epoch} onChange={(y) => P.set("epoch", y as number)} /><Param spec={REP.race} value={v.race} onChange={(y) => P.set("race", y as boolean)} /><Param spec={REP.lag} value={v.lag} onChange={(y) => P.set("lag", y as boolean)} /></>}
    >
      <SpaceTime nodes={["client", "sequencer", "replica 1", "replica 2", "replica 3"]} tEnd={tEnd} messages={msgs} marks={marks} rowHeight={40} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "6px 0" }}>
        {CALVIN_OPS.map((o) => <Chip key={o.id}>{o.id}: {o.text}</Chip>)}
        <span className="muted" style={{ fontSize: 12 }}>start: x = {CALVIN_INIT.x}, y = {CALVIN_INIT.y}</span>
      </div>
      <SectionLabel>{r.batches.length} batches · what each replica did</SectionLabel>
      <MiniTable
        head={["replica", "execution order", "x", "y"]}
        rows={r.replicas.map((x, i) => [`replica ${i + 1}`, x.order.map((o) => CALVIN_OPS[o]!.id).join(" "), x.state.x, x.state.y])}
        highlight={(i) => !r.identical && JSON.stringify(r.replicas[i]!.state) !== JSON.stringify(r.replicas[0]!.state)}
      />
      <Banner ok={r.identical}>
        {r.identical
          ? `All replicas executed the same batches in the same order and reached x = ${r.replicas[0]!.state.x}, y = ${r.replicas[0]!.state.y}. No replica asked another one anything${v.lag ? ", and the late replica simply caught up" : ""}.`
          : "The replicas got the same input but ran each batch in their own thread order. Their states now differ, and no protocol will notice. Determinism is what made the input log enough."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. One transaction across partitions: 2PC against Calvin

const MP = {
  parts: range({ label: "Partitions the transaction touches", min: 1, max: 8, step: 1, default: 3 }),
  lat: range({ label: "One-way latency (model input)", min: 0.2, max: 50, log: true, default: 1, format: (x) => `${x} ms` }),
  epoch: range({ label: "Calvin epoch", min: 1, max: 20, step: 1, default: 10, format: (x) => `${x} ms` }),
};

export function DistTxnCalvinVs2pcDemo() {
  const P = useParams("dist-txn-mp", MP);
  const v = P.values;
  const cfg = { partitions: v.parts, latency: v.lat, epoch: v.epoch };
  const a = mp2pc(cfg), b = mpCalvin(cfg);
  const maxL = Math.max(a.latency, b.latency), maxH = Math.max(a.lockHold, b.lockHold, 1e-9);
  return (
    <Demo title="One multi-partition transaction: 2PC against Calvin" controls={<><Param spec={MP.parts} value={v.parts} onChange={(y) => P.set("parts", y as number)} /><Param spec={MP.lat} value={v.lat} onChange={(y) => P.set("lat", y as number)} /><Param spec={MP.epoch} value={v.epoch} onChange={(y) => P.set("epoch", y as number)} /></>}>
      <SectionLabel>Latency the client sees</SectionLabel>
      <Meter label="2PC over Paxos groups" value={a.latency} max={maxL} color="var(--c4)" text={`${fixed(a.latency, 1)} ms`} />
      <Meter label="Calvin" value={b.latency} max={maxL} color="var(--c1)" text={`${fixed(b.latency, 1)} ms`} />
      <SectionLabel>How long the rows stay locked</SectionLabel>
      <Meter label="2PC: from the read to COMMIT" value={a.lockHold} max={maxH} color="var(--c4)" text={`${fixed(a.lockHold, 1)} ms`} />
      <Meter label="Calvin: from the batch to the last remote read" value={b.lockHold} max={maxH} color="var(--c1)" text={`${fixed(b.lockHold, 1)} ms`} />
      <MiniTable
        head={["", "2PC", "Calvin"]}
        rows={[
          ["one-way delays on the critical path", a.hops, `${b.hops} + half an epoch`],
          ["network delays while locks are held", a.hopsUnderLock, b.hopsUnderLock],
          ["messages", int(a.messages), int(b.messages)],
        ]}
      />
      <Banner tone={b.latency < a.latency ? "good" : "warn"}>
        {v.parts === 1
          ? "With one partition, 2PC has nothing to agree on, and Calvin still pays for the epoch. Calvin's gain is for transactions across partitions."
          : `2PC holds locks across ${a.hopsUnderLock} network delays: reads, the prepare write, the vote, the commit write and the COMMIT message. Calvin holds them across ${b.hopsUnderLock}, the exchange of reads. ${b.latency < a.latency ? "Here Calvin is also faster." : "Here the epoch wait makes Calvin slower, but its locks are still much shorter, so contended rows do far better."}`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "2PC lock hold / Calvin lock hold", value: b.lockHold > 0 ? `${fixed(a.lockHold / b.lockHold, 1)}×` : "Calvin holds none across the network" },
        ]} />
      </div>
    </Demo>
  );
}
