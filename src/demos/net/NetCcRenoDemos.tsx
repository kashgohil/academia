/** Demos for "Congestion control: Reno and CUBIC". Every run is a PacketNet run of src/sims/net/cc. */
import { useMemo } from "react";
import {
  Area, Banner, Demo, Dots, Label, Legend, Line, Param, Plot, RuleX, RuleY, Stats, fixed, pct, range, seg, sig, useChunked, useParams,
} from "../../kit";
import {
  BUF, BUF_FLOWS, COLLAPSE, COLLAPSE_SENDERS, CUBIC_ALPHA, CUBIC_BETA, CUBIC_C, FAIR, LOSS_RATES, SAW, appenzellerBuffer, bdpPackets,
  bufferScenario, collapseRun, cubicK, cubicW, fairScenario, lossScenario, mathisMbps, renoFluidUtilisation, sawScenario, type CollapseMode,
  type CollapsePoint,
} from "../../sims/net/cc";
import { FLOW_COLORS, RunProgress, smooth, useCcRun, useScenarioSweep, useSweep } from "./NetCcUi";

const secs = (t: number) => `${fixed(t / 1000, 0)}`;

// ============================================================================ 1. Congestion collapse

const CO = {
  n: range({ label: "Senders", min: 1, max: 32, step: 1, default: 12 }),
  mode: seg<CollapseMode>("The senders are", [["1986", "1986: fixed window, fixed timer"], ["1988", "1988: slow start, AIMD, RTO"]], "1986"),
};

