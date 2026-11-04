import { createContext, useContext, useMemo, type ReactNode } from "react";
import { scaleLinear, scaleLog, type ScaleContinuousNumeric } from "d3-scale";
import { line as d3line, area as d3area, curveLinear } from "d3-shape";
import { useWidth } from "./useSize";

type Scale = ScaleContinuousNumeric<number, number>;
interface Ctx { x: Scale; y: Scale; w: number; h: number }
const PlotCtx = createContext<Ctx | null>(null);

export function usePlot(): Ctx {
  const c = useContext(PlotCtx);
  if (!c) throw new Error("Plot primitives must be inside <Plot>");
  return c;
}

const BASE_M = { t: 10, r: 14, b: 34, l: 48 };

export interface PlotProps {
  x: [number, number];
  y: [number, number];
  height?: number;
  xLabel?: string;
  yLabel?: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  logX?: boolean;
  logY?: boolean;
  ticks?: number;
  /** Explicit tick values (override automatic ticks). */
  xTicks?: number[];
  yTicks?: number[];
  /** Lock aspect so 1 unit in x equals 1 unit in y (for geometry / loss surfaces). */
  equal?: boolean;
  grid?: boolean;
  children: ReactNode;
}

/** SVG chart with axes. Children are drawn in data coordinates via the primitives below. */
export function Plot({ x, y, height = 260, xLabel, yLabel, xFormat, yFormat, logX, logY, ticks = 6, xTicks, yTicks, equal, grid = true, children }: PlotProps) {
  const M = { ...BASE_M, t: yLabel ? 24 : BASE_M.t };
  const [ref, width] = useWidth<HTMLDivElement>();
  const iw = Math.max(10, width - M.l - M.r);
  const ih = equal ? (iw * (y[1] - y[0])) / (x[1] - x[0]) : height - M.t - M.b;
  const ctx = useMemo<Ctx>(() => {
    const xs = (logX ? scaleLog() : scaleLinear()).domain(x).range([0, iw]);
    const ys = (logY ? scaleLog() : scaleLinear()).domain(y).range([ih, 0]);
    return { x: xs, y: ys, w: iw, h: ih };
  }, [x[0], x[1], y[0], y[1], iw, ih, logX, logY]); // eslint-disable-line react-hooks/exhaustive-deps

  const xt = xTicks ?? ctx.x.ticks(Math.max(2, Math.round((ticks * iw) / 600)));
  const yt = yTicks ?? ctx.y.ticks(Math.max(2, Math.round((ticks * ih) / 260)));
  const fx = xFormat ?? ctx.x.tickFormat(xt.length);
  const fy = yFormat ?? ctx.y.tickFormat(yt.length);

  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg className="plot" width={width} height={ih + M.t + M.b} style={{ display: "block", overflow: "visible" }}>
        <defs>
          <clipPath id={`clip-${iw}-${ih}`}>
            <rect width={iw} height={ih} />
          </clipPath>
        </defs>
        <g transform={`translate(${M.l},${M.t})`}>
          {grid && (
            <g className="grid">
              {yt.map((t) => <line key={t} x1={0} x2={iw} y1={ctx.y(t)} y2={ctx.y(t)} />)}
            </g>
          )}
          <g className="axis">
            <line x1={0} x2={iw} y1={ih} y2={ih} />
            {xt.map((t) => (
              <g key={t} transform={`translate(${ctx.x(t)},${ih})`}>
                <line y2={4} />
                <text y={16} textAnchor="middle">{fx(t)}</text>
              </g>
            ))}
            {yt.map((t) => (
              <text key={t} x={-8} y={ctx.y(t)} dy="0.32em" textAnchor="end">{fy(t)}</text>
            ))}
            {xLabel && <text x={iw} y={ih + 30} textAnchor="end">{xLabel}</text>}
            {yLabel && <text x={-M.l + 2} y={-14} textAnchor="start" dy="0.32em">{yLabel}</text>}
          </g>
          <PlotCtx.Provider value={ctx}>
            <g clipPath={`url(#clip-${iw}-${ih})`}>{children}</g>
          </PlotCtx.Provider>
        </g>
      </svg>
    </div>
  );
}

type Pt = readonly [number, number];

export function Line({ points, color = "var(--c1)", width = 2, dash }: { points: readonly Pt[]; color?: string; width?: number; dash?: string }) {
  const { x, y } = usePlot();
  const d = d3line<Pt>().x((p) => x(p[0])).y((p) => y(p[1])).defined((p) => Number.isFinite(p[1])).curve(curveLinear)(points as Pt[]);
  return <path d={d ?? ""} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinejoin="round" />;
}

export function Area({ points, color = "var(--c1)", opacity = 0.12, base = 0 }: { points: readonly Pt[]; color?: string; opacity?: number; base?: number }) {
  const { x, y } = usePlot();
  const d = d3area<Pt>().x((p) => x(p[0])).y0(y(base)).y1((p) => y(p[1]))(points as Pt[]);
  return <path d={d ?? ""} fill={color} opacity={opacity} />;
}

export function Bars({ bins, color = "var(--c1)", opacity = 0.75 }: { bins: readonly { x0: number; x1: number; y: number }[]; color?: string; opacity?: number }) {
  const { x, y } = usePlot();
  return (
    <g fill={color} opacity={opacity}>
      {bins.map((b, i) => {
        const x0 = x(b.x0), x1 = x(b.x1);
        return <rect key={i} x={x0 + 0.5} width={Math.max(0, x1 - x0 - 1)} y={y(b.y)} height={Math.max(0, y(0) - y(b.y))} />;
      })}
    </g>
  );
}

export function Dots({ points, color = "var(--c1)", r = 3 }: { points: readonly Pt[]; color?: string; r?: number }) {
  const { x, y } = usePlot();
  return <g fill={color}>{points.map((p, i) => <circle key={i} cx={x(p[0])} cy={y(p[1])} r={r} />)}</g>;
}

export function RuleX({ at, color = "var(--faint)", label, dash = "4 3" }: { at: number; color?: string; label?: string; dash?: string }) {
  const { x, h } = usePlot();
  return (
    <g>
      <line x1={x(at)} x2={x(at)} y1={0} y2={h} stroke={color} strokeDasharray={dash} />
      {label && <text x={x(at) + 4} y={10} style={{ fill: color }}>{label}</text>}
    </g>
  );
}

export function RuleY({ at, color = "var(--faint)", label, dash = "4 3" }: { at: number; color?: string; label?: string; dash?: string }) {
  const { y, w } = usePlot();
  return (
    <g>
      <line x1={0} x2={w} y1={y(at)} y2={y(at)} stroke={color} strokeDasharray={dash} />
      {label && <text x={w - 4} y={y(at) - 4} textAnchor="end" style={{ fill: color }}>{label}</text>}
    </g>
  );
}

export function Label({ at, children, color = "var(--muted)", anchor = "start" }: { at: Pt; children: ReactNode; color?: string; anchor?: "start" | "middle" | "end" }) {
  const { x, y } = usePlot();
  return <text x={x(at[0])} y={y(at[1])} textAnchor={anchor} style={{ fill: color }}>{children}</text>;
}

export function Legend({ items, box }: { items: { label: string; color: string }[]; box?: boolean }) {
  return (
    <div className={`legend${box ? " box" : ""}`}>
      {items.map((i) => <span key={i.label} style={{ ["--swatch" as string]: i.color }}>{i.label}</span>)}
    </div>
  );
}
