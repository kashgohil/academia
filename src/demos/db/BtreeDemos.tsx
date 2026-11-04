/** Demos for the B-tree lessons: B+ trees, bulk loading and fill factor. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, Dots, Bars, RuleX, RuleY, Legend, range, select, pct, si, bytes } from "../../kit";
import {
  BPlusTree, type BEvent, type SnapNode, fillExperiment, bulkExperiment, fillHistogram, growthCurve, pageCapacity, levelSizes,
  cachedLevels, bstDepth, btreeLookupLines, LAB_KEYS, type InsertOrder, type SplitPolicy, type BulkStep,
} from "../../sims/db/btree";
import { mulberry32 } from "../../sims/rng";
import { TreeView, type ViewNode, mono } from "./BtreeView";

const C = { path: "var(--c1)", changed: "var(--c3)", bad: "var(--c4)", added: "var(--c2)", donor: "var(--c5)" };

function findSnap(s: SnapNode<number>, id: number): SnapNode<number> | null {
  if (s.id === id) return s;
  for (const k of s.kids ?? []) {
    const f = findSnap(k, id);
    if (f) return f;
  }
  return null;
}
const keysOf = (s: SnapNode<number>, id: number) => findSnap(s, id)?.keys ?? [];
const fmtKeys = (ks: number[]) => `[${ks.join(", ")}]`;
/** 1e3 → "1k", 1e12 → "1T". */
const fmtN = (v: number) => (v >= 1e12 ? `${+(v / 1e12).toPrecision(3)}T` : si(v).replace(" ", ""));

// ============================================================================
// Lesson 1: interactive B+ tree
// ============================================================================

interface Frame {
  snap: SnapNode<number>;
  caption: string;
  color: Map<number, string>;
  chain: Map<number, string>;
  mark?: { key: number; color: string };
}

const INITIAL = LAB_KEYS;
type Op = ["i" | "d", number];

function buildTree(order: number, ops: Op[]) {
  const t = new BPlusTree<number, number>({ order });
  for (const [o, k] of ops) (o === "i" ? t.insert(k, k) : t.delete(k));
  t.resetStats();
  return t;
}

function caption(e: BEvent<number>, t: BPlusTree<number, number>, snap: SnapNode<number>, key: number): string {
  switch (e.t) {
    case "visit": {
      const n = findSnap(snap, e.id)!;
      if (n.leaf) return `Level ${e.depth}: read leaf ${fmtKeys(n.keys)}.`;
      const i = n.keys.filter((s) => s <= key).length;
      const why = i === 0 ? `${key} < ${n.keys[0]}` : i === n.keys.length ? `${key} ≥ ${n.keys[i - 1]}` : `${n.keys[i - 1]} ≤ ${key} < ${n.keys[i]}`;
      return `Level ${e.depth}: read ${fmtKeys(n.keys)}. ${why}, so follow pointer ${i + 1} of ${n.keys.length + 1}.`;
    }
    case "insert": return `Put ${e.key} in the leaf, in sorted position.`;
    case "update": return `${e.key} is already in the tree: replace its value.`;
    case "overflow": return `This node now has ${keysOf(snap, e.id).length} keys. The maximum is ${t.maxKeys}, so it must split.`;
    case "split": {
      const l = keysOf(snap, e.id).length, r = keysOf(snap, e.right).length;
      return e.leaf
        ? `Leaf split: ${l} keys stay, ${r} move to a new right leaf. Copy its first key ${e.sep} up to the parent as a separator.`
        : `Internal split: ${l} keys stay, ${r} move right, and the middle key ${e.sep} moves up to the parent.`;
    }
    case "newRoot": return "The root split, so a new root grows on top. The tree is now one level taller.";
    case "remove": return `Remove ${e.key} from the leaf.`;
    case "underflow": {
      const n = keysOf(snap, e.id).length;
      return `This node has ${n} key${n === 1 ? "" : "s"}. The minimum is ${findSnap(snap, e.id)!.leaf ? t.minLeafKeys : t.minKids - 1}, so fix it.`;
    }
    case "borrow": return `The ${e.side} sibling has a spare key: borrow it and update the separator in the parent.`;
    case "merge": return "No sibling has a spare key: merge the two nodes and remove their separator from the parent.";
    case "collapse": return "The root has only one child: remove the root. The tree is now one level shorter.";
    case "scan": return `Scan leaf ${fmtKeys(keysOf(snap, e.id))}, then follow the link to the next leaf.`;
    case "found": return `Found ${e.key}.`;
    case "missing": return `${e.key} is not in this leaf, so it is not in the tree.`;
  }
}

