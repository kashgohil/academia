/** Views that the capstone demos share: a live store, node views for the Raft log grid, and space-time conversion. */
import { useEffect, useRef, useState } from "react";
import { mono, Chip, BAD, GOOD } from "../../kit";
import type { StMark, StMessage } from "./SpaceTime";
import { fmtConfig } from "../../sims/dist/consensus/raft/raft";
import type { NodeView } from "../../sims/dist/consensus/raft/scenarios";
import { cmdText, storeMsgLabel, opText, type KvStore, type OpRecord, type StoreMsg } from "../../sims/dist/capstone";
import type { Entry } from "../../sims/dist/consensus/raft/types";
import type { StoreCmd } from "../../sims/dist/capstone";

export const sname = (i: number) => `S${i + 1}`;

const entryText = (e: Entry<StoreCmd>) => (e.kind === "cmd" ? cmdText(e.cmd) : e.kind === "noop" ? "no-op" : "config");

/** A store server as the NodeView that the Raft views (LogGrid, Ring) draw. */
export function storeNode(s: KvStore, i: number): NodeView {
  const n = s.node(i);
  return {
    id: i, up: s.isUp(i), role: n.role, term: n.currentTerm, votedFor: n.votedFor, leaderId: n.leaderId,
    commitIndex: n.commitIndex, lastApplied: n.lastApplied, base: n.base, baseTerm: n.baseTerm,
    log: n.log.map((e) => ({ index: e.index, term: e.term, kind: e.kind, label: entryText(e) })),
    config: fmtConfig(n.config), voter: n.config.voters.includes(i) || (n.config.old?.includes(i) ?? false),
    electionDeadline: n.electionDeadline,
  };
}

const MSG_COLOR: Record<string, string> = {
  RequestVote: "var(--c2)", RequestVoteReply: "var(--c2)", AppendEntries: "var(--c1)", AppendEntriesReply: "var(--c1)",
  InstallSnapshot: "var(--c5)", InstallSnapshotReply: "var(--c5)", TimeoutNow: "var(--c3)", ClientRequest: "var(--c3)", ClientReply: "var(--c3)",
  Read: "var(--c3)", ReadReply: "var(--c3)", RiPing: "var(--c5)", RiAck: "var(--c5)",
};

const isHeartbeat = (p: StoreMsg) => (p.type === "AppendEntries" && p.entries.length === 0) || (p.type === "AppendEntriesReply" && p.success) || p.type === "InstallSnapshotReply";

/**
 * SpaceTime messages of a store run in [t0, t1]. Servers keep their rows; clients follow. Heartbeats are faint
 * (or hidden), and a broadcast is labelled once.
 */
export function storeMessages(s: KvStore, t0: number, t1: number, { heartbeats = false, clientLabels = true }: { heartbeats?: boolean; clientLabels?: boolean } = {}): StMessage[] {
  const ms = s.net.messages;
  let lo = ms.length;
  while (lo > 0 && ms[lo - 1]!.sentAt >= t0) lo--;
  const out: StMessage[] = [];
  const labelled = new Set<string>();
  for (let k = lo; k < ms.length && ms[k]!.sentAt <= t1; k++) {
    const m = ms[k]!;
    const p = m.payload as StoreMsg;
    if (m.deliveredAt === undefined && m.lost === undefined) continue; // in flight
    const hb = isHeartbeat(p);
    if (hb && !heartbeats) continue;
    const text = !clientLabels && (m.from >= s.n || m.to >= s.n) ? "" : storeMsgLabel(p);
    const key = `${m.from}|${text}|${m.sentAt.toFixed(3)}`;
    const label = text && !labelled.has(key) ? text : undefined;
    if (label) labelled.add(key);
    const refuse = text === "no" || text === "reject" || text === "retry";
    out.push({
      from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt, label,
      color: m.deliveredAt === undefined ? undefined : hb ? "var(--faint)" : refuse ? "var(--c4)" : MSG_COLOR[p.type], dashed: hb,
    });
  }
  return out;
}

/** Leader changes, crashes, recoveries and finished operations, as SpaceTime marks in [t0, t1]. */
export function storeMarks(s: KvStore, t0: number, t1: number, bad?: Set<number>): StMark[] {
  const out: StMark[] = [];
  for (const e of s.cluster.events) {
    if (e.t < t0 || e.t > t1) continue;
    if (e.kind === "role" && e.role === "leader") out.push({ node: e.node, t: e.t, label: `L t${e.term}`, color: "var(--c1)" });
    else if (e.kind === "crash") out.push({ node: e.node, t: e.t, shape: "cross" });
    else if (e.kind === "recover") out.push({ node: e.node, t: e.t, label: "up", color: "var(--c3)" });
  }
  for (const o of s.ops) {
    if (!Number.isFinite(o.ret) || o.ret < t0 || o.call > t1) continue;
    const node = s.n + o.client;
    const isBad = bad?.has(o.id);
    out.push({ node, t: Math.max(t0, o.call), until: Math.min(t1, o.ret), shape: "bar", color: isBad ? "var(--c4)" : "var(--c3)", label: resultText(o) });
  }
  return out;
}

