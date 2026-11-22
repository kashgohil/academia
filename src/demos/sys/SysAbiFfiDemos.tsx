/** Demos for "FFI across languages": strings at the boundary, the price of a crossing, and a panic that meets C frames. */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, Legend, Line, Param, Plot, RuleX, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, mono, pct, range, seg, sig, tint, useStepper } from "../../kit";
import { CROSSING, LANGS, STR_CASES, UNWIND_SOURCE, breakEven, crossCost, strTrace, unwindTrace, type Lang, type StrCase, type UnwindMode } from "../../sims/sys/abi";
import { HeapBlocks, StackView, UbBanner } from "./SysViews";
import { AbiSource } from "./SysAbiUi";

const caseSpec = seg<StrCase>("Case", STR_CASES.map((c) => [c.id, c.label]), "asptr");

/** The bytes that strlen read, one cell each; bytes past `ok` are outside the string. */
function Scan({ bytes, ok }: { bytes: number[]; ok: number }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 3, ...mono, fontSize: 11.5 }}>
        {bytes.map((b, i) => {
          const out = i >= ok;
          const col = b === 0 ? "var(--c3)" : out ? "var(--c4)" : "var(--c1)";
          return (
            <div key={i} style={{ width: 34, flex: "none", textAlign: "center", border: `1px solid ${col}`, borderRadius: 4, background: tint(col, 14), padding: "2px 0" }}>
              <div>{b >= 32 && b < 127 ? `'${String.fromCharCode(b)}'` : b}</div>
              <div className="muted" style={{ fontSize: 10 }}>+{i}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AbiStringDemo() {
  const [c, setC] = useState<StrCase>("asptr");
  const meta = STR_CASES.find((x) => x.id === c)!;
  const steps = useMemo(() => strTrace(c), [c]);
  const s = useStepper(steps.length, 1);
  const cur = steps[s.i]!;
  const bad = new Set(steps.slice(0, s.i + 1).filter((x) => x.ub).map((x) => x.line));
  const ok = c === "asptr" ? 5 : 6;
  return (
    <Demo
      title="Pass a string to C"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={caseSpec} value={c} onChange={(v) => { setC(v as StrCase); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>{meta.lang === "rust" ? "Rust" : "Go"} source</SectionLabel>
          <AbiSource lines={meta.source} current={cur.line} bad={bad} />
          <SectionLabel>Bytes that strlen read</SectionLabel>
          {cur.scanned.length ? <Scan bytes={cur.scanned} ok={ok} /> : <div className="muted" style={{ fontSize: 12.5 }}>strlen has not run yet.</div>}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack</SectionLabel>
          <StackView frames={cur.snap.frames} empty="The function has returned." />
          {cur.snap.globals.length > 0 && <>
            <SectionLabel>Statics, in address order</SectionLabel>
            <div style={{ ...mono, fontSize: 12, border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px" }}>
              {cur.snap.globals.map((g) => <div key={g.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}><span>{g.name}</span><span className="muted">{g.size} B at …{g.addr.toString(16).slice(-4)}</span><span>{g.text}</span></div>)}
            </div>
          </>}
          <SectionLabel>Heap (C's malloc)</SectionLabel>
          <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} small empty="Nothing on the heap." />
        </div>
      </div>
      <StepCaption label={`step ${s.i + 1}`} tone={cur.ub ? "bad" : null}>{cur.text}</StepCaption>
      {cur.ub && <UbBanner event={cur.ub} />}
    </Demo>
  );
}

const langSpec = seg<Lang>("Caller", LANGS.map((l) => [l, CROSSING[l].label]), "go");
const COLORS: Record<Lang, string> = { go: "var(--c1)", rust: "var(--c3)", python: "var(--c5)" };
/** Work per call, sampled on a log scale from 0.1 ns to 10 µs. */
const WORK = Array.from({ length: 61 }, (_, i) => 10 ** (-1 + i / 12));

export function AbiCrossCostDemo() {
  const [lang, setLang] = useState<Lang>("go");
  const [logWork, setLogWork] = useState(1);
  const [logBatch, setLogBatch] = useState(0);
  const work = 10 ** logWork, batch = Math.round(10 ** logBatch);
  const items = 1_000_000;
  const r = crossCost(lang, work, items, batch);
  const curves = useMemo(() => LANGS.map((l) => ({ l, pts: WORK.map((w) => [Math.log10(w), 100 * crossCost(l, w, items, batch).share] as [number, number]) })), [batch]);
  return (
    <Demo
      title="What a crossing costs"
      controls={<>
        <Param spec={langSpec} value={lang} onChange={(v) => setLang(v as Lang)} />
        <Param spec={range({ label: "Work in the C function per item", min: -1, max: 4, step: 0.05, default: 1, format: (x) => `${sig(10 ** x)} ns` })} value={logWork} onChange={(v) => setLogWork(v as number)} />
        <Param spec={range({ label: "Items per call (batching)", min: 0, max: 3, step: 0.1, default: 0, format: (x) => String(Math.round(10 ** x)) })} value={logBatch} onChange={(v) => setLogBatch(v as number)} />
      </>}
    >
      <Plot x={[-1, 4]} y={[0, 100]} height={220} xTicks={[-1, 0, 1, 2, 3, 4]} xFormat={(v) => sig(10 ** v)} xLabel="work per item, ns (log scale)" yLabel="% of time spent crossing">
        {curves.map((c) => <Line key={c.l} points={c.pts} color={COLORS[c.l]} width={c.l === lang ? 2.5 : 1.2} />)}
        <RuleX at={logWork} label={`${sig(work)} ns`} />
      </Plot>
      <Legend items={LANGS.map((l) => ({ label: CROSSING[l].label, color: COLORS[l] }))} />
      <Stats items={[
        { label: "Calls for 1,000,000 items", value: sig(r.crossings) },
        { label: "Time crossing", value: `${sig(r.crossing / 1e6)} ms` },
        { label: "Time working", value: `${sig(r.work / 1e6)} ms` },
        { label: "Share crossing", value: pct(r.share) },
      ]} />
      <Banner tone={r.share > 0.5 ? "bad" : r.share > 0.1 ? "warn" : "good"}>
        One {CROSSING[lang].label} call costs {CROSSING[lang].foreign} ns here; a {CROSSING[lang].nativeLabel} call costs {CROSSING[lang].native} ns. With {batch} item{batch > 1 ? "s" : ""} per call, the crossing equals the work at {sig(breakEven(lang, batch))} ns of work per item.
      </Banner>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Measured model inputs: one Apple M4 Pro under load; go 1.25.6, rustc 1.96.1, Python 3.9.6. Your numbers will differ.</div>
    </Demo>
  );
}

const unwindSpec = seg<UnwindMode>("cmp is", [["c", 'extern "C"'], ["c-unwind", 'extern "C-unwind"'], ["catch", "catch inside cmp"]], "c");

export function AbiUnwindDemo() {
  const [mode, setMode] = useState<UnwindMode>("c");
  const steps = useMemo(() => unwindTrace(mode), [mode]);
  const s = useStepper(steps.length, 1);
  const cur = steps[s.i]!;
  const frames = cur.snap.frames.map((f) => ({ ...f, fn: `[${cur.frameLang[f.fn] ?? "?"}] ${f.fn}` }));
  return (
    <Demo
      title="A panic meets a C frame"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={unwindSpec} value={mode} onChange={(v) => { setMode(v as UnwindMode); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Rust source (qsort is C's, from libc)</SectionLabel>
          <AbiSource lines={UNWIND_SOURCE[mode]} current={cur.line} bad={cur.outcome === "abort" ? new Set([cur.line]) : undefined} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack, innermost frame at the bottom</SectionLabel>
          {cur.outcome === "abort"
            ? <div style={{ border: "1px solid var(--c4)", borderRadius: 6, padding: 8, fontSize: 12.5, ...mono }}>abort(): the process is gone. No destructor runs, and catch_unwind in main never sees the panic.</div>
            : <StackView frames={frames} empty="main has returned." />}
        </div>
      </div>
      <StepCaption label={`step ${s.i + 1}`} tone={cur.outcome === "abort" ? "bad" : cur.outcome ? "good" : null}>{cur.text}</StepCaption>
    </Demo>
  );
}