export function BTreeLabDemo() {
  const [order, setOrder] = useState(4);
  const [key, setKey] = useState(40);
  const ops = useRef<Op[]>(INITIAL.map((k) => ["i", k] as Op));
  const tree = useRef<BPlusTree<number, number> | null>(null);
  const rng = useRef(mulberry32(42));
  if (!tree.current || tree.current.order !== order) tree.current = buildTree(order, ops.current);
  const t = tree.current;
  const [frames, setFrames] = useState<Frame[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [last, setLast] = useState<{ reads: number; writes: number; splits: number; merges: number; borrows: number } | null>(null);

  useEffect(() => {
    setFrames([]);
    setLast(null);
  }, [order]);
  useEffect(() => {
    if (!playing) return;
    if (idx >= frames.length - 1) { setPlaying(false); return; }
    const id = window.setTimeout(() => setIdx((i) => i + 1), 900);
    return () => window.clearTimeout(id);
  }, [playing, idx, frames.length]);

  const run = (kind: "insert" | "delete" | "find" | "scan", k: number) => {
    const out: Frame[] = [];
    const color = new Map<number, string>();
    const chain = new Map<number, string>();
    let mark: Frame["mark"];
    let prevScan: number | null = null;
    t.resetStats();
    t.listener = (e) => {
      const snap = t.snapshot();
      switch (e.t) {
        case "visit": color.set(e.id, C.path); break;
        case "insert": case "update": color.set(e.id, C.changed); mark = { key: e.key, color: C.changed }; break;
        case "found": mark = { key: e.key, color: C.changed }; color.set(e.id, C.changed); break;
        case "missing": color.set(e.id, C.bad); break;
        case "overflow": case "underflow": color.set(e.id, C.bad); break;
        case "split": color.set(e.id, C.changed); color.set(e.right, C.added); break;
        case "newRoot": color.set(e.id, C.added); break;
        case "remove": color.set(e.id, C.changed); mark = undefined; break;
        case "borrow": color.set(e.id, C.changed); color.set(e.from, C.donor); break;
        case "merge": color.set(e.left, C.changed); break;
        case "scan": color.set(e.id, C.changed); if (prevScan !== null) chain.set(prevScan, C.changed); prevScan = e.id; break;
        case "collapse": break;
      }
      out.push({ snap, caption: caption(e, t, snap, k), color: new Map(color), chain: new Map(chain), mark });
    };
    let summary = "";
    if (kind === "insert") {
      const isNew = t.insert(k, k);
      if (isNew) ops.current.push(["i", k]);
      summary = isNew ? `Inserted ${k}.` : `Updated ${k}.`;
    } else if (kind === "delete") {
      const had = t.delete(k);
      if (had) ops.current.push(["d", k]);
      summary = had ? `Deleted ${k}.` : `${k} was not in the tree.`;
    } else if (kind === "find") {
      summary = t.get(k) !== undefined ? `Found ${k} after reading ${t.stats.reads} nodes.` : `${k} is not in the tree.`;
    } else {
      const r = t.range(k, k + 20);
      summary = `Range ${k} to ${k + 20}: ${r.length} keys from ${t.stats.reads - t.height + 1} leaves, after one descent.`;
    }
    t.listener = null;
    out.push({ snap: t.snapshot(), caption: summary, color: kind === "scan" || kind === "find" ? color : new Map(), chain, mark: kind === "insert" ? { key: k, color: C.changed } : mark });
    setLast({ reads: t.stats.reads, writes: t.stats.writes, splits: t.stats.splits, merges: t.stats.merges, borrows: t.stats.borrows });
    setFrames(out);
    setIdx(0);
    setPlaying(true);
  };
  const randomInserts = () => {
    const added: number[] = [];
    for (let i = 0; i < 5; i++) {
      const k = 1 + Math.floor(rng.current() * 99);
      if (t.insert(k, k)) { ops.current.push(["i", k]); added.push(k); }
    }
    setFrames([{ snap: t.snapshot(), caption: added.length ? `Inserted ${added.join(", ")}.` : "All five keys were already in the tree.", color: new Map(), chain: new Map() }]);
    setIdx(0);
    setPlaying(false);
    setLast(null);
  };
  const reset = () => {
    ops.current = INITIAL.map((k) => ["i", k] as Op);
    tree.current = buildTree(order, ops.current);
    setFrames([]);
    setLast(null);
  };

  const f = frames[idx];
  const snap = f?.snap ?? t.snapshot();
  const toView = (s: SnapNode<number>): ViewNode => ({ id: s.id, leaf: s.leaf, keys: s.keys, kids: s.kids?.map(toView) });
  return (
    <Demo
      title={`B+ tree of order ${order}: at most ${order - 1} keys per node`}
      actions={
        <>
          <button className="btn primary" onClick={() => run("insert", key)}>Insert {key}</button>
          <button className="btn" onClick={() => run("delete", key)}>Delete {key}</button>
          <button className="btn" onClick={() => run("find", key)}>Find</button>
          <button className="btn" onClick={() => run("scan", key)}>Scan {key}–{key + 20}</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Order (max children)", min: 3, max: 8, step: 1, default: 4 })} value={order} onChange={(v) => setOrder(v as number)} />
          <Param spec={range({ label: "Key", min: 1, max: 99, step: 1, default: 40 })} value={key} onChange={(v) => setKey(v as number)} />
          <div className="row" style={{ alignSelf: "end" }}>
            <button className="btn" onClick={randomInserts}>Insert 5 random keys</button>
            <button className="btn ghost" onClick={reset}>Reset</button>
          </div>
        </>
      }
    >
      <TreeView
        root={toView(snap)}
        color={f?.color}
        chainColor={f?.chain}
        keyColor={(_id, k) => (f?.mark && f.mark.key === k ? f.mark.color : undefined)}
        cell={order >= 7 ? 20 : 22}
      />
      <div style={{ ...mono, minHeight: 44, marginTop: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--subtle)", lineHeight: 1.45 }}>
        {f ? f.caption : "Pick a key and press Insert, Delete, Find or Scan. Every step of the operation plays here."}
      </div>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <div className="row">
          <button className="btn" disabled={!frames.length || idx === 0} onClick={() => { setPlaying(false); setIdx(idx - 1); }}>Back</button>
          <button className="btn" disabled={!frames.length || idx >= frames.length - 1} onClick={() => { setPlaying(false); setIdx(idx + 1); }}>Next</button>
          <button className="btn ghost" disabled={!frames.length || idx >= frames.length - 1} onClick={() => { setPlaying(false); setIdx(frames.length - 1); }}>End</button>
          {frames.length > 1 && <span className="muted" style={{ fontSize: 12.5 }}>step {idx + 1} of {frames.length}</span>}
        </div>
        <Legend items={[{ label: "search path", color: C.path }, { label: "changed", color: C.changed }, { label: "new node", color: C.added }, { label: "too full / too empty", color: C.bad }, { label: "sibling that lends", color: C.donor }]} />
      </div>
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "keys", value: t.size },
          { label: "height (levels)", value: t.height },
          { label: "nodes", value: t.nodeCount() },
          { label: "last op: nodes read", value: last ? last.reads : "–" },
          { label: "last op: splits / merges / borrows", value: last ? `${last.splits} / ${last.merges} / ${last.borrows}` : "–" },
        ]}
      />
    </Demo>
  );
}

