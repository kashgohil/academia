/** Demos for "Secondary and covering indexes": planner toy, selectivity sweep, clustered vs heap lookups. */
import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Param, range, select, toggle, Plot, Line, RuleX, Legend, pct } from "../../kit";
import {
  planQuery, pathCosts, crossover, ORDERS_MODEL, DEFAULT_COSTS, SSD_COSTS, TOY_PREDS, buildWorld, lookupTrace, scaleReads, USER_ROWS,
  HEAP_ROWS_PER_PAGE, type Col, type PredCol, type ToyQuery, type ToyPlan, type Engine, type LookupKind, type SweepPoint, type PageRead,
} from "../../sims/db/indexes/secondary";
import type { SnapNode } from "../../sims/db/btree";
import { TreeView, type ViewNode } from "./BtreeView";
import { seg, mono, Note, Caption, fx, int, StepText, StepButtons, useFrames, Chip } from "./IndexesUi";

// ============================================================================
// Planner toy
// ============================================================================

const KEY_OPTS: { value: string; label: string }[] = [
  { value: "", label: "(none)" },
  ...(["customer_id", "status", "created_at", "amount", "id"] as const).map((c) => ({ value: c, label: c })),
];
const SELECTS: Record<string, ToyQuery["select"]> = { star: "*", narrow: ["customer_id", "created_at"], cover: ["customer_id", "created_at", "amount"] };
const USE_COLOR: Record<string, string> = { "seek =": "var(--c1)", "seek range": "var(--c2)", "index filter": "var(--c5)", unused: "var(--faint)" };

