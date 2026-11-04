/** Demos for "Reading query plans": an interactive EXPLAIN reader and a "find the problem" exercise set. */
import { useMemo, useState, type ReactNode } from "react";
import { Demo, Param, Stats, range, toggle, useParams } from "../../kit";
import {
  PG_DEFAULTS, shopScenario, exercises, renderExplain, renderMysqlTree, walkPlan, selfMs, rowError, executionMs, bufferText, CAUSE_LABEL, BLCKSZ,
  type PNode, type Line as PlanLine, type Cause,
} from "../../sims/db/optimizer";
import { seg, mono, Note, Caption, Code, fx, int, Btn, Row } from "./OptimizerUi";

const PROP_HELP: Record<string, string> = {
  "Index Cond": "The condition the index answers. Only these rows are read from the index.",
  "Filter": "A condition checked on each row after it is read. Rows that fail are thrown away, but they were still read.",
  "Rows Removed by Filter": "Rows read and then discarded by the Filter (per loop). A large number next to a small 'rows' means wasted work.",
  "Recheck Cond": "The bitmap may mark whole pages, so the heap scan checks the condition again on each row.",
  "Heap Blocks": "Heap pages the bitmap scan visited. 'exact' pages have one bit per row; 'lossy' pages (when work_mem is too small) have one bit per page.",
  "Hash Cond": "The equality that the hash table is keyed on.",
  "Buckets": "Hash table size. Batches > 1 means the table did not fit in work_mem × hash_mem_multiplier and was split into files on disk.",
  "Sort Key": "The ORDER BY columns of this sort.",
  "Sort Method": "quicksort and top-N heapsort run in memory. 'external merge' wrote sorted runs to temporary files: the sort spilled.",
  "Group Key": "The GROUP BY columns.",
  "Batches": "HashAggregate batches. More than 1 means the groups did not fit in memory and spilled.",
  "Join Filter": "A join condition that is checked on each pair of rows after the join produces it.",
  "Rows Removed by Join Filter": "Pairs that the join produced and then threw away. A large number means the join compared many useless pairs.",
  "Storage": "Where Materialize kept its rows: in memory, or on disk if they did not fit in work_mem.",
};

