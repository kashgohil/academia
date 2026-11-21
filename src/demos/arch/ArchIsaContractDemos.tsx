/** Demos for "What an ISA is": one binary on three cores, and the same binary under a changed contract. */
import { useMemo, useState } from "react";
import { Banner, Demo, MiniTable, Param, SectionLabel, Stats, mono, range, select, seg, tint } from "../../kit";
import { CHANGES, retiredBy, runOnCores, runUnderChange, stateAfter } from "../../sims/arch/isa";
import { disasm, programById } from "../../sims/arch/rv";
import { RegFile } from "./ArchViews";

const IDS = ["sum", "fact", "dot", "bubble", "branchy", "strlen"];
const PROGRAM = select({ label: "Program", options: IDS.map((id) => ({ value: id, label: programById(id).title })), default: "sum" });
const CORE_COLOR = ["var(--c4)", "var(--c1)", "var(--c3)"];

export function IsaCoresDemo() {
  const [id, setId] = useState("sum");
  const run = useMemo(() => runOnCores(programById(id).source), [id]);
  const maxCycles = Math.max(...run.runs.map((r) => r.cycles));
  const [cycle, setCycle] = useState(Math.round(maxCycles * 0.4));
  const c = Math.min(cycle, maxCycles);
  const [view, setView] = useState("1");
  const ks = run.runs.map((r) => retiredBy(r, c));
  const shown = Number(view);
  const st = useMemo(() => stateAfter(run.program, ks[shown]!), [run, ks[shown], shown]);
  const prev = useMemo(() => (ks[shown]! > 0 ? stateAfter(run.program, ks[shown]! - 1) : null), [run, ks[shown], shown]);
  const changed = prev ? st.regs.map((v, r) => (v !== prev.regs[r] ? r : -1)).filter((r) => r > 0) : [];
  const N = run.retired;
  const W = 560, H = 86, X0 = 14, X1 = W - 14;
  const xOf = (k: number) => X0 + ((X1 - X0) * k) / N;
  const same = ks.every((k) => k === ks[0]);
  return (
    <Demo
      title="One binary, three cores, one sequence of states"
      controls={<>
        <Param spec={range({ label: "Cycle", min: 0, max: maxCycles, step: 1, default: 0, format: (v) => `${v} of ${maxCycles}` })} value={c} onChange={(v) => setCycle(v as number)} />
        <Param spec={PROGRAM} value={id} onChange={(v) => { setId(v as string); setCycle(0); }} />
        <Param spec={seg("Show the registers of", [["0", "Tiny"], ["1", "Classic"], ["2", "Dual-issue"]], "1")} value={view} onChange={(v) => setView(v as string)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>The architectural states 0 to {N}, in program order. Each core is somewhere on this one track.</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 340, display: "block" }} role="img" aria-label="Progress of three cores along the same sequence of states">
          <line x1={X0} x2={X1} y1={20} y2={20} stroke="var(--border)" strokeWidth={6} strokeLinecap="round" />
          {Array.from({ length: N + 1 }, (_, k) => k).filter((k) => k % Math.max(1, Math.ceil(N / 40)) === 0).map((k) => (
            <line key={k} x1={xOf(k)} x2={xOf(k)} y1={16} y2={24} stroke="var(--faint)" />
          ))}
          {run.runs.map((r, i) => {
            const x = xOf(ks[i]!);
            const y = 40 + i * 15;
            return (
              <g key={r.core.id}>
                <line x1={X0} x2={x} y1={y} y2={y} stroke={CORE_COLOR[i]} strokeWidth={4} strokeLinecap="round" opacity={0.75} />
                <line x1={x} x2={x} y1={24} y2={y} stroke={CORE_COLOR[i]} strokeDasharray="2 2" />
                <circle cx={x} cy={20} r={5} fill={CORE_COLOR[i]} stroke="var(--bg)" strokeWidth={1.5} />
              </g>
            );
          })}
          <text x={X0} y={12} fontSize={10} fill="var(--muted)">state 0</text>
          <text x={X1} y={12} fontSize={10} fill="var(--muted)" textAnchor="end">state {N}: exit</text>
        </svg>
      </div>
      <MiniTable
        head={["Core (model)", "Retired", "Last instruction", "Finishes at cycle"]}
        rows={run.runs.map((r, i) => {
          const k = ks[i]!;
          const last = k > 0 ? disasm(run.dyn[k - 1]!, undefined, { pseudo: true }) : "none yet";
          return [
            <span key="n" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 5, background: CORE_COLOR[i] }} />{r.core.name}</span>,
            <span key="k" style={mono}>{k} of {N}</span>,
            <span key="l" style={{ ...mono, whiteSpace: "nowrap" }}>{last}</span>,
            <span key="c" style={mono}>{r.cycles}</span>,
          ];
        })}
        highlight={shown}
      />
      <Banner tone={same ? "good" : "info"} label={`cycle ${c}`} style={{ marginTop: 8 }}>
        {same
          ? `All three cores have retired ${ks[0]} instructions, so they hold the same state, number ${ks[0]}.`
          : `The cores are at states ${ks.join(", ")}. Each one is a state of the same sequence. A faster core is only further along.`}
      </Banner>
      <SectionLabel>State {ks[shown]} (what the {run.runs[shown]!.core.name.toLowerCase()} shows now): pc 0x{st.pc.toString(16)}</SectionLabel>
      <RegFile regs={st.regs} changed={changed} show="used" />
      <div style={{ marginTop: 10 }}>
        <Stats items={run.runs.map((r) => ({ label: `${r.core.name}: cycles, CPI`, value: `${r.cycles}, ${r.cpi.toFixed(2)}` }))} />
      </div>
    </Demo>
  );
}

