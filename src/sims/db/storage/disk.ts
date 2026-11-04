/**
 * Storage device models for the Storage lessons.
 *
 * - HDD: seek + rotation + transfer, with a closed-loop request queue (FIFO or elevator).
 * - SSD: NAND latencies, parallel units, and a page-mapped flash translation layer (FTL)
 *   with greedy garbage collection, so device write amplification comes out of the simulation.
 *
 * Units: time in milliseconds (HDD) or microseconds (SSD, marked `Us`), sizes in bytes,
 * bandwidth in MB/s with 1 MB = 1e6 bytes. Everything is deterministic for a given seed.
 */
import { mulberry32 } from "../../rng";

// =====================================================================================
// HDD
// =====================================================================================

export interface HddSpec {
  name: string;
  rpm: number;
  /** Track-to-track seek (ms). */
  minSeekMs: number;
  /** Full-stroke seek (ms). */
  maxSeekMs: number;
  /** Media transfer rate (MB/s). */
  mbps: number;
}

/** Model drives. The seek curves give average seeks close to the data sheets of each class. */
export const HDDS = {
  "5400": { name: "5,400 rpm laptop disk", rpm: 5400, minSeekMs: 1, maxSeekMs: 21, mbps: 140 },
  "7200": { name: "7,200 rpm disk", rpm: 7200, minSeekMs: 0.5, maxSeekMs: 16, mbps: 200 },
  "10k": { name: "10,000 rpm disk", rpm: 10000, minSeekMs: 0.3, maxSeekMs: 8, mbps: 220 },
  "15k": { name: "15,000 rpm disk", rpm: 15000, minSeekMs: 0.2, maxSeekMs: 6.3, mbps: 250 },
} satisfies Record<string, HddSpec>;
export type HddId = keyof typeof HDDS;

/** Time for one full turn of the platter (ms). */
export const rotationMs = (s: HddSpec) => 60000 / s.rpm;

/**
 * Seek time for a move of `frac` of the full stroke (0..1).
 * Short seeks are dominated by acceleration, so time grows with the square root of distance.
 */
export function seekMs(s: HddSpec, frac: number): number {
  if (frac <= 1e-12) return 0;
  return s.minSeekMs + (s.maxSeekMs - s.minSeekMs) * Math.sqrt(Math.min(1, frac));
}

/**
 * Average seek between two independent uniform positions.
 * E[sqrt|X - Y|] for X, Y ~ U(0, 1) is 8/15, so avg = min + (max - min) * 8/15.
 */
export const avgSeekMs = (s: HddSpec) => s.minSeekMs + ((s.maxSeekMs - s.minSeekMs) * 8) / 15;

export const transferMs = (s: HddSpec, bytes: number) => (bytes / (s.mbps * 1e6)) * 1e3;

export interface AccessTime {
  seek: number;
  rotate: number;
  transfer: number;
  total: number;
  /** Requests per second at queue depth 1. */
  iops: number;
  /** Useful MB/s. */
  mbps: number;
}

/**
 * Expected time of one request at queue depth 1.
 * Random: average seek + half a turn + transfer. Sequential: the head is already in place.
 */
export function hddAccess(s: HddSpec, bytes: number, pattern: "random" | "sequential"): AccessTime {
  const seek = pattern === "random" ? avgSeekMs(s) : 0;
  const rotate = pattern === "random" ? rotationMs(s) / 2 : 0;
  const transfer = transferMs(s, bytes);
  const total = seek + rotate + transfer;
  return { seek, rotate, transfer, total, iops: 1000 / total, mbps: bytes / 1e6 / (total / 1000) };
}

export interface HddRequest {
  id: number;
  /** Radial position, 0 = outer edge, 1 = inner edge. */
  cyl: number;
  /** Angular position of the first sector, in turns (0..1). */
  angle: number;
  bytes: number;
}

export interface HddServed {
  req: HddRequest;
  fromCyl: number;
  start: number;
  seek: number;
  rotate: number;
  transfer: number;
  end: number;
  /** Requests waiting in the queue when this one was picked (including itself). */
  queued: number;
}

export type HddPattern = "random" | "sequential" | "nearby";
export type HddSched = "fifo" | "elevator";

export interface HddRunOpts {
  n: number;
  qd: number;
  sched: HddSched;
  pattern: HddPattern;
  bytes: number;
  seed?: number;
}

export interface HddRun {
  served: HddServed[];
  totalMs: number;
  iops: number;
  mbps: number;
  avg: { seek: number; rotate: number; transfer: number };
}

