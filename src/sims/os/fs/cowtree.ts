/**
 * A copy-on-write block tree with snapshots, clones, reference counts and checksums, in the style of ZFS and btrfs.
 *
 * Blocks never change after they are written. An update copies the path from the leaf to the root. A parent stores the
 * checksum of each child, so the tree checks itself from the top down. A dataset is a named root pointer. A snapshot is
 * a root pointer that never moves. A reference count on each block says how many pointers lead to it, and a block goes
 * back to the free pool when the count reaches zero.
 */
import { crc32c } from "../../db/storage/durability";

/** ZFS closes a transaction group at least this often (zfs_txg_timeout). */
export const ZFS_TXG_SECONDS = 5;

export interface CowBlock {
  id: number;
  kind: "node" | "leaf";
  children: number[] | null;
  /** Checksums of the children, stored in the parent. */
  childSums: number[] | null;
  value: string | null;
  /** Pointers to this block: parents plus root pointers. */
  refs: number;
  /** The transaction that wrote this block. */
  birth: number;
  /** A fault injected by a test or a demo. The stored bytes differ from the bytes that were written. */
  flipped: boolean;
}

export interface UpdateResult { copied: number[]; freed: number[]; newRoot: number; oldRoot: number }
export interface ScrubResult { checked: number; bad: number[]; repaired: number[]; lost: number[] }

const enc = new TextEncoder();

export class CowTree {
  readonly blocks = new Map<number, CowBlock>();
  /** dataset name -> root block */
  readonly datasets = new Map<string, number>();
  /** snapshot name -> root block */
  readonly snapshots = new Map<string, { root: number; txg: number; from: string }>();
  readonly leaves: number;
  private nextId = 1;
  txg = 1;
  totalFreed = 0;
  totalCopied = 0;

  constructor(readonly fanout: number, readonly depth: number, init: (i: number) => string = (i) => `v0.${i}`, readonly mirrored = false) {
    this.leaves = Math.pow(fanout, depth);
    let i = 0;
    const build = (h: number): number => {
      if (h === 0) return this.make("leaf", null, init(i++));
      const kids = Array.from({ length: fanout }, () => build(h - 1));
      for (const k of kids) this.blocks.get(k)!.refs++;
      return this.make("node", kids, null);
    };
    const root = build(depth);
    this.blocks.get(root)!.refs = 1;
    this.datasets.set("live", root);
  }

  private bytes(b: CowBlock): Uint8Array {
    const body = b.kind === "leaf" ? `L${b.value}` : `N${b.children!.join(",")}|${b.childSums!.join(",")}`;
    const raw = enc.encode(body);
    if (b.flipped) raw[0]! ^= 1;
    return raw;
  }

  private make(kind: "node" | "leaf", children: number[] | null, value: string | null): number {
    const id = this.nextId++;
    const b: CowBlock = { id, kind, children, childSums: children ? children.map((c) => this.sum(this.blocks.get(c)!)) : null, value, refs: 0, birth: this.txg, flipped: false };
    this.blocks.set(id, b);
    return id;
  }

  private sum(b: CowBlock): number {
    const flipped = b.flipped;
    b.flipped = false;
    const s = crc32c(this.bytes(b));
    b.flipped = flipped;
    return s;
  }

  /** The stored checksum of a block as read from disk now. */
  private readSum(b: CowBlock) { return crc32c(this.bytes(b)); }

  /** The slot at each height for a leaf, from the root down. */
  private slots(leaf: number): number[] {
    const out: number[] = [];
    for (let h = this.depth - 1; h >= 0; h--) out.push(Math.floor(leaf / Math.pow(this.fanout, h)) % this.fanout);
    return out;
  }

  /** Reads a leaf from a root. Returns the path too. */
  readFrom(root: number, leaf: number): { value: string; path: number[] } {
    const path = [root];
    let cur = this.blocks.get(root)!;
    for (const s of this.slots(leaf)) {
      cur = this.blocks.get(cur.children![s]!)!;
      path.push(cur.id);
    }
    return { value: cur.value!, path };
  }

  read(dataset: string, leaf: number) { return this.readFrom(this.datasets.get(dataset)!, leaf).value; }

  /** Every leaf value as seen from a root. */
  allLeaves(root: number): string[] {
    const out: string[] = [];
    const go = (id: number) => {
      const b = this.blocks.get(id);
      if (!b) throw new Error(`block ${id} was freed while still reachable`);
      if (b.kind === "leaf") out.push(b.value!);
      else b.children!.forEach(go);
    };
    go(root);
    return out;
  }

  /** Drops one pointer. A block at zero is freed, and its own pointers go with it. */
  private release(id: number, freed: number[]) {
    const b = this.blocks.get(id)!;
    if (--b.refs > 0) return;
    if (b.children) for (const c of b.children) this.release(c, freed);
    this.blocks.delete(id);
    freed.push(id);
    this.totalFreed++;
  }

  /** Copies the path to a leaf, then swings the dataset's root pointer. That one pointer store is the commit. */
  update(dataset: string, leaf: number, value: string): UpdateResult {
    this.txg++;
    const oldRoot = this.datasets.get(dataset)!;
    const { path } = this.readFrom(oldRoot, leaf);
    const slots = this.slots(leaf);
    const copied: number[] = [];
    let child = this.make("leaf", null, value);
    copied.push(child);
    for (let i = path.length - 2; i >= 0; i--) {
      const old = this.blocks.get(path[i]!)!;
      const kids = [...old.children!];
      kids[slots[i]!] = child;
      for (const k of kids) this.blocks.get(k)!.refs++;
      child = this.make("node", kids, null);
      copied.push(child);
    }
    this.blocks.get(child)!.refs = 1;
    this.datasets.set(dataset, child);
    const freed: number[] = [];
    this.release(oldRoot, freed);
    this.totalCopied += copied.length;
    return { copied, freed, newRoot: child, oldRoot };
  }

