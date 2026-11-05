/** Demos for "interrupts": the path of one interrupt, a CPU timeline, and goodput against packet rate. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, pct, range, si, useParams, useWidth, IndexButtons, IndexSlider, Panel, mono, seg, tint } from "../../kit";
import {
  IRQ_MODEL, IRQ_PATH, RX_DEFAULTS, RX_LABEL, irqShares, irqTimeline, rxGoodput,
  type CpuLane, type IrqTimelineResult, type RxMode,
} from "../../sims/os/io";
import { Msg } from "./ProcessesUi";

// ---------------------------------------------------------------- the path of one interrupt

const STAGES: { id: (typeof IRQ_PATH)[number]["stage"]; label: string }[] = [
  { id: "device", label: "Device" },
  { id: "apic", label: "APIC" },
  { id: "idt", label: "IDT" },
  { id: "entry", label: "Entry" },
  { id: "eoi", label: "EOI" },
  { id: "handler", label: "Top half" },
  { id: "softirq", label: "Softirq" },
  { id: "return", label: "Task" },
];

export function IoIrqPathDemo() {
  const [k, setK] = useState(0);
  const s = IRQ_PATH[k]!;
  return (
    <Demo title="One interrupt, from the device to the task" actions={<IndexButtons k={k} n={IRQ_PATH.length} set={setK} />} controls={<IndexSlider k={k} n={IRQ_PATH.length} set={setK} />}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(62px, 1fr))", gap: 6, marginBottom: 12 }}>
        {STAGES.map((b, i) => {
          const on = i === k;
          const past = i < k;
          return (
            <button key={b.id} className="btn" onClick={() => setK(i)} style={{ padding: "6px 2px", fontSize: 12, background: on ? "var(--fg)" : past ? tint("var(--c1)") : "var(--bg)", color: on ? "var(--bg)" : "var(--fg)" }}>
              {b.label}
            </button>
          );
        })}
      </div>
      <div style={{ fontWeight: 550, fontSize: 14, marginBottom: 2 }}>{s.title}</div>
      <Msg min={76}>{s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Panel title="Context" style={{ flex: "1 1 120px" }}><span style={{ ...mono, fontSize: 13 }}>{s.context === "task" ? "the task" : s.context === "hardirq" ? "hard interrupt" : "softirq"}</span></Panel>
        <Panel title="Interrupts on this CPU" style={{ flex: "1 1 120px" }}><span style={{ ...mono, fontSize: 13, color: s.irqsOff ? "var(--c4)" : "var(--c3)" }}>{s.irqsOff ? "off" : "on"}</span></Panel>
        <Panel title="May sleep" style={{ flex: "1 1 120px" }}><span style={{ ...mono, fontSize: 13 }}>{s.context === "task" ? "the task may" : "no"}</span></Panel>
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- CPU timeline

const LANES: { id: CpuLane; label: string; color: string }[] = [
  { id: "hard", label: "hard IRQ", color: "var(--c4)" },
  { id: "soft", label: "softirq", color: "var(--c2)" },
  { id: "ksoftirqd", label: "ksoftirqd", color: "var(--c5)" },
  { id: "task", label: "task", color: "var(--c1)" },
];

function CpuLanes({ res, windowUs }: { res: IrqTimelineResult; windowUs: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const left = 68, h = 24, gap = 6;
  const iw = Math.max(40, width - left - 6);
  const x = (t: number) => (t / windowUs) * iw;
  const paths = LANES.map((l, li) => {
    const y = li * (h + gap);
    let d = "";
    for (const s of res.segments) {
      if (s.kind !== l.id || s.start >= windowUs) continue;
      const a = x(s.start), b = x(Math.min(s.end, windowUs));
      // At least a hairline, so that a short handler stays visible when zoomed out.
      d += `M${a.toFixed(2)} ${y}h${Math.max(0.7, b - a).toFixed(2)}v${h}H${a.toFixed(2)}z`;
    }
    return d;
  });
  const H = LANES.length * (h + gap) + 18;
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={width} height={H} role="img" aria-label="CPU timeline" style={{ display: "block" }}>
        {LANES.map((l, li) => <text key={l.id} x={0} y={li * (h + gap) + 16} fontSize={11.5} fill="var(--muted)">{l.label}</text>)}
        <g transform={`translate(${left},0)`}>
          {LANES.map((l, li) => <rect key={l.id} x={0} y={li * (h + gap)} width={iw} height={h} fill="var(--subtle)" />)}
          {LANES.map((l, li) => <path key={l.id} d={paths[li]} fill={l.color} />)}
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={f * iw} y={H - 4} fontSize={10.5} fill="var(--muted)" textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>{windowUs * f >= 1000 ? `${(windowUs * f) / 1000} ms` : `${windowUs * f} µs`}</text>
          ))}
        </g>
      </svg>
    </div>
  );
}

const TL = {
  rate: range({ label: "Event rate", min: 2000, max: 400000, log: true, default: 100000, format: (v) => `${si(Math.round(v))} per second` }),
  coalesce: seg<"1" | "8" | "32">("Interrupt after", [["1", "1 event"], ["8", "8 events or 50 µs"], ["32", "32 events or 50 µs"]], "1"),
  zoom: seg<"500" | "2000" | "20000">("Window", [["500", "0.5 ms"], ["2000", "2 ms"], ["20000", "20 ms"]], "2000"),
};

export function IoCpuTimelineDemo() {
  const p = useParams("io-tl", TL);
  const frames = Number(p.values.coalesce);
  const coalesceUs = frames > 1 ? 50 : 0;
  const res = useMemo(() => irqTimeline({ rate: p.values.rate, spanUs: 20000, framesPerIrq: frames, coalesceUs }), [p.values.rate, frames, coalesceUs]);
  const shares = irqShares(p.values.rate, { framesPerIrq: frames, coalesceUs });
  const span = res.spanUs;
  return (
    <Demo
      title="One CPU: a task, hard interrupts and softirqs"
      controls={
        <>
          <Param spec={TL.rate} value={p.values.rate} onChange={(v) => p.set("rate", v as number)} />
          <Param spec={TL.coalesce} value={p.values.coalesce} onChange={(v) => p.set("coalesce", v as never)} />
          <Param spec={TL.zoom} value={p.values.zoom} onChange={(v) => p.set("zoom", v as never)} />
        </>
      }
    >
      <CpuLanes res={res} windowUs={Number(p.values.zoom)} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "task share", value: pct(res.time.task / span) },
          { label: "hard IRQ share", value: pct(res.time.hard / span) },
          { label: "softirq share", value: pct((res.time.soft + res.time.ksoftirqd) / span) },
          { label: "interrupts per second", value: si((res.interrupts / span) * 1e6) },
          { label: "mean event delay", value: res.meanLatencyUs >= 1000 ? `${(res.meanLatencyUs / 1000).toFixed(1)} ms` : `${res.meanLatencyUs.toFixed(0)} µs` },
        ]} />
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0", minHeight: 36 }}>
        {res.deferred
          ? `Softirq work ran past its limit, so ksoftirqd took over. It now shares the CPU with the task. With no ksoftirqd the task would get ${pct(shares.task)}.`
          : `Model inputs: a hard handler takes ${IRQ_MODEL.hardUs} µs and softirq work takes ${IRQ_MODEL.softUs} µs per event. Arrivals are random.`}
      </p>
    </Demo>
  );
}

// ---------------------------------------------------------------- goodput

const MODES: RxMode[] = ["irq", "coalesce", "napi"];
const MODE_COLOR: Record<RxMode, string> = { irq: "var(--c4)", coalesce: "var(--c2)", napi: "var(--c3)" };
const RX_MAX = 500_000;

const LIVE = {
  rate: range({ label: "Offered packets", min: 10000, max: RX_MAX, step: 5000, default: 200000, format: (v) => `${si(v)} per second` }),
  windowUs: range({ label: "Coalescing window", min: 5, max: 200, step: 5, default: RX_DEFAULTS.windowUs, format: (v) => `${v} µs` }),
};

function ShareBar({ hard, soft, app }: { hard: number; soft: number; app: number }) {
  const idle = Math.max(0, 1 - hard - soft - app);
  const parts = [
    { w: hard, c: "var(--c4)", t: "hard" },
    { w: soft, c: "var(--c2)", t: "softirq" },
    { w: app, c: "var(--c1)", t: "application" },
    { w: idle, c: "var(--subtle)", t: "idle" },
  ];
  return (
    <div style={{ display: "flex", height: 14, border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden", flex: 1, minWidth: 80 }}>
      {parts.map((x) => <div key={x.t} title={`${x.t}: ${pct(x.w)}`} style={{ width: `${x.w * 100}%`, background: x.c, transition: "width .2s" }} />)}
    </div>
  );
}

export function IoLivelockDemo() {
  const p = useParams("io-live", LIVE);
  const { rate, windowUs } = p.values;
  const inputs = { ...RX_DEFAULTS, windowUs };
  const curves = useMemo(() => MODES.map((m) => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 200; i++) { const r = (i / 200) * RX_MAX; pts.push([r / 1000, rxGoodput(m, r, inputs).goodput / 1000]); }
    return pts;
  }), [windowUs]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Demo
      title="Goodput against offered packet rate"
      controls={
        <>
          <Param spec={LIVE.rate} value={rate} onChange={(v) => p.set("rate", v as number)} />
          <Param spec={LIVE.windowUs} value={windowUs} onChange={(v) => p.set("windowUs", v as number)} />
        </>
      }
    >
      <Plot x={[0, RX_MAX / 1000]} y={[0, 140]} height={240} xLabel="offered, thousand packets per second" yLabel="delivered to the application, thousand per second">
        {MODES.map((m, i) => <Line key={m} points={curves[i]!} color={MODE_COLOR[m]} />)}
        <RuleX at={rate / 1000} />
      </Plot>
      <Legend items={MODES.map((m) => ({ label: RX_LABEL[m], color: MODE_COLOR[m] }))} />
      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {MODES.map((m) => {
          const r = rxGoodput(m, rate, inputs);
          return (
            <div key={m} style={{ fontSize: 12.5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 2 }}>
                <span style={{ color: MODE_COLOR[m], fontWeight: 550 }}>{RX_LABEL[m]}</span>
                <span style={mono}>{si(Math.round(r.goodput))} delivered</span>
              </div>
              <div style={{ display: "flex" }}><ShareBar hard={r.hard} soft={r.soft} app={r.app} /></div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 8 }}>
        <Legend items={[{ label: "hard IRQ", color: "var(--c4)" }, { label: "softirq", color: "var(--c2)" }, { label: "application", color: "var(--c1)" }]} />
      </div>
    </Demo>
  );
}
