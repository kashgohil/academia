/** Demos for the lesson on paging and page tables. */
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { Demo, Dots, Legend, Line, Param, Plot, RuleX, Stats, range, useParams, Note, mono, seg } from "../../kit";
import {
  GiB, KiB, LEVEL_NAMES, MiB, PAGE_SIZE, PTE, PTE_BIT_INFO, PageTable, SIZE_2M, TiB, canonicalize, describeErrorCode, entryPfn, flatTableBytes, fmtBytes, has, hexVa, joinVa, parseVa, splitVa, tablesForStride, vaBits, type AccessKind, type Levels,
} from "../../sims/os/vm";

const FIELD_COLORS = ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)", "var(--c4)"];

interface Sample { name: string; va: bigint }

/** A small process: real tables with text, heap, stack, a huge page and a kernel page. */
function buildSample(levels: Levels): { pt: PageTable; samples: Sample[] } {
  const pt = new PageTable({ levels });
  const text = 0x555555554000n, heap = 0x555555c00000n, stack = 0x7ffffffde000n, huge = 0x7f0000000000n, kernel = 0xffffffff81000000n;
  for (let i = 0n; i < 4n; i++) pt.map(text + i * 4096n, 0x400 + Number(i), { user: true });
  for (let i = 0n; i < 3n; i++) pt.map(heap + i * 4096n, 0x520 + Number(i), { writable: true, nx: true, user: true });
  pt.map(stack, 0x7a0, { writable: true, nx: true, user: true });
  pt.map(huge, 0x40000, { size: SIZE_2M, writable: true, nx: true, user: true });
  pt.map(kernel, 0x1000, { user: false, global: true });
  return {
    pt,
    samples: [
      { name: "code", va: text + 0x123n },
      { name: "heap", va: heap + 0x1040n },
      { name: "stack", va: stack + 0xf80n },
      { name: "2 MiB page", va: huge + 0x12345n },
      { name: "kernel", va: kernel + 0x10n },
      { name: "unmapped", va: heap + 0x10000n },
      { name: "0x8000_0000_0000", va: 0x0000800000000000n },
    ],
  };
}

const chipStyle = (on: boolean, clickable: boolean) => ({ fontSize: 11, padding: "1px 6px", borderRadius: 3, border: `1px solid ${on ? "var(--fg)" : "var(--border)"}`, background: on ? "var(--fg)" : "transparent", color: on ? "var(--bg)" : "var(--muted)", cursor: clickable ? "pointer" : "default", ...mono });

