/**
 * Address arithmetic for x86-64 paging: constants, canonical checks, field splitting, and the size
 * formulas that the lessons quote. Virtual addresses are bigint because the kernel half needs all 64 bits.
 */

export const KiB = 1024;
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const TiB = 1024 ** 4;
export const PiB = 1024 ** 5;
export const EiB = 1024 ** 6;

export const PAGE_SHIFT = 12;
export const PAGE_SIZE = 1 << PAGE_SHIFT;
/** One page table entry is 8 bytes on x86-64. */
export const PTE_BYTES = 8;
/** Each level consumes 9 bits, because a 4 KiB table holds 4096 / 8 = 512 entries. */
export const LEVEL_BITS = 9;
export const ENTRIES_PER_TABLE = 1 << LEVEL_BITS;
export const SIZE_2M = 2 * MiB;
export const SIZE_1G = GiB;

export type Levels = 4 | 5;
export const LEVEL_NAMES: Record<Levels, readonly string[]> = {
  4: ["PML4", "PDPT", "PD", "PT"],
  5: ["PML5", "PML4", "PDPT", "PD", "PT"],
};

/** Implemented virtual address bits: 48 with 4-level paging, 57 with 5-level paging (LA57). */
export const vaBits = (levels: Levels = 4) => PAGE_SHIFT + LEVEL_BITS * levels;
/** Bytes of one half of the address space, which is the part that user space gets. */
export const userHalfBytes = (levels: Levels = 4) => 2 ** (vaBits(levels) - 1);
/** Bytes between the canonical halves: everything in 2^64 that the implemented bits cannot name. */
export const holeBytes = (levels: Levels = 4) => 2 ** 64 - 2 ** vaBits(levels);

const U64 = (1n << 64n) - 1n;
export const toU64 = (va: bigint | number) => BigInt(va) & U64;

/** True when bits 63 down to the top implemented bit are all equal. */
export function isCanonical(va: bigint | number, levels: Levels = 4): boolean {
  const v = toU64(va);
  const top = v >> BigInt(vaBits(levels) - 1);
  return top === 0n || top === (U64 >> BigInt(vaBits(levels) - 1));
}

/** Sign-extends from the top implemented bit, which makes any value canonical. */
export function canonicalize(va: bigint | number, levels: Levels = 4): bigint {
  const b = BigInt(vaBits(levels));
  const low = toU64(va) & ((1n << b) - 1n);
  return (low >> (b - 1n)) === 1n ? low | (U64 ^ ((1n << b) - 1n)) : low;
}

export interface VaFields {
  va: bigint;
  /** One 9-bit index per level, top level first. */
  indices: number[];
  /** The low 12 bits. */
  offset: number;
  canonical: boolean;
}

export function splitVa(va: bigint | number, levels: Levels = 4): VaFields {
  const v = toU64(va);
  const indices: number[] = [];
  for (let l = 0; l < levels; l++) {
    const shift = BigInt(PAGE_SHIFT + LEVEL_BITS * (levels - 1 - l));
    indices.push(Number((v >> shift) & 0x1ffn));
  }
  return { va: v, indices, offset: Number(v & 0xfffn), canonical: isCanonical(v, levels) };
}

/** The inverse of splitVa: indices (top first) and an offset back into a canonical address. */
export function joinVa(indices: readonly number[], offset = 0, levels: Levels = 4): bigint {
  let v = 0n;
  for (const i of indices) v = (v << BigInt(LEVEL_BITS)) | BigInt(i & 0x1ff);
  return canonicalize((v << BigInt(PAGE_SHIFT)) | BigInt(offset & 0xfff), levels);
}

/** "0x0000_7fff_ffff_f000": 16 hex digits with a separator every 4. */
export function hexVa(va: bigint | number): string {
  return `0x${toU64(va).toString(16).padStart(16, "0").replace(/(.{4})(?=.)/g, "$1_")}`;
}

/** Short hex with no padding, as /proc/pid/maps and debuggers print it. */
export const hexShort = (va: bigint | number) => toU64(va).toString(16);

/** Parses hex with an optional 0x prefix and optional underscores; null when it is not a 64-bit number. */
export function parseVa(s: string): bigint | null {
  const t = s.trim().replace(/_/g, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,16}$/.test(t)) return null;
  return BigInt(`0x${t}`);
}

/** Bytes that one entry maps at a given level, counting from the leaf: 0 = PT (4 KiB), 1 = PD (2 MiB), 2 = PDPT (1 GiB)... */
export const entrySpan = (fromLeaf: number) => 2 ** (PAGE_SHIFT + LEVEL_BITS * fromLeaf);

/** Bytes for a flat table with one entry per virtual page. */
export const flatTableBytes = (bits: number, pageShift = PAGE_SHIFT, pteBytes = PTE_BYTES) => 2 ** (bits - pageShift) * pteBytes;

/** Bytes for a radix tree with every table present. */
export function fullTreeBytes(levels: Levels = 4): number {
  let tables = 0;
  for (let l = 0; l < levels; l++) tables += ENTRIES_PER_TABLE ** l;
  return tables * PAGE_SIZE;
}

/** Memory reads for one TLB miss under nested paging: each guest level and the final address need a host walk. */
export const nestedWalkReads = (guest: number, host: number) => (guest + 1) * (host + 1) - 1;

export interface Granule {
  pageSize: number;
  pageShift: number;
  /** Bits per level: the table is one page of 8-byte entries. */
  bitsPerLevel: number;
  entries: number;
  /** Size of the first block (huge) mapping: one last-level table's worth. */
  blockSize: number;
}

/** arm64 translation granules: 4 KiB, 16 KiB or 64 KiB. x86-64 is the 4 KiB case. */
export function granule(pageSize: number): Granule {
  const pageShift = Math.log2(pageSize);
  const bitsPerLevel = pageShift - 3;
  return { pageSize, pageShift, bitsPerLevel, entries: 2 ** bitsPerLevel, blockSize: 2 ** (pageShift + bitsPerLevel) };
}

/** Virtual address bits that a granule covers with this many levels. */
export const granuleVaBits = (pageSize: number, levels: number) => {
  const g = granule(pageSize);
  return g.pageShift + g.bitsPerLevel * levels;
};

/** Binary size text up to EiB: 128 TiB, 16 EiB. */
export function fmtBytes(v: number, digits = 3): string {
  const units: [number, string][] = [[EiB, "EiB"], [PiB, "PiB"], [TiB, "TiB"], [GiB, "GiB"], [MiB, "MiB"], [KiB, "KiB"]];
  for (const [f, u] of units) if (v >= f) return `${Number((v / f).toPrecision(digits))} ${u}`;
  return `${Math.round(v)} B`;
}
