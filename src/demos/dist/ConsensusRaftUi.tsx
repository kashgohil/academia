/** Views that the Raft demos share: a ring of servers, per-server logs, message colors, and a live cluster hook. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MONO, mono, tint, useWidth } from "../../kit";
import type { StMark, StMessage } from "./SpaceTime";
import { viewMsg, viewNode, type MsgView, type NodeView } from "../../sims/dist/consensus/raft/scenarios";
import type { RaftCluster } from "../../sims/dist/consensus/raft/raft";
import type { KvCmd } from "../../sims/dist/consensus/raft/machine";

export const sname = (i: number) => `S${i + 1}`;

/** One color per term, so that entries of one term look alike. */
export const termColor = (t: number) => (t <= 0 ? "var(--faint)" : `var(--c${((t - 1) % 5) + 1})`);

export const ROLE_COLOR = { leader: "var(--c1)", candidate: "var(--c2)", precandidate: "var(--c2)", follower: "var(--muted)" } as const;

const MSG_COLOR: Record<MsgView["type"], string> = {
  RequestVote: "var(--c2)", RequestVoteReply: "var(--c2)", AppendEntries: "var(--c1)", AppendEntriesReply: "var(--c1)",
  InstallSnapshot: "var(--c5)", InstallSnapshotReply: "var(--c5)", TimeoutNow: "var(--c3)", ClientRequest: "var(--c3)", ClientReply: "var(--c3)",
};

/** True for an empty AppendEntries or a plain reply: the background traffic of a healthy cluster. */
export const isHeartbeat = (m: MsgView) => (m.type === "AppendEntries" || m.type === "AppendEntriesReply") && m.label === "";

/** Messages for SpaceTime. Heartbeats are drawn faint and dashed, with no label. */
export function stMessages(ms: MsgView[], { heartbeats = true, rowOf = (i: number) => i }: { heartbeats?: boolean; rowOf?: (i: number) => number } = {}): StMessage[] {
  const labelled = new Set<string>();
  return ms
    .filter((m) => (heartbeats || !isHeartbeat(m)) && (m.deliveredAt !== undefined || m.lost !== undefined)) // skip messages in flight
    .map((m) => {
      const hb = isHeartbeat(m);
      const refuse = m.label === "no" || m.label === "reject" || m.label === "retry";
      // A broadcast gets one label, not one per arrow.
      const key = `${m.from}|${m.label}|${m.sentAt.toFixed(3)}`;
      const label = m.label && !labelled.has(key) ? m.label : undefined;
      if (label) labelled.add(key);
      return {
        from: rowOf(m.from), to: rowOf(m.to), sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lostAt, label,
        color: m.deliveredAt === undefined ? undefined : hb ? "var(--faint)" : refuse ? "var(--c4)" : MSG_COLOR[m.type],
        dashed: hb,
      };
    });
}

/** Role changes and crashes of a live cluster as SpaceTime marks, in [t0, t1]. */
export function stMarks(c: RaftCluster<KvCmd>, t0: number, t1: number): StMark[] {
  const out: StMark[] = [];
  for (const e of c.events) {
    if (e.t < t0 || e.t > t1) continue;
    if (e.kind === "role" && e.role === "leader") out.push({ node: e.node, t: e.t, label: `L t${e.term}`, color: ROLE_COLOR.leader });
    else if (e.kind === "role" && e.role === "candidate") out.push({ node: e.node, t: e.t, label: `t${e.term}`, color: ROLE_COLOR.candidate });
    else if (e.kind === "crash") out.push({ node: e.node, t: e.t, shape: "cross" });
    else if (e.kind === "recover") out.push({ node: e.node, t: e.t, label: "up", color: "var(--c3)" });
    else if (e.kind === "install") out.push({ node: e.node, t: e.t, label: "install", color: "var(--c5)" });
  }
  return out;
}

// ---------------------------------------------------------------- the ring

