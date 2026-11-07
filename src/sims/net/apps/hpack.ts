/**
 * HPACK (RFC 7541): the header compression of HTTP/2. A real encoder and decoder, checked against the examples
 * of RFC 7541 appendix C.
 *
 * - Integers with an N-bit prefix (section 5.1) and string literals with an optional Huffman code (5.2).
 * - The static table (61 entries) and a dynamic table (section 4): newest entry first at index 62, the size of an
 *   entry is name + value + 32 bytes, and old entries are evicted when an insert would pass the maximum size.
 * - Representations (section 6): indexed (1xxxxxxx), literal with incremental indexing (01xxxxxx), literal without
 *   indexing (0000xxxx), literal never indexed (0001xxxx), and dynamic table size update (001xxxxx).
 *
 * The encoder and the decoder each keep a copy of the dynamic table. The copies stay equal only if the decoder
 * sees the header blocks in the order the encoder wrote them. HTTP/2 gets that order from TCP; QUIC does not
 * give it, which is why HTTP/3 uses QPACK (qpack.ts).
 */
import { HPACK_STATIC, HUFFMAN } from "./hpack-tables";

export type Header = readonly [name: string, value: string];

/** RFC 7541 section 4.1: an entry costs its name and value bytes plus 32. */
export const ENTRY_OVERHEAD = 32;
export const entrySize = (h: Header) => utf8Len(h[0]) + utf8Len(h[1]) + ENTRY_OVERHEAD;
/** SETTINGS_HEADER_TABLE_SIZE default (RFC 9113 section 6.5.2). */
export const DEFAULT_TABLE_SIZE = 4096;

const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8Len = (s: string) => enc.encode(s).length;

export class HpackError extends Error {}

// ------------------------------------------------------------------------------------------------ integers

