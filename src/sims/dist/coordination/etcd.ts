/**
 * An etcd-like store: a multi-version key-value map with one revision counter, leases, and watches that can start
 * from an old revision.
 *
 * - MvccStore: every change gets the next revision (a 64-bit counter in etcd; it starts at 1). Each key keeps
 *   create_revision, mod_revision and version. The history of events stays until a compaction removes the part
 *   below a revision. A lease has a TTL; when it expires, every key attached to it is deleted.
 * - watchRun: a writer (it updates 12 keys in turn), the server and one watcher on Net. The learner cuts the watcher off for a while. When the
 *   watcher sees the stream stall, it opens a new watch. It can resume from its last revision + 1 (correct), from its
 *   last revision (start_revision is inclusive, so one event comes twice), or from now (it misses the gap). If the
 *   server compacted the gap away, the watch is cancelled with compact_revision, and the watcher must read the
 *   current state again and watch from there.
 */
import { Net } from "../net";

export interface KeyValue {
  key: string;
  value: string;
  createRev: number;
  modRev: number;
  version: number;
  lease: number;
}

export interface MvccEvent {
  rev: number;
  type: "PUT" | "DELETE";
  key: string;
  value: string;
}

export class MvccStore {
  /** The revision of the last change. etcd starts an empty store at 1. */
  rev = 1;
  kv = new Map<string, KeyValue>();
  history: MvccEvent[] = [];
  /** Events below this revision are gone. 0: never compacted. */
  compactRev = 0;
  leases = new Map<number, { ttl: number; expires: number; keys: Set<string> }>();
  private nextLease = 1;

  put(key: string, value: string, lease = 0): MvccEvent {
    const rev = ++this.rev;
    const old = this.kv.get(key);
    if (old?.lease) this.leases.get(old.lease)?.keys.delete(key);
    this.kv.set(key, { key, value, createRev: old ? old.createRev : rev, modRev: rev, version: (old?.version ?? 0) + 1, lease });
    if (lease) this.leases.get(lease)?.keys.add(key);
    const ev: MvccEvent = { rev, type: "PUT", key, value };
    this.history.push(ev);
    return ev;
  }

  delete(key: string): MvccEvent | null {
    const old = this.kv.get(key);
    if (!old) return null;
    const rev = ++this.rev;
    this.kv.delete(key);
    if (old.lease) this.leases.get(old.lease)?.keys.delete(key);
    const ev: MvccEvent = { rev, type: "DELETE", key, value: "" };
    this.history.push(ev);
    return ev;
  }

  /** Removes history below `rev`. A watch from a lower revision then fails. */
  compact(rev: number) {
    if (rev <= this.compactRev) return;
    this.compactRev = Math.min(rev, this.rev);
    this.history = this.history.filter((e) => e.rev >= this.compactRev);
  }

  /** Events on keys with this prefix, from `startRev` (inclusive). */
  eventsFrom(prefix: string, startRev: number): { compacted: boolean; events: MvccEvent[] } {
    if (startRev > 0 && startRev < this.compactRev) return { compacted: true, events: [] };
    return { compacted: false, events: this.history.filter((e) => e.rev >= startRev && e.key.startsWith(prefix)) };
  }

