/**
 * A buffer pool with pluggable replacement policies.
 *
 * The pool has `n` frames. A page table maps page IDs to frames. `fetch` pins a page (loading it on a miss),
 * `unpin` releases it and may mark it dirty. Only frames with pin count 0 can be victims. A dirty victim is
 * written back before its frame is reused.
 *
 * Policies implement `ReplacementPolicy`. Time (`now`) is the access counter, so "1000 ms" style windows are
 * expressed in accesses.
 *
 * Policies:
 * - lru: least recently used.
 * - clock: one reference bit per frame and a rotating hand (second chance).
 * - lru2: LRU-K with K = 2 (O'Neil, O'Neil, Weikum 1993). Evicts the page whose second-to-last access is oldest;
 *   pages seen only once go first. History is kept for evicted pages too.
 * - 2q: Johnson and Shasha 1994, full version: A1in (FIFO for new pages), A1out (ghost IDs), Am (LRU).
 * - midpoint: InnoDB. One LRU list; new pages enter at the head of the "old" sublist (the last 37%). A page in
 *   the old sublist moves to the head only if it is accessed again at least `oldTime` after its first access.
 * - pg: PostgreSQL clock sweep with usage counts (max 5). Accesses marked `scan` use a small ring of frames
 *   (the BAS_BULKREAD strategy), so a large scan recycles its own frames.
 */

export type PageId = number;

export interface Frame { page: PageId; pins: number; dirty: boolean }

export interface ReplacementPolicy {
  readonly id: PolicyId;
  hit(f: number, page: PageId, now: number, scan: boolean): void;
  load(f: number, page: PageId, now: number, scan: boolean): void;
  /** Chooses a victim among frames where `ok(f)`. Must not change state. Returns -1 if none. */
  victim(ok: (f: number) => boolean, now: number, scan: boolean): number;
  /** Frame f lost `page` (after victim selection). */
  evict(f: number, page: PageId): void;
  /** Frames ordered from the next victim to the safest, for display. */
  order(): number[];
  /** Short per-frame state for display (reference bit, usage count, list name). */
  tag(f: number): string;
}

export type PolicyId = "lru" | "clock" | "lru2" | "2q" | "midpoint" | "pg";

// ---------------- LRU ----------------
class Lru implements ReplacementPolicy {
  readonly id = "lru" as const;
  private last: Float64Array;
  private used: Uint8Array;
  constructor(private n: number) { this.last = new Float64Array(n); this.used = new Uint8Array(n); }
  hit(f: number, _p: PageId, now: number) { this.last[f] = now; }
  load(f: number, _p: PageId, now: number) { this.last[f] = now; this.used[f] = 1; }
  victim(ok: (f: number) => boolean) {
    let best = -1, bt = Infinity;
    for (let f = 0; f < this.n; f++) if (this.used[f] && ok(f) && this.last[f]! < bt) { bt = this.last[f]!; best = f; }
    return best;
  }
  evict(f: number) { this.used[f] = 0; }
  order() { return [...Array(this.n).keys()].filter((f) => this.used[f]).sort((a, b) => this.last[a]! - this.last[b]!); }
  tag(f: number) { return this.used[f] ? `t${this.last[f]}` : ""; }
}

// ---------------- Clock ----------------
class Clock implements ReplacementPolicy {
  readonly id = "clock" as const;
  readonly ref: Uint8Array;
  hand = 0;
  constructor(private n: number) { this.ref = new Uint8Array(n); }
  hit(f: number) { this.ref[f] = 1; }
  load(f: number) { this.ref[f] = 1; }
  private planned: Uint8Array | null = null;
  victim(ok: (f: number) => boolean) {
    // Sweep on a copy: victim() must not change state; evict() commits the copy.
    const ref = this.ref.slice();
    let h = this.hand;
    for (let k = 0; k < 2 * this.n + 1; k++) {
      if (ok(h)) { if (!ref[h]) { this.planned = ref; return h; } ref[h] = 0; }
      h = (h + 1) % this.n;
    }
    this.planned = null;
    return -1;
  }
  evict(f: number) {
    if (this.planned) this.ref.set(this.planned);
    this.planned = null;
    this.ref[f] = 0;
    this.hand = (f + 1) % this.n;
  }
  order() { const o: number[] = []; for (let k = 0; k < this.n; k++) o.push((this.hand + k) % this.n); return o; }
  tag(f: number) { return `ref ${this.ref[f]}`; }
}

