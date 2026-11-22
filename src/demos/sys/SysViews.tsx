/**
 * Shared views for the Systems Programming track, on top of the program-memory toolkit in src/sims/sys/mem:
 * - StructBytes: the bytes of a layout as rows of cells, one color per field, padding hatched; optional live bytes.
 * - AddressSpaceMap: the segments of a snapshot, high addresses on top, not to scale, with rsp, brk and markers.
 * - StackView: stack frames (return address, saved rbp, locals with values), dangling pointers, popped frames dimmed.
 * - HeapBlocks: heap blocks (live, freed, leaked) as boxes, with arrows from stack and global roots and between
 *   blocks. Grid layout in address order, or a free layout from `pos` (GC object graphs, up to about 30 objects).
 * - UbBanner: one UB report in the style of a sanitizer.
 * Wide views scroll inside their own box, so they fit a 375 px screen. Colors are theme variables only.
 */
import type { CSSProperties, ReactNode } from "react";
import { Arrow, Banner, Legend, MiniTable, MONO, mono, tint, useWidth, bytes as fmtBytes } from "../../kit";
import {
  byteOwners, hex, type BlockSnap, type FrameSnap, type Layout, type PtrEdge, type SlotSnap, type Snapshot, type TraceEvent, type UbReport,
} from "../../sims/sys/mem";

/** Field colors, in order. --c4 is left out: it marks UB and dangling pointers. */
export const FIELD_COLORS = ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)"];
export const fieldColor = (i: number) => FIELD_COLORS[i % FIELD_COLORS.length]!;
/** The hatch for padding bytes. */
export const PAD_BG = "repeating-linear-gradient(135deg, var(--subtle) 0 4px, var(--border) 4px 5px)";

/** Bytes with binary units up to TiB. */
const size = (n: number) => (n >= 2 ** 40 ? `${+(n / 2 ** 40).toPrecision(3)} TiB` : fmtBytes(n));
const box: CSSProperties = { border: "1px solid var(--border)", borderRadius: 6 };
const scroll: CSSProperties = { overflowX: "auto", maxWidth: "100%" };
/** The last `n` hex digits of an address, for dense columns: …dfe8. The full value is in the title. */
const short = (a: number, n = 4) => "…" + a.toString(16).slice(-n);

// ---------------------------------------------------------------- struct bytes

const CELL = 28;

/**
 * The bytes of a struct. Each row holds `bytesPerRow` bytes; each run of one field is a colored segment with the field
 * name on top. A field's color follows its declaration index, so a C layout and a reordered Rust layout of the same
 * struct match. Padding is hatched. With `bytes`, each cell shows the byte value in hex, or ?? when it is
 * uninitialized. `table` adds a field table under it.
 */
