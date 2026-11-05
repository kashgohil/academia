/** Demos for "condition variables": a stepper that finds the bug schedule, and the thundering herd. */
import { useMemo } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, range, select, si, toggle, useParams, MONO, MiniTable } from "../../kit";
import { HERD_SWITCH_NS, checkCondvar, checkFutexCondvar, condvarProg, futexCondvarProg, simulateHerd, type CvOpts, type CvScenario, type Guard, type Notify } from "../../sims/os/sync/condvar";
import { Cell, CellRow, SyncStepper, TC } from "./SyncShared";

const CV = {
  guard: select({ label: "Guard", options: [{ value: "if", label: "if" }, { value: "while", label: "while" }], default: "if", segmented: true }),
  notify: select({ label: "Notify", options: [{ value: "signal", label: "signal" }, { value: "broadcast", label: "broadcast" }], default: "signal", segmented: true }),
  scenario: select({ label: "Program", options: [{ value: "consumers", label: "2 consumers, 2 producers" }, { value: "bounded", label: "Capacity 1, one condvar" }], default: "consumers", segmented: true }),
  mode: select({
    label: "Variation",
    options: [
      { value: "mesa", label: "Mesa (normal)" },
      { value: "hoare", label: "Hoare handoff" },
      { value: "spurious", label: "Spurious wakeups" },
      { value: "broken", label: "Unlock, then join queue" },
    ],
    default: "mesa",
  }),
};

const verdictOf = (e: ReturnType<typeof checkCondvar>) =>
  e.violation ? `${e.violation.message.split(":")[0]} (${e.violation.schedule.length} steps)` : e.stuck ? `Stuck (${e.stuck.schedule.length} steps)` : "correct";

