/**
 * DMA: the CPU cost of programmed I/O against DMA, scatter-gather lists, bounce buffers, cache coherence on
 * non-coherent systems, and an IOMMU that uses the real page table walker from src/sims/os/vm.
 *
 * DMA_MODEL holds MODEL INPUTS: round figures of the right size, not measurements.
 */
import { HDDS, SSD_NVME, SSD_SATA } from "../../db/storage/disk";
import { PAGE_SIZE, PageTable, TableMem, Tlb, DRAM_NS, vaNumber, type WalkEvent } from "../vm";
import { IRQ_MODEL } from "./interrupts";

export const DMA_MODEL = {
  /** One uncached MMIO read of a device data register. */
  mmioWordUs: 0.5,
  wordBytes: 4,
  /** dma_map, descriptors and the doorbell, for one transfer. */
  setupUs: 2,
  /** Each extra scatter-gather segment. */
  perSegmentUs: 0.1,
  /** The completion interrupt. It is the same input as the interrupts lesson. */
  irqUs: IRQ_MODEL.hardUs,
  /** Mapping and unmapping one page in the IOMMU page table. */
  iommuMapNs: 300,
  /** A strict IOTLB invalidation: command queue write and wait. */
  iotlbInvalidateNs: 2000,
  /** IOTLB entries. */
  iotlbEntries: 64,
  iotlbWays: 4,
} as const;

/** Device link speeds in MB/s, from the disk models. */
export const DMA_DEVICES = {
  hdd: { label: "7,200 rpm disk", mbps: HDDS["7200"].mbps },
  sata: { label: "SATA SSD", mbps: SSD_SATA.mbps },
  nvme: { label: "NVMe SSD", mbps: SSD_NVME.mbps },
} as const;
export type DmaDeviceId = keyof typeof DMA_DEVICES;

export interface XferInputs {
  mbps: number;
  mmioWordUs?: number;
  wordBytes?: number;
  setupUs?: number;
  irqUs?: number;
  perSegmentUs?: number;
}

export interface XferCost { cpuUs: number; elapsedUs: number; share: number }
export interface XferCompare { bytes: number; pio: XferCost; dma: XferCost; segments: number; cpuRatio: number }

/** PIO: the CPU moves each word and waits for the device. DMA: the CPU sets up, the device moves the data, an interrupt ends it. */
export function pioVsDma(bytes: number, i: XferInputs): XferCompare {
  const wordUs = i.mmioWordUs ?? DMA_MODEL.mmioWordUs, word = i.wordBytes ?? DMA_MODEL.wordBytes;
  const setup = i.setupUs ?? DMA_MODEL.setupUs, irq = i.irqUs ?? DMA_MODEL.irqUs, seg = i.perSegmentUs ?? DMA_MODEL.perSegmentUs;
  const wireUs = bytes / i.mbps; // 1 MB/s is 1 byte per microsecond
  const pioCpu = Math.ceil(bytes / word) * wordUs;
  const pioElapsed = Math.max(pioCpu, wireUs);
  const segments = Math.max(1, Math.ceil(bytes / PAGE_SIZE));
  const dmaCpu = setup + irq + (segments - 1) * seg;
  const dmaElapsed = dmaCpu + wireUs;
  return {
    bytes, segments,
    pio: { cpuUs: pioElapsed, elapsedUs: pioElapsed, share: 1 },
    dma: { cpuUs: dmaCpu, elapsedUs: dmaElapsed, share: dmaCpu / dmaElapsed },
    cpuRatio: pioElapsed / dmaCpu,
  };
}

/** The smallest transfer, in words, for which DMA uses less CPU time than PIO. */
export function dmaCrossoverBytes(i: XferInputs): number {
  const word = i.wordBytes ?? DMA_MODEL.wordBytes;
  for (let n = 1; n < 1 << 24; n++) {
    const c = pioVsDma(n * word, i);
    if (c.dma.cpuUs < c.pio.cpuUs) return n * word;
  }
  return Infinity;
}

// ------------------------------------------------------------------- scatter-gather and bounce buffers

export interface SgEntry { addr: number; pages: number }

/** Merges physically adjacent pages. This is the list that a device without an IOMMU must follow. */
export function sgList(pfns: number[]): SgEntry[] {
  const out: SgEntry[] = [];
  for (const p of pfns) {
    const last = out[out.length - 1];
    if (last && last.addr + last.pages === p) last.pages++;
    else out.push({ addr: p, pages: 1 });
  }
  return out;
}

export interface DmaMapResult {
  /** Entries in the list that the device gets. */
  segments: SgEntry[];
  /** Pages that went through a bounce buffer. */
  bounced: number;
  bounceBytes: number;
  /** True when an IOMMU made the addresses contiguous. */
  viaIommu: boolean;
}

