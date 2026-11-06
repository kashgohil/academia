/** Demos for the lesson on eventual consistency: convergence by anti-entropy, and PBS for partial quorums. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, Param, Plot, RuleY, SmallLabel, Stats, fixed, int, pct, range, seg, useChunked, useParams, useWidth } from "../../kit";
import { pbsCurve, runGossip, staleClosedForm, type GossipMode } from "../../sims/dist/consistency";

const VALUE_COLORS = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)"];
const valueColor = (v: number) => (v === 0 ? "var(--subtle)" : VALUE_COLORS[(v - 1) % VALUE_COLORS.length]!);

const GOSSIP_SCHEMA = {
  interval: range({ label: "Anti-entropy period", min: 10, max: 400, step: 5, default: 60, log: true, format: (v) => `${v} ms` }),
  mode: seg<GossipMode>("Anti-entropy", [["off", "off"], ["push", "push"], ["pull", "pull"], ["push-pull", "push-pull"]], "push-pull"),
  drop: range({ label: "Messages lost", min: 0, max: 0.5, step: 0.05, default: 0.2, format: (v) => pct(v, 0) }),
  replicas: range({ label: "Replicas", min: 3, max: 12, step: 1, default: 6 }),
  seed: range({ label: "Run", min: 1, max: 40, step: 1, default: 9 }),
};

export function ConvergenceDemo() {
  const P = useParams("cons-gossip", GOSSIP_SCHEMA);
  const { interval, mode, drop, replicas, seed } = P.values;
  const cfg = { interval, mode, dropRate: drop, replicas, writes: 4, tEnd: 1500 };
  const run = useMemo(() => runGossip({ ...cfg, seed }), [interval, mode, drop, replicas, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = JSON.stringify(cfg);
  // 100 more runs with other seeds, in time slices, for the spread.
  const many = useChunked(key, Array.from({ length: 100 }, (_, i) => () => {
    const r = runGossip({ ...cfg, seed: 1000 + i });
    return { t: r.convergedAt === null ? null : r.convergedAt - r.lastWrite };
  }), { keep: true });
  const all = many.flatMap((x) => (x ? [x.t] : []));
  const doneRuns = all.length;
  const conv = all.filter((x): x is number => x !== null).sort((a, b) => a - b);
  const never = all.filter((x) => x === null).length;

  const [ref, width] = useWidth<HTMLDivElement>();
  const tShow = Math.min(cfg.tEnd, Math.max(300, (run.convergedAt ?? cfg.tEnd) * 1.15));
  const left = 30, right = 8, rowH = Math.max(12, Math.min(22, 160 / replicas)), top = 32;
  const W = Math.max(260, width), H = top + replicas * rowH + 18;
  // Write labels: two rows, so that writes close in time do not overlap.
  const labelRow = new Map<number, number>();
  const lastX = [-Infinity, -Infinity];
  [...run.writeTimes.keys()].sort((a, b) => run.writeTimes[a]! - run.writeTimes[b]!).forEach((i) => {
    const px = left + (run.writeTimes[i]! / tShow) * (Math.max(260, width) - left - right);
    const row = px - lastX[0]! > 22 ? 0 : px - lastX[1]! > 22 ? 1 : 0;
    lastX[row] = px;
    labelRow.set(i, row);
  });
  const x = (t: number) => left + (Math.min(t, tShow) / tShow) * (W - left - right);
  return (
    <Demo title="Replicas converge after the writes stop" controls={<>{(["interval", "mode", "drop", "replicas", "seed"] as const).map((k) => <Param key={k} spec={GOSSIP_SCHEMA[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>Each row is a replica; the color is the value it holds. Each write goes to one replica, which sends it to the others once. Time runs from 0 to {int(tShow)} ms.</SmallLabel>
      <div ref={ref} style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="replica values over time" style={{ display: "block" }}>
          {run.writeTimes.map((t, i) => (
            <g key={i}>
              <line x1={x(t)} x2={x(t)} y1={top - 4} y2={top + replicas * rowH} stroke="var(--faint)" strokeDasharray="2 3" />
              <text x={x(t)} y={top - 7 - 11 * (labelRow.get(i) ?? 0)} textAnchor="middle" fontSize="10" fontWeight={600} fill={valueColor(i + 1)}>{`w${i + 1}`}</text>
            </g>
          ))}
          {run.changes.map((ch, r) => (
            <g key={r}>
              <text x={left - 6} y={top + r * rowH + rowH / 2 + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{r + 1}</text>
              {ch.map(([t, v], k) => {
                const t2 = k + 1 < ch.length ? ch[k + 1]![0] : tShow;
                if (t >= tShow) return null;
                return <rect key={k} x={x(t)} y={top + r * rowH + 1} width={Math.max(0.5, x(t2) - x(t))} height={rowH - 2} fill={valueColor(v)} stroke={v === 0 ? "var(--border)" : "none"} />;
              })}
            </g>
          ))}
          {run.convergedAt !== null && (
            <g>
              <line x1={x(run.convergedAt)} x2={x(run.convergedAt)} y1={top - 4} y2={top + replicas * rowH + 4} stroke="var(--fg)" strokeWidth={1.5} />
              <text x={x(run.convergedAt) - 4} y={H - 4} textAnchor="end" fontSize="10.5" fill="var(--fg)">all agree</text>
            </g>
          )}
        </svg>
      </div>
      <Banner tone={run.convergedAt === null ? "bad" : "good"}>
        {run.convergedAt === null
          ? `No convergence in ${int(cfg.tEnd)} ms. A lost copy of the last write is never sent again, so some replicas keep an old value forever.`
          : `The last write was at ${fixed(run.lastWrite, 0)} ms. All replicas held its value ${fixed(run.convergedAt - run.lastWrite, 0)} ms later. Until then, a read could return an older value.`}
      </Banner>
      <Stats items={[
        { label: "this run: time to agree", value: run.convergedAt === null ? "never" : `${fixed(run.convergedAt - run.lastWrite, 0)} ms` },
        { label: `${doneRuns} runs: mean`, value: conv.length ? `${fixed(conv.reduce((a, b) => a + b, 0) / conv.length, 0)} ms` : "–" },
        { label: "90th percentile", value: conv.length ? `${fixed(conv[Math.floor(0.9 * (conv.length - 1))]!, 0)} ms` : "–" },
        { label: "never agreed", value: `${never} of ${doneRuns}` },
      ]} />
    </Demo>
  );
}

// ============================================================================ PBS

const PBS_SCHEMA = {
  n: seg("Replicas N", [["3", "3"], ["5", "5"]], "3"),
  r: range({ label: "Read quorum R", min: 1, max: 5, step: 1, default: 1 }),
  w: range({ label: "Write quorum W", min: 1, max: 5, step: 1, default: 1 }),
  mean: range({ label: "Mean one-way delay (model input)", min: 1, max: 20, step: 1, default: 5, format: (v) => `${v} ms` }),
};

const TS = Array.from({ length: 61 }, (_, i) => i);
const TRIALS = 3000;

export function PbsDemo() {
  const P = useParams("cons-pbs", PBS_SCHEMA);
  const n = Number(P.values.n);
  const r = Math.min(n, P.values.r), w = Math.min(n, P.values.w);
  const mean = P.values.mean;
  const cur = useMemo(() => pbsCurve({ n, r, w, mean, trials: TRIALS, seed: 1 }, TS), [n, r, w, mean]);
  const one = useMemo(() => pbsCurve({ n, r: 1, w: 1, mean, trials: TRIALS, seed: 1 }, TS), [n, mean]);
  const strict = r + w > n;
  const t999 = TS.find((_, i) => cur[i]! >= 0.999);
  const lo = Math.min(...one, ...cur);
  const yMin = Math.max(0, Math.floor(lo * 10) / 10);
  return (
    <Demo title="How stale is a partial quorum? (PBS)" controls={<>{(["n", "r", "w", "mean"] as const).map((k) => <Param key={k} spec={k === "r" || k === "w" ? { ...PBS_SCHEMA[k], max: n } : PBS_SCHEMA[k]} value={k === "r" ? r : k === "w" ? w : P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <Plot x={[0, 60]} y={[yMin, 1]} height={240} xLabel="time since the write returned (ms)" yLabel="P(read sees the write)" yFormat={(v) => pct(v, 0)}>
        <RuleY at={0.999} label="99.9%" />
        <Line points={TS.map((t, i) => [t, one[i]!] as const)} color="var(--muted)" dash="4 3" />
        <Line points={TS.map((t, i) => [t, cur[i]!] as const)} color="var(--c1)" width={2.5} />
      </Plot>
      <Legend items={[{ label: `N=${n}, R=${r}, W=${w}`, color: "var(--c1)" }, { label: "R=1, W=1", color: "var(--muted)" }]} />
      <Banner tone={strict ? "good" : "warn"}>
        {strict
          ? `R + W = ${r + w} > N = ${n}: every read quorum meets every write quorum, so every read sees the write.`
          : `R + W = ${r + w} ≤ N = ${n}: the quorums can miss each other. Right after the write, ${pct(1 - cur[0]!, 1)} of reads are stale. ${t999 === undefined ? "Even after 60 ms, fewer than 99.9% of reads are fresh." : `After ${t999} ms, 99.9% of reads are fresh.`}`}
      </Banner>
      <Stats items={[
        { label: "P(fresh) at t = 0", value: pct(cur[0]!, 1) },
        { label: "t for 99.9% fresh", value: t999 === undefined ? "> 60 ms" : `${t999} ms` },
        { label: "closed form, P(stale) at t = 0", value: pct(staleClosedForm(n, r, w), 1) },
      ]} />
    </Demo>
  );
}
