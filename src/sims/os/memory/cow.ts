/**
 * Copy-on-write: a small physical memory, page tables, and reference counts.
 *
 * fork() shares every page: both page tables map the same frame, read-only, and the frame's count goes up.
 * A write to a read-only COW page faults. The fault handler (do_wp_page in Linux) checks the count. If the
 * writer is the only mapper, it reuses the page and only sets the write bit. Otherwise it copies the page into a new
 * frame, maps the copy writable, and drops one reference on the old frame.
 *
 * Invariant (tests check it after every operation): frame.refs equals the number of page table entries that map it.
 */

export interface CowFrame { id: number; value: string; refs: number }
export interface CowPte { frame: number; writable: boolean }
export interface CowProc { pid: number; name: string; ptes: Map<number, CowPte>; alive: boolean }

export type WriteKind = "in-place" | "reuse" | "copy" | "unmapped";

export interface WriteResult { kind: WriteKind; from?: number; to?: number }

export interface CowStats { faults: number; copies: number; reuses: number; forks: number; ptesCopied: number; merges: number }

export class CowMemory {
  frames = new Map<number, CowFrame>();
  procs: CowProc[] = [];
  stats: CowStats = { faults: 0, copies: 0, reuses: 0, forks: 0, ptesCopied: 0, merges: 0 };
  private nextFrame = 0;
  private nextPid = 1;

  private alloc(value: string): CowFrame {
    const f: CowFrame = { id: this.nextFrame++, value, refs: 0 };
    this.frames.set(f.id, f);
    return f;
  }

  spawn(name: string, pages: readonly string[]): CowProc {
    const p: CowProc = { pid: this.nextPid++, name, ptes: new Map(), alive: true };
    pages.forEach((v, vpn) => { const f = this.alloc(v); f.refs = 1; p.ptes.set(vpn, { frame: f.id, writable: true }); });
    this.procs.push(p);
    return p;
  }

  fork(parent: CowProc, name = "child"): CowProc {
    const child: CowProc = { pid: this.nextPid++, name, ptes: new Map(), alive: true };
    for (const [vpn, pte] of parent.ptes) {
      pte.writable = false;  // both sides fault on the next write
      child.ptes.set(vpn, { frame: pte.frame, writable: false });
      this.frames.get(pte.frame)!.refs++;
      this.stats.ptesCopied++;
    }
    this.stats.forks++;
    this.procs.push(child);
    return child;
  }

  read(p: CowProc, vpn: number): string | null {
    const pte = p.ptes.get(vpn);
    return pte ? this.frames.get(pte.frame)!.value : null;
  }

  write(p: CowProc, vpn: number, value: string): WriteResult {
    const pte = p.ptes.get(vpn);
    if (!pte) return { kind: "unmapped" };
    const old = this.frames.get(pte.frame)!;
    if (pte.writable) { old.value = value; return { kind: "in-place", to: old.id }; }
    this.stats.faults++;
    if (old.refs === 1) {
      pte.writable = true;
      old.value = value;
      this.stats.reuses++;
      return { kind: "reuse", to: old.id };
    }
    const copy = this.alloc(old.value);
    copy.value = value;
    copy.refs = 1;
    old.refs--;
    pte.frame = copy.id;
    pte.writable = true;
    this.stats.copies++;
    return { kind: "copy", from: old.id, to: copy.id };
  }

  exit(p: CowProc) {
    for (const pte of p.ptes.values()) this.drop(pte.frame);
    p.ptes.clear();
    p.alive = false;
  }

  private drop(id: number) {
    const f = this.frames.get(id)!;
    if (--f.refs === 0) this.frames.delete(id);
  }

  /** What ksmd does: merge frames with equal contents into one shared read-only frame. Returns frames freed. */
  ksmMerge(): number {
    const byValue = new Map<string, CowFrame>();
    let freed = 0;
    for (const f of [...this.frames.values()]) {
      const keep = byValue.get(f.value);
      if (!keep) { byValue.set(f.value, f); continue; }
      for (const p of this.procs) for (const pte of p.ptes.values()) {
        if (pte.frame === f.id) { pte.frame = keep.id; pte.writable = false; keep.refs++; f.refs--; }
        else if (pte.frame === keep.id) pte.writable = false;
      }
      this.frames.delete(f.id);
      freed++;
      this.stats.merges++;
    }
    return freed;
  }

