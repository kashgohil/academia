/**
 * Leader-follower replication on the shared Net: log shipping, synchronous and asynchronous followers,
 * failover by promotion, and split brain under a partition.
 *
 * Node 0 is the leader. Node i (1..F) is follower i. A client write arrives at the leader, and the leader appends it
 * to its log. A sender for each follower ships the new entries every `shipEvery` ms (a model input: a real sender
 * streams, and falls behind when its link or follower is slow). A follower makes a batch durable (`flushMs`, a
 * model input) and acks the highest index. The leader confirms a write to the client when every synchronous
 * follower has acked it. With no synchronous follower, it confirms at once.
 */
import { Net } from "../net";

export type FollowerMode = "sync" | "async";

export type LfMsg = { k: "append"; from: number; to: number } | { k: "ack"; index: number };

export interface LfConfig {
  seed: number;
  /** One mode per follower. */
  modes: FollowerMode[];
  /** One-way network latency (model input), ms. */
  latency: { min: number; max: number };
  /** How often the sender for each follower ships new entries (model input), ms. */
  shipEvery: number[];
  /** Time a follower needs to make a batch durable before it acks (model input), ms, one per follower. */
  flushMs: number[];
  /** A client write arrives at the leader every `writeEvery` ms, starting at `writeEvery`. */
  writeEvery: number;
  writes: number;
}

export const LF_DEFAULTS: LfConfig = {
  seed: 7,
  modes: ["sync", "async"],
  latency: { min: 3, max: 8 },
  shipEvery: [5, 30],
  flushMs: [2, 2],
  writeEvery: 10,
  writes: 12,
};

export interface LfWrite {
  index: number;
  /** When the leader received it. */
  at: number;
  /** When the leader confirmed it to the client. Undefined: never confirmed. */
  ackedAt?: number;
}

export interface LfRun {
  net: Net<LfMsg>;
  cfg: LfConfig;
  writes: LfWrite[];
  /** The log indexes that each node holds, in order. Node 0 is the old leader. */
  logs: number[][];
  crashAt: number;
}

/** Runs the writes, crashes the leader at `crashAt` (Infinity: never), and lets every message in flight land. */
export function runLeaderFollower(cfg: LfConfig = LF_DEFAULTS, crashAt = Infinity): LfRun {
  const F = cfg.modes.length;
  const logs: number[][] = Array.from({ length: F + 1 }, () => []);
  const writes: LfWrite[] = [];
  const acked = new Array<number>(F + 1).fill(0);
  const shipped = new Array<number>(F + 1).fill(0);
  const syncSet = cfg.modes.flatMap((m, i) => (m === "sync" ? [i + 1] : []));
  const confirm = (net: Net<LfMsg>) => {
    for (const w of writes) if (w.ackedAt === undefined && syncSet.every((f) => acked[f]! >= w.index)) w.ackedAt = net.now;
  };
  const end = cfg.writeEvery * (cfg.writes + 1);
  const net = new Net<LfMsg>(F + 1, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onTimer(node, tag, n) {
      if (node === 0 && tag === "write") {
        const index = writes.length + 1;
        writes.push({ index, at: n.now });
        logs[0]!.push(index);
        confirm(n);
        if (writes.length < cfg.writes) n.setTimer(0, cfg.writeEvery, "write");
      } else if (node === 0 && tag.startsWith("ship:")) {
        const f = Number(tag.slice(5));
        if (logs[0]!.length > shipped[f]!) {
          n.send(0, f, { k: "append", from: shipped[f]! + 1, to: logs[0]!.length });
          shipped[f] = logs[0]!.length;
        }
        if (n.now < end) n.setTimer(0, cfg.shipEvery[f - 1]!, tag);
      } else if (tag.startsWith("flush:")) {
        const [a, b] = tag.slice(6).split("-").map(Number) as [number, number];
        for (let i = a; i <= b; i++) logs[node]!.push(i);
        n.send(node, 0, { k: "ack", index: b });
      }
    },
    onMessage(node, msg, n) {
      const p = msg.payload;
      if (p.k === "append") n.setTimer(node, cfg.flushMs[node - 1] ?? 0, `flush:${p.from}-${p.to}`);
      else if (node === 0) {
        acked[msg.from] = Math.max(acked[msg.from]!, p.index);
        confirm(n);
      }
    },
  });
  net.setTimer(0, cfg.writeEvery, "write");
  for (let f = 1; f <= F; f++) net.setTimer(0, cfg.shipEvery[f - 1]!, `ship:${f}`);
  if (Number.isFinite(crashAt)) {
    net.runUntil(crashAt);
    net.crash(0);
  }
  net.runAll();
  return { net, cfg, writes, logs, crashAt };
}