// ---------------- LRU-2 ----------------
class Lru2 implements ReplacementPolicy {
  readonly id = "lru2" as const;
  /** page → [last access, access before that]. Kept after eviction (retained information). */
  private hist = new Map<PageId, [number, number]>();
  private pageOf: Int32Array;
  constructor(private n: number, private crp = 0) { this.pageOf = new Int32Array(n).fill(-1); }
  private touch(p: PageId, now: number) {
    const h = this.hist.get(p);
    if (!h) { this.hist.set(p, [now, -Infinity]); return; }
    if (now - h[0] <= this.crp) { h[0] = now; return; } // correlated reference: not a new access
    h[1] = h[0]; h[0] = now;
  }
  hit(_f: number, p: PageId, now: number) { this.touch(p, now); }
  load(f: number, p: PageId, now: number) { this.pageOf[f] = p; this.touch(p, now); }
  private key(f: number): [number, number] { return this.hist.get(this.pageOf[f]!) ?? [0, -Infinity]; }
  victim(ok: (f: number) => boolean) {
    let best = -1, b2 = Infinity, b1 = Infinity;
    for (let f = 0; f < this.n; f++) {
      if (this.pageOf[f]! < 0 || !ok(f)) continue;
      const [t1, t2] = this.key(f);
      if (t2 < b2 || (t2 === b2 && t1 < b1)) { b2 = t2; b1 = t1; best = f; }
    }
    return best;
  }
  evict(f: number) { this.pageOf[f] = -1; }
  order() {
    return [...Array(this.n).keys()].filter((f) => this.pageOf[f]! >= 0).sort((a, b) => {
      const [a1, a2] = this.key(a), [b1, b2] = this.key(b);
      return a2 === b2 ? a1 - b1 : a2 - b2;
    });
  }
  tag(f: number) { const [, t2] = this.key(f); return t2 === -Infinity ? "1 ref" : `t2=${t2}`; }
}

// ---------------- 2Q ----------------
class TwoQ implements ReplacementPolicy {
  readonly id = "2q" as const;
  private a1in: number[] = [];
  private am: number[] = [];
  private a1out: PageId[] = [];
  private kin: number;
  private kout: number;
  constructor(n: number) { this.kin = Math.max(1, Math.round(n * 0.25)); this.kout = Math.max(1, Math.round(n * 0.5)); }
  hit(f: number) {
    const i = this.am.indexOf(f);
    if (i >= 0) { this.am.splice(i, 1); this.am.push(f); }
    // A hit in A1in does nothing: correlated accesses to a new page do not promote it.
  }
  load(f: number, p: PageId) {
    const g = this.a1out.indexOf(p);
    if (g >= 0) { this.a1out.splice(g, 1); this.am.push(f); }
    else this.a1in.push(f);
  }
  victim(ok: (f: number) => boolean) {
    const fromIn = this.a1in.find(ok), fromAm = this.am.find(ok);
    if (this.a1in.length > this.kin || fromAm === undefined) return fromIn ?? fromAm ?? -1;
    return fromAm;
  }
  evict(f: number, p: PageId) {
    const i = this.a1in.indexOf(f);
    if (i >= 0) {
      this.a1in.splice(i, 1);
      this.a1out.push(p);
      if (this.a1out.length > this.kout) this.a1out.shift();
      return;
    }
    const j = this.am.indexOf(f);
    if (j >= 0) this.am.splice(j, 1);
  }
  order() { return this.a1in.length > this.kin ? [...this.a1in, ...this.am] : [...this.am, ...this.a1in]; }
  tag(f: number) { return this.a1in.includes(f) ? "A1in" : this.am.includes(f) ? "Am" : ""; }
}

