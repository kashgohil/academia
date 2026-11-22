/** Demos for "Copying collectors": Cheney's algorithm step by step, locality of copy orders, and the space-time trade. */
import { useMemo } from "react";
import {
  Banner, Controls, Demo, Dots, Legend, Line, MiniTable, Plot, RuleX, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, fixed, mono, range, seg, useParams, useStepper,
} from "../../kit";
import {
  CHENEY_GRAPH, CHENEY_POS, FROM_BASE, cheney, copyOrder, copyWinsAbove, layoutFor, layoutHeap, list, lruMisses, lineSwitches, obj, tracingCost, tree, type Layout,
} from "../../sims/sys/gc";
import { hex } from "../../sims/sys/mem";
import { GcGraph, type NodeTone } from "./SysGcUi";

export function CheneyDemo() {
  const from = useMemo(() => layoutHeap(CHENEY_GRAPH, FROM_BASE), []);
  const frames = useMemo(() => cheney(CHENEY_GRAPH), []);
  const s = useStepper(frames.length, 1.5);
  const f = frames[s.i]!;
  const tone = (id: number): NodeTone => {
    const k = f.copied.findIndex((c) => c.id === id);
    return k < 0 ? (f.phase === "done" ? "freed" : "white") : k < f.scanIdx ? "black" : "gray";
  };
  const short = (a: number) => a.toString(16);
  return (
    <Demo title="Cheney: to-space is the queue" controls={<><StepButtons s={s} /><StepSlider s={s} /></>}>
      <SectionLabel style={{ marginTop: 0 }}>From-space (the badge is the forwarding pointer)</SectionLabel>
      <GcGraph g={CHENEY_GRAPH} pos={CHENEY_POS} tone={tone} focus={f.focus} height={170}
        badge={(id) => (f.fwd[id] !== undefined ? `→${short(f.fwd[id]!)}` : undefined)} legend={["white", "gray", "black"]}
        extra={<span className="muted" style={{ fontSize: 12 }}>gray = copied, not scanned; black = scanned</span>} />
      <SectionLabel>To-space, in copy order</SectionLabel>
      <MiniTable
        head={["", "address", "object", "f0", "f1"]}
        highlight={f.scanIdx}
        rows={[
          ...f.copied.map((c, i) => {
            const o = obj(CHENEY_GRAPH, c.id);
            const cell = (k: number) => {
              const t = o.fields[k];
              if (t === null || t === undefined) return <span className="muted">null</span>;
              return f.updated[c.id]![k] ? <span style={mono}>{hex(f.fwd[t]!)}</span> : <span style={{ ...mono, color: "var(--c4)" }}>{hex(from[t]!)} (old)</span>;
            };
            return [i === f.scanIdx ? "scan ▸" : "", <span style={mono}>{hex(c.addr)}</span>, o.name, cell(0), cell(1)];
          }),
          [f.scanIdx >= f.copied.length ? "scan ▸ free ▸" : "free ▸", <span style={mono}>{hex(f.free)}</span>, "", "", ""],
        ]}
      />
      <StepCaption label={f.phase}>{f.text}</StepCaption>
      <Stats items={[
        { label: "objects copied", value: f.copied.length },
        { label: "bytes copied", value: f.bytesCopied },
        { label: "garbage touched", value: "0 objects" },
      ]} />
    </Demo>
  );
}

const LOC = {
  shape: seg<"tree" | "list">("Data", [["tree", "binary tree, 31 nodes"], ["list", "linked list, 32 nodes"]], "tree"),
  walk: seg<"dfs" | "bfs">("The program walks it", [["dfs", "recursively (depth first)"], ["bfs", "level by level"]], "dfs"),
  layout: seg<Layout>("Plot the layout", [["scattered", "fragmented heap"], ["bfs", "after Cheney (BFS)"], ["dfs", "after a depth-first copy"]], "bfs"),
};
const LAYOUTS: { k: Layout; label: string; color: string }[] = [
  { k: "scattered", label: "fragmented heap", color: "var(--c4)" },
  { k: "bfs", label: "Cheney copy (breadth first)", color: "var(--c1)" },
  { k: "dfs", label: "depth-first copy", color: "var(--c3)" },
];

