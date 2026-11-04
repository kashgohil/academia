/** Demos for the Storage module: disks and SSDs, slotted pages, heap files. Lessons 4–6 are in StorageDemosB.tsx. */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, Dots, Legend, range, toggle, useParams, useSim, useWidth, SimButtons, bytes, pct } from "../../kit";
import {
  HDDS, type HddId, hddAccess, ssdRead, SSD_NVME, SSD_SATA, hddIopsAtQd, Ftl, ftlStream, steadyWa, PAGE_VALID, PAGE_INVALID,
  type FtlWorkload, type FtlEvent,
  SlottedPage, LP_NORMAL, LP_DEAD, LP_UNUSED, PAGE_HEADER, SLOT_BYTES, alignUp, pgTupleLayout, type PgColumn, type PgType, toastThreshold,
  heapRun, type InsertStrategy, FreeSpaceMap, availToCat, needToCat, fsmStep, tablePages, scanMs, rowsPerPage,
} from "../../sims/db/storage";
import { seg, mono, Note, Caption, StackBar, useChunked, fx, ms } from "./StorageUi";

// =====================================================================================
// Lesson 1: Disks vs SSDs
// =====================================================================================

const DISK_OPTS: [HddId, string][] = [["5400", "5,400 rpm"], ["7200", "7,200 rpm"], ["10k", "10k rpm"], ["15k", "15k rpm"]];
const SIZES = Array.from({ length: 41 }, (_, i) => 512 * Math.pow(2, (i * 13) / 40));

export function AccessTimeDemo() {
  const p = useParams("atime", {
    size: range({ label: "Request size", min: 512, max: 4 * 2 ** 20, log: true, default: 4096, format: (v) => bytes(Math.round(v)) }),
    disk: seg<HddId>("Disk", DISK_OPTS, "7200"),
  });
  const size = Math.round(p.values.size);
  const d = HDDS[p.values.disk];
  const rnd = hddAccess(d, size, "random");
  const seq = hddAccess(d, size, "sequential");
  const nv1 = ssdRead(SSD_NVME, size, 1), nv32 = ssdRead(SSD_NVME, size, 32);
  const curves = useMemo(() => ({
    hr: SIZES.map((b) => [b, hddAccess(d, b, "random").mbps] as const),
    hs: SIZES.map((b) => [b, hddAccess(d, b, "sequential").mbps] as const),
    s1: SIZES.map((b) => [b, ssdRead(SSD_NVME, b, 1).mbps] as const),
    s32: SIZES.map((b) => [b, ssdRead(SSD_NVME, b, 32).mbps] as const),
  }), [d]);
  const COL = { seek: "var(--c4)", rotate: "var(--c2)", transfer: "var(--c3)" };
  return (
    <Demo title="Where the time of one read goes" controls={<><Param spec={p.schema.size} value={p.values.size} onChange={(v) => p.set("size", v as number)} /><Param spec={p.schema.disk} value={p.values.disk} onChange={(v) => p.set("disk", v as HddId)} /></>}>
      <Caption>One random read of {bytes(size)} on a {d.name}: {ms(rnd.total)} in total</Caption>
      <StackBar parts={[{ label: "seek", value: rnd.seek, color: COL.seek }, { label: "rotate", value: rnd.rotate, color: COL.rotate }, { label: "transfer", value: rnd.transfer, color: COL.transfer }]} />
      <div style={{ margin: "6px 0 12px" }}>
        <Legend items={[{ label: `seek ${ms(rnd.seek)}`, color: COL.seek }, { label: `rotation ${ms(rnd.rotate)}`, color: COL.rotate }, { label: `transfer ${ms(rnd.transfer)}`, color: COL.transfer }]} />
      </div>
      <Plot x={[512, 4 * 2 ** 20]} y={[0.01, 5000]} logX logY height={240} xLabel="request size" yLabel="MB/s" xTicks={[512, 4096, 65536, 1048576]} xFormat={(v) => bytes(v)} yTicks={[0.01, 0.1, 1, 10, 100, 1000]} yFormat={(v) => String(v)}>
        <Line points={curves.hr} color="var(--c4)" />
        <Line points={curves.hs} color="var(--c4)" dash="5 4" />
        <Line points={curves.s1} color="var(--c1)" />
        <Line points={curves.s32} color="var(--c1)" dash="5 4" />
        <RuleX at={size} />
        <Dots points={[[size, rnd.mbps], [size, nv1.mbps]]} color="var(--fg)" r={3.5} />
      </Plot>
      <Legend items={[{ label: "disk, random", color: "var(--c4)" }, { label: "disk, sequential (dashed)", color: "var(--c4)" }, { label: "NVMe SSD, random, 1 at a time", color: "var(--c1)" }, { label: "NVMe SSD, 32 at a time (dashed)", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "disk random reads/s", value: fx(rnd.iops) },
        { label: "disk random MB/s", value: fx(rnd.mbps) },
        { label: "disk sequential MB/s", value: fx(seq.mbps) },
        { label: "sequential ÷ random", value: `${fx(seq.mbps / rnd.mbps)}×` },
        { label: "SSD latency, 1 read", value: `${fx(nv1.latUs)} µs` },
        { label: "SSD MB/s, 32 at a time", value: fx(nv32.mbps) },
      ]} />
    </Demo>
  );
}

const Platter = lazy(() => import("./StorageDisk3D").then((m) => ({ default: m.Disk3DDemo })));

