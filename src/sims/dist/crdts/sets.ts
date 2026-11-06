/**
 * Replicated sets and maps, state-based (Shapiro, Preguiça, Baquero, Zawirski 2011, and the INRIA report RR-7506).
 *
 * - G-Set (lattice.ts): add only. Merge = union.
 * - 2P-Set: a G-Set of adds A and a G-Set of removes R (the tombstones). e is in the set if e ∈ A and e ∉ R.
 *   A removed element can never come back.
 * - LWW-element-Set: per element, the latest add time and the latest remove time. e is in the set if its add is
 *   later. Ties go to add here. A clock that runs ahead wins every race.
 * - OR-Set (observed-remove): every add makes a unique tag. A remove moves the tags that it has observed to the
 *   tombstones. e is in the set if some tag of e is not a tombstone. A concurrent add has a tag that the remove did
 *   not see, so the add wins.
 * - Optimized OR-Set (Bieniusa et al. 2012, the idea behind Riak's ORSWOT): tags are dots (replica, counter), and
 *   each replica keeps a version vector of the dots it has seen. A dot that the other side has seen but does not
 *   hold was removed there. So no tombstones are needed: the metadata is one vector entry per replica.
 * - OR-Map: keys form an OR-Set, and each key holds a nested CRDT (a PN-Counter here).
 *
 * The tombstone run gossips full states on Net and measures metadata over time, with and without garbage
 * collection at causal stability.
 */
import { Net } from "../net";
import { vcMerge, vcZero, type VC } from "../time/vector";
import { pnCounter, type PNCounter } from "./lattice";

