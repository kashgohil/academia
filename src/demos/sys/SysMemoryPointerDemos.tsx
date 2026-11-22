/**
 * Demos for "Pointers and references" (Systems / memory):
 * - SysMemoryArithDemo: C pointer arithmetic on the shared machine: p + i, one past the end, out of bounds.
 * - SysMemoryFatPtrDemo: the words of thin and fat pointers in C++, Rust, Go and Zig, and what slicing changes.
 * - SysMemoryHoldDemo: keep a pointer into a growable array, then append, in Go, C++ and Rust.
 * - SysMemoryGrowthDemo: the capacity policies of Go's append, Rust's Vec and libc++'s vector.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Banner, ButtonRow, Demo, Legend, Line, MiniTable, Note, Param, Plot, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, int, mono, range, select, tint, toggle, useStepper } from "../../kit";
import { array, hex, layoutC } from "../../sims/sys/mem";
import { arith, distinctCaps, ELEMS, FAT_POINTERS, GO_VARIABLE_MAKE_BYTES, HOLD, pushAll, runScript, sliceOf, type HoldLang, type Policy } from "../../sims/sys/memory";
import { HeapBlocks, StackView, StructBytes, UbBanner } from "./SysViews";
import { CodeLines, CompilerBox } from "./SysMemoryUi";

const two: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 };

// ---------------------------------------------------------------- pointer arithmetic

const COUNT = 8;
const elemSpec = select({ label: "Element type T", options: ELEMS.map((e) => ({ value: e.id, label: e.label })), default: "int" });
const iSpec = range({ label: "i in p + i", min: -1, max: 11, step: 1, default: 3 });

export function SysMemoryArithDemo() {
  const [elemId, setElem] = useState("int");
  const [i, setI] = useState(3);
  const elem = ELEMS.find((e) => e.id === elemId)!;
  const r = arith(elem.type, COUNT, i);
  const lay = layoutC(array(elem.type, COUNT));
  const tone = r.status === "in-bounds" ? "good" : r.status === "one-past" ? "warn" : "bad";
  const text = {
    "in-bounds": `p + ${i} points to element ${i}. Reading it is fine.`,
    "one-past": `p + ${i} is one past the end. C allows you to form it, compare it and subtract it (a loop end), but not to read through it.`,
    "out-of-bounds": `p + ${i} is outside the array. In C even forming this pointer is undefined behavior; the compiler may assume it never happens.`,
    negative: "p - 1 is before the array. Forming it is undefined behavior too: only 0 to N are valid offsets.",
  }[r.status];
  return (
    <Demo title="Pointer arithmetic counts elements, not bytes" controls={<>
      <Param spec={elemSpec} value={elemId} onChange={(v) => setElem(v as string)} />
      <Param spec={iSpec} value={i} onChange={(v) => setI(v as number)} />
    </>}>
      <CodeLines lines={[`${elem.label.split(" (")[0]} *p = malloc(${COUNT} * sizeof *p);  // ${COUNT * r.size} bytes`, `${elem.label.split(" (")[0]} *q = p ${i < 0 ? "-" : "+"} ${Math.abs(i)};`, "use(*q);"]} />
      <div style={{ ...mono, fontSize: 13, margin: "8px 0", overflowX: "auto", whiteSpace: "nowrap" }}>
        q = {hex(r.base)} {i < 0 ? "-" : "+"} {Math.abs(i)} × {r.size} = <b>{hex(r.addr)}</b> <span className="muted">(byte offset {i * r.size})</span>
      </div>
      <StructBytes layout={lay} highlight={r.status === "in-bounds" ? `[${i}]` : undefined} table={false} bytesPerRow={elem.type.k === "struct" ? 12 : 16}
        caption={<>{COUNT} × {r.size} B = {COUNT * r.size} B. {r.status === "in-bounds" ? `Element [${i}] is outlined.` : `q is at byte ${i * r.size}, outside the ${COUNT * r.size} bytes.`}</>} />
      <Banner tone={tone}>{text}</Banner>
      {r.ub && <UbBanner event={r.ub} />}
    </Demo>
  );
}

// ---------------------------------------------------------------- fat pointers

const fatSpec = select({ label: "Type", options: FAT_POINTERS.map((f) => ({ value: f.id, label: `${f.lang}: ${f.type}` })), default: "go-slice" });
const BASE = 0xc000010000;
const TOTAL = 8;
const ELEM = 4;
const WORD_COLOR: Record<string, string> = { data: "var(--c1)", vtable: "var(--c5)", none: "var(--c2)" };

function Cell({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", fontSize: 12, ...mono, textAlign: "center", ...style }}>{children}</div>;
}

export function SysMemoryFatPtrDemo() {
  const [id, setId] = useState("go-slice");
  const [a, setA] = useState(2);
  const [b, setB] = useState(5);
  const f = FAT_POINTERS.find((x) => x.id === id)!;
  const sliceable = f.shape === "slice" || f.shape === "goslice";
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const v = sliceOf(f.shape, TOTAL, sliceable ? lo : 0, sliceable ? hi : TOTAL, BASE, ELEM);
  const wordValue = (name: string): string => {
    if (name === "ptr" || name === "data") return hex(v.ptr);
    if (name === "len" || name === "size") return String(f.shape === "vec" ? TOTAL - 2 : v.len);
    if (name === "cap") return String(f.shape === "vec" ? TOTAL : v.cap);
    if (name === "vtable" || name === "type/itab") return hex(0x4c1a40);
    return "";
  };
  const covered = (k: number) => (f.shape === "dyn" ? k < 2 : f.shape === "thin" ? k === 0 : f.shape === "vec" ? k < TOTAL - 2 : k >= v.from && k < v.from + v.len);
  const inCap = (k: number) => f.shape === "goslice" && k >= v.from + v.len || f.shape === "vec" && k >= TOTAL - 2;
  return (
    <Demo title="Thin and fat pointers" controls={<>
      <Param spec={fatSpec} value={id} onChange={(x) => setId(x as string)} />
      {sliceable && <Param spec={range({ label: "Slice start a", min: 0, max: TOTAL, step: 1, default: 2 })} value={a} onChange={(x) => setA(x as number)} />}
      {sliceable && <Param spec={range({ label: "Slice end b", min: 0, max: TOTAL, step: 1, default: 5 })} value={b} onChange={(x) => setB(x as number)} />}
    </>}>
      <SectionLabel style={{ marginTop: 0 }}>{f.type}: {f.size} bytes{sliceable ? ` · the view s[${lo}:${hi}]` : ""}</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {f.words.map((w) => (
          <Cell key={w.name} style={{ minWidth: 92, boxShadow: `inset 0 -3px 0 ${WORD_COLOR[w.to ?? "none"]}` }}>
            <div className="muted" style={{ fontSize: 10.5 }}>{w.name} · {w.bytes} B</div>
            <div>{wordValue(w.name)}</div>
          </Cell>
        ))}
      </div>
      <SectionLabel>{f.shape === "dyn" ? "The data and the table that the second word points to" : `The backing array: ${TOTAL} × ${ELEM}-byte elements at ${hex(BASE)}`}</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", gap: 3, minWidth: "max-content" }}>
          {Array.from({ length: f.shape === "dyn" ? 2 : TOTAL }, (_, k) => (
            <Cell key={k} style={{ width: 44, background: covered(k) ? tint("var(--c1)", 28) : inCap(k) ? tint("var(--c1)", 10) : undefined, borderStyle: inCap(k) ? "dashed" : "solid" }}>
              <div className="muted" style={{ fontSize: 10 }}>[{k}]</div>{10 * (k + 1)}
            </Cell>
          ))}
          {f.shape === "dyn" && (
            <div style={{ marginLeft: 12, display: "grid", gap: 2 }}>
              {(f.lang === "Go" ? ["type", "hash", "fun[0] Area"] : ["drop_in_place", "size = 8", "align = 8", "Shape::area"]).map((e) => <Cell key={e} style={{ fontSize: 11, background: tint("var(--c5)", 14) }}>{e}</Cell>)}
            </div>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11.5, marginTop: 6 }} className="muted">
        <span><span style={{ display: "inline-block", width: 9, height: 9, background: tint("var(--c1)", 28), marginRight: 4 }} />in the view (len)</span>
        {(f.shape === "goslice" || f.shape === "vec") && <span><span style={{ display: "inline-block", width: 9, height: 9, border: "1px dashed var(--border)", background: tint("var(--c1)", 10), marginRight: 4 }} />capacity beyond len</span>}
      </div>
      <MiniTable head={["knows its length", "can be null", "checked size"]} rows={[[f.len ? "yes" : "no", f.nullable, `${f.size} B`]]} />
      <Note>{f.note}</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- hold a pointer, then grow

const holdSpec = select({ label: "Language", options: HOLD.map((h) => ({ value: h.lang, label: h.label })), default: "go", segmented: true });

export function SysMemoryHoldDemo() {
  const [lang, setLang] = useState<HoldLang>("go");
  const prog = HOLD.find((h) => h.lang === lang)!;
  const steps = useMemo(() => runScript(prog.script).steps, [prog]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[s.i]!;
  const src = prog.fixSource ?? prog.source;
  const bad = new Set(steps.slice(1, s.i + 1).filter((x) => x.ub.length).map((x) => x.line));
  return (
    <Demo
      title="Keep a pointer into an array, then append"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={holdSpec} value={lang} onChange={(v) => { setLang(v as HoldLang); s.reset(); }} />
      </>}
    >
      <div style={two}>
        <div style={{ minWidth: 0 }}>
          {prog.compiler ? (
            <>
              <SectionLabel style={{ marginTop: 0 }}>The program</SectionLabel>
              <CodeLines lines={prog.source} dim />
              <CompilerBox tool={prog.compiler.tool} lines={prog.compiler.text} tone="error" />
              <SectionLabel>The fix that runs: keep an index</SectionLabel>
              <CodeLines lines={src} current={cur.line} bad={bad} />
            </>
          ) : (
            <>
              <SectionLabel style={{ marginTop: 0 }}>The program</SectionLabel>
              <CodeLines lines={src} current={cur.line} bad={bad} />
            </>
          )}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Output: <span style={mono}>{prog.output}</span></div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack</SectionLabel>
          <StackView frames={cur.snap.frames} empty="No frames yet." />
          <SectionLabel>Heap: the arrays and who points at them</SectionLabel>
          <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} small empty="No arrays yet." />
        </div>
      </div>
      <StepCaption label={cur.line ? `line ${cur.line}` : "start"} tone={cur.ub.length ? "bad" : null}>{cur.caption}</StepCaption>
      {cur.ub.map((r, i) => <UbBanner key={i} event={r} />)}
      {s.atEnd && <Banner tone={lang === "cpp" ? "bad" : lang === "go" ? "warn" : "good"}>{prog.outcome}</Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- growth policies

const nSpec = range({ label: "Elements pushed", min: 1, max: 20000, default: 1000, log: true, format: (v) => int(Math.round(v)) });
const sizeSpec = select({ label: "Element size", options: [{ value: "1", label: "1 byte" }, { value: "4", label: "4 bytes" }, { value: "8", label: "8 bytes" }], default: "8", segmented: true });
const escSpec = toggle({ label: "Go slice escapes (heap only)", default: true });
const POLICIES: { id: Policy; label: string; color: string }[] = [
  { id: "go", label: "Go append", color: "var(--c1)" },
  { id: "rust", label: "Rust Vec", color: "var(--c3)" },
  { id: "cpp", label: "libc++ vector", color: "var(--c5)" },
];

const DECADES = [1, 10, 100, 1000, 10000, 100000];

/** Capacity as a step function of length, sampled at its corners. */
function steps(caps: number[]): [number, number][] {
  const pts: [number, number][] = [];
  let last = 0;
  caps.forEach((c, i) => {
    if (c !== last) { if (i > 0) pts.push([i + 1, last]); pts.push([i + 1, c]); last = c; }
  });
  pts.push([caps.length, last]);
  return pts;
}

