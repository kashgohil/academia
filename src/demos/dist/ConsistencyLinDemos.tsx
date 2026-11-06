/** Demos for the lesson on linearizability: a history editor with a live checker, and stale reads on Net. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Param, SmallLabel, Stats, fixed, int, range, seg, useParams, useWidth } from "../../kit";
import {
  EDITOR_PRESETS, checkLinearizable, linearizationPoints, opLabel, provablyStaleReads, registerModel, runStore, storeMsgLabel,
  type HOp, type ReadPath,
} from "../../sims/dist/consistency";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { HistoryView, type OpMark } from "./ConsistencyUi";

const T_MAX = 100;

const EDIT_SCHEMA = { preset: seg("Start from", EDITOR_PRESETS.map((p) => [p.id, p.name] as [string, string]), "inversion") };

const fmt = (o: HOp) => opLabel(o, false).replace(/^w\((\d+)\)$/, "w $1").replace(/^r\(\)=/, "r → ");

/** Clamps a drag so that the operation stays in [0, T_MAX] and does not overlap its neighbours in the same lane. */
function clampDrag(ops: HOp[], id: number, call: number, ret: number): HOp[] {
  const o = ops.find((x) => x.id === id)!;
  const lane = ops.filter((x) => x.client === o.client && x.id !== id);
  const prevEnd = Math.max(0, ...lane.filter((x) => x.call < o.call).map((x) => x.ret + 1));
  const nextStart = Math.min(T_MAX, ...lane.filter((x) => x.call > o.call).map((x) => x.call - 1));
  const len = o.ret - o.call;
  let c = call, r = ret;
  if (r - c === len) { c = Math.max(prevEnd, Math.min(c, nextStart - len)); r = c + len; }
  else { c = Math.max(prevEnd, c); r = Math.min(nextStart, r); }
  if (r - c < 2) return ops;
  return ops.map((x) => (x.id === id ? { ...x, call: c, ret: r } : x));
}

export function HistoryEditorDemo() {
  const P = useParams("cons-edit", EDIT_SCHEMA);
  const preset = EDITOR_PRESETS.find((p) => p.id === P.values.preset)!;
  const [state, setState] = useState<{ id: string; ops: HOp[] }>({ id: preset.id, ops: preset.history });
  const ops = state.id === preset.id ? state.ops : preset.history;
  const setOps = (f: (o: HOp[]) => HOp[]) => setState({ id: preset.id, ops: f(ops) });
  const [sel, setSel] = useState<number | null>(null);
  const r = useMemo(() => checkLinearizable(ops, registerModel()), [ops]);
  const points = r.ok ? linearizationPoints(ops, r.order, T_MAX) : undefined;
  const byId = new Map(ops.map((o) => [o.id, o]));
  const marks = new Map<number, OpMark>();
  if (!r.ok) for (const id of r.blocked) marks.set(id, "bad");
  const selOp = sel === null ? undefined : byId.get(sel);
  const values = [0, ...ops.filter((o) => o.f === "w").map((o) => o.value!)];
  const nudge = (dc: number, dr: number) => selOp && setOps((o) => clampDrag(o, selOp.id, selOp.call + dc, selOp.ret + dr));
  const cycle = () => selOp && selOp.f === "r" && setOps((o) => o.map((x) => (x.id === selOp.id ? { ...x, value: values[(values.indexOf(x.value!) + 1) % values.length] } : x)));
  // The register value after the best prefix, to explain why each blocked read fails.
  let after = 0;
  for (const id of r.best) { const o = byId.get(id)!; if (o.f === "w") after = o.value!; }

  return (
    <Demo
      title="Drag the operations: is there a linearization?"
      actions={<Btn ghost onClick={() => { setState({ id: preset.id, ops: preset.history }); setSel(null); }}>Reset</Btn>}
      controls={<Param spec={EDIT_SCHEMA.preset} value={P.values.preset} onChange={(v) => { P.set("preset", v as string); setSel(null); }} />}
    >
      <SmallLabel>Drag a bar to move it, or drag an end to stretch it. Tap a bar to select it. One register x starts at 0.</SmallLabel>
      <HistoryView ops={ops} tEnd={T_MAX} points={points} order={r.ok ? r.order : undefined} marks={marks} selected={sel} onSelect={setSel} onDrag={(id, c, rr) => setOps((o) => clampDrag(o, id, c, rr))} timeLabel="real time" />
      <ButtonRow style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12.5, minWidth: 92 }}>{selOp ? `Selected: ${fmt(selOp)}` : "Nothing selected"}</span>
        <Btn onClick={() => nudge(-2, -2)} disabled={!selOp}>Earlier</Btn>
        <Btn onClick={() => nudge(2, 2)} disabled={!selOp}>Later</Btn>
        <Btn onClick={() => nudge(-2, 2)} disabled={!selOp}>Longer</Btn>
        <Btn onClick={() => nudge(2, -2)} disabled={!selOp}>Shorter</Btn>
        <Btn onClick={cycle} disabled={!selOp || selOp.f !== "r"}>Change read value</Btn>
      </ButtonRow>
      <Banner tone={r.ok ? "good" : "bad"}>
        {r.ok ? (
          <>Linearizable. Each dot is a linearization point, numbered in order: {r.order.map((id) => fmt(byId.get(id)!)).join(", ")}. The register gives every read its value in this order.</>
        ) : (
          <>
            Not linearizable. The longest valid start is {r.best.length ? r.best.map((id) => fmt(byId.get(id)!)).join(", ") : "empty"}, so x = {after}.
            {" "}After that, real time allows only {r.blocked.map((id) => fmt(byId.get(id)!)).join(" or ")}, and none fits.
          </>
        )}
      </Banner>
      <Stats items={[
        { label: "operations", value: ops.length },
        { label: "configurations searched", value: int(r.explored) },
        { label: "cut by the cache", value: int(r.cacheHits) },
      ]} />
    </Demo>
  );
}

