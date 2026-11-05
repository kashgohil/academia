/** Small shared pieces for the Processes and threads demos. */
import type { ReactNode } from "react";





/** The text that explains the current step. It reserves height so that the demo does not jump. */
export const Msg = ({ children, warn, min = 40 }: { children: ReactNode; warn?: boolean; min?: number }) => (
  <p style={{ fontSize: 13, margin: "0 0 10px", minHeight: min, color: warn ? "var(--c4)" : "var(--fg)" }}>{children}</p>
);



/** Bytes with binary units up to PiB. */
export function bigBytes(v: number): string {
  const units: [number, string][] = [[2 ** 50, "PiB"], [2 ** 40, "TiB"], [2 ** 30, "GiB"], [2 ** 20, "MiB"], [2 ** 10, "KiB"]];
  for (const [f, u] of units) if (v >= f) return `${+(v / f).toPrecision(3)} ${u}`;
  return `${v} B`;
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
