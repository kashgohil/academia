/** Demos for the lesson on huge pages. */
import { useRef, useState } from "react";
import { Canvas2D, Demo, Param, Plot, Dots, Legend, RuleY, Stats, cssVar, range, toggle, useParams, useWidth } from "../../kit";
import {
  FRAMES_PER_BLOCK, FREE, GiB, MiB, OTHER, PAGE_SIZE_LABEL, THP_COST, THP_DEFAULTS, ThpSim, UNMOVABLE, fmtBytes, reachRow, type PageSizeId, type ThpDefrag, type ThpEvent,
} from "../../sims/os/vm";
import { Meter, Note, mono, seg } from "../db/StorageUi";

// ---------------- reach calculator ----------------

const IDS: PageSizeId[] = ["4k", "16k", "2m", "1g"];
const COLORS: Record<PageSizeId, string> = { "4k": "var(--c1)", "16k": "var(--c5)", "2m": "var(--c3)", "1g": "var(--c2)" };

export function VmReachCalcDemo() {
  const p = useParams("vmreachcalc", {
    ws: range({ label: "Working set", min: MiB, max: 1024 * GiB, default: 32 * GiB, log: true, format: (x) => fmtBytes(x) }),
  });
  const ws = p.values.ws;
  const rows = IDS.map((id) => reachRow(id, ws));
  return (
    <Demo title="How much of the working set can the TLB cover?" controls={<Param spec={p.schema.ws} value={ws} onChange={(x) => p.set("ws", x as number)} />}>
      {rows.map((r) => (
        <Meter key={r.id} label={<>{PAGE_SIZE_LABEL[r.id]} pages: L2 reach <b style={mono}>{fmtBytes(r.l2Reach)}</b></>} value={r.coverage} max={1} color={COLORS[r.id]} text={`${(r.coverage * 100).toFixed(r.coverage < 0.1 ? 2 : 0)}%`} />
      ))}
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, ...mono }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)" }}>
              <th style={{ padding: "2px 6px" }}>page</th><th style={{ padding: "2px 6px" }}>entries needed</th><th style={{ padding: "2px 6px" }}>random miss rate</th><th style={{ padding: "2px 6px" }}>walk cycles / access</th><th style={{ padding: "2px 6px" }}>leaf PTE bytes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>{PAGE_SIZE_LABEL[r.id]}</td>
                <td style={{ padding: "2px 6px" }}>{r.entriesNeeded.toLocaleString("en-US")}</td>
                <td style={{ padding: "2px 6px" }}>{(r.missRate * 100).toFixed(1)}%</td>
                <td style={{ padding: "2px 6px" }}>{r.cyclesPerAccess.toFixed(1)}</td>
                <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>{fmtBytes(r.leafTableBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>Model inputs: an Intel Skylake L2 TLB has 1,536 entries for 4 KiB and 2 MiB pages, and 16 for 1 GiB pages. The 16 KiB row is a what-if with the 4 KiB entry count, because x86-64 has no such page.</Note>
    </Demo>
  );
}

// ---------------- THP simulator ----------------

