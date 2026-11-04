/**
 * The VMA set of one address space. A VMA (virtual memory area, vm_area_struct in Linux) is a range of
 * addresses with one set of rights and one backing store. Linux stores VMAs in a maple tree since 6.1
 * and used a red-black tree before that. This reference uses a sorted array with binary search: the
 * lookup has the same meaning and the same O(log n) cost, and the code stays short.
 */
import { PAGE_SIZE } from "./addr";

export interface VmaFile { name: string; /** Byte offset of vma.start in the file. */ offset: number }

export interface Vma {
  start: number;
  /** exclusive */
  end: number;
  read: boolean;
  write: boolean;
  exec: boolean;
  /** MAP_SHARED: writes reach the file or the other mappers. Otherwise private and copy-on-write. */
  shared: boolean;
  file?: VmaFile;
  /** VM_GROWSDOWN: a fault just below the start extends this VMA. */
  growsDown?: boolean;
  /** Label for views: [heap], [stack], libc. */
  name?: string;
}

export const vmaPerms = (v: Vma) => `${v.read ? "r" : "-"}${v.write ? "w" : "-"}${v.exec ? "x" : "-"}${v.shared ? "s" : "p"}`;
export const vmaLabel = (v: Vma) => v.name ?? v.file?.name ?? "anonymous";

const sameBacking = (a: Vma, b: Vma) =>
  a.read === b.read && a.write === b.write && a.exec === b.exec && a.shared === b.shared && !a.growsDown && !b.growsDown && a.name === b.name &&
  (a.file === undefined && b.file === undefined || (a.file !== undefined && b.file !== undefined && a.file.name === b.file.name && a.file.offset + (a.end - a.start) === b.file.offset));

export class VmaTree {
  /** Sorted by start; ranges never overlap. */
  private list: Vma[] = [];

  get all(): readonly Vma[] { return this.list; }
  get count() { return this.list.length; }
  get mappedBytes() { return this.list.reduce((a, v) => a + (v.end - v.start), 0); }

  /** The index of the first VMA whose end is above addr. */
  private lowerBound(addr: number): number {
    let lo = 0, hi = this.list.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.list[m]!.end > addr) hi = m; else lo = m + 1;
    }
    return lo;
  }

  /** The kernel's find_vma: the first VMA that ends above addr. It can start above addr. */
  findFirstAfter(addr: number): Vma | undefined { return this.list[this.lowerBound(addr)]; }

  /** The VMA that contains addr, or undefined. */
  find(addr: number): Vma | undefined {
    const v = this.findFirstAfter(addr);
    return v && v.start <= addr ? v : undefined;
  }

  /** Inserts a page-aligned range. Throws on overlap. Merges with neighbours that have the same backing, as the kernel does. */
  insert(v: Vma): Vma {
    if (v.start % PAGE_SIZE || v.end % PAGE_SIZE || v.start >= v.end) throw new Error("VMA range is not page aligned");
    const i = this.lowerBound(v.start);
    const next = this.list[i];
    if (next && next.start < v.end) throw new Error("VMA overlaps an existing VMA");
    this.list.splice(i, 0, { ...v, file: v.file && { ...v.file } });
    return this.mergeAround(i);
  }

  private mergeAround(i: number): Vma {
    let at = i;
    const nx = this.list[at + 1];
    if (nx && this.list[at]!.end === nx.start && sameBacking(this.list[at]!, nx)) { this.list[at]!.end = nx.end; this.list.splice(at + 1, 1); }
    const pv = this.list[at - 1];
    if (pv && pv.end === this.list[at]!.start && sameBacking(pv, this.list[at]!)) { pv.end = this.list[at]!.end; this.list.splice(at, 1); at--; }
    return this.list[at]!;
  }

  /** The part of v in [from, to). */
  private slice(v: Vma, from: number, to: number): Vma {
    return { ...v, start: from, end: to, file: v.file && { name: v.file.name, offset: v.file.offset + (from - v.start) } };
  }

  /** Removes [start, end), splitting VMAs at the edges as munmap does. Returns the bytes removed. */
  remove(start: number, end: number): number {
    let removed = 0;
    let i = this.lowerBound(start);
    while (i < this.list.length && this.list[i]!.start < end) {
      const v = this.list[i]!;
      const lo = Math.max(v.start, start), hi = Math.min(v.end, end);
      removed += hi - lo;
      const parts: Vma[] = [];
      if (v.start < lo) parts.push(this.slice(v, v.start, lo));
      if (hi < v.end) parts.push(this.slice(v, hi, v.end));
      this.list.splice(i, 1, ...parts);
      i += parts.length;
    }
    return removed;
  }

  /** Changes rights on [start, end), splitting at the edges as mprotect does. */
  protect(start: number, end: number, perms: { read: boolean; write: boolean; exec: boolean }) {
    const touched: Vma[] = [];
    for (const v of [...this.list]) {
      if (v.end <= start || v.start >= end) continue;
      touched.push(this.slice(v, Math.max(v.start, start), Math.min(v.end, end)));
    }
    this.remove(start, end);
    for (const t of touched) this.insert({ ...t, ...perms });
  }

  /** Extends a growsDown VMA down to newStart, keeping it page aligned. */
  growDown(v: Vma, newStart: number) {
    const inTree = this.list.find((x) => x.start === v.start)!;
    inTree.start = newStart;
  }

  clone(): VmaTree {
    const t = new VmaTree();
    t.list = this.list.map((v) => ({ ...v, file: v.file && { ...v.file } }));
    return t;
  }
}
