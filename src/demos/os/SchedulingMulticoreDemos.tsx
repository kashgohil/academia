/** Demos for "Multiprocessor scheduling". */
import { useMemo, useRef } from "react";
import { Demo, Stats, Controls, Plot, Line, Legend, range, toggle, useParams, useSim, pct } from "../../kit";
import {
  BALANCE_SWEEP, COST_INPUTS, COST_WORKLOAD, DEMO_MC, Multicore, balancePoint, numaRemoteCost, resultOf,
  type McConfig, type QueueMode,
} from "../../sims/os/scheduling";
import { Caption, Note, seg, useChunked, mono } from "../db/StorageUi";
import { f1, jobColor } from "./SchedulingGantt";

// ------------------------------------------------------------------------------------------------
// N cores
// ------------------------------------------------------------------------------------------------

function Chip({ id, dark }: { id: number; dark?: boolean }) {
  return (
    <span style={{
      width: dark ? 22 : 12, height: dark ? 18 : 14, flex: "0 0 auto", borderRadius: 2, background: jobColor(id), display: "inline-block",
      outline: dark ? "2px solid var(--fg)" : "none", outlineOffset: 1,
    }} />
  );
}

export function MulticoreDemo() {
  const p = useParams("sched-mc", {
    cpus: range({ label: "CPUs", min: 2, max: 16, step: 2, default: 8 }),
    tasks: range({ label: "Tasks", min: 2, max: 48, step: 1, default: 16 }),
    interval: range({ label: "Balancer period", min: 1, max: 500, default: 16, log: true, format: (v) => `${Math.round(v)} ms` }),
    refill: range({ label: "Cache refill per migration (model input)", min: 0, max: 5, step: 0.25, default: 0.5, format: (v) => `${v} ms` }),
    queue: seg<QueueMode>("Queues", [["per-cpu", "One queue per CPU"], ["single", "One shared queue"]], "per-cpu"),
    balance: toggle({ label: "Periodic load balancer", default: false }),
    steal: toggle({ label: "Idle CPUs steal work", default: false }),
  });
  const v = p.values;
  const cfg: McConfig = useMemo(() => ({
    ...DEMO_MC, cpus: v.cpus, tasks: v.tasks, queue: v.queue as QueueMode, balanceInterval: v.balance ? Math.round(v.interval) : 0,
    steal: v.steal, cacheRefill: v.refill,
  }), [v.cpus, v.tasks, v.queue, v.balance, v.interval, v.steal, v.refill]);
  const mc = useRef<{ key: string; m: Multicore } | null>(null);
  const key = JSON.stringify(cfg);
  if (!mc.current || mc.current.key !== key) {
    // A change of the balancer or steal option keeps the machine running. Others start again.
    const shapeKey = `${cfg.cpus}/${cfg.tasks}/${cfg.queue}`;
    const old = mc.current;
    if (old && `${old.m.cfg.cpus}/${old.m.cfg.tasks}/${old.m.cfg.queue}` === shapeKey) {
      Object.assign(old.m.cfg, cfg);
      old.key = key;
    } else {
      mc.current = { key, m: new Multicore({ ...cfg }) };
    }
  }
  const m = mc.current!.m;
  const sim = useSim({
    step: () => m.tick(),
    reset: () => { mc.current = { key, m: new Multicore({ ...cfg }) }; },
    dt: 1 / 120,
  });
  const r = resultOf(m);
  const running = m.stats.time > 0;
  const maxQ = Math.max(1, ...m.cpus.map((c) => c.queue.length));
  return (
    <Demo
      title="Per-CPU queues, imbalance and a balancer"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn" onClick={() => { for (let i = 0; i < 499; i++) m.tick(); sim.step(); }}>Run 0.5 s</button><button className="btn" onClick={() => { m.pile(); sim.step(); }}>Pile all on CPU 0</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={<Controls params={p} />}
    >
      {v.queue === "single" && (
        <div style={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center", fontSize: 12, marginBottom: 6, minHeight: 18 }}>
          <span className="muted" style={{ marginRight: 6 }}>Shared queue</span>
          {m.global.map((t) => <Chip key={t.id} id={t.id} />)}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 3 }}>
        {m.cpus.map((c) => (
          <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 6, height: 22, overflow: "hidden" }}>
            <span className="muted" style={{ width: 54, flex: "0 0 auto", fontSize: 11.5, whiteSpace: "nowrap", ...mono }}>CPU {c.id}{c.node ? "'" : ""}</span>
            <span style={{ width: 26, flex: "0 0 auto", display: "inline-flex", justifyContent: "center" }}>{c.running ? <Chip id={c.running.id} dark /> : <span style={{ fontSize: 10.5, color: "var(--faint)" }}>idle</span>}</span>
            <span style={{ display: "flex", gap: 2, flex: 1, minWidth: 0, overflow: "hidden" }}>
              {c.queue.slice(0, 22).map((t) => <Chip key={t.id} id={t.id} />)}
              {c.queue.length > 22 && <span className="muted" style={{ fontSize: 11 }}>+{c.queue.length - 22}</span>}
            </span>
          </div>
        ))}
      </div>
      <Note>A large box is the task on the CPU. Small boxes wait in that CPU's queue. A prime mark means NUMA node 1. Longest queue now: {maxQ}.</Note>
      <Stats items={[
        { label: "simulated", value: `${(m.stats.time / 1000).toFixed(1)} s` },
        { label: "useful CPU", value: running ? pct(r.useful) : "–" },
        { label: "idle CPU", value: running ? pct(r.idle) : "–" },
        { label: "lost to migrations and locks", value: running ? pct(r.penalty) : "–" },
        { label: "bursts finished per s", value: running ? Math.round(r.throughput) : "–" },
        { label: "migrations per s", value: running ? Math.round(r.migrationsPerSec) : "–" },
        { label: "mean imbalance", value: running ? f1(r.meanImbalance) : "–" },
      ]} />
    </Demo>
  );
}

