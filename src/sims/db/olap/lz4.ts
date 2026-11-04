/**
 * A small, real LZ4 block compressor and decompressor (the LZ4 "block format").
 *
 * The output is a list of sequences. Each sequence is:
 *   token (high 4 bits: literal length, low 4 bits: match length − 4; 15 means "more bytes follow"),
 *   extra literal-length bytes, the literals, a 2-byte little-endian offset, extra match-length bytes.
 * The last sequence has only literals. The last 5 bytes are always literals, and the last match
 * starts at least 12 bytes before the end, as the format requires.
 *
 * The compressor is greedy with one hash table of 4-byte sequences, like LZ4's fast mode.
 * It does not use an entropy coder: that is what Zstd adds (Huffman and FSE coding).
 */

const MINMATCH = 4;
const LASTLITERALS = 5;
const MFLIMIT = 12;
const HASH_LOG = 16;
const MAX_OFFSET = 65535;

const read32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const hash = (v: number) => Math.imul(v, 2654435761) >>> (32 - HASH_LOG);

class Out {
  buf = new Uint8Array(1024);
  n = 0;
  push(v: number) {
    if (this.n === this.buf.length) { const b = new Uint8Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
    this.buf[this.n++] = v;
  }
  done() { return this.buf.slice(0, this.n); }
}

function writeLen(out: Out, len: number) {
  while (len >= 255) { out.push(255); len -= 255; }
  out.push(len);
}

function emit(out: Out, src: Uint8Array, litStart: number, litEnd: number, offset: number, matchLen: number) {
  const lit = litEnd - litStart;
  const ml = matchLen - MINMATCH;
  out.push((Math.min(lit, 15) << 4) | (matchLen > 0 ? Math.min(ml, 15) : 0));
  if (lit >= 15) writeLen(out, lit - 15);
  for (let i = litStart; i < litEnd; i++) out.push(src[i]!);
  if (matchLen === 0) return;
  out.push(offset & 0xff);
  out.push(offset >>> 8);
  if (ml >= 15) writeLen(out, ml - 15);
}

/** Compresses `src` into one LZ4 block. */
export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Out();
  let anchor = 0;
  if (n >= MFLIMIT + 1) {
    const table = new Int32Array(1 << HASH_LOG).fill(-1);
    const matchLimit = n - LASTLITERALS;
    let ip = 0;
    while (ip <= n - MFLIMIT) {
      const seq = read32(src, ip);
      const h = hash(seq);
      const ref = table[h]!;
      table[h] = ip;
      if (ref >= 0 && ip - ref <= MAX_OFFSET && read32(src, ref) === seq) {
        let len = MINMATCH;
        while (ip + len < matchLimit && src[ref + len] === src[ip + len]) len++;
        emit(out, src, anchor, ip, ip - ref, len);
        ip += len;
        anchor = ip;
        if (ip - 2 >= 0 && ip - 2 <= n - 4) table[hash(read32(src, ip - 2))] = ip - 2;
      } else {
        ip++;
      }
    }
  }
  emit(out, src, anchor, n, 0, 0);
  return out.done();
}

/** Decompresses one LZ4 block. */
export function lz4Decompress(src: Uint8Array): Uint8Array {
  const out = new Out();
  let ip = 0;
  const readLen = (base: number) => {
    let len = base;
    if (base === 15) for (;;) { const b = src[ip++]!; len += b; if (b !== 255) break; }
    return len;
  };
  while (ip < src.length) {
    const token = src[ip++]!;
    const lit = readLen(token >>> 4);
    for (let i = 0; i < lit; i++) out.push(src[ip++]!);
    if (ip >= src.length) break;
    const offset = src[ip]! | (src[ip + 1]! << 8);
    ip += 2;
    if (offset === 0 || offset > out.n) throw new Error("bad LZ4 offset");
    const ml = readLen(token & 15) + MINMATCH;
    const from = out.n - offset;
    for (let i = 0; i < ml; i++) out.push(out.buf[from + i]!);
  }
  return out.done();
}