/**
 * dma_map_sg in three cases. With an IOMMU, all pages get one contiguous IOVA range. Without one, a page above the
 * device's DMA mask cannot be reached, so it is copied through a bounce buffer below the mask (swiotlb).
 */
export function dmaMapSg(pfns: number[], o: { iommu: boolean; maskBits: number; iovaBase?: number; bouncePfn?: number }): DmaMapResult {
  if (o.iommu) return { segments: [{ addr: o.iovaBase ?? 0x100, pages: pfns.length }], bounced: 0, bounceBytes: 0, viaIommu: true };
  const limitPfn = 2 ** (o.maskBits - 12);
  let bounce = o.bouncePfn ?? 0x8000;
  let bounced = 0;
  const reachable = pfns.map((p) => {
    if (p < limitPfn) return p;
    bounced++;
    return bounce++;
  });
  return { segments: sgList(reachable), bounced, bounceBytes: bounced * PAGE_SIZE, viaIommu: false };
}

/** Default size of the swiotlb pool. Real value. */
export const SWIOTLB_DEFAULT_BYTES = 64 * 1024 * 1024;

// ------------------------------------------------------------------- cache coherence with DMA

export type DmaDir = "to-device" | "from-device";

/**
 * One cache line and the memory behind it. On a non-coherent system the device reads and writes memory only and never
 * sees the cache. The dma_map, dma_unmap and dma_sync functions do the cache maintenance.
 */
export class DmaLine {
  readonly coherent: boolean;
  memory = "old";
  cache: string | null = null;
  dirty = false;
  owner: "cpu" | "device" = "cpu";
  readonly log: string[] = [];
  /** Reads that returned a value that is not the newest one. */
  staleReads = 0;
  private newest = "old";

  constructor(coherent: boolean) { this.coherent = coherent; }

  cpuWrite(v: string) {
    this.cache = v; this.dirty = true; this.newest = v;
    if (this.coherent) { this.memory = v; this.dirty = false; }
  }
  cpuRead(): string {
    if (this.cache === null) this.cache = this.memory;
    const v = this.coherent ? this.newest : this.cache;
    if (v !== this.newest) this.staleReads++;
    return v;
  }
  /** Clean: write dirty data to memory. Keep the line. */
  private clean() { if (this.dirty && this.cache !== null) { this.memory = this.cache; this.dirty = false; } }
  /** Invalidate: drop the line. A dirty line is written first, so that this model loses no CPU write by accident. */
  private invalidate() { this.clean(); this.cache = null; }

  /** dma_map_single or dma_sync_*_for_device: the buffer now belongs to the device. */
  mapForDevice(dir: DmaDir) {
    if (dir === "to-device") this.clean(); else this.invalidate();
    this.owner = "device";
  }
  /** dma_unmap_single or dma_sync_*_for_cpu: the buffer belongs to the CPU again. */
  mapForCpu(dir: DmaDir) {
    if (dir === "from-device") this.invalidate();
    this.owner = "cpu";
  }
  deviceRead(): string {
    const v = this.memory;
    if (v !== this.newest) this.staleReads++;
    return v;
  }
  deviceWrite(v: string) {
    this.memory = v; this.newest = v;
    if (this.coherent) this.cache = v;
  }
}

// ------------------------------------------------------------------- IOMMU

/** One step that the IOMMU took. */
export interface IommuResult {
  ok: boolean;
  /** The physical address, when ok. */
  pa?: number;
  iotlbHit: boolean;
  /** Table reads of this translation. */
  events: WalkEvent[];
  fault?: "no-domain" | "not-mapped" | "read-only";
  /** Time of the translation in the model. */
  ns: number;
}

export interface IommuFault { device: string; iova: number; kind: "r" | "w"; reason: NonNullable<IommuResult["fault"]> }

/**
 * An IOMMU. Each device attaches to a domain. Each domain has its own page table in the same radix format as the CPU,
 * which is true of the second-level tables in Intel VT-d and of the AMD IOMMU. A small IOTLB sits in front of the walk.
 */
export class Iommu {
  readonly mem = new TableMem(0x4000);
  readonly iotlb: Tlb;
  private domains = new Map<number, PageTable>();
  private attached = new Map<string, number>();
  private flushQueue: { domain: number; iova: number }[] = [];
  readonly faults: IommuFault[] = [];
  translations = 0;
  walks = 0;
  invalidations = 0;

  constructor(entries: number = DMA_MODEL.iotlbEntries, ways: number = DMA_MODEL.iotlbWays) {
    this.iotlb = new Tlb({ entries, ways });
  }

