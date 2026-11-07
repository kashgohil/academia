/** Demos for "etcd, CockroachDB and DynamoDB compared": one write and one read side by side, and workload fit. */
import { useMemo, useState } from "react";
import { Demo, Note, SmallLabel, Param, seg, toggle, range, fixed, mono, Banner, MiniTable } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { Verdict } from "./CapstoneUi";
import { flow, fit, SYSTEMS, WORKLOADS, FLOW_INPUTS, FIT_INPUTS, type SystemId } from "../../sims/dist/capstone";

export function FlowCompareDemo() {
  const [op, setOp] = useState<"write" | "read">("write");
  const [direct, setDirect] = useState(false);
  const [eventual, setEventual] = useState(false);
  const flows = useMemo(() => SYSTEMS.map((s) => ({ ...s, f: flow(s.id, op, direct, eventual && s.id !== "crdb") })), [op, direct, eventual]);
  const tEnd = Math.max(...flows.map((x) => x.f.end)) + 0.25;
  const [t, setT] = useState(tEnd);
  const cur = Math.min(t, tEnd);
  return (
    <Demo
      title="One request in three systems"
      controls={
        <>
          <Param spec={range({ label: "Time", min: 0, max: tEnd, step: 0.25, default: tEnd, format: (v) => `${fixed(v, 2)} ms` })} value={cur} onChange={(v) => setT(v as number)} />
          <Param spec={seg<"write" | "read">("Request", [["write", "one write"], ["read", "one read"]], "write")} value={op} onChange={(v) => { setOp(v as "write" | "read"); setT(99); }} />
          <Param spec={toggle({ label: "The client reaches the leader (etcd) or the leaseholder is the gateway (CockroachDB)", default: false })} value={direct} onChange={(v) => { setDirect(v as boolean); setT(99); }} />
          {op === "read" && <Param spec={toggle({ label: "Stale reads allowed (etcd serializable, DynamoDB eventually consistent)", default: false })} value={eventual} onChange={(v) => { setEventual(v as boolean); setT(99); }} />}
        </>
      }
    >
      {flows.map(({ id, name, f }) => {
        const messages: StMessage[] = f.msgs.filter((m) => m.sentAt <= cur).map((m) => ({
          from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: Math.min(m.deliveredAt, Math.max(m.sentAt + 0.01, cur)), label: m.critical ? m.label : undefined,
          color: m.critical ? "var(--c1)" : "var(--faint)", dashed: !m.critical,
        }));
        const marks: StMark[] = f.marks.filter((k) => k.t <= cur).map((k) => k.until !== undefined
          ? { node: k.node, t: k.t, until: Math.min(k.until, cur), shape: "bar" as const, color: "var(--c2)", label: k.label }
          : { node: k.node, t: k.t, label: k.label, color: "var(--c3)" });
        return (
          <div key={id} style={{ marginBottom: 6 }}>
            <SmallLabel style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <b style={{ color: "var(--fg)" }}>{name}</b>
              <span style={mono}>{f.messages} messages · {f.hops} hops on the critical path · {fixed(f.end, 1)} ms{cur >= f.end ? " · done" : ""}</span>
            </SmallLabel>
            <SpaceTime nodes={f.nodes} tEnd={tEnd} messages={messages} marks={marks} rowHeight={30} cursor={cur} />
          </div>
        );
      })}
      <Note>Rows: etcd's leader L and followers A and C; CockroachDB's gateway, leaseholder (lh) and two more replicas; DynamoDB's request router, the leader in one Availability Zone and replicas in two others. Model inputs: every hop between machines takes {FLOW_INPUTS.hop} ms and every fsync {FLOW_INPUTS.fsync} ms. Blue arrows decide the answer time; faint dashed ones are needed but not waited for (the slower follower, the commit notice). Orange bars are fsyncs.</Note>
    </Demo>
  );
}

const fmtRatio = (x: number) => (!Number.isFinite(x) ? "grows" : x >= 10 ? `${Math.round(x)}×` : `${fixed(x, 1)}×`);

export function WorkloadFitDemo() {
  const [wid, setWid] = useState(WORKLOADS[0]!.id);
  const w = WORKLOADS.find((x) => x.id === wid)!;
  const fits = useMemo(() => SYSTEMS.map((s) => ({ ...s, r: fit(s.id as SystemId, w) })), [w]);
  const cell = (x: number) => <span style={{ color: x < 1 ? "var(--c4)" : "var(--fg)", ...mono }}>{fmtRatio(x)}</span>;
  return (
    <Demo title="Workload fit" controls={<Param spec={seg("Workload", WORKLOADS.map((x) => [x.id, x.name] as [string, string]), WORKLOADS[0]!.id)} value={wid} onChange={(v) => setWid(v as string)} />}>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>
        <b>{w.name}:</b> {w.dataGiB.toLocaleString("en-US")} GiB, {w.writesPerSec.toLocaleString("en-US")} writes/s and {w.readsPerSec.toLocaleString("en-US")} reads/s, {w.hotKeyWrites.toLocaleString("en-US")} writes/s to the hottest key, transactions over {w.txnKeys} key{w.txnKeys > 1 ? "s" : ""}, {w.strongReads ? "reads must be linearizable" : "stale reads are fine"}.
      </p>
      <MiniTable
        head={["", ...fits.map((x) => x.name)]}
        rows={[
          ["size headroom", ...fits.map((x) => cell(x.r.size))],
          ["write headroom", ...fits.map((x) => cell(x.r.throughput))],
          ["hot-key headroom", ...fits.map((x) => cell(x.r.hotKey))],
          ["transaction size", ...fits.map((x) => (x.r.txn ? "ok" : <span style={{ color: "var(--c4)" }}>too large</span>))],
          ["mean latency", ...fits.map((x) => <span style={mono}>{fixed(x.r.latencyMs, 2)} ms</span>)],
          ["fit", ...fits.map((x) => <Verdict ok={x.r.fits}>{x.r.fits ? "fits" : "no"}</Verdict>)],
        ]}
      />
      {fits.filter((x) => !x.r.fits).map(({ id, name, r }) => <Banner key={id} ok={false}>{name}: {r.why.join("; ")}.</Banner>)}
      {fits.every((x) => x.r.fits) && <Banner ok>All three fit. Then the choice turns on the rest: watches and leases (etcd), SQL and transactions (CockroachDB), or a managed service that you do not operate (DynamoDB).</Banner>}
      <Note>Headroom is capacity divided by need; below 1× does not fit. Model inputs: one leader commits {FIT_INPUTS.leaderWrites.toLocaleString("en-US")} writes/s, CockroachDB has {FIT_INPUTS.crdbNodes} nodes with {FIT_INPUTS.replicas} replicas per range. Published limits: etcd's suggested {FIT_INPUTS.etcdMaxGiB} GiB maximum, {FIT_INPUTS.dynamoPartitionWrites.toLocaleString("en-US")} write units per second per DynamoDB partition, {FIT_INPUTS.dynamoTxnItems} items per DynamoDB transaction. Latency is the mix of the flows above.</Note>
    </Demo>
  );
}
