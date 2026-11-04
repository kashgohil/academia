import { useEffect, useRef } from "react";
import { useWidth } from "./useSize";

/** DPR-aware canvas that redraws when size or `deps` change. */
export function Canvas2D({
  height,
  draw,
  deps,
  onPointer,
}: {
  height: number | ((w: number) => number);
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  deps: unknown[];
  onPointer?: (x: number, y: number, e: React.PointerEvent) => void;
}) {
  const [wrap, w] = useWidth<HTMLDivElement>();
  const ref = useRef<HTMLCanvasElement>(null);
  const h = typeof height === "function" ? height(w) : height;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
  }, [w, h, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrap} style={{ width: "100%" }}>
      <canvas
        ref={ref}
        style={{ width: w, height: h, display: "block" }}
        onPointerMove={onPointer && ((e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onPointer(e.clientX - r.left, e.clientY - r.top, e);
        })}
      />
    </div>
  );
}

/** Reads a CSS custom property (for using theme colors on canvas). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
