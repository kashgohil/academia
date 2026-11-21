/**
 * Demos of the lesson "Building a RISC-V core":
 * - ArchHwCoreStepDemo: the single-cycle core runs a sample program on the RTL simulator; step cycle by cycle and
 *   read the listing, the decoded word, the registers and the waveform of the datapath signals.
 * - ArchHwLockstepDemo: inject a bug into the core (or edit it), run every test in lockstep with the hart, and read
 *   the first instruction where the two disagree.
 */
import { useMemo, useState } from "react";
import { Demo, MiniTable, Param, SectionLabel, Stats, StepCaption, mono, range, select, tint, useChunked } from "../../kit";
import { assemble, disasm, REG_ABI } from "../../sims/arch/rv";
import { ALL_TESTS, BUGS, CORE_SRC, cosim, DIRECTED, RV32I_PROGRAMS, traceCore, withBug, type CosimResult } from "../../sims/arch/hw";
import { AsmListing, BitFields, RegFile } from "./ArchViews";
import { VerilogEditor, Waveform, type WaveRow } from "./ArchHwUi";

const hex = (v: number) => "0x" + (v >>> 0).toString(16);

// ---------------------------------------------------------------- stepper

const PROG = select({ label: "Program", options: RV32I_PROGRAMS.map((p) => ({ value: p.id, label: p.title })), default: "sum" });
const WIN = 10;
const VIEW: { name: string; label: string; fmt?: (v: number) => string }[] = [
  { name: "pc_out", label: "pc", fmt: (v) => v.toString(16) },
  { name: "instr_out", label: "instr", fmt: (v) => v.toString(16).padStart(8, "0") },
  { name: "a", label: "a (rs1)", fmt: (v) => String(v | 0) },
  { name: "b", label: "b (rs2)", fmt: (v) => String(v | 0) },
  { name: "alu", label: "alu", fmt: (v) => String(v | 0) },
  { name: "wb", label: "wb", fmt: (v) => String(v | 0) },
  { name: "rf_we", label: "rf_we" },
  { name: "mem_we", label: "mem_we" },
  { name: "next_pc", label: "next_pc", fmt: (v) => v.toString(16) },
];

