/**
 * Shared views for the computer architecture track, on top of the RISC-V toolkit in src/sims/arch/rv:
 * - PipelineDiagram: a pipeline result as rows of instructions and columns of cycles (stall bubbles, squashed rows,
 *   forwarding arrows).
 * - AsmListing: address, machine word and source line of each instruction, with the current pc.
 * - RegFile: the 32 registers with ABI names, in hex or signed decimal.
 * - BitFields: the 32 bits of an instruction, grouped and colored by field, with names and values.
 * - AsmEditor: a monospace text area with the assembler's errors under it.
 * Wide views scroll inside their own box, so they fit a 375 px screen.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Btn, Legend, MONO, mono, tint, useWidth } from "../../kit";
import {
  decode, disasm, fields, REG_ABI, type AsmError, type FieldKind, type PipelineResult, type Program, type Stage,
} from "../../sims/arch/rv";

const hex = (v: number, digits = 8) => (v >>> 0).toString(16).padStart(digits, "0");

// ---------------------------------------------------------------- pipeline diagram

export const STAGE_COLOR: Record<Stage, string> = { IF: "var(--c1)", ID: "var(--c2)", EX: "var(--c3)", MEM: "var(--c4)", WB: "var(--c5)" };
const CW = 30, RH = 22, HEAD = 18;

/**
 * Rows are instructions in fetch order, columns are cycles. A stall is a dashed bubble; a squashed (wrong-path)
 * instruction is dimmed and struck through. `cursor` highlights one cycle; `arrows` draws the forwarding paths used.
 * Shows `maxRows` rows from `firstRow`.
 */