export function LocalityDemo() {
  const P = useParams("sys-gc-locality", LOC);
  const { shape, walk, layout } = P.values;
  const g = useMemo(() => (shape === "tree" ? tree(31) : list(32)), [shape]);
  const order = useMemo(() => copyOrder(g, walk), [g, walk]);
  const res = LAYOUTS.map((l) => {
    const a = layoutFor(g, l.k);
    const ls = lineSwitches(order, a);
    return { ...l, misses: lruMisses(order, a), lines: ls.lines, distinct: ls.distinct };
  });
  const cur = res.find((r) => r.k === layout)!;
  const lo = Math.min(...cur.lines), hi = Math.max(...cur.lines);
  return (
    <Demo title="The copy order is the memory layout" controls={<Controls params={P} />}>
      <SectionLabel style={{ marginTop: 0 }}>Cache line of each access, in walk order: {cur.label}</SectionLabel>
      <Plot x={[0, order.length - 1]} y={[0, Math.max(1, hi - lo)]} height={190} xLabel="access number" yLabel="cache line (64 B)">
        <Line points={cur.lines.map((l, i) => [i, l - lo] as [number, number])} color={cur.color} width={1.2} />
        <Dots points={cur.lines.map((l, i) => [i, l - lo] as [number, number])} color={cur.color} r={2.5} />
      </Plot>
      <MiniTable
        head={["layout", "lines used", "misses, 4-line LRU cache"]}
        highlight={res.findIndex((r) => r.k === layout)}
        rows={res.map((r) => [r.label, r.distinct, r.misses])}
      />
      <Legend items={res.map((r) => ({ label: r.label, color: r.color }))} />
      <Note2 />
    </Demo>
  );
}

function Note2() {
  return (
    <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
      Model: 32-byte objects, 64-byte cache lines, a cache of only 4 lines with LRU replacement. The fragmented heap puts each object in a random free 32-byte slot among 4 times as many slots. Real caches are larger, so real gaps are smaller, but the order of the three rows is the point.
    </p>
  );
}

const SPACE = {
  mult: range({ label: "Heap size H as a multiple of live data L", min: 1.2, max: 64, step: 0.1, default: 3, log: true, format: (v) => `${v.toFixed(1)} × L` }),
  copy: range({ label: "Copy cost, ns per live byte (model input)", min: 0.5, max: 6, step: 0.1, default: 2 }),
  mark: range({ label: "Mark cost, ns per live byte (model input)", min: 0.2, max: 4, step: 0.1, default: 1 }),
  sweep: range({ label: "Sweep cost, ns per heap byte (model input)", min: 0, max: 1, step: 0.05, default: 0.1 }),
};

export function SpaceTimeDemo() {
  const P = useParams("sys-gc-spacetime", SPACE);
  const { mult, copy, mark, sweep } = P.values;
  const at = (m: number) => tracingCost({ live: 100, heap: 100 * m, markNs: mark, sweepNs: sweep, copyNs: copy });
  const xs = Array.from({ length: 120 }, (_, i) => 1.2 * Math.pow(64 / 1.2, i / 119));
  const cap = (v: number) => Math.min(v, 4);
  const c = at(mult);
  const cross = copyWinsAbove({ live: 100, markNs: mark, sweepNs: sweep, copyNs: copy });
  return (
    <Demo title="Copying needs twice the room" controls={<Controls params={P} />}>
      <Plot x={[1.2, 64]} y={[0, 4]} logX xTicks={[1.5, 2, 4, 8, 16, 32, 64]} height={220} xLabel="heap size H / live data L (log scale)" yLabel="GC ns per allocated byte">
        <Line points={xs.map((m) => [m, cap(at(m).ms.perByte)] as [number, number])} color="var(--c1)" />
        <Line points={xs.filter((m) => m > 2.02).map((m) => [m, cap(at(m).copy.perByte)] as [number, number])} color="var(--c5)" />
        <RuleX at={2} label="H = 2L" />
        <RuleX at={mult} />
      </Plot>
      <Legend items={[{ label: "mark-sweep", color: "var(--c1)" }, { label: "semispace copying", color: "var(--c5)" }]} />
      <Stats items={[
        { label: "mark-sweep, ns per allocated byte", value: fixed(c.ms.perByte) },
        { label: "copying, ns per allocated byte", value: Number.isFinite(c.copy.perByte) ? fixed(c.copy.perByte) : "does not fit" },
        { label: "copying is cheaper above", value: Number.isFinite(cross) ? `${fixed(cross, 1)} × L` : "never" },
      ]} />
      <Banner tone="info">
        A semispace copier can use only half of H, and it must hold all L live bytes in that half. Below H = 2L it cannot run. Its work grows with L only, never with H. So it wins only when the heap is many times larger than the live data, or when sweeping is expensive.
      </Banner>
    </Demo>
  );
}
