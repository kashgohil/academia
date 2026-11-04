/**
 * A small but complete LSM tree, in memory, for lessons and for the capstone engine.
 *
 * Write path: append to the WAL, insert into the memtable (a skip list in internal-key order).
 * A full memtable becomes immutable; a flush writes it to a new sorted run (an SSTable).
 * Read path: memtable → immutable memtables (newest first) → each level, each run newest first.
 *
 * Two compaction strategies (RocksDB names in brackets):
 * - "leveled" [kCompactionStyleLevel]: L0 holds overlapping flush files. Each level Li ≥ 1 is one
 *   sorted run with a byte budget base·T^(i−1) [max_bytes_for_level_base, max_bytes_for_level_multiplier].
 *   L0 → L1 starts at l0Trigger files [level0_file_num_compaction_trigger]. Li → Li+1 moves one file
 *   (round robin, as LevelDB) and rewrites the overlapping files of Li+1.
 * - "tiered" [like kCompactionStyleUniversal / Cassandra size-tiered]: each level collects up to T
 *   runs; when it has T runs, they merge into one run in the next level.
 *
 * Every byte written by flushes and compactions is counted, so write amplification is measured,
 * not assumed. The engine also keeps a key → size map of live data for space-amplification stats
 * only; reads never use it.
 */
import { SkipList } from "./skiplist";
import { SSTable, collectGarbage, compareEntries, entryBytes, mergeSorted, type Entry, type SstResult, type TableOptions } from "./sstable";

export type Strategy = "leveled" | "tiered";

export interface LsmOptions {
  strategy: Strategy;
  /** write_buffer_size: a memtable becomes immutable when it reaches this many bytes. */
  memtableBytes: number;
  /** Size ratio T: max_bytes_for_level_multiplier (leveled) or runs per level (tiered). */
  sizeRatio: number;
  /** level0_file_num_compaction_trigger (leveled). */
  l0Trigger: number;
  /** max_bytes_for_level_base: the byte budget of L1 (leveled). */
  baseLevelBytes: number;
  /** target_file_size_base: compaction output is cut into files of about this size. */
  targetFileBytes: number;
  /** block_size. */
  blockBytes: number;
  /** Bloom bits per key; 0 = no filters. */
  bloomBitsPerKey: number;
  /** num_levels. */
  maxLevels: number;
  /** Flush at once when a memtable fills (false: call flush() yourself). */
  autoFlush: boolean;
  /** Run compactions after each flush (false: call compactOnce() yourself). */
  autoCompact: boolean;
  /** Immutable memtables that may wait for a flush before a put forces one (max_write_buffer_number − 1). */
  maxImmutable: number;
}

export const DEFAULT_OPTIONS: LsmOptions = {
  strategy: "leveled",
  memtableBytes: 4096,
  sizeRatio: 10,
  l0Trigger: 4,
  baseLevelBytes: 16384,
  targetFileBytes: 4096,
  blockBytes: 512,
  bloomBitsPerKey: 10,
  maxLevels: 7,
  autoFlush: true,
  autoCompact: true,
  maxImmutable: 1,
};

/** A sorted run: files with disjoint key ranges, sorted by key. */
export interface Run { id: number; files: SSTable[] }
/** A level: runs newest first. Leveled: L0 has one file per run, Li ≥ 1 has at most one run. */
export interface Level { runs: Run[] }

export interface Memtable { id: number; list: SkipList<Entry, true>; bytes: number; entries: number; walSegment: number }

export interface WalRecord { segment: number; entry: Entry }

export type ProbeResult = SstResult | "no-file";
export interface Probe {
  source: "memtable" | "immutable" | "sst";
  /** Level number for SSTs; −1 for memtables. */
  level: number;
  /** Run index inside the level (0 = newest), or memtable index. */
  run: number;
  fileId?: number;
  result: ProbeResult;
  blocksRead: number;
  falsePositive?: boolean;
}

export interface GetResult { value: string | undefined; probes: Probe[]; ios: number; entry?: Entry }

