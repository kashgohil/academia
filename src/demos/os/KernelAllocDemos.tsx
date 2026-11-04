/** Lesson: a simple allocator. A boot memory map with frame allocators, and a heap bring-up stepper. */
import { useMemo, useRef, useState } from "react";
import { Canvas2D, Demo, Param, Stats, bytes, cssVar, range } from "../../kit";
import { BitmapFrames, DEMO_FRAMES, DEMO_MAP, StackFrames, bitmapBytes, carve, heapSnaps, placeEarly, type FrameAllocator, type HeapAlloc, type MemEntry, type MemType, type TableSource } from "../../sims/os/kernel";
import { Cap, Msg, Note, Panel, StepButtons, StepSlider, Verdict, mono, seg, tint } from "./KernelUi";

const TYPE_COLOR: Record<MemType, string> = { usable: "--c3", reserved: "--muted", acpi: "--faint", bootloader: "--c5", kernel: "--c1", framebuffer: "--faint" };
const MAX_CELL = 7;
const cellSize = (w: number) => Math.max(1, Math.min(MAX_CELL, Math.floor(w / COLS)));
const COLS = 64;
const STAGE_TEXT = [
  "The firmware's map, as the loader passes it. Each dot is one 4 KiB frame. Some entries do not start or end on a frame.",
  "Keep whole frames only. The usable entry that ends at 0x9FC00 loses its last partial frame, and frame 0 stays out so that a null pointer can never be a real allocation.",
  "Place the allocator's own data. An early bump allocator takes the first usable frames above 1 MiB. Now the frame allocator can start, and it hands out frames.",
];

const hx = (n: number) => `0x${n.toString(16)}`;

function typeOfFrame(f: number): MemEntry | undefined {
  const a = f * 4096;
  return DEMO_MAP.find((e) => a < e.base + e.len && a + 4096 > e.base);
}

