/**
 * Demos for the branch prediction lesson: be the predictor (bimodal, local, gshare on one branch, step by step); a
 * shoot-out of six predictors on RISC-V workloads at a storage budget; and a return-address stack on recursive code.
 */
import { useMemo, useState } from "react";
import {
  Chip, Demo, IndexButtons, IndexSlider, Legend, Line, MiniTable, Note, Param, Plot, RuleX, SectionLabel, Stats, StepCaption,
  bytes, fixed, int, mono, pct, range, seg, select, tint, useChunked, useParams,
} from "../../kit";
import {
  BP_IDS, BP_LABEL, BUDGET_LOG2, PATTERNS, WORKLOADS, bimodal, branchEvents, fibSource, gshare, local, makeBP, patternEvents,
  returnPredict, runSource, score, steps, tableAfter, workloadById, workloadTrace, type BP, type BPId,
} from "../../sims/arch/pipelining";

// ---------------------------------------------------------------- be the predictor

type Simple = "bimodal" | "local" | "gshare";
const MAKE: Record<Simple, () => BP> = { bimodal: () => bimodal(4), local: () => local(16, 4), gshare: () => gshare(4, 4) };
const N_STEPS = 48;
const CTR_NAME = ["strong N", "weak N", "weak T", "strong T"];
const bitsOf = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >> (n - 1 - i)) & 1);

