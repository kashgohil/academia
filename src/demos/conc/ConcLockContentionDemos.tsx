/** Demos for "lock-contention": throughput against threads for three waiting policies, and lock striping. */
import { useMemo } from "react";
import { Demo, Param, Plot, Line, Dots, RuleY, Legend, Stats, range, useParams, useChunked, int, pct, StackBar, SmallLabel, Note, MiniTable, Bar, Label } from "../../kit";
import { contendedLoop, idealPerMs, lockBound, SWEEP_THREADS, stripedLoop, type WaitPolicy, type LoopStats, type StripeStats } from "../../sims/conc/locks/contention";
import { DEFAULT_COSTS } from "../../sims/conc";
import { dur } from "./ConcLockUi";

const PASS = 10_000;
const CORES = 8;
const POLICIES: { p: WaitPolicy; label: string; color: string }[] = [
  { p: "spin", label: "spin", color: "var(--c2)" },
  { p: "adaptive", label: "adaptive (spin 2 µs, then park)", color: "var(--c3)" },
  { p: "block", label: "block (park at once)", color: "var(--c1)" },
];

const S = {
  share: range({ label: "Share of each 10 µs pass inside the lock", min: 0.05, max: 0.5, step: 0.05, default: 0.2, format: (v) => `${Math.round(v * 100)}%` }),
};

