/** Demos for the lesson on Tomasulo's algorithm. */
import { useMemo, useState } from "react";
import { Demo, IndexButtons, IndexSlider, MiniTable, Note, Param, SectionLabel, Stats, StepCaption, fixed, mono, range, seg, tint, useChunked } from "../../kit";
import { cdbRun, tomasuloRun, type Frame, type OooResult } from "../../sims/arch/ooo";
import { IssueTable, RenameTables, tag } from "./ArchOooUi";

const REGS = [16, 12, 5, 28, 30]; // a6 (F6) a2 (F2) t0 (F0) t3 (F8) t5 (F10)
const FP_NAME: Record<number, string> = { 16: "F6", 12: "F2", 5: "F0", 28: "F8", 30: "F10" };

function caption(f: Frame, r: OooResult): string {
  const name = (id: number) => r.uops.find((u) => u.id === id)?.text ?? "";
  const parts: string[] = [];
  if (f.renamed.length) parts.push(`Issue: ${f.renamed.map(name).join(", ")} gets a station and a tag.`);
  if (f.issued.length) parts.push(`Execute starts: ${f.issued.map(name).join(", ")}.`);
  if (f.cdb.length) parts.push(`Common data bus: ${f.cdb.map((c) => `${tag(c.pd)} = ${c.value}`).join(", ")}; every waiting station that holds the tag copies the value.`);
  if (f.stall) parts.push(`Issue stalls: ${f.stall}.`);
  if (!parts.length && f.rob.length === 0) return "Fetch has started. The first instructions reach issue in the next cycles.";
  return parts.join(" ") || "Nothing changes in this cycle: the units are busy.";
}

/** Step the classic sequence: instruction status, reservation stations, register status and the bus. */
export function OooTomasuloDemo() {
  const [mul, setMul] = useState(6);
  const [div, setDiv] = useState(12);
  const [k, setK] = useState(0);
  const r = useMemo(() => tomasuloRun({ lat: { mul, div } }), [mul, div]);
  const n = r.frames.length;
  const c = Math.min(k, n - 1);
  const f = r.frames[c]!;
  const first = r.uops.find((u) => u.text.startsWith("lw"))?.seq ?? 0;
  const body = r.uops.filter((u) => u.seq >= first && u.seq < first + 6 && u.squash < 0 && !u.wrong);
  const cell = (v: number) => (v >= 0 && v <= f.cycle ? v : "");
  return (
    <Demo
      title="Tomasulo's algorithm, cycle by cycle"
      actions={<IndexButtons k={c} n={n} set={setK} />}
      controls={<>
        <IndexSlider k={c} n={n} set={setK} label="Cycle" />
        <Param spec={range({ label: "Multiply latency", min: 2, max: 12, step: 1, default: 6 })} value={mul} onChange={(v) => setMul(v as number)} />
        <Param spec={range({ label: "Divide latency", min: 4, max: 24, step: 1, default: 12 })} value={div} onChange={(v) => setDiv(v as number)} />
      </>}
    >
      <StepCaption tone={f.cdb.length ? "good" : f.stall ? "warn" : "info"} label={`cycle ${f.cycle}`}>{caption(f, r)}</StepCaption>
      <SectionLabel>Instruction status (cycle of each step)</SectionLabel>
      <MiniTable
        head={["Instruction", "Issue", "Execute", "Write result"]}
        highlight={(i) => { const u = body[i]!; return f.renamed.includes(u.id) || f.issued.includes(u.id) || f.cdb.some((x) => x.id === u.id); }}
        rows={body.map((u) => [<span key="t" style={mono}>{u.text}</span>, cell(u.rename), cell(u.issue), u.rd ? cell(u.ready) : ""])}
      />
      <SectionLabel>Reservation stations (3 ALU, 2 mul, 2 div, 3 load/store)</SectionLabel>
      <IssueTable frame={f} tomasulo />
      <SectionLabel>Register status: which tag will write each register</SectionLabel>
      <RenameTables frame={f} regs={REGS} showFree={false} />
      <div style={{ fontSize: 12, marginTop: 4 }} className="muted">{REGS.map((x) => `${FP_NAME[x]} = ${["a6", "a2", "t0", "t3", "t5"][REGS.indexOf(x)]}`).join(", ")}</div>
      <SectionLabel>Common data bus this cycle</SectionLabel>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", minHeight: 22 }}>
        {f.cdb.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>idle</span> : f.cdb.map((x) => (
          <span key={x.id} style={{ ...mono, fontSize: 12, padding: "1px 6px", borderRadius: 4, background: tint("var(--c3)", 35) }}>{tag(x.pd)} = {x.value} ({x.text})</span>
        ))}
      </div>
      <Note>The tags here are physical register numbers. In the 360/91 a tag named the reservation station or load buffer that would produce the value. One instruction issues per cycle and one bus carries one result per cycle; latencies are model inputs.</Note>
    </Demo>
  );
}

const BUSES = ["1", "2", "4"] as const;

/** 64 independent adds: the result bus limits how many instructions finish per cycle. */
export function OooCdbDemo() {
  const [b, setB] = useState<(typeof BUSES)[number]>("1");
  const res = useChunked("cdb", useMemo(() => BUSES.map((x) => () => cdbRun(Number(x))), []));
  const i = BUSES.indexOf(b);
  const r = res[i];
  return (
    <Demo title="One bus, one result per cycle" controls={<Param spec={seg("Result buses", BUSES.map((x) => [x, x]), "1")} value={b} onChange={(v) => setB(v as typeof b)} />}>
      <MiniTable
        head={["Result buses", "Cycles", "Instructions per cycle", "Results that waited for the bus"]}
        highlight={i}
        rows={BUSES.map((x, j) => { const q = res[j]; return [x, q ? q.cycles : "…", q ? fixed(q.ipc) : "…", q ? q.stats.cdbWaits : "…"]; })}
      />
      {r && (
        <Stats items={[
          { label: "Cycles", value: r.cycles },
          { label: "Instructions per cycle", value: fixed(r.ipc) },
          { label: "Cycles results waited in total", value: r.stats.cdbWaitCycles },
        ]} />
      )}
      <Note>Fetch, rename and commit 4 per cycle, 4 ALUs, a 1-cycle add (model inputs). Every add is ready at once, so only the bus can hold them back.</Note>
    </Demo>
  );
}