export function SysMemoryGrowthDemo() {
  const [n0, setN] = useState(1000);
  const [size, setSize] = useState("8");
  const [escapes, setEscapes] = useState(true);
  const n = Math.round(n0);
  const elem = Number(size);
  const runs = POLICIES.map((p) => ({ ...p, run: pushAll(p.id, n, elem, escapes ? 0 : GO_VARIABLE_MAKE_BYTES) }));
  const maxCap = Math.max(...runs.map((r) => r.run.caps[r.run.caps.length - 1] ?? 1));
  return (
    <Demo title="How capacity grows: Go, Rust and C++" controls={<>
      <Param spec={nSpec} value={n0} onChange={(v) => setN(v as number)} />
      <Param spec={sizeSpec} value={size} onChange={(v) => setSize(v as string)} />
      <Param spec={escSpec} value={escapes} onChange={(v) => setEscapes(v as boolean)} />
    </>}>
      <Plot x={[1, Math.max(2, n)]} y={[1, Math.max(2, maxCap)]} logX logY height={230} xLabel="length" yLabel="capacity" xTicks={DECADES.filter((d) => d <= n)} yTicks={DECADES.filter((d) => d <= maxCap)} xFormat={(v) => int(v)} yFormat={(v) => int(v)}>
        {runs.map((r) => <Line key={r.id} points={steps(r.run.caps)} color={r.color} width={1.8} dash={r.id === "cpp" ? "5 3" : undefined} />)}
      </Plot>
      <Legend items={POLICIES.map((p) => ({ label: p.label, color: p.color }))} />
      <MiniTable head={["policy", "final capacity", "reallocations", "elements copied", "copies per push"]} rows={runs.map((r) => [
        r.label, int(r.run.caps[r.run.caps.length - 1] ?? 0), int(r.run.reallocs), int(r.run.copied), (r.run.copied / n).toFixed(2),
      ])} />
      <Stats items={runs.map((r) => ({ label: `${r.label} capacities`, value: distinctCaps(r.run.caps).slice(-3).map(int).join(" → ") }))} />
      <Note>Go doubles up to 256 elements, then grows more slowly, and rounds each new array up to a size class of its allocator. Rust and libc++ double, so they copy fewer than two elements per push on average. Go's slower growth for large slices copies more: about 4 per push at a million elements.</Note>
    </Demo>
  );
}
