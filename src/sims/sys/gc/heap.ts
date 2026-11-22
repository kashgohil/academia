/**
 * The one object-graph model that every collector of the gc module runs on.
 *
 * A heap is a list of objects. Each object has a name, a size in bytes and a fixed number of pointer fields. A field
 * holds the id of another object or null. Roots are named slots outside the heap (locals on a stack, globals). An
 * object is live when a chain of pointers from a root reaches it. A collector never sees names: it sees ids, fields
 * and roots, as a real collector sees addresses, pointer maps and the root set.
 *
 * A mutator script is a list of operations (`MutOp`): allocate an object, write a field, write a root. `apply` runs
 * one operation and returns a new graph, so steppers can keep every state. Graphs are small (up to about 30 objects
 * for the views; the cost models in other files use counts, not graphs).
 *
 * `toMachine` copies a graph into the shared program-memory machine (src/sims/sys/mem), so demos can show it with the
 * shared heap views and run LeakSanitizer on it.
 */
import { Machine, ptr, struct, type Ptr, type Type } from "../mem";

export type Ref = number | null;

export interface GcObj {
  id: number;
  name: string;
  /** Pointer fields. A field holds an object id, or null. */
  fields: Ref[];
  /** Bytes, including the header. A model value. */
  size: number;
}

export interface Root { name: string; to: Ref }

export interface Graph { objs: GcObj[]; roots: Root[] }

/** A position in unit coordinates (0..1) for the graph views. */
export interface Pos { x: number; y: number }

export type MutOp =
  | { op: "new"; name: string; fields?: number; size?: number; root?: string }
  | { op: "write"; obj: string; field: number; to: string | null }
  | { op: "root"; root: string; to: string | null };

/** One pointer: from an object field or a root, to an object. */
export interface Edge { from: number | string; field: number; to: number }

/**
 * Builds a graph from names: `build({ A: ["B", null], B: [] }, { x: "A" })`. Ids follow the order of the keys,
 * from 1. `sizes` gives sizes by name (default 32 bytes).
 */
export function build(objs: Record<string, (string | null)[]>, roots: Record<string, string | null>, sizes: Record<string, number> = {}): Graph {
  const names = Object.keys(objs);
  const id = (n: string | null): Ref => {
    if (n === null) return null;
    const i = names.indexOf(n);
    if (i < 0) throw new Error(`unknown object ${n}`);
    return i + 1;
  };
  return {
    objs: names.map((n, i) => ({ id: i + 1, name: n, fields: objs[n]!.map(id), size: sizes[n] ?? 32 })),
    roots: Object.entries(roots).map(([name, to]) => ({ name, to: id(to) })),
  };
}

export const clone = (g: Graph): Graph => ({ objs: g.objs.map((o) => ({ ...o, fields: [...o.fields] })), roots: g.roots.map((r) => ({ ...r })) });

export function obj(g: Graph, id: number): GcObj {
  const o = g.objs.find((x) => x.id === id);
  if (!o) throw new Error(`no object ${id}`);
  return o;
}

export const idOf = (g: Graph, name: string): number => {
  const o = g.objs.find((x) => x.name === name);
  if (!o) throw new Error(`no object ${name}`);
  return o.id;
};

export const nameOf = (g: Graph, id: Ref) => (id === null ? "null" : obj(g, id).name);

/** All pointers in the heap and in the roots. Root edges have the root name in `from` and field 0. */
export function edges(g: Graph): Edge[] {
  const out: Edge[] = [];
  for (const r of g.roots) if (r.to !== null) out.push({ from: r.name, field: 0, to: r.to });
  for (const o of g.objs) o.fields.forEach((t, i) => { if (t !== null) out.push({ from: o.id, field: i, to: t }); });
  return out;
}

/** The ids that a chain of pointers from a root reaches. This is the truth that every collector must respect. */
export function reachable(g: Graph, from: Ref[] = g.roots.map((r) => r.to)): Set<number> {
  const seen = new Set<number>();
  const stack = from.filter((x): x is number => x !== null);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const t of obj(g, id).fields) if (t !== null && !seen.has(t)) stack.push(t);
  }
  return seen;
}

