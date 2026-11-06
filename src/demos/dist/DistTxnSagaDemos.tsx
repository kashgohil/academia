/** Demos for the sagas lesson: a trip saga with a reader in the middle, and orchestration against choreography. */
import { useMemo } from "react";
import { Banner, Chip, Demo, MiniTable, Param, SectionLabel, Stats, int, range, seg, toggle, useParams } from "../../kit";
import { SpaceTime, type StMark } from "./SpaceTime";
import { crashMarks, stMessages } from "./DistTxnUi";
import { runSaga, sagaLabel, SERVICE_NAMES, type Saga, type SagaMode, type Status } from "../../sims/dist/transactions/saga";

const STATUS_COLOR: Record<Status | "none", string> = { PENDING: "var(--c2)", CONFIRMED: "var(--c3)", CANCELLED: "var(--c4)", none: "var(--muted)" };
const FAIL: [string, string][] = [["0", "none"], ["1", "flight"], ["2", "hotel"], ["3", "car"]];

function sagaView(s: Saga, end: number) {
  const msgs = stMessages(s.net.messages, (m) => sagaLabel(m.payload), end, new Set(), (m) =>
    m.payload.saga === "B" ? "var(--c5)" : m.payload.k === "cancel" || m.payload.k === "cancelled" || m.payload.k === "failed" ? "var(--c4)" : undefined);
  const marks: StMark[] = crashMarks(s.net.trace as { kind: string; t: number; node?: number }[]);
  if (s.resultAt !== undefined) marks.push({ node: 0, t: s.resultAt, color: s.result === "completed" ? "var(--c3)" : "var(--c4)" });
  return { msgs, marks };
}

// ============================================================================ 1. The trip saga, and what a reader sees

const TRIP = {
  look: range({ label: "A reader looks at time", min: 0, max: 120, step: 1, default: 45, format: (x) => `${x} ms` }),
  fail: seg("Step that fails", FAIL, "3"),
  lock: toggle({ label: "Semantic lock (bookings stay PENDING until the saga ends)", default: false }),
  comp: seg<"inverse" | "restore">("Compensation", [["inverse", "add the seat back"], ["restore", "write back the old count"]], "inverse"),
  b: toggle({ label: "Traveller B books a flight seat at 25 ms", default: true }),
};

