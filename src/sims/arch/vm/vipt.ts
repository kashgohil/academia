/**
 * Where translation sits next to the L1 cache: the bit geometry of a virtually indexed, physically tagged
 * (VIPT) cache, the alias rule (way size must not exceed the page size), the hit latency of PIPT, VIPT and
 * VIVT organizations, and a tiny cache that shows the synonym bug step by step.
 *
 * Cycle counts in LATENCY_MODEL are MODEL INPUTS, not measurements of a real core.
 */

export const log2 = (n: number) => Math.round(Math.log2(n));
export const isPow2 = (n: number) => n > 0 && (n & (n - 1)) === 0;

export interface CacheGeometry {
  sizeBytes: number;
  ways: number;
  lineBytes: number;
  pageBytes: number;
  sets: number;
  /** Bytes in one way: sets times line size. */
  wayBytes: number;
  /** Bits that select a byte in a line. */
  offsetBits: number;
  /** Bits that select a set. */
  indexBits: number;
  /** Bits that the TLB does not translate. */
  pageOffsetBits: number;
  /** Index bits above the page offset. They come from the virtual page number. 0 means no aliases. */
  aliasBits: number;
  /** Number of page colors: 2 to the alias bits. A physical line can sit in this many different sets. */
  colors: number;
  /** The largest VIPT cache with this page size and associativity that has no aliases. */
  maxAliasFreeBytes: number;
  /** The fewest ways that make this size alias-free with this page size. */
  minWaysAliasFree: number;
}

export function cacheGeometry(sizeBytes: number, ways: number, lineBytes: number, pageBytes: number): CacheGeometry {
  for (const [n, v] of [["line", lineBytes], ["page", pageBytes]] as const) if (!isPow2(v)) throw new Error(`${n} must be a power of two`);
  const wayBytes = sizeBytes / ways;
  if (!Number.isInteger(wayBytes) || !isPow2(wayBytes) || wayBytes < lineBytes) throw new Error("size / ways must be a power of two of at least one line");
  const sets = wayBytes / lineBytes;
  const offsetBits = log2(lineBytes);
  const indexBits = log2(sets);
  const pageOffsetBits = log2(pageBytes);
  const aliasBits = Math.max(0, offsetBits + indexBits - pageOffsetBits);
  return {
    sizeBytes, ways, lineBytes, pageBytes, sets, wayBytes, offsetBits, indexBits, pageOffsetBits, aliasBits,
    colors: 2 ** aliasBits,
    maxAliasFreeBytes: ways * pageBytes,
    minWaysAliasFree: Math.max(1, Math.ceil(sizeBytes / pageBytes)),
  };
}

/** Real L1 data caches that the lesson names. Each one has a source in the lesson; ways null = not published. */
export const REAL_L1D = [
  { core: "AMD Zen 3", sizeBytes: 32 * 1024, ways: 8, lineBytes: 64, pageBytes: 4096, source: "AMD 56665, section 2.6.2" },
  { core: "Intel Sunny Cove", sizeBytes: 48 * 1024, ways: 12, lineBytes: 64, pageBytes: 4096, source: "Ice Lake core" },
  { core: "Apple M4 Pro P-core", sizeBytes: 128 * 1024, ways: null, lineBytes: 128, pageBytes: 16384, source: "sysctl hw.perflevel0.l1dcachesize" },
] as const;

// ---------------------------------------------------------------- hit latency

export type Org = "pipt" | "vipt" | "vivt";

/** MODEL INPUTS: cycles for each part of an L1 hit. */
export const LATENCY_MODEL = { tlb: 1, index: 2, compare: 1 };

export interface HitTiming {
  org: Org;
  /** [start, end) in cycles for each part, for a timing diagram. */
  parts: { name: "TLB" | "Read the set" | "Compare tags"; start: number; end: number }[];
  total: number;
}

/**
 * Cycles for an L1 hit. PIPT: the TLB must finish before the set read starts. VIPT: the TLB and the set read
 * run in parallel, and the tag compare waits for both. VIVT: no TLB on a hit.
 */