// ---------------- InnoDB midpoint insertion ----------------
class Midpoint implements ReplacementPolicy {
  readonly id = "midpoint" as const;
  /** Index 0 = head (most recently made young), end = tail (next victim). */
  private list: number[] = [];
  private first: Float64Array;
  constructor(n: number, private oldTime = 0, private oldPct = 37) { this.first = new Float64Array(n); }
  private oldStart() { return this.list.length - Math.round((this.list.length * this.oldPct) / 100); }
  hit(f: number, _p: PageId, now: number) {
    const i = this.list.indexOf(f);
    if (i < 0) return;
    const isOld = i >= this.oldStart();
    if (isOld && now - this.first[f]! < this.oldTime) return; // too soon after the first access: stay old
    this.list.splice(i, 1);
    this.list.unshift(f);
  }
  load(f: number, _p: PageId, now: number) {
    this.first[f] = now;
    // Insert at the head of the old sublist, sized for the list after the insert.
    const len = this.list.length + 1;
    this.list.splice(len - Math.round((len * this.oldPct) / 100), 0, f);
  }
  victim(ok: (f: number) => boolean) {
    for (let i = this.list.length - 1; i >= 0; i--) if (ok(this.list[i]!)) return this.list[i]!;
    return -1;
  }
  evict(f: number) { const i = this.list.indexOf(f); if (i >= 0) this.list.splice(i, 1); }
  order() { return [...this.list].reverse(); }
  tag(f: number) { const i = this.list.indexOf(f); return i < 0 ? "" : i >= this.oldStart() ? "old" : "young"; }
}

// ---------------- PostgreSQL clock sweep + ring ----------------
export const PG_MAX_USAGE = 5;
class PgClock implements ReplacementPolicy {
  readonly id = "pg" as const;
  readonly usage: Uint8Array;
  private inRing: Uint8Array;
  private ring: number[] = [];
  private ringPos = 0;
  hand = 0;
  /** Set by victim(), applied by evict(). */
  private plan: { kind: "ring" | "sweep"; f: number; usage?: Uint8Array } | null = null;
  constructor(private n: number, private ringSize = 8) { this.usage = new Uint8Array(n); this.inRing = new Uint8Array(n); }
  hit(f: number, _p: PageId, _now: number, scan: boolean) {
    // PinBuffer: a normal access increments usage_count; a strategy (ring) access only raises 0 to 1.
    if (scan) { if (this.usage[f] === 0) this.usage[f] = 1; }
    else { this.usage[f] = Math.min(PG_MAX_USAGE, this.usage[f]! + 1); this.inRing[f] = 0; }
  }
  load(f: number, _p: PageId, _now: number, scan: boolean) {
    this.usage[f] = 1;
    if (scan) {
      this.inRing[f] = 1;
      if (this.ring.length < this.ringSize) this.ring.push(f);
      else { this.ring[this.ringPos] = f; this.ringPos = (this.ringPos + 1) % this.ringSize; }
    } else this.inRing[f] = 0;
  }
  victim(ok: (f: number) => boolean, _now: number, scan: boolean) {
    this.plan = null;
    if (scan && this.ring.length >= this.ringSize) {
      const f = this.ring[this.ringPos]!;
      if (this.inRing[f] && ok(f) && this.usage[f]! <= 1) { this.plan = { kind: "ring", f }; return f; }
    }
    const u = this.usage.slice();
    let h = this.hand;
    for (let k = 0; k < (PG_MAX_USAGE + 1) * this.n + 1; k++) {
      if (ok(h)) { if (u[h] === 0) { this.plan = { kind: "sweep", f: h, usage: u }; return h; } u[h]!--; }
      h = (h + 1) % this.n;
    }
    this.plan = null;
    return -1;
  }
  evict(f: number) {
    if (this.plan?.kind === "sweep" && this.plan.f === f) {
      // Commit the sweep: each time the hand passed a frame, its usage count went down by one.
      this.usage.set(this.plan.usage!);
      this.hand = (f + 1) % this.n;
    }
    // A ring reuse needs nothing here: load() writes the frame back into the current ring slot.
    this.inRing[f] = 0;
    this.plan = null;
  }
  order() { const o: number[] = []; for (let k = 0; k < this.n; k++) o.push((this.hand + k) % this.n); return o; }
  tag(f: number) { return `use ${this.usage[f]}${this.inRing[f] ? " ring" : ""}`; }
}

