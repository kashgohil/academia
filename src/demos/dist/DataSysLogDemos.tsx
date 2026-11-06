/** Demos for "Distributed logs": a consumer group with rebalances and lag, and a replicated partition with ISR. */
import { useMemo } from "react";
import {
  Banner, Chip, Demo, Legend, Line, Param, Plot, RuleX, SmallLabel, StepButtons, StepSlider, Stats, int, range, seg,
  toggle, useParams, useStepper, useWidth, MONO,
} from "../../kit";
import { runGroup, type Assignor, type Protocol } from "../../sims/dist/data-systems/groups";
import { BROKERS, runRepLog, type Acks, type RepLogRun } from "../../sims/dist/data-systems/replog";

// ============================================================================ 1. A consumer group

const CG = {
  after: range({ label: "Consumers after the change at 20 s", min: 1, max: 8, step: 1, default: 4 }),
  assignor: seg<Assignor>("Assignor", [["range", "range"], ["round-robin", "round-robin"], ["sticky", "sticky"]], "range"),
  protocol: seg<Protocol>("Rebalance", [["eager", "eager (stop all)"], ["cooperative", "cooperative"]], "eager"),
  crash: toggle({ label: "One consumer crashes at 60 s", default: false }),
};

const CONSUMER_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)", "var(--muted)", "var(--fg)", "var(--faint)"];
const cname = (i: number) => `c${i + 1}`;

