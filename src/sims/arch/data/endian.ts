/**
 * Byte order: how a multi-byte value is laid out at increasing addresses, the byte-swap and bit-reverse
 * instructions, decoding across a boundary, and the cost of an access that is not aligned.
 */

export type Order = "le" | "be";

/** The bytes of a w-bit value at increasing addresses. */
export function toBytes(x: bigint, bytes: number, order: Order): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) out.push(Number((x >> BigInt(8 * i)) & 0xffn));
  return order === "le" ? out : out.reverse();
}
export function fromBytes(b: ArrayLike<number>, offset: number, bytes: number, order: Order): bigint {
  let v = 0n;
  for (let i = 0; i < bytes; i++) {
    const byte = BigInt(b[offset + (order === "be" ? i : bytes - 1 - i)] ?? 0);
    v = (v << 8n) | byte;
  }
  return v;
}

/** The PDP-11 layout of a 32-bit value: the high 16-bit word first, each word little-endian. 0x0A0B0C0D → 0B 0A 0D 0C. */
export const pdp11Bytes = (x: bigint): number[] => [...toBytes((x >> 16n) & 0xffffn, 2, "le"), ...toBytes(x & 0xffffn, 2, "le")];

// ---------------------------------------------------------------- a struct in memory

export type FieldType = "u8" | "u16" | "u32" | "i32" | "u64" | "f32";
export interface StructField { name: string; type: FieldType; offset: number; size: number }
const SIZE: Record<FieldType, number> = { u8: 1, u16: 2, u32: 4, i32: 4, u64: 8, f32: 4 };

/**
 * A header struct with natural alignment and no padding:
 * struct Header { uint32_t magic; uint16_t version; uint8_t flags; uint8_t kind; uint64_t id; float ratio; int32_t delta; }
 */
export const HEADER: StructField[] = (() => {
  const spec: [string, FieldType][] = [["magic", "u32"], ["version", "u16"], ["flags", "u8"], ["kind", "u8"], ["id", "u64"], ["ratio", "f32"], ["delta", "i32"]];
  let off = 0;
  return spec.map(([name, type]) => {
    const size = SIZE[type];
    off = Math.ceil(off / size) * size;
    const f = { name, type, offset: off, size };
    off += size;
    return f;
  });
})();
export const structSize = (fs: StructField[]): number => Math.max(...fs.map((f) => f.offset + f.size));

/** The raw bits of a field value (floats as their binary32 bits, negative ints as two's complement). */
export function fieldBits(type: FieldType, v: number | bigint): bigint {
  if (type === "f32") { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, Number(v)); return BigInt(dv.getUint32(0)); }
  return BigInt.asUintN(8 * SIZE[type], BigInt(v));
}

export interface ByteCell { value: number; field: string; /** 0 = least significant byte of the field */ significance: number }
/** Lays the struct out in memory with one byte order. */
export function layout(fs: StructField[], values: Record<string, number | bigint>, order: Order): ByteCell[] {
  const out: ByteCell[] = Array.from({ length: structSize(fs) }, () => ({ value: 0, field: "pad", significance: 0 }));
  for (const f of fs) {
    const b = toBytes(fieldBits(f.type, values[f.name] ?? 0), f.size, order);
    b.forEach((v, i) => (out[f.offset + i] = { value: v, field: f.name, significance: order === "le" ? i : f.size - 1 - i }));
  }
  return out;
}

// ---------------------------------------------------------------- swap and reverse instructions

export const bswap = (x: bigint, bytes: number): bigint => fromBytes(toBytes(x, bytes, "le"), 0, bytes, "be");
/** Reverse the bits of a w-bit value (Arm RBIT). */
export function reverseBits(x: bigint, w: number): bigint {
  let r = 0n;
  for (let i = 0; i < w; i++) r = (r << 1n) | ((x >> BigInt(i)) & 1n);
  return r;
}
/** Applies a byte or bit permutation to each chunk of `chunk` bytes. */
function perChunk(x: bigint, w: number, chunk: number, f: (c: bigint) => bigint): bigint {
  let r = 0n;
  for (let i = 0; i < w / (8 * chunk); i++) {
    const sh = BigInt(i * 8 * chunk);
    r |= f((x >> sh) & ((1n << BigInt(8 * chunk)) - 1n)) << sh;
  }
  return r;
}

