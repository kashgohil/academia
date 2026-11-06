/**
 * The normal case of PBFT (Castro and Liskov, OSDI 1999) for one request, on the shared network.
 * Replicas 0..n-1, replica 0 is the primary of view 0, and node n is the client. The protocol tolerates f
 * Byzantine replicas and uses quorums of Q = n − f (that is 2f + 1 when n = 3f + 1).
 *
 *   REQUEST      client → primary
 *   PRE-PREPARE  primary → backups: sequence number 1 for digest d
 *   PREPARE      each backup → all replicas, after it accepts the pre-prepare
 *   prepared     a replica has the pre-prepare and Q − 1 matching PREPAREs from distinct backups
 *   COMMIT       each prepared replica → all replicas
 *   committed    prepared, and Q matching COMMITs (its own included); it executes and sends REPLY
 *   REPLY        replica → client; the client trusts a result that f + 1 replicas report
 *
 * A traitor can equivocate (different values to different replicas, and votes for both values), stay silent, or
 * send garbage digests. With n = 3f + 1, two quorums share f + 1 replicas, so at least one honest replica, and that
 * replica never votes for two values. With n = 3 and f = 1, two quorums of 2 can share only the traitor.
 *
 * `linear` switches to a leader-collector pattern (as in SBFT and HotStuff): backups send votes only to the primary,
 * which forwards one certificate. That needs signatures in a real system; here it only counts messages.
 */
import { Net, type Message } from "../../net";

export type Behavior = "honest" | "equivocate" | "silent" | "garbage";

export type PbftMsg =
  | { t: "request"; d: string }
  | { t: "pre-prepare"; d: string }
  | { t: "prepare"; d: string }
  | { t: "commit"; d: string }
  | { t: "reply"; d: string }
  | { t: "cert-prepared"; d: string }
  | { t: "cert-committed"; d: string };

export interface PbftConfig {
  n: number;
  f: number;
  /** Behavior of each replica; missing entries are honest. */
  behavior: Behavior[];
  seed: number;
  linear: boolean;
  latency: { min: number; max: number };
}

export const PBFT_DEFAULTS: PbftConfig = { n: 4, f: 1, behavior: [], seed: 1, linear: false, latency: { min: 5, max: 15 } };

export interface PbftReplica {
  prePrepared: string | null;
  prepares: Map<string, Set<number>>;
  commits: Map<string, Set<number>>;
  prepared: string | null;
  committed: string | null;
  committedAt: number | null;
}

export interface PbftResult {
  net: Net<PbftMsg>;
  replicas: PbftReplica[];
  honest: number[];
  /** Distinct values that honest replicas committed. */
  honestValues: string[];
  agreement: boolean;
  /** Every honest replica committed. */
  live: boolean;
  /** The value the client accepted (f + 1 matching replies), or null. */
  clientResult: string | null;
  messages: number;
}

export const CLIENT_VALUE = "x";
export const OTHER_VALUE = "y";