// ============================================================================ stale reads on Net

const STORE_SCHEMA = {
  run: range({ label: "Run", min: 1, max: 30, step: 1, default: 9 }),
  path: seg<ReadPath>("Read path", [["readindex", "leader + quorum"], ["leader", "leader only"], ["follower", "any replica"]], "follower"),
  fault: seg("Fault", [["none", "none"], ["isolate", "cut off f2"]], "none"),
};

export function StaleFollowerDemo() {
  const P = useParams("cons-stale", STORE_SCHEMA);
  const [wref, wpx] = useWidth<HTMLDivElement>();
  const wide = wpx >= 560; // message labels only where they fit
  const { run: seed, path, fault } = P.values;
  const cut = { at: 40, until: 130 };
  const run = useMemo(() => runStore({
    seed, readPath: path, clients: 2, duration: 150, think: 18, heartbeat: 40,
    faults: fault === "isolate" ? [{ kind: "isolate", node: 2, ...cut }] : [],
  }), [seed, path, fault]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useMemo(() => checkLinearizable(run.history, registerModel()), [run]);
  const stale = provablyStaleReads(run.history);
  const done = run.history.filter((o) => Number.isFinite(o.ret));
  const tEnd = Math.ceil(Math.max(...done.map((o) => o.ret)) / 10) * 10 + 10;
  const N = run.cfg.replicas;
  // Plain acks from followers are left out to keep the picture readable; acks of a ReadIndex round stay.
  const messages: StMessage[] = run.net.messages.filter((m) => m.sentAt <= tEnd && !(m.payload.k === "ack" && m.payload.rid === undefined)).map((m) => {
    const client = m.from >= N || m.to >= N;
    return {
      from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt,
      label: client && wide ? storeMsgLabel(m.payload) : undefined,
      color: client ? (m.from >= N ? "var(--c1)" : "var(--fg)") : "rid" in m.payload && m.payload.rid !== undefined ? "var(--c2)" : "var(--faint)",
    };
  });
  const marks: StMark[] = fault === "isolate" ? [{ node: 2, t: cut.at, until: cut.until, shape: "bar", label: "cut off", color: "var(--c4)" }] : [];
  const reads = done.filter((o) => o.f === "r");
  const meanRead = reads.reduce((a, o) => a + o.ret - o.call, 0) / Math.max(1, reads.length);
  const opMarks = new Map<number, OpMark>(stale.map((o) => [o.id, "bad"]));
  if (!res.ok) for (const id of res.blocked) opMarks.set(id, "bad");
  return (
    <Demo title="A replicated register: where do reads go?" controls={<><Param spec={STORE_SCHEMA.run} value={seed} onChange={(v) => P.set("run", v as number)} /><Param spec={STORE_SCHEMA.path} value={path} onChange={(v) => P.set("path", v as ReadPath)} /><Param spec={STORE_SCHEMA.fault} value={fault} onChange={(v) => P.set("fault", v as "none" | "isolate")} /></>}>
      <div ref={wref}><SpaceTime nodes={run.nodes} tEnd={tEnd} messages={messages} marks={marks} rowHeight={36} /></div>
      <SmallLabel style={{ marginTop: 8 }}>The history that the two clients saw (each bar is one operation; red: a read that cannot be placed)</SmallLabel>
      <HistoryView ops={run.history} tEnd={tEnd} marks={opMarks} laneName={(c) => `c${(c % 2) + 1}${c >= 2 ? "′" : ""}`} rowHeight={38} timeLabel="time (ms)" />
      <Banner tone={res.ok ? "good" : "bad"}>
        {res.ok
          ? path === "follower" ? "Linearizable this time: no read happened to hit a lagging replica. Try other runs." : "Linearizable. Every read sees every write that returned before the read began."
          : `Not linearizable. ${stale.length ? `${stale.length} read${stale.length > 1 ? "s" : ""} returned a value that a completed write had already replaced.` : "Some reads cannot be ordered with the writes."}`}
      </Banner>
      <Stats items={[
        { label: "operations", value: done.length },
        { label: "stale reads", value: stale.length },
        { label: "mean read latency", value: `${fixed(meanRead, 1)} ms` },
        { label: "messages", value: int(run.net.messages.length) },
      ]} />
    </Demo>
  );
}
