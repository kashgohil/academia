/**
 * Slotted pages and tuple layout, modelled on PostgreSQL's heap page (bufpage.h, itemid.h, htup_details.h).
 *
 * Page layout (all offsets in bytes from the start of the page):
 *
 *   0                24          lower          upper                   special   size
 *   | header (24 B) | slot array → |  free space  | ← tuples (newest first) | special |
 *
 * - The header stores `lower` (end of the slot array) and `upper` (start of the tuple area), like
 *   pd_lower and pd_upper.
 * - Each slot (PostgreSQL: line pointer, ItemIdData) is 4 bytes: 15-bit offset, 2-bit flags, 15-bit length.
 * - A record ID is (page, slot). Compaction moves tuples but never changes slot numbers, so record IDs stay valid.
 */

export const PAGE_HEADER = 24;
export const SLOT_BYTES = 4;
/** PostgreSQL MAXALIGN on 64-bit platforms. */
export const MAXALIGN = 8;

export const LP_UNUSED = 0, LP_NORMAL = 1, LP_REDIRECT = 2, LP_DEAD = 3;
export type SlotFlags = typeof LP_UNUSED | typeof LP_NORMAL | typeof LP_REDIRECT | typeof LP_DEAD;

export const alignUp = (n: number, a = MAXALIGN) => Math.ceil(n / a) * a;
export const alignDown = (n: number, a = MAXALIGN) => Math.floor(n / a) * a;

/** Record ID: where a tuple lives. PostgreSQL calls it a TID or ctid, written (page,slot). */
export interface Rid { page: number; slot: number }

export interface SlotInfo { slot: number; flags: SlotFlags; off: number; len: number }

export type UpdateResult = "in-place" | "moved" | "compacted" | "no-room";

/** Real page sizes. */
export const PAGE_SIZES = {
  postgres: 8192,
  innodb: 16384,
  sqlite: 4096,
  oracle: 8192,
  sqlserver: 8192,
} as const;

/**
 * A slotted page over real bytes. The page owns a Uint8Array of `size` bytes; the header,
 * slot array and tuples are encoded in it, so it can be checksummed or written as-is.
 */
export class SlottedPage {
  readonly bytes: Uint8Array;
  private dv: DataView;
  readonly size: number;
  readonly align: number;

