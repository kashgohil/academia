/**
 * One Kafka-style partition with three replicas, on the shared Net. Node 0 is a producer, nodes 1 to 3 are brokers
 * that hold replicas, and node 4 is the controller.
 *
 * - The leader appends each produced record to its log. Followers pull: each sends Fetch(offset, last epoch) and
 *   appends what the leader returns. The fetch offset tells the leader how far that follower is (its LEO, log end
 *   offset).
 * - The in-sync replica set (ISR) holds the replicas that are caught up. A follower that has not reached the
 *   leader's LEO for `lagMax` ms leaves the ISR; one that reaches the high watermark comes back. The leader asks the
 *   controller to change the ISR (AlterPartition), and uses a smaller ISR only after the controller agrees.
 * - The high watermark (HW) is the smallest LEO in the ISR. Records below it are committed: consumers read only those.
 * - acks=0: the producer counts a record as sent at once. acks=1: the leader replies after its own append.
 *   acks=all: the leader replies when the HW passes the record, and only if the ISR has at least `minIsr` members;
 *   otherwise it rejects the record (NotEnoughReplicas).
 * - The controller watches broker heartbeats. When the leader dies, it picks the first live replica in the ISR. If
 *   none is alive, it picks any live replica if `unclean` is on, and otherwise leaves the partition offline until
 *   an ISR member comes back. Each new leader gets a new leader epoch.
 * - A follower whose log diverges from the new leader's truncates it, using the leader epochs of its last records
 *   (as Kafka does since KIP-101 and in KRaft fetches).
 *
 * All timings are MODEL INPUTS, scaled down so that a run fits on a screen: Kafka's replica.lag.time.max.ms is
 * 30 s by default, here `lagMax` is 60 ms. Logs survive a crash (the model does not lose unflushed data).
 */
import { Net } from "../net";

export type Acks = "0" | "1" | "all";

export interface RepLogConfig {
  seed: number;
  acks: Acks;
  minIsr: number;
  unclean: boolean;
  /** The producer sends one record every `produceEvery` ms, from t = produceEvery to `produceUntil`. */
  produceEvery: number;
  produceUntil: number;
  fetchEvery: number;
  lagMax: number;
  heartbeatEvery: number;
  sessionTimeout: number;
  latency: { min: number; max: number };
  horizon: number;
  /** Crashes and recoveries of brokers (1..3). Node ids are broker numbers. */
  crashes: { t: number; node: number }[];
  recovers: { t: number; node: number }[];
  /** Followers that stop fetching (a slow disk, a long pause) during [from, until). */
  stalls: { node: number; from: number; until: number }[];
}

export const REPLOG_DEFAULTS: RepLogConfig = {
  seed: 1, acks: "all", minIsr: 2, unclean: false, produceEvery: 20, produceUntil: 400,
  fetchEvery: 8, lagMax: 60, heartbeatEvery: 10, sessionTimeout: 40, latency: { min: 1, max: 3 }, horizon: 700,
  crashes: [], recovers: [], stalls: [],
};

export const PRODUCER = 0, CONTROLLER = 4;
export const BROKERS = [1, 2, 3];

export interface Rec { v: number; epoch: number }

type RMsg =
  | { k: "produce"; id: number; acks: Acks }
  | { k: "produce-resp"; id: number; ok: boolean; err?: string }
  | { k: "fetch"; epoch: number; offset: number; lastEpoch: number }
  | { k: "fetch-resp"; epoch: number; offset: number; recs: Rec[]; hw: number }
  | { k: "diverge"; epoch: number; truncateTo: number }
  | { k: "alter-isr"; epoch: number; isr: number[] }
  | { k: "isr-ok"; epoch: number; isr: number[] }
  | { k: "leader"; leader: number; epoch: number; isr: number[] }
  | { k: "hb" };

export interface Broker {
  log: Rec[];
  hw: number;
  epoch: number;
  leader: number;
  role: "leader" | "follower" | "none";
  /** Leader only: the ISR the controller agreed to, and members added but not yet confirmed. */
  isr: number[];
  adding: number[];
  replicaLeo: Record<number, number>;
  caughtUp: Record<number, number>;
  waiting: { id: number; offset: number }[];
  isrInFlight: boolean;
}