export interface SetCrdt<S> {
  name: string;
  init(n: number): S;
  /** `time` is the replica's clock, for LWW. */
  add(s: S, r: number, e: string, time: number): S;
  /** Returns the same state if the remove is not allowed (2P-Set: e is not in the local set). */
  rmv(s: S, r: number, e: string, time: number): S;
  merge(a: S, b: S): S;
  elements(s: S): string[];
  /** Metadata items: tombstones, timestamps or tags. */
  meta(s: S): number;
  /** Equal states, for the convergence tests. */
  key(s: S): string;
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

// ---------------------------------------------------------------- 2P-Set

export interface TwoP { a: string[]; r: string[] }
export const twoPSet: SetCrdt<TwoP> = {
  name: "2P-Set",
  init: () => ({ a: [], r: [] }),
  add: (s, _r, e) => ({ a: sorted([...s.a, e]), r: s.r }),
  rmv: (s, _r, e) => (s.a.includes(e) && !s.r.includes(e) ? { a: s.a, r: sorted([...s.r, e]) } : s),
  merge: (x, y) => ({ a: sorted([...x.a, ...y.a]), r: sorted([...x.r, ...y.r]) }),
  elements: (s) => s.a.filter((e) => !s.r.includes(e)),
  meta: (s) => s.r.length,
  key: (s) => JSON.stringify(s),
};

// ---------------------------------------------------------------- LWW-element-Set

/** e -> [last add time, last remove time]; -Infinity is "never". A stamp is time + replica / 1000 to break ties. */
export type LwwSet = Record<string, [number, number]>;
const stamp = (time: number, r: number) => time + r / 1000;
export const lwwSet: SetCrdt<LwwSet> = {
  name: "LWW-element-Set",
  init: () => ({}),
  add: (s, r, e, time) => ({ ...s, [e]: [Math.max(s[e]?.[0] ?? -Infinity, stamp(time, r)), s[e]?.[1] ?? -Infinity] }),
  rmv: (s, r, e, time) => ({ ...s, [e]: [s[e]?.[0] ?? -Infinity, Math.max(s[e]?.[1] ?? -Infinity, stamp(time, r))] }),
  merge: (x, y) => {
    const out: LwwSet = { ...x };
    for (const [e, [a, d]] of Object.entries(y)) out[e] = [Math.max(out[e]?.[0] ?? -Infinity, a), Math.max(out[e]?.[1] ?? -Infinity, d)];
    return out;
  },
  elements: (s) => Object.keys(s).filter((e) => s[e]![0] >= s[e]![1]).sort(),
  meta: (s) => Object.values(s).filter(([, d]) => d > -Infinity).length,
  key: (s) => JSON.stringify(Object.keys(s).sort().map((e) => [e, s[e]])),
};

// ---------------------------------------------------------------- OR-Set with tombstones

/** adds: tag -> element; tombs: removed tags. A tag is "replica.counter", unique per add. */
export interface OrSet { adds: Record<string, string>; tombs: string[]; next: number[] }
export const orSet: SetCrdt<OrSet> = {
  name: "OR-Set",
  init: (n) => ({ adds: {}, tombs: [], next: new Array<number>(n).fill(0) }),
  add: (s, r, e) => {
    const next = s.next.map((x, i) => (i === r ? x + 1 : x));
    return { adds: { ...s.adds, [`${r + 1}.${next[r]}`]: e }, tombs: s.tombs, next };
  },
  rmv: (s, _r, e) => {
    const seen = Object.keys(s.adds).filter((t) => s.adds[t] === e && !s.tombs.includes(t));
    return seen.length ? { ...s, tombs: sorted([...s.tombs, ...seen]) } : s;
  },
  merge: (x, y) => ({ adds: { ...x.adds, ...y.adds }, tombs: sorted([...x.tombs, ...y.tombs]), next: vcMerge(x.next, y.next) }),
  elements: (s) => sorted(Object.keys(s.adds).filter((t) => !s.tombs.includes(t)).map((t) => s.adds[t]!)),
  meta: (s) => s.tombs.length,
  key: (s) => JSON.stringify([Object.keys(s.adds).sort().map((t) => [t, s.adds[t]]), s.tombs]),
};
/** The live tags of e in an OR-Set. */
export const orLiveTags = (s: OrSet, e: string) => Object.keys(s.adds).filter((t) => s.adds[t] === e && !s.tombs.includes(t)).sort();

// ---------------------------------------------------------------- optimized OR-Set (dots and a version vector)

/** dots: "replica.counter" -> element, only live ones. vv: the dots seen, per replica. */
export interface Orswot { dots: Record<string, string>; vv: VC }
const dotOf = (d: string) => d.split(".").map(Number) as [number, number];
const covered = (vv: VC, d: string) => { const [r, c] = dotOf(d); return c <= vv[r - 1]!; };
export const orswot: SetCrdt<Orswot> = {
  name: "Optimized OR-Set",
  init: (n) => ({ dots: {}, vv: vcZero(n) }),
  add: (s, r, e) => {
    const vv = s.vv.map((x, i) => (i === r ? x + 1 : x));
    return { dots: { ...s.dots, [`${r + 1}.${vv[r]}`]: e }, vv };
  },
  rmv: (s, _r, e) => ({ dots: Object.fromEntries(Object.entries(s.dots).filter(([, x]) => x !== e)), vv: s.vv }),
  merge: (x, y) => {
    const dots: Record<string, string> = {};
    // Keep a dot that both hold, or that the other side has not seen yet. A dot that the other side has seen but
    // does not hold was removed there.
    for (const [d, e] of Object.entries(x.dots)) if (d in y.dots || !covered(y.vv, d)) dots[d] = e;
    for (const [d, e] of Object.entries(y.dots)) if (!(d in x.dots) && !covered(x.vv, d)) dots[d] = e;
    return { dots, vv: vcMerge(x.vv, y.vv) };
  },
  elements: (s) => sorted(Object.values(s.dots)),
  meta: (s) => s.vv.length,
  key: (s) => JSON.stringify([Object.keys(s.dots).sort().map((d) => [d, s.dots[d]]), s.vv]),
};

export const SET_TYPES = { twoP: twoPSet, lww: lwwSet, or: orSet, orswot } as const;

// ---------------------------------------------------------------- the playground

export type SetAction = { k: "add" | "rmv"; r: number; e: string } | { k: "sync" };

export interface PlayResult<S> {
  /** Per replica, after the last action. */
  states: S[];
  /** After a final sync of both replicas. */
  merged: S;
  /** Per action, true if it changed nothing (a remove that the type does not allow). */
  ignored: boolean[];
}

/**
 * Two replicas. Action k happens at time 10·k on the replica's clock, plus `skew[r]` ms (a clock that runs ahead).
 * "sync" merges both states into both replicas.
 */
export function playSet<S>(c: SetCrdt<S>, actions: SetAction[], skew: [number, number] = [0, 0]): PlayResult<S> {
  const states: S[] = [c.init(2), c.init(2)];
  const ignored: boolean[] = [];
  actions.forEach((a, k) => {
    if (a.k === "sync") {
      const m = c.merge(states[0]!, states[1]!);
      states[0] = m;
      states[1] = m;
      ignored.push(false);
      return;
    }
    const t = 10 * (k + 1) + skew[a.r]!;
    const before = states[a.r]!;
    states[a.r] = a.k === "add" ? c.add(before, a.r, a.e, t) : c.rmv(before, a.r, a.e, t);
    ignored.push(c.key(before) === c.key(states[a.r]!));
  });
  return { states, merged: c.merge(states[0]!, states[1]!), ignored };
}

export const SET_PRESETS: { id: string; name: string; actions: SetAction[] }[] = [
  { id: "race", name: "concurrent add and remove", actions: [{ k: "add", r: 0, e: "x" }, { k: "sync" }, { k: "rmv", r: 0, e: "x" }, { k: "add", r: 1, e: "x" }] },
  { id: "readd", name: "remove, then add again", actions: [{ k: "add", r: 0, e: "x" }, { k: "sync" }, { k: "rmv", r: 1, e: "x" }, { k: "sync" }, { k: "add", r: 0, e: "x" }] },
  { id: "late", name: "remove after a late add", actions: [{ k: "add", r: 0, e: "x" }, { k: "sync" }, { k: "add", r: 1, e: "x" }, { k: "rmv", r: 0, e: "x" }] },
];

// ---------------------------------------------------------------- OR-Map with nested counters

/** Keys are an OR-Set; each key holds a PN-Counter. Removing a key hides it but keeps its counter state. */
export interface OrMap { keys: OrSet; vals: Record<string, PNCounter> }
export const orMap = {
  init: (n: number): OrMap => ({ keys: orSet.init(n), vals: {} }),
  /** Adds d to the counter of key, and makes the key present (an update re-adds a removed key). */
  update: (s: OrMap, r: number, key: string, d: number, n: number): OrMap => ({
    keys: orSet.add(s.keys, r, key, 0),
    vals: { ...s.vals, [key]: pnCounter.update(s.vals[key] ?? pnCounter.init(n), r, d, 0) },
  }),
  remove: (s: OrMap, r: number, key: string): OrMap => ({ keys: orSet.rmv(s.keys, r, key, 0), vals: s.vals }),
  merge: (a: OrMap, b: OrMap): OrMap => {
    const vals: Record<string, PNCounter> = { ...a.vals };
    for (const [k, v] of Object.entries(b.vals)) vals[k] = vals[k] ? pnCounter.merge(vals[k]!, v) : v;
    return { keys: orSet.merge(a.keys, b.keys), vals };
  },
  value: (s: OrMap): Record<string, number> => Object.fromEntries(orSet.elements(s.keys).map((k) => [k, pnCounter.value(s.vals[k]!)])),
  key: (s: OrMap) => JSON.stringify([orSet.key(s.keys), Object.keys(s.vals).sort().map((k) => [k, s.vals[k]])]),
};

// ---------------------------------------------------------------- tombstones over time, and GC at causal stability

export type TombMode = "keep" | "gc" | "orswot";

export interface TombConfig {
  seed: number;
  n: number;
  /** Updates per second over all replicas. */
  rate: number;
  tEnd: number;
  period: number;
  /** Cut the last replica off in [cutFrom, cutTo) ms; null: never. */
  cut: [number, number] | null;
  items: number;
}

export const DEFAULT_TOMB: TombConfig = { seed: 2, n: 3, rate: 50, tEnd: 4000, period: 40, cut: null, items: 12 };

/** The classic OR-Set, plus the remove event of each tombstone and a vector of events seen, for GC. */
interface GcState { s: OrSet; rmOf: Record<string, string>; vv: VC }

export interface TombRun {
  cfg: TombConfig;
  mode: TombMode;
  /** Samples every 50 ms: [time, metadata items at replica 1, live elements at replica 1]. */
  samples: [number, number, number][];
  /** All replicas hold the same elements at the end (after the run heals and quiets down). */
  converged: boolean;
  removes: number;
  adds: number;
  finalMeta: number;
}

export function runTombstones(mode: TombMode, partial: Partial<TombConfig> = {}): TombRun {
  const cfg = { ...DEFAULT_TOMB, ...partial };
  const N = cfg.n;
  const gc: GcState[] = Array.from({ length: N }, () => ({ s: orSet.init(N), rmOf: {}, vv: vcZero(N) }));
  const ow: Orswot[] = Array.from({ length: N }, () => orswot.init(N));
  /** known[i][j]: the event vector of j that i has seen on j's messages. */
  const known: VC[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => vcZero(N)));
  const elements = (i: number) => (mode === "orswot" ? orswot.elements(ow[i]!) : orSet.elements(gc[i]!.s));
  const meta = (i: number) => (mode === "orswot" ? orswot.meta(ow[i]!) : gc[i]!.s.tombs.length);
  let adds = 0, removes = 0;

