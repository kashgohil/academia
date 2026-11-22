/** Demos for "Go's GC": the heap goal and pacing as a calculator, and a real gctrace line read field by field. */
import { useState } from "react";
import {
  Banner, Controls, Demo, IndexButtons, IndexSlider, Line, MiniTable, Plot, RuleY, SectionLabel, Stats, fixed, mono, pct, range, tint, toggle, useParams,
} from "../../kit";
import { BACKGROUND_UTILIZATION, CYCLE_DEFAULTS, GCTRACE, LIMITER_CAP, goCycle, parseTrace, sawtooth, type CycleIn } from "../../sims/sys/gc";
import { GcCode } from "./SysGcUi";

const PACE = {
  live: range({ label: "Live heap, MiB", min: 2, max: 1000, step: 1, default: CYCLE_DEFAULTS.live, log: true, format: (v) => `${Math.round(v)}` }),
  gogc: range({ label: "GOGC", min: 10, max: 800, step: 10, default: 100 }),
  off: toggle({ label: "GOGC=off", default: false }),
  limitOn: toggle({ label: "Set GOMEMLIMIT", default: false }),
  limit: range({ label: "GOMEMLIMIT, MiB", min: 50, max: 4000, step: 10, default: 400, log: true, format: (v) => `${Math.round(v)}` }),
  rate: range({ label: "Allocation rate, MiB/s", min: 10, max: 4000, step: 10, default: CYCLE_DEFAULTS.rate, log: true, format: (v) => `${Math.round(v)}` }),
};

export function GoPacerDemo() {
  const P = useParams("sys-gc-pacer", PACE);
  const v = P.values;
  const inp: CycleIn = { ...CYCLE_DEFAULTS, live: Math.round(v.live), gogc: v.off ? null : v.gogc, limit: v.limitOn ? Math.round(v.limit) : null, rate: Math.round(v.rate) };
  const c = goCycle(inp);
  const secs = 2;
  const pts = sawtooth(inp, secs);
  const top = Math.max(c.peak, inp.limit ?? 0, inp.live * 2.2) * 1.08;
  const unbounded = !Number.isFinite(c.goal);
  return (
    <Demo title="The heap goal and the price of memory" controls={<Controls params={P} />}>
      <Plot x={[0, secs]} y={[0, unbounded ? inp.live + inp.rate * secs : top]} height={210} xLabel="seconds" yLabel="heap, MiB">
        <Line points={pts} color="var(--c1)" width={1.3} />
        {Number.isFinite(c.goal) && <RuleY at={c.goal} label="goal" color="var(--c3)" />}
        {inp.limit !== null && <RuleY at={inp.limit - inp.nonHeap} label="limit − non-heap" color="var(--c4)" />}
      </Plot>
      <Stats items={[
        { label: "heap goal", value: unbounded ? "none: GOGC=off" : `${fixed(c.goal, 1)} MiB (${c.by === "gogc" ? "GOGC" : c.by === "minimum" ? "4 MiB minimum" : "memory limit"})` },
        { label: "GC cycles per second", value: fixed(c.cyclesPerSec, 1) },
        { label: "GC CPU, share of all P", value: unbounded ? "0%" : pct(c.share) },
        { label: "process memory (heap peak + non-heap)", value: unbounded ? "grows without end" : `${fixed(c.total, 0)} MiB` },
      ]} />
      {unbounded ? <Banner tone="bad">With GOGC=off and no memory limit, the GC never runs. The heap grows until the system kills the process.</Banner>
        : c.capped ? <Banner tone="bad">The limit leaves too little room: it would need {Number.isFinite(c.wanted) ? pct(c.wanted) : "all"} of the CPU for GC. The limiter caps GC at about {pct(LIMITER_CAP, 0)}, so the heap goes over the limit instead of the program stopping.</Banner>
        : <Banner tone="info">Each cycle marks {fixed(inp.live + inp.roots, 0)} MiB (live heap + roots) and then the program allocates {fixed(c.runway, 1)} MiB before the next one. Double GOGC and the runway doubles, so the GC runs half as often.</Banner>}
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
        Model inputs: roots {inp.roots} MiB, non-heap memory {inp.nonHeap} MiB, {inp.procs} P, a cycle costs {inp.fixedMs} ms + {inp.markMsPerMiB} ms per MiB marked of CPU time. Background marking is planned at {pct(BACKGROUND_UTILIZATION, 0)} of the P while a cycle runs.
      </p>
    </Demo>
  );
}

