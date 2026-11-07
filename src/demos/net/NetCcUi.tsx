/** Views shared by the congestion-control and QUIC demos (prefix NetCc). */
import { useMemo, type ReactNode } from "react";
import { useChunked, usePlot } from "../../kit";
import { CcRun, type RunResult, type Sample, type Scenario } from "../../sims/net/cc";

export const FLOW_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

/**
 * Runs a scenario in slices of simulated time, so that a long run never blocks a frame. Returns the samples so far
 * and, at the end, the summary. The run restarts when `key` changes; the old picture stays until new data arrives.
 */
export function useCcRun(key: string, sc: Scenario, sliceMs = 1000): { samples: Sample[]; result?: RunResult; progress: number } {
  const jobs = useMemo(() => {
    let run: CcRun | undefined;
    const n = Math.max(1, Math.ceil(sc.durationMs / sliceMs));
    return Array.from({ length: n }, (_, i) => () => {
      run ??= new CcRun(sc);
      run.runTo(Math.min(sc.durationMs, (i + 1) * sliceMs));
      return { n: run.samples.length, samples: run.samples, result: i === n - 1 ? run.result() : undefined };
    });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the key names the scenario
  const res = useChunked(key, jobs, { keep: true });
  let last: (typeof res)[number];
  let done = 0;
  for (const r of res) if (r) { last = r; done++; }
  return { samples: last ? last.samples.slice(0, last.n) : [], result: last?.result, progress: done / jobs.length };
}

/**
 * Runs several scenarios one after the other, each in slices of simulated time. Returns each run's summary once it
 * has finished (undefined before), and the fraction of slices done.
 */
export function useScenarioSweep(key: string, scenarios: Scenario[], sliceMs = 2000): { results: (RunResult | undefined)[]; progress: number } {
  const plan = useMemo(() => {
    const jobs: (() => { i: number; r?: RunResult })[] = [];
    scenarios.forEach((sc, i) => {
      let run: CcRun | undefined;
      const n = Math.max(1, Math.ceil(sc.durationMs / sliceMs));
      for (let k = 0; k < n; k++) {
        jobs.push(() => {
          run ??= new CcRun(sc);
          run.runTo(Math.min(sc.durationMs, (k + 1) * sliceMs));
          if (k < n - 1) return { i };
          const r = run.result();
          run = undefined;
          return { i, r };
        });
      }
    });
    return jobs;
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the key names the scenarios
  const res = useChunked(key, plan, { keep: true });
  const results: (RunResult | undefined)[] = scenarios.map(() => undefined);
  let done = 0;
  for (const x of res) if (x) { done++; if (x.r) results[x.i] = x.r; }
  return { results, progress: done / plan.length };
}

/** A sweep of independent jobs; `done` counts the finished ones. */
export function useSweep<T>(key: string, jobs: (() => T)[]) {
  const res = useChunked(key, jobs, { keep: true });
  return { res, done: res.filter((r) => r !== undefined).length };
}

/** Coloured bands behind a time plot, one per run of equal `label` values: BBR's states, a flow's mode. */
export function Bands({ spans, colors, opacity = 0.13 }: { spans: { t0: number; t1: number; label: string }[]; colors: Record<string, string>; opacity?: number }) {
  const { x, h } = usePlot();
  return (
    <g>
      {spans.map((s, i) => (
        <rect key={i} x={x(s.t0)} y={0} width={Math.max(0, x(s.t1) - x(s.t0))} height={h} fill={colors[s.label] ?? "transparent"} opacity={opacity} />
      ))}
    </g>
  );
}

/** Turns per-sample labels into spans of equal labels. */
export function spansOf(samples: Sample[], label: (s: Sample) => string) {
  const out: { t0: number; t1: number; label: string }[] = [];
  for (const s of samples) {
    const l = label(s);
    const last = out[out.length - 1];
    if (last && last.label === l) last.t1 = s.t;
    else {
      if (last) last.t1 = s.t;
      out.push({ t0: s.t, t1: s.t, label: l });
    }
  }
  return out;
}

/** Moving average over `k` samples of a series of [x, y]. */
export function smooth(pts: [number, number][], k: number): [number, number][] {
  if (k <= 1) return pts;
  const out: [number, number][] = [];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    sum += pts[i]![1];
    if (i >= k) sum -= pts[i - k]![1];
    out.push([pts[i]![0], sum / Math.min(i + 1, k)]);
  }
  return out;
}

/** A thin progress line while a run is in progress, with a fixed height so that the demo does not jump. */
export function RunProgress({ p, children }: { p: number; children?: ReactNode }) {
  return (
    <div style={{ minHeight: 16, fontSize: 11.5, lineHeight: 1.35, color: "var(--muted)", display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0 6px" }}>
      <div style={{ flex: "0 0 40px", height: 3, alignSelf: "center", background: "var(--subtle)", borderRadius: 2, overflow: "hidden", opacity: p < 1 ? 1 : 0.35 }}>
        <div style={{ width: `${Math.round(p * 100)}%`, height: "100%", background: "var(--muted)" }} />
      </div>
      <span>{p < 1 ? "simulating…" : children}</span>
    </div>
  );
}