  constructor(size = 8192, opts: { align?: number; special?: number; bytes?: Uint8Array } = {}) {
    if (size > 32768) throw new Error("15-bit offsets allow pages up to 32 KiB");
    this.size = size;
    this.align = opts.align ?? MAXALIGN;
    this.bytes = opts.bytes ?? new Uint8Array(size);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, size);
    if (!opts.bytes) {
      const special = size - (opts.special ?? 0);
      this.lower = PAGE_HEADER;
      this.upper = special;
      this.dv.setUint16(16, special, true);
      this.dv.setUint16(18, size | 4, true); // pd_pagesize_version: size + layout version 4
    }
  }

  // ---------- header fields ----------
  get lower() { return this.dv.getUint16(12, true); }
  set lower(v: number) { this.dv.setUint16(12, v, true); }
  get upper() { return this.dv.getUint16(14, true); }
  set upper(v: number) { this.dv.setUint16(14, v, true); }
  get special() { return this.dv.getUint16(16, true); }
  /** Page LSN (stored as two 32-bit halves, like PostgreSQL). */
  get lsn() { return this.dv.getUint32(0, true) * 2 ** 32 + this.dv.getUint32(4, true); }
  set lsn(v: number) { this.dv.setUint32(0, Math.floor(v / 2 ** 32), true); this.dv.setUint32(4, v >>> 0, true); }
  get checksum() { return this.dv.getUint16(8, true); }
  set checksum(v: number) { this.dv.setUint16(8, v, true); }

  get slotCount() { return (this.lower - PAGE_HEADER) / SLOT_BYTES; }

  // ---------- slots ----------
  slot(i: number): SlotInfo {
    const w = this.dv.getUint32(PAGE_HEADER + i * SLOT_BYTES, true);
    return { slot: i, off: w & 0x7fff, flags: ((w >>> 15) & 3) as SlotFlags, len: w >>> 17 };
  }
  private setSlot(i: number, off: number, flags: SlotFlags, len: number) {
    this.dv.setUint32(PAGE_HEADER + i * SLOT_BYTES, ((len << 17) | (flags << 15) | off) >>> 0, true);
  }
  slots(): SlotInfo[] { return Array.from({ length: this.slotCount }, (_, i) => this.slot(i)); }

  // ---------- space ----------
  /** Contiguous free bytes between the slot array and the tuples. */
  get freeContiguous() { return this.upper - this.lower; }
  /** Free space for one new tuple, after its new slot (PostgreSQL PageGetFreeSpace). */
  get freeForInsert() { return Math.max(0, this.freeContiguous - SLOT_BYTES); }
  /** Bytes in the tuple area that no live tuple uses (deleted tuples, old versions, alignment gaps). */
  get garbage() {
    let live = 0;
    for (const s of this.slots()) if (s.flags === LP_NORMAL) live += alignUp(s.len, this.align);
    return this.special - this.upper - live;
  }
  /** Free bytes after a compaction. */
  get freeAfterCompact() { return this.freeContiguous + this.garbage; }

  private firstUnused(): number {
    for (let i = 0; i < this.slotCount; i++) if (this.slot(i).flags === LP_UNUSED) return i;
    return -1;
  }

  /**
   * Inserts a tuple. Reuses an unused slot if there is one, else grows the slot array.
   * If the contiguous gap is too small but deleted space would make room, it compacts first.
   * Returns the slot number, or null if the tuple does not fit.
   */
  insert(data: Uint8Array, opts: { autoCompact?: boolean } = {}): number | null {
    const need = alignUp(data.length, this.align);
    if (data.length >= 1 << 15) return null;
    const fits = () => {
      const reuse = this.firstUnused();
      return this.freeContiguous >= need + (reuse < 0 ? SLOT_BYTES : 0);
    };
    if (!fits()) {
      if ((opts.autoCompact ?? true) && this.compactWouldFit(need)) this.compact();
      if (!fits()) return null;
    }
    let slot = this.firstUnused();
    if (slot < 0) { slot = this.slotCount; this.lower = this.lower + SLOT_BYTES; }
    this.upper = this.upper - need;
    this.bytes.set(data, this.upper);
    this.bytes.fill(0, this.upper + data.length, this.upper + need);
    this.setSlot(slot, this.upper, LP_NORMAL, data.length);
    return slot;
  }

  private compactWouldFit(need: number) {
    // After compaction, trailing unused/dead slots are removed, and dead slots become reusable.
    const ss = this.slots();
    let n = ss.length;
    while (n > 0 && ss[n - 1]!.flags !== LP_NORMAL) n--;
    const hasHole = ss.slice(0, n).some((s) => s.flags !== LP_NORMAL);
    const lower = PAGE_HEADER + n * SLOT_BYTES;
    const live = ss.reduce((a, s) => a + (s.flags === LP_NORMAL ? alignUp(s.len, this.align) : 0), 0);
    return this.special - live - lower >= need + (hasHole ? 0 : SLOT_BYTES);
  }

  /** Reads a live tuple. */
  read(slot: number): Uint8Array | null {
    if (slot >= this.slotCount) return null;
    const s = this.slot(slot);
    if (s.flags !== LP_NORMAL) return null;
    return this.bytes.slice(s.off, s.off + s.len);
  }

  /**
   * Deletes a tuple. The slot becomes DEAD: its number is not reused yet, and its bytes stay
   * until compaction. (PostgreSQL also waits until VACUUM has removed index entries that point to the slot.)
   */
  delete(slot: number): boolean {
    if (slot >= this.slotCount) return false;
    const s = this.slot(slot);
    if (s.flags !== LP_NORMAL) return false;
    this.setSlot(slot, s.off, LP_DEAD, s.len);
    return true;
  }

  /**
   * Replaces a tuple and keeps its slot (so the record ID does not change).
   * - in-place: the new tuple is not larger (after alignment) than the old one.
   * - moved: it is written into the free gap, and the slot points to the new place.
   * - compacted: the page was compacted first to make a large enough gap.
   * - no-room: the page cannot hold it; the caller must move the record to another page.
   */
  update(slot: number, data: Uint8Array): UpdateResult {
    const s = this.slot(slot);
    if (s.flags !== LP_NORMAL) throw new Error(`slot ${slot} is not live`);
    const need = alignUp(data.length, this.align);
    if (need <= alignUp(s.len, this.align)) {
      this.bytes.set(data, s.off);
      this.bytes.fill(0, s.off + data.length, s.off + alignUp(s.len, this.align));
      this.setSlot(slot, s.off, LP_NORMAL, data.length);
      return "in-place";
    }
    if (this.freeContiguous >= need) {
      this.upper = this.upper - need;
      this.bytes.set(data, this.upper);
      this.setSlot(slot, this.upper, LP_NORMAL, data.length);
      return "moved";
    }
    // Would a compaction without the old version make room?
    const freeIfCompacted = this.freeAfterCompact + alignUp(s.len, this.align);
    if (freeIfCompacted < need) return "no-room";
    this.setSlot(slot, s.off, LP_REDIRECT, 0); // keep the slot while compacting
    this.compact();
    this.upper = this.upper - need;
    this.bytes.set(data, this.upper);
    this.setSlot(slot, this.upper, LP_NORMAL, data.length);
    return "compacted";
  }

  /**
   * Moves all live tuples to the end of the page, in slot-offset order, so the free space is one gap.
   * Dead slots become unused (reusable); trailing unused slots are removed.
   * Returns the number of tuple bytes moved.
   */
  compact(): number {
    const ss = this.slots();
    const live = ss.filter((s) => s.flags === LP_NORMAL).sort((a, b) => b.off - a.off);
    let pos = this.special, moved = 0;
    for (const s of live) {
      pos -= alignUp(s.len, this.align);
      if (pos !== s.off) { this.bytes.copyWithin(pos, s.off, s.off + s.len); moved += s.len; }
      this.setSlot(s.slot, pos, LP_NORMAL, s.len);
    }
    for (const s of ss) if (s.flags === LP_DEAD) this.setSlot(s.slot, 0, LP_UNUSED, 0);
    // A REDIRECT here is a slot held open by update(); keep it.
    let n = ss.length;
    while (n > 0 && this.slot(n - 1).flags === LP_UNUSED) n--;
    this.lower = PAGE_HEADER + n * SLOT_BYTES;
    this.bytes.fill(0, this.lower, pos);
    this.upper = pos;
    return moved;
  }

  /** Live record count. */
  get liveCount() { return this.slots().filter((s) => s.flags === LP_NORMAL).length; }
}

