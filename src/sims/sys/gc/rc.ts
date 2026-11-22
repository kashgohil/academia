/**
 * Reference counting as a collector, on the shared object graph (heap.ts).
 *
 * - `rcInit` counts the pointers to each object (from roots and from other objects).
 * - `rcStore` writes one pointer: it increments the new target first, then writes, then decrements the old target.
 *   An object whose count reaches zero is freed at once, and its own fields are decremented in turn: the cascade.
 *   An object whose count drops to a value above zero becomes a candidate root of a garbage cycle ("purple").
 * - `trialDeletion` is the synchronous cycle collector of Bacon and Rajan (ECOOP 2001, "Concurrent Cycle Collection
 *   in Reference Counted Systems", LNCS 2072): three phases, MarkRoots (MarkGray subtracts the counts that come
 *   from inside the candidate subgraph), ScanRoots (Scan restores the objects that still have an outside count, with
 *   ScanBlack) and CollectRoots (CollectWhite frees the rest). It returns one frame per change, for a stepper.
 *   The paper's green (acyclic) color and the colors of its concurrent collector are not modeled.
 * - `RC_BENCH`: clone+drop pairs of Rust Rc and Arc, measured (see the comment there).
 */
import { clone, obj, type Graph, type Ref } from "./heap";

export interface RcState {
  g: Graph;
  rc: Record<number, number>;
  /** Ids freed so far, in order. */
  freed: number[];
  /** Candidate roots of cycles: objects decremented to a count above zero. */
  purple: number[];
}

export interface RcEvent { kind: "inc" | "dec" | "free"; id: number; count: number; depth: number }

/** A store target: a root slot, or a field of an object. */
export type Slot = { root: string } | { obj: number; field: number };

/** Counts from roots and from every object in the graph. */
export function rcInit(g: Graph): RcState {
  const rc: Record<number, number> = {};
  for (const o of g.objs) rc[o.id] = 0;
  for (const r of g.roots) if (r.to !== null) rc[r.to]! += 1;
  for (const o of g.objs) for (const t of o.fields) if (t !== null) rc[t]! += 1;
  return { g: clone(g), rc, freed: [], purple: [] };
}

/**
 * `*slot = to` with reference counting. Increment first, so `x = x` never frees x. The returned events list the
 * count changes and the frees in order; `depth` is the length of the cascade chain that caused each one.
 */
export function rcStore(s0: RcState, slot: Slot, to: Ref): { state: RcState; events: RcEvent[] } {
  const s: RcState = { g: clone(s0.g), rc: { ...s0.rc }, freed: [...s0.freed], purple: [...s0.purple] };
  const events: RcEvent[] = [];
  if (to !== null) { s.rc[to]! += 1; events.push({ kind: "inc", id: to, count: s.rc[to]!, depth: 0 }); }
  let old: Ref;
  if ("root" in slot) {
    const r = s.g.roots.find((x) => x.name === slot.root);
    if (!r) throw new Error(`no root ${slot.root}`);
    old = r.to; r.to = to;
  } else {
    const o = obj(s.g, slot.obj);
    old = o.fields[slot.field] ?? null; o.fields[slot.field] = to;
  }
  if (old !== null) decrement(s, old, 0, events);
  return { state: s, events };
}

function decrement(s: RcState, id0: number, depth0: number, events: RcEvent[]) {
  const work: [number, number][] = [[id0, depth0]];
  while (work.length) {
    const [id, depth] = work.shift()!;
    s.rc[id]! -= 1;
    events.push({ kind: "dec", id, count: s.rc[id]!, depth });
    if (s.rc[id] === 0) {
      const o = obj(s.g, id);
      events.push({ kind: "free", id, count: 0, depth });
      s.freed.push(id);
      s.purple = s.purple.filter((x) => x !== id);
      s.g.objs = s.g.objs.filter((x) => x.id !== id);
      delete s.rc[id];
      for (const t of o.fields) if (t !== null && t !== id && s.rc[t] !== undefined) work.push([t, depth + 1]);
    } else if (!s.purple.includes(id)) {
      s.purple.push(id);
    }
  }
}

/** Objects that are still allocated but that no root reaches: the leak of plain reference counting. */
export function rcLeaked(s: RcState): number[] {
  const seen = new Set<number>();
  const stack = s.g.roots.map((r) => r.to).filter((x): x is number => x !== null);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const t of obj(s.g, id).fields) if (t !== null) stack.push(t);
  }
  return s.g.objs.filter((o) => !seen.has(o.id)).map((o) => o.id);
}

// ---------------------------------------------------------------- trial deletion

/** Bacon and Rajan's colors: black = in use, gray = maybe in a garbage cycle, white = garbage, purple = candidate. */
export type BrColor = "black" | "gray" | "white" | "purple";

export interface TdFrame {
  phase: "start" | "markgray" | "scan" | "collect" | "done";
  rc: Record<number, number>;
  color: Record<number, BrColor>;
  freed: number[];
  focus?: number;
  text: string;
}