export interface CompactionEvent {
  kind: "flush" | "compaction" | "move";
  fromLevel: number;
  toLevel: number;
  inputs: number[];
  outputs: number[];
  bytesRead: number;
  bytesWritten: number;
  droppedVersions: number;
  droppedTombstones: number;
}

export interface LsmStats {
  /** Bytes the user wrote (put and delete entries). */
  userBytes: number;
  /** Bytes appended to the WAL (entry + 7-byte record header, as in LevelDB's log format). */
  walBytes: number;
  flushBytes: number;
  compactReadBytes: number;
  compactWriteBytes: number;
  /** Bytes written into each level (flush output counts for L0). */
  levelWriteBytes: number[];
  flushes: number;
  compactions: number;
  trivialMoves: number;
  droppedVersions: number;
  droppedTombstones: number;
  gets: number;
  getIos: number;
}

/** LevelDB log record header: 4-byte checksum + 2-byte length + 1-byte type. */
export const WAL_RECORD_HEADER = 7;

const fresh = (levels: number): LsmStats => ({
  userBytes: 0, walBytes: 0, flushBytes: 0, compactReadBytes: 0, compactWriteBytes: 0,
  levelWriteBytes: new Array(levels).fill(0), flushes: 0, compactions: 0, trivialMoves: 0,
  droppedVersions: 0, droppedTombstones: 0, gets: 0, getIos: 0,
});

export class LsmTree {
  readonly opts: LsmOptions;
  seq = 0;
  mem: Memtable;
  /** Immutable memtables, newest first. */
  imm: Memtable[] = [];
  levels: Level[];
  wal: WalRecord[] = [];
  stats: LsmStats;
  /** Recent flushes and compactions, newest last (at most 64). */
  events: CompactionEvent[] = [];
  private snapshots = new Map<number, number>(); // seq → count
  private live = new Map<string, number>();
  private liveTotal = 0;
  private nextMem = 1;
  private nextRun = 1;
  private nextFile = 1;
  private compactPointer: string[] = [];
  private tableOpts: TableOptions;

  constructor(opts: Partial<LsmOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.levels = Array.from({ length: this.opts.maxLevels }, () => ({ runs: [] }));
    this.stats = fresh(this.opts.maxLevels);
    this.tableOpts = { blockBytes: this.opts.blockBytes, bloomBitsPerKey: this.opts.bloomBitsPerKey };
    this.mem = this.newMemtable();
  }

  private newMemtable(): Memtable {
    const id = this.nextMem++;
    return { id, list: new SkipList<Entry, true>(compareEntries, { seed: id * 7919 }), bytes: 0, entries: 0, walSegment: id };
  }

  // ---------------- write path ----------------

  put(key: string, value: string) { return this.write({ key, value, kind: "put", seq: 0 }); }
  del(key: string) { return this.write({ key, value: "", kind: "del", seq: 0 }); }

  private write(e: Entry): Entry {
    e.seq = ++this.seq;
    const b = entryBytes(e);
    this.wal.push({ segment: this.mem.walSegment, entry: e });
    this.stats.walBytes += b + WAL_RECORD_HEADER;
    this.stats.userBytes += b;
    this.applyToMemtable(e);
    return e;
  }

  private applyToMemtable(e: Entry) {
    const b = entryBytes(e);
    this.mem.list.insert(e, true);
    this.mem.bytes += b;
    this.mem.entries++;
    const old = this.live.get(e.key);
    if (old !== undefined) this.liveTotal -= old;
    if (e.kind === "put") { this.live.set(e.key, b); this.liveTotal += b; } else this.live.delete(e.key);
    if (this.mem.bytes >= this.opts.memtableBytes) {
      this.rotate();
      if (this.opts.autoFlush) this.flush();
      else if (this.imm.length > this.opts.maxImmutable) this.flushOldest(); // write stall: wait for a flush
    }
  }

  /**
   * Crash recovery: replays WAL records (for example from `walAfterCrash()`) into the memtable.
   * Records keep their sequence numbers.
   */
  replay(records: readonly WalRecord[]) {
    for (const r of records) {
      const e = { ...r.entry };
      this.seq = Math.max(this.seq, e.seq);
      this.wal.push({ segment: this.mem.walSegment, entry: e });
      this.applyToMemtable(e);
    }
  }

