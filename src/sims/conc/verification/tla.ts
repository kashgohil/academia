/**
 * A tiny explicit-state checker in the style of TLC, and two specs written for it.
 *
 * A spec has initial states, actions and invariants. An action maps a state to its successors (none if it is not
 * enabled; several if it chooses, like `\E t \in waitSet`). The checker runs a breadth-first search over distinct
 * states, as TLC does by default, so the first violation it finds has a shortest trace. It checks each invariant on
 * each new state and reports a deadlock: a reachable state with no successor.
 *
 * - DieHard: the jugs puzzle from the TLA+ video course and the tlaplus Examples repository, with capacities and
 *   goal as parameters, and an optional bug (a pour that ignores the capacity).
 * - BlockingQueue: a bounded buffer with one monitor, `wait` and `notify`, in the style of Markus Kuppe's
 *   BlockingQueue tutorial. Only the buffer length is kept (the data does not matter for deadlock).
 */

export interface TlaAction<S> { name: string; succ(s: S): S[] }

export interface TlaSpec<S> {
  init: S[];
  actions: TlaAction<S>[];
  key(s: S): string;
  invariants: { name: string; holds(s: S): boolean }[];
}

export interface TraceStep<S> { action: string; state: S }

export interface TlcNode<S> { state: S; depth: number; parent: number; via: string }

export interface TlcResult<S> {
  /** Distinct states found. */
  distinct: number;
  /** States generated, counting duplicates (TLC prints both numbers). */
  generated: number;
  /** All nodes in BFS order. */
  nodes: TlcNode<S>[];
  /** Edges: [from, to, action] by node index. */
  edges: [number, number, string][];
  /** Depth of the BFS (the longest shortest path from an initial state). */
  depth: number;
  violation: { invariant: string; node: number; trace: TraceStep<S>[] } | null;
  deadlock: { node: number; trace: TraceStep<S>[] } | null;
}

export interface TlcOptions { checkDeadlock?: boolean; stopOnError?: boolean; maxStates?: number }

/** Breadth-first search over the state graph. */
export function tlc<S>(spec: TlaSpec<S>, opts: TlcOptions = {}): TlcResult<S> {
  const { checkDeadlock = true, stopOnError = true, maxStates = 200_000 } = opts;
  const index = new Map<string, number>();
  const nodes: TlcNode<S>[] = [];
  const edges: [number, number, string][] = [];
  let generated = 0;
  let violation: TlcResult<S>["violation"] = null;
  let deadlock: TlcResult<S>["deadlock"] = null;
  const trace = (i: number): TraceStep<S>[] => {
    const out: TraceStep<S>[] = [];
    for (let k = i; k >= 0; k = nodes[k]!.parent) out.push({ action: nodes[k]!.via, state: nodes[k]!.state });
    return out.reverse();
  };
  const add = (s: S, depth: number, parent: number, via: string): number => {
    generated++;
    const k = spec.key(s);
    const old = index.get(k);
    if (old !== undefined) return old;
    const i = nodes.length;
    index.set(k, i);
    nodes.push({ state: s, depth, parent, via });
    if (!violation) {
      const bad = spec.invariants.find((inv) => !inv.holds(s));
      if (bad) violation = { invariant: bad.name, node: i, trace: trace(i) };
    }
    return i;
  };
  for (const s of spec.init) add(s, 0, -1, "Init");
  for (let head = 0; head < nodes.length; head++) {
    if (stopOnError && (violation || deadlock)) break;
    if (nodes.length >= maxStates) break;
    const { state, depth } = nodes[head]!;
    let any = false;
    for (const a of spec.actions) {
      for (const t of a.succ(state)) {
        any = true;
        const j = add(t, depth + 1, head, a.name);
        edges.push([head, j, a.name]);
      }
    }
    if (!any && checkDeadlock && !deadlock) deadlock = { node: head, trace: trace(head) };
  }
  const depth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  return { distinct: nodes.length, generated, nodes, edges, depth, violation, deadlock };
}

// ---------------------------------------------------------------- DieHard

export interface Jugs { small: number; big: number }

export interface DieHardOptions { smallCap?: number; bigCap?: number; goal?: number; bug?: boolean }

