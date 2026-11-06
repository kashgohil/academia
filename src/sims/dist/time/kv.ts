/**
 * A replicated key-value store for one key (a shopping cart), on the shared Net. Two replicas and two clients.
 * A client reads (it gets every sibling value and a causal context), adds an item to the union of what it read, and
 * writes back with that context. Replicas exchange state with "sync". Three ways to track versions:
 *
 * - "lww": last write wins by the client's wall-clock timestamp. Concurrent writes lose data.
 * - "vv": each value carries a version vector with one entry per replica (no dots). When two clients write through
 *   the same replica with the same context, the second vector dominates the first, so a concurrent write is lost.
 * - "dvv": dotted version vectors (Preguiça et al. 2010; Riak 2.0 and later). Each sibling carries one dot
 *   (replica, counter) for the write that made it, and the key has one vector for its whole causal history. A write
 *   removes exactly the siblings that its context has seen, so concurrent writes stay as siblings.
 */
import { Net } from "../net";
import { vcMerge, vcLeq, type VC } from "./vector";

export type KvMode = "lww" | "vv" | "dvv";
export const REPLICAS = 2;
export const CLIENTS = 2;
/** Net node of replica r and of client c. */
export const replicaNode = (r: number) => r;
export const clientNode = (c: number) => REPLICAS + c;

/** A value is a set of cart items, kept sorted. */
export type Cart = string[];
export const cartUnion = (...cs: Cart[]): Cart => [...new Set(cs.flat())].sort();

interface Sib { v: Cart; dot: [number, number]; vv: VC; ts: number }
interface Replica { sibs: Sib[]; vv: VC }
/** What a read returns: siblings and the context to pass back on a write. */
export interface ReadResult { values: Cart[]; ctx: VC; ts: number }

type KvMsg =
  | { k: "get" }
  | { k: "got"; r: ReadResult }
  | { k: "put"; v: Cart; ctx: VC; ts: number }
  | { k: "ok" }
  | { k: "sync"; sibs: Sib[]; vv: VC };

export type KvAction =
  | { k: "read"; c: number; r: number }
  | { k: "write"; c: number; r: number; item: string }
  | { k: "sync"; from: number; to: number };

export interface KvState {
  net: Net<KvMsg>;
  replicas: { values: Cart[]; vv: VC; dots: ([number, number] | null)[] }[];
  clients: { read: ReadResult | null }[];
  /** Items that some write added. An item that is in no replica after a full sync is lost. */
  added: string[];
  /** Per action, a sentence that says what happened. */
  log: string[];
}

const zero = (): VC => new Array<number>(REPLICAS).fill(0);

/** Applies a write with context ctx at replica r. */
function applyPut(mode: KvMode, rep: Replica, r: number, v: Cart, ctx: VC, ts: number) {
  if (mode === "lww") {
    const cur = rep.sibs[0];
    if (!cur || ts > cur.ts) rep.sibs = [{ v, dot: [r, 0], vv: zero(), ts }];
    return;
  }
  const counter = (mode === "dvv" ? rep.vv[r]! : Math.max(0, ...rep.sibs.map((s) => s.vv[r]!))) + 1;
  if (mode === "dvv") {
    // Keep a sibling if the context has not seen its dot.
    rep.sibs = rep.sibs.filter((s) => ctx[s.dot[0]]! < s.dot[1]);
    rep.vv = vcMerge(rep.vv, ctx);
    rep.vv[r] = counter;
    rep.sibs.push({ v, dot: [r, counter], vv: [], ts });
  } else {
    const vv = vcMerge(ctx, zero());
    vv[r] = counter;
    // Remove every sibling whose vector the new one dominates.
    rep.sibs = rep.sibs.filter((s) => !vcLeq(s.vv, vv));
    rep.sibs.push({ v, dot: [r, counter], vv, ts });
  }
}

function applySync(mode: KvMode, rep: Replica, sibs: Sib[], vv: VC) {
  if (mode === "lww") {
    const a = rep.sibs[0], b = sibs[0];
    if (b && (!a || b.ts > a.ts)) rep.sibs = [b];
    return;
  }
  if (mode === "dvv") {
    const same = (x: Sib, y: Sib) => x.dot[0] === y.dot[0] && x.dot[1] === y.dot[1];
    const keepMine = rep.sibs.filter((s) => sibs.some((t) => same(s, t)) || vv[s.dot[0]]! < s.dot[1]);
    const theirs = sibs.filter((t) => !rep.sibs.some((s) => same(s, t)) && rep.vv[t.dot[0]]! < t.dot[1]);
    rep.sibs = [...keepMine, ...theirs.map((t) => ({ ...t }))];
    rep.vv = vcMerge(rep.vv, vv);
  } else {
    const all = [...rep.sibs, ...sibs.map((t) => ({ ...t, vv: [...t.vv] }))];
    const uniq = all.filter((s, i) => all.findIndex((t) => t.vv.join() === s.vv.join()) === i);
    rep.sibs = uniq.filter((s) => !uniq.some((t) => t !== s && vcLeq(s.vv, t.vv) && t.vv.join() !== s.vv.join()));
  }
}

