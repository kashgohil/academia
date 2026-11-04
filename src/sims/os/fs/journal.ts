/**
 * Crash consistency with an exhaustive explorer. One operation (an append or an overwrite) becomes a set of block
 * writes with barriers between groups. The disk may complete the writes of a group in any order. So a crash state is
 * any set of writes that is closed under "everything before the last barrier": `enumerateCrashStates` lists them all.
 * `recover` then runs journal replay on a state, and `classify` says what a reader finds.
 *
 * The modes follow ext4 and jbd2: data=journal, data=ordered and data=writeback. Mode "none" is a file system with no
 * journal, like ext2, and the classic eight outcomes of Remzi and Andrea Arpaci-Dusseau's crash consistency chapter.
 */
import { ext4Layout } from "./inodefs";
import { HDDS, SSD_NVME, hddAccess } from "../../db/storage/disk";
import { mulberry32 } from "../../rng";

/** ext4 commits a running transaction at least this often (the commit= mount option). */
export const EXT4_COMMIT_SECONDS = 5;

export type JournalMode = "none" | "writeback" | "ordered" | "data";
export const MODE_LABEL: Record<JournalMode, string> = { none: "No journal", writeback: "data=writeback", ordered: "data=ordered", data: "data=journal" };

export type JWorkload = "append" | "overwrite";
export const WORKLOAD_LABEL: Record<JWorkload, string> = { append: "Append one block", overwrite: "Overwrite two blocks" };

/**
 * barrier: flush before the commit block. nobarrier: no flush there, so the commit block can pass the blocks it covers.
 * checksum: no flush there, and the commit block holds a checksum of the transaction (journal_async_commit).
 */
export type CommitPolicy = "barrier" | "nobarrier" | "checksum";
export const COMMIT_LABEL: Record<CommitPolicy, string> = { barrier: "Flush before commit", nobarrier: "No flush", checksum: "No flush, checksum" };

export interface PlannedWrite { id: string; level: number | null; area: "journal" | "home"; note: string }
export interface WritePlan { mode: JournalMode; workload: JWorkload; commit: CommitPolicy; writes: PlannedWrite[]; dataIds: string[]; metaIds: string[] }

const NOTE: Record<string, string> = {
  TxB: "transaction begin: the descriptor block that lists what follows",
  TxE: "the commit block: the transaction counts only if this is on disk",
  JSB: "journal superblock: marks the transaction as done, so the space can be reused",
  I: "the inode, in place",
  B: "the block bitmap, in place",
};

export function writePlan(mode: JournalMode, workload: JWorkload, commit: CommitPolicy = "barrier"): WritePlan {
  const dataIds = workload === "append" ? ["D0"] : ["D0", "D1"];
  const metaIds = workload === "append" ? ["I", "B"] : ["I"];
  const home = (id: string, level: number | null): PlannedWrite => ({ id, level, area: "home", note: NOTE[id] ?? `data block ${id}, in place` });
  const jrn = (id: string, level: number): PlannedWrite => ({ id, level, area: "journal", note: NOTE[id] ?? `the journal copy of ${id.slice(2)}` });
  const writes: PlannedWrite[] = [];
  if (mode === "none") {
    for (const id of [...dataIds, ...metaIds]) writes.push(home(id, 0));
    return { mode, workload, commit, writes, dataIds, metaIds };
  }
  const logged = mode === "data" ? [...metaIds, ...dataIds] : metaIds;
  writes.push(jrn("TxB", 0));
  for (const id of logged) writes.push(jrn(`J:${id}`, 0));
  if (mode === "ordered") for (const id of dataIds) writes.push(home(id, 0));
  if (mode === "writeback") for (const id of dataIds) writes.push(home(id, null));
  const commitLevel = commit === "barrier" ? 1 : 0;
  writes.push(jrn("TxE", commitLevel));
  const ck = commitLevel + 1;
  for (const id of metaIds) writes.push(home(id, ck));
  if (mode === "data") for (const id of dataIds) writes.push(home(id, ck));
  writes.push(jrn("JSB", ck + 1));
  return { mode, workload, commit, writes, dataIds, metaIds };
}

/** True if the set `mask` can be the durable writes at a crash. Bit i stands for writes[i]. */
export function isCrashState(p: WritePlan, mask: number): boolean {
  let top = -1;
  p.writes.forEach((w, i) => { if (mask & (1 << i) && w.level !== null && w.level > top) top = w.level; });
  return p.writes.every((w, i) => w.level === null || w.level >= top || (mask & (1 << i)) !== 0);
}

/** Every reachable crash state as a bit mask. */
export function enumerateCrashStates(p: WritePlan): number[] {
  const out: number[] = [];
  for (let m = 0; m < 1 << p.writes.length; m++) if (isCrashState(p, m)) out.push(m);
  return out;
}

