/**
 * The page cache and writeback.
 *
 * - `writebackRun`: a write burst against the kernel's dirty limits: background writeback starts at one threshold, and
 *   balance_dirty_pages throttles writers above a free-run ceiling with the kernel's cubic position ratio.
 * - `Readahead`: the on-demand read-ahead state machine (struct file_ra_state, get_init_ra_size, get_next_ra_size).
 * - `PageCache`: a page cache with dirty pages, writeback, fsync and drop_caches.
 * - `memAvailable`, `freeOutput`: how `free` computes its columns.
 */
import { HDDS } from "../../db/storage/disk";

/** Defaults of /proc/sys/vm/. */
export const VM_DEFAULTS = { dirtyRatio: 20, dirtyBackgroundRatio: 10, dirtyExpireCentisecs: 3000, dirtyWritebackCentisecs: 500 };

export interface DirtyLimits { limit: number; bg: number; freerun: number; setpoint: number }

/**
 * The thresholds in MiB, from the dirtyable memory (free pages plus file cache). If the background ratio is not
 * below the dirty ratio, the kernel uses half of the limit. See domain_dirty_limits and dirty_freerun_ceiling.
 */
export function dirtyLimits(dirtyableMiB: number, dirtyRatio: number, bgRatio: number): DirtyLimits {
  const limit = (dirtyableMiB * dirtyRatio) / 100;
  let bg = (dirtyableMiB * bgRatio) / 100;
  if (bg >= limit) bg = limit / 2;
  const freerun = (bg + limit) / 2;
  return { limit, bg, freerun, setpoint: (freerun + limit) / 2 };
}

/**
 * The position ratio of balance_dirty_pages (pos_ratio_polynom): 1 + ((setpoint - dirty) / (limit - setpoint))^3,
 * clamped to 0..2. It is 2 at the free-run side, 1 at the setpoint and 0 at the limit.
 */
export function posRatio(dirty: number, l: DirtyLimits): number {
  const x = (l.setpoint - dirty) / Math.max(1e-9, l.limit - l.setpoint);
  return Math.min(2, Math.max(0, 1 + x * x * x));
}

export type WriterState = "free" | "throttled" | "blocked" | "idle";

export interface WritebackOpts {
  dirtyableMiB: number;
  dirtyRatio: number;
  dirtyBackgroundRatio: number;
  dirtyExpireCentisecs: number;
  dirtyWritebackCentisecs: number;
  /** Disk write speed in MiB/s. */
  diskMiBps: number;
  /** The rate at which the writer wants to write, in MiB/s. */
  writerMiBps: number;
  /** The size of the burst, in MiB. */
  burstMiB: number;
  duration: number;
  dt: number;
}

/** Model inputs for the demo. The disk speed is the 7,200 rpm model of the databases track. */
export const BURST_DEFAULTS: WritebackOpts = {
  dirtyableMiB: 16384,
  dirtyRatio: VM_DEFAULTS.dirtyRatio,
  dirtyBackgroundRatio: VM_DEFAULTS.dirtyBackgroundRatio,
  dirtyExpireCentisecs: VM_DEFAULTS.dirtyExpireCentisecs,
  dirtyWritebackCentisecs: VM_DEFAULTS.dirtyWritebackCentisecs,
  diskMiBps: HDDS["7200"].mbps,
  writerMiBps: 2000,
  burstMiB: 8192,
  duration: 80,
  dt: 0.05,
};

export interface WritebackSample { t: number; dirty: number; written: number; accepted: number; writerRate: number; flushing: boolean; state: WriterState }

export interface WritebackRun {
  limits: DirtyLimits;
  samples: WritebackSample[];
  /** First time above the background threshold, or null. */
  bgAt: number | null;
  /** First time the writer slowed down, or null. */
  throttleAt: number | null;
  /** First time the disk started to write, for any reason. */
  firstFlushAt: number | null;
  /** The time at which the burst was all in the page cache. */
  burstDoneAt: number | null;
  /** The time at which all of it was on disk. */
  cleanAt: number | null;
  /** Time the writer spent below its wanted rate. */
  throttledSeconds: number;
  peakDirty: number;
  /** The time an fsync would take at the end of the burst: all dirty data at disk speed. */
  syncAtBurstEnd: number | null;
  /** The mean rate the writer saw for the whole burst, in MiB/s. */
  meanWriterRate: number | null;
}

