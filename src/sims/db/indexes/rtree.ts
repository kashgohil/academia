/**
 * R-tree (Guttman, SIGMOD 1984): a balanced tree of minimum bounding rectangles (MBRs).
 *
 * - Insert: choose the child whose MBR needs the least enlargement (ties: smaller area), add the
 *   entry to a leaf, split an overfull node with the quadratic split, and grow MBRs upward.
 * - Search: visit every child whose MBR intersects the query box. Several children can match,
 *   so a search can follow many paths.
 * - kNN: best-first search with a priority queue ordered by MINDIST (Hjaltason and Samet).
 * - Delete: remove the entry, then condense the tree and reinsert entries of underfull nodes.
 */

export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Item { id: number; r: Rect }

export const area = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
export const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
export const intersects = (a: Rect, b: Rect) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
export const enlargement = (a: Rect, b: Rect) => area(union(a, b)) - area(a);
export const point = (x: number, y: number): Rect => ({ x0: x, y0: y, x1: x, y1: y });
/** Smallest distance from point (x, y) to rectangle r (0 inside). */
export function minDist(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.x0 - x, 0, x - r.x1), dy = Math.max(r.y0 - y, 0, y - r.y1);
  return Math.hypot(dx, dy);
}

export interface RNode { id: number; leaf: boolean; mbr: Rect; kids: RNode[]; items: Item[] }

export interface SearchTrace { visited: number[]; pruned: number[]; tested: number; results: number[] }

function mbrOf(rs: Rect[]): Rect {
  return rs.reduce((a, b) => union(a, b));
}

export class RTree {
  root: RNode;
  size = 0;
  readonly min: number;
  private nextId = 1;
  constructor(readonly max = 4, min?: number) {
    if (max < 3) throw new Error("max entries must be at least 3");
    this.min = min ?? Math.min(Math.floor(max / 2), Math.max(1, Math.ceil(max * 0.4))); // about 40% of M, at most M/2
    this.root = this.node(true);
  }
  private node(leaf: boolean): RNode { return { id: this.nextId++, leaf, mbr: { x0: 0, y0: 0, x1: 0, y1: 0 }, kids: [], items: [] }; }
  private entries(n: RNode): Rect[] { return n.leaf ? n.items.map((i) => i.r) : n.kids.map((k) => k.mbr); }
  private count(n: RNode) { return n.leaf ? n.items.length : n.kids.length; }
  private refit(n: RNode) { const e = this.entries(n); if (e.length) n.mbr = mbrOf(e); }

  get height(): number { let h = 1; for (let n = this.root; !n.leaf; n = n.kids[0]!) h++; return h; }

