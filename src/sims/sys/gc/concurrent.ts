/**
 * Concurrent marking on the shared object graph: a mutator and a marker that take turns, and four write barriers.
 *
 * The marker uses the tri-color terms of Dijkstra, Lamport, Martin, Scholten and Steffens ("On-the-fly garbage
 * collection: an exercise in cooperation", CACM 21(11), 1978): white = not reached yet, gray = reached but its
 * fields are not read yet, black = reached and its fields are read. Its first step scans all roots (the stacks and
 * the globals); each later step scans one gray object. When no gray object is left, it sweeps: every white object is
 * freed.
 *
 * The mutator runs a script of pointer writes. Each write copies a pointer that the mutator can read (from a field
 * or a root) into a slot. Writes to stack roots have no barrier (compilers do not emit barriers for the current
 * frame). Writes to heap fields and to globals run the barrier:
 * - "none": no barrier.
 * - "dijkstra": insertion barrier (Dijkstra et al. 1978): shade the new target. The strong invariant: no black object
 *   points to a white one. Stack writes are not covered, so the stacks must be scanned again at the end, with the
 *   world stopped (`rescan`).
 * - "yuasa": deletion barrier (T. Yuasa, "Real-time garbage collection on general-purpose machines", Journal of
 *   Systems and Software 11(3), 1990): shade the old target. Everything reachable at the start survives (later
 *   authors call this snapshot-at-the-beginning).
 * - "hybrid": Go's barrier since Go 1.8 (src/runtime/mbarrier.go): shade the old target, and also the new target
 *   while the stack of the writing goroutine is not yet scanned (gray).
 */
import { clone, nameOf, obj, reachable, rng, type Graph, type Ref } from "./heap";
import type { Tri } from "./marksweep";

export type Barrier = "none" | "dijkstra" | "yuasa" | "hybrid";

export type ConcSlot = { root: string } | { obj: string; field: number };

/** `*dst = *src` (src null: store nil). */
export interface ConcOp { dst: ConcSlot; src: ConcSlot | null }

export interface ConcScenario {
  name: string;
  g: Graph;
  /** Roots that are stack slots: writes to them run no barrier. The others are globals. */
  stack: string[];
  ops: ConcOp[];
}

export interface ConcState {
  g: Graph;
  color: Record<number, Tri>;
  gray: number[];
  rootsScanned: boolean;
  rescanned: boolean;
  opIdx: number;
  log: { who: "mutator" | "marker" | "barrier"; text: string }[];
  done: boolean;
  freed: number[];
  /** Objects that a barrier shaded. */
  shades: number;
  /** Root slots read again at the end (Dijkstra's stack rescan, with the world stopped). */
  rescanWork: number;
}

export function slotText(s: ConcSlot) { return "root" in s ? s.root : `${s.obj}.f${s.field}`; }
export const opText = (op: ConcOp) => `${slotText(op.dst)} = ${op.src ? slotText(op.src) : "nil"}`;

function read(g: Graph, s: ConcSlot): Ref {
  if ("root" in s) return g.roots.find((r) => r.name === s.root)?.to ?? null;
  const o = g.objs.find((x) => x.name === s.obj);
  return o ? o.fields[s.field] ?? null : null;
}

export function concInit(sc: ConcScenario): ConcState {
  const color: Record<number, Tri> = {};
  for (const o of sc.g.objs) color[o.id] = "white";
  return { g: clone(sc.g), color, gray: [], rootsScanned: false, rescanned: false, opIdx: 0, log: [], done: false, freed: [], shades: 0, rescanWork: 0 };
}

const copyState = (s: ConcState): ConcState => ({ ...s, g: clone(s.g), color: { ...s.color }, gray: [...s.gray], log: [...s.log], freed: [...s.freed] });

function shade(s: ConcState, id: Ref): boolean {
  if (id === null || s.color[id] !== "white") return false;
  s.color[id] = "gray";
  s.gray.push(id);
  return true;
}