export interface PolicyOpts {
  /** midpoint: innodb_old_blocks_time in accesses. */
  oldTime?: number;
  /** midpoint: innodb_old_blocks_pct (default 37). */
  oldPct?: number;
  /** lru2: correlated reference period in accesses. */
  crp?: number;
  /** pg: ring size in frames (PostgreSQL: 256 KiB = 32 pages of 8 KiB). */
  ring?: number;
}

export function makePolicy(id: PolicyId, n: number, o: PolicyOpts = {}): ReplacementPolicy {
  switch (id) {
    case "lru": return new Lru(n);
    case "clock": return new Clock(n);
    case "lru2": return new Lru2(n, o.crp ?? 0);
    case "2q": return new TwoQ(n);
    case "midpoint": return new Midpoint(n, o.oldTime ?? 0, o.oldPct ?? 37);
    case "pg": return new PgClock(n, Math.min(o.ring ?? 8, Math.max(1, n >> 2)));
  }
}

export const POLICY_LABEL: Record<PolicyId, string> = {
  lru: "LRU",
  clock: "Clock",
  lru2: "LRU-2",
  "2q": "2Q",
  midpoint: "Midpoint (InnoDB)",
  pg: "Clock sweep + ring (PostgreSQL)",
};

export class BufferPoolFullError extends Error {
  constructor() { super("all frames are pinned"); }
}

export interface FetchResult {
  frame: number;
  hit: boolean;
  /** The page that was evicted to make room, and whether it was written back. */
  evicted?: { page: PageId; dirty: boolean };
}

export interface PoolStats { hits: number; misses: number; reads: number; writes: number; evictions: number }

export interface PageIo { read(page: PageId, frame: number): void; write(page: PageId, frame: number): void }

export class BufferPool {
  readonly frames: Frame[];
  readonly table = new Map<PageId, number>();
  readonly policy: ReplacementPolicy;
  readonly stats: PoolStats = { hits: 0, misses: 0, reads: 0, writes: 0, evictions: 0 };
  now = 0;

  constructor(readonly size: number, policy: PolicyId | ReplacementPolicy = "lru", private io?: PageIo, opts: PolicyOpts = {}) {
    this.frames = Array.from({ length: size }, () => ({ page: -1, pins: 0, dirty: false }));
    this.policy = typeof policy === "string" ? makePolicy(policy, size, opts) : policy;
  }

  /** Pins `page`, loading it on a miss. Throws BufferPoolFullError if every frame is pinned. */
  fetch(page: PageId, opts: { scan?: boolean } = {}): FetchResult {
    const now = ++this.now;
    const scan = opts.scan ?? false;
    const f0 = this.table.get(page);
    if (f0 !== undefined) {
      this.frames[f0]!.pins++;
      this.stats.hits++;
      this.policy.hit(f0, page, now, scan);
      return { frame: f0, hit: true };
    }
    this.stats.misses++;
    let f = this.frames.findIndex((x) => x.page < 0);
    let evicted: FetchResult["evicted"];
    if (f < 0) {
      f = this.policy.victim((k) => this.frames[k]!.pins === 0, now, scan);
      if (f < 0) throw new BufferPoolFullError();
      const v = this.frames[f]!;
      evicted = { page: v.page, dirty: v.dirty };
      if (v.dirty) { this.io?.write(v.page, f); this.stats.writes++; }
      this.policy.evict(f, v.page);
      this.table.delete(v.page);
      this.stats.evictions++;
    }
    this.io?.read(page, f);
    this.stats.reads++;
    this.frames[f] = { page, pins: 1, dirty: false };
    this.table.set(page, f);
    this.policy.load(f, page, now, scan);
    return { frame: f, hit: false, evicted };
  }

