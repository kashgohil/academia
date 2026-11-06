/**
 * A Kafka-style consumer group, as a fluid model in time steps (no messages: the point is assignment and lag).
 *
 * A topic has P partitions. Producers append `rate[p]` records per second to partition p. Each partition is
 * assigned to exactly one consumer of the group, and each consumer reads up to `capacity` records per second,
 * shared among its partitions that have a backlog. Lag = log end offset − the consumer's position.
 *
 * Membership changes start a rebalance:
 * - eager: every consumer gives up all its partitions, and nothing is read for `rebalanceSec`;
 * - cooperative (incremental, KIP-429): only partitions that move to another consumer stop, for two rebalance rounds.
 * A consumer that crashes keeps its partitions, unread, until the coordinator notices it after `sessionTimeoutSec`.
 *
 * Assignors: range (Kafka's RangeAssignor for one topic), round-robin, and sticky (balanced, and keeps as many
 * partitions in place as it can). All rates and durations are MODEL INPUTS.
 */

export type Assignor = "range" | "round-robin" | "sticky";
export type Protocol = "eager" | "cooperative";

export interface GroupConfig {
  partitions: number;
  /** Records per second, per partition. */
  rate: number[];
  capacity: number;
  assignor: Assignor;
  protocol: Protocol;
  rebalanceSec: number;
  sessionTimeoutSec: number;
  dt: number;
  horizon: number;
  /** Consumer ids in the group at t = 0. */
  initial: string[];
  /** Changes: a consumer joins, leaves cleanly (it sends LeaveGroup), or crashes. */
  events: { t: number; op: "join" | "leave" | "crash"; id: string }[];
}

export const GROUP_DEFAULTS: GroupConfig = {
  partitions: 6, rate: [100, 100, 100, 100, 100, 100], capacity: 400, assignor: "range", protocol: "eager",
  rebalanceSec: 3, sessionTimeoutSec: 45, dt: 0.25, horizon: 120, initial: ["c1", "c2"], events: [],
};

/** Assigns partitions 0..P-1 to consumers. `prev` is the current owner of each partition (for sticky). */
export function assign(assignor: Assignor, P: number, members: string[], prev: (string | null)[] = []): (string | null)[] {
  const ms = [...members].sort();
  const out: (string | null)[] = new Array(P).fill(null);
  if (!ms.length) return out;
  if (assignor === "range") {
    const per = Math.floor(P / ms.length), extra = P % ms.length;
    let p = 0;
    ms.forEach((m, i) => { for (let j = 0; j < per + (i < extra ? 1 : 0); j++) out[p++] = m; });
  } else if (assignor === "round-robin") {
    for (let p = 0; p < P; p++) out[p] = ms[p % ms.length]!;
  } else {
    // Sticky: each member may keep up to its quota; the rest go to the members with the fewest partitions.
    const quota = (i: number) => Math.floor(P / ms.length) + (i < P % ms.length ? 1 : 0);
    const count = new Map(ms.map((m) => [m, 0]));
    // Members that already own more partitions get the larger quotas, so that fewer partitions move.
    const owned = (m: string) => prev.filter((x) => x === m).length;
    const order = [...ms].sort((a, b) => owned(b) - owned(a) || (a < b ? -1 : 1));
    const cap = new Map(order.map((m, i) => [m, quota(i)]));
    for (let p = 0; p < P; p++) {
      const o = prev[p];
      if (o && cap.has(o) && count.get(o)! < cap.get(o)!) { out[p] = o; count.set(o, count.get(o)! + 1); }
    }
    for (let p = 0; p < P; p++) {
      if (out[p]) continue;
      const m = order.filter((x) => count.get(x)! < cap.get(x)!).sort((a, b) => count.get(a)! - count.get(b)!)[0]!;
      out[p] = m;
      count.set(m, count.get(m)! + 1);
    }
  }
  return out;
}

