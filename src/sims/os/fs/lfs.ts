/**
 * A log-structured file system at block level (Rosenblum and Ousterhout, 1992). All writes go to the head of a log made
 * of fixed-size segments. An overwrite only makes the old copy dead. `where` plays the part of the inode map: it says
 * where the newest copy of each block lives. The cleaner picks segments, copies their live blocks to the head of the
 * log and frees them.
 *
 * Write cost follows the paper: (segment blocks read + live blocks written + new blocks written) / new blocks.
 * A segment with no live blocks costs nothing, because the cleaner need not read it.
 */
import { mulberry32 } from "../../rng";

export type CleanPolicy = "greedy" | "cost-benefit";
export type LfsWorkload = "uniform" | "hotcold";

export const POLICY_NAME: Record<CleanPolicy, string> = { greedy: "Greedy", "cost-benefit": "Cost-benefit" };

export interface LfsOpts {
  segments: number;
  blocksPerSegment: number;
  /** Number of logical blocks. */
  logical: number;
  policy: CleanPolicy;
  /** The cleaner runs when fewer segments than this are free. */
  lowWater: number;
  /** It stops when this many are free. */
  highWater: number;
  /** Sort live blocks by age when the cleaner rewrites them, so cold blocks group together. */
  ageSort: boolean;
}

export interface LfsStats { newBlocks: number; copied: number; segRead: number; blocksRead: number; cleaned: number; emptyCleaned: number; cleanedUtilSum: number }

export class Lfs {
  /** slots[seg * bps + slot] = logical block number, or -1. It plays the part of the segment summary. */
  readonly slots: Int32Array;
  /** The address of the newest copy of each logical block, or -1. It plays the part of the inode map. */
  readonly where: Int32Array;
  /** The time of the last user write of each logical block. */
  readonly writeTime: Float64Array;
  /** A value per logical block, so tests can check that the cleaner loses nothing. */
  readonly value: Int32Array;
  /** Live blocks per segment. */
  readonly live: Int32Array;
  /** The newest write time in each segment. */
  readonly lastMod: Float64Array;
  readonly isFree: Uint8Array;
  head = 0;
  headSlot = 0;
  clock = 0;
  freeCount: number;
  stats: LfsStats = { newBlocks: 0, copied: 0, segRead: 0, blocksRead: 0, cleaned: 0, emptyCleaned: 0, cleanedUtilSum: 0 };
  /** The segments that the last cleaning pass chose. */
  lastCleaned: number[] = [];
  private inClean = false;

  constructor(readonly o: LfsOpts) {
    const n = o.segments * o.blocksPerSegment;
    if (o.logical + o.blocksPerSegment * (o.highWater + 1) > n) throw new Error("too little spare space for the cleaner");
    this.slots = new Int32Array(n).fill(-1);
    this.where = new Int32Array(o.logical).fill(-1);
    this.writeTime = new Float64Array(o.logical);
    this.value = new Int32Array(o.logical);
    this.live = new Int32Array(o.segments);
    this.lastMod = new Float64Array(o.segments);
    this.isFree = new Uint8Array(o.segments).fill(1);
    this.isFree[0] = 0;
    this.freeCount = o.segments - 1;
  }

  /** The log head moved past the end of a segment. Take the next free one. */
  private nextSegment() {
    const { segments } = this.o;
    for (let i = 1; i <= segments; i++) {
      const s = (this.head + i) % segments;
      if (this.isFree[s]) {
        this.isFree[s] = 0;
        this.freeCount--;
        this.head = s;
        this.headSlot = 0;
        return;
      }
    }
    throw new Error("the log is out of free segments");
  }

  private append(l: number, time: number) {
    const bps = this.o.blocksPerSegment;
    if (this.headSlot === bps) this.nextSegment();
    const addr = this.head * bps + this.headSlot;
    const old = this.where[l]!;
    if (old >= 0) {
      this.slots[old] = -1;
      this.live[Math.floor(old / bps)]!--;
    }
    this.slots[addr] = l;
    this.where[l] = addr;
    this.live[this.head]!++;
    this.lastMod[this.head] = Math.max(this.lastMod[this.head]!, time);
    this.headSlot++;
  }

