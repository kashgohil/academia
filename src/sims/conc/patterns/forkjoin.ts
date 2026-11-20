/**
 * The work-span model of fork-join parallelism.
 *
 * A fork-join program is a DAG of tasks. `sumDag` builds the DAG of a recursive parallel sum: a split node forks two
 * halves, a leaf adds up to `grain` elements, and a join node adds two partial results. `workSpan` gives the work T1
 * (the sum of all costs) and the span T∞ (the most expensive path). `greedy` is a list scheduler on P processors: it
 * never leaves a processor idle while a node is ready. Every greedy schedule meets Brent's bound
 * T_P ≤ T1/P + T∞ (Graham 1969 gives the sharper (T1 − T∞)/P + T∞), and no schedule beats max(T1/P, T∞).
 *
 * `algoWorkSpan` evaluates the work and span recurrences of three algorithms with unit costs, so that a lesson can
 * compare their parallelism T1/T∞ as n grows.
 *
 * Costs are in abstract time units in the small DAG demo, and in ns in the grain sweep. All costs are MODEL INPUTS.
 */

export type NodeKind = "split" | "leaf" | "join";

export interface DagNode {
  id: number;
  kind: NodeKind;
  cost: number;
  /** The elements [lo, hi) of the subproblem. */
  lo: number;
  hi: number;
  /** Recursion depth of the subproblem (0 at the root). */
  depth: number;
  succ: number[];
  pred: number[];
}

/** Nodes in creation order, which is also a topological order. */
export interface Dag { nodes: DagNode[]; root: number; sink: number }

export interface FjCosts {
  /** Cost of one element in a leaf. */
  elem: number;
  /** Cost of a fork: create a task and make it visible to other workers. */
  spawn: number;
  /** Cost of a join: wait for the child result and combine two partial results. */
  join: number;
}

/** The DAG of a recursive parallel sum over n elements that stops splitting at `grain` elements. */
export function sumDag(n: number, grain: number, c: FjCosts): Dag {
  const nodes: DagNode[] = [];
  const add = (kind: NodeKind, cost: number, lo: number, hi: number, depth: number) => {
    const node: DagNode = { id: nodes.length, kind, cost, lo, hi, depth, succ: [], pred: [] };
    nodes.push(node);
    return node.id;
  };
  const edge = (a: number, b: number) => {
    nodes[a]!.succ.push(b);
    nodes[b]!.pred.push(a);
  };
  const g = Math.max(1, Math.floor(grain));
  const build = (lo: number, hi: number, depth: number): [number, number] => {
    if (hi - lo <= g) {
      const l = add("leaf", (hi - lo) * c.elem, lo, hi, depth);
      return [l, l];
    }
    const mid = lo + Math.floor((hi - lo) / 2);
    const s = add("split", c.spawn, lo, hi, depth);
    const [a0, a1] = build(lo, mid, depth + 1);
    const [b0, b1] = build(mid, hi, depth + 1);
    const j = add("join", c.join, lo, hi, depth);
    edge(s, a0);
    edge(s, b0);
    edge(a1, j);
    edge(b1, j);
    return [s, j];
  };
  const [root, sink] = build(0, n, 0);
  return { nodes, root, sink };
}

export interface WorkSpan {
  /** T1: the time on one processor (all node costs). */
  work: number;
  /** T∞: the most expensive path, the time with unlimited processors. */
  span: number;
  /** T1 / T∞: the most processors that can be useful on average. */
  parallelism: number;
  /** The ids on one most expensive path, root first. */
  path: number[];
}

export function workSpan(dag: Dag): WorkSpan {
  const n = dag.nodes.length;
  const finish = new Float64Array(n);
  const from = new Int32Array(n).fill(-1);
  let work = 0;
  for (const node of dag.nodes) {
    work += node.cost;
    let best = 0;
    for (const p of node.pred) {
      if (from[node.id]! < 0 || finish[p]! > best) {
        best = finish[p]!;
        from[node.id] = p;
      }
    }
    finish[node.id] = best + node.cost;
  }
  const span = finish[dag.sink]!;
  const path: number[] = [];
  for (let v = dag.sink; v >= 0; v = from[v]!) path.push(v);
  path.reverse();
  return { work, span, parallelism: span > 0 ? work / span : 0, path };
}

export interface Slot { node: number; proc: number; start: number; end: number; ready: number }

export interface Schedule {
  /** One slot per node, by node id. */
  slots: Slot[];
  /** T_P, the finish time of the last node. */
  makespan: number;
  procs: number;
  /** Busy time of each processor. */
  busy: number[];
}

/**
 * A greedy list schedule on P processors. A free processor takes a ready node at once. `order` picks among ready
 * nodes: "lifo" takes the newest (depth first, as one worker of a work-stealing runtime does), "fifo" the oldest.
 */