export function writebackRun(o: WritebackOpts): WritebackRun {
  const limits = dirtyLimits(o.dirtyableMiB, o.dirtyRatio, o.dirtyBackgroundRatio);
  const expire = o.dirtyExpireCentisecs / 100, period = o.dirtyWritebackCentisecs / 100;
  const samples: WritebackSample[] = [];
  // A FIFO of dirty data by age. Each entry is [time of write, MiB].
  const q: [number, number][] = [];
  let head = 0;
  let dirty = 0, accepted = 0, written = 0, nextWake = period, flushingOld = false, bgActive = false;
  let bgAt: number | null = null, throttleAt: number | null = null, firstFlushAt: number | null = null, burstDoneAt: number | null = null, cleanAt: number | null = null;
  let throttled = 0, peak = 0, syncAtBurstEnd: number | null = null;
  const steps = Math.round(o.duration / o.dt);
  for (let i = 0; i <= steps; i++) {
    const t = i * o.dt;
    // The writer.
    let state: WriterState = "idle";
    let rate = 0;
    if (accepted < o.burstMiB) {
      if (dirty <= limits.freerun) { rate = o.writerMiBps; state = "free"; }
      else if (dirty >= limits.limit) { rate = 0; state = "blocked"; }
      else { rate = Math.min(o.writerMiBps, posRatio(dirty, limits) * o.diskMiBps); state = "throttled"; }
      if (state !== "free" && throttleAt === null) throttleAt = t;
      if (rate < o.writerMiBps) throttled += o.dt;
      const add = Math.min(rate * o.dt, o.burstMiB - accepted);
      if (add > 0) { q.push([t, add]); dirty += add; accepted += add; }
      if (accepted >= o.burstMiB - 1e-9) { burstDoneAt = t + o.dt; syncAtBurstEnd = dirty / o.diskMiBps; }
    }
    if (dirty > limits.bg) {
      if (bgAt === null) bgAt = t;
      bgActive = true;
    }
    if (dirty <= limits.bg) bgActive = false;
    // The flusher thread wakes on its period, and it writes data older than the expiry age.
    if (t >= nextWake) {
      nextWake += period;
      if (head < q.length && t - q[head]![0] >= expire) flushingOld = true;
    }
    if (flushingOld && (head >= q.length || t - q[head]![0] < expire)) flushingOld = false;
    const flushing = (bgActive || flushingOld) && dirty > 0;
    if (flushing) {
      if (firstFlushAt === null) firstFlushAt = t;
      let budget = o.diskMiBps * o.dt;
      while (budget > 1e-12 && head < q.length) {
        const e = q[head]!;
        // Background writeback stops at the threshold, and expiry writeback stops at young data.
        if (!bgActive && t - e[0] < expire) break;
        const take = Math.min(budget, e[1]);
        e[1] -= take;
        budget -= take;
        dirty -= take;
        written += take;
        if (e[1] <= 1e-12) head++;
      }
    }
    peak = Math.max(peak, dirty);
    if (cleanAt === null && accepted >= o.burstMiB - 1e-9 && dirty <= 1e-6) cleanAt = t + o.dt;
    samples.push({ t, dirty, written, accepted, writerRate: rate, flushing, state });
  }
  return { limits, samples, bgAt, throttleAt, firstFlushAt, burstDoneAt, cleanAt, throttledSeconds: throttled, peakDirty: peak, syncAtBurstEnd, meanWriterRate: burstDoneAt ? o.burstMiB / burstDoneAt : null };
}

/** The run that the demo plots: long enough for the disk to finish, with a fixed sample count. */
export function burstRun(o: Partial<WritebackOpts> = {}): WritebackRun {
  const m = { ...BURST_DEFAULTS, ...o };
  const duration = Math.min(1200, Math.max(90, (m.burstMiB / m.diskMiBps) * 1.25 + 40));
  return writebackRun({ ...m, duration, dt: duration / 1600 });
}

// --------------------------------------------------------------------------------------------- read-ahead

export const READ_AHEAD_DEFAULT_KB = 128;
export const PAGE_KB = 4;
export const raPages = (kb: number) => Math.max(1, Math.floor(kb / PAGE_KB));

