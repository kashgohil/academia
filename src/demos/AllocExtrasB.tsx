/** New demos for the allocator lessons, group B: buddy, slab, fragmentation, general-purpose allocators. */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Demo, Stats, Param, Plot, Line, Area, Dots, RuleY, Legend, range, select, toggle, useSim, useWidth, pct, mono } from "../kit";
import { mulberry32 } from "../sims/rng";
import {
  BuddyHeap, type BuddyEvent, type SlabCache, slabDemo, slabFit, FragHeap, checkerboard, fillWith, type FragMode,
  spacingStats, roundToClass, mallocTrace, runMallocModel, M_WORKLOADS, TIER_NAMES, TIER_COST, type MWorkload,
} from "../sims/allocextrasB";

const hex = (n: number) => "0x" + n.toString(16).padStart(3, "0");
const bin = (n: number, bits: number) => n.toString(2).padStart(bits, "0");
const codeText = { ...mono, fontSize: 12 };

function FragMeter({ label, value, color, note }: { label: string; value: number; color: string; note: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--muted)" }}>
        <span>{label}</span>
        <b style={{ color: "var(--fg)", fontVariantNumeric: "tabular-nums" }}>{pct(value, 1)}</b>
      </div>
      <div style={{ height: 10, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden", margin: "4px 0" }}>
        <div style={{ width: `${Math.min(100, value * 100)}%`, height: "100%", background: color, transition: "width 0.25s" }} />
      </div>
      <div className="muted" style={{ fontSize: 11.5 }}>{note}</div>
    </div>
  );
}

// ============================================================================
// Buddy tree
// ============================================================================

function describe(e: BuddyEvent): string {
  switch (e.kind) {
    case "take": return `Take the free ${e.size} B block at ${hex(e.off)}.`;
    case "split": return `Split ${hex(e.off)} (${e.size} B) into two ${e.size / 2} B buddies. Put ${hex(e.other!)} on the free list.`;
    case "merge": return `Buddy = ${hex(e.off)} XOR ${e.size} = ${hex(e.other!)}. It is free: merge into ${hex(Math.min(e.off, e.other!))} (${e.size * 2} B).`;
    case "stop": return `Buddy = ${hex(e.off)} XOR ${e.size} = ${hex(e.other!)}. It is not free: stop here.`;
    case "fail": return `No free block of ${e.size} B or larger: alloc fails.`;
  }
}

export function BuddyTreeDemo() {
  const heap = useRef<BuddyHeap | null>(null);
  if (!heap.current) heap.current = new BuddyHeap(1024, 16);
  const h = heap.current;
  const [req, setReq] = useState(33);
  const [, force] = useState(0);
  const [events, setEvents] = useState<BuddyEvent[]>([]);
  const [title, setTitle] = useState("");
  const order = useRef<number[]>([]);
  const [ref, w] = useWidth<HTMLDivElement>();

  const doAlloc = () => {
    const r = h.alloc(req);
    if (r.off !== null) order.current.push(r.off);
    setTitle(r.off === null ? `alloc(${req}) failed` : `alloc(${req}) → ${hex(r.off)}`);
    setEvents(r.events);
    force((x) => x + 1);
  };
  const doFree = (off: number) => {
    const r = h.free(off);
    order.current = order.current.filter((x) => x !== off);
    setTitle(`free(${hex(off)})`);
    setEvents(r.events);
    force((x) => x + 1);
  };

  const blocks = h.blocks();
  // Icicle layout: one row per order, the whole heap at the top.
  type Node = { off: number; order: number; kind: "split" | "free" | "live"; req: number | null };
  const nodes = new Map<string, Node>();
  for (const b of blocks) {
    nodes.set(`${b.order}:${b.off}`, { off: b.off, order: b.order, kind: b.req === null ? "free" : "live", req: b.req });
    for (let k = b.order + 1; k <= h.maxOrder; k++) {
      const off = b.off - (b.off % h.sizeOf(k));
      const key = `${k}:${off}`;
      if (!nodes.has(key)) nodes.set(key, { off, order: k, kind: "split", req: null });
    }
  }
  const hot = new Set<string>();
  for (const e of events) {
    const k = Math.round(Math.log2(e.size / h.min));
    if (e.kind === "take") hot.add(`${k}:${e.off}`);
    if (e.kind === "split") { hot.add(`${k - 1}:${e.off}`); hot.add(`${k - 1}:${e.other}`); }
    if (e.kind === "merge" || e.kind === "stop") { hot.add(`${k}:${e.off}`); hot.add(`${k}:${e.other}`); }
  }
  const rowH = 26, gapY = 5;
  const H = (h.maxOrder + 1) * (rowH + gapY);
  const sx = (off: number) => (off / h.total) * w;
  const need = h.orderFor(req);
  const s = h.stats();
  const xorEvent = events.find((e) => e.kind === "merge" || e.kind === "stop");

  return (
    <Demo
      title="Buddy tree · 1 KiB heap · 16 B minimum block"
      actions={
        <>
          <button className="btn primary" onClick={doAlloc}>Allocate {req} B</button>
          <button className="btn" disabled={!order.current.length} onClick={() => doFree(order.current.at(-1)!)}>Free newest</button>
          <button className="btn ghost" onClick={() => { h.reset(); order.current = []; setEvents([]); setTitle("reset"); force((x) => x + 1); }}>Reset</button>
        </>
      }
      controls={<Param spec={range({ label: "Request size", min: 1, max: 1024, step: 1, default: 33, format: (v) => `${v} B` })} value={req} onChange={(v) => setReq(v as number)} />}
    >
      <p style={{ margin: "0 0 10px", fontSize: 13.5 }}>
        {need < 0 ? <>A request of {req} B is larger than the heap.</> : <>alloc({req}) needs a <b>{h.sizeOf(need)} B</b> block (order {need}). It wastes <b>{h.sizeOf(need) - req} B</b> inside the block.</>}
      </p>
      <div ref={ref}>
        <svg width={w} height={H} style={{ display: "block" }}>
          {[...nodes.entries()].map(([key, n]) => {
            const size = h.sizeOf(n.order);
            const x = sx(n.off) + 1, y = (h.maxOrder - n.order) * (rowH + gapY), bw = Math.max(1, sx(size) - 2);
            const isHot = hot.has(key);
            const label = n.kind === "live" ? `${n.req}/${size}` : String(size);
            return (
              <g key={key} onClick={n.kind === "live" ? () => doFree(n.off) : undefined} style={{ cursor: n.kind === "live" ? "pointer" : undefined }}>
                <title>{`${hex(n.off)} · ${size} B · ${n.kind === "live" ? `in use, ${n.req} B requested (click to free)` : n.kind === "free" ? "free" : "split into two buddies"}`}</title>
                <rect x={x} y={y} width={bw} height={rowH} rx={3}
                  fill={n.kind === "split" ? "var(--subtle)" : n.kind === "free" ? "var(--bg)" : "var(--c1)"}
                  fillOpacity={n.kind === "live" ? 0.3 : 1}
                  stroke={isHot ? "var(--c4)" : n.kind === "free" ? "var(--c3)" : "var(--border)"}
                  strokeWidth={isHot ? 2.25 : n.kind === "free" ? 1.5 : 1} strokeDasharray={n.kind === "free" && !isHot ? "4 2" : undefined} />
                {n.kind === "live" && <rect x={x} y={y} width={Math.max(1, (bw * (n.req ?? 0)) / size)} height={rowH} rx={3} fill="var(--c1)" pointerEvents="none" />}
                {bw > label.length * 6 + 6 && (
                  <text x={x + bw / 2} y={y + rowH / 2 + 4} textAnchor="middle" fontSize={10.5} pointerEvents="none" fill={n.kind === "live" ? "var(--fg)" : n.kind === "free" ? "var(--c3)" : "var(--muted)"} fontWeight={n.kind === "split" ? 400 : 600}>{label}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <Legend box items={[{ label: "in use (dark part: requested bytes)", color: "var(--c1)" }, { label: "free block", color: "var(--c3)" }, { label: "split", color: "var(--border)" }, { label: "last operation", color: "var(--c4)" }]} />
      <div style={{ ...codeText, marginTop: 10, minHeight: 60, color: "var(--muted)" }}>
        {title ? <div style={{ color: "var(--fg)", marginBottom: 2 }}>{title}</div> : <div>Allocate, or click a block in use to free it.</div>}
        {events.map((e, i) => <div key={i}>{describe(e)}</div>)}
      </div>
      {xorEvent && (
        <div style={{ ...codeText, marginTop: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--subtle)", lineHeight: 1.5, overflowX: "auto" }}>
          {(() => {
            const bits = Math.log2(h.total);
            const flip = Math.round(Math.log2(xorEvent.size));
            const show = (n: number) => bin(n, bits).split("").map((c, i) => <span key={i} style={{ color: bits - 1 - i === flip ? "var(--c4)" : undefined, fontWeight: bits - 1 - i === flip ? 700 : 400 }}>{c}</span>);
            return (
              <>
                <div style={{ whiteSpace: "pre" }}>block  {show(xorEvent.off)}  ({xorEvent.off})</div>
                <div style={{ whiteSpace: "pre" }}>size   {show(xorEvent.size)}  ({xorEvent.size})</div>
                <div style={{ whiteSpace: "pre" }}>buddy  {show(xorEvent.other!)}  ({xorEvent.other})</div>
                <div className="muted" style={{ fontFamily: "inherit" }}>XOR flips one bit: the bit that says lower or upper half.</div>
              </>
            );
          })()}
        </div>
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>Free blocks per order (the format of one row of /proc/buddyinfo)</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${h.maxOrder + 1}, minmax(0, 1fr))`, gap: 3, marginTop: 4 }}>
        {h.freeCounts().map((c, k) => (
          <div key={k} style={{ textAlign: "center", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 0", background: c ? "var(--subtle)" : undefined }}>
            <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: c ? "var(--c3)" : "var(--faint)" }}>{c}</div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>{h.sizeOf(k)} B</div>
          </div>
        ))}
      </div>
      <div style={{ height: 12 }} />
      <Stats items={[
        { label: "requested", value: `${s.requested} B` },
        { label: "in blocks", value: `${s.allocated} B` },
        { label: "wasted inside blocks", value: s.allocated ? pct(s.internal / s.allocated, 0) : "–" },
        { label: "largest free block", value: `${s.largestFree} B` },
      ]} />
    </Demo>
  );
}

// ============================================================================
// Slab caches: full / partial / empty
// ============================================================================

export function SlabListsDemo() {
  const [target, setTarget] = useState(12);
  const [keep, setKeep] = useState(false);
  const caches = useRef<ReturnType<typeof slabDemo>>([]);
  const [, force] = useState(0);
  const build = (k: boolean, t: number) => {
    caches.current = slabDemo(k);
    caches.current.forEach((c) => c.cache.setLive(t, c.rng));
  };
  if (!caches.current.length) build(keep, target);
  const change = (t: number) => { caches.current.forEach((c) => c.cache.setLive(t, c.rng)); setTarget(t); };
  const total = caches.current.reduce((a, { cache: c }) => ({ taken: a.taken + c.pagesTaken, back: a.back + c.pagesReturned, allocs: a.allocs + c.allocs, ctor: a.ctor + c.ctorCalls }), { taken: 0, back: 0, allocs: 0, ctor: 0 });

  const mini = (c: SlabCache, slab: { id: number; live: boolean[] }) => {
    const cols = Math.min(4, c.perSlab);
    return (
      <div key={slab.id} title={`slab #${slab.id}: ${slab.live.filter(Boolean).length} of ${c.perSlab} objects in use`} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 8px)`, gap: 1, padding: 3, border: "1px solid var(--border)", borderRadius: 3, background: "var(--bg)" }}>
        {slab.live.map((l, i) => <div key={i} style={{ width: 8, height: 8, borderRadius: 2, background: l ? "var(--c1)" : "var(--subtle)", border: l ? "none" : "1px solid var(--border)", boxSizing: "border-box", transition: "background 0.2s" }} />)}
      </div>
    );
  };
  return (
    <Demo
      title="Three slab caches · 4 KiB slabs"
      actions={<button className="btn ghost" onClick={() => { build(keep, target); force((x) => x + 1); }}>Restart</button>}
      controls={
        <>
          <Param spec={range({ label: "Live objects in each cache", min: 0, max: 40, step: 1, default: 12 })} value={target} onChange={(v) => change(v as number)} />
          <Param spec={toggle({ label: "Keep one empty slab per cache", default: false })} value={keep} onChange={(v) => { setKeep(v as boolean); build(v as boolean, target); force((x) => x + 1); }} />
        </>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        {caches.current.map(({ cache: c }) => {
          const l = c.lists();
          const fit = slabFit(c.objSize);
          return (
            <div key={c.objSize}>
              <div style={{ fontSize: 13, marginBottom: 5 }}>
                <b>{c.objSize} B objects</b> <span className="muted">· {c.perSlab} per slab · {fit.leftover} B left over · {c.liveCount()} live</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
                {(["full", "partial", "empty"] as const).map((k) => (
                  <div key={k} style={{ border: "1px solid var(--border)", borderRadius: 5, padding: 5, minHeight: 44, background: k === "partial" ? "var(--subtle)" : undefined }}>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>{k} ({l[k].length})</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{l[k].map((sl) => mini(c, sl))}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ height: 12 }} />
      <Stats items={[
        { label: "pages taken from the page allocator", value: total.taken },
        { label: "pages given back", value: total.back },
        { label: "allocations", value: total.allocs },
        { label: "constructor calls (object caching)", value: total.ctor },
      ]} />
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Blue: object in use. Grey: free object, already constructed. Without object caching, each allocation would call the constructor.</p>
    </Demo>
  );
}

// ============================================================================
// Slab fit: objects per slab and leftover bytes
// ============================================================================

export function SlabFitDemo() {
  const [size, setSize] = useState(700);
  const [pages, setPages] = useState("1");
  const f = slabFit(size, Number(pages));
  const [ref, w] = useWidth<HTMLDivElement>();
  const scale = w / f.bytes;
  const drawEach = f.perSlab <= 96;
  return (
    <Demo
      title="How objects fill one slab"
      controls={
        <>
          <Param spec={range({ label: "Object size", min: 16, max: 2048, step: 8, default: 700, format: (v) => `${v} B` })} value={size} onChange={(v) => setSize(v as number)} />
          <Param spec={select({ label: "Slab size", options: ["1", "2", "4", "8"].map((p) => ({ value: p, label: `${p} page${p === "1" ? "" : "s"}` })), default: "1", segmented: true })} value={pages} onChange={(v) => setPages(v as string)} />
        </>
      }
    >
      <div ref={ref}>
        <svg width={w} height={34} style={{ display: "block" }}>
          {drawEach
            ? Array.from({ length: f.perSlab }, (_, i) => <rect key={i} x={i * size * scale} y={2} width={Math.max(0.5, size * scale - (size * scale > 3 ? 1 : 0))} height={30} fill="var(--c1)" opacity={i % 2 ? 0.75 : 1} />)
            : <rect x={0} y={2} width={f.perSlab * size * scale} height={30} fill="var(--c1)" />}
          <rect x={f.perSlab * size * scale} y={2} width={Math.max(0, f.leftover * scale)} height={30} fill="var(--c4)" opacity={0.85} />
        </svg>
      </div>
      <Legend box items={[{ label: "objects", color: "var(--c1)" }, { label: "left over (cannot hold an object)", color: "var(--c4)" }]} />
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "objects per slab", value: f.perSlab },
        { label: "left over", value: `${f.leftover} B` },
        { label: "wasted", value: pct(f.waste, 1) },
        { label: "cache colors (64 B steps)", value: f.colors },
      ]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 4, marginTop: 12 }}>
        {["1", "2", "4", "8"].map((p) => {
          const g = slabFit(size, Number(p));
          return (
            <button key={p} className="btn" onClick={() => setPages(p)} style={{ display: "block", textAlign: "center", padding: "4px 2px", borderColor: p === pages ? "var(--fg)" : undefined }}>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>{p} page{p === "1" ? "" : "s"}</div>
              <div style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{pct(g.waste, 1)}</div>
            </button>
          );
        })}
      </div>
    </Demo>
  );
}

// ============================================================================
// Fragmentation explorer: internal vs external
// ============================================================================

export function FragExplorerDemo() {
  const [mode, setMode] = useState<FragMode>("exact");
  const [req, setReq] = useState(65);
  const heaps = useRef<Record<FragMode, FragHeap> | null>(null);
  if (!heaps.current) heaps.current = { exact: new FragHeap("exact"), buddy: new FragHeap("buddy") };
  const h = heaps.current[mode];
  const [, force] = useState(0);
  const [msg, setMsg] = useState("");
  const rng = useRef(mulberry32(9));
  const [ref, w] = useWidth<HTMLDivElement>();
  const ROW = 256, rowH = 30, gapY = 6;
  const rows = h.total / ROW;
  const s = h.stats();
  const blocks = h.blocks();
  const need = h.blockFor(req);
  const fits = need <= s.largestFree;
  const live = blocks.filter((b) => b.req !== null);

  const act = (f: () => string) => { setMsg(f()); force((x) => x + 1); };
  const segs = (off: number, len: number) => {
    const out: { x: number; y: number; w: number }[] = [];
    for (let r = 0; r < rows; r++) {
      const a = Math.max(off, r * ROW), b = Math.min(off + len, (r + 1) * ROW);
      if (b > a) out.push({ x: ((a - r * ROW) / ROW) * w, y: r * (rowH + gapY), w: ((b - a) / ROW) * w });
    }
    return out;
  };
  const largest = blocks.find((b) => b.req === null && b.size === s.largestFree);

  return (
    <Demo
      title="Internal and external fragmentation · 1 KiB heap"
      actions={
        <>
          <button className="btn primary" onClick={() => act(() => { const a = h.alloc(req); return a === null ? `alloc(${req}) failed: it needs ${need} B in one piece` : `alloc(${req}) → ${hex(a)}, block of ${need} B`; })}>Allocate {req} B</button>
          <button className="btn ghost" onClick={() => act(() => { h.reset(); return "reset"; })}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Request size", min: 1, max: 512, step: 1, default: 65, format: (v) => `${v} B` })} value={req} onChange={(v) => setReq(v as number)} />
          <Param spec={select({ label: "Allocator", options: [{ value: "exact", label: "Exact size (first fit, 8 B steps)" }, { value: "buddy", label: "Power-of-two blocks (buddy)" }], default: "exact", segmented: true })} value={mode} onChange={(v) => { setMode(v as FragMode); setMsg(""); }} />
        </>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => act(() => { const n = checkerboard(h); return `${n} × alloc(64), then free every second block`; })}>Checkerboard</button>
        <button className="btn" onClick={() => act(() => { const n = fillWith(h, req); return `${n} objects of ${req} B fit in the heap`; })}>Fill with {req} B</button>
        <button className="btn" disabled={!live.length} onClick={() => act(() => { const b = live[Math.floor(rng.current() * live.length)]!; h.free(b.off); return `free(${hex(b.off)})`; })}>Free random</button>
      </div>
      <div ref={ref}>
        <svg width={w} height={rows * (rowH + gapY)} style={{ display: "block" }}>
          {Array.from({ length: rows }, (_, r) => <rect key={r} x={0} y={r * (rowH + gapY)} width={w} height={rowH} rx={3} fill="var(--subtle)" stroke="var(--border)" />)}
          {blocks.map((b) => b.req === null
            ? segs(b.off, b.size).map((g, i) => <rect key={`${b.off}-${i}`} x={g.x + 0.5} y={g.y + 0.5} width={Math.max(0, g.w - 1)} height={rowH - 1} rx={3} fill="none" stroke={b === largest ? "var(--c3)" : "var(--faint)"} strokeWidth={b === largest ? 2 : 1} strokeDasharray={b === largest ? undefined : "3 2"} />)
            : (
              <g key={b.off} onClick={() => act(() => { h.free(b.off); return `free(${hex(b.off)})`; })} style={{ cursor: "pointer" }}>
                <title>{`${hex(b.off)}: ${b.req} B requested in a ${b.size} B block (click to free)`}</title>
                {segs(b.off, b.req!).map((g, i) => <rect key={`r${i}`} x={g.x} y={g.y} width={g.w} height={rowH} fill="var(--c1)" />)}
                {segs(b.off + b.req!, b.size - b.req!).map((g, i) => <rect key={`s${i}`} x={g.x} y={g.y} width={g.w} height={rowH} fill="var(--c2)" opacity={0.55} />)}
                {segs(b.off, b.size).map((g, i) => <rect key={`o${i}`} x={g.x + 0.5} y={g.y + 0.5} width={Math.max(0, g.w - 1)} height={rowH - 1} fill="none" stroke="var(--bg)" strokeWidth={1} />)}
              </g>
            ))}
        </svg>
      </div>
      <Legend box items={[{ label: "requested bytes", color: "var(--c1)" }, { label: "internal waste (rounding)", color: "var(--c2)" }, { label: "largest free block", color: "var(--c3)" }, { label: "other free blocks", color: "var(--faint)" }]} />
      <p style={{ fontSize: 13.5, margin: "10px 0", color: fits ? "var(--c3)" : "var(--c4)" }}>
        alloc({req}) needs one free block of {Number.isFinite(need) ? `${need} B` : "more than 1 KiB"}. The largest free block is {s.largestFree} B, so it {fits ? "fits" : "does not fit"}{!fits && s.free >= req ? `, although ${s.free} B are free in total` : ""}.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <FragMeter label="Internal fragmentation" value={s.internalFrac} color="var(--c2)" note={`${s.internal} B of ${s.allocated} B in blocks are not requested`} />
        <FragMeter label="External fragmentation" value={s.external} color="var(--c4)" note={`${s.free - s.largestFree} B of ${s.free} B free are outside the largest free block`} />
      </div>
      <div style={{ ...codeText, marginTop: 10, color: "var(--muted)", minHeight: 18 }}>{msg || "Click a block in use to free it."}</div>
    </Demo>
  );
}

// ============================================================================
// Size-class spacing
// ============================================================================

export function ClassSpacingDemo() {
  const [k, setK] = useState("4");
  const [req, setReq] = useState(600);
  const st = useMemo(() => spacingStats(Number(k)), [k]);
  const cls = roundToClass(st.classes, req);
  const waste = (cls - req) / cls;
  const pts = useMemo(() => st.curve.filter((_, i) => i % 2 === 0), [st]);
  return (
    <Demo
      title="Rounding waste for each request size"
      controls={
        <>
          <Param spec={range({ label: "Request size", min: 129, max: 2048, step: 1, default: 600, format: (v) => `${v} B` })} value={req} onChange={(v) => setReq(v as number)} />
          <Param spec={select({ label: "Size classes per doubling", options: [{ value: "1", label: "1 (powers of two)" }, { value: "2", label: "2" }, { value: "4", label: "4 (jemalloc)" }, { value: "8", label: "8" }], default: "4", segmented: true })} value={k} onChange={(v) => setK(v as string)} />
        </>
      }
    >
      <p style={{ margin: "0 0 8px", fontSize: 13.5 }}>
        alloc({req}) gets the <b>{cls} B</b> class. <b>{cls - req} B</b> of the block ({pct(waste, 1)}) is not used.
      </p>
      <Plot x={[128, 2048]} y={[0, 0.5]} height={200} logX xTicks={[128, 256, 512, 1024, 2048]} xFormat={(v) => `${v}`} yFormat={(v) => `${Math.round(v * 100)}%`} xLabel="request size (B)" yLabel="wasted part of the block">
        <Area points={pts} color="var(--c2)" opacity={0.18} />
        <Line points={pts} color="var(--c2)" width={1.5} />
        <RuleY at={st.avg} color="var(--c1)" label={`average ${pct(st.avg, 1)}`} />
        <Dots points={[[req, waste]]} color="var(--c4)" r={5} />
      </Plot>
      <div style={{ height: 8 }} />
      <Stats items={[
        { label: "classes from 129 B to 2 KiB", value: st.classesInRange },
        { label: "worst case", value: pct(st.worst, 2) },
        { label: "average (uniform sizes)", value: pct(st.avg, 1) },
      ]} />
    </Demo>
  );
}

// ============================================================================
// Malloc path: thread cache → central list → page heap → OS
// ============================================================================

const TIER_COLOR = ["var(--c3)", "var(--c1)", "var(--c2)", "var(--c4)"];

export function MallocPathDemo() {
  const [wl, setWl] = useState<MWorkload>("steady");
  const [cap, setCap] = useState(32);
  const trace = useMemo(() => mallocTrace(wl), [wl]);
  const res = useMemo(() => runMallocModel(trace, cap), [trace, cap]);
  const none = useMemo(() => runMallocModel(trace, 0), [trace]);
  const cur = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / 6, autoplay: false, step: () => { cur.current = Math.min(res.steps.length - 1, cur.current + 1); force((x) => x + 1); }, reset: () => { cur.current = 0; } });
  const i = Math.min(cur.current, res.steps.length - 1);
  const step = res.steps[i]!;
  const sofar: [number, number, number, number] = [0, 0, 0, 0];
  for (let j = 0; j <= i; j++) sofar[res.steps[j]!.tier]++;
  const note = M_WORKLOADS.find((x) => x.id === wl)!.note;
  const recent = res.steps.slice(Math.max(0, i - 47), i + 1);
  const jump = (n: number) => { cur.current = Math.max(0, Math.min(res.steps.length - 1, n)); force((x) => x + 1); };

  return (
    <Demo
      title="Where does each malloc and free go?"
      actions={
        <>
          <button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button>
          <button className="btn" disabled={sim.running} onClick={() => jump(cur.current + 1)}>Step</button>
          <button className="btn" onClick={() => jump(res.steps.length - 1)}>To the end</button>
          <button className="btn ghost" onClick={sim.reset}>Restart</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Thread cache size (objects per class)", min: 0, max: 64, step: 1, default: 32 })} value={cap} onChange={(v) => setCap(v as number)} />
          <Param spec={select({ label: "Workload", options: M_WORKLOADS.map((x) => ({ value: x.id, label: x.label })), default: "steady" })} value={wl} onChange={(v) => { setWl(v as MWorkload); cur.current = 0; }} />
        </>
      }
    >
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{note} {res.steps.length} operations.</p>
      <div style={{ ...codeText, fontSize: 12.5, marginBottom: 8, minHeight: 18 }}>
        #{i + 1}: {step.kind === "a" ? "malloc" : "free"}({step.size} B){wl === "prodcons" ? ` on thread ${step.thread + 1}` : ""} → <b style={{ color: TIER_COLOR[step.tier] }}>{TIER_NAMES[step.tier].toLowerCase()}</b>, cost {TIER_COST[step.tier]}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {TIER_NAMES.map((name, t) => {
          const on = t <= step.tier;
          return (
            <div key={name} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 6, border: `1.5px solid ${on ? TIER_COLOR[t] : "var(--border)"}`, background: t === step.tier ? "var(--subtle)" : "var(--bg)", marginLeft: t * 10, transition: "border-color 0.15s, background 0.15s" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{name} <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>· cost {TIER_COST[t]}{t === 1 ? " · takes a lock" : t === 3 ? " · system call" : ""}</span></div>
                <div style={{ height: 6, background: "var(--subtle)", borderRadius: 3, marginTop: 4, overflow: "hidden" }}>
                  <div style={{ width: `${(100 * sofar[t]!) / (i + 1)}%`, height: "100%", background: TIER_COLOR[t] }} />
                </div>
              </div>
              <div style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, textAlign: "right" }}>{sofar[t]}</div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2, margin: "12px 0 4px" }}>
        {recent.map((r, j) => <div key={i - recent.length + 1 + j} title={`${r.kind === "a" ? "malloc" : "free"} ${r.size} B → ${TIER_NAMES[r.tier]}`} style={{ width: 10, height: 14, borderRadius: 2, background: TIER_COLOR[r.tier], opacity: r.kind === "a" ? 1 : 0.5, outline: j === recent.length - 1 ? "2px solid var(--fg)" : undefined }} />)}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 10 }}>Last 48 operations. Solid: malloc. Faded: free. Color: the deepest level the operation reached.</div>
      <Stats items={[
        { label: "whole trace: in the thread cache", value: pct(res.fastShare, 1) },
        { label: "lock trips (central list)", value: res.counts[1] },
        { label: "OS calls", value: res.counts[3] },
        { label: "average cost per operation", value: res.avgCost.toFixed(2) },
        { label: "with no thread cache", value: none.avgCost.toFixed(2) },
      ]} />
    </Demo>
  );
}