/** A snapshot of the partition for drawing. */
export interface RepFrame {
  t: number;
  brokers: { up: boolean; log: Rec[]; hw: number; role: Broker["role"]; epoch: number }[];
  isr: number[];
  leader: number;
  acked: number[];
  note?: string;
}

export interface RepLogRun {
  cfg: RepLogConfig;
  net: Net<RMsg>;
  frames: RepFrame[];
  sent: number[];
  /** Records the producer saw acknowledged, with the time. */
  acked: { id: number; t: number }[];
  rejected: { id: number; t: number; err: string }[];
  /** Acknowledged records that are not in the final leader's log. */
  lost: number[];
  /** Records that consumers could read (below some leader's HW) and that are gone at the end. */
  seenThenLost: number[];
  finalLeader: number;
  finalLog: Rec[];
  /** Leader changes: time, new leader (-1: offline), clean or not. */
  elections: { t: number; leader: number; clean: boolean }[];
  /** ISR changes the controller accepted. */
  isrChanges: { t: number; isr: number[] }[];
}

export function runRepLog(partial: Partial<RepLogConfig> = {}): RepLogRun {
  const cfg: RepLogConfig = { ...REPLOG_DEFAULTS, ...partial, latency: { ...REPLOG_DEFAULTS.latency, ...partial.latency } };
  const B: Record<number, Broker> = {};
  for (const b of BROKERS) B[b] = { log: [], hw: 0, epoch: 0, leader: 1, role: b === 1 ? "leader" : "follower", isr: [...BROKERS], adding: [], replicaLeo: {}, caughtUp: {}, waiting: [], isrInFlight: false };
  for (const f of [2, 3]) { B[1]!.replicaLeo[f] = 0; B[1]!.caughtUp[f] = 0; }
  const ctl = { leader: 1, epoch: 0, isr: [...BROKERS], lastHb: { 1: 0, 2: 0, 3: 0 } as Record<number, number>, alive: { 1: true, 2: true, 3: true } as Record<number, boolean> };
  const prod = { leader: 1, epoch: 0 };
  const sent: number[] = [];
  const acked: RepLogRun["acked"] = [];
  const rejected: RepLogRun["rejected"] = [];
  const elections: RepLogRun["elections"] = [];
  const isrChanges: RepLogRun["isrChanges"] = [];
  const committedEver = new Set<number>();
  const frames: RepFrame[] = [];
  let note: string | undefined;

  const stalled = (b: number, t: number) => cfg.stalls.some((s) => s.node === b && t >= s.from && t < s.until);
  const lastEpoch = (log: Rec[]) => (log.length ? log[log.length - 1]!.epoch : -1);

  /** The leader's view: HW over the ISR plus members being added (a larger set is the safe choice). */
  const advanceHw = (b: number, net: Net<RMsg>) => {
    const L = B[b]!;
    const members = [...new Set([...L.isr, ...L.adding])];
    const leo = Math.min(...members.map((m) => (m === b ? L.log.length : L.replicaLeo[m] ?? 0)));
    if (leo > L.hw) L.hw = leo;
    for (let o = 0; o < L.hw; o++) committedEver.add(L.log[o]!.v);
    const done = L.waiting.filter((w) => w.offset < L.hw);
    L.waiting = L.waiting.filter((w) => w.offset >= L.hw);
    for (const w of done) {
      if (L.isr.length < cfg.minIsr) net.send(b, PRODUCER, { k: "produce-resp", id: w.id, ok: false, err: "NotEnoughReplicasAfterAppend" });
      else net.send(b, PRODUCER, { k: "produce-resp", id: w.id, ok: true });
    }
  };

  const proposeIsr = (b: number, isr: number[], net: Net<RMsg>) => {
    const L = B[b]!;
    if (L.isrInFlight) return;
    L.isrInFlight = true;
    net.send(b, CONTROLLER, { k: "alter-isr", epoch: L.epoch, isr });
  };

  const sendFetch = (b: number, net: Net<RMsg>) => {
    const F = B[b]!;
    if (F.role !== "follower" || F.leader < 0) return;
    net.send(b, F.leader, { k: "fetch", epoch: F.epoch, offset: F.log.length, lastEpoch: lastEpoch(F.log) });
  };

  const announce = (net: Net<RMsg>) => {
    const m: RMsg = { k: "leader", leader: ctl.leader, epoch: ctl.epoch, isr: [...ctl.isr] };
    for (const b of BROKERS) net.send(CONTROLLER, b, m);
    net.send(CONTROLLER, PRODUCER, m);
  };

  const elect = (net: Net<RMsg>) => {
    const live = (b: number) => ctl.alive[b]!;
    const inIsr = ctl.isr.filter(live);
    let leader = -1, clean = true;
    if (inIsr.length) leader = inIsr[0]!;
    else if (cfg.unclean) {
      const any = BROKERS.filter(live);
      if (any.length) { leader = any[0]!; clean = false; }
    }
    if (leader === ctl.leader && leader >= 0) return;
    ctl.epoch++;
    ctl.leader = leader;
    if (leader >= 0) ctl.isr = clean ? inIsr : [leader];
    elections.push({ t: net.now, leader, clean });
    note = leader < 0 ? "no live ISR member: partition offline" : clean ? `controller elects broker ${leader} from the ISR` : `unclean election: broker ${leader} was not in the ISR`;
    isrChanges.push({ t: net.now, isr: [...ctl.isr] });
    announce(net);
  };

  const net = new Net<RMsg>(5, { seed: cfg.seed, latency: cfg.latency, fifo: true }, {
    onMessage(node, m, nt) {
      const p = m.payload;
      if (node === PRODUCER) {
        if (p.k === "produce-resp") {
          if (p.ok) acked.push({ id: p.id, t: nt.now });
          else rejected.push({ id: p.id, t: nt.now, err: p.err ?? "error" });
        } else if (p.k === "leader") {
          if (p.epoch > prod.epoch) { prod.epoch = p.epoch; prod.leader = p.leader; }
        }
        return;
      }
      if (node === CONTROLLER) {
        if (p.k === "hb") {
          ctl.lastHb[m.from] = nt.now;
          if (!ctl.alive[m.from]) {
            ctl.alive[m.from] = true;
            if (ctl.leader < 0) elect(nt);
            nt.send(CONTROLLER, m.from, { k: "leader", leader: ctl.leader, epoch: ctl.epoch, isr: [...ctl.isr] });
          }
        } else if (p.k === "alter-isr") {
          if (m.from === ctl.leader && p.epoch === ctl.epoch) {
            // Never add a dead broker back.
            ctl.isr = p.isr.filter((b) => ctl.alive[b] || b === ctl.leader);
            isrChanges.push({ t: nt.now, isr: [...ctl.isr] });
            nt.send(CONTROLLER, m.from, { k: "isr-ok", epoch: ctl.epoch, isr: [...ctl.isr] });
          } else nt.send(CONTROLLER, m.from, { k: "isr-ok", epoch: ctl.epoch, isr: [...ctl.isr] });
        }
        return;
      }
      const me = B[node]!;
      switch (p.k) {
        case "leader": {
          if (p.epoch <= me.epoch && !(p.epoch === me.epoch && me.role === "none")) return;
          const stay = me.role === "leader" && p.leader === node;
          me.epoch = p.epoch;
          me.leader = p.leader;
          me.isrInFlight = false;
          if (stay) {
            // Same leader, new partition epoch: the controller removed a dead follower from the ISR.
            me.isr = [...p.isr];
            me.adding = me.adding.filter((a) => !me.isr.includes(a));
            advanceHw(node, nt);
            return;
          }
          me.waiting = [];
          if (p.leader === node) {
            me.role = "leader";
            me.isr = [...p.isr];
            me.adding = [];
            for (const f of BROKERS) if (f !== node) { me.replicaLeo[f] = 0; me.caughtUp[f] = nt.now; }
            advanceHw(node, nt);
          } else {
            me.role = p.leader < 0 ? "none" : "follower";
            sendFetch(node, nt);
          }
          return;
        }
        case "produce": {
          if (me.role !== "leader") {
            if (p.acks !== "0") nt.send(node, PRODUCER, { k: "produce-resp", id: p.id, ok: false, err: "NotLeader" });
            return;
          }
          if (p.acks === "all" && me.isr.length < cfg.minIsr) {
            nt.send(node, PRODUCER, { k: "produce-resp", id: p.id, ok: false, err: "NotEnoughReplicas" });
            return;
          }
          me.log.push({ v: p.id, epoch: me.epoch });
          if (p.acks === "1") nt.send(node, PRODUCER, { k: "produce-resp", id: p.id, ok: true });
          else if (p.acks === "all") me.waiting.push({ id: p.id, offset: me.log.length - 1 });
          advanceHw(node, nt);
          return;
        }
        case "fetch": {
          if (me.role !== "leader" || p.epoch !== me.epoch) return;
          const f = m.from;
          // Divergence: the follower's last record is not at the same place in my log, with the same epoch.
          if (p.offset > me.log.length || (p.offset > 0 && me.log[p.offset - 1]!.epoch !== p.lastEpoch)) {
            let end = me.log.findIndex((r) => r.epoch > p.lastEpoch);
            if (end < 0) end = me.log.length;
            nt.send(node, f, { k: "diverge", epoch: me.epoch, truncateTo: Math.min(end, p.offset - 1) });
            return;
          }
          me.replicaLeo[f] = p.offset;
          if (p.offset >= me.log.length) me.caughtUp[f] = nt.now;
          if (!me.isr.includes(f) && !me.adding.includes(f) && p.offset >= me.hw && !me.isrInFlight) {
            me.adding.push(f);
            proposeIsr(node, [...me.isr, f], nt);
          }
          advanceHw(node, nt);
          nt.send(node, f, { k: "fetch-resp", epoch: me.epoch, offset: p.offset, recs: me.log.slice(p.offset), hw: me.hw });
          return;
        }
        case "fetch-resp": {
          if (me.role !== "follower" || p.epoch !== me.epoch || p.offset !== me.log.length) return;
          me.log.push(...p.recs);
          me.hw = Math.max(me.hw, Math.min(p.hw, me.log.length));
          nt.setTimer(node, cfg.fetchEvery, "fetch");
          return;
        }
        case "diverge": {
          if (me.role !== "follower" || p.epoch !== me.epoch) return;
          me.log.length = Math.max(0, Math.min(me.log.length, p.truncateTo));
          me.hw = Math.min(me.hw, me.log.length);
          sendFetch(node, nt);
          return;
        }
        case "isr-ok": {
          if (me.role !== "leader" || p.epoch !== me.epoch) return;
          me.isrInFlight = false;
          me.isr = [...p.isr];
          me.adding = me.adding.filter((a) => !me.isr.includes(a));
          advanceHw(node, nt);
          return;
        }
      }
    },
    onTimer(node, tag, nt) {
      if (node === PRODUCER && tag === "produce") {
        const id = sent.length + 1;
        sent.push(id);
        if (prod.leader < 0) rejected.push({ id, t: nt.now, err: "NoLeader" });
        else {
          nt.send(PRODUCER, prod.leader, { k: "produce", id, acks: cfg.acks });
          if (cfg.acks === "0") acked.push({ id, t: nt.now });
        }
        if (nt.now + cfg.produceEvery <= cfg.produceUntil) nt.setTimer(PRODUCER, cfg.produceEvery, "produce");
        return;
      }
      if (node === CONTROLLER && tag === "check") {
        nt.setTimer(CONTROLLER, cfg.heartbeatEvery, "check");
        let changed = false;
        for (const b of BROKERS) {
          if (ctl.alive[b] && nt.now - ctl.lastHb[b]! > cfg.sessionTimeout) {
            ctl.alive[b] = false;
            if (b === ctl.leader) elect(nt);
            else if (ctl.isr.includes(b) && ctl.isr.length > 1) {
              ctl.isr = ctl.isr.filter((x) => x !== b);
              changed = true;
            }
          }
        }
        if (changed) {
          ctl.epoch++; // a new partition epoch with the same leader
          isrChanges.push({ t: nt.now, isr: [...ctl.isr] });
          announce(nt);
        }
        return;
      }
      if (node === CONTROLLER) return;
      const me = B[node]!;
      if (tag === "hb") {
        nt.setTimer(node, cfg.heartbeatEvery, "hb");
        nt.send(node, CONTROLLER, { k: "hb" });
      } else if (tag === "fetch") {
        if (stalled(node, nt.now)) nt.setTimer(node, cfg.fetchEvery, "fetch");
        else sendFetch(node, nt);
      } else if (tag === "refetch") {
        // A safety net: if a fetch or its reply was lost to a crash, fetch again.
        nt.setTimer(node, 4 * cfg.fetchEvery, "refetch");
        if (me.role === "follower" && !stalled(node, nt.now)) sendFetch(node, nt);
      } else if (tag === "isr-check" && me.role === "leader") {
        const stale = me.isr.filter((f) => f !== node && nt.now - (me.caughtUp[f] ?? 0) > cfg.lagMax);
        if (stale.length) proposeIsr(node, me.isr.filter((f) => !stale.includes(f)), nt);
      }
      if (tag === "isr-check") nt.setTimer(node, cfg.heartbeatEvery, "isr-check");
    },
    onRecover(node, nt) {
      const me = B[node];
      if (!me) return;
      me.role = "none";
      me.waiting = [];
      me.isrInFlight = false;
      nt.setTimer(node, 0, "hb");
      nt.setTimer(node, cfg.heartbeatEvery, "isr-check");
      nt.setTimer(node, 4 * cfg.fetchEvery, "refetch");
    },
  });

  // Every broker sends heartbeats; followers fetch; the leader checks its ISR. The controller checks heartbeats.
  for (const b of BROKERS) {
    net.setTimer(b, 0, "hb");
    net.setTimer(b, cfg.heartbeatEvery, "isr-check");
    net.setTimer(b, 4 * cfg.fetchEvery, "refetch");
    if (b !== 1) net.setTimer(b, 1, "fetch");
  }
  net.setTimer(CONTROLLER, cfg.heartbeatEvery, "check");
  net.setTimer(PRODUCER, cfg.produceEvery, "produce");

  const events = [
    ...cfg.crashes.map((c) => ({ t: c.t, run: () => { net.crash(c.node); note = `broker ${c.node} crashes`; } })),
    ...cfg.recovers.map((c) => ({ t: c.t, run: () => { net.recover(c.node); note = `broker ${c.node} restarts`; } })),
  ].sort((a, b) => a.t - b.t);

  const snap = () => {
    frames.push({
      t: net.now,
      brokers: BROKERS.map((b) => ({ up: net.isUp(b), log: B[b]!.log.slice(), hw: B[b]!.hw, role: B[b]!.role, epoch: B[b]!.epoch })),
      isr: [...ctl.isr], leader: ctl.leader, acked: acked.map((a) => a.id), note,
    });
    note = undefined;
  };
  const FRAME = 5;
  let ei = 0;
  for (let t = 0; t <= cfg.horizon; t += FRAME) {
    while (ei < events.length && events[ei]!.t <= t) {
      net.runUntil(events[ei]!.t);
      events[ei]!.run();
      ei++;
    }
    net.runUntil(t);
    snap();
  }

  const finalLeader = ctl.leader;
  const ref = finalLeader >= 0 ? B[finalLeader]! : BROKERS.map((b) => B[b]!).sort((a, b) => b.log.length - a.log.length)[0]!;
  const finalLog = ref.log.slice();
  const have = new Set(finalLog.map((r) => r.v));
  const lost = acked.map((a) => a.id).filter((id) => !have.has(id));
  const seenThenLost = [...committedEver].filter((id) => !have.has(id)).sort((a, b) => a - b);
  return { cfg, net, frames, sent, acked, rejected, lost, seenThenLost, finalLeader, finalLog, elections, isrChanges };
}