export function PipelineDiagram({ result, firstRow = 0, maxRows = 40, cursor, arrows = true, legend = true }: {
  result: PipelineResult; firstRow?: number; maxRows?: number; cursor?: number; arrows?: boolean; legend?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const rows = result.rows.slice(firstRow, firstRow + maxRows);
  let c0 = Infinity, c1 = -Infinity;
  for (const r of rows) for (const c of r.cells) { c0 = Math.min(c0, c.cycle); c1 = Math.max(c1, c.cycle); }
  if (cursor !== undefined && rows.length) { c0 = Math.min(c0, cursor); c1 = Math.max(c1, cursor); }
  if (!rows.length) { c0 = 1; c1 = 1; }
  const n = c1 - c0 + 1;
  const longest = Math.max(8, ...rows.map((r) => r.text.length));
  const LW = Math.round(Math.min(longest * 7.4 + 18, 230, Math.max(96, width * 0.42)));
  const rowOf = new Map(rows.map((r, i) => [r.seq, i] as const));
  const x = (cycle: number) => (cycle - c0) * CW;
  const fw = arrows ? result.forwards.filter((f) => rowOf.has(f.src) && rowOf.has(f.seq) && f.cycle - 1 >= c0 && f.cycle <= c1) : [];
  const label: CSSProperties = {
    position: "sticky", left: 0, zIndex: 2, width: LW, minWidth: LW, background: "var(--bg)", fontFamily: MONO, fontSize: 12,
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: `${RH}px`, paddingRight: 8, boxSizing: "border-box",
  };
  return (
    <div ref={ref}>
      <div style={{ overflowX: "auto", maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 6 }}>
        <div style={{ width: LW + n * CW, position: "relative", padding: "4px 0" }}>
          <div style={{ display: "flex", height: HEAD, position: "relative", zIndex: 1 }}>
            <div className="muted" style={{ ...label, fontFamily: undefined, fontSize: 11, lineHeight: `${HEAD}px`, paddingLeft: 8 }}>cycle</div>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="muted" style={{ width: CW, textAlign: "center", fontSize: 10.5, lineHeight: `${HEAD}px`, ...mono, fontWeight: c0 + i === cursor ? 700 : 400 }}>{c0 + i}</div>
            ))}
          </div>
          {cursor !== undefined && (
            <div style={{ position: "absolute", top: 4, bottom: 4, left: LW + x(cursor), width: CW, background: "var(--subtle)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)" }} />
          )}
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", height: RH, position: "relative", opacity: r.squashed ? 0.45 : 1 }}>
              <div title={r.text} style={{ ...label, paddingLeft: 8, textDecoration: r.squashed ? "line-through" : undefined, color: r.squashed ? "var(--muted)" : "var(--fg)" }}>{r.text}</div>
              <div style={{ position: "relative", width: n * CW }}>
                {r.cells.map((c, k) => (
                  <div key={k} style={{ position: "absolute", left: x(c.cycle) + 1, top: 2, width: CW - 2, height: RH - 4, display: "grid", placeItems: "center" }}>
                    {c.stage === "stall" ? (
                      <span title="stall (bubble)" style={{ width: 11, height: 11, borderRadius: "50%", border: "1.5px dashed var(--muted)" }} />
                    ) : (
                      <span style={{
                        width: "100%", height: "100%", display: "grid", placeItems: "center", borderRadius: 3, fontSize: 10, ...mono, fontWeight: 600,
                        background: tint(STAGE_COLOR[c.stage], r.squashed ? 12 : 30), color: "var(--fg)", boxShadow: `inset 0 -2px 0 ${STAGE_COLOR[c.stage]}`,
                      }}>{c.stage}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {fw.length > 0 && (
            <svg width={n * CW} height={HEAD + rows.length * RH + 4} style={{ position: "absolute", left: LW, top: 0, pointerEvents: "none", zIndex: 1 }} aria-hidden>
              {fw.map((f, i) => {
                const y = (row: number) => 4 + HEAD + row * RH + RH / 2;
                const x1 = x(f.cycle) - 4, y1 = y(rowOf.get(f.src)!), x2 = x(f.cycle) + 5, y2 = y(rowOf.get(f.seq)!);
                return (
                  <g key={i} stroke="var(--fg)" fill="var(--fg)">
                    <path d={`M${x1} ${y1 + 4} C${x1 + 6} ${(y1 + y2) / 2}, ${x2 - 6} ${(y1 + y2) / 2}, ${x2} ${y2 - 4}`} fill="none" strokeWidth={1.3} />
                    <circle cx={x2} cy={y2 - 4} r={2} stroke="none" />
                    <title>{`${f.from} → ${f.to}: ${REG_ABI[f.reg]}`}</title>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>
      {legend && (
        <Legend items={[
          ...(["IF", "ID", "EX", "MEM", "WB"] as Stage[]).map((s) => ({ label: s, color: STAGE_COLOR[s] })),
          { label: "stall (bubble)", color: "var(--muted)" },
          ...(result.flushes ? [{ label: "squashed (dimmed)", color: "var(--faint)" }] : []),
          ...(fw.length ? [{ label: "forwarding", color: "var(--fg)" }] : []),
        ]} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- assembly listing

const codePart = (line: string) => {
  const m = /^(.*?)(\s*(?:#|\/\/).*)?$/.exec(line)!;
  return { code: m[1]!.replace(/^\s*([A-Za-z_.$][\w.$]*:\s*)+/, "").trim(), comment: (m[2] ?? "").trim() };
};

/**
 * One row per instruction word: address, machine word in hex, source line (a pseudo-instruction's extra words show
 * their real instruction). Labels get a row of their own. The row at `pc` is highlighted; `marks` adds a note by address.
 */
export function AsmListing({ program, pc, marks, maxHeight = 320 }: { program: Program; pc?: number; marks?: Record<number, ReactNode>; maxHeight?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const cur = useRef<HTMLDivElement>(null);
  const labels = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const [name, a] of Object.entries(program.labels)) if (a >= program.textBase && a < program.textBase + 4 * program.words.length) m.set(a, [...(m.get(a) ?? []), name]);
    return m;
  }, [program]);
  const names = useMemo(() => new Map([...labels].map(([a, n]) => [a, n[0]!] as const)), [labels]);
  useLayoutEffect(() => {
    const b = box.current, c = cur.current;
    if (!b || !c) return;
    const top = c.offsetTop; // the box is position: relative, so this is relative to it
    if (top < b.scrollTop + 20 || top > b.scrollTop + b.clientHeight - 40) b.scrollTop = Math.max(0, top - b.clientHeight / 3);
  }, [pc]);
  const cell: CSSProperties = { whiteSpace: "pre", padding: "1px 0" };
  return (
    <div ref={box} style={{ maxHeight, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: 1.5, position: "relative" }}>
      <div style={{ minWidth: "max-content", padding: "4px 0" }}>
        {program.words.map((w, i) => {
          const addr = program.textBase + 4 * i;
          const first = i === 0 || program.src[i - 1] !== program.src[i];
          const src = codePart(program.lines[program.src[i]! - 1] ?? "");
          const on = addr === pc;
          return (
            <div key={i}>
              {labels.get(addr)?.map((l) => <div key={l} style={{ padding: "2px 10px 0", color: "var(--muted)" }}>{l}:</div>)}
              <div ref={on ? cur : undefined} style={{ display: "flex", gap: 12, padding: "0 10px", background: on ? tint("var(--c1)", 22) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined }}>
                <span style={{ ...cell, color: "var(--muted)" }}>{hex(addr, 4)}</span>
                <span style={{ ...cell, color: "var(--faint)" }}>{hex(w)}</span>
                <span style={{ ...cell, color: first ? "var(--fg)" : "var(--muted)" }}>
                  {first ? src.code : `  ↳ ${disasm(program.insts[i]!, addr, { symbol: (a) => names.get(a) })}`}
                  {first && src.comment && <span style={{ color: "var(--faint)" }}>{"  "}{src.comment}</span>}
                </span>
                {marks?.[addr] !== undefined && <span style={{ ...cell, marginLeft: "auto", color: "var(--c2)" }}>{marks[addr]}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- register file

/**
 * The 32 registers in a compact grid, with ABI names. `changed` registers are highlighted. "used" shows only the
 * registers that are not zero or that changed. A button switches between hex and signed decimal.
 */
export function RegFile({ regs, changed = [], show = "all" }: { regs: ArrayLike<number>; changed?: number[]; show?: "all" | "used" }) {
  const [asHex, setHex] = useState(false);
  const list = Array.from({ length: 32 }, (_, r) => r).filter((r) => show === "all" || regs[r] !== 0 || changed.includes(r));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, gap: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Registers{show === "used" ? " (non-zero or changed)" : ""}</span>
        <Btn ghost onClick={() => setHex((h) => !h)}>{asHex ? "Show decimal" : "Show hex"}</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: 3 }}>
        {list.map((r) => {
          const v = regs[r]! | 0, on = changed.includes(r);
          return (
            <div key={r} style={{ display: "flex", justifyContent: "space-between", gap: 6, padding: "2px 6px", borderRadius: 4, fontSize: 12, ...mono, background: on ? tint("var(--c2)", 30) : "var(--subtle)", boxShadow: on ? "inset 0 0 0 1px var(--c2)" : undefined }}>
              <span style={{ color: "var(--muted)" }} title={`x${r}`}>{REG_ABI[r]}</span>
              <span style={{ color: v === 0 && !on ? "var(--faint)" : "var(--fg)" }}>{asHex ? hex(v) : v}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bit fields

export const FIELD_COLOR: Record<FieldKind, string> = { opcode: "var(--c1)", funct: "var(--c5)", reg: "var(--c3)", imm: "var(--c2)" };
const BW = 17;

/** The 32 bits of a word as a strip, grouped and colored by field, with each field's name and value under it. */
export function BitFields({ word, caption }: { word: number; caption?: ReactNode }) {
  const fs = fields(word);
  const col = (bit: number) => 32 - bit; // grid column of a bit (bit 31 is column 1)
  const val = (f: (typeof fs)[number]) => (f.kind === "reg" ? `x${f.value} ${REG_ABI[f.value]}` : f.kind === "imm" ? String(f.value) : `0x${f.value.toString(16)}`);
  return (
    <div>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(32, ${BW}px)`, width: 32 * BW, fontFamily: MONO, rowGap: 2 }}>
          {fs.map((f) => (
            <div key={`h${f.lo}`} className="muted" style={{ gridColumn: `${col(f.hi)} / ${col(f.lo) + 1}`, gridRow: 1, display: "flex", justifyContent: "space-between", fontSize: 9.5, padding: "0 2px" }}>
              <span>{f.hi}</span>{f.hi !== f.lo && <span>{f.lo}</span>}
            </div>
          ))}
          {Array.from({ length: 32 }, (_, i) => {
            const bit = 31 - i, f = fs.find((x) => bit <= x.hi && bit >= x.lo)!;
            return (
              <div key={i} style={{
                gridColumn: i + 1, gridRow: 2, height: 22, display: "grid", placeItems: "center", fontSize: 12,
                background: tint(FIELD_COLOR[f.kind], 26), borderLeft: bit === f.hi ? `2px solid ${FIELD_COLOR[f.kind]}` : "1px solid var(--bg)",
              }}>{(word >>> bit) & 1}</div>
            );
          })}
          {fs.map((f) => (
            <div key={`n${f.lo}`} style={{ gridColumn: `${col(f.hi)} / ${col(f.lo) + 1}`, gridRow: 3, textAlign: "center", fontSize: 10.5, lineHeight: 1.3, overflow: "hidden", padding: "1px 1px 0" }}>
              <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={f.name}>{f.name}</div>
              <div style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{val(f)}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 6, ...mono }}>
        <span className="muted">0x{hex(word)}</span>{"  "}{caption ?? (decode(word) ? disasm(word) : "not an RV32IM instruction")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- editor

/** A monospace text area for assembly, with the assembler's errors listed under it. */
export function AsmEditor({ value, onChange, errors = [], rows = 14 }: { value: string; onChange: (v: string) => void; errors?: AsmError[]; rows?: number }) {
  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="RISC-V assembly"
        style={{
          width: "100%", boxSizing: "border-box", fontFamily: MONO, fontSize: 12.5, lineHeight: 1.5, padding: "6px 8px", resize: "vertical",
          background: "var(--bg)", color: "var(--fg)", border: `1px solid ${errors.length ? "var(--c4)" : "var(--border)"}`, borderRadius: 6, tabSize: 8, whiteSpace: "pre",
        }}
      />
      {errors.length > 0 && (
        <div style={{ fontSize: 12.5, marginTop: 4, ...mono }}>
          {errors.slice(0, 8).map((e, i) => <div key={i} style={{ color: "var(--c4)" }}>line {e.line}: {e.message}</div>)}
          {errors.length > 8 && <div className="muted">and {errors.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}
