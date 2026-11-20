/** Demos for "map-reduce": float sums that depend on P, combine strategies on the Runtime, and key skew in a shuffle. */
import { useMemo } from "react";
import { Banner, Bars, Demo, Legend, Line, MiniTable, Param, Plot, RuleY, Stats, fixed, int, mono, pct, range, seg, sig, toggle, useChunked, useParams } from "../../kit";
import { chunkedSum, makeValues, referenceSum, runReduction, shuffleLoad, type Strategy } from "../../sims/conc/patterns";
import { ThreadTimeline } from "./ConcViews";

const FN = 1 << 20;
let VALUES: Float32Array | null = null;
let REF = 0;
const values = () => {
  if (!VALUES) {
    VALUES = makeValues(FN, 1);
    REF = referenceSum(VALUES);
  }
  return VALUES;
};
const TABLE_P = [1, 2, 4, 8, 16, 32, 64];

const FLOAT = {
  p: range({ label: "Threads P (chunks)", min: 0, max: 6, step: 1, default: 0, format: (v) => `${2 ** v}` }),
  how: seg("Combine the partial sums", [["linear", "left to right"], ["tree", "in a tree"]], "tree"),
  kahan: toggle({ label: "Kahan compensation inside each chunk", default: false }),
};

export function ConcPatFloatDemo() {
  const P = useParams("conc-mr-float", FLOAT);
  const { p: pExp, how, kahan } = P.values;
  const threads = 2 ** pExp;
  const v = values();
  const sum = useMemo(() => chunkedSum(v, threads, how as "tree", kahan), [v, threads, how, kahan]);
  const jobs = useMemo(() => TABLE_P.map((p) => () => chunkedSum(v, p, how as "tree", kahan)), [v, how, kahan]);
  const table = useChunked<number>(`${how}/${kahan}`, jobs, { keep: true });
  const err = sum - REF;
  return (
    <Demo
      title="One float32 sum, many answers"
      controls={
        <>
          <Param spec={FLOAT.p} value={pExp} onChange={(x) => P.set("p", x as number)} />
          <Param spec={FLOAT.how} value={how} onChange={(x) => P.set("how", x as "tree")} />
          <Param spec={FLOAT.kahan} value={kahan} onChange={(x) => P.set("kahan", x as boolean)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
          <div className="muted" style={{ fontSize: 11.5 }}>float32 result with {threads} chunk{threads > 1 ? "s" : ""}</div>
          <div style={{ ...mono, fontSize: 20, fontWeight: 600 }}>{sum.toFixed(3)}</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
          <div className="muted" style={{ fontSize: 11.5 }}>reference (float64, compensated)</div>
          <div style={{ ...mono, fontSize: 20, fontWeight: 600 }}>{REF.toFixed(3)}</div>
        </div>
      </div>
      <MiniTable
        head={["chunks P", "float32 sum", "error"]}
        rows={TABLE_P.map((p, i) => [p, table[i] === undefined ? "…" : table[i]!.toFixed(3), table[i] === undefined ? "…" : fixed(table[i]! - REF, 3)])}
        highlight={TABLE_P.indexOf(threads)}
      />
      <Banner tone={Math.abs(err) > 1 ? "bad" : "good"}>
        {int(FN)} values in [0, 1). Each add rounds to 24 bits. With P = {threads}, the error is {fixed(err, 3)}. A different P gives a different grouping, so a different result.
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- combine strategies

const STRATS: { s: Strategy; label: string; color: string }[] = [
  { s: "shared", label: "shared accumulator (atomic add per item)", color: "var(--c4)" },
  { s: "linear", label: "partials, merged one by one", color: "var(--c2)" },
  { s: "tree", label: "partials, merged in a tree", color: "var(--c3)" },
];
const RPS = [1, 2, 4, 8, 16, 32];
const COMB = {
  threads: range({ label: "Threads", min: 1, max: 32, step: 1, default: 16 }),
  size: range({ label: "Values in one partial result", min: 0, max: 14, step: 1, default: 0, format: (v) => (v === 0 ? "1 (a sum)" : `${int(2 ** v)} (a histogram)`) }),
  show: seg("Timeline", [["linear", "one by one"], ["tree", "tree"]], "tree"),
};

export function ConcPatCombineDemo() {
  const P = useParams("conc-mr-combine", COMB);
  const { threads, size: sExp, show } = P.values;
  const partialSize = 2 ** sExp;
  const jobs = useMemo(() => STRATS.flatMap((x) => RPS.map((p) => () => runReduction({ strategy: x.s, threads: p, partialSize, record: false }).speedup)), [partialSize]);
  const sweep = useChunked<number>(`${partialSize}`, jobs, { keep: true });
  const sel = useMemo(() => runReduction({ strategy: show as Strategy, threads, partialSize }), [show, threads, partialSize]);
  const other = useMemo(() => runReduction({ strategy: show === "tree" ? "linear" : "tree", threads, partialSize, record: false }), [show, threads, partialSize]);
  return (
    <Demo
      title="Combine partial results: shared, one by one, or a tree"
      controls={
        <>
          <Param spec={COMB.threads} value={threads} onChange={(v) => P.set("threads", v as number)} />
          <Param spec={COMB.size} value={sExp} onChange={(v) => P.set("size", v as number)} />
          <Param spec={COMB.show} value={show} onChange={(v) => P.set("show", v as "tree")} />
        </>
      }
    >
      <Plot x={[1, 32]} y={[0, 32]} height={200} xLabel="threads" yLabel="speedup" xTicks={RPS}>
        <Line points={[[1, 1], [32, 32]]} color="var(--faint)" dash="4 3" width={1} />
        {STRATS.map((x, i) => <Line key={x.s} color={x.color} points={RPS.flatMap((p, j) => { const v = sweep[i * RPS.length + j]; return v === undefined ? [] : [[p, v] as [number, number]]; })} />)}
      </Plot>
      <Legend items={STRATS.map((x) => ({ label: x.label, color: x.color }))} />
      <div style={{ marginTop: 8 }}>
        <ThreadTimeline result={sel.run} by="thread" labels={false} />
      </div>
      <Stats items={[
        { label: `${show === "tree" ? "tree" : "one by one"}: time`, value: `${sig(sel.makespan / 1_000, 3)} µs` },
        { label: "of which after the last map", value: `${sig(sel.combineNs / 1_000, 3)} µs` },
        { label: `${show === "tree" ? "one by one" : "tree"}: time`, value: `${sig(other.makespan / 1_000, 3)} µs` },
        { label: "speedup", value: `${fixed(sel.speedup, 2)}×` },
      ]} />
      <Banner>
        {int(65_536)} items, 20 ns of map work each; one merge costs 2 ns per value (model inputs). The tree pays a join (a wake-up) per level; one by one pays a full merge per thread.
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- skew in the shuffle

const SKEW = {
  zipf: range({ label: "Key skew (Zipf exponent)", min: 0, max: 1.5, step: 0.1, default: 1, format: (v) => fixed(v, 1) }),
  reducers: range({ label: "Reducers", min: 2, max: 64, step: 1, default: 16 }),
  combiner: toggle({ label: "Map-side combiner", default: false }),
};

export function ConcPatSkewDemo() {
  const P = useParams("conc-mr-skew", SKEW);
  const { zipf, reducers, combiner } = P.values;
  const r = useMemo(() => shuffleLoad({ zipf, reducers, combiner }), [zipf, reducers, combiner]);
  const ymax = Math.max(...r.load) * 1.1;
  return (
    <Demo
      title="Records per reducer after the shuffle"
      controls={
        <>
          <Param spec={SKEW.zipf} value={zipf} onChange={(v) => P.set("zipf", v as number)} />
          <Param spec={SKEW.reducers} value={reducers} onChange={(v) => P.set("reducers", v as number)} />
          <Param spec={SKEW.combiner} value={combiner} onChange={(v) => P.set("combiner", v as boolean)} />
        </>
      }
    >
      <Plot x={[0, reducers]} y={[0, ymax]} height={200} xLabel="reducer" yLabel="records received" xTicks={[0, reducers]}>
        <Bars bins={r.load.map((y, i) => ({ x0: i, x1: i + 1, y }))} color={r.imbalance > 2 ? "var(--c4)" : "var(--c1)"} />
        <RuleY at={r.mean} label="mean" />
      </Plot>
      <Stats items={[
        { label: "records into the reducers", value: int(r.total) },
        { label: "the hottest key, before combining", value: `${int(r.hottest)} (${pct(r.hottest / 100_000, 0)})` },
        { label: "busiest reducer / mean", value: fixed(r.imbalance, 2) },
        { label: "reduce-phase speedup", value: `${fixed(r.speedup, 1)} of ${reducers}` },
      ]} />
      <Banner tone={r.imbalance > 2 ? "bad" : "good"}>
        100,000 records, 1,000 keys, 16 mappers, keys hashed to reducers. {combiner
          ? "Each mapper sends one record per key it saw, so a hot key costs at most 16 records."
          : "Every record of the hottest key goes to one reducer. More reducers cannot split it."}
      </Banner>
    </Demo>
  );
}