/** Bars for faults in [t0, t1]: servers that are cut off, paused or down, and network-wide loss or delay. */
export function faultBars(s: KvStore, t0: number, t1: number): StMark[] {
  const out: StMark[] = [];
  const open = new Map<string, { node: number; t: number; label: string; color: string }>();
  const begin = (k: string, node: number, t: number, label: string, color: string) => { if (!open.has(k)) open.set(k, { node, t, label, color }); };
  const end = (k: string, t: number) => {
    const o = open.get(k);
    if (!o) return;
    open.delete(k);
    if (t >= t0 && o.t <= t1) out.push({ node: o.node, t: Math.max(t0, o.t), until: Math.min(t1, t), shape: "bar", color: o.color, label: o.t >= t0 ? o.label : undefined });
  };
  type Ev = { t: number; f: () => void };
  const evs: Ev[] = [];
  for (const e of s.net.trace) {
    if (e.kind === "partition") evs.push({ t: e.t, f: () => {
      for (let i = 0; i < s.n; i++) {
        const alone = !e.groups.some((g) => [...Array(s.n).keys()].every((j) => g.includes(j)) && g.includes(i));
        if (alone) begin(`cut${i}`, i, e.t, "cut off", "var(--c2)"); else end(`cut${i}`, e.t);
      }
    } });
    else if (e.kind === "heal") evs.push({ t: e.t, f: () => { for (let i = 0; i < s.n; i++) end(`cut${i}`, e.t); } });
    else if (e.kind === "crash" && e.node < s.n) evs.push({ t: e.t, f: () => begin(`down${e.node}`, e.node, e.t, "down", "var(--c4)") });
    else if (e.kind === "recover" && e.node < s.n) evs.push({ t: e.t, f: () => end(`down${e.node}`, e.t) });
  }
  for (const f of s.faultLog) {
    if (f.kind === "pause") evs.push({ t: f.t, f: () => begin(`pause${f.node}`, f.node!, f.t, "paused", "var(--c5)") });
    else if (f.kind === "resume") evs.push({ t: f.t, f: () => end(`pause${f.node}`, f.t) });
  }
  evs.sort((a, b) => a.t - b.t);
  for (const e of evs) e.f();
  for (const k of [...open.keys()]) end(k, t1);
  return out;
}

export function resultText(o: OpRecord): string {
  const done = Number.isFinite(o.ret);
  if (o.op.kind === "get") return `get ${o.op.key} = ${done ? o.value : "?"}`;
  if (o.op.kind === "cas") return `${opText(o.op)} ${done ? (o.ok ? "ok" : "fail") : "?"}`;
  return `${opText(o.op)}${done ? "" : " ?"}`;
}

/** Row names for a SpaceTime of a store: servers, then clients. */
export const storeRows = (s: KvStore) => [...Array(s.n).keys()].map(sname).concat(s.clients.map((c) => `C${c.index + 1}`));

/**
 * A running store that advances while playing. `speed` is simulated ms per real second. `version` changes on each
 * tick, so that views redraw.
 */
export function useLiveStore(make: () => KvStore, speed: number, onTick?: (s: KvStore) => void) {
  const tickRef = useRef(onTick);
  tickRef.current = onTick;
  const makeRef = useRef(make);
  makeRef.current = make;
  const ref = useRef<KvStore | null>(null);
  ref.current ??= make();
  const [version, setVersion] = useState(0);
  const [playing, setPlaying] = useState(false);
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
  const s = ref.current;
  return {
    s, version, playing,
    setPlaying,
    toggle: () => setPlaying((p) => !p),
    act: (f: (s: KvStore) => void) => { f(ref.current!); setVersion((v) => v + 1); },
    /** Builds a new store with the newest `make` (so a reset after a settings change uses the new settings). */
    reset: () => { ref.current = makeRef.current(); setVersion((v) => v + 1); },
  };
}

/** A compact list of operations, newest last. Bad ones are red. */
export function OpList({ ops, bad, max = 160 }: { ops: OpRecord[]; bad?: Set<number>; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [ops.length]);
  return (
    <div ref={ref} style={{ border: "1px solid var(--border)", borderRadius: 6, maxHeight: max, overflowY: "auto", fontSize: 12 }}>
      {ops.length === 0 && <div className="muted" style={{ padding: 6 }}>No operations yet.</div>}
      {ops.map((o) => {
        const done = Number.isFinite(o.ret);
        const isBad = bad?.has(o.id);
        return (
          <div key={o.id} style={{ display: "flex", gap: 8, padding: "1px 6px", borderBottom: "1px solid var(--border)", color: isBad ? BAD : done ? "var(--fg)" : "var(--muted)" }}>
            <span style={{ ...mono, width: 30, flex: "none", color: "var(--muted)" }}>C{o.client + 1}</span>
            <span style={{ ...mono, flex: "1 1 auto", minWidth: 0, overflowWrap: "anywhere" }}>{resultText(o)}</span>
            <span style={{ ...mono, flex: "none", color: "var(--muted)" }}>{Math.round(o.call)}–{done ? Math.round(o.ret) : "…"}</span>
            <span style={{ flex: "none", width: 96, textAlign: "right", color: "var(--muted)", whiteSpace: "nowrap" }}>{done ? (o.via === "write" ? `S${(o.servedBy ?? 0) + 1}` : `${o.via} S${(o.servedBy ?? 0) + 1}`) : `try ${o.tries}`}</span>
          </div>
        );
      })}
    </div>
  );
}

export const Verdict = ({ ok, children }: { ok: boolean | null; children: React.ReactNode }) => (
  <Chip color={ok === null ? "var(--c2)" : ok ? GOOD : BAD} filled={ok === false}>{children}</Chip>
);