export function hitTiming(org: Org, m = LATENCY_MODEL): HitTiming {
  const parts: HitTiming["parts"] = [];
  if (org === "pipt") {
    parts.push({ name: "TLB", start: 0, end: m.tlb }, { name: "Read the set", start: m.tlb, end: m.tlb + m.index });
  } else if (org === "vipt") {
    parts.push({ name: "TLB", start: 0, end: m.tlb }, { name: "Read the set", start: 0, end: m.index });
  } else {
    parts.push({ name: "Read the set", start: 0, end: m.index });
  }
  const ready = Math.max(...parts.map((p) => p.end));
  parts.push({ name: "Compare tags", start: ready, end: ready + m.compare });
  return { org, parts, total: ready + m.compare };
}

// ---------------------------------------------------------------- the synonym bug, step by step

export type AliasOrg = "vipt" | "vipt-probe" | "pipt";

export interface AliasLine { valid: boolean; tag: number; dirty: boolean; value: number; lastUsed: number }

export interface AliasOp { kind: "load" | "store" | "flush"; va?: number; value?: number }

export interface AliasResult {
  op: AliasOp;
  pa?: number;
  set?: number;
  hit?: boolean;
  /** Value that the load returned. */
  value?: number;
  /** Value that a coherent memory would return: the last value stored to this physical address. */
  truth?: number;
  stale?: boolean;
  /** Sets that the alias probe searched and the line that it moved, for vipt-probe. */
  probed?: number[];
  movedFrom?: number;
  note: string;
}

/**
 * A small write-back data cache with one word per line, enough to show synonyms. Two virtual pages can map
 * to one physical frame. "vipt" indexes with virtual address bits, so the two names can use two sets.
 * "vipt-probe" does the same, but on a miss it searches the other colors for the physical tag and moves the
 * line, as some cores do in hardware. "pipt" indexes with the physical address.
 */
export class AliasCache {
  readonly geo: CacheGeometry;
  readonly lines: AliasLine[][];
  readonly memory = new Map<number, number>();
  private truth = new Map<number, number>();
  private clock = 0;
  readonly log: AliasResult[] = [];

  constructor(readonly org: AliasOrg, readonly pageMap: Map<number, number>, geo: CacheGeometry) {
    this.geo = geo;
    this.lines = Array.from({ length: geo.sets }, () => Array.from({ length: geo.ways }, () => ({ valid: false, tag: 0, dirty: false, value: 0, lastUsed: 0 })));
  }

  translate(va: number): number {
    const vpn = Math.floor(va / this.geo.pageBytes);
    const pfn = this.pageMap.get(vpn);
    if (pfn === undefined) throw new Error(`no mapping for page 0x${vpn.toString(16)}`);
    return pfn * this.geo.pageBytes + (va % this.geo.pageBytes);
  }
  setOf(addr: number) { return Math.floor(addr / this.geo.lineBytes) % this.geo.sets; }
  /** Physical tag: the line address above the index bits... kept whole here, which is simpler and equivalent. */
  private tagOf(pa: number) { return Math.floor(pa / this.geo.lineBytes); }
  private lineBase(tag: number) { return tag * this.geo.lineBytes; }

  private find(set: number, tag: number) { return this.lines[set]!.findIndex((l) => l.valid && l.tag === tag); }
  private writeBack(l: AliasLine) { if (l.valid && l.dirty) { this.memory.set(this.lineBase(l.tag), l.value); l.dirty = false; } }

  /** Puts a line in a set with LRU replacement and returns the way. */
  private fill(set: number, tag: number, value: number, dirty: boolean): number {
    const ways = this.lines[set]!;
    let w = ways.findIndex((l) => !l.valid);
    if (w < 0) { w = 0; for (let i = 1; i < ways.length; i++) if (ways[i]!.lastUsed < ways[w]!.lastUsed) w = i; this.writeBack(ways[w]!); }
    ways[w] = { valid: true, tag, dirty, value, lastUsed: ++this.clock };
    return w;
  }

