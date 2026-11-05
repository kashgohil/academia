/** Demos for the lesson on the TLB. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, SimButtons, Stats, range, select, toggle, useParams, useSim, useWidth, Note, SmallLabel, mono, seg, useChunked } from "../../kit";
import {
  GiB, KiB, MiB, Mmu, PAGE_SIZES, PAGE_SIZE_LABEL, PageTable, SHOOTDOWN_MODEL, SIZE_2M, TLB_MODEL, TLB_PATTERN_LABEL, Tlb, chase, fmtBytes, nestedWalkReads, reachBytes, runTrace, shootdown, tlbPattern, type PageSizeId, type Translation, type TlbPatternId,
} from "../../sims/os/vm";

// ---------------- simulator ----------------

const TRACE_LEN = 1200;
const WALK_NAMES = ["PML4", "PDPT", "PD", "PT"];
const ASID_COLOR = ["var(--c1)", "var(--c5)"];

interface Machine { mmu: Mmu; tables: PageTable[]; asid: 0 | 1; next: number; pc: number; last: { va: number; t: Translation; set: number } | null; reads: number; note: string; hitsL: number; total: number }

function makeMachine(entries: number, ways: number, shift: number, pcid: boolean): Machine {
  const tables = [new PageTable(), new PageTable()];
  const l1 = new Tlb({ entries, ways, pageShifts: [shift] });
  return { mmu: new Mmu({ pt: tables[0]!, l1, asid: 1, pcid }), tables, asid: 0, next: 0x100, pc: 0, last: null, reads: 0, note: "", hitsL: 0, total: 0 };
}

export function VmTlbSimDemo() {
  const p = useParams("vmtlb", {
    pages: range({ label: "Pages the pattern uses", min: 1, max: 128, step: 1, default: 17 }),
    entries: seg<"8" | "16" | "32" | "64">("Entries", [["8", "8"], ["16", "16"], ["32", "32"], ["64", "64"]], "16"),
    ways: seg<"1" | "2" | "4" | "full">("Ways", [["1", "1"], ["2", "2"], ["4", "4"], ["full", "Full"]], "full"),
    page: seg<"12" | "21">("Page size", [["12", "4 KiB"], ["21", "2 MiB"]], "12"),
    pattern: select<TlbPatternId>({ label: "Pattern", options: (Object.keys(TLB_PATTERN_LABEL) as TlbPatternId[]).map((v) => ({ value: v, label: TLB_PATTERN_LABEL[v] })), default: "stride" }),
    pcid: toggle({ label: "PCID: tag entries with an address space ID", default: true }),
  });
  const v = p.values;
  const entries = Number(v.entries);
  const ways = v.ways === "full" ? entries : Number(v.ways);
  const shift = Number(v.page);
  const pageSize = 2 ** shift;
  const trace = useMemo(() => tlbPattern(v.pattern, { length: TRACE_LEN, pages: v.pages, pageSize, entries, ways, seed: 9 }), [v.pattern, v.pages, pageSize, entries, ways]);
  const fullRun = useMemo(() => runTrace(trace, { entries, ways }, shift), [trace, entries, ways, shift]);
  const m = useRef<Machine>(makeMachine(entries, ways, shift, v.pcid));
  const key = `${entries}:${ways}:${shift}:${v.pcid}:${v.pattern}:${v.pages}`;
  const lastKey = useRef(key);
  const [, force] = useState(0);
  const reset = () => { m.current = makeMachine(entries, ways, shift, v.pcid); force((x) => x + 1); };
  if (lastKey.current !== key) { lastKey.current = key; m.current = makeMachine(entries, ways, shift, v.pcid); }

  const stepOne = () => {
    const s = m.current;
    const va = trace[s.pc % trace.length]!;
    s.pc++;
    const pt = s.tables[s.asid]!;
    const page = Math.floor(va / pageSize) * pageSize;
    if (!pt.leaf(page)) {
      const pfn = shift === 12 ? s.next++ : (s.next++) * 512;
      pt.map(page, pfn, { writable: true, size: shift === 12 ? undefined : SIZE_2M });
    }
    const t = s.mmu.translate(va);
    s.reads += t.reads;
    s.total++;
    if (t.level === "l1") s.hitsL++;
    s.last = { va, t, set: s.mmu.l1.setIndex(Math.floor(va / pageSize)) };
    s.note = "";
  };
  const sim = useSim({ step: stepOne, reset, dt: 0.22, speed: 1 });
  const burst = (n: number) => { for (let i = 0; i < n; i++) stepOne(); force((x) => x + 1); };
  const ctxSwitch = () => {
    const s = m.current;
    s.asid = s.asid === 0 ? 1 : 0;
    const before = s.mmu.l1.occupied;
    s.mmu.switchTo(s.tables[s.asid]!, s.asid + 1);
    const after = s.mmu.l1.occupied;
    s.note = v.pcid ? `Now in process ${s.asid === 0 ? "A" : "B"}. PCID keeps all ${after} entries, and the tags keep the two processes apart.` : `Now in process ${s.asid === 0 ? "A" : "B"}. The CR3 load removed ${before - after} entries, so the next accesses all miss.`;
    force((x) => x + 1);
  };
  const s = m.current;
  const tlb = s.mmu.l1;
  const grid = tlb.snapshot();
  const last = s.last;
  const cell = entries >= 64 ? 34 : 44;
  return (
    <Demo
      title={`A ${entries}-entry, ${ways === entries ? "fully associative" : `${ways}-way`} TLB`}
      actions={<><SimButtons sim={sim} /><button className="btn" onClick={() => burst(100)} disabled={sim.running}>+100</button></>}
      controls={<>
        <Param spec={p.schema.pages} value={v.pages} onChange={(x) => p.set("pages", x as number)} />
        <Param spec={p.schema.pattern} value={v.pattern} onChange={(x) => p.set("pattern", x as TlbPatternId)} />
        <Param spec={p.schema.entries} value={v.entries} onChange={(x) => p.set("entries", x as "16")} />
        <Param spec={p.schema.ways} value={v.ways} onChange={(x) => p.set("ways", x as "4")} />
        <Param spec={p.schema.page} value={v.page} onChange={(x) => p.set("page", x as "12")} />
        <Param spec={p.schema.pcid} value={v.pcid} onChange={(x) => p.set("pcid", x as boolean)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, alignItems: "center" }}>
        <button className="btn" onClick={ctxSwitch}>Context switch</button>
        <span className="muted" style={{ fontSize: 12.5 }}>Running process {s.asid === 0 ? "A" : "B"}. {tlb.sets} set{tlb.sets > 1 ? "s" : ""} of {ways}. Reach: {fmtBytes(reachBytes(entries, pageSize))}.</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
        {grid.map((set, si) => {
          const active = last?.set === si;
          return (
            <div key={si} style={{ display: "flex", flexWrap: "wrap", maxWidth: "100%", gap: 2, padding: 2, borderRadius: 3, border: `1px solid ${active ? "var(--fg)" : "var(--border)"}` }}>
              {set.map((e, wi) => {
                const justHit = active && e && last && e.vpn === Math.floor(last.va / pageSize);
                const col = e ? ASID_COLOR[e.asid - 1] ?? "var(--c1)" : "transparent";
                return (
                  <div key={wi} style={{ width: cell, height: 20, fontSize: entries >= 64 ? 9 : 10, lineHeight: "20px", textAlign: "center", borderRadius: 2, background: justHit ? (last?.t.level === "l1" ? "var(--c3)" : "var(--c2)") : e ? col : "var(--subtle)", color: e ? "#fff" : "var(--faint)", opacity: e && !justHit ? 0.75 : 1, overflow: "hidden", ...mono }}>
                    {e ? (e.vpn % 65536).toString(16).padStart(4, "0") : "·"}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 12.5, minHeight: 58 }}>
        {last ? (
          <>
            <div style={mono}>
              <span style={{ overflowWrap: "anywhere" }}>0x{last.va.toString(16)}</span>{" → "}
              <b style={{ color: last.t.level === "l1" ? "var(--c3)" : "var(--c2)" }}>{last.t.level === "l1" ? "hit: no memory read" : `miss: walk, ${last.t.reads} reads`}</b>
            </div>
            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
              {WALK_NAMES.map((n, i) => {
                const ev = last.t.walk?.events[i];
                return <span key={n} style={{ fontSize: 11, padding: "1px 6px", borderRadius: 3, border: "1px solid var(--border)", background: ev ? "var(--c2)" : "transparent", color: ev ? "#fff" : "var(--faint)", ...mono }}>{n}{ev ? `[${ev.index}]` : ""}</span>;
              })}
            </div>
          </>
        ) : <span className="muted">Press Step. The highlighted set is where this address must be.</span>}
        {s.note && <div style={{ marginTop: 4 }}>{s.note}</div>}
      </div>
      <Stats items={[
        { label: "accesses", value: s.total },
        { label: "hit rate so far", value: s.total ? `${((s.hitsL / s.total) * 100).toFixed(1)}%` : "–" },
        { label: "walk reads", value: s.reads },
        { label: `hit rate over ${TRACE_LEN} accesses`, value: `${(fullRun.hitRate * 100).toFixed(1)}%` },
      ]} />
    </Demo>
  );
}

// ---------------- reach plot ----------------

const REACH_SIZES: PageSizeId[] = ["4k", "2m", "1g"];
const REACH_COLOR: Record<PageSizeId, string> = { "4k": "var(--c1)", "16k": "var(--c5)", "2m": "var(--c3)", "1g": "var(--c2)" };
const WS = Array.from({ length: 37 }, (_, i) => 2 ** (14 + i * 0.6)); // 16 KiB .. about 128 GiB
const WS_MAX = WS[WS.length - 1]!;

export function VmTlbReachDemo() {
  const p = useParams("vmreach", {
    ws: range({ label: "Working set", min: 16 * KiB, max: 128 * GiB, default: 64 * MiB, log: true, format: (x) => fmtBytes(x) }),
    data: toggle({ label: "Add the cost of the data read itself", default: false }),
  });
  const jobs = useMemo(() => REACH_SIZES.flatMap((id) => WS.map((b) => () => chase(b, id))), []);
  const res = useChunked("reach", jobs);
  const series = (id: PageSizeId) => {
    const offset = REACH_SIZES.indexOf(id) * WS.length;
    return WS.flatMap((b, i) => {
      const r = res[offset + i];
      return r ? [[b, Math.max(1, p.values.data ? r.totalCycles : r.translationCycles)] as const] : [];
    });
  };
  const near = (id: PageSizeId) => {
    const offset = REACH_SIZES.indexOf(id) * WS.length;
    let best = 0;
    WS.forEach((b, i) => { if (Math.abs(Math.log(b / p.values.ws)) < Math.abs(Math.log(WS[best]! / p.values.ws))) best = i; });
    return res[offset + best];
  };
  const m4 = TLB_MODEL["4k"];
  return (
    <Demo
      title="Random pointer chase: cycles per access against working set"
      controls={<>
        <Param spec={p.schema.ws} value={p.values.ws} onChange={(x) => p.set("ws", x as number)} />
        <Param spec={p.schema.data} value={p.values.data} onChange={(x) => p.set("data", x as boolean)} />
      </>}
    >
      <SmallLabel>{p.values.data ? "Translation plus the data read." : "Translation only: L2 TLB hits and page walks."} Model inputs: an Intel Skylake TLB and typical cache latencies.</SmallLabel>
      <Plot x={[16 * KiB, WS_MAX]} y={[1, 500]} logX logY height={280} xLabel="working set" yLabel="cycles per access (log), floor 1" xFormat={(x) => fmtBytes(x)} yFormat={(y) => String(y)} yTicks={[1, 10, 100]} xTicks={[64 * KiB, MiB, 16 * MiB, 256 * MiB, 4 * GiB, 64 * GiB]}>
        {REACH_SIZES.map((id) => <Line key={id} points={series(id)} color={REACH_COLOR[id]} />)}
        <RuleX at={reachBytes(m4.l1.entries, PAGE_SIZES["4k"])} label="L1 reach" />
        <RuleX at={reachBytes(m4.l2.entries, PAGE_SIZES["4k"])} label="L2 reach" />
        <RuleX at={p.values.ws} color="var(--fg)" />
      </Plot>
      <Legend items={REACH_SIZES.map((id) => ({ label: `${PAGE_SIZE_LABEL[id]} pages`, color: REACH_COLOR[id] }))} />
      <Stats items={REACH_SIZES.flatMap((id) => {
        const r = near(id);
        return [{ label: `${PAGE_SIZE_LABEL[id]}: L1 / L2 / walk`, value: r ? <span style={{ fontSize: 13 }}>{(r.l1Hit * 100).toFixed(0)} / {(r.l2Hit * 100).toFixed(0)} / {(r.walkRate * 100).toFixed(0)}%</span> : "…" }];
      })} />
      <Note>The dashed lines mark the reach of 4 KiB pages. A walk here costs a base plus one read of the PTE; a larger working set has a larger page table, which fits worse in the cache.</Note>
    </Demo>
  );
}

// ---------------- nested paging arithmetic ----------------

export function VmNestedWalkDemo() {
  const p = useParams("vmnest", {
    guest: range({ label: "Guest levels", min: 2, max: 5, step: 1, default: 4 }),
    host: range({ label: "Host levels (0 = no VM)", min: 0, max: 5, step: 1, default: 4 }),
  });
  const g = p.values.guest, h = p.values.host;
  const reads = nestedWalkReads(g, h);
  const [wrap, w] = useWidth<HTMLDivElement>();
  const size = Math.min(26, Math.floor((w - 60) / (h + 2)));
  return (
    <Demo
      title="Reads for one TLB miss, with nested paging"
      controls={<>
        <Param spec={p.schema.guest} value={g} onChange={(x) => p.set("guest", x as number)} />
        <Param spec={p.schema.host} value={h} onChange={(x) => p.set("host", x as number)} />
      </>}
    >
      <div ref={wrap} style={{ overflowX: "auto" }}>
        <div style={{ display: "inline-grid", gridTemplateColumns: `50px repeat(${h + 1}, ${size}px)`, gap: 2, fontSize: 10.5, alignItems: "center" }}>
          {Array.from({ length: g + 1 }, (_, r) => (
            <div key={r} style={{ display: "contents" }}>
              <span className="muted">{r < g ? `guest L${r + 1}` : "data"}</span>
              {Array.from({ length: h + 1 }, (_, c) => {
                const isHost = c < h;
                const isGuestEntry = c === h && r < g;
                const isData = c === h && r === g;
                return <div key={c} title={isData ? "the data read itself" : isGuestEntry ? "read of the guest entry" : "read of a host entry"} style={{ height: size, borderRadius: 2, background: isData ? "transparent" : isGuestEntry ? "var(--c2)" : isHost ? "var(--c1)" : "transparent", border: isData ? "1px dashed var(--faint)" : "none" }} />;
              })}
            </div>
          ))}
        </div>
      </div>
      <Legend items={[{ label: "host page table read", color: "var(--c1)" }, { label: "guest page table read", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "memory reads for one miss", value: reads },
        { label: "formula", value: <span style={{ fontSize: 13, ...mono }}>({g} + 1)({h} + 1) − 1</span> },
      ]} />
    </Demo>
  );
}

// ---------------- shootdown ----------------

export function VmShootdownDemo() {
  const p = useParams("vmshoot", {
    cores: range({ label: "Cores that run this process", min: 2, max: 128, step: 1, default: 32 }),
    pages: range({ label: "Pages in the munmap", min: 1, max: 64, step: 1, default: 1 }),
    mode: seg<"ipi" | "broadcast">("Invalidation", [["ipi", "IPIs (x86-64)"], ["broadcast", "Hardware broadcast (arm64 TLBI)"]], "ipi"),
  });
  const v = p.values;
  const broadcast = v.mode === "broadcast";
  const r = useMemo(() => shootdown({ cores: v.cores, pages: v.pages, broadcast }), [v.cores, v.pages, broadcast]);
  const curve = useMemo(() => Array.from({ length: 64 }, (_, i) => 2 + i * 2).map((n) => [n, shootdown({ cores: n, pages: v.pages, broadcast }).senderWaitNs / 1000] as const), [v.pages, broadcast]);
  const total = useMemo(() => curve.map(([n]) => [n, shootdown({ cores: n, pages: v.pages, broadcast }).totalCoreNs / 1000] as const), [curve, v.pages, broadcast]);
  const tRef = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => { tRef.current = 1; tick((x) => x + 1); }, [v.cores, v.pages, broadcast]);
  const sim = useSim({
    step: (dt) => { tRef.current = Math.min(1, tRef.current + dt / 2.4); if (tRef.current >= 1) sim.pause(); },
    reset: () => { tRef.current = 1; },
    dt: 1 / 60,
  });
  const replay = () => { tRef.current = 0; sim.play(); };
  const now = tRef.current * r.senderWaitNs;
  const [wrap, w] = useWidth<HTMLDivElement>();
  const cols = Math.max(8, Math.min(16, Math.floor(w / 26)));
  const stateOf = (core: number) => {
    if (core === 0) return now >= r.senderWaitNs && tRef.current >= 1 ? "sender-done" : "sender";
    const t = r.timeline[core - 1];
    if (!t) return "broadcast";
    if (now < t.arriveAt) return "running";
    if (now < t.ackAt) return "handler";
    return "done";
  };
  const COLOR: Record<string, string> = { sender: "var(--c2)", "sender-done": "var(--c2)", running: "var(--c1)", handler: "var(--c4)", done: "var(--c3)", broadcast: "var(--c1)" };
  const yMax = Math.max(10, Math.ceil((total[total.length - 1]?.[1] ?? 10) * 1.1));
  return (
    <Demo
      title="One munmap, N cores"
      actions={<button className="btn" onClick={replay}>Replay</button>}
      controls={<>
        <Param spec={p.schema.cores} value={v.cores} onChange={(x) => p.set("cores", x as number)} />
        <Param spec={p.schema.pages} value={v.pages} onChange={(x) => p.set("pages", x as number)} />
        <Param spec={p.schema.mode} value={v.mode} onChange={(x) => p.set("mode", x as "ipi")} />
      </>}
    >
      <div ref={wrap} style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 3, marginBottom: 8 }}>
        {Array.from({ length: v.cores }, (_, i) => {
          const st = stateOf(i);
          return <div key={i} title={`core ${i}: ${st}`} style={{ height: 18, borderRadius: 2, background: COLOR[st], opacity: st === "running" || st === "broadcast" ? 0.35 : 1, transition: "opacity 0.08s" }} />;
        })}
      </div>
      <Legend items={[{ label: "sender, spinning", color: "var(--c2)" }, { label: "running your code", color: "var(--c1)" }, { label: "in the IPI handler", color: "var(--c4)" }, { label: "acknowledged", color: "var(--c3)" }]} />
      <Plot x={[2, 128]} y={[0, yMax]} height={200} xLabel="cores" yLabel="µs, model" xTicks={[2, 32, 64, 96, 128]}>
        <Line points={total} color="var(--c4)" />
        <Line points={curve} color="var(--c2)" />
        <RuleX at={v.cores} color="var(--fg)" />
      </Plot>
      <Legend items={[{ label: "time on all cores together", color: "var(--c4)" }, { label: "time the caller waits", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "IPIs sent", value: r.ipis },
        { label: "caller waits", value: `${(r.senderWaitNs / 1000).toFixed(2)} µs` },
        { label: "all cores together", value: `${(r.totalCoreNs / 1000).toFixed(1)} µs` },
        { label: "flush", value: broadcast ? "broadcast" : r.fullFlush ? "whole TLB" : `${v.pages} × INVLPG` },
      ]} />
      <Note>All costs are model inputs. Above {SHOOTDOWN_MODEL.flushCeiling} pages, Linux flushes the whole TLB instead (tlb_single_page_flush_ceiling), and the model adds the later refills.</Note>
    </Demo>
  );
}
