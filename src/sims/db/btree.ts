/**
 * A B+ tree for teaching and for reuse by later modules (the capstone engine imports it).
 *
 * - Keys live in leaves; internal nodes hold separators and child pointers.
 * - Leaves form a doubly linked chain for range scans.
 * - `order` = the maximum number of children of an internal node. Every node holds at most
 *   `order - 1` keys. A non-root leaf holds at least `floor(order / 2)` keys, and a non-root
 *   internal node has at least `ceil(order / 2)` children.
 * - Separator rule: in an internal node, child i holds keys k with keys[i-1] <= k < keys[i].
 * - Instrumented: `stats` counts node reads, node writes, splits, merges, borrows and key
 *   comparisons; `listener` receives a step log (`BEvent`) that demos replay as an animation.
 *
 * Also here: bulk loading (bottom-up build from sorted input), fill/occupancy experiments,
 * and closed-form sizing math (fanout, height, cache lines per lookup, separator truncation).
 * Pure TypeScript, no React.
 */
import { mulberry32 } from "../rng";

export type Cmp<K> = (a: K, b: K) => number;
export const numCmp: Cmp<number> = (a, b) => a - b;
export const strCmp: Cmp<string> = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export interface LeafNode<K, V> {
  kind: "leaf";
  id: number;
  keys: K[];
  vals: V[];
  prev: LeafNode<K, V> | null;
  next: LeafNode<K, V> | null;
}
export interface InnerNode<K, V> {
  kind: "inner";
  id: number;
  keys: K[];
  kids: BNode<K, V>[];
}
export type BNode<K, V> = LeafNode<K, V> | InnerNode<K, V>;

/** One step of an operation. `depth` 0 is the root. Demos take `tree.snapshot()` inside the listener. */
export type BEvent<K> =
  | { t: "visit"; id: number; depth: number }
  | { t: "insert"; id: number; key: K }
  | { t: "update"; id: number; key: K }
  | { t: "overflow"; id: number; depth: number }
  | { t: "split"; id: number; right: number; sep: K; leaf: boolean; depth: number }
  | { t: "newRoot"; id: number }
  | { t: "remove"; id: number; key: K }
  | { t: "underflow"; id: number; depth: number }
  | { t: "borrow"; id: number; from: number; side: "left" | "right"; leaf: boolean }
  | { t: "merge"; left: number; right: number; leaf: boolean }
  | { t: "collapse"; id: number }
  | { t: "scan"; id: number }
  | { t: "found"; id: number; key: K }
  | { t: "missing"; id: number; key: K };

export interface TreeStats {
  /** Node visits (page reads if every node is a page). */
  reads: number;
  /** Node modifications (page writes before any buffering). */
  writes: number;
  splits: number;
  merges: number;
  borrows: number;
  comparisons: number;
  allocs: number;
  frees: number;
}
const zeroStats = (): TreeStats => ({ reads: 0, writes: 0, splits: 0, merges: 0, borrows: 0, comparisons: 0, allocs: 0, frees: 0 });

/**
 * Split policy.
 * - "half": an overfull node splits into two halves (the classic algorithm).
 * - "rightmost": if the node is the rightmost node of its level and the new key went to its end,
 *   the left node keeps `leafFill` (leaves) or `innerFill` (internal nodes) of its capacity and
 *   the rest moves right. This is the append optimization of PostgreSQL, SQLite and InnoDB.
 */
export type SplitPolicy = "half" | "rightmost";

export interface BTreeConfig<K> {
  /** Maximum children per internal node (3 or more). Max keys per node = order - 1. */
  order: number;
  compare?: Cmp<K>;
  split?: SplitPolicy;
  /** Left-node fill for rightmost leaf splits (default 1 = keep the node full). */
  leafFill?: number;
  /** Left-node fill for rightmost internal splits (default 1). */
  innerFill?: number;
}

/** Plain nested copy of the tree for rendering. */
export interface SnapNode<K> {
  id: number;
  leaf: boolean;
  keys: K[];
  kids?: SnapNode<K>[];
}

export class BPlusTree<K = number, V = K> {
  readonly order: number;
  readonly maxKeys: number;
  readonly minLeafKeys: number;
  readonly minKids: number;
  readonly cmp: Cmp<K>;
  readonly split: SplitPolicy;
  readonly leafFill: number;
  readonly innerFill: number;
  root: BNode<K, V>;
  size = 0;
  stats: TreeStats = zeroStats();
  listener: ((e: BEvent<K>) => void) | null = null;
  private nextId = 1;

