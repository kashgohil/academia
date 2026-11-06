/** Demos for the physical clock and NTP lessons: drift, wall versus monotonic time, last-write-wins, the NTP exchange, the error wedge and the saw-tooth. */
import { useMemo } from "react";
import { Area, Banner, Demo, Dots, Legend, Line, Param, Plot, RuleY, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, fixed, mono, range, seg, toggle, useParams, useStepper } from "../../kit";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";
import { driftPerDay, driftSeries, lwwRun, measureDuration } from "../../sims/dist/time/clocks";
import { clockFilter, ntpExchange, syncRun, wedgeSamples } from "../../sims/dist/time/ntp";

const NODE_COLOR = ["var(--c1)", "var(--c2)", "var(--c5)"];
const sgn = (v: number, d = 1) => `${v >= 0 ? "+" : "−"}${fixed(Math.abs(v), d)}`;

// ============================================================================ 1. Drifting clocks

const DRIFT = {
  node: seg("Node", [["0", "N1"], ["1", "N2"], ["2", "N3"]], "0"),
  d0: range({ label: "Drift of N1 (model input)", min: -100, max: 100, step: 1, default: 20, format: (v) => `${sgn(v, 0)} ppm` }),
  d1: range({ label: "Drift of N2 (model input)", min: -100, max: 100, step: 1, default: -35, format: (v) => `${sgn(v, 0)} ppm` }),
  d2: range({ label: "Drift of N3 (model input)", min: -100, max: 100, step: 1, default: 5, format: (v) => `${sgn(v, 0)} ppm` }),
  o0: range({ label: "Offset of N1 at the start", min: -500, max: 500, step: 5, default: 0, format: (v) => `${sgn(v, 0)} ms` }),
  o1: range({ label: "Offset of N2 at the start", min: -500, max: 500, step: 5, default: 0, format: (v) => `${sgn(v, 0)} ms` }),
  o2: range({ label: "Offset of N3 at the start", min: -500, max: 500, step: 5, default: 0, format: (v) => `${sgn(v, 0)} ms` }),
  hours: range({ label: "Simulated time", min: 1, max: 72, step: 1, default: 24, format: (v) => `${v} h` }),
};