export interface RingProps {
  nodes: NodeView[];
  now: number;
  /** Pairs that can talk. Others get no link line. */
  connected: (a: number, b: number) => boolean;
  /** Election timeout range, to draw each timer as an arc. */
  maxTimeout: number;
  onNode?: (i: number) => void;
  height?: number;
  /** A short note under each live server, such as its last log index. */
  sub?: (n: NodeView) => string;
}

/** Servers on a circle. A link line joins servers that can talk; an arc shows each election timer; arrows show votes. */
export function Ring({ nodes, now, connected, maxTimeout, onNode, height = 240, sub }: RingProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const W = Math.min(w, 420), H = height, R = Math.min(W, H) / 2 - 44, cx = W / 2, cy = H / 2 + 4;
  const n = nodes.length;
  const pos = nodes.map((_, i) => [cx + R * Math.sin((2 * Math.PI * i) / n), cy - R * Math.cos((2 * Math.PI * i) / n)] as const);
  const r = 23;
  const maxTerm = Math.max(...nodes.map((x) => x.term));
  return (
    <div ref={ref} style={{ width: "100%", display: "flex", justifyContent: "center" }}>
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }} role="img" aria-label="Raft servers">
        <defs>
          <marker id="raft-vote" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--c3)" />
          </marker>
        </defs>
        {nodes.map((a, i) => nodes.map((b, j) => j > i && a.up && b.up && connected(i, j) && (
          <line key={`${i}-${j}`} x1={pos[i]![0]} y1={pos[i]![1]} x2={pos[j]![0]} y2={pos[j]![1]} stroke="var(--border)" strokeWidth={1} />
        )))}
        {nodes.map((a, i) => {
          const v = a.votedFor;
          if (!a.up || v === null || v === i || a.term !== maxTerm || v >= n) return null;
          const [x1, y1] = pos[i]!, [x2, y2] = pos[v]!;
          const d = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / d, uy = (y2 - y1) / d;
          return <line key={`v${i}`} x1={x1 + ux * (r + 4)} y1={y1 + uy * (r + 4)} x2={x2 - ux * (r + 6)} y2={y2 - uy * (r + 6)} stroke="var(--c3)" strokeWidth={1.8} markerEnd="url(#raft-vote)" />;
        })}
        {nodes.map((a, i) => {
          const [x, y] = pos[i]!;
          const col = a.up ? ROLE_COLOR[a.role] : "var(--faint)";
          const left = a.up && a.role !== "leader" && Number.isFinite(a.electionDeadline) ? Math.max(0, Math.min(1, (a.electionDeadline - now) / maxTimeout)) : 0;
          const arc = (f: number) => {
            const ang = 2 * Math.PI * f - 1e-6, rr = r + 5;
            return `M${x} ${y - rr} A${rr} ${rr} 0 ${ang > Math.PI ? 1 : 0} 1 ${x + rr * Math.sin(ang)} ${y - rr * Math.cos(ang)}`;
          };
          return (
            <g key={i} onClick={onNode && (() => onNode(i))} style={{ cursor: onNode ? "pointer" : undefined }}>
              <circle cx={x} cy={y} r={r} fill={a.up ? (a.role === "follower" ? "var(--bg)" : tint(col, 22)) : "var(--subtle)"} stroke={col} strokeWidth={a.role === "leader" && a.up ? 3 : 1.5} strokeDasharray={!a.up || a.role === "precandidate" ? "4 3" : undefined} />
              {left > 0 && <path d={arc(left)} fill="none" stroke="var(--c2)" strokeWidth={2.5} strokeLinecap="round" opacity={0.75} />}
              <text x={x} y={y - 3} textAnchor="middle" fontSize={12.5} fontWeight={600} fill={a.up ? "var(--fg)" : "var(--faint)"}>{sname(i)}</text>
              <text x={x} y={y + 11} textAnchor="middle" fontSize={10.5} fill="var(--muted)" style={{ fontFamily: MONO }}>{a.up ? `t${a.term}` : "down"}</text>
              {a.up && (() => {
                // Notes go outward from the center: the role (if not a follower), then the sub text.
                const ux = (x - cx) / R, uy = (y - cy) / R;
                const lines = [a.role !== "follower" ? { t: a.role === "precandidate" ? "pre-vote" : a.role, c: col, b: 600 } : null, sub ? { t: sub(a), c: "var(--faint)", b: 400 } : null].filter((l): l is { t: string; c: string; b: number } => l !== null);
                const side = Math.abs(ux) > 0.6;
                const ax = side ? x + ux * (r + 10) : x;
                const order = side || uy > 0 ? lines : [...lines].reverse();
                const y0 = side ? y + uy * (r + 6) - ((order.length - 1) * 12) / 2 + 4 : uy > 0 ? y + r + 17 : y - r - 10 - (order.length - 1) * 12;
                return order.map((l, k) => (
                  <text key={k} x={ax} y={y0 + k * 12} textAnchor={side ? (ux > 0 ? "start" : "end") : "middle"} fontSize={10.5} fontWeight={l.b} fill={l.c} style={{ fontFamily: l.b === 400 ? MONO : undefined }}>{l.t}</text>
                ));
              })()}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- per-server logs

export interface LogGridProps {
  nodes: NodeView[];
  /** First index to show. Default: the window that ends at the longest log. */
  from?: number;
  /** Number of index columns. Default: as many as fit. */
  cols?: number;
  /** What each node applied, by index, to mark entries that a state machine has seen. */
  applied?: Record<number, string>[];
  /** Entries to ring, as "node:index". */
  ring?: Set<string>;
  /** Extra text after each server's name. */
  side?: (n: NodeView) => ReactNode;
}

/**
 * One row per server and one column per log index. A cell shows the term (color and number) and the command.
 * A solid cell is committed on that server; a dashed one is not. A dot marks an applied entry.
 */
export function LogGrid({ nodes, from, cols, applied, ring, side }: LogGridProps) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const head = 58, cell = 38;
  const fit = Math.max(4, Math.floor((w - head) / (cell + 2)));
  const ncols = Math.min(cols ?? fit, fit);
  const last = Math.max(1, ...nodes.map((n) => n.base + n.log.length));
  const start = Math.max(1, from ?? last - ncols + 1);
  const idx = Array.from({ length: ncols }, (_, k) => start + k);
  return (
    <div ref={ref} style={{ width: "100%", overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: `${head}px repeat(${ncols}, ${cell}px)`, gap: 2, alignItems: "center", fontSize: 11 }}>
        <span className="muted" style={{ fontSize: 10.5 }}>index</span>
        {idx.map((i) => <span key={i} className="muted" style={{ ...mono, textAlign: "center", fontSize: 10.5 }}>{i}</span>)}
        {nodes.map((n) => (
          <Row key={n.id} n={n} idx={idx} applied={applied?.[n.id]} ring={ring} side={side?.(n)} />
        ))}
      </div>
    </div>
  );
}

function Row({ n, idx, applied, ring, side }: { n: NodeView; idx: number[]; applied?: Record<number, string>; ring?: Set<string>; side?: ReactNode }) {
  const lead = n.up && n.role === "leader";
  return (
    <>
      <span style={{ fontSize: 12, fontWeight: lead ? 700 : 500, color: n.up ? (lead ? ROLE_COLOR.leader : "var(--fg)") : "var(--faint)", whiteSpace: "nowrap", overflow: "hidden" }}>
        {sname(n.id)} <span className="muted" style={{ ...mono, fontSize: 10.5, fontWeight: 400 }}>{n.up ? `t${n.term}` : "down"}</span>{side}
      </span>
      {idx.map((i) => {
        if (i <= n.base) {
          return <span key={i} title={`in the snapshot (up to index ${n.base})`} style={{ height: 30, borderRadius: 4, background: "var(--subtle)", border: "1px solid var(--border)", opacity: n.up ? 1 : 0.5 }} />;
        }
        const e = n.log[i - n.base - 1];
        if (!e) return <span key={i} style={{ height: 30, borderRadius: 4, border: "1px dotted var(--border)", opacity: 0.6 }} />;
        const committed = i <= n.commitIndex;
        const col = termColor(e.term);
        const label = e.kind === "config" ? "cfg" : e.label;
        return (
          <span
            key={i}
            title={`index ${i}, term ${e.term}: ${e.label}${committed ? ", committed here" : ", not committed here"}`}
            style={{
              position: "relative", height: 30, borderRadius: 4, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              background: committed ? tint(col, 30) : "var(--bg)", border: `1.5px ${committed ? "solid" : "dashed"} ${col}`, opacity: n.up ? 1 : 0.5,
              outline: ring?.has(`${n.id}:${i}`) ? "2px solid var(--c4)" : undefined, outlineOffset: 1, lineHeight: 1.05,
            }}
          >
            <b style={{ ...mono, fontSize: 11, color: "var(--fg)" }}>{e.term}</b>
            <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--muted)", maxWidth: 36, overflow: "hidden", whiteSpace: "nowrap" }}>{label}</span>
            {!applied && i <= n.lastApplied && <span title="applied" style={{ position: "absolute", top: 2, right: 2, width: 5, height: 5, borderRadius: 3, background: "var(--fg)" }} />}
            {applied?.[i] && (() => {
              // A red dot: this server applied a different entry at this index earlier.
              const other = applied[i] !== `${e.label} (t${e.term})`;
              return <span title={other ? `applied ${applied[i]} here earlier` : "applied"} style={{ position: "absolute", top: 2, right: 2, width: other ? 7 : 5, height: other ? 7 : 5, borderRadius: 4, background: other ? "var(--c4)" : "var(--fg)" }} />;
            })()}
          </span>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------- a live cluster

/**
 * Holds a running cluster and advances it while playing. `speed` is simulated ms per real second.
 * `version` changes on every tick, so that views redraw.
 */
export function useLiveCluster(make: () => RaftCluster<KvCmd>, speed: number, onTick?: (c: RaftCluster<KvCmd>) => void) {
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  const ref = useRef<RaftCluster<KvCmd> | null>(null);
  ref.current ??= make();
  const [version, setVersion] = useState(0);
  const [playing, setPlaying] = useState(true);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      tickRef.current?.(ref.current!);
      ref.current!.run(speedRef.current / 20);
      setVersion((v) => v + 1);
    }, 50);
    return () => window.clearInterval(id);
  }, [playing]);
  const c = ref.current;
  return {
    c, version, playing,
    toggle: () => setPlaying((p) => !p),
    /** Runs a change on the cluster, then redraws. */
    act: (f: (c: RaftCluster<KvCmd>) => void) => { f(c); setVersion((v) => v + 1); },
    step: (ms: number) => { c.run(ms); setVersion((v) => v + 1); },
    reset: () => { ref.current = make(); setVersion((v) => v + 1); },
    nodes: () => c.nodes.map((_, i) => viewNode(c, i)),
    /** Messages sent in the last `span` ms. */
    recent: (span: number) => {
      const ms = c.net.messages, t0 = c.now - span, out: MsgView[] = [];
      for (let k = ms.length - 1; k >= 0 && ms[k]!.sentAt >= t0; k--) out.push(viewMsg(ms[k]!));
      return out.reverse();
    },
  };
}

/** Partition helpers for the live demos: who can talk to whom now. */
export const connectedIn = (c: RaftCluster<KvCmd>) => (a: number, b: number) => c.net.connected(a, b);

/** The time span that a step's messages need on a space-time diagram: from the step start to the last arrival. */
export function frameSpan(f: { t0: number; t1: number; msgs: MsgView[] }, heartbeats = false): [number, number] {
  let end = f.t0 + 30;
  for (const m of f.msgs) if (heartbeats || !isHeartbeat(m)) end = Math.max(end, (m.deliveredAt ?? m.lostAt ?? m.sentAt) + 4);
  return [f.t0, Math.min(f.t1, end)];
}
