/** Demos for "Mark and sweep": a mark-sweep stepper, precise vs conservative stack scanning, and the cost model. */
import { useMemo } from "react";
import {
  Banner, Chip, Controls, Demo, Dots, Line, Plot, RuleX, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, fixed, mono, range, seg, tint, useParams, useStepper, useWidth,
} from "../../kit";
import { COST_DEFAULTS, MS_GRAPH, MS_POS, freeStats, layoutHeap, markSweep, nameOf, stackScan, tracingCost, type MsFrame, type WordValue } from "../../sims/sys/gc";
import { hex } from "../../sims/sys/mem";
import { HeapBlocks, StackView } from "./SysViews";
import { GcCode, GcGraph, type NodeTone } from "./SysGcUi";

/** The heap in address order: one box per object, width by size, free runs hatched. */
function HeapStrip({ f, addr }: { f: MsFrame; addr: Record<number, number> }) {
  const [ref, w0] = useWidth<HTMLDivElement>(520);
  const order = [...MS_GRAPH.objs].sort((a, b) => addr[a.id]! - addr[b.id]!);
  const lo = addr[order[0]!.id]!;
  const hi = addr[order[order.length - 1]!.id]! + Math.ceil(order[order.length - 1]!.size / 16) * 16;
  const W = Math.max(w0, 460), scale = (W - 2) / (hi - lo);
  const swept = (i: number) => f.phase === "sweep" || f.phase === "done" ? i < f.sweepAt : false;
  return (
    <div ref={ref} style={{ overflowX: "auto", maxWidth: "100%" }}>
      <div style={{ position: "relative", width: W, height: 48, ...mono, fontSize: 11 }}>
        {order.map((o, i) => {
          const freed = f.freed.includes(o.id);
          const c = f.color[o.id]!;
          const bg = freed ? "repeating-linear-gradient(135deg, var(--subtle) 0 4px, var(--border) 4px 5px)" : c === "black" ? "var(--fg)" : c === "gray" ? tint("var(--c2)", 40) : "var(--bg)";
          return (
            <div key={o.id} title={`${o.name} at ${hex(addr[o.id]!)}, ${o.size} B`} style={{
              position: "absolute", left: (addr[o.id]! - lo) * scale, width: Math.ceil(o.size / 16) * 16 * scale - 2, top: 0, height: 30,
              border: `1.5px ${freed ? "dashed" : "solid"} ${freed ? "var(--faint)" : "var(--fg)"}`, borderRadius: 3, background: bg,
              color: c === "black" && !freed ? "var(--bg)" : freed ? "var(--muted)" : "var(--fg)", display: "grid", placeItems: "center", boxSizing: "border-box",
              outline: f.focus === o.id ? "2px solid var(--c1)" : undefined, outlineOffset: 1, opacity: swept(i) || f.phase !== "sweep" ? 1 : 0.85,
            }}>{o.name}</div>
          );
        })}
        {(f.phase === "sweep" || f.phase === "done") && f.sweepAt < order.length && (
          <div style={{ position: "absolute", left: (addr[order[f.sweepAt]!.id]! - lo) * scale, top: 32, color: "var(--c1)" }}>▲ sweep</div>
        )}
      </div>
    </div>
  );
}

export function MarkSweepDemo() {
  const addr = useMemo(() => layoutHeap(MS_GRAPH), []);
  const frames = useMemo(() => markSweep(MS_GRAPH, addr), [addr]);
  const s = useStepper(frames.length, 1.5);
  const f = frames[s.i]!;
  const fs = freeStats(f.free);
  const tone = (id: number): NodeTone => (f.freed.includes(id) ? "freed" : f.color[id]!);
  return (
    <Demo title="Mark with a stack, then sweep in address order" controls={<><StepButtons s={s} /><StepSlider s={s} /></>}>
      <GcGraph g={MS_GRAPH} pos={MS_POS} tone={tone} focus={f.focus} height={210} legend={["white", "gray", "black", "freed"]} />
      <SectionLabel>Mark stack (top on the right)</SectionLabel>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", minHeight: 20 }}>
        {f.stack.length ? f.stack.map((id, i) => <Chip key={i} color="var(--c2)">{nameOf(MS_GRAPH, id)}</Chip>) : <span className="muted" style={{ fontSize: 12 }}>empty</span>}
      </div>
      <SectionLabel>The heap in address order</SectionLabel>
      <HeapStrip f={f} addr={addr} />
      <StepCaption label={f.phase}>{f.text}</StepCaption>
      <Stats items={[
        { label: "objects scanned by mark", value: f.work.scanned },
        { label: "fields read", value: f.work.fields },
        { label: "objects visited by sweep", value: f.work.swept },
        { label: "free bytes / largest run", value: `${fs.total} / ${fs.largest}` },
      ]} />
    </Demo>
  );
}

