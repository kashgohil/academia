/** Demos for /os/memory/kernel-memory-allocators. */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Demo, Stats, Param, Legend, range, toggle, select, useParams, bytes, pct, Meter, Note, SmallLabel, mono, sig } from "../../kit";
import {
  SlubCache, PageAllocator, kmallocClass, classLabel, slabLayout, getOrder, runSlubWorkload, ALLOC_PATHS, PATH_LABEL, PATH_COST_NS, SLUB_WORKLOAD_LABEL,
  CONTEXT_LABEL, GFP_BITS, gfpOutcome, contextMaySleep, fragmentedZone, compactedZone, freePages, largestOrder, zoneWatermarkOk, MAX_PAGE_ORDER,
  type AllocPath, type FreePath, type ObjRef, type SlubWorkload, type GfpContext, type GfpBase, type GfpModifier, type GfpVerdict,
} from "../../sims/os/memory";
import { mulberry32 } from "../../sims/rng";

const PATH_COLOR: Record<AllocPath, string> = { fast: "var(--c3)", "slab-freelist": "var(--c1)", "cpu-partial": "var(--c5)", "node-partial": "var(--c2)", "new-slab": "var(--c4)", fail: "var(--c4)" };

function Layer({ active, title, note, children }: { active: boolean; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: "5px 8px", background: active ? "var(--subtle)" : "transparent", minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, flexWrap: "wrap" }}>
        <b style={mono}>{title}</b>
        <span className="muted" style={{ fontSize: 11.5 }}>{note}</span>
      </div>
      {children}
    </div>
  );
}

const Dots = ({ n, total, color }: { n: number; total: number; color: string }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 1.5, marginTop: 3 }}>
    {Array.from({ length: Math.min(total, 64) }, (_, i) => <span key={i} style={{ width: 7, height: 7, borderRadius: 1, background: i < n ? color : "var(--subtle)", border: "1px solid var(--border)", boxSizing: "border-box" }} />)}
  </div>
);

