/**
 * Architecture of an embedded engine: the layers, a trace of one operation through them, and the
 * design space (one choice per axis, its consequences, and the real engines that made it).
 *
 * The numbers come from the wave-1 models: storage/amplification (RA, WA, SA with AMP_ENV:
 * 100-byte records, 4 KiB pages, 100 GB of data) and btree-cow (path-copy write amplification).
 */
import { btreeAmp, leveledAmp, logHashAmp, AMP_ENV, type Amp } from "../storage/amplification";
import { cowBytesPerUpdate } from "../btree-cow";
import { TinyKv, LAYERS, type Layer, type LayerEvent, type KvConfig } from "./kv";

// ---------------------------------------------------------------- the layers

export const LAYER_INFO: Record<Layer, { name: string; job: string }> = {
  api: { name: "API", job: "begin, get, put, delete, commit, abort" },
  txn: { name: "Transaction manager", job: "snapshots, version visibility, write conflicts, commit timestamps" },
  tree: { name: "Access method (B+ tree)", job: "find the leaf, change a cell, split full pages" },
  pool: { name: "Buffer pool", job: "pin pages in frames, choose victims, write back dirty pages" },
  file: { name: "Page and file layer", job: "page numbers to file offsets, CRC-32C checksums" },
  wal: { name: "Write-ahead log", job: "LSNs, log records, the WAL rule, group commit" },
  os: { name: "OS and device", job: "write(), pread(), fsync(): the only calls that touch storage" },
};

export interface OpTrace {
  label: string;
  events: LayerEvent[];
  /** Counter changes caused by the operation. */
  delta: Record<OpCounter, number>;
  /** Events per layer. */
  perLayer: Record<Layer, number>;
}

const COUNTERS = ["treeVisits", "poolHits", "poolMisses", "evictions", "pageReads", "pageWrites", "logRecords", "logBytes", "logWrites", "logFsyncs", "dataFsyncs", "splits", "fpis"] as const;
export type OpCounter = (typeof COUNTERS)[number];

/** Runs `fn` on an engine with events on, and returns what each layer did. */
export function traceOp(e: TinyKv, label: string, fn: (e: TinyKv) => void): OpTrace {
  const before = e.counters();
  e.events = [];
  const was = e.cfg.events;
  e.cfg.events = true;
  let err: string | null = null;
  try { fn(e); } catch (x) { err = (x as Error).message; }
  e.cfg.events = was;
  const after = e.counters();
  const delta = Object.fromEntries(COUNTERS.map((k) => [k, after[k] - before[k]])) as Record<OpCounter, number>;
  const events = e.events.slice();
  if (err) events.push({ layer: "api", text: `error: ${err}` });
  const perLayer = Object.fromEntries(LAYERS.map((l) => [l, events.filter((x) => x.layer === l).length])) as Record<Layer, number>;
  return { label, events, delta, perLayer };
}