export function BootMemMapDemo() {
  const [stage, setStage] = useState(0);
  const [kind, setKind] = useState<"bitmap" | "stack">("bitmap");
  const carved = useMemo(() => carve(DEMO_MAP, { skipFrameZero: true }), []);
  const metaAt = useMemo(() => placeEarly(carved, bitmapBytes(DEMO_FRAMES))!, [carved]);
  const make = (k: "bitmap" | "stack"): FrameAllocator => {
    if (k === "stack") {
      const ranges = carved.ranges.flatMap((r) => (r.first === metaAt.frame ? [{ first: r.first + metaAt.frames, count: r.count - metaAt.frames }] : [r]));
      return new StackFrames(ranges);
    }
    const b = new BitmapFrames(DEMO_FRAMES, carved.ranges);
    for (let i = 0; i < metaAt.frames; i++) b.reserve(metaAt.frame + i);
    return b;
  };
  const alloc = useRef<FrameAllocator>(make("bitmap"));
  const held = useRef<number[]>([]);
  const [, force] = useState(0);
  const [lastGiven, setLastGiven] = useState<number[]>([]);
  const a = alloc.current;
  const reset = (k = kind) => { alloc.current = make(k); held.current = []; setLastGiven([]); force((n) => n + 1); };
  const take = (n: number) => {
    if (stage < 2) setStage(2);
    const got: number[] = [];
    for (let i = 0; i < n; i++) { const f = alloc.current.alloc(); if (f === null) break; held.current.push(f); got.push(f); }
    setLastGiven(got);
    force((x) => x + 1);
  };
  const giveBack = (n: number) => {
    const got: number[] = [];
    for (let i = 0; i < n && held.current.length; i++) {
      const j = Math.floor(((held.current.length * 0.618 + i * 7) % 1) * held.current.length);
      const f = held.current.splice(j, 1)[0]!;
      alloc.current.free(f);
      got.push(f);
    }
    setLastGiven(got);
    force((x) => x + 1);
  };
  const heldSet = new Set(held.current);
  const given = new Set(lastGiven);
  return (
    <Demo
      title="Boot memory map and the frame allocator"
      actions={<button className="btn ghost" onClick={() => reset()}>Reset</button>}
      controls={<>
        <Param spec={range({ label: "Carving stage", min: 0, max: 2, step: 1, default: 0, format: (v) => ["raw map", "whole frames", "allocator ready"][v]! })} value={stage} onChange={(v) => setStage(v as number)} />
        <Param spec={seg<"bitmap" | "stack">("Allocator", [["bitmap", "bitmap"], ["stack", "free-list stack"]], "bitmap")} value={kind} onChange={(v) => { setKind(v as "bitmap" | "stack"); reset(v as "bitmap" | "stack"); }} />
      </>}
    >
      <Msg min={56}>{STAGE_TEXT[stage]}</Msg>
      <Canvas2D
        height={(w) => cellSize(w) * (DEMO_FRAMES / COLS)}
        deps={[stage, lastGiven, kind, held.current.length]}
        draw={(ctx, w) => {
          const cell = cellSize(w);
          for (let f = 0; f < DEMO_FRAMES; f++) {
            const x = (f % COLS) * cell, y = Math.floor(f / COLS) * cell;
            const e = typeOfFrame(f);
            let c = e ? cssVar(TYPE_COLOR[e.type]) : cssVar("--muted");
            let alpha = 1;
            if (e?.type === "usable") alpha = 0.32;
            if (stage >= 1) {
              const whole = carved.ranges.some((r) => f >= r.first && f < r.first + r.count);
              if (e?.type === "usable" && !whole) { c = cssVar("--c4"); alpha = 1; }
            }
            if (stage >= 2) {
              if (f >= metaAt.frame && f < metaAt.frame + metaAt.frames) { c = cssVar("--fg"); alpha = 1; }
              if (heldSet.has(f)) { c = cssVar("--c2"); alpha = given.has(f) ? 1 : 0.55; }
            }
            ctx.globalAlpha = alpha;
            ctx.fillStyle = c;
            ctx.fillRect(x, y, Math.max(1, cell - 1), Math.max(1, cell - 1));
          }
          ctx.globalAlpha = 1;
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 11.5, margin: "6px 0" }}>
        {([["usable", "free"], ["kernel", "kernel"], ["bootloader", "loader data"], ["acpi", "ACPI and framebuffer"], ["reserved", "reserved"]] as [MemType, string][]).map(([t, l]) => <span key={t}><span style={{ display: "inline-block", width: 9, height: 9, background: `var(${TYPE_COLOR[t]})`, opacity: t === "usable" ? 0.32 : 1, marginRight: 4 }} />{l}</span>)}
        {stage >= 1 && <span><span style={{ display: "inline-block", width: 9, height: 9, background: "var(--c4)", marginRight: 4 }} />dropped</span>}
        {stage >= 2 && <span><span style={{ display: "inline-block", width: 9, height: 9, background: "var(--c2)", marginRight: 4 }} />allocated</span>}
        {stage >= 2 && <span><span style={{ display: "inline-block", width: 9, height: 9, background: "var(--fg)", marginRight: 4 }} />bitmap</span>}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
        <button className="btn primary" onClick={() => take(1)}>Allocate 1</button>
        <button className="btn" onClick={() => take(64)}>Allocate 64</button>
        <button className="btn" onClick={() => take(512)}>Allocate 512</button>
        <button className="btn" disabled={!held.current.length} onClick={() => giveBack(8)}>Free 8 at random</button>
      </div>
      {lastGiven.length > 0 && <Note>Last frames touched: <span style={mono}>{lastGiven.slice(0, 6).join(", ")}{lastGiven.length > 6 ? ` and ${lastGiven.length - 6} more` : ""}</span></Note>}
      <Stats items={[
        { label: "usable frames", value: carved.usableFrames.toLocaleString("en-US") },
        { label: "free now", value: a.freeCount.toLocaleString("en-US") },
        { label: "metadata", value: `${a.metaBytes} B` },
        { label: a.kind === "bitmap" ? "bitmap words read" : "frame headers touched", value: a.touches.toLocaleString("en-US") },
      ]} />
      <details style={{ marginTop: 8 }}>
        <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>The map as a table</summary>
        <div style={{ ...mono, fontSize: 11, lineHeight: 1.5, marginTop: 4 }}>
          {DEMO_MAP.map((e) => <div key={e.base} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><span>{hx(e.base)}</span><span>{bytes(e.len)}</span><span style={{ color: `var(${TYPE_COLOR[e.type]})` }}>{e.type}</span><span className="muted">{e.note}</span></div>)}
        </div>
      </details>
    </Demo>
  );
}

