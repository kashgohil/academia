/** Demos for "Concurrent GC and write barriers": interleave a mutator and a marker by hand, and many random runs. */
import { useState } from "react";
import {
  Banner, Btn, ButtonRow, Controls, Demo, MiniTable, SectionLabel, Stats, fixed, range, seg, toggle, useChunked, useParams,
} from "../../kit";
import {
  CONC_POS, HEAP_SCENARIO, STACK_SCENARIO, barrierTrials, concInit, markerStep, mutatorStep, opText, verdict, type Barrier, type ConcState,
} from "../../sims/sys/gc";
import { GcCode, GcGraph, GcLog, type NodeTone } from "./SysGcUi";

const SCENARIOS = { heap: HEAP_SCENARIO, stack: STACK_SCENARIO };
export const BARRIER_LABEL: Record<Barrier, string> = { none: "none", dijkstra: "Dijkstra (insert)", yuasa: "Yuasa (delete)", hybrid: "Go hybrid" };

export function InterleaveDemo({ id = "sys-gc-interleave", barrier: b0 = "none", scenario: s0 = "heap" }: { id?: string; barrier?: Barrier; scenario?: "heap" | "stack" }) {
  const P = useParams(id, {
    scenario: seg<"heap" | "stack">("Scenario", [["heap", "pointer into a black object"], ["stack", "pointer hidden on the stack"]], s0),
    barrier: seg<Barrier>("Write barrier", [["none", "none"], ["dijkstra", "Dijkstra"], ["yuasa", "Yuasa"], ["hybrid", "Go hybrid"]], b0),
    rescan: toggle({ label: "Dijkstra: rescan stacks at the end, world stopped", default: false }),
  });
  const { scenario, barrier, rescan } = P.values;
  const sc = SCENARIOS[scenario];
  const key = `${scenario}|${barrier}|${rescan}`;
  const [st, setSt] = useState<{ key: string; s: ConcState }>({ key, s: concInit(sc) });
  const s = st.key === key ? st.s : concInit(sc);
  const set = (n: ConcState) => setSt({ key, s: n });
  const v = s.done ? verdict(s) : null;
  const tone = (oid: number): NodeTone => (s.freed.includes(oid) ? (v?.lost.includes(sc.g.objs.find((o) => o.id === oid)!.name) ? "leaked" : "freed") : s.color[oid]!);
  const nextOp = sc.ops[s.opIdx];
  const finish = () => {
    let n = s, guard = 0;
    while (!n.done && guard++ < 100) n = markerStep(n, sc, barrier, rescan);
    set(n);
  };
  return (
    <Demo title="You schedule the mutator and the marker" controls={<Controls params={P} />}>
      <GcGraph g={s.g} pos={CONC_POS} tone={tone} height={150} minWidth={300}
        edgeTone={(e) => (s.freed.includes(e.to) ? "var(--c4)" : undefined)}
        legend={["white", "gray", "black", "freed", "leaked"]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>Mutator script ({sc.stack.join(", ")} is a stack slot: no barrier)</SectionLabel>
          <GcCode lines={sc.ops.map((o, i) => `${i < s.opIdx ? "✓" : " "} ${opText(o)}`)} at={s.opIdx < sc.ops.length ? s.opIdx : null} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>What happened</SectionLabel>
          <GcLog height={110} items={s.log.map((l) => ({ text: `${l.who}: ${l.text}`, color: l.who === "mutator" ? "var(--c1)" : l.who === "barrier" ? "var(--c2)" : "var(--fg)" }))} />
        </div>
      </div>
      <ButtonRow style={{ marginTop: 10 }}>
        <Btn onClick={() => set(mutatorStep(s, sc, barrier))} disabled={s.done || !nextOp}>Mutator: {nextOp ? opText(nextOp) : "done"}</Btn>
        <Btn onClick={() => set(markerStep(s, sc, barrier, rescan))} disabled={s.done}>Marker: one step</Btn>
        <Btn onClick={finish} disabled={s.done}>Marker: finish</Btn>
        <Btn ghost onClick={() => set(concInit(sc))}>Reset</Btn>
      </ButtonRow>
      {v ? (
        v.lost.length
          ? <Banner tone="bad">Lost object: {v.lost.join(", ")} was freed, but a live pointer still reaches it. The next load through that pointer reads freed memory.</Banner>
          : <Banner tone="good">No object lost.{v.floating.length ? ` Floating garbage: ${v.floating.join(", ")} is unreachable but survives until the next cycle.` : ""}</Banner>
      ) : <Banner tone="plain">Marker steps so far: {s.log.filter((l) => l.who === "marker").length}. Barrier shades: {s.shades}.</Banner>}
    </Demo>
  );
}

const TRIALS = {
  pm: range({ label: "Mutator share of the steps", min: 0.3, max: 0.9, step: 0.1, default: 0.7, format: (v) => `${Math.round(v * 100)}%` }),
};
const CONFIGS: { label: string; barrier: Barrier; rescan: boolean }[] = [
  { label: "none", barrier: "none", rescan: false },
  { label: "Dijkstra, no stack rescan", barrier: "dijkstra", rescan: false },
  { label: "Dijkstra + STW stack rescan", barrier: "dijkstra", rescan: true },
  { label: "Yuasa", barrier: "yuasa", rescan: false },
  { label: "Go hybrid", barrier: "hybrid", rescan: false },
];
export const TRIAL_COUNT = 1000;

export function BarrierTrialsDemo() {
  const P = useParams("sys-gc-trials", TRIALS);
  const pm = P.values.pm;
  const res = useChunked(`trials-${pm}`, CONFIGS.map((c) => () => barrierTrials(c.barrier, TRIAL_COUNT, 1, c.rescan, { pm })), { keep: true });
  return (
    <Demo title={`${TRIAL_COUNT} random interleavings per barrier`} controls={<Controls params={P} />}>
      <MiniTable
        head={["barrier", "runs that lost an object", "floating garbage per run", "barrier shades per run", "stack rescans"]}
        rows={CONFIGS.map((c, i) => {
          const r = res[i];
          if (!r) return [c.label, "…", "…", "…", "…"];
          return [c.label, <b style={{ color: r.lostRuns ? "var(--c4)" : "var(--c3)" }}>{r.lostRuns}</b>, fixed(r.floating / r.trials), fixed(r.shades / r.trials), r.rescan];
        })}
      />
      <Stats items={[{ label: "objects per graph", value: 6 }, { label: "mutator writes per run", value: 12 }, { label: "runs per row", value: TRIAL_COUNT }]} />
      <Banner tone="info">
        Each run builds a random graph and a random legal script: every write copies a pointer that the mutator can reach. The marker scans the roots first; then the two take turns at random. The same seeds are used in every row.
      </Banner>
    </Demo>
  );
}