const SCAN = {
  n: seg<WordValue>("long n holds", [["small", "42"], ["base", "address of D"], ["interior", "an address inside D"]], "base"),
  mode: seg<"precise" | "conservative">("Root finding", [["precise", "precise (stack map)"], ["conservative", "conservative"]], "conservative"),
};

export function StackScanDemo() {
  const P = useParams("sys-gc-scan", SCAN);
  const r = useMemo(() => stackScan(P.values.n, P.values.mode), [P.values.n, P.values.mode]);
  return (
    <Demo title="Find the roots: stack map or guess" controls={<Controls params={P} />}>
      <GcCode lines={r.source} at={3} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 10, marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack of main() at the collection</SectionLabel>
          <StackView frames={r.before.frames.filter((x) => x.live)} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Heap after the collection</SectionLabel>
          <HeapBlocks blocks={r.snap.heap} edges={r.snap.edges} small minWidth={260} />
        </div>
      </div>
      <SectionLabel>Words that the scan treats as pointers</SectionLabel>
      <div style={{ ...mono, fontSize: 12 }}>
        {r.roots.map((x) => (
          <div key={x.addr}>{x.where} = {hex(x.value)} → {x.block} {x.typed ? "" : <b style={{ color: "var(--c4)" }}>(not a pointer)</b>}</div>
        ))}
      </div>
      <Stats items={[
        { label: "words read", value: r.wordsScanned },
        { label: "retained", value: r.retained.join(" ") },
        { label: "freed", value: r.freed.join(" ") || "none" },
      ]} />
      {r.falseRetained.length
        ? <Banner tone="bad">The integer n looks like a pointer into D, so {r.falseRetained.join(" and ")} stay alive. The program can never use them again: {r.falseRetained.length * 16} bytes of false retention.</Banner>
        : <Banner tone="good">Only the real pointer list is a root. D and E are freed.</Banner>}
    </Demo>
  );
}

const COST = {
  live: range({ label: "Live data L, MiB", min: 10, max: 1000, step: 10, default: 100 }),
  mult: range({ label: "Heap size H as a multiple of L", min: 1.1, max: 6, step: 0.1, default: 3, format: (v) => `${v.toFixed(1)} × L` }),
  mark: range({ label: "Mark cost, ns per live byte (model input)", min: 0.2, max: 4, step: 0.1, default: COST_DEFAULTS.markNs }),
  sweep: range({ label: "Sweep cost, ns per heap byte (model input)", min: 0, max: 1, step: 0.05, default: COST_DEFAULTS.sweepNs }),
};

export function TracingCostDemo() {
  const P = useParams("sys-gc-mscost", COST);
  const { live, mult, mark, sweep } = P.values;
  const at = (m: number) => tracingCost({ live, heap: live * m, markNs: mark, sweepNs: sweep, copyNs: 0 }).ms;
  const c = at(mult);
  const pts = Array.from({ length: 50 }, (_, i) => 1.1 + (i * 4.9) / 49).map((m) => [m, Math.min(at(m).perByte, 12)] as [number, number]);
  return (
    <Demo title="More heap, less collection work" controls={<Controls params={P} />}>
      <Plot x={[1, 6]} y={[0, 12]} height={220} xLabel="heap size H / live data L" yLabel="GC ns per allocated byte">
        <Line points={pts} color="var(--c1)" />
        <RuleX at={mult} />
        <Dots points={[[mult, Math.min(c.perByte, 12)]]} color="var(--c1)" r={5} />
      </Plot>
      <Stats items={[
        { label: "heap H", value: `${fixed(live * mult, 0)} MiB` },
        { label: "collections per GiB allocated", value: fixed(c.gcsPerGiB, 1) },
        { label: "GC ns per allocated byte", value: fixed(c.perByte) },
        { label: "stop-the-world pause: mark + sweep", value: `${fixed(c.pauseMs, 0)} ms` },
        { label: "pause with lazy sweep: mark only", value: `${fixed(c.markOnlyMs, 0)} ms` },
      ]} />
      <Banner tone="info">
        Each collection marks all L live bytes and sweeps all H heap bytes, and it frees H − L bytes for new objects. So the cost per allocated byte is (mark · L + sweep · H) / (H − L). It explodes as H approaches L. The pause does not shrink with more heap: it grows with L.
      </Banner>
    </Demo>
  );
}
