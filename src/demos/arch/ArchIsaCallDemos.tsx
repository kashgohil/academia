/** Demos for "Calling conventions": the stack frames of a recursive call, and the caller/callee-saved split. */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, Dots, IndexButtons, Line, Param, Plot, RuleX, SectionLabel, Stats, mono, range, tint } from "../../kit";
import { POOL, RISCV_SPLIT, factRun, frameView, runSplit, splitExpect, splitSweep } from "../../sims/arch/isa";
import { REG_ABI } from "../../sims/arch/rv";
import { AsmListing } from "./ArchViews";

const FRAME_COLORS = ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)"];
const hx = (v: number) => `0x${(v >>> 0).toString(16)}`;

export function IsaFrameDemo() {
  const [n, setN] = useState(4);
  const run = useMemo(() => factRun(n), [n]);
  const [k, setK] = useState(14);
  const step = Math.min(k, run.steps);
  const span = run.top - run.minSp + 16;
  const v = useMemo(() => frameView(run.program, step, span), [run, step, span]);
  const show = [1, 2, 8, 10];
  return (
    <Demo
      title="Watch the stack grow and shrink"
      actions={<ButtonRow><IndexButtons k={step} n={run.steps + 1} set={setK} /></ButtonRow>}
      controls={<>
        <Param spec={range({ label: "Instructions run", min: 0, max: run.steps, step: 1, default: 14, format: (x) => `${x} of ${run.steps}` })} value={step} onChange={(x) => setK(x as number)} />
        <Param spec={range({ label: "n in fact(n)", min: 1, max: 12, step: 1, default: 4 })} value={n} onChange={(x) => { setN(x as number); setK(0); }} />
      </>}
    >
      <Stats items={[
        { label: "Frames now", value: v.depth },
        { label: "sp", value: hx(v.sp) },
        { label: "Bytes below the start", value: run.top - v.sp },
        { label: "Deepest, whole run", value: `${run.top - run.minSp} B` },
      ]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 8 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Code (next instruction highlighted)</SectionLabel>
          <AsmListing program={run.program} pc={v.status === "running" ? v.pc : undefined} maxHeight={330} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, fontSize: 12, ...mono }}>
            {show.map((r) => <span key={r} style={{ padding: "1px 6px", borderRadius: 4, background: "var(--subtle)" }}><span className="muted">{REG_ABI[r]} </span>{r === 1 || r === 2 ? hx(v.regs[r]!) : v.regs[r]}</span>)}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack memory, high addresses at the top (padding keeps sp 16-byte aligned)</SectionLabel>
          <div style={{ maxHeight: 330, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, ...mono }}>
            {v.words.map((w) => {
              const col = w.frame >= 0 ? FRAME_COLORS[w.frame % FRAME_COLORS.length]! : "var(--border)";
              const isSp = w.addr === v.sp;
              return (
                <div key={w.addr} style={{ display: "grid", gridTemplateColumns: "44px 64px minmax(0, 1fr)", gap: 6, padding: "1px 8px", borderLeft: `4px solid ${w.frame >= 0 ? col : "transparent"}`, background: w.frame >= 0 ? tint(col, 12) : undefined, borderBottom: (w.addr & 15) === 0 ? "1px solid var(--border)" : undefined, opacity: w.live ? 1 : 0.5 }}>
                  <span className="muted">{hx(w.addr).slice(-4)}</span>
                  <span>{w.frame >= 0 || w.what ? (w.what.includes("ra") ? hx(w.value) : w.value) : ""}</span>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: w.frame >= 0 ? "var(--fg)" : "var(--faint)" }}>
                    {isSp && <b style={{ color: "var(--c4)" }}>sp → </b>}
                    {w.frame >= 0 ? `fact #${w.frame + 1}: ${w.what}` : w.what}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Banner tone={v.status === "exited" ? "good" : "info"} style={{ marginTop: 8 }} label={`step ${v.step}`}>
        {v.status === "exited"
          ? `fact(${n}) returned ${v.exitCode}. Every frame is gone, and sp is back at its start. The old values are still in memory, below sp, where nothing owns them.`
          : v.lastText ? `Ran: ${v.lastText}` : "Not started. The first instruction loads n into a0."}
      </Banner>
    </Demo>
  );
}

export function IsaSplitDemo() {
  const [s, setS] = useState(RISCV_SPLIT);
  const [live, setLive] = useState(4);
  const [temps, setTemps] = useState(6);
  const [calls, setCalls] = useState(8);
  const sweep = useMemo(() => splitSweep({ live, temps, calls }), [live, temps, calls]);
  const cur = sweep[s]!;
  const best = Math.min(...sweep.map((r) => r.memOps));
  const max = Math.max(...sweep.map((r) => r.memOps));
  const pts = sweep.map((r, i) => [i, r.memOps] as [number, number]);
  const [showSrc, setShowSrc] = useState(false);
  return (
    <Demo
      title="Caller-saved or callee-saved: count the saves"
      controls={<>
        <Param spec={range({ label: "Callee-saved registers (of 25)", min: 0, max: POOL.length, step: 1, default: RISCV_SPLIT })} value={s} onChange={(x) => setS(x as number)} />
        <Param spec={range({ label: "Values f keeps across calls", min: 0, max: 12, step: 1, default: 4 })} value={live} onChange={(x) => setLive(x as number)} />
        <Param spec={range({ label: "Registers the leaf g needs", min: 0, max: 12, step: 1, default: 6 })} value={temps} onChange={(x) => setTemps(x as number)} />
        <Param spec={range({ label: "Calls from f to g", min: 1, max: 16, step: 1, default: 8 })} value={calls} onChange={(x) => setCalls(x as number)} />
      </>}
    >
      <Plot x={[0, POOL.length]} y={[0, Math.max(10, max * 1.08)]} height={220} xLabel="callee-saved registers in the convention" yLabel="loads + stores">
        <RuleX at={RISCV_SPLIT} label="RISC-V psABI: 12" />
        <Line points={pts} color="var(--c1)" />
        <Dots points={[[s, cur.memOps]]} color="var(--c4)" r={5} />
      </Plot>
      <Stats items={[
        { label: "Stores (saves)", value: cur.stores },
        { label: "Loads (restores)", value: cur.loads },
        { label: "Fewest for these values", value: best },
        { label: "Result", value: `${cur.exitCode} ${cur.ok ? "(correct)" : `(expected ${splitExpect(cur.params)})`}` },
      ]} />
      <Banner tone={cur.memOps === best ? "good" : "warn"} style={{ marginTop: 6 }}>
        {cur.memOps === best
          ? `This split is as good as any for these values: ${cur.memOps} loads and stores.`
          : s < live
            ? `Too few callee-saved registers: f must save ${live - s} live value(s) around each of its ${calls} calls.`
            : `Too many callee-saved registers: the leaf g has only ${POOL.length - s} free scratch registers, so it saves the rest on every call.`}
        {" "}The result does not change with the split. Only the cost does.
      </Banner>
      <ButtonRow style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={() => setShowSrc((x) => !x)}>{showSrc ? "Hide" : "Show"} the generated program</button>
      </ButtonRow>
      {showSrc && <pre style={{ maxHeight: 260, overflow: "auto", fontSize: 11.5, border: "1px solid var(--border)", borderRadius: 6, padding: 8, ...mono }}>{runSplit({ calleeSaved: s, live, temps, calls }).source}</pre>}
    </Demo>
  );
}
