import { useMemo } from "react";
import { Demo, Stats, Controls, Plot, Line, Dots, Legend, RuleX, useParams, range, toggle } from "../kit";
import { simulateCas } from "../sims/cas";

const schema = {
  threads: range({ label: "Threads", min: 1, max: 16, step: 1, default: 8 }),
  backoff: toggle({ label: "Exponential backoff after a failed CAS", default: false }),
};

const NS = Array.from({ length: 16 }, (_, i) => i + 1);

export function CasContentionDemo() {
  const params = useParams("cas", schema);
  const { threads, backoff } = params.values;
  const curves = useMemo(() => ({
    plain: NS.map((n) => [n, simulateCas(n, 200, false)] as [number, number]),
    backoff: NS.map((n) => [n, simulateCas(n, 200, true)] as [number, number]),
  }), []);
  const cur = (backoff ? curves.backoff : curves.plain)[threads - 1]![1];

  return (
    <Demo title="CAS retry loops under contention" controls={<Controls params={params} />}>
      <Stats
        items={[
          { label: "CAS attempts per increment", value: cur.toFixed(2) },
          { label: "failed CAS per increment", value: (cur - 1).toFixed(2) },
          { label: "fetch_add ops per increment", value: "1.00" },
        ]}
      />
      <div style={{ height: 10 }} />
      <Plot x={[1, 16]} y={[0, Math.ceil(Math.max(...curves.plain.map((p) => p[1])) + 0.5)]} height={220} xLabel="threads" yLabel="attempts / increment" xTicks={[1, 2, 4, 8, 12, 16]}>
        <Line points={NS.map((n) => [n, 1] as [number, number])} color="var(--c3)" width={1.5} dash="4 3" />
        <Line points={curves.plain} color="var(--c4)" width={1.75} />
        <Dots points={curves.plain} color="var(--c4)" r={2} />
        <Line points={curves.backoff} color="var(--c1)" width={1.75} />
        <Dots points={curves.backoff} color="var(--c1)" r={2} />
        <RuleX at={threads} />
      </Plot>
      <Legend items={[{ label: "CAS loop", color: "var(--c4)" }, { label: "CAS loop + backoff", color: "var(--c1)" }, { label: "fetch_add", color: "var(--c3)" }]} />
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
        Each thread repeatedly loads the counter and then tries <code>compare_exchange(old, old + 1)</code>. Any other thread's success between those two steps makes it fail.
      </p>
    </Demo>
  );
}
