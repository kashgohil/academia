/** Lesson: tracepoints and ftrace. Live patching of a function entry, a per-CPU ring buffer, a loss plot, and sampling against tracing. */
import { useMemo, useRef, useState } from "react";
import { Canvas2D, Demo, Legend, Line, Param, Plot, RuleX, RuleY, SimButtons, Stats, cssVar, range, si, toggle, useParams, useSim, bytes as fmtBytes } from "../../kit";
import {
  BODY_AFTER_SITE, CALL_BYTES, DEFAULT_BUFFER_KIB, FTRACE_INPUTS, NOP5, PROFILER_HZ, RingBuffer, SAMPLE_INPUTS, TraceBuffers, costPerCallNs, cpuShareAt, encodeRel32, lossModel, naivePatch, pMissAll, pSeen, samplerCpuShare, simulateSampler, textPokeBp, tracerCpuShare,
  FN_ENTRY, type FnTracer, type RingMode, type SiteView,
} from "../../sims/os/observability";
import { Cap, Msg, Note, Panel, StepButtons, StepSlider, mono, seg, tint } from "./ProcessesUi";

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const ns = (x: number) => `${x} ns`;
/** A percentage that stays readable when it is very small. */
const smallPct = (share: number) => (share === 0 ? "0%" : share >= 0.001 ? `${(share * 100).toFixed(2)}%` : `${Number((share * 100).toPrecision(2))}%`);

// ---------------------------------------------------------------------------- live patching

const VIEW_TEXT: Record<SiteView | "fentry", { text: string; color: string }> = {
  fentry: { text: "call __fentry__ (from the compiler)", color: "var(--c5)" },
  old: { text: "", color: "var(--fg)" },
  new: { text: "", color: "var(--fg)" },
  int3: { text: "int3: the trap handler emulates the instruction", color: "var(--c2)" },
  torn: { text: "bytes from neither version: a crash", color: "var(--c4)" },
};
const FENTRY = encodeRel32(FN_ENTRY, 0xffffffff81002000n);

interface Frame { title: string; text: string; bytes: number[]; hot: number[]; label: string; color: string; on: boolean; sync: boolean }

function frames(naive: boolean): Frame[] {
  const nop = "nopl 0x0(%rax,%rax,1): tracing is off";
  const call = "call ftrace_caller: tracing is on";
  const fr: Frame[] = [
    { title: "The compiler output", text: "With -pg and -mfentry, each traceable function starts with a call. A build step records this address in the __mcount_loc section.", bytes: FENTRY, hot: [0, 1, 2, 3, 4], label: VIEW_TEXT.fentry.text, color: VIEW_TEXT.fentry.color, on: false, sync: false },
    { title: "At boot", text: "The kernel walks the list of sites and writes a 5-byte nop at each one. The cost of the call is gone. The function has one nop that does nothing.", bytes: [...NOP5], hot: [0, 1, 2, 3, 4], label: nop, color: "var(--c3)", on: false, sync: false },
  ];
  const on = naive ? naivePatch(NOP5, CALL_BYTES) : textPokeBp(NOP5, CALL_BYTES);
  for (const s of on.slice(1)) {
    fr.push({ title: `Turn on. ${s.title}`, text: s.text, bytes: s.bytes, hot: s.hot, label: s.view === "new" ? call : s.view === "old" ? nop : VIEW_TEXT[s.view].text, color: s.view === "new" ? "var(--c1)" : s.view === "old" ? "var(--c3)" : VIEW_TEXT[s.view].color, on: s.view === "new", sync: s.sync });
  }
  if (!naive) {
    for (const s of textPokeBp(CALL_BYTES, NOP5).slice(1)) {
      fr.push({ title: `Turn off. ${s.title}`, text: s.text, bytes: s.bytes, hot: s.hot, label: s.view === "new" ? nop : s.view === "old" ? call : VIEW_TEXT[s.view].text, color: s.view === "new" ? "var(--c3)" : s.view === "old" ? "var(--c1)" : VIEW_TEXT[s.view].color, on: s.view === "old" || s.view === "int3", sync: s.sync });
    }
  }
  return fr;
}

