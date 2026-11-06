/**
 * Replication lag and the read anomalies it causes, on the shared Net.
 *
 * Node 0 is the leader, nodes 1..F are followers, and the next S nodes are client sessions. The leader gives each
 * write the next log sequence number (LSN) and ships it to every follower. A follower applies entries one at a
 * time, in log order: an entry is applied `delayMs` after it arrives at the earliest, and `applyMs` after the
 * previous one at the earliest. Both are model inputs: the first stands for a slow link or a deliberate delay, the
 * second for a single-threaded replay that has a fixed cost per entry.
 */
import { Net } from "../net";

export type ReadFix = "none" | "leader" | "sticky" | "lsn";
export const READ_FIXES: ReadFix[] = ["none", "leader", "sticky", "lsn"];

export type LagMsg =
  | { k: "entry"; lsn: number; key: string; at: number }
  | { k: "write"; key: string; op: number }
  | { k: "wrote"; lsn: number; op: number }
  | { k: "read"; key: string; op: number; token: number }
  | { k: "got"; key: string; version: number; applied: number; op: number };

/** One finished operation of a session, as the client saw it. */
export interface SessionOp {
  session: number;
  kind: "write" | "read";
  key: string;
  replica: number;
  start: number;
  end: number;
  /** write: its LSN. read: the LSN of the newest write to the key that the replica had applied (0: none). */
  version: number;
  /** read: the replica's applied LSN when it answered. */
  applied: number;
}

export interface LagConfig {
  seed: number;
  followers: number;
  sessions: number;
  /** Each follower: minimum delay from arrival to apply (model input), ms. */
  delayMs: number[];
  /** Each follower: replay cost per entry (model input), ms. */
  applyMs: number[];
  latency: { min: number; max: number };
  /** Pause between two operations of one session, ms. */
  thinkMs: number;
  /** Operations per session. */
  ops: number;
  fix: ReadFix;
}

export const LAG_DEFAULTS: LagConfig = {
  seed: 5,
  followers: 2,
  sessions: 3,
  delayMs: [15, 40],
  applyMs: [0.2, 0.2],
  latency: { min: 1, max: 4 },
  thinkMs: 6,
  ops: 120,
  fix: "none",
};

/**
 * Each session repeats: write its own key, read it back, read it again, read the key of another session.
 * The keys are "k0", "k1", ... (one per session).
 */
const PATTERN: ("write" | "own" | "other")[] = ["write", "own", "own", "other"];

export interface LagRun {
  net: Net<LagMsg>;
  cfg: LagConfig;
  history: SessionOp[];
  /** LSN → key, for the checker. Index 0 is unused. */
  log: string[];
}

