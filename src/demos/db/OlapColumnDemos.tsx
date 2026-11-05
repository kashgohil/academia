/** Demos for "Column stores": a byte-level layout visualizer, a bytes-read sweep and a 3D table block. */
import { lazy, Suspense, useMemo, useState } from "react";
import { Demo, Stats, Param, Legend, range, Plot, Line, RuleX, Dots, bytes, pct, MiniTable, Note, int, mono, seg } from "../../kit";
import {
  Layout, footprint, cellsOf, ORDERS, QUERIES, CACHE_LINE, scanFootprint, pointFootprint, wideSchema,
  type LayoutKind, type QueryName,
} from "../../sims/db/olap";

const KIND_LABEL: Record<LayoutKind, string> = { nsm: "NSM (rows)", dsm: "DSM (columns)", pax: "PAX" };
const LETTER = ["i", "d", "c", "p", "q", "$", "%"];
const KINDS: LayoutKind[] = ["nsm", "dsm", "pax"];

function PageView({ L, page, need, lines, read, cell }: { L: Layout; page: number; need: Set<string>; lines: Set<string>; read: boolean; cell: number }) {
  const nLines = L.pageBytes / CACHE_LINE;
  const lh = 13, left = 14;
  const W = left + CACHE_LINE * cell + 2;
  const H = nLines * lh + 2;
  const vals = L.cellsOfPage(page).map(([r, c]) => ({ r, c, p: L.place(r, c) }));
  const first = vals[0], last = vals[vals.length - 1];
  const label = L.kind === "dsm"
    ? `page ${page}: ${ORDERS[first?.c ?? 0]!.name}, rows ${first?.r}–${last?.r}`
    : `page ${page}: rows ${first?.r}–${last?.r}`;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ ...mono, fontSize: 10.5, color: read ? "var(--fg)" : "var(--muted)", fontWeight: read ? 600 : 400 }}>{label}{read ? " · read from disk" : ""}</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W * 1.6, height: "auto", display: "block" }}>
        <rect x={left - 1} y={0.5} width={CACHE_LINE * cell + 1} height={H - 1} fill="none" stroke={read ? "var(--c3)" : "var(--border)"} strokeWidth={read ? 1.5 : 1} rx={2} />
        {Array.from({ length: nLines }, (_, l) => {
          const hot = lines.has(`${page}:${l}`);
          return <rect key={l} x={1} y={1 + l * lh + 2} width={8} height={lh - 4} rx={1.5} fill={hot ? "var(--c2)" : "var(--subtle)"} />;
        })}
        {vals.map(({ r, c, p }) => {
          const l = Math.floor(p.offset / CACHE_LINE), x = left + (p.offset % CACHE_LINE) * cell, y = 1 + l * lh;
          const on = need.has(`${r},${c}`);
          const w = p.bytes * cell;
          return (
            <g key={`${r},${c}`}>
              <rect x={x + 0.4} y={y + 1} width={w - 0.8} height={lh - 2} rx={1} fill={on ? "var(--c1)" : "var(--subtle)"} stroke={on ? "none" : "var(--border)"} strokeWidth={0.6} />
              {w >= 9 && <text x={x + w / 2} y={y + lh / 2 + 3} textAnchor="middle" fontSize={8} fill={on ? "var(--bg)" : "var(--muted)"} style={mono}>{L.kind === "dsm" ? r : LETTER[c]}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function LayoutDemo() {
  const [rows, setRows] = useState(32);
  const [pageStr, setPage] = useState<"128" | "256">("128");
  const [kind, setKind] = useState<LayoutKind>("nsm");
  const [q, setQ] = useState<QueryName>("sum");
  const pageBytes = Number(pageStr);
  const def = QUERIES[q];
  const all = useMemo(() => KINDS.map((k) => {
    const L = new Layout(k, ORDERS, rows, pageBytes);
    return { k, L, f: footprint(L, cellsOf(def.rows(rows), def.cols)) };
  }), [rows, pageBytes, def]);
  const cur = all.find((x) => x.k === kind)!;
  const need = useMemo(() => new Set(cellsOf(def.rows(rows), def.cols).map(([r, c]) => `${r},${c}`)), [def, rows]);
  const cell = 5;
  return (
    <Demo
      title="The same table in three page layouts"
      controls={
        <>
          <Param spec={range({ label: "Rows in the table", min: 8, max: 32, step: 4, default: 32 })} value={rows} onChange={(v) => setRows(v as number)} />
          <Param spec={seg<QueryName>("Query", [["sum", "SUM(price)"], ["filter", "3 columns"], ["point", "one row"], ["insert", "insert"]], "sum")} value={q} onChange={(v) => setQ(v as QueryName)} />
          <Param spec={seg<LayoutKind>("Layout", [["nsm", "NSM"], ["dsm", "DSM"], ["pax", "PAX"]], "nsm")} value={kind} onChange={(v) => setKind(v as LayoutKind)} />
          <Param spec={seg<"128" | "256">("Page size", [["128", "128 B"], ["256", "256 B"]], "128")} value={pageStr} onChange={(v) => setPage(v as "128" | "256")} />
        </>
      }
    >
      <div style={{ ...mono, fontSize: 12, marginBottom: 6 }}>{def.sql}</div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Each row is 32 bytes: id, date, customer, product, qty and discount are 4 bytes, price is 8. Each strip is one 64-byte cache line.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 330px), 1fr))", gap: "0 14px" }}>
        {Array.from({ length: cur.L.pageCount }, (_, p) => (
          <PageView key={`${kind}-${pageBytes}-${p}`} L={cur.L} page={p} need={need} lines={cur.f.lineKeys} read={cur.f.pageIds.has(p)} cell={cell} />
        ))}
      </div>
      <Legend box items={[{ label: "value the query needs", color: "var(--c1)" }, { label: "cache line touched", color: "var(--c2)" }, { label: "page read", color: "var(--c3)" }]} />
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4, ...mono }}>i id · d date · c customer · p product · q qty · $ price · % discount{kind === "dsm" ? " · in DSM a cell shows its row number" : ""}</div>
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["layout", "needed", "pages", "disk", "lines", "useful"]}
          highlight={KINDS.indexOf(kind)}
          rows={all.map(({ k, f }) => [KIND_LABEL[k], `${f.usefulBytes} B`, f.pages, `${f.diskBytes} B`, f.lines, pct(f.usefulBytes / f.diskBytes, 0)])}
        />
      </div>
    </Demo>
  );
}