export function ArchHwCoreStepDemo() {
  const [id, setId] = useState("sum");
  const [k, setK] = useState(0);
  const prog = RV32I_PROGRAMS.find((p) => p.id === id)!;
  const program = useMemo(() => assemble(prog.source).program, [prog]);
  const run = useMemo(() => traceCore(program, 400), [program]);
  const n = run.cycles.length;
  const c = run.cycles[Math.min(k, n - 1)]!;
  const first = Math.max(0, Math.min(k - Math.floor(WIN / 2), n - WIN));
  const rows: WaveRow[] = VIEW.map((v) => ({ name: v.label, width: v.name === "rf_we" || v.name === "mem_we" ? 1 : 32, values: run.cycles.map((x) => x.sig[v.name]!), fmt: v.fmt }));
  const rd = c.sig.rf_we ? c.sig.rd! : 0;
  const after = run.cycles[Math.min(k + 1, n - 1)]!;
  return (
    <Demo
      title="The core in the RTL simulator, one cycle at a time"
      controls={
        <>
          <Param spec={range({ label: "Cycle", min: 0, max: Math.max(1, n - 1), step: 1, default: 0, format: (v) => `${v} of ${n - 1}` })} value={Math.min(k, n - 1)} onChange={(v) => setK(v as number)} />
          <Param spec={PROG} value={id} onChange={(v) => { setId(v as string); setK(0); }} />
        </>
      }
    >
      <StepCaption tone="info" label={`cycle ${k}`}>
        <span style={mono}>{c.text}</span> at pc {hex(c.pc)}.{" "}
        {rd ? `The register file write port has ${REG_ABI[rd]} = ${c.sig.wb! | 0}; the edge stores it.` : c.sig.mem_we ? `The memory write port is on for address ${hex(c.sig.addr!)}.` : "No register is written."}{" "}
        Next pc: {hex(c.sig.next_pc!)}.{k === n - 1 && run.result.status === "pass" ? ` The program exits with ${run.result.exitCode}; the hart agrees on all ${run.result.retired} instructions.` : ""}
      </StepCaption>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Program in the core's memory</SectionLabel>
          <AsmListing program={program} pc={c.pc} maxHeight={240} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>The core's register file (after this edge)</SectionLabel>
          <RegFile regs={after.regs} changed={rd ? [rd] : []} show="used" />
        </div>
      </div>
      <SectionLabel>The instruction word, as decode splits it</SectionLabel>
      <BitFields word={c.instr} />
      <SectionLabel>Datapath signals around this cycle (click a cycle)</SectionLabel>
      <Waveform rows={rows} cycles={Math.min(n, first + WIN)} first={first} cursor={k} onCursor={setK} cw={66} clock />
      <Stats items={[
        { label: "cycles", value: String(n) },
        { label: "instructions", value: String(run.result.retired) },
        { label: "cycles per instruction", value: "1" },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- lockstep

const BUG = select({ label: "Bug", options: [{ value: "none", label: "No bug" }, ...BUGS.map((b) => ({ value: b.id, label: b.title }))], default: "imm-i-zero" });
const PROGRAMS_ASM = new Map(ALL_TESTS.map((id) => {
  const src = RV32I_PROGRAMS.find((p) => p.id === id)?.source ?? DIRECTED.find((t) => t.id === id)!.source;
  return [id, assemble(src).program] as const;
}));
const titleOf = (id: string) => RV32I_PROGRAMS.find((p) => p.id === id)?.title ?? DIRECTED.find((t) => t.id === id)!.title;

export function ArchHwLockstepDemo() {
  const [bug, setBug] = useState("imm-i-zero");
  const [src, setSrc] = useState(withBug("imm-i-zero"));
  const [picked, setPicked] = useState<string | null>(null);
  const results = useChunked(src, ALL_TESTS.map((id) => () => cosim(src, PROGRAMS_ASM.get(id)!)), { keep: true });
  const done = results.filter(Boolean).length;
  const first = ALL_TESTS.find((_, i) => results[i] && results[i]!.status !== "pass") ?? null;
  const sel = picked ?? first ?? ALL_TESTS[0]!;
  const r = results[ALL_TESTS.indexOf(sel)] as CosimResult | undefined;
  const b = BUGS.find((x) => x.id === bug);
  const bugLine = b ? src.split("\n").findIndex((l) => l.includes(b.replace.split("\n")[0]!.trim())) + 1 : 0;
  const pass = results.filter((x) => x && x.status === "pass").length;
  const progPass = ALL_TESTS.filter((id, i) => RV32I_PROGRAMS.some((p) => p.id === id) && results[i]?.status === "pass").length;
  const err = results.find((x) => x?.error)?.error ?? null;
  const pick = (v: string) => { setBug(v); setSrc(withBug(v === "none" ? null : v)); setPicked(null); };
  return (
    <Demo title="Lockstep with the hart: inject a bug, find the first wrong instruction" controls={<Param spec={BUG} value={bug} onChange={(v) => pick(v as string)} />}>
      <StepCaption tone={err ? "bad" : done < ALL_TESTS.length ? "plain" : pass === ALL_TESTS.length ? "good" : "bad"} label={`${pass} of ${ALL_TESTS.length} pass`}>
        {err ? `The core does not compile: line ${err.line}: ${err.message}` : b ? b.about : src === CORE_SRC ? "The core as written. Every test runs in lockstep with the hart." : "Your edited core."}
      </StepCaption>
      <SectionLabel>Tests (click one)</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {ALL_TESTS.map((id, i) => {
          const x = results[i], ok = x?.status === "pass", directed = id.startsWith("t-");
          const col = !x ? "var(--muted)" : ok ? "var(--c3)" : "var(--c4)";
          return (
            <button key={id} className="btn" onClick={() => setPicked(id)} title={titleOf(id)} style={{
              ...mono, fontSize: 12, padding: "2px 8px", borderColor: col, background: x ? tint(col, ok ? 18 : 30) : undefined,
              outline: id === sel ? "2px solid var(--fg)" : undefined, outlineOffset: -2, fontStyle: directed ? "italic" : undefined,
            }}>{ok ? "✓" : x ? "✗" : "…"} {id}</button>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Upright: sample programs. Italic (t-…): directed tests in the style of riscv-tests.</div>
      {r && (
        <>
          <SectionLabel>{titleOf(sel)}</SectionLabel>
          {r.mismatch ? (
            <StepCaption tone="bad" label={`instruction ${r.mismatch.seq}`}>
              <span style={mono}>{r.mismatch.text}</span> at pc {hex(r.mismatch.pc)}: the {r.mismatch.what} differs. Hart: <b style={mono}>{r.mismatch.expected}</b>. Core: <b style={mono}>{r.mismatch.got}</b>.
            </StepCaption>
          ) : (
            <StepCaption tone={r.status === "pass" ? "good" : "warn"} label={r.status}>
              {r.status === "pass" ? `${r.retired} instructions agree. Exit code ${r.exitCode}${r.output ? `, output "${r.output.trim()}"` : ""}.` : `Stopped: ${r.status}.`}
            </StepCaption>
          )}
          <MiniTable
            head={["#", "pc", "instruction", "hart", "core"]}
            highlight={(i) => !!r.mismatch && i === r.rows.length - 1}
            rows={r.rows.map((x) => [
              String(x.seq), <span key="p" style={mono}>{x.pc.toString(16)}</span>, <span key="t" style={mono}>{x.text}</span>,
              <span key="h" style={mono}>{x.hart.store ? `M[${x.hart.store.addr.toString(16)}] ← ${x.hart.store.value.toString(16)}` : x.hart.rd ? `${REG_ABI[x.hart.rd]} ← ${x.hart.value | 0}` : "–"}</span>,
              <span key="c" style={mono}>{x.core.store ? `M[${x.core.store.addr.toString(16)}] mask ${x.core.store.mask.toString(2).padStart(4, "0")}` : x.core.we ? `${REG_ABI[x.core.rd]} ← ${x.core.value | 0}` : "–"}</span>,
            ])}
          />
        </>
      )}
      <Stats items={[
        { label: "sample programs passing", value: `${progPass} of ${RV32I_PROGRAMS.length}` },
        { label: "directed tests passing", value: `${pass - progPass} of ${DIRECTED.length}` },
      ]} />
      <SectionLabel>The core (edit it: every test runs again)</SectionLabel>
      <VerilogEditor value={src} onChange={(v) => { setSrc(v); setPicked(null); }} error={err} rows={14} mark={bugLine || undefined} />
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{bugLine ? `The bug is on line ${bugLine}. ` : ""}{disasm(0x00000073)} hands control to the testbench, which plays the kernel for exit and write.</div>
    </Demo>
  );
}
