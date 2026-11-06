/** Demos for the Spanner and TrueTime lesson: commit wait on a timeline, and what commit wait costs. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, Dots, Param, Plot, RuleX, SectionLabel, Stats, fixed, range, seg, sig, toggle, useParams } from "../../kit";
import { SpaceTime, type StMark } from "./SpaceTime";
import { stMessages } from "./DistTxnUi";
import { externalRun, hotKeyRun, commitLatency, EPS_SWEEP, DEFAULT_EXT, DEFAULT_HOT } from "../../sims/dist/transactions/truetime";

const sgn = (x: number) => `${x >= 0 ? "+" : "−"}${fixed(Math.abs(x), 1)}`;

// ============================================================================ 1. Commit wait on a timeline

const CW = {
  eps: range({ label: "Uncertainty $\\varepsilon$", min: 1, max: 20, step: 0.5, default: 4, format: (x) => `${x} ms` }),
  clocks: seg<"worst" | "exact" | "reverse">("Clock errors", [["worst", "A fast, B slow"], ["exact", "both exact"], ["reverse", "A slow, B fast"]], "worst"),
  gap: range({ label: "Client waits after T1's ack", min: 0, max: 20, step: 0.5, default: 1, format: (x) => `${x} ms` }),
  wait: toggle({ label: "Commit wait", default: true }),
};

export function DistTxnCommitWaitDemo() {
  const P = useParams("dist-txn-cw", CW);
  const v = P.values;
  const err = v.clocks === "worst" ? [v.eps, -v.eps] : v.clocks === "reverse" ? [-v.eps, v.eps] : [0, 0];
  const r = useMemo(() => externalRun({ ...DEFAULT_EXT, eps: v.eps, errA: err[0]!, errB: err[1]!, gap: v.gap, commitWait: v.wait }), [v.eps, v.clocks, v.gap, v.wait]); // eslint-disable-line react-hooks/exhaustive-deps
  const tEnd = Math.max(...r.net.messages.map((m) => m.deliveredAt ?? 0)) + 4;
  const msgs = stMessages(r.net.messages, (m) => (m.payload.k === "commit" ? `commit T${m.payload.txn}` : `ack T${m.payload.txn}`), tEnd);
  const bar = (node: number, t: { arrive: number; visible: number; extraWait: number }, name: string): StMark => ({ node, t: t.arrive, until: t.visible, shape: "bar", color: t.extraWait > 0 ? "var(--c2)" : "var(--c1)", label: t.extraWait > 0 ? `${name}: wait ${fixed(t.visible - t.arrive, 1)}` : `${name}: Paxos` });
  const marks: StMark[] = [bar(1, r.t1, "T1"), bar(2, r.t2, "T2"), { node: 1, t: r.t1.arrive, label: `s1=${fixed(r.t1.s, 1)}` }, { node: 2, t: r.t2.arrive, label: `s2=${fixed(r.t2.s, 1)}` }];
  const lo = Math.min(0, r.t1.s, r.t2.s) - 2, hi = Math.max(r.t1.s, r.t2.s, r.ack1, r.start2) + 3;
  return (
    <Demo
      title="Commit wait: T1 commits, then T2 starts"
      controls={<>
        <Param spec={CW.eps} value={v.eps} onChange={(y) => P.set("eps", y as number)} />
        <Param spec={CW.gap} value={v.gap} onChange={(y) => P.set("gap", y as number)} />
        <Param spec={CW.clocks} value={v.clocks} onChange={(y) => P.set("clocks", y as "worst" | "exact" | "reverse")} />
        <Param spec={CW.wait} value={v.wait} onChange={(y) => P.set("wait", y as boolean)} />
      </>}
    >
      <SpaceTime nodes={["client", "server A", "server B"]} tEnd={tEnd} messages={msgs} marks={marks} timeLabel="true time (ms)" />
      <SectionLabel>Commit timestamps against true time</SectionLabel>
      <Plot x={[lo, hi]} y={[0, 1]} height={92} xLabel="ms" yTicks={[]} grid={false}>
        <RuleX at={r.ack1} color="var(--muted)" label="T1 acked" />
        <RuleX at={r.start2} color="var(--muted)" dash="2 2" />
        <Dots points={[[r.t1.s, 0.35]]} color="var(--c1)" r={5} />
        <Dots points={[[r.t2.s, 0.35]]} color={r.ok ? "var(--c3)" : "var(--c4)"} r={5} />
      </Plot>
      <Legend items={[{ label: `s1 = ${fixed(r.t1.s, 1)}`, color: "var(--c1)" }, { label: `s2 = ${fixed(r.t2.s, 1)}`, color: r.ok ? "var(--c3)" : "var(--c4)" }, { label: "dotted: T2 starts", color: "var(--muted)" }]} />
      <Banner ok={r.ok}>
        {r.ok
          ? v.wait
            ? `T1 picked s1 = ${fixed(r.t1.s, 1)} and waited until TT.after(s1), so its ack left after true time ${fixed(r.t1.s, 1)}. T2 started later and picked s2 = ${fixed(r.t2.s, 1)} > s1. External consistency holds.`
            : `s1 < s2 this time, but only because the clocks were kind. Pick "A fast, B slow" and a short gap.`
          : `T1 committed first in real time, but T2 got the smaller timestamp: s2 = ${fixed(r.t2.s, 1)} < s1 = ${fixed(r.t1.s, 1)}. A snapshot read at ${fixed(r.t2.s, 1)} sees T2 and not T1. External consistency is broken.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "clock errors A, B", value: `${sgn(err[0]!)}, ${sgn(err[1]!)} ms` },
          { label: "T1 commit time at A", value: `${fixed(r.t1.visible - r.t1.arrive, 1)} ms` },
          { label: "of which commit wait beyond Paxos", value: `${fixed(r.t1.extraWait, 1)} ms` },
          { label: "$2\\varepsilon$", value: `${fixed(2 * v.eps, 1)} ms` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. What commit wait costs

const COST = {
  paxos: range({ label: "Paxos write of the commit record (model input)", min: 1, max: 50, step: 1, default: DEFAULT_HOT.paxos, format: (x) => `${x} ms` }),
  eps: range({ label: "Mark $\\varepsilon$", min: 0.5, max: 250, log: true, default: 4, format: (x) => `${x} ms` }),
};

const EPS_TICKS = [0.5, 1, 2, 5, 10, 20, 50, 100, 250];

export function DistTxnCommitCostDemo() {
  const P = useParams("dist-txn-cwcost", COST);
  const v = P.values;
  const pts = useMemo(() => EPS_SWEEP.map((e) => ({
    e,
    tw: hotKeyRun({ ...DEFAULT_HOT, eps: e, paxos: v.paxos }).throughput,
    tn: hotKeyRun({ ...DEFAULT_HOT, eps: e, paxos: v.paxos, commitWait: false }).throughput,
    lw: commitLatency(e, true, v.paxos),
    ln: commitLatency(e, false, v.paxos),
  })), [v.paxos]);
  const here = useMemo(() => ({ t: hotKeyRun({ ...DEFAULT_HOT, eps: v.eps, paxos: v.paxos }).throughput, l: commitLatency(v.eps, true, v.paxos) }), [v.eps, v.paxos]);
  // Commit wait starts to cost when 2ε exceeds the Paxos write.
  const knee = v.paxos / 2;
  return (
    <Demo title="Commit wait against the uncertainty ε" controls={<><Param spec={COST.eps} value={v.eps} onChange={(y) => P.set("eps", y as number)} /><Param spec={COST.paxos} value={v.paxos} onChange={(y) => P.set("paxos", y as number)} /></>}>
      <SectionLabel>Commits per second on one hot row (8 clients)</SectionLabel>
      <Plot x={[0.5, 250]} y={[1, 2000]} logX logY height={200} xLabel="ε (ms)" xTicks={EPS_TICKS} yTicks={[1, 10, 100, 1000]} yFormat={(t) => sig(t)}>
        <Line points={pts.map((p) => [p.e, p.tn])} color="var(--muted)" dash="4 3" />
        <Line points={pts.map((p) => [p.e, p.tw])} color="var(--c1)" />
        <Dots points={pts.map((p) => [p.e, p.tw])} color="var(--c1)" />
        <RuleX at={knee} color="var(--faint)" label="2ε = Paxos" />
        <RuleX at={v.eps} color="var(--c2)" />
      </Plot>
      <SectionLabel>Latency of one commit, no contention</SectionLabel>
      <Plot x={[0.5, 250]} y={[1, 1000]} logX logY height={180} xLabel="ε (ms)" xTicks={EPS_TICKS} yTicks={[1, 10, 100, 1000]} yFormat={(t) => sig(t)}>
        <Line points={pts.map((p) => [p.e, p.ln])} color="var(--muted)" dash="4 3" />
        <Line points={pts.map((p) => [p.e, p.lw])} color="var(--c1)" />
        <RuleX at={v.eps} color="var(--c2)" />
      </Plot>
      <Legend items={[{ label: "with commit wait", color: "var(--c1)" }, { label: "no commit wait (not externally consistent)", color: "var(--muted)" }]} />
      <Banner tone={2 * v.eps <= v.paxos ? "good" : 2 * v.eps < 4 * v.paxos ? "warn" : "bad"}>
        {2 * v.eps <= v.paxos
          ? `At ε = ${v.eps} ms the wait of 2ε hides inside the ${v.paxos} ms Paxos write. Commit wait is free.`
          : `At ε = ${v.eps} ms the row stays locked for 2ε = ${fixed(2 * v.eps, 1)} ms, longer than the ${v.paxos} ms Paxos write. Throughput on the row falls to ${sig(here.t)} commits per second.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "lock hold per commit", value: `${fixed(Math.max(v.paxos, 2 * v.eps), 1)} ms` },
          { label: "hot-row commits/s", value: sig(here.t) },
          { label: "commit latency", value: `${fixed(here.l, 1)} ms` },
        ]} />
      </div>
    </Demo>
  );
}
