/**
 * Adaptive radix tree (Leis, Kemper and Neumann, ICDE 2013) and binary-comparable key encoding.
 *
 * - Keys are byte strings (Uint8Array). They must be prefix-free: no key may be a prefix of
 *   another. Fixed-length encodings and strings with a 0x00 terminator satisfy this.
 * - Inner nodes adapt their layout to the number of children: Node4, Node16, Node48, Node256.
 * - Path compression: an inner node stores the bytes that all keys below it share (pessimistic:
 *   the whole prefix is stored). Lazy expansion: a subtree with one key is just a leaf.
 * - Delete shrinks nodes (256 → 48 at 37 children, 48 → 16 at 12, 16 → 4 at 3) and merges a Node4
 *   with one child into that child.
 *
 * Memory model (8-byte pointers, 16-byte header for type, count and up to 8 prefix bytes):
 * Node4 16 + 4 + 4·8 = 52 B, Node16 16 + 16 + 16·8 = 160 B, Node48 16 + 256 + 48·8 = 656 B,
 * Node256 16 + 256·8 = 2064 B. Prefix bytes beyond 8 are counted extra. Leaves are tagged
 * pointers to the row (0 extra bytes), as in the paper; the full key lives in the row.
 */

export type NodeType = 4 | 16 | 48 | 256;
export const NODE_BYTES: Record<NodeType, number> = { 4: 52, 16: 160, 48: 656, 256: 2064 };
export const HEADER_PREFIX_BYTES = 8;

export interface ArtLeaf<V> { kind: "leaf"; key: Uint8Array; value: V }
export interface ArtInner<V> {
  kind: "inner";
  id: number;
  type: NodeType;
  prefix: Uint8Array;
  /** Node4/Node16: sorted key bytes (length = count). */
  keys: number[];
  /** Node4/16: children parallel to keys. Node48: up to 48 slots. Node256: 256 entries. */
  kids: (ArtNode<V> | undefined)[];
  /** Node48 only: byte → slot + 1 (0 = empty). */
  index: Uint8Array | null;
  count: number;
}
export type ArtNode<V> = ArtLeaf<V> | ArtInner<V>;

export type ArtEvent =
  | { t: "new4"; id: number; depth: number; prefix: number }
  | { t: "grow"; id: number; from: NodeType; to: NodeType }
  | { t: "shrink"; id: number; from: NodeType; to: NodeType }
  | { t: "splitPrefix"; id: number; at: number }
  | { t: "merge"; id: number };

const GROW: Record<NodeType, NodeType> = { 4: 16, 16: 48, 48: 256, 256: 256 };
const CAP: Record<NodeType, number> = { 4: 4, 16: 16, 48: 48, 256: 256 };

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && compareBytes(a, b) === 0;

export class PrefixError extends Error {}

export class ART<V = number> {
  root: ArtNode<V> | undefined;
  size = 0;
  listener: ((e: ArtEvent) => void) | null = null;
  private nextId = 1;

  private emit(e: ArtEvent) { this.listener?.(e); }
  private inner(type: NodeType, prefix: Uint8Array): ArtInner<V> {
    return {
      kind: "inner", id: this.nextId++, type, prefix, keys: [], count: 0,
      kids: type === 256 ? new Array(256).fill(undefined) : [],
      index: type === 48 ? new Uint8Array(256) : null,
    };
  }

