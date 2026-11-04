/** Small shared pieces for the Processes and threads demos. */
import type { CSSProperties, ReactNode } from "react";
import { Param, range, select } from "../../kit";

export const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

/** A light tint of a theme color. It works in both themes. */
export const tint = (c: string, pct = 16) => `color-mix(in srgb, ${c} ${pct}%, var(--bg))`;

export const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

export const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;
export const Cap = ({ children }: { children: ReactNode }) => <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{children}</div>;

/** The text that explains the current step. It reserves height so that the demo does not jump. */
export const Msg = ({ children, warn, min = 40 }: { children: ReactNode; warn?: boolean; min?: number }) => (
  <p style={{ fontSize: 13, margin: "0 0 10px", minHeight: min, color: warn ? "var(--c4)" : "var(--fg)" }}>{children}</p>
);

export function StepButtons({ k, n, set }: { k: number; n: number; set: (v: number) => void }) {
  return (
    <>
      <button className="btn" onClick={() => set(Math.max(0, k - 1))} disabled={k === 0}>Back</button>
      <button className="btn primary" onClick={() => set(Math.min(n - 1, k + 1))} disabled={k >= n - 1}>Next</button>
    </>
  );
}

export const StepSlider = ({ k, n, set, label = "Step" }: { k: number; n: number; set: (v: number) => void; label?: string }) => (
  <Param spec={range({ label, min: 0, max: n - 1, step: 1, default: 0, format: (v) => `${v + 1} of ${n}` })} value={Math.min(k, n - 1)} onChange={(v) => set(v as number)} />
);

/** Bytes with binary units up to PiB. */
export function bigBytes(v: number): string {
  const units: [number, string][] = [[2 ** 50, "PiB"], [2 ** 40, "TiB"], [2 ** 30, "GiB"], [2 ** 20, "MiB"], [2 ** 10, "KiB"]];
  for (const [f, u] of units) if (v >= f) return `${+(v / f).toPrecision(3)} ${u}`;
  return `${v} B`;
}

/** A small labelled box. */
export function Panel({ title, active, children, style }: { title?: ReactNode; active?: boolean; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: `1px solid ${active ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: "6px 8px", minWidth: 0, ...style }}>
      {title && <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 4 }}>{title}</div>}
      {children}
    </div>
  );
}

/** A mode indicator: which privilege level the CPU is in. */
export function ModeBar({ mode, userLabel, kernelLabel }: { mode: "user" | "kernel"; userLabel: string; kernelLabel: string }) {
  const item = (on: boolean, label: string, c: string) => (
    <div style={{ flex: 1, textAlign: "center", padding: "3px 4px", fontSize: 12, background: on ? c : "var(--bg)", color: on ? "var(--bg)" : "var(--muted)", transition: "background 0.2s" }}>{label}</div>
  );
  return (
    <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
      {item(mode === "user", userLabel, "var(--c3)")}
      {item(mode === "kernel", kernelLabel, "var(--c5)")}
    </div>
  );
}
