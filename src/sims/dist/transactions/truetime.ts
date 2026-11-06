/**
 * TrueTime and commit wait (Corbett et al., "Spanner: Google's Globally-Distributed Database", OSDI 2012).
 *
 * TT.now() returns an interval [earliest, latest] that contains the true time. Here a node's clock reads
 * true time + err, with |err| <= ε, and TT.now() = [clock − ε, clock + ε]. TT.after(s) is true when earliest > s.
 *
 * Commit wait: the coordinator picks s = TT.now().latest when the commit request arrives, then waits until
 * TT.after(s) before anyone can see the commit. With no drift that wait is exactly 2ε. It overlaps with the Paxos
 * write of the commit record, so the commit takes max(paxos, 2ε).
 *
 * External consistency: if T1 commits before T2 starts (in real time), then s1 < s2. With commit wait, T1's commit
 * becomes visible at a true time after s1, and T2 picks s2 >= its start's true time, so s1 < s2. Without the wait,
 * a fast clock at T1's node and a slow clock at T2's node can give s2 < s1.
 */
import { Net, type Message } from "../net";
import { mulberry32 } from "../../rng";

export interface TtInterval { earliest: number; latest: number }

export const ttNow = (clock: number, eps: number): TtInterval => ({ earliest: clock - eps, latest: clock + eps });
export const ttAfter = (tt: TtInterval, s: number) => tt.earliest > s;

export interface ExtCfg {
  /** The uncertainty bound ε (ms). */
  eps: number;
  /** Clock errors of server A (T1) and server B (T2), in ms; each within ±ε. */
  errA: number;
  errB: number;
  commitWait: boolean;
  /** The client waits this long after T1's acknowledgement before it starts T2 (ms). */
  gap: number;
  /** Model inputs: the Paxos write of the commit record, and the one-way client-server latency (ms). */
  paxos: number;
  latency: number;
}

export const DEFAULT_EXT: ExtCfg = { eps: 4, errA: 4, errB: -4, commitWait: false, gap: 1, paxos: 2, latency: 1 };

export type ExtMsg = { k: "commit"; txn: 1 | 2 } | { k: "ack"; txn: 1 | 2; s: number };

export interface TxnTrace {
  /** True time when the server received the commit request, picked s, and made the commit visible. */
  arrive: number;
  s: number;
  tt: TtInterval;
  visible: number;
  /** Time spent in commit wait beyond the Paxos write. */
  extraWait: number;
}

export interface ExtRun {
  net: Net<ExtMsg>;
  t1: TxnTrace;
  t2: TxnTrace;
  /** s1 < s2: T1 committed first in real time and has the smaller timestamp. */
  ok: boolean;
  ack1: number;
  start2: number;
}

/** Node 0 is the client, node 1 is server A (T1), node 2 is server B (T2). */
export function externalRun(c: ExtCfg): ExtRun {
  const tr: Partial<Record<1 | 2, TxnTrace>> = {};
  let ack1 = 0, start2 = 0;
  const net: Net<ExtMsg> = new Net<ExtMsg>(3, { seed: 1, latency: { min: c.latency, max: c.latency } }, {
    onMessage: (to, m: Message<ExtMsg>) => {
      const p = m.payload;
      if (p.k === "commit") {
        const tt = ttNow(net.clock(to), c.eps);
        const s = tt.latest;
        // Wait for the Paxos write, and with commit wait also until TT.after(s): clock − ε > s.
        const waitTT = c.commitWait ? s + c.eps - net.clock(to) : 0;
        const wait = Math.max(c.paxos, waitTT);
        tr[p.txn] = { arrive: net.now, s, tt, visible: net.now + wait, extraWait: Math.max(0, wait - c.paxos) };
        net.setTimer(to, wait, `done${p.txn}`);
      } else if (p.txn === 1) {
        ack1 = net.now;
        net.setTimer(0, c.gap, "start2");
      }
    },
    onTimer: (node, tag) => {
      if (tag === "start2") {
        start2 = net.now;
        net.send(0, 2, { k: "commit", txn: 2 });
      } else {
        const txn = tag === "done1" ? 1 : 2;
        net.send(node, 0, { k: "ack", txn, s: tr[txn]!.s });
      }
    },
  });
  net.offset[1] = c.errA;
  net.offset[2] = c.errB;
  net.send(0, 1, { k: "commit", txn: 1 });
  net.runAll();
  const t1 = tr[1]!, t2 = tr[2]!;
  return { net, t1, t2, ok: t1.s < t2.s, ack1, start2 };
}