export function TimeDriftDemo() {
  const P = useParams("dist-time-drift", DRIFT);
  const v = P.values;
  const k = Number(v.node) as 0 | 1 | 2;
  const ppm = [v.d0, v.d1, v.d2], off = [v.o0, v.o1, v.o2];
  const s = useMemo(() => driftSeries({ ppm, offset: off, hours: v.hours, samples: 120 }), [v.d0, v.d1, v.d2, v.o0, v.o1, v.o2, v.hours]); // eslint-disable-line react-hooks/exhaustive-deps
  const toS = (pts: [number, number][]) => pts.map(([h, e]) => [h, e / 1000] as [number, number]);
  const all = s.error.flat().map((p) => Math.abs(p[1]) / 1000);
  const ymax = Math.max(0.2, ...all) * 1.1;
  const over = s.spread.find((p) => p[1] > 100);
  const dKey = (["d0", "d1", "d2"] as const)[k], oKey = (["o0", "o1", "o2"] as const)[k];
  return (
    <Demo
      title="Three quartz clocks, no synchronization"
      controls={<>
        <Param spec={DRIFT.node} value={v.node} onChange={(x) => P.set("node", x as "0")} />
        <Param spec={DRIFT[dKey]} value={v[dKey]} onChange={(x) => P.set(dKey, x as number)} />
        <Param spec={DRIFT[oKey]} value={v[oKey]} onChange={(x) => P.set(oKey, x as number)} />
        <Param spec={DRIFT.hours} value={v.hours} onChange={(x) => P.set("hours", x as number)} />
      </>}
    >
      <Plot x={[0, v.hours]} y={[-ymax, ymax]} height={230} xLabel="true time (hours)" yLabel="clock − true time (s)">
        <RuleY at={0} />
        {s.error.map((pts, i) => <Line key={i} points={toS(pts)} color={NODE_COLOR[i]} width={i === k ? 2.6 : 1.6} />)}
      </Plot>
      <Legend items={[0, 1, 2].map((i) => ({ label: `N${i + 1}: ${sgn(ppm[i]!, 0)} ppm`, color: NODE_COLOR[i]! }))} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: `largest gap between two nodes after ${v.hours} h`, value: `${fixed(s.finalSpread / 1000, 2)} s` },
          { label: "gap passes 100 ms after", value: over ? `${fixed(over[0], 1)} h` : "never here" },
          { label: `drift of the selected node per day`, value: `${fixed(driftPerDay(Math.abs(ppm[k]!)) / 1000, 2)} s` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Wall clock versus monotonic clock

const MONOTONIC = {
  step: range({ label: "Clock step", min: -2000, max: 2000, step: 50, default: -1000, format: (v) => `${sgn(v, 0)} ms` }),
  at: range({ label: "Step happens at", min: -50, max: 350, step: 10, default: 120, format: (v) => (v < 0 ? "before the start" : v > 300 ? "after the end" : `${v} ms`) }),
};

export function TimeMonotonicDemo() {
  const P = useParams("dist-time-mono", MONOTONIC);
  const work = 300;
  const r = measureDuration({ work, stepAt: P.values.at, step: P.values.step });
  const max = Math.max(work + 2000, 2300);
  const bar = (label: string, val: number, color: string) => (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 8px", alignItems: "center", fontSize: 12.5 }}>
      <span style={{ ...mono, fontSize: 12 }}>{label}</span>
      <b style={{ ...mono, textAlign: "right", color: val < 0 ? "var(--c4)" : "var(--fg)" }}>{val < 0 ? "−" : ""}{Math.abs(val)} ms</b>
      <div style={{ gridColumn: "1 / -1", position: "relative", height: 14, background: "var(--subtle)", borderRadius: 3, border: "1px solid var(--border)" }}>
        <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 1, background: "var(--muted)" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: val >= 0 ? "50%" : `${50 + (50 * val) / max}%`, width: `${(50 * Math.abs(val)) / max}%`, background: color, transition: "all 0.25s" }} />
      </div>
    </div>
  );
  const bad = r.wall !== r.monotonic;
  return (
    <Demo title="Time 300 ms of work across a clock step" controls={<><Param spec={MONOTONIC.step} value={P.values.step} onChange={(x) => P.set("step", x as number)} /><Param spec={MONOTONIC.at} value={P.values.at} onChange={(x) => P.set("at", x as number)} /></>}>
      <div style={{ display: "grid", gap: 8 }}>
        {bar("CLOCK_REALTIME", r.wall, "var(--c4)")}
        {bar("CLOCK_MONOTONIC", r.monotonic, "var(--c3)")}
      </div>
      <Banner ok={!bad}>
        {!bad
          ? "The step falls outside the timed work, so both clocks measure 300 ms."
          : r.wall < 0
            ? `The time-of-day clock says the work took −${Math.abs(r.wall)} ms: a negative duration. A timeout or a rate computed from it is now wrong. The monotonic clock still says 300 ms.`
            : `The time-of-day clock says ${r.wall} ms. The step went into the measurement. The monotonic clock is never stepped, so it says 300 ms.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. Last write wins with skewed clocks

const LWW = {
  skew: range({ label: "B's clock is behind A's by", min: 0, max: 100, step: 1, default: 40, format: (v) => `${v} ms` }),
  gap: range({ label: "B writes later by", min: 0, max: 100, step: 1, default: 25, format: (v) => `${v} ms` }),
};

export function TimeLwwDemo() {
  const P = useParams("dist-time-lww", LWW);
  const r = useMemo(() => lwwRun({ skew: P.values.skew, gap: P.values.gap }), [P.values.skew, P.values.gap]);
  const st = fromTrace(r.net, (m) => (m.payload.k === "put" ? `x=${m.payload.v} @${fixed(m.payload.ts, 0)}` : undefined));
  const messages = st.messages.map((m, i) => ({ ...m, color: r.net.messages[i]!.payload.k === "ack" ? "var(--faint)" : m.from === 0 ? "var(--c1)" : "var(--c2)" }));
  const marks: StMark[] = r.writes.map((w) => ({ node: w.node, t: w.at, color: w.node === 0 ? "var(--c1)" : "var(--c2)", }));
  const tEnd = Math.max(80, r.net.now + 5);
  return (
    <Demo title="Last write wins, with skew" controls={<><Param spec={LWW.skew} value={P.values.skew} onChange={(x) => P.set("skew", x as number)} /><Param spec={LWW.gap} value={P.values.gap} onChange={(x) => P.set("gap", x as number)} /></>}>
      <SpaceTime nodes={["A", "B", "store"]} tEnd={tEnd} messages={messages} marks={marks} timeLabel="true time (ms)" />
      <Banner ok={!r.lost}>
        {r.lost
          ? `The store keeps x = ${r.final}. B wrote ${P.values.gap} ms later, but B's clock is ${P.values.skew} ms behind, so its timestamp is smaller. B's write is silently lost.`
          : `The store keeps x = B, the later write. Skew (${P.values.skew} ms) is not larger than the gap (${P.values.gap} ms), so the timestamps are in real-time order.`}
      </Banner>
      <SectionLabel>Where the later write is lost</SectionLabel>
      <Plot x={[0, 100]} y={[0, 100]} height={170} xLabel="gap between the writes (ms)" yLabel="skew (ms)">
        <Area points={[[0, 0], [100, 100]]} base={100} color="var(--c4)" opacity={0.18} />
        <Line points={[[0, 0], [100, 100]]} color="var(--c4)" width={1.5} dash="4 3" />
        <Dots points={[[P.values.gap, P.values.skew]]} color={r.lost ? "var(--c4)" : "var(--c3)"} r={5} />
      </Plot>
      <Legend items={[{ label: "skew > gap: B's write is lost", color: "var(--c4)" }]} />
    </Demo>
  );
}

// ============================================================================ 4. One NTP exchange, step by step

const NTP = {
  offset: range({ label: "Client clock offset (truth)", min: -50, max: 50, step: 1, default: 30, format: (v) => `${sgn(v, 0)} ms` }),
  out: range({ label: "Path out (client → server)", min: 1, max: 60, step: 1, default: 10, format: (v) => `${v} ms` }),
  back: range({ label: "Path back (server → client)", min: 1, max: 60, step: 1, default: 10, format: (v) => `${v} ms` }),
  proc: range({ label: "Server hold, t1 to t2", min: 0, max: 20, step: 1, default: 2, format: (v) => `${v} ms` }),
};

export function TimeNtpExchangeDemo() {
  const P = useParams("dist-time-ntp", NTP);
  const v = P.values;
  const start = 5;
  const { sample: s } = useMemo(() => ntpExchange({ clientOffset: v.offset, out: v.out, back: v.back, proc: v.proc, start }), [v.offset, v.out, v.back, v.proc]);
  const st = useStepper(6, 1.2);
  const tt = [start, start + v.out, start + v.out + v.proc, start + v.out + v.proc + v.back];
  const tEnd = tt[3]! + 8;
  const cursor = st.i === 0 ? 0 : st.i >= 5 ? tEnd : tt[st.i - 1]! + 0.01;
  const marks: StMark[] = [
    { node: 0, t: tt[0]!, label: "t0", color: "var(--c1)" },
    { node: 1, t: tt[1]!, label: "t1", color: "var(--c2)" },
    { node: 1, t: tt[2]!, label: v.proc >= 6 ? "t2" : "", color: "var(--c2)" },
    { node: 0, t: tt[3]!, label: "t3", color: "var(--c1)" },
  ];
  const messages = [{ from: 0, to: 1, sentAt: tt[0]!, deliveredAt: tt[1]!, label: `${v.out} ms` }, { from: 1, to: 0, sentAt: tt[2]!, deliveredAt: tt[3]!, label: `${v.back} ms` }];
  const caps = [
    "Press Step. The client will read its own clock and send a request.",
    `t0 = ${fixed(s.t0, 1)}: the client's clock when the request leaves. The client clock is ${sgn(v.offset, 0)} ms off.`,
    `t1 = ${fixed(s.t1, 1)}: the server's clock when the request arrives. The server puts t0 and t1 in its reply.`,
    `t2 = ${fixed(s.t2, 1)}: the server's clock when the reply leaves, ${v.proc} ms after t1.`,
    `t3 = ${fixed(s.t3, 1)}: the client's clock when the reply arrives. The client now has all four timestamps.`,
    `θ = ((t1 − t0) + (t2 − t3)) / 2 = ${fixed(s.theta, 1)} ms. δ = (t3 − t0) − (t2 − t1) = ${fixed(s.delta, 1)} ms. The truth is ${fixed(s.trueTheta, 1)} ms, so the error is ${sgn(s.error, 1)} ms.`,
  ];
  const asym = v.out !== v.back;
  return (
    <Demo title="One NTP exchange: four timestamps" actions={<StepButtons s={st} />} controls={<><Param spec={NTP.offset} value={v.offset} onChange={(x) => P.set("offset", x as number)} /><Param spec={NTP.out} value={v.out} onChange={(x) => P.set("out", x as number)} /><Param spec={NTP.back} value={v.back} onChange={(x) => P.set("back", x as number)} /><Param spec={NTP.proc} value={v.proc} onChange={(x) => P.set("proc", x as number)} /></>}>
      <SpaceTime nodes={["client", "server"]} tEnd={tEnd} messages={messages} marks={marks} cursor={cursor} timeLabel="true time (ms)" />
      <StepCaption tone={st.i === 5 ? (asym ? "warn" : "good") : "plain"} label={`${st.i}/5`}>{caps[st.i]}</StepCaption>
      <StepSlider s={st} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "offset estimate θ", value: `${sgn(s.theta)} ms` },
          { label: "true offset", value: `${sgn(s.trueTheta)} ms` },
          { label: "error = (out − back) / 2", value: `${sgn(s.error, 1)} ms` },
          { label: "round-trip delay δ", value: `${fixed(s.delta, 1)} ms` },
          { label: "bound the client knows: δ / 2", value: `±${fixed(s.delta / 2, 1)} ms` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 5. Many exchanges: the wedge and the clock filter

const WEDGE = {
  queue: range({ label: "Mean queueing (model input)", min: 0.5, max: 30, step: 0.5, default: 8, format: (v) => `${v} ms` }),
  filter: toggle({ label: "Show the filter picks", default: true }),
};

export function TimeNtpWedgeDemo() {
  const P = useParams("dist-time-wedge", WEDGE);
  const q = P.values.queue;
  const samples = useMemo(() => wedgeSamples({ queue: q }), [q]);
  const picks = useMemo(() => Array.from({ length: samples.length / 8 }, (_, k) => clockFilter(samples, k * 8 + 7)), [samples]);
  const dmin = Math.min(...samples.map((s) => s.delta));
  const xmax = Math.max(...samples.map((s) => s.delta)) * 1.05;
  const ymax = Math.max(5, (xmax - dmin) / 2) * 1.05;
  const meanAbs = (xs: { error: number }[]) => xs.reduce((a, s) => a + Math.abs(s.error), 0) / xs.length;
  return (
    <Demo title="200 exchanges: error against delay" controls={<><Param spec={WEDGE.queue} value={q} onChange={(x) => P.set("queue", x as number)} /><Param spec={WEDGE.filter} value={P.values.filter} onChange={(x) => P.set("filter", x as boolean)} /></>}>
      <Plot x={[dmin * 0.9, xmax]} y={[-ymax, ymax]} height={240} xLabel="round-trip delay δ (ms)" yLabel="error of θ (ms)">
        <RuleY at={0} />
        <Line points={[[dmin, 0], [xmax, (xmax - dmin) / 2]]} color="var(--c4)" width={1.4} dash="4 3" />
        <Line points={[[dmin, 0], [xmax, -(xmax - dmin) / 2]]} color="var(--c4)" width={1.4} dash="4 3" />
        <Dots points={samples.map((s) => [s.delta, s.error] as [number, number])} color="var(--c1)" r={2.4} />
        {P.values.filter && <Dots points={picks.map((s) => [s.delta, s.error] as [number, number])} color="var(--c3)" r={4.5} />}
      </Plot>
      <Legend items={[{ label: "one exchange", color: "var(--c1)" }, { label: "filter pick", color: "var(--c3)" }, { label: "|error| ≤ (δ − δmin) / 2", color: "var(--c4)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "mean |error|, every sample", value: `${fixed(meanAbs(samples), 2)} ms` },
          { label: "mean |error|, filter picks", value: `${fixed(meanAbs(picks), 2)} ms` },
          { label: "worst |error|", value: `${fixed(Math.max(...samples.map((s) => Math.abs(s.error))), 2)} ms` },
          { label: "lowest δ seen", value: `${fixed(dmin, 1)} ms` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 6. A drifting clock, corrected every N seconds

const SYNC = {
  drift: range({ label: "Client drift (model input)", min: 1, max: 200, step: 1, default: 50, format: (v) => `${v} ppm` }),
  interval: range({ label: "Poll interval", min: 16, max: 1024, log: true, default: 64, format: (v) => `${Math.round(v)} s` }),
  queue: range({ label: "Queueing (model input)", min: 0, max: 10, step: 0.5, default: 1, format: (v) => `${v} ms` }),
  filter: toggle({ label: "Best of 8 (clock filter)", default: false }),
  freq: toggle({ label: "Correct the rate too", default: false }),
};

export function TimeNtpSyncDemo() {
  const P = useParams("dist-time-sync", SYNC);
  const v = P.values;
  const duration = Math.max(1024, 8 * v.interval);
  const r = useMemo(() => syncRun({ driftPpm: v.drift, interval: v.interval, queue: v.queue, filter: v.filter, freq: v.freq, duration }), [v.drift, v.interval, v.queue, v.filter, v.freq, duration]);
  const ymax = Math.max(4, ...r.error.filter(([t]) => t > 0).map(([, e]) => Math.abs(e))) * 1.1;
  return (
    <Demo
      title="Correct the clock every N seconds"
      controls={<>
        <Param spec={SYNC.drift} value={v.drift} onChange={(x) => P.set("drift", x as number)} />
        <Param spec={SYNC.interval} value={v.interval} onChange={(x) => P.set("interval", x as number)} />
        <Param spec={SYNC.queue} value={v.queue} onChange={(x) => P.set("queue", x as number)} />
        <Param spec={SYNC.filter} value={v.filter} onChange={(x) => P.set("filter", x as boolean)} />
        <Param spec={SYNC.freq} value={v.freq} onChange={(x) => P.set("freq", x as boolean)} />
      </>}
    >
      <Plot x={[0, duration]} y={[-ymax, ymax]} height={230} xLabel="time (s)" yLabel="client clock − true time (ms)">
        <RuleY at={0} />
        <Line points={r.error} color="var(--c1)" width={1.6} />
      </Plot>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "walk between polls: drift × interval", value: `${fixed(r.walk, 1)} ms` },
          { label: "largest |error| after the first poll", value: `${fixed(r.maxAfter, 1)} ms` },
          { label: "corrections", value: r.steps.length },
        ]} />
      </div>
    </Demo>
  );
}
