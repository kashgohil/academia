/** Demos for "Spatial indexes: R-trees": an interactive R-tree and Z-order vs Hilbert key ranges. */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { Demo, Stats, Param, range, Legend, Note, SectionLabel, fixed, mono, seg } from "../../kit";
import { RTree, demoItems, RTREE_QUERY, type Item, type Rect, type RNode } from "../../sims/db/indexes/rtree";
import { boxRanges, decode, meanRanges, CURVE_BOX, type Curve } from "../../sims/db/indexes/sfc";

// ============================================================================
// Interactive R-tree
// ============================================================================

type Mode = "query" | "knn" | "point" | "rect";
const LEVEL_COLORS = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c4)"];

const norm = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) });
const round = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export function RTreeDemo() {
  const [M, setM] = useState(4);
  const [items, setItems] = useState<Item[]>(() => demoItems());
  const [mode, setMode] = useState<Mode>("query");
  const [q, setQ] = useState<Rect>(RTREE_QUERY);
  const [kp, setKp] = useState({ x: 70, y: 30 });
  const [draft, setDraft] = useState<Rect | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tree = useMemo(() => { const t = new RTree(M); for (const it of items) t.insert(it); return t; }, [items, M]);
  const levels = tree.levels();
  const h = levels.length;
  const tr = useMemo(() => tree.search(q), [tree, q]);
  const nn = useMemo(() => tree.knn(kp.x, kp.y, 3), [tree, kp]);
  const visited = new Set(mode === "knn" ? nn.visited : tr.visited);
  const pruned = new Set(mode === "knn" ? [] : tr.pruned);
  const hits = new Set(mode === "knn" ? nn.ids : tr.results);
  const at = (e: RPointerEvent) => {
    const s = svg.current!, p = s.createSVGPoint();
    p.x = e.clientX; p.y = e.clientY;
    const r = p.matrixTransform(s.getScreenCTM()!.inverse());
    return { x: round(r.x), y: round(r.y) };
  };
  const down = (e: RPointerEvent<SVGSVGElement>) => {
    const p = at(e);
    if (mode === "point") { setItems((xs) => [...xs, { id: xs.length + 1, r: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } }]); return; }
    if (mode === "knn") { setKp(p); drag.current = p; e.currentTarget.setPointerCapture(e.pointerId); return; }
    drag.current = p;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (mode === "query") setQ(norm(p, p)); else setDraft(norm(p, p));
  };
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const p = at(e);
    if (mode === "knn") setKp(p);
    else if (mode === "query") setQ(norm(drag.current, p));
    else setDraft(norm(drag.current, p));
  };
  const up = () => {
    if (mode === "rect" && draft) setItems((xs) => [...xs, { id: xs.length + 1, r: draft }]);
    setDraft(null);
    drag.current = null;
  };
  const nodeLevel = new Map<number, number>();
  levels.forEach((lv, i) => lv.forEach((n) => nodeLevel.set(n.id, h - 1 - i)));
  const stroke = (n: RNode) => {
    const lvl = nodeLevel.get(n.id)!;
    return { color: LEVEL_COLORS[lvl % LEVEL_COLORS.length]!, on: visited.has(n.id), cut: pruned.has(n.id) };
  };
  const total = tree.nodeCount();
  return (
    <Demo
      title={`R-tree: at most ${M} entries per node`}
      actions={
        <>
          <button className="btn" onClick={() => setItems((xs) => [...xs, ...demoItems(10, xs.length + 17).map((it, i) => ({ ...it, id: xs.length + i + 1 }))])}>Add 10 random</button>
          <button className="btn ghost" onClick={() => { setItems(demoItems()); setQ(RTREE_QUERY); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Max entries per node (M)", min: 3, max: 8, step: 1, default: 4 })} value={M} onChange={(v) => setM(v as number)} />
          <Param spec={seg<Mode>("Drag or click on the map to", [["query", "draw a query box"], ["knn", "find 3 nearest"], ["point", "add a point"], ["rect", "add a rectangle"]], "query")} value={mode} onChange={(v) => setMode(v as Mode)} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <svg ref={svg} viewBox="-1 -1 102 102" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          style={{ width: "100%", maxWidth: 440, aspectRatio: "1", touchAction: "none", cursor: "crosshair", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", flex: "1 1 280px" }}>
          {levels.slice().reverse().map((lv) => lv.map((n) => {
            const s = stroke(n);
            if (n === tree.root && h > 1) return null;
            const pad = 0.6 * (nodeLevel.get(n.id)!);
            return <rect key={n.id} x={n.mbr.x0 - pad} y={n.mbr.y0 - pad} width={n.mbr.x1 - n.mbr.x0 + 2 * pad} height={n.mbr.y1 - n.mbr.y0 + 2 * pad} fill={s.on ? s.color : "none"} fillOpacity={0.06} stroke={s.cut ? "var(--c4)" : s.color} strokeOpacity={s.on || s.cut ? 1 : 0.35} strokeWidth={s.on ? 0.7 : 0.4} strokeDasharray={s.on ? undefined : "1.5 1"} />;
          }))}
          {items.map((it) => {
            const hit = hits.has(it.id), r = it.r;
            return r.x0 === r.x1 && r.y0 === r.y1
              ? <circle key={it.id} cx={r.x0} cy={r.y0} r={1.1} fill={hit ? "var(--c3)" : "var(--fg)"} />
              : <rect key={it.id} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill={hit ? "var(--c3)" : "var(--muted)"} fillOpacity={hit ? 0.8 : 0.35} stroke={hit ? "var(--c3)" : "var(--muted)"} strokeWidth={0.3} />;
          })}
          {mode !== "knn" && <rect x={q.x0} y={q.y0} width={q.x1 - q.x0} height={q.y1 - q.y0} fill="var(--c3)" fillOpacity={0.08} stroke="var(--c3)" strokeWidth={0.6} strokeDasharray="2 1" />}
          {mode === "knn" && (
            <>
              {nn.dists.length > 0 && <circle cx={kp.x} cy={kp.y} r={nn.dists[nn.dists.length - 1]!} fill="none" stroke="var(--c3)" strokeWidth={0.4} strokeDasharray="1.5 1" />}
              <circle cx={kp.x} cy={kp.y} r={1.6} fill="var(--c3)" />
            </>
          )}
          {draft && <rect x={draft.x0} y={draft.y0} width={draft.x1 - draft.x0} height={draft.y1 - draft.y0} fill="none" stroke="var(--fg)" strokeWidth={0.4} />}
        </svg>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          {levels.map((lv, i) => (
            <div key={i}>
              <SectionLabel style={{ marginTop: i ? 8 : 0 }}>{i === 0 ? "root" : i === h - 1 ? "leaves" : `level ${i}`}</SectionLabel>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                {lv.map((n) => {
                  const s = stroke(n);
                  return <span key={n.id} title={`${n.leaf ? n.items.length : n.kids.length} entries`} style={{ ...mono, fontSize: 10.5, padding: "0 5px", borderRadius: 3, border: `1px ${s.on ? "solid" : "dashed"} ${s.cut ? "var(--c4)" : s.color}`, background: s.on ? s.color : "transparent", color: s.on ? "#fff" : "var(--muted)" }}>{n.leaf ? n.items.length : n.kids.length}</span>;
                })}
              </div>
            </div>
          ))}
          <Note>Each chip is a node and shows its entry count. Filled: visited. Red dashed: the MBR test pruned it. Faint: never reached.</Note>
        </div>
      </div>
      <div style={{ height: 10 }} />
      <Stats
        items={mode === "knn"
          ? [
            { label: "nodes opened / all nodes", value: `${nn.visited.length} / ${total}` },
            { label: "3 nearest (ids)", value: nn.ids.join(", ") || "–" },
            { label: "distance to the 3rd", value: nn.dists[2] !== undefined ? fixed(nn.dists[2], 1) : "–" },
            { label: "height", value: h },
          ]
          : [
            { label: "nodes visited / all nodes", value: `${tr.visited.length} / ${total}` },
            { label: "MBR and item tests", value: tr.tested },
            { label: "results", value: tr.results.length },
            { label: "a scan with no index tests", value: items.length },
            { label: "height", value: h },
          ]}
      />
      <div style={{ marginTop: 6 }}><Legend items={[{ label: "leaf MBRs", color: LEVEL_COLORS[0]! }, { label: "MBRs one level up", color: LEVEL_COLORS[1]! }, { label: "query and results", color: "var(--c3)" }, { label: "pruned", color: "var(--c4)" }]} /></div>
    </Demo>
  );
}

// ============================================================================
// Z-order vs Hilbert: a box as 1D key ranges
// ============================================================================


function CurveGrid({ c, n, box, maxR }: { c: Curve; n: number; box: { x0: number; y0: number; x1: number; y1: number }; maxR: number }) {
  const cov = useMemo(() => boxRanges(c, n, box, maxR), [c, n, box.x0, box.y0, box.x1, box.y1, maxR]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => Array.from({ length: n * n }, (_, d) => decode(c, n, d)), [c, n]);
  const inBox = (x: number, y: number) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
  const scanned = new Set<number>();
  for (const [a, z] of cov.merged) for (let d = a; d <= z; d++) scanned.add(d);
  const path = (from: number, to: number) => order.slice(from, to + 1).map(([x, y], i) => `${i ? "L" : "M"}${x + 0.5} ${n - 1 - y + 0.5}`).join("");
  const sw = 8 / n;
  return (
    <div style={{ flex: "1 1 240px", minWidth: 0, maxWidth: 400 }}>
      <SectionLabel>{c === "z" ? "Z-order (Morton)" : "Hilbert"}</SectionLabel>
      <svg viewBox={`0 0 ${n} ${n}`} style={{ width: "100%", aspectRatio: "1", display: "block", border: "1px solid var(--border)", borderRadius: 4 }}>
        {order.map(([x, y], d) => {
          const ib = inBox(x, y), fp = !ib && scanned.has(d);
          return ib || fp ? <rect key={d} x={x} y={n - 1 - y} width={1} height={1} fill={ib ? "var(--c1)" : "var(--c4)"} opacity={ib ? 0.3 : 0.35} /> : null;
        })}
        <path d={path(0, n * n - 1)} fill="none" stroke="var(--faint)" strokeWidth={sw * 0.08} />
        {cov.merged.map(([a, z]) => a === z
          ? <circle key={a} cx={order[a]![0] + 0.5} cy={n - 1 - order[a]![1] + 0.5} r={0.22} fill="var(--c3)" />
          : <path key={a} d={path(a, z)} fill="none" stroke="var(--c3)" strokeWidth={sw * 0.18} strokeLinecap="round" strokeLinejoin="round" />)}
      </svg>
      <div style={{ display: "flex", height: 10, marginTop: 6, borderRadius: 2, overflow: "hidden", border: "1px solid var(--border)" }} title="the keys 0 … n²−1 in B-tree order">
        {order.map(([x, y], d) => <div key={d} style={{ flex: 1, background: inBox(x, y) ? "var(--c1)" : scanned.has(d) ? "var(--c4)" : "transparent" }} />)}
      </div>
      <div className="muted" style={{ ...mono, fontSize: 11, marginTop: 3 }}>{cov.ranges.length} exact ranges · {cov.merged.length} scanned, {cov.falsePositives} false-positive cells</div>
    </div>
  );
}

export function CurveDemo() {
  const [n, setN] = useState<"8" | "16" | "32">("16");
  const [x0, setX0] = useState(CURVE_BOX.x0);
  const [y0, setY0] = useState(CURVE_BOX.y0);
  const [w, setW] = useState(CURVE_BOX.w);
  const [hh, setH] = useState(CURVE_BOX.h);
  const [maxR, setMaxR] = useState(32);
  const N = Number(n);
  const bw = Math.min(w, N), bh = Math.min(hh, N);
  const bx = Math.min(x0, N - bw), by = Math.min(y0, N - bh);
  const box = { x0: bx, y0: by, x1: bx + bw - 1, y1: by + bh - 1 };
  const z = boxRanges("z", N, box, maxR), hi = boxRanges("hilbert", N, box, maxR);
  const mean = useMemo(() => ({ z: meanRanges("z", N, bw, bh, 200), h: meanRanges("hilbert", N, bw, bh, 200) }), [N, bw, bh]);
  return (
    <Demo
      title="One query box, two curves: how many key ranges?"
      controls={
        <>
          <Param spec={range({ label: "Box x", min: 0, max: 31, step: 1, default: CURVE_BOX.x0 })} value={x0} onChange={(v) => setX0(v as number)} />
          <Param spec={range({ label: "Box y", min: 0, max: 31, step: 1, default: CURVE_BOX.y0 })} value={y0} onChange={(v) => setY0(v as number)} />
          <Param spec={range({ label: "Box width", min: 1, max: 16, step: 1, default: CURVE_BOX.w })} value={w} onChange={(v) => setW(v as number)} />
          <Param spec={range({ label: "Box height", min: 1, max: 16, step: 1, default: CURVE_BOX.h })} value={hh} onChange={(v) => setH(v as number)} />
          <Param spec={range({ label: "Max ranges per query", min: 1, max: 32, step: 1, default: 32 })} value={maxR} onChange={(v) => setMaxR(v as number)} />
          <Param spec={seg<"8" | "16" | "32">("Grid", [["8", "8 × 8"], ["16", "16 × 16"], ["32", "32 × 32"]], "16")} value={n} onChange={(v) => setN(v as "8" | "16" | "32")} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <CurveGrid c="z" n={N} box={box} maxR={maxR} />
        <CurveGrid c="hilbert" n={N} box={box} maxR={maxR} />
      </div>
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "cells in the box", value: z.cells },
          { label: "exact ranges: Z / Hilbert", value: `${z.ranges.length} / ${hi.ranges.length}` },
          { label: `false positives with ≤ ${maxR} ranges: Z / Hilbert`, value: `${z.falsePositives} / ${hi.falsePositives}` },
          { label: `mean exact ranges, random ${bw} × ${bh} boxes: Z / Hilbert`, value: `${fixed(mean.z, 1)} / ${fixed(mean.h, 1)}` },
        ]}
      />
      <div style={{ marginTop: 6 }}><Legend items={[{ label: "cells in the box", color: "var(--c1)" }, { label: "scanned but outside: false positives", color: "var(--c4)" }, { label: "curve pieces that the scan reads", color: "var(--c3)" }]} /></div>
      <Note>The strip under each grid is the one-dimensional key order that a B-tree stores. Each green piece of the curve is one range scan. Fewer ranges mean fewer index seeks; merging ranges saves seeks but reads false positives.</Note>
    </Demo>
  );
}