export function IsaContractDemo() {
  const [id, setId] = useState("fact");
  const src = programById(id).source;
  const cores = useMemo(() => runOnCores(src), [src]);
  const changes = useMemo(() => CHANGES.map((ch) => ({ ch, r: runUnderChange(src, ch.id) })), [src]);
  const ref = changes[0]!.r;
  const broken = changes.filter((x) => x.r.exitCode !== ref.exitCode || x.r.error).length;
  return (
    <Demo title="Change the core, or change the contract" controls={<Param spec={PROGRAM} value={id} onChange={(v) => setId(v as string)} />}>
      <SectionLabel style={{ marginTop: 0 }}>Change the microarchitecture: the same ISA, other timing (model inputs)</SectionLabel>
      <MiniTable
        head={["Core", "Result (exit code)", "Instructions", "Cycles"]}
        rows={cores.runs.map((r) => [r.core.name, <span key="e" style={mono}>{cores.exitCode}</span>, cores.retired, r.cycles])}
      />
      <SectionLabel>Change the architecture: the same bits, read by another contract</SectionLabel>
      <MiniTable
        head={["Contract", "Words read differently", "Result"]}
        rows={changes.map(({ ch, r }) => [
          <span key="n" title={ch.about}>{ch.name}</span>,
          r.changedWords,
          <span key="r" style={{ ...mono, color: r.error ? "var(--c4)" : r.exitCode !== ref.exitCode ? "var(--c4)" : "var(--fg)", whiteSpace: "nowrap" }}>
            {r.error ? `trap after ${r.retired}: illegal instruction` : r.exitCode !== ref.exitCode ? `${r.exitCode} (wrong, silently)` : `${r.exitCode}`}
          </span>,
        ])}
      />
      <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: tint("var(--c1)", 8), fontSize: 12.5 }}>
        {changes.map(({ ch }) => <div key={ch.id}><b>{ch.name}.</b> <span className="muted">{ch.about}</span></div>)}
      </div>
      <Banner tone={broken ? "bad" : "good"} style={{ marginTop: 8 }}>
        {broken
          ? `Every core gives exit code ${cores.exitCode}. ${broken} of the ${CHANGES.length - 1} contract changes break this binary: a trap, or a wrong answer with no error.`
          : `No contract change touches an instruction that this program uses, so it still runs. Pick fact or dot to see a change break it.`}
      </Banner>
    </Demo>
  );
}
