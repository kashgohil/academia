/** Demos for /os/memory/page-replacement. */
import { useMemo } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, RuleY, Dots, Legend, SimButtons, range, toggle, useParams, useSim, pct } from "../../kit";
import {
  simulate, countFaults, faultCurve, workload, workingSetSeries, phaseString, thrashCurve, thrashPeak, THRASH_DEFAULTS, THRASH_LOCALITY,
  BELADY_STRING, TEXTBOOK_STRING, LOOP_STRING, randomString, CURVE_FRAMES, REPL_LABEL, WORKLOAD_LABEL, WORKLOAD_NOTE,
  type ReplPolicy, type ReplStep, type WorkloadId,
} from "../../sims/os/memory";
import { seg, mono, Note, Caption, useChunked } from "../db/StorageUi";

const STRINGS: Record<string, { label: string; refs: readonly number[] }> = {
  textbook: { label: "Textbook", refs: TEXTBOOK_STRING },
  belady: { label: "Belady", refs: BELADY_STRING },
  loop: { label: "Loop", refs: LOOP_STRING },
  random: { label: "Random", refs: randomString(20, 6, 3) },
};

const POLICIES: ReplPolicy[] = ["min", "fifo", "lru", "clock"];

function PolicyGrid({ steps, upto, frames, policy, faultsAlt }: { steps: ReplStep[]; upto: number; frames: number; policy: ReplPolicy; faultsAlt?: number }) {
  const n = steps.length;
  const cur = steps[Math.min(upto, n - 1)]!;
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <b>{REPL_LABEL[policy]}</b>
        <span style={mono}>{cur.faults} fault{cur.faults === 1 ? "" : "s"}{faultsAlt !== undefined ? ` (with ${frames + 1} frames: ${faultsAlt})` : ""}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gap: 1, ...mono, fontSize: 11 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ textAlign: "center", fontWeight: i === upto ? 700 : 400, color: i > upto ? "var(--faint)" : "var(--fg)" }}>{s.ref}</div>
        ))}
        {Array.from({ length: frames }, (_, f) => steps.map((s, i) => {
          const past = i <= upto;
          const page = past ? s.frames[f] : null;
          const touched = past && s.slot === f;
          const bg = touched ? (s.hit ? "var(--c3)" : "var(--c4)") : "var(--subtle)";
          return (
            <div key={`${f}-${i}`} style={{ height: 18, lineHeight: "18px", textAlign: "center", background: bg, color: touched ? "#fff" : "var(--muted)", outline: i === upto ? "1px solid var(--fg)" : undefined, outlineOffset: -1 }}>
              {page ?? ""}
            </div>
          );
        }))}
      </div>
      {policy === "clock" && cur.bits && (
        <div style={{ ...mono, fontSize: 11.5, marginTop: 4, color: "var(--muted)", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {cur.frames.map((p, f) => (
            <span key={f} style={{ color: cur.hand === f ? "var(--fg)" : undefined, fontWeight: cur.hand === f ? 700 : 400 }}>
              {cur.hand === f ? "hand→" : ""}{p ?? "–"}:{cur.bits![f]}
            </span>
          ))}
          <span>(page:accessed bit)</span>
        </div>
      )}
    </div>
  );
}

