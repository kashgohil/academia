/** Demos for "the page cache and writeback": a write burst against the dirty limits, and read-ahead. */
import { useMemo, useState } from "react";
import { Area, Demo, Legend, Line, Param, Plot, RuleX, RuleY, Stats, bytes, range, select, useParams, Banner, MONO, Note, SmallLabel } from "../../kit";
import { BURST_DEFAULTS, READ_AHEAD_DEFAULT_KB, Readahead, burstRun, raPages, type RaResult, type WriterState } from "../../sims/os/fs/pagecache";
import { smallBtn } from "./FsUi";

const W = {
  dirtyRatio: range({ label: "vm.dirty_ratio", min: 1, max: 60, step: 1, default: BURST_DEFAULTS.dirtyRatio, format: (v) => `${v}%` }),
  bgRatio: range({ label: "vm.dirty_background_ratio", min: 1, max: 50, step: 1, default: BURST_DEFAULTS.dirtyBackgroundRatio, format: (v) => `${v}%` }),
  disk: range({ label: "Disk speed (model input)", min: 20, max: 3000, log: true, default: BURST_DEFAULTS.diskMiBps, format: (v) => `${Math.round(v)} MiB/s` }),
  burst: range({ label: "Burst size", min: 256, max: 16384, log: true, default: BURST_DEFAULTS.burstMiB, format: (v) => bytes(Math.round(v) * 1048576) }),
  writer: range({ label: "Writer speed (model input)", min: 100, max: 5000, log: true, default: BURST_DEFAULTS.writerMiBps, format: (v) => `${Math.round(v)} MiB/s` }),
  cursor: range({ label: "Time cursor", min: 0, max: 1, step: 0.005, default: 0.12, format: (v) => `${Math.round(v * 100)}%` }),
};

const STATE_NAME: Record<WriterState, string> = { free: "free run", throttled: "throttled", blocked: "blocked at the limit", idle: "finished" };
const STATE_COLOR: Record<WriterState, string> = { free: "var(--c3)", throttled: "var(--c2)", blocked: "var(--c4)", idle: "var(--muted)" };
const secs = (v: number | null) => (v === null ? "never" : `${v.toFixed(1)} s`);