/** Random clock errors in [−ε, ε] and random gaps in [0, 2ε]: how often is s2 <= s1? */
export function externalTrials(eps: number, commitWait: boolean, trials = 500, seed = 7): { violations: number; trials: number } {
  const rng = mulberry32(seed);
  let violations = 0;
  for (let k = 0; k < trials; k++) {
    const r = externalRun({ ...DEFAULT_EXT, eps, commitWait, errA: (2 * rng() - 1) * eps, errB: (2 * rng() - 1) * eps, gap: rng() * 2 * eps });
    if (!r.ok) violations++;
  }
  return { violations, trials };
}

// ============================================================================ the cost of commit wait

export interface HotCfg {
  eps: number;
  commitWait: boolean;
  /** Model inputs (ms): the Paxos write of the commit record, and the one-way client-leader latency. */
  paxos: number;
  latency: number;
  clients: number;
  /** Simulated time (ms). */
  duration: number;
}

export const DEFAULT_HOT: HotCfg = { eps: 4, commitWait: true, paxos: 9, latency: 0.5, clients: 8, duration: 4000 };

export type HotMsg = { k: "req" } | { k: "ok" };

/**
 * Clients run read-modify-write transactions on one hot row. The leader holds the row's lock from grant until the
 * commit is visible: max(paxos, 2ε) with commit wait, paxos without. Returns commits per second and mean latency.
 */
export function hotKeyRun(c: HotCfg): { throughput: number; latency: number; hold: number } {
  const queue: number[] = [];
  let busy = false, commits = 0, latSum = 0;
  const sentAt = new Map<number, number>();
  const hold = c.commitWait ? Math.max(c.paxos, 2 * c.eps) : c.paxos;
  const grant = () => {
    if (busy || !queue.length) return;
    busy = true;
    const who = queue.shift()!;
    net.setTimer(0, hold, `done:${who}`);
  };
  const net: Net<HotMsg> = new Net<HotMsg>(c.clients + 1, { seed: 2, latency: { min: c.latency, max: c.latency } }, {
    onMessage: (to, m) => {
      if (to === 0) {
        queue.push(m.from);
        grant();
      } else {
        commits++;
        latSum += net.now - sentAt.get(to)!;
        sentAt.set(to, net.now);
        if (net.now < c.duration) net.send(to, 0, { k: "req" });
      }
    },
    onTimer: (_n, tag) => {
      busy = false;
      net.send(0, Number(tag.split(":")[1]), { k: "ok" });
      grant();
    },
  });
  for (let i = 1; i <= c.clients; i++) {
    sentAt.set(i, 0);
    net.send(i, 0, { k: "req" });
  }
  net.runUntil(c.duration);
  return { throughput: (commits * 1000) / c.duration, latency: commits ? latSum / commits : NaN, hold };
}

/** One transaction with no contention: the latency a client sees. */
export const commitLatency = (eps: number, commitWait: boolean, paxos = DEFAULT_HOT.paxos, latency = DEFAULT_HOT.latency) =>
  hotKeyRun({ ...DEFAULT_HOT, eps, commitWait, paxos, latency, clients: 1 }).latency;

/** ε values for the sweep (ms): Spanner's 1–7 ms range up to NTP-class bounds. */
export const EPS_SWEEP = [0.5, 1, 2, 4, 7, 10, 20, 50, 100, 250];