  /** The WAL records that a restart must replay: those of memtables not yet flushed. */
  walAfterCrash(): WalRecord[] { return this.wal.map((r) => ({ segment: r.segment, entry: { ...r.entry } })); }

  /** Makes the active memtable immutable and opens a new one with a new WAL segment. */
  rotate(): boolean {
    if (this.mem.entries === 0) return false;
    this.imm.unshift(this.mem);
    this.mem = this.newMemtable();
    return true;
  }

  /** Writes the oldest immutable memtable to a new SSTable (one new run in level 0). */
  flushOldest(): CompactionEvent | null {
    const m = this.imm.pop();
    if (!m) return null;
    const sorted = [...m.list.entries()].map(([e]) => e);
    const { out, droppedVersions } = collectGarbage(sorted, this.smallestSnapshot(), () => false);
    this.wal = this.wal.filter((r) => r.segment !== m.walSegment); // the WAL segment is no longer needed
    if (!out.length) return null;
    const t = new SSTable(out, this.tableOpts, this.nextFile++);
    this.levels[0]!.runs.unshift({ id: this.nextRun++, files: [t] });
    this.stats.flushBytes += t.bytes;
    this.stats.levelWriteBytes[0]! += t.bytes;
    this.stats.flushes++;
    this.stats.droppedVersions += droppedVersions;
    const ev: CompactionEvent = { kind: "flush", fromLevel: -1, toLevel: 0, inputs: [m.id], outputs: [t.id], bytesRead: 0, bytesWritten: t.bytes, droppedVersions, droppedTombstones: 0 };
    this.log(ev);
    if (this.opts.autoCompact) this.compactAll();
    return ev;
  }

  /** Rotates the memtable and flushes every immutable memtable. */
  flush(): CompactionEvent[] {
    this.rotate();
    const out: CompactionEvent[] = [];
    while (this.imm.length) { const e = this.flushOldest(); if (e) out.push(e); }
    return out;
  }

  private log(e: CompactionEvent) {
    this.events.push(e);
    if (this.events.length > 64) this.events.shift();
  }

  // ---------------- snapshots ----------------

  /** Takes a snapshot: reads at this sequence number see the data as it is now. */
  snapshot(): number {
    this.snapshots.set(this.seq, (this.snapshots.get(this.seq) ?? 0) + 1);
    return this.seq;
  }
  release(seq: number) {
    const n = this.snapshots.get(seq) ?? 0;
    if (n <= 1) this.snapshots.delete(seq); else this.snapshots.set(seq, n - 1);
  }
  smallestSnapshot(): number {
    let s = this.seq;
    for (const k of this.snapshots.keys()) if (k < s) s = k;
    return s;
  }

  // ---------------- read path ----------------

  get(key: string, snapshot = Infinity): GetResult {
    const probes: Probe[] = [];
    const done = (e: Entry | undefined): GetResult => {
      const ios = probes.reduce((s, p) => s + p.blocksRead, 0);
      this.stats.gets++;
      this.stats.getIos += ios;
      return { value: e && e.kind === "put" ? e.value : undefined, probes, ios, entry: e };
    };
    const mems = [this.mem, ...this.imm];
    for (let i = 0; i < mems.length; i++) {
      const e = memGet(mems[i]!, key, snapshot);
      probes.push({ source: i === 0 ? "memtable" : "immutable", level: -1, run: i, result: e ? (e.kind === "put" ? "found" : "deleted") : "miss", blocksRead: 0 });
      if (e) return done(e);
    }
    for (let l = 0; l < this.levels.length; l++) {
      const runs = this.levels[l]!.runs;
      for (let r = 0; r < runs.length; r++) {
        const f = fileFor(runs[r]!, key);
        if (!f) { probes.push({ source: "sst", level: l, run: r, result: "no-file", blocksRead: 0 }); continue; }
        const g = f.get(key, snapshot);
        probes.push({ source: "sst", level: l, run: r, fileId: f.id, result: g.result, blocksRead: g.blocksRead, falsePositive: g.falsePositive });
        if (g.entry) return done(g.entry);
      }
    }
    return done(undefined);
  }

