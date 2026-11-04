/**
 * A step-level machine for lock-free algorithms.
 *
 * Operations are generators. Each `yield` announces the *next* shared-memory action and
 * pauses; resuming performs that action and runs private code up to the next yield. So one
 * scheduler step = one atomic shared-memory action, and every thread can show what it will
 * do next.
 *
 * Memory is a pool of nodes with explicit states, so the machine can catch use-after-free,
 * double free and corrupted structures the moment they happen.
 */

export type Ptr = number; // 0 = null
export interface Word { ptr: Ptr; tag: number }
export type NodeState = "free" | "private" | "live" | "retired";
export interface Node { value: number; next: Word; state: NodeState }

export type Scheme = "leak" | "immediate" | "hazard" | "epoch";
export interface Options {
  /** Pair pointers in roots with a version counter that every successful CAS bumps. */
  tags: boolean;
  scheme: Scheme;
  /** Retired nodes per thread before scanning (hazard) or trying to advance (epoch). */
  threshold: number;
  pool: number;
}

export type Op = { kind: "push"; v: number } | { kind: "pop" } | { kind: "enq"; v: number } | { kind: "deq" };
export type OpGen = Generator<string, number | null, void>;

export interface Violation { kind: "use-after-free" | "double-free" | "corruption" | "lost-or-duplicated" | "out-of-memory" | "timeout"; detail: string; step: number }

export interface ThreadState {
  id: number;
  ops: Op[];
  opIndex: number;
  gen: OpGen | null;
  /** Label of the action the next step will perform (null when finished). */
  next: string | null;
  /** Thread-local pointers worth drawing, e.g. { h: 3, next: 4 }. */
  ptrs: Record<string, Ptr>;
  results: (number | null)[];
  hazards: Ptr[];
  retired: Ptr[];
  // epoch-based reclamation
  active: boolean;
  epoch: number;
  bags: Ptr[][];
  bagEpoch: number[];
}

export const NAMES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const nodeName = (p: Ptr) => (p === 0 ? "null" : p <= 26 ? NAMES[p - 1]! : `n${p}`);

export class World {
  nodes: Node[];
  freeList: Ptr[] = [];
  roots: Record<string, Word> = {};
  threads: ThreadState[];
  violations: Violation[] = [];
  log: { t: number; label: string }[] = [];
  steps = 0;
  epoch = 0;
  pushed: number[] = [];
  popped: number[] = [];
  /** Structure invariant, checked after every step. */
  checker: ((w: World) => string | null) | null = null;
  /** Values currently in the structure, for final accounting. */
  contents: ((w: World) => number[]) | null = null;
  private seenCorruption = new Set<string>();

  constructor(public opts: Options, threadOps: Op[][], public algo: (w: World, t: ThreadState, op: Op) => OpGen) {
    this.nodes = Array.from({ length: opts.pool + 1 }, () => ({ value: 0, next: { ptr: 0, tag: 0 }, state: "free" as NodeState }));
    // LIFO free list: the most recently freed node is reused first (as real allocators do).
    for (let p = opts.pool; p >= 1; p--) this.freeList.push(p);
    this.threads = threadOps.map((ops, id) => ({
      id, ops, opIndex: 0, gen: null, next: null, ptrs: {}, results: [],
      hazards: [0, 0], retired: [], active: false, epoch: 0, bags: [[], [], []], bagEpoch: [-9, -9, -9],
    }));
  }

  /** Must be called after initial structure setup. */
  start() {
    for (const t of this.threads) this.prime(t);
  }

  // ---------------- memory ----------------

  violate(kind: Violation["kind"], detail: string) {
    this.violations.push({ kind, detail, step: this.steps });
  }

  alloc(value: number): Ptr {
    const p = this.freeList.pop();
    if (p === undefined) {
      this.violate("out-of-memory", "node pool exhausted");
      return 0;
    }
    this.nodes[p] = { value, next: { ptr: 0, tag: 0 }, state: "private" };
    return p;
  }

  free(p: Ptr) {
    const n = this.nodes[p]!;
    if (n.state === "free") return this.violate("double-free", `${nodeName(p)} freed twice`);
    n.state = "free";
    this.freeList.push(p);
  }

  /** Reads a node field, flagging reads of freed memory. */
  read(p: Ptr, what: string): Node {
    const n = this.nodes[p]!;
    if (p === 0) this.violate("corruption", `null dereference reading ${what}`);
    else if (n.state === "free") this.violate("use-after-free", `read ${nodeName(p)}.${what} after it was freed`);
    return n;
  }

  load(root: string): Word {
    return { ...this.roots[root]! };
  }

  /** CAS on a root. Compares the tag too when tagging is on; bumps the tag on success. */
  cas(root: string, expected: Word, ptr: Ptr): boolean {
    const cur = this.roots[root]!;
    if (cur.ptr !== expected.ptr || (this.opts.tags && cur.tag !== expected.tag)) return false;
    this.roots[root] = { ptr, tag: cur.tag + 1 };
    return true;
  }

  casNext(p: Ptr, expected: Ptr, ptr: Ptr): boolean {
    const n = this.read(p, "next");
    if (n.next.ptr !== expected) return false;
    n.next = { ptr, tag: n.next.tag + 1 };
    return true;
  }

  // ---------------- scheduling ----------------

  private prime(t: ThreadState) {
    while (t.opIndex < t.ops.length) {
      if (!t.gen) t.gen = this.algo(this, t, t.ops[t.opIndex]!);
      const r = t.gen.next();
      if (!r.done) {
        t.next = r.value;
        return;
      }
      this.finishOp(t, r.value);
    }
    t.next = null;
  }

  private finishOp(t: ThreadState, result: number | null) {
    const op = t.ops[t.opIndex]!;
    t.results.push(result);
    if ((op.kind === "pop" || op.kind === "deq") && result !== null) this.popped.push(result);
    if ((op.kind === "push" || op.kind === "enq") && result !== null) this.pushed.push(result);
    t.gen = null;
    t.ptrs = {};
    t.opIndex++;
  }

  runnable(): number[] {
    return this.threads.filter((t) => t.next !== null).map((t) => t.id);
  }

  step(id: number) {
    const t = this.threads[id]!;
    if (!t.gen || t.next === null) return;
    this.steps++;
    this.log.push({ t: id, label: t.next });
    const r = t.gen.next();
    if (r.done) {
      this.finishOp(t, r.value);
      this.prime(t);
    } else t.next = r.value;
    const bad = this.checker?.(this);
    if (bad && !this.seenCorruption.has(bad)) {
      this.seenCorruption.add(bad);
      this.violate("corruption", bad);
    }
  }

  done(): boolean {
    return this.threads.every((t) => t.next === null);
  }

  /** After all threads finish: every pushed value must be popped or still present, exactly once. */
  finalize() {
    if (!this.contents) return;
    const count = (xs: number[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<number, number>());
    const a = count(this.pushed), b = count([...this.popped, ...this.contents(this)]);
    const keys = new Set([...a.keys(), ...b.keys()]);
    const bad = [...keys].filter((k) => a.get(k) !== b.get(k));
    if (bad.length) this.violate("lost-or-duplicated", `values ${bad.join(", ")} were lost or returned twice`);
  }

  /** Nodes retired but not yet freed. */
  unreclaimed(): number {
    return this.nodes.filter((n) => n.state === "retired").length;
  }
}

export function fmt(w: Word, tags: boolean) {
  return tags ? `${nodeName(w.ptr)}·v${w.tag}` : nodeName(w.ptr);
}