  private domain(id: number): PageTable {
    let pt = this.domains.get(id);
    if (!pt) { pt = new PageTable({ mem: this.mem }); this.domains.set(id, pt); }
    return pt;
  }

  attach(device: string, domain: number) { this.attached.set(device, domain); this.domain(domain); }

  /** The DMA API maps pages here, one page at a time. */
  map(domain: number, iova: number, pfn: number, opts: { write: boolean }) {
    this.domain(domain).map(iova, pfn, { writable: opts.write, user: true });
  }

  /** Strict: the IOTLB entry goes now. Lazy: it stays until flush(), which saves time and leaves a window. */
  unmap(domain: number, iova: number, mode: "strict" | "lazy" = "strict") {
    this.domain(domain).unmap(iova);
    if (mode === "strict") this.invalidate(domain, iova);
    else this.flushQueue.push({ domain, iova });
  }

  private invalidate(domain: number, iova: number) {
    this.iotlb.invalidatePage(vaNumber(BigInt(iova)), domain);
    this.invalidations++;
  }

  /** The deferred invalidation of a lazy unmap. Linux runs this from a timer or when the queue is full. */
  flush() {
    for (const f of this.flushQueue.splice(0)) this.invalidate(f.domain, f.iova);
  }
  get pendingFlush() { return this.flushQueue.length; }

  /** A device issues this address. */
  translate(device: string, iova: number, kind: "r" | "w"): IommuResult {
    this.translations++;
    const fail = (reason: NonNullable<IommuResult["fault"]>, events: WalkEvent[], iotlbHit: boolean, ns: number): IommuResult => {
      this.faults.push({ device, iova, kind, reason });
      return { ok: false, iotlbHit, events, fault: reason, ns };
    };
    const domain = this.attached.get(device);
    if (domain === undefined) return fail("no-domain", [], false, 0);
    const hit = this.iotlb.lookup(iova, domain);
    const offset = iova % PAGE_SIZE;
    if (hit) {
      if (kind === "w" && !hit.writable) return fail("read-only", [], true, 0);
      return { ok: true, pa: hit.pfn * PAGE_SIZE + offset, iotlbHit: true, events: [], ns: 0 };
    }
    this.walks++;
    const w = this.domain(domain).walk(iova, { kind, user: true }, { readOnly: true });
    const ns = w.events.length * DRAM_NS;
    if (!w.ok) return fail(w.fault?.reason === "protection" ? "read-only" : "not-mapped", w.events, false, ns);
    this.iotlb.insert(iova, w.pfn!, 12, domain, { writable: w.writable });
    return { ok: true, pa: Number(w.pa), iotlbHit: false, events: w.events, ns };
  }
}

/** IOTLB reach: how many bytes the entries cover. */
export const iotlbReach = (entries: number, pageBytes: number) => entries * pageBytes;

/** A device that cycles over `pages` buffers, as a NIC does with its ring. It returns the measured IOTLB hit rate. */
export function iotlbRun(pages: number, rounds = 4, entries: number = DMA_MODEL.iotlbEntries, ways: number = DMA_MODEL.iotlbWays): { hitRate: number; readsPerAccess: number; nsPerAccess: number } {
  const u = new Iommu(entries, ways);
  u.attach("nic", 1);
  for (let i = 0; i < pages; i++) u.map(1, 0x10000000 + i * PAGE_SIZE, 0x2000 + i, { write: true });
  // The first round fills the IOTLB. Measure the others.
  const access = () => { let ns = 0, reads = 0, hits = 0; for (let i = 0; i < pages; i++) { const r = u.translate("nic", 0x10000000 + i * PAGE_SIZE, "w"); ns += r.ns; reads += r.events.length; if (r.iotlbHit) hits++; } return { ns, reads, hits }; };
  access();
  let ns = 0, reads = 0, hits = 0;
  for (let k = 0; k < rounds; k++) { const a = access(); ns += a.ns; reads += a.reads; hits += a.hits; }
  const n = pages * rounds;
  return { hitRate: hits / n, readsPerAccess: reads / n, nsPerAccess: ns / n };
}

/** CPU cost of the IOMMU per 4 KiB I/O. Strict mode pays one invalidation for each unmap. */
export function iommuCpuPerIo(mode: "strict" | "lazy" | "passthrough"): number {
  if (mode === "passthrough") return 0;
  return 2 * DMA_MODEL.iommuMapNs + (mode === "strict" ? DMA_MODEL.iotlbInvalidateNs : 0);
}
/** The share of one CPU at `iops` I/O operations per second. */
export const iommuCpuShare = (iops: number, mode: "strict" | "lazy" | "passthrough") => (iops * iommuCpuPerIo(mode)) / 1e9;
