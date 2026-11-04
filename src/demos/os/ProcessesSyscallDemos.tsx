/** Lesson: system calls. A write stepper with registers, and a cost model. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, range, select, si, toggle, useParams } from "../../kit";
import {
  ALL_MITIGATIONS, COST_INPUTS, MSG_ADDR, NO_MITIGATIONS, REG_ORDER, TABLE_EXCERPT, VARIANT_LABEL, cpuShare, libcView, syscallNs, syscallRate, vdsoNs, vdsoRate, writeSteps,
  type Mitigations, type Regs, type WriteVariant,
} from "../../sims/os/processes";
import { Cap, ModeBar, Msg, Note, Panel, StepButtons, StepSlider, mono, tint } from "./ProcessesUi";

const REG_ROLE: Record<keyof Regs, string> = {
  rax: "number, then result", rdi: "argument 1", rsi: "argument 2", rdx: "argument 3", r10: "argument 4", r8: "argument 5", r9: "argument 6",
  rcx: "CPU saves rip here", r11: "CPU saves RFLAGS here", rip: "next instruction", rsp: "stack",
};

const VARIANTS = Object.keys(VARIANT_LABEL) as WriteVariant[];

function Cell({ c, on, hot }: { c: string; on?: boolean; hot?: boolean }) {
  return <span style={{ ...mono, display: "inline-block", width: 22, textAlign: "center", fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 3, marginRight: 2, background: hot ? tint("var(--c2)", 30) : on ? tint("var(--c3)", 20) : "var(--bg)" }}>{c}</span>;
}

export function WriteStepperDemo() {
  const p = useParams("sys-write", {
    variant: select<WriteVariant>({ label: "The call", options: VARIANTS.map((v) => ({ value: v, label: VARIANT_LABEL[v] })), default: "ok" }),
    kpti: toggle({ label: "KPTI on", default: true }),
  });
  const [k, setK] = useState(0);
  const steps = useMemo(() => writeSteps(p.values.variant, p.values.kpti), [p.values.variant, p.values.kpti]);
  const kk = Math.min(k, steps.length - 1);
  const s = steps[kk]!;
  const lastRet = steps[steps.length - 1]!.ret;
  const copying = s.pane === "copy";
  const done = kk === steps.length - 1;
  const view = lastRet !== undefined ? libcView(lastRet) : null;
  const userBad = p.values.variant === "kernelptr" || p.values.variant === "unmapped";
  return (
    <Demo
      title='write(1, "hi", 2)'
      actions={<StepButtons k={kk} n={steps.length} set={setK} />}
      controls={<>
        <StepSlider k={kk} n={steps.length} set={setK} />
        <Param spec={p.schema.variant} value={p.values.variant} onChange={(v) => { p.set("variant", v as WriteVariant); setK(0); }} />
        <Param spec={p.schema.kpti} value={p.values.kpti} onChange={(v) => { p.set("kpti", v as boolean); setK(0); }} />
      </>}
    >
      <ModeBar mode={s.mode} userLabel="user mode, ring 3" kernelLabel="kernel mode, ring 0" />
      <div style={{ margin: "8px 0 2px", fontSize: 13.5, fontWeight: 600 }}>{s.title}</div>
      <Msg min={56}>{s.text}</Msg>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(146px, 1fr))", gap: 4, marginBottom: 10 }}>
        {REG_ORDER.map((r) => {
          const hot = s.changed.includes(r);
          return (
            <div key={r} style={{ border: `1px solid ${hot ? "var(--c2)" : "var(--border)"}`, background: hot ? tint("var(--c2)", 14) : "var(--bg)", borderRadius: 4, padding: "2px 6px", transition: "background 0.2s", minWidth: 0 }}>
              <div style={{ fontSize: 10.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ ...mono, fontWeight: 600 }}>{r}</b> {REG_ROLE[r]}</div>
              <div style={{ ...mono, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.regs[r]}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8 }}>
        <Panel title="Syscall table" active={s.pane === "table"}>
          <div style={{ ...mono, fontSize: 12 }}>
            {TABLE_EXCERPT.map((e) => (
              <div key={e.nr} style={{ background: s.tableNr === e.nr ? tint("var(--c2)", 30) : undefined, borderRadius: 3, padding: "0 4px" }}>{e.nr}: {e.name}</div>
            ))}
            <div className="muted" style={{ padding: "0 4px" }}>…</div>
            {s.tableNr !== undefined && s.tableNr > 3 && <div style={{ color: "var(--c4)", padding: "0 4px" }}>{s.tableNr}: out of range</div>}
          </div>
        </Panel>
        <Panel title="Memory" active={copying}>
          <div style={{ fontSize: 11.5 }} className="muted">user page at 0x{MSG_ADDR.toString(16)}</div>
          <div style={{ margin: "2px 0 6px" }}><Cell c="h" on={!userBad} hot={s.ac && !userBad} /><Cell c="i" on={!userBad} hot={s.ac && !userBad} /></div>
          <div style={{ fontSize: 11.5 }} className="muted">kernel buffer</div>
          <div style={{ marginTop: 2, minHeight: 20 }}>{[0, 1].map((i) => <Cell key={i} c={s.kernelBuf[i] ?? "·"} on={!!s.kernelBuf[i]} />)}</div>
          <div style={{ fontSize: 11.5, marginTop: 6 }}>SMAP window: <b style={{ color: s.ac ? "var(--c2)" : "var(--muted)", fontWeight: 600 }}>{s.ac ? "open" : "closed"}</b></div>
        </Panel>
        <Panel title="CPU and output" active={s.pane === "entry" || s.pane === "return"}>
          <div style={{ fontSize: 12 }}>Page table: <b style={{ fontWeight: 600 }}>{p.values.kpti ? (s.cr3 === "user" ? "user (small)" : "kernel (full)") : "one table"}</b></div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Terminal: <span style={mono}>{s.output || "(nothing)"}</span></div>
          <div style={{ fontSize: 12, marginTop: 4, minHeight: 34 }}>
            {done && view && <>libc returns <b style={{ ...mono, fontWeight: 600 }}>{view.ret}</b>, errno <b style={{ ...mono, fontWeight: 600 }}>{view.errno}</b></>}
          </div>
        </Panel>
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- cost model

export function SyscallCostDemo() {
  const p = useParams("sys-cost", {
    work: range({ label: "User work between calls", min: 10, max: 100000, default: 200, log: true, format: (v) => `${si(v * 1e-9, "s")}` }),
    refill: range({ label: "Cache and TLB refill after a syscall (model input)", min: 0, max: 2000, step: 50, default: 100, format: (v) => `${v} ns` }),
    kpti: toggle({ label: "KPTI", default: true }),
    pcid: toggle({ label: "PCID", default: true }),
    spectre: toggle({ label: "Spectre v2 entry work", default: true }),
    mds: toggle({ label: "MDS buffer clear", default: false }),
  });
  const v = p.values;
  const m: Mitigations = { kpti: v.kpti, pcid: v.pcid, spectre: v.spectre, mds: v.mds };
  const xs = useMemo(() => Array.from({ length: 60 }, (_, i) => 10 * Math.pow(1e4, i / 59)), []);
  const sys = xs.map((x) => [x, syscallRate(x, m, v.refill)] as [number, number]);
  const bare = xs.map((x) => [x, syscallRate(x, NO_MITIGATIONS, v.refill)] as [number, number]);
  const vd = xs.map((x) => [x, vdsoRate(x)] as [number, number]);
  const ns = syscallNs(m) + v.refill;
  return (
    <Demo title="Calls per second: a real syscall against the vDSO" controls={<>
      <Param spec={p.schema.work} value={v.work} onChange={(x) => p.set("work", x as number)} />
      <Param spec={p.schema.refill} value={v.refill} onChange={(x) => p.set("refill", x as number)} />
      <Param spec={p.schema.kpti} value={v.kpti} onChange={(x) => p.set("kpti", x as boolean)} />
      <Param spec={p.schema.pcid} value={v.pcid} onChange={(x) => p.set("pcid", x as boolean)} />
      <Param spec={p.schema.spectre} value={v.spectre} onChange={(x) => p.set("spectre", x as boolean)} />
      <Param spec={p.schema.mds} value={v.mds} onChange={(x) => p.set("mds", x as boolean)} />
    </>}>
      <Cap>One CPU in a loop: user work, then one call. All costs here are model inputs.</Cap>
      <Plot x={[10, 100000]} y={[5e3, 5e7]} logX logY height={250} xLabel="user work between calls (ns)" yLabel="calls per second" xTicks={[10, 100, 1000, 10000, 100000]} yTicks={[1e4, 1e5, 1e6, 1e7]} xFormat={(t) => si(t)} yFormat={(t) => si(t)}>
        <Line points={vd} color="var(--c3)" />
        <Line points={bare} color="var(--faint)" dash="4 3" />
        <Line points={sys} color="var(--c1)" />
        <RuleX at={v.work} color="var(--fg)" />
      </Plot>
      <Legend items={[{ label: "vDSO clock_gettime", color: "var(--c3)" }, { label: "syscall, current toggles", color: "var(--c1)" }, { label: "syscall, no mitigations", color: "var(--faint)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "syscall, direct", value: `${syscallNs(m)} ns` },
          { label: "syscall, with refill", value: `${ns} ns` },
          { label: "vDSO", value: `${vdsoNs()} ns` },
          { label: "syscall / vDSO", value: `${(ns / vdsoNs()).toFixed(1)}×` },
          { label: "share of one CPU at 1 M syscalls/s", value: `${Math.round(cpuShare(1e6, m, v.refill) * 100)}%` },
        ]} />
      </div>
      <Note>Model inputs: base {COST_INPUTS.baseNs} ns, KPTI CR3 writes {COST_INPUTS.kptiCr3Ns} ns, KPTI TLB loss with no PCID {COST_INPUTS.kptiNoPcidNs} ns, Spectre v2 {COST_INPUTS.spectreNs} ns, MDS {COST_INPUTS.mdsNs} ns, vDSO {COST_INPUTS.vdsoNs} ns. With all toggles on and PCID on, the direct cost is {syscallNs(ALL_MITIGATIONS)} ns. Real CPUs differ, so measure yours.</Note>
    </Demo>
  );
}