  insert(item: Item) {
    this.size++;
    this.insertAt(item);
  }
  /** Descends by least enlargement to a leaf, adds the item, then splits and refits upward. */
  private insertAt(item: Item) {
    const r = item.r;
    const path: RNode[] = [];
    let n = this.root;
    while (!n.leaf) {
      path.push(n);
      n = this.chooseSubtree(n, r);
    }
    n.items.push(item);
    this.refit(n);
    let split = this.count(n) > this.max ? this.splitNode(n) : null;
    for (let i = path.length - 1; i >= 0; i--) {
      const p = path[i]!;
      if (split) p.kids.push(split);
      this.refit(p);
      split = this.count(p) > this.max ? this.splitNode(p) : null;
    }
    if (split) {
      const nr = this.node(false);
      nr.kids = [this.root, split];
      this.refit(nr);
      this.root = nr;
    }
  }
  /** Least enlargement, ties broken by smaller area. */
  chooseSubtree(n: RNode, r: Rect): RNode {
    let best = n.kids[0]!, be = Infinity, ba = Infinity;
    for (const k of n.kids) {
      const e = enlargement(k.mbr, r), a = area(k.mbr);
      if (e < be || (e === be && a < ba)) { best = k; be = e; ba = a; }
    }
    return best;
  }
  /** Guttman's quadratic split. `n` keeps one group; returns a new sibling with the other. */
  private splitNode(n: RNode): RNode {
    const sib = this.node(n.leaf);
    const all: { r: Rect; e: Item | RNode }[] = n.leaf ? n.items.map((i) => ({ r: i.r, e: i })) : n.kids.map((k) => ({ r: k.mbr, e: k }));
    const [s1, s2] = quadraticSeeds(all.map((x) => x.r));
    const g1 = [all[s1]!], g2 = [all[s2]!];
    let m1 = all[s1]!.r, m2 = all[s2]!.r;
    const rest = all.filter((_, i) => i !== s1 && i !== s2);
    while (rest.length) {
      // If one group needs all the rest to reach the minimum, give it all of them.
      if (g1.length + rest.length === this.min) { g1.push(...rest); m1 = mbrOf([m1, ...rest.map((x) => x.r)]); break; }
      if (g2.length + rest.length === this.min) { g2.push(...rest); m2 = mbrOf([m2, ...rest.map((x) => x.r)]); break; }
      // PickNext: the entry with the biggest preference for one group.
      let bi = 0, bd = -1;
      rest.forEach((x, i) => {
        const d = Math.abs(enlargement(m1, x.r) - enlargement(m2, x.r));
        if (d > bd) { bd = d; bi = i; }
      });
      const x = rest.splice(bi, 1)[0]!;
      const e1 = enlargement(m1, x.r), e2 = enlargement(m2, x.r);
      const to1 = e1 < e2 || (e1 === e2 && (area(m1) < area(m2) || (area(m1) === area(m2) && g1.length <= g2.length)));
      if (to1) { g1.push(x); m1 = union(m1, x.r); } else { g2.push(x); m2 = union(m2, x.r); }
    }
    if (n.leaf) { n.items = g1.map((x) => x.e as Item); sib.items = g2.map((x) => x.e as Item); }
    else { n.kids = g1.map((x) => x.e as RNode); sib.kids = g2.map((x) => x.e as RNode); }
    this.refit(n); this.refit(sib);
    return sib;
  }

  /** Range search with a trace of visited and pruned nodes. */
  search(q: Rect): SearchTrace {
    const t: SearchTrace = { visited: [], pruned: [], tested: 0, results: [] };
    const walk = (n: RNode) => {
      t.visited.push(n.id);
      if (n.leaf) {
        for (const it of n.items) { t.tested++; if (intersects(it.r, q)) t.results.push(it.id); }
        return;
      }
      for (const k of n.kids) {
        t.tested++;
        if (intersects(k.mbr, q)) walk(k); else t.pruned.push(k.id);
      }
    };
    if (this.size) walk(this.root);
    return t;
  }