  /** One user write. */
  write(l: number, value = 0) {
    this.clock++;
    this.writeTime[l] = this.clock;
    this.value[l] = value;
    this.append(l, this.clock);
    this.stats.newBlocks++;
    if (!this.inClean && this.freeCount < this.o.lowWater) this.clean();
  }

  read(l: number) { return this.where[l]! >= 0 ? this.value[l]! : undefined; }

  /** Picks the next segment to clean, or -1. */
  pickVictim(): number {
    const { segments, blocksPerSegment: bps, policy } = this.o;
    let best = -1, score = -Infinity;
    for (let s = 0; s < segments; s++) {
      if (this.isFree[s] || s === this.head) continue;
      const u = this.live[s]! / bps;
      const v = policy === "greedy" ? -u : u === 0 ? Infinity : ((1 - u) * (this.clock - this.lastMod[s]!)) / (1 + u);
      if (v > score) { score = v; best = s; }
    }
    return best;
  }

  /** Cleans until highWater segments are free. */
  clean() {
    const { blocksPerSegment: bps, highWater, ageSort, segments } = this.o;
    this.inClean = true;
    this.lastCleaned = [];
    let guard = segments * 4;
    while (this.freeCount < highWater && guard-- > 0) {
      const batch: number[] = [];
      const liveBlocks: number[] = [];
      const room = (this.freeCount) * bps + (bps - this.headSlot);
      // Take victims while the copies still fit in the free space.
      while (batch.length < 8) {
        const v = this.pickVictimExcept(batch);
        if (v < 0) break;
        const add = this.live[v]!;
        if (liveBlocks.length + add > room) break;
        batch.push(v);
        for (let i = 0; i < bps; i++) {
          const l = this.slots[v * bps + i]!;
          if (l >= 0) liveBlocks.push(l);
        }
        if (this.freeCount + batch.length >= highWater + Math.ceil(liveBlocks.length / bps)) break;
      }
      if (!batch.length) break;
      if (ageSort) liveBlocks.sort((a, b) => this.writeTime[a]! - this.writeTime[b]!);
      for (const s of batch) {
        const u = this.live[s]! / bps;
        this.stats.cleaned++;
        this.stats.cleanedUtilSum += u;
        if (u === 0) this.stats.emptyCleaned++;
        else { this.stats.segRead++; this.stats.blocksRead += bps; }
        this.lastCleaned.push(s);
      }
      for (const l of liveBlocks) {
        this.append(l, this.writeTime[l]!);
        this.stats.copied++;
      }
      for (const s of batch) {
        if (this.live[s] !== 0 || s === this.head) continue;
        this.isFree[s] = 1;
        this.freeCount++;
        this.lastMod[s] = 0;
        this.slots.fill(-1, s * bps, (s + 1) * bps);
      }
    }
    this.inClean = false;
  }

  private pickVictimExcept(skip: number[]): number {
    const saved = skip.map((s) => this.isFree[s]!);
    for (const s of skip) this.isFree[s] = 1;
    const v = this.pickVictim();
    skip.forEach((s, i) => { this.isFree[s] = saved[i]!; });
    return v;
  }

  /** Write cost by the paper's formula, since the counters were last reset. */
  writeCost(): number {
    const s = this.stats;
    return s.newBlocks ? (s.blocksRead + s.copied + s.newBlocks) / s.newBlocks : 1;
  }
  /** Device writes per user write. This is what matters on flash, where a read is cheap. */
  writeAmp(): number {
    const s = this.stats;
    return s.newBlocks ? (s.copied + s.newBlocks) / s.newBlocks : 1;
  }
  resetStats() { this.stats = { newBlocks: 0, copied: 0, segRead: 0, blocksRead: 0, cleaned: 0, emptyCleaned: 0, cleanedUtilSum: 0 }; }

