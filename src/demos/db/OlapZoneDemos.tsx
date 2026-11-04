/** Demos for "Zone maps and data skipping": a block map with pruning, and blocks scanned vs predicate width. */
import { useMemo, useState } from "react";
import { Demo, Stats, Param, Legend, range, toggle, Plot, Line, RuleX, Canvas2D, cssVar } from "../../kit";
import {
  buildLayouts, prune, avgScanned, DOMAIN, BLOCK_ROWS, ZONE_ROWS, ZLAYOUTS,
  type ZLayout, type Pred, type PredOn,
} from "../../sims/db/olap";
import { seg, Note, Caption, int, fx } from "./OlapShared";

const LAYOUT_LABEL: [ZLayout, string][] = [["unsorted", "unsorted"], ["a", "sorted by A"], ["z", "Z-order (A, B)"]];
type Mode = PredOn | "point";

function alpha(color: string, a: number) {
  // Works for #rgb / #rrggbb tokens; other color syntaxes fall back to globalAlpha.
  if (/^#[0-9a-f]{6}$/i.test(color)) return color + Math.round(a * 255).toString(16).padStart(2, "0");
  return color;
}

export function ZoneMapDemo() {
  const [lo, setLo] = useState(400);
  const [widthPct, setWidthPct] = useState(10);
  const [mode, setMode] = useState<Mode>("a");
  const [layout, setLayout] = useState<ZLayout>("a");
  const [bloom, setBloom] = useState(false);
  const data = useMemo(() => buildLayouts(21, true), []);
  const d = data[layout];
  const w = Math.max(1, Math.round((widthPct / 100) * DOMAIN));
  const start = Math.min(lo, DOMAIN - (mode === "point" ? 1 : w));
  const r: [number, number] = mode === "point" ? [start, start] : [start, start + w - 1];
  const pred: Pred = mode === "a" ? { a: r } : mode === "b" || mode === "point" ? { b: r } : { a: r, b: r };
  const res = useMemo(() => prune(d.rows, d.zones, pred, bloom && mode === "point"), [d, pred.a?.[0], pred.a?.[1], pred.b?.[0], pred.b?.[1], bloom, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const draw = (ctx: CanvasRenderingContext2D, W: number, H: number) => {
    const side = Math.min(W, H);
    const ox = (W - side) / 2;
    const sx = (v: number) => ox + (v / DOMAIN) * side;
    const sy = (v: number) => side - (v / DOMAIN) * side;
    const c1 = cssVar("--c1") || "#36c", c3 = cssVar("--c3") || "#393", c4 = cssVar("--c4") || "#c33", faint = cssVar("--faint") || "#bbb", border = cssVar("--border") || "#ddd";
    ctx.strokeStyle = border;
    ctx.strokeRect(ox + 0.5, 0.5, side - 1, side - 1);
    // predicate region
    const pa = pred.a ?? [0, DOMAIN - 1], pb = pred.b ?? [0, DOMAIN - 1];
    ctx.fillStyle = alpha(c4, 0.12);
    ctx.fillRect(sx(pa[0]), sy(pb[1] + 1), Math.max(1.5, sx(pa[1] + 1) - sx(pa[0])), Math.max(1.5, sy(pb[0]) - sy(pb[1] + 1)));
    // rows
    for (const row of d.rows) {
      const m = (!pred.a || (row.a >= pred.a[0] && row.a <= pred.a[1])) && (!pred.b || (row.b >= pred.b[0] && row.b <= pred.b[1]));
      ctx.fillStyle = m ? c3 : faint;
      const s = m ? 3 : 1.6;
      ctx.fillRect(sx(row.a) - s / 2, sy(row.b) - s / 2, s, s);
    }
    // zone boxes
    d.zones.forEach((z, i) => {
      const x0 = sx(z.minA), x1 = sx(z.maxA + 1), y0 = sy(z.maxB + 1), y1 = sy(z.minB);
      if (res.scan[i]) {
        ctx.fillStyle = alpha(c1, 0.07);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeStyle = c1;
        ctx.lineWidth = 1.2;
      } else {
        ctx.strokeStyle = border;
        ctx.lineWidth = 0.8;
      }
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = c4;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(sx(pa[0]), sy(pb[1] + 1), Math.max(1.5, sx(pa[1] + 1) - sx(pa[0])), Math.max(1.5, sy(pb[0]) - sy(pb[1] + 1)));
    ctx.setLineDash([]);
  };
  const predText = mode === "point" ? `B = ${r[0]}` : mode === "a" ? `A BETWEEN ${r[0]} AND ${r[1]}` : mode === "b" ? `B BETWEEN ${r[0]} AND ${r[1]}` : `A and B BETWEEN ${r[0]} AND ${r[1]}`;
  return (
    <Demo
      title="Zone maps: min and max per block"
      controls={
        <>
          <Param spec={range({ label: "Predicate starts at", min: 0, max: DOMAIN - 1, step: 1, default: 400 })} value={lo} onChange={(v) => setLo(v as number)} />
          <Param spec={range({ label: "Predicate width (% of the domain)", min: 1, max: 100, step: 1, default: 10 })} value={widthPct} onChange={(v) => setWidthPct(v as number)} />
          <Param spec={seg<Mode>("Predicate on", [["a", "A"], ["b", "B"], ["ab", "A and B"], ["point", "B = value"]], "a")} value={mode} onChange={(v) => setMode(v as Mode)} />
          <Param spec={seg<ZLayout>("Rows stored", LAYOUT_LABEL, "a")} value={layout} onChange={(v) => setLayout(v as ZLayout)} />
          {mode === "point" && <Param spec={toggle({ label: "Bloom filter per block (10 bits per value)", default: false })} value={bloom} onChange={(v) => setBloom(v as boolean)} />}
        </>
      }
    >
      <div style={{ fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ fontFamily: "ui-monospace, monospace" }}>WHERE {predText}</span>
        <span className="muted"> · {int(ZONE_ROWS)} rows, {BLOCK_ROWS} rows per block</span>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>Each row is a dot at (A, B). Each box is the zone map of one block: [min A, max A] × [min B, max B].</div>
      <Canvas2D height={(W) => Math.min(W, 360)} draw={draw} deps={[d, res, layout, mode, r[0], r[1]]} />
      <Caption>The {d.zones.length} blocks in file order</Caption>
      <svg viewBox={`0 0 ${16 * 14} ${Math.ceil(d.zones.length / 16) * 14}`} style={{ width: "100%", maxWidth: 420, display: "block" }}>
        {d.zones.map((_, i) => {
          const x = (i % 16) * 14, y = Math.floor(i / 16) * 14;
          const sc = res.scan[i];
          return (
            <g key={i}>
              <rect x={x + 1} y={y + 1} width={12} height={12} rx={2} fill={sc ? "var(--c1)" : "var(--subtle)"} stroke="var(--border)" strokeWidth={0.6} />
            </g>
          );
        })}
      </svg>
      <Stats
        items={[
          { label: "blocks scanned", value: `${res.scanned} of ${res.blocks}` },
          { label: "blocks that hold a match", value: res.needed },
          { label: "rows scanned", value: int(res.rowsScanned) },
          { label: "matching rows", value: int(res.matches) },
          { label: "matches in skipped blocks", value: res.lost },
        ]}
      />
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: "block scanned", color: "var(--c1)" }, { label: "matching row", color: "var(--c3)" }, { label: "predicate", color: "var(--c4)" }]} />
      </div>
    </Demo>
  );
}

const WIDTHS = Array.from({ length: 41 }, (_, i) => Math.max(0.005, i / 40));

export function PruningSweepDemo() {
  const [on, setOn] = useState<PredOn>("a");
  const [wPct, setWPct] = useState(10);
  const data = useMemo(() => buildLayouts(21, false), []);
  const series = useMemo(
    () => Object.fromEntries(ZLAYOUTS.map((l) => [l, WIDTHS.map((w) => [w * 100, avgScanned(data[l].zones, on, w)] as [number, number])])) as Record<ZLayout, [number, number][]>,
    [data, on],
  );
  const at = (l: ZLayout) => avgScanned(data[l].zones, on, wPct / 100);
  const colors: Record<ZLayout, string> = { unsorted: "var(--c2)", a: "var(--c1)", z: "var(--c3)" };
  return (
    <Demo
      title="Blocks scanned as the predicate gets wider"
      controls={
        <>
          <Param spec={range({ label: "Predicate width (%)", min: 1, max: 100, step: 1, default: 10 })} value={wPct} onChange={(v) => setWPct(v as number)} />
          <Param spec={seg<PredOn>("Predicate on", [["a", "A"], ["b", "B"], ["ab", "A and B"]], "a")} value={on} onChange={(v) => setOn(v as PredOn)} />
        </>
      }
    >
      <Plot x={[0, 100]} y={[0, 66]} height={250} xLabel="predicate width, % of the domain" yLabel="blocks scanned (of 64)" yTicks={[0, 8, 16, 32, 48, 64]}>
        {ZLAYOUTS.map((l) => <Line key={l} points={series[l]} color={colors[l]} />)}
        <RuleX at={wPct} />
      </Plot>
      <Legend items={LAYOUT_LABEL.map(([l, label]) => ({ label, color: colors[l] }))} />
      <Stats items={LAYOUT_LABEL.map(([l, label]) => ({ label: `${label}, ${wPct}% wide`, value: fx(at(l), 1) }))} />
      <Note>Each point is the average over 32 positions of the predicate. With "A and B", both columns get a range of the same width.</Note>
    </Demo>
  );
}
