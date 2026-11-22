/**
 * Demos for "Lifetimes": the three elision rules applied to a signature step by step, and a region view that puts
 * each variable's scope next to the lines where each borrow of it is live.
 */
import { useMemo, useState } from "react";
import { Banner, Demo, MONO, Param, SectionLabel, mono, select, tint } from "../../kit";
import { ELISION_EXAMPLES, LIFETIMES, SigError, check, elide, parseSig } from "../../sims/sys/ownership";
import { EditableCode, LoanTimeline, Verdict } from "./SysOwnUi";

const exSpec = select({ label: "Signature", options: ELISION_EXAMPLES.map((e) => ({ value: e.id, label: e.src.replace(/^fn /, "") })), default: "one" });
const LT_COLOR = ["var(--c1)", "var(--c5)", "var(--c3)", "var(--c2)"];

/** A signature with each lifetime name colored. */
function Colored({ text }: { text: string }) {
  const names = [...new Set(text.match(/'[a-z_]+/g) ?? [])].filter((n) => n !== "'static");
  return (
    <span style={{ whiteSpace: "pre" }}>
      {text.split(/('[a-z_]+)/).map((part, i) => {
        const k = names.indexOf(part);
        return k >= 0 ? <b key={i} style={{ color: LT_COLOR[k % LT_COLOR.length] }}>{part}</b> : <span key={i}>{part}</span>;
      })}
    </span>
  );
}

export function ElisionDemo() {
  const [id, setId] = useState("one");
  const ex = ELISION_EXAMPLES.find((e) => e.id === id)!;
  const [text, setText] = useState(ex.src);
  const res = useMemo(() => {
    try { return { r: elide(parseSig(text)) }; } catch (e) { if (e instanceof SigError) return { err: e.message }; throw e; }
  }, [text]);
  const box = { fontFamily: MONO, fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", overflowX: "auto" as const };
  return (
    <Demo title="Lifetime elision: fill in what the signature leaves out" controls={<Param spec={exSpec} value={id} onChange={(v) => { const e = ELISION_EXAMPLES.find((x) => x.id === v)!; setId(e.id); setText(e.src); }} />}>
      <SectionLabel style={{ marginTop: 0 }}>The signature as written (you can edit it)</SectionLabel>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="function signature"
        style={{ width: "100%", boxSizing: "border-box", fontFamily: MONO, fontSize: 12.5, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)" }}
      />
      {res.err !== undefined && <Banner tone="warn">The signature parser stops: {res.err}.</Banner>}
      {res.r && (
        <>
          <SectionLabel>The rules, in order</SectionLabel>
          <div style={{ display: "grid", gap: 4 }}>
            {res.r.steps.map((st, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "64px minmax(0, 1fr)", gap: 8, fontSize: 13, alignItems: "baseline" }}>
                <span style={{ ...mono, fontSize: 12, padding: "1px 6px", borderRadius: 4, background: tint(st.rule ? "var(--c1)" : "var(--faint)", 18), textAlign: "center" }}>{st.rule ? `rule ${st.rule}` : "result"}</span>
                <span>{st.text}</span>
              </div>
            ))}
          </div>
          <SectionLabel>What the compiler sees</SectionLabel>
          {res.r.ok ? (
            <>
              <div style={box}><Colored text={res.r.text} /></div>
              <Banner tone="good">Accepted. {res.r.output && res.r.output !== "'static" ? `The result borrows from every input with ${res.r.output}.` : "The result holds no borrow of an input."}</Banner>
            </>
          ) : (
            <>
              <div style={{ ...box, lineHeight: 1.5 }}>
                <div><b style={{ color: "var(--c4)" }}>error[{res.r.code}]</b><b>: {res.r.message}</b></div>
                <div style={{ color: "var(--c4)" }}>{res.r.label}</div>
                {res.r.help && <div className="muted" style={{ whiteSpace: "normal" }}>help: {res.r.help}</div>}
              </div>
              <Banner tone="bad">Rejected: you must name the lifetimes, because the compiler will not guess which input the result borrows from.</Banner>
            </>
          )}
        </>
      )}
    </Demo>
  );
}

const regSpec = select({ label: "Program", options: LIFETIMES.filter((p) => p.id !== "missing").map((p) => ({ value: p.id, label: p.title })), default: "longestbad" });

export function RegionDemo() {
  const [id, setId] = useState("longestbad");
  const preset = LIFETIMES.find((p) => p.id === id)!;
  const [src, setSrc] = useState(preset.src);
  const r = useMemo(() => check(src), [src]);
  const lines = src.split("\n");
  return (
    <Demo title="A borrow must end inside the scope of what it borrows" controls={<Param spec={regSpec} value={id} onChange={(v) => { const p = LIFETIMES.find((x) => x.id === v)!; setId(p.id); setSrc(p.src); }} />}>
      <SectionLabel style={{ marginTop: 0 }}>Green: each variable's scope. Blue: the lines on which each loan is live.</SectionLabel>
      <EditableCode value={src} onChange={setSrc} onReset={() => setSrc(preset.src)}>
        <LoanTimeline r={r} lines={lines} scopes />
      </EditableCode>
      <Verdict r={r} lines={lines} output={!/^fn /m.test(src)} />
    </Demo>
  );
}