export function StructBytes({ layout, bytesPerRow, bytes, highlight, table = true, caption }: {
  layout: Layout;
  bytesPerRow?: number;
  bytes?: { bytes: number[]; init: boolean[] };
  /** A top-level field name to outline. */
  highlight?: string;
  table?: boolean;
  caption?: ReactNode;
}) {
  const bpr = bytesPerRow ?? (layout.size <= 16 ? 8 : 16);
  const owners = byteOwners(layout);
  const rows = Math.max(1, Math.ceil(layout.size / bpr));
  const pad = layout.holes.reduce((s, h) => s + h.size, 0);
  const deepPad = owners.filter((o) => o.pad).length;
  const nameOf = (i: number) => (i < 0 ? "" : layout.fields[i]?.name ?? "");
  return (
    <div>
      <div style={{ ...scroll, ...box, padding: "6px 8px" }}>
        <div style={{ width: 40 + bpr * CELL }}>
          {Array.from({ length: rows }, (_, r) => {
            // runs of the same owner (field index, or padding) inside this row
            const runs: { from: number; to: number; field: number; pad: boolean }[] = [];
            for (let b = r * bpr; b < Math.min(layout.size, (r + 1) * bpr); b++) {
              const o = owners[b]!;
              const last = runs[runs.length - 1];
              const fieldStart = !o.pad && layout.fields[o.field]?.offset === b;
              if (last && last.field === o.field && last.pad === o.pad && !fieldStart) last.to = b + 1;
              else runs.push({ from: b, to: b + 1, field: o.field, pad: o.pad });
            }
            return (
              <div key={r} style={{ display: "flex", alignItems: "stretch", marginBottom: r < rows - 1 ? 4 : 0 }}>
                <div className="muted" style={{ width: 40, flex: "none", fontSize: 11, ...mono, paddingTop: 15 }}>+{r * bpr}</div>
                {runs.map((run) => {
                  const col = run.field >= 0 ? fieldColor(layout.fields[run.field]!.decl) : "var(--border)";
                  const on = highlight !== undefined && nameOf(run.field) === highlight;
                  const label = run.pad ? (run.to - run.from > 1 ? "pad" : "") : nameOf(run.field);
                  return (
                    <div key={run.from} title={run.pad ? `padding, ${run.to - run.from} B` : `${owners[run.from]!.path} · offset ${run.from}`} style={{ width: (run.to - run.from) * CELL, flex: "none", padding: "0 1px" }}>
                      <div style={{ fontSize: 10.5, lineHeight: "14px", height: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: run.pad ? "var(--faint)" : "var(--fg)", fontWeight: on ? 700 : 500, paddingLeft: 2 }}>{label}</div>
                      <div style={{
                        display: "flex", height: 22, borderRadius: 3, overflow: "hidden",
                        background: run.pad ? PAD_BG : tint(col, on ? 45 : 28), boxShadow: run.pad ? "inset 0 0 0 1px var(--border)" : `inset 0 -2px 0 ${col}${on ? ", inset 0 0 0 1.5px var(--fg)" : ""}`,
                      }}>
                        {Array.from({ length: run.to - run.from }, (_, k) => {
                          const b = run.from + k;
                          const init = bytes?.init[b];
                          const text = bytes ? (init ? bytes.bytes[b]!.toString(16).padStart(2, "0") : "??") : "";
                          return <span key={k} style={{ width: CELL - (k === 0 ? 2 : 0), flex: "none", textAlign: "center", fontSize: 11, lineHeight: "22px", ...mono, color: bytes && !init ? "var(--muted)" : "var(--fg)", borderLeft: k > 0 ? "1px solid color-mix(in srgb, var(--bg) 60%, transparent)" : undefined }}>{text}</span>;
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6, ...mono }}>
        {caption ?? <>{layout.typeName}: {layout.size} B, align {layout.align}, padding {pad} B{deepPad > pad ? ` (+${deepPad - pad} inside fields)` : ""}{layout.size ? ` · ${Math.round((100 * deepPad) / layout.size)}% wasted` : ""}</>}
      </div>
      {table && layout.fields.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <MiniTable
            head={["field", "type", "offset", "size", "align"]}
            highlight={(i) => layout.fields[i]?.name === highlight}
            rows={layout.fields.map((f) => [
              <span key="n" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: fieldColor(f.decl), flex: "none" }} />{f.name}</span>,
              <span key="t" style={mono}>{f.typeName}</span>, f.offset, f.size, f.align,
            ])}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- address-space map

const SEG_COLOR: Record<string, string> = { stack: "var(--c1)", mmap: "var(--c5)", heap: "var(--c3)", bss: "var(--c2)", data: "var(--c2)", rodata: "var(--faint)", text: "var(--muted)" };
const SEG_TEXT: Record<string, string> = { stack: "stack (grows down)", mmap: "mmap area (grows down)", heap: "heap (grows up)", bss: ".bss", data: ".data", rodata: ".rodata", text: ".text" };

/**
 * The segments of a snapshot as a vertical map, high addresses on top. Not to scale: the gaps between segments are
 * terabytes. rsp and brk are marked; `highlight` adds labelled markers (a pointer and what it points to).
 */
export function AddressSpaceMap({ snapshot, highlight = [] }: { snapshot: Snapshot; highlight?: { addr: number; label: string }[] }) {
  const segs = [...snapshot.segments].sort((a, b) => b.lo - a.lo);
  const marks = [...highlight, { addr: snapshot.rsp, label: "rsp" }, { addr: snapshot.brk, label: "brk" }];
  const inSeg = (s: Snapshot["segments"][number], a: number) => a >= s.lo && a <= s.hi && !(s.name === "heap" && a === s.hi && a !== snapshot.brk);
  return (
    <div style={{ ...scroll }}>
      <div style={{ minWidth: 300, fontSize: 12, ...mono }}>
        {segs.map((s, i) => {
          const next = segs[i + 1];
          const gap = next ? s.lo - next.hi : 0;
          const here = marks.filter((m) => inSeg(s, m.addr) && (m.label !== "brk" || s.name === "heap") && (m.label !== "rsp" || s.name === "stack"));
          const empty = s.used === 0 && s.name !== "stack";
          return (
            <div key={s.name}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, padding: "5px 8px 5px 11px", borderRadius: 5, border: "1px solid var(--border)", boxShadow: `inset 3px 0 0 ${SEG_COLOR[s.name]}`, background: empty ? undefined : tint(SEG_COLOR[s.name]!, 10), opacity: empty ? 0.6 : 1 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "inherit", fontWeight: 600 }}>{SEG_TEXT[s.name]} <span className="muted" style={{ fontWeight: 400 }}>{s.perms}</span></div>
                  <div className="muted" style={{ fontSize: 11 }}>{hex(s.lo)} – {hex(s.hi)}</div>
                  {here.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
                      {here.map((m) => <span key={m.label} style={{ fontSize: 11, padding: "0 5px", borderRadius: 4, border: "1px solid var(--fg)", whiteSpace: "nowrap" }}>{m.label} → {hex(m.addr)}</span>)}
                    </div>
                  )}
                </div>
                <div className="muted" style={{ textAlign: "right", fontSize: 11 }}>{s.used ? `${fmtBytes(s.used)} used` : "empty"}</div>
              </div>
              {next && (
                <div className="muted" style={{ fontSize: 10.5, padding: "1px 0 1px 12px", margin: "1px 0", borderLeft: gap > 0 ? "1px dashed var(--border)" : undefined, marginLeft: 6 }}>
                  {gap > 0 ? `unmapped gap · ${size(gap)}` : ""}
                </div>
              )}
            </div>
          );
        })}
        <div className="muted" style={{ fontSize: 10.5, marginTop: 4 }}>0x0 – 0xfff: the null page, never mapped. Not to scale.</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- stack frames

function SlotRow({ s, dead }: { s: SlotSnap; dead: boolean }) {
  const meta = s.kind === "ret" || s.kind === "fp";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "50px minmax(0, 1fr) auto", gap: 8, padding: "2px 8px", borderTop: "1px solid var(--border)", alignItems: "baseline" }}>
      <span className="muted" title={hex(s.addr)}>{short(s.addr)}</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: meta ? "var(--muted)" : "var(--fg)" }}>
        {meta ? s.name : <>{s.name}<span className="muted">: {s.typeName}</span></>}
      </span>
      <span style={{ textAlign: "right", whiteSpace: "nowrap", color: s.init === "no" ? "var(--faint)" : s.dangling && !dead ? "var(--c4)" : "var(--fg)" }}>
        {s.text}
        {s.dangling && !dead && <span style={{ marginLeft: 6, fontSize: 10.5, padding: "0 4px", borderRadius: 3, border: "1px solid var(--c4)", color: "var(--c4)" }}>dangling</span>}
      </span>
    </div>
  );
}

/**
 * Stack frames, high addresses on top: the outermost frame first, the newest at the bottom. Each frame lists its return
 * address, saved rbp and locals (high to low address). A popped frame whose bytes are not reused yet is dashed and
 * dimmed: its values are still in memory, but no object lives there.
 */
export function StackView({ frames, empty = "No frames yet." }: { frames: FrameSnap[]; empty?: ReactNode }) {
  if (!frames.length) return <div className="muted" style={{ fontSize: 12.5 }}>{empty}</div>;
  const ordered = [...frames].sort((a, b) => b.hi - a.hi || Number(b.live) - Number(a.live));
  return (
    <div style={{ display: "grid", gap: 6, fontSize: 12, ...mono, minWidth: 0 }}>
      {ordered.map((f) => (
        <div key={f.id} style={{ border: `1px ${f.live ? "solid" : "dashed"} var(--border)`, borderRadius: 6, opacity: f.live ? 1 : 0.55, boxShadow: f.live ? "inset 3px 0 0 var(--c1)" : undefined, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 8px", flexWrap: "wrap" }}>
            <b style={{ fontWeight: 600 }}>{f.live ? `${f.fn}()` : `${f.fn}() · returned`}</b>
            <span className="muted" title={`frame [${hex(f.lo)}, ${hex(f.hi)})`}>rbp {short(f.fp)} · {f.hi - f.lo} B</span>
          </div>
          {f.slots.map((s) => <SlotRow key={s.id} s={s} dead={!f.live} />)}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- heap blocks and pointer arrows

const RW = 74, RH = 24;

type Pos = { x: number; y: number };

/** The point where the segment from the center of a w×h box at c toward p leaves the box. */
function exitPoint(c: Pos, p: Pos, w: number, h: number): Pos {
  const dx = p.x - c.x, dy = p.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? w / 2 / Math.abs(dx) : Infinity, dy ? h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/**
 * Heap blocks as boxes, with pointer arrows. Roots (stack and global slots that hold a pointer to a block) sit in a
 * column on the left. Live blocks are solid, freed blocks dashed and faint, leaked blocks outlined in --c4; a
 * dangling arrow is dashed --c4. By default the blocks fill a grid in address order; `pos` (unit coordinates, keyed by
 * block id) places them freely, for object graphs. `small` draws 54 x 26 boxes with the label only, for dense graphs;
 * `minWidth` keeps a wide graph readable on a phone (it scrolls inside its box).
 */
export function HeapBlocks({ blocks, edges = [], pos, height, roots = true, small = false, minWidth = 0, empty = "The heap is empty." }: {
  blocks: BlockSnap[];
  edges?: PtrEdge[];
  pos?: Record<number, Pos>;
  height?: number;
  roots?: boolean;
  small?: boolean;
  minWidth?: number;
  empty?: ReactNode;
}) {
  const [ref, w] = useWidth<HTMLDivElement>(600);
  const NW = small ? 54 : 92, NH = small ? 26 : 42;
  const rootEdges = roots ? edges.filter((e) => e.fromKind === "stack" || e.fromKind === "global") : [];
  const rootNames = [...new Set(rootEdges.map((e) => e.fromName))];
  const left = rootNames.length ? RW + 34 : 4;
  const width = Math.max(w, minWidth, left + NW + 8);
  const cols = Math.max(1, Math.floor((width - left) / (NW + 18)));
  const rows = Math.ceil(blocks.length / cols);
  const H = height ?? Math.max(rows * (NH + 22) + 8, rootNames.length * (RH + 8) + 8, NH + 16);
  const at = new Map<number, Pos>();
  blocks.forEach((b, i) => {
    const p = pos?.[b.id];
    at.set(b.id, p
      ? { x: left + NW / 2 + p.x * (width - left - NW - 28), y: NH / 2 + 4 + p.y * (H - NH - 8) }
      : { x: left + (i % cols) * (NW + 18) + NW / 2, y: 4 + Math.floor(i / cols) * (NH + 22) + NH / 2 });
  });
  const rootAt = new Map(rootNames.map((n, i) => [n, { x: 4 + RW / 2, y: 4 + i * (RH + 8) + RH / 2 }] as const));
  const shown = new Set(blocks.map((b) => b.id));
  // A dangling pointer whose block was reused points at whatever block holds its address now.
  const targetOf = (e: PtrEdge) => (e.to !== undefined && shown.has(e.to) ? e.to : blocks.find((b) => e.toAddr >= b.addr && e.toAddr < b.addr + Math.max(1, b.cap))?.id);
  const lines = edges
    .map((e) => ({ ...e, to: targetOf(e) }))
    .filter((e) => e.to !== undefined && (rootAt.has(e.fromName) || (shown.has(e.from) && e.fromKind !== "stack" && e.fromKind !== "global")));
  if (!blocks.length) return <div ref={ref} className="muted" style={{ fontSize: 12.5 }}>{empty}</div>;
  return (
    <div ref={ref}>
      <div style={{ ...scroll }}>
        <svg width={width} height={H} style={{ display: "block", fontFamily: MONO, fontSize: 11 }}>
          <defs>
            <Arrow id="sys-arrow" color="var(--fg)" />
            <Arrow id="sys-arrow-bad" color="var(--c4)" />
          </defs>
          {lines.map((e, i) => {
            const fromRoot = rootAt.get(e.fromName);
            const a = fromRoot ?? at.get(e.from)!, b = at.get(e.to!)!;
            const color = e.dangling ? "var(--c4)" : "var(--fg)";
            const marker = `url(#${e.dangling ? "sys-arrow-bad" : "sys-arrow"})`;
            if (!fromRoot && e.from === e.to) {
              const x = a.x + NW / 2, y = a.y;
              return <path key={i} d={`M${x} ${y - 8} C${x + 22} ${y - 26}, ${x + 22} ${y + 26}, ${x} ${y + 8}`} fill="none" stroke={color} strokeWidth={1.2} markerEnd={marker} />;
            }
            const p = exitPoint(a, b, fromRoot ? RW : NW, fromRoot ? RH : NH);
            const q = exitPoint(b, a, NW + 4, NH + 4);
            const bend = fromRoot ? 0 : 14 * (i % 2 ? 1 : -1);
            const mx = (p.x + q.x) / 2 - ((q.y - p.y) / (Math.hypot(q.x - p.x, q.y - p.y) || 1)) * bend;
            const my = (p.y + q.y) / 2 + ((q.x - p.x) / (Math.hypot(q.x - p.x, q.y - p.y) || 1)) * bend;
            return <path key={i} d={`M${p.x} ${p.y} Q${mx} ${my} ${q.x} ${q.y}`} fill="none" stroke={color} strokeWidth={1.2} strokeDasharray={e.dangling ? "4 3" : undefined} markerEnd={marker} />;
          })}
          {rootNames.map((n) => {
            const p = rootAt.get(n)!;
            return (
              <g key={n} transform={`translate(${p.x - RW / 2},${p.y - RH / 2})`}>
                <rect width={RW} height={RH} rx={4} fill="var(--subtle)" stroke="var(--border)" />
                <text x={RW / 2} y={RH / 2} dy="0.35em" textAnchor="middle" style={{ fill: "var(--fg)" }}>{n.length > 10 ? n.slice(0, 9) + "…" : n}</text>
              </g>
            );
          })}
          {blocks.map((b) => {
            const p = at.get(b.id)!;
            const col = b.state === "leaked" ? "var(--c4)" : b.state === "freed" ? "var(--faint)" : "var(--c3)";
            const name = b.objKind ? `${b.objKind} ${b.label}` : b.label;
            return (
              <g key={b.id} transform={`translate(${p.x - NW / 2},${p.y - NH / 2})`} opacity={b.state === "freed" ? 0.7 : 1}>
                <title>{`#${b.id} ${name} at ${hex(b.addr)}, ${b.size} B (${b.state})`}</title>
                <rect width={NW} height={NH} rx={5} fill={b.state === "freed" ? "var(--bg)" : tint(col, 14)} stroke={col} strokeWidth={b.state === "live" ? 1 : 1.5} strokeDasharray={b.state === "freed" ? "4 3" : undefined} />
                {small ? (
                  <text x={NW / 2} y={NH / 2} dy="0.35em" textAnchor="middle" style={{ fill: b.state === "freed" ? "var(--muted)" : "var(--fg)", fontWeight: 600 }}>{b.label.length > 6 ? b.label.slice(0, 5) + "…" : b.label}</text>
                ) : (
                  <>
                    <text x={7} y={15} style={{ fill: b.state === "freed" ? "var(--muted)" : "var(--fg)", fontWeight: 600 }}>{name.length > 12 ? name.slice(0, 11) + "…" : name}</text>
                    <text x={7} y={31} style={{ fill: "var(--muted)" }}>{b.state === "live" ? `${short(b.addr, 4)} · ${b.size} B` : b.state}</text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <Legend items={[
        { label: "live block", color: "var(--c3)" },
        { label: "freed (bytes still there)", color: "var(--faint)" },
        ...(blocks.some((b) => b.state === "leaked") ? [{ label: "leaked", color: "var(--c4)" }] : []),
        ...(lines.some((e) => e.dangling) ? [{ label: "dangling pointer", color: "var(--c4)" }] : []),
      ]} />
    </div>
  );
}

// ---------------------------------------------------------------- UB report

/**
 * A UB report as a sanitizer prints it: the tool and the kind, the access, and where the address is. Accepts a report
 * or a trace event; shows nothing for null, or `clean` when given.
 */
export function UbBanner({ event, clean }: { event: UbReport | TraceEvent | null | undefined; clean?: ReactNode }) {
  const r = event && "kind" in event ? event : event?.ub;
  if (!r) return clean ? <Banner tone="good">{clean}</Banner> : null;
  return (
    <Banner tone="bad">
      <div style={{ ...mono, fontSize: 12.5, overflowWrap: "anywhere" }}>
        <b style={{ color: "var(--c4)" }}>{r.tool}: {r.kind}</b>
        {r.message !== r.kind && <div>{r.message}</div>}
        {r.access && <div className="muted">{r.access}</div>}
      </div>
      <div style={{ fontSize: 12.5, marginTop: 3 }}>{r.note}</div>
    </Banner>
  );
}
