/**
 * Lamport clocks ("Time, Clocks, and the Ordering of Events in a Distributed System", CACM 1978), and Lamport's
 * mutual exclusion algorithm from the same paper, on the shared Net.
 *
 * Rules: before a local event or a send, C := C + 1. A message carries C. On a receive, C := max(C, C_msg) + 1.
 * Clock condition: a → b implies C(a) < C(b). The converse is false: C(a) < C(b) can hold for concurrent events.
 */
import { Net, type Message } from "../net";
import { eventOrder, happensBefore, randomRun, relation, type Run } from "./events";

/** The Lamport timestamp of every event, indexed by event id. */
export function lamportStamps(run: Run): number[] {
  const C = new Array<number>(run.n).fill(0);
  const L = new Array<number>(run.events.length).fill(0);
  for (const id of eventOrder(run)) {
    const e = run.events[id]!;
    const msgT = e.kind === "recv" ? L[run.msgs[e.msg!]!.send]! : 0;
    C[e.proc] = Math.max(C[e.proc]!, msgT) + 1;
    L[id] = C[e.proc]!;
  }
  return L;
}

/** The total order of Lamport: by timestamp, and ties broken by process id. */
export const lamportTotalLess = (la: number, pa: number, lb: number, pb: number) => la < lb || (la === lb && pa < pb);

export interface ConverseStats {
  pairs: number;
  /** Ordered pairs (a, b) with C(a) < C(b). */
  ordered: number;
  /** Of those, the pairs where a → b really holds. */
  causal: number;
  /** Of those, the concurrent pairs: the timestamps suggest an order that does not exist. */
  concurrent: number;
  /** Pairs with a → b but C(a) >= C(b): must be 0 (clock condition). */
  violations: number;
}

/** Counts, over all pairs of events in a run, how often C(a) < C(b) means a → b. */
export function converseStats(run: Run): ConverseStats {
  const L = lamportStamps(run);
  const hb = happensBefore(run);
  const s: ConverseStats = { pairs: 0, ordered: 0, causal: 0, concurrent: 0, violations: 0 };
  const n = run.events.length;
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const r = relation(hb, a, b);
      if (a < b) s.pairs++;
      if (r === "before" && !(L[a]! < L[b]!)) s.violations++;
      if (L[a]! < L[b]!) {
        s.ordered++;
        if (r === "before") s.causal++;
        else if (r === "concurrent") s.concurrent++;
      }
    }
  return s;
}

/** Over random runs (seeds 1..seeds, 3 processes, 200 ms): the share of pairs with C(a) < C(b) that are concurrent. */
export function concurrentShare(sendProb: number, seeds = 8) {
  let ordered = 0, conc = 0;
  for (let s = 1; s <= seeds; s++) {
    const c = converseStats(randomRun({ sendProb, seed: s }).run);
    ordered += c.ordered;
    conc += c.concurrent;
  }
  return conc / ordered;
}

/** One concurrent pair with C(a) < C(b) and the largest gap in timestamps, or null. */
export function worstConcurrentPair(run: Run): [number, number] | null {
  const L = lamportStamps(run);
  const hb = happensBefore(run);
  let best: [number, number] | null = null, gap = 0;
  for (let a = 0; a < run.events.length; a++)
    for (let b = 0; b < run.events.length; b++)
      if (L[a]! < L[b]! && relation(hb, a, b) === "concurrent" && L[b]! - L[a]! > gap) { gap = L[b]! - L[a]!; best = [a, b]; }
  return best;
}

// ---------------------------------------------------------------- Lamport's mutual exclusion

export type MutexMsg = { k: "request" | "ack" | "release"; ts: number; from: number };

export interface MutexCfg {
  n: number;
  seed: number;
  fifo: boolean;
  latency: { min: number; max: number };
  /** Who asks for the lock, and when (Net ms). */
  requests: { node: number; at: number }[];
  /** How long a process holds the lock. */
  hold: number;
  /** An extra delay for one message, chosen by the adversary: the k-th request that `from` sends to `to`. */
  slow?: { from: number; to: number; delay: number };
}

export const MUTEX_DEFAULT: MutexCfg = {
  n: 3, seed: 2, fifo: true, latency: { min: 4, max: 10 }, hold: 15,
  requests: [{ node: 0, at: 10 }, { node: 1, at: 10 }, { node: 2, at: 60 }],
  slow: { from: 0, to: 1, delay: 0 },
};

export interface MutexResult {
  net: Net<MutexMsg>;
  /** Each time a process held the lock. */
  holds: { node: number; enter: number; exit: number; ts: number }[];
  /** True if two processes held the lock at the same time. */
  violation: boolean;
  messages: number;
}

