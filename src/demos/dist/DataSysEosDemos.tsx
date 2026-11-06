/** Demos for "Exactly-once semantics": a pipeline with chosen crash points, and an idempotent producer. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, MiniTable, Param, SmallLabel, Stats, pct, range, seg, toggle, useParams, MONO,
} from "../../kit";
import { SpaceTime, fromTrace } from "./SpaceTime";
import {
  GUARANTEES, PIPE_DEFAULTS, pipeLabel, runIdemProducer, runPipeline, type CrashPhase, type CrashPoint, type Guarantee,
  type IdemAction, type ProdMsg,
} from "../../sims/dist/data-systems/eos";
import type { Message } from "../../sims/dist/net";

// ============================================================================ 1. The pipeline

const PL = {
  loss: range({ label: "Message loss (requests are retried after 30 ms)", min: 0, max: 0.3, step: 0.05, default: 0, format: (v) => pct(v, 0) }),
  mode: seg<Guarantee>("Diagram shows", [["at-most-once", "at-most-once"], ["at-least-once", "at-least-once"], ["exactly-once", "exactly-once"]], "at-least-once"),
};

const PHASES: [CrashPhase, string][] = [["read", "after read"], ["first", "after 1st write"], ["second", "after 2nd sent"]];
const FIRST: Record<Guarantee, string> = { "at-most-once": "commit offset, then send the effect once", "at-least-once": "apply the effect, then commit the offset", "exactly-once": "one sink transaction: effect + offset" };

export function PipelineCrashDemo() {
  const P = useParams("dist-ds-pipe", PL);
  const { loss, mode } = P.values;
  const [crashes, setCrashes] = useState<CrashPoint[]>(PIPE_DEFAULTS.crashes);
  const key = (c: CrashPoint) => `${c.rec}:${c.phase}`;
  const has = (c: CrashPoint) => crashes.some((x) => key(x) === key(c));
  const flip = (c: CrashPoint) => setCrashes(has(c) ? crashes.filter((x) => key(x) !== key(c)) : [...crashes, c]);
  const runs = useMemo(() => GUARANTEES.map((m) => runPipeline({ mode: m, crashes, dropRate: loss })), [crashes, loss]);
  const run = runs[GUARANTEES.indexOf(mode)]!;
  const st = fromTrace(run.net, (m) => pipeLabel(m) || undefined);
  // Zoom on the first crash; without one, show the start of the run.
  const c0 = run.crashesHit[0]?.t;
  const tStart = c0 === undefined ? 0 : Math.max(0, c0 - 45);
  const tEnd = c0 === undefined ? 110 : c0 + 95;
  return (
    <Demo
      title="Source, processor, sink: where the crash lands"
      controls={<>
        <Param spec={PL.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
        <Param spec={PL.mode} value={mode} onChange={(v) => P.set("mode", v as Guarantee)} />
      </>}
    >
      <SmallLabel>Six records; record i adds 10 × (i + 1) to an account. Click cells to choose where the processor crashes (it restarts 25 ms later).</SmallLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <tbody>
            {PHASES.map(([ph, label]) => (
              <tr key={ph}>
                <td className="muted" style={{ padding: "2px 8px 2px 0", whiteSpace: "nowrap" }}>{label}</td>
                {Array.from({ length: PIPE_DEFAULTS.records }, (_, rec) => {
                  const c = { rec, phase: ph };
                  return <td key={rec} style={{ padding: 2 }}><Chip color={has(c) ? "var(--c4)" : "var(--faint)"} filled={has(c)} onClick={() => flip(c)}>{`r${rec}`}</Chip></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ButtonRow style={{ marginTop: 6 }}>
        <Btn ghost onClick={() => setCrashes([])}>No crashes</Btn>
        <Btn ghost onClick={() => setCrashes(PIPE_DEFAULTS.crashes)}>Reset</Btn>
      </ButtonRow>
      <MiniTable
        head={["mode", "lost effects", "duplicated", "balance (want " + run.expected + ")"]}
        rows={runs.map((r, i) => [GUARANTEES[i]!, r.lost, r.duplicated, r.balance])}
        highlight={GUARANTEES.indexOf(mode)}
      />
      <SmallLabel style={{ marginTop: 10 }}>{mode}: {FIRST[mode]}.</SmallLabel>
      <SmallLabel style={{ marginTop: 2 }}>{c0 === undefined ? "The first 110 ms." : `Around the first crash, ${Math.round(tStart)} to ${Math.round(tEnd)} ms.`}</SmallLabel>
      <SpaceTime nodes={["input log", "processor", "sink"]} tStart={tStart} tEnd={tEnd} messages={st.messages.filter((m) => m.sentAt >= tStart - 10 && m.sentAt <= tEnd)} marks={[
        ...st.marks,
        ...run.crashesHit.map((c) => ({ node: 1, t: c.t, until: c.t + PIPE_DEFAULTS.downtime, shape: "bar" as const, color: "var(--c4)", label: "down" })),
      ]} rowHeight={52} />
      <Stats items={[
        { label: "effects per record (r0 … r5)", value: <span style={{ fontFamily: MONO }}>{run.effects.join(" ")}</span> },
        { label: "crashes that happened", value: run.crashesHit.length },
      ]} />
      <Banner tone={run.lost || run.duplicated ? "bad" : "good"}>
        {run.lost
          ? `${run.lost} effect${run.lost > 1 ? "s" : ""} lost: the offset moved past a record whose effect never reached the sink.`
          : run.duplicated
            ? `${run.duplicated} effect${run.duplicated > 1 ? "s" : ""} applied twice: the effect landed, but the record was read again after the crash or the retry.`
            : mode === "exactly-once"
              ? "Each effect exactly once. Messages were still lost and resent; the sink transaction made the repeats harmless."
              : "No loss and no duplicate with these crash points. Try another cell."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. The idempotent producer

const IP = {
  idem: toggle({ label: "enable.idempotence", default: true }),
  inflight: seg<"1" | "2">("max.in.flight.requests", [["1", "1"], ["2", "2"]], "2"),
};

const prodLabel = (m: Message<ProdMsg>) => {
  const p = m.payload;
  return p.k === "produce" ? `batch ${p.seq} (try ${p.attempt})` : p.k === "ack" ? `ack ${p.seq}${p.dup ? " (dup)" : ""} @${p.offset}` : `error ${p.seq}: out of order`;
};

export function IdempotentProducerDemo() {
  const P = useParams("dist-ds-idem", IP);
  const { idem, inflight } = P.values;
  const [actions, setActions] = useState<IdemAction[]>([]);
  const cfg = { idempotent: idem, maxInFlight: Number(inflight) };
  const run = useMemo(() => runIdemProducer(cfg, actions), [idem, inflight, actions]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (a: IdemAction) => setActions([...actions, a]);
  const st = fromTrace(run.net, prodLabel);
  // Held messages are still in the learner's hands: draw only delivered and lost ones.
  const shown = run.net.messages.map((m, i) => ({ m, d: st.messages[i]! })).filter(({ m }) => m.deliveredAt !== undefined || m.lost).map(({ d }) => d);
  const allAcked = run.acked.every((x) => x !== null);
  /** A preset: deliver batch 0, lose its ack, let the retry go through. */
  const preset = () => {
    const a: IdemAction[] = [];
    let r = runIdemProducer(cfg, a);
    const step = (pick: (m: Message<ProdMsg>) => boolean, k: "deliver" | "drop") => {
      const m = r.held.find(pick);
      if (m) { a.push({ k, id: m.id }); r = runIdemProducer(cfg, a); }
    };
    step((m) => m.payload.k === "produce" && m.payload.seq === 0, "deliver");
    step((m) => m.payload.k === "ack" && m.payload.seq === 0, "drop");
    a.push({ k: "wait" });
    r = runIdemProducer(cfg, a);
    step((m) => m.payload.k === "produce" && m.payload.seq === 0 && m.payload.attempt === 2, "deliver");
    setActions(a);
  };
  return (
    <Demo
      title="An idempotent producer: you are the network"
      actions={<Btn ghost onClick={() => setActions([])}>Reset</Btn>}
      controls={<>
        <Param spec={IP.idem} value={idem} onChange={(v) => { P.set("idem", v as boolean); }} />
        <Param spec={IP.inflight} value={inflight} onChange={(v) => { P.set("inflight", v as "1" | "2"); setActions([]); }} />
      </>}
    >
      <SmallLabel>Producer id {4000}, epoch 0. It sends 3 batches with sequence numbers 0, 1, 2 and retries a batch after 40 ms with no answer.</SmallLabel>
      <div style={{ display: "grid", gap: 4, margin: "6px 0" }}>
        {run.held.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>No message in flight. {allAcked ? "Every batch is acknowledged." : "Press Wait to let the producer retry."}</span>}
        {run.held.map((m) => (
          <div key={m.id} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, fontSize: 12, minWidth: 0, flex: "1 1 150px" }}>{m.from === 0 ? "to broker" : "to producer"}: {prodLabel(m)}</span>
            <Btn onClick={() => act({ k: "deliver", id: m.id })}>Deliver</Btn>
            <Btn onClick={() => act({ k: "drop", id: m.id })}>Lose</Btn>
          </div>
        ))}
      </div>
      <ButtonRow>
        <Btn onClick={() => act({ k: "wait" })}>Wait 40 ms (timeouts fire)</Btn>
        <Btn ghost onClick={preset}>Play: lost ack, then retry</Btn>
      </ButtonRow>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 12, width: 92 }}>partition log</span>
        {run.log.length ? run.log.map((r, i) => {
          const dup = run.log.findIndex((x) => x.seq === r.seq) !== i;
          return <Chip key={i} color={dup ? "var(--c4)" : "var(--c1)"} filled>{`${i}: b${r.seq}`}</Chip>;
        }) : <span className="muted" style={{ fontSize: 12 }}>empty</span>}
      </div>
      <SpaceTime nodes={["producer", "broker"]} tEnd={Math.max(60, run.net.now + 5)} messages={shown} rowHeight={56} />
      <SmallLabel style={{ marginTop: 6 }}>What happened</SmallLabel>
      <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        {run.events.slice(-4).map((e, i) => <div key={i}>{e}</div>)}
        {!run.events.length && <span className="muted">Deliver batch 0 to start.</span>}
      </div>
      <Stats items={[
        { label: "duplicate batches in the log", value: run.duplicates },
        { label: "log in sequence order", value: run.inOrder ? "yes" : "no" },
        { label: "batches acknowledged", value: `${run.acked.filter((x) => x !== null).length} of 3` },
      ]} />
      <Banner tone={run.duplicates || !run.inOrder ? "bad" : allAcked ? "good" : "plain"}>
        {run.duplicates
          ? "The retry was appended a second time. Without a sequence number, the broker cannot tell a retry from a new batch."
          : !run.inOrder
            ? "Batches are out of order: a retry landed after a later batch."
            : allAcked
              ? "Every batch is in the log exactly once and in order, whatever you lost on the way."
              : "Lose an ack, then Wait: the producer resends the same batch with the same sequence number."}
      </Banner>
    </Demo>
  );
}