  /** All live key/value pairs with lo <= key <= hi, at a snapshot. Also returns the blocks read. */
  scan(lo: string, hi: string, snapshot = Infinity): { rows: [string, string][]; blocksRead: number; runsSeeked: number } {
    const lists: Entry[][] = [];
    let blocksRead = 0, runsSeeked = 0;
    for (const m of [this.mem, ...this.imm]) {
      const l: Entry[] = [];
      for (const [e] of m.list.seek({ key: lo, seq: Infinity, kind: "put", value: "" })) { if (e.key > hi) break; l.push(e); }
      lists.push(l);
    }
    for (const lvl of this.levels) for (const run of lvl.runs) {
      const files = run.files.filter((f) => f.overlaps(lo, hi));
      if (files.length) runsSeeked++;
      for (const f of files) {
        blocksRead += f.blocksFor(lo, hi);
        lists.push(f.entries.filter((e) => e.key >= lo && e.key <= hi));
      }
    }
    const rows: [string, string][] = [];
    let last: string | null = null;
    for (const e of mergeSorted(lists)) {
      if (e.seq > snapshot || e.key === last) continue;
      last = e.key;
      if (e.kind === "put") rows.push([e.key, e.value]);
    }
    return { rows, blocksRead, runsSeeked };
  }

  // ---------------- compaction ----------------

  /** Byte budget of level i ≥ 1 (leveled). */
  maxBytes(level: number) { return this.opts.baseLevelBytes * Math.pow(this.opts.sizeRatio, level - 1); }

  levelBytes(level: number) {
    return this.levels[level]!.runs.reduce((s, r) => s + r.files.reduce((a, f) => a + f.bytes, 0), 0);
  }

  /** Compaction score of each level; a level with score >= 1 needs compaction. */
  scores(): number[] {
    const { strategy, l0Trigger, sizeRatio, maxLevels } = this.opts;
    return this.levels.map((lvl, i) => {
      if (i === maxLevels - 1) return strategy === "tiered" ? lvl.runs.length / sizeRatio : 0;
      if (strategy === "tiered") return lvl.runs.length / sizeRatio;
      if (i === 0) return lvl.runs.length / l0Trigger;
      return this.levelBytes(i) / this.maxBytes(i);
    });
  }

  /** Runs one compaction if any level needs it. */
  compactOnce(): CompactionEvent | null {
    const s = this.scores();
    let best = -1;
    for (let i = 0; i < s.length; i++) if (s[i]! >= 1 && (best < 0 || s[i]! > s[best]!)) best = i;
    if (best < 0) return null;
    return this.opts.strategy === "leveled" ? this.compactLeveled(best) : this.compactTiered(best);
  }

  /** Compacts one level now, even if its score is below 1 (manual compaction). Null if the level is empty. */
  compactLevel(level: number): CompactionEvent | null {
    if (!this.levels[level]?.runs.length || level >= this.opts.maxLevels - (this.opts.strategy === "leveled" ? 1 : 0)) return null;
    return this.opts.strategy === "leveled" ? this.compactLeveled(level) : this.compactTiered(level);
  }

  /** Compacts until no level needs it. Returns the events. */
  compactAll(): CompactionEvent[] {
    const out: CompactionEvent[] = [];
    for (let guard = 0; guard < 10000; guard++) {
      const e = this.compactOnce();
      if (!e) break;
      out.push(e);
    }
    return out;
  }

