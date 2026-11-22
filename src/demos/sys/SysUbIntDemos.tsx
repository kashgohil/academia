/**
 * Demos for "Integer overflow": loop counter widening (int vs unsigned), an overflow check that the optimizer deletes,
 * four ways to write the check, and malloc(n * size) with a 32-bit product on the shared machine.
 */
import { useMemo, useState } from "react";
import { Banner, bytes as fmtBytes, Demo, mono, Param, range, SectionLabel, seg, select, tint } from "../../kit";
import { ADD_INPUTS, addOverflows, CHECK_FORMS, fillWrites, INT_MAX, planAlloc, runAllocFill, runCheck, UINT_MAX, type CheckForm, type SizeMode } from "../../sims/sys/ub";
import { HeapBlocks, UbBanner } from "./SysViews";
import { AsmView, CodeView, Cols, OptimizerView, OutBox } from "./SysUbUi";

// ---------------------------------------------------------------- loop widening

const tSpec = seg("Type of i, n, k", [["int", "int"], ["unsigned", "unsigned"]], "int");
const dSpec = range({ label: "k", min: 0, max: 8, step: 1, default: 1, format: (v) => (v ? `MAX − ${v}` : "MAX") });
const nSpec = range({ label: "n", min: 1, max: 6, step: 1, default: 4 });