type Field = "n" | "at" | "pct" | "clock" | "cpu" | "heap" | "goal" | "stacks" | "globals" | "procs";
const FIELD_TEXT: Record<Field, string> = {
  n: "The number of this collection. It counts up from 1.",
  at: "Seconds since the program started.",
  pct: "The share of the program's time spent in GC since it started.",
  clock: "Wall-clock time of the three phases: stop-the-world sweep termination + concurrent mark and scan + stop-the-world mark termination.",
  cpu: "CPU time of the same phases. The middle part is split into mark assist (goroutines that allocate do GC work) / background mark workers / idle-time marking.",
  heap: "Heap size when this GC started -> when it ended -> live heap that it marked. The live heap sets the next goal.",
  goal: "The heap goal of this cycle. It was computed from the live heap of the previous cycle.",
  stacks: "Estimated stack bytes to scan (a GC root).",
  globals: "Scannable global bytes (a GC root).",
  procs: "The number of P (GOMAXPROCS) that the GC could use.",
};

const LINES = [...GCTRACE.gogc100.map((l) => ({ l, tag: "GOGC=100" })), ...GCTRACE.gogc400.map((l) => ({ l, tag: "GOGC=400" })), ...GCTRACE.offLimit40.map((l) => ({ l, tag: "GOGC=off GOMEMLIMIT=40MiB" }))];

/** Splits a gctrace line into tokens tagged with their field. */
function tokens(line: string): { t: string; f?: Field }[] {
  const m = /^(gc \d+) (@[\d.]+s) (\d+%): ([^ ]+ ms clock), ([^ ]+ ms cpu), ([\d>-]+ MB), (\d+ MB goal), (\d+ MB stacks), (\d+ MB globals), (\d+ P)(.*)$/.exec(line)!;
  return [
    { t: m[1]!, f: "n" }, { t: " " }, { t: m[2]!, f: "at" }, { t: " " }, { t: m[3]!, f: "pct" }, { t: ": " }, { t: m[4]!, f: "clock" }, { t: ", " },
    { t: m[5]!, f: "cpu" }, { t: ", " }, { t: m[6]!, f: "heap" }, { t: ", " }, { t: m[7]!, f: "goal" }, { t: ", " }, { t: m[8]!, f: "stacks" }, { t: ", " },
    { t: m[9]!, f: "globals" }, { t: ", " }, { t: m[10]!, f: "procs" }, { t: m[11]! },
  ];
}

export function GcTraceDemo() {
  const [k, setK] = useState(6);
  const [field, setField] = useState<Field>("heap");
  const { l, tag } = LINES[k]!;
  const t = parseTrace(l);
  const prev = k > 0 && LINES[k - 1]!.tag === tag ? parseTrace(LINES[k - 1]!.l) : null;
  return (
    <Demo title="Read a real gctrace line" controls={<><IndexButtons k={k} n={LINES.length} set={setK} /><IndexSlider k={k} n={LINES.length} set={setK} label="Line" /></>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{tag}, go1.25.6, darwin/arm64. Click a field.</div>
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.7, border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", background: "var(--subtle)" }}>
        {tokens(l).map((x, i) => x.f
          ? <span key={i} onClick={() => setField(x.f!)} style={{ whiteSpace: "nowrap", cursor: "pointer", borderRadius: 3, padding: "1px 2px", background: field === x.f ? tint("var(--c1)", 30) : undefined, boxShadow: field === x.f ? "inset 0 -2px 0 var(--c1)" : "inset 0 -1px 0 var(--border)" }}>{x.t}</span>
          : <span key={i}>{x.t}</span>)}
      </div>
      <Banner tone="info" label={field}>{FIELD_TEXT[field]}</Banner>
      <MiniTable
        head={["phase", "wall clock", "CPU"]}
        rows={[
          ["STW sweep termination", `${t.clock[0]} ms`, `${t.cpu.stw1} ms`],
          ["concurrent mark: assist / background / idle", `${t.clock[1]} ms`, `${t.cpu.assist} / ${t.cpu.background} / ${t.cpu.idle} ms`],
          ["STW mark termination", `${t.clock[2]} ms`, `${t.cpu.stw2} ms`],
        ]}
      />
      <Stats items={[
        { label: "heap at start → end → live", value: `${t.heap[0]} → ${t.heap[1]} → ${t.heap[2]} MiB` },
        { label: "goal", value: `${t.goal} MiB` },
        { label: "previous line's live heap", value: prev ? `${prev.heap[2]} MiB` : "—" },
        { label: "stop-the-world total", value: `${fixed(t.clock[0] + t.clock[2], 3)} ms` },
      ]} />
      <SectionLabel>The program</SectionLabel>
      <GcCode lines={GCTRACE.program} maxHeight={150} />
    </Demo>
  );
}