  /** Releases one pin. Pass dirty = true if the caller changed the page. */
  unpin(page: PageId, dirty = false) {
    const f = this.table.get(page);
    if (f === undefined) throw new Error(`page ${page} is not in the pool`);
    const fr = this.frames[f]!;
    if (fr.pins <= 0) throw new Error(`page ${page} is not pinned`);
    fr.pins--;
    if (dirty) fr.dirty = true;
  }

  /** Fetch + unpin in one call. */
  access(page: PageId, opts: { scan?: boolean; write?: boolean } = {}): FetchResult {
    const r = this.fetch(page, opts);
    this.unpin(page, opts.write ?? false);
    return r;
  }

  /** Writes a dirty page back and clears its dirty bit (the page stays cached). */
  flush(page: PageId): boolean {
    const f = this.table.get(page);
    if (f === undefined || !this.frames[f]!.dirty) return false;
    this.io?.write(page, f);
    this.stats.writes++;
    this.frames[f]!.dirty = false;
    return true;
  }

  flushAll(): number { let n = 0; for (const p of this.table.keys()) if (this.flush(p)) n++; return n; }

  get hitRate() { const t = this.stats.hits + this.stats.misses; return t ? this.stats.hits / t : 0; }
}

// =====================================================================================
// Workloads
// =====================================================================================

export interface Access { page: PageId; scan: boolean; write?: boolean; cold?: boolean }

export interface MixOpts {
  /** Hot pages 0..hot-1, accessed uniformly. */
  hot: number;
  /** Total hot-set accesses. */
  hotAccesses: number;
  /** Pages that one scan reads. Each scan reads pages that no earlier access touched
   *  (a different part of a very large table), so scan pages are never reused. 0 = no scans. */
  scanPages: number;
  /** A full scan starts after every `scanEvery` hot accesses. */
  scanEvery: number;
  /** Consecutive accesses per scanned page (one per row read from it). */
  touches: number;
  /** Fraction of non-scan accesses that go to a large cold set (pages after the scanned table). */
  coldFrac?: number;
  coldPages?: number;
  seed?: number;
}

/** Hot set accessed at random, with periodic full scans of a large table mixed in. */
export function mixedTrace(o: MixOpts): Access[] {
  let a = (o.seed ?? 11) >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: Access[] = [];
  const coldPages = o.coldPages ?? 10000;
  let nextScan = o.hot + coldPages;
  for (let i = 0; i < o.hotAccesses; i++) {
    if (o.scanPages > 0 && i > 0 && i % o.scanEvery === 0) {
      for (let p = 0; p < o.scanPages; p++) for (let t = 0; t < o.touches; t++) out.push({ page: nextScan + p, scan: true });
      nextScan += o.scanPages;
    }
    const cold = (o.coldFrac ?? 0) > 0 && rnd() < o.coldFrac!;
    out.push(cold
      ? { page: o.hot + Math.floor(rnd() * coldPages), scan: false, cold: true }
      : { page: Math.floor(rnd() * o.hot), scan: false });
  }
  return out;
}

export interface TraceResult { hotHitRate: number; hitRate: number; reads: number }

/** Runs a trace and reports the hit rate of hot-set accesses (not scan, not cold) after a warm-up of `warm` accesses. */
export function runTrace(trace: Access[], frames: number, policy: PolicyId, o: PolicyOpts = {}, warm = Math.floor(trace.length / 5)): TraceResult {
  const bp = new BufferPool(frames, policy, undefined, o);
  let hh = 0, hn = 0, ah = 0, an = 0;
  trace.forEach((x, i) => {
    const r = bp.access(x.page, { scan: x.scan, write: x.write });
    if (i < warm) return;
    an++; if (r.hit) ah++;
    if (!x.scan && !x.cold) { hn++; if (r.hit) hh++; }
  });
  return { hotHitRate: hn ? hh / hn : 0, hitRate: an ? ah / an : 0, reads: bp.stats.reads };
}
