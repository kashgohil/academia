/**
 * A skip list (Pugh 1990), the memtable structure of LevelDB and RocksDB.
 * Each node has a random height: a coin with P(heads) = p decides each extra level.
 * LevelDB uses p = 1/4 (kBranching = 4) and at most 12 levels (kMaxHeight = 12).
 * Search starts at the top level of the head node and moves right while the next key is smaller,
 * then moves down one level. Expected cost: about log_{1/p}(n) / p comparisons.
 */
import { mulberry32, type Rng } from "../../rng";

export type Cmp<K> = (a: K, b: K) => number;

interface Node<K, V> { key: K; value: V; next: (Node<K, V> | null)[] }

export interface SkipListOptions { p?: number; maxHeight?: number; rng?: Rng; seed?: number }

/** One move of a search: at `level`, the search compared the target with `key` (null = end of list). */
export interface SearchStep<K> { level: number; key: K | null; dir: "right" | "down" }

export class SkipList<K, V> {
  readonly p: number;
  readonly maxHeight: number;
  private readonly head: Node<K, V>;
  private readonly rng: Rng;
  height = 1;
  size = 0;
  /** Key comparisons done by all operations (for cost readouts). */
  comparisons = 0;

  constructor(private readonly cmp: Cmp<K>, opts: SkipListOptions = {}) {
    this.p = opts.p ?? 0.25;
    this.maxHeight = opts.maxHeight ?? 12;
    this.rng = opts.rng ?? mulberry32(opts.seed ?? 1);
    this.head = { key: undefined as unknown as K, value: undefined as unknown as V, next: new Array(this.maxHeight).fill(null) };
  }

  /** Flips coins until tails or maxHeight. Returns the height and the flips (true = heads). */
  randomHeight(): { height: number; flips: boolean[] } {
    const flips: boolean[] = [];
    let h = 1;
    while (h < this.maxHeight) {
      const heads = this.rng() < this.p;
      flips.push(heads);
      if (!heads) break;
      h++;
    }
    return { height: h, flips };
  }

  /** For each level, the last node with key < target (head if none). */
  private findPrev(key: K, path?: SearchStep<K>[]): Node<K, V>[] {
    const prev: Node<K, V>[] = new Array(this.maxHeight).fill(this.head);
    let x = this.head;
    for (let lvl = this.height - 1; lvl >= 0; lvl--) {
      for (;;) {
        const nx = x.next[lvl] ?? null;
        if (nx === null) { path?.push({ level: lvl, key: null, dir: "down" }); break; }
        this.comparisons++;
        if (this.cmp(nx.key, key) < 0) { path?.push({ level: lvl, key: nx.key, dir: "right" }); x = nx; }
        else { path?.push({ level: lvl, key: nx.key, dir: "down" }); break; }
      }
      prev[lvl] = x;
    }
    return prev;
  }

  /** Inserts or replaces. Returns the new node's height and coin flips (height 0 = replaced). */
  insert(key: K, value: V): { height: number; flips: boolean[] } {
    const prev = this.findPrev(key);
    const at = prev[0]!.next[0] ?? null;
    if (at && this.cmp(at.key, key) === 0) { at.value = value; return { height: 0, flips: [] }; }
    const r = this.randomHeight();
    if (r.height > this.height) this.height = r.height;
    const node: Node<K, V> = { key, value, next: new Array(r.height).fill(null) };
    for (let l = 0; l < r.height; l++) {
      node.next[l] = prev[l]!.next[l] ?? null;
      prev[l]!.next[l] = node;
    }
    this.size++;
    return r;
  }

  get(key: K): V | undefined {
    const at = this.findPrev(key)[0]!.next[0] ?? null;
    return at && this.cmp(at.key, key) === 0 ? at.value : undefined;
  }

  /** The search path for a key: every comparison, top level first. */
  search(key: K): { path: SearchStep<K>[]; comparisons: number; found: boolean } {
    const path: SearchStep<K>[] = [];
    const before = this.comparisons;
    const at = this.findPrev(key, path)[0]!.next[0] ?? null;
    return { path, comparisons: this.comparisons - before, found: !!at && this.cmp(at.key, key) === 0 };
  }

  /** Entries with key >= from, in order. */
  *seek(from: K): Generator<[K, V]> {
    let x = this.findPrev(from)[0]!.next[0] ?? null;
    for (; x; x = x.next[0] ?? null) yield [x.key, x.value];
  }

  *entries(): Generator<[K, V]> {
    for (let x = this.head.next[0] ?? null; x; x = x.next[0] ?? null) yield [x.key, x.value];
  }

  /** Nodes in order with their heights, for drawing. */
  nodes(): { key: K; value: V; height: number }[] {
    const out: { key: K; value: V; height: number }[] = [];
    for (let x = this.head.next[0] ?? null; x; x = x.next[0] ?? null) out.push({ key: x.key, value: x.value, height: x.next.length });
    return out;
  }
}

/** Expected comparisons of a skip-list search: log_{1/p}(n) / p (Pugh's bound, ignoring small terms). */
export const expectedSearchCost = (n: number, p: number) => (n <= 1 ? 1 : Math.log(n) / Math.log(1 / p) / p);

/** Average comparisons over a search for every key in the list. */
export function averageSearchCost<K>(list: SkipList<K, unknown>): number {
  const keys = list.nodes().map((n) => n.key);
  if (!keys.length) return 0;
  return keys.reduce((s, k) => s + list.search(k).comparisons, 0) / keys.length;
}