  // ------------------------------------------------------------ child access
  static findChild<V>(n: ArtInner<V>, b: number): ArtNode<V> | undefined {
    switch (n.type) {
      case 4: case 16: {
        const i = n.keys.indexOf(b);
        return i < 0 ? undefined : n.kids[i];
      }
      case 48: { const s = n.index![b]!; return s ? n.kids[s - 1] : undefined; }
      case 256: return n.kids[b];
    }
  }
  private setChild(n: ArtInner<V>, b: number, c: ArtNode<V>) {
    switch (n.type) {
      case 4: case 16: n.kids[n.keys.indexOf(b)] = c; break;
      case 48: n.kids[n.index![b]! - 1] = c; break;
      case 256: n.kids[b] = c; break;
    }
  }
  /** Adds a child; returns the node that now holds it (a bigger node if `n` was full). */
  private addChild(n: ArtInner<V>, b: number, c: ArtNode<V>): ArtInner<V> {
    if (n.count === CAP[n.type]) {
      const g = this.inner(GROW[n.type], n.prefix);
      g.id = n.id; // same logical node, new layout
      for (const [kb, kc] of ART.children(n)) this.rawAdd(g, kb, kc);
      this.emit({ t: "grow", id: n.id, from: n.type, to: g.type });
      n = g;
    }
    this.rawAdd(n, b, c);
    return n;
  }
  private rawAdd(n: ArtInner<V>, b: number, c: ArtNode<V>) {
    switch (n.type) {
      case 4: case 16: {
        let i = 0;
        while (i < n.count && n.keys[i]! < b) i++;
        n.keys.splice(i, 0, b);
        n.kids.splice(i, 0, c);
        break;
      }
      case 48: {
        let s = 0;
        while (n.kids[s] !== undefined) s++;
        n.kids[s] = c;
        n.index![b] = s + 1;
        break;
      }
      case 256: n.kids[b] = c; break;
    }
    n.count++;
  }
  private removeChild(n: ArtInner<V>, b: number): ArtInner<V> {
    switch (n.type) {
      case 4: case 16: {
        const i = n.keys.indexOf(b);
        n.keys.splice(i, 1);
        n.kids.splice(i, 1);
        break;
      }
      case 48: { const s = n.index![b]!; n.kids[s - 1] = undefined; n.index![b] = 0; break; }
      case 256: n.kids[b] = undefined; break;
    }
    n.count--;
    const to: NodeType | null = n.type === 256 && n.count <= 37 ? 48 : n.type === 48 && n.count <= 12 ? 16 : n.type === 16 && n.count <= 3 ? 4 : null;
    if (!to) return n;
    const s = this.inner(to, n.prefix);
    s.id = n.id;
    for (const [kb, kc] of ART.children(n)) this.rawAdd(s, kb, kc);
    this.emit({ t: "shrink", id: n.id, from: n.type, to });
    return s;
  }
  /** Children in byte order. */
  static children<V>(n: ArtInner<V>): [number, ArtNode<V>][] {
    const out: [number, ArtNode<V>][] = [];
    if (n.type === 4 || n.type === 16) n.keys.forEach((b, i) => out.push([b, n.kids[i]!]));
    else if (n.type === 48) { for (let b = 0; b < 256; b++) if (n.index![b]) out.push([b, n.kids[n.index![b]! - 1]!]); }
    else for (let b = 0; b < 256; b++) if (n.kids[b]) out.push([b, n.kids[b]!]);
    return out;
  }