// ------------------------------------------------------------------------------------------------
// Cost of balancing
// ------------------------------------------------------------------------------------------------

export function MigrationCostDemo() {
  const p = useParams("sched-migcost", {
    refill: range({ label: "Cache refill per migration (model input)", min: 0, max: 5, step: 0.25, default: COST_INPUTS.refill, format: (v) => `${v} ms` }),
    remote: range({ label: "Time on a remote node before pages follow (model input)", min: 0, max: 30, step: 1, default: COST_INPUTS.remoteMs, format: (v) => `${v} ms` }),
    domains: toggle({ label: "Scheduling domains: cross nodes four times less often", default: false }),
  });
  const { refill, remote, domains } = p.values;
  const numa = numaRemoteCost(remote);
  const base: McConfig = { ...COST_WORKLOAD, domains };
  const key = `${refill}/${remote}/${domains}`;
  const cases: McConfig[] = [
    { ...base, cacheRefill: 0, numaPenalty: 0 },
    { ...base, cacheRefill: refill, numaPenalty: 0 },
    { ...base, cacheRefill: refill, numaPenalty: numa },
  ];
  const jobs = useMemo(() => cases.flatMap((c) => BALANCE_SWEEP.map((iv) => () => balancePoint(c, iv))), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked(key, jobs);
  const L = BALANCE_SWEEP.length;
  const curve = (i: number) => BALANCE_SWEEP.flatMap((iv, k) => {
    const r = res[i * L + k];
    return r ? [[iv, r.useful * 100] as [number, number]] : [];
  });
  const full = BALANCE_SWEEP.map((iv, k) => ({ iv, r: res[2 * L + k] }));
  const done = full.filter((x) => x.r);
  const best = done.length ? done.reduce((a, b) => (b.r!.useful > a.r!.useful ? b : a)) : null;
  const fastest = full[0]?.r;
  const ys = res.flatMap((r) => (r ? [r.useful * 100] : []));
  const yMin = ys.length ? Math.floor(Math.min(...ys) / 5) * 5 : 0;
  return (
    <Demo title="More balancing, or less?" controls={<Controls params={p} />}>
      <Caption>Useful CPU time, as a share of all CPU time. 8 CPUs on 2 nodes, 20 tasks. Each point is the mean of 3 runs.</Caption>
      <Plot x={[1, 1024]} y={[yMin, 100]} logX height={230} xLabel="balancer period (ms)" xTicks={[1, 4, 16, 64, 256, 1024]} xFormat={(v) => String(v)} yFormat={(v) => `${v}%`}>
        <Line points={curve(0)} color="var(--c3)" />
        <Line points={curve(1)} color="var(--c2)" />
        <Line points={curve(2)} color="var(--c4)" />
      </Plot>
      <Legend items={[{ label: "migration is free", color: "var(--c3)" }, { label: "cache refill", color: "var(--c2)" }, { label: "cache refill and NUMA", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "NUMA penalty, from numa.ts latencies", value: `${f1(numa)} ms` },
        { label: "best period (red curve)", value: best ? `${best.iv} ms` : "–" },
        { label: "useful CPU at 1 ms (red curve)", value: fastest ? pct(fastest.useful) : "–" },
        { label: "migrations per s at 1 ms", value: fastest ? Math.round(fastest.migrationsPerSec) : "–" },
        { label: "cross-node per s at 1 ms", value: fastest ? Math.round(fastest.crossNodePerSec) : "–" },
      ]} />
    </Demo>
  );
}
