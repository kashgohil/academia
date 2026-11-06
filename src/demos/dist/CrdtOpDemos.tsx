/** Demos for the lesson on operation-based CRDTs: what each delivery requirement protects, and a causal broadcast stepper. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Panel, Param, SectionLabel, SmallLabel, Stats, StepCaption, mono, pct, range, seg, toggle, useChunked, useParams } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { brokenShare, orElements, orTags, presetSteps, replaySteps, runOpBased, tagOf, STEP_NAMES, type OpObject, type StepAction } from "../../sims/dist/crdts";

const R = ["R1", "R2", "R3"];

// ============================================================================ 1. Which requirement breaks which object

const DELIV = {
  dup: range({ label: "Duplicated messages", min: 0, max: 0.5, step: 0.05, default: 0.3, format: (v) => pct(v, 0) }),
  object: seg<OpObject>("Object", [["counter", "counter"], ["set", "add/remove set"]], "counter"),
  dedupe: toggle({ label: "Drop duplicates by op id", default: false }),
  causal: toggle({ label: "Causal delivery (buffer early ops)", default: false }),
  seed: range({ label: "Run", min: 1, max: 30, step: 1, default: 1 }),
};

export function CrdtDeliveryDemo() {
  const P = useParams("crdt-deliv", DELIV);
  const { dup, object, dedupe, causal, seed } = P.values;
  const run = useMemo(() => runOpBased({ object, dupRate: dup, dedupe, causal, seed }), [object, dup, dedupe, causal, seed]);
  const key = JSON.stringify({ object, dup, dedupe, causal });
  const parts = useChunked(key, [0, 1, 2, 3].map((k) => () => brokenShare({ object, dupRate: dup, dedupe, causal }, 50, 1 + 50 * k)), { keep: true });
  const done = parts.filter((x): x is number => x !== undefined);
  const share = done.length ? done.reduce((a, b) => a + b, 0) / done.length : null;
  const net = run.cb.net;
  const tEnd = Math.max(250, net.now + 5);
  const messages: StMessage[] = net.messages.filter((m) => m.payload.k === "op").map((m) => ({
    from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, color: m.dupOf ? "var(--c2)" : m.payload.k === "op" && m.payload.op.k === "rmv" ? "var(--c4)" : "var(--faint)",
  }));
  const marks: StMark[] = run.updates.map((u) => ({ node: u.r, t: u.t, label: object === "set" ? u.text : undefined, color: u.text.startsWith("−") ? "var(--c4)" : "var(--c3)" }));
  const show = (v: number | string[]) => (Array.isArray(v) ? (v.length ? `{${v.join(", ")}}` : "∅") : String(v));
  const bad = run.wrong.length > 0;
  const why = object === "counter"
    ? bad
      ? `Duplicates were applied: ${run.cb.duplicatesApplied} ops counted twice. Increments commute, so order never matters, but they are not idempotent.`
      : run.cb.duplicatesDropped
        ? `${run.cb.duplicatesDropped} duplicates were recognised by their op id and dropped. Ops arrived in many orders, and that is fine: increments commute.`
        : "Ops arrived in different orders at each replica. Increments commute, so every replica reaches the same sum."
    : bad
      ? `At ${run.wrong.map((i) => R[i]).join(" and ")}, a remove arrived before the add that it removes. It removed nothing, and the add then stayed forever.`
      : causal
        ? `The buffer held ${run.cb.maxBuffered ? "early removes" : "nothing in this run"} until their add was delivered, so every remove found its tags.`
        : "In this run, every add happened to arrive before its remove. Try other runs.";
  return (
    <Demo title="Op-based replicas on a faulty network" controls={<>{(["dup", "object", "dedupe", "causal", "seed"] as const).map((k) => <Param key={k} spec={DELIV[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>
        {object === "counter"
          ? "12 updates of +1 or −1 at random replicas. Each op goes to the others once; latency is 5 to 80 ms. Orange arrows are duplicates."
          : "R1 adds items a, b, c, …. When an add reaches R2, R2 removes the item. Red arrows carry removes; orange arrows are duplicates."}
      </SmallLabel>
      <SpaceTime nodes={R} tEnd={tEnd} messages={messages} marks={marks} rowHeight={42} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
        {run.values.map((v, i) => (
          <Panel key={i} title={R[i]} accent={run.wrong.includes(i) ? "var(--c4)" : "var(--c3)"}>
            <div style={{ fontSize: 18, fontWeight: 650, overflowWrap: "anywhere", ...mono }}>{show(v)}</div>
          </Panel>
        ))}
      </div>
      <Banner tone={bad ? "bad" : "good"} label={`expected ${show(run.expected)}`}>{why}</Banner>
      <Stats items={[
        { label: "op messages", value: messages.length },
        { label: "duplicates applied", value: run.cb.duplicatesApplied },
        { label: "duplicates dropped", value: run.cb.duplicatesDropped },
        { label: "200 runs: some replica wrong", value: share === null ? "…" : pct(share, 1) },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. Causal broadcast: you are the network

const STEP = { causal: toggle({ label: "Causal delivery buffer", default: true }) };

export function CrdtCausalStepperDemo() {
  const P = useParams("crdt-causal", STEP);
  const causal = P.values.causal;
  const [actions, setActions] = useState<StepAction[]>(presetSteps());
  const st = useMemo(() => replaySteps(actions, causal), [actions, causal]);
  const net = st.cb.net;
  const held = net.held();
  const heldIds = new Set(held.map((m) => m.id));
  const push = (a: StepAction) => setActions((x) => [...x, a]);
  const opText = (m: (typeof held)[number]) => (m.payload.k === "op" ? `${m.payload.op.k === "add" ? "add" : "rmv"} ${m.payload.op.e} · ${tagOf(m.payload)}` : "sync");
  const messages: StMessage[] = net.messages.filter((m) => !heldIds.has(m.id)).map((m) => ({
    from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, label: opText(m), color: m.payload.k === "op" && m.payload.op.k === "rmv" ? "var(--c4)" : "var(--c1)",
  }));
  const marks: StMark[] = [];
  for (const m of net.messages) if (m.payload.k === "op" && m.payload.origin === m.from && !marks.some((x) => x.t === m.sentAt && x.node === m.from)) marks.push({ node: m.from, t: m.sentAt, color: "var(--c3)" });
  const tEnd = Math.max(8, net.now + 1);
  const last = st.log.at(-1);
  const sets = st.sets.map(orElements);
  const allDelivered = held.length === 0 && st.cb.buffer.every((b) => !b.length);
  const agreeAll = sets.every((s) => JSON.stringify(s) === JSON.stringify(sets[0]));
  return (
    <Demo
      title="Causal broadcast: you are the network"
      actions={<>
        <Btn onClick={() => setActions((a) => a.slice(0, -1))} disabled={!actions.length}>Undo</Btn>
        <Btn ghost onClick={() => setActions([])}>Clear</Btn>
        <Btn ghost onClick={() => setActions(presetSteps())}>Preset</Btn>
      </>}
      controls={<Param spec={STEP.causal} value={causal} onChange={(v) => P.set("causal", v as boolean)} />}
    >
      <SmallLabel>Every op waits on the network until you deliver or drop it. Time moves one step per action.</SmallLabel>
      <SpaceTime nodes={R} tEnd={tEnd} messages={messages} marks={marks} rowHeight={42} timeLabel="steps" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
        {R.map((name, i) => (
          <Panel key={i} title={name}>
            <div style={{ fontSize: 16, fontWeight: 650, ...mono }}>{sets[i]!.length ? `{${sets[i]!.join(", ")}}` : "∅"}</div>
            <div className="muted" style={{ fontSize: 11, ...mono }}>D = [{st.cb.D[i]!.join(",")}]</div>
            <div className="muted" style={{ fontSize: 11, ...mono, minHeight: 15 }}>{sets[i]!.map((e) => `${e}: ${orTags(st.sets[i]!, e).join(" ")}`).join("; ")}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minHeight: 20, marginTop: 2 }}>
              {st.cb.buffer[i]!.map((b) => <Chip key={b.msgId} color="var(--c2)" dashed title="waiting in the buffer">{`${b.op.k === "add" ? "add" : "rmv"} ${tagOf(b)}`}</Chip>)}
            </div>
            <ButtonRow style={{ marginTop: 4 }}>
              <Btn onClick={() => push({ k: "add", r: i, e: "x" })}>add x</Btn>
              <Btn onClick={() => push({ k: "rmv", r: i, e: "x" })}>rmv x</Btn>
            </ButtonRow>
          </Panel>
        ))}
      </div>
      <SectionLabel>On the network ({held.length})</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {held.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>Nothing in flight.</div>}
        {held.map((m) => (
          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12.5 }}>
            <span style={{ ...mono, minWidth: 150 }}>{`${STEP_NAMES[m.from]} → ${STEP_NAMES[m.to]}: ${opText(m)}`}</span>
            <Btn onClick={() => push({ k: "deliver", id: m.id })}>Deliver</Btn>
            <Btn ghost onClick={() => push({ k: "drop", id: m.id })}>Drop</Btn>
          </div>
        ))}
      </div>
      <StepCaption tone={last?.includes("buffers") ? "warn" : last?.includes("loses") ? "bad" : "info"} label={`step ${actions.length}`}>{last ?? "Make an op at a replica: add x or remove x."}</StepCaption>
      {allDelivered && actions.length > 0 && (
        <Banner tone={agreeAll ? "good" : "bad"}>
          {agreeAll ? "Every op is delivered, and all replicas hold the same set." : `Every op is delivered or lost, but the replicas differ: ${sets.map((s, i) => `${R[i]} ${s.length ? `{${s.join(", ")}}` : "∅"}`).join(", ")}.`}
        </Banner>
      )}
    </Demo>
  );
}
