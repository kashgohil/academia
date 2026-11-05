/** Demos for "A tiny key-value store, end to end": a console playground and a B+ tree vs LSM workload runner. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Demo, Stats, Param, Plot, Line, Dots, RuleX, Legend, range, toggle, pct, Banner, Note, SmallLabel, mono, seg } from "../../kit";
import { TinyKv, reopen, ConflictError, CorruptPageError, type LogRec, type DurableImage, type RecoveryReport } from "../../sims/db/engine/kv";
import { measureSteps, deviceTime, SWEEP, WL_DEFAULTS, type IoProfile, type EngineMode, type FsyncDevice } from "../../sims/db/engine/workload";
import { mulberry32 } from "../../sims/rng";
import { PageChip, chainText, fmt } from "./EngineShared";

// ============================================================================
// The playground
// ============================================================================

const pk = (i: number) => `k${String(i).padStart(2, "0")}`;

export function recLine(r: LogRec): ReactNode {
  switch (r.kind) {
    case "fpi": return <>full image of page {r.page}</>;
    case "cell": return <>T{r.txn} page {r.page}: {r.key} ← <span className="muted">{chainText(r.after)}</span></>;
    case "clr": return <>T{r.txn} CLR page {r.page}: {r.key} ← <span className="muted">{r.after ? chainText(r.after) : "absent"}</span>, undoNext {r.undoNext}</>;
    case "smo": return <>split: pages {r.pages.map((p) => p.no).join(", ")}</>;
    case "commit": return <>T{r.txn} commit, ts {r.ts}</>;
    case "abort": return <>T{r.txn} abort</>;
    case "end": return <>T{r.txn} end</>;
    case "ckpt_begin": return <b style={{ fontWeight: 600 }}>checkpoint begin</b>;
    case "ckpt_end": return <><b style={{ fontWeight: 600 }}>checkpoint end</b> <span className="muted">ATT {r.att.map((a) => `T${a.txn}`).join(" ") || "–"}</span></>;
  }
}

function seedEngine(frames: number, group: number) {
  const e = new TinyKv({ leafCap: 4, innerCap: 4, frames, groupCommit: group }, undefined, mulberry32(5));
  const t = e.begin();
  for (const i of [6, 14, 2, 10, 18, 4, 12, 0, 16, 8]) e.put(t, pk(i), `a${i}`);
  e.commit(t);
  e.checkpoint();
  return e;
}

export function KvPlaygroundDemo() {
  const [frames, setFrames] = useState(8);
  const [group, setGroup] = useState("1");
  const [key, setKey] = useState(5);
  const [versions, setVersions] = useState(true);
  const eng = useRef<TinyKv | null>(null);
  const crashed = useRef<DurableImage | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [out, setOut] = useState<{ text: string; tone?: "bad" | "ok" }[]>([{ text: "10 keys are loaded and committed. Begin a transaction, then put, get, commit, crash and recover." }]);
  const [, force] = useState(0);
  const valN = useRef(0);
  const reset = (f = frames, g = group) => { eng.current = seedEngine(f, Number(g)); crashed.current = null; setSel(null); setOut([{ text: "New engine: 10 keys loaded and committed." }]); };
  if (!eng.current) eng.current = seedEngine(frames, Number(group));
  const e = eng.current;
  const say = (text: string, tone?: "bad" | "ok") => setOut((o) => [{ text, tone }, ...o].slice(0, 30));
  const act = (f: () => string | void) => {
    try { const m = f(); if (m) say(m); } catch (x) {
      if (x instanceof ConflictError) { say(`${x.message}.`, "bad"); setSel(null); } else say((x as Error).message, "bad");
    }
    force((n) => n + 1);
  };
  const k = pk(key);
  const live = crashed.current ? [] : e.liveTxns();
  const t = sel !== null && live.some((x) => x.id === sel) ? sel : null;
  const need = () => { if (t === null) throw new Error("Select or begin a transaction first."); return t; };
  const doCrash = () => act(() => {
    const img = e.crash();
    crashed.current = img;
    setSel(null);
    return `Power cut. Disk keeps ${img.log.length} log record(s); ${img.lostLogRecords} record(s) in memory are lost, ${img.lostPageWrites} unsynced page write(s) lost.`;
  });
  const doRecover = () => act(() => {
    const img = crashed.current!;
    const n = reopen(img, mulberry32(9));
    let rep: RecoveryReport;
    try { rep = n.recover(); } catch (x) { if (x instanceof CorruptPageError) return `Recovery stops: ${x.message}`; throw x; }
    eng.current = n;
    crashed.current = null;
    return `Recovered: analysis read ${rep.analysed} record(s); redo from LSN ${rep.redoFrom || "none"} redid ${rep.redone}; undo rolled back ${rep.losers.map((x) => `T${x}`).join(", ") || "no loser"} with ${rep.clrs} CLR(s); then a checkpoint. ${img.oracle.acked} acknowledged commit(s) must survive.`;
  });
  const levels = crashed.current ? [] : e.levels();
  const frs = e.frames();
  const tail = e.log.slice(-14);
  const off = !!crashed.current;
  return (
    <Demo
      title="TinyKv console"
      actions={<button className="btn ghost" onClick={() => reset()}>Reset</button>}
      controls={
        <>
          <Param spec={range({ label: "Buffer pool frames", min: 8, max: 24, step: 1, default: 8 })} value={frames} onChange={(v) => { setFrames(v as number); reset(v as number, group); }} />
          <Param spec={range({ label: "Key", min: 0, max: 29, step: 1, default: 5, format: (v) => pk(v) })} value={key} onChange={(v) => setKey(v as number)} />
          <Param spec={seg("Group commit", [["1", "fsync each commit"], ["3", "3 commits per fsync"]], "1")} value={group} onChange={(v) => { setGroup(v as string); reset(frames, v as string); }} />
          <Param spec={toggle({ label: "Show version chains", default: true })} value={versions} onChange={(v) => setVersions(v as boolean)} />
        </>
      }
    >
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
        <button className="btn" disabled={off} onClick={() => act(() => { const id = e.begin(); setSel(id); return `begin T${id}: snapshot ts ${e.txns.get(id)!.snap}.`; })}>begin</button>
        <button className="btn" disabled={off} onClick={() => act(() => { const id = e.begin(true); setSel(id); return `begin T${id} read-only: snapshot ts ${e.txns.get(id)!.snap}.`; })}>begin read-only</button>
        <button className="btn primary" disabled={off} onClick={() => act(() => { const id = need(); const v = `v${++valN.current}`; e.put(id, k, v); return `T${id}: put ${k} = ${v}.`; })}>put {k}</button>
        <button className="btn" disabled={off} onClick={() => act(() => { const id = need(); e.del(id, k); return `T${id}: delete ${k}.`; })}>delete {k}</button>
        <button className="btn" disabled={off} onClick={() => act(() => { const v = e.get(t, k); return `${t === null ? "autocommit" : `T${t}`}: get ${k} → ${v ?? "absent"}.`; })}>get {k}</button>
        <button className="btn" disabled={off} onClick={() => act(() => { const id = need(); const r = e.commit(id); setSel(null); return `T${id} committed at ts ${r.ts}. ${r.durable ? "The commit record is durable: the client is told." : "Waiting for a group flush: the client is not told yet."}`; })}>commit</button>
        <button className="btn" disabled={off} onClick={() => act(() => { const id = need(); e.abort(id); setSel(null); return `T${id} aborted: its changes were undone with CLRs.`; })}>abort</button>
      </div>
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
        <button className="btn" disabled={off} onClick={() => act(() => { e.sync(); return `Log flushed: durable to LSN ${e.flushedLSN}.`; })}>flush log</button>
        <button className="btn" disabled={off} onClick={() => act(() => { e.checkpoint(); return `Checkpoint: dirty pages written, data file synced, master record = LSN ${e.master}.`; })}>checkpoint</button>
        <button className="btn" disabled={off} onClick={doCrash} style={{ color: "var(--c4)", borderColor: "var(--c4)" }}>crash</button>
        <button className="btn" disabled={!off} onClick={doRecover}>recover</button>
      </div>
      <div style={{ ...mono, fontSize: 12, border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", height: 74, overflowY: "auto", marginBottom: 10, background: "var(--subtle)" }}>
        {out.map((o, i) => <div key={out.length - i} style={{ color: o.tone === "bad" ? "var(--c4)" : i === 0 ? "var(--fg)" : "var(--muted)" }}>&gt; {o.text}</div>)}
      </div>
      {off ? (
        <Banner ok={null}>The engine is down. Memory is gone: the buffer pool, the transaction table and the log tail. Press recover.</Banner>
      ) : (
        <>
          <SmallLabel>B+ tree (4 keys per leaf). Grey pages are dirty in the buffer pool.</SmallLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
            {levels.map((lv, d) => (
              <div key={d} style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {lv.map((p) => <PageChip key={p.no} p={p} showVersions={versions} dirty={frs.some((f) => f.page === p.no && f.dirty)} hot={p.kind === "leaf" && p.keys.includes(k)} />)}
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <SmallLabel>Buffer pool frames: page, pins, recLSN</SmallLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(52px, 1fr))", gap: 3 }}>
            {frs.map((f) => (
              <div key={f.frame} style={{ ...mono, fontSize: 10.5, border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px", background: off ? "transparent" : f.dirty ? "var(--subtle)" : "var(--bg)", opacity: off ? 0.4 : 1 }}>
                <div className="muted">f{f.frame}</div>
                <div>{off || f.page < 0 ? "–" : `p${f.page}`}{!off && f.dirty && <span style={{ color: "var(--c2)" }}> D</span>}</div>
                <div className="muted">{!off && f.recLSN !== null ? `rec ${f.recLSN}` : " "}</div>
              </div>
            ))}
          </div>
          <SmallLabel style={{ marginTop: 10 }}>Live transactions (click to select)</SmallLabel>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%", ...mono }}>
            <thead><tr>{["txn", "status", "snap", "lastLSN", "writes"].map((h) => <th key={h} style={{ textAlign: "left", fontWeight: 500, color: "var(--muted)", borderBottom: "1px solid var(--border)", padding: "1px 6px 1px 0" }}>{h}</th>)}</tr></thead>
            <tbody>
              {live.map((x) => (
                <tr key={x.id} onClick={() => setSel(x.id)} style={{ cursor: "pointer", background: x.id === t ? "var(--subtle)" : undefined }}>
                  <td style={{ padding: "1px 6px 1px 0" }}>T{x.id}{x.readOnly ? " ro" : ""}</td><td>{x.status}</td><td>{x.snap}</td><td>{x.last}</td><td>{[...x.writes.keys()].join(" ") || "–"}</td>
                </tr>
              ))}
              {live.length === 0 && <tr><td colSpan={5} className="muted">none</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <SmallLabel>Log tail. Filled dot: durable. Hollow: in memory only.</SmallLabel>
          <div style={{ border: "1px solid var(--border)", borderRadius: 6, fontSize: 11.5 }}>
            {tail.map((r) => {
              const durable = r.lsn <= e.syncedLSN;
              return (
                <div key={r.lsn} style={{ display: "flex", gap: 6, alignItems: "center", padding: "1px 6px", borderTop: r.lsn === e.syncedLSN + 1 ? "1px dashed var(--c4)" : undefined, whiteSpace: "nowrap", overflow: "hidden" }}>
                  <span style={{ ...mono, width: 26, textAlign: "right", color: "var(--muted)" }}>{r.lsn}</span>
                  <span style={{ width: 7, height: 7, borderRadius: 7, flex: "none", background: durable ? "var(--fg)" : "transparent", border: "1px solid var(--muted)" }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{recLine(r)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Stats items={[
        { label: "log records", value: e.lastLSN },
        { label: "durable to LSN", value: e.syncedLSN },
        { label: "master (checkpoint)", value: e.master || "none" },
        { label: "acknowledged commits", value: e.oracle.acked },
        { label: "fsyncs", value: e.stats.logFsyncs + e.stats.dataFsyncs },
      ]} />
    </Demo>
  );
}

// ============================================================================
// Workload runner: B+ tree mode vs LSM mode
// ============================================================================

type Sweep = Record<EngineMode, (IoProfile | null)[]>;
const B = (v: number) => `${Math.round(v).toLocaleString("en-US")} B`;

export function WorkloadRunnerDemo() {
  const [wi, setWi] = useState(5);
  const [frames, setFrames] = useState("16");
  const [group, setGroup] = useState("1");
  const [dev, setDev] = useState<FsyncDevice>("plp");
  const key = `${frames}|${group}`;
  const cache = useRef(new Map<string, Sweep>());
  const [, force] = useState(0);
  useEffect(() => {
    let live = true;
    const sw = cache.current.get(key) ?? { btree: SWEEP.map(() => null), lsm: SWEEP.map(() => null) };
    cache.current.set(key, sw);
    const order: [EngineMode, number][] = [];
    const near = [...SWEEP.keys()].sort((a, b) => Math.abs(a - wi) - Math.abs(b - wi));
    for (const i of near) for (const m of ["btree", "lsm"] as EngineMode[]) order.push([m, i]);
    let gen: { m: EngineMode; i: number; g: Generator<void, IoProfile> } | null = null;
    const next = () => {
      if (!live) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 25) {
        if (!gen) {
          const job = order.find(([m, i]) => !sw[m][i]);
          if (!job) { force((n) => n + 1); return; }
          gen = { m: job[0], i: job[1], g: measureSteps(job[0], { ...WL_DEFAULTS, writeFrac: SWEEP[job[1]]!, frames: Number(frames), groupCommit: Number(group) }) };
        }
        const r = gen.g.next();
        if (r.done) { sw[gen.m][gen.i] = r.value; gen = null; force((n) => n + 1); }
      }
      id = setTimeout(next, 0);
    };
    let id = setTimeout(next, 0);
    return () => { live = false; clearTimeout(id); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sw = cache.current.get(key);
  const pts = (m: EngineMode) => (sw?.[m] ?? []).flatMap((p, i) => (p ? [[SWEEP[i]!, deviceTime(m, p, dev).opsPerSec / 1000] as const] : []));
  const bt = pts("btree"), ls = pts("lsm");
  const yMax = Math.max(10, ...bt.map((p) => p[1]), ...ls.map((p) => p[1])) * 1.1;
  const pb = sw?.btree[wi] ?? null, pl = sw?.lsm[wi] ?? null;
  const done = (sw ? [...sw.btree, ...sw.lsm].filter(Boolean).length : 0);
  const rows: [string, (p: IoProfile, m: EngineMode) => string][] = [
    ["page or block reads per op", (p) => fmt(p.randomReads, 2)],
    ["in-place page writes per op", (p) => fmt(p.randomWrites, 2)],
    ["log bytes per op", (p) => B(p.logBytes)],
    ["page or SSTable bytes per op", (p) => B(p.dataBytes)],
    ["compaction reads per op", (p) => B(p.seqReadBytes)],
    ["fsyncs per op", (p) => fmt(p.fsyncs, 3)],
    ["bytes written per user byte", (p) => fmt(p.writeAmp, 1)],
    ["µs per op (model)", (p, m) => fmt(deviceTime(m, p, dev).total, 1)],
  ];
  return (
    <Demo
      title="The same workload in B+ tree mode and in LSM mode"
      controls={
        <>
          <Param spec={range({ label: "Share of writes", min: 0, max: 10, step: 1, default: 5, format: (v) => pct(SWEEP[v]!, 0) })} value={wi} onChange={(v) => setWi(v as number)} />
          <Param spec={seg("B+ tree pool", [["8", "8 frames"], ["16", "16 frames"], ["128", "128 frames"]], "16")} value={frames} onChange={(v) => setFrames(v as string)} />
          <Param spec={seg("Group commit", [["1", "1 commit per fsync"], ["8", "8 per fsync"]], "1")} value={group} onChange={(v) => setGroup(v as string)} />
          <Param spec={seg<FsyncDevice>("fsync device", [["ssd", "SSD, 1 ms"], ["plp", "SSD with PLP, 0.05 ms"]], "plp")} value={dev} onChange={(v) => setDev(v as FsyncDevice)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr) minmax(0, 1fr)", gap: "3px 10px", fontSize: 12.5, alignItems: "baseline" }}>
        <span className="muted">at {pct(SWEEP[wi]!, 0)} writes</span>
        <b style={{ color: "var(--c2)" }}>B+ tree</b>
        <b style={{ color: "var(--c1)" }}>LSM</b>
        {rows.map(([a, f]) => (
          <div key={a} style={{ display: "contents" }}>
            <span className="muted">{a}</span>
            <span style={mono}>{pb ? f(pb, "btree") : "…"}</span>
            <span style={mono}>{pl ? f(pl, "lsm") : "…"}</span>
          </div>
        ))}
      </div>
      <SmallLabel style={{ marginTop: 12 }}>Operations per second (device-time model, thousands){done < 22 ? ` – running ${done} of 22` : ""}</SmallLabel>
      <Plot x={[0, 1]} y={[0, yMax]} height={200} xLabel="share of writes" yLabel="k ops/s" xFormat={(v) => pct(v, 0)}>
        <Line points={bt} color="var(--c2)" />
        <Line points={ls} color="var(--c1)" />
        <Dots points={bt} color="var(--c2)" r={2.5} />
        <Dots points={ls} color="var(--c1)" r={2.5} />
        <RuleX at={SWEEP[wi]!} />
      </Plot>
      <Legend items={[{ label: "B+ tree (TinyKv)", color: "var(--c2)" }, { label: "LSM (LsmTree)", color: "var(--c1)" }]} />
      <Note>Each point runs both real engines: 3,000 keys with 100-byte values, then 2,000 operations in transactions of 4. The B+ tree checkpoints every 500 operations. Both keep their index in memory and read data pages or blocks from the device.</Note>
    </Demo>
  );
}