export function ReplacementStepperDemo() {
  const p = useParams("refstr", {
    step: range({ label: "Reference number", min: 1, max: 20, step: 1, default: 12 }),
    frames: range({ label: "Frames", min: 2, max: 6, step: 1, default: 3 }),
    str: seg("Reference string", Object.entries(STRINGS).map(([k, v]) => [k, v.label] as [string, string]), "textbook"),
  });
  const v = p.values;
  const refs = STRINGS[v.str]!.refs;
  const upto = Math.min(v.step, refs.length) - 1;
  const steps = useMemo(() => Object.fromEntries(POLICIES.map((q) => [q, simulate(q, refs, v.frames)])) as Record<ReplPolicy, ReplStep[]>, [refs, v.frames]);
  const sim = useSim({
    dt: 0.5,
    step: () => p.set("step", upto + 2 > refs.length ? 1 : upto + 2),
    reset: () => p.set("step", 1),
  });
  const table = useMemo(() => [1, 2, 3, 4, 5, 6, 7].map((m) => ({ m, f: POLICIES.map((q) => countFaults(q, refs, m)) })), [refs]);
  return (
    <Demo
      title="One reference string, four policies"
      actions={<>
        <SimButtons sim={sim} />
        <button className="btn" onClick={() => { p.set("str", "belady"); p.set("frames", 3); p.set("step", 12); }}>Belady's anomaly</button>
      </>}
      controls={<>
        <Param spec={{ ...p.schema.step, max: refs.length }} value={upto + 1} onChange={(x) => p.set("step", x as number)} />
        <Param spec={p.schema.frames} value={v.frames} onChange={(x) => p.set("frames", x as number)} />
        <Param spec={p.schema.str} value={v.str} onChange={(x) => { p.set("str", x as string); p.set("step", STRINGS[x as string]!.refs.length); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px 18px" }}>
        {POLICIES.map((q) => <PolicyGrid key={q} policy={q} steps={steps[q]} upto={upto} frames={v.frames} />)}
      </div>
      <div style={{ marginTop: 8 }}><Legend items={[{ label: "fault: page loaded here", color: "var(--c4)" }, { label: "hit", color: "var(--c3)" }]} box /></div>
      <Caption><span style={{ display: "block", marginTop: 10 }}>Faults over the whole string, by number of frames. A red number means more faults than with one frame less.</span></Caption>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%", ...mono }}>
          <thead>
            <tr style={{ color: "var(--muted)" }}>
              <th style={{ textAlign: "left", fontWeight: 400, padding: "2px 4px" }}>frames</th>
              {table.map((r) => <th key={r.m} style={{ fontWeight: r.m === v.frames ? 700 : 400, padding: "2px 4px", textAlign: "right" }}>{r.m}</th>)}
            </tr>
          </thead>
          <tbody>
            {POLICIES.map((q, qi) => (
              <tr key={q} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "2px 4px" }}>{REPL_LABEL[q]}</td>
                {table.map((r, ri) => {
                  const up = ri > 0 && r.f[qi]! > table[ri - 1]!.f[qi]!;
                  return <td key={r.m} style={{ padding: "2px 4px", textAlign: "right", color: up ? "var(--c4)" : "var(--fg)", fontWeight: up ? 700 : 400 }}>{r.f[qi]}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Demo>
  );
}

// ---------------- fault curves ----------------

const CURVE_POLICIES: ReplPolicy[] = ["min", "fifo", "lru", "clock", "twolist"];
const COLOR: Record<ReplPolicy, string> = { min: "var(--c3)", fifo: "var(--c4)", lru: "var(--c1)", clock: "var(--c2)", twolist: "var(--c5)" };

export function FaultCurveDemo() {
  const p = useParams("fcurve", {
    frames: range({ label: "Frames", min: 2, max: 96, step: 2, default: 32 }),
    wl: seg<WorkloadId>("Workload", (Object.keys(WORKLOAD_LABEL) as WorkloadId[]).map((k) => [k, WORKLOAD_LABEL[k]]), "phases"),
  });
  const v = p.values;
  const refs = useMemo(() => workload(v.wl), [v.wl]);
  const jobs = CURVE_POLICIES.map((q) => () => faultCurve(q, refs, CURVE_FRAMES));
  const res = useChunked(`curve:${v.wl}`, jobs);
  const now = useMemo(() => CURVE_POLICIES.map((q) => countFaults(q, refs, v.frames) / refs.length), [refs, v.frames]);
  return (
    <Demo title="Fault rate against memory size" controls={<>
      <Param spec={p.schema.frames} value={v.frames} onChange={(x) => p.set("frames", x as number)} />
      <Param spec={p.schema.wl} value={v.wl} onChange={(x) => p.set("wl", x as WorkloadId)} />
    </>}>
      <Caption>{WORKLOAD_NOTE[v.wl]} Each run has {refs.length.toLocaleString("en-US")} references.</Caption>
      <Plot x={[0, 96]} y={[0, 1]} height={240} xLabel="frames" yLabel="faults per reference" yFormat={(y) => `${Math.round(y * 100)}%`} xTicks={[0, 16, 32, 48, 64, 80, 96]}>
        {CURVE_POLICIES.map((q, i) => res[i] && <Line key={q} points={res[i]!} color={COLOR[q]} width={q === "min" ? 2.5 : 1.8} dash={q === "clock" ? "4 3" : undefined} />)}
        <RuleX at={v.frames} color="var(--fg)" />
      </Plot>
      <Legend items={CURVE_POLICIES.map((q) => ({ label: REPL_LABEL[q], color: COLOR[q] }))} />
      <Stats items={CURVE_POLICIES.map((q, i) => ({ label: REPL_LABEL[q], value: pct(now[i]!, 1) }))} />
    </Demo>
  );
}

// ---------------- working set ----------------

const WS_REFS = phaseString(6000, 24, 1500, 7);

export function WorkingSetDemo() {
  const p = useParams("wset", {
    tau: range({ label: "Window τ (references)", min: 10, max: 3000, log: true, default: 200, format: (x) => String(Math.round(x)) }),
  });
  const tau = Math.round(p.values.tau);
  const series = useMemo(() => workingSetSeries(WS_REFS, tau), [tau]);
  const pts = useMemo(() => series.filter((_, i) => i % 15 === 0).map((w, i) => [i * 15, w] as const), [series]);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const max = Math.max(...series);
  return (
    <Demo title="The working set of a program with phases" controls={<Param spec={p.schema.tau} value={p.values.tau} onChange={(x) => p.set("tau", x as number)} />}>
      <Plot x={[0, 6000]} y={[0, 100]} height={200} xLabel="references" yLabel="pages in W(t, τ)" xTicks={[0, 1500, 3000, 4500, 6000]}>
        <Line points={pts} color="var(--c1)" />
        <RuleY at={24} label="locality: 24 pages" />
        {[1500, 3000, 4500].map((x) => <RuleX key={x} at={x} />)}
      </Plot>
      <Stats items={[{ label: "mean working set", value: mean.toFixed(1) }, { label: "largest working set", value: max }]} />
      <Note>The dashed lines mark each move to a new set of pages.</Note>
    </Demo>
  );
}

// ---------------- thrashing ----------------

export function ThrashingDemo() {
  const p = useParams("thrash", {
    n: range({ label: "Processes (degree of multiprogramming)", min: 1, max: 40, step: 1, default: 8 }),
    frames: range({ label: "Physical frames", min: 64, max: 512, step: 8, default: THRASH_DEFAULTS.totalFrames }),
    fault: seg("Fault service time (model input)", [["100", "100 µs"], ["500", "500 µs"], ["2000", "2 ms"], ["8000", "8 ms"]], String(THRASH_DEFAULTS.faultUs)),
    io: range({ label: "File I/O wait per unit of CPU (model input)", min: 0, max: 6, step: 0.5, default: THRASH_DEFAULTS.ioRatio }),
    lc: toggle({ label: "Show load control", default: true }),
  });
  const v = p.values;
  const pts = useMemo(() => thrashCurve({ ...THRASH_DEFAULTS, totalFrames: v.frames, faultUs: Number(v.fault), ioRatio: v.io }), [v.frames, v.fault, v.io]);
  const cur = pts[v.n - 1]!;
  const peak = thrashPeak(pts);
  const need = THRASH_LOCALITY * v.n;
  return (
    <Demo title="Add processes until the machine stops working" controls={<>
      <Param spec={p.schema.n} value={v.n} onChange={(x) => p.set("n", x as number)} />
      <Param spec={p.schema.frames} value={v.frames} onChange={(x) => p.set("frames", x as number)} />
      <Param spec={p.schema.fault} value={v.fault} onChange={(x) => p.set("fault", x as string)} />
      <Param spec={p.schema.io} value={v.io} onChange={(x) => p.set("io", x as number)} />
      <Param spec={p.schema.lc} value={v.lc} onChange={(x) => p.set("lc", x as boolean)} />
    </>}>
      <Plot x={[1, 40]} y={[0, 1]} height={240} xLabel="processes" yLabel="utilization" yFormat={(y) => `${Math.round(y * 100)}%`} xTicks={[1, 10, 20, 30, 40]}>
        {v.lc && <Line points={pts.map((q) => [q.n, q.loadControlled] as const)} color="var(--c3)" dash="5 4" />}
        <Line points={pts.map((q) => [q.n, q.paging] as const)} color="var(--c4)" width={1.5} />
        <Line points={pts.map((q) => [q.n, q.cpu] as const)} color="var(--c1)" width={2.5} />
        <RuleX at={v.n} color="var(--fg)" />
        <Dots points={[[v.n, cur.cpu]]} color="var(--c1)" r={4} />
      </Plot>
      <Legend items={[{ label: "CPU", color: "var(--c1)" }, { label: "paging device", color: "var(--c4)" }, ...(v.lc ? [{ label: "CPU with load control", color: "var(--c3)" }] : [])]} />
      <Stats items={[
        { label: "CPU utilization", value: pct(cur.cpu, 1) },
        { label: "frames per process", value: cur.framesEach },
        { label: "faults per reference", value: pct(cur.faultRate, 1) },
        { label: "peak CPU", value: `${pct(peak.cpu, 1)} at ${peak.n}` },
        { label: "total locality / frames", value: `${need} / ${v.frames}` },
      ]} />
    </Demo>
  );
}