/** One possible order in which the disk completes the writes. Barriers still hold. */
export function diskOrder(p: WritePlan, seed: number): number[] {
  const rng = mulberry32(seed * 2654435 + 17);
  const levels = [...new Set(p.writes.flatMap((w) => (w.level === null ? [] : [w.level])))].sort((a, b) => a - b);
  const out: number[] = [];
  for (const l of levels) {
    const idx = p.writes.flatMap((w, i) => (w.level === l ? [i] : []));
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    out.push(...idx);
  }
  p.writes.forEach((w, i) => { if (w.level === null) out.splice(Math.floor(rng() * (out.length + 1)), 0, i); });
  return out;
}

export const orderMask = (order: readonly number[], k: number) => order.slice(0, k).reduce((m, i) => m | (1 << i), 0);

export type BlockValue = "old" | "new" | "junk";

export interface Recovery {
  replayed: boolean;
  /** The reason for what replay did. */
  action: string;
  /** Home blocks after recovery. */
  home: Record<string, BlockValue>;
}

/** Journal replay: a complete transaction is copied home, and anything else in the journal is ignored. */
export function recover(p: WritePlan, mask: number): Recovery {
  const has = (id: string) => { const i = p.writes.findIndex((w) => w.id === id); return i >= 0 && (mask & (1 << i)) !== 0; };
  const home: Record<string, BlockValue> = {};
  for (const id of [...p.dataIds, ...p.metaIds]) home[id] = has(id) ? "new" : "old";
  if (p.mode === "none") return { replayed: false, action: "There is no journal. The disk is what it is, and only a full fsck can look for damage.", home };
  const logged = p.writes.filter((w) => w.id.startsWith("J:"));
  if (has("JSB")) return { replayed: false, action: "The journal superblock says that this transaction is finished. Nothing to replay.", home };
  if (!has("TxE")) {
    const n = p.writes.filter((w) => w.area === "journal" && has(w.id)).length;
    return { replayed: false, action: n ? `No commit block. Replay ignores the ${n} journal block${n === 1 ? "" : "s"} on disk.` : "The journal is empty. Nothing to replay.", home };
  }
  if (!has("TxB")) return { replayed: false, action: "A commit block is on disk, but no descriptor block leads to it. Replay finds no transaction.", home };
  const missing = logged.filter((w) => !has(w.id));
  if (p.commit === "checksum" && missing.length) return { replayed: false, action: `The commit block's checksum does not match, because ${missing.map((w) => w.id).join(", ")} did not reach the disk. Replay discards the transaction.`, home };
  for (const w of logged) home[w.id.slice(2)] = has(w.id) ? "new" : "junk";
  if (missing.length) return { replayed: true, action: `The commit block is valid, so replay copies every logged block home. ${missing.map((w) => w.id).join(", ")} never reached the disk, so replay writes old journal bytes over real blocks.`, home };
  return { replayed: true, action: `The transaction is complete. Replay copies ${logged.length} block${logged.length === 1 ? "" : "s"} from the journal to their home locations.`, home };
}

export type Outcome = "old" | "new" | "torn" | "garbage" | "leak" | "dangling" | "corrupt";

export const OUTCOME_LABEL: Record<Outcome, string> = {
  old: "Old file, as if the write never happened",
  new: "New file, complete",
  torn: "File system fine, file holds a mix of old and new data",
  garbage: "File system fine, file holds bytes that were never written to it",
  leak: "Bitmap says used, no inode owns the block: space leak",
  dangling: "Inode owns a block that the bitmap says is free: it can be given to a second file",
  corrupt: "Replay wrote junk over a real block",
};

export const OUTCOME_ORDER: Outcome[] = ["old", "new", "torn", "garbage", "leak", "dangling", "corrupt"];
export const metadataOk = (o: Outcome) => o !== "leak" && o !== "dangling" && o !== "corrupt";
/** The reader sees only bytes that this file really held. */
export const dataOk = (o: Outcome) => metadataOk(o) && o !== "garbage";
/** All or nothing. */
export const atomic = (o: Outcome) => o === "old" || o === "new";

export function classify(p: WritePlan, r: Recovery): Outcome {
  const vals = Object.values(r.home);
  if (vals.includes("junk")) return "corrupt";
  if (p.workload === "append") {
    const i = r.home.I!, b = r.home.B!;
    if (i === "new" && b === "old") return "dangling";
    if (i === "old" && b === "new") return "leak";
    if (i === "old") return "old";
    return r.home.D0 === "new" ? "new" : "garbage";
  }
  const nNew = p.dataIds.filter((d) => r.home[d] === "new").length;
  if (nNew === 0) return "old";
  return nNew === p.dataIds.length ? "new" : "torn";
}

