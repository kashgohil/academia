/** Demos for "io_uring": the shared rings, and the cost of each I/O path. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, range, toggle, useParams } from "../../kit";
import {
  ALL_MITIGATIONS, IO_PATH_LABEL, NO_MITIGATIONS, URING_FACTS, ioPathCost, replayRing,
  type IoPath, type IoRing, type UringAction,
} from "../../sims/os/io";
import { Banner } from "./SyncShared";
import { Cap, Panel, mono, seg, tint } from "./ProcessesUi";

// ---------------------------------------------------------------- ring stepper

const WRAP_START = 2 ** 32 - 3;

function Strip({ title, n, filled, head, tail, headName, tailName, rawHead, rawTail, color, label }: { title: string; n: number; filled: (i: number) => boolean; head: number; tail: number; headName: string; tailName: string; rawHead: number; rawTail: number; color: string; label: (i: number) => string }) {
  const hi = head & (n - 1), ti = tail & (n - 1);
  const pct = 100 / n;
  return (
    <div style={{ marginBottom: 12 }}>
      <Cap>{title}</Cap>
      <div style={{ position: "relative", paddingBottom: 34 }}>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} style={{ flex: 1, minWidth: 0, height: 28, background: filled(i) ? tint(color, 45) : "var(--bg)", borderLeft: i ? "1px solid var(--border)" : "none", textAlign: "center", lineHeight: "28px", fontSize: n > 8 ? 10.5 : 12, ...mono, transition: "background .15s", overflow: "hidden" }}>{label(i)}</div>
          ))}
        </div>
        <div style={{ position: "absolute", top: 30, left: `${hi * pct}%`, fontSize: 11, color: "var(--c1)", whiteSpace: "nowrap", transform: hi > n / 2 ? "translateX(-100%)" : undefined, transition: "left .15s" }}>▲ {headName}</div>
        <div style={{ position: "absolute", top: 44, left: `${ti * pct}%`, fontSize: 11, color: "var(--c5)", whiteSpace: "nowrap", transform: ti > n / 2 ? "translateX(-100%)" : undefined, transition: "left .15s" }}>▲ {tailName}</div>
      </div>
      <div style={{ ...mono, fontSize: 11.5, color: "var(--muted)", overflowWrap: "anywhere" }}>
        {headName} = {rawHead}, {tailName} = {rawTail}, slot = index &amp; {n - 1}, filled = {(rawTail - rawHead) >>> 0}
      </div>
    </div>
  );
}

const RG = {
  size: seg<"4" | "8">("SQ entries", [["4", "4"], ["8", "8"]], "4"),
  wrap: toggle({ label: "Start 3 steps before 2^32", default: false }),
  sqpoll: toggle({ label: "SQPOLL: a kernel thread reads the SQ", default: false }),
};

function Inflight({ ring, onDone }: { ring: IoRing; onDone: (id: number) => void }) {
  return (
    <Panel title="In flight in the kernel: press one to finish it, in any order" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 30, alignItems: "center" }}>
        {ring.inflight.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>Nothing.</span>}
        {ring.inflight.map((f) => <button key={f.sqe.userData} className="btn" onClick={() => onDone(f.sqe.userData)}>Op {f.sqe.userData}</button>)}
      </div>
    </Panel>
  );
}

export function IoRingDemo() {
  const p = useParams("io-ring2", RG);
  const entries = Number(p.values.size);
  const opts = { entries, start: p.values.wrap ? WRAP_START : 0, sqpoll: p.values.sqpoll };
  const [actions, setActions] = useState<UringAction[]>([]);
  const { ring, nextId, reaped } = useMemo(() => replayRing(opts, actions), [entries, p.values.wrap, p.values.sqpoll, actions]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = (a: UringAction) => setActions((x) => [...x, a]);
  const reset = () => setActions([]);
  const sqLabel = (i: number) => ring.sqes[i] ? String(ring.sqes[i]!.userData) : "";
  const cqLabel = (i: number) => ring.cqes[i] ? String(ring.cqes[i]!.userData) : "";
  const msg = ring.sqSpace === 0
    ? `The SQ is full: tail - head = ${ring.entries}. The application must submit first.`
    : reaped.length && reaped.map((c) => c.userData).some((v, i, a) => i > 0 && v < a[i - 1]!)
      ? "CQEs arrive in completion order, not submission order. The user_data field says which operation each one belongs to."
      : ring.sqpoll && ring.needWakeup ? "The SQPOLL thread sleeps. The flag IORING_SQ_NEED_WAKEUP tells the application to make one system call."
      : ring.sqpoll ? "The kernel thread reads the SQ, so that a new SQE costs no system call."
      : "The application writes an SQE and moves the tail. The kernel sees nothing until io_uring_enter.";
  return (
    <Demo
      title="Two rings in shared memory"
      actions={<button className="btn ghost" onClick={reset}>Reset</button>}
      controls={
        <>
          <Param spec={RG.size} value={p.values.size} onChange={(v) => { p.set("size", v as never); reset(); }} />
          <Param spec={RG.wrap} value={p.values.wrap} onChange={(v) => { p.set("wrap", v as boolean); reset(); }} />
          <Param spec={RG.sqpoll} value={p.values.sqpoll} onChange={(v) => { p.set("sqpoll", v as boolean); reset(); }} />
        </>
      }
    >
      <Strip title={`Submission queue: the application owns the tail, the kernel owns the head`} n={ring.entries} filled={(i) => !!ring.sqes[i]} head={ring.sqHead} tail={ring.sqTail} headName="SQ head" tailName="SQ tail" rawHead={ring.sqHead} rawTail={ring.sqTail} color="var(--c1)" label={sqLabel} />
      <Inflight ring={ring} onDone={(id) => add({ a: "complete", id })} />
      <Strip title={`Completion queue: the kernel owns the tail, the application owns the head`} n={ring.cqEntries} filled={(i) => !!ring.cqes[i]} head={ring.cqHead} tail={ring.cqTail} headName="CQ head" tailName="CQ tail" rawHead={ring.cqHead} rawTail={ring.cqTail} color="var(--c3)" label={cqLabel} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <button className="btn" onClick={() => add({ a: "push" })} disabled={ring.sqSpace === 0}>Write SQE {nextId}</button>
        {!p.values.sqpoll && <button className="btn" onClick={() => add({ a: "enter" })}>io_uring_enter</button>}
        {p.values.sqpoll && <button className="btn" onClick={() => add({ a: "poll" })}>SQPOLL thread looks</button>}
        {p.values.sqpoll && <button className="btn" onClick={() => add({ a: "sleep" })} disabled={ring.needWakeup}>Thread goes idle</button>}
        {p.values.sqpoll && <button className="btn" onClick={() => add({ a: "enter" })} disabled={!ring.needWakeup}>Wake it: io_uring_enter</button>}
        <button className="btn" onClick={() => add({ a: "reap" })} disabled={ring.cqReady === 0}>Read CQE</button>
      </div>
      <Banner>{msg}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "operations written", value: ring.pushed },
          { label: "system calls", value: ring.enterCalls },
          { label: "finished", value: ring.completed },
          { label: "CQEs read, in order", value: reaped.length ? reaped.map((c) => c.userData).join(", ") : "none" },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- cost per path

const PATHS: IoPath[] = ["read", "epoll", "uring", "sqpoll"];
const COLOR: Record<IoPath, string> = { read: "var(--c4)", epoll: "var(--c2)", uring: "var(--c1)", sqpoll: "var(--c3)" };

const PC = {
  batch: range({ label: "Operations per batch", min: 1, max: 256, log: true, default: 16, format: (v) => String(Math.round(v)) }),
  mitigations: toggle({ label: "CPU mitigations on", default: true }),
  fixed: toggle({ label: "Fixed files", default: false }),
};

const ns = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} ms` : v >= 1000 ? `${(v / 1000).toFixed(v >= 1e4 ? 0 : 2)} µs` : `${v.toFixed(0)} ns`);

export function IoPathCostDemo() {
  const p = useParams("io-pc", PC);
  const batch = Math.round(p.values.batch);
  const o = { mitigations: p.values.mitigations ? ALL_MITIGATIONS : NO_MITIGATIONS, fixedFiles: p.values.fixed };
  const xs = useMemo(() => Array.from({ length: 41 }, (_, i) => 2 ** (i / 5)), []);
  const curves = useMemo(() => PATHS.map((path) => xs.map((b) => ioPathCost(path, b, o))), [xs, p.values.mitigations, p.values.fixed]); // eslint-disable-line react-hooks/exhaustive-deps
  const now = PATHS.map((path) => ioPathCost(path, batch, o));
  return (
    <Demo
      title="Syscalls and latency per operation"
      controls={
        <>
          <Param spec={PC.batch} value={p.values.batch} onChange={(v) => p.set("batch", v as number)} />
          <Param spec={PC.mitigations} value={p.values.mitigations} onChange={(v) => p.set("mitigations", v as boolean)} />
          <Param spec={PC.fixed} value={p.values.fixed} onChange={(v) => p.set("fixed", v as boolean)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <div>
          <Cap>System calls per operation</Cap>
          <Plot x={[1, 256]} y={[0, 2.1]} logX height={190} xTicks={[1, 4, 16, 64, 256]} xFormat={(v) => String(v)} xLabel="operations per batch">
            {PATHS.map((path, i) => <Line key={path} points={curves[i]!.map((c, k) => [xs[k]!, c.syscallsPerOp] as [number, number])} color={COLOR[path]} />)}
            <RuleX at={batch} />
          </Plot>
        </div>
        <div>
          <Cap>Latency per operation, with batch fill time</Cap>
          <Plot x={[1, 256]} y={[500, 1e6]} logX logY height={190} xTicks={[1, 4, 16, 64, 256]} yTicks={[1e3, 1e4, 1e5, 1e6]} xFormat={(v) => String(v)} yFormat={ns} xLabel="operations per batch">
            {PATHS.map((path, i) => <Line key={path} points={curves[i]!.map((c, k) => [xs[k]!, c.latencyNs] as [number, number])} color={COLOR[path]} />)}
            <RuleX at={batch} />
          </Plot>
        </div>
      </div>
      <Legend items={PATHS.map((path) => ({ label: IO_PATH_LABEL[path], color: COLOR[path] }))} />
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
          <thead><tr>{[`Batch of ${batch}`, "syscalls", "CPU", "latency", "spinning cores"].map((h, i) => <th key={h} style={{ textAlign: i ? "right" : "left", fontWeight: 500, padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{h}</th>)}</tr></thead>
          <tbody>
            {now.map((c) => (
              <tr key={c.path}>
                <td style={{ padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{IO_PATH_LABEL[c.path]}</td>
                <td style={{ ...mono, textAlign: "right", padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{c.syscallsPerOp.toFixed(3)}</td>
                <td style={{ ...mono, textAlign: "right", padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{ns(c.cpuNs)}</td>
                <td style={{ ...mono, textAlign: "right", padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{ns(c.latencyNs)}</td>
                <td style={{ ...mono, textAlign: "right", padding: "3px 6px", borderBottom: "1px solid var(--border)" }}>{c.extraCores}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
        Model inputs. Operations arrive every 5 µs, so a batch takes time to fill. An SQE is {URING_FACTS.sqeBytes} bytes and a CQE is {URING_FACTS.cqeBytes} bytes.
      </p>
    </Demo>
  );
}