/**
 * The synchronous cycle collection of Bacon and Rajan (2001), run on the candidate roots of `s` (its purple list).
 * Returns every intermediate state. The counts in the frames are the trial counts; at the end, the counts of the
 * survivors are back to their real values.
 */
export function trialDeletion(s: RcState): TdFrame[] {
  const g = s.g;
  const rc = { ...s.rc };
  const color: Record<number, BrColor> = {};
  for (const o of g.objs) color[o.id] = s.purple.includes(o.id) ? "purple" : "black";
  const freed: number[] = [];
  const frames: TdFrame[] = [];
  const name = (id: number) => obj(g, id).name;
  const kids = (id: number) => obj(g, id).fields.filter((t): t is number => t !== null && rc[t] !== undefined);
  const snap = (phase: TdFrame["phase"], text: string, focus?: number) => frames.push({ phase, rc: { ...rc }, color: { ...color }, freed: [...freed], focus, text });
  const roots = s.purple.filter((id) => rc[id] !== undefined);
  snap("start", `Candidate roots: ${roots.map(name).join(", ") || "none"}. Their counts dropped, but not to zero, so each one may be part of a garbage cycle.`);

  const markGray = (id: number) => {
    if (color[id] === "gray") return;
    color[id] = "gray";
    snap("markgray", `MarkGray(${name(id)}): color it gray, then subtract 1 from each child for the pointer inside this subgraph.`, id);
    for (const t of kids(id)) {
      rc[t]! -= 1;
      snap("markgray", `${name(id)} → ${name(t)}: trial count of ${name(t)} is now ${rc[t]}.`, t);
      markGray(t);
    }
  };
  const scanBlack = (id: number) => {
    color[id] = "black";
    snap("scan", `ScanBlack(${name(id)}): it is live, so color it black and give its children back their counts.`, id);
    for (const t of kids(id)) {
      rc[t]! += 1;
      if (color[t] !== "black") scanBlack(t);
    }
  };
  const scan = (id: number) => {
    if (color[id] !== "gray") return;
    if (rc[id]! > 0) {
      snap("scan", `Scan(${name(id)}): trial count ${rc[id]} > 0, so a pointer from outside the subgraph holds it.`, id);
      scanBlack(id);
    } else {
      color[id] = "white";
      snap("scan", `Scan(${name(id)}): trial count 0. Only pointers from inside the subgraph held it: white (garbage, for now).`, id);
      for (const t of kids(id)) scan(t);
    }
  };
  const collect = (id: number) => {
    if (color[id] !== "white") return;
    color[id] = "black";
    for (const t of kids(id)) collect(t);
    freed.push(id);
    snap("collect", `CollectWhite: free ${name(id)}.`, id);
  };

  for (const r of roots) if (color[r] === "purple") markGray(r);
  for (const r of roots) scan(r);
  for (const r of roots) collect(r);
  for (const id of freed) { delete rc[id]; delete color[id]; }
  snap("done", freed.length ? `Freed ${freed.map(name).join(", ")}. The survivors have their real counts again.` : "Nothing was garbage. All counts are back to their real values.");
  return frames;
}

// ---------------------------------------------------------------- measured cost of a count

/**
 * Measured: ns per clone+drop pair (one increment and one decrement of the strong count) of Rust's Rc and Arc,
 * rustc 1.96.1 -C opt-level=3, on an Apple M4 Pro (aarch64-apple-darwin), 14 cores, while other jobs loaded the
 * machine. Each thread runs 5,000,000 pairs (Rc: 20,000,000 on one thread); the value of a run is the best of 5,
 * and we keep three runs. "shared": all threads clone the same Arc, so they write the same cache line. "own": each
 * thread has its own Arc, 256 bytes apart or more. The loop uses std::hint::black_box, so the numbers include a
 * store and a load per pair. Source: scratch program b.rs of this module (see the lesson text).
 */
export const RC_BENCH = {
  rc: [2.61, 3.05, 2.58],
  arcShared: { 1: [3.83, 3.82, 3.74], 2: [17.36, 16.36, 17.32], 4: [51.26, 99.68, 90.62], 8: [106.76, 380.07, 380.74] } as Record<number, number[]>,
  arcOwn: { 1: [3.82, 3.82, 3.75], 2: [4.02, 3.79, 3.76], 4: [3.9, 3.78, 3.74], 8: [4.23, 3.86, 3.83] } as Record<number, number[]>,
};

export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

/** The median of the three runs for each configuration. */
export function rcBench(threads: number) {
  return { rc: median(RC_BENCH.rc), shared: median(RC_BENCH.arcShared[threads]!), own: median(RC_BENCH.arcOwn[threads]!) };
}

/**
 * Count updates to walk a list of n nodes with a counted cursor (`cur = cur.next.clone()` in Rust terms): each step
 * increments the next node and decrements the current one. With a borrowed cursor (`&Node`), there are none.
 */
export const walkUpdates = (n: number, counted: boolean) => (counted ? 2 * n : 0);
