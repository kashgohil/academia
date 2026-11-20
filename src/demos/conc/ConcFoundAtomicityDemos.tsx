/** Demos for "atomicity": a transfer and an audit, torn multiword values, and the cost of each fix under load. */
import { useMemo } from "react";
import { Demo, Meter, MiniTable, Note, SmallLabel, Param, Stats, fixed, int, range, select, useChunked, useParams } from "../../kit";
import {
  AMOUNT, IFACE_TYPES, SNAPSHOT_DEFAULTS, SNAPSHOT_LABELS, START, TORN_LABELS, TRANSFER_LABELS, auditTotal, copyNs, runSnapshot,
  tornCounts, tornOutcome, tornProg, transferCounts, transferProg, transferViolation,
  type Snapshot, type SnapshotResult, type TornCase, type TransferScheme,
} from "../../sims/conc/foundations";
import { Cell, CellRow, SyncStepper } from "../os/SyncShared";

// ---------------------------------------------------------------- transfer and audit

const TR = {
  scheme: select({ label: "Scheme", options: (Object.keys(TRANSFER_LABELS) as TransferScheme[]).map((k) => ({ value: k, label: TRANSFER_LABELS[k] })), default: "two-adds" as TransferScheme }),
};

export function ConcFoundTransferDemo() {
  const P = useParams("conc-found-transfer", TR);
  const scheme = P.values.scheme as TransferScheme;
  const prog = useMemo(() => transferProg(scheme), [scheme]);
  const counts = useMemo(() => transferCounts(scheme), [scheme]);
  const bad = useMemo(() => transferViolation(scheme), [scheme]);
  const breakdown = Object.entries(counts.totals).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, n]) => `${k}: ${n}`).join(", ");
  return (
    <SyncStepper
      title="Transfer and audit"
      prog={prog}
      scripts={bad ? [{ label: "Show a wrong audit", schedule: bad }] : []}
      hideRegs={["old", "s1", "p"]}
      controls={<Param spec={TR.scheme} value={scheme} onChange={(v) => P.set("scheme", v as never)} />}
      panel={({ s }) => {
        const m = s.mem;
        const seen = auditTotal(s);
        return (
          <CellRow>
            {scheme === "packed-cas" ? (
              <Cell name="AB (one word)" value={`${Math.floor(m.AB! / 1000)} | ${m.AB! % 1000}`} width={110} />
            ) : scheme === "cow" ? (
              <>
                <Cell name="current" value={`#${m.cur}`} />
                <Cell name={`#${m.cur} A, B`} value={`${m[`A${m.cur}`]}, ${m[`B${m.cur}`]}`} width={90} />
                {m.n !== m.cur && m.n! > 0 && <Cell name={`#${m.n} (private)`} value={`${m[`A${m.n}`]}, ${m[`B${m.n}`]}`} width={90} />}
              </>
            ) : (
              <>
                <Cell name="A" value={m.A} />
                <Cell name="B" value={m.B} />
                <Cell name="A + B" value={m.A! + m.B!} hot={m.A! + m.B! !== 2 * START} />
              </>
            )}
            {scheme === "seqlock" && <Cell name="seq" value={m.seq} note={m.seq! % 2 ? "odd: writing" : "even"} />}
            {(scheme === "lock-writer" || scheme === "lock-both") && <Cell name="m" value={m.m ? "held" : "free"} />}
            <Cell name="audit saw" value={seen ?? "…"} hot={seen !== undefined && seen !== 2 * START} />
          </CellRow>
        );
      }}
      verdict={({ s, finished }) => {
        if (!finished) return null;
        const seen = auditTotal(s)!;
        return seen === 2 * START
          ? { tone: "good", text: `The audit saw ${seen}. The invariant A + B = ${2 * START} held for the reader.` }
          : { tone: "bad", text: `The audit saw ${seen}, but no state of the bank ever had that total between transfers. ${seen < 2 * START ? `The ${AMOUNT} was in flight.` : `The ${AMOUNT} was counted twice.`}` };
      }}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "complete schedules", value: counts.total },
            { label: "the audit sees a wrong total", value: counts.bad },
            { label: "totals seen (schedules)", value: breakdown },
          ]} />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- torn multiword values

const TORN = {
  value: select({ label: "Shared value", options: (Object.keys(TORN_LABELS) as TornCase[]).map((k) => ({ value: k, label: TORN_LABELS[k] })), default: "iface" as TornCase }),
};

