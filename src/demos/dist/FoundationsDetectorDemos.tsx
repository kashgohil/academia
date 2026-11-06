/** Demos for "Failure detectors": a fixed-timeout heartbeat detector with its trade-off curve, and phi accrual. */
import { useMemo } from "react";
import { Banner, Demo, rich, Dots, Legend, Line, Param, Plot, RuleX, RuleY, Stats, fixed, pct, range, select, useParams, BAD } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { PHI_DEFAULTS, heartbeatRun, phiOf, phiTrace, timeoutSuspicions, tradeoff, type PhiDist } from "../../sims/dist/foundations/detectors";
import { bisect } from "../../sims/dist/foundations/math";

// ============================================================================ 1. Heartbeats and a fixed timeout

const HB = {
  timeout: range({ label: "Timeout", min: 110, max: 1000, step: 10, default: 250, format: (v) => `${v} ms` }),
  maxLat: range({ label: "Network latency max (min 5 ms)", min: 5, max: 150, step: 5, default: 40, format: (v) => `${v} ms` }),
  pauseP: range({ label: "Chance of a pause before a heartbeat", min: 0, max: 0.2, step: 0.01, default: 0.05, format: (v) => pct(v, 0) }),
};

const VIEW = 2500, CRASH = 1800, LONG = 120_000;
const SWEEP = Array.from({ length: 31 }, (_, i) => 110 + i * 30);