export function NetCcCollapseDemo() {
  const P = useParams("net-cc-collapse", CO);
  const { n, mode } = P.values;
  const jobs = useMemo(() => (["1986", "1988"] as const).flatMap((m) => COLLAPSE_SENDERS.map((k) => () => collapseRun(k, m))), []);
  const sweep = useSweep("net-cc-collapse-sweep", jobs);
  const cur = useChunked(`net-cc-collapse-${n}-${mode}`, [() => collapseRun(n, mode)], { keep: true })[0];
  const line = (m: CollapseMode, f: (p: CollapsePoint) => number) =>
    sweep.res.filter((p): p is CollapsePoint => !!p && p.mode === m).map((p) => [p.n, f(p)] as [number, number]);
  const bad = cur && cur.mode === "1986" && cur.goodput < 0.5;
  return (
    <Demo
      title="Senders that only add load: congestion collapse"
      controls={<>
        <Param spec={CO.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={CO.mode} value={mode} onChange={(v) => P.set("mode", v as CollapseMode)} />
      </>}
    >
      <Plot x={[0, 33]} y={[0, 1.05]} height={230} xLabel="senders" yLabel="fraction of the link" yFormat={(v) => pct(v, 0)}>
        <Line points={line("1986", (p) => p.busy)} color="var(--muted)" width={1.5} dash="5 4" />
        <Line points={line("1986", (p) => p.goodput)} color="var(--c4)" />
        <Line points={line("1988", (p) => p.goodput)} color="var(--c3)" />
        <RuleX at={n} color="var(--fg)" />
        {cur && <Dots points={[[cur.n, cur.goodput]]} color={cur.mode === "1986" ? "var(--c4)" : "var(--c3)"} r={5} />}
      </Plot>
      <Legend items={[
        { label: "goodput, 1986 senders", color: "var(--c4)" },
        { label: "goodput, 1988 senders", color: "var(--c3)" },
        { label: "link busy, 1986 senders", color: "var(--muted)" },
      ]} />
      <RunProgress p={sweep.done / jobs.length}>{`${COLLAPSE.mbps} Mbit/s link, base RTT ${COLLAPSE.rttMs} ms, queue of ${COLLAPSE.queue} packets, window ${COLLAPSE.window}, timer ${COLLAPSE.timerMs} ms (model inputs)`}</RunProgress>
      <Stats items={[
        { label: "link busy", value: cur ? pct(cur.busy, 0) : "…" },
        { label: "goodput (new data)", value: cur ? pct(cur.goodput, 0) : "…" },
        { label: "packets sent per new packet", value: cur ? fixed(cur.copies, 1) : "…" },
        { label: "mean queueing delay", value: cur ? `${sig(cur.meanQueueMs)} ms` : "…" },
        { label: "timeouts", value: cur ? sig(cur.timeouts) : "…" },
      ]} />
      <Banner tone={bad ? "bad" : cur && cur.goodput > 0.9 ? "good" : "plain"}>
        {!cur ? "Simulating…" : bad
          ? `The link is busy ${pct(cur.busy, 0)} of the time, but only ${pct(cur.goodput, 0)} of it carries new data. The queue delay (${sig(cur.meanQueueMs)} ms) is longer than the fixed timer, so every sender resends packets that are only late.`
          : cur.mode === "1986"
            ? "The senders together keep fewer packets in flight than the link and its queue hold. Nothing times out yet."
            : `Each sender backs off when it loses a packet, and its timer follows the RTT. Goodput stays at ${pct(cur.goodput, 0)} of the link.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. The sawtooth

const SW = {
  buf: range({ label: "Buffer at the bottleneck", min: 0.1, max: 4, default: 1, log: true, format: (v) => `${fixed(v, 2)} × BDP` }),
  cc: seg<"reno" | "cubic">("Algorithm", [["reno", "Reno"], ["cubic", "CUBIC"]], "reno"),
};

export function NetCcSawtoothDemo() {
  const P = useParams("net-cc-saw", SW);
  const { buf, cc } = P.values;
  const bdp = bdpPackets(SAW.mbps, SAW.rttMs);
  const sc = sawScenario(cc, buf);
  const { samples, result, progress } = useCcRun(`net-cc-saw-${cc}-${buf}`, sc, 2000);
  const cw = samples.map((s) => [s.t / 1000, s.flows[0]!.cwnd] as [number, number]);
  const q = samples.map((s) => [s.t / 1000, s.q] as [number, number]);
  const top = Math.max(bdp + sc.queue, ...cw.map((p) => p[1])) * 1.12;
  const fluid = renoFluidUtilisation(bdp, sc.queue);
  const T = SAW.durationMs / 1000;
  return (
    <Demo
      title="One flow, one bottleneck: the window sawtooth"
      controls={<>
        <Param spec={SW.buf} value={buf} onChange={(v) => P.set("buf", v as number)} />
        <Param spec={SW.cc} value={cc} onChange={(v) => P.set("cc", v as "reno" | "cubic")} />
      </>}
    >
      <Plot x={[0, T]} y={[0, top]} height={210} xLabel="time (s)" yLabel="congestion window (packets)">
        <RuleY at={bdp} color="var(--c3)" label="BDP" />
        <RuleY at={bdp + sc.queue} color="var(--c4)" label="BDP + buffer" />
        <Line points={cw} color="var(--c1)" width={1.5} />
      </Plot>
      <Plot x={[0, T]} y={[0, Math.max(4, sc.queue) * 1.1]} height={130} xLabel="time (s)" yLabel="queue (packets)">
        <Area points={q} color="var(--c2)" opacity={0.3} />
        <Line points={q} color="var(--c2)" width={1} />
      </Plot>
      <RunProgress p={progress}>{`${SAW.mbps} Mbit/s, RTT ${SAW.rttMs} ms, BDP ${fixed(bdp, 1)} packets of 1500 bytes, buffer ${sc.queue} packets`}</RunProgress>
      <Stats items={[
        { label: "link utilisation (after 5 s)", value: result ? pct(result.utilisation, 1) : "…" },
        { label: "mean queueing delay", value: result ? `${fixed(result.meanQueueMs, 1)} ms` : "…" },
        { label: "congestion events", value: result ? result.flows[0]!.congestionEvents : "…" },
        ...(cc === "reno" ? [{ label: "fluid model of Reno", value: pct(fluid, 1) }] : []),
      ]} />
    </Demo>
  );
}

// ============================================================================ 3. CUBIC's curve

const CU = {
  wmax: range({ label: "Window at the last loss, $W_{\\max}$", min: 20, max: 2000, default: 100, log: true, format: (v) => `${sig(v)} packets` }),
  rtt: range({ label: "RTT", min: 10, max: 300, step: 5, default: 50, format: (v) => `${v} ms` }),
};

export function NetCcCubicCurveDemo() {
  const P = useParams("net-cc-cubic", CU);
  const { wmax, rtt } = P.values;
  const w0 = CUBIC_BETA * wmax;
  const K = cubicK(wmax, w0);
  const renoT = (wmax / 2) * (rtt / 1000);
  const tEnd = Math.max(2 * K, renoT) * 1.15;
  const N = 200;
  const ts = Array.from({ length: N + 1 }, (_, i) => (i / N) * tEnd);
  const cub = ts.map((t) => [t, cubicW(t, wmax, K)] as [number, number]);
  const reno = ts.map((t) => [t, wmax / 2 + t / (rtt / 1000)] as [number, number]);
  const est = ts.map((t) => [t, w0 + (CUBIC_ALPHA * t) / (rtt / 1000)] as [number, number]);
  const yTop = wmax * 1.6;
  return (
    <Demo
      title="After a loss: CUBIC's curve and Reno's line"
      controls={<>
        <Param spec={CU.wmax} value={wmax} onChange={(v) => P.set("wmax", v as number)} />
        <Param spec={CU.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
      </>}
    >
      <Plot x={[0, tEnd]} y={[0, yTop]} height={260} xLabel="seconds after the loss" yLabel="window (packets)">
        <RuleY at={wmax} color="var(--muted)" label="W max" />
        <RuleX at={K} color="var(--c1)" label="K" />
        <Line points={est} color="var(--c5)" width={1.5} dash="5 4" />
        <Line points={reno} color="var(--c2)" />
        <Line points={cub} color="var(--c1)" width={2.5} />
        <Label at={[K * 0.5, wmax * 1.1]} color="var(--c1)" anchor="middle">concave</Label>
        {K * 1.6 < tEnd && <Label at={[K * 1.5, wmax * 0.82]} color="var(--c1)" anchor="middle">convex</Label>}
      </Plot>
      <Legend items={[
        { label: "CUBIC: C(t − K)³ + W max", color: "var(--c1)" },
        { label: "Reno: halve, then +1 per RTT", color: "var(--c2)" },
        { label: "CUBIC's Reno-friendly estimate", color: "var(--c5)" },
      ]} />
      <Stats items={[
        { label: "$K$: CUBIC back at $W_{\\max}$", value: `${fixed(K, 2)} s` },
        { label: "Reno back at $W_{\\max}$", value: `${fixed(renoT, 2)} s` },
        { label: "CUBIC's $K$ in RTTs", value: sig(K / (rtt / 1000)) },
        { label: "cut on loss", value: `CUBIC to ${pct(CUBIC_BETA, 0)}, Reno to 50%` },
      ]} />
      <Banner>
        {`C = ${CUBIC_C} and β = ${CUBIC_BETA} (RFC 9438). K depends only on W max: change the RTT and the CUBIC curve does not move, while Reno's line gets steeper or flatter.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 4. Buffer sizing with many flows

const BS = {
  buf: range({ label: "Buffer", min: 0.05, max: 1, default: 0.25, log: true, format: (v) => `${fixed(v, 2)} × BDP` }),
  n: seg<"1" | "4" | "32">("Reno flows", BUF_FLOWS.map((k) => [String(k) as "1" | "4" | "32", String(k)]), "1"),
};

export function NetCcBufferDemo() {
  const P = useParams("net-cc-buf", BS);
  const { buf } = P.values;
  const n = Number(P.values.n);
  const bdp = bdpPackets(BUF.mbps, BUF.rttMean);
  const sc = bufferScenario(n, buf);
  const { samples, result, progress } = useCcRun(`net-cc-buf-${n}-${buf}`, sc, 1000);
  const total = samples.map((s) => [s.t / 1000, s.flows.reduce((a, f) => a + f.cwnd, 0)] as [number, number]);
  const T = BUF.durationMs / 1000;
  const top = Math.max(bdp + sc.queue, ...total.map((p) => p[1])) * 1.1;
  const app = appenzellerBuffer(bdp, n);
  return (
    <Demo
      title="How much buffer does a link need?"
      controls={<>
        <Param spec={BS.buf} value={buf} onChange={(v) => P.set("buf", v as number)} />
        <Param spec={BS.n} value={P.values.n} onChange={(v) => P.set("n", v as "1" | "4" | "32")} />
      </>}
    >
      <Plot x={[0, T]} y={[0, top]} height={220} xLabel="time (s)" yLabel="sum of the windows (packets)">
        <RuleY at={bdp} color="var(--c3)" label="BDP" />
        <RuleY at={bdp + sc.queue} color="var(--c4)" label="BDP + buffer" />
        <Line points={total} color="var(--c1)" width={1.5} />
      </Plot>
      <RunProgress p={progress}>{`${BUF.mbps} Mbit/s; RTTs from ${BUF.rttLo} to ${BUF.rttHi} ms (one flow: ${BUF.rttMean} ms); BDP at ${BUF.rttMean} ms is ${sig(bdp)} packets`}</RunProgress>
      <Stats items={[
        { label: "buffer", value: `${sc.queue} packets` },
        { label: "Appenzeller: $\\mathrm{BDP}/\\sqrt{n}$", value: `${sig(app)} packets` },
        { label: "link utilisation (after 5 s)", value: result ? pct(result.utilisation, 1) : "…" },
        { label: "mean queueing delay", value: result ? `${fixed(result.meanQueueMs, 1)} ms` : "…" },
      ]} />
      <Banner tone={result ? (result.utilisation > 0.97 ? "good" : result.utilisation < 0.9 ? "bad" : "warn") : "plain"}>
        {n === 1
          ? "One flow halves its window at each loss. The sum dips below the BDP, and the link idles, unless the buffer holds a full BDP."
          : `${n} flows lose packets at different times. When one halves, the others hold the sum near the top, so a smaller buffer is enough.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 5. RTT fairness

const FA = {
  ratio: range({ label: "RTT of flow 2", min: 1, max: 8, step: 1, default: 4, format: (v) => `${v} × ${FAIR.rttMs} ms` }),
  cc: seg<"reno" | "cubic">("Both flows use", [["reno", "Reno"], ["cubic", "CUBIC"]], "reno"),
};

export function NetCcFairnessDemo() {
  const P = useParams("net-cc-fair", FA);
  const { ratio, cc } = P.values;
  const { samples, result, progress } = useCcRun(`net-cc-fair-${cc}-${ratio}`, fairScenario(cc, ratio), 4000);
  const k = Math.round(1000 / FAIR.sampleMs);
  const series = [0, 1].map((i) => smooth(samples.map((s) => [s.t / 1000, s.flows[i]!.mbps] as [number, number]), k));
  const T = FAIR.durationMs / 1000;
  const g = result?.flows.map((f) => f.goodputMbps);
  return (
    <Demo
      title="Two flows, one link, different RTTs"
      controls={<>
        <Param spec={FA.ratio} value={ratio} onChange={(v) => P.set("ratio", v as number)} />
        <Param spec={FA.cc} value={cc} onChange={(v) => P.set("cc", v as "reno" | "cubic")} />
      </>}
    >
      <Plot x={[0, T]} y={[0, FAIR.mbps * 1.1]} height={230} xLabel="time (s)" yLabel="throughput (Mbit/s, 1 s average)">
        <RuleY at={FAIR.mbps / 2} color="var(--faint)" label="fair share" />
        <RuleX at={FAIR.warmupMs / 1000} color="var(--faint)" />
        <Line points={series[0]!} color={FLOW_COLORS[0]} />
        <Line points={series[1]!} color={FLOW_COLORS[1]} />
      </Plot>
      <Legend items={[
        { label: `flow 1, RTT ${FAIR.rttMs} ms`, color: FLOW_COLORS[0]! },
        { label: `flow 2, RTT ${FAIR.rttMs * ratio} ms`, color: FLOW_COLORS[1]! },
      ]} />
      <RunProgress p={progress}>{`${FAIR.mbps} Mbit/s; buffer = one BDP of flow 1; stats from ${secs(FAIR.warmupMs)} s on`}</RunProgress>
      <Stats items={[
        { label: "flow 1", value: g ? `${fixed(g[0]!, 2)} Mbit/s` : "…" },
        { label: "flow 2", value: g ? `${fixed(g[1]!, 2)} Mbit/s` : "…" },
        { label: "ratio", value: g ? `${fixed(g[0]! / g[1]!, 2)} : 1` : "…" },
        { label: "Jain's index", value: result ? fixed(result.jain, 3) : "…" },
      ]} />
    </Demo>
  );
}

// ============================================================================ 6. Throughput and random loss

const LR = {
  rtt: seg<"25" | "50" | "100">("RTT", [["25", "25 ms"], ["50", "50 ms"], ["100", "100 ms"]], "100"),
};

export function NetCcLossDemo() {
  const P = useParams("net-cc-loss", LR);
  const rtt = Number(P.values.rtt);
  const scs = useMemo(() => (["reno", "cubic"] as const).flatMap((cc) => LOSS_RATES.map((p) => lossScenario(cc, p, rtt))), [rtt]);
  const { results, progress } = useScenarioSweep(`net-cc-loss-${rtt}`, scs, 1000);
  const pts = (cc: number) => LOSS_RATES.flatMap((p, i) => {
    const r = results[cc * LOSS_RATES.length + i];
    return r ? [[p, Math.max(0.1, r.flows[0]!.goodputMbps)] as [number, number]] : [];
  });
  const formula = Array.from({ length: 41 }, (_, i) => {
    const p = 1e-4 * 10 ** ((i / 40) * Math.log10(3e-2 / 1e-4));
    return [p, Math.min(400, mathisMbps(p, rtt))] as [number, number];
  });
  const rows = LOSS_RATES.map((p, i) => ({ p, reno: results[i]?.flows[0]!.goodputMbps, cubic: results[LOSS_RATES.length + i]?.flows[0]!.goodputMbps }));
  return (
    <Demo title="Throughput against random loss" controls={<Param spec={LR.rtt} value={P.values.rtt} onChange={(v) => P.set("rtt", v as "25" | "50" | "100")} />}>
      <Plot x={[8e-5, 4e-2]} y={[0.1, 200]} logX logY height={260} xLabel="loss rate p" yLabel="throughput (Mbit/s)"
        xTicks={[1e-4, 1e-3, 1e-2]} xFormat={(v) => (v >= 1e-2 ? "1%" : v >= 1e-3 ? "0.1%" : "0.01%")} yTicks={[0.1, 1, 10, 100]} yFormat={(v) => String(v)}>
        <RuleY at={100} color="var(--faint)" label="link 100 Mbit/s" />
        <Line points={formula} color="var(--muted)" dash="5 4" width={1.5} />
        <Dots points={pts(0)} color={FLOW_COLORS[0]} r={4.5} />
        <Dots points={pts(1)} color={FLOW_COLORS[1]} r={4.5} />
      </Plot>
      <Legend items={[
        { label: "Reno (packet runs)", color: FLOW_COLORS[0]! },
        { label: "CUBIC (packet runs)", color: FLOW_COLORS[1]! },
        { label: "Mathis: (MSS/RTT) · 1.22/√p", color: "var(--muted)" },
      ]} />
      <RunProgress p={progress}>{`one flow, 1500-byte packets, ${LOSS_RATES.length * 2} runs of 30 s each`}</RunProgress>
      <Stats items={rows.filter((r) => r.p === 1e-4 || r.p === 1e-2).flatMap((r) => [
        { label: `Reno at p = ${pct(r.p, 2)}`, value: r.reno !== undefined ? `${fixed(r.reno, 1)} Mbit/s` : "…" },
        { label: `CUBIC at p = ${pct(r.p, 2)}`, value: r.cubic !== undefined ? `${fixed(r.cubic, 1)} Mbit/s` : "…" },
        { label: `Mathis at p = ${pct(r.p, 2)}`, value: `${fixed(mathisMbps(r.p, rtt), 1)} Mbit/s` },
      ])} />
    </Demo>
  );
}