export function SlubPathDemo() {
  const p = useParams("slub", {
    size: range({ label: "kmalloc(size)", min: 8, max: 65536, log: true, default: 256, format: (x) => bytes(Math.round(x)) }),
    cpu: select({ label: "Running on", options: [{ value: "0", label: "CPU 0" }, { value: "1", label: "CPU 1" }], default: "0", segmented: true }),
  });
  const size = Math.round(p.values.size);
  const cpu = Number(p.values.cpu);
  const cls = kmallocClass(size);
  const key = cls ?? 0;
  const st = useRef<{ key: number; cache: SlubCache | null; held: ObjRef[] } | null>(null);
  const [, force] = useState(0);
  const [lastA, setLastA] = useState<AllocPath | null>(null);
  const [msg, setMsg] = useState("Press Alloc. The first allocation in an empty cache takes the slowest path.");
  if (!st.current || st.current.key !== key) st.current = { key, cache: cls ? new SlubCache({ size: cls, cpus: 2, pages: new PageAllocator(2048, 2) }) : null, held: [] };
  const s = st.current;
  const c = s.cache;
  const reset = () => { st.current = null; setLastA(null); setMsg("Empty cache."); force((x) => x + 1); };
  const alloc = (k: number) => {
    if (!c) return;
    let last: AllocPath | null = null;
    for (let i = 0; i < k; i++) { const r = c.alloc(cpu); last = r.path; if (r.obj) s.held.push(r.obj); }
    setLastA(last);
    setMsg(last === "fast" ? "Fast path: pop from c->freelist with a per-CPU cmpxchg. No lock, no atomic bus lock." : last === "slab-freelist" ? "c->freelist was empty, but other frees left objects on the current slab. The CPU takes that whole list." : last === "cpu-partial" ? "The current slab is used up. The CPU takes a slab from its own partial list. Still no shared lock." : last === "node-partial" ? "The CPU lists are empty. It takes n->list_lock and moves slabs from the node list." : last === "new-slab" ? `No partial slab anywhere. The cache asks the page allocator for an order-${c.order} block.` : "The page allocator has no block.");
    force((x) => x + 1);
  };
  const free = (k: number, on: number) => {
    if (!c) return;
    let last: FreePath | null = null;
    let n = 0;
    for (; n < k && s.held.length > 0; n++) last = c.free(on, s.held.pop()!);
    setLastA(null);
    setMsg(!last ? "Nothing to free." : last === "fast" ? "Fast free: the object belongs to this CPU's current slab, so it goes back on c->freelist." : last === "to-cpu-partial" ? "The object's slab was full and has no list. This CPU adopts the slab on its c->partial list." : last === "release-slab" ? "The slab became empty and the node has enough partial slabs. The pages return to the page allocator." : "Slow free: the object is not in this CPU's current slab. A cmpxchg pushes it onto the slab's own freelist.");
    force((x) => x + 1);
  };
  const lay = cls ? slabLayout(cls) : null;
  const co = c?.cpus[cpu];
  const other = c?.cpus[1 - cpu];
  const zoneWork = c?.pages.stats;
  const results = useMemo(() => (Object.keys(SLUB_WORKLOAD_LABEL) as SlubWorkload[]).map((w) => ({ w, c: runSlubWorkload(w, cls ?? 256) })), [cls]);
  return (
    <Demo
      title="The path of one kmalloc"
      actions={<>
        <button className="btn ghost" onClick={reset}>Reset</button>
      </>}
      controls={<>
        <Param spec={p.schema.size} value={p.values.size} onChange={(x) => p.set("size", x as number)} />
        <Param spec={p.schema.cpu} value={p.values.cpu} onChange={(x) => p.set("cpu", x as string)} />
      </>}
    >
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        {cls ? <>Request of {bytes(size)} → cache <b style={mono}>{classLabel(cls)}</b>. A slab is order {lay!.order} ({bytes(lay!.pages * 4096)}) and holds {lay!.objects} objects. Internal waste per object: {pct((cls - size) / cls, 0)}.</>
          : <>Request of {bytes(size)} is above 8 KiB. kmalloc skips the slab layers and asks the page allocator for an order-{getOrder(size)} block ({bytes(4096 * 2 ** getOrder(size))}).</>}
      </div>
      {c && co && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            <button className="btn" onClick={() => alloc(1)}>Alloc</button>
            <button className="btn" onClick={() => alloc(16)}>Alloc 16</button>
            <button className="btn ghost" onClick={() => free(1, cpu)}>Free on this CPU</button>
            <button className="btn ghost" onClick={() => free(16, cpu)}>Free 16</button>
            <button className="btn ghost" onClick={() => free(16, 1 - cpu)}>Free 16 on the other CPU</button>
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <Layer active={lastA === "fast"} title="c->freelist" note={`CPU ${cpu}: lockless`}>
              <Dots n={co.freelist.length} total={c.objects} color="var(--c3)" />
            </Layer>
            <Layer active={lastA === "slab-freelist"} title="c->slab freelist" note="objects from slow frees">
              <Dots n={co.slab?.freelist.length ?? 0} total={co.slab ? c.objects : 0} color="var(--c1)" />
            </Layer>
            <Layer active={lastA === "cpu-partial"} title={`c->partial: ${co.partial.length} slabs`} note={`limit ${c.cpuPartial}; other CPU: ${other!.partial.length}`} />
            <Layer active={lastA === "node-partial"} title={`n->partial: ${c.node.length} slabs`} note={`n->list_lock taken ${c.listLocks} times`} />
            <Layer active={lastA === "new-slab"} title="page allocator" note={`pcp hits ${zoneWork!.pcpHits}, zone->lock ${zoneWork!.zoneLocks} times`}>
              <div className="muted" style={{ fontSize: 11.5, ...mono }}>slabs created {c.slabsCreated}, freed {c.slabsFreed}, live objects {c.live()}</div>
            </Layer>
          </div>
          <p style={{ fontSize: 13, margin: "8px 0", minHeight: 36 }}>{msg}</p>
          <Stats items={ALLOC_PATHS.map((x) => ({ label: PATH_LABEL[x], value: c.allocPaths[x] }))} />
        </>
      )}
      <SmallLabel><span style={{ display: "block", marginTop: 10 }}>Fixed workloads of 20,000 allocations in {classLabel(cls ?? 256)}, with path costs as model inputs ({ALLOC_PATHS.map((x) => `${PATH_COST_NS[x]}`).join(", ")} ns from fastest to slowest).</span></SmallLabel>
      <div style={{ display: "grid", gap: 6 }}>
        {results.map(({ w, c: r }) => (
          <div key={w}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, gap: 8, flexWrap: "wrap" }}>
              <span>{SLUB_WORKLOAD_LABEL[w]}</span>
              <span style={mono}>alloc fast {pct(r.fastShare(), 1)} · free fast {pct(r.freeFastShare(), 1)} · {sig(r.meanAllocNs(), 3)} ns per alloc</span>
            </div>
            <div style={{ display: "flex", height: 12, borderRadius: 3, overflow: "hidden", border: "1px solid var(--border)" }}>
              {ALLOC_PATHS.map((x) => <div key={x} title={`${PATH_LABEL[x]}: ${r.allocPaths[x]}`} style={{ width: `${(r.allocPaths[x] / r.totalAllocs()) * 100}%`, background: PATH_COLOR[x] }} />)}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6 }}><Legend box items={ALLOC_PATHS.map((x) => ({ label: PATH_LABEL[x], color: PATH_COLOR[x] }))} /></div>
    </Demo>
  );
}

