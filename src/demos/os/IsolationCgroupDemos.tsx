/** Demos for "cgroups": cpu.max throttling and p99 latency, the cpu.weight tree, and the memory limits. */
import { useMemo, useRef, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleY, Dots, Stats, range, toggle, useParams, Banner, Note, Panel, mono, seg } from "../../kit";
import {
  CPU_WEIGHT, EXAMPLE_TREE, LATENCY_WORKLOAD, Memcg, levelSums, simulateBandwidth, simulateLatency, throttleStall, weightShares, type CgNode, type MemEvent,
} from "../../sims/os/isolation";
import { Gantt } from "./SchedulingGantt";
import { twoCol } from "./IsolationUi";

// ---------------- cpu.max ----------------

const QUOTAS = [0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 2, 3, 4];

export function IsolationCpuMaxDemo() {
  const P = useParams("iso-cpumax", {
    quota: range({ label: "Quota in CPUs (quota / period)", min: 0.1, max: 4, step: 0.05, default: 1, format: (v) => v.toFixed(2) }),
    threads: range({ label: "Busy threads", min: 1, max: 16, step: 1, default: 8 }),
    period: seg<string>("Period", [["10", "10 ms"], ["50", "50 ms"], ["100", "100 ms"], ["200", "200 ms"]], "100"),
    burst: range({ label: "cpu.max.burst", min: 0, max: 200, step: 10, default: 0, format: (v) => `${v} ms` }),
  });
  const { quota, threads, burst } = P.values;
  const period = Number(P.values.period);
  const quotaMs = quota * period;
  const sim = useMemo(() => simulateBandwidth({ quotaMs, periodMs: period, threads, burstMs: burst, horizonMs: period * 3, dtMs: period / 1000 }), [quotaMs, period, threads, burst]);
  const closed = throttleStall(quotaMs, period, threads);
  const rows = sim.rows.map((segs, i) => ({
    label: `T${i}`,
    segs: segs.map((s) => ({ start: s.start, end: s.end, color: s.state === "run" ? "var(--c3)" : "var(--c4)", faint: s.state === "throttled" })),
  }));
  const curves = useMemo(() => {
    const base = { ...LATENCY_WORKLOAD, periodMs: period, burstMs: burst };
    const line = (t: number) => QUOTAS.map((c) => [c, simulateLatency({ ...base, threads: t, quotaMs: c * period }).p99] as [number, number]);
    return {
      many: line(threads), one: line(1),
      freeMany: simulateLatency({ ...base, threads, quotaMs: null }).p99,
      mean: simulateLatency({ ...base, threads, quotaMs: null }).meanCpus,
    };
  }, [threads, period, burst]);
  const hereQ = Math.max(QUOTAS[0]!, Math.min(4, quota));
  const here = useMemo(() => simulateLatency({ ...LATENCY_WORKLOAD, periodMs: period, burstMs: burst, threads, quotaMs: hereQ * period }).p99, [hereQ, threads, period, burst]);
  const yMax = 2000;
  return (
    <Demo title="cpu.max: a timeline of throttling, and what it does to p99" controls={<>
      <Param spec={P.schema.quota} value={quota} onChange={(v) => P.set("quota", v as number)} />
      <Param spec={P.schema.threads} value={threads} onChange={(v) => P.set("threads", v as number)} />
      <Param spec={P.schema.burst} value={burst} onChange={(v) => P.set("burst", v as number)} />
      <Param spec={P.schema.period} value={P.values.period} onChange={(v) => P.set("period", v as string)} />
    </>}>
      <div style={{ ...mono, fontSize: 12.5, marginBottom: 6 }}>cpu.max = "{Math.round(quotaMs * 1000)} {period * 1000}"</div>
      <Gantt rows={rows} end={period * 3} rowH={Math.max(5, Math.min(14, 120 / threads))} labelW={30} rules={[period, period * 2].map((t) => ({ t, color: "var(--fg)" }))} />
      <Legend items={[{ label: "running", color: "var(--c3)" }, { label: "throttled", color: "var(--c4)" }, { label: "pool refill", color: "var(--fg)" }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "run, then stall, per period (quota / N)", value: `${closed.burnMs.toFixed(1)} + ${closed.stallMs.toFixed(1)} ms` },
          { label: "nr_periods", value: sim.nrPeriods },
          { label: "nr_throttled", value: sim.nrThrottled },
          { label: "throttled time, summed over threads", value: `${Math.round(sim.throttledMs)} ms` },
        ]} />
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
          A service: {LATENCY_WORKLOAD.rps} requests per second, {LATENCY_WORKLOAD.requestCpuMs} ms of CPU each, {curves.mean.toFixed(2)} CPUs on average. p99 latency against quota.
        </div>
        <Plot x={[0.4, 4]} y={[1, yMax]} logY height={240} xLabel="quota (CPUs)" yLabel="p99 latency (ms)" yTicks={[1, 10, 100, 1000]} xTicks={[0.5, 1, 2, 3, 4]} xFormat={(v) => String(v)} yFormat={(v) => String(v)}>
          <RuleY at={curves.freeMany} label="no limit" />
          <Line points={curves.one} color="var(--c1)" />
          <Line points={curves.many} color="var(--c4)" />
          <Dots points={[[hereQ, here]]} color="var(--c4)" r={5} />
        </Plot>
        <Legend items={[{ label: `${threads} threads`, color: "var(--c4)" }, { label: "1 thread", color: "var(--c1)" }]} />
        <Note>The timeline uses threads that are always busy. The curve uses a request queue on a pool of threads, so one request runs on all threads at once. Model: Poisson arrivals with a fixed seed, and no per-CPU slices.</Note>
      </div>
    </Demo>
  );
}

