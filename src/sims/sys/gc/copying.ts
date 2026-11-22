/**
 * Copying collection on the shared object graph.
 *
 * - `cheney` returns the frames of Cheney's algorithm (C. J. Cheney, "A nonrecursive list compacting algorithm",
 *   CACM 13(11), 1970): copy the objects that the roots point to into to-space, then move a scan pointer through
 *   to-space; for each field of the object at scan, copy its target (unless it already has a forwarding pointer)
 *   and update the field. Copying stops when scan reaches free. To-space itself is the queue, so the copy order is
 *   breadth first and no extra stack is needed.
 * - `copyOrder` gives the order of a breadth-first (Cheney) or depth-first copy; `scattered` gives a fragmented
 *   allocation order. `lineSwitches` counts how often a walk of the objects moves to a different cache line: a
 *   measure of locality for the layout that a copy order produces.
 */
import { obj, rng, type Graph } from "./heap";

export interface CopyFrame {
  /** Objects in to-space, in copy order, with their new addresses. */
  copied: { id: number; addr: number }[];
  /** id → address in to-space: the forwarding pointer left in the old copy. */
  fwd: Record<number, number>;
  /** Index into `copied` of the object at the scan pointer. */
  scanIdx: number;
  scan: number;
  free: number;
  /** For each copied object: which fields already hold to-space addresses. */
  updated: Record<number, boolean[]>;
  rootsUpdated: string[];
  phase: "start" | "roots" | "scan" | "done";
  focus?: number;
  text: string;
  bytesCopied: number;
}

export const FROM_BASE = 0x1000;
export const TO_BASE = 0x2000;

const rounded = (n: number) => Math.ceil(n / 16) * 16;

export function cheney(g: Graph, toBase = TO_BASE): CopyFrame[] {
  const copied: { id: number; addr: number }[] = [];
  const fwd: Record<number, number> = {};
  const updated: Record<number, boolean[]> = {};
  const rootsUpdated: string[] = [];
  let free = toBase, scanIdx = 0, bytes = 0;
  const frames: CopyFrame[] = [];
  const name = (id: number) => obj(g, id).name;
  const scanAddr = () => (scanIdx < copied.length ? copied[scanIdx]!.addr : free);
  const snap = (phase: CopyFrame["phase"], text: string, focus?: number) =>
    frames.push({
      copied: copied.map((c) => ({ ...c })), fwd: { ...fwd }, scanIdx, scan: scanAddr(), free,
      updated: Object.fromEntries(Object.entries(updated).map(([k, v]) => [k, [...v]])), rootsUpdated: [...rootsUpdated], phase, focus, text, bytesCopied: bytes,
    });
  const copy = (id: number): { addr: number; fresh: boolean } => {
    if (fwd[id] !== undefined) return { addr: fwd[id]!, fresh: false };
    const o = obj(g, id);
    const addr = free;
    free += rounded(o.size);
    bytes += o.size;
    fwd[id] = addr;
    copied.push({ id, addr });
    updated[id] = o.fields.map((t) => t === null);
    return { addr, fresh: true };
  };
  snap("start", "To-space is empty. scan and free both point to its start.");
  for (const r of g.roots) {
    if (r.to === null) continue;
    const c = copy(r.to);
    rootsUpdated.push(r.name);
    snap("roots", c.fresh
      ? `Root ${r.name}: copy ${name(r.to)} to 0x${c.addr.toString(16)}, leave a forwarding pointer in the old copy, and update the root.`
      : `Root ${r.name}: ${name(r.to)} already has a forwarding pointer. Just update the root.`, r.to);
  }
  while (scanIdx < copied.length) {
    const { id } = copied[scanIdx]!;
    const o = obj(g, id);
    o.fields.forEach((t, i) => {
      if (t === null) return;
      const c = copy(t);
      updated[id]![i] = true;
      snap("scan", c.fresh
        ? `Scan ${o.name}.f${i}: ${name(t)} is not copied yet. Copy it to free (0x${c.addr.toString(16)}) and update the field.`
        : `Scan ${o.name}.f${i}: ${name(t)} has a forwarding pointer to 0x${c.addr.toString(16)}. Update the field only.`, t);
    });
    scanIdx++;
    snap("scan", `${o.name} is scanned. scan moves past it.`, id);
  }
  snap("done", `scan = free: done. ${copied.length} objects (${bytes} bytes) copied. All of from-space is free now, and the roles of the two halves swap.`);
  return frames;
}

