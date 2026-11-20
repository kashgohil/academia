/** Demos for "pipelines": a pipeline builder, ordered against unordered output, and batching. */
import { useMemo } from "react";
import { Banner, Btn, Demo, Legend, Line, Meter, Param, Plot, Stats, int, range, seg, sig, toggle, useChunked, useParams } from "../../kit";
import { PIPE_DEFAULTS, runPipeline, type PipelineResult, type StageSpec } from "../../sims/conc/patterns";
import { ThreadTimeline } from "./ConcViews";

const rate = (x: number) => (x >= 1_000 ? `${sig(x / 1_000, 3)}k/s` : `${sig(x, 3)}/s`);
const us = (ns: number) => `${sig(ns / 1_000, 3)} µs`;

const BUILD = {
  c0: range({ label: "parse (µs per item)", min: 5, max: 100, step: 5, default: 20 }),
  c1: range({ label: "resize (µs per item)", min: 5, max: 100, step: 5, default: 60 }),
  c2: range({ label: "encode (µs per item)", min: 5, max: 100, step: 5, default: 30 }),
  c3: range({ label: "write (µs per item)", min: 5, max: 100, step: 5, default: 10 }),
  r0: range({ label: "r0", min: 1, max: 4, step: 1, default: 1 }),
  r1: range({ label: "r1", min: 1, max: 4, step: 1, default: 1 }),
  r2: range({ label: "r2", min: 1, max: 4, step: 1, default: 1 }),
  r3: range({ label: "r3", min: 1, max: 4, step: 1, default: 1 }),
  cap: range({ label: "Queue capacity (items)", min: 0, max: 8, step: 1, default: 2 }),
};
const COST_KEYS = ["c0", "c1", "c2", "c3"] as const;
const REP_KEYS = ["r0", "r1", "r2", "r3"] as const;