// ---------------- bytes read vs columns selected ----------------

type Measure = "disk" | "memory" | "point";
const ROWS = 1e8;
const PAGE = 8192;
const GB = 1e9;

export function BytesReadDemo() {
  const [ncols, setNcols] = useState(100);
  const [k, setK] = useState(3);
  const [m, setM] = useState<Measure>("disk");
  const kk = Math.min(k, ncols);
  const schema = useMemo(() => wideSchema(ncols), [ncols]);
  const series = useMemo(() => {
    const xs = Array.from({ length: ncols }, (_, i) => i + 1);
    const val = (kind: LayoutKind, x: number) => {
      const cols = Array.from({ length: x }, (_, i) => i);
      if (m === "point") return pointFootprint(kind, schema, ROWS, PAGE, cols, 12_345).pages;
      const f = scanFootprint(kind, schema, ROWS, PAGE, cols);
      return (m === "disk" ? f.diskBytes : f.memoryBytes) / GB;
    };
    return Object.fromEntries(KINDS.map((kind) => [kind, xs.map((x) => [x, val(kind, x)] as [number, number])])) as Record<LayoutKind, [number, number][]>;
  }, [ncols, m, schema]);
  const at = (kind: LayoutKind) => series[kind][kk - 1]![1];
  const ymax = Math.max(...KINDS.map((kind) => Math.max(...series[kind].map((p) => p[1])))) * 1.08;
  const unit = m === "point" ? "pages" : "GB";
  const show = (v: number) => (m === "point" ? int(v) : `${v.toFixed(v < 10 ? 2 : 1)} GB`);
  const colors: Record<LayoutKind, string> = { nsm: "var(--c2)", dsm: "var(--c1)", pax: "var(--c4)" };
  return (
    <Demo
      title="Bytes a query reads, as it selects more columns"
      controls={
        <>
          <Param spec={range({ label: "Columns the query reads", min: 1, max: ncols, step: 1, default: 3 })} value={kk} onChange={(v) => setK(v as number)} />
          <Param spec={range({ label: "Columns in the table", min: 10, max: 200, step: 10, default: 100 })} value={ncols} onChange={(v) => setNcols(v as number)} />
          <Param spec={seg<Measure>("Measure", [["disk", "disk bytes, scan"], ["memory", "memory traffic, scan"], ["point", "pages, fetch one row"]], "disk")} value={m} onChange={(v) => setM(v as Measure)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>100 million rows, 8-byte columns, 8 KiB pages. The query reads the first k columns.</div>
      <Plot x={[1, ncols]} y={[0, ymax || 1]} height={250} xLabel="columns read" yLabel={unit}>
        {(["nsm", "pax", "dsm"] as LayoutKind[]).map((kind) => <Line key={kind} points={series[kind]} color={colors[kind]} width={2} dash={kind === "pax" ? "5 3" : undefined} />)}
        <RuleX at={kk} />
        <Dots points={KINDS.map((kind) => [kk, at(kind)] as [number, number])} color="var(--fg)" r={3} />
      </Plot>
      <Legend items={KINDS.map((kind) => ({ label: KIND_LABEL[kind], color: colors[kind] }))} />
      <Stats
        items={[
          { label: `NSM, ${kk} column${kk > 1 ? "s" : ""}`, value: show(at("nsm")) },
          { label: "DSM", value: show(at("dsm")) },
          { label: "PAX", value: show(at("pax")) },
          { label: "table size", value: bytes(ROWS * ncols * 8) },
        ]}
      />
      <Note>
        {m === "disk" && "A row store must read every page, so its line is flat. PAX pages hold whole rows, so on disk PAX is a row store."}
        {m === "memory" && "Inside a PAX page each column is contiguous, so the cache sees column-store traffic. A wide NSM row still costs one line per 8 columns."}
        {m === "point" && "To rebuild one row, a column store visits one page per column. This is the tuple reconstruction cost."}
      </Note>
    </Demo>
  );
}

// ---------------- 3D (lazy) ----------------

const Block3D = lazy(() => import("./Olap3D").then((x) => ({ default: x.TableBlock3D })));
const Loading = ({ h }: { h: number }) => <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>;
export function TableBlockDemo() {
  return <Suspense fallback={<Loading h={480} />}><Block3D /></Suspense>;
}
