/** Demos for "Reference counting": build and cut pointers with live counts, trial deletion, and the cost of a count. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Controls, Demo, Legend, Meter, Param, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, fixed, mono, range, useParams, useStepper,
} from "../../kit";
import {
  RC_BENCH, RC_PRESETS, nameOf, rcBench, rcInit, rcLeaked, rcStore, toMachine, trialDeletion, trialPreset, type BrColor, type Graph, type RcEvent, type RcState, type Slot,
} from "../../sims/sys/gc";
import { UbBanner } from "./SysViews";
import { GcGraph, GcLog, TONE_COLOR, type NodeTone } from "./SysGcUi";

/** The preset objects, with the freed ones still drawn (without pointers) at their places. */
function shown(base: Graph, s: RcState): Graph {
  return {
    roots: s.g.roots,
    objs: base.objs.map((o) => s.g.objs.find((x) => x.id === o.id) ?? { ...o, fields: o.fields.map(() => null) }),
  };
}

const slotKey = (s: Slot) => ("root" in s ? `r:${s.root}` : `o:${s.obj}:${s.field}`);

export function RcBuildDemo() {
  const [preset, setPreset] = useState(RC_PRESETS[2]!.id);
  const base = RC_PRESETS.find((p) => p.id === preset)!;
  const [state, setState] = useState<RcState>(() => rcInit(base.g));
  const [events, setEvents] = useState<RcEvent[]>([]);
  const [updates, setUpdates] = useState(0);
  const [dst, setDst] = useState("r:r");
  const [to, setTo] = useState("1");
  const load = (id: string) => {
    const p = RC_PRESETS.find((x) => x.id === id)!;
    setPreset(id); setState(rcInit(p.g)); setEvents([]); setUpdates(0); setDst("r:r"); setTo("1");
  };
  const store = (slot: Slot, target: number | null) => {
    const r = rcStore(state, slot, target);
    setState(r.state); setEvents(r.events); setUpdates((u) => u + r.events.filter((e) => e.kind !== "free").length);
  };
  const g = shown(base.g, state);
  const leaked = rcLeaked(state);
  const tone = (id: number): NodeTone => (state.rc[id] === undefined ? "freed" : leaked.includes(id) ? "leaked" : "live");
  const slots: { key: string; slot: Slot; label: string }[] = [
    ...state.g.roots.map((r) => ({ key: slotKey({ root: r.name }), slot: { root: r.name } as Slot, label: `root ${r.name}` })),
    ...state.g.objs.flatMap((o) => o.fields.map((_, i) => ({ key: slotKey({ obj: o.id, field: i }), slot: { obj: o.id, field: i } as Slot, label: `${o.name}.f${i}` }))),
  ];
  const cur = slots.find((s) => s.key === dst) ?? slots[0]!;
  const targets = [{ value: "null", label: "null" }, ...state.g.objs.map((o) => ({ value: String(o.id), label: o.name }))];
  const tgt = targets.some((t) => t.value === to) ? to : "null";
  const lsan = useMemo(() => (leaked.length ? toMachine(state.g, { exit: true }).m.ub : []), [state, leaked.length]);
  return (
    <Demo title="Reference counts: cut a pointer, watch the cascade" controls={
      <ButtonRow>
        {RC_PRESETS.map((p) => <Btn key={p.id} on={p.id === preset} onClick={() => load(p.id)}>{p.label}</Btn>)}
      </ButtonRow>
    }>
      <GcGraph g={g} pos={base.pos} height={150} tone={tone} badge={(id) => (state.rc[id] === undefined ? undefined : String(state.rc[id]))}
        onEdge={(e) => store(typeof e.from === "string" ? { root: e.from } : { obj: e.from, field: e.field }, null)}
        legend={["live", "freed", "leaked"]} extra={<span className="muted" style={{ fontSize: 12 }}>badge = reference count</span>} />
      <SectionLabel>Store a pointer</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <Param spec={{ kind: "select", label: "Slot", options: slots.map((s) => ({ value: s.key, label: s.label })), default: cur.key }} value={cur.key} onChange={(v) => setDst(v as string)} />
        <Param spec={{ kind: "select", label: "= object", options: targets, default: "null" }} value={tgt} onChange={(v) => setTo(v as string)} />
        <Btn onClick={() => store(cur.slot, tgt === "null" ? null : Number(tgt))}>Store</Btn>
      </div>
      <SectionLabel>What the last store did (increment first, then decrement)</SectionLabel>
      <GcLog height={96} items={events.map((e) => ({
        text: <span style={{ paddingLeft: 12 * e.depth }}>{e.kind === "free" ? `free ${nameOf(base.g, e.id)}: decrement its fields` : `${e.kind === "inc" ? "+1" : "−1"} ${nameOf(base.g, e.id)} → ${e.count}`}</span>,
        color: e.kind === "free" ? "var(--c4)" : e.kind === "inc" ? "var(--c3)" : "var(--c2)",
      }))} />
      <Stats items={[
        { label: "objects freed", value: state.freed.length },
        { label: "leaked (count > 0, no root reaches them)", value: leaked.length },
        { label: "count updates so far", value: updates },
      ]} />
      {leaked.length > 0 ? (
        <>
          <Banner tone="bad">
            {leaked.map((id) => nameOf(base.g, id)).join(", ")} {leaked.length === 1 ? "is" : "are"} unreachable, but each count is above zero, because the cycle holds itself. Reference counting alone never frees {leaked.length === 1 ? "it" : "them"}.
          </Banner>
          <SectionLabel>The same heap in the shared machine, checked at exit()</SectionLabel>
          <UbBanner event={lsan[0]} />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{lsan.length} leak report{lsan.length === 1 ? "" : "s"} in total.</div>
        </>
      ) : <Banner tone="good">Every object is reachable or freed. Click a pointer to cut it.</Banner>}
    </Demo>
  );
}

