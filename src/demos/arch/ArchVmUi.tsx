/** Views that the vm demos of the architecture track share: a strip of address bits with labelled fields. */
import type { ReactNode } from "react";
import { MONO, tint } from "../../kit";

export interface BitField { hi: number; lo: number; label: string; color: string; value?: string }

/**
 * Address bits from `hi` down to 0, one box per bit, colored by field. Bits outside every field are faint.
 * `marks` draws a vertical rule to the right of a bit, for a boundary such as the page offset.
 */
export function BitStrip({ bits, hi, fields, marks = [], cell = 17 }: { bits?: bigint | number; hi: number; fields: BitField[]; marks?: { after: number; label: string }[]; cell?: number }) {
  const v = bits === undefined ? null : BigInt(bits);
  const field = (b: number) => fields.find((f) => b <= f.hi && b >= f.lo);
  const idx = Array.from({ length: hi + 1 }, (_, i) => hi - i);
  return (
    <div style={{ overflowX: "auto", maxWidth: "100%", paddingBottom: 4 }}>
      <div style={{ display: "inline-block", minWidth: "min-content" }}>
        <div style={{ display: "flex" }}>
          {idx.map((b) => {
            const f = field(b);
            const mark = marks.find((m) => m.after === b);
            return (
              <div key={b} style={{ width: cell, flex: "0 0 auto", borderRight: mark ? "2px solid var(--fg)" : undefined, position: "relative" }}>
                {v !== null && <div style={{ height: 12, fontSize: 9, lineHeight: "12px", color: "var(--muted)", textAlign: "center", fontFamily: MONO }}>{b % 4 === 0 || b === hi ? b : ""}</div>}
                <div style={{ height: cell + 2, display: "grid", placeItems: "center", fontFamily: MONO, background: f ? tint(f.color, 30) : "var(--subtle)", borderTop: `3px solid ${f ? f.color : "var(--border)"}`, color: f ? "var(--fg)" : "var(--faint)", fontSize: v === null ? 9 : 11 }}>
                  {v === null ? b : Number((v >> BigInt(b)) & 1n)}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", marginTop: 3 }}>
          {groups(idx, field).map((g, i) => (
            <div key={i} style={{ width: g.n * cell, flex: "0 0 auto", fontSize: 10.5, lineHeight: 1.25, textAlign: "center", color: g.f ? "var(--fg)" : "var(--faint)", overflow: "hidden", padding: "0 1px" }}>
              {g.f ? <>{g.f.label}{g.f.value !== undefined && <b style={{ display: "block", fontFamily: MONO }}>{g.f.value}</b>}</> : null}
            </div>
          ))}
        </div>
        {marks.length > 0 && (
          <div style={{ display: "flex", marginTop: 2 }}>
            {idx.map((b) => {
              const m = marks.find((x) => x.after === b);
              return <div key={b} style={{ width: cell, flex: "0 0 auto", position: "relative", height: 14 }}>{m && <span style={{ position: "absolute", right: -2, whiteSpace: "nowrap", fontSize: 10, color: "var(--muted)", transform: "translateX(50%)" }}>{m.label}</span>}</div>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function groups(idx: number[], field: (b: number) => BitField | undefined) {
  const out: { f: BitField | undefined; n: number }[] = [];
  for (const b of idx) {
    const f = field(b);
    const last = out[out.length - 1];
    if (last && last.f === f) last.n++;
    else out.push({ f, n: 1 });
  }
  return out;
}

/** A small key-value grid for registers and CSRs. */
export function RegGrid({ items }: { items: { name: string; value: ReactNode; hot?: boolean; bad?: boolean }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(118px, 1fr))", gap: 4 }}>
      {items.map((r) => (
        <div key={r.name} style={{ border: `1px solid ${r.bad ? "var(--c4)" : r.hot ? "var(--fg)" : "var(--border)"}`, borderRadius: 4, padding: "2px 6px", fontFamily: MONO, fontSize: 12, display: "flex", justifyContent: "space-between", gap: 6, background: r.bad ? tint("var(--c4)", 14) : undefined }}>
          <span className="muted">{r.name}</span>
          <b style={{ overflowWrap: "anywhere" }}>{r.value}</b>
        </div>
      ))}
    </div>
  );
}