export function ConsumerGroupDemo() {
  const P = useParams("dist-ds-group", CG);
  const { after, assignor, protocol, crash } = P.values;
  const run = useMemo(() => {
    const events: { t: number; op: "join" | "leave" | "crash"; id: string }[] = [];
    if (after > 2) for (let i = 2; i < after; i++) events.push({ t: 20, op: "join", id: cname(i) });
    if (after < 2) events.push({ t: 20, op: "leave", id: "c2" });
    if (crash) events.push({ t: 60, op: "crash", id: cname(Math.max(after, 1) - 1) });
    return runGroup({ assignor, protocol, events, capacity: 250 });
  }, [after, assignor, protocol, crash]);
  const P6 = run.cfg.partitions;
  const colorOf = (id: string | null) => (id ? CONSUMER_COLORS[Number(id.slice(1)) - 1]! : "var(--faint)");
  const maxLag = Math.max(...run.total);
  const yMax = Math.max(2000, maxLag * 1.1);
  const final = run.assignments[run.assignments.length - 1]!;
  const idle = final.members.filter((m) => !final.owner.includes(m));
  const pausedSec = run.paused.reduce((a, [x, y]) => a + (y - x), 0);

  return (
    <Demo
      title="A consumer group: assignment, rebalances and lag"
      controls={<>
        <Param spec={CG.after} value={after} onChange={(v) => P.set("after", v as number)} />
        <Param spec={CG.assignor} value={assignor} onChange={(v) => P.set("assignor", v as Assignor)} />
        <Param spec={CG.protocol} value={protocol} onChange={(v) => P.set("protocol", v as Protocol)} />
        <Param spec={CG.crash} value={crash} onChange={(v) => P.set("crash", v as boolean)} />
      </>}
    >
      <SmallLabel>6 partitions, 100 records/s each. Each consumer reads up to 250 records/s (model inputs). Two consumers at the start.</SmallLabel>
      <div style={{ display: "grid", gap: 4, margin: "6px 0 8px" }}>
        {run.assignments.map((a, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12, width: 92, fontFamily: MONO }}>{a.t === 0 ? "start" : `t = ${a.t} s`}{a.moved ? `, ${a.moved} moved` : ""}</span>
            {a.owner.map((o, p) => <Chip key={p} color={colorOf(o)} filled={!!o}>{`p${p}→${o ?? "–"}`}</Chip>)}
          </div>
        ))}
      </div>
      <Plot x={[0, run.cfg.horizon]} y={[0, yMax]} height={210} xLabel="time (s)" yLabel="lag (records)">
        {Array.from({ length: P6 }, (_, p) => <Line key={p} points={run.t.map((t, i) => [t, run.lag[i]![p]!] as [number, number])} color="var(--faint)" width={1} />)}
        <Line points={run.t.map((t, i) => [t, run.total[i]!] as [number, number])} color="var(--c1)" width={2} />
        {run.assignments.slice(1).map((a, i) => <RuleX key={i} at={a.t} color="var(--c2)" />)}
        {crash && <RuleX at={60} color="var(--c4)" label="crash" />}
      </Plot>
      <Legend items={[{ label: "total lag", color: "var(--c1)" }, { label: "lag of each partition", color: "var(--faint)" }, { label: "rebalance", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "largest total lag", value: int(maxLag) },
        { label: "lag at the end", value: int(run.total[run.total.length - 1]!) },
        { label: "partition-seconds with no reads (rebalances)", value: int(pausedSec) },
        { label: "idle consumers at the end", value: idle.length ? idle.join(", ") : "none" },
      ]} />
      <Banner tone={idle.length ? "warn" : run.total[run.total.length - 1]! > 500 ? "bad" : "good"}>
        {idle.length
          ? `${idle.length} consumer${idle.length > 1 ? "s have" : " has"} no partition: a group cannot use more consumers than partitions.`
          : run.total[run.total.length - 1]! > 500
            ? "The group reads slower than producers write, so lag grows. Add consumers, or spread the busiest partitions."
            : crash
              ? "The crashed consumer's partitions were not read until the coordinator noticed it, 45 s later (session.timeout.ms). Then the lag drained."
              : "Lag drains after each rebalance. The cost of a rebalance is the time in which moved partitions are not read."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Replication: ISR, HW and acks

const RL = {
  crashAt: range({ label: "Leader crashes at", min: 100, max: 380, step: 5, default: 200, format: (v) => `${v} ms` }),
  acks: seg<Acks>("acks", [["0", "0"], ["1", "1"], ["all", "all"]], "1"),
  minIsr: seg<"1" | "2" | "3">("min.insync.replicas", [["1", "1"], ["2", "2"], ["3", "3"]], "2"),
  pause: seg<"0" | "40" | "100">("Followers pause before the crash", [["0", "no"], ["40", "40 ms (stay in ISR)"], ["100", "100 ms (leave ISR)"]], "40"),
  unclean: toggle({ label: "unclean.leader.election.enable", default: false }),
};

export function IsrReplicationDemo() {
  const P = useParams("dist-ds-isr", RL);
  const { crashAt, acks, minIsr, pause, unclean } = P.values;
  const pz = Number(pause);
  const run = useMemo(() => runRepLog({
    acks, minIsr: Number(minIsr), unclean,
    stalls: pz ? [2, 3].map((node) => ({ node, from: crashAt - pz, until: crashAt + 200 })) : [],
    crashes: [{ t: crashAt, node: 1 }], recovers: [{ t: crashAt + 250, node: 1 }],
  }), [crashAt, acks, minIsr, pz, unclean]);
  const s = useStepper(run.frames.length, 12);
  const [wref, width] = useWidth<HTMLDivElement>();
  const cell = Math.max(12, Math.min(18, Math.floor((width - 78) / 20) - 2));
  const fr = run.frames[s.i]!;
  const lost = new Set(run.lost);
  const seenLost = new Set(run.seenThenLost);
  const ackedNow = new Set(fr.acked);

  return (
    <Demo
      title="One partition, three replicas: ISR, high watermark and acks"
      controls={<>
        <Param spec={RL.crashAt} value={crashAt} onChange={(v) => P.set("crashAt", v as number)} />
        <Param spec={RL.acks} value={acks} onChange={(v) => P.set("acks", v as Acks)} />
        <Param spec={RL.minIsr} value={minIsr} onChange={(v) => P.set("minIsr", v as typeof minIsr)} />
        <Param spec={RL.pause} value={pause} onChange={(v) => P.set("pause", v as typeof pause)} />
        <Param spec={RL.unclean} value={unclean} onChange={(v) => P.set("unclean", v as boolean)} />
      </>}
    >
      <SmallLabel>The producer sends record 1 to 20, one every 20 ms. Broker 1 leads. It restarts 250 ms after its crash. Times are scaled-down model inputs.</SmallLabel>
      <div ref={wref} style={{ display: "grid", gap: 6, margin: "6px 0" }}>
        {BROKERS.map((b, i) => <BrokerRow key={b} cell={cell} b={b} f={fr.brokers[i]!} leader={fr.leader === b} inIsr={fr.isr.includes(b)} lost={lost} seenLost={seenLost} />)}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12, width: 70 }}>producer: acked</span>
        {run.sent.map((id) => {
          const rej = run.rejected.find((r) => r.id === id);
          const on = ackedNow.has(id);
          return <Chip key={id} color={lost.has(id) && on ? "var(--c4)" : on ? "var(--c3)" : "var(--faint)"} filled={on} strike={!!rej && rej.t <= fr.t} faint={!on && !(rej && rej.t <= fr.t)}>{id}</Chip>;
        })}
      </div>
      <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}><StepButtons s={s} /></div>
      <StepSlider s={s} label="Time" />
      <Banner label={`${Math.round(fr.t)} ms`} min={42}>{lastNote(run, s.i) ?? "Followers fetch from the leader. The HW moves when every ISR member has a record."}</Banner>
      <Legend items={[{ label: "committed (below the HW)", color: "var(--c1)" }, { label: "not committed", color: "var(--muted)" }, { label: "acknowledged then lost", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "records acknowledged", value: run.acked.length },
        { label: "rejected (no leader, or ISR too small)", value: run.rejected.length },
        { label: "acknowledged and lost", value: run.lost.length },
        { label: "read by consumers, then lost", value: run.seenThenLost.length },
      ]} />
      <Banner tone={run.lost.length || run.seenThenLost.length ? "bad" : run.rejected.length ? "warn" : "good"}>
        {run.lost.length
          ? `${run.lost.length} acknowledged record${run.lost.length > 1 ? "s were" : " was"} lost (${run.lost.join(", ")}). ${acks === "1" ? "acks=1 confirms before any follower has the record." : acks === "0" ? "acks=0 confirms nothing." : "An unclean election picked a replica that did not have them."}`
          : run.seenThenLost.length
            ? `No acknowledged record was lost, but consumers read records ${run.seenThenLost.join(", ")} and then they vanished: the unclean leader never had them.`
            : run.rejected.length
              ? `No acknowledged record was lost. The price: ${run.rejected.length} records were refused while the partition had too few in-sync replicas or no leader.`
              : "No loss, no refusals. Try a 40 ms pause with acks=1, or a 100 ms pause with min.insync.replicas = 1 and unclean election on."}
      </Banner>
    </Demo>
  );
}