/** How many tuples of `tupleBytes` fit on an empty page (each needs MAXALIGN(len) + one slot). */
export function tuplesPerPage(tupleBytes: number, pageBytes = 8192, align = MAXALIGN): number {
  return Math.floor((pageBytes - PAGE_HEADER) / (alignUp(tupleBytes, align) + SLOT_BYTES));
}

// =====================================================================================
// PostgreSQL heap tuple layout
// =====================================================================================

/** HeapTupleHeaderData: xmin 4, xmax 4, cid 4, ctid 6, infomask2 2, infomask 2, hoff 1 = 23 bytes. */
export const PG_TUPLE_HEADER = 23;
/** MaxHeapTuplesPerPage for a page size: tuples with no data at all. */
export const maxHeapTuplesPerPage = (pageBytes = 8192) =>
  Math.floor((pageBytes - PAGE_HEADER) / (alignUp(PG_TUPLE_HEADER) + SLOT_BYTES));

/** MaximumBytesPerTuple(n): the largest tuple such that n of them fit on one page. */
export const maxBytesPerTuple = (n: number, pageBytes = 8192) =>
  alignDown((pageBytes - alignUp(PAGE_HEADER + n * SLOT_BYTES)) / n);
/** TOAST_TUPLE_THRESHOLD: above this size, PostgreSQL compresses or moves wide values out of line. */
export const toastThreshold = (pageBytes = 8192) => maxBytesPerTuple(4, pageBytes);
/** TOAST_MAX_CHUNK_SIZE: payload of one row in the TOAST table (chunk_id oid, chunk_seq int4, varlena header). */
export const toastChunk = (pageBytes = 8192) => maxBytesPerTuple(4, pageBytes) - alignUp(PG_TUPLE_HEADER) - 4 - 4 - 4;
/** An out-of-line TOAST pointer in the main tuple: 2 header bytes + varatt_external (16 bytes). */
export const TOAST_POINTER = 18;
/** A varlena with at most this many data bytes gets a 1-byte header and no alignment. */
export const SHORT_VARLENA_MAX = 126;

