/** Demos for "rebalancing": a cluster growing from 3 to 6 nodes under four strategies, and a split and merge stepper. */
import { useMemo } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, range, seg, toggle, useParams, MiniTable, SectionLabel, StepButtons, StepCaption, StepSlider, fixed, int, mono, tint, useStepper } from "../../kit";
import { REBALANCE_DEFAULTS, SPLIT_KEYS, simulateRebalance, simulateSplits, type Burst, type Strategy } from "../../sims/dist/partitioning";
import { LoadBars, nodeColor } from "./PartitioningUi";

const NAMES: Record<Strategy, string> = { modulo: "hash mod N", fixed: "fixed partitions", dynamic: "dynamic splits", proportional: "per-node tokens" };
const COLORS: Record<Strategy, string> = { modulo: "var(--c4)", fixed: "var(--c1)", dynamic: "var(--c3)", proportional: "var(--c2)" };
const SHOWN: Strategy[] = ["modulo", "fixed", "dynamic", "proportional"];

const REB = {
  rate: range({ label: "Copy budget per node", min: 10, max: 200, step: 5, default: 40, format: (v) => `${v} MB/s` }),
  partitions: seg<"16" | "64" | "256" | "1024">("Fixed: partitions", [["16", "16"], ["64", "64"], ["256", "256"], ["1024", "1024"]], "64"),
  tokens: seg<"1" | "4" | "16" | "256">("Per-node tokens", [["1", "1"], ["4", "4"], ["16", "16"], ["256", "256"]], "16"),
  maxRange: range({ label: "Dynamic: split size", min: 1, max: 20, step: 1, default: 4, format: (v) => `${v} GB` }),
  modulo: toggle({ label: "Show hash mod N", default: true }),
};

