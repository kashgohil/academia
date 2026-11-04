/**
 * Garbage collection of old versions, and PostgreSQL transaction id wraparound.
 *
 * Bloat model: a table of `rows` live rows gets `updatesPerTick` updates per tick. Each update leaves one dead
 * version. A version that died at time d can be removed only when every snapshot that could still see it is gone:
 * d must be older than the horizon (the start of the oldest running snapshot). Autovacuum wakes every `naptime`
 * ticks and runs when dead versions > threshold + scale × rows (the PostgreSQL trigger rule). VACUUM frees the
 * space for reuse, but the file does not shrink: its size is the high-water mark of live + dead versions.
 */

export interface BloatCfg {
  rows: number;
  updatesPerTick: number;
  ticks: number;
  naptime: number;
  /** autovacuum_vacuum_threshold (default 50). */
  threshold: number;
  /** autovacuum_vacuum_scale_factor (default 0.2). */
  scale: number;
  readerStart: number;
  /** 0 means no long reader. */
  readerLength: number;
  tuplesPerPage: number;
}

export const DEFAULT_BLOAT: BloatCfg = { rows: 1000, updatesPerTick: 20, ticks: 600, naptime: 10, threshold: 50, scale: 0.2, readerStart: 100, readerLength: 300, tuplesPerPage: 50 };

export interface BloatPoint { t: number; live: number; held: number; removable: number; size: number; vacuum: number | null }

export interface BloatResult {
  points: BloatPoint[];
  vacuums: number;
  /** Vacuum runs that removed nothing. */
  uselessVacuums: number;
  peakDead: number;
  /** Final file size in versions (high-water mark) and in pages. */
  size: number;
  pages: number;
}

/** Dead tuples that trigger autovacuum: threshold + scale × rows. */
export const autovacuumTrigger = (rows: number, threshold = 50, scale = 0.2) => threshold + scale * rows;

export function bloatSim(cfgIn: Partial<BloatCfg> = {}): BloatResult {
  const cfg = { ...DEFAULT_BLOAT, ...cfgIn };
  // deadAt[d] = dead versions that died at tick d and are still in the table
  const deadAt = new Float64Array(cfg.ticks + 1);
  let dead = 0, size = cfg.rows, vacuums = 0, useless = 0, peak = 0;
  const points: BloatPoint[] = [];
  const trigger = autovacuumTrigger(cfg.rows, cfg.threshold, cfg.scale);
  for (let t = 0; t <= cfg.ticks; t++) {
    const readerOn = cfg.readerLength > 0 && t >= cfg.readerStart && t < cfg.readerStart + cfg.readerLength;
    const horizon = readerOn ? cfg.readerStart : t;
    if (t > 0) {
      deadAt[t] = cfg.updatesPerTick;
      dead += cfg.updatesPerTick;
    }
    let vac: number | null = null;
    if (t > 0 && t % cfg.naptime === 0 && dead > trigger) {
      let removed = 0;
      for (let d = 0; d < horizon; d++) { removed += deadAt[d]!; deadAt[d] = 0; }
      dead -= removed;
      vacuums++;
      if (removed === 0) useless++;
      vac = removed;
    }
    let held = 0;
    for (let d = horizon; d <= t; d++) held += deadAt[d]!;
    size = Math.max(size, cfg.rows + dead);
    peak = Math.max(peak, dead);
    points.push({ t, live: cfg.rows, held, removable: dead - held, size, vacuum: vac });
  }
  return { points, vacuums, uselessVacuums: useless, peakDead: peak, size, pages: Math.ceil(size / cfg.tuplesPerPage) };
}

// ---------------------------------------------------------------- XID wraparound

export const XID_BITS = 32;
export const XID_SPACE = 2 ** XID_BITS;
/** Half the ring: ids up to this far behind are "in the past", the rest are "in the future". */
export const XID_HALF = 2 ** (XID_BITS - 1);
/** Ids 0, 1 and 2 are special (invalid, bootstrap, frozen); normal ids start at 3. */
export const FIRST_NORMAL_XID = 3;
export const FREEZE_MIN_AGE = 50_000_000;
export const FREEZE_TABLE_AGE = 150_000_000;
export const FREEZE_MAX_AGE = 200_000_000;
export const WARN_REMAINING = 40_000_000;

/** PostgreSQL TransactionIdPrecedes for normal ids: compare the difference as a signed 32-bit integer. */
export function xidPrecedes(a: number, b: number): boolean {
  return ((a - b) | 0) < 0;
}

/** Age of id x when the next id is `current`. */
export const xidAge = (current: number, x: number) => (((current - x) % XID_SPACE) + XID_SPACE) % XID_SPACE;

/** Where an old row stands after `consumed` more transactions: it looks in the past while its age < 2^31. */
export function rowLooksPast(consumed: number, frozen: boolean): boolean {
  if (frozen) return true;
  return consumed % XID_SPACE < XID_HALF;
}

/** Days until the oldest unfrozen id is 2^31 old, at a given number of ids per second. */
export const daysToWraparound = (xidsPerSecond: number, startAge = 0) => (XID_HALF - startAge) / xidsPerSecond / 86_400;

/** Days between anti-wraparound vacuums: autovacuum_freeze_max_age ids at this rate. */
export const daysToForcedVacuum = (xidsPerSecond: number, maxAge = FREEZE_MAX_AGE) => maxAge / xidsPerSecond / 86_400;
