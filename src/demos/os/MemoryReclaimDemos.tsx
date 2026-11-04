/** Demos for /os/memory/swapping-and-the-oom-killer. */
import { useMemo, useState } from "react";
import { Demo, Stats, Param, Plot, Area, RuleX, Legend, SimButtons, range, toggle, useParams, useSim, usePlot, pct, bytes } from "../../kit";
import {
  runPressure, PHASE_LABEL, PRESSURE_DEFAULTS, VM_DEFAULTS, oomBadness, oomScore, pickVictim, globalTotalPages, k8sOomScoreAdj,
  overcommitCheck, commitLimit, touchOutcome, type PressureFrame, type PressurePhase, type OomProc, type OvercommitMode,
} from "../../sims/os/memory";
import { seg, mono, Note, Caption, Meter } from "../db/StorageUi";

const PHASE_COLOR: Record<PressurePhase, string> = { ok: "var(--c3)", kswapd: "var(--c2)", direct: "var(--c4)", oom: "var(--c4)", recovered: "var(--muted)" };
const C = { anon: "var(--c1)", zpool: "var(--c5)", hot: "var(--c2)", cold: "var(--faint)", free: "var(--c3)" };

function Bar({ parts, total }: { parts: { label: string; value: number; color: string }[]; total: number }) {
  return (
    <div style={{ display: "flex", height: 26, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)", background: "var(--subtle)" }}>
      {parts.map((p) => <div key={p.label} title={`${p.label}: ${Math.round(p.value)} MiB`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
    </div>
  );
}

/** Free memory on a zoomed scale, with the three watermarks. */
function FreeGauge({ free, marks }: { free: number; marks: { min: number; low: number; high: number } }) {
  const top = marks.high * 1.5;
  const x = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  const tick = (v: number, label: string, align: "left" | "right" = "left") => (
    <div key={label} style={{ position: "absolute", left: x(v), top: 0, bottom: 0, borderLeft: "1px solid var(--fg)" }}>
      <span style={{ position: "absolute", top: 28, fontSize: 11, color: "var(--muted)", ...(align === "left" ? { left: 2 } : { right: 2 }), whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
  const color = free < marks.min * 1.02 ? "var(--c4)" : free < marks.low ? "var(--c2)" : "var(--c3)";
  return (
    <div style={{ position: "relative", height: 44, marginBottom: 4 }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 24, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: x(free), height: "100%", background: color }} />
      </div>
      {tick(marks.min, "min")}
      {tick(marks.low, "low")}
      {tick(marks.high, "high")}
    </div>
  );
}

function PhaseBand({ frames }: { frames: PressureFrame[] }) {
  const { x, h } = usePlot();
  const out: { a: number; b: number; ph: PressurePhase }[] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && last.ph === f.phase) last.b = f.t;
    else out.push({ a: f.t, b: f.t, ph: f.phase });
  }
  return <g>{out.map((s, i) => <rect key={i} x={x(s.a)} width={Math.max(1, x(s.b + 0.1) - x(s.a))} y={h - 6} height={6} fill={PHASE_COLOR[s.ph]} />)}</g>;
}

export function PressureDemo() {
  const p = useParams("press", {
    t: range({ label: "Time", min: 0, max: PRESSURE_DEFAULTS.durationS, step: 0.1, default: 0, format: (x) => `${x.toFixed(1)} s` }),
    sw: range({ label: "vm.swappiness", min: 0, max: VM_DEFAULTS.swappinessMax, step: 10, default: VM_DEFAULTS.swappiness }),
    growth: range({ label: "Workload growth (MiB/s)", min: 100, max: 1600, step: 100, default: PRESSURE_DEFAULTS.growthMiBps }),
    swap: seg("Swap", [["0", "None"], ["2048", "2 GiB"], ["8192", "8 GiB"]], "2048"),
    z: toggle({ label: "zswap (compress before swap)", default: false }),
  });
  const v = p.values;
  const run = useMemo(() => runPressure({ swappiness: v.sw, growthMiBps: v.growth, swapMiB: Number(v.swap), zswap: v.z }), [v.sw, v.growth, v.swap, v.z]);
  const i = Math.min(run.frames.length - 1, Math.round(v.t / 0.1));
  const f = run.frames[i]!;
  const total = PRESSURE_DEFAULTS.ramMiB;
  const sim = useSim({
    dt: 0.1,
    speed: 3,
    step: () => p.set("t", Math.min(PRESSURE_DEFAULTS.durationS, Math.round((v.t + 0.1) * 10) / 10)),
    reset: () => p.set("t", 0),
  });
  const thin = useMemo(() => run.frames.filter((_, k) => k % 4 === 0), [run]);
  const stack = (g: (x: PressureFrame) => number) => thin.map((x) => [x.t, g(x)] as const);
  const event = (label: string, at: number | null) => ({ label, value: at === null ? "never" : `${at.toFixed(1)} s` });
  return (
    <Demo title="8 GiB of RAM under a growing workload" actions={<SimButtons sim={sim} />} controls={<>
      <Param spec={p.schema.t} value={v.t} onChange={(x) => p.set("t", x as number)} />
      <Param spec={p.schema.sw} value={v.sw} onChange={(x) => p.set("sw", x as number)} />
      <Param spec={p.schema.growth} value={v.growth} onChange={(x) => p.set("growth", x as number)} />
      <Param spec={p.schema.swap} value={v.swap} onChange={(x) => p.set("swap", x as string)} />
      <Param spec={p.schema.z} value={v.z} onChange={(x) => p.set("z", x as boolean)} />
    </>}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: PHASE_COLOR[f.phase], marginBottom: 6 }}>{PHASE_LABEL[f.phase]}</div>
      <Caption>RAM at {f.t.toFixed(1)} s</Caption>
      <Bar total={total} parts={[
        { label: "anonymous", value: f.anon, color: C.anon },
        { label: "zswap pool", value: f.zpool, color: C.zpool },
        { label: "hot file cache", value: f.fileHot, color: C.hot },
        { label: "cold file cache", value: f.fileCold, color: C.cold },
        { label: "free", value: f.free, color: C.free },
      ]} />
      <div style={{ margin: "4px 0 8px" }}><Legend box items={[{ label: `anonymous ${Math.round(f.anon)}`, color: C.anon }, ...(v.z ? [{ label: `zswap pool ${Math.round(f.zpool)}`, color: C.zpool }] : []), { label: `hot file ${Math.round(f.fileHot)}`, color: C.hot }, { label: `cold file ${Math.round(f.fileCold)}`, color: C.cold }, { label: `free ${Math.round(f.free)} MiB`, color: C.free }]} /></div>
      <Caption>Free memory, zoomed. Watermarks in MiB: min {Math.round(run.marks.min)}, low {Math.round(run.marks.low)}, high {Math.round(run.marks.high)}. kswapd is {f.kswapd ? "awake" : "asleep"}.</Caption>
      <FreeGauge free={f.free} marks={run.marks} />
      <Meter label={`Swap used of ${bytes(Number(v.swap) * 2 ** 20) === "0 B" ? "no swap" : bytes(Number(v.swap) * 2 ** 20)}`} value={f.swapUsed} max={Math.max(1, Number(v.swap))} color="var(--c5)" text={`${Math.round(f.swapUsed)} MiB`} />
      <Meter label="Stall, averaged like PSI some avg10" value={f.psi} max={1} color="var(--c4)" text={pct(f.psi, 0)} />
      <div style={{ marginTop: 6 }}>
        <Plot x={[0, PRESSURE_DEFAULTS.durationS]} y={[0, total]} height={170} xLabel="seconds" yLabel="MiB" xTicks={[0, 10, 20, 30, 40]} yTicks={[0, 4096, 8192]}>
          <Area points={stack((x) => x.anon + x.zpool + x.fileHot + x.fileCold + x.free)} color={C.free} opacity={0.5} />
          <Area points={stack((x) => x.anon + x.zpool + x.fileHot + x.fileCold)} color={C.cold} opacity={0.75} />
          <Area points={stack((x) => x.anon + x.zpool + x.fileHot)} color={C.hot} opacity={0.75} />
          <Area points={stack((x) => x.anon + x.zpool)} color={C.anon} opacity={0.75} />
          <PhaseBand frames={run.frames} />
          <RuleX at={v.t} color="var(--fg)" />
        </Plot>
      </div>
      <Stats items={[
        event("kswapd first wakes", run.firstKswapd),
        event("first direct reclaim", run.firstDirect),
        event("OOM kill", run.oomAt),
        { label: "swapped out", value: `${Math.round(run.totals.swapOutMiB)} MiB` },
        { label: "file refaults", value: `${Math.round(run.totals.refaultMiB)} MiB` },
        { label: "peak stall", value: pct(run.peakPsi, 0) },
      ]} />
      <Note>The band under the plot shows the phase. This model widens the watermarks (watermark_scale_factor = {PRESSURE_DEFAULTS.scaleFactor}, min = {PRESSURE_DEFAULTS.minMiB} MiB) so that you can see them. All throughputs are model inputs.</Note>
    </Demo>
  );
}

// ---------------- overcommit ----------------

export function OvercommitDemo() {
  const p = useParams("over", {
    req: range({ label: "mmap request", min: 1, max: 40, step: 1, default: 24, format: (x) => `${x} GiB` }),
    used: range({ label: "Already committed (Committed_AS)", min: 0, max: 20, step: 1, default: 2, format: (x) => `${x} GiB` }),
    touch: range({ label: "Share of the request that the program touches", min: 0, max: 100, step: 5, default: 100, format: (x) => `${x}%` }),
    mode: seg("vm.overcommit_memory", [["0", "0 heuristic"], ["1", "1 always"], ["2", "2 never"]], "0"),
    ratio: range({ label: "vm.overcommit_ratio", min: 0, max: 100, step: 10, default: VM_DEFAULTS.overcommitRatio, format: (x) => `${x}%` }),
  });
  const v = p.values;
  const ram = 16, swap = 4;
  const mode = Number(v.mode) as OvercommitMode;
  const res = overcommitCheck(mode, v.req, v.used, ram, swap, v.ratio);
  const limit = commitLimit(ram, swap, v.ratio);
  const touched = v.used + (v.req * v.touch) / 100;
  const out = touchOutcome(touched, ram, swap);
  const scale = 60;
  const mark = (at: number, label: string, top: number) => (
    <div key={label} style={{ position: "absolute", left: `${(at / scale) * 100}%`, top: 0, bottom: 0, borderLeft: "1px dashed var(--fg)" }}>
      <span style={{ position: "absolute", top, left: 3, fontSize: 11, whiteSpace: "nowrap", color: "var(--muted)" }}>{label}</span>
    </div>
  );
  return (
    <Demo title="A 16 GiB machine with 4 GiB of swap: will the request pass?" controls={<>
      <Param spec={p.schema.req} value={v.req} onChange={(x) => p.set("req", x as number)} />
      <Param spec={p.schema.used} value={v.used} onChange={(x) => p.set("used", x as number)} />
      <Param spec={p.schema.touch} value={v.touch} onChange={(x) => p.set("touch", x as number)} />
      <Param spec={p.schema.mode} value={v.mode} onChange={(x) => p.set("mode", x as string)} />
      {mode === 2 && <Param spec={p.schema.ratio} value={v.ratio} onChange={(x) => p.set("ratio", x as number)} />}
    </>}>
      <div style={{ position: "relative", height: 70, marginBottom: 6 }}>
        <div style={{ position: "absolute", top: 34, left: 0, right: 0, height: 22, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden", display: "flex" }}>
          <div style={{ width: `${(v.used / scale) * 100}%`, background: "var(--faint)" }} />
          <div style={{ width: `${(v.req / scale) * 100}%`, background: res.ok ? "var(--c1)" : "var(--c4)" }} />
        </div>
        {mark(ram, "RAM", 0)}
        {mark(ram + swap, "RAM + swap", 16)}
        {mode === 2 && mark(limit, "CommitLimit", 0)}
      </div>
      <p style={{ fontSize: 13.5, margin: "6px 0", fontWeight: 600, color: res.ok ? "var(--c3)" : "var(--c4)" }}>
        {res.ok ? "mmap returns a pointer." : "mmap fails with ENOMEM."}
      </p>
      <p style={{ fontSize: 13, margin: "4px 0" }}>{res.why}</p>
      {res.ok && (
        <p style={{ fontSize: 13, margin: "4px 0", color: out === "oom" ? "var(--c4)" : out === "swap" ? "var(--c2)" : "var(--c3)" }}>
          Then the program touches {v.touch}% of it, so memory in use reaches {touched.toFixed(1)} GiB. {out === "oom" ? "That is more than RAM + swap: the OOM killer runs." : out === "swap" ? "That is more than RAM: pages go to swap." : "That fits in RAM."}
        </p>
      )}
      {!res.ok && <p style={{ fontSize: 13, margin: "4px 0" }}>The failure is a clean error at the system call. The program can handle it.</p>}
      <Stats items={[{ label: "CommitLimit (only mode 2 uses it)", value: `${limit} GiB` }, { label: "RAM + swap", value: `${ram + swap} GiB` }]} />
    </Demo>
  );
}

// ---------------- OOM victim picker ----------------

const GiB = 262144; // pages of 4 KiB
const NODE_RAM = 16 * GiB;
const POD_LIMIT = 4 * GiB;

interface Row extends OomProc { pod?: boolean; note: string }

const START: Row[] = [
  { name: "postgres", rssPages: 8 * GiB, swapPages: 0, pgtablePages: 8192, adj: -900, note: "database, protected" },
  { name: "java (pod)", rssPages: 3.5 * GiB, swapPages: 0, pgtablePages: 3000, adj: 0, pod: true, note: "main process in a pod" },
  { name: "sidecar (pod)", rssPages: 0.25 * GiB, swapPages: 0, pgtablePages: 200, adj: 0, pod: true, note: "same pod" },
  { name: "batch job", rssPages: 2 * GiB, swapPages: 0, pgtablePages: 1000, adj: 500, note: "preferred victim" },
  { name: "sshd", rssPages: 0.01 * GiB, swapPages: 0, pgtablePages: 20, adj: -1000, note: "never killed" },
];

export function OomPickerDemo() {
  const [rows, setRows] = useState<Row[]>(START);
  const [killed, setKilled] = useState<string[]>([]);
  const p = useParams("oompick", { scope: seg("OOM scope", [["node", "Whole node"], ["pod", "Pod at its 4 GiB limit"]], "node") });
  const scope = p.values.scope;
  const live = rows.filter((r) => !killed.includes(r.name) && (scope === "node" || r.pod));
  const total = scope === "node" ? globalTotalPages(NODE_RAM, 0) : POD_LIMIT;
  const victim = live[pickVictim(live, total)];
  const setAdj = (name: string, adj: number) => setRows((rs) => rs.map((r) => (r.name === name ? { ...r, adj } : r)));
  return (
    <Demo
      title="Which process does the OOM killer choose?"
      actions={<>
        <button className="btn" disabled={!victim} onClick={() => victim && setKilled([...killed, victim.name])}>Kill the victim</button>
        <button className="btn ghost" onClick={() => { setRows(START); setKilled([]); }}>Reset</button>
      </>}
      controls={<Param spec={p.schema.scope} value={scope} onChange={(x) => p.set("scope", x as string)} />}
    >
      <Caption>Total pages for scoring: {total.toLocaleString("en-US")} ({scope === "node" ? "RAM + swap" : "the memory cgroup limit"}). Each row is one process. Drag oom_score_adj.</Caption>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r) => {
          const out = !live.includes(r);
          const b = oomBadness(r, total);
          const score = oomScore(r, total);
          const isV = victim?.name === r.name;
          return (
            <div key={r.name} style={{ border: `1px solid ${isV ? "var(--c4)" : "var(--border)"}`, borderRadius: 6, padding: "6px 8px", opacity: out ? 0.45 : 1, background: isV ? "var(--subtle)" : "transparent" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
                <span><b>{r.name}</b> <span className="muted" style={{ fontSize: 12 }}>{r.note}</span></span>
                <span style={{ ...mono, color: isV ? "var(--c4)" : "var(--fg)", fontWeight: isV ? 700 : 400 }}>
                  {killed.includes(r.name) ? "killed" : out ? "outside this cgroup" : <>oom_score {score}{isV ? " · victim" : ""}</>}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, flexWrap: "wrap" }}>
                <span className="muted" style={{ ...mono, flex: "0 0 auto" }}>RSS {bytes(r.rssPages * 4096)}</span>
                <input aria-label={`oom_score_adj of ${r.name}`} type="range" min={-1000} max={1000} step={50} value={r.adj} onChange={(e) => setAdj(r.name, Number(e.target.value))} style={{ flex: "1 1 120px", minWidth: 90 }} />
                <span style={{ ...mono, width: 76, textAlign: "right" }}>adj {r.adj}</span>
              </div>
              <div className="muted" style={{ ...mono, fontSize: 11.5 }}>badness {b === null ? "never" : b.toLocaleString("en-US")} pages</div>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 13, margin: "10px 0 0" }}>{victim ? <>The kernel sends SIGKILL to <b>{victim.name}</b>.</> : "No process can be killed. The kernel panics if this is a node OOM."}</p>
      <Caption><span style={{ display: "block", marginTop: 8 }}>Kubelet values on this 16 GiB node: Guaranteed {k8sOomScoreAdj("guaranteed")}, BestEffort {k8sOomScoreAdj("besteffort")}, Burstable with a 1 GiB request {k8sOomScoreAdj("burstable", 2 ** 30, 16 * 2 ** 30)}.</span></Caption>
    </Demo>
  );
}