export function PlannerToyDemo() {
  const [k1, setK1] = useState("customer_id");
  const [k2, setK2] = useState("created_at");
  const [k3, setK3] = useState("");
  const [inc, setInc] = useState(false);
  const [where, setWhere] = useState<Record<PredCol, boolean>>({ customer_id: false, status: false, created_at: true, amount: false });
  const [orderBy, setOrderBy] = useState("created_at");
  const [sel, setSel] = useState("star");
  const [limit, setLimit] = useState(false);
  const key = [k1, k2, k3].filter((c, i, a) => c && a.indexOf(c) === i) as Col[];
  const q: ToyQuery = { where: (Object.keys(where) as PredCol[]).filter((c) => where[c]), orderBy: orderBy ? (orderBy as Col) : null, select: SELECTS[sel]!, limit: limit ? 10 : null };
  const plan = planQuery(key.length ? { key, include: inc ? ["amount"] : [] } : null, q);
  const sql = `SELECT ${q.select === "*" ? "*" : q.select.join(", ")} FROM orders${q.where.length ? ` WHERE ${q.where.map((w) => TOY_PREDS[w].sql).join(" AND ")}` : ""}${q.orderBy ? ` ORDER BY ${q.orderBy}` : ""}${q.limit ? ` LIMIT ${q.limit}` : ""};`;
  const ddl = key.length ? `CREATE INDEX ON orders (${key.join(", ")})${inc ? " INCLUDE (amount)" : ""};` : "-- no index";
  const maxCost = Math.max(...plan.paths.map((p) => p.cost));
  return (
    <Demo
      title="Which part of a composite index can a query use?"
      controls={
        <>
          <Param spec={select({ label: "Index column 1", options: KEY_OPTS, default: "customer_id" })} value={k1} onChange={(v) => setK1(v as string)} />
          <Param spec={select({ label: "Index column 2", options: KEY_OPTS, default: "created_at" })} value={k2} onChange={(v) => setK2(v as string)} />
          <Param spec={select({ label: "Index column 3", options: KEY_OPTS, default: "" })} value={k3} onChange={(v) => setK3(v as string)} />
          <Param spec={toggle({ label: "INCLUDE (amount)", default: false })} value={inc} onChange={(v) => setInc(v as boolean)} />
          {(Object.keys(TOY_PREDS) as PredCol[]).map((c) => (
            <Param key={c} spec={toggle({ label: `WHERE ${TOY_PREDS[c].sql}`, default: c === "created_at" })} value={where[c]} onChange={(v) => setWhere({ ...where, [c]: v as boolean })} />
          ))}
          <Param spec={seg("ORDER BY", [["", "none"], ["created_at", "created_at"], ["amount", "amount"]], "created_at")} value={orderBy} onChange={(v) => setOrderBy(v as string)} />
          <Param spec={seg("SELECT", [["star", "*"], ["narrow", "customer_id, created_at"], ["cover", "customer_id, created_at, amount"]], "star")} value={sel} onChange={(v) => setSel(v as string)} />
          <Param spec={toggle({ label: "LIMIT 10", default: false })} value={limit} onChange={(v) => setLimit(v as boolean)} />
        </>
      }
    >
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        <div className="muted">{ddl}</div>
        <div>{sql}</div>
      </div>
      <Caption>Index columns, left to right</Caption>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {key.length ? key.map((c, i) => (
          <span key={c} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <Chip color={USE_COLOR[plan.use[i]!]} fill={plan.use[i] !== "unused"}>{c}</Chip>
            <span className="muted" style={{ fontSize: 10.5 }}>{plan.use[i]}</span>
          </span>
        )) : <span className="muted" style={{ fontSize: 12.5 }}>no index</span>}
        {inc && key.length > 0 && <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}><Chip>amount</Chip><span className="muted" style={{ fontSize: 10.5 }}>payload</span></span>}
      </div>
      <Caption>Plan</Caption>
      <PlanText plan={plan} q={q} />
      <Caption>Estimated cost of each access path (log scale)</Caption>
      <div style={{ display: "grid", gap: 4 }}>
        {plan.paths.map((p) => (
          <div key={p.name} style={{ display: "grid", gridTemplateColumns: "minmax(0, 9.5em) minmax(0, 1fr) 5.5em", gap: 8, alignItems: "center", fontSize: 12.5, opacity: p.available ? 1 : 0.45 }} title={p.why}>
            <span style={{ fontWeight: p === plan.best ? 700 : 400 }}>{p.name}{!p.sorted && q.orderBy && p.available ? " + Sort" : ""}</span>
            <div style={{ height: 10, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div style={{ width: `${p.available ? (100 * Math.log10(1 + p.cost)) / Math.log10(1 + maxCost) : 0}%`, height: "100%", background: p === plan.best ? "var(--c3)" : "var(--c1)", transition: "width 0.25s" }} />
            </div>
            <span style={{ ...mono, textAlign: "right" }}>{p.available ? int(p.cost) : "n/a"}</span>
          </div>
        ))}
      </div>
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "rows that match", value: int(plan.rows) },
          { label: "index range read", value: plan.indexCond.length ? pct(plan.boundSel, plan.boundSel < 0.001 ? 3 : 1) : "whole index" },
          { label: "covering", value: plan.covered ? "yes" : plan.missing.length ? `no: ${plan.missing.slice(0, 3).join(", ")}${plan.missing.length > 3 ? "…" : ""}` : "no" },
          { label: "order from index", value: q.orderBy ? (plan.orderByIndex ? "yes" : "no: sort") : "–" },
        ]}
      />
      <Note>Table: 1 M rows in {int(ORDERS_MODEL.pages)} pages of 8 KiB; the index has {int(ORDERS_MODEL.indexPages)} leaf pages. Costs follow PostgreSQL's formulas with its default settings; created_at follows the physical row order (correlation 0.95).</Note>
    </Demo>
  );
}

