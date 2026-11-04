/**
 * Physical, logical and physiological logging on a tiny slotted page.
 *
 * Page layout (PAGE_BYTES bytes, SECTOR_BYTES per sector):
 *   byte 0: pageLSN   byte 1: number of slots   byte 2: start of the record area   byte 3: checksum
 *   bytes 4..: slot directory, 1 byte per slot = offset of the record (0 = deleted)
 *   records grow down from the end of the page; each record is 4 ASCII bytes: name (3) + qty digit (1)
 * The checksum is the sum of every other byte, mod 256 (real engines use CRC-32C or similar).
 *
 * The same five operations are logged four ways. Replay runs the log since the last checkpoint
 * on the page that is on disk after a crash, and the result is compared with the correct page.
 */

export const PAGE_BYTES = 64;
export const SECTOR_BYTES = 16;
export const REC_BYTES = 4;
/** Header of every log record in this toy encoding: LSN, type, page, length. */
export const TOY_HEADER = 4;

export type PageBytes = Uint8Array;

export function emptyPage(): PageBytes {
  const p = new Uint8Array(PAGE_BYTES);
  p[2] = PAGE_BYTES;
  p[3] = checksum(p);
  return p;
}

export function checksum(p: PageBytes): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) if (i !== 3) s += p[i]!;
  return s & 255;
}
export const checksumOk = (p: PageBytes) => p[3] === checksum(p);

const seal = (p: PageBytes, lsn: number) => {
  p[0] = lsn;
  p[3] = checksum(p);
};

export interface Row { name: string; qty: number }

/** Reads the live rows; null if the page structure is not valid. */
export function rows(p: PageBytes): Row[] | null {
  const n = p[1]!, start = p[2]!;
  if (4 + n > start || start > PAGE_BYTES) return null;
  const out: Row[] = [];
  for (let s = 0; s < n; s++) {
    const off = p[4 + s]!;
    if (off === 0) continue;
    if (off < start || off + REC_BYTES > PAGE_BYTES) return null;
    const name = String.fromCharCode(p[off]!, p[off + 1]!, p[off + 2]!);
    const q = p[off + 3]! - 48;
    if (!/^[a-z]{3}$/.test(name) || q < 0 || q > 9) return null;
    out.push({ name, qty: q });
  }
  return out;
}

// ---------------- page operations (what physiological redo does) ----------------

function insertRow(p: PageBytes, r: Row): number {
  const start = p[2]! - REC_BYTES;
  const slot = p[1]!;
  for (let i = 0; i < 3; i++) p[start + i] = r.name.charCodeAt(i);
  p[start + 3] = 48 + r.qty;
  p[4 + slot] = start;
  p[1] = slot + 1;
  p[2] = start;
  return slot;
}
const setQty = (p: PageBytes, slot: number, qty: number) => { p[p[4 + slot]! + 3] = 48 + qty; };
const deleteSlot = (p: PageBytes, slot: number) => { p[4 + slot] = 0; };
function findSlot(p: PageBytes, name: string): number {
  for (let s = 0; s < p[1]!; s++) {
    const off = p[4 + s]!;
    if (off && String.fromCharCode(p[off]!, p[off + 1]!, p[off + 2]!) === name) return s;
  }
  return -1;
}

// ---------------- the operations ----------------

export type LogicalOp =
  | { op: "insert"; row: Row }
  | { op: "add"; name: string; delta: number }
  | { op: "delete"; name: string };

export const OPS: { sql: string; op: LogicalOp }[] = [
  { sql: "INSERT ('ann', 3)", op: { op: "insert", row: { name: "ann", qty: 3 } } },
  { sql: "INSERT ('bob', 5)", op: { op: "insert", row: { name: "bob", qty: 5 } } },
  { sql: "UPDATE SET qty = qty + 2 WHERE name = 'bob'", op: { op: "add", name: "bob", delta: 2 } },
  { sql: "DELETE WHERE name = 'ann'", op: { op: "delete", name: "ann" } },
  { sql: "INSERT ('cyd', 1)", op: { op: "insert", row: { name: "cyd", qty: 1 } } },
];
/** The last checkpoint comes after this many operations; the log before it is gone. */
export const CHECKPOINT_AFTER = 2;

export type PhysioOp = { op: "insert"; row: Row } | { op: "set"; slot: number; qty: number } | { op: "delete"; slot: number };

/** Applies a logical operation to a page and returns the physiological form of what it did. */
function applyLogical(p: PageBytes, o: LogicalOp): PhysioOp | null {
  if (o.op === "insert") {
    insertRow(p, o.row);
    return { op: "insert", row: o.row };
  }
  const s = findSlot(p, o.name);
  if (s < 0) return null;
  if (o.op === "add") {
    const q = p[p[4 + s]! + 3]! - 48 + o.delta;
    setQty(p, s, q);
    return { op: "set", slot: s, qty: q };
  }
  deleteSlot(p, s);
  return { op: "delete", slot: s };
}

