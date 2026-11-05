/** Demos for the recovery lessons: WAL, group commit, and the forms of logging. */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, Dots, Legend, range, toggle, useSim, useWidth, si, bytes, Banner, Note, SmallLabel, mono, seg } from "../../kit";
import { Db } from "../../sims/db/recovery/core";
import { pageName } from "../../sims/db/recovery/aries";
import { TRANSFER, transferDb, crashReport } from "../../sims/db/recovery/scenarios";
import { policyCost, DEFAULT_WORKLOAD, type StealPolicy, type ForcePolicy } from "../../sims/db/recovery/policy";
import { pgLsnText, pgWalPlace, PG_WAL_SEGMENT, PG_WAL_PAGE } from "../../sims/db/recovery/pgwal";
import { GroupCommitSim, gcSteady, DEVICES, CLIENT_COUNTS, type CommitMode, type GcSummary } from "../../sims/db/recovery/groupcommit";
import * as LF from "../../sims/db/recovery/logforms";
import { LogView, PageBox } from "./RecoveryUi";


// ============================================================================
// Lesson 1: the WAL stepper
// ============================================================================

type Crash = ReturnType<typeof crashReport>;

export function WalStepperDemo() {
  const [rule, setRule] = useState<"follow" | "break">("follow");
  const db = useRef<Db>(transferDb(true));
  const tx = useRef(new Map<string, number>());
  const [k, setK] = useState(0);
  const [msg, setMsg] = useState("Run the transactions with Next. Write pages and flush the log when you want. Then crash.");
  const [crash, setCrash] = useState<Crash | null>(null);
  const [, force] = useState(0);
  const reset = (r = rule) => {
    db.current = transferDb(r === "follow");
    tx.current = new Map();
    setK(0);
    setCrash(null);
    setMsg("Run the transactions with Next. Write pages and flush the log when you want. Then crash.");
  };
  const d = db.current;
  const act = (f: () => string) => { if (crash) return; setMsg(f()); force((x) => x + 1); };
  const next = () => act(() => {
    const step = TRANSFER[k]!;
    const before = d.flushedLSN;
    step.run(d, tx.current);
    setK(k + 1);
    const forced = d.flushedLSN > before ? ` The log is forced to LSN ${d.flushedLSN} before the commit returns.` : step.label.includes("commits") ? " The commit returns, but its record is only in memory." : "";
    return `${step.label}.${forced}`;
  });
  const writePage = (p: number) => act(() => {
    const f = d.pool.get(p);
    if (!f?.dirty) return `Page ${pageName(p)} is not dirty. Nothing to write.`;
    const before = d.flushedLSN;
    const broke = d.flushPage(p);
    if (broke) return `Page ${pageName(p)} is on disk with pageLSN ${f.page.pageLSN}, but the log is durable only to LSN ${d.flushedLSN}. This breaks the WAL rule.`;
    return `Page ${pageName(p)} written.${d.flushedLSN > before ? ` The WAL rule first forced the log to LSN ${d.flushedLSN}.` : ""}`;
  });
  const flushLog = () => act(() => {
    d.flushLog();
    return `Log flushed: durable to LSN ${d.flushedLSN}.`;
  });
  const doCrash = () => {
    const c = crashReport(d);
    setCrash(c);
    setMsg(c.problems.length ? "Crash. Recovery ran, but the result is not the committed state." : "Crash. Recovery ran and the result is exactly the committed state.");
  };
  const pages = Array.from({ length: 3 }, (_, p) => d.pool.get(p)?.page ?? d.disk[p]!);
  const rec = crash?.recovered;
  const bad = new Set(crash?.problems.map((x) => x.page));
  return (
    <Demo
      title="Write pages, flush the log, then pull the plug"
      actions={<button className="btn ghost" onClick={() => reset()}>Reset</button>}
      controls={<Param spec={seg("WAL rule", [["follow", "Follow it"], ["break", "Break it"]], "follow")} value={rule} onChange={(v) => { setRule(v as "follow" | "break"); reset(v as "follow" | "break"); }} />}
    >
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn primary" disabled={!!crash || k >= TRANSFER.length} onClick={next}>{k < TRANSFER.length ? `Next: ${TRANSFER[k]!.label}` : "All steps done"}</button>
        <button className="btn" disabled={!!crash} onClick={flushLog}>Flush log</button>
        {[0, 1, 2].map((p) => <button key={p} className="btn" disabled={!!crash || !d.pool.get(p)?.dirty} onClick={() => writePage(p)}>Write {pageName(p)}</button>)}
        <button className="btn" disabled={!!crash} onClick={doCrash} style={{ color: "var(--c4)", borderColor: "var(--c4)" }}>Crash</button>
      </div>
      <p style={{ fontSize: 13, margin: "0 0 10px", minHeight: 38 }}>{msg}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <SmallLabel>Buffer pool (memory). A grey page has changes that are not on disk.</SmallLabel>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {pages.map((p) => <PageBox key={p.id} page={p} dirty={d.pool.get(p.id)?.dirty} />)}
          </div>
          <SmallLabel>Disk</SmallLabel>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {d.disk.map((p) => <PageBox key={p.id} page={p} tone={p.pageLSN > d.flushedLSN ? "bad" : undefined} note={p.pageLSN > d.flushedLSN ? <span style={{ color: "var(--c4)" }}>newer than the log</span> : undefined} />)}
          </div>
          {rec && (
            <>
              <SmallLabel>After the crash and recovery</SmallLabel>
              <div style={{ display: "flex", gap: 6 }}>
                {rec.state().map((v, p) => <PageBox key={p} page={{ id: p, pageLSN: (rec.pool.get(p)?.page ?? rec.disk[p]!).pageLSN, slots: v }} tone={bad.has(pageName(p)) ? "bad" : "good"} />)}
              </div>
            </>
          )}
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <SmallLabel>Log. A filled dot is durable; the red dashed line is the end of the durable log.</SmallLabel>
          <LogView log={d.log} flushedLSN={d.flushedLSN} />
        </div>
      </div>
      {crash && (
        <Banner ok={crash.problems.length === 0}>
          <div>Clients were told: {d.acked.map((v, p) => `${pageName(p)} = ${v[0]}`).join(", ")}. Total money: {d.acked.reduce((s, v) => s + v[0]!, 0)} (it must stay 170).</div>
          <div>Recovered: {rec!.state().map((v, p) => `${pageName(p)} = ${v[0]}`).join(", ")}. Total: {rec!.state().reduce((s, v) => s + v[0]!, 0)}. {crash.lostTail} log record(s) were lost in the crash.</div>
          {crash.problems.map((x) => <div key={x.page} style={{ color: "var(--c4)" }}>Page {x.page}: {x.actual}, should be {x.expected}. {x.why}</div>)}
        </Banner>
      )}
    </Demo>
  );
}