function fieldRows(n: PNode, analyze: boolean, buffers: boolean): [string, ReactNode][] {
  const out: [string, ReactNode][] = [];
  const kids = n.children.length > 0;
  out.push([`cost=${fx(n.est.startup)}..${fx(n.est.total)}`, <>Estimated cost in planner units (1.0 = one sequential page read). <b>{fx(n.est.startup)}</b> is the startup cost: the work before the first row. <b>{fx(n.est.total)}</b> is the total cost for all rows{kids ? ", including the children" : ""}{n.act.loops > 1 ? ", for one loop" : ""}.</>]);
  out.push([`rows=${n.est.rows}`, <>The planner's estimate of rows this node returns{n.act.loops > 1 ? " per loop" : ""}. Every cost above this node depends on it.</>]);
  out.push([`width=${n.est.width}`, <>Estimated average size of one output row, in bytes. It sets the memory for hashes and sorts.</>]);
  if (analyze) {
    out.push([`actual time=${fx(n.act.startup, 3)}..${fx(n.act.total, 3)}`, <>Milliseconds until the first row and until the last row{n.act.loops > 1 ? `, averaged over the ${int(n.act.loops)} loops. The node spent ${fx(n.act.total * n.act.loops, 1)} ms in total` : ""}. The time includes the children.</>]);
    out.push([`rows=${Math.round(n.act.rows)} loops=${n.act.loops}`, <>Rows returned per loop, and how many times the node ran. Total rows = {int(n.act.rows)} × {int(n.act.loops)} = <b>{int(n.act.rows * n.act.loops)}</b>.</>]);
  }
  if (analyze && buffers) {
    const b = bufferText(n.buf);
    if (b) out.push([`Buffers: ${b}`, <>8 KiB pages this node and its children touched. <b>hit</b> pages were in shared_buffers; <b>read</b> pages came from the OS ({fx(((n.buf.read * BLCKSZ) / 2 ** 20), 1)} MiB). <b>temp</b> pages went to temporary files.</>]);
  }
  for (const p of n.props) if (!p.runtime || analyze) out.push([`${p.key}: ${p.value}`, PROP_HELP[p.key] ?? ""]);
  return out;
}

function PlanText({ lines, sel, onPick }: { lines: PlanLine[]; sel?: number; onPick?: (id: number) => void }) {
  return (
    <pre style={{ ...mono, fontSize: 11.5, lineHeight: 1.5, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 0", margin: 0, overflowX: "auto", whiteSpace: "pre" }}>
      {lines.map((l, i) => (
        <div key={i} onClick={() => onPick && l.node >= 0 && onPick(l.node)} style={{ padding: "0 10px", cursor: onPick && l.node >= 0 ? "pointer" : "default", background: sel !== undefined && l.node === sel ? "var(--bg)" : undefined, boxShadow: sel !== undefined && l.node === sel ? "inset 3px 0 0 var(--c1)" : undefined, fontWeight: l.head && l.node === sel ? 600 : 400 }}>{l.text || " "}</div>
      ))}
    </pre>
  );
}

function PlanCards({ root, sel, onPick, analyze }: { root: PNode; sel: number; onPick: (id: number) => void; analyze: boolean }) {
  const items: { n: PNode; d: number }[] = [];
  walkPlan(root, (n, d) => items.push({ n, d }));
  const total = executionMs(root);
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {items.map(({ n, d }) => {
        const e = rowError(n);
        const bad = analyze && e.q >= 10;
        const share = analyze ? selfMs(n) / total : 0;
        return (
          <div key={n.id} onClick={() => onPick(n.id)} style={{ marginLeft: Math.min(d, 6) * 14, border: `1px solid ${n.id === sel ? "var(--c1)" : "var(--border)"}`, borderRadius: 6, padding: "4px 8px", cursor: "pointer", background: n.id === sel ? "var(--subtle)" : "var(--bg)", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 12.5 }}>
              <b>{n.op}<span className="muted" style={{ fontWeight: 400 }}>{n.target ? ` ${n.target}` : ""}</span></b>
              <span style={{ ...mono, fontSize: 11.5 }}>cost {fx(n.est.total, 0)}</span>
            </div>
            {analyze && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 11.5, flexWrap: "wrap" }}>
                <span style={{ ...mono, color: bad ? "var(--c4)" : "var(--muted)" }}>rows est {int(n.est.rows)} · actual {int(n.act.rows)}{n.act.loops > 1 ? ` × ${int(n.act.loops)} loops` : ""}{e.q >= 2 ? ` (${e.under ? "↓" : "↑"}${fx(e.q, 0)}×)` : ""}</span>
                <span style={{ flex: "1 1 60px", height: 6, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden", minWidth: 40 }}>
                  <span style={{ display: "block", width: `${Math.min(100, share * 100)}%`, height: "100%", background: "var(--c2)" }} />
                </span>
                <span style={mono}>self {fx(selfMs(n), 1)} ms</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ExplainReaderDemo() {
  const p = useParams("explain", {
    days: range({ label: "WHERE created_at ≥ (days back from 2026-11-01)", min: 1, max: 730, step: 1, default: 31 }),
    analyze: toggle({ label: "ANALYZE (run the query, show actual numbers)", default: true }),
    buffers: toggle({ label: "BUFFERS", default: true }),
    view: seg("View", [["text", "PostgreSQL text"], ["tree", "tree"], ["mysql", "MySQL FORMAT=TREE"]], "text"),
  });
  const v = p.values;
  const sc = useMemo(() => shopScenario(PG_DEFAULTS, v.days), [v.days]);
  const order = useMemo(() => { const o: PNode[] = []; walkPlan(sc.root, (n) => o.push(n)); return o; }, [sc]);
  const [pos, setPos] = useState(4);
  const selNode = order[Math.min(pos, order.length - 1)]!;
  const pick = (id: number) => setPos(Math.max(0, order.findIndex((n) => n.id === id)));
  const lines = useMemo(() => (v.view === "mysql" ? renderMysqlTree(sc.root, v.analyze) : renderExplain(sc.root, { analyze: v.analyze, buffers: v.buffers })), [sc, v.view, v.analyze, v.buffers]);
  const fields = fieldRows(selNode, v.analyze, v.buffers);
  return (
    <Demo
      title="EXPLAIN reader: click a node"
      controls={<>
        <Param spec={p.schema.days} value={v.days} onChange={(x) => p.set("days", x as number)} />
        <Param spec={p.schema.analyze} value={v.analyze} onChange={(x) => p.set("analyze", x as boolean)} />
        <Param spec={p.schema.buffers} value={v.buffers} onChange={(x) => p.set("buffers", x as boolean)} />
        <Param spec={p.schema.view} value={v.view} onChange={(x) => p.set("view", x as string)} />
      </>}
    >
      <Code style={{ fontSize: 11 }}>{sc.sql.split("\n").filter((l) => !l.startsWith("SET") && !l.startsWith("EXPLAIN")).join("\n")}</Code>
      <div className="muted" style={{ fontSize: 12, margin: "6px 0 8px" }}>{sc.context}</div>
      {v.view === "tree" ? <PlanCards root={sc.root} sel={selNode.id} onPick={pick} analyze={v.analyze} /> : <PlanText lines={lines} sel={selNode.id} onPick={pick} />}
      {v.view === "mysql" && <Note>The same plan in MySQL's EXPLAIN FORMAT=TREE shape (EXPLAIN ANALYZE adds the actual part). MySQL has no bitmap scans and uses other cost units, so only row estimates are shown.</Note>}
      <Caption>{selNode.op}{selNode.target ? ` ${selNode.target}` : ""}</Caption>
      <p style={{ fontSize: 13, margin: "0 0 6px" }}>{selNode.note}</p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 0.9fr) minmax(0, 2fr)", gap: "5px 12px", fontSize: 12.5, alignItems: "baseline" }}>
        {fields.map(([k, d]) => (
          <div key={k} style={{ display: "contents" }}>
            <span style={{ ...mono, fontSize: 11.5, overflowWrap: "anywhere", color: "var(--c1)" }}>{k}</span>
            <span>{d}</span>
          </div>
        ))}
      </div>
      {selNode.terms.length > 0 && <>
        <Caption>Where this node's own cost comes from (our model of costsize.c)</Caption>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) auto", gap: "2px 10px", fontSize: 12, alignItems: "baseline" }}>
          {selNode.terms.map((t, i) => (
            <div key={i} style={{ display: "contents" }}>
              <span className="muted">{t.label}</span>
              <span style={{ ...mono, fontSize: 11, overflowWrap: "anywhere" }}>{t.expr}</span>
              <span style={{ ...mono, textAlign: "right" }}>{fx(t.value)}</span>
            </div>
          ))}
        </div>
      </>}
      {v.analyze && <Stats items={[
        { label: "scan on orders", value: sc.path === "seq" ? "Seq Scan" : sc.path === "bitmap" ? "Bitmap Heap Scan" : "Index Scan" },
        { label: "hash table built on", value: sc.hashOrders ? "orders" : "customers" },
        { label: "self time of this node", value: `${fx(selfMs(selNode), 2)} ms` },
        { label: "execution time", value: `${fx(executionMs(sc.root), 1)} ms` },
      ]} />}
    </Demo>
  );
}

// ---------------- find the problem ----------------

const CAUSES: Cause[] = ["estimate", "index", "spill", "nestloop"];

export function FindProblemDemo() {
  const exs = useMemo(() => exercises(), []);
  const p = useParams("problem", { ex: seg("Plan", exs.map((e, i) => [String(i), `${i + 1}. ${e.title}`] as [string, string]), "0") });
  const i = Number(p.values.ex);
  const e = exs[i]!;
  const [answers, setAnswers] = useState<(Cause | null)[]>(() => exs.map(() => null));
  const a = answers[i];
  const score = answers.filter((x, k) => x === exs[k]!.cause).length;
  const before = executionMs(e.root), after = executionMs(e.fix.root);
  return (
    <Demo
      title={`Find the root cause · ${score} of ${exs.length} correct`}
      controls={<Param spec={p.schema.ex} value={p.values.ex} onChange={(x) => p.set("ex", x as string)} />}
    >
      <Code style={{ fontSize: 11 }}>{e.sql}</Code>
      <div className="muted" style={{ fontSize: 12, margin: "6px 0 8px" }}>{e.context}</div>
      <PlanText lines={renderExplain(e.root, { analyze: true, buffers: true })} />
      <Caption>What is the main problem?</Caption>
      <Row>
        {CAUSES.map((c) => (
          <Btn key={c} on={a === c} onClick={() => setAnswers((s) => s.map((x, k) => (k === i ? c : x)))}>{CAUSE_LABEL[c]}</Btn>
        ))}
      </Row>
      {a && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <p style={{ margin: "0 0 6px" }}><b style={{ color: a === e.cause ? "var(--c3)" : "var(--c4)" }}>{a === e.cause ? "Correct." : `Not quite: the cause is "${CAUSE_LABEL[e.cause].toLowerCase()}".`}</b> {e.clue}</p>
          <p style={{ margin: "0 0 6px" }}>{e.why}</p>
          <Caption>The fix</Caption>
          <Code style={{ fontSize: 11 }}>{e.fix.sql}</Code>
          <Caption>The plan after the fix{e.fix.settings ? ` (${e.fix.settings})` : ""}: {fx(before, 1)} ms → {fx(after, 1)} ms</Caption>
          <PlanText lines={renderExplain(e.fix.root, { analyze: true, buffers: true })} />
        </div>
      )}
      <Note>All four plans come from the same cost model and execution model, so the numbers in each plan agree with each other. Parallel query is off to keep the plans short.</Note>
    </Demo>
  );
}
