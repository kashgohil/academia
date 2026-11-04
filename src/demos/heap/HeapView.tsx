import { useState } from "react";
import { Canvas2D, cssVar, Legend } from "../../kit";
import { REGION, type Region } from "../../wasm/heapsim";

export const KIND_STYLE: Record<number, { label: string; color: string }> = {
  [REGION.live]: { label: "live payload", color: "--c1" },
  [REGION.meta]: { label: "metadata", color: "--c5" },
  [REGION.pad]: { label: "alignment padding", color: "--c2" },
  [REGION.slack]: { label: "slack (allocated, unused)", color: "--c4" },
  [REGION.dead]: { label: "freed, not reclaimed", color: "--faint" },
  [REGION.free]: { label: "free", color: "--subtle" },
};

const ROW_H = 22;
const GAP = 4;
const GUTTER = 46;

const hex = (n: number) => "0x" + n.toString(16).padStart(4, "0");

export interface HeapViewProps {
  regions: Region[];
  cap: number;
  bytesPerRow?: number;
  /** Free-list order labels: (from, to) pairs. */
  links?: [number, number][];
  onPick?: (r: Region) => void;
  kinds?: number[];
}

/** Byte-accurate heap map: each row is `bytesPerRow` bytes; region boundaries are visible as gaps. */
export function HeapView({ regions, cap, bytesPerRow, links, onPick, kinds }: HeapViewProps) {
  const bpr = bytesPerRow ?? (cap <= 1024 ? 64 : cap <= 4096 ? 256 : 512);
  const rows = Math.ceil(cap / bpr);
  const [hover, setHover] = useState<Region | null>(null);

  // Free-list order: link i means "free block i is followed by i+1".
  const order = new Map<number, number>();
  links?.forEach(([from], i) => order.set(from, i + 1));
  const orderOf = (r: Region) => order.get(r.off) ?? order.get(r.off - 8);

  const at = (x: number, y: number, w: number): Region | null => {
    const row = Math.floor(y / (ROW_H + GAP));
    const col = (x - GUTTER) / (w - GUTTER);
    if (row < 0 || row >= rows || col < 0 || col >= 1) return null;
    const byte = row * bpr + Math.floor(col * bpr);
    return regions.find((r) => byte >= r.off && byte < r.off + r.len) ?? null;
  };

  const shown = kinds ?? [REGION.live, REGION.free, REGION.meta, REGION.pad, REGION.slack, REGION.dead];

  return (
    <div>
      <Canvas2D
        height={rows * (ROW_H + GAP)}
        deps={[regions, links, bpr, hover]}
        onLeave={() => setHover(null)}
        onPointer={(x, y, e) => {
          const w = (e.currentTarget as HTMLCanvasElement).clientWidth;
          const r = at(x, y, w);
          setHover(r);
          (e.currentTarget as HTMLCanvasElement).style.cursor = r && r.kind === REGION.live && onPick ? "pointer" : "default";
          if (e.type === "pointerdown" && r && onPick) onPick(r);
        }}
        draw={(ctx, w) => {
          const inner = w - GUTTER;
          const px = inner / bpr;
          const color = Object.fromEntries(Object.entries(KIND_STYLE).map(([k, v]) => [k, cssVar(v.color)]));
          const border = cssVar("--border");
          const muted = cssVar("--muted");
          ctx.font = "10.5px Inter Variable, system-ui, sans-serif";
          ctx.textBaseline = "middle";
          for (let row = 0; row < rows; row++) {
            ctx.fillStyle = muted;
            ctx.textAlign = "left";
            ctx.fillText(hex(row * bpr), 0, row * (ROW_H + GAP) + ROW_H / 2);
          }
          for (const r of regions) {
            // A region may span rows: draw one piece per row.
            let start = r.off;
            const end = r.off + r.len;
            while (start < end) {
              const row = Math.floor(start / bpr);
              const rowEnd = Math.min(end, (row + 1) * bpr);
              const x0 = GUTTER + (start - row * bpr) * px;
              const x1 = GUTTER + (rowEnd - row * bpr) * px;
              const y = row * (ROW_H + GAP);
              const gapL = start === r.off && px > 1.5 ? 1 : 0;
              ctx.fillStyle = color[r.kind] ?? border;
              ctx.globalAlpha = r.kind === REGION.slack ? 0.55 : 1;
              ctx.fillRect(x0 + gapL, y, Math.max(0.5, x1 - x0 - gapL), ROW_H);
              ctx.globalAlpha = 1;
              if (r.kind === REGION.free) {
                ctx.strokeStyle = border;
                ctx.strokeRect(x0 + gapL + 0.5, y + 0.5, Math.max(0, x1 - x0 - gapL - 1), ROW_H - 1);
              }
              if (hover && hover.off === r.off) {
                ctx.strokeStyle = cssVar("--fg");
                ctx.lineWidth = 1.5;
                ctx.strokeRect(x0 + gapL + 0.75, y + 0.75, Math.max(0, x1 - x0 - gapL - 1.5), ROW_H - 1.5);
                ctx.lineWidth = 1;
              }
              // Labels on the first piece if there's room.
              if (start === r.off) {
                const text = r.kind === REGION.live ? `#${r.id}` : r.kind === REGION.free && orderOf(r) ? String(orderOf(r)) : "";
                if (text && x1 - x0 > ctx.measureText(text).width + 6) {
                  ctx.fillStyle = r.kind === REGION.live ? cssVar("--bg") : muted;
                  ctx.textAlign = "center";
                  ctx.fillText(text, (x0 + x1) / 2, y + ROW_H / 2);
                }
              }
              start = rowEnd;
            }
          }
        }}
      />
      <div className="muted" style={{ fontSize: 12, minHeight: 18, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>
        {hover
          ? `${hex(hover.off)}–${hex(hover.off + hover.len - 1)} · ${KIND_STYLE[hover.kind]?.label}${hover.id ? ` #${hover.id}` : ""} · ${hover.len} B${hover.kind === REGION.live && onPick ? " · click to free" : ""}`
          : "Hover a region for details."}
      </div>
      <Legend box items={shown.map((k) => ({ label: KIND_STYLE[k]!.label, color: k === REGION.free ? "var(--border)" : `var(${KIND_STYLE[k]!.color})` }))} />
    </div>
  );
}