// ============================================================================
// Lesson 1: height and I/O calculator
// ============================================================================

const PAGES = [
  { bytes: 4096, label: "4 KiB (SQLite, LMDB)", color: "var(--c2)" },
  { bytes: 8192, label: "8 KiB (PostgreSQL)", color: "var(--c3)" },
  { bytes: 16384, label: "16 KiB (InnoDB)", color: "var(--c1)" },
  { bytes: 65536, label: "64 KiB", color: "var(--c5)" },
] as const;

export function HeightCalcDemo() {
  const [keyBytes, setKeyBytes] = useState(8);
  const [logN, setLogN] = useState(9);
  const [fill, setFill] = useState(1);
  const [cacheMiB, setCacheMiB] = useState(64);
  const [page, setPage] = useState("16384");
  const kb = Math.round(keyBytes);
  const n = Math.round(Math.pow(10, logN));
  const xs = useMemo(() => Array.from({ length: 181 }, (_, i) => Math.pow(10, 3 + i / 20)), []);
  const lines = PAGES.map((p) => {
    const { fanout, leafCap } = pageCapacity({ pageBytes: p.bytes, keyBytes: kb, fill });
    return { ...p, pts: xs.map((x) => [x, levelSizes(x, leafCap, fanout).length] as const) };
  });
  const sel = PAGES.find((p) => String(p.bytes) === page)!;
  const model = { pageBytes: sel.bytes, keyBytes: kb, fill };
  const cap = pageCapacity(model);
  const sizes = levelSizes(n, cap.leafCap, cap.fanout);
  const upper = sizes.slice(0, -1).reduce((a, b) => a + b, 0) * sel.bytes;
  const cacheBytes = cacheMiB * 2 ** 20;
  const cached = cachedLevels(n, model, cacheBytes);
  const ios = xs.map((x) => [x, levelSizes(x, cap.leafCap, cap.fanout).length - cachedLevels(x, model, cacheBytes)] as const);
  return (
    <Demo
      title="Levels of a B+ tree, and page reads per lookup"
      controls={
        <>
          <Param spec={range({ label: "Key size", min: 4, max: 256, log: true, default: 8, format: (v) => `${Math.round(v)} B` })} value={keyBytes} onChange={(v) => setKeyBytes(v as number)} />
          <Param spec={range({ label: "Number of keys N", min: 3, max: 12, step: 0.1, default: 9, format: (v) => fmtN(Math.round(Math.pow(10, v))) })} value={logN} onChange={(v) => setLogN(v as number)} />
          <Param spec={range({ label: "Average page fill", min: 0.5, max: 1, step: 0.01, default: 1, format: (v) => pct(v, 0) })} value={fill} onChange={(v) => setFill(v as number)} />
          <Param spec={range({ label: "Buffer pool (cache)", min: 1, max: 65536, log: true, default: 64, format: (v) => bytes(Math.round(v) * 2 ** 20) })} value={cacheMiB} onChange={(v) => setCacheMiB(v as number)} />
          <Param spec={select({ label: "Page size for the numbers", options: PAGES.map((p) => ({ value: String(p.bytes), label: bytes(p.bytes) })), default: "16384", segmented: true })} value={page} onChange={(v) => setPage(v as string)} />
        </>
      }
    >
      <Plot x={[1e3, 1e12]} y={[0, 9]} logX height={240} xLabel="number of keys N" yLabel="levels" xTicks={[1e3, 1e6, 1e9, 1e12]} xFormat={fmtN} yTicks={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}>
        {lines.map((l) => <Line key={l.bytes} points={l.pts} color={l.color} width={String(l.bytes) === page ? 2.6 : 1.4} />)}
        <Line points={ios} color={sel.color} width={1.6} dash="5 4" />
        <RuleX at={n} />
      </Plot>
      <Legend items={[...PAGES.map((p) => ({ label: p.label, color: p.color })), { label: `storage reads per lookup, ${bytes(sel.bytes)} pages (dashed)`, color: "var(--muted)" }]} />
      <div style={{ height: 12 }} />
      <Stats
        items={[
          { label: "fanout (children per node)", value: cap.fanout },
          { label: "keys per leaf", value: cap.leafCap },
          { label: `levels for ${fmtN(n)} keys`, value: sizes.length },
          { label: "nodes per level (root first)", value: <span style={{ fontSize: 13 }}>{sizes.map((s) => s.toLocaleString("en-US")).join(" · ")}</span> },
          { label: "all levels above the leaves", value: bytes(upper) },
          { label: "storage reads per lookup", value: sizes.length - cached },
        ]}
      />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Model: 128-byte page header; each entry is the key, an 8-byte pointer or value and a 2-byte slot. The buffer pool keeps the top levels that fit.
      </p>
    </Demo>
  );
}

