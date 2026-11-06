/** Views that the Replication demos share: a row of log entries, and spans of down time for the space-time diagram. */
import type { ReactNode } from "react";
import { Chip } from "../../kit";
import type { Net } from "../../sims/dist/net";
import type { StMark } from "./SpaceTime";

/** A labelled row of chips, one per log entry or value. */
export function LogRow({ label, children, accent }: { label: ReactNode; children: ReactNode; accent?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minHeight: 22 }}>
      <span style={{ width: 62, flex: "none", fontSize: 12, color: accent ?? "var(--muted)", fontWeight: 600, paddingTop: 1 }}>{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** One log entry. */
export const Entry = ({ i, color, filled, dashed, faint, strike, title }: { i: ReactNode; color?: string; filled?: boolean; dashed?: boolean; faint?: boolean; strike?: boolean; title?: string }) => (
  <Chip color={color} filled={filled} dashed={dashed} faint={faint} strike={strike} title={title}>{i}</Chip>
);

/** Bars for the time each node was down, from the crash and recover events of a run. */
export function downBars<P>(net: Net<P>, tEnd: number, label = "down"): StMark[] {
  const open = new Map<number, number>();
  const out: StMark[] = [];
  for (const e of net.trace) {
    if (e.kind === "crash") open.set(e.node, e.t);
    if (e.kind === "recover" && open.has(e.node)) {
      out.push({ node: e.node, t: open.get(e.node)!, until: e.t, shape: "bar", color: "var(--c4)", label });
      open.delete(e.node);
    }
  }
  for (const [node, t] of open) out.push({ node, t, until: tEnd, shape: "bar", color: "var(--c4)", label });
  return out;
}
