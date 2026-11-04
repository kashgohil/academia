/** Lesson: ptrace and strace. A tracer and tracee stepper, a breakpoint stepper, and an overhead plot. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, range, select, si, useParams } from "../../kit";
import {
  DEMO_PROGRAM, FN_ADDR, INT3, RFLAGS_BASE, TEXT_BASE, TF_BIT, TRACE_INPUTS, breakpointSteps, instructionList, slowdown, stopNs, straceSteps,
  type Mistake, type StraceStep, type UserRegs,
} from "../../sims/os/observability";
import { Cap, Msg, Note, Panel, StepButtons, StepSlider, mono, seg, tint } from "./ProcessesUi";

const hex = (n: number) => `0x${n.toString(16)}`;
const hex2 = (n: number) => n.toString(16).padStart(2, "0");

// ---------------------------------------------------------------------------- tracer and tracee

const REG_NAMES: (keyof UserRegs)[] = ["orig_rax", "rax", "rdi", "rsi", "rdx", "rip"];
const regText = (name: keyof UserRegs, v: number) => (name === "rax" || name === "orig_rax" ? String(v) : hex(v));

function Ladder({ steps, k, set }: { steps: StraceStep[]; k: number; set: (v: number) => void }) {
  const row = (who: "tracer" | "tracee", color: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 11, color: "var(--muted)", width: 42, flex: "none" }}>{who}</span>
      <div style={{ flex: 1, display: "flex", minWidth: 0, height: 14 }}>
        {steps.map((s, i) => (
          <button key={i} aria-label={`Step ${i + 1}`} onClick={() => set(i)} style={{ flex: 1, minWidth: 0, padding: 0, border: 0, cursor: "pointer", borderRight: "1px solid var(--bg)", background: s.onCpu === who ? color : "var(--subtle)", outline: i === k ? "2px solid var(--fg)" : "none", outlineOffset: -2 }} />
        ))}
      </div>
    </div>
  );
  return (
    <div style={{ display: "grid", gap: 2, marginBottom: 8 }}>
      {row("tracer", "var(--c1)")}
      {row("tracee", "var(--c3)")}
    </div>
  );
}

export function PtraceStepperDemo() {
  const p = useParams("pt-step", {
    mode: seg("How strace runs", [["all", "PTRACE_SYSCALL"], ["seccomp", "--seccomp-bpf"]], "all"),
    filter: seg("Which calls to print", [["all", "all"], ["write", "-e trace=write"]], "all"),
  });
  const [k, setK] = useState(0);
  const steps = useMemo(() => straceSteps(DEMO_PROGRAM, { mode: p.values.mode as "all" | "seccomp", traced: p.values.filter === "write" ? ["write"] : undefined }), [p.values.mode, p.values.filter]);
  const kk = Math.min(k, steps.length - 1);
  const s = steps[kk]!;
  const tracerState = s.onCpu === "tracer" ? "running" : "blocked in waitpid";
  const traceeState = s.state === "exited" ? "exited" : s.state === "stopped" ? `TASK_TRACED${s.stop ? ` (${s.stop})` : ""}` : s.onCpu === "tracee" ? "running" : "ready";
  return (
    <Demo
      title="Two processes, one CPU: each stop is a switch"
      actions={<StepButtons k={kk} n={steps.length} set={setK} />}
      controls={<>
        <StepSlider k={kk} n={steps.length} set={setK} />
        <Param spec={p.schema.mode} value={p.values.mode} onChange={(v) => { p.set("mode", v as "all"); setK(0); }} />
        <Param spec={p.schema.filter} value={p.values.filter} onChange={(v) => { p.set("filter", v as "all"); setK(0); }} />
      </>}
    >
      <Ladder steps={steps} k={kk} set={setK} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginBottom: 8 }}>
        <Panel title="Tracer (strace)" active={s.onCpu === "tracer"}><div style={{ fontSize: 12.5 }}>{tracerState}</div></Panel>
        <Panel title="Tracee" active={s.onCpu === "tracee"}><div style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{traceeState}</div></Panel>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{s.title}</div>
      <Msg min={56}>{s.text}</Msg>
      <div style={{ ...mono, fontSize: 12, minHeight: 34, marginBottom: 8, overflowWrap: "anywhere", color: "var(--muted)" }}>{s.call ?? ""}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))", gap: 4, marginBottom: 8 }}>
        {REG_NAMES.map((r) => {
          const hot = s.read?.includes(r);
          return (
            <div key={r} style={{ border: `1px solid ${hot ? "var(--c2)" : "var(--border)"}`, background: hot ? tint("var(--c2)", 14) : "var(--bg)", borderRadius: 4, padding: "2px 6px", minWidth: 0 }}>
              <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{r}</div>
              <div style={{ ...mono, fontSize: 12 }}>{regText(r, s.regs[r])}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
        <Panel title="Word that PTRACE_PEEKDATA read" active={!!s.word}>
          <div style={{ display: "flex", gap: 2, minHeight: 36 }}>
            {s.word ? s.word.bytes.map((b, i) => (
              <div key={i} style={{ ...mono, width: 24, fontSize: 11, textAlign: "center", border: "1px solid var(--border)", borderRadius: 3 }}>
                <div>{hex2(b)}</div>
                <div style={{ color: "var(--muted)" }}>{b >= 32 && b < 127 ? String.fromCharCode(b) : b === 10 ? "\\n" : "·"}</div>
              </div>
            )) : <span className="muted" style={{ fontSize: 12 }}>none at this step</span>}
          </div>
        </Panel>
        <Panel title="strace output">
          <div style={{ ...mono, fontSize: 11.5, minHeight: 36, overflowWrap: "anywhere" }}>
            {s.output.length ? s.output.map((l, i) => <div key={i}>{l}</div>) : <span className="muted">nothing yet</span>}
          </div>
        </Panel>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "ptrace-stops", value: s.counters.stops },
          { label: "context switches", value: s.counters.switches },
          { label: "tracer system calls", value: s.counters.tracerSyscalls },
          { label: "tracee system calls", value: s.counters.traceeSyscalls },
          { label: "register reads", value: s.counters.regReads },
          { label: "words peeked", value: s.counters.peeks },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- breakpoint

const MISTAKES: { value: Mistake; label: string }[] = [
  { value: "none", label: "None: all steps" },
  { value: "no-rewind", label: "Forget to rewind RIP" },
  { value: "no-restore", label: "Forget to restore the byte" },
  { value: "no-reinsert", label: "Forget to put 0xCC back" },
];

const END_TEXT: Record<string, { text: string; good: boolean }> = {
  exit: { text: "Correct: same exit status as a run with no debugger.", good: true },
  segv: { text: "The debugger broke the program.", good: false },
  ill: { text: "The debugger broke the program.", good: false },
  stuck: { text: "The program can never continue.", good: false },
  missed: { text: "The program finished, but the debugger missed a call.", good: false },
};

export function BreakpointStepperDemo() {
  const list = useMemo(() => instructionList(), []);
  const p = useParams("pt-bp", {
    bp: select<string>({ label: "Breakpoint at", options: list.map((d) => ({ value: String(d.addr), label: `${hex(d.addr)}  ${d.text}` })), default: String(FN_ADDR + 1) }),
    mistake: select<Mistake>({ label: "Mistake in the debugger", options: MISTAKES, default: "none" }),
  });
  const [k, setK] = useState(0);
  const bp = Number(p.values.bp);
  const steps = useMemo(() => breakpointSteps(bp, p.values.mistake), [bp, p.values.mistake]);
  const kk = Math.min(k, steps.length - 1);
  const s = steps[kk]!;
  const end = s.end ? END_TEXT[s.end] : null;
  const tf = (s.regs.rflags & TF_BIT) !== 0;
  return (
    <Demo
      title="A breakpoint: patch, trap, rewind, step, patch again"
      actions={<StepButtons k={kk} n={steps.length} set={setK} />}
      controls={<>
        <StepSlider k={kk} n={steps.length} set={setK} />
        <Param spec={p.schema.bp} value={p.values.bp} onChange={(v) => { p.set("bp", v as string); setK(0); }} />
        <Param spec={p.schema.mistake} value={p.values.mistake} onChange={(v) => { p.set("mistake", v as Mistake); setK(0); }} />
      </>}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{s.title}</div>
      <Msg min={74} warn={end ? !end.good : false}>{s.text}</Msg>
      <div style={{ ...mono, fontSize: 12, minHeight: 18, marginBottom: 6, color: "var(--muted)", overflowWrap: "anywhere" }}>{s.call ?? ""}</div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 0", marginBottom: 8 }}>
        {list.map((d) => {
          const off = d.addr - TEXT_BASE;
          const inside = s.regs.rip >= d.addr && s.regs.rip < d.addr + d.len;
          const midway = inside && s.regs.rip !== d.addr;
          const patched = s.bytes[off] === INT3;
          return (
            <div key={d.addr} style={{ ...mono, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "1px 6px", background: inside ? tint("var(--c1)", 12) : undefined }}>
              <span style={{ width: 12, flex: "none", color: midway ? "var(--c4)" : "var(--c1)" }}>{inside ? (midway ? "!" : ">") : ""}</span>
              <span style={{ width: 54, flex: "none", color: "var(--muted)" }}>{d.addr.toString(16)}</span>
              <span style={{ width: 96, flex: "none", display: "flex", gap: 1 }}>
                {d.bytes.map((_, i) => {
                  const b = s.bytes[off + i]!;
                  const hot = s.hot.includes(off + i);
                  const cc = i === 0 && patched;
                  return <span key={i} style={{ width: 18, textAlign: "center", borderRadius: 2, background: cc ? "var(--c4)" : hot ? tint("var(--c2)", 35) : "transparent", color: cc ? "var(--bg)" : "var(--fg)", fontWeight: cc ? 600 : 400 }}>{hex2(b)}</span>;
                })}
              </span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: patched ? "var(--muted)" : "var(--fg)" }}>{patched ? `int3 (hides ${d.text})` : d.text}</span>
            </div>
          );
        })}
      </div>
      <Stats items={[
        { label: "RIP", value: <span style={mono}>{s.regs.rip.toString(16)}</span> },
        { label: "eax", value: <span style={mono}>{s.regs.rax}</span> },
        { label: "edi", value: <span style={mono}>{s.regs.rdi}</span> },
        { label: "trap flag", value: tf ? "set" : "clear" },
        { label: "saved byte", value: <span style={mono}>{s.saved === null ? "none" : `0x${hex2(s.saved)}`}</span> },
        { label: "breakpoint hits", value: s.hits },
      ]} />
      <div style={{ fontSize: 12.5, marginTop: 8 }}>
        The CPU decodes next: <b style={{ ...mono, fontWeight: 600 }}>{s.next}</b>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 4, minHeight: 20, color: end ? (end.good ? "var(--c3)" : "var(--c4)") : undefined }}>{end?.text ?? ""}</div>
      <Note>The program calls f twice and exits with status 43. RFLAGS is {hex(RFLAGS_BASE)} when the trap flag is clear.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- overhead

export function TraceOverheadDemo() {
  const p = useParams("pt-cost", {
    work: range({ label: "User work between system calls", min: 10, max: 1000000, default: 200, log: true, format: (v) => si(v * 1e-9, "s") }),
    share: range({ label: "Share of calls that the tool records", min: 0, max: 100, step: 1, default: 1, format: (v) => `${v}%` }),
  });
  const v = p.values;
  const share = v.share / 100;
  const xs = useMemo(() => Array.from({ length: 60 }, (_, i) => 10 * Math.pow(1e5, i / 59)), []);
  const line = (mode: "strace" | "seccomp" | "ebpf") => xs.map((x) => [x, slowdown(mode, x, share)] as [number, number]);
  return (
    <Demo title="A syscall-heavy program under three tools" controls={<>
      <Param spec={p.schema.work} value={v.work} onChange={(x) => p.set("work", x as number)} />
      <Param spec={p.schema.share} value={v.share} onChange={(x) => p.set("share", x as number)} />
    </>}>
      <Cap>One loop: user work, then one system call. Slowdown against the same loop with no tool. All costs are model inputs.</Cap>
      <Plot x={[10, 1000000]} y={[1, 100]} logX logY height={250} xLabel="user work between calls (ns)" yLabel="slowdown (times)" xTicks={[10, 100, 1000, 10000, 100000, 1000000]} yTicks={[1, 2, 5, 10, 20, 50, 100]} xFormat={(t) => si(t)} yFormat={(t) => `${t}×`}>
        <Line points={line("strace")} color="var(--c4)" />
        <Line points={line("seccomp")} color="var(--c2)" />
        <Line points={line("ebpf")} color="var(--c3)" />
        <RuleX at={v.work} color="var(--fg)" />
      </Plot>
      <Legend items={[{ label: "strace", color: "var(--c4)" }, { label: "strace --seccomp-bpf", color: "var(--c2)" }, { label: "eBPF", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "strace", value: `${slowdown("strace", v.work, share).toFixed(1)}×` },
          { label: "strace --seccomp-bpf", value: `${slowdown("seccomp", v.work, share).toFixed(2)}×` },
          { label: "eBPF", value: `${slowdown("ebpf", v.work, share).toFixed(2)}×` },
          { label: "cost of one stop", value: si(stopNs() * 1e-9, "s") },
        ]} />
      </div>
      <Note>Model inputs: system call {TRACE_INPUTS.syscallNs} ns, switch between address spaces {TRACE_INPUTS.switchNs} ns, format one line {TRACE_INPUTS.formatNs} ns, seccomp filter {TRACE_INPUTS.filterNs} ns, eBPF program {TRACE_INPUTS.ebpfRunNs} ns per run, ring buffer event {TRACE_INPUTS.ebpfEventNs} ns. Real systems differ, so measure yours.</Note>
    </Demo>
  );
}