export type SwapOp = "rev" | "rev16" | "rev32" | "brev8" | "rbit";
export interface SwapInfo { op: SwapOp; label: string; isa: string; what: string }
export const SWAP_OPS: SwapInfo[] = [
  { op: "rev", label: "reverse bytes", isa: "x86 bswap, RISC-V rev8 (Zbb), Arm REV", what: "reverses the order of all bytes" },
  { op: "rev16", label: "bytes in each 16 bits", isa: "Arm REV16", what: "swaps the two bytes of each 16-bit halfword" },
  { op: "rev32", label: "bytes in each 32 bits", isa: "Arm A64 REV32", what: "reverses the bytes of each 32-bit word" },
  { op: "brev8", label: "bits in each byte", isa: "RISC-V brev8 (Zbkb)", what: "reverses the bits inside each byte; the bytes stay in place" },
  { op: "rbit", label: "reverse all bits", isa: "Arm RBIT", what: "reverses the order of all bits" },
];
export function swapOp(op: SwapOp, x: bigint, w: number): bigint {
  switch (op) {
    case "rev": return bswap(x, w / 8);
    case "rev16": return perChunk(x, w, 2, (c) => bswap(c, 2));
    case "rev32": return w < 32 ? x : perChunk(x, w, 4, (c) => bswap(c, 4));
    case "brev8": return perChunk(x, w, 1, (c) => reverseBits(c, 8));
    case "rbit": return reverseBits(x, w);
  }
}
/** Where each source bit goes: dest[i] = the source bit index that lands at bit i. */
export function bitMap(op: SwapOp, w: number): number[] {
  return Array.from({ length: w }, (_, i) => {
    for (let j = 0; j < w; j++) if (swapOp(op, 1n << BigInt(j), w) === 1n << BigInt(i)) return j;
    return -1;
  });
}

// ---------------------------------------------------------------- across a boundary

export type Encode = "raw" | "explicit";
/**
 * Machine A stores a 32-bit value into a file or a packet; machine B reads it back.
 * "raw": copy the bytes of the in-memory integer (memcpy, fwrite, a pointer cast). The bytes are in the host's order.
 * "explicit": write or read big-endian with shifts (or htonl / ntohl). The bytes are in network order on every host.
 */
export function roundTrip(x: bigint, writer: Order, writeHow: Encode, reader: Order, readHow: Encode): { wire: number[]; read: bigint; ok: boolean } {
  const wire = toBytes(x, 4, writeHow === "raw" ? writer : "be");
  const read = fromBytes(wire, 0, 4, readHow === "raw" ? reader : "be");
  return { wire, read, ok: read === x };
}

// ---------------------------------------------------------------- alignment

export interface Span { addr: number; size: number; aligned: boolean; lines: number[]; pages: number[]; splitsLine: boolean; splitsPage: boolean }
export function span(addr: number, size: number, line = 64, page = 4096): Span {
  const last = addr + size - 1;
  const lines = [...new Set([Math.floor(addr / line), Math.floor(last / line)])];
  const pages = [...new Set([Math.floor(addr / page), Math.floor(last / page)])];
  return { addr, size, aligned: addr % size === 0, lines, pages, splitsLine: lines.length > 1, splitsPage: pages.length > 1 };
}
/** The fraction of start addresses (uniform over bytes) at which an access of `size` bytes crosses a line: (size − 1) / line. */
export function splitFraction(size: number, line = 64): number {
  let n = 0;
  for (let a = 0; a < line; a++) if (span(a, size, line).splitsLine) n++;
  return n / line;
}