// ============================================================================
// Lesson 1: cache lines per lookup, binary tree vs B+ tree nodes
// ============================================================================

export function CacheLinesDemo() {
  const [logN, setLogN] = useState(9);
  const [kb, setKb] = useState("8");
  const n = Math.round(Math.pow(10, logN));
  const k = Number(kb);
  const sizes = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
  const pts = sizes.map((s) => ({ s, ...btreeLookupLines(n, s, k, 8) }));
  const bst = bstDepth(n);
  const best = pts.reduce((a, b) => (b.lines < a.lines ? b : a));
  const maxY = Math.max(bst, ...pts.map((p) => p.lines)) * 1.15;
  return (
    <Demo
      title="Cache lines touched by one lookup in memory"
      controls={
        <>
          <Param spec={range({ label: "Number of keys N", min: 3, max: 10, step: 0.1, default: 9, format: (v) => si(Math.round(Math.pow(10, v))) })} value={logN} onChange={(v) => setLogN(v as number)} />
          <Param spec={select({ label: "Key size", options: ["4", "8", "16", "32"].map((v) => ({ value: v, label: `${v} B` })), default: "8", segmented: true })} value={kb} onChange={(v) => setKb(v as string)} />
        </>
      }
    >
      <Plot x={[64, 16384]} y={[0, maxY]} logX height={230} xLabel="node size" yLabel="cache lines per lookup" xTicks={sizes} xFormat={(v) => (v >= 1024 ? `${v / 1024}K` : String(v))}>
        <RuleY at={bst} color="var(--c4)" label={`binary search tree: ${bst} lines`} />
        <Line points={pts.map((p) => [p.s, p.lines] as const)} color="var(--c1)" />
        <Dots points={pts.map((p) => [p.s, p.lines] as const)} color="var(--c1)" />
        <Dots points={[[best.s, best.lines]]} color="var(--c3)" r={5} />
      </Plot>
      <Legend items={[{ label: "B+ tree: levels × lines per node", color: "var(--c1)" }, { label: "binary search tree: one line per node", color: "var(--c4)" }]} />
      <div style={{ height: 10 }} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ fontSize: 12.5, borderCollapse: "collapse", width: "100%", fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "right" }}>
              <th style={{ textAlign: "left", fontWeight: 500 }}>node</th><th style={{ fontWeight: 500 }}>fanout</th><th style={{ fontWeight: 500 }}>levels</th><th style={{ fontWeight: 500 }}>lines per node</th><th style={{ fontWeight: 500 }}>lines per lookup</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.s} style={{ textAlign: "right", borderTop: "1px solid var(--border)", color: p === best ? "var(--c3)" : undefined }}>
                <td style={{ textAlign: "left" }}>{bytes(p.s)}</td><td>{p.fanout}</td><td>{p.levels}</td><td>{p.linesPerNode.toFixed(2)}</td><td>{p.lines.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Model: 64-byte lines; a node holds its keys, then its child pointers (8 B). One visit costs the lines that binary search touches, plus the line of the chosen pointer.
      </p>
    </Demo>
  );
}

