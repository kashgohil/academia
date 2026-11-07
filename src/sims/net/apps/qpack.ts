/**
 * QPACK (RFC 9204): the header compression of HTTP/3, checked against the examples of RFC 9204 appendix B.
 *
 * HPACK changes the dynamic table as a side effect of each header block, so the decoder must see the blocks in
 * order. QUIC streams are independent, so blocks can arrive in any order. QPACK fixes this:
 *
 * - Inserts travel on one unidirectional **encoder stream**, in order. A header block (a "field section") only
 *   refers to entries. Its prefix says how many inserts it needs (the Required Insert Count) and a Base.
 * - A decoder that gets a section before the inserts it needs **blocks** that stream (at most
 *   SETTINGS_QPACK_BLOCKED_STREAMS of them) until the encoder stream catches up.
 * - The decoder acknowledges sections on the **decoder stream**. An encoder that never wants to block refers
 *   only to acknowledged entries and sends literals for the rest: less compression, no waiting.
 *
 * Absolute index: the first entry ever inserted is 0. In a section, an entry below Base is "relative"
 * (Base − 1 − abs) and an entry at or above Base is "post-base" (abs − Base).
 */
import { QPACK_STATIC } from "./hpack-tables";
import { HpackError, decodeInt, decodeString, encodeInt, entrySize, huffmanEncode, huffmanLength, type Header } from "./hpack";

const enc = new TextEncoder();

/** A string with an H bit at `hBit` and a length with an N-bit prefix, after `flags` in the same byte. */
function encodeStr(s: string, prefixBits: number, hBit: number, flags: number, huffman: boolean, out: number[]) {
  const raw = enc.encode(s);
  const useH = huffman && huffmanLength(s) < raw.length;
  const data = useH ? huffmanEncode(s) : raw;
  encodeInt(data.length, prefixBits, flags | (useH ? hBit : 0), out);
  for (const x of data) out.push(x);
}

function decodeStr(b: Uint8Array, pos: number, prefixBits: number): [string, number] {
  // decodeString reads a 7-bit prefix with the H bit at 0x80. For a shorter prefix, rebuild the first byte.
  if (prefixBits === 7) return decodeString(b, pos);
  const hMask = 1 << prefixBits;
  const first = b[pos]!;
  const copy = b.slice(pos);
  const [len, p] = decodeInt(b, pos, prefixBits);
  const head: number[] = [];
  encodeInt(len, 7, first & hMask ? 0x80 : 0, head);
  const rebuilt = new Uint8Array(head.length + len);
  rebuilt.set(head);
  rebuilt.set(copy.subarray(p - pos, p - pos + len), head.length);
  const [s] = decodeString(rebuilt, 0);
  return [s, p + len];
}

export function findStatic(h: Header): { index: number; full: boolean } | undefined {
  let name = -1;
  for (let i = 0; i < QPACK_STATIC.length; i++) {
    const [n, v] = QPACK_STATIC[i]!;
    if (n === h[0]) {
      if (v === h[1]) return { index: i, full: true };
      if (name < 0) name = i;
    }
  }
  return name >= 0 ? { index: name, full: false } : undefined;
}

/** The dynamic table, shared in shape by encoder and decoder. */
export class QTable {
  /** entries[i] has absolute index dropped + i. */
  entries: Header[] = [];
  dropped = 0;
  size = 0;
  constructor(public capacity = 0) {}
  get insertCount() {
    return this.dropped + this.entries.length;
  }
  get(abs: number): Header | undefined {
    return this.entries[abs - this.dropped];
  }
  /** Room for `h` after evicting entries older than `keepFrom` (entries still referenced must stay). */
  canInsert(h: Header, keepFrom = Infinity) {
    let free = this.capacity - this.size;
    for (let i = 0; i < this.entries.length && free < entrySize(h); i++) {
      if (this.dropped + i >= keepFrom) return false;
      free += entrySize(this.entries[i]!);
    }
    return free >= entrySize(h);
  }
  insert(h: Header) {
    const s = entrySize(h);
    while (this.entries.length && this.size + s > this.capacity) {
      this.size -= entrySize(this.entries.shift()!);
      this.dropped++;
    }
    if (s > this.capacity) throw new HpackError("entry larger than the table");
    this.entries.push(h);
    this.size += s;
  }
  find(h: Header): { abs: number; full: boolean } | undefined {
    let name = -1;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const [n, v] = this.entries[i]!;
      if (n === h[0]) {
        if (v === h[1]) return { abs: this.dropped + i, full: true };
        if (name < 0) name = this.dropped + i;
      }
    }
    return name >= 0 ? { abs: name, full: false } : undefined;
  }
}

