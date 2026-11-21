/**
 * Views shared by the pipelining demos: what each stage and pipeline register holds in one cycle, a cycle breakdown
 * bar, and the "be the compiler" reorder view.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Banner, Btn, ButtonRow, Legend, mono, Panel, StackBar, Stats, fixed, tint } from "../../kit";
import { REG_ABI, type DynInst, type PipelineOptions, type PipelineResult, type Stage } from "../../sims/arch/rv";
import { checkOrder, type Block } from "../../sims/arch/pipelining";
import { PipelineDiagram, STAGE_COLOR } from "./ArchViews";

const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;
const R = (r: number) => REG_ABI[r] ?? `x${r}`;

/** What the pipeline register after `stage` holds at the end of the cycle, for instruction d. */
function latchText(stage: Stage, d: DynInst): string {
  switch (stage) {
    case "IF": return `IF/ID ← pc ${hex(d.pc)}, word ${hex(d.word)}`;
    case "ID": {
      const parts: string[] = [];
      if (d.rs1) parts.push(`${R(d.rs1)} = ${d.rs1Val}`);
      if (d.rs2) parts.push(`${R(d.rs2)} = ${d.rs2Val}`);
      if (d.inst.imm || parts.length === 0) parts.push(`imm ${d.inst.imm}`);
      if (d.rd) parts.push(`rd ${R(d.rd)}`);
      return `ID/EX ← ${parts.join(", ")}`;
    }
    case "EX":
      if (d.cls === "load" || d.cls === "store") return `EX/MEM ← address ${hex(d.memAddr ?? 0)}${d.cls === "store" ? `, data ${d.result}` : ""}`;
      if (d.cls === "branch") return `EX/MEM ← ${d.taken ? "taken" : "not taken"}`;
      return d.rd ? `EX/MEM ← ${R(d.rd)} = ${d.result}` : "EX/MEM ← nothing to write";
    case "MEM":
      if (d.cls === "load") return `MEM/WB ← loaded ${d.result}`;
      if (d.cls === "store") return `memory ← ${d.result} at ${hex(d.memAddr ?? 0)}`;
      return d.rd ? `MEM/WB ← ${R(d.rd)} = ${d.result}` : "MEM/WB ← nothing";
    case "WB":
      return d.rd ? `register file ← ${R(d.rd)} = ${d.result}` : "no register write";
  }
}

const STAGES: Stage[] = ["IF", "ID", "EX", "MEM", "WB"];