export function DiskPlatterDemo() {
  return <Suspense fallback={<div className="demo" style={{ height: 460, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>}><Platter /></Suspense>;
}

// ---------------- queue depth ----------------

const QDS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

export function QueueDepthDemo() {
  const p = useParams("qd", { qd: range({ label: "Queue depth (requests in flight)", min: 1, max: 256, log: true, default: 1, format: (v) => String(Math.round(v)) }) });
  const qd = Math.round(p.values.qd);
  const d = HDDS["7200"];
  const hdd = useMemo(() => QDS.map((q) => ({ q, fifo: hddIopsAtQd(d, q, "fifo"), elev: hddIopsAtQd(d, q, "elevator") })), [d]);
  const sata = (q: number) => ssdRead(SSD_SATA, 4096, Math.min(q, 32)).iops;
  const nvme = (q: number) => ssdRead(SSD_NVME, 4096, q).iops;
  const near = hdd.reduce((a, b) => (Math.abs(Math.log(b.q / qd)) < Math.abs(Math.log(a.q / qd)) ? b : a));
  const nv = ssdRead(SSD_NVME, 4096, qd);
  return (
    <Demo title="4 KiB random reads: more requests in flight" controls={<Param spec={p.schema.qd} value={p.values.qd} onChange={(v) => p.set("qd", v as number)} />}>
      <Plot x={[1, 256]} y={[30, 2e6]} logX logY height={250} xLabel="queue depth" yLabel="reads per second" xTicks={QDS} xFormat={String} yTicks={[100, 1e3, 1e4, 1e5, 1e6]} yFormat={(v) => fx(v, 1)}>
        <Line points={hdd.map((h) => [h.q, h.fifo] as const)} color="var(--c4)" dash="5 4" />
        <Line points={hdd.map((h) => [h.q, h.elev] as const)} color="var(--c4)" />
        <Line points={QDS.map((q) => [q, sata(q)] as const)} color="var(--c2)" />
        <Line points={QDS.map((q) => [q, nvme(q)] as const)} color="var(--c1)" />
        <RuleX at={qd} />
      </Plot>
      <Legend items={[{ label: "7,200 rpm disk, FIFO (dashed)", color: "var(--c4)" }, { label: "disk, elevator order", color: "var(--c4)" }, { label: "SATA SSD (at most 32 queued)", color: "var(--c2)" }, { label: "NVMe SSD", color: "var(--c1)" }]} />
      <Stats items={[
        { label: `disk, elevator, ${near.q} queued`, value: fx(near.elev) },
        { label: "SATA SSD", value: fx(sata(qd)) },
        { label: "NVMe SSD", value: fx(nv.iops) },
        { label: "NVMe latency per read", value: `${fx((qd / nv.iops) * 1e6)} µs` },
      ]} />
      <Note>Latency here follows Little's law: requests in flight ÷ reads per second. When the SSD saturates, more depth only adds waiting time.</Note>
    </Demo>
  );
}

// ---------------- FTL ----------------

const FTL_BLOCKS = 32, FTL_PPB = 16;
type FtlState = { ftl: Ftl; next: () => number; last: FtlEvent[]; gcRuns: number; erasedLast: number };

function freshFtl(op: number, workload: FtlWorkload, gc: "greedy" | "fifo"): FtlState {
  const ftl = new Ftl({ blocks: FTL_BLOCKS, pagesPerBlock: FTL_PPB, op, gc });
  for (let l = 0; l < ftl.logical; l++) ftl.write(l);
  ftl.resetCounters();
  ftl.recordEvents = true;
  return { ftl, next: ftlStream(workload, ftl.logical, 9), last: [], gcRuns: 0, erasedLast: -1 };
}

const OP_CURVE = [0.05, 0.07, 0.1, 0.15, 0.2, 0.28, 0.4, 0.6, 1];

export function FtlDemo() {
  const p = useParams("ftl", {
    op: seg("Over-provisioning", [["0.1", "10%"], ["0.28", "28%"], ["0.5", "50%"]], "0.1"),
    wl: seg<FtlWorkload>("Host writes", [["random", "Random pages"], ["hotcold", "80% to 20% of pages"], ["sequential", "Sequential"]], "random"),
    gc: seg("Victim choice", [["greedy", "Fewest valid pages"], ["fifo", "Oldest block"]], "greedy"),
    speed: seg("Writes per step", [["1", "1"], ["8", "8"], ["64", "64"]], "1"),
  });
  const v = p.values;
  const st = useRef<FtlState | null>(null);
  const [, force] = useState(0);
  if (!st.current) st.current = freshFtl(Number(v.op), v.wl, v.gc as "greedy" | "fifo");
  const restart = (op = v.op, wl = v.wl, gc = v.gc) => { st.current = freshFtl(Number(op), wl, gc as "greedy" | "fifo"); force((x) => x + 1); };
  const sim = useSim({
    dt: 1 / 4,
    step: () => {
      const s = st.current!;
      s.ftl.events = [];
      const before = s.ftl.erases;
      for (let k = 0; k < Number(v.speed); k++) s.ftl.write(s.next());
      s.last = s.ftl.events;
      s.gcRuns += s.ftl.erases - before;
      const er = s.last.filter((e) => e.kind === "erase");
      s.erasedLast = er.length ? er[er.length - 1]!.at : -1;
    },
    reset: () => restart(),
  });
  const s = st.current;
  const f = s.ftl;
  // At 64 writes per step almost every page changes, so only show the states.
  const marks = Number(v.speed) <= 8 ? s.last : [];
  const lastHost = new Set(marks.filter((e) => e.kind === "host").map((e) => e.at));
  const lastCopy = new Set(marks.filter((e) => e.kind === "gc-copy").map((e) => e.at));
  const lastOld = new Set(marks.filter((e) => e.kind === "host" && e.old >= 0).map((e) => e.old));
  const curve = useChunked(`ftlcurve:${v.wl}:${v.gc}`, OP_CURVE.map((op) => () => steadyWa(op, v.wl, { warm: 2, measure: 4, gc: v.gc as "greedy" | "fifo" })));
  const pts = OP_CURVE.map((op, i) => [op * 100, curve[i]] as const).filter((x): x is readonly [number, number] => x[1] !== undefined);
  const CW = 11, CH = 8;
  const W = FTL_BLOCKS * CW, H = FTL_PPB * CH + 12;
  const describe = () => {
    const host = s.last.filter((e) => e.kind === "host");
    if (!host.length) return "Press Play or Step. The drive is full: every logical page was written once.";
    const h = host[host.length - 1]!;
    const copies = s.last.filter((e) => e.kind === "gc-copy").length;
    const erases = s.last.filter((e) => e.kind === "erase").length;
    let t = `Host writes logical page ${h.lpn} to block ${Math.floor(h.at / FTL_PPB)}, page ${h.at % FTL_PPB}.`;
    if (h.old >= 0) t += ` Its old copy in block ${Math.floor(h.old / FTL_PPB)} becomes invalid.`;
    if (erases) t += ` Garbage collection copied ${copies} valid page${copies === 1 ? "" : "s"} and erased ${erases} block${erases === 1 ? "" : "s"}.`;
    return t;
  };
  return (
    <Demo
      title="Inside an SSD: out-of-place writes and garbage collection"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={p.schema.op} value={v.op} onChange={(x) => { p.set("op", x as string); restart(x as string); }} />
          <Param spec={p.schema.wl} value={v.wl} onChange={(x) => { p.set("wl", x as FtlWorkload); restart(v.op, x as FtlWorkload); }} />
          <Param spec={p.schema.gc} value={v.gc} onChange={(x) => { p.set("gc", x as string); restart(v.op, v.wl, x as string); }} />
          <Param spec={p.schema.speed} value={v.speed} onChange={(x) => p.set("speed", x as string)} />
        </>
      }
    >
      <Caption>{FTL_BLOCKS} erase blocks (columns) of {FTL_PPB} pages. The host sees {f.logical} of the {f.physical} pages: {pct(f.spareRatio, 0)} spare.</Caption>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        {Array.from({ length: FTL_BLOCKS }, (_, b) => (
          <g key={b}>
            {Array.from({ length: FTL_PPB }, (_, i) => {
              const pg = b * FTL_PPB + i;
              const stt = f.state[pg]!;
              const fill = lastHost.has(pg) ? "var(--c1)" : lastCopy.has(pg) ? "var(--c2)" : stt === PAGE_VALID ? "var(--c3)" : stt === PAGE_INVALID ? "var(--c4)" : "var(--subtle)";
              return <rect key={i} x={b * CW + 0.5} y={i * CH + 0.5} width={CW - 2} height={CH - 1.5} rx={1} fill={fill} opacity={stt === PAGE_INVALID && !lastOld.has(pg) ? 0.5 : 1} stroke={lastOld.has(pg) ? "var(--fg)" : "none"} strokeWidth={0.8} />;
            })}
            {b === f.active && <rect x={b * CW - 0.3} y={0} width={CW - 0.4} height={FTL_PPB * CH} fill="none" stroke="var(--fg)" strokeWidth={1} rx={1.5} />}
            {b === s.erasedLast && marks.length > 0 && <rect x={b * CW - 0.3} y={0} width={CW - 0.4} height={FTL_PPB * CH} fill="none" stroke="var(--c2)" strokeWidth={1.2} strokeDasharray="2 1.5" rx={1.5} />}
            <text x={b * CW + CW / 2 - 1} y={FTL_PPB * CH + 9} textAnchor="middle" style={{ fontSize: 6, fill: "var(--muted)" }}>{f.eraseCount[b]}</text>
          </g>
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        <Legend items={[{ label: "valid", color: "var(--c3)" }, { label: "invalid", color: "var(--c4)" }, { label: "free", color: "var(--subtle)" }, { label: "just written", color: "var(--c1)" }, { label: "copied by GC", color: "var(--c2)" }]} />
        <span className="muted" style={{ fontSize: 11.5 }}>numbers: erases per block · framed column: open block</span>
      </div>
      <p style={{ fontSize: 13, margin: "8px 0 0", minHeight: 38 }}>{describe()}</p>
      <Stats items={[
        { label: "host page writes", value: f.hostWrites },
        { label: "NAND page writes", value: f.nandWrites },
        { label: "block erases", value: f.erases },
        { label: "write amplification", value: f.hostWrites ? f.wa.toFixed(2) : "–" },
      ]} />
      <div style={{ marginTop: 12 }}>
        <Caption>Steady-state write amplification against spare space (a larger drive model: 256 blocks of 32 pages)</Caption>
        <Plot x={[5, 100]} y={[0, 12]} height={190} logX xLabel="spare space, % of host capacity" yLabel="WA" xTicks={[5, 10, 20, 50, 100]} xFormat={(x) => `${x}%`}>
          <Line points={pts} color="var(--c4)" />
          <Dots points={pts} color="var(--c4)" r={2.5} />
          <RuleX at={f.spareRatio * 100} label="this drive" />
        </Plot>
      </div>
    </Demo>
  );
}

// =====================================================================================
// Lesson 2: Pages and slotted records
// =====================================================================================

const DEMO_PAGE = 512;

function makeRecord(len: number, tag: number) {
  const b = new Uint8Array(len);
  b.fill(65 + (tag % 26));
  return b;
}

type PageLog = { text: string; kind: "ok" | "warn" };

export function SlottedPageDemo() {
  const p = useParams("slotted", { len: range({ label: "Record size for the next insert", min: 8, max: 120, step: 1, default: 40, format: (v) => `${v} B` }) });
  const [wref, width] = useWidth<HTMLDivElement>();
  const ROW = width < 520 ? 32 : 64; // bytes per row of the byte map
  const page = useRef<SlottedPage | null>(null);
  const tagOf = useRef<Map<number, number>>(new Map());
  const nextTag = useRef(0);
  const [sel, setSel] = useState<number | null>(null);
  const [log, setLog] = useState<PageLog>({ text: "Insert records. Click a slot to select it.", kind: "ok" });
  const [, force] = useState(0);
  const init = () => {
    const pg = new SlottedPage(DEMO_PAGE);
    tagOf.current = new Map();
    nextTag.current = 0;
    for (const n of [40, 24, 56]) { const s = pg.insert(makeRecord(n, nextTag.current))!; tagOf.current.set(s, nextTag.current++); }
    page.current = pg;
  };
  if (!page.current) init();
  const pg = page.current!;
  const len = p.values.len;
  const done = (l: PageLog) => { setLog(l); force((x) => x + 1); };

  const insert = () => {
    const tag = nextTag.current;
    const s = pg.insert(makeRecord(len, tag));
    if (s === null) return done({ text: `No room for ${len} B: the page needs ${alignUp(len)} B plus a 4-byte slot, but it has only ${pg.freeAfterCompact} B even after compaction. The record goes to another page.`, kind: "warn" });
    tagOf.current.set(s, tag);
    nextTag.current++;
    setSel(s);
    const sl = pg.slot(s);
    done({ text: `Inserted ${len} B as record ID (0, ${s}) at offset ${sl.off}. The tuple takes ${alignUp(len)} B after 8-byte alignment.`, kind: "ok" });
  };
  const del = () => {
    if (sel === null) return;
    if (!pg.delete(sel)) return;
    done({ text: `Deleted slot ${sel}. The slot is now dead and its ${alignUp(pg.slot(sel).len)} B stay in place until compaction.`, kind: "ok" });
  };
  const grow = () => {
    if (sel === null || pg.slot(sel).flags !== LP_NORMAL) return;
    const old = pg.slot(sel).len;
    const r = pg.update(sel, makeRecord(old + 24, tagOf.current.get(sel) ?? 0));
    const msg = {
      "in-place": `Updated in place: ${old + 24} B still fits in the old ${alignUp(old)} B.`,
      moved: `The record grew to ${old + 24} B. It moved into the free gap; slot ${sel} now points to offset ${pg.slot(sel).off}. Its old bytes are garbage.`,
      compacted: `The record grew to ${old + 24} B. The gap was too small, so the page compacted first. Slot ${sel} keeps its number.`,
      "no-room": `The record cannot grow to ${old + 24} B on this page. It must move to another page, and its record ID changes (or leaves a forwarding pointer).`,
    }[r];
    done({ text: msg, kind: r === "no-room" ? "warn" : "ok" });
  };
  const compact = () => {
    const moved = pg.compact();
    if (sel !== null && sel >= pg.slotCount) setSel(null);
    done({ text: `Compaction moved ${moved} B of tuples to the end of the page. Dead slots became unused, so a new insert can reuse them.`, kind: "ok" });
  };

  // Byte map: owner of each byte.
  const slots = pg.slots();
  const owner = new Int16Array(DEMO_PAGE).fill(-3); // -3 free/garbage, -1 header, -2 slot array
  for (let i = 0; i < PAGE_HEADER; i++) owner[i] = -1;
  for (let i = PAGE_HEADER; i < pg.lower; i++) owner[i] = -2;
  for (let i = pg.upper; i < DEMO_PAGE; i++) owner[i] = -4; // garbage unless a tuple claims it
  for (const s of slots) if (s.flags === LP_NORMAL || s.flags === LP_DEAD) for (let i = s.off; i < s.off + alignUp(s.len); i++) owner[i] = s.slot;
  const color = (o: number) => {
    if (o === -1) return "var(--muted)";
    if (o === -2) return "var(--c5)";
    if (o === -3) return "var(--subtle)";
    if (o === -4) return "var(--faint)";
    const s = slots[o]!;
    if (s.flags === LP_DEAD) return "var(--c4)";
    return o === sel ? "var(--c1)" : "var(--c3)";
  };
  // Alternate shades so neighbouring tuples and slots are easy to tell apart.
  const shade = (i: number) => { const o = owner[i]!; const k = o >= 0 ? o : o === -2 ? Math.floor((i - PAGE_HEADER) / SLOT_BYTES) : 0; return (o >= 0 || o === -2) && k % 2 ? 0.72 : 1; };
  const slotOfByte = (i: number) => (i >= PAGE_HEADER && i < pg.lower ? Math.floor((i - PAGE_HEADER) / SLOT_BYTES) : owner[i]! >= 0 ? owner[i]! : -1);
  const CW = 6, CH = 9;
  return (
    <Demo
      title={`A slotted page of ${DEMO_PAGE} bytes, one cell per byte`}
      actions={<button className="btn ghost" onClick={() => { init(); setSel(null); done({ text: "Page reset.", kind: "ok" }); }}>Reset</button>}
      controls={<Param spec={p.schema.len} value={len} onChange={(x) => p.set("len", x as number)} />}
    >
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <button className="btn" onClick={insert}>Insert {len} B</button>
        <button className="btn" onClick={del} disabled={sel === null || pg.slot(sel).flags !== LP_NORMAL}>{sel === null ? "Delete" : `Delete slot ${sel}`}</button>
        <button className="btn" onClick={grow} disabled={sel === null || pg.slot(sel).flags !== LP_NORMAL}>{sel === null ? "Grow by 24 B" : `Grow slot ${sel} by 24 B`}</button>
        <button className="btn" onClick={compact}>Compact</button>
      </div>
      <div ref={wref} />
      <svg viewBox={`0 0 ${ROW * CW} ${(DEMO_PAGE / ROW) * CH}`} style={{ width: "100%", display: "block", cursor: "pointer" }}>
        {Array.from({ length: DEMO_PAGE }, (_, i) => (
          <rect key={i} x={(i % ROW) * CW + 0.3} y={Math.floor(i / ROW) * CH + 0.3} width={CW - 0.6} height={CH - 0.6} fill={color(owner[i]!)} opacity={shade(i)}
            stroke={slotOfByte(i) === sel && sel !== null && i >= PAGE_HEADER && i < pg.lower ? "var(--fg)" : "none"} strokeWidth={0.6}
            onClick={() => { const s = slotOfByte(i); if (s >= 0) setSel(s); }} />
        ))}
        <line x1={(pg.lower % ROW) * CW} x2={(pg.lower % ROW) * CW} y1={Math.floor(pg.lower / ROW) * CH} y2={Math.floor(pg.lower / ROW) * CH + CH} stroke="var(--fg)" strokeWidth={1.2} />
        <line x1={(pg.upper % ROW) * CW} x2={(pg.upper % ROW) * CW} y1={Math.floor(pg.upper / ROW) * CH} y2={Math.floor(pg.upper / ROW) * CH + CH} stroke="var(--fg)" strokeWidth={1.2} />
      </svg>
      <div style={{ marginTop: 6 }}>
        <Legend items={[{ label: "header 24 B", color: "var(--muted)" }, { label: "slot array (4 B each)", color: "var(--c5)" }, { label: "free", color: "var(--subtle)" }, { label: "live tuple", color: "var(--c3)" }, { label: "selected", color: "var(--c1)" }, { label: "dead tuple", color: "var(--c4)" }, { label: "garbage", color: "var(--faint)" }]} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10, ...mono, fontSize: 11.5 }}>
        {slots.map((s) => (
          <button key={s.slot} onClick={() => setSel(s.slot)} className="btn ghost" style={{ padding: "3px 6px", fontSize: 11.5, outline: s.slot === sel ? "2px solid var(--c1)" : undefined, color: s.flags === LP_NORMAL ? "var(--fg)" : "var(--muted)", ...mono }}>
            {s.slot}: {s.flags === LP_NORMAL ? `off ${s.off}, len ${s.len}` : s.flags === LP_DEAD ? "dead" : s.flags === LP_UNUSED ? "unused" : "held"}
          </button>
        ))}
      </div>
      <p style={{ fontSize: 13, margin: "10px 0 0", minHeight: 36, color: log.kind === "warn" ? "var(--c4)" : "var(--fg)" }}>{log.text}</p>
      <Stats items={[
        { label: "lower (end of slots)", value: pg.lower },
        { label: "upper (start of tuples)", value: pg.upper },
        { label: "free gap", value: `${pg.freeContiguous} B` },
        { label: "garbage", value: `${pg.garbage} B` },
        { label: "live records", value: pg.liveCount },
      ]} />
    </Demo>
  );
}

// ---------------- tuple layout ----------------

const TYPE_OPTS: PgType[] = ["bool", "int2", "int4", "int8", "timestamptz", "uuid", "text"];
const PRESETS: Record<string, PgType[]> = {
  bad: ["bool", "int8", "bool", "int8", "int2", "timestamptz"],
  good: ["int8", "int8", "timestamptz", "int2", "bool", "bool"],
  text: ["int8", "text", "int4"],
};

export function TupleLayoutDemo() {
  const p = useParams("tuple", {
    textLen: range({ label: "Length of each text value", min: 0, max: 4000, step: 1, default: 20, format: (v) => `${v} B` }),
    preset: seg("Columns", [["bad", "bool, int8, bool, int8, int2, ts"], ["good", "Same, largest first"], ["text", "int8, text, int4"]], "bad"),
    nulls: toggle({ label: "Make the second column NULL", default: false }),
  });
  const [types, setTypes] = useState<PgType[] | null>(null);
  const cols: PgColumn[] = (types ?? PRESETS[p.values.preset]!).map((t, i) => ({ name: `c${i + 1}`, type: t, textLen: p.values.textLen, isNull: p.values.nulls && i === 1 }));
  const lay = pgTupleLayout(cols);
  const total = Math.max(lay.len, 1);
  const shown = Math.min(total, 160);
  const COLS = ["var(--c1)", "var(--c3)", "var(--c2)", "var(--c5)"];
  const colorOf = (s: { kind: string; col?: number }) =>
    s.kind === "header" ? "var(--muted)" : s.kind === "bitmap" ? "var(--c5)" : s.kind === "pad" ? "var(--c4)" : s.kind === "varhdr" ? "var(--faint)" : s.kind === "toast" ? "var(--fg)" : COLS[(s.col ?? 0) % COLS.length]!;
  const perPage = Math.floor((8192 - 24) / lay.onPage);
  const setType = (i: number, t: PgType) => { const base = [...(types ?? PRESETS[p.values.preset]!)]; base[i] = t; setTypes(base); };
  return (
    <Demo
      title="One PostgreSQL heap tuple, byte by byte"
      controls={<>
        <Param spec={p.schema.textLen} value={p.values.textLen} onChange={(x) => p.set("textLen", x as number)} />
        <Param spec={p.schema.preset} value={p.values.preset} onChange={(x) => { p.set("preset", x as string); setTypes(null); }} />
        <Param spec={p.schema.nulls} value={p.values.nulls} onChange={(x) => p.set("nulls", x as boolean)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {cols.map((c, i) => (
          <label key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: COLS[i % COLS.length] }} />
            <select value={c.type} onChange={(e) => setType(i, e.target.value as PgType)} style={{ fontSize: 12 }}>
              {TYPE_OPTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        ))}
      </div>
      <Caption>{shown < lay.len ? `First ${shown} of ${lay.len} bytes` : `All ${lay.len} bytes`}, one cell per byte, 32 per row</Caption>
      <svg viewBox={`0 0 ${32 * 10} ${Math.ceil(shown / 32) * 12}`} style={{ width: "100%", display: "block" }}>
        {lay.segments.flatMap((s, k) => Array.from({ length: Math.max(0, Math.min(s.len, shown - s.start)) }, (_, j) => {
          const i = s.start + j;
          return <rect key={`${k}-${j}`} x={(i % 32) * 10 + 0.5} y={Math.floor(i / 32) * 12 + 0.5} width={9} height={11} rx={1} fill={colorOf(s)} opacity={s.kind === "pad" ? 0.55 : 1} />;
        }))}
      </svg>
      <div style={{ marginTop: 6 }}>
        <Legend items={[{ label: "header 23 B", color: "var(--muted)" }, { label: "null bitmap", color: "var(--c5)" }, { label: "alignment padding", color: "var(--c4)" }, { label: "varlena length", color: "var(--faint)" }, { label: "TOAST pointer", color: "var(--fg)" }]} />
      </div>
      <Stats items={[
        { label: "tuple length", value: `${lay.len} B` },
        { label: "padding", value: `${lay.padding} B` },
        { label: "on the page (aligned + slot)", value: `${lay.onPage} B` },
        { label: "tuples per 8 KiB page", value: perPage },
        { label: "moved to TOAST", value: lay.toasted.length ? lay.toasted.map((t) => `c${t.col + 1}: ${t.chunks} chunks`).join(", ") : "none" },
      ]} />
      <Note>Data starts at t_hoff = {lay.hoff}. Short text (up to 126 bytes) has a 1-byte length and no alignment. Above {toastThreshold()} bytes, wide values move to the TOAST table.</Note>
    </Demo>
  );
}

// =====================================================================================
// Lesson 3: Heap files and free-space maps
// =====================================================================================

const STRAT_OPTS: [InsertStrategy, string][] = [["append", "Append only"], ["first-fit", "Scan from page 0"], ["fsm", "Free-space map"]];

export function HeapInsertDemo() {
  const p = useParams("heapins", {
    del: range({ label: "Rows deleted after the load", min: 0, max: 60, step: 5, default: 30, format: (v) => `${v}%` }),
    strategy: seg<InsertStrategy>("Find a page by", STRAT_OPTS, "fsm"),
    vacuum: toggle({ label: "Run VACUUM after the deletes", default: true }),
  });
  const v = p.values;
  const run = useMemo(() => heapRun({ strategy: v.strategy, initial: 3000, deleteFrac: v.del / 100, vacuum: v.vacuum, inserts: 900, rowBytes: [60, 200] }), [v.strategy, v.del, v.vacuum]);
  const [i, setI] = useState(0);
  const sim = useSim({ dt: 1 / 30, step: () => setI((x) => Math.min(run.results.length, x + 3)), reset: () => setI(0) });
  const key = `${v.strategy}:${v.del}:${v.vacuum}`;
  useEffect(() => { setI(0); }, [key]);
  const k = Math.min(i, run.results.length);
  const { running, pause } = sim;
  useEffect(() => { if (k >= run.results.length && running) pause(); }, [k, run.results.length, running, pause]);
  // Page state after k inserts.
  const used = run.before.map((pg) => pg.used);
  const dead = run.before.map((pg) => pg.dead);
  for (let j = 0; j < k; j++) {
    const r = run.results[j]!;
    while (used.length <= r.page) { used.push(0); dead.push(0); }
    used[r.page] = used[r.page]! + r.cost;
  }
  const cur = k > 0 ? run.results[k - 1]! : null;
  const probed = new Set(cur?.probed ?? []);
  const npages = Math.max(run.pagesAfter, used.length);
  const shownPages = run.pagesAfter;
  const cap = 8192 - 24;
  const probes = run.results.slice(0, k).reduce((a, r) => a + r.probed.length, 0);
  const W = 320, H = 110, bw = W / Math.max(70, shownPages);
  return (
    <Demo
      title="900 inserts after deletes: how many pages does each insert read?"
      actions={<SimButtons sim={sim} />}
      controls={<>
        <Param spec={p.schema.del} value={v.del} onChange={(x) => p.set("del", x as number)} />
        <Param spec={p.schema.strategy} value={v.strategy} onChange={(x) => p.set("strategy", x as InsertStrategy)} />
        <Param spec={p.schema.vacuum} value={v.vacuum} onChange={(x) => p.set("vacuum", x as boolean)} />
      </>}
    >
      <Caption>Each bar is one 8 KiB page. 3,000 rows of 60 to 200 bytes filled {run.pagesAfterLoad} pages.</Caption>
      <svg viewBox={`0 0 ${W} ${H + 14}`} style={{ width: "100%", display: "block" }}>
        {Array.from({ length: npages }, (_, pIdx) => {
          const u = used[pIdx] ?? 0, d = dead[pIdx] ?? 0;
          const x = pIdx * bw;
          const hu = (u / cap) * H, hd = (d / cap) * H;
          const isNew = pIdx >= run.pagesAfterLoad;
          return (
            <g key={pIdx}>
              <rect x={x + 0.3} y={0} width={bw - 0.6} height={H} fill="var(--subtle)" />
              <rect x={x + 0.3} y={H - hu} width={bw - 0.6} height={hu} fill={cur?.page === pIdx ? "var(--c1)" : isNew ? "var(--c2)" : "var(--c3)"} />
              <rect x={x + 0.3} y={H - hu - hd} width={bw - 0.6} height={hd} fill="var(--c4)" opacity={0.6} />
              {probed.has(pIdx) && <rect x={x + 0.3} y={H + 3} width={bw - 0.6} height={4} fill="var(--fg)" />}
            </g>
          );
        })}
        <line x1={run.pagesAfterLoad * bw} x2={run.pagesAfterLoad * bw} y1={0} y2={H} stroke="var(--fg)" strokeDasharray="3 2" strokeWidth={0.8} />
      </svg>
      <Legend items={[{ label: "live rows", color: "var(--c3)" }, { label: "dead rows (not vacuumed)", color: "var(--c4)" }, { label: "pages added now", color: "var(--c2)" }, { label: "page that got the row", color: "var(--c1)" }, { label: "pages read (marks below)", color: "var(--fg)" }]} />
      <p style={{ fontSize: 13, margin: "8px 0 0", minHeight: 36 }}>
        {cur ? <>Insert {k}: read {cur.probed.length} page{cur.probed.length === 1 ? "" : "s"}{cur.fsmVisits ? ` and ${cur.fsmVisits} FSM nodes` : ""}, {cur.extended ? "then added a new page" : `then put the row in page ${cur.page}`}.</> : "Press Play to run the 900 inserts."}
      </p>
      <Stats items={[
        { label: "pages read per insert (all 900)", value: run.avgProbes.toFixed(2) },
        { label: "worst insert", value: `${run.maxProbes} pages` },
        { label: "pages read so far", value: probes },
        { label: "file size after", value: `${run.pagesAfter} pages` },
      ]} />
    </Demo>
  );
}

// ---------------- FSM tree ----------------

const FSM_N = 16;
const FSM_START = [180, 40, 0, 230, 90, 12, 64, 0, 150, 255, 30, 0, 75, 120, 5, 200];

export function FsmTreeDemo() {
  const p = useParams("fsmtree", { need: range({ label: "Row to insert (bytes, with slot)", min: 16, max: 8000, step: 8, default: 2400, format: (v) => `${v} B` }) });
  const [cats, setCats] = useState(FSM_START);
  const need = p.values.need;
  const want = needToCat(need);
  const fsm = new FreeSpaceMap(8192, FSM_N);
  cats.forEach((c, i) => fsm.set(i, c));
  const found = fsm.search(want);
  // Rebuild the tree values for drawing.
  const tree: number[] = Array(2 * FSM_N).fill(0);
  cats.forEach((c, i) => { tree[FSM_N + i] = c; });
  for (let i = FSM_N - 1; i >= 1; i--) tree[i] = Math.max(tree[2 * i]!, tree[2 * i + 1]!);
  const path = new Set<number>();
  if (tree[1]! >= want) { let i = 1; path.add(1); while (i < FSM_N) { i = tree[2 * i]! >= want ? 2 * i : 2 * i + 1; path.add(i); } }
  const W = 320, levels = Math.log2(FSM_N) + 1, LH = 34;
  const pos = (i: number) => { const lvl = Math.floor(Math.log2(i)); const k = i - 2 ** lvl; const n = 2 ** lvl; return { x: ((k + 0.5) / n) * W, y: 12 + lvl * LH }; };
  return (
    <Demo title="The free-space map: a max-tree over one byte per page" controls={<Param spec={p.schema.need} value={need} onChange={(x) => p.set("need", x as number)} />}>
      <svg viewBox={`0 0 ${W} ${levels * LH + 10}`} style={{ width: "100%", display: "block" }}>
        {Array.from({ length: FSM_N - 1 }, (_, j) => j + 1).flatMap((i) => [2 * i, 2 * i + 1].map((c) => {
          const a = pos(i), b = pos(c);
          return <line key={`${i}-${c}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={path.has(i) && path.has(c) ? "var(--c1)" : "var(--border)"} strokeWidth={path.has(i) && path.has(c) ? 2 : 1} />;
        }))}
        {Array.from({ length: 2 * FSM_N - 1 }, (_, j) => j + 1).map((i) => {
          const { x, y } = pos(i);
          const leaf = i >= FSM_N;
          const ok = tree[i]! >= want;
          return (
            <g key={i} style={{ cursor: leaf ? "pointer" : undefined }} onClick={() => { if (!leaf) return; const n = [...cats]; n[i - FSM_N] = (n[i - FSM_N]! + 64) % 256; setCats(n); }}>
              <rect x={x - 9.5} y={y - 8} width={19} height={16} rx={3} fill={path.has(i) ? "var(--c1)" : ok ? "var(--subtle)" : "var(--bg)"} stroke={leaf && i - FSM_N === found ? "var(--fg)" : "var(--border)"} strokeWidth={leaf && i - FSM_N === found ? 1.6 : 0.8} />
              <text x={x} y={y + 3.5} textAnchor="middle" style={{ fontSize: 8.5, fill: path.has(i) ? "#fff" : ok ? "var(--fg)" : "var(--faint)", ...mono }}>{tree[i]}</text>
            </g>
          );
        })}
      </svg>
      <p style={{ fontSize: 13, margin: "6px 0 0" }}>
        A row of {need} B needs category ⌈{need} / {fsmStep()}⌉ = <b>{want}</b>.{" "}
        {found >= 0 ? <>The search reads {fsm.lastVisits} nodes, one per level, and returns page {found} (category {cats[found]}, at least {cats[found]! * fsmStep()} B free).</> : <>The root holds {tree[1]}, which is less than {want}, so no page has room. The heap adds a new page.</>}
      </p>
      <Note>The bottom row is one category per heap page: free bytes ÷ 32, rounded down. Each parent holds the larger value of its two children. Click a page to change its free space.</Note>
      <Stats items={[{ label: "category of 8,160 free bytes", value: availToCat(8160) }, { label: "nodes read", value: found >= 0 ? fsm.lastVisits : 1 }]} />
    </Demo>
  );
}

// ---------------- sequential scan ----------------

export function SeqScanDemo() {
  const p = useParams("seqscan", {
    dead: range({ label: "Dead row versions on the pages", min: 0, max: 80, step: 5, default: 0, format: (v) => `${v}%` }),
    ff: range({ label: "Fill factor", min: 50, max: 100, step: 5, default: 100, format: (v) => `${v}%` }),
    row: seg("Row size", [["40", "40 B"], ["100", "100 B"], ["400", "400 B"]], "100"),
  });
  const v = p.values;
  const rowB = Number(v.row);
  const t = tablePages({ liveRows: 1e6, rowBytes: rowB, deadFrac: v.dead / 100, fillFactor: v.ff });
  const rpp = rowsPerPage(rowB, v.ff);
  const capRows = rowsPerPage(rowB, 100);
  const [pos, setPos] = useState(0);
  const SHOW = 16;
  const sim = useSim({ dt: 1 / 6, autoplay: true, step: () => setPos((x) => (x + 1) % (SHOW + 4)) });
  void sim;
  const cellsPerRow = Math.min(capRows, 64);
  const scale = capRows / cellsPerRow;
  // Deterministic dead placement: spread evenly.
  const deadEvery = v.dead > 0 ? 100 / v.dead : Infinity;
  const W = 640, PH = 14;
  return (
    <Demo title="A full-table scan reads every page, live or not" controls={<>
      <Param spec={p.schema.dead} value={v.dead} onChange={(x) => p.set("dead", x as number)} />
      <Param spec={p.schema.ff} value={v.ff} onChange={(x) => p.set("ff", x as number)} />
      <Param spec={p.schema.row} value={v.row} onChange={(x) => p.set("row", x as string)} />
    </>}>
      <Caption>The first {SHOW} pages of a table with 1,000,000 live rows. One cell ≈ {fx(scale, 2)} row slot{scale > 1.01 ? "s" : ""}.</Caption>
      <svg viewBox={`0 0 ${W} ${SHOW * PH}`} style={{ width: "100%", display: "block" }}>
        {Array.from({ length: SHOW }, (_, r) => {
          const filled = Math.round(rpp / scale);
          const cw = (W - 30) / cellsPerRow;
          return (
            <g key={r} transform={`translate(0, ${r * PH})`}>
              <text x={0} y={10.5} style={{ fontSize: 9, fill: r === pos ? "var(--fg)" : "var(--faint)", ...mono }}>{r}</text>
              {Array.from({ length: cellsPerRow }, (_, c) => {
                const idx = r * filled + c;
                const isRow = c < filled;
                const isDead = isRow && Math.floor((idx + 1) / deadEvery) !== Math.floor(idx / deadEvery);
                return <rect key={c} x={24 + c * cw} y={2} width={Math.max(0.5, cw - 0.6)} height={PH - 4} fill={!isRow ? "var(--subtle)" : isDead ? "var(--c4)" : "var(--c3)"} opacity={r < pos ? 0.45 : 1} />;
              })}
              {r === pos && <rect x={22} y={0.5} width={W - 22} height={PH - 1} fill="none" stroke="var(--c1)" strokeWidth={1.5} rx={2} />}
            </g>
          );
        })}
      </svg>
      <Legend items={[{ label: "live row", color: "var(--c3)" }, { label: "dead version", color: "var(--c4)" }, { label: "free (fill factor)", color: "var(--subtle)" }, { label: "page being read", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "pages to read", value: t.pages.toLocaleString("en-US") },
        { label: "table size", value: bytes(t.bytes) },
        { label: "disk at 200 MB/s", value: ms(scanMs(t.bytes, 200)) },
        { label: "NVMe at 3,200 MB/s", value: ms(scanMs(t.bytes, 3200)) },
        { label: "planner cost estimate", value: Math.round(t.cost).toLocaleString("en-US") },
      ]} />
      <Note>PostgreSQL estimates a sequential scan as pages × 1.0 + row versions × 0.01. Dead versions cost a page read and a visibility check, but return nothing.</Note>
    </Demo>
  );
}