export interface Failover {
  promoted: number;
  /** Writes the old leader confirmed to a client that the new leader does not have. */
  lost: number[];
  /** Entries that another follower holds beyond the new leader's log. It must throw them away. */
  discarded: { node: number; index: number }[];
  /** The follower with the longest log, which a careful failover tool picks. */
  best: number;
}

/** Promotes `node` after the crash: the new leader's log is the truth from now on. */
export function failover(run: LfRun, node: number): Failover {
  const have = new Set(run.logs[node]!);
  const lost = run.writes.filter((w) => w.ackedAt !== undefined && !have.has(w.index)).map((w) => w.index);
  const discarded: Failover["discarded"] = [];
  for (let f = 1; f < run.logs.length; f++) {
    if (f === node) continue;
    for (const i of run.logs[f]!) if (!have.has(i)) discarded.push({ node: f, index: i });
  }
  let best = 1;
  for (let f = 2; f < run.logs.length; f++) if (run.logs[f]!.length > run.logs[best]!.length) best = f;
  return { promoted: node, lost, discarded, best };
}

/** Mean time from arrival to client confirmation, over confirmed writes. */
export function meanCommitMs(run: LfRun): number {
  const done = run.writes.filter((w) => w.ackedAt !== undefined);
  return done.length ? done.reduce((a, w) => a + (w.ackedAt! - w.at), 0) / done.length : NaN;
}

// ============================================================================ split brain

export type SbMsg = { k: "append"; id: string; epoch: number } | { k: "ack"; id: string; epoch: number } | { k: "beat"; epoch: number };

export interface SbConfig {
  seed: number;
  /** async: confirm at once. sync: confirm after one follower acks. */
  replication: "async" | "sync";
  /** none: the old leader never doubts itself. lease: it stops taking writes when no follower acked for `leaseMs`. */
  guard: "none" | "lease";
  latency: { min: number; max: number };
  partitionAt: number;
  partitionMs: number;
  /** A follower promotes itself when it has heard nothing from a leader for this long. */
  electionTimeoutMs: number;
  /** Shorter than the election timeout, so that the old leader stops first (model input). */
  leaseMs: number;
  beatEvery: number;
  writeEvery: number;
  end: number;
}

export const SB_DEFAULTS: SbConfig = {
  seed: 3,
  replication: "async",
  guard: "none",
  latency: { min: 3, max: 9 },
  partitionAt: 60,
  partitionMs: 140,
  electionTimeoutMs: 50,
  leaseMs: 30,
  beatEvery: 10,
  writeEvery: 20,
  end: 300,
};

export interface SbWrite {
  id: string;
  node: number;
  epoch: number;
  at: number;
  ackedAt?: number;
  /** Not in the final log of the cluster after the heal. */
  lost?: boolean;
}

export interface SbRun {
  net: Net<SbMsg>;
  cfg: SbConfig;
  writes: SbWrite[];
  /** [node, from, to): a time span in which the node believed it was the leader. */
  leaderSpans: { node: number; from: number; to: number }[];
  /** Time during which two nodes accepted writes as leader at the same time. */
  twoLeaderMs: number;
  stepDownAt?: number;
  promotedAt?: number;
  finalLog: string[];
}

/**
 * Three nodes. Node 0 leads in epoch 1, with client A next to it. A partition cuts node 0 off from nodes 1 and 2.
 * Node 1 times out and promotes itself to epoch 2; client B then writes to it. After the heal, node 0 sees the
 * higher epoch, steps down, and throws away the entries that the new leader does not have.
 */