/**
 * Closed-loop disk simulation: `qd` requests are always outstanding. When one completes, a new one arrives.
 * The platter angle at time t is (t / rotation) mod 1. After the seek, the head waits until the target
 * sector comes under it, then reads `bytes` while the platter keeps turning.
 * - random: uniform position and angle.
 * - sequential: each request starts where the previous one ended (no seek, no rotational wait).
 * - nearby: uniform within 2% of the stroke around a slowly moving center (a "hot" region).
 * - elevator (LOOK): pick the nearest request in the current direction; reverse at the last one.
 */
export function hddRun(s: HddSpec, o: HddRunOpts): HddRun {
  const rng = mulberry32(o.seed ?? 1);
  const rot = rotationMs(s);
  const trTurns = transferMs(s, o.bytes) / rot;
  let nextId = 0;
  let seqCyl = 0.3, seqAngle = 0;
  const gen = (): HddRequest => {
    const id = nextId++;
    if (o.pattern === "sequential") {
      const r = { id, cyl: seqCyl, angle: seqAngle, bytes: o.bytes };
      seqAngle = (seqAngle + trTurns) % 1;
      return r;
    }
    if (o.pattern === "nearby") {
      const c = 0.5 + 0.02 * (rng() - 0.5);
      return { id, cyl: c, angle: rng(), bytes: o.bytes };
    }
    return { id, cyl: rng(), angle: rng(), bytes: o.bytes };
  };
  const queue: HddRequest[] = [];
  for (let i = 0; i < o.qd; i++) queue.push(gen());
  let t = 0, head = 0.3, dir = 1;
  const served: HddServed[] = [];
  for (let k = 0; k < o.n; k++) {
    let pick = 0;
    if (o.sched === "elevator" && queue.length > 1) {
      const pickIn = (d: number) => {
        let best = -1, bd = Infinity;
        queue.forEach((r, i) => {
          const dist = (r.cyl - head) * d;
          if (dist >= 0 && dist < bd) { bd = dist; best = i; }
        });
        return best;
      };
      pick = pickIn(dir);
      if (pick < 0) { dir = -dir; pick = pickIn(dir); }
    }
    const queued = queue.length;
    const req = queue.splice(pick, 1)[0]!;
    const seek = seekMs(s, Math.abs(req.cyl - head));
    const at = (t + seek) / rot;
    let wait = (((req.angle - at) % 1) + 1) % 1;
    if (wait > 1 - 1e-9) wait = 0; // floating error on sequential requests
    const rotate = wait * rot;
    const transfer = trTurns * rot;
    served.push({ req, fromCyl: head, start: t, seek, rotate, transfer, end: t + seek + rotate + transfer, queued });
    t += seek + rotate + transfer;
    head = req.cyl;
    queue.push(gen());
  }
  const sum = (f: (x: HddServed) => number) => served.reduce((a, x) => a + f(x), 0) / served.length;
  return {
    served,
    totalMs: t,
    iops: (o.n / t) * 1000,
    mbps: (o.n * o.bytes) / 1e6 / (t / 1000),
    avg: { seek: sum((x) => x.seek), rotate: sum((x) => x.rotate), transfer: sum((x) => x.transfer) },
  };
}

// =====================================================================================
// SSD: latency and parallelism
// =====================================================================================

export interface SsdSpec {
  name: string;
  /** NAND page read (tR), µs. */
  readUs: number;
  /** NAND page program (tPROG), µs. */
  progUs: number;
  /** NAND block erase (tBERS), µs. */
  eraseUs: number;
  /** Controller, firmware and protocol time per command, µs. */
  overheadUs: number;
  /** Independent NAND units (channels × dies). */
  units: number;
  /** Host interface bandwidth, MB/s. */
  mbps: number;
  /** NAND page size, bytes. */
  pageBytes: number;
}

/** A model TLC NVMe drive (PCIe 3.0 x4 class). The NAND timings are typical for TLC. */
export const SSD_NVME: SsdSpec = { name: "NVMe TLC SSD", readUs: 60, progUs: 600, eraseUs: 3000, overheadUs: 20, units: 32, mbps: 3200, pageBytes: 16384 };
/** The same NAND behind SATA/AHCI: more protocol time, 32 commands, 550 MB/s. */
export const SSD_SATA: SsdSpec = { ...SSD_NVME, name: "SATA TLC SSD", overheadUs: 40, mbps: 550 };

