/** Demos for "Architecture of an embedded engine": a live layer diagram and a design-choice explorer. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, range, useSim } from "../../kit";
import { LAYERS, type Layer, type TinyKv } from "../../sims/db/engine/kv";
import { archEngine, archKey, traceOp, LAYER_INFO, AXES, consequences, type OpTrace, type Choice } from "../../sims/db/engine/design";
import { mono, seg, Note, Label, LAYER_COLOR, Verdict, fmt } from "./EngineShared";

// ============================================================================
// The layers, lit by real work
// ============================================================================

function layerSummary(l: Layer, d: OpTrace["delta"], tr: OpTrace): string {
  switch (l) {
    case "api": return tr.label;
    case "txn": return tr.perLayer.txn ? `${tr.perLayer.txn} check(s): snapshot, conflicts, timestamps` : "no work";
    case "tree": return d.treeVisits ? `${d.treeVisits} page visit(s)${d.splits ? `, ${d.splits} split(s)` : ""}` : "no work";
    case "pool": return d.poolHits + d.poolMisses ? `${d.poolHits} hit(s), ${d.poolMisses} miss(es)${d.evictions ? `, ${d.evictions} eviction(s)` : ""}` : "no work";
    case "file": return d.pageReads + d.pageWrites ? `${d.pageReads} page read(s), ${d.pageWrites} page write(s)` : "no work";
    case "wal": return d.logRecords ? `${d.logRecords} record(s), ${d.logBytes.toLocaleString("en-US")} B${d.fpis ? `, ${d.fpis} full-page image(s)` : ""}` : "no work";
    case "os": return d.logWrites + d.logFsyncs + d.dataFsyncs + d.pageWrites + d.pageReads ? `${d.logWrites + d.pageWrites + d.pageReads} read/write call(s), ${d.logFsyncs + d.dataFsyncs} fsync(s)` : "no work";
  }
}

export function ArchitectureDemo() {
  const [keys, setKeys] = useState(24);
  const [frames, setFrames] = useState(8);
  const eng = useRef<TinyKv | null>(null);
  const txn = useRef<number | null>(null);
  const [key, setKey] = useState(5);
  const [tr, setTr] = useState<OpTrace | null>(null);
  const [shown, setShown] = useState(0);
  const puts = useRef(0);
  const make = (k = keys, f = frames) => { eng.current = archEngine(k, { frames: f }); txn.current = null; puts.current = 0; setTr(null); setShown(0); };
  if (!eng.current) make();
  const e = eng.current!;
  const sim = useSim({ dt: 1 / 5, autoplay: false, step: () => setShown((s) => { const n = s + 1; if (tr && n >= tr.events.length) sim.pause(); return Math.min(n, tr?.events.length ?? 0); }) });
  const run = (label: string, fn: (e: TinyKv) => void) => {
    const t = traceOp(e, label, fn);
    setTr(t);
    setShown(1);
    sim.play();
  };
  const k = archKey(key);
  const doPut = () => run(`put(${k}) and commit`, (x) => { const t = x.begin(); x.put(t, k, `v${++puts.current}`); x.commit(t); });
  const doPutOpen = () => run(`put(${k}) in an open transaction`, (x) => { if (txn.current === null) txn.current = x.begin(); x.put(txn.current, k, `v${++puts.current}`); });
  const doCommit = () => run("commit", (x) => { if (txn.current === null) throw new Error("no open transaction: use put (no commit) first"); const t = txn.current; txn.current = null; x.commit(t); });
  const doGet = () => run(`get(${k})`, (x) => { x.get(txn.current, k); });
  const doCkpt = () => run("checkpoint", (x) => { x.checkpoint(); });
  const cur = tr && shown > 0 ? tr.events[Math.min(shown, tr.events.length) - 1] : undefined;
  const levels = e.levels();
  const c = e.counters();
  return (
    <Demo
      title="Send an operation through the layers"
      controls={
        <>
          <Param spec={range({ label: "Keys in the tree", min: 4, max: 60, step: 1, default: 24 })} value={keys} onChange={(v) => { setKeys(v as number); make(v as number, frames); }} />
          <Param spec={range({ label: "Buffer pool frames", min: 8, max: 32, step: 1, default: 8 })} value={frames} onChange={(v) => { setFrames(v as number); make(keys, v as number); }} />
          <Param spec={range({ label: "Key", min: 0, max: 70, step: 1, default: 5, format: (v) => archKey(v) })} value={key} onChange={(v) => setKey(v as number)} />
        </>
      }
    >
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={doPut}>put + commit</button>
        <button className="btn" onClick={doPutOpen}>put (no commit)</button>
        <button className="btn" onClick={doCommit}>commit</button>
        <button className="btn" onClick={doGet}>get</button>
        <button className="btn" onClick={doCkpt}>checkpoint</button>
        {tr && <button className="btn ghost" onClick={() => { sim.pause(); setShown(tr.events.length); }}>show all steps</button>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {LAYERS.map((l) => {
            const did = tr ? tr.events.slice(0, shown).some((x) => x.layer === l) : false;
            const now = cur?.layer === l;
            return (
              <div key={l} style={{ border: `1.5px solid ${now ? LAYER_COLOR[l] : did ? "var(--border)" : "var(--border)"}`, borderLeft: `5px solid ${did || now ? LAYER_COLOR[l] : "var(--border)"}`, borderRadius: 6, padding: "4px 8px", background: now ? "var(--subtle)" : "var(--bg)", opacity: tr && !did && !now ? 0.55 : 1, transition: "background 0.15s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
                  <b style={{ fontWeight: 600 }}>{LAYER_INFO[l].name}</b>
                  {tr && <span className="muted" style={{ fontSize: 11.5, textAlign: "right" }}>{did ? layerSummary(l, tr.delta, tr) : "no work"}</span>}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>{LAYER_INFO[l].job}</div>
              </div>
            );
          })}
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <Label>{tr ? `What happened, in order (${Math.min(shown, tr.events.length)} of ${tr.events.length} steps)` : "Press a button. Each step shows the layer that did it."}</Label>
          <div style={{ border: "1px solid var(--border)", borderRadius: 6, maxHeight: 290, overflowY: "auto", fontSize: 11.5 }}>
            {tr?.events.slice(0, shown).map((x, i) => (
              <div key={i} style={{ display: "flex", gap: 6, padding: "2px 6px", background: i === shown - 1 ? "var(--subtle)" : undefined, borderBottom: "1px solid var(--border)" }}>
                <span style={{ ...mono, color: LAYER_COLOR[x.layer], width: 34, flex: "none", fontWeight: 600 }}>{x.layer}</span>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{x.text}</span>
              </div>
            ))}
            {!tr && <div className="muted" style={{ padding: 6 }}>No operation yet.</div>}
          </div>
        </div>
      </div>
      <Stats items={[
        { label: "tree height", value: levels.length },
        { label: "pages in the tree", value: levels.reduce((s, l) => s + l.length, 0) },
        { label: "open transaction", value: txn.current === null ? "none" : `T${txn.current}` },
        { label: "log end (LSN)", value: `${e.lastLSN} (durable ${e.flushedLSN})` },
        { label: "fsyncs so far", value: c.logFsyncs + c.dataFsyncs },
      ]} />
      <Note>Every number here comes from the real engine of the next lesson (TinyKv): 4 keys per leaf, a write-ahead log, CRC-32C pages and an LRU buffer pool. The tree is loaded and checkpointed when you move a slider.</Note>
    </Demo>
  );
}

// ============================================================================
// Design choices and their consequences
// ============================================================================

const ROWS: [keyof Choice, string][] = [["access", "access"], ["update", "update"], ["recovery", "recovery"], ["writers", "writers"], ["cache", "cache"]];

export function DesignExplorerDemo() {
  const [c, setC] = useState<Choice>({ access: "btree", update: "inplace", recovery: "undoredo", writers: "many", cache: "pool" });
  const r = useMemo(() => consequences(c), [c]);
  const top = r.matches.filter((m) => m.score === r.matches[0]!.score);
  return (
    <Demo
      title="Pick one choice per axis"
      controls={
        <>
          {ROWS.map(([k]) => {
            const ax = AXES[k];
            return <Param key={k} spec={seg(ax.label, ax.options.map(([v, l]) => [v, l] as [string, string]), c[k])} value={c[k]} onChange={(v) => setC({ ...c, [k]: v } as Choice)} />;
          })}
        </>
      }
    >
      {!r.valid ? (
        <Verdict ok={false}>
          <b>This combination does not work.</b>
          {r.problems.map((p) => <div key={p}>{p}</div>)}
        </Verdict>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 2fr)", gap: "5px 12px", fontSize: 13 }}>
            {([
              ["Write amplification", `${fmt(r.amp!.wa)} bytes written per byte updated`],
              ["Point read", `${fmt(r.amp!.ra, 2)} I/O (inner nodes and filters in memory)`],
              ["Range of 100 records", `${fmt(r.amp!.raRange, 0)} I/Os`],
              ["Space amplification", `${fmt(r.amp!.sa, 2)}× the live data`],
              ["fsyncs on the commit path", `${r.commitFsyncs}`],
              ["After a crash", r.recoveryWork],
              ["Concurrency", r.concurrency],
              ["Caching", r.caching],
            ] as [string, string][]).map(([a, b]) => (
              <div key={a} style={{ display: "contents" }}>
                <span className="muted">{a}</span>
                <span>{b}</span>
              </div>
            ))}
          </div>
          <Bar wa={r.amp!.wa} />
        </>
      )}
      <Label style={{ marginTop: 12 }}>{top[0]!.score === 5 ? "Real engines with exactly these choices" : `Closest real engines (${top[0]!.score} of 5 choices match)`}</Label>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {top.map((m) => (
          <div key={m.engine.name} style={{ fontSize: 13 }}>
            <b style={{ fontWeight: 600 }}>{m.engine.name}</b> <span className="muted">– {m.engine.note}</span>
          </div>
        ))}
      </div>
      <Note>Write, read and space numbers: the models of the amplification lesson for 100-byte records, 4 KiB pages and 100 GB of data, one update per transaction. LSM is leveled with T = 10; the hash log is cleaned at 80% live data.</Note>
    </Demo>
  );
}

/** Write amplification on a log scale from 1 to 300. */
function Bar({ wa }: { wa: number }) {
  const x = (v: number) => (Math.log(v) / Math.log(300)) * 100;
  return (
    <div style={{ marginTop: 12 }}>
      <Label>Write amplification on a log scale</Label>
      <svg viewBox="0 0 100 9" preserveAspectRatio="none" style={{ width: "100%", height: 18, display: "block" }}>
        <rect x={0} y={1} width={100} height={7} fill="var(--subtle)" />
        <rect x={0} y={1} width={Math.max(0.5, x(wa))} height={7} fill="var(--c1)" />
        {[1, 3, 10, 30, 100, 300].map((t) => <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={9} stroke="var(--border)" strokeWidth={0.3} />)}
      </svg>
      <div style={{ position: "relative", height: 14, fontSize: 10.5 }} className="muted">
        {[1, 3, 10, 30, 100, 300].map((t) => <span key={t} style={{ position: "absolute", left: `${x(t)}%`, transform: t === 300 ? "translateX(-100%)" : t === 1 ? undefined : "translateX(-50%)" }}>{t}</span>)}
      </div>
    </div>
  );
}
