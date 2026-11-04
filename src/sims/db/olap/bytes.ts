/**
 * Byte and bit streams for the column encodings.
 * - ByteWriter / ByteReader: little-endian fixed-width values, ULEB128 varints, zigzag.
 * - BitWriter / BitReader: values of any width up to 53 bits, packed LSB first, as in Parquet's bit-packing.
 * Numbers are JS doubles, so integers must stay within ±2^53.
 */

export class ByteWriter {
  private buf = new Uint8Array(256);
  length = 0;
  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.length));
    this.buf = b;
  }
  u8(v: number) { this.grow(1); this.buf[this.length++] = v & 0xff; }
  u16(v: number) { this.u8(v); this.u8(v >>> 8); }
  i32(v: number) { this.grow(4); new DataView(this.buf.buffer).setInt32(this.length, v, true); this.length += 4; }
  i64(v: number) { this.grow(8); new DataView(this.buf.buffer).setBigInt64(this.length, BigInt(v), true); this.length += 8; }
  f64(v: number) { this.grow(8); new DataView(this.buf.buffer).setFloat64(this.length, v, true); this.length += 8; }
  bytes(b: Uint8Array) { this.grow(b.length); this.buf.set(b, this.length); this.length += b.length; }
  /** Unsigned LEB128: 7 bits per byte, high bit set on every byte but the last. */
  varint(v: number) {
    if (v < 0 || !Number.isInteger(v)) throw new Error(`varint needs a non-negative integer, got ${v}`);
    while (v >= 0x80) { this.u8((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    this.u8(v);
  }
  /** Zigzag maps 0, −1, 1, −2, ... to 0, 1, 2, 3, ... so small negative numbers stay short. */
  zigzag(v: number) { this.varint(v >= 0 ? 2 * v : -2 * v - 1); }
  done(): Uint8Array { return this.buf.slice(0, this.length); }
}

export class ByteReader {
  pos = 0;
  private dv: DataView;
  constructor(readonly buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u8() { if (this.pos >= this.buf.length) throw new Error("read past end"); return this.buf[this.pos++]!; }
  u16() { return this.u8() | (this.u8() << 8); }
  i32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  i64() { const v = Number(this.dv.getBigInt64(this.pos, true)); this.pos += 8; return v; }
  f64() { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  bytes(n: number) { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  varint() {
    let v = 0, mul = 1;
    for (;;) {
      const b = this.u8();
      v += (b & 0x7f) * mul;
      if (b < 0x80) return v;
      mul *= 0x80;
    }
  }
  zigzag() { const z = this.varint(); return z % 2 === 0 ? z / 2 : -(z + 1) / 2; }
}

/** Number of bits needed to store every value in 0..max (0 for max = 0). */
export function bitWidth(max: number): number {
  let w = 0;
  while (2 ** w <= max) w++;
  return w;
}

export class BitWriter {
  private acc = 0;
  private n = 0;
  constructor(private out: ByteWriter) {}
  /** Writes the low `width` bits of a non-negative integer v. */
  write(v: number, width: number) {
    while (width > 0) {
      const k = Math.min(width, 24);
      const chunk = v % 2 ** k;
      v = Math.floor(v / 2 ** k);
      width -= k;
      this.acc += chunk * 2 ** this.n;
      this.n += k;
      while (this.n >= 8) { this.out.u8(this.acc % 256); this.acc = Math.floor(this.acc / 256); this.n -= 8; }
    }
  }
  /** Pads the last byte with zero bits. */
  flush() { if (this.n > 0) { this.out.u8(this.acc); this.acc = 0; this.n = 0; } }
}

export class BitReader {
  private acc = 0;
  private n = 0;
  constructor(private inp: ByteReader) {}
  read(width: number): number {
    let v = 0, mul = 1;
    while (width > 0) {
      if (this.n === 0) { this.acc = this.inp.u8(); this.n = 8; }
      const k = Math.min(width, this.n);
      v += (this.acc % 2 ** k) * mul;
      this.acc = Math.floor(this.acc / 2 ** k);
      this.n -= k;
      width -= k;
      mul *= 2 ** k;
    }
    return v;
  }
  /** Skips the padding bits of the current byte. */
  align() { this.n = 0; this.acc = 0; }
}