function PlanText({ plan, q }: { plan: ToyPlan; q: ToyQuery }) {
  const b = plan.best;
  const ixf = plan.indexFilter.join(" AND ");
  const hf = plan.heapFilter.join(" AND ");
  const allIx = [...plan.indexCond, ...plan.indexFilter].join(" AND ");
  // Plan nodes from the top down; each has a title and detail lines.
  const nodes: { title: string; details: string[] }[] = [];
  if (q.limit) nodes.push({ title: `Limit (${q.limit} rows)`, details: [] });
  if (q.orderBy && !b.sorted) nodes.push({ title: `Sort (key: ${q.orderBy}${q.limit ? ", top-N heap" : ""})`, details: [] });
  if (b.name === "Seq Scan") nodes.push({ title: "Seq Scan on orders", details: q.where.length ? [`Filter: ${q.where.map((w) => TOY_PREDS[w].sql).join(" AND ")}`] : [] });
  else if (b.name === "Bitmap Heap Scan") {
    nodes.push({ title: "Bitmap Heap Scan on orders", details: [`Recheck Cond: ${allIx}`, ...(hf ? [`Filter: ${hf}`] : [])] });
    nodes.push({ title: "Bitmap Index Scan on orders_idx", details: [`Index Cond: ${allIx}`] });
  } else nodes.push({ title: `${b.name} using orders_idx on orders`, details: [...(allIx ? [`Index Cond: ${allIx}`] : []), ...(hf ? [`Filter: ${hf}`] : [])] });
  const text = nodes.map((n, i) => {
    const pad = "  ".repeat(i * 2);
    const head = `${pad}${i ? "->  " : ""}${n.title}`;
    return [head, ...n.details.map((d) => `${pad}${i ? "    " : ""}  ${d}`)].join("\n");
  }).join("\n");
  return (
    <div>
      <pre style={{ ...mono, fontSize: 11.5, margin: 0, padding: "8px 10px", background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</pre>
      {b.name !== "Seq Scan" && ixf && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{ixf} is checked on each index entry, but it does not narrow the range that the scan reads{plan.indexCond.length ? "" : ": the scan reads the whole index"}.</div>}
    </div>
  );
}

// ============================================================================
// Selectivity sweep
// ============================================================================

const SELS = Array.from({ length: 61 }, (_, i) => Math.pow(10, -6 + i / 10));

export function SelectivityDemo() {
  const [s, setS] = useState(0.01);
  const [corr, setCorr] = useState(0);
  const [disk, setDisk] = useState<"hdd" | "ssd">("hdd");
  const [vis, setVis] = useState(1);
  const c = disk === "hdd" ? DEFAULT_COSTS : SSD_COSTS;
  const m = ORDERS_MODEL;
  const pts = useMemo(() => SELS.map((x) => pathCosts(m, x, { correlation: corr, allVisible: vis }, c)), [corr, vis, c, m]);
  const line = (k: keyof SweepPoint) => pts.map((p) => [p.sel, p[k]] as const);
  const f = (k: keyof SweepPoint) => (x: number) => pathCosts(m, x, { correlation: corr, allVisible: vis }, c)[k];
  const xIdx = crossover(f("index"), f("seq"));
  const xBmp = crossover(f("bitmap"), f("seq"));
  const here = pathCosts(m, s, { correlation: corr, allVisible: vis }, c);
  const best = (["seq", "index", "bitmap"] as const).reduce((a, b) => (here[b] < here[a] ? b : a));
  const names = { seq: "Seq Scan", index: "Index Scan", bitmap: "Bitmap Heap Scan" };
  const maxY = Math.max(...pts.map((p) => Math.max(p.seq, p.index, p.bitmap)));
  return (
    <Demo
      title="Index scan, bitmap scan or sequential scan?"
      controls={
        <>
          <Param spec={range({ label: "Selectivity (share of rows)", min: 1e-6, max: 1, log: true, default: 0.01, format: (v) => pct(v, v < 1e-3 ? 4 : v < 0.01 ? 2 : 1) })} value={s} onChange={(v) => setS(v as number)} />
          <Param spec={range({ label: "Correlation: index order vs heap order", min: 0, max: 1, step: 0.05, default: 0, format: (v) => fx(v, 2) })} value={corr} onChange={(v) => setCorr(v as number)} />
          <Param spec={seg<"hdd" | "ssd">("random_page_cost", [["hdd", "4 (default)"], ["ssd", "1.1 (SSD tuning)"]], "hdd")} value={disk} onChange={(v) => setDisk(v as "hdd" | "ssd")} />
          <Param spec={range({ label: "Heap pages all-visible (index-only scan)", min: 0, max: 1, step: 0.05, default: 1, format: (v) => pct(v, 0) })} value={vis} onChange={(v) => setVis(v as number)} />
        </>
      }
    >
      <Plot x={[1e-6, 1]} y={[1, maxY * 1.5]} logX logY height={270} xLabel="selectivity" yLabel="estimated cost" xTicks={[1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1]} xFormat={(v) => (v >= 0.01 ? pct(v, 0) : v >= 1e-4 ? pct(v, 2) : `${v.toExponential(0)}`)} yTicks={[1, 10, 100, 1e3, 1e4, 1e5]} yFormat={(v) => (v >= 1000 ? `${v / 1000}k` : String(v))}>
        <Line points={line("seq")} color="var(--c4)" />
        <Line points={line("index")} color="var(--c1)" />
        <Line points={line("bitmap")} color="var(--c2)" />
        <Line points={line("indexOnly")} color="var(--c3)" dash="5 4" />
        {xIdx && <RuleX at={xIdx} color="var(--c1)" />}
        {xBmp && <RuleX at={xBmp} color="var(--c2)" />}
        <RuleX at={s} color="var(--fg)" dash="2 2" />
      </Plot>
      <Legend items={[{ label: "Seq Scan", color: "var(--c4)" }, { label: "Index Scan", color: "var(--c1)" }, { label: "Bitmap Heap Scan", color: "var(--c2)" }, { label: "Index Only Scan (dashed)", color: "var(--c3)" }]} />
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "rows at this selectivity", value: int(s * m.rows) },
          { label: "cheapest of the three", value: names[best] },
          { label: "index scan loses above", value: xIdx ? pct(xIdx, xIdx < 0.01 ? 2 : 1) : "never" },
          { label: "bitmap scan loses above", value: xBmp ? pct(xBmp, 1) : "never" },
          { label: "costs: seq / index / bitmap", value: <span style={{ fontSize: 13 }}>{int(here.seq)} / {int(here.index)} / {int(here.bitmap)}</span> },
        ]}
      />
      <Note>Model: {int(m.rows)} rows of 100 bytes in {int(m.pages)} heap pages, a B-tree with {int(m.indexPages)} leaves, effective_cache_size 4 GB. A vertical line marks each crossover with the sequential scan.</Note>
    </Demo>
  );
}