  private compactLeveled(level: number): CompactionEvent {
    const L = this.levels;
    const out = level + 1;
    let inputs: SSTable[];
    if (level === 0) {
      // Start from the oldest L0 file; add every L0 file that overlaps the growing range.
      const all = L[0]!.runs.map((r) => r.files[0]!);
      inputs = [all[all.length - 1]!];
      for (let changed = true; changed;) {
        changed = false;
        const [lo, hi] = range(inputs);
        for (const f of all) if (!inputs.includes(f) && f.overlaps(lo, hi)) { inputs.push(f); changed = true; }
      }
    } else {
      const files = L[level]!.runs[0]!.files;
      const ptr = this.compactPointer[level];
      inputs = [files.find((f) => ptr === undefined || f.minKey > ptr) ?? files[0]!];
    }
    const [lo, hi] = range(inputs);
    this.compactPointer[level] = hi;
    const outRun = L[out]!.runs[0];
    const next = outRun ? outRun.files.filter((f) => f.overlaps(lo, hi)) : [];
    const inIds = [...inputs, ...next].map((f) => f.id);
    // Remove the inputs from their levels.
    if (level === 0) L[0]!.runs = L[0]!.runs.filter((r) => !inputs.includes(r.files[0]!));
    else { L[level]!.runs[0]!.files = L[level]!.runs[0]!.files.filter((f) => !inputs.includes(f)); if (!L[level]!.runs[0]!.files.length) L[level]!.runs = []; }

    if (inputs.length === 1 && next.length === 0) {
      // Trivial move: the file changes level; nothing is read or written.
      this.placeInRun(out, inputs);
      this.stats.trivialMoves++;
      const ev: CompactionEvent = { kind: "move", fromLevel: level, toLevel: out, inputs: inIds, outputs: inIds, bytesRead: 0, bytesWritten: 0, droppedVersions: 0, droppedTombstones: 0 };
      this.log(ev);
      return ev;
    }
    if (outRun) outRun.files = outRun.files.filter((f) => !next.includes(f));
    // Newest data first in the merge input order does not matter: the merge sorts by (key, seq desc).
    const merged = this.mergeAndWrite([...inputs, ...next], out, new Set(inIds));
    this.placeInRun(out, merged.files);
    const ev: CompactionEvent = { kind: "compaction", fromLevel: level, toLevel: out, inputs: inIds, outputs: merged.files.map((f) => f.id), ...merged.counts };
    this.log(ev);
    return ev;
  }

  private placeInRun(level: number, files: SSTable[]) {
    const lvl = this.levels[level]!;
    if (!lvl.runs.length) lvl.runs.push({ id: this.nextRun++, files: [] });
    const run = lvl.runs[0]!;
    run.files = [...run.files, ...files].sort((a, b) => (a.minKey < b.minKey ? -1 : 1));
  }

  private compactTiered(level: number): CompactionEvent {
    const L = this.levels;
    const last = this.opts.maxLevels - 1;
    const out = Math.min(level + 1, last);
    const runs = L[level]!.runs;
    L[level]!.runs = [];
    const files = runs.flatMap((r) => r.files);
    const inIds = files.map((f) => f.id);
    const merged = this.mergeAndWrite(files, out, new Set(inIds));
    if (merged.files.length) L[out]!.runs.unshift({ id: this.nextRun++, files: merged.files });
    const ev: CompactionEvent = { kind: "compaction", fromLevel: level, toLevel: out, inputs: inIds, outputs: merged.files.map((f) => f.id), ...merged.counts };
    this.log(ev);
    return ev;
  }

  /** Merges input files, drops dead versions, writes new files into level `out`. */
  private mergeAndWrite(inputs: SSTable[], out: number, inputIds: Set<number>) {
    const bytesRead = inputs.reduce((s, f) => s + f.bytes, 0);
    const sorted = mergeSorted(inputs.map((f) => f.entries));
    // A tombstone may go only if no older data for its key can sit below the output:
    // no other file in the output level or deeper covers the key.
    const others: SSTable[] = [];
    for (let l = out; l < this.levels.length; l++) for (const r of this.levels[l]!.runs) for (const f of r.files) if (!inputIds.has(f.id)) others.push(f);
    const g = collectGarbage(sorted, this.smallestSnapshot(), (key) => !others.some((f) => f.covers(key)));
    const files = this.cut(g.out);
    const bytesWritten = files.reduce((s, f) => s + f.bytes, 0);
    this.stats.compactReadBytes += bytesRead;
    this.stats.compactWriteBytes += bytesWritten;
    this.stats.levelWriteBytes[out]! += bytesWritten;
    this.stats.compactions++;
    this.stats.droppedVersions += g.droppedVersions;
    this.stats.droppedTombstones += g.droppedTombstones;
    return { files, counts: { bytesRead, bytesWritten, droppedVersions: g.droppedVersions, droppedTombstones: g.droppedTombstones } };
  }