/** Expected number of busy units when q requests go to random units (balls into bins). */
export const busyUnits = (units: number, q: number) => units * (1 - Math.pow(1 - 1 / units, q));

/** Latency of one random read of `bytes` at queue depth 1 (µs). Large reads stripe over the units. */
export function ssdReadUs(s: SsdSpec, bytes: number): number {
  const pages = Math.max(1, Math.ceil(bytes / s.pageBytes));
  const rounds = Math.ceil(pages / s.units);
  return s.overheadUs + rounds * s.readUs + (bytes / (s.mbps * 1e6)) * 1e6;
}

/** Random-read throughput at queue depth `qd`: parallel units, capped by the host interface. */
export function ssdRead(s: SsdSpec, bytes: number, qd: number): { iops: number; mbps: number; latUs: number } {
  const lat = ssdReadUs(s, bytes);
  const pages = Math.max(1, Math.ceil(bytes / s.pageBytes));
  const perReqUnits = Math.min(s.units, pages);
  const parallel = Math.max(1, busyUnits(s.units, qd * perReqUnits) / perReqUnits);
  let iops = (Math.min(qd, parallel) / lat) * 1e6;
  iops = Math.min(iops, (s.mbps * 1e6) / bytes);
  return { iops, mbps: (iops * bytes) / 1e6, latUs: lat };
}

/** Random reads per second of an HDD at queue depth `qd`, with the elevator (simulated, 4000 requests). */
export function hddIopsAtQd(s: HddSpec, qd: number, sched: HddSched = "elevator", bytes = 4096): number {
  return hddRun(s, { n: 4000, qd, sched, pattern: "random", bytes, seed: 7 }).iops;
}

// =====================================================================================
// SSD: flash translation layer
// =====================================================================================

export const PAGE_FREE = 0, PAGE_VALID = 1, PAGE_INVALID = 2;

export interface FtlOpts {
  blocks: number;
  pagesPerBlock: number;
  /** Over-provisioning as vendors quote it: spare pages / host-visible pages (0.07 = 7%). */
  op: number;
  /** Victim selection for garbage collection. */
  gc?: "greedy" | "fifo";
}

export interface FtlEvent {
  kind: "host" | "gc-copy" | "erase";
  lpn: number;
  /** Physical page written (host, gc-copy) or block erased. */
  at: number;
  /** Old physical page made invalid (host writes only), or -1. */
  old: number;
}

/**
 * A page-mapped FTL. Writes go out of place to the next free page of the active block, and the old
 * physical page becomes invalid. When free blocks run low, garbage collection picks a victim block,
 * copies its valid pages to the active block, and erases it.
 *
 * Device write amplification = NAND page writes / host page writes.
 */
export class Ftl {
  readonly blocks: number;
  readonly ppb: number;
  readonly logical: number;
  readonly gcPolicy: "greedy" | "fifo";
  /** Logical page → physical page, or -1. */
  readonly map: Int32Array;
  /** Physical page → logical page, or -1. */
  readonly owner: Int32Array;
  /** Physical page state: PAGE_FREE, PAGE_VALID or PAGE_INVALID. */
  readonly state: Uint8Array;
  readonly valid: Int32Array;
  readonly eraseCount: Int32Array;
  readonly free: number[] = [];
  /** Blocks in the order they were filled (for FIFO victim selection). */
  private filled: number[] = [];
  active = 0;
  /** Next free page index inside the active block. */
  cursor = 0;
  hostWrites = 0;
  nandWrites = 0;
  erases = 0;
  events: FtlEvent[] = [];
  recordEvents = false;

  constructor(o: FtlOpts) {
    this.blocks = o.blocks;
    this.ppb = o.pagesPerBlock;
    this.gcPolicy = o.gc ?? "greedy";
    const phys = o.blocks * o.pagesPerBlock;
    // Keep at least 3 blocks of slack so garbage collection always finds a block with an invalid page.
    this.logical = Math.min(Math.floor(phys / (1 + o.op)), (o.blocks - 3) * o.pagesPerBlock);
    this.map = new Int32Array(this.logical).fill(-1);
    this.owner = new Int32Array(phys).fill(-1);
    this.state = new Uint8Array(phys);
    this.valid = new Int32Array(o.blocks);
    this.eraseCount = new Int32Array(o.blocks);
    for (let b = o.blocks - 1; b >= 1; b--) this.free.push(b);
    this.active = 0;
  }