const time = (ns: number) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(1)} ms` : `${(ns / 1000).toFixed(0)} µs`);
const EVENT_COLOR: Record<ThpEvent["kind"], string> = { "fault-huge": "var(--c3)", "fault-huge-compact": "var(--c4)", "fault-small": "var(--c1)", oom: "var(--c4)", collapse: "var(--c5)", "collapse-skip": "var(--muted)", kcompactd: "var(--c2)", "compact-fail": "var(--c4)" };
const BLOCK_COLS = 12;

export function VmThpSimDemo() {
  const p = useParams("vmthp", {
    scatter: range({ label: "Fragmentation: blocks that hold other pages", min: 0, max: 100, step: 5, default: 70, format: (x) => `${x}%` }),
    used: range({ label: "Memory used by other programs", min: 0, max: 70, step: 5, default: 40, format: (x) => `${x}%` }),
    unmovable: range({ label: "Blocks with a pinned kernel page", min: 0, max: 100, step: 5, default: 15, format: (x) => `${x}%` }),
    touched: range({ label: "Pages touched per 2 MiB region", min: 1, max: 512, step: 1, default: 512 }),
    enabled: toggle({ label: "THP on (enabled = always)", default: true }),
    defrag: seg<ThpDefrag>("On a fault with no free block (defrag)", [["never", "Fall back"], ["defer", "Fall back, kcompactd"], ["direct", "Direct compaction"]], "never"),
    seed: range({ label: "Layout seed", min: 1, max: 20, step: 1, default: THP_DEFAULTS.seed }),
  });
  const v = p.values;
  const cfgKey = `${v.scatter}:${v.used}:${v.unmovable}:${v.touched}:${v.enabled}:${v.defrag}:${v.seed}`;
  const make = () => new ThpSim({ scatter: v.scatter / 100, used: v.used / 100, unmovable: v.unmovable / 100, touchedPerRegion: v.touched, enabled: v.enabled ? "always" : "never", defrag: v.defrag, seed: v.seed });
  const simRef = useRef<ThpSim | null>(null);
  const keyRef = useRef("");
  if (keyRef.current !== cfgKey) { keyRef.current = cfgKey; simRef.current = make(); }
  const sim = simRef.current!;
  const [, force] = useState(0);
  const [last, setLast] = useState<string>("");
  const act = (f: () => string) => { setLast(f()); force((x) => x + 1); };
  const touch = (n: number) => act(() => { let t = ""; for (let i = 0; i < n; i++) t = sim.touchRegion().text; return t; });
  const scan = () => act(() => { const ev = sim.khugepagedPass(); return ev.length ? ev[ev.length - 1]!.text + (ev.length > 1 ? ` (${ev.length} regions in this pass.)` : "") : "khugepaged found nothing to collapse."; });
  const s = sim.stats;
  const faults = sim.events.filter((e) => e.latencyNs > 0);
  const [wrap, w] = useWidth<HTMLDivElement>();
  const cols = w < 480 ? 8 : BLOCK_COLS;
  const rows = Math.ceil(sim.mem.blocks / cols);
  const cellPx = (w - (cols - 1) * 3) / cols;
  const height = rows * (cellPx + 3);
  const peak = Math.max(...faults.map((e) => e.latencyNs), THP_COST.hugeFaultNs);
  const yTop = Math.max(1000, peak * 2);
  return (
    <Demo
      title={`Physical memory: ${sim.mem.blocks} blocks of 2 MiB, 512 frames each`}
      actions={<button className="btn ghost" onClick={() => { simRef.current = make(); setLast(""); force((x) => x + 1); }}>Reset</button>}
      controls={<>
        {(["scatter", "used", "unmovable", "touched"] as const).map((k) => <Param key={k} spec={p.schema[k]} value={v[k]} onChange={(x) => { p.set(k, x as number); setLast(""); }} />)}
        <Param spec={p.schema.enabled} value={v.enabled} onChange={(x) => { p.set("enabled", x as boolean); setLast(""); }} />
        <Param spec={p.schema.defrag} value={v.defrag} onChange={(x) => { p.set("defrag", x as ThpDefrag); setLast(""); }} />
        <Param spec={p.schema.seed} value={v.seed} onChange={(x) => { p.set("seed", x as number); setLast(""); }} />
      </>}
    >
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <button className="btn primary" onClick={() => touch(1)}>Touch next region</button>
        <button className="btn" onClick={() => touch(8)}>Touch 8</button>
        <button className="btn" onClick={scan}>Run khugepaged</button>
        <button className="btn" onClick={() => act(() => sim.compactOnce().text)}>Compact one block</button>
      </div>
      <div ref={wrap}>
        <Canvas2D
          height={height}
          deps={[s.regions, s.hugeRegions, s.compactionMoved, cols, cfgKey, sim.events.length]}
          draw={(ctx, W) => {
            const cell = (W - (cols - 1) * 3) / cols;
            // 512 frames as 32 columns by 16 rows, which fills the square exactly.
            const dw = cell / 32, dh = cell / 16;
            const col = { free: cssVar("--subtle"), other: cssVar("--c1"), pin: cssVar("--c4"), app: cssVar("--c2"), huge: cssVar("--c3"), border: cssVar("--border") };
            for (let b = 0; b < sim.mem.blocks; b++) {
              const x0 = (b % cols) * (cell + 3), y0 = Math.floor(b / cols) * (cell + 3);
              ctx.fillStyle = col.free;
              ctx.fillRect(x0, y0, cell, cell);
              const pins: number[] = [];
              if (sim.mem.isHugeBlock(b)) { ctx.fillStyle = col.huge; ctx.fillRect(x0, y0, cell, cell); }
              else for (let i = 0; i < FRAMES_PER_BLOCK; i++) {
                const o = sim.mem.owner[b * FRAMES_PER_BLOCK + i]!;
                if (o === FREE) continue;
                if (o === UNMOVABLE) { pins.push(i); continue; }
                ctx.fillStyle = o === OTHER ? col.other : col.app;
                ctx.fillRect(x0 + (i % 32) * dw, y0 + Math.floor(i / 32) * dh, Math.ceil(dw), Math.ceil(dh));
              }
              ctx.fillStyle = col.pin;
              for (const i of pins) ctx.fillRect(Math.min(x0 + (i % 32) * dw, x0 + cell - 6), Math.min(y0 + Math.floor(i / 32) * dh, y0 + cell - 6), 6, 6);
              ctx.strokeStyle = col.border;
              ctx.strokeRect(x0 + 0.5, y0 + 0.5, cell - 1, cell - 1);
            }
          }}
        />
      </div>
      <Legend items={[{ label: "free", color: "var(--subtle)" }, { label: "other programs (movable)", color: "var(--c1)" }, { label: "pinned", color: "var(--c4)" }, { label: "your small pages", color: "var(--c2)" }, { label: "your huge pages", color: "var(--c3)" }]} />
      <p style={{ fontSize: 13, minHeight: 36, margin: "8px 0" }}>{last || "Touch a region. With a free block, one fault maps 2 MiB. Without one, the fault falls back to small pages."}</p>
      <Stats items={[
        { label: "regions huge / small", value: `${s.hugeRegions} / ${s.smallRegions}` },
        { label: "free blocks", value: sim.mem.freeBlocks },
        { label: "TLB entries needed", value: s.tlbEntries.toLocaleString("en-US") },
        { label: "RSS / touched", value: s.usefulBytes ? `${fmtBytes(s.rssBytes)} / ${fmtBytes(s.usefulBytes)}` : "–" },
        { label: "pages moved by compaction", value: s.compactionMoved.toLocaleString("en-US") },
        { label: "pages copied by khugepaged", value: s.collapseCopied.toLocaleString("en-US") },
        { label: "worst fault, model", value: s.worstFaultNs ? time(s.worstFaultNs) : "–" },
        { label: "all faults, model", value: time(s.faultNs) },
      ]} />
      {faults.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <Plot x={[0, Math.max(8, faults.length)]} y={[500, yTop]} logY height={140} xLabel="region faulted, in order" yLabel="worst fault latency (µs), model" yFormat={(y) => `${y / 1000}`} yTicks={[1000, 10000, 100000, 1000000].filter((t) => t <= yTop)} xTicks={[0, Math.max(8, faults.length)]}>
            <RuleY at={THP_COST.hugeFaultNs} />
            {faults.map((e, i) => <Dots key={i} points={[[i + 0.5, e.latencyNs]]} color={EVENT_COLOR[e.kind]} r={3.5} />)}
          </Plot>
        </div>
      )}
    </Demo>
  );
}