  /** Cuts sorted entries into files of about targetFileBytes; versions of one key stay in one file. */
  private cut(entries: Entry[]): SSTable[] {
    const files: SSTable[] = [];
    let cur: Entry[] = [], size = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      cur.push(e);
      size += entryBytes(e);
      const nextKey = entries[i + 1]?.key;
      if (size >= this.opts.targetFileBytes && nextKey !== e.key) { files.push(new SSTable(cur, this.tableOpts, this.nextFile++)); cur = []; size = 0; }
    }
    if (cur.length) files.push(new SSTable(cur, this.tableOpts, this.nextFile++));
    return files;
  }

  // ---------------- measurements ----------------

  /** Bytes written by flushes and compactions per byte the user wrote (the WAL is not counted). */
  writeAmp() { return this.stats.userBytes ? (this.stats.flushBytes + this.stats.compactWriteBytes) / this.stats.userBytes : 0; }
  /** Sorted runs that a point lookup may have to check: memtables plus all SST runs. */
  sortedRuns() { return 1 + this.imm.length + this.levels.reduce((s, l) => s + l.runs.length, 0); }
  sstBytes() { let s = 0; for (let l = 0; l < this.levels.length; l++) s += this.levelBytes(l); return s; }
  memBytes() { return this.mem.bytes + this.imm.reduce((s, m) => s + m.bytes, 0); }
  /** Bytes of the newest version of every live key. */
  liveBytes() { return this.liveTotal; }
  liveKeys() { return this.live.size; }
  /** Stored bytes (SSTs + memtables) per live byte. */
  spaceAmp() { return this.liveTotal ? (this.sstBytes() + this.memBytes()) / this.liveTotal : 1; }
  fileCount() { return this.levels.reduce((s, l) => s + l.runs.reduce((a, r) => a + r.files.length, 0), 0); }

  /** Checks structural rules; returns a list of problems (empty = fine). For tests. */
  checkInvariants(): string[] {
    const bad: string[] = [];
    this.levels.forEach((lvl, l) => {
      if (this.opts.strategy === "leveled" && l > 0 && lvl.runs.length > 1) bad.push(`L${l} has ${lvl.runs.length} runs`);
      if (this.opts.strategy === "leveled" && l === 0 && lvl.runs.some((r) => r.files.length !== 1)) bad.push("L0 run with more than one file");
      for (const run of lvl.runs) {
        for (const f of run.files) for (let i = 1; i < f.entries.length; i++) if (compareEntries(f.entries[i - 1]!, f.entries[i]!) >= 0) bad.push(`file ${f.id} not sorted`);
        for (let i = 1; i < run.files.length; i++) if (run.files[i - 1]!.maxKey >= run.files[i]!.minKey) bad.push(`run ${run.id} files overlap`);
      }
    });
    return bad;
  }
}

function memGet(m: Memtable, key: string, snapshot: number): Entry | undefined {
  const it = m.list.seek({ key, seq: snapshot === Infinity ? Number.MAX_SAFE_INTEGER : snapshot, kind: "put", value: "" });
  const first = it.next();
  if (first.done) return undefined;
  const e = first.value[0];
  return e.key === key ? e : undefined;
}

/** The one file in a run whose key range covers `key` (binary search over the file fences). */
function fileFor(run: Run, key: string): SSTable | undefined {
  const fs = run.files;
  let lo = 0, hi = fs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = fs[mid]!;
    if (key < f.minKey) hi = mid - 1;
    else if (key > f.maxKey) lo = mid + 1;
    else return f;
  }
  return undefined;
}

function range(files: SSTable[]): [string, string] {
  let lo = files[0]!.minKey, hi = files[0]!.maxKey;
  for (const f of files) { if (f.minKey < lo) lo = f.minKey; if (f.maxKey > hi) hi = f.maxKey; }
  return [lo, hi];
}
