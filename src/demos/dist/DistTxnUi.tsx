/** Views that the distributed-transactions demos share: log records, node cards and run diagrams. */
import type { ReactNode } from "react";
import { Chip, Panel, tint } from "../../kit";
import type { Message } from "../../sims/dist/net";
import type { StMark, StMessage } from "./SpaceTime";

/** A color per outcome or state, so that every demo of the module reads the same way. */
export const STATE_COLOR: Record<string, string> = {
  working: "var(--muted)", init: "var(--muted)", idle: "var(--muted)", collecting: "var(--c1)",
  prepared: "var(--c2)", uncertain: "var(--c2)", precommitted: "var(--c5)", readonly: "var(--muted)",
  committed: "var(--c3)", aborted: "var(--c4)", done: "var(--c3)", down: "var(--c4)",
};

export const stateColor = (s: string) => STATE_COLOR[s] ?? "var(--fg)";

/** One durable log: forced records are solid; unforced ones, which a crash loses, are dashed. */
export function LogStrip({ log, buffer = [], empty = "empty" }: { log: { rec: string; forced: boolean }[]; buffer?: { rec: string }[]; empty?: string }) {
  if (!log.length && !buffer.length) return <span className="muted" style={{ fontSize: 12 }}>{empty}</span>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
      {log.map((r, i) => <Chip key={`l${i}`} color={stateColor(r.rec === "commit" ? "committed" : r.rec === "abort" ? "aborted" : r.rec === "prepared" ? "prepared" : "done")} bold={r.forced} title={r.forced ? "forced to disk" : "written with a later force"}>{r.rec}</Chip>)}
      {buffer.map((r, i) => <Chip key={`b${i}`} dashed faint color="var(--muted)" title="in memory: a crash loses it">{r.rec}</Chip>)}
    </div>
  );
}

/** A node's card: its name, its state chip, and what it holds. */
export function NodeCard({ name, state, up, children, actions }: { name: string; state: string; up: boolean; children?: ReactNode; actions?: ReactNode }) {
  const c = up ? stateColor(state) : "var(--c4)";
  return (
    <Panel accent={c} style={{ background: up ? undefined : tint("var(--c4)", 8) }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <b style={{ fontSize: 13 }}>{name}</b>
        <Chip color={c} filled={up && state !== "working" && state !== "init"}>{up ? state : "down"}</Chip>
      </div>
      <div style={{ marginTop: 6, display: "grid", gap: 5, fontSize: 12.5 }}>{children}</div>
      {actions && <div style={{ marginTop: 6 }}>{actions}</div>}
    </Panel>
  );
}

/** Messages of a Net run for SpaceTime. Held messages (hold mode) end at `now` as dashed arrows: still in flight. */
export function stMessages<P>(msgs: Message<P>[], label: (m: Message<P>) => string, now: number, held = new Set<number>(), color?: (m: Message<P>) => string | undefined): StMessage[] {
  return msgs.map((m) => {
    const inFlight = held.has(m.id);
    return {
      from: m.from, to: m.to, sentAt: m.sentAt,
      deliveredAt: inFlight ? Math.max(now, m.sentAt + 1) : m.deliveredAt,
      lostAt: m.lost && m.lost !== "dropped" ? m.lostAt : undefined,
      label: label(m), dashed: inFlight, color: inFlight ? "var(--muted)" : color?.(m),
    };
  });
}

/** Crash crosses and recovery dots from a Net trace. */
export function crashMarks(trace: { kind: string; t: number; node?: number }[]): StMark[] {
  return trace.flatMap((e) =>
    e.kind === "crash" ? [{ node: e.node!, t: e.t, shape: "cross" as const, label: "crash", color: "var(--c4)" }]
      : e.kind === "recover" ? [{ node: e.node!, t: e.t, label: "recover", color: "var(--c1)" }] : []);
}
