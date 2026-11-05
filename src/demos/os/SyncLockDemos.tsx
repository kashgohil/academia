/** Demos for "locks and spinlocks": a spinlock race with coherence traffic, and spin versus block. */
import { useMemo } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, range, select, si, useParams, usePlot, MiniTable, useChunked } from "../../kit";
import {
  SPIN_ALGOS, SPIN_CORES, SPIN_LABEL, SPIN_SWEEP_ACQ, simulateSpin, spinBlockCost, spinBlockCrossover,
  type SpinAlgo, type SpinResult,
} from "../../sims/os/sync/spinlocks";

const COLOR: Record<SpinAlgo, string> = { tas: "var(--c4)", ttas: "var(--c2)", backoff: "var(--c5)", ticket: "var(--c1)", mcs: "var(--c3)" };

const RACE = {
  cs: range({ label: "Critical section", min: 50, max: 3000, default: 300, log: true, format: (v) => `${Math.round(v)} cycles` }),
  work: range({ label: "Work between locks", min: 50, max: 5000, default: 300, log: true, format: (v) => `${Math.round(v)} cycles` }),
  cores: select({ label: "Cores in the race", options: SPIN_CORES.map((c) => ({ value: String(c), label: String(c) })), default: "16", segmented: true }),
  view: select({ label: "Handoff order", options: SPIN_ALGOS.map((a) => ({ value: a, label: SPIN_LABEL[a] })), default: "tas" }),
};

function OrderDots({ order, cores, color }: { order: number[]; cores: number; color: string }) {
  const W = 360, H = 86;
  const n = Math.max(order.length, 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 560, display: "block" }} role="img" aria-label="core that got the lock at each handoff">
      <line x1={0} y1={H - 12} x2={W} y2={H - 12} stroke="var(--border)" />
      {order.map((c, i) => <circle key={i} cx={4 + (i / n) * (W - 8)} cy={4 + (c / Math.max(1, cores - 1)) * (H - 22)} r={2.2} fill={color} />)}
      <text x={0} y={H - 1} fontSize={8.5} fill="var(--muted)">handoff 1</text>
      <text x={W} y={H - 1} fontSize={8.5} fill="var(--muted)" textAnchor="end">handoff {order.length}</text>
    </svg>
  );
}

export function SyncSpinRaceDemo() {
  const P = useParams("os-sync-spin", RACE);
  const cs = Math.round(P.values.cs);
  const work = Math.round(P.values.work);
  const cores = Number(P.values.cores);
  const tasks = useMemo(
    () => SPIN_ALGOS.flatMap((algo) => SPIN_CORES.map((n) => () => simulateSpin({ algo, cores: n, cs, work, acquisitions: SPIN_SWEEP_ACQ }))),
    [cs, work],
  );
  const results = useChunked<SpinResult>(`${cs}/${work}`, tasks);
  const get = (a: SpinAlgo, n: number) => results[SPIN_ALGOS.indexOf(a) * SPIN_CORES.length + SPIN_CORES.indexOf(n)];
  const ready = (a: SpinAlgo) => SPIN_CORES.flatMap((n) => { const r = get(a, n); return r ? [[n, r.busPerAcq] as [number, number]] : []; });
  const maxY = Math.max(10, ...results.map((r) => r?.busPerAcq ?? 0));
  const view = P.values.view as SpinAlgo;
  const sel = get(view, cores);
  return (
    <Demo
      title="N cores race for one spinlock"
      controls={
        <>
          <Param spec={RACE.cs} value={P.values.cs} onChange={(v) => P.set("cs", v as number)} />
          <Param spec={RACE.work} value={P.values.work} onChange={(v) => P.set("work", v as number)} />
          <Param spec={RACE.cores} value={P.values.cores} onChange={(v) => P.set("cores", v as never)} />
          <Param spec={RACE.view} value={view} onChange={(v) => P.set("view", v as never)} />
        </>
      }
    >
      <Plot x={[2, 32]} y={[0, maxY * 1.05]} height={230} xLabel="cores" yLabel="bus transactions per acquisition" logX xTicks={SPIN_CORES} xFormat={(v) => String(v)}>
        {SPIN_ALGOS.map((a) => <Line key={a} points={ready(a)} color={COLOR[a]} />)}
        <RuleX at={cores} />
      </Plot>
      <Legend items={SPIN_ALGOS.map((a) => ({ label: SPIN_LABEL[a], color: COLOR[a] }))} />
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={[`${cores} cores`, "bus", "inval.", "cycles", "fairness", "bypass"]}
          highlight={(i) => SPIN_ALGOS[i] === view}
          rows={SPIN_ALGOS.map((a) => {
            const r = get(a, cores);
            return [SPIN_LABEL[a], r ? r.busPerAcq.toFixed(1) : "…", r ? r.invalPerAcq.toFixed(1) : "…", r ? Math.round(r.cyclesPerAcq) : "…", r ? r.jain.toFixed(2) : "…", r ? r.maxBypass : "…"];
          })}
        />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          All columns are per acquisition, except the last two. Fairness is Jain's index (1 is equal shares). Bypass is the most handoffs that one waiter watched.
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12.5, marginBottom: 2 }}>Who got the lock next: {SPIN_LABEL[view]}, core id on the vertical axis</div>
        {sel && <OrderDots order={sel.order} cores={cores} color={COLOR[view]} />}
      </div>
    </Demo>
  );
}

