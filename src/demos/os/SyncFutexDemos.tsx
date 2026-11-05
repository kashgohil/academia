/** Demos for "futexes": a mutex stepper with the lost wakeup, syscall counts, and the hash table. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, Stats, range, select, toggle, useParams, Banner, MONO, useChunked } from "../../kit";
import { FUTEX_FAST_SCHEDULE, FUTEX_SLOW_SCHEDULE, FutexTable, LOAD_DEFAULTS, LOAD_THREADS, checkFutexMutex, futexLoad, futexMutexProg, type FutexLoad, type MutexVariant } from "../../sims/os/sync/futex";
import { Cell, CellRow, SyncStepper, TC } from "./SyncShared";

const SCHEMA = {
  variant: select({ label: "Mutex", options: [{ value: "three-state", label: "3-state (Drepper)" }, { value: "two-state", label: "2-state (naive)" }], default: "three-state", segmented: true }),
  nocheck: toggle({ label: "Remove the kernel's value check", default: false }),
};

const VAL_MEANING: Record<MutexVariant, Record<number, string>> = {
  "three-state": { 0: "free", 1: "held, no waiters", 2: "held, maybe waiters" },
  "two-state": { 0: "free", 1: "held" },
};

export function SyncFutexStepperDemo() {
  const P = useParams("os-sync-futex", SCHEMA);
  const variant = P.values.variant as MutexVariant;
  const check = !P.values.nocheck;
  const prog = useMemo(() => futexMutexProg({ variant, check }), [variant, check]);
  const res = useMemo(() => checkFutexMutex({ variant, check }), [variant, check]);
  const scripts = [];
  if (variant === "three-state") {
    scripts.push({ label: "Fast path: no contention", schedule: FUTEX_FAST_SCHEDULE });
    if (check) scripts.push({ label: "Slow path: T1 sleeps, T0 wakes it", schedule: FUTEX_SLOW_SCHEDULE });
  }
  if (res.stuck) scripts.push({ label: "Show the lost wakeup", schedule: res.stuck.schedule });
  return (
    <SyncStepper
      title="A futex mutex, step by step"
      prog={prog}
      scripts={scripts}
      hideRegs={["counted", "i"]}
      controls={
        <>
          <Param spec={SCHEMA.variant} value={variant} onChange={(v) => P.set("variant", v as never)} />
          <Param spec={SCHEMA.nocheck} value={P.values.nocheck} onChange={(v) => P.set("nocheck", v as boolean)} />
        </>
      }
      panel={({ s }) => (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>User space: shared memory</div>
            <CellRow><Cell name="val" value={s.mem.val} note={VAL_MEANING[variant][s.mem.val!] ?? ""} width={130} /></CellRow>
          </div>
          <div style={{ border: "1px solid var(--c5)", borderRadius: 6, padding: 8, background: "var(--subtle)" }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Kernel: wait queue for this word</div>
            <div style={{ display: "flex", gap: 4, minHeight: 30, alignItems: "center" }}>
              {s.q.val!.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
              {s.q.val!.map((t) => <span key={t} style={{ fontFamily: MONO, fontSize: 12.5, color: "var(--bg)", background: TC[t], borderRadius: 4, padding: "2px 8px" }}>T{t}</span>)}
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>syscalls: {s.n.syscalls ?? 0}. EAGAIN: {s.n.eagain ?? 0}.</div>
          </div>
        </div>
      )}
      verdict={({ finished, s }) => (finished ? { tone: "good", text: `Both threads finished with ${s.n.syscalls ?? 0} syscall(s).` } : null)}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "states searched", value: res.states },
            { label: "reachable stuck states", value: res.stuck ? `yes: ${res.stuck.schedule.length}-step schedule` : "none" },
            { label: "mutual exclusion", value: res.violation ? "fails" : "holds" },
          ]} />
        </div>
      }
    />
  );
}

const LOAD = {
  cs: range({ label: "Critical section", min: 2, max: 80, step: 1, default: LOAD_DEFAULTS.cs, format: (v) => `${v} ticks` }),
  work: range({ label: "Mean work between locks", min: 20, max: 400, step: 10, default: LOAD_DEFAULTS.work, format: (v) => `${v} ticks` }),
  syscall: range({ label: "Syscall entry (model input)", min: 1, max: 20, step: 1, default: LOAD_DEFAULTS.syscall, format: (v) => `${v} ticks` }),
};

export function SyncFutexLoadDemo() {
  const P = useParams("os-sync-load", LOAD);
  const { cs, work, syscall } = P.values;
  const tasks = useMemo(
    () => (["two-state", "three-state"] as MutexVariant[]).flatMap((v) => LOAD_THREADS.map((n) => () => futexLoad(v, n, { cs, work, syscall }))),
    [cs, work, syscall],
  );
  const results = useChunked<FutexLoad>(`${cs}/${work}/${syscall}`, tasks);
  const line = (k: number) => LOAD_THREADS.flatMap((n, i) => { const r = results[k * LOAD_THREADS.length + i]; return r ? [[n, r.perPair] as [number, number]] : []; });
  const two = line(0);
  const three = line(1);
  const maxY = Math.max(2.5, ...two.map((p) => p[1]), ...three.map((p) => p[1]));
  const at = (k: number, n: number) => results[k * LOAD_THREADS.length + LOAD_THREADS.indexOf(n)];
  return (
    <Demo
      title="Syscalls per lock and unlock"
      controls={
        <>
          <Param spec={LOAD.cs} value={cs} onChange={(v) => P.set("cs", v as number)} />
          <Param spec={LOAD.work} value={work} onChange={(v) => P.set("work", v as number)} />
          <Param spec={LOAD.syscall} value={syscall} onChange={(v) => P.set("syscall", v as number)} />
        </>
      }
    >
      <Plot x={[1, 16]} y={[0, maxY * 1.05]} height={230} xLabel="threads" yLabel="syscalls per lock + unlock pair" xTicks={[1, 2, 4, 8, 12, 16]}>
        <Line points={two} color="var(--c4)" />
        <Line points={three} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "2-state", color: "var(--c4)" }, { label: "3-state", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "2-state, 1 thread", value: at(0, 1)?.perPair.toFixed(2) ?? "…" },
          { label: "3-state, 1 thread", value: at(1, 1)?.perPair.toFixed(2) ?? "…" },
          { label: "2-state, 16 threads", value: at(0, 16)?.perPair.toFixed(2) ?? "…" },
          { label: "3-state, 16 threads", value: at(1, 16)?.perPair.toFixed(2) ?? "…" },
          { label: "locks that found it held, 16 threads", value: at(1, 16) ? `${Math.round(at(1, 16)!.contended * 100)}%` : "…" },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- the hash table

type Op = { op: "wait"; addr: number; thread: number } | { op: "wake"; addr: number; n: number } | { op: "requeue"; from: number; to: number };

const ADDRS = [0x1000, 0x1040, 0x2000, 0x2040];
const BUCKETS = 4;
const addrName = (a: number) => `0x${a.toString(16)}`;

function replayTable(ops: Op[]) {
  const t = new FutexTable(BUCKETS, () => 0);
  let last = "Put threads to sleep on some addresses. Then wake one address.";
  let thread = 0;
  for (const o of ops) {
    if (o.op === "wait") { t.wait(o.addr, 0, thread++); last = `Thread ${thread - 1} sleeps on ${addrName(o.addr)} in bucket ${t.bucketOf(o.addr)}.`; }
    else if (o.op === "wake") {
      const before = t.scanned;
      const w = t.wake(o.addr, o.n);
      last = `FUTEX_WAKE(${addrName(o.addr)}, ${o.n}) walks ${t.scanned - before} entr${t.scanned - before === 1 ? "y" : "ies"} in bucket ${t.bucketOf(o.addr)} and wakes ${w.length ? w.map((x) => `thread ${x}`).join(", ") : "nobody"}.`;
    } else {
      const r = t.cmpRequeue(o.from, o.to, 1, 1000, 0);
      if (r !== "EAGAIN") last = `FUTEX_CMP_REQUEUE wakes ${r.woken.length} and moves ${r.moved} waiter(s) from ${addrName(o.from)} to ${addrName(o.to)} with no wakeup.`;
    }
  }
  return { t, last };
}

export function SyncFutexHashDemo() {
  const [ops, setOps] = useState<Op[]>([]);
  const [sel, setSel] = useState(0);
  const { t, last } = useMemo(() => replayTable(ops), [ops]);
  const addr = ADDRS[sel]!;
  const other = ADDRS[(sel + 1) % ADDRS.length]!;
  return (
    <Demo title="The futex hash table" actions={<button className="btn ghost" onClick={() => setOps([])}>Reset</button>}>
      <div className="seg" style={{ marginBottom: 8 }}>
        {ADDRS.map((a, i) => <button key={a} className={i === sel ? "on" : ""} onClick={() => setSel(i)}>{addrName(a)}</button>)}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <button className="btn" onClick={() => setOps([...ops, { op: "wait", addr, thread: 0 }])}>FUTEX_WAIT here</button>
        <button className="btn" onClick={() => setOps([...ops, { op: "wake", addr, n: 1 }])}>FUTEX_WAKE 1</button>
        <button className="btn" onClick={() => setOps([...ops, { op: "wake", addr, n: 1000 }])}>FUTEX_WAKE all</button>
        <button className="btn" onClick={() => setOps([...ops, { op: "requeue", from: addr, to: other }])}>Requeue to {addrName(other)}</button>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {t.buckets.map((b, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 28, border: `1px solid ${i === t.bucketOf(addr) ? "var(--fg)" : "var(--border)"}`, borderRadius: 5, padding: "2px 6px", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 11, width: 56, flex: "none" }}>bucket {i}</span>
            {b.length === 0 && <span className="muted" style={{ fontSize: 11 }}>empty</span>}
            {b.map((w, k) => (
              <span key={k} style={{ fontFamily: MONO, fontSize: 11, color: "var(--bg)", background: TC[ADDRS.indexOf(w.addr) % TC.length], borderRadius: 3, padding: "1px 5px" }}>
                T{w.thread} @{addrName(w.addr)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <Banner>{last}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "bucket of the selected address", value: t.bucketOf(addr) },
          { label: "waiters on this address", value: t.waiters(addr).length },
          { label: "entries walked so far", value: t.scanned },
        ]} />
      </div>
    </Demo>
  );
}
