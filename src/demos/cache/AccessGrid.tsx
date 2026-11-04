import { Canvas2D, cssVar, Legend } from "../../kit";

/** One cell per access, in program order, colored by outcome index. */
export function AccessGrid({ out, colors, labels, cell = 5, maxRows = 60 }: { out: Uint8Array | null; colors: string[]; labels: string[]; cell?: number; maxRows?: number }) {
  return (
    <div>
      <Canvas2D
        height={(w) => {
          if (!out) return 40;
          const cols = Math.max(32, Math.floor(w / cell));
          return Math.min(maxRows, Math.ceil(out.length / cols)) * cell;
        }}
        deps={[out]}
        draw={(ctx, w) => {
          if (!out) return;
          const cols = Math.max(32, Math.floor(w / cell));
          const n = Math.min(out.length, cols * maxRows);
          const palette = colors.map((c) => cssVar(c));
          for (let i = 0; i < n; i++) {
            ctx.fillStyle = palette[out[i]!]!;
            ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell - 1, cell - 1);
          }
        }}
      />
      <div style={{ marginTop: 6 }}>
        <Legend box items={labels.map((l, i) => ({ label: l, color: `var(${colors[i]})` }))} />
      </div>
    </div>
  );
}

