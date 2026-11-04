/**
 * Column encodings with real byte formats, decoders and a per-column chooser.
 *
 * Every encoding starts with a varint value count. Formats:
 *   plain     the values at full width: int32 4 B, int64 8 B, float64 8 B, string = u32 length + bytes
 *   rle       runs: u16 run length + the value in plain form (runs longer than 65,535 are split), as DuckDB's RLE
 *   dict      varint dictionary size, the distinct values in plain form, a u8 code width, bit-packed codes
 *   for       frame of reference, blocks of 128: zigzag varint block minimum, u8 width, bit-packed (v − min)
 *   delta     zigzag varint first value, then the deltas as "for" blocks (like Parquet DELTA_BINARY_PACKED)
 *   bitpack   u8 width, then every value bit-packed (non-negative integers only)
 *   lz4       the plain bytes, compressed with the LZ4 block format (general-purpose)
 */
import { ByteReader, ByteWriter, BitReader, BitWriter, bitWidth } from "./bytes";
import { lz4Compress, lz4Decompress } from "./lz4";

export type ColType = "int32" | "int64" | "float64" | "string";
export type Value = number | string;
export type EncodingName = "plain" | "rle" | "dict" | "for" | "delta" | "bitpack" | "lz4";
export const ENCODINGS: EncodingName[] = ["plain", "rle", "dict", "for", "delta", "bitpack", "lz4"];
export const FOR_BLOCK = 128;
export const RLE_MAX_RUN = 65535;

export interface Encoded {
  encoding: EncodingName;
  bytes: Uint8Array;
  /** A short human-readable view of the start of the encoded form. */
  preview: string;
}

const isInt = (t: ColType) => t === "int32" || t === "int64";
const keyOf = (v: Value) => (typeof v === "number" ? (Object.is(v, -0) ? "-0" : String(v)) : `s${v}`);

/** Which encodings can store a column of this type and these values. */
export function applicable(type: ColType, values: readonly Value[], e: EncodingName): boolean {
  if (e === "for" || e === "delta") return isInt(type);
  if (e === "bitpack") return isInt(type) && (values as number[]).every((v) => v >= 0);
  return true;
}

// ---------------- plain ----------------

function writePlain(w: ByteWriter, type: ColType, v: Value) {
  if (type === "int32") w.i32(v as number);
  else if (type === "int64") w.i64(v as number);
  else if (type === "float64") w.f64(v as number);
  else { const b = new TextEncoder().encode(v as string); w.i32(b.length); w.bytes(b); }
}
function readPlain(r: ByteReader, type: ColType): Value {
  if (type === "int32") return r.i32();
  if (type === "int64") return r.i64();
  if (type === "float64") return r.f64();
  const n = r.i32();
  return new TextDecoder().decode(r.bytes(n));
}
export function plainBytes(type: ColType, values: readonly Value[]): Uint8Array {
  const w = new ByteWriter();
  w.varint(values.length);
  for (const v of values) writePlain(w, type, v);
  return w.done();
}

// ---------------- run-length ----------------

export interface Run { value: Value; length: number }
export function runsOf(values: readonly Value[]): Run[] {
  const runs: Run[] = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && keyOf(last.value) === keyOf(v)) last.length++;
    else runs.push({ value: v, length: 1 });
  }
  return runs;
}

// ---------------- frame of reference blocks ----------------

function writeForBlocks(w: ByteWriter, vals: readonly number[], blocks?: { min: number; width: number }[]) {
  for (let i = 0; i < vals.length; i += FOR_BLOCK) {
    const blk = vals.slice(i, i + FOR_BLOCK);
    let min = Infinity, max = -Infinity;
    for (const v of blk) { if (v < min) min = v; if (v > max) max = v; }
    const width = bitWidth(max - min);
    w.zigzag(min);
    w.u8(width);
    const bw = new BitWriter(w);
    for (const v of blk) bw.write(v - min, width);
    bw.flush();
    blocks?.push({ min, width });
  }
}
function readForBlocks(r: ByteReader, n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const min = r.zigzag();
    const width = r.u8();
    const br = new BitReader(r);
    const m = Math.min(FOR_BLOCK, n - out.length);
    for (let i = 0; i < m; i++) out.push(min + br.read(width));
  }
  return out;
}

// ---------------- encode / decode ----------------

const show = (v: Value) => (typeof v === "string" ? v : Number.isInteger(v) ? String(v) : v.toFixed(2));
const signed = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
const PREVIEW = 6;