export function DistTxnSagaTripDemo() {
  const P = useParams("dist-txn-saga", TRIP);
  const v = P.values;
  const s = useMemo(() => runSaga({ mode: "orchestration", fail: Number(v.fail), semanticLock: v.lock, compensation: v.comp, bAt: v.b ? 25 : null }), [v.fail, v.lock, v.comp, v.b]);
  const end = 120;
  const { msgs, marks } = sagaView(s, end);
  const broken = s.invariantBroken();
  const rows = [1, 2, 3].map((i) => {
    const st = s.stateAt(i, v.look);
    const a = st.bookings.find((b) => b.saga === "A");
    const finalA = s.svc[i]!.bookings.find((b) => b.saga === "A");
    const dirty = a?.status === "CONFIRMED" && finalA?.status === "CANCELLED";
    return {
      cells: [
        SERVICE_NAMES[i - 1]!,
        `${st.free} of ${s.cfg.capacity}`,
        <Chip key="a" color={STATUS_COLOR[a?.status ?? "none"]} filled={!!a}>{a?.status ?? "none"}</Chip>,
        st.bookings.some((b) => b.saga === "B") ? "B booked" : "",
      ],
      dirty,
    };
  });
  const dirtyNow = rows.some((r) => r.dirty);
  const pendingNow = [1, 2, 3].some((i) => s.stateAt(i, v.look).bookings.some((b) => b.saga === "A" && b.status === "PENDING"));
  return (
    <Demo
      title="A trip saga: book a flight, a hotel and a car"
      controls={<>
        <Param spec={TRIP.look} value={v.look} onChange={(y) => P.set("look", y as number)} />
        <Param spec={TRIP.fail} value={v.fail} onChange={(y) => P.set("fail", y as string)} />
        <Param spec={TRIP.comp} value={v.comp} onChange={(y) => P.set("comp", y as "inverse" | "restore")} />
        <Param spec={TRIP.lock} value={v.lock} onChange={(y) => P.set("lock", y as boolean)} />
        <Param spec={TRIP.b} value={v.b} onChange={(y) => P.set("b", y as boolean)} />
      </>}
    >
      <SpaceTime nodes={["orchestr.", "flight", "hotel", "car", "trav. B"]} tEnd={end} messages={msgs} marks={marks} cursor={v.look} rowHeight={40} />
      <SectionLabel>What a reader sees at {v.look} ms (each service has 2 units)</SectionLabel>
      <MiniTable head={["service", "free", "A's booking", "other"]} rows={rows.map((r) => r.cells)} highlight={(i) => rows[i]!.dirty} />
      <Banner tone={dirtyNow ? "bad" : pendingNow ? "warn" : "plain"}>
        {dirtyNow
          ? "The reader sees a CONFIRMED booking that the saga will cancel. It reads a state that never becomes final: a dirty read across services."
          : pendingNow
            ? "The reader sees PENDING. The semantic lock tells it that this booking may still go away, so it can wait, warn, or treat it as not final."
            : "Move the time slider through the run, and watch what a reader would see at each moment."}
      </Banner>
      <Banner tone={broken.length ? "bad" : s.result === "completed" ? "good" : "info"}>
        {s.result === "completed" ? "Every step succeeded. The saga completed." : `Step ${v.fail} (${SERVICE_NAMES[Number(v.fail) - 1]}) failed. The orchestrator ran the compensations in reverse order, so no booking of A is left.`}
        {broken.length ? ` But the flight now shows ${s.svc[1]!.free} free seats while B holds one: the compensation wrote back an old count and erased B's update. This is a lost update.` : ""}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "saga result", value: s.result ?? "running" },
          { label: "saga messages", value: s.sagaMessages() },
          { label: "flight seats free at the end", value: `${s.svc[1]!.free} of 2` },
          { label: "traveller B", value: s.bResult ?? "–" },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Orchestration against choreography

const STY = {
  fail: seg("Step that fails", FAIL, "2"),
  fault: seg<"none" | "crash">("Fault", [["none", "none"], ["crash", "hotel crashes after its commit"]], "none"),
  outbox: toggle({ label: "Transactional outbox", default: false }),
  idem: toggle({ label: "Idempotent steps (request ids)", default: true }),
  lock: toggle({ label: "Semantic lock (adds a confirm round)", default: false }),
};

function outcomeText(s: Saga) {
  if (!s.result) return "stuck: nobody will ever finish or undo it";
  return s.result;
}

export function DistTxnSagaStylesDemo() {
  const P = useParams("dist-txn-sagastyle", STY);
  const v = P.values;
  const fail = v.fault === "crash" ? 0 : Number(v.fail);
  const runs = useMemo(() => (["orchestration", "choreography"] as SagaMode[]).map((mode) => runSaga({ mode, fail, semanticLock: v.lock, crashHotel: v.fault === "crash", outbox: v.outbox, idempotent: v.idem })), [fail, v.lock, v.fault, v.outbox, v.idem]);
  const tEnd = Math.ceil((Math.max(60, ...runs.flatMap((s) => s.net.messages.map((m) => m.deliveredAt ?? m.lostAt ?? m.sentAt))) + 15) / 10) * 10;
  const table = useMemo(() => FAIL.map(([f, name]) => [name, ...(["orchestration", "choreography"] as SagaMode[]).map((mode) => runSaga({ mode, fail: Number(f), semanticLock: v.lock }).sagaMessages())]), [v.lock]);
  return (
    <Demo
      title="The same saga, orchestrated and choreographed"
      controls={<>
        <Param spec={STY.fault} value={v.fault} onChange={(y) => P.set("fault", y as "none" | "crash")} />
        {v.fault === "none" && <Param spec={STY.fail} value={v.fail} onChange={(y) => P.set("fail", y as string)} />}
        <Param spec={STY.outbox} value={v.outbox} onChange={(y) => P.set("outbox", y as boolean)} />
        <Param spec={STY.idem} value={v.idem} onChange={(y) => P.set("idem", y as boolean)} />
        <Param spec={STY.lock} value={v.lock} onChange={(y) => P.set("lock", y as boolean)} />
      </>}
    >
      {runs.map((s, k) => {
        const { msgs, marks } = sagaView(s, tEnd);
        const dbl = s.doubleBooked();
        return (
          <div key={k} style={{ marginBottom: 6 }}>
            <SectionLabel>{k === 0 ? "Orchestration: one orchestrator sends commands and waits for replies" : "Choreography: each service reacts to the event before it"}</SectionLabel>
            <SpaceTime nodes={[k === 0 ? "orchestr." : "trip app", "flight", "hotel", "car"]} tEnd={tEnd} messages={msgs} marks={marks} rowHeight={36} />
            <Banner tone={!s.result || dbl.length ? "bad" : s.result === "completed" ? "good" : "info"} label={`${s.sagaMessages()} messages`}>
              Result: <b>{outcomeText(s)}</b>{s.resultAt !== undefined ? ` at ${int(s.resultAt)} ms` : ""}.
              {dbl.length ? ` The hotel booked twice for one trip: a retried command ran again.` : ""}
              {!s.result ? " The hotel's event died with its process, and no one waits for it, so nothing retries." : ""}
            </Banner>
          </div>
        );
      })}
      <SectionLabel>Saga messages, with no fault</SectionLabel>
      <MiniTable head={["step that fails", "orchestration", "choreography"]} rows={table} />
    </Demo>
  );
}