  /** Returns each broken rule. */
  check(): string[] {
    const bad: string[] = [];
    const { blocksPerSegment: bps, segments, logical } = this.o;
    const counts = new Int32Array(segments);
    for (let l = 0; l < logical; l++) {
      const a = this.where[l]!;
      if (a < 0) continue;
      if (this.slots[a] !== l) bad.push(`block ${l}: map says ${a}, the slot holds ${this.slots[a]}`);
      counts[Math.floor(a / bps)]!++;
    }
    let fr = 0;
    for (let s = 0; s < segments; s++) {
      if (counts[s] !== this.live[s]) bad.push(`segment ${s}: live ${this.live[s]}, counted ${counts[s]}`);
      if (this.isFree[s]) { fr++; if (counts[s]) bad.push(`free segment ${s} holds live blocks`); }
    }
    if (fr !== this.freeCount) bad.push(`free ${this.freeCount}, counted ${fr}`);
    return bad;
  }
}

/** The formula of the paper: a segment at utilization u costs 2 / (1 - u). Below that, u = 0 costs 1. */
export const writeCostFormula = (u: number) => (u <= 0 ? 1 : 2 / (1 - u));
/** The same for flash, where a read is free: live copies plus new data. */
export const writeAmpFormula = (u: number) => 1 / (1 - u);
/** Cleaned-segment utilization at which the log costs as much as a file system with write cost c. */
export const breakEvenUtil = (c: number) => 1 - 2 / c;
/** The paper's estimates for FFS: 10 for today's Unix, 4 with logging, delayed writes and sorted requests. */
export const FFS_WRITE_COST = { today: 10, improved: 4 };

export const LFS_GEOMETRY = { segments: 128, blocksPerSegment: 128, lowWater: 4, highWater: 8 };

export interface StreamOpts { logical: number; workload: LfsWorkload; hotFraction?: number; hotWrites?: number; seed: number }
export const HOT_COLD = { hotFraction: 0.1, hotWrites: 0.9 };

export function lfsStream(o: StreamOpts) {
  const rng = mulberry32(o.seed);
  const hot = Math.max(1, Math.floor(o.logical * (o.hotFraction ?? HOT_COLD.hotFraction)));
  const hw = o.hotWrites ?? HOT_COLD.hotWrites;
  return () => {
    if (o.workload === "uniform") return Math.floor(rng() * o.logical);
    return rng() < hw ? Math.floor(rng() * hot) : hot + Math.floor(rng() * (o.logical - hot));
  };
}

export interface LfsRunOpts { util: number; workload: LfsWorkload; policy: CleanPolicy; seed?: number; warmPasses?: number; measurePasses?: number; segments?: number; blocksPerSegment?: number }

/** A steady-state run. First it fills the disk and overwrites it, then it measures. */
export function runLfs(o: LfsRunOpts) {
  const segments = o.segments ?? LFS_GEOMETRY.segments;
  const bps = o.blocksPerSegment ?? LFS_GEOMETRY.blocksPerSegment;
  const logical = Math.floor(o.util * segments * bps);
  const fs = new Lfs({ segments, blocksPerSegment: bps, logical, policy: o.policy, lowWater: LFS_GEOMETRY.lowWater, highWater: LFS_GEOMETRY.highWater, ageSort: true });
  for (let l = 0; l < logical; l++) fs.write(l);
  const next = lfsStream({ logical, workload: o.workload, seed: o.seed ?? 11 });
  const warm = (o.warmPasses ?? 16) * logical, measure = (o.measurePasses ?? 16) * logical;
  for (let i = 0; i < warm; i++) fs.write(next());
  fs.resetStats();
  for (let i = 0; i < measure; i++) fs.write(next());
  const s = fs.stats;
  return { util: o.util, writeCost: fs.writeCost(), writeAmp: fs.writeAmp(), meanCleanedUtil: s.cleaned ? s.cleanedUtilSum / s.cleaned : 0, emptyShare: s.cleaned ? s.emptyCleaned / s.cleaned : 0 };
}

/** The largest utilization that the geometry allows, with room for the cleaner. */
export const LFS_UTILS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9];

/** F2FS facts that the lesson quotes. A segment is 2 MiB of 4 KiB blocks. */
export const F2FS = { blockBytes: 4096, blocksPerSegment: 512, logs: 6 };
export const f2fsSegmentBytes = () => F2FS.blockBytes * F2FS.blocksPerSegment;