// ============================================================================
// Lesson 1: STEAL / FORCE matrix
// ============================================================================

const ENGINES: Record<string, string> = {
  "steal/no-force": "PostgreSQL (redo WAL; MVCC instead of an undo log), InnoDB (redo log + undo logs), SQL Server, Db2",
  "steal/force": "SQLite rollback journal (undo images; the database file is synced at commit)",
  "no-steal/no-force": "SQLite WAL mode (redo: page images in the -wal file)",
  "no-steal/force": "LMDB (copy-on-write pages; commit switches the root, no log)",
};

export function PolicyMatrixDemo() {
  const [k, setK] = useState(4);
  const [hot, setHot] = useState(10_000);
  const [m, setM] = useState(10_000);
  const [pool, setPool] = useState(1000);
  const [sel, setSel] = useState("steal/no-force");
  const w = { ...DEFAULT_WORKLOAD, pagesPerTxn: k, hotPages: Math.round(hot), commitsPerCheckpoint: Math.round(m), poolPages: Math.round(pool) };
  const cells: [StealPolicy, ForcePolicy][] = [["steal", "force"], ["steal", "no-force"], ["no-steal", "force"], ["no-steal", "no-force"]];
  const yes = (b: boolean, what: string) => <span style={{ color: b ? "var(--fg)" : "var(--faint)" }}>{b ? "needs " : "no "}{what}</span>;
  return (
    <Demo
      title="Two choices of the buffer pool decide what recovery must do"
      controls={
        <>
          <Param spec={range({ label: "Pages each transaction changes", min: 1, max: 2000, step: 1, default: 4, log: true })} value={k} onChange={(v) => setK(Math.max(1, Math.round(v as number)))} />
          <Param spec={range({ label: "Pages the workload updates", min: 100, max: 1_000_000, default: 10_000, log: true, format: (v) => si(Math.round(v)) })} value={hot} onChange={(v) => setHot(v as number)} />
          <Param spec={range({ label: "Commits between checkpoints", min: 10, max: 100_000, default: 10_000, log: true, format: (v) => si(Math.round(v)) })} value={m} onChange={(v) => setM(v as number)} />
          <Param spec={range({ label: "Buffer pool pages", min: 100, max: 100_000, default: 1000, log: true, format: (v) => si(Math.round(v)) })} value={pool} onChange={(v) => setPool(v as number)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 6, fontSize: 12.5 }}>
        <div />
        <div className="muted" style={{ textAlign: "center" }}><b style={{ color: "var(--fg)" }}>FORCE</b><br />commit writes the pages</div>
        <div className="muted" style={{ textAlign: "center" }}><b style={{ color: "var(--fg)" }}>NO-FORCE</b><br />commit writes the log only</div>
        {(["steal", "no-steal"] as const).map((s) => (
          <Fragment key={s}>
            <div className="muted" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "center", fontSize: 11.5 }}><b style={{ color: "var(--fg)" }}>{s === "steal" ? "STEAL" : "NO-STEAL"}</b></div>
            {cells.filter(([a]) => a === s).map(([a, b]) => {
              const id = `${a}/${b}`;
              const c = policyCost(a, b, w);
              return (
                <button key={id} onClick={() => setSel(id)} style={{ textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer", border: `1.5px solid ${sel === id ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: 8, background: sel === id ? "var(--subtle)" : "var(--bg)", minWidth: 0, opacity: c.fits ? 1 : 0.55 }}>
                  <div>{yes(c.undo, "undo")} · {yes(c.redo, "redo")}</div>
                  <div style={{ fontSize: 12, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
                    commit: {c.commitPageWrites ? `${c.commitPageWrites} page write${c.commitPageWrites > 1 ? "s" : ""} + ` : ""}1 {c.commitPageWrites && !c.undo && !c.redo ? "root switch" : "log flush"}
                  </div>
                  <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>pages / 1000 commits: {si(c.pageWritesPer1000)}</div>
                  <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>log / update: {c.logBytesPerUpdate ? `${c.logBytesPerUpdate} B` : "none"}</div>
                  {!c.fits && <div style={{ color: "var(--c4)", fontSize: 12, marginTop: 2 }}>A transaction of {k} pages does not fit in {Math.round(pool)} pages.</div>}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
      {(() => {
        const [a, b] = sel.split("/") as [StealPolicy, ForcePolicy];
        const c = policyCost(a, b, w);
        return (
          <Note>
            <b style={{ color: "var(--fg)" }}>{a.toUpperCase()} + {b.toUpperCase()}.</b> After a crash: {c.recovery} {a === "no-steal" ? `Every page that a live transaction changed must stay in memory, so one transaction can change at most ${Math.round(pool)} pages. ` : ""}Used by: {ENGINES[sel]}.
          </Note>
        );
      })()}
    </Demo>
  );
}

// ============================================================================
// Lesson 1: where an LSN lives in PostgreSQL
// ============================================================================

export function PgLsnDemo() {
  const [pos, setPos] = useState(50_331_744);
  const lsn = Math.round(pos);
  const w = pgWalPlace(lsn);
  const pagesPerSeg = PG_WAL_SEGMENT / PG_WAL_PAGE;
  return (
    <Demo
      title="An LSN is a byte position: PostgreSQL's WAL files"
      controls={<Param spec={range({ label: "Bytes of WAL written so far", min: 1024, max: 2 ** 42, default: 50_331_744, log: true, format: (v) => bytes(Math.round(v)) })} value={pos} onChange={(v) => setPos(v as number)} />}
    >
      <Stats items={[
        { label: "LSN (pg_current_wal_lsn)", value: <span style={mono}>{pgLsnText(lsn)}</span> },
        { label: "segment file in pg_wal/", value: <span style={{ ...mono, fontSize: 13 }}>{w.file}</span> },
        { label: "offset in the 16 MiB file", value: bytes(w.offsetInSegment) },
        { label: "8 KiB WAL page", value: `${w.walPage} of ${pagesPerSeg}` },
      ]} />
      <div style={{ marginTop: 10 }}>
        <SmallLabel>The segment file: {pagesPerSeg} WAL pages of 8 KiB</SmallLabel>
        <div style={{ position: "relative", height: 18, border: "1px solid var(--border)", borderRadius: 4, background: "var(--subtle)" }}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(w.offsetInSegment / PG_WAL_SEGMENT) * 100}%`, background: "var(--c1)", opacity: 0.35, borderRadius: 3 }} />
          <div style={{ position: "absolute", top: -3, bottom: -3, width: 2, left: `calc(${(w.offsetInSegment / PG_WAL_SEGMENT) * 100}% - 1px)`, background: "var(--c1)" }} />
        </div>
      </div>
      <Note>File name = timeline (8 hex digits) + LSN / 4 GiB (8 hex digits) + segment number within that 4 GiB (8 hex digits). The left half of the LSN text is the same LSN / 4 GiB.</Note>
    </Demo>
  );
}

// ============================================================================
// Lesson 2: the commit queue
// ============================================================================

const STATE_COLOR = { cpu: "var(--c1)", ready: "var(--c1)", queued: "var(--c2)", flushing: "var(--c3)" } as const;

export function CommitQueueDemo() {
  const [clients, setClients] = useState(8);
  const [fsync, setFsync] = useState(8.33);
  const [mode, setMode] = useState<CommitMode>("group");
  const [delay, setDelay] = useState(0);
  const p = useMemo(() => ({ clients: Math.round(clients), fsyncMs: fsync, mode, commitDelayMs: delay }), [clients, fsync, mode, delay]);
  const sim = useRef<GroupCommitSim>(new GroupCommitSim(p));
  const [key, setKey] = useState(0);
  useEffect(() => { sim.current = new GroupCommitSim(p); setKey((x) => x + 1); }, [p]);
  // One flush takes about 0.7 s of real time; async mode shows one WAL writer period in 0.7 s.
  const msPerSec = mode === "async" ? 300 : fsync * 1.4;
  const loop = useSim({ dt: 1 / 60, autoplay: true, step: (dt) => sim.current.advanceTo(sim.current.t + dt * msPerSec) });
  const steady: GcSummary = useMemo(() => gcSteady(p), [p]);
  const s = sim.current;
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = s.clients.length;
  const narrow = w < 460;
  const cols = Math.min(n, 16);
  const rowsN = Math.ceil(n / cols);
  const cell = 18;
  // Wide: clients left, device right. Narrow: device below the clients.
  const devX = narrow ? 0 : cols * cell + 24;
  const devY = narrow ? rowsN * cell + 8 : 4;
  const devW = Math.max(60, (narrow ? Math.max(w, 300) : Math.max(w, 300) - devX) - 4);
  const stripY = narrow ? devY + 60 : Math.max(rowsN * cell + 8, 64) + 6;
  const W = Math.max(w, 300);
  const f = s.flush;
  const prog = f ? Math.min(1, (s.t - f.start) / (f.end - f.start)) : 0;
  const win = msPerSec * 4;
  const recent = s.recent.filter((x) => x.end > s.t - win);
  const maxBatch = mode === "async" ? Math.max(1, ...recent.map((x) => x.count)) : Math.max(1, n);
  void key;
  return (
    <Demo
      title="Clients commit; the leader flushes everyone who is waiting"
      actions={<button className="btn" onClick={loop.toggle}>{loop.running ? "Pause" : "Play"}</button>}
      controls={
        <>
          <Param spec={range({ label: "Clients", min: 1, max: 32, step: 1, default: 8 })} value={clients} onChange={(v) => setClients(v as number)} />
          <Param spec={range({ label: "Flush time (fsync)", min: 0.05, max: 20, default: 8.33, log: true, format: (v) => `${v} ms` })} value={fsync} onChange={(v) => setFsync(v as number)} />
          <Param spec={seg("Commit", [["per-commit", "fsync per commit"], ["group", "Group commit"], ["async", "Async"]], "group")} value={mode} onChange={(v) => setMode(v as CommitMode)} />
          <Param spec={range({ label: "commit_delay", min: 0, max: 5, step: 0.1, default: 0, format: (v) => `${v} ms` })} value={delay} onChange={(v) => setDelay(v as number)} />
        </>
      }
    >
      <div ref={ref}>
        <svg width={W} height={stripY + 64} style={{ display: "block" }}>
          {s.clients.map((c, i) => (
            <circle key={i} cx={10 + (i % cols) * cell} cy={12 + Math.floor(i / cols) * cell} r={6.5} fill={mode === "async" ? STATE_COLOR.cpu : STATE_COLOR[c.state]} opacity={c.state === "ready" ? 0.4 : 1} />
          ))}
          <g transform={`translate(${devX},${devY})`}>
            <rect width={devW} height={52} rx={6} fill="var(--bg)" stroke="var(--border)" />
            <rect width={devW * prog} height={52} rx={6} fill="var(--c3)" opacity={0.25} />
            <text x={8} y={20} style={{ fill: "var(--fg)", fontSize: 12 }}>Log device</text>
            <text x={8} y={40} style={{ fill: "var(--muted)", fontSize: 12 }}>
              {f ? (mode === "async" ? `WAL writer flush: ${s.inFlushCount} commits` : `flushing ${f.batch.length} commit${f.batch.length === 1 ? "" : "s"}`) : s.leaderWaitUntil !== null ? "leader waits (commit_delay)" : "idle"}
            </text>
          </g>
          <g transform={`translate(0,${stripY})`}>
            <text x={0} y={10} style={{ fill: "var(--muted)", fontSize: 11 }}>Recent flushes: width = time, height = commits in the flush</text>
            <line x1={0} x2={W} y1={60} y2={60} stroke="var(--border)" />
            {recent.map((x, i) => {
              const x0 = ((x.start - (s.t - win)) / win) * W, x1 = ((Math.min(x.end, s.t) - (s.t - win)) / win) * W;
              const b = x.count;
              const h = Math.max(3, (b / maxBatch) * 44);
              return <rect key={i} x={Math.max(0, x0)} y={60 - h} width={Math.max(1.5, x1 - Math.max(0, x0) - 1)} height={h} fill="var(--c3)" opacity={x.end > s.t ? 0.5 : 0.85} />;
            })}
          </g>
        </svg>
      </div>
      <Legend box items={[{ label: "running a transaction", color: "var(--c1)" }, { label: "waiting for a flush", color: "var(--c2)" }, { label: "in the current flush", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "commits / s (steady state)", value: si(steady.throughput) },
          { label: "mean commit latency", value: mode === "async" ? "0 (no wait)" : `${steady.meanLatencyMs.toFixed(2)} ms` },
          { label: "commits per flush", value: steady.meanBatch.toFixed(1) },
          { label: "flushes / s", value: si(steady.flushesPerSec) },
          ...(mode === "async" ? [{ label: "acknowledged but not durable (max)", value: `${si(steady.maxAtRisk)} commits, ${steady.maxRiskAgeMs.toFixed(0)} ms` }] : []),
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================
// Lesson 2: commits/s against clients
// ============================================================================

const SERIES: { id: string; label: string; color: string; mode: CommitMode; delay: boolean }[] = [
  { id: "per", label: "fsync per commit", color: "var(--c4)", mode: "per-commit", delay: false },
  { id: "group", label: "group commit", color: "var(--c1)", mode: "group", delay: false },
  { id: "delay", label: "group commit + commit_delay", color: "var(--c5)", mode: "group", delay: true },
  { id: "async", label: "asynchronous commit", color: "var(--c3)", mode: "async", delay: false },
];

export function CommitScalingDemo() {
  const [dev, setDev] = useState<keyof typeof DEVICES>("hdd");
  const [fsync, setFsync] = useState<number>(DEVICES.hdd.fsyncMs);
  const [delay, setDelay] = useState(1);
  const [y, setY] = useState<"tput" | "lat">("tput");
  const [data, setData] = useState<Record<string, GcSummary[]>>({});
  useEffect(() => {
    let live = true;
    const out: Record<string, GcSummary[]> = {};
    const jobs = SERIES.flatMap((s) => CLIENT_COUNTS.map((n) => ({ s, n })));
    let i = 0;
    const tick = () => {
      if (!live) return;
      const end = Math.min(jobs.length, i + 4);
      for (; i < end; i++) {
        const { s, n } = jobs[i]!;
        (out[s.id] ??= []).push(gcSteady({ clients: n, fsyncMs: fsync, mode: s.mode, commitDelayMs: s.delay ? delay : 0 }, 800));
      }
      setData({ ...out });
      if (i < jobs.length) setTimeout(tick, 0);
    };
    const t = setTimeout(tick, 0);
    return () => { live = false; clearTimeout(t); };
  }, [fsync, delay]);
  const pts = (id: string) => (data[id] ?? []).map((d) => [d.clients, y === "tput" ? Math.max(1, d.throughput) : Math.max(0.01, d.meanLatencyMs)] as const);
  const shown = SERIES.filter((s) => y === "tput" || s.mode !== "async");
  const at = (id: string, n: number) => data[id]?.find((d) => d.clients === n);
  return (
    <Demo
      title="Commits per second as clients are added"
      controls={
        <>
          <Param spec={seg("Device", [["hdd", "HDD"], ["ssd", "Consumer SSD"], ["plp", "SSD with PLP"]], "hdd")} value={dev} onChange={(v) => { const d = v as keyof typeof DEVICES; setDev(d); setFsync(DEVICES[d].fsyncMs); }} />
          <Param spec={range({ label: "Flush time (fsync)", min: 0.02, max: 20, default: DEVICES.hdd.fsyncMs, log: true, format: (v) => `${Number(v.toPrecision(3))} ms` })} value={fsync} onChange={(v) => setFsync(v as number)} />
          <Param spec={range({ label: "commit_delay", min: 0.1, max: 10, default: 1, log: true, format: (v) => `${v} ms` })} value={delay} onChange={(v) => setDelay(v as number)} />
          <Param spec={seg("Show", [["tput", "Commits / s"], ["lat", "Commit latency"]], "tput")} value={y} onChange={(v) => setY(v as "tput" | "lat")} />
        </>
      }
    >
      <Plot x={[1, 128]} y={y === "tput" ? [10, 100_000] : [0.01, 2000]} logX logY xTicks={CLIENT_COUNTS} yTicks={y === "tput" ? [10, 100, 1000, 10_000, 100_000] : [0.01, 0.1, 1, 10, 100, 1000]} xLabel="clients" yLabel={y === "tput" ? "commits / s" : "mean commit latency (ms)"} xFormat={(v) => String(v)} yFormat={(v) => si(v)}>
        {shown.map((s) => <Line key={s.id} points={pts(s.id)} color={s.color} />)}
        {shown.map((s) => <Dots key={s.id} points={pts(s.id)} color={s.color} r={2.5} />)}
      </Plot>
      <Legend items={shown.map((s) => ({ label: s.label, color: s.color }))} />
      <Stats items={[
        { label: "fsync-per-commit limit (1 / F)", value: `${si(1000 / fsync)} /s` },
        { label: "group commit, 32 clients", value: at("group", 32) ? `${si(at("group", 32)!.throughput)} /s, ${at("group", 32)!.meanBatch.toFixed(1)} per flush` : "…" },
        { label: "CPU limit (8 cores × 0.2 ms)", value: `${si(8 / 0.0002)} /s` },
      ]} />
    </Demo>
  );
}

// ============================================================================
// Lesson 3: the same operations, logged four ways
// ============================================================================

const REGION = (i: number, p: LF.PageBytes) => (i < 4 ? "hdr" : i < 4 + p[1]! ? "slot" : i >= p[2]! ? "rec" : "free");
const REGION_COLOR: Record<string, string> = { hdr: "var(--c1)", slot: "var(--c5)", rec: "var(--c3)", free: "var(--border)" };

function ByteGrid({ page, changed, tornOld, label }: { page: LF.PageBytes; changed?: Set<number>; tornOld?: Set<number>; label?: string }) {
  const ok = LF.checksumOk(page);
  return (
    <div style={{ minWidth: 0 }}>
      {label && <SmallLabel>{label}</SmallLabel>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(16, minmax(0, 1fr))", gap: 2, ...mono }}>
        {Array.from(page).map((b, i) => {
          const r = REGION(i, page);
          const ch = b >= 97 && b <= 122 ? String.fromCharCode(b) : b >= 48 && b <= 57 && r === "rec" ? String.fromCharCode(b) : r === "free" && b === 0 ? "" : String(b);
          const c = REGION_COLOR[r]!;
          return (
            <div key={i} title={`byte ${i}`} style={{
              height: 20, display: "grid", placeItems: "center", fontSize: 10, borderRadius: 3, overflow: "hidden",
              background: r === "free" ? "var(--subtle)" : `color-mix(in srgb, ${c} 18%, var(--bg))`,
              border: `1px solid ${changed?.has(i) ? "var(--c2)" : r === "free" ? "var(--border)" : c}`,
              outline: changed?.has(i) ? "1.5px solid var(--c2)" : undefined,
              opacity: tornOld?.has(i) ? 0.55 : 1,
            }}>{ch}</div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>pageLSN {page[0]} · {page[1]} slots · checksum {ok ? "ok" : <b style={{ color: "var(--c4)" }}>FAILS</b>}</div>
    </div>
  );
}

const FORM_SEG = seg<LF.Form>("Log form", [["physical", "Physical"], ["physiological", "Physiological"], ["fpw", "Physio + FPW"], ["logical", "Logical"]], "physical");

export function LogFormsDemo() {
  const [op, setOp] = useState(3);
  const [form, setForm] = useState<LF.Form>("physical");
  const states = useMemo(() => LF.pageStates(), []);
  const log = useMemo(() => LF.buildLog(form), [form]);
  const k = Math.round(op);
  const prev = states[k - 1]!, cur = states[k]!;
  const changed = new Set<number>();
  for (let i = 0; i < LF.PAGE_BYTES; i++) if (prev[i] !== cur[i]) changed.add(i);
  const sizes = LF.FORMS.map((f) => ({ ...f, b: LF.logBytes(f.id) }));
  const maxB = Math.max(...sizes.map((s) => s.b));
  return (
    <Demo
      title="Five operations on one page, logged four ways"
      controls={
        <>
          <Param spec={range({ label: "After operation", min: 1, max: 5, step: 1, default: 3 })} value={op} onChange={(v) => setOp(v as number)} />
          <Param spec={FORM_SEG} value={form} onChange={(v) => setForm(v as LF.Form)} />
        </>
      }
    >
      <ByteGrid page={cur} changed={changed} label={`The page after operation ${k}: ${LF.OPS[k - 1]!.sql}. Orange outlines mark the ${changed.size} bytes that it changed.`} />
      <div style={{ marginTop: 6 }}><Legend box items={[{ label: "header: LSN, slots, free start, checksum", color: "var(--c1)" }, { label: "slot directory", color: "var(--c5)" }, { label: "records", color: "var(--c3)" }]} /></div>
      <div style={{ marginTop: 12 }}>
        <SmallLabel>The {LF.FORMS.find((f) => f.id === form)!.label.toLowerCase()} log. The checkpoint is after LSN {LF.CHECKPOINT_AFTER}; replay reads only the records after it.</SmallLabel>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6 }}>
          {log.map((e) => (
            <div key={e.lsn} style={{ display: "flex", gap: 8, padding: "3px 8px", fontSize: 12, alignItems: "baseline", background: e.lsn === k ? "var(--subtle)" : undefined, opacity: e.lsn <= LF.CHECKPOINT_AFTER ? 0.5 : 1, borderTop: e.lsn === LF.CHECKPOINT_AFTER + 1 ? "1px dashed var(--muted)" : undefined }}>
              <span style={{ ...mono, color: "var(--muted)", width: 14 }}>{e.lsn}</span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{e.text}</span>
              <span style={{ ...mono, color: "var(--muted)" }}>{e.bytes} B</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <SmallLabel>Log bytes that replay reads (LSN 3 to 5), toy encoding with a {LF.TOY_HEADER}-byte header</SmallLabel>
        {sizes.map((s) => (
          <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, margin: "3px 0" }}>
            <span style={{ width: 150, flex: "none", fontWeight: s.id === form ? 600 : 400 }}>{s.label}</span>
            <div style={{ flex: 1, minWidth: 0, height: 10, background: "var(--subtle)", borderRadius: 3 }}>
              <div style={{ width: `${(s.b / maxB) * 100}%`, height: "100%", background: s.id === form ? "var(--c1)" : "var(--faint)", borderRadius: 3 }} />
            </div>
            <span style={{ ...mono, width: 40, textAlign: "right" }}>{s.b} B</span>
          </div>
        ))}
      </div>
    </Demo>
  );
}

export function ReplayDemo() {
  const [form, setForm] = useState<LF.Form>("physiological");
  const [disk, setDisk] = useState<LF.DiskCase>("final");
  const [check, setCheck] = useState(false);
  const dp = useMemo(() => LF.diskPage(disk), [disk]);
  const r = useMemo(() => LF.replay(form, dp, check), [form, dp, check]);
  const table = useMemo(() => LF.verdictTable(check), [check]);
  const tornOld = new Set<number>();
  if (disk === "torn") for (let i = 0; i < LF.PAGE_BYTES; i++) if (!LF.TORN_NEW_SECTORS.includes(Math.floor(i / LF.SECTOR_BYTES))) tornOld.add(i);
  const V = { correct: { t: "correct", c: "var(--c3)" }, wrong: { t: "wrong", c: "var(--c4)" }, refused: { t: "refused", c: "var(--c2)" } } as const;
  return (
    <Demo
      title="Replay the log on the page that survived the crash"
      controls={
        <>
          <Param spec={seg<LF.DiskCase>("Page on disk", [["checkpoint", "As of checkpoint"], ["after4", "After op 4"], ["final", "After op 5"], ["torn", "Torn"]], "final")} value={disk} onChange={(v) => setDisk(v as LF.DiskCase)} />
          <Param spec={FORM_SEG} value={form} onChange={(v) => setForm(v as LF.Form)} />
          <Param spec={toggle({ label: "Skip a record when pageLSN ≥ its LSN", default: false })} value={check} onChange={(v) => setCheck(v as boolean)} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <ByteGrid page={dp} tornOld={tornOld} label={disk === "torn" ? "On disk: only the first 16-byte sector of the new page arrived (faded bytes are old)" : `On disk: ${LF.DISK_CASES.find((c) => c.id === disk)!.label.toLowerCase()}`} />
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <ByteGrid page={r.page} label={`After replay of LSN 3 to 5: ${r.applied} applied, ${r.skipped} skipped`} />
        </div>
      </div>
      <Banner ok={r.verdict === "correct"}><b style={{ color: V[r.verdict].c }}>{V[r.verdict].t}.</b> {r.note}</Banner>
      <SmallLabel>Every combination {check ? "with" : "without"} the pageLSN check (logical records cannot use it)</SmallLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontWeight: 500, color: "var(--muted)", padding: 3 }}></th>
              {LF.DISK_CASES.map((c) => <th key={c.id} style={{ fontWeight: 500, color: "var(--muted)", padding: 3, fontSize: 11 }}>{c.id === "checkpoint" ? "ckpt" : c.id === "after4" ? "op 4" : c.id === "final" ? "op 5" : "torn"}</th>)}
            </tr>
          </thead>
          <tbody>
            {LF.FORMS.map((f) => (
              <tr key={f.id} style={{ background: f.id === form ? "var(--subtle)" : undefined }}>
                <td style={{ padding: 3 }}>{f.label}</td>
                {LF.DISK_CASES.map((c) => {
                  const v = V[table[f.id][c.id]];
                  return <td key={c.id} style={{ padding: 3, textAlign: "center", color: v.c, fontWeight: c.id === disk && f.id === form ? 700 : 500 }}>{v.t}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Demo>
  );
}
