/** Demos for "race conditions": check-then-act steppers, the race window, and a vector-clock race detector. */
import { useMemo } from "react";
import { Dots, Demo, Legend, Line, Note, Param, Plot, RuleX, Stats, MONO, fixed, int, pct, range, seg, select, useChunked, useParams } from "../../kit";
import {
  CTA_LABELS, FILE_KIND, HB_LABELS, HB_SYNC, HB_VARS, chanceToSee, ctaBugSchedule, ctaCounts, ctaOutcome, ctaProg,
  hbCounts, hbProg, opsToSee, windowEstimate, windowRun, type CtaProgram, type HbProgram,
} from "../../sims/conc/foundations";
import { allDone } from "../../sims/os/sync/machine";
import { Cell, CellRow, SyncStepper } from "../os/SyncShared";

// ---------------------------------------------------------------- check-then-act

const CTA = {
  program: select({ label: "Program", options: (Object.keys(CTA_LABELS) as CtaProgram[]).map((k) => ({ value: k, label: CTA_LABELS[k] })), default: "withdraw" as CtaProgram }),
};

export function ConcFoundCheckActDemo() {
  const P = useParams("conc-found-cta", CTA);
  const program = P.values.program as CtaProgram;
  const prog = useMemo(() => ctaProg(program), [program]);
  const counts = useMemo(() => ctaCounts(program), [program]);
  const bug = useMemo(() => ctaBugSchedule(program), [program]);
  const kind = program.startsWith("withdraw") ? "withdraw" : program.startsWith("lazy") ? "lazy" : "toctou";
  return (
    <SyncStepper
      title="Check, then act"
      prog={prog}
      scripts={bug ? [{ label: "Show the bug", schedule: bug }] : []}
      hideRegs={["old", "target", "fd", "cfg"]}
      controls={<Param spec={CTA.program} value={program} onChange={(v) => P.set("program", v as never)} />}
      panel={({ s }) => (
        <CellRow>
          {kind === "withdraw" && <>
            <Cell name="balance" value={s.mem.balance} hot={s.mem.balance! < 0} />
            <Cell name="T0 paid" value={s.mem.paid0 ? 80 : 0} />
            <Cell name="T1 paid" value={s.mem.paid1 ? 80 : 0} />
            {program === "withdraw-lock" && <Cell name="m" value={s.mem.m ? "held" : "free"} />}
          </>}
          {kind === "lazy" && <>
            <Cell name="cfg" value={s.mem.cfg ? `#${s.mem.cfg}` : "nil"} />
            <Cell name="configs created" value={s.mem.made} hot={s.mem.made! > 1} />
            {program === "lazy-once" && <Cell name="once" value={["new", "running", "done"][s.mem.once!]} width={80} />}
          </>}
          {kind === "toctou" && <>
            <Cell name="/tmp/report is" value={FILE_KIND[s.mem.file!]} width={190} hot={s.mem.file === 2} />
          </>}
        </CellRow>
      )}
      verdict={({ s, finished }) => {
        if (!finished || !allDone(prog, s)) return null;
        const o = ctaOutcome(program, s);
        return { tone: o.bad ? "bad" : "good", text: `Finished: ${o.text}.` };
      }}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "complete schedules", value: counts.total },
            { label: "schedules with the bug", value: counts.bad },
            { label: "data races", value: "none: each step is atomic" },
          ]} />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- the race window

const WIN = {
  window: range({ label: "Window from check to act", min: 5, max: 5000, log: true, default: 20, format: (v) => `${sigNs(v)}` }),
  think: range({ label: "Other work between operations", min: 1000, max: 1_000_000, log: true, default: 10_000, format: (v) => sigNs(v) }),
  cores: seg("Machine", [["2", "2 threads, 2 cores"], ["1", "2 threads, 1 core"]], "2"),
  test: range({ label: "Operations in one test run", min: 10, max: 100_000, log: true, default: 100, format: (v) => int(v) }),
};

function sigNs(v: number) {
  if (v >= 1_000_000) return `${fixed(v / 1e6, v >= 1e7 ? 0 : 1)} ms`;
  if (v >= 1000) return `${fixed(v / 1000, v >= 10_000 ? 0 : 1)} µs`;
  return `${Math.round(v)} ns`;
}

const WINDOWS = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const OPS = 20_000;