/** The six actions of DieHard. With `bug`, SmallToBig ignores the capacity of the big jug. */
export function dieHardActions({ smallCap = 3, bigCap = 5, bug = false }: DieHardOptions = {}): TlaAction<Jugs>[] {
  const min = Math.min;
  return [
    { name: "FillSmallJug", succ: (s) => [{ small: smallCap, big: s.big }] },
    { name: "FillBigJug", succ: (s) => [{ small: s.small, big: bigCap }] },
    { name: "EmptySmallJug", succ: (s) => [{ small: 0, big: s.big }] },
    { name: "EmptyBigJug", succ: (s) => [{ small: s.small, big: 0 }] },
    {
      name: "SmallToBig",
      succ: (s) => {
        const big = bug ? s.big + s.small : min(s.big + s.small, bigCap);
        return [{ small: s.small - (big - s.big), big }];
      },
    },
    {
      name: "BigToSmall",
      succ: (s) => {
        const small = min(s.big + s.small, smallCap);
        return [{ small, big: s.big - (small - s.small) }];
      },
    },
  ];
}

export function dieHard(o: DieHardOptions = {}): TlaSpec<Jugs> {
  const { smallCap = 3, bigCap = 5, goal = 4 } = o;
  return {
    init: [{ small: 0, big: 0 }],
    actions: dieHardActions(o),
    key: (s) => `${s.small},${s.big}`,
    invariants: [
      { name: "TypeOK", holds: (s) => s.small >= 0 && s.small <= smallCap && s.big >= 0 && s.big <= bigCap },
      { name: "NotSolved", holds: (s) => s.big !== goal },
    ],
  };
}

/** The primed-variable formula of a DieHard action, evaluated at state s, for the learner's view. */
export function dieHardExplain(name: string, s: Jugs, o: DieHardOptions = {}): string[] {
  const { smallCap = 3, bigCap = 5 } = o;
  const next = dieHardActions(o).find((a) => a.name === name)!.succ(s)[0]!;
  switch (name) {
    case "FillSmallJug": return [`small' = ${smallCap}`, `big' = big = ${next.big}`];
    case "FillBigJug": return [`big' = ${bigCap}`, `small' = small = ${next.small}`];
    case "EmptySmallJug": return ["small' = 0", `big' = big = ${next.big}`];
    case "EmptyBigJug": return ["big' = 0", `small' = small = ${next.small}`];
    case "SmallToBig": return [o.bug ? `big' = big + small = ${next.big}` : `big' = Min(big + small, ${bigCap}) = ${next.big}`, `small' = small - (big' - big) = ${next.small}`];
    default: return [`small' = Min(big + small, ${smallCap}) = ${next.small}`, `big' = big - (small' - small) = ${next.big}`];
  }
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The goal is reachable exactly when it fits in the big jug and is a multiple of gcd(small, big). */
export const dieHardSolvable = (smallCap: number, bigCap: number, goal: number) => goal <= bigCap && goal % gcd(smallCap, bigCap) === 0;

// ---------------------------------------------------------------- BlockingQueue

export interface BQState { len: number; wait: number }

export interface BQOptions { producers: number; consumers: number; capacity: number; notify: "one" | "all" }

/** Thread names: p1..pP, then c1..cC. Thread i is bit i of `wait`. */
export const bqThreads = (o: BQOptions) => [
  ...Array.from({ length: o.producers }, (_, i) => `p${i + 1}`),
  ...Array.from({ length: o.consumers }, (_, i) => `c${i + 1}`),
];

/**
 * Put(t) and Get(t) for each thread that is not waiting. A Put on a full buffer, or a Get on an empty one, adds the
 * thread to the wait set. Otherwise it changes the length and notifies: "one" removes any one waiting thread (Java's
 * notify), so there is one successor per waiting thread; "all" empties the wait set (notifyAll).
 */
export function blockingQueue(o: BQOptions): TlaSpec<BQState> {
  const names = bqThreads(o);
  const n = names.length;
  const notify = (wait: number): number[] => {
    if (wait === 0) return [0];
    if (o.notify === "all") return [0];
    const out: number[] = [];
    for (let t = 0; t < n; t++) if (wait & (1 << t)) out.push(wait & ~(1 << t));
    return out;
  };
  const actions: TlaAction<BQState>[] = names.map((name, t) => {
    const producer = t < o.producers;
    return {
      name: `${producer ? "Put" : "Get"}(${name})`,
      succ: (s) => {
        if (s.wait & (1 << t)) return [];
        const can = producer ? s.len < o.capacity : s.len > 0;
        if (!can) return [{ len: s.len, wait: s.wait | (1 << t) }];
        const len = s.len + (producer ? 1 : -1);
        return notify(s.wait).map((wait) => ({ len, wait }));
      },
    };
  });
  return {
    init: [{ len: 0, wait: 0 }],
    actions,
    key: (s) => `${s.len}|${s.wait}`,
    invariants: [{ name: "TypeOK", holds: (s) => s.len >= 0 && s.len <= o.capacity }],
  };
}

/** The names in a wait set. */
export const waitNames = (o: BQOptions, wait: number) => bqThreads(o).filter((_, t) => wait & (1 << t));