// ---------------- cpu.weight tree ----------------

const clone = (n: CgNode): CgNode => ({ ...n, children: n.children?.map(clone) });
const findNode = (root: CgNode, path: string): CgNode | null => {
  const parts = path.split("/").filter(Boolean);
  let cur: CgNode | undefined = root;
  for (const p of parts) cur = cur?.children?.find((c) => c.name === p);
  return cur ?? null;
};
const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];
const toSlider = (w: number) => Math.log(w) / Math.log(CPU_WEIGHT.max);
const fromSlider = (x: number) => Math.max(CPU_WEIGHT.min, Math.min(CPU_WEIGHT.max, Math.round(CPU_WEIGHT.max ** x)));

export function IsolationWeightTreeDemo() {
  const [tree, setTree] = useState<CgNode>(() => clone(EXAMPLE_TREE));
  const seq = useRef(1);
  const rows = weightShares(tree);
  const sums = levelSums(tree);
  const edit = (path: string, f: (n: CgNode) => void) => setTree((t) => { const c = clone(t); const n = findNode(c, path); if (n) f(n); return c; });
  const remove = (path: string) => setTree((t) => {
    const c = clone(t);
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const p = findNode(c, parentPath)!;
    const name = path.slice(path.lastIndexOf("/") + 1);
    p.children = p.children!.filter((x) => x.name !== name);
    if (p.children.length === 0) delete p.children;
    return c;
  });
  const leaves = rows.filter((r) => !findNode(tree, r.path)?.children?.length && r.global > 0);
  return (
    <Demo title="cpu.weight: each group's share of the machine" actions={<button className="btn ghost" onClick={() => setTree(clone(EXAMPLE_TREE))}>Reset</button>}>
      <div style={{ display: "grid", gap: 2 }}>
        {rows.map((r) => {
          const n = findNode(tree, r.path)!;
          const isLeaf = !n.children?.length;
          const isRoot = r.depth === 0;
          return (
            <div key={r.path} style={{ paddingLeft: r.depth * 12, borderTop: "1px solid var(--border)", padding: `5px 0 5px ${r.depth * 12}px`, opacity: r.idle && !isRoot ? 0.5 : 1 }}>
              <div className="row" style={{ justifyContent: "space-between", gap: 6, fontSize: 12.5 }}>
                <span className="row" style={{ gap: 4 }}>
                  <span style={{ ...mono, fontWeight: 550 }}>{r.name}{isRoot ? "" : "/"}</span>
                  <button className="btn ghost" style={{ padding: "0 5px", fontSize: 11.5 }} aria-label={`add a child to ${r.path}`} onClick={() => edit(r.path, (x) => { x.children = [...(x.children ?? []), { name: `g${seq.current++}`, weight: CPU_WEIGHT.def }]; delete x.idle; })}>+ child</button>
                </span>
                <span className="row" style={{ gap: 8 }}>
                  {!isRoot && <span style={mono}>{(r.local * 100).toFixed(1)}% <span className="muted">of parent</span></span>}
                  <b style={mono}>{(r.global * 100).toFixed(1)}%</b>
                </span>
              </div>
              {!isRoot && (
                <div className="row" style={{ gap: 6, fontSize: 12, marginTop: 2 }}>
                  <span className="muted" style={{ ...mono, minWidth: 92 }}>weight {r.weight}</span>
                  <input type="range" aria-label={`cpu.weight of ${r.path}`} min={0} max={1} step={0.005} value={toSlider(r.weight)} style={{ flex: 1, minWidth: 70 }} onChange={(e) => { const w = fromSlider(Number(e.target.value)); edit(r.path, (x) => { x.weight = w; }); }} />
                  {isLeaf && <label className="row" style={{ gap: 3 }}><input type="checkbox" checked={!!n.idle} onChange={() => edit(r.path, (x) => { x.idle = !x.idle; })} />idle</label>}
                  <button className="btn ghost" style={{ padding: "0 6px", fontSize: 12 }} aria-label={`remove ${r.path}`} onClick={() => remove(r.path)}>remove</button>
                </div>
              )}
              <div style={{ height: 5, marginTop: 3, background: "var(--subtle)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${r.global * 100}%`, height: "100%", background: "var(--c1)", transition: "width .2s" }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", height: 22, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
          {leaves.map((l, i) => <div key={l.path} title={`${l.path}: ${(l.global * 100).toFixed(1)}%`} style={{ width: `${l.global * 100}%`, background: COLORS[i % COLORS.length], transition: "width .2s" }} />)}
        </div>
        <Legend items={leaves.map((l, i) => ({ label: `${l.path} ${(l.global * 100).toFixed(1)}%`, color: COLORS[i % COLORS.length]! }))} />
        <Note>Checks: the sibling shares under each parent sum to {sums.length && sums.every((s) => Math.abs(s - 1) < 1e-9) ? "100%" : "something else"} at all {sums.length} level(s). Shares apply only when the CPU is busy. An idle group gives up its share.</Note>
      </div>
    </Demo>
  );
}

// ---------------- memory limits ----------------

const SCALE = 1024;
const EV_COLOR: Record<MemEvent["kind"], string> = { alloc: "var(--muted)", free: "var(--muted)", reclaim: "var(--c1)", swap: "var(--c5)", high: "var(--c2)", throttle: "var(--c2)", max: "var(--c4)", oom: "var(--c4)", low: "var(--c3)" };

export function IsolationMemcgDemo() {
  const P = useParams("iso-memcg", {
    max: range({ label: "memory.max", min: 200, max: 1024, step: 8, default: 800, format: (v) => `${v} MiB` }),
    high: range({ label: "memory.high", min: 100, max: 1024, step: 8, default: 600, format: (v) => `${v} MiB` }),
    low: range({ label: "memory.low", min: 0, max: 512, step: 8, default: 128, format: (v) => `${v} MiB` }),
    swap: range({ label: "memory.swap.max", min: 0, max: 512, step: 32, default: 0, format: (v) => `${v} MiB` }),
    group: toggle({ label: "memory.oom.group = 1", default: false }),
  });
  const v = P.values;
  const make = () => new Memcg({ maxMiB: v.max, highMiB: v.high, lowMiB: v.low, swapMaxMiB: v.swap, oomGroup: v.group });
  const ref = useRef<Memcg | null>(null);
  if (!ref.current) ref.current = make();
  const m = ref.current;
  m.cfg = { maxMiB: v.max, highMiB: v.high, lowMiB: v.low, swapMaxMiB: v.swap, oomGroup: v.group };
  const [, force] = useState(0);
  const act = (f: (m: Memcg) => void) => { f(m); force((x) => x + 1); };
  const app = m.procs[0]!, side = m.procs[1]!;
  const seg2 = [
    { label: "app", value: app.anon, color: "var(--c1)" },
    { label: "sidecar", value: side.anon, color: "var(--c5)" },
    { label: "page cache", value: m.file, color: "var(--c3)" },
  ];
  const pct = (x: number) => `${(x / SCALE) * 100}%`;
  const marker = (at: number, label: string, color: string, top: number) => (
    <div key={label} style={{ position: "absolute", left: pct(at), top: 0, bottom: 0, width: 0, borderLeft: `2px solid ${color}` }}>
      <span style={{ position: "absolute", top: top - 2, left: at > SCALE * 0.72 ? undefined : 3, right: at > SCALE * 0.72 ? 3 : undefined, fontSize: 10.5, color, whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
  return (
    <Demo title="A memory cgroup at its limits" actions={<button className="btn ghost" onClick={() => { ref.current = make(); force((x) => x + 1); }}>Reset</button>} controls={<>
      <Param spec={P.schema.max} value={v.max} onChange={(x) => P.set("max", x as number)} />
      <Param spec={P.schema.high} value={v.high} onChange={(x) => P.set("high", x as number)} />
      <Param spec={P.schema.low} value={v.low} onChange={(x) => P.set("low", x as number)} />
      <Param spec={P.schema.swap} value={v.swap} onChange={(x) => P.set("swap", x as number)} />
      <Param spec={P.schema.group} value={v.group} onChange={(x) => P.set("group", x as boolean)} />
    </>}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn primary" disabled={!app.alive} onClick={() => act((c) => c.allocAnon("app", 100))}>app: touch 100 MiB</button>
        <button className="btn" onClick={() => act((c) => c.readFile(100))}>read a 100 MiB file</button>
        <button className="btn" disabled={!app.alive} onClick={() => act((c) => c.free("app", 100))}>app: free 100 MiB</button>
        <button className="btn" onClick={() => act((c) => c.outsidePressure(100))}>outside pressure</button>
        {!app.alive && <button className="btn" onClick={() => act((c) => c.restart("app"))}>restart app</button>}
      </div>
      <div style={{ position: "relative", height: 64 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 22, height: 26, display: "flex", background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden" }}>
          {seg2.map((s) => <div key={s.label} style={{ width: pct(s.value), background: s.color, transition: "width .25s" }} />)}
        </div>
        {marker(v.low, "low", "var(--c3)", 12)}
        {marker(v.high, "high", "var(--c2)", 0)}
        {marker(v.max, "max", "var(--c4)", 12)}
      </div>
      <Legend items={[...seg2.map((s) => ({ label: `${s.label} ${s.value} MiB`, color: s.color })), ...(m.swap ? [{ label: `swap ${m.swap} MiB`, color: "var(--faint)" }] : [])]} />
      <div style={{ ...twoCol, marginTop: 8 }}>
        <Panel title="memory.events and friends">
          <Stats items={[
            { label: "memory.current", value: `${m.current} MiB` },
            { label: "high", value: m.counters.high },
            { label: "max", value: m.counters.max },
            { label: "oom_kill", value: m.counters.oomKill },
            { label: "low", value: m.counters.low },
          ]} />
          <div style={{ marginTop: 8 }}>
            <Stats items={[{ label: "reclaimed in total", value: `${m.reclaimedMiB} MiB` }, { label: "sleep from memory.high (model)", value: `${(m.stallMs / 1000).toFixed(1)} s` }]} />
          </div>
        </Panel>
        <Panel title="What the kernel did">
          <div style={{ fontSize: 12.5, lineHeight: 1.45, maxHeight: 150, overflowY: "auto" }}>
            {m.events.length === 0 && <span className="muted">Nothing yet. sidecar holds 40 MiB.</span>}
            {m.events.slice(-6).map((e, i) => <div key={i} style={{ color: EV_COLOR[e.kind] }}>{e.text}</div>)}
          </div>
        </Panel>
      </div>
      {!app.alive && <Banner tone="bad">The app is dead. The container runtime reports OOMKilled, and the node may still have free memory.</Banner>}
    </Demo>
  );
}