/** Appends `value` with an N-bit prefix. `flags` holds the bits above the prefix in the first byte. */
export function encodeInt(value: number, prefixBits: number, flags: number, out: number[]) {
  const max = (1 << prefixBits) - 1;
  if (value < max) {
    out.push(flags | value);
    return;
  }
  out.push(flags | max);
  value -= max;
  while (value >= 128) {
    out.push((value % 128) + 128);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

/** Reads an integer with an N-bit prefix at `pos`. Returns [value, next position]. */
export function decodeInt(b: Uint8Array, pos: number, prefixBits: number): [number, number] {
  const max = (1 << prefixBits) - 1;
  if (pos >= b.length) throw new HpackError("truncated integer");
  let v = b[pos]! & max;
  pos++;
  if (v < max) return [v, pos];
  let m = 1;
  for (;;) {
    if (pos >= b.length) throw new HpackError("truncated integer");
    const x = b[pos++]!;
    v += (x & 127) * m;
    m *= 128;
    if (!(x & 128)) return [v, pos];
    if (m > 2 ** 35) throw new HpackError("integer too large");
  }
}

// ------------------------------------------------------------------------------------------------ Huffman

/** Bytes of the Huffman code of `s` (the last byte padded with the high bits of EOS, all ones). */
export function huffmanEncode(s: string): Uint8Array {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const byte of enc.encode(s)) {
    const [code, len] = HUFFMAN[byte]!;
    acc = acc * 2 ** len + code;
    bits += len;
    while (bits >= 8) {
      const shift = 2 ** (bits - 8);
      out.push(Math.floor(acc / shift) & 0xff);
      acc %= shift;
      bits -= 8;
    }
  }
  if (bits > 0) out.push(((acc << (8 - bits)) | ((1 << (8 - bits)) - 1)) & 0xff);
  return new Uint8Array(out);
}

export const huffmanLength = (s: string) => Math.ceil([...enc.encode(s)].reduce((a, b) => a + HUFFMAN[b]![1], 0) / 8);

let decodeMap: Map<number, number>[] | undefined;

export function huffmanDecode(b: Uint8Array): string {
  if (!decodeMap) {
    decodeMap = Array.from({ length: 31 }, () => new Map());
    HUFFMAN.forEach(([code, len], sym) => decodeMap![len]!.set(code, sym));
  }
  const out: number[] = [];
  let code = 0, len = 0;
  for (const byte of b) {
    for (let i = 7; i >= 0; i--) {
      code = code * 2 + ((byte >> i) & 1);
      len++;
      const sym = decodeMap[len]?.get(code);
      if (sym !== undefined) {
        if (sym === 256) throw new HpackError("EOS in a Huffman string");
        out.push(sym);
        code = 0;
        len = 0;
      } else if (len > 30) throw new HpackError("bad Huffman code");
    }
  }
  if (len > 7 || code !== 2 ** len - 1) throw new HpackError("bad Huffman padding");
  return dec.decode(new Uint8Array(out));
}

// ------------------------------------------------------------------------------------------------ strings

/** Appends a string literal: H bit, 7-bit length prefix, then the bytes. `huffman`: "auto" picks the shorter. */
export function encodeString(s: string, huffman: boolean | "auto", out: number[]): boolean {
  const raw = enc.encode(s);
  const useH = huffman === "auto" ? huffmanLength(s) < raw.length : huffman;
  const data = useH ? huffmanEncode(s) : raw;
  encodeInt(data.length, 7, useH ? 0x80 : 0, out);
  for (const x of data) out.push(x);
  return useH;
}

export function decodeString(b: Uint8Array, pos: number): [string, number] {
  if (pos >= b.length) throw new HpackError("truncated string");
  const h = (b[pos]! & 0x80) !== 0;
  const [len, p] = decodeInt(b, pos, 7);
  if (p + len > b.length) throw new HpackError("truncated string");
  const data = b.subarray(p, p + len);
  return [h ? huffmanDecode(data) : dec.decode(data), p + len];
}

// ------------------------------------------------------------------------------------------------ tables

export class DynamicTable {
  /** Newest first: entries[0] has index 62 in HPACK. */
  entries: Header[] = [];
  size = 0;
  /** Entries evicted so far (for the demos). */
  evicted = 0;
  constructor(public maxSize = DEFAULT_TABLE_SIZE) {}

  add(h: Header) {
    const s = entrySize(h);
    while (this.entries.length && this.size + s > this.maxSize) this.evictOne();
    // An entry larger than the table empties it and is not added (section 4.4).
    if (s > this.maxSize) return;
    this.entries.unshift(h);
    this.size += s;
  }
  setMax(n: number) {
    this.maxSize = n;
    while (this.size > n) this.evictOne();
  }
  private evictOne() {
    const e = this.entries.pop()!;
    this.size -= entrySize(e);
    this.evicted++;
  }
  clone() {
    const t = new DynamicTable(this.maxSize);
    t.entries = [...this.entries];
    t.size = this.size;
    t.evicted = this.evicted;
    return t;
  }
}

/** Index space: 1..61 static, 62.. dynamic (newest first). */
export function lookup(t: DynamicTable, index: number): Header {
  if (index >= 1 && index <= HPACK_STATIC.length) return HPACK_STATIC[index - 1]!;
  const d = t.entries[index - HPACK_STATIC.length - 1];
  if (!d) throw new HpackError(`index ${index} is not in the table`);
  return d;
}

/** The best match: a full match (index, true), a name match (index, false), or none. Static first. */
export function findHeader(t: DynamicTable, h: Header): { index: number; full: boolean } | undefined {
  let nameIdx = 0;
  for (let i = 0; i < HPACK_STATIC.length; i++) {
    const [n, v] = HPACK_STATIC[i]!;
    if (n === h[0]) {
      if (v === h[1]) return { index: i + 1, full: true };
      nameIdx ||= i + 1;
    }
  }
  for (let i = 0; i < t.entries.length; i++) {
    const [n, v] = t.entries[i]!;
    if (n === h[0]) {
      if (v === h[1]) return { index: HPACK_STATIC.length + 1 + i, full: true };
      nameIdx ||= HPACK_STATIC.length + 1 + i;
    }
  }
  return nameIdx ? { index: nameIdx, full: false } : undefined;
}

// ------------------------------------------------------------------------------------------------ encoder

export type RepKind = "indexed" | "incremental" | "without" | "never" | "size";

/** One encoded header: how it was represented and its bytes. */
export interface Rep {
  header: Header;
  kind: RepKind;
  /** Index of the full match (indexed) or of the name (literal with a name reference). 0: literal name. */
  index: number;
  /** The name or value went as a Huffman string. */
  huffman: boolean;
  bytes: Uint8Array;
}

export interface EncodeOpts {
  /** Huffman-code string literals: true, false or "auto" (the shorter). Default "auto". */
  huffman?: boolean | "auto";
  /** Never add headers to the dynamic table (a stateless encoder). */
  noIndexing?: boolean;
  /** Header names sent as "never indexed" (secrets such as authorization). */
  sensitive?: string[];
}

export class HpackEncoder {
  readonly table: DynamicTable;
  constructor(maxSize = DEFAULT_TABLE_SIZE, readonly opts: EncodeOpts = {}) {
    this.table = new DynamicTable(maxSize);
  }

  /** Encodes one header block. Returns its bytes and one Rep per header. */
  encode(headers: readonly Header[]): { bytes: Uint8Array; reps: Rep[] } {
    const reps: Rep[] = [];
    const huff = this.opts.huffman ?? "auto";
    for (const h of headers) {
      const out: number[] = [];
      const m = findHeader(this.table, h);
      const sensitive = this.opts.sensitive?.includes(h[0]);
      let kind: RepKind, index = 0, usedH = false;
      if (m?.full && !sensitive) {
        kind = "indexed";
        index = m.index;
        encodeInt(index, 7, 0x80, out);
      } else {
        kind = sensitive ? "never" : this.opts.noIndexing ? "without" : "incremental";
        index = m?.index ?? 0;
        const [prefix, flags] = kind === "incremental" ? [6, 0x40] : kind === "never" ? [4, 0x10] : [4, 0x00];
        encodeInt(index, prefix, flags, out);
        if (!index) usedH = encodeString(h[0], huff, out);
        usedH = encodeString(h[1], huff, out) || usedH;
        if (kind === "incremental") this.table.add(h);
      }
      reps.push({ header: h, kind, index, huffman: usedH, bytes: new Uint8Array(out) });
    }
    const total = reps.reduce((a, r) => a + r.bytes.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const r of reps) {
      bytes.set(r.bytes, at);
      at += r.bytes.length;
    }
    return { bytes, reps };
  }
}

// ------------------------------------------------------------------------------------------------ decoder

export class HpackDecoder {
  readonly table: DynamicTable;
  constructor(maxSize = DEFAULT_TABLE_SIZE) {
    this.table = new DynamicTable(maxSize);
  }

  /** Decodes one header block. Throws HpackError (a COMPRESSION_ERROR in HTTP/2) on bad input. */
  decode(b: Uint8Array): Header[] {
    const out: Header[] = [];
    let pos = 0;
    while (pos < b.length) {
      const x = b[pos]!;
      if (x & 0x80) {
        const [i, p] = decodeInt(b, pos, 7);
        if (i === 0) throw new HpackError("index 0");
        out.push(lookup(this.table, i));
        pos = p;
      } else if ((x & 0xe0) === 0x20) {
        const [n, p] = decodeInt(b, pos, 5);
        this.table.setMax(n);
        pos = p;
      } else {
        const inc = (x & 0xc0) === 0x40;
        const [i, p] = decodeInt(b, pos, inc ? 6 : 4);
        pos = p;
        let name: string, value: string;
        if (i) name = lookup(this.table, i)[0];
        else [name, pos] = decodeString(b, pos);
        [value, pos] = decodeString(b, pos);
        const h: Header = [name, value];
        if (inc) this.table.add(h);
        out.push(h);
      }
    }
    return out;
  }
}

/** HTTP/1.1-style text size of a header list: "name: value\r\n" per header (pseudo-headers counted the same way). */
export const textSize = (headers: readonly Header[]) => headers.reduce((a, [n, v]) => a + utf8Len(n) + 2 + utf8Len(v) + 2, 0);
