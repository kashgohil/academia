/** Small views that the linking demos share: a code box and a clickable hex dump. */
import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { MONO, mono, tint, useWidth } from "../../kit";

export const hx = (n: number) => (n < 0 ? `-0x${(-n).toString(16)}` : `0x${n.toString(16)}`);

/** Monospace text that scrolls inside its own box on a narrow screen. */
export function CodeBox({ children, maxHeight, style }: { children: ReactNode; maxHeight?: number; style?: CSSProperties }) {
  return (
    <pre style={{ ...mono, fontSize: 12, lineHeight: 1.45, margin: 0, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--subtle)", overflow: "auto", maxHeight, whiteSpace: "pre", ...style }}>
      {children}
    </pre>
  );
}

/**
 * A hex dump. `color(o)` gives a byte its color or null; `strong(o)` marks the selected bytes. Clicking a byte
 * calls onPick with its offset. `focus` scrolls that offset into view.
 */
export function HexView({ bytes, color, strong, onPick, focus, height = 220, base = 0 }: {
  bytes: Uint8Array; color: (o: number) => string | null; strong: (o: number) => boolean; onPick?: (o: number) => void; focus?: number | null; height?: number; base?: number;
}) {
  const [wrapRef, w] = useWidth<HTMLDivElement>();
  const perRow = w >= 520 ? 16 : 8;
  const cell = Math.max(19, Math.floor((w - 56) / perRow));
  const box = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => Array.from({ length: Math.ceil(bytes.length / perRow) }, (_, i) => i * perRow), [bytes.length, perRow]);
  useEffect(() => {
    if (focus == null || !box.current) return;
    box.current.scrollTop = Math.max(0, Math.floor(focus / perRow) * 17 - 34);
  }, [focus, perRow]);
  return (
    <div ref={wrapRef} style={{ minWidth: 0 }}>
      <div
        ref={box}
        onClick={(e) => { const o = (e.target as HTMLElement).dataset.o; if (o !== undefined) onPick?.(Number(o)); }}
        style={{ fontFamily: MONO, fontSize: 11, lineHeight: "17px", height, overflowY: "auto", overflowX: "hidden", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px", whiteSpace: "nowrap" }}
      >
        {rows.map((r) => (
          <div key={r}>
            <span style={{ color: "var(--faint)", marginRight: 6 }}>{(base + r).toString(16).padStart(4, "0")}</span>
            {Array.from({ length: Math.min(perRow, bytes.length - r) }, (_, i) => {
              const o = r + i;
              const c = color(o);
              const on = strong(o);
              return (
                <span key={o} data-o={o} style={{
                  display: "inline-block", width: cell, textAlign: "center", cursor: onPick ? "pointer" : "default",
                  background: on ? (c ?? "var(--fg)") : c ? tint(c, 18) : "transparent", color: on ? "var(--bg)" : c ? "var(--fg)" : "var(--faint)",
                }}>{bytes[o]!.toString(16).padStart(2, "0")}</span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A clickable row in a compact list. */
export function PickRow({ on, onClick, children, color }: { on: boolean; onClick: () => void; children: ReactNode; color?: string }) {
  return (
    <div onClick={onClick} style={{ ...mono, fontSize: 11.5, padding: "2px 6px", cursor: "pointer", whiteSpace: "nowrap", borderLeft: `3px solid ${color ?? "transparent"}`, background: on ? tint(color ?? "var(--fg)", 22) : undefined, borderRadius: 2 }}>
      {children}
    </div>
  );
}