// ============================================================================
// Lesson 1: 3D shape (lazy)
// ============================================================================

const Shape3D = lazy(() => import("./BtreeShape3D").then((m) => ({ default: m.TreeShape3D })));
const Loading = ({ h }: { h: number }) => <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>;

export function TreeShapeDemo() {
  return <Suspense fallback={<Loading h={460} />}><Shape3D /></Suspense>;
}

// ============================================================================
// Lesson 2: insert order vs leaf fill
// ============================================================================

const LEAF_SIZES = [
  { value: "9", label: "8" },
  { value: "33", label: "32" },
  { value: "101", label: "100" },
];

export function FillOrderDemo() {
  const [n, setN] = useState(20000);
  const [order, setOrder] = useState("33");
  const [ins, setIns] = useState<InsertOrder>("random");
  const [split, setSplit] = useState<SplitPolicy>("half");
  const [leafFill, setLeafFill] = useState(0.9);
  const o = Number(order);
  const r = useMemo(() => fillExperiment({ order: o, n, insertOrder: ins, split, leafFill }), [o, n, ins, split, leafFill]);
  const bulk = useMemo(() => bulkExperiment({ order: o, n, fill: 1 }), [o, n]);
  // Small leaves: one bar per key count. 100-key leaves: 20 bars of 5 key counts each.
  const m = o - 1;
  const bins = m <= 32
    ? Array.from({ length: m + 1 }, (_, k) => ({ x0: (k - 0.45) / m, x1: (k + 0.45) / m, y: r.fills.filter((f) => Math.round(f * m) === k).length }))
    : fillHistogram(r.fills.map((f) => f + 1e-9), 20).map((y, i) => ({ x0: i / 20, x1: (i + 1) / 20, y }));
  const h = bins.map((b) => b.y);
  const maxY = Math.max(...h) * 1.1 || 1;
  return (
    <Demo
      title="Leaf fill after one-by-one inserts"
      controls={
        <>
          <Param spec={range({ label: "Keys inserted", min: 1000, max: 40000, step: 1000, default: 20000, format: (v) => v.toLocaleString("en-US") })} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={select({ label: "Insert order", options: [{ value: "ascending", label: "ascending" }, { value: "random", label: "random" }, { value: "descending", label: "descending" }], default: "random", segmented: true })} value={ins} onChange={(v) => setIns(v as InsertOrder)} />
          <Param spec={select({ label: "Max keys per leaf", options: LEAF_SIZES, default: "33", segmented: true })} value={order} onChange={(v) => setOrder(v as string)} />
          <Param spec={select({ label: "Split policy", options: [{ value: "half", label: "split in half" }, { value: "rightmost", label: "rightmost split" }], default: "half", segmented: true })} value={split} onChange={(v) => setSplit(v as SplitPolicy)} />
          {split === "rightmost" && <Param spec={range({ label: "Rightmost split: left page keeps", min: 0.5, max: 1, step: 0.05, default: 0.9, format: (v) => pct(v, 0) })} value={leafFill} onChange={(v) => setLeafFill(v as number)} />}
        </>
      }
    >
      <Plot x={[0, 1.04]} y={[0, maxY]} height={220} xLabel="leaf fill" yLabel="number of leaves" xFormat={(v) => pct(v, 0)} xTicks={[0, 0.25, 0.5, 0.75, 1]}>
        <Bars bins={bins} />
        <RuleX at={Math.LN2} />
        <RuleX at={r.avgFill} color="var(--c4)" dash="0" />
      </Plot>
      <Legend items={[{ label: "number of leaves per fill band", color: "var(--c1)" }, { label: `mean fill ${pct(r.avgFill, 1)}`, color: "var(--c4)" }, { label: "ln 2 = 69.3% (dashed)", color: "var(--faint)" }]} />
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "leaves", value: r.leaves.toLocaleString("en-US") },
          { label: "mean leaf fill", value: pct(r.avgFill, 1) },
          { label: "splits", value: r.splits.toLocaleString("en-US") },
          { label: "node writes", value: r.nodeWrites.toLocaleString("en-US") },
          { label: "bulk load: leaves / node writes", value: `${bulk.leaves.toLocaleString("en-US")} / ${bulk.nodeWrites.toLocaleString("en-US")}` },
        ]}
      />
    </Demo>
  );
}

