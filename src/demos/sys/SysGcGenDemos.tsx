/** Demos for "Generational GC": a lifetime model of minor and major work, and a card-marking write barrier. */
import { useMemo } from "react";
import {
  Banner, Controls, Demo, Legend, Line, Meter, Plot, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, bytes, pct, range, toggle, useParams, useStepper, tint, mono,
} from "../../kit";
import { CARD, GEN_DEFAULTS, OLD_BASE, cardFrames, genSim, type CardFrame, type Graph } from "../../sims/sys/gc";
import { GcCode, GcGraph, type NodeTone } from "./SysGcUi";

const LIFE = {
  young: range({ label: "Objects that die young", min: 0.5, max: 0.99, step: 0.01, default: GEN_DEFAULTS.young, format: (v) => `${Math.round(v * 100)}%` }),
  youngLife: range({ label: "Mean life of a young-dying object, KiB allocated", min: 4, max: 512, step: 4, default: GEN_DEFAULTS.youngLife }),
  nursery: range({ label: "Nursery size, KiB", min: 64, max: 4096, step: 64, default: GEN_DEFAULTS.nursery }),
};

export function LifetimeDemo() {
  const P = useParams("sys-gc-life", LIFE);
  const { young, youngLife, nursery } = P.values;
  const r = useMemo(() => genSim({ ...GEN_DEFAULTS, young, youngLife, nursery }), [young, youngLife, nursery]);
  const maxW = Math.max(r.genWork, r.full.work);
  const maxP = Math.max(r.maxMinor, r.maxMajor, r.full.maxPause);
  const yMax = Math.max(...r.trace.map((p) => p[1])) * 1.1;
  return (
    <Demo title="Most objects die young: collect where they die" controls={<Controls params={P} />}>
      <Plot x={[0, GEN_DEFAULTS.total]} y={[0, yMax]} height={190} xLabel="KiB allocated" yLabel="KiB in use (generational)">
        <Line points={r.trace} color="var(--c1)" width={1.2} />
      </Plot>
      <Stats items={[
        { label: "minor collections", value: r.minors },
        { label: "survival rate of a minor", value: pct(r.survival) },
        { label: "major collections", value: r.majors },
        { label: "promoted, then died old", value: bytes(r.promotedDied) },
      ]} />
      <SectionLabel>Total work: bytes copied or marked</SectionLabel>
      <Meter label="generational: minor copies + major marks" value={r.genWork} max={maxW} color="var(--c3)" text={bytes(r.genWork)} />
      <Meter label={`non-generational mark-sweep, same peak memory (${r.full.gcs} collections)`} value={r.full.work} max={maxW} color="var(--c1)" text={bytes(r.full.work)} />
      <SectionLabel>Largest single collection: a proxy for the pause</SectionLabel>
      <Meter label="largest minor" value={r.maxMinor} max={maxP} color="var(--c3)" text={bytes(r.maxMinor)} />
      <Meter label="largest major" value={r.maxMajor} max={maxP} color="var(--c2)" text={bytes(r.maxMajor)} />
      <Meter label="largest non-generational" value={r.full.maxPause} max={maxP} color="var(--c1)" text={bytes(r.full.maxPause)} />
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
        Model inputs: {GEN_DEFAULTS.total / 1024} MiB of {GEN_DEFAULTS.objSize}-byte objects; the long-lived ones have a mean life of {GEN_DEFAULTS.oldLife / 1024} MiB allocated. Survivors are promoted after one minor collection. A major collection runs when the old generation doubles.
      </p>
    </Demo>
  );
}

const CARD_SPEC = { barrier: toggle({ label: "Card-marking write barrier", default: false }) };

const NAMES = ["O0", "O1", "O2", "O3", "O4", "O5", "O6", "O7", "Y1", "Y2", "Y3"];
const POS: Record<string, { x: number; y: number }> = Object.fromEntries([
  ...Array.from({ length: 8 }, (_, i) => [`O${i}`, { x: 0.12 + (i % 4) * 0.27, y: i < 4 ? 0 : 0.4 }] as const),
  ["Y1", { x: 0.15, y: 0.95 }], ["Y2", { x: 0.45, y: 0.95 }], ["Y3", { x: 0.75, y: 0.95 }],
]);

function asGraph(f: CardFrame): Graph {
  const id = (n: string | null) => (n === null ? null : NAMES.indexOf(n) + 1);
  return {
    objs: f.objs.map((o) => ({ id: id(o.name)!, name: o.name, size: o.size, fields: o.fields.map(id) })),
    roots: Object.entries(f.roots).map(([name, to]) => ({ name, to: id(to) })),
  };
}

export function CardTableDemo() {
  const P = useParams("sys-gc-cards", CARD_SPEC);
  const frames = useMemo(() => cardFrames(P.values.barrier), [P.values.barrier]);
  const s = useStepper(frames.length, 1);
  const f = frames[s.i]!;
  const g = asGraph(f);
  const all: Graph = { roots: g.roots, objs: [...g.objs, ...f.freed.map((n) => ({ id: NAMES.indexOf(n) + 1, name: n, size: 32, fields: [null, null] }))] };
  const nameOf = (id: number) => NAMES[id - 1]!;
  const tone = (id: number): NodeTone => {
    const n = nameOf(id);
    if (f.freed.includes(n)) return "freed";
    if (f.scanned.includes(n)) return "gray";
    if (n.startsWith("Y")) return f.live.includes(n) ? "black" : "live";
    return "plain";
  };
  const cards = [0, 1, 2, 3];
  return (
    <Demo title="An old-to-young pointer and the card table" controls={<><Controls params={P} /><StepButtons s={s} /><StepSlider s={s} /></>}>
      <GcGraph g={all} pos={POS} tone={tone} height={190} minWidth={320}
        edgeTone={(e) => (f.freed.includes(nameOf(e.to)) ? "var(--c4)" : undefined)} />
      <Legend items={[
        { label: "old object", color: "var(--c1)" }, { label: "young object", color: "var(--c3)" }, { label: "read by the minor GC (dirty card)", color: "var(--c2)" },
        { label: "found live", color: "var(--fg)" }, { label: "freed", color: "var(--faint)" },
      ]} />
      <SectionLabel>Card table: one byte per {CARD} bytes of the old generation</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4, ...mono, fontSize: 11.5 }}>
        {cards.map((c) => {
          const dirty = f.dirty.includes(c);
          return (
            <div key={c} style={{ border: `1.5px solid ${dirty ? "var(--c2)" : "var(--border)"}`, background: dirty ? tint("var(--c2)", 30) : "var(--subtle)", borderRadius: 4, padding: "3px 4px", textAlign: "center" }}>
              card {c}: {dirty ? "dirty" : "clean"}<br /><span className="muted">O{2 * c}, O{2 * c + 1}</span>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>Card k covers the 512 bytes from {`0x${OLD_BASE.toString(16)}`} + 512 · k. The old objects are 256 bytes each, so two share a card. The minor collection reads every object on a dirty card.</p>
      <SectionLabel>Mutator code at this step</SectionLabel>
      <GcCode lines={(f.code ?? "…").split("\n")} />
      <StepCaption tone={f.dangling.length ? "bad" : f.phase === "done" ? "good" : undefined} label={f.phase}>{f.text}</StepCaption>
      {f.phase === "done" && f.dangling.length > 0 && <Banner tone="bad">Turn on the barrier and step again.</Banner>}
    </Demo>
  );
}
