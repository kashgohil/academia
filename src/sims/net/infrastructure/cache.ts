/**
 * Cache hit ratio under a Zipf workload: the replacement policies, Che's approximation for LRU, cache keys with
 * variants (Vary), and a two-tier hierarchy of edges and a shield.
 *
 * Objects are ranks 1..K; rank r is requested with probability ∝ r^−θ (the Zipf sampler of the partitioning
 * module). All caches count objects, not bytes (every object has the same size), and start empty; hit ratios are
 * measured after a warm-up of the first `warm` share of requests.
 */
import { mulberry32, type Rng } from "../../rng";
import { Zipf, harmonic } from "../../dist/partitioning/workload";

export type CachePolicy = "lru" | "fifo" | "lfu" | "static";
export const CACHE_POLICIES: CachePolicy[] = ["lru", "fifo", "lfu", "static"];
export const CACHE_POLICY_LABEL: Record<CachePolicy, string> = { lru: "LRU", fifo: "FIFO", lfu: "LFU", static: "top C objects (ideal)" };

/** A cache of object ids. `get` returns true on a hit and inserts on a miss. */
export interface Cache {
  get(id: number): boolean;
  readonly size: number;
}

/** LRU: a Map keeps insertion order; a hit moves the key to the end; the first key is the least recent. */
export class LruCache implements Cache {
  private m = new Map<number, true>();
  constructor(readonly capacity: number) {}
  get size() { return this.m.size; }
  has(id: number) { return this.m.has(id); }
  get(id: number): boolean {
    if (this.m.has(id)) {
      this.m.delete(id);
      this.m.set(id, true);
      return true;
    }
    this.put(id);
    return false;
  }
  put(id: number) {
    if (this.capacity <= 0) return;
    this.m.delete(id);
    if (this.m.size >= this.capacity) this.m.delete(this.m.keys().next().value!);
    this.m.set(id, true);
  }
  delete(id: number) { this.m.delete(id); }
}

/** FIFO: a hit changes nothing; the oldest insert leaves first. */
export class FifoCache implements Cache {
  private m = new Set<number>();
  constructor(readonly capacity: number) {}
  get size() { return this.m.size; }
  get(id: number): boolean {
    if (this.m.has(id)) return true;
    if (this.capacity <= 0) return false;
    if (this.m.size >= this.capacity) this.m.delete(this.m.values().next().value!);
    this.m.add(id);
    return false;
  }
}

/**
 * LFU with counts that survive eviction ("perfect" LFU): evict the cached object with the fewest requests so far.
 * A binary heap with lazy entries: a count change pushes a new entry, and stale entries are skipped at eviction.
 */
export class LfuCache implements Cache {
  private count = new Map<number, number>();
  private cached = new Set<number>();
  private heap: [number, number][] = [];
  constructor(readonly capacity: number) {}
  get size() { return this.cached.size; }
  private push(e: [number, number]) {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p]![0] <= e[0]) break;
      h[i] = h[p]!;
      i = p;
    }
    h[i] = e;
  }
  private pop(): [number, number] {
    const h = this.heap, top = h[0]!, last = h.pop()!;
    if (h.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        const key = (j: number) => (j === i ? last[0] : h[j]![0]);
        if (l < h.length && h[l]![0] < key(m)) m = l;
        if (r < h.length && h[r]![0] < key(m)) m = r;
        if (m === i) break;
        h[i] = h[m]!;
        i = m;
      }
      h[i] = last;
    }
    return top;
  }
  get(id: number): boolean {
    const c = (this.count.get(id) ?? 0) + 1;
    this.count.set(id, c);
    if (this.cached.has(id)) {
      this.push([c, id]);
      return true;
    }
    if (this.capacity <= 0) return false;
    if (this.cached.size >= this.capacity) {
      // A new object enters only if it is at least as popular as the least popular cached object.
      for (;;) {
        const [k, v] = this.heap[0]!;
        if (!this.cached.has(v) || this.count.get(v) !== k) { this.pop(); continue; }
        if (k > c) return false;
        this.pop();
        this.cached.delete(v);
        break;
      }
    }
    this.cached.add(id);
    this.push([c, id]);
    return false;
  }
}

/** The ideal static cache: it holds the C most popular objects (ranks 1..C) and never changes. */
export class StaticCache implements Cache {
  constructor(readonly capacity: number) {}
  get size() { return this.capacity; }
  get(id: number) { return id <= this.capacity; }
}

export function makeCache(p: CachePolicy, capacity: number): Cache {
  switch (p) {
    case "lru": return new LruCache(capacity);
    case "fifo": return new FifoCache(capacity);
    case "lfu": return new LfuCache(capacity);
    case "static": return new StaticCache(capacity);
  }
}

export interface Workload {
  /** Number of distinct URLs. */
  K: number;
  theta: number;
  /** Cache-key variants per URL (Vary): each request picks one of V at random. 1: a normalized key. */
  variants?: number;
  requests?: number;
  seed?: number;
}

/**
 * A request stream of object ids. With V variants, URL r and variant v give object (r − 1)·V + v + 1; the most
 * popular URL's variants are objects 1..V. (The ideal static cache uses the order of the URLs, which is the order
 * of popularity of objects too, because all variants of a URL are equally likely.)
 */
export function zipfStream(w: Workload): Int32Array {
  const n = w.requests ?? 100_000, V = w.variants ?? 1;
  const z = new Zipf(w.K, w.theta);
  const rng: Rng = mulberry32(w.seed ?? 5);
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = z.rank(rng);
    out[i] = V === 1 ? r : (r - 1) * V + Math.floor(rng() * V) + 1;
  }
  return out;
}

