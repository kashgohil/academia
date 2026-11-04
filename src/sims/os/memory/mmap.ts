/**
 * mmap with a page cache. One file, its page cache, and processes with shared or private mappings.
 *
 * - The file's disk blocks hold the durable values.
 * - The page cache holds at most one copy of each file page, with a dirty bit. read(), write(), and every
 *   MAP_SHARED mapping use that same copy.
 * - A MAP_PRIVATE mapping maps the page cache page read-only. Its first store copies the page into an anonymous frame,
 *   and from then on the process no longer sees the file for that page.
 * - Writeback copies dirty cache pages to disk. A store to a private copy never reaches the file.
 * - Truncate removes cache pages and every mapping of them, private copies too (even_cows = 1 in
 *   unmap_mapping_range). A later access past the new end raises SIGBUS.
 */

export type MapMode = "shared" | "private";

export interface CachePage { value: string; dirty: boolean }

export type Pte = { kind: "cache" } | { kind: "anon"; value: string };

export interface Mapping { name: string; mode: MapMode; ptes: Map<number, Pte> }

export type FaultKind = "none" | "minor" | "major" | "cow";

export type AccessResult =
  | { ok: true; value: string; fault: FaultKind }
  | { ok: false; signal: "SIGBUS" };

export interface MmapStats { minor: number; major: number; cow: number; diskReads: number; diskWrites: number; shootdowns: number }

export class MappedFile {
  disk: (string | null)[];
  cache = new Map<number, CachePage>();
  maps: Mapping[] = [];
  stats: MmapStats = { minor: 0, major: 0, cow: 0, diskReads: 0, diskWrites: 0, shootdowns: 0 };

  constructor(initial: readonly string[]) { this.disk = [...initial]; }

  get pages() { return this.disk.length; }

  map(name: string, mode: MapMode): Mapping {
    const m: Mapping = { name, mode, ptes: new Map() };
    this.maps.push(m);
    return m;
  }

  /** Brings a file page into the cache. Returns true if it needed a disk read. */
  private fill(page: number): boolean {
    if (this.cache.has(page)) return false;
    this.cache.set(page, { value: this.disk[page]!, dirty: false });
    this.stats.diskReads++;
    return true;
  }

  load(m: Mapping, page: number): AccessResult {
    if (page >= this.pages) return { ok: false, signal: "SIGBUS" };
    const pte = m.ptes.get(page);
    if (pte?.kind === "anon") return { ok: true, value: pte.value, fault: "none" };
    if (pte) return { ok: true, value: this.cache.get(page)!.value, fault: "none" };
    const major = this.fill(page);
    if (major) this.stats.major++; else this.stats.minor++;
    m.ptes.set(page, { kind: "cache" });
    return { ok: true, value: this.cache.get(page)!.value, fault: major ? "major" : "minor" };
  }

  store(m: Mapping, page: number, value: string): AccessResult {
    if (page >= this.pages) return { ok: false, signal: "SIGBUS" };
    const pte = m.ptes.get(page);
    if (m.mode === "shared") {
      let fault: FaultKind = "none";
      if (!pte) {
        const major = this.fill(page);
        fault = major ? "major" : "minor";
        if (major) this.stats.major++; else this.stats.minor++;
        m.ptes.set(page, { kind: "cache" });
      }
      const c = this.cache.get(page)!;
      c.value = value;
      c.dirty = true;
      return { ok: true, value, fault };
    }
    if (pte?.kind === "anon") { pte.value = value; return { ok: true, value, fault: "none" }; }
    if (!pte) { if (this.fill(page)) this.stats.major++; }
    m.ptes.set(page, { kind: "anon", value });
    this.stats.cow++;
    return { ok: true, value, fault: "cow" };
  }

  /** read(2): copies from the page cache to a user buffer. */
  sysRead(page: number): string | null {
    if (page >= this.pages) return null;
    this.fill(page);
    return this.cache.get(page)!.value;
  }

  /** write(2): copies from a user buffer into the page cache. */
  sysWrite(page: number, value: string) {
    if (page >= this.pages) return;
    this.fill(page);
    const c = this.cache.get(page)!;
    c.value = value;
    c.dirty = true;
  }

  /** msync(MS_SYNC) or kernel writeback: dirty cache pages go to disk and stay cached. Returns pages written. */
  writeback(): number {
    let n = 0;
    for (const [page, c] of this.cache) if (c.dirty) { this.disk[page] = c.value; c.dirty = false; n++; }
    this.stats.diskWrites += n;
    return n;
  }

  /** Evicts a clean page: unmaps it from every process (a TLB shootdown for each) and drops it. */
  evict(page: number): boolean {
    const c = this.cache.get(page);
    if (!c) return false;
    if (c.dirty) { this.disk[page] = c.value; c.dirty = false; this.stats.diskWrites++; }
    for (const m of this.maps) if (m.ptes.get(page)?.kind === "cache") { m.ptes.delete(page); this.stats.shootdowns++; }
    this.cache.delete(page);
    return true;
  }