export type QLineKind = "static" | "dynamic" | "post-base" | "literal-static-name" | "literal-dynamic-name" | "literal";
export interface QLine { header: Header; kind: QLineKind; bytes: Uint8Array }
export interface QInstr { text: string; bytes: Uint8Array }

export interface QSection {
  /** The encoded field section: prefix, then lines. */
  bytes: Uint8Array;
  prefix: Uint8Array;
  lines: QLine[];
  /** Encoder-stream instructions this section caused (sent before it). */
  instructions: QInstr[];
  requiredInsertCount: number;
  base: number;
}

export interface QEncodeOpts {
  /** Refer to entries the decoder has not acknowledged yet (the stream may block). */
  allowBlocking: boolean;
  huffman?: boolean;
}

export class QpackEncoder {
  readonly table: QTable;
  /** Inserts the decoder has acknowledged. */
  knownReceived = 0;
  private sentCapacity = false;
  constructor(readonly capacity: number, readonly maxCapacity = capacity) {
    this.table = new QTable(capacity);
  }

  /** Encoder-stream instruction: Set Dynamic Table Capacity (001xxxxx). */
  private setCapacity(): QInstr {
    const out: number[] = [];
    encodeInt(this.capacity, 5, 0x20, out);
    return { text: `Set Dynamic Table Capacity = ${this.capacity}`, bytes: new Uint8Array(out) };
  }

  encodeSection(headers: readonly Header[], o: QEncodeOpts): QSection {
    const huff = o.huffman ?? false;
    const instructions: QInstr[] = [];
    if (!this.sentCapacity && this.capacity > 0) {
      instructions.push(this.setCapacity());
      this.sentCapacity = true;
    }
    const base = this.table.insertCount;
    const plan: { h: Header; ref?: { abs: number }; st?: { index: number; full: boolean } }[] = [];
    let ric = 0;
    const usable = (abs: number) => o.allowBlocking || abs < this.knownReceived;

    for (const h of headers) {
      const st = findStatic(h);
      if (st?.full) {
        plan.push({ h, st });
        continue;
      }
      const dyn = this.table.find(h);
      if (dyn?.full && usable(dyn.abs)) {
        plan.push({ h, ref: { abs: dyn.abs } });
        ric = Math.max(ric, dyn.abs + 1);
        continue;
      }
      // Insert it for this section (if blocking is allowed) or for later ones.
      if (this.capacity > 0 && !dyn?.full && this.table.canInsert(h, this.knownReceived)) {
        const out: number[] = [];
        let text: string;
        if (st) {
          encodeInt(st.index, 6, 0xc0, out);
          text = `Insert With Name Reference: static ${st.index} (${h[0]}) = ${h[1]}`;
        } else if (dyn) {
          encodeInt(this.table.insertCount - dyn.abs - 1, 6, 0x80, out);
          text = `Insert With Name Reference: dynamic ${dyn.abs} (${h[0]}) = ${h[1]}`;
        } else {
          encodeStr(h[0], 5, 0x20, 0x40, huff, out);
          text = `Insert With Literal Name: ${h[0]} = ${h[1]}`;
        }
        encodeStr(h[1], 7, 0x80, 0, huff, out);
        this.table.insert(h);
        instructions.push({ text, bytes: new Uint8Array(out) });
        const abs = this.table.insertCount - 1;
        if (usable(abs)) {
          plan.push({ h, ref: { abs } });
          ric = Math.max(ric, abs + 1);
          continue;
        }
      }
      plan.push({ h, st: st ?? undefined });
    }

    const lines: QLine[] = plan.map(({ h, ref, st }) => {
      const out: number[] = [];
      let kind: QLineKind;
      if (st?.full) {
        encodeInt(st.index, 6, 0xc0, out);
        kind = "static";
      } else if (ref) {
        if (ref.abs < base) {
          encodeInt(base - 1 - ref.abs, 6, 0x80, out);
          kind = "dynamic";
        } else {
          encodeInt(ref.abs - base, 4, 0x10, out);
          kind = "post-base";
        }
      } else {
        const dynName = this.table.find(h);
        if (st) {
          encodeInt(st.index, 4, 0x50, out);
          kind = "literal-static-name";
        } else if (dynName && dynName.abs < base && usable(dynName.abs)) {
          encodeInt(base - 1 - dynName.abs, 4, 0x40, out);
          ric = Math.max(ric, dynName.abs + 1);
          kind = "literal-dynamic-name";
        } else {
          encodeStr(h[0], 3, 0x08, 0x20, huff, out);
          kind = "literal";
        }
        encodeStr(h[1], 7, 0x80, 0, huff, out);
      }
      return { header: h, kind, bytes: new Uint8Array(out) };
    });

    const prefix: number[] = [];
    const maxEntries = Math.floor(this.maxCapacity / 32);
    encodeInt(ric === 0 ? 0 : (ric % (2 * maxEntries)) + 1, 8, 0, prefix);
    if (base >= ric) encodeInt(ric === 0 ? 0 : base - ric, 7, 0, prefix);
    else encodeInt(ric - base - 1, 7, 0x80, prefix);
    const pre = new Uint8Array(prefix);
    const total = pre.length + lines.reduce((a, l) => a + l.bytes.length, 0);
    const bytes = new Uint8Array(total);
    bytes.set(pre);
    let at = pre.length;
    for (const l of lines) {
      bytes.set(l.bytes, at);
      at += l.bytes.length;
    }
    return { bytes, prefix: pre, lines, instructions, requiredInsertCount: ric, base };
  }

