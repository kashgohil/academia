/** Demos for "Copy-on-write B-trees": path copying with snapshot readers, write amplification, file growth. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, Legend, range, select, si, bytes } from "../../kit";
import { CowBTree, type CowMode, type PageStatus, cowBytesPerUpdate, fileGrowth, cowDemoTree } from "../../sims/db/btree-cow";
import { TreeView, type ViewNode } from "./BtreeView";

const makeTree = cowDemoTree;

function view(t: CowBTree, txn: number): ViewNode | null {
  const r = t.roots.get(txn);
  if (r === undefined || r === null) return null;
  const go = (no: number): ViewNode => {
    const p = t.pages.get(no)!;
    return { id: no, leaf: p.leaf, keys: p.keys, kids: p.leaf ? undefined : p.kids.map(go) };
  };
  return go(r);
}

const STATUS: Record<PageStatus, { color: string; label: string }> = {
  "meta-current": { color: "var(--c3)", label: "meta page (newest)" },
  meta: { color: "var(--muted)", label: "meta page (older)" },
  header: { color: "var(--c3)", label: "commit header" },
  live: { color: "var(--c1)", label: "in the newest version" },
  pinned: { color: "var(--c5)", label: "old version, still visible" },
  waiting: { color: "var(--c4)", label: "freed, not reusable yet" },
  free: { color: "var(--faint)", label: "free: can be reused" },
  dead: { color: "var(--border)", label: "garbage (until compaction)" },
};

export function CowStepperDemo() {
  const [key, setKey] = useState(22);
  const [mode, setMode] = useState<CowMode>("reuse");
  const tree = useRef<CowBTree | null>(null);
  if (!tree.current || tree.current.mode !== mode) tree.current = makeTree(mode);
  const t = tree.current;
  const [, force] = useState(0);
  const [note, setNote] = useState("");
  const bump = () => force((x) => x + 1);
  const write = () => {
    const before = t.stats.pagesWritten;
    const existed = t.get(key) !== undefined;
    const id = t.update(key, t.lastTxn + 1);
    setNote(`Txn ${id}: ${existed ? "update" : "insert"} ${key}. Copied ${t.stats.pagesWritten - before} pages (leaf to root), then wrote the ${mode === "reuse" ? "meta page" : "commit header"}.`);
    bump();
  };
  const openReader = () => {
    const id = t.openReader();
    setNote(`Reader ${id} starts. It sees txn ${t.lastTxn} until it ends.`);
    bump();
  };
  const closeReader = (id: number) => {
    t.closeReader(id);
    setNote(`Reader ${id} ends. Pages that only it could see become free after later commits.`);
    bump();
  };
  const compact = () => {
    const { before, after } = t.compact();
    setNote(`Compaction copied the live pages to a new file: ${before} pages → ${after} pages. Open readers were closed.`);
    bump();
  };
  const reset = () => { tree.current = makeTree(mode); setNote(""); bump(); };

  const latest = view(t, t.lastTxn);
  const written = new Set(t.lastWritten);
  const liveSet = t.reachable();
  const readerTxns = [...new Set(t.readers.values())].filter((x) => x !== t.lastTxn).sort((a, b) => a - b);
  const status = t.pageStatus();
  const counts = status.reduce<Record<string, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {});
  const pageLabel = (n: ViewNode) => `p${n.id}`;
  return (
    <Demo
      title="Copy-on-write: every write copies the path to the root"
      actions={
        <>
          <button className="btn primary" onClick={write}>Write key {key}</button>
          <button className="btn" onClick={openReader} disabled={t.readers.size >= 3}>Start a reader</button>
          {mode === "append" && <button className="btn" onClick={compact}>Compact</button>}
          <button className="btn ghost" onClick={reset}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Key to write", min: 1, max: 64, step: 1, default: 22 })} value={key} onChange={(v) => setKey(v as number)} />
          <Param spec={select({ label: "Free pages", options: [{ value: "reuse", label: "reuse (LMDB)" }, { value: "append", label: "append only (CouchDB)" }], default: "reuse", segmented: true })} value={mode} onChange={(v) => { setMode(v as CowMode); setNote(""); }} />
        </>
      }
    >
      <div style={{ fontSize: 12.5, marginBottom: 4 }}>
        <b>Newest version: txn {t.lastTxn}</b> <span className="muted">· pages labeled p0, p1, … are page numbers in the file</span>
      </div>
      <TreeView root={latest} chain={false} label={pageLabel} color={new Map([...written].map((n) => [n, "var(--c1)"]))} fill={new Map([...written].map((n) => [n, "var(--c1)"]))} />
      {readerTxns.map((txn) => {
        const v = view(t, txn);
        const ids = [...t.readers.entries()].filter(([, x]) => x === txn).map(([id]) => id);
        const old = new Map<number, string>();
        for (const p of t.reachable(txn)) if (!liveSet.has(p)) old.set(p, "var(--c5)");
        return (
          <div key={txn} style={{ marginTop: 12, paddingTop: 8, borderTop: "1px dashed var(--border)" }}>
            <div className="row" style={{ justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
              <span><b style={{ color: "var(--c5)" }}>Reader {ids.join(", ")}</b> sees txn {txn}: {old.size} old pages kept alive</span>
              <span className="row">{ids.map((id) => <button key={id} className="btn ghost" onClick={() => closeReader(id)}>End reader {id}</button>)}</span>
            </div>
            <TreeView root={v} chain={false} label={pageLabel} color={old} fill={old} />
          </div>
        );
      })}
      {[...t.readers.entries()].filter(([, x]) => x === t.lastTxn).map(([id]) => (
        <div key={id} className="row" style={{ fontSize: 12.5, marginTop: 6 }}>
          <span className="muted">Reader {id} sees the newest version (txn {t.lastTxn}).</span>
          <button className="btn ghost" onClick={() => closeReader(id)}>End reader {id}</button>
        </div>
      ))}
      <div style={{ fontSize: 12.5, margin: "14px 0 4px" }}><b>The file, one square per page</b></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {status.map((st, no) => (
          <div key={no} title={`page ${no}: ${STATUS[st].label}`} style={{ width: 24, height: 20, borderRadius: 3, fontSize: 9, display: "grid", placeItems: "center", border: `1.5px solid ${STATUS[st].color}`, background: st === "free" || st === "dead" ? "var(--bg)" : "var(--subtle)", color: st === "free" || st === "dead" ? "var(--faint)" : "var(--fg)", fontVariantNumeric: "tabular-nums" }}>
            {no}
          </div>
        ))}
      </div>
      <div style={{ height: 6 }} />
      <Legend box items={(Object.keys(STATUS) as PageStatus[]).filter((k) => counts[k]).map((k) => ({ label: STATUS[k].label, color: STATUS[k].color }))} />
      {mode === "reuse" && (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          {t.meta.map((m) => (
            <div key={m.slot} style={{ fontSize: 12, padding: "4px 8px", borderRadius: 4, border: `1.5px solid ${t.currentMeta().slot === m.slot ? "var(--c3)" : "var(--border)"}` }}>
              meta p{m.slot}: txn {m.txn}, root p{m.root ?? "–"}{t.currentMeta().slot === m.slot ? " (newest)" : ""}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12.5, minHeight: 36, marginTop: 10, lineHeight: 1.45 }}>{note || "Write a key. Then start a reader, write more keys, and watch the pages that the reader keeps alive."}</div>
      <Stats
        items={[
          { label: "pages written by the last txn", value: t.lastWritten.length },
          { label: "file size (pages)", value: t.fileEnd },
          { label: "reused pages so far", value: t.stats.pagesReused },
          { label: "freed, waiting for readers", value: counts.waiting ?? 0 },
        ]}
      />
    </Demo>
  );
}

// ============================================================================
// Write amplification
// ============================================================================

const PAGE_LINES = [
  { bytes: 4096, color: "var(--c2)" },
  { bytes: 8192, color: "var(--c3)" },
  { bytes: 16384, color: "var(--c1)" },
] as const;

export function WriteAmpDemo() {
  const [rec, setRec] = useState(32);
  const [batch, setBatch] = useState(1);
  const [logN, setLogN] = useState(6);
  const b = Math.max(1, Math.round(batch));
  const r = Math.round(rec);
  const xs = useMemo(() => Array.from({ length: 121 }, (_, i) => Math.pow(10, 3 + i / 15)), []);
  const lines = PAGE_LINES.map((p) => ({ ...p, pts: xs.map((n) => [n, cowBytesPerUpdate({ n, pageBytes: p.bytes, recordBytes: r, batch: b }).bytesPerUpdate] as const) }));
  const n = Math.round(Math.pow(10, logN));
  const at = PAGE_LINES.map((p) => ({ p, m: cowBytesPerUpdate({ n, pageBytes: p.bytes, recordBytes: r, batch: b }) }));
  const maxY = Math.max(...lines.flatMap((l) => l.pts.map((q) => q[1])));
  const tickStep = 4096 * Math.max(1, Math.ceil(maxY / 4096 / 5));
  const yTicks = Array.from({ length: Math.floor((maxY * 1.08) / tickStep) + 1 }, (_, i) => i * tickStep);
  return (
    <Demo
      title="Bytes written per update by path copying"
      controls={
        <>
          <Param spec={range({ label: "Record size (key + value)", min: 16, max: 1024, log: true, default: 32, format: (v) => `${Math.round(v)} B` })} value={rec} onChange={(v) => setRec(v as number)} />
          <Param spec={range({ label: "Updates per transaction", min: 1, max: 1000, log: true, default: 1, format: (v) => String(Math.max(1, Math.round(v))) })} value={batch} onChange={(v) => setBatch(v as number)} />
          <Param spec={range({ label: "Keys in the tree", min: 3, max: 10, step: 0.1, default: 6, format: (v) => si(Math.round(Math.pow(10, v))) })} value={logN} onChange={(v) => setLogN(v as number)} />
        </>
      }
    >
      <Plot x={[1e3, 1e10]} y={[0, maxY * 1.08]} logX height={230} xLabel="keys in the tree" yLabel="bytes written per update" xTicks={[1e3, 1e5, 1e7, 1e9]} xFormat={(v) => si(v)} yFormat={(v) => bytes(v)} yTicks={yTicks}>
        {lines.map((l) => <Line key={l.bytes} points={l.pts} color={l.color} />)}
        <RuleX at={n} />
      </Plot>
      <Legend items={PAGE_LINES.map((p) => ({ label: `${bytes(p.bytes)} pages`, color: p.color }))} />
      <div style={{ height: 10 }} />
      <Stats
        items={at.map(({ p, m }) => ({
          label: `${bytes(p.bytes)} pages: height ${m.height}, ${m.pagesPerTxn.toFixed(1)} pages per txn`,
          value: `${bytes(Math.round(m.bytesPerUpdate))} = ${Math.round(m.amplification).toLocaleString("en-US")}×`,
        }))}
      />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Model: pages 69% full; each transaction writes every page it dirtied, plus one meta page. Random keys, so a batch shares only the upper levels.
      </p>
    </Demo>
  );
}

// ============================================================================
// Long readers and file growth
// ============================================================================

const GROW = { n: 2000, order: 16, updates: 400 };

export function LongReaderDemo() {
  const [from, setFrom] = useState(50);
  const [len, setLen] = useState(200);
  const to = Math.min(GROW.updates - 1, from + len);
  const none = useMemo(() => fileGrowth({ ...GROW, readerFrom: 1, readerTo: 0, mode: "reuse" }), []);
  const held = useMemo(() => fileGrowth({ ...GROW, readerFrom: from, readerTo: to, mode: "reuse" }), [from, to]);
  const app = useMemo(() => fileGrowth({ ...GROW, readerFrom: 1, readerTo: 0, mode: "append" }), []);
  const pts = (a: number[]) => a.map((y, i) => [i, y] as const);
  const maxY = Math.max(...app, ...held) * 1.05;
  return (
    <Demo
      title="One long reader stops page reuse"
      controls={
        <>
          <Param spec={range({ label: "Reader starts before update", min: 0, max: 350, step: 10, default: 50 })} value={from} onChange={(v) => setFrom(v as number)} />
          <Param spec={range({ label: "Reader stays open for", min: 0, max: 400, step: 10, default: 200, format: (v) => `${v} updates` })} value={len} onChange={(v) => setLen(v as number)} />
        </>
      }
    >
      <Plot x={[0, GROW.updates]} y={[0, maxY]} height={230} xLabel="committed updates" yLabel="file size (pages)">
        <Line points={pts(app)} color="var(--c2)" dash="5 4" />
        <Line points={pts(none)} color="var(--c3)" />
        <Line points={pts(held)} color="var(--c4)" width={2.4} />
        <RuleX at={from} label="reader starts" />
        <RuleX at={to + 1} label="ends" />
      </Plot>
      <Legend items={[{ label: "reuse, with the long reader", color: "var(--c4)" }, { label: "reuse, no reader", color: "var(--c3)" }, { label: "append only, no reuse", color: "var(--c2)" }]} />
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "file size at the start", value: held[0]! },
          { label: "at the end, no reader", value: none.at(-1)! },
          { label: "at the end, with the reader", value: held.at(-1)! },
          { label: "at the end, append only", value: app.at(-1)! },
        ]}
      />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        2,000 keys, order 16 (height 3). Each update is its own transaction on a random key. The file never shrinks: free pages stay inside it for later reuse.
      </p>
    </Demo>
  );
}
