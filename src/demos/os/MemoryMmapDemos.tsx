/** Demos for /os/memory/mmap. */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, Dots, Legend, range, useParams, bytes } from "../../kit";
import { MappedFile, classifyAccess, readCost, mmapCost, MMAP_COSTS, shootdownNs, type MapMode, type AccessPattern, type ByteAccess } from "../../sims/os/memory";
import { seg, mono, Caption, fx } from "../db/StorageUi";

type Op =
  | { k: "load"; who: 0 | 1; page: number }
  | { k: "store"; who: 0 | 1; page: number; v: string }
  | { k: "read"; page: number }
  | { k: "write"; page: number; v: string }
  | { k: "sync" }
  | { k: "evict"; page: number }
  | { k: "trunc"; pages: number };

const NAMES = ["A", "B"] as const;
const opText = (o: Op) => {
  switch (o.k) {
    case "load": return `${NAMES[o.who]} reads page ${o.page}`;
    case "store": return `${NAMES[o.who]} writes "${o.v}" to page ${o.page}`;
    case "read": return `read() of page ${o.page}`;
    case "write": return `write() of "${o.v}" to page ${o.page}`;
    case "sync": return "msync / writeback";
    case "evict": return `kernel evicts page ${o.page}`;
    case "trunc": return `ftruncate to ${o.pages} pages`;
  }
};

const PRESETS: { id: string; label: string; a: MapMode; b: MapMode; ops: Op[] }[] = [
  { id: "snap", label: "Private is not a snapshot", a: "private", b: "shared", ops: [{ k: "load", who: 0, page: 0 }, { k: "store", who: 1, page: 0, v: "B1" }, { k: "load", who: 0, page: 0 }, { k: "store", who: 0, page: 0, v: "A1" }, { k: "store", who: 1, page: 0, v: "B2" }, { k: "load", who: 0, page: 0 }] },
  { id: "shared", label: "Two shared mappings", a: "shared", b: "shared", ops: [{ k: "load", who: 1, page: 1 }, { k: "store", who: 0, page: 1, v: "A1" }, { k: "load", who: 1, page: 1 }, { k: "sync" }] },
  { id: "sync", label: "Private writes never reach the disk", a: "private", b: "private", ops: [{ k: "store", who: 0, page: 2, v: "A1" }, { k: "sync" }, { k: "load", who: 1, page: 2 }] },
  { id: "evict", label: "Eviction and a major fault", a: "shared", b: "shared", ops: [{ k: "store", who: 0, page: 0, v: "A1" }, { k: "load", who: 1, page: 0 }, { k: "evict", page: 0 }, { k: "load", who: 1, page: 0 }] },
  { id: "free", label: "Empty: try it yourself", a: "shared", b: "private", ops: [] },
];

function replay(a: MapMode, b: MapMode, ops: readonly Op[]) {
  const f = new MappedFile(["d0", "d1", "d2", "d3"]);
  const maps = [f.map("A", a), f.map("B", b)];
  let last = "";
  let warn = false;
  ops.forEach((o) => {
    warn = false;
    switch (o.k) {
      case "load": {
        const r = f.load(maps[o.who]!, o.page);
        if (r.ok) last = `${NAMES[o.who]} sees "${r.value}"${r.fault === "none" ? " with no fault" : r.fault === "minor" ? " after a minor fault: the page was in the cache" : " after a major fault: the kernel read the disk"}.`;
        else { last = `${NAMES[o.who]} gets SIGBUS: page ${o.page} is past the end of the file.`; warn = true; }
        break;
      }
      case "store": {
        const r = f.store(maps[o.who]!, o.page, o.v);
        if (!r.ok) { last = `${NAMES[o.who]} gets SIGBUS: page ${o.page} is past the end of the file.`; warn = true; break; }
        last = maps[o.who]!.mode === "shared"
          ? `The store changes the page cache page and marks it dirty. Every shared mapper and read() see "${o.v}" now. The disk does not change yet.`
          : r.fault === "cow" ? `Copy-on-write: ${NAMES[o.who]} gets a private anonymous copy. Only ${NAMES[o.who]} sees "${o.v}".` : `${NAMES[o.who]} changes its own private copy.`;
        break;
      }
      case "read": { const r = f.sysRead(o.page); last = `read() copies "${r}" from the page cache to a user buffer.`; break; }
      case "write": f.sysWrite(o.page, o.v); last = `write() changes the page cache page. Shared mappers see "${o.v}", and so does a private mapper that has no copy of this page.`; break;
      case "sync": { const n = f.writeback(); last = n ? `${n} dirty page${n > 1 ? "s" : ""} went to disk. The cache copy stays, now clean.` : "No page was dirty, so the disk does not change."; break; }
      case "evict": { f.evict(o.page); last = `The kernel removes page ${o.page} from the cache and from every page table that maps it. Each mapper needs a TLB shootdown.`; break; }
      case "trunc": f.truncate(o.pages); last = `The file now has ${o.pages} page${o.pages === 1 ? "" : "s"}. The kernel removes the pages past the end, private copies too.`; break;
    }
  });
  return { f, maps, last, warn };
}