const SB = {
  threads: range({ label: "Threads that want the lock", min: 2, max: 64, step: 1, default: 8 }),
  cores: range({ label: "CPU cores", min: 1, max: 64, step: 1, default: 16 }),
  sw: range({ label: "Sleep or wake cost (model input)", min: 500, max: 20000, default: 2000, log: true, format: (v) => `${si(v * 1e-9, "s")}` }),
};

function CrossDot({ x, y }: { x: number; y: number }) {
  const { x: X, y: Y } = usePlot();
  return <circle cx={X(x)} cy={Y(y)} r={4} fill="none" stroke="var(--fg)" strokeWidth={1.5} />;
}

export function SyncSpinBlockDemo() {
  const P = useParams("os-sync-sb", SB);
  const threads = Math.round(P.values.threads);
  const cores = Math.round(P.values.cores);
  const switchNs = P.values.sw;
  const pts = useMemo(() => {
    const xs = Array.from({ length: 41 }, (_, i) => 10 * Math.pow(10, (i / 40) * 4));
    const at = xs.map((cs) => ({ cs, ...spinBlockCost({ cs, threads, cores, switchNs, sliceNs: 4_000_000 }) }));
    return {
      spin: at.map((p) => [p.cs, Math.max(1, p.spin)] as [number, number]),
      block: at.map((p) => [p.cs, Math.max(1, p.block)] as [number, number]),
      adaptive: at.map((p) => [p.cs, Math.max(1, p.adaptive)] as [number, number]),
    };
  }, [threads, cores, switchNs]);
  const over = threads > cores;
  const cross = spinBlockCrossover(Math.min(threads, cores), switchNs);
  const inRange = !over && cores > 1 && cross >= 10 && cross <= 1e5;
  return (
    <Demo
      title="Spin or block: CPU time wasted per contended acquisition"
      controls={
        <>
          <Param spec={SB.threads} value={P.values.threads} onChange={(v) => P.set("threads", v as number)} />
          <Param spec={SB.cores} value={P.values.cores} onChange={(v) => P.set("cores", v as number)} />
          <Param spec={SB.sw} value={P.values.sw} onChange={(v) => P.set("sw", v as number)} />
        </>
      }
    >
      <Plot x={[10, 1e5]} y={[10, 1e7]} logX logY height={250} xLabel="critical section length" yLabel="wasted CPU time" xFormat={(v) => si(v * 1e-9, "s", 2)} yFormat={(v) => si(v * 1e-9, "s", 2)} xTicks={[10, 100, 1000, 1e4, 1e5]} yTicks={[10, 100, 1000, 1e4, 1e5, 1e6, 1e7]}>
        <Line points={pts.spin} color="var(--c4)" />
        <Line points={pts.block} color="var(--c1)" />
        <Line points={pts.adaptive} color="var(--c3)" dash="5 3" />
        {inRange && <RuleX at={cross} />}
        {inRange && <CrossDot x={cross} y={2 * switchNs} />}
      </Plot>
      <Legend items={[{ label: "Spin", color: "var(--c4)" }, { label: "Block", color: "var(--c1)" }, { label: "Adaptive: spin, then block", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: over ? "threads without a core" : "spin wins below this length", value: over ? threads - cores : inRange ? si(cross * 1e-9, "s", 3) : "n/a" },
          { label: "block cost (sleep + wake)", value: si(2 * switchNs * 1e-9, "s", 3) },
          { label: "preempted holder adds to a spin", value: over ? si((1 - cores / threads) * 2e6 * 1e-9, "s", 3) : "0" },
        ]} />
      </div>
    </Demo>
  );
}