  /** The decoder acknowledged a section that needed `ric` inserts (a Section Acknowledgment). */
  acknowledge(ric: number) {
    this.knownReceived = Math.max(this.knownReceived, ric);
  }
}

export class QpackDecoder {
  readonly table: QTable;
  constructor(readonly maxCapacity: number) {
    this.table = new QTable(0);
  }

  /** Applies encoder-stream bytes (whole instructions). */
  onEncoderStream(b: Uint8Array) {
    let pos = 0;
    while (pos < b.length) {
      const x = b[pos]!;
      if (x & 0x80) {
        const isStatic = (x & 0x40) !== 0;
        const [i, p] = decodeInt(b, pos, 6);
        const name = isStatic ? QPACK_STATIC[i]?.[0] : this.table.get(this.table.insertCount - 1 - i)?.[0];
        if (name === undefined) throw new HpackError(`bad name reference ${i}`);
        const [v, q] = decodeStr(b, p, 7);
        this.table.insert([name, v]);
        pos = q;
      } else if (x & 0x40) {
        const [n, p] = decodeStr(b, pos, 5);
        const [v, q] = decodeStr(b, p, 7);
        this.table.insert([n, v]);
        pos = q;
      } else if (x & 0x20) {
        const [c, p] = decodeInt(b, pos, 5);
        if (c > this.maxCapacity) throw new HpackError("capacity above the maximum");
        this.table.capacity = c;
        pos = p;
      } else {
        const [i, p] = decodeInt(b, pos, 5);
        const e = this.table.get(this.table.insertCount - 1 - i);
        if (!e) throw new HpackError(`bad duplicate ${i}`);
        this.table.insert(e);
        pos = p;
      }
    }
  }

  /** The Required Insert Count of a section, from its first byte(s). */
  requiredInsertCount(b: Uint8Array): number {
    const [e] = decodeInt(b, 0, 8);
    if (e === 0) return 0;
    const maxEntries = Math.floor(this.maxCapacity / 32);
    const full = 2 * maxEntries;
    const maxValue = this.table.insertCount + maxEntries;
    const maxWrapped = Math.floor(maxValue / full) * full;
    let ric = maxWrapped + e - 1;
    if (ric > maxValue) ric -= full;
    return ric;
  }

  /** Decodes a section, or returns "blocked" if it needs inserts that have not arrived. */
  decodeSection(b: Uint8Array): Header[] | "blocked" {
    const ric = this.requiredInsertCount(b);
    if (ric > this.table.insertCount) return "blocked";
    let [, pos] = decodeInt(b, 0, 8);
    const sign = (b[pos]! & 0x80) !== 0;
    const [delta, p0] = decodeInt(b, pos, 7);
    pos = p0;
    const base = sign ? ric - delta - 1 : ric + delta;
    const get = (abs: number) => {
      const e = this.table.get(abs);
      if (!e) throw new HpackError(`entry ${abs} is not in the table`);
      return e;
    };
    const out: Header[] = [];
    while (pos < b.length) {
      const x = b[pos]!;
      if (x & 0x80) {
        const [i, p] = decodeInt(b, pos, 6);
        out.push(x & 0x40 ? QPACK_STATIC[i]! : get(base - 1 - i));
        pos = p;
      } else if (x & 0x40) {
        const [i, p] = decodeInt(b, pos, 4);
        const name = x & 0x10 ? QPACK_STATIC[i]![0] : get(base - 1 - i)[0];
        const [v, q] = decodeStr(b, p, 7);
        out.push([name, v]);
        pos = q;
      } else if (x & 0x20) {
        const [n, p] = decodeStr(b, pos, 3);
        const [v, q] = decodeStr(b, p, 7);
        out.push([n, v]);
        pos = q;
      } else if (x & 0x10) {
        const [i, p] = decodeInt(b, pos, 4);
        out.push(get(base + i));
        pos = p;
      } else {
        const [i, p] = decodeInt(b, pos, 3);
        const name = get(base + i)[0];
        const [v, q] = decodeStr(b, p, 7);
        out.push([name, v]);
        pos = q;
      }
    }
    return out;
  }
}