export type PgType = "bool" | "int2" | "int4" | "int8" | "float8" | "timestamptz" | "uuid" | "text";
/** typlen (-1 = varlena) and typalign in bytes. */
export const PG_TYPES: Record<PgType, { len: number; align: number }> = {
  bool: { len: 1, align: 1 },
  int2: { len: 2, align: 2 },
  int4: { len: 4, align: 4 },
  int8: { len: 8, align: 8 },
  float8: { len: 8, align: 8 },
  timestamptz: { len: 8, align: 8 },
  uuid: { len: 16, align: 1 },
  text: { len: -1, align: 4 },
};

export interface PgColumn { name: string; type: PgType; isNull?: boolean; /** text bytes */ textLen?: number }

export interface Segment {
  kind: "header" | "bitmap" | "pad" | "data" | "varhdr" | "toast";
  start: number;
  len: number;
  col?: number;
}

export interface TupleLayout {
  segments: Segment[];
  /** t_hoff: start of the data area. */
  hoff: number;
  /** Unaligned tuple length (what the slot stores). */
  len: number;
  /** Space on the page: MAXALIGN(len) + 4-byte slot. */
  onPage: number;
  padding: number;
  /** Indexes of columns moved to the TOAST table, and their chunk counts. */
  toasted: { col: number; chunks: number }[];
}

/**
 * Byte layout of one PostgreSQL heap tuple: 23-byte header, optional null bitmap, padding to MAXALIGN,
 * then each non-null column at its type alignment. Short text values (≤ 126 bytes) have a 1-byte header
 * and no alignment; longer ones a 4-byte header, aligned to 4. If the aligned tuple is larger than the
 * TOAST threshold (2032 bytes for 8 KiB pages), the largest text values move out of line (we assume they do
 * not compress) and leave an 18-byte pointer.
 */
export function pgTupleLayout(cols: PgColumn[], pageBytes = 8192): TupleLayout {
  const toastSet = new Set<number>();
  const threshold = toastThreshold(pageBytes);
  for (;;) {
    const lay = layoutOnce(cols, toastSet);
    if (alignUp(lay.len) <= threshold) {
      const chunk = toastChunk(pageBytes);
      lay.toasted = [...toastSet].sort((a, b) => a - b).map((c) => ({ col: c, chunks: Math.ceil((cols[c]!.textLen ?? 0) / chunk) }));
      return lay;
    }
    let best = -1, bl = TOAST_POINTER;
    cols.forEach((c, i) => {
      if (c.type === "text" && !c.isNull && !toastSet.has(i) && (c.textLen ?? 0) + 4 > bl) { bl = (c.textLen ?? 0) + 4; best = i; }
    });
    if (best < 0) { lay.toasted = []; return lay; }
    toastSet.add(best);
  }
}

function layoutOnce(cols: PgColumn[], toastSet: Set<number>): TupleLayout {
  const segments: Segment[] = [{ kind: "header", start: 0, len: PG_TUPLE_HEADER }];
  let off = PG_TUPLE_HEADER, padding = 0;
  if (cols.some((c) => c.isNull)) {
    const b = Math.ceil(cols.length / 8);
    segments.push({ kind: "bitmap", start: off, len: b });
    off += b;
  }
  const hoff = alignUp(off);
  if (hoff > off) { segments.push({ kind: "pad", start: off, len: hoff - off }); padding += hoff - off; }
  off = hoff;
  cols.forEach((c, i) => {
    if (c.isNull) return;
    const t = PG_TYPES[c.type];
    if (t.len === -1) {
      const n = c.textLen ?? 0;
      if (toastSet.has(i)) {
        segments.push({ kind: "toast", start: off, len: TOAST_POINTER, col: i });
        off += TOAST_POINTER;
      } else if (n <= SHORT_VARLENA_MAX) {
        segments.push({ kind: "varhdr", start: off, len: 1, col: i });
        if (n) segments.push({ kind: "data", start: off + 1, len: n, col: i });
        off += 1 + n;
      } else {
        const a = alignUp(off, t.align);
        if (a > off) { segments.push({ kind: "pad", start: off, len: a - off }); padding += a - off; }
        segments.push({ kind: "varhdr", start: a, len: 4, col: i });
        segments.push({ kind: "data", start: a + 4, len: n, col: i });
        off = a + 4 + n;
      }
      return;
    }
    const a = alignUp(off, t.align);
    if (a > off) { segments.push({ kind: "pad", start: off, len: a - off }); padding += a - off; }
    segments.push({ kind: "data", start: a, len: t.len, col: i });
    off = a + t.len;
  });
  const onPage = alignUp(off) + SLOT_BYTES;
  return { segments, hoff, len: off, onPage, padding, toasted: [] };
}
