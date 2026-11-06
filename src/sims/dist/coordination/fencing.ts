/**
 * Many clients increment one counter under a lease, with random pauses and clock drift. This is the
 * "lock only" versus "lock + fencing" comparison of the distributed-locks lesson.
 *
 * Each client: acquire the lease, read the counter, check the lease by its own clock, then (sometimes) pause, then
 * write counter + 1. A pause after the check is the case that no check can catch: the GC stops the thread between
 * the check and the write. A lost update is an increment that the storage acknowledged but that the final value
 * does not contain.
 */
import { Net, type NodeId } from "../net";
import { FencedStore, LeaseService, Pausable, type FenceMode, type LeaseMsg } from "./lease";

export interface FencingCfg {
  seed: number;
  mode: FenceMode;
  /** Lease time to live, ms. */
  ttl: number;
  clients: number;
  /** Increments each client tries to make. */
  rounds: number;
  /** Probability that a client pauses between its check and its write. */
  pauseProb: number;
  /** A pause lasts uniform(0, maxPause) ms. Model input. */
  maxPause: number;
  /** Each client's clock rate error is uniform(−drift, +drift). */
  drift: number;
}

export const FENCING_DEFAULT: FencingCfg = { seed: 1, mode: "none", ttl: 300, clients: 3, rounds: 12, pauseProb: 0.3, maxPause: 600, drift: 0.0001 };

export interface FencingResult {
  /** Increments that the storage acknowledged to a client. */
  acked: number;
  final: number;
  /** acked − final: acknowledged increments that the final value lost. */
  lostUpdates: number;
  /** Writes that the storage rejected because of an old token. */
  rejected: number;
  /** Tokens of the accepted writes, in arrival order. */
  acceptedTokens: number[];
  /** Accepted writes with a token older than one the storage had already accepted. */
  staleAccepted: number;
  pauses: number;
}

export function fencingTrial(cfg: Partial<FencingCfg> = {}): FencingResult {
  const c = { ...FENCING_DEFAULT, ...cfg };
  const n = c.clients;
  const SVC = 0, STORE = n + 1;
  const svc = new LeaseService(SVC, c.ttl);
  const store = new FencedStore(STORE, c.mode);
  const pz = new Map<NodeId, Pausable>();
  type St = { token: number; deadline: number; asked: number; left: number; phase: "idle" | "acquiring" | "reading" | "writing"; op: number; acked: number; v: number };
  const st = new Map<NodeId, St>();
  let op = 0, pauses = 0;
  for (let i = 1; i <= n; i++) {
    pz.set(i, new Pausable(i));
    st.set(i, { token: 0, deadline: 0, asked: 0, left: c.rounds, phase: "idle", op: 0, acked: 0, v: 0 });
  }

  const release = (id: NodeId, s: St) => {
    if (s.token) net.send(id, SVC, { k: "release", token: s.token });
    s.token = 0;
    s.phase = "idle";
    if (s.left > 0) net.setTimer(id, 5 + net.random() * 40, "go");
  };

  const onClient = (id: NodeId, kind: "timer" | "msg", tag: string, p?: LeaseMsg) => {
    const s = st.get(id)!;
    if (kind === "timer") {
      if (tag === "go" && s.phase === "idle" && s.left > 0) {
        s.phase = "acquiring";
        s.asked = net.clock(id);
        net.send(id, SVC, { k: "acquire" });
      } else if (tag === "write" && s.phase === "writing") {
        net.send(id, STORE, { k: "write", op: s.op, token: s.token, value: s.v });
      }
      return;
    }
    if (!p) return;
    if (p.k === "busy" && s.phase === "acquiring") {
      s.phase = "idle";
      net.setTimer(id, 20 + net.random() * 60, "go");
    } else if (p.k === "grant" && s.phase === "acquiring") {
      s.token = p.token;
      s.deadline = s.asked + p.ttl;
      s.phase = "reading";
      s.op = ++op;
      net.send(id, STORE, { k: "read", op: s.op, token: s.token });
    } else if (p.k === "reply" && p.op === s.op && s.phase === "reading") {
      if (!p.ok || net.clock(id) >= s.deadline) return void release(id, s); // rejected, or the lease ran out: give up this round
      s.phase = "writing";
      s.op = ++op;
      s.v = p.value + 1;
      if (net.random() < c.pauseProb) {
        const len = net.random() * c.maxPause;
        pz.get(id)!.pauses.push({ from: net.now, to: net.now + len });
        pauses++;
      }
      net.setTimer(id, 1, "write");
    } else if (p.k === "reply" && p.op === s.op && s.phase === "writing") {
      if (p.ok) { s.acked++; s.left--; }
      else s.left--; // the storage refused: this increment did not happen, and the client knows it
      release(id, s);
    }
  };

  const net: Net<LeaseMsg> = new Net<LeaseMsg>(n + 2, { seed: c.seed, latency: { min: 5, max: 15 }, fifo: true }, {
    onMessage(node, m) {
      if (node === SVC) svc.onMessage(net, m);
      else if (node === STORE) store.onMessage(net, m);
      else pz.get(node)!.run(net, () => onClient(node, "msg", "", m.payload));
    },
    onTimer(node, tag) {
      if (tag === "wake") return void pz.get(node)!.wake();
      pz.get(node)!.run(net, () => onClient(node, "timer", tag));
    },
  });
  for (let i = 1; i <= n; i++) {
    net.drift[i] = (2 * net.random() - 1) * c.drift;
    net.setTimer(i, net.random() * 20, "go");
  }
  net.runUntil(120_000);
  const acked = [...st.values()].reduce((a, s) => a + s.acked, 0);
  const acc = store.accepted();
  return {
    acked, final: store.value, lostUpdates: acked - store.value,
    rejected: store.ops.filter((o) => !o.ok && o.kind === "write").length,
    acceptedTokens: acc.map((o) => o.token),
    staleAccepted: acc.filter((o) => o.stale).length,
    pauses,
  };
}

/** Sums `fencingTrial` over seeds 1..seeds. */
export function fencingSweepPoint(cfg: Partial<FencingCfg>, seeds: number) {
  let acked = 0, lost = 0, rejected = 0, badRuns = 0;
  for (let s = 1; s <= seeds; s++) {
    const r = fencingTrial({ ...cfg, seed: s });
    acked += r.acked;
    lost += r.lostUpdates;
    rejected += r.rejected;
    if (r.lostUpdates > 0) badRuns++;
  }
  return { acked, lost, rejected, badRuns, seeds };
}