const BR_TONE: Record<BrColor, NodeTone> = { black: "live", gray: "gray", white: "leaked", purple: "purple" };

export function TrialDeletionDemo() {
  const { state, pos, frames } = useMemo(() => { const p = trialPreset(); return { ...p, frames: trialDeletion(p.state) }; }, []);
  const s = useStepper(frames.length, 1.5);
  const f = frames[s.i]!;
  const g: Graph = { roots: state.g.roots, objs: state.g.objs };
  const tone = (id: number): NodeTone => (f.freed.includes(id) ? "freed" : BR_TONE[f.color[id] ?? "black"]);
  return (
    <Demo title="Trial deletion: subtract the inside counts" controls={<><StepButtons s={s} /><StepSlider s={s} /></>}>
      <GcGraph g={g} pos={pos} tone={tone} badge={(id) => (f.rc[id] === undefined ? undefined : String(f.rc[id]))} focus={f.focus} height={170} />
      <Legend items={[
        { label: "black: in use", color: TONE_COLOR.live }, { label: "purple: candidate root", color: TONE_COLOR.purple },
        { label: "gray: trial count", color: TONE_COLOR.gray }, { label: "white: garbage", color: TONE_COLOR.leaked }, { label: "freed", color: TONE_COLOR.freed },
      ]} />
      <StepCaption label={f.phase}>{f.text}</StepCaption>
    </Demo>
  );
}

const THREADS = [1, 2, 4, 8];
const RSPEC = { t: range({ label: "Threads", min: 0, max: 3, step: 1, default: 3, format: (v) => String(THREADS[v]) }) };

export function RcCostDemo() {
  const P = useParams("sys-gc-rccost", RSPEC);
  const t = THREADS[P.values.t]!;
  const b = rcBench(t);
  const max = rcBench(8).shared;
  const walk = (ns: number) => (1_000_000 * ns) / 1e6; // 1,000,000 steps of ns each, in ms
  const runs = RC_BENCH.arcShared[t]!;
  return (
    <Demo title="Measured: one increment and one decrement" controls={<Controls params={P} />}>
      <div style={{ display: "grid", gap: 2 }}>
        <Meter label="Rc: plain add and subtract (one thread)" value={b.rc} max={max} log color="var(--c3)" text={`${fixed(b.rc)} ns`} />
        <Meter label={`Arc, each thread has its own (${t} thread${t > 1 ? "s" : ""})`} value={b.own} max={max} log color="var(--c1)" text={`${fixed(b.own)} ns`} />
        <Meter label={`Arc, all threads clone the same one (${t} thread${t > 1 ? "s" : ""})`} value={b.shared} max={max} log color="var(--c4)" text={`${fixed(b.shared)} ns`} />
      </div>
      <Stats items={[
        { label: "1,000,000-node walk, counted cursor, shared Arc", value: `${fixed(walk(b.shared))} ms` },
        { label: "same walk with a borrowed cursor", value: "0 count updates" },
        { label: "shared / own", value: `${fixed(b.shared / b.own, 1)}×` },
      ]} />
      <Note3 runs={runs} t={t} />
    </Demo>
  );
}

function Note3({ runs, t }: { runs: number[]; t: number }) {
  return (
    <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
      ns per clone and drop, rustc 1.96.1 -O, Apple M4 Pro, median of three runs (shared, {t} thread{t > 1 ? "s" : ""}: <span style={mono}>{runs.map((x) => fixed(x)).join(", ")}</span> ns). The bars use a log scale. Other jobs loaded the machine, so the contended numbers vary by up to {fixed(Math.max(...runs) / Math.min(...runs), 1)}×.
    </p>
  );
}