// ---------------- GFP explorer ----------------

const V: Record<GfpVerdict, { t: string; c: string }> = {
  ok: { t: "Correct", c: "var(--c3)" },
  warn: { t: "Works, but the kernel warns", c: "var(--c2)" },
  deadlock: { t: "Deadlock risk", c: "var(--c4)" },
  bug: { t: "Bug", c: "var(--c4)" },
};

export function GfpExplorerDemo() {
  const p = useParams("gfp", {
    order: range({ label: "Order ($2^{\\text{order}}$ pages)", min: 0, max: 10, step: 1, default: 0, format: (x) => `${x} (${bytes(4096 * 2 ** x)})` }),
    ctx: select<GfpContext>({ label: "Calling context", options: (Object.keys(CONTEXT_LABEL) as GfpContext[]).map((value) => ({ value, label: CONTEXT_LABEL[value] })), default: "spinlock" }),
    base: select<GfpBase>({ label: "Flags", options: (Object.keys(GFP_BITS) as GfpBase[]).map((value) => ({ value, label: value })), default: "GFP_KERNEL" }),
    nofail: toggle({ label: "__GFP_NOFAIL", default: false }),
    noretry: toggle({ label: "__GFP_NORETRY", default: false }),
    mayfail: toggle({ label: "__GFP_RETRY_MAYFAIL", default: false }),
  });
  const v = p.values;
  const mods: GfpModifier[] = [...(v.nofail ? ["NOFAIL" as const] : []), ...(v.noretry ? ["NORETRY" as const] : []), ...(v.mayfail ? ["RETRY_MAYFAIL" as const] : [])];
  const o = gfpOutcome(v.ctx, v.base, mods, v.order);
  const row = (label: string, yes: boolean) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "2px 0", borderTop: "1px solid var(--border)" }}>
      <span>{label}</span><b style={{ color: yes ? "var(--c3)" : "var(--muted)" }}>{yes ? "yes" : "no"}</b>
    </div>
  );
  return (
    <Demo title="What may this allocation do?" controls={<>
      <Param spec={p.schema.order} value={v.order} onChange={(x) => p.set("order", x as number)} />
      <Param spec={p.schema.ctx} value={v.ctx} onChange={(x) => p.set("ctx", x as GfpContext)} />
      <Param spec={p.schema.base} value={v.base} onChange={(x) => p.set("base", x as GfpBase)} />
      <Param spec={p.schema.nofail} value={v.nofail} onChange={(x) => p.set("nofail", x as boolean)} />
      <Param spec={p.schema.noretry} value={v.noretry} onChange={(x) => p.set("noretry", x as boolean)} />
      <Param spec={p.schema.mayfail} value={v.mayfail} onChange={(x) => p.set("mayfail", x as boolean)} />
    </>}>
      <div style={{ fontSize: 15, fontWeight: 700, color: V[o.verdict].c }}>{V[o.verdict].t}</div>
      <p style={{ fontSize: 13, margin: "4px 0 8px", minHeight: 54 }}>{o.why}</p>
      <div style={{ ...mono, fontSize: 12, marginBottom: 8, overflowWrap: "anywhere" }}>{v.base} = {o.bits.map((b) => `__GFP_${b}`).join(" | ")}</div>
      {row("This context may sleep", contextMaySleep(v.ctx))}
      {row("The flags allow sleep (direct reclaim)", o.directReclaim)}
      {row("Wakes kswapd", o.wakesKswapd)}
      {row("Reclaim may start I/O", o.mayStartIo)}
      {row("Reclaim may enter the file system", o.mayEnterFs)}
      {row("May return NULL", o.mayFail)}
      {row("May call the OOM killer", o.mayOom)}
      <div style={{ marginTop: 8 }}><Meter label="Share of the min watermark reserve it may use" value={o.reserveShare} max={1} color="var(--c5)" text={pct(o.reserveShare, 1)} /></div>
    </Demo>
  );
}