export function hitRatio(stream: Int32Array, cache: Cache, warm = 0.3): number {
  const w = Math.floor(stream.length * warm);
  let hits = 0;
  for (let i = 0; i < stream.length; i++) if (cache.get(stream[i]!) && i >= w) hits++;
  return hits / (stream.length - w);
}

/** Request probabilities of the objects, most popular first (variants share their URL's probability). */
export function objectProbs(K: number, theta: number, variants = 1): Float64Array {
  const H = harmonic(K, theta);
  const p = new Float64Array(K * variants);
  for (let r = 1; r <= K; r++) for (let v = 0; v < variants; v++) p[(r - 1) * variants + v] = Math.pow(r, -theta) / H / variants;
  return p;
}

/**
 * Che's approximation for LRU (Che, Tung and Wang, IEEE JSAC 2002). Each object is in the cache if it was requested
 * within the last T requests, the "characteristic time". T solves Σ (1 − e^(−pᵢT)) = C, and the hit ratio is
 * Σ pᵢ(1 − e^(−pᵢT)). `probs` are per URL; with V variants each URL is V objects of probability p/V, so the sums
 * run over URLs with a factor V, and the cost does not grow with V.
 */
export function cheLru(probs: Float64Array, C: number, variants = 1): { hit: number; T: number } {
  const V = variants;
  if (C <= 0) return { hit: 0, T: 0 };
  if (C >= probs.length * V) return { hit: 1, T: Infinity };
  const fill = (T: number) => { let s = 0; for (const p of probs) s += 1 - Math.exp((-p * T) / V); return s * V; };
  let lo = 0, hi = 1;
  while (fill(hi) < C) hi *= 2;
  for (let k = 0; k < 50; k++) {
    const mid = (lo + hi) / 2;
    if (fill(mid) < C) lo = mid; else hi = mid;
  }
  const T = (lo + hi) / 2;
  let hit = 0;
  for (const p of probs) hit += p * (1 - Math.exp((-p * T) / V));
  return { hit, T };
}

/** The ideal static hit ratio: the share of requests for the C most popular objects. */
export function staticHit(probs: Float64Array, C: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(C, probs.length); i++) s += probs[i]!;
  return s;
}

// ---------------------------------------------------------------- a hierarchy of edges and a shield

/**
 * An LRU cache whose entries also expire: each entry keeps the time the origin made it. A copy that a cache passes
 * on keeps that time (the Age header, RFC 9111), so it expires everywhere at the same moment.
 */
export class TtlLru {
  private m = new Map<number, number>();
  constructor(readonly capacity: number) {}
  /** The origin time of a fresh copy, or undefined. A hit refreshes the entry's recency. */
  lookup(id: number, now: number, ttl: number): number | undefined {
    const t = this.m.get(id);
    if (t === undefined) return undefined;
    this.m.delete(id);
    if (now - t >= ttl) return undefined;
    this.m.set(id, t);
    return t;
  }
  store(id: number, born: number) {
    if (this.capacity <= 0) return;
    this.m.delete(id);
    if (this.m.size >= this.capacity) this.m.delete(this.m.keys().next().value!);
    this.m.set(id, born);
  }
}

export interface TierOpts {
  K: number;
  theta: number;
  /** Edge servers; each user request goes to one of them at random. */
  edges: number;
  /** Objects each edge holds. */
  edgeSize: number;
  /** Objects the shield holds; 0: no shield, the edges go to the origin. */
  shieldSize: number;
  /** User requests per second, all edges together (model input). */
  rate?: number;
  /** Freshness lifetime (max-age), s. */
  ttl?: number;
  requests?: number;
  seed?: number;
}

export interface TierResult {
  edgeHit: number;
  /** The share of edge misses that the shield answers. */
  shieldHit: number;
  /** Origin requests per user request. */
  originShare: number;
  /** Origin requests per second. */
  originRate: number;
}

export function tierRun(o: TierOpts): TierResult {
  const n = o.requests ?? 200_000, rate = o.rate ?? 1000, ttl = (o.ttl ?? 60) * 1000;
  const stream = zipfStream({ K: o.K, theta: o.theta, requests: n, seed: o.seed });
  const rng = mulberry32((o.seed ?? 5) + 99);
  const edges = Array.from({ length: o.edges }, () => new TtlLru(o.edgeSize));
  const shield = o.shieldSize > 0 ? new TtlLru(o.shieldSize) : null;
  const warm = Math.floor(n * 0.3);
  let edgeHits = 0, misses = 0, shieldHits = 0, origin = 0, t = 0, tWarm = 0;
  for (let i = 0; i < n; i++) {
    t += (-Math.log(1 - rng()) / rate) * 1000;
    if (i === warm) tWarm = t;
    const id = stream[i]!;
    const e = edges[Math.floor(rng() * o.edges)]!;
    const counted = i >= warm;
    if (e.lookup(id, t, ttl) !== undefined) { if (counted) edgeHits++; continue; }
    if (counted) misses++;
    let born = shield?.lookup(id, t, ttl);
    if (born !== undefined) { if (counted) shieldHits++; }
    else {
      born = t;
      shield?.store(id, born);
      if (counted) origin++;
    }
    e.store(id, born);
  }
  const m = n - warm;
  return { edgeHit: edgeHits / m, shieldHit: misses ? shieldHits / misses : 0, originShare: origin / m, originRate: origin / ((t - tWarm) / 1000) };
}
