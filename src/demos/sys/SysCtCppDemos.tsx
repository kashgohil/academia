/** Demos for "C++ templates and constexpr": instantiation in two translation units and the link, and the constexpr budget. */
import { useMemo, useState } from "react";
import { Banner, Chip, Btn, ButtonRow, Demo, Meter, MiniTable, Param, SectionLabel, Stats, int, mono, range, seg, si, tint, toggle } from "../../kit";
import {
  CALL_SITES, MEASURED_MAX, SYMS, cost, fibCalls, fibTree, instantiate,
  type BudgetFn, type Evaluator, type SymId,
} from "../../sims/sys/comptime";
import { CodeLines, Cols, CompilerMessage } from "./SysCtUi";

const hex = (n: number) => n.toString(16).padStart(16, "0");

export function CppInstDemo() {
  const [on, setOn] = useState<string[]>(["a1", "a5", "b1", "b2"]);
  const [externInB, setExtern] = useState(false);
  const [explicitInA, setExplicit] = useState(false);
  const r = useMemo(() => instantiate({ on, externInB, explicitInA }), [on, externInB, explicitInA]);
  const flip = (id: string) => setOn((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const dup = (s: SymId) => r.tus.filter((t) => t.defined.includes(s)).length > 1;
  return (
    <Demo
      title="Which instances does each file create, and what does the linker keep?"
      controls={<>
        <Param spec={toggle({ label: "b.cpp: extern template int max_of<int>(int, int);", default: false })} value={externInB} onChange={(v) => setExtern(v as boolean)} />
        <Param spec={toggle({ label: "a.cpp: template int max_of<int>(int, int);", default: false })} value={explicitInA} onChange={(v) => setExplicit(v as boolean)} />
      </>}
    >
      <Stats items={[
        { label: "Instances compiled", value: r.compiled },
        { label: "Kept after the link", value: r.kept.length },
        { label: "Copies dropped", value: `${r.dropped} (${r.droppedBytes} B)` },
      ]} />
      <Cols>
        {r.tus.map((t) => (
          <div key={t.tu} style={{ minWidth: 0 }}>
            <SectionLabel style={{ marginTop: 0 }}>{t.tu}.cpp: click a call to add or remove it</SectionLabel>
            <div style={{ display: "grid", gap: 4 }}>
              {CALL_SITES.filter((c) => c.tu === t.tu).map((c) => {
                const active = on.includes(c.id);
                return (
                  <button key={c.id} className="btn ghost" onClick={() => flip(c.id)} title={c.note}
                    style={{ textAlign: "left", justifyContent: "flex-start", fontSize: 12, padding: "3px 8px", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", ...mono, opacity: active ? 1 : 0.45, boxShadow: active ? `inset 3px 0 0 ${c.error ? "var(--c4)" : "var(--c1)"}` : undefined }}>
                    {active ? "✓ " : "  "}{c.code}
                  </button>
                );
              })}
            </div>
            {t.errors.map((e, i) => <CompilerMessage key={i} lines={e} label="clang 21: this file does not compile" />)}
            <SectionLabel>{t.tu}.o: template symbols (nm -S, x86-64 ELF, -O0)</SectionLabel>
            <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 11.5, lineHeight: "18px", ...mono, minHeight: 40 }}>
              {t.defined.length + t.undefinedRefs.length === 0 && <span className="muted">none</span>}
              {t.defined.map((s) => (
                <div key={s} style={{ whiteSpace: "pre", color: dup(s) ? "var(--c2)" : "var(--fg)" }} title={SYMS[s]!.demangled}>
                  {`${hex(SYMS[s]!.bytes)} W ${SYMS[s]!.name}`}
                </div>
              ))}
              {t.undefinedRefs.map((s) => <div key={s} style={{ whiteSpace: "pre", color: "var(--c5)" }}>{`                 U ${SYMS[s]!.name}`}</div>)}
            </div>
          </div>
        ))}
      </Cols>
      <SectionLabel>The link: one copy of each name</SectionLabel>
      {r.linkError
        ? <CompilerMessage lines={r.linkError} label="the link fails" />
        : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {r.kept.length === 0 && <span className="muted" style={{ fontSize: 12 }}>no template code</span>}
            {r.kept.map((s) => <Chip key={s} color={dup(s) ? "var(--c2)" : "var(--c1)"} title={SYMS[s]!.name}>{SYMS[s]!.demangled}</Chip>)}
          </div>
        )}
      <Banner tone={r.linkError ? "bad" : r.dropped ? "warn" : "good"}>
        {r.tus.some((t) => t.errors.length)
          ? "A failed deduction is a compile error, so this file makes no object file. Remove the call, or write max_of<double>(x, 2.5)."
          : r.linkError
          ? "b.cpp promised that another file instantiates max_of<int>, but no file does. Turn on the explicit instantiation in a.cpp, or a1."
          : r.dropped
            ? `${r.dropped} instance(s) were compiled in both files (orange). Each copy is a weak symbol in its own COMDAT group, so the linker keeps one and drops the other. The compile time is spent twice.`
            : "Each instance is compiled once. Hover a call for what the compiler deduces."}
      </Banner>
    </Demo>
  );
}

const FN_CODE: Record<BudgetFn, Record<Evaluator, string[]>> = {
  sumTo: {
    clang: ["constexpr long sum_to(long n) {", "  long s = 0;", "  for (long i = 0; i < n; ++i) s += i;", "  return s;", "}", "constexpr long v = sum_to(N);"],
    zig: ["fn sumTo(n: u64) u64 {", "    var s: u64 = 0;", "    var i: u64 = 0;", "    while (i < n) : (i += 1) s += i;", "    return s;", "}", "fn use() u64 {", "    return comptime sumTo(N); // one call per body", "}"],
  },
  fibLoop: {
    clang: ["constexpr unsigned long fib_loop(unsigned long n) {", "  unsigned long a = 0, b = 1;", "  for (unsigned long i = 0; i < n; ++i) {", "    unsigned long t = a + b;", "    a = b;", "    b = t;", "  }", "  return a;", "}", "constexpr unsigned long v = fib_loop(N);"],
    zig: ["fn fibLoop(n: u64) u64 {", "    var a: u64 = 0;", "    var b: u64 = 1;", "    var i: u64 = 0;", "    while (i < n) : (i += 1) {", "        const t = a +% b;", "        a = b;", "        b = t;", "    }", "    return a;", "}", "fn use() u64 {", "    return comptime fibLoop(N);", "}"],
  },
  fib: {
    clang: ["constexpr long fib(long n) {", "  return n < 2 ? n : fib(n - 1) + fib(n - 2);", "}", "constexpr long v = fib(N);"],
    zig: ["fn fib(n: u64) u64 {", "    if (n < 2) return n;", "    return fib(n - 1) + fib(n - 2);", "}", "fn use() u64 {", "    return comptime fib(N);", "}"],
  },
};
const UNIT: Record<Evaluator, string> = { clang: "steps", zig: "branches" };

function FibTreeView({ n }: { n: number }) {
  const nodes = useMemo(() => fibTree(n), [n]);
  const leaves = Math.max(1, ...nodes.map((x) => x.x)) + 1;
  const depth = Math.max(...nodes.map((x) => x.y)) + 1;
  const W = Math.max(300, leaves * 22), H = depth * 30 + 10;
  const px = (x: number) => 12 + (x / Math.max(1, leaves - 1)) * (W - 24);
  const py = (y: number) => 14 + y * 30;
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <svg width={W} height={H} style={{ display: "block" }}>
        {nodes.map((d, i) => d.parent >= 0 && <line key={`l${i}`} x1={px(nodes[d.parent]!.x)} y1={py(nodes[d.parent]!.y)} x2={px(d.x)} y2={py(d.y)} stroke="var(--border)" />)}
        {nodes.map((d, i) => (
          <g key={i}>
            <circle cx={px(d.x)} cy={py(d.y)} r={9} fill={d.n < 2 ? tint("var(--c3)", 40) : tint("var(--c1)", 30)} stroke={d.n < 2 ? "var(--c3)" : "var(--c1)"} />
            <text x={px(d.x)} y={py(d.y) + 4} textAnchor="middle" fontSize={10} fill="var(--fg)" style={{ fontFamily: "ui-monospace, monospace" }}>{d.n}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function ConstBudgetDemo() {
  const [fn, setFn] = useState<BudgetFn>("fib");
  const [ev, setEv] = useState<Evaluator>("clang");
  const [ns, setNs] = useState<Record<BudgetFn, number>>({ sumTo: 1000, fibLoop: 1000, fib: 6 });
  const n = ns[fn];
  const spec = fn === "fib"
    ? range({ label: "N", min: 1, max: 40, step: 1, default: 6 })
    : range({ label: "N", min: 10, max: 2_000_000, step: 1, default: 1000, log: true });
  const c = cost(fn, n, ev);
  const code = FN_CODE[fn][ev];
  const calls = fn === "fib" ? fibCalls(n) : 1;
  return (
    <Demo
      title="The constant evaluator runs on a budget"
      controls={<>
        <Param spec={spec} value={n} onChange={(v) => setNs((s) => ({ ...s, [fn]: v as number }))} />
        <Param spec={seg("Function", [["sumTo", "sum loop"], ["fibLoop", "fib, loop"], ["fib", "fib, recursive"]], "fib")} value={fn} onChange={(v) => setFn(v as BudgetFn)} />
        <Param spec={seg("Evaluator", [["clang", "clang 21 constexpr"], ["zig", "zig 0.17.1 comptime"]], "clang")} value={ev} onChange={(v) => setEv(v as Evaluator)} />
      </>}
    >
      <Stats items={[
        { label: `Work, in ${UNIT[ev]} (model)`, value: si(c.work) },
        { label: "Limit", value: si(c.limit) },
        { label: "Calls", value: si(calls) },
        { label: "Deepest call chain", value: c.depth },
      ]} />
      <Meter label={`${UNIT[ev]} used, log scale`} value={c.work} max={c.limit} color={c.ok ? "var(--c1)" : "var(--c4)"} text={`${si(c.work)} / ${si(c.limit)}`} log />
      {ev === "clang" && <Meter label="call depth" value={c.depth} max={c.depthLimit} color={c.depth > c.depthLimit ? "var(--c4)" : "var(--c5)"} text={`${c.depth} / ${c.depthLimit}`} />}
      <Cols>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>{ev === "clang" ? "C++20, compiled with clang 21" : "Zig 0.17.1"}</SectionLabel>
          <CodeLines lines={code.map((t) => ({ text: t.replace(/\bN\b/, String(n)) }))} maxHeight={220} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>{fn === "fib" ? "The call tree" : "Largest N that compiles (measured)"}</SectionLabel>
          {fn === "fib"
            ? n <= 8 ? <FibTreeView n={n} /> : <div className="muted" style={{ fontSize: 12.5 }}>{si(calls)} calls: too many to draw. Each call below N = 9 makes two more, so the tree doubles about every level.</div>
            : null}
          {fn !== "fib" || n > 8 ? (
            <div style={{ marginTop: fn === "fib" ? 8 : 0 }}>
              <MiniTable
                head={["function", "clang 21", "zig 0.17.1"]}
                rows={(["sumTo", "fibLoop", "fib"] as BudgetFn[]).map((f) => [f, int(MEASURED_MAX[f].clang), int(MEASURED_MAX[f].zig)])}
                highlight={(["sumTo", "fibLoop", "fib"] as BudgetFn[]).indexOf(fn)}
              />
            </div>
          ) : null}
        </div>
      </Cols>
      {c.ok
        ? <CompilerMessage ok lines={[`compiles: ${si(c.work)} ${UNIT[ev]} of ${si(c.limit)}`]} />
        : <CompilerMessage lines={ev === "clang" ? ["error: constexpr variable 'v' must be initialized by a constant expression", `note: ${c.message}`] : [`error: ${c.message}`, "note: use @setEvalBranchQuota() to raise the branch limit from 1000"]} label={ev === "clang" ? "clang 21 prints" : "zig 0.17.1 prints"} />}
      <ButtonRow style={{ marginTop: 8 }}>
        <Btn ghost onClick={() => setNs((s) => ({ ...s, [fn]: MEASURED_MAX[fn][ev] }))}>Set N to the largest that fits</Btn>
        <Btn ghost onClick={() => setNs((s) => ({ ...s, [fn]: MEASURED_MAX[fn][ev] + 1 }))}>One more</Btn>
      </ButtonRow>
    </Demo>
  );
}
