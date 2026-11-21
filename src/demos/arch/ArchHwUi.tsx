/**
 * Views for the hw-design module:
 * - Waveform: signals over clock cycles, as a logic analyzer or GTKWave shows them. 1-bit signals are lines; buses are
 *   segments with their value. The clock row rises at every column boundary. Scrolls inside its own box.
 * - VerilogEditor: a text area with line numbers, the error (with its line) and the warnings under it.
 * - NetView: a gate netlist drawn in levels from inputs (left) to outputs (right), with an optional LUT colouring and
 *   a highlighted critical path.
 */
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { MONO, mono, tint } from "../../kit";
import type { Mapping, Netlist, VError, Wave } from "../../sims/arch/hw";

// ---------------------------------------------------------------- waveform

export interface WaveRow { name: string; width: number; values: number[]; fmt?: (v: number) => string; color?: string }

const RH = 24, LW_MIN = 56;

export const fmtValue = (v: number, w: number) => (w === 1 ? String(v) : w <= 6 ? String(v) : (v >>> 0).toString(16));

/** Rows from a simulator wave, in order, optionally filtered by name. */
export function waveRows(wave: Wave, names?: string[], fmt?: Record<string, (v: number) => string>): WaveRow[] {
  const idx = (names ?? wave.signals.map((s) => s.name)).map((n) => wave.signals.findIndex((s) => s.name === n)).filter((i) => i >= 0);
  return idx.map((i) => ({ name: wave.signals[i]!.name, width: wave.signals[i]!.width, values: wave.values[i]!, fmt: fmt?.[wave.signals[i]!.name] }));
}

