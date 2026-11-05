/** Lesson: context switching. A register-level stepper, and a cost model with cache refill. */
import { useMemo, useState } from "react";
import { Area, Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes, pct, range, si, toggle, useParams, IndexButtons, IndexSlider, Note, SmallLabel, mono, tint } from "../../kit";
import { SWITCH_INPUTS, USER_REGS, switchCost, switchSnaps, type SwitchCostInput, type TaskCtx } from "../../sims/os/processes";
import { ModeBar, Msg } from "./ProcessesUi";

const TASK_COLOR: Record<string, string> = { A: "var(--c1)", B: "var(--c2)" };

function colorOf(v: string): string | undefined {
  if (v.startsWith("A.")) return TASK_COLOR.A;
  if (v.startsWith("B.")) return TASK_COLOR.B;
  return undefined;
}

function KernelStack({ t, active, sp }: { t: TaskCtx; active: boolean; sp: string }) {
  const rows = [...t.kstack].reverse();
  const c = TASK_COLOR[t.name]!;
  return (
    <div style={{ flex: "1 1 145px", minWidth: 0, border: `1px solid ${active ? c : "var(--border)"}`, borderRadius: 6, padding: "4px 6px", background: active ? tint(c, 5) : undefined }}>
      <div style={{ fontSize: 12, marginBottom: 2 }}><b style={{ fontWeight: 600, color: c }}>{t.name}</b> kernel stack{active ? ", rsp here" : ""}</div>
      <div style={{ ...mono, fontSize: 10.5, color: "var(--muted)" }}>thread.sp = {t.savedSp || "–"}</div>
      <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.35, marginTop: 3, height: 280, overflow: "hidden" }}>
        {rows.length === 0 && <div className="muted">(empty)</div>}
        {rows.map((r, i) => (
          <div key={t.kstack.length - i} style={{ display: "flex", justifyContent: "space-between", gap: 4, padding: "0 3px", background: i === 0 && active && sp ? tint(c, 22) : undefined, borderRadius: 2 }}>
            <span className="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label.replace("return into irq exit path", "ret addr")}</span>
            <span style={{ whiteSpace: "nowrap", color: colorOf(r.value) }}>{r.value.replace("preempt_schedule_irq", "sched").replace("user data", "udata").replace("user code", "ucode")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SwitchStepperDemo() {
  const p = useParams("ctx-step", { same: toggle({ label: "A and B are threads of one process", default: false }) });
  const [k, setK] = useState(0);
  const snaps = useMemo(() => switchSnaps({ sameMm: p.values.same }), [p.values.same]);
  const kk = Math.min(k, snaps.length - 1);
  const s = snaps[kk]!;
  const r = s.cpu.regs;
  const cell = (name: string, val: string) => {
    const hot = s.changed.includes(name);
    return (
      <div key={name} style={{ border: `1px solid ${hot ? "var(--c4)" : "var(--border)"}`, background: hot ? tint("var(--c4)", 12) : "var(--bg)", borderRadius: 4, padding: "1px 5px", minWidth: 0, transition: "background 0.2s" }}>
        <div style={{ fontSize: 10, color: "var(--muted)", ...mono }}>{name}</div>
        <div style={{ ...mono, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: colorOf(val) }}>{val}</div>
      </div>
    );
  };
  return (
    <Demo
      title="Task A to task B on a timer interrupt"
      actions={<IndexButtons k={kk} n={snaps.length} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={snaps.length} set={setK} />
        <Param spec={p.schema.same} value={p.values.same} onChange={(v) => p.set("same", v as boolean)} />
      </>}
    >
      <ModeBar mode={s.cpu.mode} userLabel="user mode" kernelLabel="kernel mode" />
      <div style={{ margin: "8px 0 2px", fontSize: 13.5, fontWeight: 600, color: s.phase === "switch" ? "var(--c4)" : undefined }}>{s.title}</div>
      <Msg min={56}>{s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <SmallLabel>CPU</SmallLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 3 }}>
            {USER_REGS.map((n) => cell(n, r[n]))}
            {cell("cr3", s.cpu.cr3)}
            {cell("current", s.cpu.current)}
            {cell("tssSp0", s.cpu.tssSp0)}
            {cell("fsbase", s.cpu.fsbase)}
            {cell("fpuOwner", s.cpu.fpuOwner)}
          </div>
        </div>
        <KernelStack t={s.tasks.A!} active={s.onStack === "A"} sp={r.rsp} />
        <KernelStack t={s.tasks.B!} active={s.onStack === "B"} sp={r.rsp} />
      </div>
      <Note>Blue values belong to A, and orange values to B. Red boxes changed in this step. kA+19 means "19 entries down from the top of A's kernel stack". Other values starting with k: are kernel data.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- cost

export function SwitchCostDemo() {
  const p = useParams("ctx-cost", {
    rate: range({ label: "Switches per second", min: 100, max: 1000000, default: 1000, log: true, format: (v) => si(Math.round(v)) }),
    ws: range({ label: "Working set of each task", min: 4, max: 65536, default: 1024, log: true, format: (v) => bytes(Math.round(v) * 1024) }),
    evict: range({ label: "Share of the cache that the other task evicts (model input)", min: 0, max: 1, step: 0.05, default: 0.5, format: (v) => `${Math.round(v * 100)}%` }),
    same: toggle({ label: "Threads of one process", default: false }),
    pcid: toggle({ label: "PCID", default: true }),
  });
  const v = p.values;
  const inp = (ws: number, rate: number): SwitchCostInput => ({ workingSetBytes: ws * 1024, switchesPerSec: rate, evictedShare: v.evict, sameMm: v.same, pcid: v.pcid });
  const xs = useMemo(() => Array.from({ length: 50 }, (_, i) => 4 * Math.pow(16384, i / 49)), []);
  const lost = xs.map((x) => [x, switchCost(inp(x, Math.round(v.rate))).cpuLost * 100] as [number, number]);
  const direct = xs.map((x) => [x, switchCost(inp(x, Math.round(v.rate))).directNs * Math.round(v.rate) / 1e7] as [number, number]);
  const c = switchCost(inp(Math.round(v.ws), Math.round(v.rate)));
  return (
    <Demo title="CPU lost to context switches" controls={<>
      <Param spec={p.schema.rate} value={v.rate} onChange={(x) => p.set("rate", x as number)} />
      <Param spec={p.schema.ws} value={v.ws} onChange={(x) => p.set("ws", x as number)} />
      <Param spec={p.schema.evict} value={v.evict} onChange={(x) => p.set("evict", x as number)} />
      <Param spec={p.schema.same} value={v.same} onChange={(x) => p.set("same", x as boolean)} />
      <Param spec={p.schema.pcid} value={v.pcid} onChange={(x) => p.set("pcid", x as boolean)} />
    </>}>
      <SmallLabel>The curve is the share of CPU lost at this switch rate. The dashed line is the direct cost alone.</SmallLabel>
      <Plot x={[4, 65536]} y={[0, 100]} logX height={240} xLabel="working set (KiB)" yLabel="CPU lost (%)" xTicks={[4, 64, 1024, 16384]} yTicks={[0, 25, 50, 75, 100]} xFormat={(t) => (t >= 1024 ? `${t / 1024} M` : `${t} K`)}>
        <Area points={lost} color="var(--c4)" opacity={0.12} />
        <Line points={lost} color="var(--c4)" />
        <Line points={direct} color="var(--c1)" dash="4 3" />
        <RuleX at={v.ws} color="var(--fg)" />
        <RuleX at={SWITCH_INPUTS.cacheBytes / 1024} color="var(--faint)" label="cache size" />
      </Plot>
      <Legend items={[{ label: "total", color: "var(--c4)" }, { label: "direct cost only", color: "var(--c1)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "direct, per switch", value: `${si(c.directNs * 1e-9, "s")}` },
          { label: "cache refill", value: `${si(c.cacheNs * 1e-9, "s")}` },
          { label: "TLB refill", value: `${si(c.tlbNs * 1e-9, "s")}` },
          { label: "CPU lost", value: pct(c.cpuLost, 1) },
          { label: "share that is direct", value: pct(c.directShare, 0) },
        ]} />
      </div>
      <Note>The model assumes a task touches its whole working set after each switch, if it has the time. Model inputs: direct {SWITCH_INPUTS.directNs} ns, address space change {SWITCH_INPUTS.mmSwitchNs} ns, cache {bytes(SWITCH_INPUTS.cacheBytes)}, {SWITCH_INPUTS.lineRefillNs} ns per {SWITCH_INPUTS.lineBytes}-byte line, {SWITCH_INPUTS.tlbEntries} TLB entries, {SWITCH_INPUTS.walkNs} ns per page walk, {SWITCH_INPUTS.touchNs} ns between line touches.</Note>
    </Demo>
  );
}