function IndexCells({ ix, other, label }: { ix: number[]; other: number[]; label: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <SectionLabel style={{ marginTop: 0 }}>{label}</SectionLabel>
      <div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {ix.map((x, j) => {
            const bad = x !== other[j];
            return (
              <div key={j} style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "2px 6px", textAlign: "right", background: bad ? tint("var(--c4)", 16) : undefined, ...mono, fontSize: 12 }}>
                <div className="muted" style={{ fontSize: 10 }}>i = {j}</div>
                <div>{x.toLocaleString("en-US")}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const flat = (runs: { from: number; to: number }[]) => runs.flatMap((r) => Array.from({ length: r.to - r.from }, (_, i) => r.from + i));

export function UbWidenDemo() {
  const [t, setT] = useState<"int" | "unsigned">("int");
  const [d, setD] = useState(1);
  const [n, setN] = useState(4);
  const signed = t === "int";
  const k = (signed ? INT_MAX : UINT_MAX) - d;
  const r = fillWrites(n, k, signed);
  const w = flat(r.written), o = flat(r.optimized);
  const differ = w.some((x, j) => x !== o[j]);
  const wraps = w.some((x, j) => j > 0 && x < w[j - 1]!);
  return (
    <Demo title="Widen the loop counter" controls={<><Param spec={dSpec} value={d} onChange={(v) => setD(v as number)} /><Param spec={nSpec} value={n} onChange={(v) => setN(v as number)} /><Param spec={tSpec} value={t} onChange={(v) => setT(v as "int" | "unsigned")} /></>}>
      <Cols min={270} style={{ marginTop: 0 }}>
        <CodeView label="C source" lines={[`void fill(float *a, ${t} n, ${t} k) {`, `    for (${t} i = 0; i < n; i++)`, { text: "        a[i + k] = 0.0f;", mark: "fact", note: signed ? "i + k never overflows" : "i + k may wrap" }, "}", `fill(a, ${n}, ${signed ? "INT_MAX" : "UINT_MAX"} - ${d});`]} />
        <AsmView k={signed ? "fill.O2" : "fillu.O2"} hot={signed ? /memset/ : /mov\s+ecx, edx/} label="Real clang -O2 output (vectorizer off)" />
      </Cols>
      <Cols min={600}>
        <IndexCells ix={w} other={o} label="Indices as written (32-bit i + k)" />
        <IndexCells ix={o} other={w} label={signed ? "Indices that -O2 writes (one memset from a + k)" : "Indices that -O2 writes (same loop)"} />
      </Cols>
      <Banner tone={r.ub ? "bad" : wraps ? "warn" : "good"}>
        {r.ub
          ? `UB: i + k passes INT_MAX. As written, the index wraps to −2,147,483,648, about 8 GiB before a. The memset writes past a + 4·INT_MAX instead. ${differ ? "The two builds write different memory." : ""}`
          : signed
            ? "No overflow, so the indices are k, k + 1, … in every build. clang proves this and emits one memset."
            : wraps
              ? "Unsigned i + k wraps to 0. That is defined, so -O2 must write these exact indices. It cannot use one memset, and it zero-extends i + k in every iteration."
              : "No wrap for these inputs, but clang cannot know that, so it still keeps the 32-bit loop."}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- the deleted check, step by step

export function UbCheckStepDemo() {
  return <OptimizerView id="ub-check" title="Delete the overflow check" cases={["check"]} />;
}

// ---------------------------------------------------------------- four ways to write the check

const formSpec = select({ label: "Check", options: CHECK_FORMS.map((f) => ({ value: f.id, label: f.label })), default: "after" as string });
const inSpec = select({ label: "Inputs", options: ADD_INPUTS.map(([a, b], i) => ({ value: String(i), label: `a = ${a}, b = ${b}` })), default: "4" });

export function UbCheckFormsDemo() {
  const [form, setForm] = useState<CheckForm>("after");
  const [ii, setIi] = useState("4");
  const f = CHECK_FORMS.find((x) => x.id === form)!;
  const [a, b] = ADD_INPUTS[Number(ii)]!;
  const got = runCheck(form, a, b);
  const ovf = addOverflows(a, b);
  const right = ovf ? got === -1 : got === a + b;
  return (
    <Demo title="Write the check before the overflow" controls={<><Param spec={formSpec} value={form} onChange={(v) => setForm(v as CheckForm)} /><Param spec={inSpec} value={ii} onChange={(v) => setIi(v as string)} /></>}>
      <Cols min={270} style={{ marginTop: 0 }}>
        <CodeView label="int add(int a, int b)" lines={f.code.map((t, i) => (i === (form === "builtin" ? 1 : 0) ? { text: t, mark: f.kept ? ("fact" as const) : ("dead" as const) } : t))} />
        <AsmView k={f.asm} hot={/cmp|cmovno|seto|jo/} />
      </Cols>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))", gap: 8, marginTop: 8 }}>
        <OutBox title="exact a + b">{(a + b).toLocaleString("en-US")}{ovf ? " (does not fit)" : ""}</OutBox>
        <OutBox title="-O2 returns" tone={right ? "good" : "bad"}>{got.toLocaleString("en-US")}</OutBox>
      </div>
      <Banner tone={f.kept ? (right ? "good" : "warn") : ovf ? "bad" : "warn"}>
        {f.kept
          ? form === "unsigned"
            ? "Unsigned arithmetic wraps by definition, so the compare stays. The cast back to int is implementation-defined; GCC and Clang wrap."
            : form === "builtin"
              ? "The builtin computes the sum and the overflow flag in one add: seto or cmovno reads the flag. C23 ckd_add gives the same code."
              : "The test runs before the add, on values that cannot overflow, so the compare stays."
          : ovf
            ? "The check is gone: -O2 returns the wrapped sum. The overflow that the check was written for is the UB that let the compiler delete it."
            : "This input does not overflow, so the deleted check makes no difference here."}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- malloc(n * size)

const N_CHOICES: [number, string][] = [[4, "4"], [1000, "1000"], [2 ** 28 - 1, "2²⁸ − 1"], [2 ** 28, "2²⁸"], [2 ** 28 + 1, "2²⁸ + 1"], [2 ** 28 + 2, "2²⁸ + 2"], [2 ** 29 + 1, "2²⁹ + 1"]];
const nSpec2 = select({ label: "n (elements)", options: N_CHOICES.map(([n, label]) => ({ value: String(n), label })), default: String(2 ** 28 + 1) });
const sSpec = seg("sizeof(T)", [["8", "8"], ["16", "16"], ["24", "24"]], "16");
const mSpec = seg("Size computation", [["u32", "uint32_t n * size"], ["size_t", "size_t n * size"], ["checked", "checked multiply"]], "u32");

export function UbMallocDemo() {
  const [ns, setNs] = useState(String(2 ** 28 + 1));
  const [ss, setSs] = useState("16");
  const [mode, setMode] = useState<SizeMode>("u32");
  const n = Number(ns), size = Number(ss);
  const run = useMemo(() => runAllocFill(n, size, mode), [n, size, mode]);
  const p = planAlloc(n, size, mode);
  const big = p.requested !== null && p.requested > 1 << 20;
  return (
    <Demo title="malloc(n * size)" controls={<><Param spec={nSpec2} value={ns} onChange={(v) => setNs(v as string)} /><Param spec={sSpec} value={ss} onChange={(v) => setSs(v as string)} /><Param spec={mSpec} value={mode} onChange={(v) => setMode(v as SizeMode)} /></>}>
      <Cols min={270} style={{ marginTop: 0 }}>
        <CodeView label="C source" lines={
          mode === "checked"
            ? ["size_t bytes;", { text: "if (__builtin_mul_overflow(n, size, &bytes))", mark: "fact" }, "    return NULL;", "T *p = malloc(bytes);", "for (size_t i = 0; i < n; i++) p[i] = x;"]
            : [mode === "u32" ? "uint32_t bytes = n * size;" : "size_t bytes = n * size;", "T *p = malloc(bytes);", { text: "for (size_t i = 0; i < n; i++) p[i] = x;", mark: "fact", note: "writes n elements" }]
        } />
        <AsmView k={mode === "checked" ? "alloc_array_ok.O2" : "alloc_array.O2"} hot={/imul|mul|jno/} />
      </Cols>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))", gap: 8, marginTop: 8 }}>
        <OutBox title="exact n · size">{p.exact.toLocaleString("en-US")} B</OutBox>
        <OutBox title="malloc gets" tone={p.wrapped ? "bad" : p.requested === null ? "good" : "plain"}>{p.requested === null ? "nothing: returns NULL" : `${p.requested.toLocaleString("en-US")} B`}</OutBox>
        <OutBox title="the loop needs">{fmtBytes(p.exact)}</OutBox>
      </div>
      {!big && p.requested !== null && (
        <>
          <SectionLabel>Heap after the first {run.written} element writes (model)</SectionLabel>
          <HeapBlocks blocks={run.snap.heap} edges={run.snap.edges} roots={false} />
          <div style={{ fontSize: 12.5, marginTop: 4, ...mono }}>session value: 0x{run.neighbour}</div>
        </>
      )}
      {run.ub ? <UbBanner event={run.ub} /> : (
        <Banner tone={p.requested === null ? "good" : big ? "warn" : "good"}>
          {p.requested === null
            ? "The checked multiply sees that the product does not fit and refuses. calloc and reallocarray do the same check inside."
            : big
              ? "The product fits, so it is exact. A real malloc either gives the memory or returns NULL; the model does not allocate gigabytes."
              : "The block is large enough for every element."}
        </Banner>
      )}
    </Demo>
  );
}
