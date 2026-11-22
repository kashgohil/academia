/** Demos for "Temporary allocators": the scratch-arena conflict, and a cost model for malloc against an arena. */
import { useMemo } from "react";
import { Banner, ButtonRow, Demo, Legend, Line, Param, Plot, RuleX, SectionLabel, StepButtons, StepCaption, StepSlider, Stats, Dots, mono, range, seg, tint, toggle, useParams, useStepper, fixed, pct } from "../../kit";
import { ARENA_BYTES, COST, SCRATCH_SOURCE, arenaCost, breakEven, mallocCost, runScratch, type ArenaView } from "../../sims/sys/explicit";
import { Code } from "./SysExpUi";

const LABEL_COLOR: Record<string, string> = { up: "var(--c5)", r: "var(--c1)", q: "var(--c2)" };

function ArenaBytes({ a, p }: { a: ArenaView; p?: { arena: string; from: number; len: number } }) {
  const CELL = 14;
  const pin = p && p.arena === a.name;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="muted" style={{ fontSize: 12, ...mono, marginBottom: 2 }}>arena {a.name} · pos {a.pos}{a.marks.length ? ` · saved marks: ${a.marks.join(", ")}` : ""}</div>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <div style={{ width: ARENA_BYTES * CELL, position: "relative", paddingBottom: pin ? 16 : 4 }}>
          <div style={{ display: "flex" }}>
            {a.bytes.map((b, i) => {
              const own = a.owners.find((o) => i >= o.from && i < o.to);
              const poisoned = a.poisonFrom !== null && i >= a.poisonFrom;
              const ch = a.init[i] ? String.fromCharCode(b) : "";
              return (
                <div key={i} style={{
                  width: CELL, height: 24, flex: "none", textAlign: "center", lineHeight: "24px", fontSize: 11.5, ...mono,
                  borderRight: "1px solid var(--border)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
                  borderLeft: i === 0 ? "1px solid var(--border)" : undefined,
                  background: own ? tint(LABEL_COLOR[own.label] ?? "var(--fg)", 35) : poisoned ? tint("var(--c4)", 14) : undefined,
                  color: own ? "var(--fg)" : "var(--muted)",
                  boxShadow: i === a.pos ? "inset 2px 0 0 var(--fg)" : undefined,
                }}>{ch}</div>
              );
            })}
          </div>
          {pin && (
            <div style={{ position: "absolute", left: p!.from * CELL, width: p!.len * CELL, top: 26, height: 10, borderLeft: "2px solid var(--c4)", borderRight: "2px solid var(--c4)", borderBottom: "2px solid var(--c4)" }}>
              <span style={{ position: "absolute", left: 4, top: -1, fontSize: 10, color: "var(--c4)", ...mono, whiteSpace: "nowrap", lineHeight: "10px" }}> p</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const SC = {
  arenas: seg<"1" | "2">("Scratch arenas per thread", [["1", "one"], ["2", "two"]], "1"),
  poison: toggle({ label: "Poison bytes on scratch_end (ASan)", default: false }),
};

export function ScratchConflictDemo() {
  const P = useParams("sys-exp-scratch", SC);
  const arenas = P.values.arenas === "2" ? 2 : 1;
  const steps = useMemo(() => runScratch({ arenas, poison: P.values.poison }), [arenas, P.values.poison]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[s.i]!;
  return (
    <Demo
      title="A result in its own scratch arena"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={SC.arenas} value={P.values.arenas} onChange={(v) => { P.set("arenas", v as "1" | "2"); s.reset(); }} />
        <Param spec={SC.poison} value={P.values.poison} onChange={(v) => { P.set("poison", v as boolean); s.reset(); }} />
      </>}
    >
      <Code lines={SCRATCH_SOURCE} current={cur.line} />
      <SectionLabel>Arena bytes (the bar is pos; colored bytes belong to a live allocation)</SectionLabel>
      {cur.arenas.map((a) => <ArenaBytes key={a.name} a={a} p={cur.p} />)}
      <div className="muted" style={{ fontSize: 11.5, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <span><b style={{ color: "var(--c5)" }}>■</b> up (temporary)</span><span><b style={{ color: "var(--c1)" }}>■</b> r (result)</span><span><b style={{ color: "var(--c2)" }}>■</b> q</span>
        {P.values.poison && <span><b style={{ color: "var(--c4)" }}>■</b> poisoned</span>}
      </div>
      {cur.p && <div style={{ ...mono, fontSize: 12.5, marginTop: 6 }}>p reads: "{cur.p.text}"</div>}
      <StepCaption label={`line ${cur.line}`} tone={cur.report ? "bad" : cur.bad ? "warn" : null}>{cur.caption}</StepCaption>
      {cur.report && <Banner tone="bad"><div style={{ ...mono, fontSize: 12.5, whiteSpace: "pre-wrap", color: "var(--c4)" }}>{cur.report}</div></Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- cost model

const CM = {
  n: range({ label: "Objects per request", min: 2, max: 1000, step: 1, default: 100, log: true }),
  size: range({ label: "Object size", min: 8, max: 4096, step: 8, default: 64, log: true, format: (v) => `${v} B` }),
  survive: range({ label: "Objects that outlive the request", min: 0, max: 1, step: 0.01, default: 0.1, format: (v) => pct(v) }),
};

export function TempCostDemo() {
  const P = useParams("sys-exp-cost", CM);
  const { n, size, survive } = P.values;
  const xs = Array.from({ length: 51 }, (_, i) => i / 50);
  const m = xs.map((f) => [f, mallocCost({ n, size, survive: f }) / n] as [number, number]);
  const a = xs.map((f) => [f, arenaCost({ n, size, survive: f }) / n] as [number, number]);
  const be = breakEven(n, size);
  const ma = mallocCost({ n, size, survive }), ar = arenaCost({ n, size, survive });
  const ymax = Math.max(...a.map((p) => p[1]), ...m.map((p) => p[1])) * 1.05;
  return (
    <Demo title="Per-object malloc against one arena per request" controls={<>
      <Param spec={CM.survive} value={survive} onChange={(v) => P.set("survive", v as number)} />
      <Param spec={CM.n} value={n} onChange={(v) => P.set("n", v as number)} />
      <Param spec={CM.size} value={size} onChange={(v) => P.set("size", v as number)} />
    </>}>
      <Plot x={[0, 1]} y={[0, ymax]} height={220} xLabel="fraction of objects that outlive the request" yLabel="ns per object">
        <Line points={m} color="var(--c4)" />
        <Line points={a} color="var(--c3)" />
        {be > 0 && be < 1 && <RuleX at={be} color="var(--muted)" />}
        <Dots points={[[survive, ma / n], [survive, ar / n]]} color="var(--fg)" />
      </Plot>
      <Legend items={[{ label: "malloc + free per object", color: "var(--c4)" }, { label: "arena: bump, reset, copy survivors out", color: "var(--c3)" }]} />
      <Stats items={[
        { label: "malloc, ns per request", value: fixed(ma, 0) },
        { label: "arena, ns per request", value: fixed(ar, 0) },
        { label: "arena is faster by", value: `${fixed(ma / ar, 1)}×` },
        { label: "break-even survivor fraction", value: be >= 1 ? "never" : be <= 0 ? "always slower" : pct(be) },
      ]} />
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Model inputs: malloc {COST.malloc} ns, free {COST.free} ns, bump {COST.bump} ns, reset {COST.reset} ns, copy {COST.copyPerByte} ns per byte.
      </div>
    </Demo>
  );
}