export function Waveform({ rows, cycles, cursor, onCursor, cw = 30, clock = true, first = 0, mark }: {
  rows: WaveRow[]; cycles: number; cursor?: number; onCursor?: (t: number) => void; cw?: number; clock?: boolean; first?: number;
  /** Columns to mark (for example, the cycle where a check failed). */
  mark?: number[];
}) {
  const n = Math.max(0, cycles - first);
  const W = n * cw;
  const longest = Math.max(4, ...rows.map((r) => r.name.length + (r.width > 1 ? String(r.width).length + 2 : 0)));
  const LW = Math.max(LW_MIN, Math.min(140, longest * 7 + 16));
  const all = (clock ? 1 : 0) + rows.length;
  const H = 18 + all * RH;
  const label: CSSProperties = { height: RH, lineHeight: `${RH}px`, fontFamily: MONO, fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", paddingRight: 6 };
  return (
    <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", maxWidth: "100%" }}>
      <div style={{ width: LW, minWidth: LW, borderRight: "1px solid var(--border)", padding: "0 0 0 8px", boxSizing: "border-box", background: "var(--bg)" }}>
        <div className="muted" style={{ height: 18, fontSize: 10.5, lineHeight: "18px" }}>cycle</div>
        {clock && <div className="muted" style={label}>clk</div>}
        {rows.map((r) => <div key={r.name} style={label} title={r.name}>{r.name}{r.width > 1 ? <span className="muted" style={{ fontSize: 10 }}> {r.width}b</span> : null}</div>)}
      </div>
      <div style={{ overflowX: "auto", flex: 1, minWidth: 0 }}>
        <svg width={W} height={H} style={{ display: "block" }} role="img" aria-label="waveform">
          {cursor !== undefined && cursor >= first && cursor < cycles && (
            <rect x={(cursor - first) * cw} y={0} width={cw} height={H} fill="var(--subtle)" stroke="var(--border)" />
          )}
          {mark?.filter((t) => t >= first && t < cycles).map((t) => (
            <rect key={`m${t}`} x={(t - first) * cw} y={0} width={cw} height={H} fill={tint("var(--c4)", 22)} />
          ))}
          {Array.from({ length: n }, (_, i) => (
            <g key={i} onClick={onCursor ? () => onCursor(first + i) : undefined} style={{ cursor: onCursor ? "pointer" : undefined }}>
              <rect x={i * cw} y={0} width={cw} height={H} fill="transparent" />
              <text x={i * cw + cw / 2} y={12.5} textAnchor="middle" fontSize={10} fill="var(--muted)" style={{ fontFamily: MONO, fontWeight: first + i === cursor ? 700 : 400 }}>{first + i}</text>
              <line x1={i * cw} x2={i * cw} y1={16} y2={H} stroke="var(--border)" strokeDasharray="2 3" />
            </g>
          ))}
          {clock && (() => {
            const y0 = 18 + 5, y1 = 18 + RH - 5;
            let d = "";
            for (let i = 0; i < n; i++) { const x = i * cw; d += `M${x} ${y0}H${x + cw / 2}V${y1}H${x + cw}V${y0}`; }
            return <path d={d} fill="none" stroke="var(--muted)" strokeWidth={1.3} pointerEvents="none" />;
          })()}
          {rows.map((r, ri) => {
            const top = 18 + ((clock ? 1 : 0) + ri) * RH, y0 = top + 5, y1 = top + RH - 5, mid = top + RH / 2;
            const color = r.color ?? "var(--c1)";
            const vals = r.values.slice(first, cycles);
            if (r.width === 1) {
              let d = "";
              vals.forEach((v, i) => {
                const y = v ? y0 : y1, x = i * cw;
                d += i === 0 ? `M${x} ${y}` : `V${y}`;
                d += `H${x + cw}`;
              });
              return (
                <g key={r.name} pointerEvents="none">
                  {vals.map((v, i) => (v ? <rect key={i} x={i * cw} y={y0} width={cw} height={y1 - y0} fill={tint(color, 25)} /> : null))}
                  <path d={d} fill="none" stroke={color} strokeWidth={1.6} />
                </g>
              );
            }
            // buses: merge equal neighbours into one segment
            const segs: { s: number; e: number; v: number }[] = [];
            vals.forEach((v, i) => { const last = segs[segs.length - 1]; if (last && last.v === v) last.e = i + 1; else segs.push({ s: i, e: i + 1, v }); });
            return (
              <g key={r.name} pointerEvents="none">
                {segs.map((g, k) => {
                  const x0 = g.s * cw + 1.5, x1 = g.e * cw - 1.5, sl = 3;
                  const text = (r.fmt ?? ((v: number) => fmtValue(v, r.width)))(g.v);
                  const room = (x1 - x0 - 4) / 6.4;
                  const shown = text.length <= room ? text : room >= 2 ? text.slice(0, Math.max(1, Math.floor(room) - 1)) + "…" : "";
                  return (
                    <g key={k}>
                      <path d={`M${x0} ${mid}L${x0 + sl} ${y0}H${x1 - sl}L${x1} ${mid}L${x1 - sl} ${y1}H${x0 + sl}Z`} fill={tint(color, g.v ? 20 : 8)} stroke={color} strokeWidth={1.1} />
                      <text x={(x0 + x1) / 2} y={mid + 4} textAnchor="middle" fontSize={10.5} fill="var(--fg)" style={{ fontFamily: MONO }}>{shown}<title>{`${r.name} = ${text}`}</title></text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor

/** A monospace text area with line numbers. `error` marks its line; warnings are listed under the box. */
export function VerilogEditor({ value, onChange, error, warnings = [], rows = 14, mark }: {
  value: string; onChange: (v: string) => void; error?: VError | null; warnings?: VError[]; rows?: number;
  /** A line to highlight (1-based), for example the line that a bug changed. */
  mark?: number;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const lines = value.split("\n").length;
  const LH = 18;
  const focus = mark ?? error?.line;
  useEffect(() => {
    // bring the marked line (or the error) into view
    const t = area.current;
    if (!t || !focus) return;
    const top = (focus - 1) * LH;
    if (top < t.scrollTop || top > t.scrollTop + t.clientHeight - 2 * LH) t.scrollTop = Math.max(0, top - 3 * LH);
    if (gutter.current) gutter.current.scrollTop = t.scrollTop;
  }, [focus]);
  const warnLines = new Set(warnings.map((w) => w.line));
  return (
    <div>
      <div style={{ display: "flex", border: `1px solid ${error ? "var(--c4)" : "var(--border)"}`, borderRadius: 6, overflow: "hidden", background: "var(--bg)" }}>
        <div ref={gutter} aria-hidden style={{ overflow: "hidden", height: rows * LH + 12, padding: "6px 0", minWidth: 34, textAlign: "right", background: "var(--subtle)", borderRight: "1px solid var(--border)", boxSizing: "border-box", flexShrink: 0 }}>
          {Array.from({ length: lines }, (_, i) => {
            const ln = i + 1;
            const bad = error?.line === ln, warn = warnLines.has(ln), on = mark === ln;
            return (
              <div key={i} style={{ fontFamily: MONO, fontSize: 11, lineHeight: `${LH}px`, height: LH, padding: "0 6px", color: bad ? "var(--c4)" : warn ? "var(--c2)" : "var(--faint)", fontWeight: bad || warn || on ? 700 : 400, background: bad ? tint("var(--c4)", 25) : on ? tint("var(--c2)", 30) : undefined }}>{ln}</div>
            );
          })}
        </div>
        <textarea
          ref={area}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          rows={rows}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label="Verilog source"
          style={{
            flex: 1, minWidth: 0, height: rows * LH + 12, boxSizing: "border-box", fontFamily: MONO, fontSize: 12.5, lineHeight: `${LH}px`, padding: "6px 8px",
            resize: "none", border: "none", outline: "none", background: "var(--bg)", color: "var(--fg)", whiteSpace: "pre", overflow: "auto", tabSize: 2,
          }}
        />
      </div>
      {error && <div style={{ fontSize: 12.5, marginTop: 4, color: "var(--c4)", ...mono }}>line {error.line}: {error.message}</div>}
      {warnings.slice(0, 4).map((w, i) => <div key={i} style={{ fontSize: 12.5, marginTop: 3, color: "var(--c2)", ...mono }}>line {w.line}: warning: {w.message}</div>)}
    </div>
  );
}

// ---------------------------------------------------------------- netlist view

const OP_TEXT: Record<string, string> = { not: "NOT", and: "AND", or: "OR", xor: "XOR", mux: "MUX" };
export const LUT_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];

/**
 * Draws the live gates of a netlist in levels. With `mapping`, each gate takes the colour of the LUT that holds it.
 * `path` (gate ids) is drawn thick. Returns a note instead when the netlist is too large to read.
 */
export function NetView({ net, mapping, path, maxGates = 90, caption }: { net: Netlist; mapping?: Mapping; path?: number[]; maxGates?: number; caption?: ReactNode }) {
  const layout = useMemo(() => {
    const live = net.live();
    const level = new Map<number, number>();
    for (const id of live) {
      const f = net.fanins(id).filter((x) => level.has(x));
      level.set(id, net.gates[id]!.op === "in" ? 0 : 1 + Math.max(0, ...f.map((x) => level.get(x)!)));
    }
    const maxL = Math.max(0, ...level.values());
    const cols: number[][] = Array.from({ length: maxL + 1 }, () => []);
    for (const id of live) cols[level.get(id)!]!.push(id);
    // order each column by the mean row of its fanins (a barycentre pass), inputs by id
    const row = new Map<number, number>();
    cols.forEach((c, l) => {
      if (l > 0) c.sort((a, b) => bary(a) - bary(b));
      c.forEach((id, i) => row.set(id, i));
    });
    function bary(id: number) {
      const f = net.fanins(id).filter((x) => row.has(x));
      return f.length ? f.reduce((t, x) => t + row.get(x)! / Math.max(1, cols[level.get(x)!]!.length), 0) / f.length : 0;
    }
    return { live, level, cols, row, gates: live.filter((id) => net.gates[id]!.op !== "in").length };
  }, [net]);
  if (layout.gates > maxGates) return <div className="muted" style={{ fontSize: 12.5, padding: 8, border: "1px dashed var(--border)", borderRadius: 6 }}>{layout.gates} gates: too many to draw here. The numbers above still hold.</div>;
  const CW = 66, RHh = 26, PADL = 64, PADR = 70;
  const tallest = Math.max(...layout.cols.map((c) => c.length));
  const H = tallest * RHh + 16;
  const pos = (id: number) => {
    const l = layout.level.get(id)!, c = layout.cols[l]!;
    const off = ((tallest - c.length) * RHh) / 2;
    return { x: PADL + l * CW, y: 10 + off + layout.row.get(id)! * RHh + RHh / 2 };
  };
  const W = PADL + (layout.cols.length - 1) * CW + PADR;
  const onPath = new Set(path ?? []);
  const outsByNode = new Map<number, string[]>();
  for (const o of net.outputs) outsByNode.set(o.node, [...(outsByNode.get(o.node) ?? []), o.name]);
  const lutOf = (id: number) => (mapping ? mapping.owner[id]! : -1);
  return (
    <div>
      <div style={{ overflow: "auto", maxHeight: 380, border: "1px solid var(--border)", borderRadius: 6 }}>
        <svg width={W} height={H} style={{ display: "block" }} role="img" aria-label="gate netlist">
          {layout.live.flatMap((id) => net.fanins(id).filter((f) => layout.level.has(f)).map((f, k) => {
            const a = pos(f), b = pos(id), hot = onPath.has(id) && onPath.has(f);
            return <path key={`${id}-${k}`} d={`M${a.x + 14} ${a.y}C${(a.x + b.x) / 2} ${a.y} ${(a.x + b.x) / 2} ${b.y} ${b.x - 16} ${b.y}`} fill="none" stroke={hot ? "var(--c4)" : "var(--faint)"} strokeWidth={hot ? 2.2 : 1} />;
          }))}
          {layout.live.map((id) => {
            const g = net.gates[id]!, p = pos(id);
            if (g.op === "in") return <text key={id} x={p.x + 12} y={p.y + 4} textAnchor="end" fontSize={10.5} fill={g.name.includes("(held)") ? "var(--c4)" : "var(--fg)"} style={{ fontFamily: MONO }}>{g.name}</text>;
            const L = lutOf(id), col = L >= 0 ? LUT_COLORS[L % LUT_COLORS.length]! : "var(--muted)";
            const isRoot = mapping?.luts[L]?.root === id;
            return (
              <g key={id}>
                <rect x={p.x - 16} y={p.y - 9} width={32} height={18} rx={4} fill={L >= 0 ? tint(col, 35) : "var(--bg)"} stroke={onPath.has(id) ? "var(--c4)" : col} strokeWidth={onPath.has(id) || isRoot ? 2 : 1} />
                <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={9} fill="var(--fg)" style={{ fontFamily: MONO, fontWeight: 600 }}>{OP_TEXT[g.op] ?? g.op}</text>
                {outsByNode.has(id) && <text x={p.x + 20} y={p.y + 4} fontSize={10.5} fill="var(--fg)" style={{ fontFamily: MONO }}>→ {outsByNode.get(id)!.join(", ")}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      {caption && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{caption}</div>}
    </div>
  );
}