/**
 * Lamport's algorithm. A process that wants the lock stamps a request, puts it in its own queue and sends it to all.
 * A receiver queues it and replies with a timestamped ack. A process enters when (1) its request is first in its
 * queue in the total order, and (2) it has received a message from every other process with a later timestamp.
 * It leaves by removing its request and sending release to all. The proof needs FIFO links: without them, an ack
 * can overtake the request that should have come first.
 */
export function lamportMutex(cfg: Partial<MutexCfg> = {}): MutexResult {
  const c = { ...MUTEX_DEFAULT, ...cfg };
  const C = new Array<number>(c.n).fill(0);
  const queue: { ts: number; node: number }[][] = Array.from({ length: c.n }, () => []);
  const lastSeen: number[][] = Array.from({ length: c.n }, () => new Array<number>(c.n).fill(-1));
  const mine: ({ ts: number } | null)[] = new Array(c.n).fill(null);
  const inCs = new Array<boolean>(c.n).fill(false);
  const holds: MutexResult["holds"] = [];
  const pending: number[][] = Array.from({ length: c.n }, () => []);
  let violation = false;
  const lessQ = (a: { ts: number; node: number }, b: { ts: number; node: number }) => lamportTotalLess(a.ts, a.node, b.ts, b.node);

  const send = (net: Net<MutexMsg>, from: number, to: number, k: MutexMsg["k"]) => {
    C[from]!++;
    const msg: MutexMsg = { k, ts: C[from]!, from };
    const s = c.slow;
    if (s && k === "request" && from === s.from && to === s.to && s.delay > 0) {
      net.send(from, to, msg, { delay: net.cfg.latency.max + s.delay });
    } else net.send(from, to, msg);
  };
  const tryEnter = (net: Net<MutexMsg>, i: number) => {
    const r = mine[i];
    if (!r || inCs[i]) return;
    const head = queue[i]!.reduce((m, x) => (lessQ(x, m) ? x : m), queue[i]![0]!);
    if (head.node !== i) return;
    for (let j = 0; j < c.n; j++) if (j !== i && !lamportTotalLess(r.ts, i, lastSeen[i]![j]!, j)) return;
    inCs[i] = true;
    if (inCs.some((x, j) => x && j !== i)) violation = true;
    holds.push({ node: i, enter: net.now, exit: NaN, ts: r.ts });
    net.setTimer(i, c.hold, "exit");
  };
  const request = (net: Net<MutexMsg>, i: number) => {
    if (mine[i]) { pending[i]!.push(1); return; }
    C[i]!++;
    const ts = C[i]!;
    mine[i] = { ts };
    queue[i]!.push({ ts, node: i });
    // Every request carries the same timestamp, so the clock is not ticked again per copy.
    for (let j = 0; j < c.n; j++) if (j !== i) { C[i] = ts - 1; send(net, i, j, "request"); }
    C[i] = ts;
    tryEnter(net, i);
  };
  const net: Net<MutexMsg> = new Net<MutexMsg>(c.n, { seed: c.seed, latency: c.latency, fifo: c.fifo }, {
    onMessage(i, m: Message<MutexMsg>, x) {
      const p = m.payload;
      C[i] = Math.max(C[i]!, p.ts) + 1;
      lastSeen[i]![p.from] = Math.max(lastSeen[i]![p.from]!, p.ts);
      if (p.k === "request") {
        queue[i]!.push({ ts: p.ts, node: p.from });
        send(x, i, p.from, "ack");
      } else if (p.k === "release") {
        queue[i] = queue[i]!.filter((q) => q.node !== p.from);
      }
      for (let j = 0; j < c.n; j++) tryEnter(x, j);
    },
    onTimer(i, tag, x) {
      if (tag.startsWith("req")) return request(x, i);
      if (tag !== "exit") return;
      inCs[i] = false;
      const h = holds.filter((q) => q.node === i).pop();
      if (h) h.exit = x.now;
      queue[i] = queue[i]!.filter((q) => q.node !== i);
      mine[i] = null;
      for (let j = 0; j < c.n; j++) if (j !== i) send(x, i, j, "release");
      if (pending[i]!.length) { pending[i]!.pop(); request(x, i); }
      for (let j = 0; j < c.n; j++) tryEnter(x, j);
    },
  });
  c.requests.forEach((r, k) => net.setTimer(r.node, r.at, `req${k}`));
  net.runAll(1e5);
  return { net, holds, violation, messages: net.messages.length };
}
