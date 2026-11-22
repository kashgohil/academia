/**
 * Demos for "Borrowing and the borrow checker": a loan timeline (NLL against a lexical model), a step-by-step view of
 * the checker's actions with the live loans, and the C++ bug that E0502 prevents, on the memory machine.
 */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, IndexButtons, IndexSlider, MiniTable, Param, SectionLabel, StepButtons, StepCaption, StepSlider, mono, seg, select, tint, useStepper } from "../../kit";
import { BORROWS, INVALIDATION_SOURCE, check, vectorInvalidation } from "../../sims/sys/ownership";
import { CodeView, Diagnostic, EditableCode, LoanTimeline, MemStepper, Verdict } from "./SysOwnUi";

const presetSpec = select({ label: "Program", options: BORROWS.map((p) => ({ value: p.id, label: p.title })), default: "nll" });
const modeSpec = seg<"nll" | "lexical">("Checker", [["nll", "NLL (today)"], ["lexical", "Lexical (model of 2015)"]], "nll");

export function BorrowTimelineDemo() {
  const [id, setId] = useState("nll");
  const [mode, setMode] = useState<"nll" | "lexical">("nll");
  const preset = BORROWS.find((p) => p.id === id) ?? BORROWS[0]!;
  const [src, setSrc] = useState(preset.src);
  const r = useMemo(() => check(src, { lexical: mode === "lexical" }), [src, mode]);
  const lines = src.split("\n");
  return (
    <Demo
      title="Each borrow is live from its creation to its last use"
      controls={<>
        <Param spec={presetSpec} value={id} onChange={(v) => { const p = BORROWS.find((x) => x.id === v)!; setId(p.id); setSrc(p.src); }} />
        <Param spec={modeSpec} value={mode} onChange={(v) => setMode(v as "nll" | "lexical")} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Program and its loans (blue: shared, orange: mutable, dashed: reserved)</SectionLabel>
      <EditableCode value={src} onChange={setSrc} onReset={() => setSrc(preset.src)}>
        <LoanTimeline r={r} lines={lines} />
      </EditableCode>
      <Verdict r={r} lines={lines} />
    </Demo>
  );
}

const STEP_IDS = ["push", "twophase", "twophasebad", "readmut", "reborrow"];
const stepSpec = select({ label: "Program", options: BORROWS.filter((p) => STEP_IDS.includes(p.id)).map((p) => ({ value: p.id, label: p.title })), default: "twophase" });
const OP_TEXT: Record<string, string> = { borrow: "borrow", reserve: "reserve", activate: "activate", read: "read", move: "move", write: "write", use: "use", def: "assign loans", dead: "scope end", drop: "drop", print: "print", call: "call" };

export function BorrowStepDemo() {
  const [id, setId] = useState("twophase");
  const prog = BORROWS.find((p) => p.id === id)!;
  const r = useMemo(() => check(prog.src), [prog]);
  const lines = prog.src.split("\n");
  const acts = r.actions.filter((a) => a.op !== "def" && a.op !== "print" && a.op !== "drop");
  const [k, setK] = useState(0);
  const i = Math.min(k, acts.length - 1);
  const cur = acts[i]!;
  const loanRows = r.loans.map((l) => {
    const live = cur.live.includes(l.id);
    const reservedNow = l.twoPhase && live && !acts.slice(0, i + 1).some((a) => a.op === "activate" && a.loan === l.id);
    return { l, live, reservedNow };
  });
  return (
    <Demo
      title="Be the borrow checker: one action at a time"
      actions={<ButtonRow><IndexButtons k={i} n={acts.length} set={setK} /></ButtonRow>}
      controls={<>
        <IndexSlider k={i} n={acts.length} set={setK} label="Action" />
        <Param spec={stepSpec} value={id} onChange={(v) => { setId(v as string); setK(0); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Source</SectionLabel>
          <CodeView lines={lines} current={cur.line} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Actions on line {cur.line}</SectionLabel>
          <div style={{ display: "grid", gap: 3, fontSize: 12.5, ...mono }}>
            {acts.map((a, j) => a.line === cur.line && (
              <div key={j} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: j === i ? tint(a.error ? "var(--c4)" : "var(--c1)", 18) : undefined, opacity: j > i ? 0.5 : 1 }}>
                <b style={{ fontWeight: 600 }}>{OP_TEXT[a.op]}</b> <span className="muted">{a.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <SectionLabel>Loans and whether they are live at this action</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <MiniTable
          head={["loan", "of", "kind", "made on", "live now?"]}
          highlight={(row) => loanRows[row]!.l.id === cur.loan}
          rows={loanRows.map(({ l, live, reservedNow }) => [
            `L${l.id}`, l.place, l.mut ? (l.twoPhase ? "&mut (two-phase)" : "&mut") : "&", `line ${l.line}`,
            live ? (reservedNow ? "yes, reserved" : "yes") : "no",
          ])}
        />
      </div>
      <StepCaption tone={cur.error ? "bad" : null} label={`line ${cur.line}`}>
        {cur.error ? `Conflict: ${cur.error.message}.` : checkText(cur.op, cur.live.length)}
      </StepCaption>
      {cur.error && <Diagnostic d={cur.error} lines={lines} />}
      {i === acts.length - 1 && !r.errors.length && <Banner tone="good">No action conflicts with a live loan: the program compiles.</Banner>}
    </Demo>
  );
}

function checkText(op: string, live: number): string {
  switch (op) {
    case "reserve": return "A two-phase borrow starts as a reservation. It conflicts only with live mutable loans, like a shared borrow.";
    case "activate": return "Activation: now the borrow is mutable. No other loan of the same place may be live here.";
    case "borrow": return "A new loan. A shared one must not overlap a live mutable loan; a mutable one must not overlap any live loan.";
    case "read": return "A read of the place. It conflicts only with live mutable loans.";
    case "move": return "A move out of the place. No loan of it may be live.";
    case "write": return "A write to the place. No loan of it may be live.";
    case "use": return `A use of a reference keeps its loans live until here. ${live} loan${live === 1 ? " is" : "s are"} live after this action.`;
    case "dead": return "The variable goes out of scope. No loan of it may still be live.";
    default: return "";
  }
}

const resSpec = seg<"no" | "yes">("v.reserve(4) first", [["no", "No"], ["yes", "Yes"]], "no");

export function InvalidationDemo() {
  const [res, setRes] = useState<"no" | "yes">("no");
  const steps = useMemo(() => vectorInvalidation(res === "yes"), [res]);
  const s = useStepper(steps.length, 1.2);
  return (
    <Demo
      title="The C++ bug that E0502 prevents"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={resSpec} value={res} onChange={(v) => { setRes(v as "no" | "yes"); s.reset(); }} />
      </>}
    >
      <MemStepper steps={steps} source={INVALIDATION_SOURCE} s={s} />
    </Demo>
  );
}