  truncate(pages: number) {
    for (const page of [...this.cache.keys()]) if (page >= pages) this.cache.delete(page);
    for (const m of this.maps) for (const page of [...m.ptes.keys()]) if (page >= pages) { m.ptes.delete(page); this.stats.shootdowns++; }
    this.disk.length = pages;
  }
}

// ---------------- SIGBUS and SIGSEGV ----------------

export type ByteAccess = "data" | "tail-zero" | "sigbus" | "sigsegv";

/**
 * What one byte access does. The file has `fileBytes`; the mapping starts at offset 0 and has `mapBytes` (rounded up to
 * pages). Bytes after EOF in the last file page read as zero. A whole page past EOF raises SIGBUS. Past the
 * mapping is SIGSEGV (if nothing else is mapped there).
 */
export function classifyAccess(offset: number, fileBytes: number, mapBytes: number, pageBytes = 4096): ByteAccess {
  const mapEnd = Math.ceil(mapBytes / pageBytes) * pageBytes;
  if (offset >= mapEnd) return "sigsegv";
  if (offset < fileBytes) return "data";
  const lastFilePageEnd = Math.ceil(fileBytes / pageBytes) * pageBytes;
  return offset < lastFilePageEnd ? "tail-zero" : "sigbus";
}

// ---------------- read() vs mmap cost model ----------------

/** Every value here is a model input: a round number chosen for scale, not a measurement. */
export const MMAP_COSTS = {
  syscallNs: 150,
  copy4kNs: 400,
  /** Minor fault: enter the kernel, map a page that is already cached. */
  minorFaultNs: 600,
  /** fault_around_bytes defaults to 64 KiB, so a read fault can map 16 cached neighbours. */
  faultAroundPages: 16,
  /** Extra cost per mapped page in fault-around. */
  faultAroundPerPageNs: 40,
  tlbMissNs: 30,
  /** Device latency for one random read. */
  deviceReadNs: 80_000,
  /** Sequential readahead batches device reads. read_ahead_kb defaults to 128 KiB = 32 pages. */
  readaheadPages: 32,
  /** Base cost of a TLB shootdown, plus the cost per core that must be interrupted. */
  shootdownBaseNs: 1000,
  shootdownPerCoreNs: 800,
} as const;

export type AccessPattern = "seq" | "rand";

export interface CostInput {
  pattern: AccessPattern;
  /** Fraction of page visits that find the page in the page cache. */
  cachedShare: number;
  /** How many times a program touches each page while the page stays mapped or cached. */
  touches: number;
  /** Cores that run threads of this process and must see each shootdown. */
  cores: number;
}

export interface CostBreakdown { total: number; kernelEntry: number; copy: number; device: number; tlb: number; shootdown: number }

const deviceNsPerMiss = (p: AccessPattern, c = MMAP_COSTS) => (p === "seq" ? c.deviceReadNs / c.readaheadPages : c.deviceReadNs);

/** read(): every touch is a syscall and a copy. Misses add device time. Eviction of a page that nobody maps sends no IPIs. */
export function readCost(i: CostInput, c = MMAP_COSTS): CostBreakdown {
  const kernelEntry = c.syscallNs;
  const copy = c.copy4kNs;
  const device = ((1 - i.cachedShare) * deviceNsPerMiss(i.pattern, c)) / i.touches;
  return { total: kernelEntry + copy + device, kernelEntry, copy, device, tlb: 0, shootdown: 0 };
}

/** mmap: only the first touch of a page enters the kernel. Later touches cost nothing beyond TLB misses. */
export function mmapCost(i: CostInput, c = MMAP_COSTS): CostBreakdown {
  // Sequential: one fault maps the cached neighbours, so the fault cost is shared.
  const faultPerPage = i.pattern === "seq"
    ? c.minorFaultNs / c.faultAroundPages + c.faultAroundPerPageNs
    : c.minorFaultNs;
  const kernelEntry = faultPerPage / i.touches;
  const device = ((1 - i.cachedShare) * deviceNsPerMiss(i.pattern, c)) / i.touches;
  const tlb = i.pattern === "rand" ? c.tlbMissNs : c.tlbMissNs / 512;
  // A page miss in a full cache evicts a mapped page. Its PTE must go from every core's TLB.
  const shootdown = ((1 - i.cachedShare) * (c.shootdownBaseNs + c.shootdownPerCoreNs * Math.max(0, i.cores - 1))) / i.touches;
  return { total: kernelEntry + device + tlb + shootdown, kernelEntry, copy: 0, device, tlb, shootdown };
}

/** Time of one eviction's shootdown, per core count. */
export const shootdownNs = (cores: number, c = MMAP_COSTS) => c.shootdownBaseNs + c.shootdownPerCoreNs * Math.max(0, cores - 1);