export function ConcPatPipeDemo() {
  const P = useParams("conc-pipe-build", BUILD);
  const v = P.values;
  const stages: StageSpec[] = PIPE_DEFAULTS.stages.map((s, i) => ({ name: s.name, costNs: v[COST_KEYS[i]!] * 1_000, replicas: v[REP_KEYS[i]!] }));
  const key = JSON.stringify(stages) + v.cap;
  const res = useMemo(() => runPipeline({ stages, capacity: v.cap, items: 40 }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Demo
      title="A four-stage pipeline: find and fix the bottleneck"
      controls={
        <>
          {COST_KEYS.map((k) => <Param key={k} spec={BUILD[k]} value={v[k]} onChange={(x) => P.set(k, x as number)} />)}
          <Param spec={BUILD.cap} value={v.cap} onChange={(x) => P.set("cap", x as number)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 6 }}>
        {stages.map((s, i) => {
          const hot = i === res.bottleneck;
          return (
            <div key={s.name} style={{ border: `1px solid ${hot ? "var(--c4)" : "var(--border)"}`, borderRadius: 6, padding: "6px 8px", boxShadow: hot ? "inset 0 3px 0 var(--c4)" : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 4 }}>
                <b style={{ fontSize: 13 }}>{s.name}</b>
                <span className="muted" style={{ fontSize: 11.5 }}>{s.costNs / 1_000} µs</span>
              </div>
              <Meter label="busy" value={res.util[i]!} max={1} color={hot ? "var(--c4)" : "var(--c1)"} text={`${Math.round(res.util[i]! * 100)}%`} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <Btn ghost onClick={() => P.set(REP_KEYS[i]!, Math.max(1, s.replicas - 1))} disabled={s.replicas <= 1}>−</Btn>
                <span>{s.replicas} thread{s.replicas > 1 ? "s" : ""}</span>
                <Btn ghost onClick={() => P.set(REP_KEYS[i]!, Math.min(4, s.replicas + 1))} disabled={s.replicas >= 4}>+</Btn>
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>queue before it: max {res.maxQueue[i]} of {v.cap}</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <ThreadTimeline result={res.run} by="thread" labels={false} />
      </div>
      <Stats items={[
        { label: "throughput (measured)", value: rate(res.throughput) },
        { label: "slowest stage allows", value: rate(res.predicted) },
        { label: "mean latency per item", value: us(res.meanLatency) },
        { label: "sum of stage costs", value: us(res.minLatency) },
      ]} />
      <Banner tone="warn">
        The bottleneck is <b>{stages[res.bottleneck]!.name}</b>: {stages[res.bottleneck]!.replicas} thread{stages[res.bottleneck]!.replicas > 1 ? "s" : ""} at {stages[res.bottleneck]!.costNs / 1_000} µs per item. Stages before it wait on full queues; stages after it wait on empty ones.
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- ordered and unordered output

const ORDER = {
  replicas: range({ label: "Threads in the transform stage", min: 1, max: 8, step: 1, default: 4 }),
  jitter: seg("Transform cost", [["fixed", "always 60 µs"], ["tail", "60 µs on average, long tail"]], "tail"),
  tokens: range({ label: "Live tokens (0: no limit)", min: 0, max: 16, step: 1, default: 0 }),
};
const ORDER_STAGES = (replicas: number, jitter: number): StageSpec[] => [
  { name: "decode", costNs: 10_000, replicas: 1 },
  { name: "transform", costNs: 60_000, replicas, jitter },
  { name: "write", costNs: 10_000, replicas: 1 },
];

export function ConcPatOrderDemo() {
  const P = useParams("conc-pipe-order", ORDER);
  const { replicas, jitter, tokens } = P.values;
  const j = jitter === "tail" ? 1 : 0;
  const [un, ord] = useMemo(() => [false, true].map((ordered) => runPipeline({ stages: ORDER_STAGES(replicas, j), ordered, tokens, items: 400, sourceNs: 20_000, capacity: 4, record: false })) as [PipelineResult, PipelineResult], [replicas, j, tokens]);
  const pts = (r: PipelineResult) => r.latency.map((l, i) => [i, l / 1_000] as [number, number]);
  const ymax = Math.max(200, ...ord.latency.map((l) => l / 1_000), ...un.latency.map((l) => l / 1_000)) * 1.05;
  return (
    <Demo
      title="Ordered output waits for the slowest item"
      controls={
        <>
          <Param spec={ORDER.replicas} value={replicas} onChange={(v) => P.set("replicas", v as number)} />
          <Param spec={ORDER.jitter} value={jitter} onChange={(v) => P.set("jitter", v as "tail")} />
          <Param spec={ORDER.tokens} value={tokens} onChange={(v) => P.set("tokens", v as number)} />
        </>
      }
    >
      <Plot x={[0, 400]} y={[0, ymax]} height={220} xLabel="item number" yLabel="latency (µs)">
        <Line points={pts(ord)} color="var(--c4)" width={1.5} />
        <Line points={pts(un)} color="var(--c1)" width={1.5} />
      </Plot>
      <Legend items={[{ label: "ordered (reorder buffer)", color: "var(--c4)" }, { label: "unordered", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "mean latency, unordered", value: us(un.meanLatency) },
        { label: "mean latency, ordered", value: us(ord.meanLatency) },
        { label: "p99, unordered / ordered", value: `${sig(un.p99Latency / 1_000, 3)} / ${sig(ord.p99Latency / 1_000, 3)} µs` },
        { label: "largest reorder buffer", value: `${ord.reorderMax} items` },
        { label: "throughput, unordered / ordered", value: `${rate(un.throughput)} / ${rate(ord.throughput)}` },
      ]} />
      <Banner tone={ord.throughput < un.throughput * 0.9 ? "bad" : "info"}>
        A new item arrives every 20 µs. {(replicas * 1e9) / 60_000 < 50_000 ? `${replicas} transform thread${replicas > 1 ? "s" : ""} can do only ${rate((replicas * 1e9) / 60_000)}, less than the 50k/s that arrive, so the queues grow. ` : ""}
        {int(un.outOfOrder)} of 400 items reached the end before an earlier item.
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- batching

const BATCH = {
  handoff: range({ label: "Cost of one handoff (model input)", min: 0, max: 10, step: 0.5, default: 3, format: (v) => `${v} µs` }),
  item: range({ label: "Work per item, per stage", min: 1, max: 10, step: 1, default: 2, format: (v) => `${v} µs` }),
  limit: toggle({ label: "Show the worst latency, not the mean", default: false }),
};
const BATCHES = [1, 2, 4, 8, 16, 32, 64, 128];

export function ConcPatBatchDemo() {
  const P = useParams("conc-pipe-batch", BATCH);
  const { handoff, item, limit } = P.values;
  const jobs = useMemo(() => BATCHES.map((b) => () => runPipeline({ stages: [{ name: "a", costNs: item * 1_000, replicas: 1 }, { name: "b", costNs: item * 1_000, replicas: 1 }], batch: b, handoffNs: handoff * 1_000, items: 512, capacity: 2, record: false })), [handoff, item]);
  const res = useChunked<PipelineResult>(`${handoff}/${item}`, jobs, { keep: true });
  const got = BATCHES.flatMap((b, i) => (res[i] ? [{ b, r: res[i]! }] : []));
  const tmax = Math.max(1, ...got.map((g) => g.r.throughput)) * 1.1;
  const lmax = Math.max(1, ...got.map((g) => (limit ? g.r.maxLatency : g.r.meanLatency))) * 1.1;
  return (
    <Demo
      title="Batching: fewer handoffs, longer waits"
      controls={
        <>
          <Param spec={BATCH.handoff} value={handoff} onChange={(v) => P.set("handoff", v as number)} />
          <Param spec={BATCH.item} value={item} onChange={(v) => P.set("item", v as number)} />
          <Param spec={BATCH.limit} value={limit} onChange={(v) => P.set("limit", v as boolean)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
        <Plot x={[1, 128]} y={[0, tmax / 1_000]} logX height={190} xLabel="batch size" yLabel="throughput (k items/s)" xTicks={BATCHES}>
          <Line points={got.map((g) => [g.b, g.r.throughput / 1_000] as [number, number])} color="var(--c3)" />
        </Plot>
        <Plot x={[1, 128]} y={[0, lmax / 1_000]} logX height={190} xLabel="batch size" yLabel={limit ? "worst latency (µs)" : "mean latency (µs)"} xTicks={BATCHES}>
          <Line points={got.map((g) => [g.b, (limit ? g.r.maxLatency : g.r.meanLatency) / 1_000] as [number, number])} color="var(--c4)" />
        </Plot>
      </div>
      <Stats items={[
        { label: "throughput, batch 1", value: got[0] ? rate(got[0].r.throughput) : "…" },
        { label: `throughput, batch ${BATCHES[BATCHES.length - 1]}`, value: got[7] ? rate(got[7].r.throughput) : "…" },
        { label: "limit with no handoff cost", value: rate(1e6 / item) },
        { label: "mean latency, batch 1 / 128", value: got[0] && got[7] ? `${us(got[0].r.meanLatency)} / ${us(got[7].r.meanLatency)}` : "…" },
      ]} />
      <Banner>
        Two stages, 512 items. Each send costs the handoff once per batch, so a stage needs {item} + {handoff} / batch µs per item. The model ignores everything else.
      </Banner>
    </Demo>
  );
}