  const collect = (i: number) => {
    if (mode !== "gc") return;
    const g = gc[i]!;
    const rows = known[i]!.map((r, j) => (j === i ? g.vv : r));
    const stable = (d: string) => { const [o, c] = dotOf(d); return rows.every((r) => r[o - 1]! >= c); };
    const keep = g.s.tombs.filter((t) => !stable(g.rmOf[t]!));
    if (keep.length === g.s.tombs.length) return;
    const drop = g.s.tombs.filter((t) => !keep.includes(t));
    const adds2 = { ...g.s.adds };
    const rmOf = { ...g.rmOf };
    for (const t of drop) { delete adds2[t]; delete rmOf[t]; }
    gc[i] = { s: { ...g.s, adds: adds2, tombs: keep }, rmOf, vv: g.vv };
  };

  type M = { g?: GcState; o?: Orswot };
  const net = new Net<M>(N, { seed: cfg.seed, latency: { min: 4, max: 20 }, fifo: true }, {
    onMessage(i, m) {
      const p = m.payload;
      if (p.o) ow[i] = orswot.merge(ow[i]!, p.o);
      if (p.g) {
        const a = gc[i]!, b = p.g;
        // FIFO links matter here: once i knows that j has seen a remove, no older state of j, with the tag still
        // live, can arrive later and bring a collected tag back.
        gc[i] = { s: orSet.merge(a.s, b.s), rmOf: { ...a.rmOf, ...b.rmOf }, vv: vcMerge(a.vv, b.vv) };
        const row = known[i]![m.from]!;
        b.vv.forEach((x, k) => (row[k] = Math.max(row[k]!, x)));
        collect(i);
      }
    },
    onTimer(i, tag, net) {
      if (tag === "gossip") {
        let j = Math.floor(net.random() * (N - 1));
        if (j >= i) j++;
        net.send(i, j, mode === "orswot" ? { o: ow[i] } : { g: gc[i] });
        net.setTimer(i, cfg.period, "gossip");
        return;
      }
      if (tag === "cut") net.partition([Array.from({ length: N - 1 }, (_, k) => k), [N - 1]]);
      if (tag === "heal") net.heal();
      if (tag !== "op" || net.now >= cfg.tEnd * 0.8) return;
      // One update at a random replica: remove a live element, or add one from the pool.
      const live = elements(i);
      if (live.length && net.random() < 0.5) {
        const e = live[Math.floor(net.random() * live.length)]!;
        removes++;
        if (mode === "orswot") ow[i] = orswot.rmv(ow[i]!, i, e, 0);
        else {
          const g = gc[i]!;
          const vv = g.vv.map((x, k) => (k === i ? x + 1 : x));
          const tags = orLiveTags(g.s, e);
          const rmOf = { ...g.rmOf };
          for (const t of tags) rmOf[t] = `${i + 1}.${vv[i]}`;
          gc[i] = { s: orSet.rmv(g.s, i, e, 0), rmOf, vv };
        }
      } else {
        const e = `i${Math.floor(net.random() * cfg.items)}`;
        adds++;
        if (mode === "orswot") ow[i] = orswot.add(ow[i]!, i, e, 0);
        else {
          const g = gc[i]!;
          gc[i] = { s: orSet.add(g.s, i, e, 0), rmOf: g.rmOf, vv: g.vv.map((x, k) => (k === i ? x + 1 : x)) };
        }
      }
      net.setTimer(Math.floor(net.random() * N), -Math.log(1 - net.random()) * (1000 / cfg.rate), "op");
    },
  });
  for (let i = 0; i < N; i++) net.setTimer(i, (cfg.period * (i + 1)) / N, "gossip");
  net.setTimer(0, 1, "op");
  if (cfg.cut) {
    net.setTimer(0, cfg.cut[0], "cut");
    net.setTimer(0, Math.min(cfg.cut[1], cfg.tEnd * 0.8), "heal");
  }
  const samples: [number, number, number][] = [];
  for (let t = 0; t <= cfg.tEnd; t += 50) {
    net.runUntil(t);
    samples.push([t, meta(0), elements(0).length]);
  }
  const ref = JSON.stringify(elements(0));
  return { cfg, mode, samples, converged: Array.from({ length: N }, (_, i) => JSON.stringify(elements(i)) === ref).every(Boolean), adds, removes, finalMeta: meta(0) };
}