export function ArchPipePredictorStepper() {
  const [k, setK] = useState(0);
  const p = useParams("bpstep", {
    pat: select({ label: "Branch pattern", options: PATTERNS.map((x) => ({ value: x.id, label: x.label })), default: "loop4" }),
    bp: seg<Simple>("Predictor (16 counters)", [["bimodal", "Bimodal"], ["local", "Local history"], ["gshare", "gshare"]], "bimodal"),
  });
  const pat = PATTERNS.find((x) => x.id === p.values.pat)!;
  const ev = useMemo(() => patternEvents(pat.bits, N_STEPS), [pat]);
  const st = useMemo(() => steps(MAKE[p.values.bp], ev), [p.values.bp, ev]);
  const i = Math.min(k, N_STEPS - 1);
  const table = useMemo(() => tableAfter(MAKE[p.values.bp], ev, i), [p.values.bp, ev, i]);
  const s = st[i]!;
  const misses = st.slice(0, i + 1).filter((x) => x.pred !== x.taken).length;
  const late = st.slice(Math.max(0, i - 15), i + 1);
  const lateMiss = late.filter((x) => x.pred !== x.taken).length;
  const how = p.values.bp === "bimodal"
    ? `Index = low 4 bits of pc ÷ 4 = ${s.look.index}. One counter serves this branch, whatever happened before.`
    : p.values.bp === "local"
      ? `This branch's own last 4 outcomes are ${bitsOf(s.look.hist, 4).map((b) => (b ? "T" : "N")).join("")} (oldest first). They select counter ${s.look.index}.`
      : `Global history ${bitsOf(s.look.hist, 4).join("")} XOR pc bits ${bitsOf((s.pc >>> 2) & 15, 4).join("")} = counter ${s.look.index}.`;
  return (
    <Demo
      title="Be the predictor: one branch, 16 counters"
      actions={<IndexButtons k={i} n={N_STEPS} set={setK} />}
      controls={<>
        <IndexSlider k={i} n={N_STEPS} set={setK} label="Branch" />
        <Param spec={p.schema.pat} value={p.values.pat} onChange={(v) => { p.set("pat", v as string); setK(0); }} />
        <Param spec={p.schema.bp} value={p.values.bp} onChange={(v) => { p.set("bp", v as Simple); setK(0); }} />
      </>}
    >
      <StepCaption tone={s.pred === s.taken ? "good" : "bad"} label={`branch ${i + 1}`}>
        {how} The counter says {CTR_NAME[s.look.counter]}, so the prediction is {s.pred ? "taken" : "not taken"}. The branch is {s.taken ? "taken" : "not taken"}: {s.pred === s.taken ? "correct" : "a mispredict"}.
      </StepCaption>
      <SectionLabel>Outcomes so far (red: mispredicted)</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {st.slice(0, i + 1).map((x, j) => (
          <Chip key={j} color={x.pred === x.taken ? "var(--c3)" : "var(--c4)"} filled={j === i}>{x.taken ? "T" : "N"}</Chip>
        ))}
      </div>
      <SectionLabel>Counter table before the update (0–1 predict not taken, 2–3 predict taken)</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 3, maxWidth: 420 }}>
        {Array.from(table).map((c, j) => (
          <div key={j} style={{
            ...mono, fontSize: 11.5, textAlign: "center", padding: "3px 0", borderRadius: 4,
            background: tint(c >= 2 ? "var(--c3)" : "var(--c4)", 12 + Math.abs(c - 1.5) * 22),
            outline: j === s.look.index ? "2px solid var(--fg)" : undefined, outlineOffset: -2,
          }}>
            <div className="muted" style={{ fontSize: 9.5 }}>{j}</div>{c}
          </div>
        ))}
      </div>
      <Stats items={[
        { label: "mispredicts so far", value: `${misses} of ${i + 1}` },
        { label: "in the last 16 branches", value: `${lateMiss} of ${late.length}` },
        { label: "counters used", value: String(new Set(st.slice(0, i + 1).map((x) => x.look.index)).size) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- shoot-out

const ALL: BPId[] = ["static", ...BP_IDS];
const COLOR: Record<BPId, string> = {
  static: "var(--faint)", bimodal: "var(--muted)", local: "var(--c2)", gshare: "var(--c1)", tournament: "var(--c5)", perceptron: "var(--c4)", tage: "var(--c3)",
};
/** 13 → "¹³", for text that cannot render math. */
const sup = (v: number) => String(v).split("").map((d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]).join("");
const BUDGETS = Array.from({ length: BUDGET_LOG2.max - BUDGET_LOG2.min + 1 }, (_, i) => BUDGET_LOG2.min + i);

export function ArchPipeShootoutDemo() {
  const p = useParams("bpshoot", {
    k: range({ label: "Storage budget", min: BUDGET_LOG2.min, max: BUDGET_LOG2.max, step: 1, default: BUDGET_LOG2.default, format: (v) => `2${sup(v)} bits = ${bytes(2 ** v / 8)}` }),
    w: select({ label: "Workload (a RISC-V program run on the hart)", options: WORKLOADS.map((x) => ({ value: x.id, label: x.title })), default: "many" }),
  });
  const { k, w } = p.values;
  const jobs = useMemo(() => ALL.flatMap((id) => BUDGETS.map((b) => () => {
    const t = workloadTrace(w), bp = makeBP(id, b);
    return { id, b, ...score(bp, branchEvents(t)), insts: t.length, bits: bp.bits, shape: bp.shape };
  })), [w]);
  const res = useChunked(`shoot:${w}`, jobs, { keep: true });
  const at = (id: BPId, b: number) => res[ALL.indexOf(id) * BUDGETS.length + (b - BUDGET_LOG2.min)];
  const ready = res.filter(Boolean).length;
  const rows = ALL.map((id) => {
    const r = at(id, k);
    return [BP_LABEL[id], r ? pct(r.rate) : "…", r ? fixed((r.misses / r.insts) * 1000, 1) : "…", r ? (id === "static" ? "0" : int(r.bits)) : "…"];
  });
  const best = ALL.map((id) => [id, at(id, k)?.rate ?? 1] as const).sort((a, b) => a[1] - b[1])[0]!;
  return (
    <Demo
      title="Six predictors, one storage budget"
      controls={<>
        <Param spec={p.schema.k} value={k} onChange={(v) => p.set("k", v as number)} />
        <Param spec={p.schema.w} value={w} onChange={(v) => p.set("w", v as string)} />
      </>}
    >
      <Note>{workloadById(w).about}</Note>
      <MiniTable head={["predictor", "mispredicted", "per 1000 instr.", "storage, bits"]} rows={rows} highlight={ALL.indexOf(best[0])} />
      <SectionLabel>Mispredict rate against budget{ready < jobs.length ? ` (running ${ready} of ${jobs.length})` : ""}</SectionLabel>
      <Plot x={[BUDGET_LOG2.min, BUDGET_LOG2.max]} y={[0, 0.45]} height={230} xLabel="budget, log₂ bits" yLabel="mispredicted" yFormat={(v) => pct(v, 0)}>
        <RuleX at={k} />
        {ALL.map((id) => (
          <Line key={id} color={COLOR[id]} dash={id === "static" ? "4 3" : undefined}
            points={BUDGETS.flatMap((b) => { const r = at(id, b); return r ? [[b, Math.min(0.45, r.rate)] as const] : []; })} />
        ))}
      </Plot>
      <Legend items={ALL.map((id) => ({ label: BP_LABEL[id], color: COLOR[id] }))} />
      <Note>Table sizes and history lengths for each budget are model inputs. At 2¹⁵ bits the tournament predictor has the Alpha 21264's tables. No warm-up is skipped, so cold misses count.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- return-address stack

export function ArchPipeRasDemo() {
  const p = useParams("bpras", {
    depth: range({ label: "Return-address stack entries", min: 0, max: 16, step: 1, default: 4 }),
    n: range({ label: "fib(n), n =", min: 3, max: 12, step: 1, default: 8 }),
  });
  const [k, setK] = useState(0);
  const run = useMemo(() => runSource(fibSource(p.values.n)), [p.values.n]);
  const r = useMemo(() => returnPredict(run.trace, p.values.depth), [run, p.values.depth]);
  const names = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of r.steps) if (s.kind === "call" && !m.has(s.addr)) m.set(s.addr, ["_start", "site A", "site B"][m.size] ?? "?");
    return m;
  }, [r]);
  const nm = (a: number | null) => (a === null ? "nothing" : names.get(a) ?? `0x${a.toString(16)}`);
  const i = Math.min(k, r.steps.length - 1);
  const s = r.steps[i]!;
  const cap = s.kind === "call"
    ? `Call: push the return address (back to ${nm(s.addr)}).${s.dropped ? " The stack was full, so the oldest entry fell off the bottom." : ""}`
    : `Return to ${nm(s.addr)}. The stack predicts ${nm(s.ras)} (${s.ras === s.addr ? "correct" : "wrong"}); a BTB alone predicts ${nm(s.btb)} (${s.btb === s.addr ? "correct" : "wrong"}).`;
  return (
    <Demo
      title="Returns: a BTB alone against a return-address stack"
      actions={<IndexButtons k={i} n={r.steps.length} set={setK} />}
      controls={<>
        <Param spec={p.schema.depth} value={p.values.depth} onChange={(v) => p.set("depth", v as number)} />
        <Param spec={p.schema.n} value={p.values.n} onChange={(v) => { p.set("n", v as number); setK(0); }} />
        <IndexSlider k={i} n={r.steps.length} set={setK} label="Call or return" />
      </>}
    >
      <StepCaption tone={s.kind === "call" ? "info" : s.ras === s.addr ? "good" : "bad"} label={s.kind}>{cap}</StepCaption>
      <Stats items={[
        { label: "calls", value: String(r.calls) },
        { label: "deepest call chain", value: String(r.maxDepth) },
        { label: "returns mispredicted, stack", value: `${r.rasMisses} of ${r.returns}` },
        { label: "returns mispredicted, BTB alone", value: `${r.btbMisses} of ${r.returns}` },
      ]} />
      <SectionLabel>Stack after this step (top first, {p.values.depth} entries)</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 20 }}>
        {s.stack.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
        {s.stack.slice().reverse().map((a, j) => (
          <Chip key={j} color={j === 0 ? "var(--c1)" : "var(--muted)"} filled={j === 0}>{nm(a)}</Chip>
        ))}
      </div>
      <SectionLabel>Every depth on this run</SectionLabel>
      <MiniTable
        head={["stack entries", "0", "2", "4", "8", "16"]}
        rows={[["returns mispredicted", ...[0, 2, 4, 8, 16].map((d) => String(returnPredict(run.trace, d, false).rasMisses))]]}
      />
      <Note>The program is recursive fib(n), run on the hart. It calls fib from two places, so a return goes to site A or site B. A call is a jal or jalr that writes ra; a return is a jalr that reads ra and writes x0, as in the RISC-V hint table.</Note>
    </Demo>
  );
}
