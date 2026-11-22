/**
 * Demos for "Aliasing rules": a load that restrict lets the compiler hoist out of a loop, an int and a float at one
 * address (strict aliasing), and four ways to read the bits of a float. Memory comes from the shared machine.
 */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, IndexButtons, IndexSlider, mono, Param, range, SectionLabel, seg, select, StepCaption, tint } from "../../kit";
import { hex } from "../../sims/sys/mem";
import { floatBits, le32, mayHoist, PUN_METHODS, runScale, runTbaa, SCALE_A, SCALE_ASM, SCALE_V, type PunVerdict } from "../../sims/sys/ub";
import { AsmView, CodeView, Cols, OutBox } from "./SysUbUi";

// ---------------------------------------------------------------- hoisting under restrict

const kSpec = range({ label: "k points to", min: -1, max: 3, step: 1, default: -1, format: (v) => (v < 0 ? `v (= ${SCALE_V})` : `a[${v}]`) });
const qSpec = seg("Parameter a", [["plain", "int *a"], ["restrict", "int *restrict a"]], "plain");

function Cells({ vals, k, label, changed }: { vals: number[]; k: number; label: string; changed?: boolean[] }) {
  return (
    <div style={{ minWidth: 0 }}>
      <SectionLabel style={{ marginTop: 0 }}>{label}</SectionLabel>
      <div style={{ display: "flex", gap: 4 }}>
        {vals.map((x, j) => (
          <div key={j} style={{ flex: "1 1 0", minWidth: 0, border: `1px solid ${j === k ? "var(--c2)" : "var(--border)"}`, borderRadius: 5, textAlign: "center", padding: "3px 0", background: changed?.[j] ? tint("var(--c4)", 16) : undefined, boxShadow: j === k ? "inset 0 -3px 0 var(--c2)" : undefined }}>
            <div className="muted" style={{ fontSize: 10.5 }}>a[{j}]{j === k ? " ← k" : ""}</div>
            <div style={{ fontSize: 14, fontWeight: 600, ...mono }}>{x}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UbHoistDemo() {
  const [k, setK] = useState(-1);
  const [q, setQ] = useState<"plain" | "restrict">("plain");
  const written = useMemo(() => runScale(k, false), [k]);
  const hoisted = useMemo(() => runScale(k, true), [k]);
  const o2 = q === "restrict" ? hoisted : written;
  const diff = written.final.map((x, j) => x !== hoisted.final[j]);
  const anyDiff = diff.some(Boolean);
  const hoist = mayHoist(q === "restrict");
  const ub = q === "restrict" && k >= 0;
  return (
    <Demo title="Hoist the load of *k" controls={<><Param spec={kSpec} value={k} onChange={(v) => setK(v as number)} /><Param spec={qSpec} value={q} onChange={(v) => setQ(v as "plain" | "restrict")} /></>}>
      <Cols min={270} style={{ marginTop: 0 }}>
        <CodeView label="C source" lines={[
          `void scale(${q === "restrict" ? "int *restrict a" : "int *a"}, const int *k, int n) {`,
          "    for (int i = 0; i < n; i++)",
          { text: "        a[i] = a[i] * *k;", mark: "fact", note: hoist.ok ? "load *k once" : "reload *k" },
          "}",
          `int a[4] = {${SCALE_A.join(", ")}}, v = ${SCALE_V};`,
          `scale(a, ${k < 0 ? "&v" : `&a[${k}]`}, 4);`,
        ]} />
        <AsmView k={SCALE_ASM[q]} hot={/\[rsi\]/} label="Real clang -O2 output (vectorizer off)" />
      </Cols>
      <Banner tone={hoist.ok ? "info" : "plain"}>{hoist.ok ? "Hoisted: " : "Not hoisted: "}{hoist.why}</Banner>
      <Cols min={240}>
        <Cells vals={written.final} k={k} label="As written: reload *k (-O0)" />
        <Cells vals={o2.final} k={k} label={`clang -O2, ${q === "restrict" ? "restrict: load *k once" : "no restrict: reload"}`} changed={q === "restrict" ? diff : undefined} />
      </Cols>
      <SectionLabel>The value of *k in each iteration</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4, fontSize: 12, ...mono }}>
        {written.iters.map((it, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "3px 6px", textAlign: "center" }}>
            <div className="muted" style={{ fontSize: 10.5 }}>i = {i}</div>
            <div>{it.k}{it.k !== hoisted.iters[i]!.k ? <span style={{ color: "var(--c4)" }}> / {hoisted.iters[i]!.k}</span> : null}</div>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 3 }}>reloaded{anyDiff ? " / hoisted (red where they differ)" : "; the hoisted value is the same"}</div>
      <Banner tone={ub ? "bad" : anyDiff ? "warn" : "good"}>
        {ub
          ? `UB: a is restrict, but a[${k}] is written through a and read through k. ${anyDiff ? "The two builds give different arrays." : "Here both builds give the same array, but the program is still wrong."}`
          : anyDiff ? "Without restrict, clang must reload, so -O2 gives the as-written result." : "k does not alias anything that the loop writes before it reads *k, so every build agrees."}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- strict aliasing

const valSpec = select({ label: "Float stored through f", options: [["2", "2.0f"], ["1", "1.0f"], ["0.5", "0.5f"], ["-1", "-1.0f"]].map(([value, label]) => ({ value: value!, label: label! })), default: "2" });

function ByteRow({ bytes, init, hot }: { bytes: number[]; init: boolean[]; hot?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {bytes.map((b, i) => (
        <div key={i} style={{ width: 44, textAlign: "center", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 0", background: hot ? tint("var(--c1)", 16) : init[i] ? undefined : "var(--subtle)", ...mono, fontSize: 13 }}>
          <div className="muted" style={{ fontSize: 10 }}>+{i}</div>
          {init[i] ? b.toString(16).padStart(2, "0") : "??"}
        </div>
      ))}
    </div>
  );
}

export function UbTbaaDemo() {
  const [val, setVal] = useState("2");
  const run = useMemo(() => runTbaa(Number(val)), [val]);
  const [k, setK] = useState(run.steps.length - 1);
  const st = run.steps[Math.min(k, run.steps.length - 1)]!;
  const atEnd = k >= run.steps.length - 1;
  const lines = ["int f(int *i, float *f) {", "    *i = 1;", `    *f = ${st === run.steps[0] ? "2.0f" : run.steps[2]!.line.slice(5, -1)};`, "    return *i;", "}", "int x;  f(&x, (float *)&x);"];
  const cur = [5, 1, 2, 3][Math.min(k, 3)]!;
  return (
    <Demo
      title="An int and a float at one address"
      actions={<ButtonRow><IndexButtons k={k} n={run.steps.length} set={setK} /></ButtonRow>}
      controls={<><IndexSlider k={k} n={run.steps.length} set={setK} /><Param spec={valSpec} value={val} onChange={(v) => setVal(v as string)} /></>}
    >
      <Cols min={260} style={{ marginTop: 0 }}>
        <CodeView label="C source" lines={lines.map((t, i) => (i === cur ? { text: t, mark: "fact" as const } : t))} />
        <AsmView k="tbaa.O2" hot={/eax, 1$/} label="Real clang -O2 output (for 2.0f)" />
      </Cols>
      <SectionLabel>The 4 bytes of x, little-endian</SectionLabel>
      <ByteRow bytes={st.bytes} init={st.init} hot={k > 0} />
      <StepCaption label={st.line}>{st.note}</StepCaption>
      {atEnd && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))", gap: 8, marginTop: 8 }}>
          <OutBox title="-O0 returns" tone="warn">{run.returns.O0}</OutBox>
          <OutBox title="-O2 returns" tone="bad">{run.returns.O2}</OutBox>
          <OutBox title="-O2 -fno-strict-aliasing" tone="warn">{run.returns.nostrict}</OutBox>
        </div>
      )}
      {atEnd && <Banner tone="bad">UB: the program writes x as a float, then reads it as an int. -O2 assumes that a float store cannot change an int, so it returns the 1 that it stored before.</Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- type punning

const fSpec = range({ label: "f", min: -8, max: 8, step: 0.25, default: 1, format: (v) => `${v}` });
const V_TEXT: Record<PunVerdict, { t: string; c: string }> = {
  defined: { t: "defined", c: "var(--c3)" },
  ub: { t: "UB", c: "var(--c4)" },
  impl: { t: "impl.-defined", c: "var(--c2)" },
  na: { t: "—", c: "var(--faint)" },
};

export function UbPunDemo() {
  const [f, setF] = useState(1);
  const [mid, setMid] = useState("memcpy");
  const m = PUN_METHODS.find((x) => x.id === mid)!;
  const u = floatBits(f);
  const bytes = le32(u);
  const mSpec = select({ label: "Method", options: PUN_METHODS.map((x) => ({ value: x.id, label: `${x.label} (${x.lang})` })), default: "memcpy" });
  return (
    <Demo title="Read the bits of a float" controls={<><Param spec={fSpec} value={f} onChange={(v) => setF(v as number)} /><Param spec={mSpec} value={mid} onChange={(v) => setMid(v as string)} /></>}>
      <SectionLabel style={{ marginTop: 0 }}>The 4 bytes of f in memory, little-endian</SectionLabel>
      <ByteRow bytes={bytes} init={[true, true, true, true]} />
      <div style={{ fontSize: 13, marginTop: 6, ...mono }}>u = {hex(u)} = {u}</div>
      <Cols min={260}>
        <CodeView label={`${m.lang}: ${m.label}`} lines={m.code.split("\n")} />
        {m.asm ? <AsmView k={m.asm} /> : <div style={{ fontSize: 13, lineHeight: 1.45, minWidth: 0 }}><SectionLabel style={{ marginTop: 0 }}>Generated code</SectionLabel>{m.note}</div>}
      </Cols>
      <SectionLabel>What each language says</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%", minWidth: 300 }}>
          <thead><tr>{["Method", "C", "C++"].map((h) => <th key={h} style={{ textAlign: "left", padding: "3px 6px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>
            {PUN_METHODS.filter((x) => x.c !== "na" || x.cpp !== "na").map((x) => (
              <tr key={x.id} style={{ background: x.id === mid ? tint("var(--c1)", 12) : undefined, cursor: "pointer" }} onClick={() => setMid(x.id)}>
                <td style={{ padding: "3px 6px", ...mono }}>{x.label}</td>
                {[x.c, x.cpp].map((v, i) => <td key={i} style={{ padding: "3px 6px", color: V_TEXT[v].c, fontWeight: 600 }}>{V_TEXT[v].t}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {m.asm && <Banner>{m.note}</Banner>}
    </Demo>
  );
}