/** The copy order of a breadth-first (Cheney) or depth-first (pre-order, recursive) copier, from the roots. */
export function copyOrder(g: Graph, kind: "bfs" | "dfs"): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  if (kind === "bfs") {
    const q = g.roots.map((r) => r.to).filter((x): x is number => x !== null);
    for (const id of q) if (!seen.has(id)) { seen.add(id); out.push(id); }
    for (let i = 0; i < out.length; i++) for (const t of obj(g, out[i]!).fields) if (t !== null && !seen.has(t)) { seen.add(t); out.push(t); }
  } else {
    const visit = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id); out.push(id);
      for (const t of obj(g, id).fields) if (t !== null) visit(t);
    };
    for (const r of g.roots) if (r.to !== null) visit(r.to);
  }
  return out;
}

/** A complete binary tree of `n` nodes (heap order: node i has children 2i+1 and 2i+2), one root. */
export function tree(n: number, size = 32): Graph {
  return {
    objs: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `t${i}`, size, fields: [2 * i + 1 < n ? 2 * i + 2 : null, 2 * i + 2 < n ? 2 * i + 3 : null] })),
    roots: [{ name: "root", to: n ? 1 : null }],
  };
}

/** A linked list of `n` nodes. */
export function list(n: number, size = 32): Graph {
  return { objs: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `n${i}`, size, fields: [i + 1 < n ? i + 2 : null] })), roots: [{ name: "head", to: n ? 1 : null }] };
}

/**
 * Addresses for a fragmented heap: the objects were allocated between other objects that died, so each object is at
 * a random slot among `slots` (deterministic for a seed).
 */
export function scattered(g: Graph, slots: number, seed = 7, size = 32): Record<number, number> {
  const r = rng(seed);
  const free = Array.from({ length: slots }, (_, i) => i);
  for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [free[i], free[j]] = [free[j]!, free[i]!]; }
  return Object.fromEntries(g.objs.map((o, i) => [o.id, FROM_BASE + free[i]! * size]));
}

/** Addresses for objects packed in the given order. */
export function packed(g: Graph, order: number[], base = TO_BASE): Record<number, number> {
  const out: Record<number, number> = {};
  let a = base;
  for (const id of order) { out[id] = a; a += rounded(obj(g, id).size); }
  return out;
}

/**
 * The cache lines that a walk touches, in order, and how often consecutive accesses are on different lines. A walk
 * that stays on one line for two 32-byte objects needs one line fill for both.
 */
export function lineSwitches(walk: number[], addr: Record<number, number>, line = 64) {
  const lines = walk.map((id) => Math.floor(addr[id]! / line));
  let switches = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] !== lines[i - 1]) switches++;
  return { lines, switches, distinct: new Set(lines).size, fills: lines.length ? switches + 1 : 0 };
}

/** Misses of a walk in a tiny fully associative LRU cache of `cache` lines: a rough proxy for cache misses. */
export function lruMisses(walk: number[], addr: Record<number, number>, cache = 4, line = 64): number {
  const lru: number[] = [];
  let miss = 0;
  for (const id of walk) {
    const l = Math.floor(addr[id]! / line);
    const i = lru.indexOf(l);
    if (i >= 0) lru.splice(i, 1);
    else { miss++; if (lru.length >= cache) lru.shift(); }
    lru.push(l);
  }
  return miss;
}

export type Layout = "scattered" | "bfs" | "dfs";

/** The addresses of a graph after a fragmented allocation, a Cheney (BFS) copy, or a depth-first copy. */
export function layoutFor(g: Graph, kind: Layout, slots = 4 * g.objs.length): Record<number, number> {
  return kind === "scattered" ? scattered(g, slots) : packed(g, copyOrder(g, kind));
}