/** Objects that no root reaches. */
export const garbage = (g: Graph): number[] => { const r = reachable(g); return g.objs.filter((o) => !r.has(o.id)).map((o) => o.id); };

/** Bytes of all objects in `ids`. */
export const bytesOf = (g: Graph, ids: Iterable<number>) => [...ids].reduce((s, id) => s + obj(g, id).size, 0);

/** Runs one mutator operation on a copy of the graph. A new object gets the next free id. */
export function apply(g0: Graph, op: MutOp): Graph {
  const g = clone(g0);
  const ref = (n: string | null): Ref => (n === null ? null : idOf(g, n));
  if (op.op === "new") {
    const id = g.objs.reduce((m, o) => Math.max(m, o.id), 0) + 1;
    g.objs.push({ id, name: op.name, fields: Array(op.fields ?? 2).fill(null), size: op.size ?? 32 });
    if (op.root) setRoot(g, op.root, id);
  } else if (op.op === "write") {
    obj(g, idOf(g, op.obj)).fields[op.field] = ref(op.to);
  } else {
    setRoot(g, op.root, ref(op.to));
  }
  return g;
}

function setRoot(g: Graph, name: string, to: Ref) {
  const r = g.roots.find((x) => x.name === name);
  if (r) r.to = to;
  else g.roots.push({ name, to });
}

/** Removes objects (a collector frees them). Fields that point at them stay as they are: they now dangle. */
export const without = (g: Graph, ids: Iterable<number>): Graph => {
  const drop = new Set(ids);
  const c = clone(g);
  c.objs = c.objs.filter((o) => !drop.has(o.id));
  return c;
};

/** Pointers that point at an object that is not in the graph any more: what a wrong collector leaves behind. */
export function dangling(g: Graph): Edge[] {
  const ids = new Set(g.objs.map((o) => o.id));
  const out: Edge[] = [];
  for (const r of g.roots) if (r.to !== null && !ids.has(r.to)) out.push({ from: r.name, field: 0, to: r.to });
  for (const o of g.objs) o.fields.forEach((t, i) => { if (t !== null && !ids.has(t)) out.push({ from: o.id, field: i, to: t }); });
  return out;
}

/** A deterministic random number generator (mulberry32), so every model run is repeatable. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the shared machine

/** The C type of a model object with n pointer fields: `struct obj { struct obj *f0, *f1, ...; }`. */
export function objType(n: number): Type {
  return struct(`obj${n}`, Array.from({ length: Math.max(1, n) }, (_, i) => [`f${i}`, ptr()] as [string, Type]));
}

/**
 * Copies a graph into the shared machine: one heap block per object (allocNamed, with real pointer fields), one
 * global per root. With `exit`, the machine then runs its LeakSanitizer-style check: every object that no root
 * reaches is reported as a leak. The machine stores only pointers; the model size of an object is not used.
 */
export function toMachine(g: Graph, { exit = false }: { exit?: boolean } = {}): { m: Machine; ptrs: Map<number, Ptr> } {
  const m = new Machine();
  const ptrs = new Map<number, Ptr>();
  for (const o of g.objs) ptrs.set(o.id, m.allocNamed("obj", o.name, { type: objType(o.fields.length) }));
  for (const o of g.objs) {
    const p = ptrs.get(o.id)!;
    o.fields.forEach((t, i) => { if (t !== null && ptrs.has(t)) m.store({ addr: p.addr + 8 * i, alloc: p.alloc }, ptr(), ptrs.get(t)!); });
  }
  for (const r of g.roots) {
    const gp = m.global(r.name, ptr());
    if (r.to !== null && ptrs.has(r.to)) m.store(gp, ptr(), ptrs.get(r.to)!);
  }
  if (exit) m.exit();
  return { m, ptrs };
}