export function HeartbeatDetectorDemo() {
  const P = useParams("dist-fd-hb", HB);
  const { timeout, maxLat, pauseP } = P.values;
  const latency = { min: 5, max: maxLat };
  const view = useMemo(() => heartbeatRun({ latency, pauseP, crashAt: CRASH, horizon: VIEW }), [maxLat, pauseP]); // eslint-disable-line react-hooks/exhaustive-deps
  const long = useMemo(() => heartbeatRun({ latency, pauseP, horizon: LONG }), [maxLat, pauseP]); // eslint-disable-line react-hooks/exhaustive-deps
  const curve = useMemo(() => SWEEP.map((T) => tradeoff(long, T, LONG)), [long]);
  const here = useMemo(() => tradeoff(long, timeout, LONG), [long, timeout]);
  const sus = timeoutSuspicions(view.arrivals, timeout, VIEW);
  const msgs: StMessage[] = view.net.messages.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt }));
  const marks: StMark[] = [
    { node: 1, t: CRASH, shape: "cross", label: "crash" },
    ...view.pauses.filter(([a]) => a < CRASH).map(([a, b]) => ({ node: 1, t: a, until: Math.min(b, CRASH), shape: "bar" as const, label: "pause", color: "var(--c2)" })),
    ...sus.map((s) => ({ node: 0, t: s.from, until: s.to ?? VIEW, shape: "bar" as const, label: s.from < CRASH ? "false suspicion" : "suspect", color: s.from < CRASH ? "var(--c4)" : "var(--c1)" })),
  ];
  const falseHere = sus.filter((s) => s.from < CRASH).length;
  const detect = sus.find((s) => s.to === undefined);
  const xMax = Math.max(...curve.map((c) => c.detectMean)) * 1.05;
  const FLOOR = 0.1;
  const yv = (v: number) => Math.max(FLOOR, v);
  const yMax = Math.max(10, ...curve.map((c) => c.falsePerMin)) * 1.5;
  return (
    <Demo
      title="A heartbeat detector with a fixed timeout"
      controls={<>
        <Param spec={HB.timeout} value={timeout} onChange={(v) => P.set("timeout", v as number)} />
        <Param spec={HB.maxLat} value={maxLat} onChange={(v) => P.set("maxLat", v as number)} />
        <Param spec={HB.pauseP} value={pauseP} onChange={(v) => P.set("pauseP", v as number)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>The node sends a heartbeat every 100 ms. Pauses have a mean of 150 ms (model input). It crashes at {CRASH} ms.</div>
      <SpaceTime nodes={["monitor", "node"]} tEnd={VIEW} messages={msgs} marks={marks} rowHeight={54} />
      <div style={{ marginTop: 8 }}>
        <Plot x={[0, xMax]} y={[FLOOR, yMax]} logY height={200} xLabel="mean time to detect a crash (ms)" yLabel="false suspicions per minute (log; 0 drawn at 0.1)" yTicks={[0.1, 1, 10, 100, 1000].filter((v) => v <= yMax)} yFormat={(v) => String(v)}>
          <Line points={curve.map((c) => [c.detectMean, yv(c.falsePerMin)] as [number, number])} color="var(--c1)" />
          <Dots points={curve.map((c) => [c.detectMean, yv(c.falsePerMin)] as [number, number])} color="var(--c1)" r={2} />
          <Dots points={[[here.detectMean, yv(here.falsePerMin)]]} color="var(--c4)" r={5} />
        </Plot>
        <Legend items={[{ label: "one dot per timeout, 110 to 1000 ms (2 simulated minutes each)", color: "var(--c1)" }, { label: "your timeout", color: "var(--c4)" }]} />
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "false suspicions per minute", value: fixed(here.falsePerMin, 1) },
          { label: "mean detection time", value: `${fixed(here.detectMean, 0)} ms` },
          { label: "worst detection time", value: `${fixed(here.detectMax, 0)} ms` },
          { label: "in the diagram: false suspicions, detection", value: `${falseHere}, ${detect ? `${fixed(detect.from - CRASH, 0)} ms` : "none yet"}` },
        ]} />
      </div>
      <Banner tone={here.falsePerMin > 1 ? "bad" : here.detectMean > 500 ? "warn" : "good"}>
        {here.falsePerMin > 1
          ? `The timeout is shorter than the gaps that pauses and slow messages make. The detector accuses a live node ${fixed(here.falsePerMin, 1)} times a minute.`
          : here.detectMean > 500
            ? `No false suspicions, but a crash goes unseen for ${fixed(here.detectMean, 0)} ms on average. Every request to the dead node waits that long.`
            : `A fair compromise for this network. Change the latency or the pauses, and the best timeout moves.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Phi accrual

const PH = {
  threshold: range({ label: "Threshold φ", min: 1, max: 16, step: 0.5, default: 8 }),
  maxLat: range({ label: "Network latency max (min 5 ms)", min: 5, max: 150, step: 5, default: 40, format: (v) => `${v} ms` }),
  pauseP: range({ label: "Chance of a pause before a heartbeat", min: 0, max: 0.2, step: 0.01, default: 0.05, format: (v) => pct(v, 0) }),
  dist: select({ label: "Model of the inter-arrival times", options: [{ value: "normal", label: "normal (paper, Akka)" }, { value: "exponential", label: "exponential (Cassandra)" }], default: "normal" as PhiDist, segmented: true }),
};

const PH_END = 4000, PH_CRASH = 3000, PHI_MAX = 16;

export function PhiAccrualDemo() {
  const P = useParams("dist-fd-phi", PH);
  const { threshold, maxLat, pauseP, dist } = P.values;
  const cfg = { ...PHI_DEFAULTS, dist };
  const run = useMemo(() => heartbeatRun({ seed: 5, latency: { min: 5, max: maxLat }, pauseP, crashAt: PH_CRASH, horizon: PH_END }), [maxLat, pauseP]);
  const tr = useMemo(() => phiTrace(run.arrivals, PH_END, threshold, cfg), [run, threshold, dist]); // eslint-disable-line react-hooks/exhaustive-deps
  const w = tr.detector.window;
  const m = w.reduce((a, b) => a + b, 0) / Math.max(1, w.length);
  const atThreshold = bisect((e) => phiOf(e, w, cfg), threshold, 0, 1e5);
  const falseS = tr.crossings.filter((c) => c.from < PH_CRASH);
  const det = tr.crossings.find((c) => c.from >= PH_CRASH);
  const ticks = run.arrivals.map((a) => [a.at, 0.25] as [number, number]);
  return (
    <Demo
      title="Phi accrual: suspicion as a number"
      controls={<>
        <Param spec={PH.threshold} value={threshold} onChange={(v) => P.set("threshold", v as number)} />
        <Param spec={PH.maxLat} value={maxLat} onChange={(v) => P.set("maxLat", v as number)} />
        <Param spec={PH.pauseP} value={pauseP} onChange={(v) => P.set("pauseP", v as number)} />
        <Param spec={PH.dist} value={dist} onChange={(v) => P.set("dist", v as PhiDist)} />
      </>}
    >
      <Plot x={[0, PH_END]} y={[0, PHI_MAX]} height={240} xLabel="time (ms)" yLabel="φ at the monitor (clipped at 16)">
        <Line points={tr.pts.map(([t, p]) => [t, Math.min(PHI_MAX, p)] as [number, number])} color="var(--c1)" width={1.6} />
        <Dots points={ticks} color="var(--muted)" r={1.8} />
        <RuleY at={threshold} color="var(--c4)" label={`threshold ${threshold}`} />
        <RuleX at={PH_CRASH} color="var(--fg)" />
        {tr.crossings.map((c, i) => <RuleX key={i} at={c.from} color={c.from < PH_CRASH ? BAD : "var(--c3)"} dash="2 2" />)}
      </Plot>
      <Legend items={[{ label: "φ", color: "var(--c1)" }, { label: "heartbeat arrivals", color: "var(--muted)" }, { label: `crash at ${PH_CRASH} ms`, color: "var(--fg)" }, { label: "false suspicion", color: BAD }, { label: "detection", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "mean, std of the intervals", value: `${fixed(m, 0)} ms, ${fixed(Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, w.length)), 0)} ms` },
          { label: "φ reaches the threshold after a silence of", value: `${fixed(atThreshold, 0)} ms` },
          { label: "false suspicions before the crash", value: falseS.length },
          { label: "detection time after the crash", value: det ? `${fixed(det.from - PH_CRASH, 0)} ms` : "not yet" },
        ]} />
      </div>
      <Banner tone={falseS.length ? "bad" : det ? "good" : "warn"}>
        {rich(`$\\varphi = ${threshold}$ means: if the node were alive, a silence this long would happen with probability $10^{-${threshold}}$. `)}
        {falseS.length ? `It still crossed ${falseS.length} time${falseS.length > 1 ? "s" : ""} before the crash: the model of the intervals is too optimistic for these pauses.` : det ? `It detected the crash ${fixed(det.from - PH_CRASH, 0)} ms after it happened.` : "The crash is not detected within the run."}
      </Banner>
    </Demo>
  );
}