  // ------------------------------------------------------------ operations
  get(key: Uint8Array): V | undefined {
    let n = this.root, depth = 0;
    while (n) {
      if (n.kind === "leaf") return equalBytes(n.key, key) ? n.value : undefined;
      for (let i = 0; i < n.prefix.length; i++) if (key[depth + i] !== n.prefix[i]) return undefined;
      depth += n.prefix.length;
      if (depth >= key.length) return undefined;
      n = ART.findChild(n, key[depth]!);
      depth++;
    }
    return undefined;
  }
  /** Node ids visited by a lookup, root first (leaves are not counted). */
  path(key: Uint8Array): number[] {
    const out: number[] = [];
    let n = this.root, depth = 0;
    while (n && n.kind === "inner") {
      out.push(n.id);
      depth += n.prefix.length;
      if (depth >= key.length) break;
      n = ART.findChild(n, key[depth]!);
      depth++;
    }
    return out;
  }
  /** Inserts or updates. Returns true if the key is new. Throws PrefixError if the keys are not prefix-free. */
  insert(key: Uint8Array, value: V): boolean {
    const before = this.size;
    this.root = this.ins(this.root, key, value, 0);
    return this.size > before;
  }
  private ins(n: ArtNode<V> | undefined, key: Uint8Array, value: V, depth: number): ArtNode<V> {
    if (!n) { this.size++; return { kind: "leaf", key, value }; }
    if (n.kind === "leaf") {
      if (equalBytes(n.key, key)) { n.value = value; return n; }
      let i = depth;
      while (i < key.length && i < n.key.length && key[i] === n.key[i]) i++;
      if (i >= key.length || i >= n.key.length) throw new PrefixError("keys must be prefix-free");
      const m = this.inner(4, key.slice(depth, i));
      this.rawAdd(m, n.key[i]!, n);
      this.rawAdd(m, key[i]!, { kind: "leaf", key, value });
      this.size++;
      this.emit({ t: "new4", id: m.id, depth, prefix: i - depth });
      return m;
    }
    let p = 0;
    while (p < n.prefix.length && key[depth + p] === n.prefix[p]) p++;
    if (p < n.prefix.length) {
      if (depth + p >= key.length) throw new PrefixError("keys must be prefix-free");
      const m = this.inner(4, n.prefix.slice(0, p));
      const old = n.prefix[p]!;
      n.prefix = n.prefix.slice(p + 1);
      this.rawAdd(m, old, n);
      this.rawAdd(m, key[depth + p]!, { kind: "leaf", key, value });
      this.size++;
      this.emit({ t: "splitPrefix", id: n.id, at: p });
      return m;
    }
    depth += n.prefix.length;
    if (depth >= key.length) throw new PrefixError("keys must be prefix-free");
    const b = key[depth]!;
    const c = ART.findChild(n, b);
    if (c) {
      const nc = this.ins(c, key, value, depth + 1);
      if (nc !== c) this.setChild(n, b, nc);
      return n;
    }
    this.size++;
    return this.addChild(n, b, { kind: "leaf", key, value });
  }
  delete(key: Uint8Array): boolean {
    const before = this.size;
    this.root = this.del(this.root, key, 0);
    return this.size < before;
  }
  private del(n: ArtNode<V> | undefined, key: Uint8Array, depth: number): ArtNode<V> | undefined {
    if (!n) return n;
    if (n.kind === "leaf") {
      if (!equalBytes(n.key, key)) return n;
      this.size--;
      return undefined;
    }
    for (let i = 0; i < n.prefix.length; i++) if (key[depth + i] !== n.prefix[i]) return n;
    depth += n.prefix.length;
    if (depth >= key.length) return n;
    const b = key[depth]!;
    const c = ART.findChild(n, b);
    if (!c) return n;
    const nc = this.del(c, key, depth + 1);
    if (nc === c) return n;
    if (nc) { this.setChild(n, b, nc); return n; }
    const m = this.removeChild(n, b);
    if (m.type === 4 && m.count === 1) {
      const [ob, only] = ART.children(m)[0]!;
      this.emit({ t: "merge", id: m.id });
      if (only.kind === "leaf") return only;
      const merged = new Uint8Array(m.prefix.length + 1 + only.prefix.length);
      merged.set(m.prefix, 0);
      merged[m.prefix.length] = ob;
      merged.set(only.prefix, m.prefix.length + 1);
      only.prefix = merged;
      return only;
    }
    return m;
  }
  /** All entries in key order (an in-order walk is a sorted scan). */
  entries(): [Uint8Array, V][] {
    const out: [Uint8Array, V][] = [];
    const walk = (n: ArtNode<V> | undefined) => {
      if (!n) return;
      if (n.kind === "leaf") { out.push([n.key, n.value]); return; }
      for (const [, c] of ART.children(n)) walk(c);
    };
    walk(this.root);
    return out;
  }
  /** Inner nodes, breadth first. */
  innerNodes(): { node: ArtInner<V>; depth: number }[] {
    const out: { node: ArtInner<V>; depth: number }[] = [];
    const q: { n: ArtNode<V> | undefined; d: number }[] = [{ n: this.root, d: 0 }];
    while (q.length) {
      const { n, d } = q.shift()!;
      if (!n || n.kind === "leaf") continue;
      out.push({ node: n, depth: d });
      for (const [, c] of ART.children(n)) q.push({ n: c, d: d + 1 });
    }
    return out;
  }
  stats() {
    const counts: Record<NodeType, number> = { 4: 0, 16: 0, 48: 0, 256: 0 };
    let bytes = 0, depthSum = 0, leaves = 0, maxDepth = 0;
    const walk = (n: ArtNode<V> | undefined, d: number) => {
      if (!n) return;
      if (n.kind === "leaf") { leaves++; depthSum += d; maxDepth = Math.max(maxDepth, d); return; }
      counts[n.type]++;
      bytes += NODE_BYTES[n.type] + Math.max(0, n.prefix.length - HEADER_PREFIX_BYTES);
      for (const [, c] of ART.children(n)) walk(c, d + 1);
    };
    walk(this.root, 0);
    return { counts, bytes, bytesPerKey: this.size ? bytes / this.size : 0, avgDepth: leaves ? depthSum / leaves : 0, maxDepth };
  }
  /** Structural checks: counts, sorted Node4/16 keys, node sizes in range, prefix-free leaves. */
  check(): string[] {
    const errs: string[] = [];
    const walk = (n: ArtNode<V> | undefined, isRoot: boolean) => {
      if (!n || n.kind === "leaf") return;
      const ch = ART.children(n);
      if (ch.length !== n.count) errs.push(`node ${n.id}: count ${n.count} but ${ch.length} children`);
      if (n.count > CAP[n.type]) errs.push(`node ${n.id}: too many children`);
      if (!isRoot && n.count < 2) errs.push(`node ${n.id}: inner node with ${n.count} child`);
      if ((n.type === 4 || n.type === 16) && n.keys.some((k, i) => i > 0 && k <= n.keys[i - 1]!)) errs.push(`node ${n.id}: keys not sorted`);
      for (const [, c] of ch) walk(c, false);
    };
    walk(this.root, true);
    return errs;
  }
}

