/**
 * State-based CRDTs as join-semilattices (Shapiro, Preguiça, Baquero, Zawirski 2011).
 *
 * A state-based CRDT has a set of states with a partial order ≤, an update that only moves a state up (an
 * "inflation"), and a merge that is the least upper bound (the join ⊔). The join is commutative, associative and
 * idempotent. So replicas that have seen the same updates hold the same state, whatever the order of delivery and
 * however often a state arrives twice.
 *
 * Every function here is pure: an update or a merge returns a new state.
 */
import { vcBytes } from "../time/vector";

export interface StateCrdt<S, Op, V> {
  name: string;
  /** The bottom state for n replicas. */
  init(n: number): S;
  /** A local update at replica r. `time` is the replica's clock, for the last-writer-wins types. */
  update(s: S, r: number, op: Op, time: number): S;
  merge(a: S, b: S): S;
  leq(a: S, b: S): boolean;
  value(s: S): V;
  /** Entries in the state, for the size of a full-state message. */
  entries(s: S): number;
}

export const sameState = <S>(c: StateCrdt<S, unknown, unknown>, a: S, b: S) => c.leq(a, b) && c.leq(b, a);

// ---------------------------------------------------------------- G-Counter

/** A grow-only counter: one entry per replica. Replica r adds only to entry r. Value = sum. Merge = max per entry. */
export type GCounter = number[];
export const gCounter: StateCrdt<GCounter, number, number> = {
  name: "G-Counter",
  init: (n) => new Array<number>(n).fill(0),
  update: (s, r, k) => {
    if (k < 0) throw new Error("a G-Counter cannot decrease");
    return s.map((x, i) => (i === r ? x + k : x));
  },
  merge: (a, b) => a.map((x, i) => Math.max(x, b[i] ?? 0)),
  leq: (a, b) => a.every((x, i) => x <= (b[i] ?? 0)),
  value: (s) => s.reduce((a, b) => a + b, 0),
  entries: (s) => s.length,
};

// ---------------------------------------------------------------- PN-Counter

/** Two G-Counters: P counts increments and N counts decrements. Value = sum(P) − sum(N). */
export interface PNCounter { p: number[]; n: number[] }
export const pnCounter: StateCrdt<PNCounter, number, number> = {
  name: "PN-Counter",
  init: (n) => ({ p: gCounter.init(n), n: gCounter.init(n) }),
  update: (s, r, k) => (k >= 0 ? { p: gCounter.update(s.p, r, k, 0), n: s.n } : { p: s.p, n: gCounter.update(s.n, r, -k, 0) }),
  merge: (a, b) => ({ p: gCounter.merge(a.p, b.p), n: gCounter.merge(a.n, b.n) }),
  leq: (a, b) => gCounter.leq(a.p, b.p) && gCounter.leq(a.n, b.n),
  value: (s) => gCounter.value(s.p) - gCounter.value(s.n),
  entries: (s) => s.p.length + s.n.length,
};

// ---------------------------------------------------------------- registers

/** A max-register: a write keeps the larger value. The order is the order of numbers, a chain. */
export const maxRegister: StateCrdt<number, number, number> = {
  name: "max-register",
  init: () => 0,
  update: (s, _r, v) => Math.max(s, v),
  merge: (a, b) => Math.max(a, b),
  leq: (a, b) => a <= b,
  value: (s) => s,
  entries: () => 1,
};

/** A last-writer-wins register: the value with the larger timestamp (time, then replica id) wins. */
export interface Lww<V> { v: V; t: number; r: number }
export const lwwLess = (a: { t: number; r: number }, b: { t: number; r: number }) => a.t < b.t || (a.t === b.t && a.r < b.r);
export const lwwRegister: StateCrdt<Lww<number>, number, number> = {
  name: "LWW-register",
  init: () => ({ v: 0, t: -Infinity, r: -1 }),
  update: (_s, r, v, time) => ({ v, t: time, r }),
  merge: (a, b) => (lwwLess(a, b) ? b : a),
  leq: (a, b) => !lwwLess(b, a),
  value: (s) => s.v,
  entries: () => 1,
};

/**
 * The naive counter: an LWW-register that holds a count. An increment reads the local count, adds, and writes the
 * sum with the local time. Its merge is a real join, so replicas converge. But two concurrent increments both
 * write "old + 1", and one of them wins: an update is lost. The lattice laws give convergence, not the meaning.
 */
export const lwwCounter: StateCrdt<Lww<number>, number, number> = {
  ...lwwRegister,
  name: "LWW counter (naive)",
  update: (s, r, k, time) => ({ v: s.v + k, t: Math.max(time, s.t + 1e-6), r }),
};

// ---------------------------------------------------------------- G-Set