/** The mutator runs its next write. */
export function mutatorStep(s0: ConcState, sc: ConcScenario, barrier: Barrier): ConcState {
  if (s0.done || s0.opIdx >= sc.ops.length) return s0;
  const s = copyState(s0);
  const op = sc.ops[s.opIdx++]!;
  const val = op.src ? read(s.g, op.src) : null;
  const isStack = "root" in op.dst && sc.stack.includes(op.dst.root);
  const old = read(s.g, op.dst);
  s.log.push({ who: "mutator", text: `${opText(op)}  (${nameOf(s.g, val)})` });
  if (!isStack && barrier !== "none") {
    const shaded: string[] = [];
    const stackGray = !s.rootsScanned;
    if ((barrier === "yuasa" || barrier === "hybrid") && shade(s, old)) shaded.push(`old ${nameOf(s.g, old)}`);
    if ((barrier === "dijkstra" || (barrier === "hybrid" && stackGray)) && shade(s, val)) shaded.push(`new ${nameOf(s.g, val)}`);
    if (shaded.length) { s.shades += shaded.length; s.log.push({ who: "barrier", text: `shade ${shaded.join(" and ")}` }); }
  }
  if ("root" in op.dst) {
    const dst = op.dst;
    const r = s.g.roots.find((x) => x.name === dst.root);
    if (r) r.to = val; else s.g.roots.push({ name: dst.root, to: val });
  } else {
    obj(s.g, s.g.objs.find((o) => o.name === (op.dst as { obj: string }).obj)!.id).fields[op.dst.field] = val;
  }
  return s;
}

/** The marker does one step: scan the roots, scan one gray object, rescan the stacks, or sweep. */
export function markerStep(s0: ConcState, sc: ConcScenario, barrier: Barrier, rescan = true): ConcState {
  if (s0.done) return s0;
  const s = copyState(s0);
  if (!s.rootsScanned) {
    s.rootsScanned = true;
    const got = s.g.roots.filter((r) => shade(s, r.to)).map((r) => nameOf(s.g, r.to));
    s.log.push({ who: "marker", text: `scan roots: shade ${got.join(", ") || "nothing"}` });
    return s;
  }
  if (s.gray.length) {
    const id = s.gray.shift()!;
    const got = obj(s.g, id).fields.filter((t) => shade(s, t)).map((t) => nameOf(s.g, t));
    s.color[id] = "black";
    s.log.push({ who: "marker", text: `scan ${nameOf(s.g, id)}: ${got.length ? `shade ${got.join(", ")}` : "no white children"}; ${nameOf(s.g, id)} is black` });
    return s;
  }
  if (barrier === "dijkstra" && rescan && !s.rescanned) {
    s.rescanned = true;
    const stackRoots = s.g.roots.filter((r) => sc.stack.includes(r.name));
    s.rescanWork += stackRoots.length;
    const got = stackRoots.filter((r) => shade(s, r.to)).map((r) => nameOf(s.g, r.to));
    s.log.push({ who: "marker", text: `stop the world, rescan stacks: ${got.length ? `shade ${got.join(", ")}` : "nothing new"}` });
    if (got.length) return s;
  }
  // sweep
  const white = s.g.objs.filter((o) => s.color[o.id] === "white").map((o) => o.id);
  s.freed = white;
  s.done = true;
  s.log.push({ who: "marker", text: `sweep: free ${white.map((id) => nameOf(sc.g, id)).join(", ") || "nothing"}` });
  return s;
}

/**
 * After the sweep: lost objects (freed although a pointer still reaches them) and floating garbage (kept although
 * unreachable). The freed objects stay in the graph of the state, so a view can draw them as freed.
 */
export function verdict(s: ConcState) {
  // the freed objects stay in s.g, so the pointers to them still count for reachability
  const reach = reachable(s.g);
  const lost = s.freed.filter((id) => reach.has(id)).map((id) => nameOf(s.g, id));
  const floating = s.g.objs.filter((o) => !reach.has(o.id) && !s.freed.includes(o.id)).map((o) => o.name);
  return { lost, floating };
}

/** Runs a whole interleaving: "m" = mutator step, "c" = marker (collector) step; then the marker runs to the end. */
export function runSchedule(sc: ConcScenario, barrier: Barrier, schedule: string, rescan = true): ConcState {
  let s = concInit(sc);
  for (const ch of schedule) s = ch === "m" ? mutatorStep(s, sc, barrier) : markerStep(s, sc, barrier, rescan);
  while (s.opIdx < sc.ops.length && !s.done) s = mutatorStep(s, sc, barrier);
  let guard = 0;
  while (!s.done && guard++ < 1000) s = markerStep(s, sc, barrier, rescan);
  return s;
}

// ---------------------------------------------------------------- scenarios