// ---------------------------------------------------------------- heap

export function HeapBringupDemo() {
  const [k, setK] = useState(0);
  const [alloc, setAlloc] = useState<HeapAlloc>("bump");
  const [tables, setTables] = useState<TableSource>("frames");
  const snaps = useMemo(() => heapSnaps(alloc, tables), [alloc, tables]);
  const kk = Math.min(k, snaps.length - 1);
  const s = snaps[kk]!;
  const pages = Math.max(s.mappedPages, 1);
  const span = pages * 4096;
  return (
    <Demo
      title="Bring up the kernel heap"
      actions={<StepButtons k={kk} n={snaps.length} set={setK} />}
      controls={<>
        <StepSlider k={kk} n={snaps.length} set={setK} />
        <Param spec={seg<HeapAlloc>("Heap", [["bump", "bump"], ["list", "free list"]], "bump")} value={alloc} onChange={(v) => setAlloc(v as HeapAlloc)} />
        <Param spec={seg<TableSource>("Table frames come from", [["frames", "frame allocator"], ["heap", "kmalloc"]], "frames")} value={tables} onChange={(v) => setTables(v as TableSource)} />
      </>}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2, color: s.hazard ? "var(--c4)" : undefined }}>{s.title}</div>
      <Msg warn={s.hazard} min={58}>{s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <Panel title="Kernel call stack, deepest at the bottom" style={{ flex: "1 1 220px", minHeight: 120 }}>
          <div style={{ ...mono, fontSize: 11, lineHeight: 1.45 }}>
            {s.calls.length === 0 && <div className="muted">(no call is active)</div>}
            {s.calls.slice(-9).map((c, i) => <div key={i} style={{ paddingLeft: Math.min(i, 8) * 6, color: s.hazard ? "var(--c4)" : undefined }}>{c}</div>)}
          </div>
        </Panel>
        <Panel title="Frames handed out" style={{ flex: "1 1 200px", minHeight: 120 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {s.frames.map((f, i) => {
              const c = f.use === "data" ? "var(--c3)" : f.use === "root" ? "var(--c5)" : "var(--c2)";
              return <span key={i} title={f.use} style={{ ...mono, fontSize: 10.5, padding: "1px 5px", borderRadius: 3, border: `1px solid ${c}`, background: tint(c, 16) }}>{f.pfn}</span>;
            })}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", fontSize: 11, marginTop: 6 }}>
            <span style={{ color: "var(--c5)" }}>top table</span><span style={{ color: "var(--c2)" }}>table</span><span style={{ color: "var(--c3)" }}>heap data</span>
          </div>
        </Panel>
      </div>
      <Cap><span style={{ display: "block", marginTop: 10 }}>Heap, from HEAP_BASE. Thin lines mark page boundaries.</span></Cap>
      <svg viewBox={`0 0 ${span} 1`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 34, border: "1px solid var(--border)", borderRadius: 3, background: "var(--subtle)" }} role="img" aria-label="Heap blocks">
        {s.blocks.map((b, i) => <rect key={i} x={b.off} y={0} width={b.size} height={1} fill={b.free ? "var(--faint)" : `var(--c${(i % 3) + 1})`} opacity={b.free ? 0.35 : 0.85} />)}
        {Array.from({ length: pages - 1 }, (_, i) => <rect key={i} x={(i + 1) * 4096 - span / 400} y={0} width={span / 200} height={1} fill="var(--fg)" />)}
      </svg>
      <div className="muted" style={{ ...mono, fontSize: 11, marginTop: 3, minHeight: 16 }}>{s.blocks.filter((b) => !b.free && b.name).map((b) => `${b.name}: +${b.off}`).join("  ")}</div>
      <Stats items={[
        { label: "pages mapped", value: s.mappedPages },
        { label: "table frames", value: s.tableFrames },
        { label: "live bytes", value: s.liveBytes.toLocaleString("en-US") },
        { label: "bytes up to the last used block", value: s.usedSpan.toLocaleString("en-US") },
      ]} />
      {s.hazard && <Verdict tone="bad">Fix: page tables take frames directly from the frame allocator. The frame allocator has fixed data, so it never needs a new mapping or the heap.</Verdict>}
    </Demo>
  );
}