export interface CrashCase { mask: number; durable: string[]; recovery: Recovery; outcome: Outcome }

export function exploreCrashes(p: WritePlan): CrashCase[] {
  return enumerateCrashStates(p).map((mask) => {
    const recovery = recover(p, mask);
    return { mask, durable: p.writes.flatMap((w, i) => (mask & (1 << i) ? [w.id] : [])), recovery, outcome: classify(p, recovery) };
  });
}

export function outcomeCounts(p: WritePlan): Record<Outcome, number> {
  const c = Object.fromEntries(OUTCOME_ORDER.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const x of exploreCrashes(p)) c[x.outcome]++;
  return c;
}

// ----------------------------------------------------------------------------------------------- fsck

/**
 * Pass 1 of a full fsck reads every inode table. Their share of the disk is fixed, so the time grows with the disk.
 * Replay reads only the journal, so its time stays fixed. The journal size is a model input.
 */
export const FSCK_INPUTS = { journalBytes: 1024 * 1024 * 1024, mbps: HDDS["7200"].mbps };

export function fsckVsReplay(diskBytes: number) {
  const l = ext4Layout();
  const inodeTableBytes = diskBytes * l.inodeTableFraction;
  const mbps = FSCK_INPUTS.mbps;
  return {
    inodeTableBytes,
    pass1Seconds: inodeTableBytes / (mbps * 1e6),
    replaySeconds: FSCK_INPUTS.journalBytes / (mbps * 1e6),
  };
}

// ----------------------------------------------------------------------------------------------- the cost model

export type CostDevice = "hdd" | "nvme";

/** Model inputs. The HDD figures come from the disk model of the databases track. The flush times are round numbers. */
export const COST_DEVICES: Record<CostDevice, { label: string; positionMs: number; mbps: number; flushMs: number }> = {
  hdd: { label: "7,200 rpm disk", positionMs: hddAccess(HDDS["7200"], 0, "random").total, mbps: HDDS["7200"].mbps, flushMs: 1 },
  nvme: { label: "NVMe SSD", positionMs: 0.02, mbps: SSD_NVME.mbps, flushMs: 0.2 },
};

export const COST_INPUTS = {
  blockBytes: 4096,
  /** Metadata blocks in one transaction: an inode block and a bitmap block. */
  metaPerCommit: 2,
  /** Block tags that one descriptor block holds. */
  tagsPerDescriptor: 250,
};

export interface CostOpts {
  /** Data blocks per fsync. */
  blocks: number;
  /** Commits between checkpoints. A metadata block that many commits change is written home once. */
  absorb: number;
  /** Dirty blocks of other files that fall into the same transaction. */
  entangled: number;
  device: CostDevice;
}

export const COST_MODES = ["writeback", "ordered", "data"] as const;
export type CostMode = (typeof COST_MODES)[number];

export interface CostResult {
  mode: CostMode;
  /** Blocks per commit. */
  dataInPlace: number;
  journal: number;
  checkpoint: number;
  total: number;
  writeAmp: number;
  /** Time for fsync to return, in ms. */
  fsyncMs: number;
  /** Positioning operations during fsync. */
  seeks: number;
}

/** One append and fsync under one mode. */
export function journalCost(mode: CostMode, o: CostOpts): CostResult {
  const { metaPerCommit: m, tagsPerDescriptor: tags, blockBytes } = COST_INPUTS;
  const d = COST_DEVICES[o.device];
  const logged = mode === "data" ? m + o.blocks : m;
  const descriptors = Math.ceil(logged / tags);
  const journal = descriptors + logged + 1;
  const dataInPlace = mode === "data" ? 0 : o.blocks;
  const checkpoint = m / o.absorb + (mode === "data" ? o.blocks : 0);
  const total = dataInPlace + journal + checkpoint;
  // What fsync waits for. fsync always waits for this file's data. Only ordered mode must also wait for other files' data.
  const waited = mode === "ordered" ? o.blocks + o.entangled : mode === "writeback" ? o.blocks : 0;
  const entangledInJournal = mode === "data" ? o.entangled : 0;
  const seeks = (waited > 0 ? 1 : 0) + (mode === "ordered" && o.entangled > 0 ? 1 : 0) + 1;
  const xferBlocks = waited + journal + entangledInJournal;
  const fsyncMs = seeks * d.positionMs + (xferBlocks * blockBytes) / (d.mbps * 1e6) * 1e3 + d.flushMs;
  return { mode, dataInPlace, journal, checkpoint, total, writeAmp: total / o.blocks, fsyncMs, seeks };
}
