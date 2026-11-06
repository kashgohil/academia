/** Demos for "Replication lag and read-your-writes": reads from lagging replicas, and lag under a write burst. */
import { useMemo } from "react";
import { Demo, Param, Plot, Line, RuleX, Legend, Stats, range, seg, useParams, Banner, MiniTable, SectionLabel, fixed, pct } from "../../kit";
import { LAG_DEFAULTS, READ_FIXES, runLag, summarize, checkAnomalies, runBurst, burstModel, BURST_DEFAULTS, type ReadFix, type Anomaly } from "../../sims/dist/replication";
import { SpaceTime, type StMark } from "./SpaceTime";

const FIX_NAME: Record<ReadFix, string> = { none: "any follower", leader: "leader only", sticky: "sticky follower", lsn: "wait for LSN" };
const KIND_NAME: Record<Anomaly["kind"], string> = { ryw: "read-your-writes", monotonic: "monotonic reads", prefix: "consistent prefix" };

const READS = {
  delay: range({ label: "Follower delay (F1; F2 has 2.5×)", min: 0, max: 60, step: 1, default: 15, format: (v) => `${v} ms` }),
  fix: seg<ReadFix>("Reads go to", READ_FIXES.map((f) => [f, FIX_NAME[f]]), "none"),
};

export function ReplicationReadAnomalyDemo() {
  const P = useParams("repl-reads", READS);
  const { delay, fix } = P.values;
  const delayMs = [delay, delay * 2.5];
  const small = useMemo(() => runLag({ ...LAG_DEFAULTS, delayMs, fix, sessions: 2, ops: 8, seed: 3 }), [delay, fix]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useMemo(() => READ_FIXES.map((f) => summarize(runLag({ ...LAG_DEFAULTS, delayMs, fix: f }))), [delay]); // eslint-disable-line react-hooks/exhaustive-deps
  const mine = small.history.filter((o) => o.session === 0);
  const anomalies = checkAnomalies(small.history, small.log).filter((a) => a.op.session === 0);
  const bad = new Map<object, Anomaly[]>();
  for (const a of anomalies) bad.set(a.op, [...(bad.get(a.op) ?? []), a]);
  const client = 3;
  const keep = small.net.messages.filter((m) => m.from === client || m.to === client || (m.payload.k === "entry" && m.payload.key === "k0"));
  const tEnd = Math.max(40, ...mine.map((o) => o.end)) + 4;
  const marks: StMark[] = mine.filter((o) => o.kind === "read").map((o) => ({ node: client, t: o.end, color: bad.has(o) ? "var(--c4)" : "var(--c3)" }));
  const cur = table[READ_FIXES.indexOf(fix)]!;
  const total = cur.ryw + cur.monotonic + cur.prefix;
  const rname = (r: number) => (r === 0 ? "leader" : `F${r}`);
  return (
    <Demo
      title="Reads from lagging followers"
      controls={<>
        <Param spec={READS.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={READS.fix} value={fix} onChange={(v) => P.set("fix", v as ReadFix)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>One session: write k0, read it, read it again, read another key</SectionLabel>
      <SpaceTime
        nodes={["leader", "F1", "F2", "client"]}
        tEnd={tEnd}
        rowHeight={40}
        messages={keep.map((m) => ({
          from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt,
          color: m.payload.k === "entry" ? "var(--faint)" : m.payload.k === "write" || m.payload.k === "wrote" ? "var(--c1)" : "var(--fg)",
          label: m.payload.k === "write" ? "write" : m.payload.k === "entry" ? `${m.payload.lsn}` : undefined,
        }))}
        marks={marks}
      />
      <MiniTable
        head={["op", "saw", "result"]}
        rows={mine.map((o) => [
          o.kind === "write" ? `write ${o.key}` : `read ${o.key} at ${rname(o.replica)}`,
          o.kind === "write" ? `LSN ${o.version}` : o.version ? `LSN ${o.version}` : "nothing",
          o.kind === "write" ? "" : bad.has(o) ? <span style={{ color: "var(--c4)" }}>{bad.get(o)!.map((a) => `breaks ${KIND_NAME[a.kind]} (wanted ${a.want})`).join("; ")}</span> : <span style={{ color: "var(--c3)" }}>ok</span>,
        ])}
      />
      <SectionLabel>Three sessions, 270 reads, every fix: anomalies found</SectionLabel>
      <MiniTable
        head={["reads go to", "own writes", "monotonic", "prefix", "read ms"]}
        rows={table.map((s) => [FIX_NAME[s.fix], s.ryw, s.monotonic, s.prefix, fixed(s.meanReadMs, 1)])}
        highlight={READ_FIXES.indexOf(fix)}
      />
      <Banner ok={total === 0}>
        {total === 0
          ? fix === "leader"
            ? `No anomalies, because one node serves every read. But the leader now serves ${pct(cur.leaderReads, 0)} of the reads, and the followers only stand by.`
            : fix === "lsn"
              ? `No anomalies. Each read carries the highest LSN that the session has written or seen, and the follower waits until it has applied it. The cost is wait: the mean read takes ${fixed(cur.meanReadMs, 1)} ms.`
              : "No anomalies at this delay: the followers keep up."
          : `${total} anomalies in ${cur.reads} reads.${fix === "sticky" ? " A sticky follower moves only forward, so reads never go back in time. But it can still be behind your own write." : ""}`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ lag under a burst

const BURST = {
  burstRate: range({ label: "Burst rate", min: 300, max: 3000, step: 100, default: BURST_DEFAULTS.burstRate, format: (v) => `${v} writes/s` }),
  burstMs: range({ label: "Burst length", min: 100, max: 600, step: 50, default: BURST_DEFAULTS.burstMs, format: (v) => `${v} ms` }),
  apply2: range({ label: "F2 replay cost per entry (model input)", min: 0.4, max: 3, step: 0.1, default: 1.6, format: (v) => `${v.toFixed(1)} ms` }),
};

export function ReplicationLagBurstDemo() {
  const P = useParams("repl-burst", BURST);
  const { burstRate, burstMs, apply2 } = P.values;
  const cfg = useMemo(() => ({ ...BURST_DEFAULTS, burstRate, burstMs, applyMs: [BURST_DEFAULTS.applyMs[0]!, apply2] }), [burstRate, burstMs, apply2]);
  const r = useMemo(() => runBurst(cfg), [cfg]);
  const m = [burstModel(cfg, 0), burstModel(cfg, 1)];
  const ymax = Math.max(50, ...r.peak) * 1.1;
  const line = (i: number) => r.samples.map((s) => [s[0]!, s[i + 1]!] as [number, number]);
  const catchText = (i: number) => (Number.isFinite(r.catchUp[i]!) ? `${Math.round(r.catchUp[i]!)} ms` : "not in this run");
  return (
    <Demo
      title="Lag under a write burst"
      controls={<>
        <Param spec={BURST.burstRate} value={burstRate} onChange={(v) => P.set("burstRate", v as number)} />
        <Param spec={BURST.burstMs} value={burstMs} onChange={(v) => P.set("burstMs", v as number)} />
        <Param spec={BURST.apply2} value={apply2} onChange={(v) => P.set("apply2", v as number)} />
      </>}
    >
      <Plot x={[0, cfg.end]} y={[0, ymax]} height={240} xLabel="time (ms)" yLabel="lag: age of the oldest unapplied change (ms)">
        <RuleX at={cfg.burstAt} label="burst" />
        <RuleX at={cfg.burstAt + cfg.burstMs} />
        <Line points={line(0)} color="var(--c1)" />
        <Line points={line(1)} color="var(--c2)" />
      </Plot>
      <Legend items={[{ label: `F1: replays ${Math.round(m[0]!.mu)} entries/s`, color: "var(--c1)" }, { label: `F2: replays ${Math.round(m[1]!.mu)} entries/s`, color: "var(--c2)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "F1 peak lag (queue model)", value: `${Math.round(r.peak[0]!)} ms (${Math.round(m[0]!.peakLagMs)})` },
          { label: "F2 peak lag (queue model)", value: `${Math.round(r.peak[1]!)} ms (${Math.round(m[1]!.peakLagMs)})` },
          { label: "F1 back to normal after the burst", value: catchText(0) },
          { label: "F2 back to normal after the burst", value: catchText(1) },
        ]} />
      </div>
      <Banner ok={m[1]!.backlog === 0 ? true : null}>
        {m[1]!.backlog === 0
          ? `F2 replays ${Math.round(m[1]!.mu)} entries/s, which is more than the burst rate. No queue forms, and the lag stays near the network delay.`
          : `During the burst the leader commits ${burstRate} writes/s, but F2 replays only ${Math.round(m[1]!.mu)}. A queue of ${Math.round(m[1]!.backlog)} entries builds up, and the lag keeps growing until the queue drains.`}
      </Banner>
    </Demo>
  );
}