export interface GroupRun {
  cfg: GroupConfig;
  /** Time points, total lag and the lag of each partition at each point. */
  t: number[];
  lag: number[][];
  total: number[];
  /** Each assignment that took effect: time, owner per partition, and how many partitions moved. */
  assignments: { t: number; owner: (string | null)[]; moved: number; members: string[] }[];
  /** Periods in which a partition was not read: [from, to, partition]. */
  paused: [number, number, number][];
  /** Records read per consumer over the run. */
  readBy: Record<string, number>;
}

export function runGroup(partial: Partial<GroupConfig> = {}): GroupRun {
  const cfg: GroupConfig = { ...GROUP_DEFAULTS, ...partial };
  const P = cfg.partitions;
  const rate = Array.from({ length: P }, (_, p) => cfg.rate[p] ?? cfg.rate[cfg.rate.length - 1] ?? 0);
  const lagNow = new Array<number>(P).fill(0);
  let members = [...cfg.initial];
  const alive = new Set(members);
  let owner = assign(cfg.assignor, P, members);
  /** Until this time, partition p is not read (it is being revoked or reassigned). */
  const pausedUntil = new Array<number>(P).fill(0);
  const assignments: GroupRun["assignments"] = [{ t: 0, owner: [...owner], moved: 0, members: [...members] }];
  const paused: GroupRun["paused"] = [];
  const readBy: Record<string, number> = {};
  const pending: { at: number; members: string[] }[] = [];

  const rebalance = (t: number, next: string[]) => {
    const newOwner = assign(cfg.assignor, P, next, owner);
    let moved = 0;
    for (let p = 0; p < P; p++) {
      const moves = newOwner[p] !== owner[p];
      if (moves) moved++;
      // Eager: everything stops for one round. Cooperative: only moved partitions stop, for two rounds.
      const stop = cfg.protocol === "eager" ? cfg.rebalanceSec : moves ? 2 * cfg.rebalanceSec : 0;
      if (stop > 0) {
        pausedUntil[p] = Math.max(pausedUntil[p]!, t + stop);
        paused.push([t, t + stop, p]);
      }
    }
    owner = newOwner;
    members = next;
    assignments.push({ t, owner: [...owner], moved, members: [...members] });
  };

  const events = [...cfg.events].sort((a, b) => a.t - b.t);
  let ei = 0;
  const ts: number[] = [], lag: number[][] = [], total: number[] = [];
  for (let t = 0; t <= cfg.horizon + 1e-9; t += cfg.dt) {
    // Joins and clean leaves at the same time make one rebalance.
    let next: string[] | null = null;
    while (ei < events.length && events[ei]!.t <= t + 1e-9) {
      const e = events[ei++]!;
      const cur: string[] = next ?? members;
      if (e.op === "join") { alive.add(e.id); next = [...cur, e.id]; }
      else if (e.op === "leave") { alive.delete(e.id); next = cur.filter((m) => m !== e.id); }
      else { alive.delete(e.id); pending.push({ at: t + cfg.sessionTimeoutSec, members: [e.id] }); }
    }
    if (next) rebalance(t, next);
    for (const q of pending.filter((x) => x.at <= t + 1e-9)) rebalance(t, members.filter((m) => !q.members.includes(m)));
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.at <= t + 1e-9) pending.splice(i, 1);

    for (let p = 0; p < P; p++) lagNow[p]! += rate[p]! * cfg.dt;
    // Each live consumer splits its capacity among its readable partitions with a backlog (water filling).
    for (const m of members) {
      if (!alive.has(m)) continue;
      let ps = Array.from({ length: P }, (_, p) => p).filter((p) => owner[p] === m && pausedUntil[p]! <= t && lagNow[p]! > 0);
      let budget = cfg.capacity * cfg.dt;
      while (ps.length && budget > 1e-9) {
        const share = budget / ps.length;
        for (const p of ps) {
          const take = Math.min(share, lagNow[p]!);
          lagNow[p]! -= take;
          budget -= take;
          readBy[m] = (readBy[m] ?? 0) + take;
        }
        ps = ps.filter((p) => lagNow[p]! > 1e-9);
      }
    }
    ts.push(t);
    lag.push(lagNow.slice());
    total.push(lagNow.reduce((a, b) => a + b, 0));
  }
  return { cfg, t: ts, lag, total, assignments, paused, readBy };
}