function applyPhysio(p: PageBytes, o: PhysioOp) {
  if (o.op === "insert") insertRow(p, o.row);
  else if (o.op === "set") setQty(p, o.slot, o.qty);
  else deleteSlot(p, o.slot);
}

export type Form = "physical" | "physiological" | "fpw" | "logical";
export const FORMS: { id: Form; label: string }[] = [
  { id: "physical", label: "Physical (byte diffs)" },
  { id: "physiological", label: "Physiological" },
  { id: "fpw", label: "Physiological + full-page writes" },
  { id: "logical", label: "Logical" },
];

export interface ByteRange { off: number; bytes: number[] }
export interface LogEntry {
  lsn: number;
  form: Form;
  text: string;
  bytes: number;
  diff?: ByteRange[];
  physio?: PhysioOp;
  logical?: LogicalOp;
  image?: number[];
}

/** The page after each operation: states[0] is empty, states[i] is after operation i (LSN i). */
export function pageStates(): PageBytes[] {
  const states = [emptyPage()];
  for (let i = 0; i < OPS.length; i++) {
    const p = states[i]!.slice();
    applyLogical(p, OPS[i]!.op);
    seal(p, i + 1);
    states.push(p);
  }
  return states;
}

function diffRanges(a: PageBytes, b: PageBytes): ByteRange[] {
  const out: ByteRange[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const last = out[out.length - 1];
    if (last && last.off + last.bytes.length === i) last.bytes.push(b[i]!);
    else out.push({ off: i, bytes: [b[i]!] });
  }
  return out;
}

const physioText = (o: PhysioOp) =>
  o.op === "insert" ? `insert '${o.row.name}${o.row.qty}' into the page` : o.op === "set" ? `slot ${o.slot}: qty = ${o.qty}` : `slot ${o.slot}: delete`;
const physioBytes = (o: PhysioOp) => TOY_HEADER + 1 + (o.op === "insert" ? REC_BYTES : o.op === "set" ? 2 : 1);
const logicalBytes = (o: LogicalOp) => TOY_HEADER + 2 + (o.op === "insert" ? REC_BYTES : o.op === "add" ? 4 : 3);

/** The log of all operations in one form. Records before CHECKPOINT_AFTER exist but are not replayed. */
export function buildLog(form: Form): LogEntry[] {
  const st = pageStates();
  const out: LogEntry[] = [];
  const scratch = st[0]!.slice();
  for (let i = 0; i < OPS.length; i++) {
    const lsn = i + 1;
    const physio = applyLogical(scratch, OPS[i]!.op)!;
    seal(scratch, lsn);
    if (form === "physical") {
      const diff = diffRanges(st[i]!, st[lsn]!);
      out.push({ lsn, form, diff, text: diff.map((d) => `@${d.off}: ${d.bytes.length} B`).join(", "), bytes: TOY_HEADER + diff.reduce((s, d) => s + 2 + d.bytes.length, 0) });
    } else if (form === "logical") {
      out.push({ lsn, form, logical: OPS[i]!.op, text: OPS[i]!.sql, bytes: logicalBytes(OPS[i]!.op) });
    } else {
      // Full-page writes: the first change after a checkpoint logs the whole page (as it is after the change).
      const fpi = form === "fpw" && (lsn === 1 || lsn === CHECKPOINT_AFTER + 1);
      out.push({ lsn, form, physio, image: fpi ? Array.from(st[lsn]!) : undefined, text: (fpi ? "full page image + " : "") + physioText(physio), bytes: physioBytes(physio) + (fpi ? PAGE_BYTES : 0) });
    }
  }
  return out;
}

/** Total bytes of the log records that replay reads (those after the checkpoint). */
export const logBytes = (form: Form) => buildLog(form).filter((e) => e.lsn > CHECKPOINT_AFTER).reduce((s, e) => s + e.bytes, 0);

export type DiskCase = "checkpoint" | "after4" | "final" | "torn";
export const DISK_CASES: { id: DiskCase; label: string }[] = [
  { id: "checkpoint", label: "Page as of the checkpoint" },
  { id: "after4", label: "Page written after op 4" },
  { id: "final", label: "Page written after op 5" },
  { id: "torn", label: "Torn write of the final page" },
];

/** Sectors of the final page that reached disk in the torn case (the others are old). */
export const TORN_NEW_SECTORS = [0];