export function ConcLockScalingDemo() {
  const P = useParams("conc-lock-scale", S);
  const { share } = P.values;
  const cs = Math.round(PASS * share), out = PASS - cs;
  const jobs = useMemo(
    () => POLICIES.flatMap(({ p }) => SWEEP_THREADS.map((threads) => () => contendedLoop({ threads, cores: CORES, csNs: cs, outsideNs: out, wait: p }))),
    [cs, out],
  );
  const res = useChunked<LoopStats>(`scale-${cs}`, jobs);
  const at = (k: number, n: number) => res[k * SWEEP_THREADS.length + SWEEP_THREADS.indexOf(n)];
  const line = (k: number) => SWEEP_THREADS.flatMap((n) => { const r = at(k, n); return r ? [[n, r.perMs] as [number, number]] : []; });
  const bound = lockBound(cs, false);
  const ideal = SWEEP_THREADS.map((n) => [n, idealPerMs(n, CORES, cs, out)] as [number, number]);
  const yMax = Math.max(bound, ...ideal.map((p) => p[1])) * 1.1;
  return (
    <Demo title="Throughput of one lock as threads grow" controls={<Param spec={S.share} value={share} onChange={(v) => P.set("share", v as number)} />}>
      <SmallLabel>{CORES} cores. Each pass: lock, {dur(cs)} inside, unlock, about {dur(out)} outside.</SmallLabel>
      <Plot x={[1, 32]} y={[0, yMax]} height={240} xLabel="threads" yLabel="acquisitions per ms" xTicks={[1, 4, 8, 16, 24, 32]}>
        <Line points={ideal} color="var(--muted)" dash="4 3" width={1.5} />
        <RuleY at={bound} color="var(--c4)" />
        <Label at={[32, bound]} anchor="end" color="var(--c4)">lock limit</Label>
        {POLICIES.map(({ p, color }, k) => (
          <g key={p}>
            <Line points={line(k)} color={color} />
            <Dots points={line(k)} color={color} r={2.5} />
          </g>
        ))}
      </Plot>
      <Legend items={[...POLICIES.map(({ label, color }) => ({ label, color })), { label: "no lock at all", color: "var(--muted)" }]} />
      <SmallLabel style={{ marginTop: 10 }}>Where the core time goes at 32 threads: work, spinning, context switches, idle</SmallLabel>
      <div style={{ display: "grid", gap: 6 }}>
        {POLICIES.map(({ p, color }, k) => {
          const r = at(k, 32);
          return (
            <div key={p} style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 8, alignItems: "center", fontSize: 12 }}>
              <span className="muted">{p}</span>
              {r ? (
                <StackBar height={14} parts={[
                  { value: r.shares.work, color, label: `work ${pct(r.shares.work, 0)}` },
                  { value: r.shares.spin, color: "var(--c4)", label: `spin ${pct(r.shares.spin, 0)}` },
                  { value: r.shares.switch, color: "var(--faint)", label: `switch ${pct(r.shares.switch, 0)}` },
                  { value: r.shares.idle, color: "var(--subtle)", label: `idle ${pct(r.shares.idle, 0)}` },
                ]} />
              ) : <span className="muted">…</span>}
            </div>
          );
        })}
      </div>
      <Legend items={[{ label: "work (line color)", color: "var(--c1)" }, { label: "spin", color: "var(--c4)" }, { label: "context switch", color: "var(--faint)" }, { label: "idle", color: "var(--subtle)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "lock limit, 1 / (cs + acquire)", value: `${int(bound)} per ms` },
          ...POLICIES.map(({ p }, k) => ({ label: `${p}: 8 → 32 threads`, value: at(k, 8) && at(k, 32) ? `${int(at(k, 8)!.perMs)} → ${int(at(k, 32)!.perMs)}` : "…" })),
        ]} />
      </div>
      <Note>Model inputs: acquire {DEFAULT_COSTS.lockNs} ns plus {DEFAULT_COSTS.transferNs} ns when the lock moves to another core, wake-up {dur(DEFAULT_COSTS.wakeNs)}, context switch {dur(DEFAULT_COSTS.switchNs)}, time slice 100 µs. Each point is a 2 ms run.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- striping

const STRIPES = [1, 2, 4, 8, 16, 32, 64];

const T = {
  stripes: range({ label: "Stripes (log₂)", min: 0, max: 6, step: 1, default: 0, format: (v) => `${2 ** v}` }),
  skew: range({ label: "Key skew (Zipf exponent)", min: 0, max: 2, step: 0.1, default: 0, format: (v) => v.toFixed(1) }),
};

export function ConcLockStripeDemo() {
  const P = useParams("conc-lock-stripe", T);
  const { stripes: lg, skew } = P.values;
  const stripes = 2 ** lg;
  const jobs = useMemo(() => STRIPES.map((k) => () => stripedLoop({ stripes: k, skew })), [skew]);
  const res = useChunked<StripeStats>(`stripe-${skew}`, jobs);
  const pts = STRIPES.flatMap((k, i) => (res[i] ? [[k, res[i]!.perMs] as [number, number]] : []));
  const cur = res[STRIPES.indexOf(stripes)];
  const top = cur ? cur.stripes.map((s, i) => ({ i, ...s })).sort((a, b) => b.waitNs - a.waitNs).slice(0, 4) : [];
  const totalWait = cur ? cur.stripes.reduce((a, s) => a + s.waitNs, 0) : 0;
  const ideal = (8 * 1e6) / 4_000;
  return (
    <Demo
      title="Striping a hash map's lock"
      controls={
        <>
          <Param spec={T.stripes} value={lg} onChange={(v) => P.set("stripes", v as number)} />
          <Param spec={T.skew} value={skew} onChange={(v) => P.set("skew", v as number)} />
        </>
      }
    >
      <SmallLabel>8 threads on 8 cores, 1,024 keys. Each operation locks stripe (key mod k) for 1 µs, then works about 3 µs outside.</SmallLabel>
      <Plot x={[1, 64]} y={[0, ideal * 1.1]} logX height={200} xLabel="stripes" yLabel="operations per ms" xTicks={STRIPES} xFormat={(v) => String(v)}>
        <RuleY at={ideal} color="var(--muted)" />
        <Label at={[1.1, ideal]} color="var(--muted)">no lock at all</Label>
        <Line points={pts} color="var(--c1)" />
        <Dots points={pts} color="var(--c1)" r={3} />
        {cur && <Dots points={[[stripes, cur.perMs]]} color="var(--c4)" r={5} />}
      </Plot>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: `throughput, ${stripes} stripe${stripes > 1 ? "s" : ""}`, value: cur ? `${int(cur.perMs)} per ms` : "…" },
          { label: "share of operations on the busiest stripe", value: cur ? pct(cur.hottest, 0) : "…" },
          { label: "mean wait per operation", value: cur ? dur(cur.meanWaitNs) : "…" },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>A mutex profile: the stripes with the most total wait time</SmallLabel>
      <MiniTable
        head={["stripe", "operations", "contended", "total wait", "share of wait"]}
        rows={top.map((s) => [
          String(s.i), int(s.ops), pct(s.ops ? s.contended / s.ops : 0, 0), dur(s.waitNs),
          <div key="b" style={{ minWidth: 60 }}><Bar frac={totalWait ? s.waitNs / totalWait : 0} color="var(--c4)" /></div>,
        ])}
      />
    </Demo>
  );
}
