/** Demos for "BBR". Every run is a PacketNet run of src/sims/net/cc. */
import { useMemo } from "react";
import { Area, Banner, Demo, Dots, Legend, Line, Param, Plot, RuleX, RuleY, Stats, fixed, pct, range, seg, sig, useChunked, useParams } from "../../kit";
import {
  BBR_EVENT_AT, BBR_LINE, BBR_LOSS, BBR_LOSS_RATES, OP, VS, bbrLossScenario, bbrTimelineScenario, bdpPackets, idealPoint, operatingPoint,
  vsScenario, type BbrEvent, type OperatingPoint,
} from "../../sims/net/cc";
import { Bands, FLOW_COLORS, RunProgress, smooth, spansOf, useCcRun, useScenarioSweep, useSweep } from "./NetCcUi";

// ============================================================================ 1. The operating point

const OPP = {
  win: range({ label: "In flight (fixed window)", min: 0.25, max: 6, step: 0.25, default: 2, format: (v) => `${fixed(v, 2)} × BDP` }),
  buf: range({ label: "Buffer", min: 0.5, max: 4, step: 0.5, default: 2, format: (v) => `${fixed(v, 1)} × BDP` }),
};
const OP_WINDOWS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];

export function NetCcOperatingPointDemo() {
  const P = useParams("net-cc-op", OPP);
  const { win, buf } = P.values;
  const bdp = bdpPackets(OP.mbps, OP.rttMs);
  const queue = Math.round(buf * bdp);
  const jobs = useMemo(() => OP_WINDOWS.map((w) => () => operatingPoint(OP.mbps, OP.rttMs, queue, Math.round(w * bdp))), [queue, bdp]);
  const sweep = useSweep(`net-cc-op-${queue}`, jobs);
  const cur = useChunked(`net-cc-op-${queue}-${win}`, [() => operatingPoint(OP.mbps, OP.rttMs, queue, Math.round(win * bdp))], { keep: true })[0];
  const pts = sweep.res.filter((p): p is OperatingPoint => !!p);
  const xs = Array.from({ length: 121 }, (_, i) => (i / 120) * 6 * bdp);
  const ideal = xs.map((x) => ({ x, ...idealPoint(OP.mbps, OP.rttMs, queue, x) }));
  const xMax = 6 * bdp;
  const yRtt = OP.rttMs * (1 + queue / bdp) * 1.15;
  const marks = (
    <>
      <RuleX at={bdp} color="var(--c3)" label="BDP" />
      <RuleX at={bdp + queue} color="var(--c4)" label="BDP + buffer" />
    </>
  );
  return (
    <Demo
      title="Delivery rate and RTT against the amount in flight"
      controls={<>
        <Param spec={OPP.win} value={win} onChange={(v) => P.set("win", v as number)} />
        <Param spec={OPP.buf} value={buf} onChange={(v) => P.set("buf", v as number)} />
      </>}
    >
      <Plot x={[0, xMax]} y={[0, OP.mbps * 1.15]} height={190} xLabel="packets in flight" yLabel="delivery rate (Mbit/s)">
        {marks}
        <Line points={ideal.map((p) => [p.x, p.mbps] as [number, number])} color="var(--muted)" dash="5 4" width={1.5} />
        <Dots points={pts.map((p) => [p.inflight, p.mbps])} color="var(--c1)" r={3.5} />
        {cur && <Dots points={[[cur.inflight, cur.mbps]]} color="var(--fg)" r={6} />}
      </Plot>
      <Plot x={[0, xMax]} y={[0, yRtt]} height={190} xLabel="packets in flight" yLabel="RTT (ms)">
        {marks}
        <Line points={ideal.map((p) => [p.x, p.rttMs] as [number, number])} color="var(--muted)" dash="5 4" width={1.5} />
        <Dots points={pts.map((p) => [p.inflight, p.rttMs])} color="var(--c2)" r={3.5} />
        {cur && <Dots points={[[cur.inflight, cur.rttMs]]} color="var(--fg)" r={6} />}
      </Plot>
      <Legend items={[
        { label: "packet runs, fixed window", color: "var(--c1)" },
        { label: "ideal: min(inflight/RTprop, BtlBw)", color: "var(--muted)" },
      ]} />
      <RunProgress p={sweep.done / jobs.length}>{`${OP.mbps} Mbit/s, RTprop ${OP.rttMs} ms, BDP ${fixed(bdp, 1)} packets, buffer ${queue} packets`}</RunProgress>
      <Stats items={[
        { label: "delivery rate", value: cur ? `${fixed(cur.mbps, 2)} Mbit/s` : "…" },
        { label: "mean RTT", value: cur ? `${fixed(cur.rttMs, 1)} ms` : "…" },
        { label: "packets sent again", value: cur ? pct(cur.retrans, 1) : "…" },
      ]} />
      <Banner tone={!cur ? "plain" : win <= 1.05 && win >= 0.95 ? "good" : cur.retrans > 0.001 ? "bad" : win > 1 ? "warn" : "info"}>
        {win < 1 ? "Below one BDP the link idles part of each round trip: the rate grows with the window, and the RTT stays at RTprop."
          : win <= 1.05 ? "At one BDP the link is full and the queue is empty. This is the point that BBR aims for (Kleinrock's optimal operating point)."
          : win * bdp <= bdp + queue ? "Above one BDP the rate cannot grow. Every extra packet waits in the queue and adds to the RTT."
          : "The window is larger than the path and its buffer hold. The queue overflows and drops packets. A loss-based sender cuts its window only here."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. BBR's state machine over time

const MODE_COLORS: Record<string, string> = { Startup: "var(--c4)", Drain: "var(--c2)", ProbeBW: "transparent", ProbeRTT: "var(--c5)" };

const TL = {
  ev: seg<BbrEvent>(`At ${BBR_EVENT_AT / 1000} s`, [["none", "nothing"], ["rate-down", "rate to 5 Mbit/s"], ["rate-up", "rate to 20 Mbit/s"], ["rtt-up", "RTT to 120 ms"]], "none"),
};

export function NetCcBbrTimelineDemo() {
  const P = useParams("net-cc-bbr-tl", TL);
  const ev = P.values.ev;
  const { samples, result, progress } = useCcRun(`net-cc-bbr-tl-${ev}`, bbrTimelineScenario(ev), 1000);
  const T = BBR_LINE.durationMs / 1000;
  const spans = spansOf(samples, (s) => s.flows[0]!.state).map((s) => ({ ...s, t0: s.t0 / 1000, t1: s.t1 / 1000 }));
  const f = (g: (x: (typeof samples)[number]["flows"][number]) => number) => samples.map((s) => [s.t / 1000, g(s.flows[0]!)] as [number, number]);
  const rate = smooth(f((x) => x.mbps), 10);
  const maxRate = ev === "rate-up" ? 25 : 13;
  const maxRtt = ev === "rtt-up" ? 260 : 150;
  const bands = <Bands spans={spans} colors={MODE_COLORS} />;
  return (
    <Demo title="One BBR flow: its model and its states" controls={<Param spec={TL.ev} value={ev} onChange={(v) => P.set("ev", v as BbrEvent)} />}>
      <Plot x={[0, T]} y={[0, maxRate]} height={190} xLabel="time (s)" yLabel="Mbit/s">
        {bands}
        <Line points={f((x) => x.pacingMbps ?? 0)} color="color-mix(in srgb, var(--c5) 45%, transparent)" width={0.8} />
        <Line points={rate} color="var(--c1)" width={1.5} />
        <Line points={f((x) => x.btlBwMbps ?? 0)} color="var(--c3)" width={2} />
      </Plot>
      <Legend items={[
        { label: "BtlBw estimate", color: "var(--c3)" },
        { label: "delivery rate (200 ms average)", color: "var(--c1)" },
        { label: "pacing rate", color: "var(--c5)" },
      ]} />
      <Plot x={[0, T]} y={[0, maxRtt]} height={170} xLabel="time (s)" yLabel="ms">
        {bands}
        <Line points={f((x) => x.rtt)} color="var(--c2)" width={1.2} />
        <Line points={f((x) => x.rtPropMs ?? 0)} color="var(--c3)" width={2} />
      </Plot>
      <Legend items={[
        { label: "RTT samples", color: "var(--c2)" },
        { label: "RTprop estimate", color: "var(--c3)" },
        { label: "Startup", color: "var(--c4)" },
        { label: "Drain", color: "var(--c2)" },
        { label: "ProbeRTT", color: "var(--c5)" },
      ]} />
      <Plot x={[0, T]} y={[0, Math.max(10, ...samples.map((s) => s.q)) * 1.1]} height={110} xLabel="time (s)" yLabel="queue (packets)">
        {bands}
        <Area points={samples.map((s) => [s.t / 1000, s.q] as [number, number])} color="var(--c2)" opacity={0.3} />
      </Plot>
      <RunProgress p={progress}>{`${BBR_LINE.mbps} Mbit/s, RTT ${BBR_LINE.rttMs} ms, buffer 2 × BDP (model inputs)`}</RunProgress>
      <Stats items={[
        { label: "link utilisation", value: result ? pct(result.utilisation, 1) : "…" },
        { label: "mean queueing delay", value: result ? `${fixed(result.meanQueueMs, 1)} ms` : "…" },
        { label: "drops", value: result ? sig(result.drops) : "…" },
      ]} />
    </Demo>
  );
}

// ============================================================================ 3. BBR against CUBIC

const VSP = {
  buf: range({ label: "Buffer", min: 0.25, max: 8, default: 1, log: true, format: (v) => `${fixed(v, 2)} × BDP` }),
};

export function NetCcBbrVsCubicDemo() {
  const P = useParams("net-cc-vs", VSP);
  const { buf } = P.values;
  const sc = vsScenario(buf);
  const { samples, result, progress } = useCcRun(`net-cc-vs-${buf}`, sc, 4000);
  const k = Math.round(1000 / VS.sampleMs);
  const series = [0, 1].map((i) => smooth(samples.map((s) => [s.t / 1000, s.flows[i]!.mbps] as [number, number]), k));
  const g = result?.flows;
  return (
    <Demo title="BBR and CUBIC share a bottleneck" controls={<Param spec={VSP.buf} value={buf} onChange={(v) => P.set("buf", v as number)} />}>
      <Plot x={[0, VS.durationMs / 1000]} y={[0, VS.mbps * 1.1]} height={230} xLabel="time (s)" yLabel="throughput (Mbit/s, 1 s average)">
        <RuleY at={VS.mbps / 2} color="var(--faint)" label="fair share" />
        <Line points={series[0]!} color={FLOW_COLORS[0]} />
        <Line points={series[1]!} color={FLOW_COLORS[1]} />
      </Plot>
      <Legend items={[{ label: "BBR", color: FLOW_COLORS[0]! }, { label: "CUBIC", color: FLOW_COLORS[1]! }]} />
      <RunProgress p={progress}>{`${VS.mbps} Mbit/s, both RTTs ${VS.rttMs} ms, buffer ${sc.queue} packets; stats from 10 s on`}</RunProgress>
      <Stats items={[
        { label: "BBR", value: g ? `${fixed(g[0]!.goodputMbps, 2)} Mbit/s` : "…" },
        { label: "CUBIC", value: g ? `${fixed(g[1]!.goodputMbps, 2)} Mbit/s` : "…" },
        { label: "BBR resends", value: g ? pct(g[0]!.retransFrac, 1) : "…" },
        { label: "CUBIC resends", value: g ? pct(g[1]!.retransFrac, 1) : "…" },
        { label: "mean queueing delay", value: result ? `${fixed(result.meanQueueMs, 1)} ms` : "…" },
      ]} />
    </Demo>
  );
}

// ============================================================================ 4. Random loss

const BL = {
  i: range({ label: "Random loss", min: 0, max: BBR_LOSS_RATES.length - 1, step: 1, default: 3, format: (v) => pct(BBR_LOSS_RATES[v]!, 1) }),
};

export function NetCcBbrLossDemo() {
  const P = useParams("net-cc-bbr-loss", BL);
  const p = BBR_LOSS_RATES[P.values.i]!;
  const scs = useMemo(() => (["cubic", "bbr"] as const).flatMap((cc) => BBR_LOSS_RATES.map((x) => bbrLossScenario(cc, x))), []);
  const { results, progress } = useScenarioSweep("net-cc-bbr-loss-sweep", scs, 2000);
  const pts = (k: number) => BBR_LOSS_RATES.flatMap((_, i) => {
    const r = results[k * BBR_LOSS_RATES.length + i];
    return r ? [[i, r.flows[0]!.goodputMbps] as [number, number]] : [];
  });
  const at = (k: number) => results[k * BBR_LOSS_RATES.length + P.values.i]?.flows[0]!.goodputMbps;
  return (
    <Demo title="Random loss: a signal for CUBIC, noise for BBR" controls={<Param spec={BL.i} value={P.values.i} onChange={(v) => P.set("i", v as number)} />}>
      <Plot x={[-0.4, BBR_LOSS_RATES.length - 0.6]} y={[0, BBR_LOSS.mbps * 1.1]} height={230} xLabel="random loss rate" yLabel="throughput (Mbit/s)"
        xTicks={BBR_LOSS_RATES.map((_, i) => i)} xFormat={(v) => pct(BBR_LOSS_RATES[v] ?? 0, BBR_LOSS_RATES[v]! < 0.01 && BBR_LOSS_RATES[v]! > 0 ? 1 : 0)}>
        <RuleX at={P.values.i} color="var(--fg)" />
        <Line points={pts(0)} color={FLOW_COLORS[1]} />
        <Dots points={pts(0)} color={FLOW_COLORS[1]} r={4} />
        <Line points={pts(1)} color={FLOW_COLORS[0]} />
        <Dots points={pts(1)} color={FLOW_COLORS[0]} r={4} />
      </Plot>
      <Legend items={[{ label: "BBR", color: FLOW_COLORS[0]! }, { label: "CUBIC", color: FLOW_COLORS[1]! }]} />
      <RunProgress p={progress}>{`one flow alone, ${BBR_LOSS.mbps} Mbit/s, RTT ${BBR_LOSS.rttMs} ms, buffer 1 × BDP, loss in both directions`}</RunProgress>
      <Stats items={[
        { label: `BBR at ${pct(p, 1)} loss`, value: at(1) !== undefined ? `${fixed(at(1)!, 1)} Mbit/s` : "…" },
        { label: `CUBIC at ${pct(p, 1)} loss`, value: at(0) !== undefined ? `${fixed(at(0)!, 1)} Mbit/s` : "…" },
      ]} />
    </Demo>
  );
}
