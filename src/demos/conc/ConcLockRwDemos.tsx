/** Demos for "reader-writer-locks": Go's RWMutex step by step, policies on the Runtime, and a seqlock. */
import { useMemo } from "react";
import { Demo, Param, Stats, range, seg, toggle, useParams, int, Note, SmallLabel, Banner } from "../../kit";
import { goRwProg, exploreGoRw, showCount, rwLoop, seqlockProg, exploreSeqlock, type RwPolicy } from "../../sims/conc/locks/rwlock";
import { SyncStepper } from "../os/SyncShared";
import { ThreadTimeline } from "./ConcViews";
import { dur, Field, FieldRow } from "./ConcLockUi";

const GR = {
  recursive: toggle({ label: "R1 takes a second read lock (recursive)", default: true }),
  policy: seg("RLock", [["go", "Go: writer first"], ["reader", "glibc default: readers first"]], "go"),
};

export function ConcLockGoRwDemo() {
  const P = useParams("conc-lock-gorw", GR);
  const { recursive, policy } = P.values;
  const prog = useMemo(() => goRwProg({ recursive, policy }), [recursive, policy]);
  const ex = useMemo(() => exploreGoRw({ recursive, policy }), [recursive, policy]);
  const scripts = ex.stuck ? [{ label: `Show the deadlock (${ex.stuck.schedule.length} steps)`, schedule: ex.stuck.schedule }] : [];
  return (
    <SyncStepper
      title="Go's RWMutex, one atomic step at a time"
      prog={prog}
      scripts={scripts}
      hideRegs={["need"]}
      controls={
        <>
          <Param spec={GR.recursive} value={recursive} onChange={(v) => P.set("recursive", v as boolean)} />
          <Param spec={GR.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
        </>
      }
      panel={({ s }) => (
        <FieldRow>
          <Field name="readerCount" value={showCount(s.mem.readerCount!)} on={s.mem.readerCount! < 0} note={s.mem.readerCount! < 0 ? "writer pending" : "readers inside"} />
          {policy === "go" && <Field name="readerWait" value={s.mem.readerWait!} note="old readers to leave" />}
          <Field name="readerSem" value={s.mem.readerSem!} note="tokens" />
          {policy === "go" && <Field name="writerSem" value={s.mem.writerSem!} note="tokens" />}
          {policy === "go" ? <Field name="w (writer mutex)" value={s.mem.w ? "held" : "free"} on={!!s.mem.w} /> : <Field name="writer" value={s.mem.wActive ? "inside" : "out"} on={!!s.mem.wActive} />}
        </FieldRow>
      )}
      verdict={({ finished }) => (finished ? { tone: "good", text: "All three goroutines finished." } : null)}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "states searched (all schedules)", value: int(ex.states) },
            { label: "a schedule that deadlocks", value: ex.stuck ? `yes, ${ex.stuck.schedule.length} steps` : "none" },
          ]} />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- policies on the Runtime

const RP = {
  readers: range({ label: "Readers", min: 1, max: 8, step: 1, default: 6 }),
  policy: seg<RwPolicy>("Lock", [["reader", "RW, reader pref."], ["writer", "RW, writer pref."], ["mutex", "plain mutex"]], "reader"),
  read: range({ label: "Read section", min: 500, max: 10_000, step: 500, default: 4_000, format: (v) => dur(v) }),
};

const RUN = 200_000;

export function ConcLockRwPolicyDemo() {
  const P = useParams("conc-lock-rwpol", RP);
  const { readers, policy, read } = P.values;
  const r = useMemo(() => rwLoop({ readers, policy, readNs: read, durationNs: RUN }), [readers, policy, read]);
  return (
    <Demo
      title="Readers, one writer, three locks"
      controls={
        <>
          <Param spec={RP.readers} value={readers} onChange={(v) => P.set("readers", v as number)} />
          <Param spec={RP.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
          <Param spec={RP.read} value={read} onChange={(v) => P.set("read", v as number)} />
        </>
      }
    >
      <SmallLabel>8 cores. Each reader reads, then sleeps about 1 µs. The writer W wants to write for 2 µs every 20 µs.</SmallLabel>
      <ThreadTimeline result={r.result} by="thread" end={RUN} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "reads per ms", value: int(r.readsPerMs) },
          { label: "writes done / wanted", value: `${r.writes} / ${r.writesWanted}` },
          { label: "writer: longest wait", value: dur(r.maxWriteWaitNs) },
          { label: "readers: mean wait", value: dur(r.meanReadWaitNs) },
          { label: "readers: longest wait", value: dur(r.maxReadWaitNs) },
        ]} />
      </div>
      {r.writes === 0 && <Banner tone="bad">The writer never got the lock. At every moment some reader was inside.</Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- seqlock

const SQ = { check: toggle({ label: "Reader checks the sequence and retries", default: false }) };

export function ConcLockSeqlockDemo() {
  const P = useParams("conc-lock-seq", SQ);
  const { check } = P.values;
  const prog = useMemo(() => seqlockProg({ check }), [check]);
  const ex = useMemo(() => exploreSeqlock({ check }), [check]);
  const scripts = ex.violation ? [{ label: `Show a torn read (${ex.violation.schedule.length} steps)`, schedule: ex.violation.schedule }] : [];
  return (
    <SyncStepper
      title="A seqlock: the reader writes nothing"
      prog={prog}
      scripts={scripts}
      controls={<Param spec={SQ.check} value={check} onChange={(v) => P.set("check", v as boolean)} />}
      panel={({ s }) => (
        <FieldRow>
          <Field name="seq" value={s.mem.seq!} on={s.mem.seq! % 2 === 1} note={s.mem.seq! % 2 ? "odd: writing" : "even: stable"} />
          <Field name="x" value={s.mem.x!} />
          <Field name="y" value={s.mem.y!} />
          <Field name="retries" value={s.n.retries ?? 0} />
        </FieldRow>
      )}
      verdict={({ finished, s }) => (finished ? { tone: "good", text: `Done. The reader used (${s.th[1]!.r.a}, ${s.th[1]!.r.b}).` } : null)}
      footer={
        <>
          <div style={{ marginTop: 10 }}>
            <Stats items={[
              { label: "states searched", value: int(ex.states) },
              { label: "pairs the reader can use", value: ex.outcomes.join("  ") || "none" },
              { label: "torn read possible", value: ex.violation ? "yes" : "no" },
            ]} />
          </div>
          <Note>Each line is one atomic step on a sequentially consistent machine. Real code also needs acquire loads and fences, as the text explains.</Note>
        </>
      }
    />
  );
}
