/** Demos for "critical sections": an interleaving stepper and the Peterson litmus run. */
import { useMemo } from "react";
import { Demo, Param, Stats, select, useParams, toggle } from "../../kit";
import { checkPeterson, counterProg, counterSchedules, petersonLitmus, petersonLitmusSrc, petersonProg, type CounterMode, type PetersonStores } from "../../sims/os/sync/critical";
import { inCritical } from "../../sims/os/sync/machine";
import { Banner, Cell, CellRow, MONO, MiniTable, SyncStepper } from "./SyncShared";

const SCHEMA = {
  scenario: select({
    label: "Program",
    options: [
      { value: "plain", label: "Counter, no lock" },
      { value: "cli-one-cpu", label: "Counter, cli on one CPU" },
      { value: "cli-two-cpus", label: "Counter, cli on two CPUs" },
      { value: "atomic", label: "Counter, atomic add" },
      { value: "peterson", label: "Peterson's algorithm" },
    ],
    default: "plain",
  }),
  memory: select({ label: "Memory", options: [{ value: "sc", label: "Sequential" }, { value: "tso", label: "x86-TSO" }], default: "sc", segmented: true }),
  fence: toggle({ label: "mfence after turn", default: false }),
};

const COUNTER_SCRIPTS: Record<string, { label: string; schedule: string[] }[]> = {
  plain: [
    { label: "Show a lost update", schedule: ["T0", "T1", "T0", "T1", "T0", "T1"] },
    { label: "Show a correct order", schedule: ["T0", "T0", "T0", "T1", "T1", "T1"] },
  ],
  "cli-two-cpus": [{ label: "Show a lost update", schedule: ["T0", "T1", "T0", "T1", "T0", "T1", "T0", "T1", "T0", "T1"] }],
  "cli-one-cpu": [],
  atomic: [],
};

export function SyncInterleaveDemo() {
  const P = useParams("os-sync-interleave", SCHEMA);
  const scenario = P.values.scenario as string;
  const isPeterson = scenario === "peterson";
  const tso = isPeterson && P.values.memory === "tso";
  const fence = isPeterson && tso && P.values.fence;
  const prog = useMemo(
    () => (isPeterson ? petersonProg({ tso, fence }) : counterProg(scenario as CounterMode)),
    [isPeterson, tso, fence, scenario],
  );
  const counts = useMemo(() => (isPeterson ? null : counterSchedules(scenario as CounterMode)), [isPeterson, scenario]);
  const pete = useMemo(() => (isPeterson ? checkPeterson({ tso, fence }) : null), [isPeterson, tso, fence]);
  const scripts = isPeterson
    ? pete?.violation ? [{ label: "Show the failing schedule", schedule: pete.violation.schedule }] : []
    : COUNTER_SCRIPTS[scenario] ?? [];

  return (
    <SyncStepper
      title="You are the scheduler"
      prog={prog}
      scripts={scripts}
      controls={
        <>
          <Param spec={SCHEMA.scenario} value={scenario} onChange={(v) => P.set("scenario", v as never)} />
          {isPeterson && <Param spec={SCHEMA.memory} value={P.values.memory} onChange={(v) => P.set("memory", v as never)} />}
          {tso && <Param spec={SCHEMA.fence} value={P.values.fence} onChange={(v) => P.set("fence", v as boolean)} />}
        </>
      }
      panel={({ s }) => (
        <CellRow>
          {isPeterson ? (
            <>
              <Cell name="flag[0]" value={s.mem.flag0} />
              <Cell name="flag[1]" value={s.mem.flag1} />
              <Cell name="turn" value={s.mem.turn} />
              <Cell name="in critical" value={inCritical(prog, s)} hot={inCritical(prog, s) > 1} />
            </>
          ) : (
            <>
              <Cell name="count" value={s.mem.count} />
              {s.mem.irqoff0 !== undefined && <Cell name="T0 irq" value={s.mem.irqoff0 ? "off" : "on"} />}
              {s.mem.irqoff1 !== undefined && <Cell name="T1 irq" value={s.mem.irqoff1 ? "off" : "on"} />}
            </>
          )}
        </CellRow>
      )}
      verdict={({ s, finished }) => {
        if (isPeterson) {
          if (inCritical(prog, s) > 1) return { tone: "bad", text: "Both threads are inside the critical section. Mutual exclusion failed." };
          return null;
        }
        if (!finished) return null;
        return s.mem.count === 2
          ? { tone: "good", text: "count = 2. This schedule is correct." }
          : { tone: "bad", text: `count = ${s.mem.count}. One increment is lost.` };
      }}
      footer={
        <div style={{ marginTop: 10 }}>
          {counts && (
            <Stats items={[
              { label: "complete schedules", value: counts.total },
              { label: "give count = 2", value: counts.correct },
              { label: "lose an update", value: counts.lost },
            ]} />
          )}
          {pete && (
            <Stats items={[
              { label: "states searched", value: pete.states },
              { label: "shortest failing schedule", value: pete.violation ? `${pete.violation.schedule.length} steps` : "none exists" },
            ]} />
          )}
        </div>
      }
    />
  );
}