// ============================================================================
// Clustered (InnoDB) vs heap + TID (PostgreSQL)
// ============================================================================

const name = (e: string) => e.split("@")[0]!;
const QUERIES: [LookupKind, string][] = [["pk", "WHERE id = 17"], ["email", "WHERE email = ? SELECT *"], ["email-id", "WHERE email = ? SELECT id"], ["email-range", "email from a to f, SELECT *"]];

function toView<K>(s: SnapNode<K>, fmt: (k: K) => string | number): ViewNode {
  return { id: s.id, leaf: s.leaf, keys: s.keys.map(fmt), kids: s.kids?.map((k) => toView(k, fmt)) };
}

export function ClusteredLookupDemo() {
  const [engine, setEngine] = useState<Engine>("innodb");
  const [kind, setKind] = useState<LookupKind>("email");
  const [email, setEmail] = useState("max@x.io");
  const [allVis, setAllVis] = useState(true);
  const w = useMemo(() => buildWorld(engine), [engine]);
  const trace = useMemo(() => lookupTrace(w, kind, { id: 17, email, lo: "a", hi: "f" }, allVis), [w, kind, email, allVis]);
  const st = useFrames<number>(700);
  useEffect(() => { st.start(trace.map((_, i) => i + 1), true); }, [trace]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = st.cur ?? 0;
  const done = trace.slice(0, n);
  const cur: PageRead | undefined = trace[n - 1];
  const colorFor = (s: PageRead["s"]) => {
    const m = new Map<number | string, string>();
    for (const r of done) if (r.s === s) m.set(r.node, "var(--c1)");
    if (cur && cur.s === s) m.set(cur.node, "var(--c3)");
    return m;
  };
  const primSnap = useMemo(() => toView(w.primary.snapshot(), (k) => k), [w]);
  const secSnap = useMemo(() => {
    // Leaf notes show what each entry points to: the primary key (InnoDB) or the TID (PostgreSQL).
    const val = new Map(w.secondary.entries());
    const fmtV = (v: number) => (engine === "innodb" ? String(v) : `${Math.floor(v / 100)},${v % 100}`);
    const add = (s: SnapNode<string>): ViewNode => ({ id: s.id, leaf: s.leaf, keys: s.keys.map(name), note: s.leaf ? `→ ${s.keys.map((k) => fmtV(val.get(k)!)).join(engine === "innodb" ? " " : " | ")}` : undefined, kids: s.kids?.map(add) });
    return add(w.secondary.snapshot());
  }, [w, engine]);
  const usesSec = kind !== "pk";
  const heapRead = new Set(done.filter((r) => r.s === "heap").map((r) => r.node));
  const pages = Math.ceil(USER_ROWS.length / HEAP_ROWS_PER_PAGE);
  const big = scaleReads(1e8, { pkBytes: 8, secKeyBytes: 32, rowBytes: 200, pageBytes: engine === "innodb" ? 16384 : 8192 });
  const counts = { secondary: 0, primary: 0, heap: 0, vm: 0 };
  for (const r of trace) counts[r.s]++;
  return (
    <Demo
      title={engine === "innodb" ? "InnoDB: secondary index → primary key → clustered index" : "PostgreSQL: index → TID → heap page"}
      controls={
        <>
          <Param spec={seg<Engine>("Engine", [["innodb", "InnoDB"], ["postgres", "PostgreSQL"]], "innodb")} value={engine} onChange={(v) => setEngine(v as Engine)} />
          <Param spec={seg<LookupKind>("Query", QUERIES, "email")} value={kind} onChange={(v) => setKind(v as LookupKind)} />
          <Param spec={select({ label: "email = ?", options: USER_ROWS.map((r) => ({ value: r.email, label: r.email })), default: "max@x.io" })} value={email} onChange={(v) => setEmail(v as string)} />
          {engine === "postgres" && <Param spec={toggle({ label: "Heap page is all-visible", default: true })} value={allVis} onChange={(v) => setAllVis(v as boolean)} />}
        </>
      }
    >
      {usesSec && (
        <>
          <Caption>{engine === "innodb" ? "Secondary index on email: leaves hold the primary key" : "Index on email: leaves hold TIDs (page, slot)"}</Caption>
          <TreeView root={secSnap} color={colorFor("secondary")} cell={26} />
        </>
      )}
      {engine === "innodb" && kind !== "email-id" && (
        <>
          <Caption>Clustered index on id: the leaves are the rows</Caption>
          <TreeView root={primSnap} color={colorFor("primary")} cell={22} />
        </>
      )}
      {engine === "postgres" && kind === "pk" && (
        <>
          <Caption>Index on id (the primary key is an ordinary index)</Caption>
          <TreeView root={primSnap} color={colorFor("primary")} cell={22} />
        </>
      )}
      {engine === "postgres" && (
        <>
          <Caption>Heap file: rows in insert order, {HEAP_ROWS_PER_PAGE} per page{kind === "email-id" ? " · visibility map" : ""}</Caption>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Array.from({ length: pages }, (_, p) => {
              const on = heapRead.has(p), now = cur?.s === "heap" && cur.node === p;
              return (
                <div key={p} style={{ border: `${on ? 2 : 1}px solid ${now ? "var(--c3)" : on ? "var(--c1)" : "var(--border)"}`, borderRadius: 4, padding: "2px 4px", minWidth: 62 }}>
                  <div className="muted" style={{ ...mono, fontSize: 10 }}>page {p}</div>
                  {USER_ROWS.slice(p * HEAP_ROWS_PER_PAGE, (p + 1) * HEAP_ROWS_PER_PAGE).map((r, i) => (
                    <div key={r.id} style={{ ...mono, fontSize: 10.5 }}>{i + 1}: {r.id} {name(r.email)}</div>
                  ))}
                </div>
              );
            })}
            {kind === "email-id" && (
              <div style={{ border: `2px solid ${cur?.s === "vm" ? "var(--c3)" : done.some((r) => r.s === "vm") ? "var(--c1)" : "var(--border)"}`, borderRadius: 4, padding: "2px 6px", ...mono, fontSize: 10.5 }}>
                <div className="muted" style={{ fontSize: 10 }}>visibility map</div>
                {Array.from({ length: pages }, (_, p) => <div key={p}>page {p}: {allVis ? "all-visible" : "not all-visible"}</div>)}
              </div>
            )}
          </div>
        </>
      )}
      <StepText>{cur ? `Read ${n}: ${cur.note}.` : "Pick a query. Each page read plays in order."}</StepText>
      <StepButtons st={st} />
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "page reads in this lookup", value: trace.length },
          { label: engine === "innodb" ? "secondary + clustered" : "index + heap + map", value: engine === "innodb" ? `${counts.secondary} + ${counts.primary}` : `${counts.secondary + counts.primary} + ${counts.heap} + ${counts.vm}` },
          { label: `point lookup by email, 100 M rows (${engine === "innodb" ? "16" : "8"} KiB pages)`, value: engine === "innodb" ? `${big.hSec} + ${big.hPk} = ${big.innodb}` : `${big.hSecPg} + 1 = ${big.postgres}` },
        ]}
      />
      <Note>Small trees of order 4 over {USER_ROWS.length} users with ids 1 to {USER_ROWS.length}. A real engine keeps the upper levels in the buffer pool, so many of these reads hit memory.</Note>
    </Demo>
  );
}