/** The classic lost object: a black object gets the only pointer to a white one, and the gray path to it is cut. */
export const HEAP_SCENARIO: ConcScenario = {
  name: "Heap: move a pointer into a black object",
  g: { objs: [
    { id: 1, name: "A", size: 32, fields: [null, 2] },
    { id: 2, name: "B", size: 32, fields: [3, null] },
    { id: 3, name: "C", size: 32, fields: [null, null] },
    { id: 4, name: "D", size: 32, fields: [null, null] },
  ], roots: [{ name: "g", to: 1 }, { name: "stk", to: null }] },
  stack: ["stk"],
  ops: [{ dst: { obj: "A", field: 0 }, src: { obj: "B", field: 0 } }, { dst: { obj: "B", field: 0 }, src: null }],
};

/** The same object hidden on a stack: the mutator loads the pointer into a local, then deletes it from the heap. */
export const STACK_SCENARIO: ConcScenario = {
  name: "Stack: hide a pointer in a local",
  g: { objs: [
    { id: 1, name: "A", size: 32, fields: [2, null] },
    { id: 2, name: "B", size: 32, fields: [3, null] },
    { id: 3, name: "C", size: 32, fields: [null, null] },
    { id: 4, name: "D", size: 32, fields: [null, null] },
  ], roots: [{ name: "g", to: 1 }, { name: "stk", to: null }] },
  stack: ["stk"],
  ops: [{ dst: { root: "stk" }, src: { obj: "B", field: 0 } }, { dst: { obj: "B", field: 0 }, src: null }],
};

// ---------------------------------------------------------------- many random runs

export interface TrialStats { trials: number; lostRuns: number; lostObjects: number; floating: number; shades: number; rescan: number }

/** A random graph of n objects with 2 fields, one global and one stack root, and a random legal mutator script. */
export function randomScenario(seed: number, n = 10, ops = 6): ConcScenario {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const objs = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `o${i}`, size: 32, fields: [null, null] as Ref[] }));
  for (const o of objs) for (let f = 0; f < 2; f++) if (r() < 0.6) o.fields[f] = 1 + Math.floor(r() * n);
  const g: Graph = { objs, roots: [{ name: "g", to: 1 }, { name: "stk", to: 1 + Math.floor(r() * n) }] };
  // a script: each write copies a field or a root that the mutator can reach now into a slot it can reach now
  let cur = clone(g);
  const script: ConcOp[] = [];
  for (let k = 0; k < ops; k++) {
    const reach = [...reachable(cur)].map((id) => obj(cur, id).name);
    const slots: ConcSlot[] = [{ root: "stk" }, ...reach.flatMap((nm) => [{ obj: nm, field: 0 }, { obj: nm, field: 1 }])];
    const dst = pick(slots.filter((s) => !("root" in s && s.root === "g")));
    const src = r() < 0.3 ? null : pick(slots);
    const op: ConcOp = { dst, src };
    script.push(op);
    const st = mutatorStep({ ...concInit({ name: "", g: cur, stack: ["stk"], ops: [op] }), rootsScanned: true }, { name: "", g: cur, stack: ["stk"], ops: [op] }, "none");
    cur = st.g;
  }
  return { name: `random ${seed}`, g, stack: ["stk"], ops: script };
}

/** Runs `trials` random scenarios with random interleavings under one barrier, and sums the outcomes. */
export function barrierTrials(barrier: Barrier, trials = 400, seed = 1, rescan = true, opt: { n?: number; ops?: number; pm?: number } = {}): TrialStats {
  const { n = 6, ops = 12, pm = 0.7 } = opt;
  const out: TrialStats = { trials, lostRuns: 0, lostObjects: 0, floating: 0, shades: 0, rescan: 0 };
  for (let t = 0; t < trials; t++) {
    const sc = randomScenario(seed * 100003 + t, n, ops);
    const r = rng(seed * 7919 + t);
    // the marker scans the roots first; then the two take turns at random
    let sched = "c";
    for (let i = 0; i < ops + n; i++) sched += r() < pm ? "m" : "c";
    const s = runSchedule(sc, barrier, sched, rescan);
    const v = verdict(s);
    if (v.lost.length) out.lostRuns++;
    out.lostObjects += v.lost.length;
    out.floating += v.floating.length;
    out.shades += s.shades;
    out.rescan += s.rescanWork;
  }
  return out;
}