export function runSplitBrain(cfg: SbConfig = SB_DEFAULTS): SbRun {
  const epoch = [1, 1, 1];
  const leader = [true, false, false];
  const lastHeard = [0, 0, 0];
  const lastAck = [0, 0, 0];
  const logs: string[][] = [[], [], []];
  const writes: SbWrite[] = [];
  const byId = new Map<string, SbWrite>();
  const spans: SbRun["leaderSpans"] = [];
  const spanStart = [0, -1, -1];
  let stepDownAt: number | undefined, promotedAt: number | undefined;
  const healAt = cfg.partitionAt + cfg.partitionMs;

  const stepDown = (node: number, n: Net<SbMsg>) => {
    if (!leader[node]) return;
    leader[node] = false;
    spans.push({ node, from: spanStart[node]!, to: n.now });
    if (node === 0) stepDownAt = n.now;
  };
  const accept = (node: number, client: string, n: Net<SbMsg>) => {
    if (!leader[node]) return;
    if (cfg.guard === "lease" && n.now - lastAck[node]! > cfg.leaseMs) return stepDown(node, n);
    const id = `${client}${writes.filter((w) => w.id.startsWith(client)).length + 1}`;
    const w: SbWrite = { id, node, epoch: epoch[node]!, at: n.now };
    writes.push(w);
    byId.set(id, w);
    logs[node]!.push(id);
    for (let to = 0; to < 3; to++) if (to !== node) n.send(node, to, { k: "append", id, epoch: epoch[node]! });
    if (cfg.replication === "async") w.ackedAt = n.now;
  };

  const net = new Net<SbMsg>(3, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onTimer(node, tag, n) {
      if (tag === "writeA" && node === 0) {
        accept(0, "a", n);
        if (n.now + cfg.writeEvery <= cfg.end) n.setTimer(0, cfg.writeEvery, "writeA");
      } else if (tag === "writeB") {
        accept(1, "b", n);
        if (n.now + cfg.writeEvery <= cfg.end) n.setTimer(1, cfg.writeEvery, "writeB");
      } else if (tag === "beat") {
        if (leader[node]) {
          if (cfg.guard === "lease" && n.now - lastAck[node]! > cfg.leaseMs) stepDown(node, n);
          else for (let to = 0; to < 3; to++) if (to !== node) n.send(node, to, { k: "beat", epoch: epoch[node]! });
        }
        if (n.now + cfg.beatEvery <= cfg.end) n.setTimer(node, cfg.beatEvery, "beat");
      } else if (tag === "check" && node === 1) {
        if (!leader[1] && n.now - lastHeard[1]! > cfg.electionTimeoutMs) {
          epoch[1] = Math.max(...epoch) + 1;
          leader[1] = true;
          lastAck[1] = n.now;
          spanStart[1] = n.now;
          promotedAt = n.now;
          n.note(1, `promoted, epoch ${epoch[1]}`);
          n.setTimer(1, cfg.writeEvery / 2, "writeB");
        }
        if (n.now + 5 <= cfg.end) n.setTimer(1, 5, "check");
      }
    },
    onMessage(node, msg, n) {
      const p = msg.payload;
      if (p.epoch < epoch[node]!) return; // a stale leader: ignore it
      if (p.epoch > epoch[node]!) {
        epoch[node] = p.epoch;
        stepDown(node, n);
        // Roll back to the new leader's log: drop every entry it does not hold.
        const keep = new Set(logs[msg.from]!);
        logs[node] = logs[node]!.filter((id) => keep.has(id));
      }
      if (p.k === "beat" || p.k === "append") {
        lastHeard[node] = n.now;
        if (p.k === "append" && !logs[node]!.includes(p.id)) logs[node]!.push(p.id);
        n.send(node, msg.from, { k: "ack", id: p.k === "append" ? p.id : "", epoch: epoch[node]! });
      } else if (p.k === "ack" && leader[node]) {
        lastAck[node] = n.now;
        const w = byId.get(p.id);
        if (w && w.ackedAt === undefined && w.node === node) w.ackedAt = n.now;
      }
    },
  });
  net.setTimer(0, cfg.writeEvery, "writeA");
  for (let i = 0; i < 3; i++) net.setTimer(i, cfg.beatEvery, "beat");
  net.setTimer(1, 5, "check");
  net.runUntil(cfg.partitionAt);
  net.partition([[0], [1, 2]]);
  net.runUntil(healAt);
  net.heal();
  net.runUntil(cfg.end);
  net.runAll();
  for (let i = 0; i < 3; i++) if (leader[i]) spans.push({ node: i, from: spanStart[i]!, to: cfg.end });
  // The cluster's log after the heal is the log of the leader with the highest epoch.
  let top = 0;
  for (let i = 0; i < 3; i++) if (leader[i] && epoch[i]! >= epoch[top]!) top = i;
  const finalLog = logs[top]!;
  const keep = new Set(finalLog);
  for (const w of writes) w.lost = !keep.has(w.id);
  const a = spans.filter((s) => s.node === 0), b = spans.filter((s) => s.node !== 0);
  let twoLeaderMs = 0;
  for (const x of a) for (const y of b) twoLeaderMs += Math.max(0, Math.min(x.to, y.to) - Math.max(x.from, y.from));
  return { net, cfg, writes, leaderSpans: spans, twoLeaderMs, stepDownAt, promotedAt, finalLog };
}

/** Writes that a leader confirmed to a client and that the cluster then lost. */
export const sbLostAcked = (r: SbRun) => r.writes.filter((w) => w.ackedAt !== undefined && w.lost);