  /** k nearest items to (x, y), best-first. Returns ids (nearest first) and nodes opened. */
  knn(x: number, y: number, k: number): { ids: number[]; dists: number[]; visited: number[] } {
    type E = { d: number; node?: RNode; item?: Item };
    const heap: E[] = [];
    const push = (e: E) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p]!.d <= heap[i]!.d) break; [heap[p], heap[i]] = [heap[i]!, heap[p]!]; i = p; } };
    const pop = (): E => {
      const top = heap[0]!, last = heap.pop()!;
      if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l]!.d < heap[m]!.d) m = l; if (r < heap.length && heap[r]!.d < heap[m]!.d) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i]!, heap[m]!]; i = m; } }
      return top;
    };
    const ids: number[] = [], dists: number[] = [], visited: number[] = [];
    if (!this.size) return { ids, dists, visited };
    push({ d: minDist(x, y, this.root.mbr), node: this.root });
    while (heap.length && ids.length < k) {
      const e = pop();
      if (e.item) { ids.push(e.item.id); dists.push(e.d); continue; }
      const n = e.node!;
      visited.push(n.id);
      if (n.leaf) for (const it of n.items) push({ d: minDist(x, y, it.r), item: it });
      else for (const c of n.kids) push({ d: minDist(x, y, c.mbr), node: c });
    }
    return { ids, dists, visited };
  }

  delete(id: number): boolean {
    const path: RNode[] = [];
    const find = (n: RNode): RNode | null => {
      path.push(n);
      if (n.leaf) { if (n.items.some((i) => i.id === id)) return n; }
      else for (const k of n.kids) { const f = find(k); if (f) return f; }
      path.pop();
      return null;
    };
    const leaf = find(this.root);
    if (!leaf) return false;
    leaf.items = leaf.items.filter((i) => i.id !== id);
    this.size--;
    // Condense: remove underfull nodes on the path and reinsert all their items (a simple variant
    // of Guttman's CondenseTree, which reinserts whole subtrees at their level).
    const orphans: Item[] = [];
    for (let i = path.length - 1; i > 0; i--) {
      const n = path[i]!, p = path[i - 1]!;
      if (this.count(n) < this.min) {
        p.kids = p.kids.filter((k) => k !== n);
        orphans.push(...this.items(n));
      } else this.refit(n);
    }
    this.refit(this.root);
    while (!this.root.leaf && this.root.kids.length === 1) this.root = this.root.kids[0]!;
    if (!this.root.leaf && this.root.kids.length === 0) this.root = this.node(true);
    for (const it of orphans) { this.size--; this.insert(it); }
    return true;
  }
  /** Every item under a node. */
  items(n: RNode = this.root): Item[] { return n.leaf ? [...n.items] : n.kids.flatMap((k) => this.items(k)); }
  /** Nodes grouped by level, root first. */
  levels(): RNode[][] {
    const out: RNode[][] = [];
    let cur = [this.root];
    while (cur.length) { out.push(cur); cur = cur.flatMap((n) => (n.leaf ? [] : n.kids)); }
    return out;
  }
  nodeCount() { return this.levels().reduce((s, l) => s + l.length, 0); }
  /** Invariants: MBRs are tight, node sizes in range, leaves at one depth. */
  check(): string[] {
    const errs: string[] = [];
    const depths = new Set<number>();
    const walk = (n: RNode, d: number, isRoot: boolean) => {
      const c = this.count(n);
      if (c > this.max) errs.push(`node ${n.id} has ${c} entries`);
      if (!isRoot && c < this.min) errs.push(`node ${n.id} underfull: ${c}`);
      if (c) { const m = mbrOf(this.entries(n)); if (JSON.stringify(m) !== JSON.stringify(n.mbr)) errs.push(`node ${n.id} MBR not tight`); }
      if (n.leaf) depths.add(d); else n.kids.forEach((k) => walk(k, d + 1, false));
    };
    walk(this.root, 0, true);
    if (depths.size > 1) errs.push("leaves at different depths");
    return errs;
  }
  /** Sum of MBR areas and pairwise overlap area per level (a quality measure). */
  overlap(): number {
    let o = 0;
    for (const lv of this.levels()) for (let i = 0; i < lv.length; i++) for (let j = i + 1; j < lv.length; j++) {
      const a = lv[i]!.mbr, b = lv[j]!.mbr;
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (w > 0 && h > 0) o += w * h;
    }
    return o;
  }
}

/** The pair of entries that would waste the most area if put in one node. */
export function quadraticSeeds(rs: Rect[]): [number, number] {
  let bi = 0, bj = 1, bw = -Infinity;
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const w = area(union(rs[i]!, rs[j]!)) - area(rs[i]!) - area(rs[j]!);
    if (w > bw) { bw = w; bi = i; bj = j; }
  }
  return [bi, bj];
}

/** Deterministic demo data on a 100 × 100 map: small rectangles and points. */
export function demoItems(n = 28, seed = 4): Item[] {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: Item[] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round(4 + r() * 88), y = Math.round(4 + r() * 88);
    const isPoint = i % 3 === 2;
    const w = isPoint ? 0 : Math.round(2 + r() * 7), h = isPoint ? 0 : Math.round(2 + r() * 7);
    out.push({ id: i + 1, r: { x0: x, y0: y, x1: Math.min(100, x + w), y1: Math.min(100, y + h) } });
  }
  return out;
}

/** Average nodes visited by a random square range query of side `side` (fraction of the map side). */
export function avgVisited(t: RTree, side: number, queries = 200, seed = 9): { visited: number; results: number } {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  let v = 0, res = 0;
  for (let i = 0; i < queries; i++) {
    const s = side * 100, x = r() * (100 - s), y = r() * (100 - s);
    const tr = t.search({ x0: x, y0: y, x1: x + s, y1: y + s });
    v += tr.visited.length; res += tr.results.length;
  }
  return { visited: v / queries, results: res / queries };
}

// Demo scenarios (shared by the demos and the tests).
/** Default query box of the R-tree demo. */
export const RTREE_QUERY: Rect = { x0: 10, y0: 55, x1: 40, y1: 85 };
