/** Demos for the lesson on memory disambiguation. */
import { useMemo, useState } from "react";
import { Demo, IndexButtons, IndexSlider, MiniTable, Note, Param, SectionLabel, Stats, StepCaption, range, seg, useChunked } from "../../kit";
import { aliasLoopRun, aliasRun, MEM_DEPS, type MemDep } from "../../sims/arch/ooo";
import { LsqTables, OooTimeline } from "./ArchOooUi";

const POLICY: [MemDep, string][] = [["conservative", "Wait for all"], ["speculative", "Speculate"], ["store-sets", "Store sets"]];
const BUF = 0x1000;

/** Pick the slots of a store and a load: no conflict, forwarding, or a violation. */
export function OooAliasDemo() {
  const [ls, setLsRaw] = useState(1);
  const [ss, setSsRaw] = useState(2);
  const [slow, setSlowRaw] = useState<"slow" | "fast">("slow");
  const [pol, setPolRaw] = useState<MemDep>("speculative");
  const [k, setK] = useState<number | null>(null);
  const r = useMemo(() => aliasRun(ss, ls, slow === "slow", pol), [ss, ls, slow, pol]);
  const setLs = (v: number) => { setLsRaw(v); setK(null); };
  const setSs = (v: number) => { setSsRaw(v); setK(null); };
  const setSlow = (v: "slow" | "fast") => { setSlowRaw(v); setK(null); };
  const setPol = (v: MemDep) => { setPolRaw(v); setK(null); };
  const n = r.frames.length;
  const ld = r.uops.find((u) => u.cls === "load" && u.commit >= 0)!;
  const first = r.uops.find((u) => u.cls === "load")!;
  const c = Math.min(k ?? Math.max(first.issue, 0), n - 1);
  const f = r.frames[c]!;
  const viol = r.stats.violations > 0;
  const tone = viol ? "bad" : ld.fwd ? "good" : "info";
  const text = viol
    ? `The load ran in cycle ${first.issue} and read ${first.value} from memory. The store address arrived later and matched, so the core squashed the load and everything after it, and fetched again. The load finally got ${ld.value} in cycle ${ld.ready}.`
    : ld.fwd
      ? `The store and the load use the same address. The store has not committed, so the load takes the value ${ld.value} straight from the store queue (store-to-load forwarding), ready in cycle ${ld.ready}.`
      : ss === ls
        ? `Same address: the load waited for the store, then got ${ld.value} in cycle ${ld.ready}.`
        : `Different addresses. The load read ${ld.value} and was ready in cycle ${ld.ready}${pol === "conservative" && slow === "slow" ? ", after it waited for the store address" : ", long before the store address was known"}.`;
  const names = (a: number) => (a >= BUF && a < BUF + 32 ? `buf[${(a - BUF) / 4}]` : `0x${a.toString(16)}`);
  return (
    <Demo
      title="A store, a load, and two addresses"
      actions={<IndexButtons k={c} n={n} set={setK} />}
      controls={<>
        <Param spec={range({ label: "Load reads buf[i], i =", min: 0, max: 7, step: 1, default: 1 })} value={ls} onChange={(v) => setLs(v as number)} />
        <Param spec={range({ label: "Store writes buf[j], j =", min: 0, max: 7, step: 1, default: 2 })} value={ss} onChange={(v) => setSs(v as number)} />
        <Param spec={seg("Store address", [["slow", "From a divide"], ["fast", "Known at once"]], "slow")} value={slow} onChange={(v) => setSlow(v as "slow" | "fast")} />
        <Param spec={seg("Loads and unknown store addresses", POLICY, "speculative")} value={pol} onChange={(v) => setPol(v as MemDep)} />
        <IndexSlider k={c} n={n} set={setK} label="Cycle (queues below)" />
      </>}
    >
      <StepCaption tone={tone} label={viol ? "violation" : ld.fwd ? "forwarded" : "no conflict"}>{text}</StepCaption>
      <Stats items={[
        { label: "Load value ready in cycle", value: ld.ready },
        { label: "Program cycles", value: r.cycles },
        { label: "Violations", value: r.stats.violations },
        { label: "Exit code (value + 1)", value: r.exitCode ?? "-" },
      ]} />
      <SectionLabel>Load and store queues in cycle {f.cycle}</SectionLabel>
      <LsqTables frame={f} names={names} />
      <SectionLabel>Timeline</SectionLabel>
      <OooTimeline uops={r.uops} cursor={f.cycle} maxRows={30} />
      <Note>The divide takes 20 cycles, a load 4 (model inputs). With a fast address, the store still waits for the older divide to commit, so its data sits in the store queue.</Note>
    </Demo>
  );
}

const PATTERNS: [string, string][] = [["0", "Never"], ["8", "Every 8th"], ["1", "Every time"]];

/** The aliasing loop under the three policies. */
export function OooAliasLoopDemo() {
  const [every, setEvery] = useState("8");
  const jobs = useMemo(() => PATTERNS.flatMap(([e]) => MEM_DEPS.map((m) => () => { const r = aliasLoopRun(Number(e), m); return { cycles: r.cycles, viol: r.stats.violations, fwd: r.stats.forwards }; })), []);
  const res = useChunked("alias-loop", jobs);
  const row = PATTERNS.findIndex(([e]) => e === every);
  return (
    <Demo title="Wait, guess, or learn" controls={<Param spec={seg("out[i] points at g", PATTERNS, "8")} value={every} onChange={(v) => setEvery(v as string)} />}>
      <MiniTable
        head={["Policy", "Cycles", "Violations", "Forwarded loads"]}
        rows={MEM_DEPS.map((_, j) => {
          const q = res[row * 3 + j];
          return [POLICY[j]![1], q ? q.cycles : "…", q ? q.viol : "…", q ? q.fwd : "…"];
        })}
      />
      <SectionLabel>All patterns: cycles</SectionLabel>
      <MiniTable
        head={["out[i] points at g", ...POLICY.map((p) => p[1])]}
        highlight={row}
        rows={PATTERNS.map(([, l], i) => [l, ...MEM_DEPS.map((_, j) => res[i * 3 + j]?.cycles ?? "…")])}
      />
      <Note>24 iterations of: p = out[i]; *p = i; sum += *g. The store address comes from a load, so it is late; the address of g is known at once. Width 4, ROB 64 (model inputs).</Note>
    </Demo>
  );
}