export function encode(type: ColType, values: readonly Value[], e: EncodingName): Encoded {
  if (!applicable(type, values, e)) throw new Error(`${e} does not apply to this column`);
  const w = new ByteWriter();
  w.varint(values.length);
  let preview = "";
  const head = values.slice(0, PREVIEW);
  switch (e) {
    case "plain":
      for (const v of values) writePlain(w, type, v);
      preview = head.map(show).join(" ");
      break;
    case "rle": {
      const runs = runsOf(values);
      for (const r of runs) {
        let left = r.length;
        while (left > 0) { const k = Math.min(left, RLE_MAX_RUN); w.u16(k); writePlain(w, type, r.value); left -= k; }
      }
      preview = runs.slice(0, 4).map((r) => `(${show(r.value)} ×${r.length})`).join(" ") + ` … ${runs.length} runs`;
      break;
    }
    case "dict": {
      const index = new Map<string, number>();
      const dict: Value[] = [];
      const codes: number[] = [];
      for (const v of values) {
        const k = keyOf(v);
        let c = index.get(k);
        if (c === undefined) { c = dict.length; index.set(k, c); dict.push(v); }
        codes.push(c);
      }
      w.varint(dict.length);
      for (const v of dict) writePlain(w, type, v);
      const width = bitWidth(dict.length - 1);
      w.u8(width);
      const bw = new BitWriter(w);
      for (const c of codes) bw.write(c, width);
      bw.flush();
      preview = `dict[${dict.length}] = ${dict.slice(0, 3).map(show).join(", ")}${dict.length > 3 ? ", …" : ""} · ${width}-bit codes ${codes.slice(0, PREVIEW).join(" ")}`;
      break;
    }
    case "for": {
      const blocks: { min: number; width: number }[] = [];
      writeForBlocks(w, values as number[], blocks);
      const b0 = blocks[0];
      preview = b0 ? `min ${b0.min}, ${b0.width} bits: ${(head as number[]).map((v) => signed(v - b0.min)).join(" ")}` : "";
      break;
    }
    case "delta": {
      const v = values as number[];
      if (v.length > 0) {
        w.zigzag(v[0]!);
        const deltas = v.slice(1).map((x, i) => x - v[i]!);
        const blocks: { min: number; width: number }[] = [];
        writeForBlocks(w, deltas, blocks);
        const b0 = blocks[0];
        preview = `first ${v[0]}, deltas ${deltas.slice(0, PREVIEW - 1).map(signed).join(" ")}${b0 ? ` → min ${b0.min}, ${b0.width} bits` : ""}`;
      }
      break;
    }
    case "bitpack": {
      const v = values as number[];
      const width = bitWidth(Math.max(0, ...v));
      w.u8(width);
      const bw = new BitWriter(w);
      for (const x of v) bw.write(x, width);
      bw.flush();
      preview = `${width} bits each: ${head.map(show).join(" ")}`;
      break;
    }
    case "lz4": {
      const plain = plainBytes(type, values);
      const c = lz4Compress(plain);
      const out = new ByteWriter();
      out.varint(values.length);
      out.varint(plain.length);
      out.bytes(c);
      return { encoding: e, bytes: out.done(), preview: `${plain.length} B of plain bytes → ${c.length} B of LZ4 sequences` };
    }
  }
  return { encoding: e, bytes: w.done(), preview };
}

export function decode(type: ColType, enc: Encoded | { encoding: EncodingName; bytes: Uint8Array }): Value[] {
  const r = new ByteReader(enc.bytes);
  const n = r.varint();
  const out: Value[] = [];
  switch (enc.encoding) {
    case "plain":
      for (let i = 0; i < n; i++) out.push(readPlain(r, type));
      break;
    case "rle":
      while (out.length < n) { const k = r.u16(); const v = readPlain(r, type); for (let i = 0; i < k; i++) out.push(v); }
      break;
    case "dict": {
      const d = r.varint();
      const dict: Value[] = [];
      for (let i = 0; i < d; i++) dict.push(readPlain(r, type));
      const width = r.u8();
      const br = new BitReader(r);
      for (let i = 0; i < n; i++) out.push(dict[br.read(width)]!);
      break;
    }
    case "for":
      out.push(...readForBlocks(r, n));
      break;
    case "delta": {
      if (n === 0) break;
      let x = r.zigzag();
      out.push(x);
      for (const d of readForBlocks(r, n - 1)) { x += d; out.push(x); }
      break;
    }
    case "bitpack": {
      const width = r.u8();
      const br = new BitReader(r);
      for (let i = 0; i < n; i++) out.push(br.read(width));
      break;
    }
    case "lz4": {
      const plainLen = r.varint();
      const plain = lz4Decompress(enc.bytes.subarray(r.pos));
      if (plain.length !== plainLen) throw new Error("LZ4 length mismatch");
      const pr = new ByteReader(plain);
      pr.varint();
      for (let i = 0; i < n; i++) out.push(readPlain(pr, type));
      break;
    }
  }
  return out;
}

export interface EncodingResult { encoding: EncodingName; bytes: number; ratio: number; preview: string }

/** Encodes a column with every applicable encoding. `ratio` = plain size / encoded size. */
export function encodeAll(type: ColType, values: readonly Value[]): EncodingResult[] {
  const plain = plainBytes(type, values).length;
  return ENCODINGS.filter((e) => applicable(type, values, e)).map((e) => {
    const x = encode(type, values, e);
    return { encoding: e, bytes: x.bytes.length, ratio: plain / x.bytes.length, preview: x.preview };
  });
}

/**
 * Picks the smallest lightweight encoding, the way DuckDB's analyzer does at checkpoint time:
 * every method estimates its size and the smallest one wins. LZ4 is left out, as in DuckDB storage.
 */
export function chooseEncoding(type: ColType, values: readonly Value[]): EncodingResult {
  return encodeAll(type, values).filter((r) => r.encoding !== "lz4").reduce((a, b) => (b.bytes < a.bytes ? b : a));
}