export function PartitioningRebalanceDemo() {
  const P = useParams("dist-part-reb", REB);
  const { rate, partitions, tokens, maxRange, modulo } = P.values;
  const runs = useMemo(() => SHOWN.map((strategy) => simulateRebalance({ strategy, rateMBs: rate, partitions: Number(partitions), tokens: Number(tokens), maxRangeGB: maxRange })), [rate, partitions, tokens, maxRange]);
  const shown = runs.filter((r) => modulo || r.cfg.strategy !== "modulo");
  const T = REBALANCE_DEFAULTS.minutes;
  const maxImb = Math.max(1.6, ...shown.flatMap((r) => r.frames.map((f) => f.maxOverMean)));
  const maxMoved = Math.max(1, ...shown.map((r) => r.movedGB));
  return (
    <Demo title="Growing from 3 to 6 nodes" controls={<>
      <Param spec={REB.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
      <Param spec={REB.maxRange} value={maxRange} onChange={(v) => P.set("maxRange", v as number)} />
      <Param spec={REB.partitions} value={partitions} onChange={(v) => P.set("partitions", v as typeof partitions)} />
      <Param spec={REB.tokens} value={tokens} onChange={(v) => P.set("tokens", v as typeof tokens)} />
      <Param spec={REB.modulo} value={modulo} onChange={(v) => P.set("modulo", v as boolean)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Model inputs: data grows from {REBALANCE_DEFAULTS.dataStartGB} GB to {REBALANCE_DEFAULTS.dataEndGB} GB, and each node may copy at the budget below, in and out together. A node joins at minutes {REBALANCE_DEFAULTS.joinAt.join(", ")}.</div>
      <Plot x={[0, T]} y={[1, Math.min(4, maxImb * 1.05)]} height={200} xLabel="minutes" yLabel="busiest node / mean">
        {REBALANCE_DEFAULTS.joinAt.map((t) => <RuleX key={t} at={t} />)}
        {shown.map((r) => <Line key={r.cfg.strategy} points={r.frames.map((f) => [f.t, Math.min(4, f.maxOverMean)] as [number, number])} color={COLORS[r.cfg.strategy]} dash={r.cfg.strategy === "modulo" ? "5 4" : undefined} />)}
      </Plot>
      <Plot x={[0, T]} y={[0, maxMoved * 1.08]} height={160} xLabel="minutes" yLabel="GB copied so far">
        {shown.map((r) => <Line key={r.cfg.strategy} points={r.frames.map((f) => [f.t, f.movedGB] as [number, number])} color={COLORS[r.cfg.strategy]} dash={r.cfg.strategy === "modulo" ? "5 4" : undefined} />)}
      </Plot>
      <Legend items={shown.map((r) => ({ label: NAMES[r.cfg.strategy], color: COLORS[r.cfg.strategy] }))} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={["strategy", "GB copied", "minutes over 1.1", "busiest / mean at end", "partitions at end"]}
          rows={shown.map((r) => [NAMES[r.cfg.strategy], int(r.movedGB), int(r.unbalancedMin), fixed(r.finalMaxOverMean), int(r.pieces)])}
        />
      </div>
    </Demo>
  );
}

const SPLIT = {
  burst: seg<Burst>("Write burst", [["hot-range", "one hot range"], ["sequential", "rising keys"], ["uniform", "uniform"]], "hot-range"),
  maxMB: range({ label: "Split size", min: 32, max: 128, step: 8, default: 64, format: (v) => `${v} MB` }),
  load: toggle({ label: "Also split by load (above 400 writes/s)", default: false }),
};

const KIND_TONE = { split: "info", move: "good", merge: "warn", write: "plain", delete: "plain", idle: "none" } as const;

export function PartitioningSplitDemo() {
  const P = useParams("dist-part-split", SPLIT);
  const { burst, maxMB, load } = P.values;
  const frames = useMemo(() => simulateSplits({ burst, maxMB, loadSplitQps: load ? 400 : 0 }), [burst, maxMB, load]);
  const s = useStepper(frames.length, 3);
  const f = frames[s.i]!;
  const total = f.nodeQps.reduce((a, b) => a + b, 0);
  const maxMb = Math.max(maxMB, ...f.ranges.map((r) => r.mb));
  return (
    <Demo title="Splits, moves and merges" actions={<StepButtons s={s} />} controls={<>
      <StepSlider s={s} label="Tick (0.1 s each)" />
      <Param spec={SPLIT.burst} value={burst} onChange={(v) => { P.set("burst", v as Burst); s.reset(); }} />
      <Param spec={SPLIT.maxMB} value={maxMB} onChange={(v) => P.set("maxMB", v as number)} />
      <Param spec={SPLIT.load} value={load} onChange={(v) => P.set("load", v as boolean)} />
    </>}>
      <SectionLabel style={{ marginTop: 0 }}>Key space 0 to {SPLIT_KEYS - 1}: one box per range, colored by node, height by size</SectionLabel>
      <div style={{ display: "flex", alignItems: "flex-end", height: 92, gap: 1, borderBottom: "1px solid var(--border)", position: "relative" }}>
        <div style={{ position: "absolute", left: 0, right: 0, bottom: `${(maxMB / maxMb) * 76}px`, borderTop: "1.5px dashed var(--c4)", opacity: 0.7 }} title="split size" />
        {f.ranges.map((r) => (
          <div key={`${r.lo}-${r.hi}`} title={`[${r.lo}, ${r.hi}) on node ${r.node}: ${r.mb.toFixed(0)} MB, ${int(r.qps)} writes/s`} style={{ flex: `${r.hi - r.lo} 0 0`, minWidth: 2, height: `${Math.max(4, (r.mb / maxMb) * 76)}px`, background: tint(nodeColor(r.node), r.qps > 0 ? 85 : 45), border: `1px solid ${nodeColor(r.node)}`, borderRadius: "2px 2px 0 0", transition: "height 0.2s", position: "relative" }}>
            {r.qps > 0 && <div style={{ position: "absolute", top: -14, left: 0, right: 0, textAlign: "center", fontSize: 10, color: "var(--c4)" }}>●</div>}
          </div>
        ))}
      </div>
      <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, margin: "2px 0 10px" }}>
        <span>0</span><span>dashed: split size; dot: range takes writes now</span><span>{SPLIT_KEYS - 1}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Writes per second per node</SectionLabel>
          <LoadBars values={f.nodeQps} labels={f.nodeQps.map((_, i) => `node ${i}`)} colors={f.nodeQps.map((_, i) => nodeColor(i))} max={1600} height={90} format={(v) => int(v)} />
        </div>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Ranges</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 96, overflow: "auto" }}>
            {f.ranges.map((r) => <span key={`${r.lo}`} style={{ ...mono, fontSize: 11, padding: "0 4px", borderRadius: 3, border: `1px solid ${nodeColor(r.node)}` }}>[{r.lo},{r.hi}) {r.mb.toFixed(0)}M</span>)}
          </div>
        </div>
      </div>
      <StepCaption tone={KIND_TONE[f.kind]} label={`tick ${f.tick}`}>{f.event}</StepCaption>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "ranges", value: f.ranges.length },
          { label: "busiest node's share of writes", value: total > 0 ? `${Math.round((100 * Math.max(...f.nodeQps)) / total)}%` : "–" },
          { label: "data in all", value: `${f.ranges.reduce((a, r) => a + r.mb, 0).toFixed(0)} MB` },
        ]} />
      </div>
    </Demo>
  );
}