export function greedy(dag: Dag, procs: number, order: "lifo" | "fifo" = "lifo"): Schedule {
  const P = Math.max(1, Math.floor(procs));
  const n = dag.nodes.length;
  const left = dag.nodes.map((v) => v.pred.length);
  const slots: Slot[] = new Array(n);
  const readyAt = new Float64Array(n);
  const ready: number[] = [dag.root];
  let head = 0; // for fifo
  const free: number[] = [];
  for (let p = P - 1; p >= 0; p--) free.push(p);
  // Running nodes, a binary heap by end time (then node id, for determinism).
  const heap: Slot[] = [];
  const less = (a: Slot, b: Slot) => a.end < b.end || (a.end === b.end && a.node < b.node);
  const push = (s: Slot) => {
    heap.push(s);
    let i = heap.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (less(heap[q]!, heap[i]!)) break;
      [heap[q], heap[i]] = [heap[i]!, heap[q]!];
      i = q;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const busy = new Array<number>(P).fill(0);
  let t = 0, makespan = 0;
  for (;;) {
    while (free.length && ready.length > head) {
      const v = order === "lifo" ? ready.pop()! : ready[head++]!;
      const proc = free.pop()!;
      const s: Slot = { node: v, proc, start: t, end: t + dag.nodes[v]!.cost, ready: readyAt[v]! };
      slots[v] = s;
      busy[proc]! += s.end - s.start;
      push(s);
    }
    if (order === "fifo" && head > 1024 && head * 2 > ready.length) {
      ready.splice(0, head);
      head = 0;
    }
    if (!heap.length) break;
    // Finish every node that ends at the next time, then dispatch again.
    t = heap[0]!.end;
    while (heap.length && heap[0]!.end === t) {
      const s = pop();
      makespan = Math.max(makespan, s.end);
      free.push(s.proc);
      for (const w of dag.nodes[s.node]!.succ) {
        if (--left[w]! === 0) {
          readyAt[w] = t;
          ready.push(w);
        }
      }
    }
    // Keep free processors in a fixed order: the lowest id is taken first.
    free.sort((a, b) => b - a);
  }
  return { slots, makespan, procs: P, busy };
}

/** The lower bound max(T1/P, T∞) and Brent's upper bound T1/P + T∞. */
export function bounds(ws: WorkSpan, procs: number) {
  return { lower: Math.max(ws.work / procs, ws.span), brent: ws.work / procs + ws.span };
}

/** The state of each node at time t in a schedule: done, running, ready (all inputs done, not started) or waiting. */
export type NodeState = "done" | "running" | "ready" | "waiting";
export function nodeStates(dag: Dag, s: Schedule, t: number): NodeState[] {
  return dag.nodes.map((v) => {
    const slot = s.slots[v.id]!;
    if (slot.end <= t && (slot.start < t || slot.start === slot.end)) return "done";
    if (slot.start <= t && t < slot.end) return "running";
    return v.pred.every((p) => s.slots[p]!.end <= t) ? "ready" : "waiting";
  });
}

// ---------------------------------------------------------------- grain size

export interface GrainPoint {
  grain: number;
  tasks: number;
  work: number;
  span: number;
  makespan: number;
  /** The serial loop time over the makespan: the speedup that a user sees. */
  speedup: number;
}

/** T_P of the parallel sum for one grain size, against a serial loop of n × elem. */
export function grainPoint(n: number, grain: number, procs: number, c: FjCosts): GrainPoint {
  const dag = sumDag(n, grain, c);
  const ws = workSpan(dag);
  const s = greedy(dag, procs);
  const leaves = dag.nodes.filter((v) => v.kind === "leaf").length;
  return { grain, tasks: leaves, work: ws.work, span: ws.span, makespan: s.makespan, speedup: (n * c.elem) / s.makespan };
}

/** Grain sizes 2^k from `from` to n. */
export const grains = (n: number, from = 1) => {
  const out: number[] = [];
  for (let g = from; g <= n; g *= 2) out.push(g);
  return out;
};

// ---------------------------------------------------------------- work and span of algorithms

export type Algo = "sum" | "mergesort-serial-merge" | "mergesort-parallel-merge";

/**
 * Work and span with unit costs, for n a power of two.
 * - sum: W(n) = 2W(n/2) + 1, S(n) = S(n/2) + 1.
 * - merge sort, serial merge: W(n) = 2W(n/2) + n, S(n) = S(n/2) + n. (Quicksort with a serial partition and
 *   perfect pivots has the same recurrences.)
 * - merge sort, parallel merge: the same work, and S(n) = S(n/2) + M(n), where the parallel merge has span
 *   M(m) = M(3m/4) + log₂ m (a binary search, then two merges of at most 3/4 of the elements, rounded down).
 */
export function algoWorkSpan(algo: Algo, n: number): { work: number; span: number; parallelism: number } {
  const merge = (m: number) => {
    let s = 1;
    while (m > 1) {
      s += Math.log2(m);
      m = Math.floor((3 * m) / 4);
    }
    return s;
  };
  let work = 0, span = 0;
  if (algo === "sum") {
    work = 2 * n - 1;
    span = Math.log2(n) + 1;
  } else {
    // Level by level: 2^k subproblems of size n / 2^k.
    span = 1;
    work = n;
    for (let m = n; m > 1; m /= 2) {
      work += (n / m) * m;
      span += algo === "mergesort-serial-merge" ? m : merge(m);
    }
  }
  return { work, span, parallelism: work / span };
}