export function runLag(cfg: LagConfig): LagRun {
  const F = cfg.followers, S = cfg.sessions;
  const clientNode = (s: number) => F + 1 + s;
  const log: string[] = [""];
  const commitAt: number[] = [0];
  /** Per replica: applied LSN, and the newest version of each key. */
  const applied = new Array<number>(F + 1).fill(0);
  const versions = Array.from({ length: F + 1 }, () => new Map<string, number>());
  const lastApplyAt = new Array<number>(F + 1).fill(-Infinity);
  /** Reads waiting at a replica for its applied LSN to reach a token. */
  const waiting: { replica: number; from: number; p: Extract<LagMsg, { k: "read" }> }[][] = Array.from({ length: F + 1 }, () => []);
  const history: SessionOp[] = [];
  const sess = Array.from({ length: S }, () => ({ step: 0, op: 0, token: 0, start: 0, replica: 0, key: "" }));

  const answer = (n: Net<LagMsg>, replica: number, to: number, p: Extract<LagMsg, { k: "read" }>) =>
    n.send(replica, to, { k: "got", key: p.key, version: versions[replica]!.get(p.key) ?? 0, applied: applied[replica]!, op: p.op });

  const next = (n: Net<LagMsg>, s: number) => {
    const st = sess[s]!;
    if (st.op >= cfg.ops) return;
    const kind = PATTERN[st.op % PATTERN.length]!;
    st.op++;
    st.start = n.now;
    const me = clientNode(s);
    if (kind === "write") {
      st.key = `k${s}`;
      st.replica = 0;
      n.send(me, 0, { k: "write", key: st.key, op: st.op });
      return;
    }
    st.key = kind === "own" ? `k${s}` : `k${(s + 1 + Math.floor(n.random() * (S - 1))) % S}`;
    const r = Math.floor(n.random() * F) + 1;
    st.replica = cfg.fix === "leader" ? 0 : cfg.fix === "sticky" ? 1 + (s % F) : r;
    n.send(me, st.replica, { k: "read", key: st.key, op: st.op, token: cfg.fix === "lsn" ? st.token : 0 });
  };

  const net = new Net<LagMsg>(F + 1 + S, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onMessage(node, msg, n) {
      const p = msg.payload;
      if (p.k === "write" && node === 0) {
        const lsn = log.length;
        log.push(p.key);
        commitAt.push(n.now);
        applied[0] = lsn;
        versions[0]!.set(p.key, lsn);
        for (let f = 1; f <= F; f++) n.send(0, f, { k: "entry", lsn, key: p.key, at: n.now });
        n.send(0, msg.from, { k: "wrote", lsn, op: p.op });
      } else if (p.k === "entry") {
        const at = Math.max(n.now + (cfg.delayMs[node - 1] ?? 0), lastApplyAt[node]! + (cfg.applyMs[node - 1] ?? 0));
        lastApplyAt[node] = at;
        n.setTimer(node, at - n.now, `apply:${p.lsn}`);
      } else if (p.k === "read") {
        if (applied[node]! >= p.token) answer(n, node, msg.from, p);
        else waiting[node]!.push({ replica: node, from: msg.from, p });
      } else if (p.k === "wrote" || p.k === "got") {
        const s = node - F - 1, st = sess[s]!;
        const op: SessionOp = p.k === "wrote"
          ? { session: s, kind: "write", key: st.key, replica: 0, start: st.start, end: n.now, version: p.lsn, applied: p.lsn }
          : { session: s, kind: "read", key: p.key, replica: msg.from, start: st.start, end: n.now, version: p.version, applied: p.applied };
        history.push(op);
        st.token = Math.max(st.token, p.k === "wrote" ? p.lsn : p.applied);
        n.setTimer(node, cfg.thinkMs * (0.5 + n.random()), "next");
      }
    },
    onTimer(node, tag, n) {
      if (tag === "next") next(n, node - F - 1);
      else if (tag.startsWith("apply:")) {
        const lsn = Number(tag.slice(6));
        applied[node] = lsn;
        versions[node]!.set(log[lsn]!, lsn);
        const still: typeof waiting[number] = [];
        for (const w of waiting[node]!) {
          if (applied[node]! >= w.p.token) answer(n, node, w.from, w.p);
          else still.push(w);
        }
        waiting[node] = still;
      }
    },
  });
  for (let s = 0; s < S; s++) net.setTimer(clientNode(s), 1 + s, "next");
  net.runAll();
  return { net, cfg, history, log };
}

export interface Anomaly {
  kind: "ryw" | "monotonic" | "prefix";
  op: SessionOp;
  /** The version that the read should have seen at least. */
  want: number;
}

/**
 * Checks each session's reads, using only what the session itself did and saw.
 * - read your writes: a read of key k returns a version older than the session's last finished write to k.
 * - monotonic reads: a read of k returns a version older than an earlier read of k by the session returned.
 * - consistent prefix: an earlier read of another key showed LSN j, and the log holds a write to k with an LSN
 *   above the returned version and at most j. The session saw a later write but misses an earlier one.
 */
export function checkAnomalies(history: SessionOp[], log: string[]): Anomaly[] {
  const out: Anomaly[] = [];
  const sessions = new Map<number, SessionOp[]>();
  for (const op of history) {
    if (!sessions.has(op.session)) sessions.set(op.session, []);
    sessions.get(op.session)!.push(op);
  }
  for (const ops of sessions.values()) {
    const wrote = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const op of ops) {
      if (op.kind === "write") {
        wrote.set(op.key, op.version);
        continue;
      }
      const w = wrote.get(op.key) ?? 0;
      if (op.version < w) out.push({ kind: "ryw", op, want: w });
      const m = seen.get(op.key) ?? 0;
      if (op.version < m) out.push({ kind: "monotonic", op, want: m });
      let j = 0;
      for (const [k, v] of seen) if (k !== op.key) j = Math.max(j, v);
      for (let lsn = j; lsn > op.version; lsn--) {
        if (log[lsn] === op.key) {
          out.push({ kind: "prefix", op, want: lsn });
          break;
        }
      }
      seen.set(op.key, Math.max(m, op.version));
    }
  }
  return out;
}

export interface FixSummary {
  fix: ReadFix;
  reads: number;
  ryw: number;
  monotonic: number;
  prefix: number;
  meanReadMs: number;
  p99ReadMs: number;
  leaderReads: number;
}