const roundupPow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };

/** get_init_ra_size */
export function initRaSize(req: number, max: number): number {
  const n = roundupPow2(req);
  if (n <= max / 32) return n * 4;
  if (n <= max / 4) return n * 2;
  return max;
}

/** get_next_ra_size */
export function nextRaSize(cur: number, max: number): number {
  if (cur < max / 16) return 4 * cur;
  if (cur <= max / 2) return 2 * cur;
  return max;
}

export type RaEvent = "hit" | "marker" | "initial" | "ramp" | "random";

export interface RaResult { index: number; event: RaEvent; sync: boolean; read: number[]; say: string }

/** The kernel's on-demand read-ahead for one open file (mm/readahead.c). It works in pages. */
export class Readahead {
  start = 0;
  size = 0;
  asyncSize = 0;
  prev = -2;
  readonly cached = new Set<number>();
  readonly markers = new Set<number>();
  readonly used = new Set<number>();
  hits = 0;
  syncMisses = 0;
  pagesRead = 0;
  readonly windows: number[] = [];
  constructor(readonly max: number) {}

  private submit(pages: number[]) {
    const fresh = pages.filter((p) => !this.cached.has(p));
    for (const p of fresh) this.cached.add(p);
    this.pagesRead += fresh.length;
    this.windows.push(this.size);
    const mark = this.start + this.size - this.asyncSize;
    if (this.asyncSize > 0 && this.cached.has(mark)) this.markers.add(mark);
    return fresh;
  }

  private range() { return Array.from({ length: this.size }, (_, i) => this.start + i); }

  /** Reads one page, as a read() of one page would. */
  read(index: number): RaResult {
    this.used.add(index);
    const prev = this.prev;
    this.prev = index;
    if (this.cached.has(index)) {
      this.hits++;
      if (!this.markers.has(index)) return { index, event: "hit", sync: false, read: [], say: `Page ${index} is in the cache. No I/O.` };
      this.markers.delete(index);
      // page_cache_async_ra: the reader reached the marker, so the next window goes out now.
      if (index === this.start + this.size - this.asyncSize || index === this.start + this.size) {
        this.start += this.size;
        this.size = nextRaSize(this.size, this.max);
        this.asyncSize = this.size;
      } else {
        this.start = index + 1;
        this.size = initRaSize(1, this.max);
        this.asyncSize = this.size;
      }
      const read = this.submit(this.range());
      return { index, event: "marker", sync: false, read, say: `Page ${index} is in the cache and carries the marker. The kernel starts the next window of ${this.size} pages in the background. The reader does not wait.` };
    }
    // page_cache_sync_ra: a miss, and the reader must wait.
    this.syncMisses++;
    if (index === 0 || index - prev <= 1 && index - prev >= 0) {
      this.start = index;
      this.size = initRaSize(1, this.max);
      this.asyncSize = this.size > 1 ? this.size - 1 : this.size;
      const read = this.submit(this.range());
      return { index, event: "initial", sync: true, read, say: `Page ${index} is a miss, and it follows the previous read. A first window of ${this.size} pages goes out, and the reader waits for page ${index}.` };
    }
    if (index === this.start + this.size) {
      this.start += this.size;
      this.size = nextRaSize(this.size, this.max);
      this.asyncSize = this.size;
      const read = this.submit(this.range());
      return { index, event: "ramp", sync: true, read, say: `Page ${index} is a miss at the expected place. The window grows to ${this.size} pages, and the reader waits.` };
    }
    // A small random read: read it alone, and do not touch the state.
    this.cached.add(index);
    this.pagesRead++;
    return { index, event: "random", sync: true, read: [index], say: `Page ${index} does not follow the last read. The kernel reads this one page and starts no window. A later read of page ${index + 1} starts again from a small window.` };
  }

  /**
   * A page that the kernel will treat as a random read: not cached, its neighbour not cached, and not the place where
   * the next window would start. It looks past the cached range first, and it wraps round if the file ends.
   */
  jumpTarget(pos: number, pages: number): number {
    const top = Math.max(pos, ...this.cached);
    for (let d = 9; d < pages; d++) {
      const p = (top + d) % (pages - 1);
      if (!this.cached.has(p) && !this.cached.has(p + 1) && p !== this.start + this.size && p !== this.prev + 1) return p;
    }
    return (top + 9) % pages;
  }