// ============================================================================
// Lesson 2: bulk-load stepper
// ============================================================================

export function BulkLoadDemo() {
  const [n, setN] = useState(30);
  const [order, setOrder] = useState(4);
  const [fill, setFill] = useState(1);
  const built = useMemo(() => {
    const steps: BulkStep<number>[] = [];
    const t = BPlusTree.bulkLoad(Array.from({ length: n }, (_, i) => [i + 1, i + 1] as const), { order, fill }, (s) => steps.push(s));
    return { t, steps, snap: t.snapshot() };
  }, [n, order, fill]);
  const cmp = useMemo(() => {
    const asc = fillExperiment({ order, n, insertOrder: "ascending" });
    const rnd = fillExperiment({ order, n, insertOrder: "random" });
    return { asc, rnd };
  }, [n, order]);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = built.steps.length;
  useEffect(() => { setStep(0); setPlaying(false); }, [built]);
  useEffect(() => {
    if (!playing) return;
    if (step >= total) { setPlaying(false); return; }
    const id = window.setTimeout(() => setStep((s) => s + 1), 550);
    return () => window.clearTimeout(id);
  }, [playing, step, total]);

  const done = new Set(built.steps.slice(0, step).map((s) => s.id));
  const cur = step > 0 ? built.steps[step - 1]! : null;
  const toView = (s: SnapNode<number>): ViewNode => ({ id: s.id, leaf: s.leaf, keys: done.has(s.id) ? s.keys : [], kids: s.kids?.map(toView) });
  const faint = new Set<number>();
  const mark = (s: SnapNode<number>) => { if (!done.has(s.id)) faint.add(s.id); s.kids?.forEach(mark); };
  mark(built.snap);
  const color = new Map<number, string>();
  if (cur) color.set(cur.id, "var(--c1)");
  const consumed = built.steps.slice(0, step).filter((s) => s.level === 0).reduce((a, s) => a + s.keys.length, 0);
  const text = !cur
    ? "The input is sorted. Press Play or Next to build the tree from the bottom up."
    : cur.level === 0
      ? `Leaf ${cur.count}: take the next ${cur.keys.length} keys (${cur.keys[0]}–${cur.keys.at(-1)}), write the page once, and link it to the previous leaf.`
      : `Level ${cur.level}, node ${cur.count}: point to the next group of nodes below. Their first keys become separators ${fmtKeys(cur.keys)}.`;
  return (
    <Demo
      title="Bulk load: build the tree bottom-up from sorted keys"
      actions={
        <>
          <button className="btn primary" onClick={() => { if (step >= total) setStep(0); setPlaying(!playing); }}>{playing ? "Pause" : "Play"}</button>
          <button className="btn" disabled={playing || step >= total} onClick={() => setStep(step + 1)}>Next</button>
          <button className="btn ghost" onClick={() => { setPlaying(false); setStep(0); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Keys", min: 8, max: 60, step: 1, default: 30 })} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={range({ label: "Order (max children)", min: 3, max: 8, step: 1, default: 4 })} value={order} onChange={(v) => setOrder(v as number)} />
          <Param spec={range({ label: "Fill factor", min: 0.5, max: 1, step: 0.05, default: 1, format: (v) => pct(v, 0) })} value={fill} onChange={(v) => setFill(v as number)} />
        </>
      }
    >
      <TreeView root={toView(built.snap)} faint={faint} color={color} cell={order >= 7 ? 19 : 22} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 10 }} aria-label="sorted input">
        {Array.from({ length: n }, (_, i) => (
          <span key={i} style={{ ...mono, fontSize: 10.5, minWidth: 18, textAlign: "center", padding: "1px 0", borderRadius: 3, border: "1px solid var(--border)", color: i < consumed ? "var(--faint)" : "var(--fg)", background: i < consumed ? undefined : "var(--subtle)" }}>{i + 1}</span>
        ))}
      </div>
      <div style={{ ...mono, minHeight: 40, marginTop: 10, lineHeight: 1.45 }}>{text}</div>
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "step", value: `${step} / ${total}` },
          { label: "bulk load: node writes, splits", value: `${built.t.stats.writes}, 0` },
          { label: "ascending inserts: node writes, splits", value: `${cmp.asc.nodeWrites}, ${cmp.asc.splits}` },
          { label: "random inserts: node writes, splits", value: `${cmp.rnd.nodeWrites}, ${cmp.rnd.splits}` },
        ]}
      />
    </Demo>
  );
}