export function ConcFoundWindowDemo() {
  const P = useParams("conc-found-window", WIN);
  const { window: w, think, test } = P.values;
  const cores = Number(P.values.cores);
  const jobs = useMemo(() => WINDOWS.map((x) => () => windowRun({ threads: 2, cores, windowNs: x, thinkNs: think, ops: OPS, seed: 7 })), [cores, think]);
  const sims = useChunked(`${cores}/${think}`, jobs, { keep: true });
  const est = WINDOWS.map((x) => [x, Math.max(1e-7, windowEstimate(2, cores, x, think))] as [number, number]);
  const dots = WINDOWS.flatMap((x, i) => (sims[i] && sims[i]!.p > 0 ? [[x, sims[i]!.p] as [number, number]] : []));
  const p = windowEstimate(2, cores, w, think);
  const see = chanceToSee(p, test);
  const need = opsToSee(p);
  return (
    <Demo
      title="How often does the race fire?"
      controls={<>
        <Param spec={WIN.window} value={w} onChange={(v) => P.set("window", v as number)} />
        <Param spec={WIN.think} value={think} onChange={(v) => P.set("think", v as number)} />
        <Param spec={WIN.cores} value={P.values.cores} onChange={(v) => P.set("cores", v as never)} />
        <Param spec={WIN.test} value={test} onChange={(v) => P.set("test", v as number)} />
      </>}
    >
      <Plot x={[5, 5000]} y={[1e-6, 1]} logX logY height={230} xLabel="window (ns)" yLabel="chance per operation" xTicks={[5, 10, 50, 100, 500, 1000, 5000]} yTicks={[1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1]} yFormat={(v) => (v >= 0.01 ? `${v * 100}%` : `1e${Math.round(Math.log10(v))}`)}>
        <RuleX at={w} color="var(--c2)" />
        <Line points={est} color="var(--c1)" />
        <Dots points={dots} color="var(--c4)" r={3.5} />
      </Plot>
      <Legend items={[{ label: cores === 1 ? "estimate w / q" : "estimate w / (T + w)", color: "var(--c1)" }, { label: `Runtime, ${int(2 * OPS)} operations per point`, color: "var(--c4)" }]} />
      <Stats items={[
        { label: "chance per operation", value: p >= 1e-3 ? pct(p, 2) : `${fixed(p * 1e6, 1)} per million` },
        { label: "one firing per", value: p > 0 ? `${int(1 / p)} ops` : "never" },
        { label: `a ${int(test)}-op test sees it`, value: pct(see, see < 0.01 ? 2 : 0) },
        { label: "ops for a 99% chance", value: Number.isFinite(need) ? int(need) : "never" },
      ]} />
      <Note>
        Two threads repeat: other work (random, mean T), read a shared counter, hold the value for the window w, write it + 1.
        {cores === 1 ? " On one core the window breaks only when the time slice q ends inside it. q = 1 ms is a model input." : " Each thread has its own core, so the other thread can write at any moment."}
        {" "}Dots at zero firings are not drawn.
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- the detector

const HB = {
  program: select({ label: "Program", options: (Object.keys(HB_LABELS) as HbProgram[]).map((k) => ({ value: k, label: HB_LABELS[k] })), default: "one-forgets" as HbProgram }),
};

const vc = (a: number, b: number) => `[${a}, ${b}]`;

export function ConcFoundDetectorDemo() {
  const P = useParams("conc-found-hb", HB);
  const program = P.values.program as HbProgram;
  const prog = useMemo(() => hbProg(program), [program]);
  const counts = useMemo(() => hbCounts(program), [program]);
  const box = { border: "1px solid var(--border)", borderRadius: 6, padding: 8, minWidth: 0 } as const;
  return (
    <SyncStepper
      title="A happens-before race detector"
      prog={prog}
      controls={<Param spec={HB.program} value={program} onChange={(v) => P.set("program", v as never)} />}
      panel={({ s }) => {
        const m = s.mem;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 8 }}>
            <div style={box}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Vector clocks</div>
              <div style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6 }}>
                <div><span style={{ color: "var(--c1)" }}>C(T0)</span> = {vc(m["C0.0"]!, m["C0.1"]!)}</div>
                <div><span style={{ color: "var(--c2)" }}>C(T1)</span> = {vc(m["C1.0"]!, m["C1.1"]!)}</div>
                {HB_SYNC[program].map((o) => <div key={o}>L({o}) = {vc(m[`L${o}.0`]!, m[`L${o}.1`]!)}</div>)}
              </div>
            </div>
            <div style={box}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Shadow state per variable</div>
              <div style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6 }}>
                {HB_VARS[program].map((x) => (
                  <div key={x} style={{ color: m[`race.${x}`] ? "var(--c4)" : undefined }}>
                    {x}: W = {m[`W${x}.t`]! < 0 ? "none" : `${m[`W${x}.c`]}@T${m[`W${x}.t`]}`}, R = {vc(m[`R${x}.0`]!, m[`R${x}.1`]!)}{m[`race.${x}`] ? "  RACE" : ""}
                  </div>
                ))}
              </div>
            </div>
            <CellRow>
              {program === "both-lock" || program === "one-forgets" ? <Cell name="x" value={m.x} /> : <><Cell name="data" value={m.data} /><Cell name="done" value={m.done} /></>}
              <Cell name="races found" value={m.race} hot={m.race! > 0} />
            </CellRow>
          </div>
        );
      }}
      verdict={({ s, finished }) => {
        if (!finished) return s.mem.race ? { tone: "bad", text: "The detector has reported a race. The program may still give the right answer in this run." } : null;
        const right = program === "both-lock" || program === "one-forgets" ? s.mem.x === 2 : s.th[1]!.r.r === 42;
        return { tone: s.mem.race ? "bad" : "good", text: `Result ${right ? "right" : "WRONG"}. ${s.mem.race ? `Races reported: ${s.mem.race}.` : "No race reported."}` };
      }}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "complete schedules", value: counts.total },
            { label: "give a wrong result", value: counts.wrong },
            { label: "the detector reports a race", value: counts.raced },
          ]} />
        </div>
      }
    />
  );
}