/** The demo engine: `keys` committed keys k000.., small pages so the tree has several levels. */
export function archEngine(keys: number, cfg: Partial<KvConfig> = {}): TinyKv {
  const e = new TinyKv({ leafCap: 4, innerCap: 4, frames: 8, ...cfg });
  const order = Array.from({ length: keys }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = (i * 7919 + 13) % (i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const t = e.begin();
  for (const k of order) e.put(t, archKey(k), `a${k}`);
  e.commit(t);
  e.checkpoint();
  return e;
}
export const archKey = (i: number) => `k${String(i).padStart(3, "0")}`;

// ---------------------------------------------------------------- the design space

export type AccessId = "btree" | "lsm" | "hash";
export type UpdateId = "inplace" | "cow" | "logstruct";
export type RecoveryId = "undoredo" | "redo" | "undo" | "shadow";
export type WritersId = "single" | "many";
export type CacheId = "pool" | "os";

export interface Choice { access: AccessId; update: UpdateId; recovery: RecoveryId; writers: WritersId; cache: CacheId }

export const AXES = {
  access: { label: "Access method", options: [["btree", "B+ tree"], ["lsm", "LSM tree"], ["hash", "Hash + log"]] },
  update: { label: "Updates", options: [["inplace", "In place"], ["cow", "Copy-on-write"], ["logstruct", "Log-structured"]] },
  recovery: { label: "Crash safety", options: [["undoredo", "Undo + redo log"], ["redo", "Redo log"], ["undo", "Undo journal"], ["shadow", "Shadow paging"]] },
  writers: { label: "Writers", options: [["single", "One at a time"], ["many", "Many"]] },
  cache: { label: "Caching", options: [["pool", "Own buffer pool"], ["os", "OS page cache / mmap"]] },
} as const;

export interface RealEngine { name: string; choice: Choice; note: string }

export const REAL_ENGINES: RealEngine[] = [
  { name: "SQLite, rollback journal", choice: { access: "btree", update: "inplace", recovery: "undo", writers: "single", cache: "pool" }, note: "original pages go to the -journal file; deleting the journal is the commit" },
  { name: "SQLite, WAL mode", choice: { access: "btree", update: "inplace", recovery: "redo", writers: "single", cache: "pool" }, note: "new page images go to the -wal file; a checkpoint copies them back" },
  { name: "LMDB", choice: { access: "btree", update: "cow", recovery: "shadow", writers: "single", cache: "os" }, note: "read-only mmap, two meta pages, no log" },
  { name: "bbolt (Go)", choice: { access: "btree", update: "cow", recovery: "shadow", writers: "single", cache: "os" }, note: "an LMDB-style design in Go, used by etcd" },
  { name: "InnoDB (MySQL)", choice: { access: "btree", update: "inplace", recovery: "undoredo", writers: "many", cache: "pool" }, note: "16 KiB pages, redo log, undo logs, doublewrite buffer" },
  { name: "PostgreSQL", choice: { access: "btree", update: "inplace", recovery: "redo", writers: "many", cache: "pool" }, note: "heap tables with B-tree indexes; MVCC removes the need for undo" },
  { name: "WiredTiger (MongoDB)", choice: { access: "btree", update: "cow", recovery: "redo", writers: "many", cache: "pool" }, note: "writes changed pages to new blocks; checkpoints plus a redo journal" },
  { name: "RocksDB", choice: { access: "lsm", update: "logstruct", recovery: "redo", writers: "many", cache: "pool" }, note: "WAL, memtables, leveled compaction, block cache" },
  { name: "Bitcask (Riak)", choice: { access: "hash", update: "logstruct", recovery: "redo", writers: "single", cache: "os" }, note: "the data files are the log; a hash table in memory points into them" },
];

export interface Consequences {
  valid: boolean;
  /** Why the combination does not work, when it does not. */
  problems: string[];
  amp: Amp | null;
  /** fsync calls on the commit path. */
  commitFsyncs: number;
  recoveryWork: string;
  concurrency: string;
  caching: string;
  matches: { engine: RealEngine; score: number }[];
}

/** WA of a copy-on-write B+ tree for the AMP_ENV data set, one update per transaction. */
export const cowWa = () => cowBytesPerUpdate({ n: AMP_ENV.datasetBytes / AMP_ENV.recordBytes, pageBytes: AMP_ENV.pageBytes, recordBytes: AMP_ENV.recordBytes, batch: 1 }).amplification;

/** Write amplification of a choice (bytes written per byte updated), from the wave-1 models. */
export function designAmp(c: Choice): Amp | null {
  const e = AMP_ENV;
  const page = e.pageBytes / e.recordBytes;
  if (c.access === "lsm") return leveledAmp(10, e);
  if (c.access === "hash") return logHashAmp(0.8, e);
  const bt = btreeAmp(e);
  if (c.update === "cow") return { ...bt, wa: cowWa() + (c.recovery === "redo" ? 1 : 0) };
  // In place: one page write per update, plus what the log or journal writes.
  if (c.recovery === "undo") return { ...bt, wa: 2 * page }; // the old page to the journal, the new page in place
  return bt; // WAL record + page write (record-level redo)
}

export function consequences(c: Choice): Consequences {
  const problems: string[] = [];
  if (c.access !== "btree" && c.update !== "logstruct") problems.push(`${c.access === "lsm" ? "An LSM tree" : "A hash log"} never changes a written file, so its updates are log-structured.`);
  if (c.access === "btree" && c.update === "logstruct") problems.push("Log-structured B-trees exist (the Bw-tree), but this model does not cover them.");
  if (c.recovery === "shadow" && c.update !== "cow") problems.push("Shadow paging needs copy-on-write: it switches from the old tree to the new tree.");
  if (c.update === "cow" && (c.recovery === "undo" || c.recovery === "undoredo")) problems.push("Copy-on-write never overwrites old pages, so there is nothing to undo.");
  if (c.update === "logstruct" && c.recovery !== "redo") problems.push("Log-structured data is never changed in place, so recovery only replays (redoes) the log.");
  if (c.cache === "os" && c.update === "inplace") problems.push("With a writable mmap, the OS can write a changed page at any time, before its log or journal record is durable.");
  const amp = problems.length ? null : designAmp(c);
  const commitFsyncs = c.recovery === "shadow" ? 2 : c.recovery === "undo" ? 3 : 1;
  const recoveryWork = {
    undoredo: "Analysis, redo and undo from the last checkpoint (ARIES).",
    redo: c.update === "logstruct" ? "Replay the log tail into the memtable or the index." : "Replay the log from the last checkpoint. Uncommitted work is hidden (MVCC) or was never written (no steal).",
    undo: "Copy the original pages back from the journal, if a journal exists.",
    shadow: "None: open the newest valid meta page.",
  }[c.recovery];
  const concurrency = c.writers === "single"
    ? "One writer lock. No deadlocks and no write latches between writers. Write throughput is one commit at a time."
    : "Locks or optimistic checks per key, latches on pages, and group commit to share the log flush.";
  const caching = c.cache === "pool"
    ? "The engine chooses victims, enforces the WAL rule and can use O_DIRECT."
    : "No double caching and little code, but the OS decides what to evict and when to write, and I/O errors arrive as signals.";
  const keys: (keyof Choice)[] = ["access", "update", "recovery", "writers", "cache"];
  const matches = REAL_ENGINES.map((engine) => ({ engine, score: keys.filter((k) => engine.choice[k] === c[k]).length })).sort((a, b) => b.score - a.score);
  return { valid: problems.length === 0, problems, amp, commitFsyncs, recoveryWork, concurrency, caching, matches };
}