// ============================================================================
// Lesson 2: fill factor vs later growth
// ============================================================================

const GROWTH = { order: 101, n: 10000, maxExtra: 10000, steps: 20 };

export function FillFactorDemo() {
  const [fill, setFill] = useState(0.9);
  const base = GROWTH;
  const full = useMemo(() => growthCurve({ ...GROWTH, fill: 1 }), []);
  const seventy = useMemo(() => growthCurve({ ...GROWTH, fill: 0.7 }), []);
  const mine = useMemo(() => growthCurve({ ...GROWTH, fill }), [fill]);
  const pt = (c: typeof full) => c.map((p) => [p.extra / base.n, p.leaves] as const);
  const at = (c: typeof full, frac: number) => c.find((p) => p.extra >= frac * base.n) ?? c[c.length - 1]!;
  const maxY = Math.max(...full.map((p) => p.leaves), ...mine.map((p) => p.leaves), ...seventy.map((p) => p.leaves)) * 1.1;
  return (
    <Demo
      title="Fill factor: free space now, fewer splits later"
      controls={<Param spec={range({ label: "Fill factor at load time", min: 0.5, max: 1, step: 0.05, default: 0.9, format: (v) => pct(v, 0) })} value={fill} onChange={(v) => setFill(v as number)} />}
    >
      <Plot x={[0, 1]} y={[0, maxY]} height={230} xLabel="random keys added after the load (fraction of the 10,000 loaded)" yLabel="leaf pages" xFormat={(v) => pct(v, 0)}>
        <Line points={pt(full)} color="var(--c4)" width={1.5} dash="5 4" />
        <Line points={pt(seventy)} color="var(--c3)" width={1.5} dash="5 4" />
        <Line points={pt(mine)} color="var(--c1)" width={2.6} />
        <Dots points={pt(mine)} color="var(--c1)" r={2.5} />
      </Plot>
      <Legend items={[{ label: `fill ${pct(fill, 0)} (yours)`, color: "var(--c1)" }, { label: "fill 100%", color: "var(--c4)" }, { label: "fill 70%", color: "var(--c3)" }]} />
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "leaf pages after the load", value: mine[0]!.leaves },
          { label: "after +10% keys", value: at(mine, 0.1).leaves },
          { label: "splits in the first +10%", value: at(mine, 0.1).splits },
          { label: "after +100% keys", value: mine.at(-1)!.leaves },
        ]}
      />
    </Demo>
  );
}
