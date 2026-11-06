/**
 * The network playground: a script of sends between three nodes on a Net with the chosen latency range, loss,
 * duplication, FIFO and partition. It counts what the network did to the messages.
 */
import { Net, type Message, type NetConfig } from "../net";

export interface PgMsg {
  /** Sequence number on its link, so the receiver can see reordering and duplicates. */
  seq: number;
}

export interface PgSend {
  t: number;
  from: number;
  to: number;
}

export interface PgOptions {
  seed: number;
  latency: { min: number; max: number };
  dropRate: number;
  dupRate: number;
  fifo: boolean;
  /** Cut node `cut` off from the others during [from, to). */
  partition?: { cut: number; from: number; to: number };
}

/** The default script: a burst of messages on every link. The learner adds more with the buttons. */
export function defaultSends(n = 3, count = 12, gap = 8): PgSend[] {
  const links: [number, number][] = [[0, 1], [1, 2], [0, 2], [2, 0]];
  return Array.from({ length: count }, (_, i) => {
    const [from, to] = links[i % links.length]!;
    return { t: i * gap, from: from % n, to: to % n };
  });
}

export function playgroundRun(n: number, sends: PgSend[], o: PgOptions) {
  const cfg: Partial<NetConfig> = { seed: o.seed, latency: o.latency, dropRate: o.dropRate, dupRate: o.dupRate, fifo: o.fifo };
  const net = new Net<PgMsg>(n, cfg, {});
  const seqs = new Map<string, number>();
  const events = [
    ...sends.map((s) => ({ t: s.t, run: () => {
      const key = `${s.from}>${s.to}`;
      const seq = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, seq);
      net.send(s.from, s.to, { seq });
    } })),
    ...(o.partition ? [
      { t: o.partition.from, run: () => net.partition([Array.from({ length: n }, (_, i) => i).filter((i) => i !== o.partition!.cut), [o.partition!.cut]]) },
      { t: o.partition.to, run: () => net.heal() },
    ] : []),
  ].sort((a, b) => a.t - b.t);
  for (const e of events) {
    net.runUntil(e.t);
    e.run();
  }
  net.runAll();
  return { net, stats: netStats(net.messages) };
}

export interface NetStats {
  sent: number;
  delivered: number;
  dropped: number;
  cut: number;
  duplicates: number;
  /** Deliveries that arrived after a later message on the same link. */
  reordered: number;
  maxDelay: number;
}

export function netStats<P extends { seq: number }>(msgs: readonly Message<P>[]): NetStats {
  const s: NetStats = { sent: 0, delivered: 0, dropped: 0, cut: 0, duplicates: 0, reordered: 0, maxDelay: 0 };
  const highest = new Map<string, number>();
  const byTime = msgs.filter((m) => m.deliveredAt !== undefined).sort((a, b) => a.deliveredAt! - b.deliveredAt!);
  for (const m of msgs) {
    if (m.dupOf === undefined) s.sent++;
    else s.duplicates++;
    if (m.deliveredAt !== undefined) {
      s.delivered++;
      s.maxDelay = Math.max(s.maxDelay, m.deliveredAt - m.sentAt);
    } else if (m.lost === "dropped") s.dropped++;
    else s.cut++;
  }
  for (const m of byTime) {
    const key = `${m.from}>${m.to}`;
    const h = highest.get(key) ?? 0;
    if (m.payload.seq < h) s.reordered++;
    highest.set(key, Math.max(h, m.payload.seq));
  }
  return s;
}