  /** For each frame, the number of page table entries that map it. */
  mappers(): Map<number, number> {
    const m = new Map<number, number>();
    for (const p of this.procs) for (const pte of p.ptes.values()) m.set(pte.frame, (m.get(pte.frame) ?? 0) + 1);
    return m;
  }

  usedFrames() { return this.frames.size; }
}

// ---------------- The cost of fork and of the first write ----------------

/** Model inputs for the cost of a COW fault. These are round numbers, not measurements. */
export const COW_COSTS = {
  /** Enter the kernel, find the VMA, take locks, return to user space. */
  faultNs: 1000,
  /** Copy speed of memcpy for a whole page. */
  copyGiBps: 10,
  /** An ordinary store to a page that is writable and in the TLB. */
  storeNs: 1,
} as const;

/** One COW write fault that copies a page of `pageBytes`. */
export function firstWriteNs(pageBytes: number, c = COW_COSTS) {
  return c.faultNs + (pageBytes / (c.copyGiBps * 2 ** 30)) * 1e9;
}

/** Page table bytes that fork() copies for `memBytes` of 4 KiB-mapped private memory: 8 bytes per PTE. */
export const forkPteBytes = (memBytes: number, pageBytes = 4096) => (memBytes / pageBytes) * 8;

// ---------------- A snapshot process: the Redis BGSAVE pattern ----------------

export interface SnapshotInput {
  datasetBytes: number;
  /** Writes per second to the parent. Each write dirties one page. */
  writesPerSec: number;
  /** Model input: how fast the child writes the snapshot to disk. */
  diskBytesPerSec: number;
  pageBytes: number;
  /** Share of the writes that go to the hot pages (0 = uniform writes). */
  hotWrites: number;
  /** Share of the pages that are hot. */
  hotPages: number;
}

export const SNAPSHOT_DEFAULTS: SnapshotInput = {
  datasetBytes: 16 * 2 ** 30, writesPerSec: 10000, diskBytesPerSec: 200 * 2 ** 20, pageBytes: 4096, hotWrites: 0, hotPages: 0.1,
};

/** Expected distinct pages hit by `w` uniform writes on `d` pages: d * (1 - (1 - 1/d)^w). */
export const distinctTouched = (d: number, w: number) => (d <= 0 ? 0 : d * -Math.expm1(w * Math.log1p(-1 / Math.max(d, 1.0000001))));

export interface SnapshotResult { seconds: number; writes: number; pages: number; copiedPages: number; extraBytes: number; extraShare: number }

export function snapshotExtra(o: SnapshotInput): SnapshotResult {
  const seconds = o.datasetBytes / o.diskBytesPerSec;
  const writes = o.writesPerSec * seconds;
  const pages = o.datasetBytes / o.pageBytes;
  let copied: number;
  if (o.hotWrites <= 0) copied = distinctTouched(pages, writes);
  else {
    const hot = pages * o.hotPages;
    copied = distinctTouched(hot, writes * o.hotWrites) + distinctTouched(pages - hot, writes * (1 - o.hotWrites));
  }
  return { seconds, writes, pages, copiedPages: copied, extraBytes: copied * o.pageBytes, extraShare: copied / pages };
}

/** Run the same snapshot on a real CowMemory, for a cross-check of the formula. Returns the frames added. */
export function snapshotOnCow(pages: number, writes: number, rnd: () => number): number {
  const m = new CowMemory();
  const parent = m.spawn("parent", Array.from({ length: pages }, (_, i) => `v${i}`));
  m.fork(parent);
  const before = m.usedFrames();
  for (let i = 0; i < writes; i++) m.write(parent, Math.floor(rnd() * pages), `w${i}`);
  return m.usedFrames() - before;
}