const LIT_SCHEMA = {
  stores: select({
    label: "Code",
    options: [
      { value: "plain", label: "Plain stores (MOV)" },
      { value: "fence", label: "Add mfence" },
      { value: "seq-cst", label: "seq_cst (XCHG)" },
    ],
    default: "plain",
    segmented: true,
  }),
};

const Mark = ({ on }: { on: boolean }) => <span style={{ color: on ? "var(--fg)" : "var(--faint)" }}>{on ? "✓" : "·"}</span>;

export function SyncPetersonLitmusDemo() {
  const P = useParams("os-sync-litmus", LIT_SCHEMA);
  const kind = P.values.stores as PetersonStores;
  const res = useMemo(() => petersonLitmus(kind), [kind]);
  const src = useMemo(() => petersonLitmusSrc(kind), [kind]);
  const verdict = res.failsTso
    ? `Under x86-TSO, ${res.rows.filter((r) => r.both && r.tso).length} outcome(s) let both threads enter. Sequential consistency has none.`
    : res.failsCxx
      ? "x86-TSO has no failing outcome now. The C++ model still allows one, because relaxed atomics carry no ordering of their own."
      : "No model allows both threads to enter.";
  return (
    <Demo
      title="Peterson's entry protocol in the memory model explorer"
      controls={<Param spec={LIT_SCHEMA.stores} value={kind} onChange={(v) => P.set("stores", v as never)} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, alignItems: "start" }}>
        <pre style={{ margin: 0, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, padding: "8px 10px", background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto" }}>{src}</pre>
        <div>
          <MiniTable
            head={["r0 r1 r2 r3", "T0", "T1", "SC", "TSO", "C++"]}
            highlight={(i) => res.rows[i]!.both}
            rows={res.rows.map((r) => [
              <span key="r" style={{ fontFamily: MONO }}>{r.r0} {r.r1} {r.r2} {r.r3}</span>,
              r.t0 ? "enters" : "waits",
              r.t1 ? "enters" : "waits",
              <Mark key="sc" on={r.sc} />,
              <Mark key="t" on={r.tso} />,
              <Mark key="c" on={r.cxx} />,
            ])}
          />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            T0 enters if r0 = 0 or r1 is not 1. T1 enters if r2 = 0 or r3 is not 0. Highlighted rows let both enter.
          </div>
        </div>
      </div>
      <Banner tone={res.failsTso || res.failsCxx ? "bad" : "good"}>{verdict}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "SC states", value: res.sc.states },
          { label: "TSO states", value: res.tso.states },
          { label: "C++ states", value: res.cxx.states },
          { label: "outcomes (SC / TSO / C++)", value: `${res.sc.outcomes.length} / ${res.tso.outcomes.length} / ${res.cxx.outcomes.length}` },
        ]} />
      </div>
    </Demo>
  );
}