export function runPbft(cfg: Partial<PbftConfig> = {}): PbftResult {
  const c = { ...PBFT_DEFAULTS, ...cfg };
  const { n, f } = c;
  const Q = n - f;
  const client = n;
  const beh = (i: number): Behavior => c.behavior[i] ?? "honest";
  const reps: PbftReplica[] = Array.from({ length: n }, () => ({ prePrepared: null, prepares: new Map(), commits: new Map(), prepared: null, committed: null, committedAt: null }));
  const replies = new Map<string, Set<number>>();
  let clientResult: string | null = null;
  let certSent = false;
  const others = (i: number) => Array.from({ length: n }, (_, k) => k).filter((k) => k !== i);
  const add = (m: Map<string, Set<number>>, d: string, who: number) => {
    const s = m.get(d) ?? new Set<number>();
    s.add(who);
    m.set(d, s);
    return s.size;
  };

  const net = new Net<PbftMsg>(n + 1, { seed: c.seed, latency: c.latency });
  const garbage = () => `#${Math.floor(net.random() * 0xfff).toString(16)}`;

  /** A traitor's version of "send m to every other replica". */
  const sendAll = (i: number, m: PbftMsg, targets = others(i)) => {
    const b = beh(i);
    if (b === "silent") return;
    targets.forEach((to, k) => {
      if (b === "honest") net.send(i, to, m);
      else if (b === "garbage") net.send(i, to, { ...m, d: garbage() } as PbftMsg);
      else if (m.t === "pre-prepare") net.send(i, to, { ...m, d: k < targets.length / 2 ? CLIENT_VALUE : OTHER_VALUE });
      else {
        // An equivocating voter votes for both values, to every replica.
        net.send(i, to, { ...m, d: CLIENT_VALUE } as PbftMsg);
        net.send(i, to, { ...m, d: OTHER_VALUE } as PbftMsg);
      }
    });
  };

  const tryCommit = (i: number) => {
    const r = reps[i]!;
    if (!r.prepared || r.committed) return;
    if ((r.commits.get(r.prepared)?.size ?? 0) >= Q) {
      r.committed = r.prepared;
      r.committedAt = net.now;
      net.note(i, `commit ${r.committed}`);
      if (beh(i) !== "silent") net.send(i, client, { t: "reply", d: beh(i) === "garbage" ? garbage() : r.committed });
    }
  };

  const tryPrepare = (i: number) => {
    const r = reps[i]!;
    if (r.prepared || !r.prePrepared) return;
    if ((r.prepares.get(r.prePrepared)?.size ?? 0) >= Q - 1) {
      r.prepared = r.prePrepared;
      add(r.commits, r.prepared, i);
      if (c.linear) {
        if (i === 0) sendAll(0, { t: "cert-prepared", d: r.prepared });
        else sendAll(i, { t: "commit", d: r.prepared }, [0]);
      } else sendAll(i, { t: "commit", d: r.prepared });
      tryCommit(i);
    }
  };

  const traitorVotes = (i: number) => {
    // A Byzantine replica does not wait for anything: it sends its votes as soon as it sees a pre-prepare.
    sendAll(i, { t: "prepare", d: CLIENT_VALUE }, c.linear ? [0] : others(i));
    sendAll(i, { t: "commit", d: CLIENT_VALUE }, c.linear ? [0] : others(i));
  };

  net.setHandlers({
    onMessage: (to, msg) => {
      const m = msg.payload;
      if (to === client) {
        if (m.t === "reply" && add(replies, m.d, msg.from) >= f + 1 && clientResult === null) clientResult = m.d;
        return;
      }
      const r = reps[to]!;
      const honest = beh(to) === "honest";
      switch (m.t) {
        case "request":
          if (to !== 0) return;
          r.prePrepared = m.d;
          sendAll(0, { t: "pre-prepare", d: m.d });
          if (!honest) traitorVotes(0);
          return;
        case "pre-prepare":
          if (msg.from !== 0 || r.prePrepared) return;
          r.prePrepared = m.d;
          if (!honest) return traitorVotes(to);
          add(r.prepares, m.d, to);
          sendAll(to, { t: "prepare", d: m.d }, c.linear ? [0] : others(to));
          tryPrepare(to);
          return;
        case "prepare":
          if (msg.from === 0) return; // the primary's pre-prepare stands for its prepare
          add(r.prepares, m.d, msg.from);
          if (honest) tryPrepare(to);
          return;
        case "commit":
          add(r.commits, m.d, msg.from);
          if (!honest) return;
          if (c.linear && to === 0 && r.prepared && !certSent && (r.commits.get(r.prepared)?.size ?? 0) >= Q) {
            certSent = true;
            sendAll(0, { t: "cert-committed", d: r.prepared });
          }
          tryCommit(to);
          return;
        case "cert-prepared":
          // Linear mode: the certificate stands for Q − 1 prepares. A real system checks Q signatures in it.
          if (msg.from !== 0 || !honest || r.prepared || r.prePrepared !== m.d) return;
          r.prepared = m.d;
          sendAll(to, { t: "commit", d: m.d }, [0]);
          return;
        case "cert-committed":
          if (msg.from !== 0 || !honest || r.prepared !== m.d || r.committed) return;
          r.commits.set(m.d, new Set(Array.from({ length: Q }, (_, k) => k)));
          tryCommit(to);
          return;
      }
    },
  });

  net.send(client, 0, { t: "request", d: CLIENT_VALUE });
  net.runAll();
  const honest = Array.from({ length: n }, (_, i) => i).filter((i) => beh(i) === "honest");
  const honestValues = [...new Set(honest.map((i) => reps[i]!.committed).filter((v): v is string => v !== null))];
  return {
    net, replicas: reps, honest, honestValues,
    agreement: honestValues.length <= 1,
    live: honest.every((i) => reps[i]!.committed !== null),
    clientResult,
    messages: net.messages.length,
  };
}

/** Normal-case messages for one request with all replicas honest: PBFT is quadratic, the collector pattern linear. */
export const pbftMessages = (n: number) => 1 + (n - 1) + (n - 1) * (n - 1) + n * (n - 1) + n;
export const linearMessages = (n: number) => 1 + 5 * (n - 1) + n;

export const pbftLabel = (m: Message<PbftMsg>) => {
  const short: Record<PbftMsg["t"], string> = { request: "req", "pre-prepare": "pre", prepare: "prep", commit: "com", reply: "rep", "cert-prepared": "cert", "cert-committed": "cert" };
  return `${short[m.payload.t]} ${m.payload.d}`;
};