  /** The other sets where the same physical line could sit under another color. */
  colorSets(set: number): number[] {
    const sets: number[] = [];
    const inPage = this.geo.pageBytes / this.geo.lineBytes;
    const low = set % inPage;
    for (let c = 0; c < this.geo.colors; c++) sets.push(low + c * inPage);
    return sets;
  }

  run(op: AliasOp): AliasResult {
    let r: AliasResult;
    if (op.kind === "flush") {
      let n = 0;
      for (const set of this.lines) for (const l of set) { if (l.valid && l.dirty) n++; this.writeBack(l); l.valid = false; }
      r = { op, note: `Flush: ${n} dirty line${n === 1 ? "" : "s"} written back, and every line invalidated.` };
    } else {
      const va = op.va!;
      const pa = this.translate(va);
      const tag = this.tagOf(pa);
      const set = this.setOf(this.org === "pipt" ? pa : va);
      let w = this.find(set, tag);
      const hit = w >= 0;
      let probed: number[] | undefined;
      let movedFrom: number | undefined;
      if (!hit && this.org === "vipt-probe") {
        probed = this.colorSets(set).filter((s) => s !== set);
        for (const s of probed) {
          const k = this.find(s, tag);
          if (k >= 0) {
            const old = this.lines[s]![k]!;
            w = this.fill(set, tag, old.value, old.dirty);
            old.valid = false;
            movedFrom = s;
            break;
          }
        }
      }
      if (w < 0) w = this.fill(set, tag, this.memory.get(this.lineBase(tag)) ?? 0, false);
      const line = this.lines[set]![w]!;
      line.lastUsed = ++this.clock;
      if (op.kind === "store") {
        line.value = op.value!;
        line.dirty = true;
        this.truth.set(pa, op.value!);
        r = { op, pa, set, hit, probed, movedFrom, note: `Store ${op.value} to set ${set}${hit ? " (hit)" : movedFrom !== undefined ? ` (line moved from set ${movedFrom})` : " (miss: line filled from memory)"}.` };
      } else {
        const truth = this.truth.get(pa) ?? 0;
        const stale = line.value !== truth;
        r = { op, pa, set, hit, value: line.value, truth, stale, probed, movedFrom, note: stale ? `Load from set ${set} returns ${line.value}, but the last store to this physical address wrote ${truth}.` : `Load from set ${set} returns ${line.value}${hit ? " (hit)" : movedFrom !== undefined ? ` (the probe found the line in set ${movedFrom})` : " (miss)"}.` };
      }
    }
    this.log.push(r);
    return r;
  }
}

/** The standard scene for the synonym demo: a 16 KiB, 2-way cache with 64-byte lines and 4 KiB pages. */
export const ALIAS_SCENE = {
  sizeBytes: 16 * 1024, ways: 2, lineBytes: 64, pageBytes: 4096,
  /** Page A and the frame that both names share. */
  vpnA: 0x10, pfn: 0x80,
  /** Two choices for the second name: same color as A, or the other color. */
  vpnBSame: 0x22, vpnBOther: 0x23,
  offset: 0x40,
};

export function aliasScene(org: AliasOrg, sameColor: boolean) {
  const s = ALIAS_SCENE;
  const vpnB = sameColor ? s.vpnBSame : s.vpnBOther;
  const map = new Map([[s.vpnA, s.pfn], [vpnB, s.pfn]]);
  const cache = new AliasCache(org, map, cacheGeometry(s.sizeBytes, s.ways, s.lineBytes, s.pageBytes));
  return { cache, vaA: s.vpnA * s.pageBytes + s.offset, vaB: vpnB * s.pageBytes + s.offset, pa: s.pfn * s.pageBytes + s.offset };
}

/** The scripted sequence in the demo: write through A, read through B, write through B, read through A. */
export const ALIAS_SCRIPT = (vaA: number, vaB: number): AliasOp[] => [
  { kind: "store", va: vaA, value: 1 },
  { kind: "load", va: vaB },
  { kind: "store", va: vaB, value: 2 },
  { kind: "load", va: vaA },
];