export function VmPageWalkDemo() {
  const p = useParams("vmwalk", {
    kind: seg<AccessKind>("Access", [["r", "Read"], ["w", "Write"], ["x", "Execute"]], "r"),
    levels: seg<"4" | "5">("Paging", [["4", "4 levels (48 bits)"], ["5", "5 levels, LA57 (57 bits)"]], "4"),
  });
  const levels = Number(p.values.levels) as Levels;
  const [{ pt, samples }, setBuilt] = useState(() => buildSample(levels));
  const [va, setVa] = useState<bigint>(() => samples[0]!.va);
  const [text, setText] = useState(() => hexVa(samples[0]!.va));
  const [shown, setShown] = useState(0);
  const [, force] = useState(0);
  const committed = useRef("");
  const rebuild = (l: Levels) => { const b = buildSample(l); setBuilt(b); setVa(b.samples[0]!.va); setText(hexVa(b.samples[0]!.va)); setShown(0); committed.current = ""; };
  const go = (v: bigint) => { setVa(v); setText(hexVa(v)); setShown(0); committed.current = ""; };
  const kind = p.values.kind;
  const view = pt.walk(va, { kind }, { readOnly: true });
  const f = splitVa(va, levels);
  const names = LEVEL_NAMES[levels];
  const total = view.events.length;
  const finished = shown >= total;
  const commit = () => {
    const key = `${va}:${kind}`;
    if (committed.current !== key && view.ok) { pt.walk(va, { kind }); committed.current = key; force((x) => x + 1); }
  };
  const next = () => { const n = Math.min(total, shown + 1); setShown(n); if (n === total) commit(); };
  const all = () => { setShown(total); commit(); };
  const setIndex = (l: number, value: number) => {
    const idx = [...f.indices]; idx[l] = value;
    go(joinVa(idx, f.offset, levels));
  };
  const sign = vaBits(levels);
  const bitStr = va.toString(2).padStart(64, "0");
  const fields: { label: string; bits: string; color: string; value?: string }[] = [
    { label: `sign (${64 - sign})`, bits: bitStr.slice(0, 64 - sign), color: "var(--faint)" },
    ...names.map((n, l) => ({ label: n, bits: bitStr.slice(64 - sign + 9 * l, 64 - sign + 9 * (l + 1)), color: FIELD_COLORS[l]!, value: String(f.indices[l]) })),
    { label: "offset", bits: bitStr.slice(52), color: "var(--muted)", value: `0x${f.offset.toString(16)}` },
  ];
  const leaf = pt.leaf(va);
  const flip = (bit: keyof typeof PTE) => { if (!leaf) return; pt.updateLeaf(va, (e) => e ^ PTE[bit]); setShown(0); committed.current = ""; force((x) => x + 1); };
  return (
    <Demo
      title="Walk the page table, one memory read at a time"
      actions={<>
        <button className="btn primary" onClick={next} disabled={finished}>Next read</button>
        <button className="btn" onClick={all} disabled={finished}>All</button>
        <button className="btn ghost" onClick={() => rebuild(levels)}>Reset</button>
      </>}
      controls={<>
        {names.map((n, k) => (
          <Param key={n} spec={{ kind: "range", label: `${n} index`, min: 0, max: 511, step: 1, default: 0 }} value={f.indices[k]} onChange={(x) => setIndex(k, x as number)} />
        ))}
        <Param spec={{ kind: "range", label: "Page offset", min: 0, max: 4095, step: 1, default: 0, format: (v) => `0x${v.toString(16)}` }} value={f.offset} onChange={(x) => go(joinVa(f.indices, x as number, levels))} />
        <Param spec={p.schema.kind} value={kind} onChange={(x) => { p.set("kind", x as AccessKind); setShown(0); committed.current = ""; }} />
        <Param spec={p.schema.levels} value={p.values.levels} onChange={(x) => { p.set("levels", x as "4" | "5"); rebuild(Number(x) as Levels); }} />
      </>}
    >
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {samples.map((s) => <button key={s.name} className="btn" onClick={() => go(s.va)} style={{ fontSize: 12 }}>{s.name}</button>)}
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, marginBottom: 8, flexWrap: "wrap" }}>
        <span className="muted">Virtual address</span>
        <input aria-label="Virtual address in hex" value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); const v = parseVa(e.target.value); if (v !== null) { setVa(v); setShown(0); committed.current = ""; } }} style={{ flex: "1 1 190px", minWidth: 0, maxWidth: 240, font: "inherit", padding: "3px 6px", border: `1px solid ${parseVa(text) === null ? "var(--c4)" : "var(--border)"}`, borderRadius: 4, background: "var(--bg)", color: "var(--fg)", ...mono }} />
      </label>
      {/* the bit split */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 8px", marginBottom: 12 }}>
        {fields.map((x) => (
          <div key={x.label} style={{ borderTop: `3px solid ${x.color}`, paddingTop: 2, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{x.label}{x.value !== undefined ? <b style={{ color: "var(--fg)", marginLeft: 4 }}>{x.value}</b> : null}</div>
            <div style={{ fontSize: 10.5, letterSpacing: 0.2, ...mono }}>{x.bits}</div>
          </div>
        ))}
      </div>
      {!f.canonical ? (
        <p style={{ fontSize: 13, color: "var(--c4)", margin: 0 }}>This address is not canonical: the top bits do not all equal bit {sign - 1}. The CPU raises a general protection fault. It reads no table. The nearest canonical address with these low bits is {hexVa(canonicalize(va, levels))}.</p>
      ) : (
        <>
          <div style={{ fontSize: 12.5, marginBottom: 6, overflowWrap: "anywhere", ...mono }}>CR3 → table frame 0x{pt.root.toString(16)}</div>
          <div style={{ display: "grid", gap: 6 }}>
            {view.events.map((e, i) => {
              const vis = i < shown;
              const present = e.present;
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "54px minmax(0, 1fr)", gap: 8, border: "1px solid var(--border)", borderLeft: `3px solid ${FIELD_COLORS[e.level]}`, borderRadius: 4, padding: "5px 8px", opacity: vis ? 1 : 0.35, transition: "opacity 0.15s" }}>
                  <b style={{ fontSize: 12.5 }}>{e.name}</b>
                  <div style={{ minWidth: 0, fontSize: 12, ...mono }}>
                    {vis ? (
                      <>
                        <div style={{ overflowWrap: "anywhere" }}>frame 0x{e.tablePfn.toString(16)} + {e.index} × 8 = read at 0x{e.entryPa.toString(16)}</div>
                        <div style={{ color: present ? "var(--fg)" : "var(--c4)", overflowWrap: "anywhere" }}>
                          {present ? (e.leaf ? `leaf: frame 0x${entryPfn(e.entry).toString(16)}` : `next table: frame 0x${entryPfn(e.entry).toString(16)}`) : "entry is empty: P = 0"}
                        </div>
                      </>
                    ) : <span className="muted">index {e.index}: not read yet</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, minHeight: 42, fontSize: 13 }}>
            {finished && view.ok && <span style={{ color: "var(--c3)" }}><b>Physical address {hexVa(view.pa!)}.</b> The walk took {total} memory reads for one {kind === "w" ? "write" : kind === "x" ? "fetch" : "read"}. The page is {fmtBytes(2 ** view.pageShift!)}.</span>}
            {finished && !view.ok && view.fault && <span style={{ color: "var(--c4)" }}><b>Page fault at {view.events[view.fault.level]!.name}.</b> Error code {view.fault.code}: {describeErrorCode(view.fault.code)}. CR2 receives the address, and the kernel decides what to do next.</span>}
            {!finished && <span className="muted">Press Next read. Each read is one memory access that the program did not ask for.</span>}
          </div>
          <div style={{ marginTop: 6 }}>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>Leaf entry bits{leaf ? ". Click a bit to change it" : ": no leaf entry"}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {PTE_BIT_INFO.map((b) => {
                const on = leaf ? has(leaf.entry, PTE[b.bit]) : false;
                const editable = !!leaf && ["P", "RW", "US", "NX"].includes(b.bit);
                return <button key={b.bit} title={b.meaning} disabled={!editable} onClick={() => flip(b.bit)} style={chipStyle(on, editable)}>{b.bit}</button>;
              })}
            </div>
          </div>
        </>
      )}
      <Stats items={[
        { label: "memory reads so far", value: Math.min(shown, total) },
        { label: "tables that exist", value: pt.tablePages },
        { label: "table memory", value: fmtBytes(pt.tableBytes) },
      ]} />
    </Demo>
  );
}

// ---------------- 3D wrapper ----------------

const PageTable3D = lazy(() => import("./VmPageTable3D").then((m) => ({ default: m.VmPageTable3DDemo })));
const Loading = ({ h }: { h: number }) => <div className="demo" style={{ height: h, display: "grid", placeItems: "center" }}><span className="muted" style={{ fontSize: 13 }}>Loading 3D view…</span></div>;
export function VmPageTable3DDemo() {
  return <Suspense fallback={<Loading h={520} />}><PageTable3D /></Suspense>;
}

// ---------------- table memory versus mapped memory ----------------

const SWEEP = Array.from({ length: 53 }, (_, i) => 2 ** (12 + i * 0.5)); // 4 KiB .. 256 TiB in half-octaves, clipped below
const USER_TOP = 128 * TiB;
const PATTERNS = [
  { id: "dense", label: "Dense: pages side by side", stride: PAGE_SIZE, color: "var(--c3)" },
  { id: "s2m", label: "Sparse: 1 page per 2 MiB", stride: SIZE_2M, color: "var(--c2)" },
  { id: "s1g", label: "Very sparse: 1 page per 1 GiB", stride: GiB, color: "var(--c4)" },
] as const;

export function VmTableCostDemo() {
  const p = useParams("vmcost", {
    mapped: range({ label: "Memory the program maps", min: 4 * KiB, max: 256 * GiB, default: GiB, log: true, format: (v) => fmtBytes(v) }),
    huge: seg<"no" | "yes">("Dense pattern with", [["no", "4 KiB pages"], ["yes", "2 MiB pages"]], "no"),
  });
  const flat = flatTableBytes(48);
  const x = p.values.mapped;
  const curve = (stride: number) => SWEEP.filter((b) => b <= 256 * GiB && (b / PAGE_SIZE) * stride <= USER_TOP).map((b) => [b, tablesForStride(Math.ceil(b / PAGE_SIZE), stride).bytes] as const);
  const curves = useMemo(() => PATTERNS.map((q) => ({ ...q, pts: curve(q.stride) })), []);
  const huge = useMemo(() => SWEEP.filter((b) => b >= SIZE_2M && b <= 256 * GiB).map((b) => [b, tablesForStride(Math.ceil(b / SIZE_2M), SIZE_2M, { leafSize: SIZE_2M }).bytes] as const), []);
  const at = (stride: number) => {
    const n = Math.max(1, Math.ceil(x / PAGE_SIZE));
    if (n * stride > USER_TOP) return null;
    return tablesForStride(n, stride);
  };
  const useHuge = p.values.huge === "yes";
  const denseNow = useHuge ? tablesForStride(Math.max(1, Math.ceil(x / SIZE_2M)), SIZE_2M, { leafSize: SIZE_2M }) : at(PAGE_SIZE)!;
  const dotPts = PATTERNS.map((q) => (q.id === "dense" ? denseNow.bytes : at(q.stride)?.bytes)).map((y) => [x, y ?? NaN] as const).filter((q) => Number.isFinite(q[1]));
  return (
    <Demo
      title="Page table memory versus mapped memory"
      controls={<>
        <Param spec={p.schema.mapped} value={x} onChange={(v) => p.set("mapped", v as number)} />
        <Param spec={p.schema.huge} value={p.values.huge} onChange={(v) => p.set("huge", v as "no" | "yes")} />
      </>}
    >
      <Plot x={[4 * KiB, 256 * GiB]} y={[4 * KiB, 2 * TiB]} logX logY height={290} xLabel="memory mapped" yLabel="bytes of page tables" xFormat={(v) => fmtBytes(v)} yFormat={(v) => fmtBytes(v)} xTicks={[4 * KiB, MiB, GiB, 256 * GiB]} yTicks={[4 * KiB, MiB, GiB, TiB]}>
        <Line points={[[4 * KiB, flat], [256 * GiB, flat]]} color="var(--c5)" dash="5 4" />
        {curves.map((c) => <Line key={c.id} points={c.id === "dense" && useHuge ? huge : c.pts} color={c.color} width={c.id === "dense" ? 2.5 : 2} />)}
        <RuleX at={x} color="var(--fg)" />
        <Dots points={dotPts} color="var(--fg)" />
      </Plot>
      <Legend items={[{ label: "Flat table for 48 bits", color: "var(--c5)" }, ...PATTERNS.map((q) => ({ label: q.id === "dense" && useHuge ? "Dense: 2 MiB pages" : q.label, color: q.color }))]} />
      <Stats items={[
        { label: "flat table", value: fmtBytes(flat) },
        { label: useHuge ? "dense, 2 MiB pages" : "dense", value: `${fmtBytes(denseNow.bytes)} (${(denseNow.overhead * 100).toFixed(2)}%)` },
        { label: "1 page per 2 MiB", value: at(SIZE_2M) ? `${fmtBytes(at(SIZE_2M)!.bytes)} (${(at(SIZE_2M)!.overhead * 100).toFixed(1)}%)` : "does not fit" },
        { label: "1 page per 1 GiB", value: at(GiB) ? `${fmtBytes(at(GiB)!.bytes)} (${(at(GiB)!.overhead * 100).toFixed(0)}%)` : "does not fit" },
      ]} />
      <Note>The percentage is table bytes divided by mapped bytes. A line stops where the pattern no longer fits in the 128 TiB of user space.</Note>
    </Demo>
  );
}