const cellStyle = (bg: string, fg = "var(--fg)"): CSSProperties => ({ background: bg, color: fg, border: "1px solid var(--border)", borderRadius: 4, height: 36, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", ...mono, fontSize: 12.5, minWidth: 0, lineHeight: 1.1 });

export function MappingStepperDemo() {
  const p = useParams("mapstep", {
    preset: seg("Scenario", PRESETS.map((x) => [x.id, x.label] as [string, string]), "snap"),
  });
  const preset = PRESETS.find((x) => x.id === p.values.preset)!;
  const [modes, setModes] = useState<[MapMode, MapMode]>([preset.a, preset.b]);
  const [ops, setOps] = useState<Op[]>(preset.ops);
  const [n, setN] = useState(0);
  const [page, setPage] = useState(0);
  const [ver, setVer] = useState(1);
  const shown = ops.slice(0, n);
  const { f, maps, last, warn } = useMemo(() => replay(modes[0], modes[1], shown), [modes, shown.length, ops]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = (id: string) => { const x = PRESETS.find((q) => q.id === id)!; setModes([x.a, x.b]); setOps(x.ops); setN(0); p.set("preset", id); };
  const add = (o: Op) => { const next = [...shown, o]; setOps(next); setN(next.length); };
  const val = () => { const s = String(ver); setVer(ver + 1); return s; };
  const pages = [0, 1, 2, 3];
  const row = (label: ReactNode, cells: ReactNode[]) => (
    <>
      <div style={{ fontSize: 12, alignSelf: "center", minWidth: 0 }}>{label}</div>
      {cells.map((c, i) => <div key={i} style={{ minWidth: 0 }}>{c}</div>)}
    </>
  );
  const pteCell = (m: (typeof maps)[number], pg: number) => {
    const pte = m.ptes.get(pg);
    if (pg >= f.pages) return <div style={cellStyle("transparent", "var(--faint)")}>past EOF</div>;
    if (!pte) return <div style={cellStyle("transparent", "var(--faint)")}>–</div>;
    if (pte.kind === "anon") return <div style={cellStyle("var(--c2)", "#fff")}><b>{pte.value}</b><span style={{ fontSize: 10 }}>private copy</span></div>;
    return <div style={cellStyle("var(--subtle)")}><b>{f.cache.get(pg)?.value}</b><span style={{ fontSize: 10, color: "var(--muted)" }}>→ cache</span></div>;
  };
  return (
    <Demo
      title="One file, the page cache, two processes"
      actions={<>
        <button className="btn" disabled={n >= ops.length} onClick={() => setN(n + 1)}>Next step{ops.length ? ` (${Math.min(n + 1, ops.length)}/${ops.length})` : ""}</button>
        <button className="btn ghost" disabled={n === 0} onClick={() => setN(n - 1)}>Back</button>
      </>}
      controls={<Param spec={p.schema.preset} value={p.values.preset} onChange={(x) => load(x as string)} />}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8, fontSize: 12.5 }}>
        {[0, 1].map((w) => (
          <label key={w} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {NAMES[w]} maps with
            <select value={modes[w]} onChange={(e) => { const m: [MapMode, MapMode] = [...modes]; m[w] = e.target.value as MapMode; setModes(m); }}>
              <option value="shared">MAP_SHARED</option>
              <option value="private">MAP_PRIVATE</option>
            </select>
          </label>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(58px, 72px) repeat(4, minmax(0, 1fr))", gap: 4 }}>
        {row(<span className="muted">page</span>, pages.map((x) => <div style={{ textAlign: "center", fontSize: 12, color: "var(--muted)" }}>{x}</div>))}
        {row(<b>A</b>, pages.map((x) => pteCell(maps[0]!, x)))}
        {row(<b>B</b>, pages.map((x) => pteCell(maps[1]!, x)))}
        {row("page cache", pages.map((x) => { const c = f.cache.get(x); return c ? <div style={cellStyle(c.dirty ? "var(--c4)" : "var(--c1)", "#fff")}><b>{c.value}</b><span style={{ fontSize: 10 }}>{c.dirty ? "dirty" : "clean"}</span></div> : <div style={cellStyle("transparent", "var(--faint)")}>–</div>; }))}
        {row("disk", pages.map((x) => <div style={cellStyle("var(--subtle)")}>{x < f.pages ? f.disk[x] : ""}</div>))}
      </div>
      <p style={{ fontSize: 13, margin: "8px 0 2px", minHeight: 36, color: warn ? "var(--c4)" : "var(--fg)" }}>{n === 0 ? "Press Next step, or use the buttons to run your own steps." : <><b>{opText(ops[n - 1]!)}.</b> {last}</>}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", margin: "6px 0" }}>
        <span className="muted" style={{ fontSize: 12 }}>Page</span>
        {pages.map((x) => <button key={x} className={page === x ? "btn" : "btn ghost"} onClick={() => setPage(x)}>{x}</button>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        <button className="btn" onClick={() => add({ k: "store", who: 0, page, v: `A${val()}` })}>A writes</button>
        <button className="btn" onClick={() => add({ k: "store", who: 1, page, v: `B${val()}` })}>B writes</button>
        <button className="btn ghost" onClick={() => add({ k: "load", who: 0, page })}>A reads</button>
        <button className="btn ghost" onClick={() => add({ k: "load", who: 1, page })}>B reads</button>
        <button className="btn ghost" onClick={() => add({ k: "write", page, v: `w${val()}` })}>write()</button>
        <button className="btn ghost" onClick={() => add({ k: "read", page })}>read()</button>
        <button className="btn ghost" onClick={() => add({ k: "sync" })}>msync</button>
        <button className="btn ghost" onClick={() => add({ k: "evict", page })}>Evict</button>
        <button className="btn ghost" onClick={() => add({ k: "trunc", pages: Math.max(1, f.pages - 1) })}>Truncate</button>
      </div>
      <Stats items={[
        { label: "minor faults", value: f.stats.minor },
        { label: "major faults", value: f.stats.major },
        { label: "COW copies", value: f.stats.cow },
        { label: "disk reads", value: f.stats.diskReads },
        { label: "disk writes", value: f.stats.diskWrites },
        { label: "PTEs shot down", value: f.stats.shootdowns },
      ]} />
    </Demo>
  );
}

// ---------------- read() vs mmap ----------------

const SHARES = Array.from({ length: 41 }, (_, i) => i / 40);

export function ReadVsMmapDemo() {
  const p = useParams("rvm", {
    cached: range({ label: "Page visits that find the page cached", min: 0, max: 1, step: 0.01, default: 1, format: (x) => `${Math.round(x * 100)}%` }),
    touches: range({ label: "Touches per page while it stays in memory", min: 1, max: 100, log: true, default: 1, format: (x) => String(Math.round(x)) }),
    cores: range({ label: "Cores that run this process", min: 1, max: 128, log: true, default: 16, format: (x) => String(Math.round(x)) }),
    pattern: seg<AccessPattern>("Access pattern", [["seq", "Sequential"], ["rand", "Random"]], "rand"),
  });
  const v = p.values;
  const touches = Math.round(v.touches), cores = Math.round(v.cores);
  const base = { pattern: v.pattern, touches, cores };
  const r = readCost({ ...base, cachedShare: v.cached });
  const m = mmapCost({ ...base, cachedShare: v.cached });
  const lines = useMemo(() => ({
    read: SHARES.map((c) => [c, readCost({ ...base, cachedShare: c }).total] as const),
    mmap: SHARES.map((c) => [c, mmapCost({ ...base, cachedShare: c }).total] as const),
  }), [v.pattern, touches, cores]); // eslint-disable-line react-hooks/exhaustive-deps
  const fmt = (ns: number) => (ns >= 1000 ? `${fx(ns / 1000, 3)} µs` : `${fx(ns, 3)} ns`);
  const parts = (b: ReturnType<typeof readCost>) => [
    { l: "kernel entry", v: b.kernelEntry, c: "var(--c1)" }, { l: "copy", v: b.copy, c: "var(--c2)" }, { l: "device", v: b.device, c: "var(--c5)" }, { l: "TLB misses", v: b.tlb, c: "var(--c3)" }, { l: "shootdowns", v: b.shootdown, c: "var(--c4)" },
  ];
  const max = Math.max(r.total, m.total);
  const breakdown = (name: string, b: ReturnType<typeof readCost>) => (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}><span>{name}</span><b style={mono}>{fmt(b.total)}</b></div>
      <div style={{ display: "flex", height: 14, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden" }}>
        {parts(b).map((x) => <div key={x.l} title={`${x.l}: ${fmt(x.v)}`} style={{ width: `${(x.v / max) * 100}%`, background: x.c }} />)}
      </div>
    </div>
  );
  return (
    <Demo title="Cost per access: read() against mmap" controls={<>
      <Param spec={p.schema.cached} value={v.cached} onChange={(x) => p.set("cached", x as number)} />
      <Param spec={p.schema.touches} value={v.touches} onChange={(x) => p.set("touches", x as number)} />
      <Param spec={p.schema.cores} value={v.cores} onChange={(x) => p.set("cores", x as number)} />
      <Param spec={p.schema.pattern} value={v.pattern} onChange={(x) => p.set("pattern", x as AccessPattern)} />
    </>}>
      <Plot x={[0, 1]} y={[10, 2e5]} logY height={220} xLabel="share of page visits that hit the page cache" yLabel="ns per access" xFormat={(x) => `${Math.round(x * 100)}%`} yTicks={[10, 100, 1000, 1e4, 1e5]} yFormat={(y) => fx(y, 1)} xTicks={[0, 0.25, 0.5, 0.75, 1]}>
        <Line points={lines.read} color="var(--c1)" />
        <Line points={lines.mmap} color="var(--c4)" />
        <RuleX at={v.cached} color="var(--fg)" />
        <Dots points={[[v.cached, r.total]]} color="var(--c1)" r={4} />
        <Dots points={[[v.cached, m.total]]} color="var(--c4)" r={4} />
      </Plot>
      <Legend items={[{ label: "read(), one page per call", color: "var(--c1)" }, { label: "mmap", color: "var(--c4)" }]} />
      <div style={{ marginTop: 8 }}>
        {breakdown("read()", r)}
        {breakdown("mmap", m)}
      </div>
      <Legend box items={parts(r).map((x) => ({ label: x.l, color: x.c }))} />
      <Caption><span style={{ display: "block", marginTop: 8 }}>Model inputs, not measurements: syscall {MMAP_COSTS.syscallNs} ns; copy of 4 KiB {MMAP_COSTS.copy4kNs} ns; minor fault {MMAP_COSTS.minorFaultNs} ns; fault-around {MMAP_COSTS.faultAroundPages} pages at {MMAP_COSTS.faultAroundPerPageNs} ns each; TLB miss {MMAP_COSTS.tlbMissNs} ns; device read {fx(MMAP_COSTS.deviceReadNs / 1000, 2)} µs; readahead {MMAP_COSTS.readaheadPages} pages; shootdown {MMAP_COSTS.shootdownBaseNs} ns + {MMAP_COSTS.shootdownPerCoreNs} ns per other core ({fmt(shootdownNs(cores))} here).</span></Caption>
    </Demo>
  );
}

// ---------------- truncate ----------------

const P = 4096;
const OUT: Record<ByteAccess, { label: string; color: string; note: string }> = {
  data: { label: "The byte from the file", color: "var(--c3)", note: "This offset is inside the file." },
  "tail-zero": { label: "Zero", color: "var(--c2)", note: "This offset is past EOF, but inside the last file page. The kernel fills the rest of that page with zeros. A store here works, but it never reaches the file." },
  sigbus: { label: "SIGBUS", color: "var(--c4)", note: "The address is mapped, but the file has no page here. The fault handler has nothing to map, so it sends SIGBUS." },
  sigsegv: { label: "SIGSEGV", color: "var(--c4)", note: "No mapping covers this address." },
};

export function TruncateDemo() {
  const map = 3 * P;
  const p = useParams("trunc", {
    size: range({ label: "File size (another process can ftruncate it)", min: 0, max: 3 * P, step: 256, default: 5120, format: (x) => bytes(x) }),
    off: range({ label: "Offset of the access", min: 0, max: 4 * P - 1, step: 128, default: 8960, format: (x) => `${x.toLocaleString("en-US")}` }),
  });
  const { size, off } = p.values;
  const res = classifyAccess(off, size, map);
  const o = OUT[res];
  const W = 400;
  const x = (b: number) => (b / (4 * P)) * W;
  const fileEnd = Math.ceil(size / P) * P;
  return (
    <Demo title="A mapping that outlives the file" controls={<>
      <Param spec={p.schema.size} value={size} onChange={(x2) => p.set("size", x2 as number)} />
      <Param spec={p.schema.off} value={off} onChange={(x2) => p.set("off", x2 as number)} />
    </>}>
      <svg viewBox={`0 0 ${W} 86`} style={{ width: "100%", display: "block" }} role="img" aria-label="Pages of the mapping, the end of the file and the access offset">
        {[0, 1, 2, 3].map((i) => <rect key={i} x={x(i * P) + 1} y={26} width={x(P) - 2} height={30} fill={i < 3 ? "var(--subtle)" : "transparent"} stroke="var(--border)" strokeDasharray={i < 3 ? undefined : "3 3"} />)}
        <rect x={1} y={26} width={Math.max(0, x(size) - 1)} height={30} fill="var(--c1)" opacity={0.7} />
        {fileEnd > size && <rect x={x(size)} y={26} width={x(fileEnd) - x(size)} height={30} fill="var(--c2)" opacity={0.45} />}
        {fileEnd < map && <rect x={x(fileEnd)} y={26} width={x(map) - x(fileEnd)} height={30} fill="var(--c4)" opacity={0.3} />}
        {[0, 1, 2, 3].map((i) => <text key={i} x={x(i * P + P / 2)} y={70} textAnchor="middle" style={{ fontSize: 11, fill: "var(--muted)" }}>{i < 3 ? `page ${i}` : "not mapped"}</text>)}
        <line x1={x(size)} x2={x(size)} y1={18} y2={60} stroke="var(--fg)" />
        <text x={Math.min(W - 26, Math.max(26, x(size)))} y={13} textAnchor="middle" style={{ fontSize: 11, fill: "var(--fg)" }}>EOF</text>
        <path d={`M${x(off)},84 l-5,-8 l10,0 z`} fill={o.color} />
      </svg>
      <p style={{ fontSize: 15, fontWeight: 700, margin: "8px 0 2px", color: o.color }}>{o.label}</p>
      <p style={{ fontSize: 13, margin: 0 }}>{o.note}</p>
      <div style={{ marginTop: 8 }}><Legend box items={[{ label: "file data", color: "var(--c1)" }, { label: "zero fill in the last page", color: "var(--c2)" }, { label: "SIGBUS", color: "var(--c4)" }]} /></div>
    </Demo>
  );
}