  /** A snapshot costs one pointer and one count. It copies nothing. */
  snapshot(dataset: string, name: string) {
    const root = this.datasets.get(dataset)!;
    this.blocks.get(root)!.refs++;
    this.snapshots.set(name, { root, txg: this.txg, from: dataset });
    return root;
  }

  /** A clone is a writable dataset that starts at a snapshot's root. */
  clone(snapshot: string, dataset: string) {
    const s = this.snapshots.get(snapshot)!;
    this.blocks.get(s.root)!.refs++;
    this.datasets.set(dataset, s.root);
    return s.root;
  }

  deleteSnapshot(name: string): number[] {
    const s = this.snapshots.get(name)!;
    this.snapshots.delete(name);
    const freed: number[] = [];
    this.release(s.root, freed);
    return freed;
  }

  deleteDataset(name: string): number[] {
    const r = this.datasets.get(name)!;
    this.datasets.delete(name);
    const freed: number[] = [];
    this.release(r, freed);
    return freed;
  }

  /** Blocks reachable from a root. */
  reachable(root: number): Set<number> {
    const seen = new Set<number>();
    const go = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      this.blocks.get(id)?.children?.forEach(go);
    };
    go(root);
    return seen;
  }

  /** All blocks in use, the blocks that the live tree can reach, and the blocks only older snapshots pin. */
  space() {
    const live = new Set<number>();
    for (const r of this.datasets.values()) for (const b of this.reachable(r)) live.add(b);
    return { total: this.blocks.size, live: live.size, pinned: this.blocks.size - live.size };
  }

  /** Flips a bit in a stored block. */
  corrupt(id: number) { const b = this.blocks.get(id); if (b) b.flipped = true; }

  /**
   * Walks each tree from its root and compares each child's bytes with the checksum in its parent. A root is checked
   * against the superblock's copy. With a mirror, a bad block is repaired from the good copy.
   */
  scrub(): ScrubResult {
    const seen = new Set<number>();
    const res: ScrubResult = { checked: 0, bad: [], repaired: [], lost: [] };
    const visit = (id: number, want: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const b = this.blocks.get(id)!;
      res.checked++;
      if (this.readSum(b) !== want) {
        res.bad.push(id);
        if (this.mirrored) { b.flipped = false; res.repaired.push(id); }
        else res.lost.push(id);
      }
      b.children?.forEach((c, i) => visit(c, b.childSums![i]!));
    };
    const roots = [...this.datasets.values(), ...[...this.snapshots.values()].map((s) => s.root)];
    for (const r of roots) visit(r, this.sum(this.blocks.get(r)!));
    return res;
  }

  /** Returns each broken rule: each count must equal the number of pointers, and no reachable block may be freed. */
  check(): string[] {
    const bad: string[] = [];
    const counts = new Map<number, number>();
    const inc = (id: number) => counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const r of this.datasets.values()) inc(r);
    for (const s of this.snapshots.values()) inc(s.root);
    const seen = new Set<number>();
    const walk = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const b = this.blocks.get(id);
      if (!b) { bad.push(`block ${id} is reachable but freed`); return; }
      for (const c of b.children ?? []) { inc(c); walk(c); }
    };
    for (const r of this.datasets.values()) walk(r);
    for (const s of this.snapshots.values()) walk(s.root);
    for (const [id, b] of this.blocks) {
      if (!seen.has(id)) bad.push(`block ${id} is allocated but unreachable`);
      if ((counts.get(id) ?? 0) !== b.refs) bad.push(`block ${id}: refs ${b.refs}, counted ${counts.get(id) ?? 0}`);
    }
    return bad;
  }
}

/** Blocks that one update writes: a path from leaf to root. */
export const pathBlocks = (depth: number) => depth + 1;
/** Blocks written by n updates to one leaf in n transactions, and by n updates in one transaction. */
export const absorbCost = (depth: number, n: number) => ({ separate: n * pathBlocks(depth), together: pathBlocks(depth) });

/**
 * Every crash state of a commit. The new blocks reach the disk in any order, then a flush, then the superblock.
 * For each state, it reads the tree through the root that the durable superblock names.
 * With `barrier` off, the superblock can land first, and the checksum in the path catches the missing block.
 */
export function commitCrashStates(fanout: number, depth: number, barrier = true) {
  const t = new CowTree(fanout, depth);
  const before = t.allLeaves(t.datasets.get("live")!);
  // A snapshot keeps the old root, as a superblock on disk does until the new one is durable.
  t.snapshot("live", "disk");
  const u = t.update("live", 0, "new");
  const after = t.allLeaves(t.datasets.get("live")!);
  const newBlocks = u.copied;
  let total = 0, oldReads = 0, newReads = 0, detected = 0, wrong = 0;
  const ok = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (let m = 0; m < 1 << newBlocks.length; m++) {
    const durable = new Set(newBlocks.filter((_, i) => m & (1 << i)));
    const allDurable = durable.size === newBlocks.length;
    for (const superNew of [false, true]) {
      if (superNew && !allDurable && barrier) continue;
      total++;
      if (!superNew) {
        if (ok(t.allLeaves(u.oldRoot), before)) oldReads++; else wrong++;
      } else if (allDurable) {
        if (ok(t.allLeaves(u.newRoot), after)) newReads++; else wrong++;
      } else detected++; // a parent's checksum does not match what the missing child's location holds
    }
  }
  return { total, oldReads, newReads, detected, wrong, newBlocks: newBlocks.length };
}