export function FsWriteBurstDemo() {
  const P = useParams("os-fs-burst", W);
  const { dirtyRatio, bgRatio, disk, burst, writer, cursor } = P.values;
  const run = useMemo(() => burstRun({ dirtyRatio, dirtyBackgroundRatio: bgRatio, diskMiBps: disk, burstMiB: burst, writerMiBps: writer }), [dirtyRatio, bgRatio, disk, burst, writer]);
  const L = run.limits;
  const every = 4;
  const samp = run.samples.filter((_, i) => i % every === 0);
  const tEnd = run.samples[run.samples.length - 1]!.t;
  const at = run.samples[Math.min(run.samples.length - 1, Math.round(cursor * (run.samples.length - 1)))]!;
  const yMax = Math.max(L.limit * 1.1, run.peakDirty * 1.05, 100);
  const dirtyable = BURST_DEFAULTS.dirtyableMiB;
  const barScale = (v: number) => `${Math.min(100, (v / yMax) * 100)}%`;
  return (
    <Demo title="A write burst against the dirty limits" controls={<>
      <Param spec={W.dirtyRatio} value={dirtyRatio} onChange={(v) => P.set("dirtyRatio", v as number)} />
      <Param spec={W.bgRatio} value={bgRatio} onChange={(v) => P.set("bgRatio", v as number)} />
      <Param spec={W.disk} value={disk} onChange={(v) => P.set("disk", v as number)} />
      <Param spec={W.burst} value={burst} onChange={(v) => P.set("burst", v as number)} />
      <Param spec={W.writer} value={writer} onChange={(v) => P.set("writer", v as number)} />
      <Param spec={W.cursor} value={cursor} onChange={(v) => P.set("cursor", v as number)} />
    </>}>
      <SmallLabel>Dirty memory at the cursor: t = {at.t.toFixed(1)} s, writer: <span style={{ color: STATE_COLOR[at.state] }}>{STATE_NAME[at.state]}</span>, flusher: {at.flushing ? "writing" : "asleep"}</SmallLabel>
      <div style={{ position: "relative", height: 26, background: "var(--subtle)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: barScale(at.dirty), background: STATE_COLOR[at.state], opacity: 0.8 }} />
        {[["bg", L.bg], ["free run", L.freerun], ["limit", L.limit]].map(([n, v]) => (
          <div key={n as string} style={{ position: "absolute", left: barScale(v as number), top: 0, bottom: 0, borderLeft: "1.5px solid var(--fg)" }}>
            <span style={{ position: "absolute", left: 3, top: 5, fontSize: 10.5, whiteSpace: "nowrap", color: "var(--fg)" }}>{n as string}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Plot x={[0, tEnd]} y={[0, yMax]} height={220} xLabel="seconds" yLabel="dirty memory, MiB">
          <Area points={samp.map((s) => [s.t, s.dirty])} color="var(--c1)" opacity={0.18} />
          <Line points={samp.map((s) => [s.t, s.dirty])} color="var(--c1)" />
          <RuleY at={L.bg} label="background" color="var(--c3)" />
          <RuleY at={L.freerun} label="free run" color="var(--c2)" />
          <RuleY at={L.limit} label="dirty limit" color="var(--c4)" />
          <RuleX at={at.t} />
        </Plot>
      </div>
      <div style={{ marginTop: 6 }}>
        <Plot x={[0, tEnd]} y={[0.5, Math.max(writer, disk) * 1.3]} logY height={150} xLabel="seconds" yLabel="MiB/s" yTicks={[1, 10, 100, 1000, 10000].filter((t) => t <= Math.max(writer, disk) * 1.3)} yFormat={(v) => String(v)}>
          <Line points={samp.map((s) => [s.t, Math.max(0.5, s.writerRate)])} color="var(--c2)" />
          <Line points={samp.map((s) => [s.t, s.flushing ? disk : 0.5])} color="var(--c3)" />
          <RuleX at={at.t} />
        </Plot>
        <Legend items={[{ label: "writer gets", color: "var(--c2)" }, { label: "flusher writes", color: "var(--c3)" }]} />
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "flusher starts", value: secs(run.firstFlushAt) },
          { label: "writer slows at", value: secs(run.throttleAt) },
          { label: "burst accepted at", value: secs(run.burstDoneAt) },
          { label: "all on disk at", value: secs(run.cleanAt) },
          { label: "peak dirty", value: bytes(Math.round(run.peakDirty) * 1048576) },
          { label: "fsync at end of burst", value: secs(run.syncAtBurstEnd) },
        ]} />
      </div>
      <Note>Dirtyable memory (model input): {bytes(dirtyable * 1048576)}. Thresholds in MiB: background {Math.round(L.bg)}, free run {Math.round(L.freerun)}, setpoint {Math.round(L.setpoint)}, limit {Math.round(L.limit)}. Between free run and the limit, the writer gets the disk speed times the kernel's position ratio.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- read-ahead

const R = {
  kb: select({ label: "read_ahead_kb", segmented: true, options: [32, 128, 512, 1024].map((k) => ({ value: String(k), label: String(k) })), default: String(READ_AHEAD_DEFAULT_KB) }),
};
const PAGES = 192, COLS = 32, CELL = 12.5;

export function FsReadaheadDemo() {
  const P = useParams("os-fs-ra", R);
  const kb = Number(P.values.kb);
  const [ra, setRa] = useState(() => new Readahead(raPages(kb)));
  const [pos, setPos] = useState(0);
  const [last, setLast] = useState<RaResult | null>(null);
  const [events, setEvents] = useState<RaResult[]>([]);
  const reset = (k = kb) => { setRa(new Readahead(raPages(k))); setPos(0); setLast(null); setEvents([]); };
  const doRead = (index: number, n = 1) => {
    const out: RaResult[] = [];
    let i = index;
    for (let c = 0; c < n && i < PAGES; c++, i++) out.push(ra.read(i));
    setPos(i);
    setLast(out[out.length - 1] ?? null);
    setEvents([...events, ...out]);
  };
  const jump = () => {
    doRead(ra.jumpTarget(pos, PAGES));
  };
  const lastWindow = ra.size > 0 ? { start: ra.start, end: ra.start + ra.size } : null;
  const waits = events.filter((e) => e.sync).length;
  const bars = ra.windows;
  const barMax = Math.max(...bars, raPages(kb));
  return (
    <Demo
      title="Read-ahead on one open file"
      actions={
        <>
          <button className="btn primary" disabled={pos >= PAGES} onClick={() => doRead(pos)}>Read next page</button>
          <button className="btn" style={smallBtn} disabled={pos >= PAGES} onClick={() => doRead(pos, 16)}>Read 16</button>
          <button className="btn" style={smallBtn} onClick={jump}>Jump</button>
          <button className="btn ghost" onClick={() => reset()}>Reset</button>
        </>
      }
      controls={<Param spec={R.kb} value={P.values.kb} onChange={(v) => { P.set("kb", v as never); reset(Number(v)); }} />}
    >
      <svg viewBox={`0 0 ${COLS * CELL} ${(PAGES / COLS) * CELL}`} style={{ width: "100%", maxWidth: 640, display: "block" }} role="img" aria-label="file pages">
        {Array.from({ length: PAGES }, (_, p) => {
          const cached = ra.cached.has(p), used = ra.used.has(p), mark = ra.markers.has(p);
          const inWin = lastWindow && p >= lastWindow.start && p < lastWindow.end;
          const x = (p % COLS) * CELL, y = Math.floor(p / COLS) * CELL;
          return (
            <g key={p}>
              <rect x={x + 0.5} y={y + 0.5} width={CELL - 1} height={CELL - 1} rx={1.5} fill={used ? "var(--c1)" : cached ? "var(--c3)" : "var(--subtle)"} opacity={used ? 0.9 : cached ? 0.55 : 1} stroke={inWin ? "var(--fg)" : "none"} strokeWidth={0.8} />
              {mark && <circle cx={x + CELL / 2} cy={y + CELL / 2} r={2.5} fill="var(--c4)" />}
              {p === pos && <rect x={x + 0.5} y={y + 0.5} width={CELL - 1} height={CELL - 1} rx={1.5} fill="none" stroke="var(--c2)" strokeWidth={1.6} />}
            </g>
          );
        })}
      </svg>
      <div className="legend" style={{ marginTop: 4 }}>
        <span style={{ ["--swatch" as string]: "var(--c1)" }}>read by the program</span>
        <span style={{ ["--swatch" as string]: "var(--c3)" }}>read ahead, in the cache</span>
        <span style={{ ["--swatch" as string]: "var(--c4)" }}>marker (PG_readahead)</span>
        <span style={{ ["--swatch" as string]: "var(--c2)" }}>next page</span>
      </div>
      <Banner>{last ? last.say : "The cache is empty. Read page 0."}</Banner>
      <div style={{ marginTop: 10 }}>
        <SmallLabel>Window size of each read-ahead, in pages</SmallLabel>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 54, overflowX: "auto" }}>
          {bars.length === 0 && <span className="muted" style={{ fontSize: 12 }}>none yet</span>}
          {bars.map((b, i) => (
            <div key={i} style={{ flex: "none", width: 18, textAlign: "center" }}>
              <div style={{ fontSize: 9.5, fontFamily: MONO }}>{b}</div>
              <div style={{ height: (b / barMax) * 38, background: "var(--c3)", opacity: 0.8, borderRadius: 1 }} />
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "reads", value: events.length },
          { label: "reads that waited for the disk", value: waits },
          { label: "cache hits", value: ra.hits },
          { label: "pages from disk", value: ra.pagesRead },
          { label: "maximum window", value: `${raPages(kb)} pages` },
        ]} />
      </div>
      <Note>The struct file_ra_state now says start {ra.start}, size {ra.size}, async_size {ra.asyncSize}. Each page is 4 KiB. A real kernel also forms large folios, which this model leaves out.</Note>
    </Demo>
  );
}