  range(prefix: string): KeyValue[] {
    return [...this.kv.values()].filter((x) => x.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  // ---------------- leases (TTL by the server's clock, ms here; etcd's API uses seconds)

  grant(ttl: number, now: number): number {
    const id = this.nextLease++;
    this.leases.set(id, { ttl, expires: now + ttl, keys: new Set() });
    return id;
  }

  keepAlive(id: number, now: number): boolean {
    const l = this.leases.get(id);
    if (!l) return false;
    l.expires = now + l.ttl;
    return true;
  }

  /** Revokes expired leases and deletes their keys. Returns the delete events. */
  expireLeases(now: number): MvccEvent[] {
    const out: MvccEvent[] = [];
    for (const [id, l] of [...this.leases]) {
      if (now < l.expires) continue;
      for (const k of [...l.keys].sort()) {
        const ev = this.delete(k);
        if (ev) out.push(ev);
      }
      this.leases.delete(id);
    }
    return out;
  }
}

// ---------------------------------------------------------------- a watch over a flaky link

export type WatchMsg =
  | { k: "put"; key: string; value: string }
  | { k: "watch"; prefix: string; startRev: number; id: number }
  | { k: "created"; id: number; rev: number; seq: number }
  | { k: "events"; id: number; events: MvccEvent[]; seq: number }
  | { k: "progress"; id: number; rev: number; seq: number }
  | { k: "canceled"; id: number; compactRev: number }
  | { k: "get"; prefix: string }
  | { k: "kvs"; kvs: KeyValue[]; rev: number };

export type ResumeMode = "next" | "last" | "now";

export interface WatchCfg {
  seed: number;
  /** The writer puts this many values, one every `writeEvery` ms. */
  writes: number;
  writeEvery: number;
  /** Cuts between the watcher and the server: [from, to) in ms. */
  cuts: { from: number; to: number }[];
  resume: ResumeMode;
  /** The server keeps the last `keep` revisions of history (it compacts every 100 ms). Infinity: no compaction. */
  keep: number;
}

export const WATCH_DEFAULT: WatchCfg = { seed: 1, writes: 30, writeEvery: 40, cuts: [{ from: 300, to: 700 }], resume: "next", keep: Infinity };

export const W = { server: 0, writer: 1, watcher: 2 } as const;
/** The watcher treats the stream as broken after this long with no message; the server sends progress this often. */
export const STALL_MS = 150, PROGRESS_MS = 50, RETRY_MS = 60;
/** The writer cycles over this many keys, so a missed event can leave a key with an old value. */
export const KEYS = 12;

export interface WatchRun {
  net: Net<WatchMsg>;
  store: MvccStore;
  /** Revisions of the writer's events. */
  expected: number[];
  /** Revisions the watcher received, in order (with repeats). */
  received: number[];
  missed: number[];
  duplicates: number[];
  /** Times the watcher had to read the whole state again after a compacted watch. */
  relists: number;
  /** The watcher's copy of the data equals the server's at the end. */
  stateMatches: boolean;
  /** Real-time spans when the watcher believed its stream worked. */
  streams: { from: number; to: number; startRev: number }[];
  tEnd: number;
}

export function watchRun(cfg: Partial<WatchCfg> = {}): WatchRun {
  const c = { ...WATCH_DEFAULT, ...cfg };
  const store = new MvccStore();
  const PREFIX = "cfg/";
  const expected: number[] = [];
  const received: number[] = [];
  let relists = 0;
  // Server: watch streams by id.
  // Each stream numbers its messages, as a TCP connection does: a gap means the connection broke.
  const streams = new Map<number, { client: number; prefix: string; seq: number }>();
  // Watcher state.
  const w = { id: 0, lastRev: 0, heard: 0, healthy: false, local: new Map<string, string>(), waitingGet: false, seq: 0 };
  const spans: WatchRun["streams"] = [];

  const push = (ev: MvccEvent) => {
    for (const [id, s] of streams) if (ev.key.startsWith(s.prefix)) net.send(W.server, s.client, { k: "events", id, events: [ev], seq: s.seq++ });
  };

  const openWatch = () => {
    const startRev = c.resume === "next" ? (w.lastRev ? w.lastRev + 1 : 0) : c.resume === "last" ? w.lastRev : 0;
    w.id++;
    w.seq = 0;
    spans.push({ from: net.now, to: net.now, startRev });
    net.send(W.watcher, W.server, { k: "watch", prefix: PREFIX, startRev, id: w.id });
    net.setTimer(W.watcher, RETRY_MS, `retry:${w.id}`);
  };

  const apply = (ev: MvccEvent) => {
    received.push(ev.rev);
    w.lastRev = Math.max(w.lastRev, ev.rev);
    if (ev.type === "PUT") w.local.set(ev.key, ev.value);
    else w.local.delete(ev.key);
  };

  const net: Net<WatchMsg> = new Net<WatchMsg>(3, { seed: c.seed, latency: { min: 5, max: 15 }, fifo: true }, {
    onMessage(node, m) {
      const p = m.payload;
      if (node === W.server) {
        if (p.k === "put") {
          const ev = store.put(p.key, p.value);
          expected.push(ev.rev);
          push(ev);
        } else if (p.k === "watch") {
          for (const [id, s] of [...streams]) if (s.client === m.from) streams.delete(id); // a new stream replaces the old one
          const r = store.eventsFrom(p.prefix, p.startRev);
          if (r.compacted) return void net.send(W.server, m.from, { k: "canceled", id: p.id, compactRev: store.compactRev });
          const st = { client: m.from, prefix: p.prefix, seq: 0 };
          streams.set(p.id, st);
          net.send(W.server, m.from, { k: "created", id: p.id, rev: store.rev, seq: st.seq++ });
          if (p.startRev > 0 && r.events.length) net.send(W.server, m.from, { k: "events", id: p.id, events: r.events, seq: st.seq++ });
        } else if (p.k === "get") {
          net.send(W.server, m.from, { k: "kvs", kvs: store.range(p.prefix), rev: store.rev });
        }
        return;
      }
      if (node === W.watcher) {
        w.heard = net.now;
        if ((p.k === "created" || p.k === "events" || p.k === "progress") && p.id === w.id) {
          if (p.seq !== w.seq) {
            // A message of this stream was lost: the connection is broken. Open a new watch.
            if (w.healthy) { w.healthy = false; openWatch(); }
            return;
          }
          w.seq++;
        }
        if (p.k === "created" && p.id === w.id) {
          w.healthy = true;
          if (c.resume === "now" || !w.lastRev) w.lastRev = Math.max(w.lastRev, p.rev);
        } else if (p.k === "events" && p.id === w.id) {
          for (const ev of p.events) apply(ev);
        } else if (p.k === "canceled" && p.id === w.id && !w.waitingGet) {
          // The gap was compacted away: read the current state, then watch from after it.
          w.waitingGet = true;
          relists++;
          net.send(W.watcher, W.server, { k: "get", prefix: PREFIX });
        } else if (p.k === "kvs" && w.waitingGet) {
          w.waitingGet = false;
          w.local = new Map(p.kvs.map((x) => [x.key, x.value]));
          w.lastRev = p.rev;
          openWatch();
        }
        const s = spans[spans.length - 1];
        if (s && w.healthy) s.to = net.now;
      }
    },
    onTimer(node, tag) {
      if (node === W.writer && tag === "write") {
        const i = pendingWrites;
        pendingWrites++;
        net.send(W.writer, W.server, { k: "put", key: `${PREFIX}k${(i % KEYS) + 1}`, value: `v${i + 1}` });
        if (pendingWrites < c.writes) net.setTimer(W.writer, c.writeEvery, "write");
        return;
      }
      if (node === W.server) {
        if (tag === "progress") {
          for (const [id, s] of streams) net.send(W.server, s.client, { k: "progress", id, rev: store.rev, seq: s.seq++ });
          net.setTimer(W.server, PROGRESS_MS, "progress");
        } else if (tag === "compact") {
          if (Number.isFinite(c.keep)) store.compact(store.rev - c.keep + 1);
          net.setTimer(W.server, 100, "compact");
        } else if (tag.startsWith("cut:")) {
          const k = Number(tag.slice(4));
          if (k % 2 === 0) net.partition([[W.server, W.writer], [W.watcher]]);
          else net.heal();
        }
        return;
      }
      if (node === W.watcher) {
        if (tag === "check") {
          if (w.healthy && net.now - w.heard > STALL_MS) {
            w.healthy = false;
            openWatch();
          }
          net.setTimer(W.watcher, 25, "check");
        } else if (tag === "start") {
          openWatch();
        } else if (tag.startsWith("retry:") && Number(tag.slice(6)) === w.id && !w.healthy && !w.waitingGet) {
          openWatch();
        }
      }
    },
  });
  let pendingWrites = 0;
  net.setTimer(W.watcher, 1, "start");
  net.setTimer(W.watcher, 25, "check");
  net.setTimer(W.writer, 20, "write");
  net.setTimer(W.server, PROGRESS_MS, "progress");
  net.setTimer(W.server, 100, "compact");
  c.cuts.forEach((cut, k) => {
    net.setTimer(W.server, cut.from, `cut:${2 * k}`);
    net.setTimer(W.server, cut.to, `cut:${2 * k + 1}`);
  });
  const tEnd = Math.max(20 + c.writes * c.writeEvery, ...c.cuts.map((x) => x.to)) + 200;
  net.runUntil(tEnd);
  const seen = new Map<number, number>();
  for (const r of received) seen.set(r, (seen.get(r) ?? 0) + 1);
  const server = new Map(store.range(PREFIX).map((x) => [x.key, x.value]));
  const stateMatches = server.size === w.local.size && [...server].every(([k, val]) => w.local.get(k) === val);
  return {
    net, store, expected, received,
    missed: expected.filter((r) => !seen.has(r)),
    duplicates: [...seen].filter(([, n]) => n > 1).map(([r]) => r),
    relists, stateMatches, streams: spans, tEnd,
  };
}

/** True if the watcher got every expected revision exactly once, in increasing order. */
export const exactlyOnceInOrder = (r: WatchRun) =>
  r.received.length === r.expected.length && r.received.every((rev, i) => rev === r.expected[i]);