export function summarize(run: LagRun): FixSummary {
  const reads = run.history.filter((o) => o.kind === "read");
  const an = checkAnomalies(run.history, run.log);
  const lat = reads.map((o) => o.end - o.start).sort((a, b) => a - b);
  return {
    fix: run.cfg.fix,
    reads: reads.length,
    ryw: an.filter((a) => a.kind === "ryw").length,
    monotonic: an.filter((a) => a.kind === "monotonic").length,
    prefix: an.filter((a) => a.kind === "prefix").length,
    meanReadMs: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
    p99ReadMs: lat[Math.min(lat.length - 1, Math.floor(0.99 * lat.length))] ?? 0,
    leaderReads: reads.filter((o) => o.replica === 0).length / Math.max(1, reads.length),
  };
}

// ============================================================================ lag under a write burst

export interface BurstConfig {
  seed: number;
  /** Writes per second outside the burst and during it. */
  baseRate: number;
  burstRate: number;
  burstAt: number;
  burstMs: number;
  /** Replay cost per entry for each follower (model input), ms. */
  applyMs: number[];
  latency: { min: number; max: number };
  end: number;
  sampleEvery: number;
}

export const BURST_DEFAULTS: BurstConfig = {
  seed: 2,
  baseRate: 200,
  burstRate: 1500,
  burstAt: 200,
  burstMs: 300,
  applyMs: [0.8, 1.6],
  latency: { min: 1, max: 3 },
  end: 1600,
  sampleEvery: 10,
};

export interface BurstRun {
  /** [t, lag of follower 1, lag of follower 2, ...] in ms; lag is the age of the oldest change not yet applied. */
  samples: number[][];
  peak: number[];
  /** Time from the end of the burst until each follower has no lag left. NaN: not within the run. */
  catchUp: number[];
}

/** The leader commits writes at a fixed rate (it has many cores); each follower replays them one at a time. */
export function runBurst(cfg: BurstConfig = BURST_DEFAULTS): BurstRun {
  const F = cfg.applyMs.length;
  const commitAt: number[] = [0];
  const applied = new Array<number>(F + 1).fill(0);
  const lastApplyAt = new Array<number>(F + 1).fill(-Infinity);
  const samples: number[][] = [];
  const lagOf = (f: number, now: number) => (applied[f]! + 1 < commitAt.length ? now - commitAt[applied[f]! + 1]! : 0);
  const net = new Net<LagMsg>(F + 1, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onMessage(node, msg, n) {
      const p = msg.payload;
      if (p.k !== "entry") return;
      const at = Math.max(n.now, lastApplyAt[node]! + cfg.applyMs[node - 1]!);
      lastApplyAt[node] = at;
      n.setTimer(node, at - n.now, `apply:${p.lsn}`);
    },
    onTimer(node, tag, n) {
      if (tag === "write") {
        const lsn = commitAt.length;
        commitAt.push(n.now);
        for (let f = 1; f <= F; f++) n.send(0, f, { k: "entry", lsn, key: "x", at: n.now });
        const inBurst = n.now >= cfg.burstAt && n.now < cfg.burstAt + cfg.burstMs;
        const gap = 1000 / (inBurst ? cfg.burstRate : cfg.baseRate);
        if (n.now + gap <= cfg.end) n.setTimer(0, gap, "write");
      } else if (tag === "sample") {
        samples.push([n.now, ...Array.from({ length: F }, (_, i) => lagOf(i + 1, n.now))]);
        if (n.now + cfg.sampleEvery <= cfg.end) n.setTimer(0, cfg.sampleEvery, "sample");
      } else if (tag.startsWith("apply:")) applied[node] = Number(tag.slice(6));
    },
  });
  net.setTimer(0, 0, "write");
  net.setTimer(0, 0, "sample");
  net.runUntil(cfg.end);
  const burstEnd = cfg.burstAt + cfg.burstMs;
  const peak = Array.from({ length: F }, (_, i) => Math.max(...samples.map((s) => s[i + 1]!)));
  const catchUp = Array.from({ length: F }, (_, i) => {
    const s = samples.find((x) => x[0]! >= burstEnd && x[i + 1]! < 2 * 1000 / cfg.baseRate);
    return s ? s[0]! - burstEnd : NaN;
  });
  return { samples, peak, catchUp };
}

/**
 * The queue model behind the burst: a follower replays μ = 1000 / applyMs entries per second. During a burst of
 * rate λ > μ the backlog grows by (λ − μ) per second; after it, the backlog drains at (μ − base) per second.
 */
export function burstModel(cfg: BurstConfig, f: number) {
  const mu = 1000 / cfg.applyMs[f]!;
  const backlog = Math.max(0, (cfg.burstRate - mu) * (cfg.burstMs / 1000));
  const drainS = mu > cfg.baseRate ? backlog / (mu - cfg.baseRate) : Infinity;
  /** The lag peaks when the last burst entry is applied: it waited backlog / μ seconds. */
  return { mu, backlog, drainMs: drainS * 1000, peakLagMs: (backlog / mu) * 1000 };
}