export function SyncCondvarDemo() {
  const P = useParams("os-sync-cv", CV);
  const guard = P.values.guard as Guard;
  const notify = P.values.notify as Notify;
  const scenario = P.values.scenario as CvScenario;
  const mode = P.values.mode as string;
  const base = useMemo<Partial<CvOpts>>(() => ({
    scenario,
    hoare: mode === "hoare" && notify === "signal" && scenario === "consumers",
    spurious: mode === "spurious",
    nonAtomicWait: mode === "broken",
  }), [mode, notify, scenario]);
  const prog = useMemo(() => condvarProg({ guard, notify, ...base }), [guard, notify, base]);
  const matrix = useMemo(() => (["if", "while"] as Guard[]).map((g) => (["signal", "broadcast"] as Notify[]).map((n) => {
    const hoare = mode === "hoare" && n === "signal" && scenario === "consumers";
    return checkCondvar({ guard: g, notify: n, ...base, hoare });
  })), [base, mode, scenario]);
  const cur = matrix[guard === "if" ? 0 : 1]![notify === "signal" ? 0 : 1]!;
  const bug = cur.violation ?? cur.stuck;
  return (
    <SyncStepper
      title="Find the bug schedule"
      prog={prog}
      scripts={bug ? [{ label: "Show the shortest bug schedule", schedule: bug.schedule }] : []}
      hideRegs={["k", "woken", "gave"]}
      controls={
        <>
          <Param spec={CV.guard} value={guard} onChange={(v) => P.set("guard", v as never)} />
          <Param spec={CV.notify} value={notify} onChange={(v) => P.set("notify", v as never)} />
          <Param spec={CV.scenario} value={scenario} onChange={(v) => P.set("scenario", v as never)} />
          <Param spec={CV.mode} value={mode} onChange={(v) => P.set("mode", v as never)} />
        </>
      }
      panel={({ s }) => (
        <CellRow>
          <Cell name="count" value={s.mem.count} />
          <Cell name="m owner" value={s.mem.m ? (prog.names?.[s.mem.m - 1] ?? "") : "free"} />
          <div style={{ minWidth: 110 }}>
            <div className="muted" style={{ fontSize: 11, fontFamily: MONO, marginBottom: 2 }}>cv queue</div>
            <div style={{ display: "flex", gap: 3, minHeight: 32, alignItems: "center", border: "1px solid var(--border)", borderRadius: 5, padding: "0 6px" }}>
              {s.q.cv!.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
              {s.q.cv!.map((t) => <span key={t} style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--bg)", background: TC[t % TC.length], borderRadius: 3, padding: "1px 5px" }}>{prog.names?.[t]}</span>)}
            </div>
          </div>
        </CellRow>
      )}
      verdict={({ finished }) => (finished ? { tone: "good", text: "All threads finished. This schedule is fine, but try to find a bad one." } : null)}
      footer={
        <div style={{ marginTop: 10 }}>
          {mode === "hoare" && !(notify === "signal" && scenario === "consumers") && (
            <div style={{ fontSize: 12, color: "var(--c4)", marginBottom: 6 }}>Hoare handoff applies only to signal in the consumers program. This run uses Mesa rules.</div>
          )}
          <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Exhaustive search of every schedule, for this program:</div>
          <MiniTable
            head={["", "signal", "broadcast"]}
            highlight={(i) => (i === 0 ? guard === "if" : guard === "while")}
            rows={["if", "while"].map((g, i) => [g, verdictOf(matrix[i]![0]!), verdictOf(matrix[i]![1]!)])}
          />
        </div>
      }
    />
  );
}

const FCV = { nocheck: toggle({ label: "Remove the kernel's value check", default: false }) };

export function SyncFutexCondvarDemo() {
  const P = useParams("os-sync-fcv", FCV);
  const check = !P.values.nocheck;
  const prog = useMemo(() => futexCondvarProg(check), [check]);
  const res = useMemo(() => checkFutexCondvar(check), [check]);
  return (
    <SyncStepper
      title="A condvar built on one futex word"
      prog={prog}
      hideRegs={[]}
      scripts={[
        { label: "Notify in the window", schedule: ["T0", "T0", "T0", "T0", "T1", "T1", "T1", "T1", "T1"] },
        ...(res.stuck ? [{ label: "Show the shortest lost wakeup", schedule: res.stuck.schedule }] : []),
      ]}
      controls={<Param spec={FCV.nocheck} value={P.values.nocheck} onChange={(v) => P.set("nocheck", v as boolean)} />}
      panel={({ s }) => (
        <CellRow>
          <Cell name="ready" value={s.mem.ready} />
          <Cell name="seq" value={s.mem.seq} note="futex word" />
          <Cell name="m" value={s.mem.m ? "held" : "free"} />
          <Cell name="kernel queue" value={s.q.seq!.length ? "waiter" : "empty"} width={90} />
        </CellRow>
      )}
      verdict={({ finished }) => (finished ? { tone: "good", text: "The waiter saw ready = 1." } : null)}
      footer={<div style={{ marginTop: 10 }}><Stats items={[{ label: "states searched", value: res.states }, { label: "reachable lost wakeup", value: res.stuck ? "yes" : "none" }]} /></div>}
    />
  );
}

// ---------------------------------------------------------------- the herd

const HERD = { waiters: range({ label: "Waiters", min: 2, max: 64, step: 1, default: 16 }) };

export function SyncHerdDemo() {
  const P = useParams("os-sync-herd", HERD);
  const w = Math.round(P.values.waiters);
  const xs = useMemo(() => Array.from({ length: 63 }, (_, i) => i + 2), []);
  const lines = useMemo(() => ({
    bw: xs.map((x) => [x, simulateHerd(x, "broadcast").wakeups] as [number, number]),
    br: xs.map((x) => [x, simulateHerd(x, "broadcast").resleeps] as [number, number]),
    sw: xs.map((x) => [x, simulateHerd(x, "signal").wakeups] as [number, number]),
  }), [xs]);
  const b = simulateHerd(w, "broadcast");
  const s = simulateHerd(w, "signal");
  return (
    <Demo title="One item at a time: wakeups and sleeps again" controls={<Param spec={HERD.waiters} value={P.values.waiters} onChange={(v) => P.set("waiters", v as number)} />}>
      <Plot x={[2, 64]} y={[1, 3000]} logY height={230} xLabel="waiters" yLabel="count for the whole run" yTicks={[1, 10, 100, 1000]}>
        <Line points={lines.bw} color="var(--c4)" />
        <Line points={lines.br} color="var(--c2)" dash="4 3" />
        <Line points={lines.sw} color="var(--c3)" />
        <RuleX at={w} />
      </Plot>
      <Legend items={[{ label: "broadcast: wakeups", color: "var(--c4)" }, { label: "broadcast: sleep again", color: "var(--c2)" }, { label: "signal: wakeups (no sleep again)", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={[`${w} waiters`, "wakeups", "sleep again", "CPU"]}
          rows={[
            ["signal", s.wakeups, s.resleeps, si(s.cpuNs * 1e-9, "s", 3)],
            ["broadcast", b.wakeups, b.resleeps, si(b.cpuNs * 1e-9, "s", 3)],
          ]}
        />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>CPU uses a model input of {si(HERD_SWITCH_NS * 1e-9, "s")} for each sleep or wake.</div>
      </div>
    </Demo>
  );
}