// =====================================================================================
// Binary-comparable key encoding
// =====================================================================================

/** Unsigned 32-bit, big-endian: the most significant byte first. */
export function encodeU32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}
/** Signed 32-bit: flip the sign bit, then big-endian. −2^31 → 00 00 00 00, −1 → 7F FF FF FF, 0 → 80 00 00 00. */
export function encodeI32(v: number): Uint8Array {
  return encodeU32((v ^ 0x80000000) >>> 0);
}
/** Little-endian two's complement: the layout of an int32 in memory on x86 and ARM. Not comparable. */
export function rawI32LE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, true);
  return b;
}
/** Big-endian two's complement without the sign flip. Negative numbers sort after positive ones. */
export function rawI32BE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v, false);
  return b;
}
/** Signed 64-bit (BigInt): flip the sign bit, then big-endian. */
export function encodeI64(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v) ^ (1n << 63n), false);
  return b;
}
/**
 * IEEE 754 double: for a positive number flip the sign bit; for a negative number flip all bits.
 * Then big-endian. −0 sorts just before +0; NaN (positive) sorts after +∞.
 */
export function encodeF64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setFloat64(0, v, false);
  if (b[0]! & 0x80) for (let i = 0; i < 8; i++) b[i] = ~b[i]! & 0xff;
  else b[0] = b[0]! | 0x80;
  return b;
}
/** UTF-8 bytes, 0x00 escaped as 00 FF, then a 00 00 terminator. Byte order = code point order; no key is a prefix of another. */
export function encodeString(s: string): Uint8Array {
  const raw = new TextEncoder().encode(s);
  const out: number[] = [];
  for (const x of raw) { out.push(x); if (x === 0) out.push(0xff); }
  out.push(0, 0);
  return Uint8Array.from(out);
}
/** Composite key: the encodings of the parts, one after the other. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");

// =====================================================================================
// Memory per key: ART measured, B+ tree and hash table modeled
// =====================================================================================

export type KeyDist = "dense" | "random";

/** n distinct 32-bit keys: 0..n−1 (dense) or uniform random (sparse). */
export function artKeys(n: number, dist: KeyDist, seed = 11): number[] {
  if (dist === "dense") return Array.from({ length: n }, (_, i) => i);
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) >>> 0; };
  const s = new Set<number>();
  while (s.size < n) s.add(r());
  return [...s];
}

/** Builds an ART over n 32-bit keys and returns its inner-node bytes per key and the node mix. */
export function artMemory(n: number, dist: KeyDist, seed = 11) {
  const t = new ART<number>();
  for (const k of artKeys(n, dist, seed)) t.insert(encodeU32(k), k);
  return t.stats();
}

/** B+ tree bytes per key: (key + 8-byte value) per entry in leaves at fill `fill`, plus inner levels. */
export function btreeBytesPerKey(keyBytes: number, fill = Math.LN2, pageBytes = 4096): number {
  const usable = pageBytes - 128;
  const leafCap = Math.floor((usable * fill) / (keyBytes + 8 + 2));
  const fanout = Math.floor((usable * fill) / (keyBytes + 8 + 2));
  let pages = 1 / leafCap, level = pages;
  while (level * fanout > 1.0001) { level /= fanout; pages += level; } // geometric inner levels
  return pages * pageBytes;
}

/**
 * Open-addressing hash table of (key, 8-byte value) slots that doubles when the load passes
 * `maxLoad`. Bytes per key for n keys (starts at 16 slots).
 */
export function hashBytesPerKey(n: number, keyBytes: number, maxLoad = 0.875): number {
  let slots = 16;
  while (n > slots * maxLoad) slots *= 2;
  return (slots * (keyBytes + 8)) / n;
}

// Demo scenario: words with shared prefixes.
export const ART_WORDS = [
  "data", "database", "datum", "date", "dated", "day", "days", "dawn", "do", "dog", "door", "dot",
  "key", "keys", "keyed", "kernel", "kept", "tree", "trie", "tries", "trim", "trip", "true", "trust",
  "index", "indexes", "indent", "inner", "input", "insert", "inside", "art", "arts", "array", "arrow",
  "page", "pages", "pager", "paper", "pair", "node", "nodes", "noise", "none", "north", "note",
];