/** The page on disk at the crash. */
export function diskPage(c: DiskCase): PageBytes {
  const st = pageStates();
  if (c === "checkpoint") return st[CHECKPOINT_AFTER]!.slice();
  if (c === "after4") return st[4]!.slice();
  if (c === "final") return st[5]!.slice();
  const p = st[CHECKPOINT_AFTER]!.slice();
  for (const s of TORN_NEW_SECTORS) for (let i = s * SECTOR_BYTES; i < (s + 1) * SECTOR_BYTES; i++) p[i] = st[5]![i]!;
  return p;
}

export type Verdict = "correct" | "wrong" | "refused";
export interface ReplayResult { page: PageBytes; verdict: Verdict; applied: number; skipped: number; note: string }

/**
 * Replays the log after the checkpoint on a disk page.
 * `checkLsn`: skip a record when pageLSN >= its LSN (logical records cannot use this check: an
 * operation on a table is not tied to one page). Physiological and logical replay refuse a page
 * whose checksum is wrong, because they must read the page structure to act.
 */
export function replay(form: Form, disk: PageBytes, checkLsn: boolean): ReplayResult {
  const p = disk.slice();
  const log = buildLog(form).filter((e) => e.lsn > CHECKPOINT_AFTER);
  let applied = 0, skipped = 0;
  for (const e of log) {
    if (e.image) {
      // A full page image does not depend on the old page: copy it in.
      if (checkLsn && checksumOk(p) && p[0]! >= e.lsn) { skipped++; continue; }
      p.set(e.image);
      applied++;
      continue;
    }
    if (form === "physical") {
      if (checkLsn && p[0]! >= e.lsn) { skipped++; continue; }
      for (const d of e.diff!) p.set(d.bytes, d.off);
      applied++;
      continue;
    }
    if (!checksumOk(p) || rows(p) === null) {
      return { page: p, verdict: "refused", applied, skipped, note: `Checksum fails before LSN ${e.lsn}: the page is torn, and the record needs a valid page to act on.` };
    }
    if (form === "logical") {
      applyLogical(p, e.logical!);
    } else {
      if (checkLsn && p[0]! >= e.lsn) { skipped++; continue; }
      applyPhysio(p, e.physio!);
    }
    seal(p, e.lsn);
    applied++;
  }
  const want = pageStates()[OPS.length]!;
  const same = sameRows(p, want);
  let note: string;
  if (same) note = "The page has the correct rows.";
  else if (!checksumOk(p)) note = "The checksum still fails: part of the page is old.";
  else note = `Wrong rows: ${fmtRows(rows(p))} (correct: ${fmtRows(rows(want))}).`;
  return { page: p, verdict: same ? "correct" : "wrong", applied, skipped, note };
}

/** Pages are equal as data: same rows and a valid checksum. */
function sameRows(a: PageBytes, b: PageBytes): boolean {
  const ra = rows(a), rb = rows(b);
  return checksumOk(a) && ra !== null && rb !== null && fmtRows(ra) === fmtRows(rb);
}
export const fmtRows = (r: Row[] | null) => (r ? r.map((x) => `${x.name}=${x.qty}`).join(", ") || "none" : "unreadable");

/** All verdicts: form × disk case, with and without the pageLSN check. */
export function verdictTable(checkLsn: boolean): Record<Form, Record<DiskCase, Verdict>> {
  const out = {} as Record<Form, Record<DiskCase, Verdict>>;
  for (const f of FORMS) {
    out[f.id] = {} as Record<DiskCase, Verdict>;
    for (const c of DISK_CASES) out[f.id][c.id] = replay(f.id, diskPage(c.id), checkLsn).verdict;
  }
  return out;
}

// ---------------- sizes at real scale ----------------

/**
 * Log bytes for one row update at real scale, under stated assumptions:
 * a 24-byte record header (PostgreSQL's XLogRecord), a 20-byte block reference (relation, fork, block),
 * an 8 KiB page, and a `rowBytes` row where `changedBytes` bytes change.
 */
export function realSizes(rowBytes = 100, changedBytes = 4, pageBytes = 8192) {
  const H = 24, BLOCK = 20;
  return {
    physicalDiff: H + BLOCK + 4 + changedBytes + 4 + 2, // the changed field + the pageLSN/checksum range (2-byte offset + 2-byte length each)
    physiological: H + BLOCK + 2 + rowBytes, // slot number + new row image
    logical: H + 8 + rowBytes, // table id + key + row
    fullPage: H + BLOCK + pageBytes,
  };
}

/** How many device sectors one page spans (a torn write can stop between any two). */
export const sectorsPerPage = (pageBytes: number, sectorBytes: number) => pageBytes / sectorBytes;