export function FunctionPatchDemo() {
  const p = useParams("ft-patch", {
    how: seg("How to write", [["bp", "text_poke_bp"], ["naive", "byte by byte"]], "bp"),
    tracer: seg("Tracer", [["function", "function"], ["function_graph", "function_graph"]], "function"),
    rate: range({ label: "Kernel function calls per second, one CPU (model input)", min: 1e4, max: 2e7, default: FTRACE_INPUTS.callsPerSecond, log: true, format: (v) => si(v) }),
  });
  const [k, setK] = useState(0);
  const fr = useMemo(() => frames(p.values.how === "naive"), [p.values.how]);
  const kk = Math.min(k, fr.length - 1);
  const f = fr[kk]!;
  const tracer = p.values.tracer as FnTracer;
  const nowOn = f.on;
  const cost = nowOn ? costPerCallNs(tracer) : costPerCallNs("off");
  return (
    <Demo
      title="The first bytes of a kernel function"
      actions={<StepButtons k={kk} n={fr.length} set={setK} />}
      controls={<>
        <StepSlider k={kk} n={fr.length} set={setK} />
        <Param spec={p.schema.how} value={p.values.how} onChange={(v) => { p.set("how", v as "bp"); setK(0); }} />
        <Param spec={p.schema.tracer} value={p.values.tracer} onChange={(v) => p.set("tracer", v as "function")} />
        <Param spec={p.schema.rate} value={p.values.rate} onChange={(v) => p.set("rate", v as number)} />
      </>}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{f.title}</div>
      <Msg min={56}>{f.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginBottom: 6 }}>
        {f.bytes.map((b, i) => (
          <div key={i} style={{ ...mono, width: 28, textAlign: "center", padding: "6px 0", fontSize: 12.5, borderRadius: 4, border: `1px solid ${f.hot.includes(i) ? "var(--fg)" : "var(--border)"}`, background: b === 0xcc ? "var(--c2)" : f.hot.includes(i) ? tint("var(--c2)", 20) : "var(--bg)", color: b === 0xcc ? "var(--bg)" : "var(--fg)", transition: "background 0.2s" }}>{hex2(b)}</div>
        ))}
        <div style={{ width: 4 }} />
        {BODY_AFTER_SITE.map((b, i) => (
          <div key={i} style={{ ...mono, width: 28, textAlign: "center", padding: "6px 0", fontSize: 12.5, borderRadius: 4, border: "1px dashed var(--border)", color: "var(--muted)" }}>{hex2(b)}</div>
        ))}
      </div>
      <div style={{ ...mono, fontSize: 12.5, minHeight: 36, marginBottom: 2, color: f.color, overflowWrap: "anywhere" }}>{f.label}</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>The dashed bytes are the function body: push rbp, then mov rbp, rsp. They never change.</div>
      <Stats items={[
        { label: "cost per call now", value: ns(cost) },
        { label: "off (one nop)", value: ns(costPerCallNs("off")) },
        { label: `on (${tracer})`, value: ns(costPerCallNs(tracer)) },
        { label: "share of one CPU now", value: `${(Math.min(1, (cost * p.values.rate) / 1e9) * 100).toFixed(3)}%` },
        { label: "share of one CPU if on", value: `${(cpuShareAt(tracer, p.values.rate) * 100).toFixed(1)}%` },
      ]} />
      <Note>Model inputs: nop {FTRACE_INPUTS.nopNs} ns, trampoline {FTRACE_INPUTS.trampolineNs} ns, record {FTRACE_INPUTS.recordNs} ns, extra for function_graph {FTRACE_INPUTS.graphExtraNs} ns.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- ring buffer stepper

const EVENT_B = 32;
const SMALL_PAGE = 16 + EVENT_B * 4; // A small page that holds 4 events.
const SMALL_PAGES = 4;

interface RingState { tb: TraceBuffers; log: string[]; wDebt: number[]; rDebt: number }
const newState = (mode: RingMode): RingState => ({ tb: new TraceBuffers(2, SMALL_PAGES, SMALL_PAGE, mode), log: [], wDebt: [0, 0], rDebt: 0 });

function readOne(st: RingState): boolean {
  // A simple reader: it takes from the fuller ring. The real trace_pipe merges the CPUs by timestamp.
  let best: RingBuffer | null = null;
  let any = false;
  for (const r of st.tb.rings) {
    if (r.held() > 0) {
      any = true;
      if (!best || r.held() > best.held()) best = r;
    }
  }
  if (!any || !best) return false;
  const e = best.readEvent();
  if (!e) return false;
  if (e.lostBefore > 0) st.log.push(`CPU:${best.cpu} [LOST ${e.lostBefore} EVENTS]`);
  st.log.push(`cpu${e.event.cpu} event #${e.event.id}`);
  if (st.log.length > 8) st.log.splice(0, st.log.length - 8);
  return true;
}

export function RingBufferDemo() {
  const p = useParams("ft-ring", {
    mode: seg("When a ring is full", [["overwrite", "overwrite the oldest"], ["discard", "drop the newest"]], "overwrite"),
    rate: range({ label: "Events per second on CPU 0 (CPU 1 has half)", min: 0, max: 40, step: 1, default: 12 }),
    read: range({ label: "Reader: events per second", min: 0, max: 40, step: 1, default: 4 }),
  });
  const mode = p.values.mode as RingMode;
  const ref = useRef<RingState>(newState(mode));
  const lastMode = useRef(mode);
  if (lastMode.current !== mode) {
    lastMode.current = mode;
    ref.current = newState(mode);
  }
  const [, force] = useState(0);
  const sim = useSim({
    dt: 0.05,
    step: (dt) => {
      const st = ref.current;
      st.tb.rings.forEach((r, c) => {
        st.wDebt[c]! += p.values.rate * (c === 0 ? 1 : 0.5) * dt;
        for (; st.wDebt[c]! >= 1; st.wDebt[c]!--) r.write(EVENT_B);
      });
      st.rDebt += p.values.read * dt;
      for (; st.rDebt >= 1; st.rDebt--) if (!readOne(st)) { st.rDebt = 0; break; }
    },
    reset: () => { ref.current = newState(mode); },
  });
  const st = ref.current;
  const total = st.tb.total();
  const write = (c: number, n: number) => { for (let i = 0; i < n; i++) st.tb.rings[c]!.write(EVENT_B); force((x) => x + 1); };
  const read = (n: number) => { for (let i = 0; i < n; i++) readOne(st); force((x) => x + 1); };
  return (
    <Demo
      title="One ring per CPU"
      actions={<SimButtons sim={sim} />}
      controls={<>
        <Param spec={p.schema.rate} value={p.values.rate} onChange={(v) => p.set("rate", v as number)} />
        <Param spec={p.schema.read} value={p.values.read} onChange={(v) => p.set("read", v as number)} />
        <Param spec={p.schema.mode} value={p.values.mode} onChange={(v) => p.set("mode", v as "overwrite")} />
      </>}
    >
      <Cap>Each ring has {SMALL_PAGES} small pages of 4 events. A real page holds about 127 events of 32 bytes.</Cap>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <button className="btn" onClick={() => write(0, 1)}>Write 1, CPU 0</button>
        <button className="btn" onClick={() => write(0, 10)}>Burst 10, CPU 0</button>
        <button className="btn" onClick={() => write(1, 10)}>Burst 10, CPU 1</button>
        <button className="btn" onClick={() => read(1)}>Read 1</button>
        <button className="btn" onClick={() => read(4)}>Read 4</button>
      </div>
      {st.tb.rings.map((r) => (
        <div key={r.cpu} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 3 }}>CPU {r.cpu}: lost {r.overwritten + r.dropped} of {r.written}</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${SMALL_PAGES}, minmax(0, 1fr)) 8px minmax(0, 1fr)`, gap: 4 }}>
            {r.view().map((pg) => {
              const events = r.pages[pg.index]!.events;
              return (
                <div key={pg.index} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 10, height: 13, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden" }}>{pg.isHead && pg.isTail ? "head, tail" : pg.isHead ? "head" : pg.isTail ? "tail" : ""}</div>
                  <PageBox ids={events.map((e) => e.id)} color={pg.isTail ? "var(--c1)" : "var(--c5)"} strong={pg.isHead || pg.isTail} />
                </div>
              );
            })}
            <div />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, height: 13, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden" }}>reader</div>
              <PageBox ids={r.readerPage.events.map((e) => e.id)} color="var(--c3)" read={readPos(r)} />
            </div>
          </div>
        </div>
      ))}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, alignItems: "start" }}>
        <Panel title="trace_pipe reads">
          <div style={{ ...mono, fontSize: 11.5, minHeight: 92 }}>
            {st.log.length ? st.log.slice(-6).map((l, i) => <div key={i} style={{ color: l.includes("LOST") ? "var(--c4)" : "var(--fg)", fontWeight: l.includes("LOST") ? 600 : 400 }}>{l}</div>) : <span className="muted">nothing yet</span>}
          </div>
        </Panel>
        <Stats items={[
          { label: "written", value: total.written },
          { label: "read", value: total.read },
          { label: "overwritten", value: total.overwritten },
          { label: "dropped", value: total.dropped },
          { label: "held", value: total.held },
        ]} />
      </div>
      <Note>Each event is in one place: written = read + overwritten + dropped + held. Now: {total.written} = {total.read} + {total.overwritten} + {total.dropped} + {total.held}.</Note>
    </Demo>
  );
}

const readPos = (r: RingBuffer) => r.readerPage.events.length - (r.held() - r.pages.reduce((n, p) => n + p.events.length, 0));

function PageBox({ ids, color, strong, read = 0 }: { ids: number[]; color: string; strong?: boolean; read?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1, border: `1px solid ${strong ? "var(--fg)" : "var(--border)"}`, borderRadius: 4, padding: 2, minHeight: 42 }}>
      {[0, 1, 2, 3].map((i) => {
        const id = ids[i];
        const done = i < read;
        return <div key={i} style={{ ...mono, fontSize: 10, height: 17, lineHeight: "17px", textAlign: "center", borderRadius: 2, overflow: "hidden", background: id === undefined || done ? "transparent" : tint(color, 30), color: done ? "var(--faint)" : "var(--fg)" }}>{id ?? ""}</div>;
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------- loss plot

const SIZES = [
  { kib: DEFAULT_BUFFER_KIB, color: "var(--c1)" },
  { kib: DEFAULT_BUFFER_KIB * 16, color: "var(--c2)" },
  { kib: DEFAULT_BUFFER_KIB * 256, color: "var(--c3)" },
];

export function RingLossDemo() {
  const p = useParams("ft-loss", {
    rate: range({ label: "Events per second on one CPU", min: 1e3, max: 1e7, default: 1e6, log: true, format: (v) => si(v) }),
    buf: range({ label: "buffer_size_kb", min: 64, max: 1048576, default: DEFAULT_BUFFER_KIB, log: true, format: (v) => fmtBytes(Math.round(v) * 1024) }),
    read: range({ label: "Reader: events per second (model input)", min: 1e3, max: 1e7, default: 3e5, log: true, format: (v) => si(v) }),
    seconds: range({ label: "Length of the burst", min: 0.01, max: 60, default: 1, log: true, format: (v) => si(v, "s") }),
    size: range({ label: "Bytes per event", min: 16, max: 256, step: 8, default: 32 }),
  });
  const v = p.values;
  const xs = useMemo(() => Array.from({ length: 80 }, (_, i) => 1e3 * Math.pow(1e4, i / 79)), []);
  const curve = (kib: number) => xs.map((x) => [x, 100 * lossModel({ eventRate: x, eventBytes: v.size, bufferKiB: kib, readRate: v.read, seconds: v.seconds }).share] as [number, number]);
  const now = lossModel({ eventRate: v.rate, eventBytes: v.size, bufferKiB: v.buf, readRate: v.read, seconds: v.seconds });
  return (
    <Demo title="Lost events against event rate and buffer size" controls={<>
      <Param spec={p.schema.rate} value={v.rate} onChange={(x) => p.set("rate", x as number)} />
      <Param spec={p.schema.buf} value={v.buf} onChange={(x) => p.set("buf", x as number)} />
      <Param spec={p.schema.read} value={v.read} onChange={(x) => p.set("read", x as number)} />
      <Param spec={p.schema.seconds} value={v.seconds} onChange={(x) => p.set("seconds", x as number)} />
      <Param spec={p.schema.size} value={v.size} onChange={(x) => p.set("size", x as number)} />
    </>}>
      <Plot x={[1e3, 1e7]} y={[0, 100]} logX height={230} xLabel="events per second" yLabel="events lost (%)" xTicks={[1e3, 1e4, 1e5, 1e6, 1e7]} xFormat={(t) => si(t)} yTicks={[0, 25, 50, 75, 100]}>
        {SIZES.map((s) => <Line key={s.kib} points={curve(s.kib)} color={s.color} />)}
        <Line points={curve(v.buf)} color="var(--fg)" dash="4 3" />
        <RuleX at={v.rate} color="var(--fg)" />
        <RuleY at={100 * now.share} color="var(--faint)" />
      </Plot>
      <Legend items={[...SIZES.map((s) => ({ label: fmtBytes(s.kib * 1024), color: s.color })), { label: "your buffer", color: "var(--fg)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "written in the burst", value: si(now.written) },
          { label: "lost", value: si(Math.round(now.lost)) },
          { label: "share lost", value: `${(now.share * 100).toFixed(1)}%` },
          { label: "events one CPU buffer holds", value: si(now.capacity) },
          { label: "time to fill", value: Number.isFinite(now.secondsToFill) ? si(now.secondsToFill, "s") : "never" },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- sampling against tracing

const HZ_OPTIONS: [string, string][] = [["49", "49 Hz"], ["99", "99 Hz"], ["100", "100 Hz"], ["997", "997 Hz"]];

export function SamplingVsTracingDemo() {
  const p = useParams("ft-sample", {
    ms: range({ label: "Length of one event", min: 0.01, max: 100, default: 2, log: true, format: (v) => si(v * 1e-3, "s") }),
    rate: range({ label: "Events per second", min: 0.05, max: 1000, default: 1, log: true, format: (v) => si(v) }),
    hz: seg("Sampler rate", HZ_OPTIONS as [string, string][], String(PROFILER_HZ)),
    periodic: toggle({ label: "Events come from an exact timer", default: false }),
  });
  const v = p.values;
  const SECONDS = 60;
  const hz = Number(v.hz);
  const r = useMemo(() => simulateSampler({ eventMs: v.ms, eventRate: v.rate, seconds: SECONDS, seed: 11, periodic: v.periodic, phase: 0 }, hz), [v.ms, v.rate, hz, v.periodic]);
  const bg = useMemo(() => {
    let k = 0;
    const hitT: number[] = [];
    for (const t of r.times) {
      while (k < r.spans.length && r.spans[k]![1] <= t) k++;
      const s = r.spans[k];
      if (s && t >= s[0] && t < s[1]) hitT.push(t);
    }
    return hitT;
  }, [r]);
  return (
    <Demo title="What a sampler sees in 60 seconds" controls={<>
      <Param spec={p.schema.ms} value={v.ms} onChange={(x) => p.set("ms", x as number)} />
      <Param spec={p.schema.rate} value={v.rate} onChange={(x) => p.set("rate", x as number)} />
      <Param spec={p.schema.hz} value={v.hz} onChange={(x) => p.set("hz", x as string)} />
      <Param spec={p.schema.periodic} value={v.periodic} onChange={(x) => p.set("periodic", x as boolean)} />
    </>}>
      <Canvas2D
        height={140}
        deps={[r, bg, hz]}
        draw={(ctx, w) => {
          const X = 56, W = w - X - 4;
          const fg = cssVar("--muted"), c1 = cssVar("--c1"), c4 = cssVar("--c4");
          ctx.font = "11px ui-sans-serif, system-ui";
          ctx.fillStyle = fg;
          ctx.fillText("tracer", 0, 22);
          ctx.fillText("sampler", 0, 62);
          ctx.fillStyle = c1;
          const step = Math.max(1, Math.floor(r.spans.length / 1500));
          for (let i = 0; i < r.spans.length; i += step) ctx.fillRect(X + (r.spans[i]![0] / SECONDS) * W, 8, Math.max(1, ((r.spans[i]![1] - r.spans[i]![0]) / SECONDS) * W), 22);
          ctx.fillStyle = c4;
          const stepH = Math.max(1, Math.floor(bg.length / 1500));
          for (let i = 0; i < bg.length; i += stepH) ctx.fillRect(X + (bg[i]! / SECONDS) * W, 48, 1.5, 22);
          ctx.fillStyle = fg;
          ctx.fillRect(X, 36, W, 1);
          ctx.fillText("0 s", X, 88);
          ctx.textAlign = "right";
          ctx.fillText(`${SECONDS} s`, X + W, 88);
          ctx.textAlign = "left";
          // Up close: the first event, and the samples near it.
          const first = r.spans[0];
          if (first) {
            const span = Math.max(0.03, (first[1] - first[0]) * 3);
            const from = first[0] - (span - (first[1] - first[0])) / 2;
            const px = (t: number) => X + ((t - from) / span) * W;
            ctx.fillStyle = fg;
            ctx.fillText("up close", 0, 118);
            ctx.fillStyle = c1;
            ctx.fillRect(px(first[0]), 104, Math.max(1, ((first[1] - first[0]) / span) * W), 22);
            for (const t of r.times) {
              if (t < from || t > from + span) continue;
              const inside = t >= first[0] && t < first[1];
              ctx.fillStyle = inside ? c4 : fg;
              ctx.fillRect(px(t), 100, inside ? 2 : 1, 30);
            }
            ctx.fillStyle = fg;
            ctx.fillText(`first event, in a ${si(span, "s")} window`, X, 138);
          }
        }}
      />
      <Legend items={[{ label: "each event, from the tracer", color: "var(--c1)" }, { label: "samples that fell inside an event", color: "var(--c4)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "events that happened", value: si(r.events) },
          { label: "events with a sample", value: si(r.seen) },
          { label: "samples inside events", value: `${si(r.hits)} of ${si(r.samples)}` },
          { label: "true share of time", value: `${(r.trueShare * 100).toFixed(2)}%` },
          { label: "share from samples", value: `${(r.estShare * 100).toFixed(2)}%` },
        ]} />
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "chance to catch one event", value: `${(pSeen(v.ms, hz) * 100).toFixed(1)}%` },
          { label: "chance to miss all, random times", value: `${(pMissAll(v.ms, v.rate, SECONDS, hz) * 100).toFixed(1)}%` },
          { label: "sampler CPU", value: smallPct(samplerCpuShare(hz)) },
          { label: "tracer CPU", value: smallPct(tracerCpuShare(v.rate)) },
        ]} />
      </div>
      <Note>Model inputs: one sample {SAMPLE_INPUTS.sampleNs} ns, one traced event {SAMPLE_INPUTS.traceEventNs} ns. Each number above comes from this simulation of one CPU that always runs.</Note>
    </Demo>
  );
}