/** A grow-only set. Merge = union. Elements are kept sorted, so equal sets are equal arrays. */
export const gSet: StateCrdt<string[], string, string[]> = {
  name: "G-Set",
  init: () => [],
  update: (s, _r, e) => (s.includes(e) ? s : [...s, e].sort()),
  merge: (a, b) => [...new Set([...a, ...b])].sort(),
  leq: (a, b) => a.every((x) => b.includes(x)),
  value: (s) => s,
  entries: (s) => s.length,
};

// ---------------------------------------------------------------- laws

export interface LawResult { commutative: boolean; associative: boolean; idempotent: boolean; upperBound: boolean; inflation: boolean }

/** Checks the join laws on three states, and that an update only moves a state up. */
export function checkLaws<S, Op>(c: StateCrdt<S, Op, unknown>, a: S, b: S, d: S, op: { r: number; op: Op; time: number }): LawResult {
  const eq = (x: S, y: S) => sameState(c, x, y);
  const ab = c.merge(a, b);
  return {
    commutative: eq(ab, c.merge(b, a)),
    associative: eq(c.merge(ab, d), c.merge(a, c.merge(b, d))),
    idempotent: eq(c.merge(a, a), a),
    upperBound: c.leq(a, ab) && c.leq(b, ab),
    inflation: c.leq(a, c.update(a, op.r, op.op, op.time)),
  };
}

// ---------------------------------------------------------------- the lattice view

/** A finite lattice to draw: nodes with labels, the covering edges (Hasse diagram), and the join. */
export interface FiniteLattice<S> {
  nodes: S[];
  label(s: S): string;
  leq(a: S, b: S): boolean;
  join(a: S, b: S): S;
  key(s: S): string;
  /** Height in the diagram (rank), and a horizontal position in [-1, 1]. */
  rank(s: S): number;
  across(s: S): number;
}

/** States [a, b] of a G-Counter with two replicas, each entry in 0..max. */
export function gCounterLattice(max = 3): FiniteLattice<number[]> {
  const nodes: number[][] = [];
  for (let a = 0; a <= max; a++) for (let b = 0; b <= max; b++) nodes.push([a, b]);
  return {
    nodes,
    label: (s) => `[${s.join(",")}]`,
    leq: gCounter.leq,
    join: gCounter.merge,
    key: (s) => s.join(","),
    rank: (s) => s[0]! + s[1]!,
    across: (s) => (s[0]! - s[1]!) / max,
  };
}

/** All subsets of the universe, ordered by inclusion: the lattice of a G-Set. */
export function powersetLattice(universe = ["x", "y", "z"]): FiniteLattice<string[]> {
  const nodes: string[][] = [];
  for (let m = 0; m < 1 << universe.length; m++) nodes.push(universe.filter((_, i) => m & (1 << i)));
  return {
    nodes,
    label: (s) => (s.length ? `{${s.join(",")}}` : "∅"),
    leq: gSet.leq,
    join: gSet.merge,
    key: (s) => s.join(","),
    rank: (s) => s.length,
    across: (s) => {
      // Spread the sets of one size evenly, in a fixed order.
      const same = nodes.filter((x) => x.length === s.length).map((x) => x.join(","));
      const i = same.indexOf(s.join(","));
      return same.length === 1 ? 0 : (2 * i) / (same.length - 1) - 1;
    },
  };
}

/** A max-register on 0..max: a chain, where the join is the larger value. */
export function chainLattice(max = 5): FiniteLattice<number> {
  return {
    nodes: Array.from({ length: max + 1 }, (_, i) => i),
    label: (s) => String(s),
    leq: (a, b) => a <= b,
    join: Math.max,
    key: String,
    rank: (s) => s,
    across: () => 0,
  };
}

/** The covering pairs [lower, upper]: a < b with nothing strictly between. */
export function hasseEdges<S>(L: FiniteLattice<S>): [S, S][] {
  const lt = (a: S, b: S) => L.leq(a, b) && L.key(a) !== L.key(b);
  const out: [S, S][] = [];
  for (const a of L.nodes)
    for (const b of L.nodes)
      if (lt(a, b) && !L.nodes.some((c) => lt(a, c) && lt(c, b))) out.push([a, b]);
  return out;
}

/** The upper bounds of a and b in L, and the least one, which is the join. */
export function upperBounds<S>(L: FiniteLattice<S>, a: S, b: S): { bounds: S[]; least: S } {
  const bounds = L.nodes.filter((c) => L.leq(a, c) && L.leq(b, c));
  const least = bounds.find((c) => bounds.every((d) => L.leq(c, d)))!;
  return { bounds, least };
}

// ---------------------------------------------------------------- state size

/**
 * Bytes of a full-state message for a counter with `entries` entries, with an 8-byte replica id and an 8-byte
 * count per entry (a model input; the same layout as a vector clock entry).
 */
export const counterStateBytes = (entries: number) => vcBytes(entries);