  constructor(cfg: BTreeConfig<K>) {
    if (!Number.isInteger(cfg.order) || cfg.order < 3) throw new Error("order must be an integer >= 3");
    this.order = cfg.order;
    this.maxKeys = cfg.order - 1;
    this.minLeafKeys = Math.floor(cfg.order / 2);
    this.minKids = Math.ceil(cfg.order / 2);
    this.cmp = cfg.compare ?? (numCmp as unknown as Cmp<K>);
    this.split = cfg.split ?? "half";
    this.leafFill = cfg.leafFill ?? 1;
    this.innerFill = cfg.innerFill ?? 1;
    this.root = this.newLeaf();
    this.stats = zeroStats();
  }

  // ---------------------------------------------------------------- helpers
  private emit(e: BEvent<K>) {
    this.listener?.(e);
  }
  private newLeaf(): LeafNode<K, V> {
    this.stats.allocs++;
    return { kind: "leaf", id: this.nextId++, keys: [], vals: [], prev: null, next: null };
  }
  private newInner(): InnerNode<K, V> {
    this.stats.allocs++;
    return { kind: "inner", id: this.nextId++, keys: [], kids: [] };
  }
  /** First index i with keys[i] >= k (binary search, counts comparisons). */
  private lowerBound(keys: K[], k: K): number {
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      this.stats.comparisons++;
      if (this.cmp(keys[mid]!, k) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Number of keys <= k: the child index to follow in an internal node. */
  private upperBound(keys: K[], k: K): number {
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      this.stats.comparisons++;
      if (this.cmp(keys[mid]!, k) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Descends to the leaf for k. Returns the path of nodes and the child index taken at each inner node. */
  private descend(k: K): { path: BNode<K, V>[]; idx: number[] } {
    const path: BNode<K, V>[] = [];
    const idx: number[] = [];
    let n = this.root;
    for (;;) {
      this.stats.reads++;
      this.emit({ t: "visit", id: n.id, depth: path.length });
      path.push(n);
      if (n.kind === "leaf") return { path, idx };
      const i = this.upperBound(n.keys, k);
      idx.push(i);
      n = n.kids[i]!;
    }
  }
  private isRightmost(path: BNode<K, V>[], idx: number[], depth: number): boolean {
    for (let d = 0; d < depth; d++) {
      const p = path[d] as InnerNode<K, V>;
      if (idx[d] !== p.kids.length - 1) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- queries
  get(k: K): V | undefined {
    const { path } = this.descend(k);
    const leaf = path[path.length - 1] as LeafNode<K, V>;
    const i = this.lowerBound(leaf.keys, k);
    if (i < leaf.keys.length && this.cmp(leaf.keys[i]!, k) === 0) {
      this.emit({ t: "found", id: leaf.id, key: k });
      return leaf.vals[i];
    }
    this.emit({ t: "missing", id: leaf.id, key: k });
    return undefined;
  }
  has(k: K): boolean {
    return this.get(k) !== undefined;
  }
  get height(): number {
    let h = 1;
    for (let n = this.root; n.kind === "inner"; n = n.kids[0]!) h++;
    return h;
  }

  /** Entries with lo <= key <= hi, in order, following the leaf chain. */
  range(lo: K, hi: K, limit = Infinity): [K, V][] {
    const out: [K, V][] = [];
    const { path } = this.descend(lo);
    let leaf: LeafNode<K, V> | null = path[path.length - 1] as LeafNode<K, V>;
    let i = this.lowerBound(leaf.keys, lo);
    let first = true;
    while (leaf) {
      if (!first) this.stats.reads++;
      first = false;
      this.emit({ t: "scan", id: leaf.id });
      for (; i < leaf.keys.length; i++) {
        const k = leaf.keys[i]!;
        this.stats.comparisons++;
        if (this.cmp(k, hi) > 0 || out.length >= limit) return out;
        out.push([k, leaf.vals[i]!]);
      }
      leaf = leaf.next;
      i = 0;
    }
    return out;
  }
  /** All entries in key order (walks the leaf chain, no instrumentation). */
  entries(): [K, V][] {
    const out: [K, V][] = [];
    for (let l: LeafNode<K, V> | null = this.firstLeaf(); l; l = l.next) for (let i = 0; i < l.keys.length; i++) out.push([l.keys[i]!, l.vals[i]!]);
    return out;
  }
  keys(): K[] {
    return this.entries().map((e) => e[0]);
  }
  firstLeaf(): LeafNode<K, V> {
    let n = this.root;
    while (n.kind === "inner") n = n.kids[0]!;
    return n;
  }
  leaves(): LeafNode<K, V>[] {
    const out: LeafNode<K, V>[] = [];
    for (let l: LeafNode<K, V> | null = this.firstLeaf(); l; l = l.next) out.push(l);
    return out;
  }
  /** Nodes level by level, root first. */
  levels(): BNode<K, V>[][] {
    const out: BNode<K, V>[][] = [];
    let level: BNode<K, V>[] = [this.root];
    while (level.length) {
      out.push(level);
      level = level.flatMap((n) => (n.kind === "inner" ? n.kids : []));
    }
    return out;
  }
  nodeCount(): number {
    return this.levels().reduce((a, l) => a + l.length, 0);
  }
  snapshot(): SnapNode<K> {
    const snap = (n: BNode<K, V>): SnapNode<K> =>
      n.kind === "leaf" ? { id: n.id, leaf: true, keys: [...n.keys] } : { id: n.id, leaf: false, keys: [...n.keys], kids: n.kids.map(snap) };
    return snap(this.root);
  }
  /** Fill of each leaf: keys / maxKeys. */
  leafFills(): number[] {
    return this.leaves().map((l) => l.keys.length / this.maxKeys);
  }
  resetStats() {
    this.stats = zeroStats();
  }

  // ---------------------------------------------------------------- insert
  /** Inserts or updates. Returns true if the key is new. */
  insert(k: K, v: V): boolean {
    const { path, idx } = this.descend(k);
    const leaf = path[path.length - 1] as LeafNode<K, V>;
    const i = this.lowerBound(leaf.keys, k);
    if (i < leaf.keys.length && this.cmp(leaf.keys[i]!, k) === 0) {
      leaf.vals[i] = v;
      this.stats.writes++;
      this.emit({ t: "update", id: leaf.id, key: k });
      return false;
    }
    leaf.keys.splice(i, 0, k);
    leaf.vals.splice(i, 0, v);
    this.size++;
    this.stats.writes++;
    this.emit({ t: "insert", id: leaf.id, key: k });
    // Walk up while the node is overfull.
    let atEnd = i === leaf.keys.length - 1;
    for (let d = path.length - 1; d >= 0; d--) {
      const node = path[d]!;
      if (node.keys.length <= this.maxKeys) break;
      this.emit({ t: "overflow", id: node.id, depth: d });
      const rightmost = this.split === "rightmost" && atEnd && this.isRightmost(path, idx, d);
      const { right, sep } = node.kind === "leaf" ? this.splitLeaf(node, rightmost) : this.splitInner(node, rightmost);
      this.stats.splits++;
      if (d === 0) {
        const r = this.newInner();
        r.keys = [sep];
        r.kids = [node, right];
        this.root = r;
        this.stats.writes++;
        this.emit({ t: "split", id: node.id, right: right.id, sep, leaf: node.kind === "leaf", depth: d });
        this.emit({ t: "newRoot", id: r.id });
      } else {
        const parent = path[d - 1] as InnerNode<K, V>;
        const at = idx[d - 1]!;
        parent.keys.splice(at, 0, sep);
        parent.kids.splice(at + 1, 0, right);
        this.stats.writes++;
        atEnd = at === parent.keys.length - 1;
        this.emit({ t: "split", id: node.id, right: right.id, sep, leaf: node.kind === "leaf", depth: d });
      }
    }
    return true;
  }

  private leftKeep(total: number, rightmost: boolean, fill: number, min: number, max: number): number {
    if (!rightmost) return Math.ceil(total / 2);
    return Math.max(min, Math.min(max, Math.round(fill * max)));
  }
  private splitLeaf(node: LeafNode<K, V>, rightmost: boolean): { right: LeafNode<K, V>; sep: K } {
    const keep = this.leftKeep(node.keys.length, rightmost, this.leafFill, this.minLeafKeys, this.maxKeys);
    const right = this.newLeaf();
    right.keys = node.keys.splice(keep);
    right.vals = node.vals.splice(keep);
    right.next = node.next;
    if (right.next) right.next.prev = right;
    right.prev = node;
    node.next = right;
    this.stats.writes += 2;
    return { right, sep: right.keys[0]! };
  }
  private splitInner(node: InnerNode<K, V>, rightmost: boolean): { right: InnerNode<K, V>; sep: K } {
    // node has `order` keys and order + 1 kids. Left keeps `kids` children.
    const total = node.kids.length;
    const kids = rightmost ? this.leftKeep(total, true, this.innerFill, this.minKids, this.order - 1) : Math.ceil(total / 2);
    const right = this.newInner();
    const sep = node.keys[kids - 1]!;
    right.keys = node.keys.splice(kids);
    node.keys.pop(); // the separator moves up
    right.kids = node.kids.splice(kids);
    this.stats.writes += 2;
    return { right, sep };
  }

  // ---------------------------------------------------------------- delete
  /** Deletes k. Returns true if it was present. */
  delete(k: K): boolean {
    const { path, idx } = this.descend(k);
    const leaf = path[path.length - 1] as LeafNode<K, V>;
    const i = this.lowerBound(leaf.keys, k);
    if (i >= leaf.keys.length || this.cmp(leaf.keys[i]!, k) !== 0) {
      this.emit({ t: "missing", id: leaf.id, key: k });
      return false;
    }
    leaf.keys.splice(i, 1);
    leaf.vals.splice(i, 1);
    this.size--;
    this.stats.writes++;
    this.emit({ t: "remove", id: leaf.id, key: k });
    for (let d = path.length - 1; d >= 1; d--) {
      const node = path[d]!;
      const min = node.kind === "leaf" ? this.minLeafKeys : this.minKids - 1;
      if (node.keys.length >= min) break;
      this.emit({ t: "underflow", id: node.id, depth: d });
      this.fix(path[d - 1] as InnerNode<K, V>, idx[d - 1]!);
    }
    const r = this.root;
    if (r.kind === "inner" && r.kids.length === 1) {
      this.root = r.kids[0]!;
      this.stats.frees++;
      this.emit({ t: "collapse", id: r.id });
    }
    return true;
  }

  /** Repairs parent.kids[i], which is below its minimum: borrow from a sibling, else merge. */
  private fix(parent: InnerNode<K, V>, i: number) {
    const node = parent.kids[i]!;
    const leaf = node.kind === "leaf";
    const size = (n: BNode<K, V>) => (n.kind === "leaf" ? n.keys.length : n.kids.length);
    const min = leaf ? this.minLeafKeys : this.minKids;
    const left = i > 0 ? parent.kids[i - 1]! : null;
    const right = i < parent.kids.length - 1 ? parent.kids[i + 1]! : null;
    if (left) this.stats.reads++;
    if (right) this.stats.reads++;
    // Borrow if a sibling can give enough and stay at its minimum.
    const need = min - size(node);
    const donor = left && size(left) - need >= min ? left : right && size(right) - need >= min ? right : null;
    if (donor) {
      const side = donor === left ? "left" : "right";
      for (let n = 0; n < need; n++) this.borrowOne(parent, i, side);
      this.stats.borrows++;
      this.stats.writes += 3;
      this.emit({ t: "borrow", id: node.id, from: donor.id, side, leaf });
      return;
    }
    // Merge with a sibling: the right one of the pair moves into the left one.
    const li = left ? i - 1 : i;
    const a = parent.kids[li]!, b = parent.kids[li + 1]!;
    if (a.kind === "leaf" && b.kind === "leaf") {
      a.keys.push(...b.keys);
      a.vals.push(...b.vals);
      a.next = b.next;
      if (b.next) b.next.prev = a;
    } else if (a.kind === "inner" && b.kind === "inner") {
      a.keys.push(parent.keys[li]!, ...b.keys);
      a.kids.push(...b.kids);
    }
    parent.keys.splice(li, 1);
    parent.kids.splice(li + 1, 1);
    this.stats.merges++;
    this.stats.frees++;
    this.stats.writes += 2;
    this.emit({ t: "merge", left: a.id, right: b.id, leaf });
  }
  private borrowOne(parent: InnerNode<K, V>, i: number, side: "left" | "right") {
    const node = parent.kids[i]!;
    if (side === "right") {
      const r = parent.kids[i + 1]!;
      if (node.kind === "leaf" && r.kind === "leaf") {
        node.keys.push(r.keys.shift()!);
        node.vals.push(r.vals.shift()!);
        parent.keys[i] = r.keys[0]!;
      } else if (node.kind === "inner" && r.kind === "inner") {
        node.keys.push(parent.keys[i]!);
        node.kids.push(r.kids.shift()!);
        parent.keys[i] = r.keys.shift()!;
      }
    } else {
      const l = parent.kids[i - 1]!;
      if (node.kind === "leaf" && l.kind === "leaf") {
        node.keys.unshift(l.keys.pop()!);
        node.vals.unshift(l.vals.pop()!);
        parent.keys[i - 1] = node.keys[0]!;
      } else if (node.kind === "inner" && l.kind === "inner") {
        node.keys.unshift(parent.keys[i - 1]!);
        node.kids.unshift(l.kids.pop()!);
        parent.keys[i - 1] = l.keys.pop()!;
      }
    }
  }

  // ---------------------------------------------------------------- invariants
  /**
   * Checks every invariant. Returns a list of problems (empty = valid):
   * sorted keys, separator bounds, equal leaf depth, occupancy bounds, the leaf chain, and size.
   * With the "rightmost" split policy (or `relaxRightmost`), the last node of each level may be
   * below the minimum, as in real engines that split the rightmost page unevenly.
   */
  check(relaxRightmost = this.split === "rightmost"): string[] {
    const errs: string[] = [];
    const cmp = this.cmp;
    let leafDepth = -1;
    const leavesInOrder: LeafNode<K, V>[] = [];
    const levels = this.levels();
    const lastOfLevel = new Set(levels.map((l) => l[l.length - 1]!.id));
    const walk = (n: BNode<K, V>, depth: number, lo: K | null, hi: K | null) => {
      for (let i = 1; i < n.keys.length; i++) if (cmp(n.keys[i - 1]!, n.keys[i]!) >= 0) errs.push(`node ${n.id}: keys not strictly sorted`);
      for (const k of n.kind === "leaf" ? n.keys : []) {
        if (lo !== null && cmp(k, lo) < 0) errs.push(`leaf ${n.id}: key below its lower bound`);
        if (hi !== null && cmp(k, hi) >= 0) errs.push(`leaf ${n.id}: key not below its upper bound`);
      }
      const isRoot = n === this.root;
      const relaxed = relaxRightmost && lastOfLevel.has(n.id);
      if (n.keys.length > this.maxKeys) errs.push(`node ${n.id}: ${n.keys.length} keys > max ${this.maxKeys}`);
      if (n.kind === "leaf") {
        if (!isRoot && n.keys.length < (relaxed ? 1 : this.minLeafKeys)) errs.push(`leaf ${n.id}: ${n.keys.length} keys < min`);
        if (n.vals.length !== n.keys.length) errs.push(`leaf ${n.id}: vals/keys length differ`);
        if (leafDepth < 0) leafDepth = depth;
        else if (leafDepth !== depth) errs.push(`leaf ${n.id}: depth ${depth} != ${leafDepth}`);
        leavesInOrder.push(n);
        return;
      }
      if (n.kids.length !== n.keys.length + 1) errs.push(`inner ${n.id}: kids != keys + 1`);
      if (isRoot && n.kids.length < 2) errs.push(`root has ${n.kids.length} child`);
      if (!isRoot && n.kids.length < (relaxed ? 2 : this.minKids)) errs.push(`inner ${n.id}: ${n.kids.length} kids < min ${this.minKids}`);
      for (const k of n.keys) {
        if (lo !== null && cmp(k, lo) < 0) errs.push(`inner ${n.id}: separator below lower bound`);
        if (hi !== null && cmp(k, hi) >= 0) errs.push(`inner ${n.id}: separator not below upper bound`);
      }
      n.kids.forEach((c, i) => walk(c, depth + 1, i === 0 ? lo : n.keys[i - 1]!, i === n.keys.length ? hi : n.keys[i]!));
    };
    walk(this.root, 0, null, null);
    // Leaf chain matches the in-order leaves.
    const chain = this.leaves();
    if (chain.length !== leavesInOrder.length || chain.some((l, i) => l !== leavesInOrder[i])) errs.push("leaf chain does not match in-order leaves");
    for (let i = 0; i < chain.length; i++) if (chain[i]!.prev !== (chain[i - 1] ?? null)) errs.push(`leaf ${chain[i]!.id}: bad prev link`);
    const all = this.keys();
    for (let i = 1; i < all.length; i++) if (cmp(all[i - 1]!, all[i]!) >= 0) errs.push("leaf chain not globally sorted");
    if (all.length !== this.size) errs.push(`size ${this.size} != ${all.length} keys`);
    return errs;
  }

  // ---------------------------------------------------------------- bulk load
  /**
   * Builds a tree bottom-up from entries sorted by key (strictly increasing).
   * Each leaf gets round(fill * maxKeys) keys and each internal node round(fill * order) children,
   * clamped to the legal range. A short last node is evened out with its left neighbour.
   * `onStep` (optional) is called after each node is built, with the level (0 = leaves).
   */
  static bulkLoad<K, V>(
    entries: readonly (readonly [K, V])[],
    cfg: BTreeConfig<K> & { fill?: number },
    onStep?: (s: BulkStep<K>) => void,
  ): BPlusTree<K, V> {
    const t = new BPlusTree<K, V>(cfg);
    const fill = cfg.fill ?? 1;
    if (!entries.length) return t;
    for (let i = 1; i < entries.length; i++) if (t.cmp(entries[i - 1]![0], entries[i]![0]) >= 0) throw new Error("bulkLoad needs strictly increasing keys");
    t.stats = zeroStats();
    const leafCap = Math.max(t.minLeafKeys, Math.min(t.maxKeys, Math.round(fill * t.maxKeys)));
    const kidCap = Math.max(t.minKids, Math.min(t.order, Math.round(fill * t.order)));
    // Group sizes: chunks of `cap`; a short tail is merged or evened out with the previous chunk.
    const groups = (n: number, cap: number, min: number, max: number): number[] => {
      const out: number[] = [];
      for (let left = n; left > 0; left -= Math.min(cap, left)) out.push(Math.min(cap, left));
      if (out.length > 1 && out[out.length - 1]! < min) {
        const tot = out.pop()! + out.pop()!;
        if (tot <= max) out.push(tot);
        else out.push(Math.ceil(tot / 2), Math.floor(tot / 2));
      }
      return out;
    };
    let level: { node: BNode<K, V>; low: K }[] = [];
    let at = 0;
    let prev: LeafNode<K, V> | null = null;
    for (const g of groups(entries.length, leafCap, t.minLeafKeys, t.maxKeys)) {
      const leaf = t.newLeaf();
      for (let j = 0; j < g; j++, at++) {
        leaf.keys.push(entries[at]![0]);
        leaf.vals.push(entries[at]![1]);
      }
      leaf.prev = prev;
      if (prev) prev.next = leaf;
      prev = leaf;
      t.stats.writes++;
      level.push({ node: leaf, low: leaf.keys[0]! });
      onStep?.({ level: 0, id: leaf.id, keys: [...leaf.keys], count: level.length });
    }
    let depth = 1;
    while (level.length > 1) {
      const up: { node: BNode<K, V>; low: K }[] = [];
      let j = 0;
      for (const g of groups(level.length, kidCap, t.minKids, t.order)) {
        const inner = t.newInner();
        const kids = level.slice(j, j + g);
        j += g;
        inner.kids = kids.map((x) => x.node);
        inner.keys = kids.slice(1).map((x) => x.low);
        t.stats.writes++;
        up.push({ node: inner, low: kids[0]!.low });
        onStep?.({ level: depth, id: inner.id, keys: [...inner.keys], count: up.length });
      }
      level = up;
      depth++;
    }
    t.root = level[0]!.node;
    t.size = entries.length;
    return t;
  }
}

export interface BulkStep<K> {
  /** 0 = leaf level. */
  level: number;
  id: number;
  keys: K[];
  /** Nodes built so far at this level. */
  count: number;
}

// ============================================================================
// Experiments on real trees
// ============================================================================

/**
 * Starting keys of the lesson-1 demo, in insertion order. With order 4 the tree has 3 levels,
 * and the path to 40 is full at every level, so inserting 40 splits a leaf, its parent and the root.
 */
export const LAB_KEYS = [80, 5, 70, 35, 75, 18, 15, 50, 38, 33, 10, 30, 95, 90, 12, 55, 85, 47, 65, 20, 60, 45, 25];

export type InsertOrder = "ascending" | "random" | "descending";

/** Keys 0..n-1 in the given order (seeded). */
export function keyOrder(n: number, order: InsertOrder, seed = 1): number[] {
  const keys = Array.from({ length: n }, (_, i) => i);
  if (order === "descending") keys.reverse();
  if (order === "random") {
    const rng = mulberry32(seed);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
  }
  return keys;
}

export interface FillResult {
  fills: number[];
  avgFill: number;
  leaves: number;
  height: number;
  splits: number;
  nodeWrites: number;
}

/** Inserts n keys one by one in the given order and measures leaf occupancy. */
export function fillExperiment(opts: { order: number; n: number; insertOrder: InsertOrder; split?: SplitPolicy; leafFill?: number; seed?: number }): FillResult {
  const t = new BPlusTree<number, number>({ order: opts.order, split: opts.split ?? "half", leafFill: opts.leafFill ?? 1, innerFill: opts.leafFill ?? 1 });
  for (const k of keyOrder(opts.n, opts.insertOrder, opts.seed ?? 1)) t.insert(k, k);
  const fills = t.leafFills();
  return { fills, avgFill: mean(fills), leaves: fills.length, height: t.height, splits: t.stats.splits, nodeWrites: t.stats.writes };
}

/** Bulk-loads keys 0..n-1 and reports the same measures as fillExperiment. */
export function bulkExperiment(opts: { order: number; n: number; fill: number }): FillResult {
  const entries = Array.from({ length: opts.n }, (_, i) => [i, i] as const);
  const t = BPlusTree.bulkLoad(entries, { order: opts.order, fill: opts.fill });
  const fills = t.leafFills();
  return { fills, avgFill: mean(fills), leaves: fills.length, height: t.height, splits: t.stats.splits, nodeWrites: t.stats.writes };
}

/** Histogram of fill fractions in `bins` equal bins over [0, 1]. Returns counts. */
export function fillHistogram(fills: number[], bins = 10): number[] {
  const h = new Array<number>(bins).fill(0);
  for (const f of fills) h[Math.min(bins - 1, Math.floor(f * bins))]!++;
  return h;
}

export interface FillFactorPoint {
  fill: number;
  leavesBefore: number;
  leavesAfter: number;
  splits: number;
  avgFillAfter: number;
}

/**
 * Fill-factor trade-off: bulk-load n even keys (0, 2, 4, ...) with the given leaf fill,
 * then insert `extra` random odd keys. Lower fill = more pages at first, fewer splits later.
 */
export function fillFactorSweep(opts: { order: number; n: number; extra: number; fills: number[]; seed?: number }): FillFactorPoint[] {
  const odd = keyOrder(opts.n, "random", opts.seed ?? 7).slice(0, opts.extra).map((i) => 2 * i + 1);
  return opts.fills.map((fill) => {
    const entries = Array.from({ length: opts.n }, (_, i) => [2 * i, 2 * i] as const);
    const t = BPlusTree.bulkLoad(entries, { order: opts.order, fill });
    const leavesBefore = t.leaves().length;
    t.resetStats();
    for (const k of odd) t.insert(k, k);
    const fills = t.leafFills();
    return { fill, leavesBefore, leavesAfter: fills.length, splits: t.stats.splits, avgFillAfter: mean(fills) };
  });
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Applies a random insert/delete workload. Used by property tests and the demos. */
export function randomOps(t: BPlusTree<number, number>, ops: number, keySpace: number, insertBias = 0.6, seed = 1): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < ops; i++) {
    const k = Math.floor(rng() * keySpace);
    if (rng() < insertBias) t.insert(k, k);
    else t.delete(k);
  }
}

// ============================================================================
// Sizing math (closed form)
// ============================================================================

export interface PageModel {
  /** Page size in bytes (e.g. 16384 for InnoDB, 8192 for PostgreSQL, 4096 for SQLite and LMDB). */
  pageBytes: number;
  keyBytes: number;
  /** Child pointer (page number) size in internal nodes. */
  ptrBytes?: number;
  /** Value (or row pointer) size in leaves. */
  valBytes?: number;
  /** Slot-array entry per record. */
  slotBytes?: number;
  /** Page header and trailer. */
  headerBytes?: number;
  /** Average fill, 0..1. */
  fill?: number;
}

/** Entries per internal node (= fanout) and per leaf, under the page model. */
export function pageCapacity(m: PageModel): { fanout: number; leafCap: number } {
  const ptr = m.ptrBytes ?? 8, val = m.valBytes ?? 8, slot = m.slotBytes ?? 2, head = m.headerBytes ?? 128, fill = m.fill ?? 1;
  const usable = m.pageBytes - head;
  return {
    fanout: Math.max(2, Math.floor((usable * fill) / (m.keyBytes + ptr + slot))),
    leafCap: Math.max(1, Math.floor((usable * fill) / (m.keyBytes + val + slot))),
  };
}

/** Number of nodes at each level for n keys, leaves first in the returned array's end (root first). */
export function levelSizes(n: number, leafCap: number, fanout: number): number[] {
  const out: number[] = [];
  let nodes = Math.max(1, Math.ceil(n / leafCap));
  out.push(nodes);
  while (nodes > 1) {
    nodes = Math.ceil(nodes / fanout);
    out.push(nodes);
  }
  return out.reverse();
}

/** Share of all nodes that are leaves (= share of bytes when every node is one page). */
export function leafShare(n: number, leafCap: number, fanout: number): number {
  const l = levelSizes(n, leafCap, fanout);
  return l[l.length - 1]! / l.reduce((a, b) => a + b, 0);
}

/** Levels of a B+ tree with n keys. */
export function treeHeight(n: number, leafCap: number, fanout: number): number {
  return levelSizes(n, leafCap, fanout).length;
}

/** How many top levels fit in `cacheBytes` of buffer pool. */
export function cachedLevels(n: number, m: PageModel, cacheBytes: number): number {
  const { fanout, leafCap } = pageCapacity(m);
  let used = 0, k = 0;
  for (const nodes of levelSizes(n, leafCap, fanout)) {
    used += nodes * m.pageBytes;
    if (used > cacheBytes) break;
    k++;
  }
  return k;
}

/** Page reads from storage for one point lookup: levels that are not cached. */
export function lookupIOs(n: number, m: PageModel, cacheBytes: number): number {
  const { fanout, leafCap } = pageCapacity(m);
  return treeHeight(n, leafCap, fanout) - cachedLevels(n, m, cacheBytes);
}

/** Depth of a complete binary search tree with n keys (= nodes on the longest search path). */
export function bstDepth(n: number): number {
  return Math.ceil(Math.log2(n + 1));
}

/**
 * Average number of distinct cache lines that a binary search touches in a sorted array of
 * `nKeys` keys of `keyBytes` each (array starts on a line boundary). Averaged over all
 * nKeys + 1 possible outcomes.
 */
export function binarySearchLines(nKeys: number, keyBytes: number, lineBytes = 64): number {
  if (nKeys <= 0) return 0;
  let total = 0;
  for (let target = 0; target <= nKeys; target++) {
    // Search for a key that falls just before position `target`.
    const lines = new Set<number>();
    let lo = 0, hi = nKeys;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      lines.add(Math.floor((mid * keyBytes) / lineBytes));
      if (mid < target) lo = mid + 1;
      else hi = mid;
    }
    total += lines.size;
  }
  return total / (nKeys + 1);
}

/**
 * Average distinct cache lines touched in one node visit: binary search over the key array,
 * then the read of the chosen child pointer. Layout: [keys (nKeys * keyBytes)][pointers (nKeys + 1)].
 */
export function nodeVisitLines(nKeys: number, keyBytes: number, ptrBytes: number, lineBytes = 64): number {
  let total = 0;
  const ptrBase = nKeys * keyBytes;
  for (let target = 0; target <= nKeys; target++) {
    const lines = new Set<number>();
    let lo = 0, hi = nKeys;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      lines.add(Math.floor((mid * keyBytes) / lineBytes));
      if (mid < target) lo = mid + 1;
      else hi = mid;
    }
    lines.add(Math.floor((ptrBase + lo * ptrBytes) / lineBytes));
    total += lines.size;
  }
  return total / (nKeys + 1);
}

/**
 * In-memory lookup cost in cache lines for a B+ tree whose nodes are `nodeBytes` long and
 * start on a cache-line boundary (the model treats leaves like internal nodes).
 */
export function btreeLookupLines(n: number, nodeBytes: number, keyBytes = 8, ptrBytes = 8, lineBytes = 64): { fanout: number; levels: number; linesPerNode: number; lines: number } {
  const fanout = Math.max(2, Math.floor((nodeBytes + keyBytes) / (keyBytes + ptrBytes)));
  const levels = treeHeight(n, fanout, fanout);
  const linesPerNode = nodeVisitLines(fanout - 1, keyBytes, ptrBytes, lineBytes);
  return { fanout, levels, linesPerNode, lines: levels * linesPerNode };
}

/**
 * Growth after loading: bulk-load n even keys with the given leaf fill, then insert random odd
 * keys and record the leaf count at `steps` checkpoints up to `maxExtra` inserted keys.
 */
export function growthCurve(opts: { order: number; n: number; fill: number; maxExtra: number; steps: number; seed?: number }): { extra: number; leaves: number; splits: number }[] {
  const entries = Array.from({ length: opts.n }, (_, i) => [2 * i, 2 * i] as const);
  const t = BPlusTree.bulkLoad(entries, { order: opts.order, fill: opts.fill });
  t.resetStats();
  const odd = keyOrder(opts.n, "random", opts.seed ?? 7).map((i) => 2 * i + 1);
  const out = [{ extra: 0, leaves: t.leaves().length, splits: 0 }];
  let done = 0;
  for (let s = 1; s <= opts.steps; s++) {
    const upTo = Math.min(opts.n, Math.round((opts.maxExtra * s) / opts.steps));
    for (; done < upTo; done++) t.insert(odd[done]!, 0);
    out.push({ extra: done, leaves: t.leaves().length, splits: t.stats.splits });
  }
  return out;
}

// ============================================================================
// Key compression
// ============================================================================

/** Shortest string s with a < s <= b (suffix truncation of a separator between leaves). */
export function shortestSeparator(a: string, b: string): string {
  if (!(a < b)) throw new Error("need a < b");
  for (let len = 1; len <= b.length; len++) {
    const s = b.slice(0, len);
    if (s > a) return s;
  }
  return b;
}

/** Longest common prefix of sorted keys (prefix compression stores it once per page). */
export function commonPrefix(keys: string[]): string {
  if (!keys.length) return "";
  let p = keys[0]!;
  for (const k of keys) while (!k.startsWith(p)) p = p.slice(0, -1);
  return p;
}