  /** Pages that were read but not used so far. */
  get wasted() { let n = 0; for (const p of this.cached) if (!this.used.has(p)) n++; return n; }
}

/** The window sizes of a sequential read of `pages` pages from offset 0. */
export function sequentialWindows(kb: number, pages: number): number[] {
  const r = new Readahead(raPages(kb));
  for (let i = 0; i < pages; i++) r.read(i);
  return r.windows;
}

// --------------------------------------------------------------------------------------------- a page cache

export interface CachedPage { dirty: boolean; mapped: boolean; value: string }

/** Files of pages with a dirty bit. `disk` is what survives a crash. */
export class PageCache {
  readonly pages = new Map<string, CachedPage>();
  readonly disk = new Map<string, string>();
  reads = 0;
  writes = 0;
  private key(file: string, n: number) { return `${file}#${n}`; }

  read(file: string, n: number): string | undefined {
    const k = this.key(file, n);
    const hit = this.pages.get(k);
    if (hit) return hit.value;
    this.reads++;
    const v = this.disk.get(k);
    if (v !== undefined) this.pages.set(k, { dirty: false, mapped: false, value: v });
    return v;
  }
  write(file: string, n: number, value: string) {
    const k = this.key(file, n);
    const p = this.pages.get(k);
    if (p) { p.value = value; p.dirty = true; } else this.pages.set(k, { dirty: true, mapped: false, value });
  }
  map(file: string, n: number) { this.read(file, n); const p = this.pages.get(this.key(file, n)); if (p) p.mapped = true; }
  /** Writes dirty pages. With a file name, only that file's: what fsync starts. */
  writeback(file?: string) {
    for (const [k, p] of this.pages) {
      if (!p.dirty || (file && !k.startsWith(`${file}#`))) continue;
      this.disk.set(k, p.value);
      p.dirty = false;
      this.writes++;
    }
  }
  fsync(file: string) { this.writeback(file); }
  /** echo 1 > drop_caches frees clean, unmapped pages. Dirty pages and mapped pages stay. */
  dropCaches() {
    let n = 0;
    for (const [k, p] of this.pages) if (!p.dirty && !p.mapped) { this.pages.delete(k); n++; }
    return n;
  }
  get dirtyCount() { let n = 0; for (const p of this.pages.values()) if (p.dirty) n++; return n; }
  /** A crash loses the cache. */
  crash() { this.pages.clear(); }
}

// --------------------------------------------------------------------------------------------- free

export interface MemInfo { totalMiB: number; freeMiB: number; fileMiB: number; buffersMiB: number; slabReclaimableMiB: number; shmemMiB: number; anonMiB: number; wmarkLowMiB: number; reservedMiB: number }

/** A worked example for reading `free`. All numbers are model inputs of one imagined machine. */
export const MEMINFO_EXAMPLE: MemInfo = { totalMiB: 16000, freeMiB: 600, fileMiB: 9000, buffersMiB: 200, slabReclaimableMiB: 800, shmemMiB: 200, anonMiB: 5000, wmarkLowMiB: 100, reservedMiB: 150 };

/** The estimate in si_mem_available: free pages, plus file pages and reclaimable slab that can go without swapping. */
export function memAvailable(m: MemInfo): number {
  const pagecache = m.fileMiB + m.buffersMiB - m.shmemMiB;
  const keepCache = Math.min(pagecache / 2, m.wmarkLowMiB);
  const keepSlab = Math.min(m.slabReclaimableMiB / 2, m.wmarkLowMiB);
  return Math.max(0, m.freeMiB - m.reservedMiB + (pagecache - keepCache) + (m.slabReclaimableMiB - keepSlab));
}

/** The columns of `free`. buff/cache counts page cache, buffers and reclaimable slab. shmem pages count in the cache. */
export function freeOutput(m: MemInfo) {
  const buffCache = m.fileMiB + m.buffersMiB + m.slabReclaimableMiB;
  const available = memAvailable(m);
  return { total: m.totalMiB, free: m.freeMiB, shared: m.shmemMiB, buffCache, available, usedOld: m.totalMiB - m.freeMiB - buffCache, usedNew: m.totalMiB - available };
}