/** The five stages at one cycle: the instruction in each, a bubble, or empty, and what its pipeline register takes. */
export function StageStrip({ result, trace, cycle }: { result: PipelineResult; trace: readonly DynInst[]; cycle: number }) {
  const at = STAGES.map((s) => {
    for (const r of result.rows) for (const c of r.cells) if (c.cycle === cycle && c.stage === s) return r;
    return null;
  });
  // A row that stalls in a stage shows as "stall" cells; find the instruction held in ID (it waits there).
  const held = result.rows.find((r) => r.cells.some((c) => c.cycle === cycle && c.stage === "stall"));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))", gap: 6 }}>
      {STAGES.map((s, i) => {
        const r = at[i];
        const d = r && !r.squashed && r.seq >= 0 ? trace[r.seq] : undefined;
        return (
          <Panel key={s} accent={STAGE_COLOR[s]} title={<b style={{ color: "var(--fg)" }}>{s}</b>} style={{ background: r ? tint(STAGE_COLOR[s], 10) : undefined }}>
            <div style={{ ...mono, fontSize: 12, minHeight: 18, color: r ? "var(--fg)" : "var(--faint)", textDecoration: r?.squashed ? "line-through" : undefined, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {r ? r.text : "(empty)"}
            </div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 3, lineHeight: 1.35, minHeight: 31 }}>
              {d ? latchText(s, d) : r?.squashed ? "squashed: writes nothing" : s === "EX" && held ? "bubble: a nop goes on" : ""}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

/** Where the cycles went: one per instruction, the fill, and each kind of stall. */
export function CycleBar({ r }: { r: PipelineResult }) {
  const fill = Math.max(0, r.cycles - r.retired - r.stalls.loadUse - r.stalls.raw - r.stalls.control - r.stalls.structural);
  const parts = [
    { value: r.retired, color: "var(--c3)", label: "one cycle per instruction" },
    { value: fill, color: "var(--faint)", label: "fill and drain" },
    { value: r.stalls.loadUse, color: "var(--c4)", label: "load-use stalls" },
    { value: r.stalls.raw, color: "var(--c2)", label: "other data stalls" },
    { value: r.stalls.control, color: "var(--c1)", label: "control (branches)" },
    { value: r.stalls.structural, color: "var(--c5)", label: "structural" },
  ];
  return (
    <div style={{ marginTop: 8 }}>
      <StackBar parts={parts} />
      <Legend items={parts.filter((p) => p.value > 0).map((p) => ({ label: `${p.label}: ${p.value}`, color: p.color }))} />
    </div>
  );
}

/**
 * "Be the compiler": the learner moves lines of a block up and down. Each order runs on the hart and is timed by the
 * shared pipeline model. A wrong order (different registers or memory) is shown in red with the first differences.
 */
export function ReorderBlock({ block, opts, extra }: { block: Block; opts: PipelineOptions; extra?: (r: PipelineResult) => ReactNode }) {
  const start = useMemo(() => block.lines.map((_, i) => i), [block]);
  const [order, setOrder] = useState<number[]>(start);
  const [sel, setSel] = useState(0);
  const res = useMemo(() => checkOrder(block, order, opts), [block, order, opts]);
  const base = useMemo(() => checkOrder(block, start, opts), [block, start, opts]);
  const move = (dir: -1 | 1) => {
    const j = sel + dir;
    if (j < 0 || j >= order.length) return;
    const o = order.slice();
    [o[sel], o[j]] = [o[j]!, o[sel]!];
    setOrder(o);
    setSel(j);
  };
  const t = res.timing;
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div role="listbox" aria-label="Instructions of the block" style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
            {order.map((li, k) => {
              const on = k === sel;
              return (
                <div
                  key={li}
                  role="option"
                  aria-selected={on}
                  onClick={() => setSel(k)}
                  style={{
                    ...mono, fontSize: 12.5, padding: "3px 8px", cursor: "pointer", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis",
                    background: on ? tint("var(--c1)", 22) : k % 2 ? "var(--subtle)" : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined,
                  }}
                >
                  {block.lines[li]}
                </div>
              );
            })}
          </div>
          <ButtonRow style={{ marginTop: 6 }}>
            <Btn onClick={() => move(-1)} disabled={sel === 0}>Move up</Btn>
            <Btn onClick={() => move(1)} disabled={sel === order.length - 1}>Move down</Btn>
            <Btn ghost onClick={() => { setOrder(start); setSel(0); }}>Original order</Btn>
            <Btn ghost onClick={() => setOrder(block.good)}>Show a good order</Btn>
          </ButtonRow>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <Stats items={[
            { label: "cycles (original order)", value: String(base.timing.cycles) },
            { label: "cycles (this order)", value: String(t.cycles) },
            { label: "stall cycles", value: String(t.stalls.loadUse + t.stalls.raw + t.stalls.structural) },
            { label: "CPI", value: fixed(t.cpi) },
          ]} />
          {extra?.(t)}
        </div>
      </div>
      <Banner ok={res.correct}>
        {res.correct
          ? t.cycles < base.timing.cycles
            ? `Correct, and ${base.timing.cycles - t.cycles} cycles faster than the original order.`
            : "Correct: the hart gives the same registers and memory as the original order."
          : `Wrong result. ${res.diffs.slice(0, 2).join("; ")}.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <PipelineDiagram result={t} maxRows={24} />
      </div>
    </div>
  );
}