export function ConcFoundTornDemo() {
  const P = useParams("conc-found-torn", TORN);
  const k = P.values.value as TornCase;
  const prog = useMemo(() => tornProg(k), [k]);
  const counts = useMemo(() => tornCounts(k), [k]);
  return (
    <SyncStepper
      title="A data race on a value of several words"
      prog={prog}
      hideRegs={["t", "d", "p", "n"]}
      controls={<Param spec={TORN.value} value={k} onChange={(v) => P.set("value", v as never)} />}
      panel={({ s }) => {
        const m = s.mem, r = s.th[1]!.r;
        return (
          <CellRow>
            {k === "iface" && <>
              <Cell name="v.tab" value={IFACE_TYPES[m.tab!]} width={70} />
              <Cell name="v.data" value={m.data === 1 ? "&small" : "&big"} width={70} />
              <Cell name="reader has" value={`${r.t ? IFACE_TYPES[r.t] : "?"} + ${r.d ? (r.d === 1 ? "&small" : "&big") : "?"}`} width={130} hot={!!r.t && !!r.d && r.t !== r.d} />
            </>}
            {k === "slice" && <>
              <Cell name="s.ptr" value={m.ptr === 1 ? "old[4]" : "big[1000]"} width={80} />
              <Cell name="s.len" value={m.len} />
              <Cell name="s.cap" value={m.cap} />
              <Cell name="reader has" value={`${r.p ? (r.p === 1 ? "old[4]" : "big[1000]") : "?"}, len ${r.n ?? "?"}`} width={140} hot={!!r.p && r.n !== undefined && (r.p === 1) !== (r.n === 4)} />
            </>}
            {k === "atomic-ptr" && <>
              <Cell name="v (one pointer)" value={m.ptr === 1 ? "→ old" : "→ new"} width={110} />
              <Cell name="reader has" value={r.p ? (r.p === 1 ? "old, whole" : "new, whole") : "?"} width={110} />
            </>}
          </CellRow>
        );
      }}
      verdict={({ s, finished }) => {
        if (!finished) return null;
        const o = tornOutcome(k, s)!;
        return { tone: o.torn ? "bad" : "good", text: `The reader got ${o.text}.` };
      }}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "complete schedules", value: counts.total },
            { label: "torn reads", value: counts.torn },
            { label: "torn and memory-unsafe", value: counts.unsafe },
          ]} />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- the cost of each fix

const COST = {
  read: range({ label: "Operations that only read", min: 50, max: 99, step: 1, default: 90, format: (v) => `${v}%` }),
  bytes: range({ label: "Record size", min: 16, max: 4096, log: true, default: 256, format: (v) => `${Math.round(v)} B` }),
  threads: range({ label: "Threads (one per core)", min: 1, max: 16, step: 1, default: 8 }),
};

const SCHEMES = Object.keys(SNAPSHOT_LABELS) as Snapshot[];

export function ConcFoundSnapshotCostDemo() {
  const P = useParams("conc-found-cost", COST);
  const { read, bytes, threads } = P.values;
  const jobs = useMemo(
    () => SCHEMES.map((scheme) => () => runSnapshot({ ...SNAPSHOT_DEFAULTS, scheme, readFrac: read / 100, bytes, threads })),
    [read, bytes, threads],
  );
  const res = useChunked(`${read}/${bytes}/${threads}`, jobs, { keep: true });
  const done = res.filter((r): r is SnapshotResult => !!r);
  const maxR = Math.max(1e-9, ...done.map((r) => r.readsPerUs));
  const maxW = Math.max(1e-9, ...done.map((r) => r.writesPerUs));
  return (
    <Demo
      title="Keep a two-field record consistent: what each fix costs"
      controls={<>
        <Param spec={COST.read} value={read} onChange={(v) => P.set("read", v as number)} />
        <Param spec={COST.bytes} value={bytes} onChange={(v) => P.set("bytes", v as number)} />
        <Param spec={COST.threads} value={threads} onChange={(v) => P.set("threads", v as number)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "4px 16px" }}>
        {SCHEMES.map((k, i) => {
          const r = res[i];
          return (
            <div key={k}>
              <div style={{ fontSize: 13, fontWeight: 600, margin: "6px 0 2px" }}>{SNAPSHOT_LABELS[k]}</div>
              <Meter label="reads per µs" value={r?.readsPerUs ?? 0} max={maxR} color="var(--c1)" text={r ? fixed(r.readsPerUs, 1) : "…"} />
              <Meter label="writes per µs" value={r?.writesPerUs ?? 0} max={maxW} color="var(--c2)" text={r ? fixed(r.writesPerUs, 2) : "…"} />
            </div>
          );
        })}
      </div>
      <SmallLabel style={{ marginTop: 10 }}>Mean time per read and per write, seqlock read retries, and reads that saw a mixed record</SmallLabel>
      <MiniTable
        head={["scheme", "read, ns", "write, ns", "retries", "mixed"]}
        rows={SCHEMES.map((k, i) => {
          const r = res[i];
          return [SNAPSHOT_LABELS[k], r ? int(r.readLatencyNs) : "…", r ? int(r.writeLatencyNs) : "…", r ? int(r.retries) : "…", r ? int(r.inconsistent) : "…"];
        })}
        highlight={(i) => (res[i]?.inconsistent ?? 0) > 0}
      />
      <Note>
        Model inputs: a read copies the record ({fixed(copyNs(bytes), 0)} ns here), an update in place takes 50 ns, and a copy-on-write update copies the
        record first. Threads do 500 ns of other work between operations. Mutex and seqlock writers spin, then park. The reader-writer lock parks its waiters,
        and a wake-up costs 5 µs. Copy-on-write here does not pay to free old copies.
      </Note>
    </Demo>
  );
}
