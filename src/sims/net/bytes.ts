/**
 * Bytes on the wire: header fields packed bit by bit (network byte order), the Internet checksum (RFC 1071),
 * the Ethernet CRC-32, hex dumps and IPv4 address text. Header lessons build their packets with these, and the
 * HeaderDiagram demo draws the same `Field` lists.
 */

export interface Field {
  name: string;
  /** Width in bits. */
  bits: number;
  /** The value to pack. A field wider than 32 bits takes a bigint or a byte array. */
  value?: number | bigint | Uint8Array;
  /** A short name for narrow boxes, such as "TTL" or "DF". */
  short?: string;
  /** One line that says what the field is for. */
  note?: string;
}

/** Total bytes of a field list (rounded up to whole bytes). */
export const fieldBytes = (fields: Field[]) => Math.ceil(fields.reduce((s, f) => s + f.bits, 0) / 8);

/** Packs fields in order, most significant bit first (network byte order). Missing values are 0. */
export function packFields(fields: Field[]): Uint8Array {
  const out = new Uint8Array(fieldBytes(fields));
  let bit = 0;
  for (const f of fields) {
    let v: bigint;
    if (f.value instanceof Uint8Array) {
      v = 0n;
      for (const b of f.value) v = (v << 8n) | BigInt(b);
    } else v = BigInt(f.value ?? 0);
    for (let i = f.bits - 1; i >= 0; i--) {
      if ((v >> BigInt(i)) & 1n) out[bit >> 3]! |= 0x80 >> (bit & 7);
      bit++;
    }
  }
  return out;
}

/** Reads fields back from bytes, with the same layout as packFields. Values come back as bigints. */
export function unpackFields(fields: Field[], bytes: Uint8Array): bigint[] {
  let bit = 0;
  return fields.map((f) => {
    let v = 0n;
    for (let i = 0; i < f.bits; i++, bit++) v = (v << 1n) | BigInt((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return v;
  });
}

/** Bit offset of each field from the start of the header. */
export function fieldOffsets(fields: Field[]): number[] {
  let at = 0;
  return fields.map((f) => {
    const o = at;
    at += f.bits;
    return o;
  });
}

/**
 * The Internet checksum (RFC 1071): the ones' complement of the ones' complement sum of 16-bit words.
 * An odd last byte is padded with a zero byte. A header with a correct checksum field sums to 0xffff, so this returns 0.
 */
export function internetChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return ~sum & 0xffff;
}

let crcTable: Uint32Array | undefined;

/** CRC-32 as Ethernet's frame check sequence uses it (reflected polynomial 0xEDB88320, init and final XOR 0xFFFFFFFF). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** "45 00 00 54 ..." with an optional break every `perLine` bytes. */
export function hex(bytes: Uint8Array, perLine = 0): string {
  const parts = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  if (!perLine) return parts.join(" ");
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += perLine) lines.push(parts.slice(i, i + perLine).join(" "));
  return lines.join("\n");
}

export const utf8 = (s: string) => new TextEncoder().encode(s);

/** "192.168.1.10" → 0xc0a8010a. Throws on bad text. */
export function parseIpv4(s: string): number {
  const p = s.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) throw new Error(`bad IPv4 address: ${s}`);
  return p.reduce((a, x) => a * 256 + Number(x), 0) >>> 0;
}

export const formatIpv4 = (a: number) => [24, 16, 8, 0].map((s) => (a >>> s) & 0xff).join(".");

/** The network mask of a prefix length, as a 32-bit number: 24 → 0xffffff00. */
export const prefixMask = (len: number) => (len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);

/** True if `addr` is inside `net/len`. */
export const inPrefix = (addr: number, net: number, len: number) => ((addr & prefixMask(len)) >>> 0) === ((net & prefixMask(len)) >>> 0);

/** 48-bit MAC address text, "02:00:00:00:00:01". */
export const formatMac = (bytes: Uint8Array | number[]) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(":");
