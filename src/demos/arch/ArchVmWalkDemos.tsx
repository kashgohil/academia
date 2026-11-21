/** Demos for the lesson on the hardware page walker: the Sv39 state machine, and page-walk caches. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Legend, Line, MONO, Note, Param, Plot, RuleX, SectionLabel, Stats, bytes, fixed, pct, range, seg, tint, toggle, useChunked, useParams } from "../../kit";
import {
  CAUSE_NAME, PTE, PTE_BITS, WALK_MODEL, has, sv39Scene, vpn, walkCycles, walkPoint, walkSv39, type Access, type PteBit, type StepKind, type TracePattern,
} from "../../sims/arch/vm";
import { BitStrip } from "./ArchVmUi";

const hexB = (v: bigint) => `0x${v.toString(16)}`;

const STATES: { kind: StepKind; label: string }[] = [
  { kind: "va-check", label: "Check VA" },
  { kind: "read", label: "Read PTE" },
  { kind: "pointer", label: "Pointer: next level" },
  { kind: "leaf", label: "Leaf" },
  { kind: "align", label: "Superpage aligned?" },
  { kind: "u-check", label: "U bit" },
  { kind: "rwx-check", label: "R W X" },
  { kind: "ad", label: "A and D" },
  { kind: "done", label: "Done" },
  { kind: "fault", label: "Page fault" },
];

export function ArchVmSv39WalkDemo() {
  const p = useParams("sv39", {
    access: seg<Access>("Access", [["load", "Load"], ["store", "Store"], ["fetch", "Fetch"]], "load"),
    priv: seg<"U" | "S">("Mode", [["U", "U-mode"], ["S", "S-mode"]], "U"),
    ad: seg<"svadu" | "svade">("A/D scheme", [["svadu", "Svadu: hardware sets"], ["svade", "Svade: fault"]], "svadu"),
    sum: toggle({ label: "sstatus.SUM", default: false }),
    mxr: toggle({ label: "sstatus.MXR", default: false }),
  });
  const [scene, setScene] = useState(() => sv39Scene());
  const [pick, setPick] = useState(0);
  const [shown, setShown] = useState(99);
  const sample = scene.samples[pick]!;
  const va = sample.va;
  // The walk runs on a copy, so that the view is stable; "Commit" keeps the A/D writes.
  const res = useMemo(() => walkSv39(scene.space.mem.clone(), scene.space.rootPpn, va, p.values.access, { priv: p.values.priv, sum: p.values.sum, mxr: p.values.mxr, ad: p.values.ad }), [scene, va, p.values]);
  const steps = res.steps.slice(0, Math.min(shown, res.steps.length));
  const last = steps[steps.length - 1];
  const finished = shown >= res.steps.length;
  const leafStep = res.steps.find((s) => s.kind === "leaf");
  const leafAddr = leafStep?.addr;
  const leafPte = leafAddr !== undefined ? scene.space.mem.peek(leafAddr) : undefined;
  const flip = (b: PteBit) => {
    if (leafAddr === undefined) return;
    const m = scene.space.mem;
    m.write(leafAddr, m.peek(leafAddr) ^ PTE[b]);
    setScene({ ...scene });
    setShown(99);
  };
  const commit = () => { walkSv39(scene.space.mem, scene.space.rootPpn, va, p.values.access, { priv: p.values.priv, sum: p.values.sum, mxr: p.values.mxr, ad: p.values.ad }); setScene({ ...scene }); };
  const fields = [
    { hi: 41, lo: 39, label: "sign", color: "var(--faint)" },
    { hi: 38, lo: 30, label: "VPN[2]", color: "var(--c1)", value: String(vpn(va, 2)) },
    { hi: 29, lo: 21, label: "VPN[1]", color: "var(--c3)", value: String(vpn(va, 1)) },
    { hi: 20, lo: 12, label: "VPN[0]", color: "var(--c5)", value: String(vpn(va, 0)) },
    { hi: 11, lo: 0, label: "offset", color: "var(--c2)", value: `0x${(va & 0xfffn).toString(16)}` },
  ];
  const visited = new Set(steps.map((s) => s.kind));
  return (
    <Demo
      title="The Sv39 walker, one state at a time"
      actions={<>
        <Btn onClick={() => setShown(Math.max(1, Math.min(shown, res.steps.length) - 1))} disabled={Math.min(shown, res.steps.length) <= 1}>Back</Btn>
        <Btn onClick={() => setShown(Math.min(shown, res.steps.length) + 1)} disabled={finished}>Step</Btn>
        <Btn onClick={() => setShown(99)} disabled={finished}>All</Btn>
        <Btn ghost onClick={() => { setScene(sv39Scene()); setShown(99); }}>Reset tables</Btn>
      </>}
      controls={<>
        <Param spec={p.schema.access} value={p.values.access} onChange={(v) => { p.set("access", v as Access); setShown(99); }} />
        <Param spec={p.schema.priv} value={p.values.priv} onChange={(v) => { p.set("priv", v as "U"); setShown(99); }} />
        <Param spec={p.schema.ad} value={p.values.ad} onChange={(v) => { p.set("ad", v as "svadu"); setShown(99); }} />
        <Param spec={p.schema.sum} value={p.values.sum} onChange={(v) => p.set("sum", v as boolean)} />
        <Param spec={p.schema.mxr} value={p.values.mxr} onChange={(v) => p.set("mxr", v as boolean)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        {scene.samples.map((s, i) => <Btn key={s.name} on={i === pick} ghost={i !== pick} onClick={() => { setPick(i); setShown(1); }}>{s.name}</Btn>)}
      </ButtonRow>
      <div style={{ fontFamily: MONO, fontSize: 12.5, marginBottom: 4, overflowWrap: "anywhere" }}>va = {hexB(va)}, satp.PPN = {hexB(scene.space.rootPpn)}</div>
      <BitStrip bits={va} hi={41} fields={fields} cell={14} />
      <SectionLabel>State machine</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {STATES.map((s) => {
          const on = last?.kind === s.kind;
          const bad = on && !last!.ok;
          return (
            <span key={s.kind} style={{ fontSize: 11.5, padding: "2px 7px", borderRadius: 10, border: `1.5px solid ${on ? (bad || s.kind === "fault" ? "var(--c4)" : "var(--fg)") : "var(--border)"}`, background: on ? tint(bad || s.kind === "fault" ? "var(--c4)" : "var(--c1)", 22) : visited.has(s.kind) ? "var(--subtle)" : undefined, color: visited.has(s.kind) || on ? "var(--fg)" : "var(--muted)" }}>{s.label}</span>
          );
        })}
      </div>
      <ol style={{ margin: "8px 0 0", paddingLeft: 22, fontSize: 12.5, display: "grid", gap: 3 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ color: s.ok ? "var(--fg)" : "var(--c4)" }}>
            <span className="muted" style={{ fontFamily: MONO, marginRight: 6 }}>{s.kind === "va-check" || s.kind === "fault" || s.kind === "done" ? "" : `i=${s.level}`}</span>
            {s.text}
            {s.pte !== undefined && s.kind === "read" && <span style={{ fontFamily: MONO, color: "var(--muted)" }}> pte = {hexB(s.pte)} [{PTE_BITS.filter((b) => has(s.pte!, b)).join(" ") || "no flags"}]</span>}
          </li>
        ))}
      </ol>
      <SectionLabel>Leaf PTE bits{leafPte !== undefined ? ": click to change one in memory" : ": the walk did not reach a leaf"}</SectionLabel>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {PTE_BITS.map((b) => {
          const on = leafPte !== undefined && has(leafPte, b);
          return <button key={b} disabled={leafPte === undefined} onClick={() => flip(b)} style={{ fontFamily: MONO, fontSize: 12, width: 30, padding: "2px 0", borderRadius: 4, border: `1px solid ${on ? "var(--fg)" : "var(--border)"}`, background: on ? "var(--fg)" : "transparent", color: on ? "var(--bg)" : "var(--muted)", cursor: leafPte === undefined ? "default" : "pointer" }}>{b}</button>;
        })}
      </div>
      <Banner ok={finished ? res.ok : undefined}>
        {!finished ? "Press Step to move the walker to its next state." : res.ok
          ? <>Physical address <b style={{ fontFamily: MONO }}>{hexB(res.pa!)}</b> after {res.reads} PTE read{res.reads === 1 ? "" : "s"}{res.writes ? ` and ${res.writes} atomic A/D write` : ""}. {res.writes ? <Btn ghost onClick={commit}>Keep the A/D write</Btn> : null}</>
          : <>{CAUSE_NAME[res.cause!]}: scause = {res.cause}, stval = <span style={{ fontFamily: MONO }}>{hexB(res.stval!)}</span>, after {res.reads} PTE read{res.reads === 1 ? "" : "s"}.</>}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- walk caches

const SIZES = Array.from({ length: 15 }, (_, i) => 2 ** (20 + i)); // 1 MiB .. 16 GiB
const LINES = [
  { pwc: 0, color: "var(--c4)", label: "no walk caches" },
  { pwc: -1, color: "var(--c1)", label: "walk caches, entries from the slider" },
] as const;

export function ArchVmWalkCacheDemo() {
  const p = useParams("pwc", {
    entries: range({ label: "Walk cache entries per level", min: 1, max: 128, step: 1, default: WALK_MODEL.pwcEntries, log: true, format: (v) => String(Math.round(v)) }),
    pattern: seg<TracePattern>("Accesses", [["random", "Random pages"], ["sparse", "1 page per 2 MiB"], ["sequential", "Sequential loop"]], "random"),
    levels: seg<"3" | "4" | "5">("Levels", [["3", "3: Sv39"], ["4", "4: Sv48, x86-64"], ["5", "5: Sv57, LA57"]], "4"),
    at: range({ label: "Working set", min: 20, max: 34, step: 1, default: 30, format: (v) => bytes(2 ** v) }),
  });
  const entries = Math.round(p.values.entries);
  const levels = Number(p.values.levels);
  const key = `${entries}:${p.values.pattern}:${levels}`;
  const jobs = useMemo(() => LINES.flatMap((l) => SIZES.map((b) => () => walkPoint(p.values.pattern, b, { levels, tlbEntries: WALK_MODEL.tlbEntries, pwcEntries: l.pwc < 0 ? entries : 0 }, 20_000))), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked(key, jobs, { keep: true });
  const curve = (i: number) => SIZES.map((b, k) => [b, res[i * SIZES.length + k]?.readsPerWalk ?? NaN] as const).filter((q) => Number.isFinite(q[1]));
  const at = 2 ** p.values.at;
  const atIdx = SIZES.indexOf(at);
  const withPwc = res[SIZES.length + atIdx];
  const without = res[atIdx];
  return (
    <Demo
      title="Memory reads per TLB miss"
      controls={<>
        <Param spec={p.schema.entries} value={p.values.entries} onChange={(v) => p.set("entries", v as number)} />
        <Param spec={p.schema.at} value={p.values.at} onChange={(v) => p.set("at", v as number)} />
        <Param spec={p.schema.pattern} value={p.values.pattern} onChange={(v) => p.set("pattern", v as TracePattern)} />
        <Param spec={p.schema.levels} value={p.values.levels} onChange={(v) => p.set("levels", v as "4")} />
      </>}
    >
      <Plot x={[SIZES[0]!, SIZES.at(-1)!]} y={[0, 5.4]} logX height={240} xLabel="working set" yLabel="PTE reads per walk" xFormat={(v) => bytes(v)} xTicks={[2 ** 20, 2 ** 24, 2 ** 28, 2 ** 32]} yTicks={[0, 1, 2, 3, 4, 5]}>
        <RuleX at={at} />
        {LINES.map((l, i) => <Line key={l.label} points={curve(i)} color={l.color} />)}
      </Plot>
      <Legend items={LINES.map((l) => ({ label: l.label, color: l.color }))} />
      <Stats items={[
        { label: "TLB miss rate", value: without ? pct(without.missRate) : "…" },
        { label: "reads per walk, no walk caches", value: without ? fixed(without.readsPerWalk) : "…" },
        { label: "reads per walk, with walk caches", value: withPwc ? fixed(withPwc.readsPerWalk) : "…" },
        { label: "cycles per miss with them (model)", value: withPwc ? fixed(walkCycles(withPwc.readsPerWalk), 0) : "…" },
      ]} />
      <Note>Model inputs: a fully associative TLB of {WALK_MODEL.tlbEntries.toLocaleString("en-US")} entries in front, one LRU walk cache per non-leaf level, and {WALK_MODEL.pteReadCycles} cycles for each PTE read. Real walk caches differ in size and layout from core to core.</Note>
    </Demo>
  );
}