function readOf(mode: KvMode, rep: Replica): ReadResult {
  const ctx = mode === "dvv" ? [...rep.vv] : rep.sibs.reduce((a, s) => vcMerge(a, s.vv), zero());
  return { values: rep.sibs.map((s) => s.v), ctx, ts: Math.max(0, ...rep.sibs.map((s) => s.ts)) };
}

/**
 * Replays a list of actions from the start. Each action sends its messages and runs the Net until it is quiet, so
 * actions do not overlap in time. Client c's clock has offset `clientOffset[c]` ms, which matters only for lww.
 */
export function kvReplay(mode: KvMode, actions: KvAction[], { seed = 1, clientOffset = [0, 0] }: { seed?: number; clientOffset?: number[] } = {}): KvState {
  const reps: Replica[] = Array.from({ length: REPLICAS }, () => ({ sibs: [], vv: zero() }));
  const clients: KvState["clients"] = Array.from({ length: CLIENTS }, () => ({ read: null }));
  const log: string[] = [];
  const added: string[] = [];
  const net: Net<KvMsg> = new Net<KvMsg>(REPLICAS + CLIENTS, { seed, latency: { min: 4, max: 8 } }, {
    onMessage(node, m, x) {
      const p = m.payload;
      if (node < REPLICAS) {
        const rep = reps[node]!;
        if (p.k === "get") x.send(node, m.from, { k: "got", r: readOf(mode, rep) });
        else if (p.k === "put") { applyPut(mode, rep, node, p.v, p.ctx, p.ts); x.send(node, m.from, { k: "ok" }); }
        else if (p.k === "sync") applySync(mode, rep, p.sibs, p.vv);
      } else if (p.k === "got") clients[node - REPLICAS]!.read = p.r;
    },
  });
  for (let c = 0; c < CLIENTS; c++) net.offset[clientNode(c)] = clientOffset[c] ?? 0;
  for (const a of actions) {
    if (a.k === "read") {
      net.send(clientNode(a.c), replicaNode(a.r), { k: "get" });
      net.runAll();
      const r = clients[a.c]!.read!;
      log.push(`C${a.c + 1} reads R${a.r + 1}: ${r.values.length === 0 ? "nothing" : r.values.length === 1 ? "one value" : `${r.values.length} siblings`}.`);
    } else if (a.k === "write") {
      const read = clients[a.c]!.read;
      const v = cartUnion(...(read?.values ?? []), [a.item]);
      added.push(a.item);
      net.send(clientNode(a.c), replicaNode(a.r), { k: "put", v, ctx: read ? [...read.ctx] : zero(), ts: net.clock(clientNode(a.c)) });
      net.runAll();
      log.push(`C${a.c + 1} writes {${v.join(", ")}} to R${a.r + 1}${read && read.values.length > 1 ? `, which merges ${read.values.length} siblings` : ""}.`);
    } else {
      const rep = reps[a.from]!;
      net.send(replicaNode(a.from), replicaNode(a.to), { k: "sync", sibs: rep.sibs.map((s) => ({ ...s, vv: [...s.vv] })), vv: [...rep.vv] });
      net.runAll();
      log.push(`R${a.from + 1} sends its state to R${a.to + 1}.`);
    }
    // Give each action its own slot of time on the diagram.
    net.runUntil(net.now + 10);
  }
  return {
    net,
    replicas: reps.map((r) => ({ values: r.sibs.map((s) => s.v), vv: mode === "dvv" ? [...r.vv] : r.sibs.reduce((a, s) => vcMerge(a, s.vv), zero()), dots: r.sibs.map((s) => (mode === "lww" ? null : s.dot)) })),
    clients,
    added,
    log,
  };
}

/** Items added by some write that no replica holds in any sibling. */
export function lostItems(s: KvState): string[] {
  const have = new Set(s.replicas.flatMap((r) => r.values.flat()));
  return s.added.filter((i) => !have.has(i));
}

/** The scenario of the lesson: both clients read the empty cart, then both add an item through replica 1. */
export const KV_CONCURRENT: KvAction[] = [
  { k: "read", c: 0, r: 0 },
  { k: "read", c: 1, r: 0 },
  { k: "write", c: 0, r: 0, item: "milk" },
  { k: "write", c: 1, r: 0, item: "eggs" },
];