function lastNote(run: RepLogRun, i: number): string | undefined {
  for (let j = i; j >= 0; j--) if (run.frames[j]!.note) return run.frames[j]!.note;
  return undefined;
}

function BrokerRow({ b, f, leader, inIsr, lost, seenLost, cell }: { cell: number; b: number; f: RepLogRun["frames"][number]["brokers"][number]; leader: boolean; inIsr: boolean; lost: Set<number>; seenLost: Set<number> }) {
  const status = !f.up ? "down" : leader ? "leader" : f.role === "follower" ? "follower" : "waiting";
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
      <div style={{ width: 70, flex: "0 0 70px", fontSize: 12 }}>
        <div style={{ fontWeight: 600, color: f.up ? "var(--fg)" : "var(--c4)" }}>b{b} {status}</div>
        <div className="muted" style={{ fontSize: 11 }}>{inIsr ? "in ISR" : "not in ISR"}</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, minWidth: 0, opacity: f.up ? 1 : 0.4 }}>
        {Array.from({ length: 20 }, (_, o) => {
          const r = f.log[o];
          const committed = o < f.hw;
          const bad = r && (lost.has(r.v) || seenLost.has(r.v));
          return (
            <span key={o} title={r ? `offset ${o}: record ${r.v}, epoch ${r.epoch}` : `offset ${o}`} style={{
              width: cell, height: 20, fontSize: cell < 16 ? 8.5 : 10, lineHeight: "18px", textAlign: "center", fontFamily: MONO, borderRadius: 3,
              border: `1.5px ${r ? "solid" : "dashed"} ${bad ? "var(--c4)" : r ? (committed ? "var(--c1)" : "var(--muted)") : "var(--border)"}`,
              background: r && committed ? (bad ? "var(--c4)" : "var(--c1)") : "var(--bg)", color: r && committed ? "var(--bg)" : "var(--fg)",
              boxShadow: o === f.hw ? "inset 2px 0 0 var(--c2)" : undefined,
            }}>{r ? r.v : ""}</span>
          );
        })}
      </div>
    </div>
  );
}