// ---------------- buddyinfo ----------------

export function BuddyinfoDemo() {
  const p = useParams("buddyinfo", {
    free: range({ label: "Free pages, chosen at random", min: 2, max: 98, step: 4, default: 30, format: (x) => `${x}%` }),
    compact: toggle({ label: "Run compaction (move used pages together)", default: false }),
  });
  const v = p.values;
  const frag = useMemo(() => fragmentedZone(v.free / 100, mulberry32(9)), [v.free]);
  const counts = v.compact ? compactedZone(frag) : frag;
  const total = freePages(counts);
  const mark = 64;
  const max = Math.max(1, ...counts);
  return (
    <Demo title="Read /proc/buddyinfo" controls={<>
      <Param spec={p.schema.free} value={v.free} onChange={(x) => p.set("free", x as number)} />
      <Param spec={p.schema.compact} value={v.compact} onChange={(x) => p.set("compact", x as boolean)} />
    </>}>
      <div style={{ ...mono, fontSize: 12, overflowX: "auto", whiteSpace: "nowrap", paddingBottom: 4 }}>Node 0, zone Normal {counts.join(" ")}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${MAX_PAGE_ORDER + 1}, minmax(0, 1fr))`, gap: 2, alignItems: "end", height: 90, marginTop: 6 }}>
        {counts.map((c, k) => <div key={k} title={`order ${k}: ${c}`} style={{ height: `${c ? 6 + (Math.log1p(c) / Math.log1p(max)) * 84 : 0}px`, background: "var(--c1)", borderRadius: "2px 2px 0 0" }} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${MAX_PAGE_ORDER + 1}, minmax(0, 1fr))`, gap: 2, ...mono, fontSize: 11, textAlign: "center", color: "var(--muted)" }}>
        {counts.map((_, k) => <div key={k}>{k}</div>)}
      </div>
      <SmallLabel><span style={{ display: "block", marginTop: 6 }}>Blocks per order (log height). Next row: can a request of this order pass the watermark check of {mark} pages?</span></SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${MAX_PAGE_ORDER + 1}, minmax(0, 1fr))`, gap: 2 }}>
        {counts.map((_, k) => { const ok = zoneWatermarkOk(counts, k, mark); return <div key={k} title={`order ${k}`} style={{ height: 14, borderRadius: 2, background: ok ? "var(--c3)" : "var(--c4)" }} />; })}
      </div>
      <Stats items={[
        { label: "free memory", value: bytes(total * 4096) },
        { label: "largest free block", value: largestOrder(counts) < 0 ? "none" : `order ${largestOrder(counts)} (${bytes(4096 * 2 ** largestOrder(counts))})` },
      ]} />
      <Note>Each row is the sum of four 4 MiB regions with every page allocated once, and then a random share freed. Compaction here is ideal: it moves all used pages together.</Note>
    </Demo>
  );
}