  get physical() { return this.blocks * this.ppb; }
  /** The real over-provisioning (spare / logical capacity), as vendors quote it. */
  get spareRatio() { return (this.physical - this.logical) / this.logical; }
  get wa() { return this.hostWrites ? this.nandWrites / this.hostWrites : 1; }

  private append(lpn: number, kind: "host" | "gc-copy") {
    if (this.cursor >= this.ppb) {
      this.filled.push(this.active);
      const b = this.free.pop();
      if (b === undefined) throw new Error("FTL: no free block");
      this.active = b;
      this.cursor = 0;
    }
    const p = this.active * this.ppb + this.cursor++;
    const old = this.map[lpn]!;
    if (old >= 0) {
      this.state[old] = PAGE_INVALID;
      this.owner[old] = -1;
      this.valid[Math.floor(old / this.ppb)]!--;
    }
    this.map[lpn] = p;
    this.owner[p] = lpn;
    this.state[p] = PAGE_VALID;
    this.valid[this.active]!++;
    this.nandWrites++;
    if (this.recordEvents) this.events.push({ kind, lpn, at: p, old: kind === "host" ? old : -1 });
  }

  private pickVictim(): number {
    if (this.gcPolicy === "fifo") {
      const i = this.filled.findIndex((b) => this.valid[b]! < this.ppb);
      return i < 0 ? -1 : this.filled.splice(i, 1)[0]!;
    }
    let best = -1, bv = Infinity;
    for (const b of this.filled) if (this.valid[b]! < bv) { bv = this.valid[b]!; best = b; }
    if (best >= 0) this.filled.splice(this.filled.indexOf(best), 1);
    return best;
  }

  /** Runs one garbage collection: copy the victim's valid pages, then erase it. Returns the victim. */
  gc(): number {
    const v = this.pickVictim();
    if (v < 0) throw new Error("FTL: no victim");
    for (let i = 0; i < this.ppb; i++) {
      const p = v * this.ppb + i;
      if (this.state[p] === PAGE_VALID) this.append(this.owner[p]!, "gc-copy");
    }
    for (let i = 0; i < this.ppb; i++) { this.state[v * this.ppb + i] = PAGE_FREE; this.owner[v * this.ppb + i] = -1; }
    this.valid[v] = 0;
    this.eraseCount[v]!++;
    this.erases++;
    this.free.unshift(v);
    if (this.recordEvents) this.events.push({ kind: "erase", lpn: -1, at: v, old: -1 });
    return v;
  }

  /** The host writes logical page `lpn`. */
  write(lpn: number) {
    while (this.free.length < 2) this.gc();
    this.hostWrites++;
    this.append(lpn, "host");
  }

  /** Resets the write counters (for example after preconditioning), keeping the mapping. */
  resetCounters() { this.hostWrites = 0; this.nandWrites = 0; this.erases = 0; }
}

export type FtlWorkload = "random" | "sequential" | "hotcold";

/** A logical page stream: uniform random, sequential overwrite, or 80% of writes to 20% of the pages. */
export function ftlStream(workload: FtlWorkload, logical: number, seed = 1) {
  const rng = mulberry32(seed);
  let i = 0;
  return () => {
    if (workload === "sequential") return i++ % logical;
    if (workload === "hotcold") {
      const hot = Math.max(1, Math.floor(logical * 0.2));
      return rng() < 0.8 ? Math.floor(rng() * hot) : hot + Math.floor(rng() * (logical - hot));
    }
    return Math.floor(rng() * logical);
  };
}

/**
 * Steady-state device write amplification: fill the drive once sequentially, overwrite it `warm` times,
 * reset the counters, then measure over `measure` drive writes.
 */
export function steadyWa(op: number, workload: FtlWorkload, o: { blocks?: number; ppb?: number; warm?: number; measure?: number; seed?: number; gc?: "greedy" | "fifo" } = {}): number {
  const f = new Ftl({ blocks: o.blocks ?? 256, pagesPerBlock: o.ppb ?? 32, op, gc: o.gc });
  for (let l = 0; l < f.logical; l++) f.write(l);
  const next = ftlStream(workload, f.logical, o.seed ?? 3);
  const warm = (o.warm ?? 3) * f.logical, measure = (o.measure ?? 6) * f.logical;
  for (let k = 0; k < warm; k++) f.write(next());
  f.resetCounters();
  for (let k = 0; k < measure; k++) f.write(next());
  return f.wa;
}
