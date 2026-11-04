/**
 * Checkpoints over time, PostgreSQL style, as a fluid model with one-second steps.
 *
 * Workload: `updatesPerSec` row updates on `pages` 8 KiB pages, page popularity Zipf(1).
 * - WAL: every update writes `recordBytes`; the first update of a page after a checkpoint starts
 *   also writes a full page image (full_page_writes), PAGE_BYTES.
 * - A checkpoint starts when checkpoint_timeout has passed, or when the WAL since the last start
 *   reaches max_wal_size / (1 + checkpoint_completion_target) (PostgreSQL's trigger).
 * - At its start, the checkpoint remembers the WAL position (the redo point) and the dirty pages.
 *   It writes them spread over completion_target × timeout, but never faster than the device can.
 * - When the writes end, the checkpoint is complete. Recovery after a crash at time t replays the
 *   WAL from the redo point of the last complete checkpoint up to t.
 * Pages touched by a skewed workload are computed in expectation: page i, with probability w_i per
 * update, is touched within τ seconds with probability 1 − exp(−U τ w_i).
 */

export const PAGE_BYTES = 8192;

export interface CkptParams {
  /** checkpoint_timeout, seconds. */
  timeoutSec: number;
  /** checkpoint_completion_target, 0..1. */
  completion: number;
  /** max_wal_size, MiB. */
  maxWalMiB: number;
  horizonSec?: number;
  updatesPerSec?: number;
  pages?: number;
  recordBytes?: number;
  /** Most pages per second that the device can write. */
  maxWritePagesPerSec?: number;
  /** WAL bytes per second that recovery can replay (an assumption of the model). */
  replayBytesPerSec?: number;
}

export const CKPT_DEFAULTS = {
  horizonSec: 3600,
  updatesPerSec: 500,
  pages: 1 << 20, // 8 GiB of 8 KiB pages
  recordBytes: 100,
  maxWritePagesPerSec: 25_000, // about 200 MB/s
  replayBytesPerSec: 64 * 1024 * 1024,
};

export interface Checkpoint { start: number; end: number; pages: number; redoWal: number; trigger: "time" | "size" }

export interface CkptResult {
  /** Per second: page write rate (pages/s), WAL rate (bytes/s), full page images. */
  writes: number[];
  wal: number[];
  fpi: number[];
  /** Cumulative WAL bytes at the start of each second. */
  walPos: number[];
  /** Recovery time (s) if the crash happens at the end of second t. */
  recovery: number[];
  checkpoints: Checkpoint[];
  totalPageWrites: number;
  totalWalBytes: number;
  totalFpi: number;
  peakWritePagesPerSec: number;
  maxRecoverySec: number;
}

// ---- expected distinct pages touched, from bucketed Zipf(1) weights ----

interface Buckets { n: number[]; w: number[] }
const bucketCache = new Map<number, Buckets>();
function buckets(pages: number): Buckets {
  let b = bucketCache.get(pages);
  if (b) return b;
  const H = (k: number) => (k < 1 ? 0 : Math.log(k) + 0.5772156649 + 1 / (2 * k)); // harmonic number
  const total = H(pages);
  const n: number[] = [], w: number[] = [];
  let lo = 1;
  while (lo <= pages) {
    const hi = Math.min(pages, Math.max(lo, Math.floor(lo * 1.15)));
    const cnt = hi - lo + 1;
    // mean weight of ranks lo..hi
    const mass = lo === hi ? 1 / lo : H(hi) - H(lo - 1);
    n.push(cnt);
    w.push(mass / cnt / total);
    lo = hi + 1;
  }
  b = { n, w };
  bucketCache.set(pages, b);
  return b;
}

/** Expected distinct pages touched by `updates` Zipf(1) updates over `pages` pages. */
export function distinctTouched(pages: number, updates: number): number {
  const { n, w } = buckets(pages);
  let s = 0;
  for (let i = 0; i < n.length; i++) s += n[i]! * -Math.expm1(-updates * w[i]!);
  return s;
}

export function simulateCheckpoints(params: CkptParams): CkptResult {
  const p = { ...CKPT_DEFAULTS, ...params };
  const T = p.horizonSec, U = p.updatesPerSec;
  const D = (sec: number) => distinctTouched(p.pages, U * Math.max(0, sec));
  const writes = new Array<number>(T).fill(0);
  const wal = new Array<number>(T).fill(0);
  const fpi = new Array<number>(T).fill(0);
  const walPos = new Array<number>(T + 1).fill(0);
  const checkpoints: Checkpoint[] = [];
  const sizeTrigger = (p.maxWalMiB * 1024 * 1024) / (1 + p.completion);

  let ckStart = 0; // start of the current FPI epoch (last checkpoint start)
  let lastStart = 0;
  let lastStartWal = 0;
  let dirtySince = 0; // pages dirty = pages touched since this time (the last checkpoint start)
  let writing: { left: number; rate: number; ck: Checkpoint } | null = null;
  for (let t = 0; t < T; t++) {
    // start a checkpoint?
    const byTime = t - lastStart >= p.timeoutSec;
    const bySize = walPos[t]! - lastStartWal >= sizeTrigger;
    if (t > 0 && !writing && (byTime || bySize)) {
      const pages = D(t - dirtySince);
      const spread = Math.max(1, p.completion * p.timeoutSec);
      const rate = Math.min(p.maxWritePagesPerSec, pages / spread);
      const ck: Checkpoint = { start: t, end: t, pages, redoWal: walPos[t]!, trigger: byTime ? "time" : "size" };
      checkpoints.push(ck);
      writing = { left: pages, rate, ck };
      lastStart = t;
      lastStartWal = walPos[t]!;
      ckStart = t;
      dirtySince = t;
    }
    // WAL this second
    const f = D(t + 1 - ckStart) - D(t - ckStart);
    fpi[t] = f;
    wal[t] = U * p.recordBytes + f * PAGE_BYTES;
    walPos[t + 1] = walPos[t]! + wal[t]!;
    // checkpoint writes this second
    if (writing) {
      const w = Math.min(writing.left, writing.rate);
      writes[t] = w;
      writing.left -= w;
      if (writing.left <= 1e-9) {
        writing.ck.end = t + 1;
        writing = null;
      }
    }
  }
  if (writing) writing.ck.end = Infinity;
  // recovery time if the crash is at the end of second t
  const recovery = new Array<number>(T).fill(0);
  for (let t = 0; t < T; t++) {
    let redo = 0;
    for (const ck of checkpoints) if (ck.end <= t + 1) redo = ck.redoWal;
    recovery[t] = (walPos[t + 1]! - redo) / p.replayBytesPerSec;
  }
  const totalPageWrites = writes.reduce((a, b) => a + b, 0);
  return {
    writes, wal, fpi, walPos, recovery, checkpoints,
    totalPageWrites,
    totalWalBytes: walPos[T]!,
    totalFpi: fpi.reduce((a, b) => a + b, 0),
    peakWritePagesPerSec: Math.max(...writes),
    maxRecoverySec: Math.max(...recovery),
  };
}

/** PostgreSQL defaults (since version 14 for checkpoint_completion_target). */
export const PG_DEFAULTS = { timeoutSec: 300, completion: 0.9, maxWalMiB: 1024 };
