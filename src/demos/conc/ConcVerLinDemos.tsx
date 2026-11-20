/** Demos for "linearizability": drag linearization points, the Herlihy-Wing queue, and checking random histories. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, MiniTable, Note, Param, SectionLabel, Stats, int, range, seg, useChunked, useParams } from "../../kit";
import {
  HW_FAI_WRONG, HW_STORE_WRONG, LIN_PRESETS, findOrder, hwDemo, hwEvents, hwRuleCheck, multiSpec, opLabel, pointsForOrder,
  producersConsumers, queueSpec, randomHistory, replayPoints, subHistory, type HistOp, type ImplName,
} from "../../sims/conc/verification";
import { threadColor } from "./ConcViews";
import { HistoryView } from "./ConcVerUi";
import { Cell, CellRow, SyncStepper } from "../os/SyncShared";

// ---------------------------------------------------------------- 1. drag the points

type PresetKey = keyof typeof LIN_PRESETS;
const PRESET = { h: seg<PresetKey>("History", [["overlap", "Overlap"], ["outOfOrder", "Out of order"], ["staleEmpty", "Stale empty"], ["twoQueues", "Two queues"]], "overlap") };

const mid = (ops: HistOp[]) => Object.fromEntries(ops.map((o) => [o.id, (o.call + o.ret) / 2]));
const yes = (b: boolean | null) => (b === null ? "budget hit" : b ? "yes" : "no");

export function ConcVerLinPointsDemo() {
  const P = useParams("conc-ver-points", PRESET);
  const preset = LIN_PRESETS[P.values.h];
  const [pts, setPts] = useState<{ key: string; p: Record<number, number> }>({ key: P.values.h, p: mid(preset.ops) });
  const points = pts.key === P.values.h ? pts.p : mid(preset.ops);
  const setPoint = (id: number, t: number) => setPts({ key: P.values.h, p: { ...points, [id]: t } });
  const spec = useMemo(() => multiSpec(preset.objs, queueSpec), [preset]);
  const replay = replayPoints(preset.ops, points, spec);
  const lin = useMemo(() => findOrder(preset.ops, spec, "linearizable"), [preset, spec]);
  const sc = useMemo(() => findOrder(preset.ops, spec, "sequential"), [preset, spec]);
  const perObj = useMemo(() => preset.objs.length > 1 ? preset.objs.map((o) => ({ o, lin: findOrder(subHistory(preset.ops, o), queueSpec, "linearizable").ok, sc: findOrder(subHistory(preset.ops, o), queueSpec, "sequential").ok })) : [], [preset]);
  const byId = new Map(preset.ops.map((o) => [o.id, o]));
  const bad = replay.steps.find((s) => !s.ok);
  const multi = preset.objs.length > 1;
  return (
    <Demo
      title="Place the linearization points"
      actions={
        <ButtonRow>
          <Btn onClick={() => lin.ok && setPts({ key: P.values.h, p: pointsForOrder(preset.ops, lin.order) })} disabled={!lin.ok}>Show a valid order</Btn>
          <Btn ghost onClick={() => setPts({ key: P.values.h, p: mid(preset.ops) })}>Reset</Btn>
        </ButtonRow>
      }
      controls={<Param spec={PRESET.h} value={P.values.h} onChange={(v) => P.set("h", v as PresetKey)} />}
    >
      <HistoryView ops={preset.ops} threads={preset.threads} t0={0} t1={100} points={points} onDrag={setPoint} withObj={multi} mark={bad ? { [bad.id]: "var(--c4)" } : undefined} axisLabel="time →" />
      <SectionLabel>Your order (the points from left to right)</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {[...preset.ops].sort((a, b) => points[a.id]! - points[b.id]!).map((o, i) => {
          const st = replay.steps.find((s) => s.id === o.id);
          return (
            <span key={o.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              {i > 0 && <span className="muted" style={{ fontSize: 11 }}>→</span>}
              <Chip color={st ? (st.ok ? threadColor(o.thread) : "var(--c4)") : "var(--faint)"} faint={!st} strike={st && !st.ok}>{opLabel(o, multi)}</Chip>
            </span>
          );
        })}
      </div>
      <Banner tone={replay.ok ? "good" : "bad"}>
        {replay.ok
          ? <>These points give a legal queue run. Final state: {replay.steps.at(-1)?.state}.</>
          : <>Illegal at {opLabel(byId.get(bad!.id)!, multi)}: {bad!.why}. State before it: {bad!.state}. Drag the points.</>}
      </Banner>
      <Stats items={[
        { label: "linearizable (search)", value: yes(lin.ok) },
        { label: "sequentially consistent", value: yes(sc.ok) },
        { label: "configurations searched", value: int(lin.explored) },
        ...perObj.flatMap((x) => [{ label: `${x.o} alone: lin. / seq. cons.`, value: `${yes(x.lin)} / ${yes(x.sc)}` }]),
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- 2. the Herlihy-Wing queue

const HW = hwDemo();
const ids = (s: readonly number[]) => s.map((t) => `T${t}`);

export function ConcVerHwQueueDemo() {
  return (
    <SyncStepper
      title="The Herlihy–Wing queue: no fixed linearization point"
      prog={HW.prog}
      hideRegs={["k"]}
      scripts={[
        { label: "Increment order is wrong", schedule: ids(HW_FAI_WRONG) },
        { label: "Store order is wrong", schedule: ids(HW_STORE_WRONG) },
      ]}
      panel={({ s, log }) => <HwPanel mem={s.mem} sched={log.map((l) => l.thread)} />}
    />
  );
}

function HwPanel({ mem, sched }: { mem: Record<string, number>; sched: number[] }) {
  const ev = useMemo(() => hwEvents(HW, sched), [sched]);
  const done = ev.ops.length === 3 && ev.ops.every((o) => o.ret !== Infinity);
  const rules = done ? (["fai", "store"] as const).map((r) => hwRuleCheck(HW, sched, r)) : null;
  const check = done ? findOrder(ev.ops, queueSpec) : null;
  const ticks: [number, number, string][] = [
    ...Object.entries(ev.fai).map(([id, t]) => [Number(id), t + 0.5, "inc"] as [number, number, string]),
    ...Object.entries(ev.store).map(([id, t]) => [Number(id), t + 0.5, "store"] as [number, number, string]),
    ...Object.entries(ev.take).map(([id, t]) => [Number(id), t + 0.5, "take"] as [number, number, string]),
  ];
  const ops = ev.ops.map((o) => ({ ...o, call: o.call, ret: o.ret === Infinity ? Infinity : o.ret + 1 }));
  const show = (r: { ok: boolean; why?: string }) => (r.ok ? "legal" : `illegal: ${r.why}`);
  return (
    <div>
      <CellRow>
        <Cell name="back" value={mem.back} />
        <Cell name="items[0]" value={mem.items0 ? mem.items0 : "null"} />
        <Cell name="items[1]" value={mem.items1 ? mem.items1 : "null"} />
      </CellRow>
      <SectionLabel>History (time = step number)</SectionLabel>
      <HistoryView ops={ops} threads={3} t0={0} t1={Math.max(9, sched.length + 1)} ticks={ticks} now={sched.length} />
      {rules && check ? (
        <MiniTable
          head={["Linearization point of enq", "Result"]}
          rows={[
            ["at its increment (inc)", show(rules[0]!)],
            ["at its store", show(rules[1]!)],
            ["search over all orders", check.ok ? "linearizable" : "not linearizable"],
          ]}
          highlight={(i) => i < 2 && !rules[i]!.ok}
        />
      ) : <Note>Run all three threads to the end. Then the table tests two fixed rules for the point of enq.</Note>}
    </div>
  );
}

// ---------------------------------------------------------------- 3. random histories

const RAND = {
  impl: seg<ImplName>("Queue", [["lock", "spinlock"], ["spsc", "SPSC array"], ["hw", "Herlihy–Wing"]], "spsc"),
  prod: range({ label: "Producers", min: 1, max: 2, step: 1, default: 2 }),
  cons: range({ label: "Consumers", min: 1, max: 2, step: 1, default: 1 }),
  ops: range({ label: "Operations per thread", min: 1, max: 3, step: 1, default: 2 }),
};
const RUNS = 200;
const CHUNK = 20;

interface RunVerdict { seed: number; ok: boolean | null; explored: number; finished: boolean }

export function ConcVerRandomHistoryDemo() {
  const P = useParams("conc-ver-random", RAND);
  const { impl, prod, cons, ops } = P.values;
  const program = useMemo(() => producersConsumers(impl, prod, cons, ops), [impl, prod, cons, ops]);
  const jobs = useMemo(() => Array.from({ length: RUNS / CHUNK }, (_, c) => () => {
    const out: RunVerdict[] = [];
    for (let i = 0; i < CHUNK; i++) {
      const seed = 1 + c * CHUNK + i;
      const r = randomHistory(program, seed);
      const done = r.ops.filter((o) => o.ret !== Infinity);
      const v = findOrder(done, queueSpec);
      out.push({ seed, ok: v.ok, explored: v.explored, finished: r.finished });
    }
    return out;
  }), [program]);
  const chunks = useChunked(`${impl}/${prod}/${cons}/${ops}`, jobs);
  const results = chunks.flatMap((c) => c ?? []);
  const failing = results.filter((r) => r.ok === false);
  const [picked, setPicked] = useState<number | null>(null);
  const seed = picked !== null && results.some((r) => r.seed === picked && r.ok === false) ? picked : failing[0]?.seed ?? null;
  const shown = useMemo(() => {
    if (seed === null) return null;
    const r = randomHistory(program, seed);
    const done = r.ops.filter((o) => o.ret !== Infinity);
    return { ops: done, steps: r.steps, check: findOrder(done, queueSpec) };
  }, [program, seed]);
  const byId = new Map(shown?.ops.map((o) => [o.id, o]));
  return (
    <Demo
      title="Check random histories"
      controls={
        <>
          <Param spec={RAND.impl} value={impl} onChange={(v) => { setPicked(null); P.set("impl", v as ImplName); }} />
          <Param spec={RAND.prod} value={prod} onChange={(v) => { setPicked(null); P.set("prod", v as number); }} />
          <Param spec={RAND.cons} value={cons} onChange={(v) => { setPicked(null); P.set("cons", v as number); }} />
          <Param spec={RAND.ops} value={ops} onChange={(v) => { setPicked(null); P.set("ops", v as number); }} />
        </>
      }
    >
      <SectionLabel>{RUNS} runs with a seeded random scheduler (click a red square)</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(11px, 1fr))", gap: 2 }}>
        {Array.from({ length: RUNS }, (_, i) => {
          const r = results[i];
          const color = !r ? "var(--subtle)" : r.ok === false ? "var(--c4)" : r.ok === null ? "var(--c2)" : "color-mix(in srgb, var(--c3) 55%, var(--bg))";
          return (
            <div
              key={i}
              title={r ? `seed ${r.seed}: ${r.ok === false ? "not linearizable" : "passes"}` : ""}
              onClick={() => r?.ok === false && setPicked(r.seed)}
              style={{ height: 11, borderRadius: 2, background: color, cursor: r?.ok === false ? "pointer" : undefined, outline: r && r.seed === seed ? "2px solid var(--fg)" : undefined }}
            />
          );
        })}
      </div>
      <Stats items={[
        { label: "runs checked", value: `${results.length} of ${RUNS}` },
        { label: "not linearizable", value: int(failing.length) },
        { label: "first failing seed", value: failing[0] ? failing[0].seed : "none" },
        { label: "most configurations in one check", value: int(Math.max(0, ...results.map((r) => r.explored))) },
      ]} />
      {impl === "hw" && cons > prod && <Note>Here consumers outnumber producers. A Herlihy–Wing deq waits forever on an empty queue, so some deqs never return. The checker treats them as pending and drops them.</Note>}
      {shown && seed !== null ? (
        <>
          <SectionLabel>Seed {seed}: no valid order exists</SectionLabel>
          <HistoryView ops={shown.ops} threads={prod + cons} names={program.prog.names} t0={0} t1={shown.steps} axisLabel="step →" />
          <Banner tone="bad">
            Longest legal prefix: {shown.check.best.length ? shown.check.best.map((id) => opLabel(byId.get(id)!)).join(", ") : "none"}. Then every candidate fails. {shown.check.why[0] ?? ""}.
          </Banner>
        </>
      ) : results.length === RUNS ? <Banner tone="good">Every history of these {RUNS} runs has a valid order. That is evidence, not proof.</Banner> : null}
    </Demo>
  );
}
