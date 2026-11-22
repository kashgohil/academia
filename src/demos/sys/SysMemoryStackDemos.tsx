/**
 * Demos for "Stack and heap" (Systems / memory):
 * - SysMemoryReturnLocalDemo: one function returns the address of its local, in C, Rust, Zig and Go, stepped on the
 *   shared memory machine.
 * - SysMemoryEscapeDemo: be Go's escape analysis: say stack or heap for each function, then see what -gcflags=-m said.
 * - SysMemoryStackBudgetDemo: how deep a recursion can go on a main thread, a thread and a goroutine.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { Banner, Btn, ButtonRow, Demo, IndexButtons, Meter, Note, Param, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, bytes, int, mono, range, select, tint, useParams, Controls, useStepper } from "../../kit";
import {
  budgets, ESCAPE_CASES, goLargestStack, GO_MAX_STACK, RETURN_LOCAL, runScript, type EscapeCase, type Lang,
} from "../../sims/sys/memory";
import { HeapBlocks, StackView, UbBanner } from "./SysViews";
import { CodeLines, CompilerBox } from "./SysMemoryUi";

const two: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 };

// ---------------------------------------------------------------- return the address of a local

const langSpec = select({ label: "Language", options: RETURN_LOCAL.map((p) => ({ value: p.lang, label: p.label })), default: "c", segmented: true });

export function SysMemoryReturnLocalDemo() {
  const [lang, setLang] = useState<Lang>("c");
  const prog = RETURN_LOCAL.find((p) => p.lang === lang)!;
  const steps = useMemo(() => runScript(prog.script).steps, [prog]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[s.i]!;
  const src = prog.runs === "fix" ? prog.fixSource! : prog.source;
  const bad = new Set(steps.slice(1, s.i + 1).filter((x) => x.ub.length).map((x) => x.line));
  const hasHeap = steps.some((x) => x.snap.heap.length > 0);
  const ubSoFar = cur.snap.ub.length;
  return (
    <Demo
      title="Return the address of a local, in four languages"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={langSpec} value={lang} onChange={(v) => { setLang(v as Lang); s.reset(); }} />
      </>}
    >
      <div style={two}>
        <div style={{ minWidth: 0 }}>
          {prog.runs === "fix" ? (
            <>
              <SectionLabel style={{ marginTop: 0 }}>The program</SectionLabel>
              <CodeLines lines={prog.source} dim />
              <CompilerBox tool={prog.compiler.tool} lines={prog.compiler.text} tone={prog.compiler.verdict} />
              <SectionLabel>The fix that runs: ask for the heap in the type</SectionLabel>
              <CodeLines lines={src} current={cur.line} bad={bad} />
            </>
          ) : (
            <>
              <SectionLabel style={{ marginTop: 0 }}>The program (current line highlighted)</SectionLabel>
              <CodeLines lines={src} current={cur.line} bad={bad} />
              <CompilerBox tool={prog.compiler.tool} lines={prog.compiler.text} tone={prog.compiler.verdict} />
            </>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack, high addresses on top</SectionLabel>
          <StackView frames={cur.snap.frames} empty="No frames yet: main has not started." />
          {hasHeap && (
            <>
              <SectionLabel>Heap</SectionLabel>
              <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} small empty="No heap blocks yet." />
            </>
          )}
        </div>
      </div>
      <StepCaption label={cur.line ? `line ${cur.line}` : "start"} tone={cur.ub.length ? "bad" : null}>{cur.caption}</StepCaption>
      {cur.ub.map((r, i) => <UbBanner key={i} event={r} />)}
      {s.atEnd && !cur.ub.length && <Banner tone={ubSoFar ? "warn" : "good"}>{prog.outcome}</Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- be the escape analysis

type Guess = "stack" | "heap" | "both";
const GUESS_TEXT: Record<Guess, string> = { stack: "Stack", heap: "Heap", both: "Depends on n" };

function EscapeVerdict({ c, guess }: { c: EscapeCase; guess: Guess }) {
  const right = guess === c.where;
  return (
    <>
      <CompilerBox tool="go build -gcflags=-m (go 1.25)" tone={c.where === "stack" ? "note" : "warning"} lines={c.output.length ? c.output : ["(nothing printed for these variables: they stay on the stack)"]} />
      <Banner tone={right ? "good" : "bad"} label={right ? "Right" : `Not ${GUESS_TEXT[guess].toLowerCase()}`}>
        {GUESS_TEXT[c.where]}. {c.why}
      </Banner>
    </>
  );
}

export function SysMemoryEscapeDemo() {
  const [k, setK] = useState(0);
  const [guesses, setGuesses] = useState<Record<string, Guess>>({});
  const c = ESCAPE_CASES[k]!;
  const g = guesses[c.id];
  const answered = ESCAPE_CASES.filter((x) => guesses[x.id]);
  const right = answered.filter((x) => guesses[x.id] === x.where).length;
  return (
    <Demo
      title="Be the escape analysis: stack or heap?"
      actions={<ButtonRow><IndexButtons k={k} n={ESCAPE_CASES.length} set={setK} /></ButtonRow>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Function {k + 1} of {ESCAPE_CASES.length}: {c.title}</div>
      <CodeLines lines={c.code} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Where does the data live?</span>
        {(["stack", "heap", "both"] as Guess[]).map((x) => (
          <Btn key={x} on={g === x} onClick={() => setGuesses({ ...guesses, [c.id]: x })}>{GUESS_TEXT[x]}</Btn>
        ))}
      </div>
      {g ? <EscapeVerdict c={c} guess={g} /> : <Note>Pick an answer to see what the compiler printed.</Note>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
        {ESCAPE_CASES.map((x, i) => {
          const gx = guesses[x.id];
          const col = !gx ? "var(--border)" : gx === x.where ? "var(--c3)" : "var(--c4)";
          return (
            <button key={x.id} onClick={() => setK(i)} title={x.title} style={{ width: 26, height: 22, borderRadius: 4, border: `1px solid ${col}`, background: i === k ? tint(col === "var(--border)" ? "var(--c1)" : col, 30) : "transparent", color: "var(--fg)", fontSize: 11, ...mono, cursor: "pointer" }}>{i + 1}</button>
          );
        })}
      </div>
      <Stats items={[{ label: "answered", value: `${answered.length} of ${ESCAPE_CASES.length}` }, { label: "right", value: `${right}` }]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- stack budgets

const fmtB = (v: number) => bytes(v);
const budgetSchema = {
  frame: range({ label: "Frame size", min: 16, max: 65536, default: 1024, log: true, format: (v) => fmtB(Math.round(v)) }),
  depth: range({ label: "Recursion depth", min: 10, max: 2_000_000, default: 10000, log: true, format: (v) => int(Math.round(v)) }),
};

const OVERFLOW: Record<string, string> = {
  main: "SIGSEGV: the next frame touches the guard gap below the stack",
  pthread: "SIGSEGV in the guard page below the thread stack",
  rust: "thread '…' has overflowed its stack (Rust's guard-page handler)",
  go: "runtime: goroutine stack exceeds 1000000000-byte limit",
};

export function SysMemoryStackBudgetDemo() {
  const params = useParams("sysmem-stack", budgetSchema);
  const frame = Math.round(params.values.frame);
  const depth = Math.round(params.values.depth);
  const rows = budgets(frame, depth);
  const used = frame * depth;
  return (
    <Demo title="How deep can a recursion go?" controls={<Controls params={params} />}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8, ...mono }}>stack needed = {int(depth)} frames × {fmtB(frame)} = {fmtB(used)}</div>
      {rows.map((b) => {
        const go = b.kind.grows;
        const max = go ? goLargestStack() : b.kind.limit;
        return (
          <div key={b.kind.id} style={{ marginBottom: 6 }}>
            <Meter
              label={<>{b.kind.label} <span style={{ color: "var(--faint)" }}>· {go ? `grows to ${fmtB(goLargestStack())}` : fmtB(b.kind.limit)}</span></>}
              value={Math.min(used, max)} max={max} log color={b.fits ? "var(--c1)" : "var(--c4)"}
              text={b.fits ? (go ? `stack now ${fmtB(b.size)}` : `${Math.round((100 * used) / b.kind.limit)}% used`) : "overflow"}
            />
            <div className="muted" style={{ fontSize: 11.5, marginTop: -3 }}>
              {b.fits
                ? go ? `${b.growths} growth${b.growths === 1 ? "" : "s"} from 2 KiB, ${fmtB(b.copied ?? 0)} copied in total. Deepest possible: ${int(b.depth)} frames.` : `Deepest possible: ${int(b.depth)} frames.`
                : OVERFLOW[b.kind.id]}
            </div>
          </div>
        );
      })}
      <Note>Bars use a log scale. The main thread and thread sizes are fixed when the stack is made. A goroutine starts small and doubles by copying; the 1 GB limit ({int(GO_MAX_STACK)} bytes) means the largest stack is 512 MiB.</Note>
    </Demo>
  );
}
