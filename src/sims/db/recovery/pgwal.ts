/**
 * Where a byte of WAL lives in PostgreSQL.
 * An LSN is a 64-bit byte position in the WAL stream, printed as two 32-bit hex halves: "16/B374D848".
 * The stream is cut into segment files (16 MiB by default, set by initdb --wal-segsize). A segment
 * file name is three 8-digit hex numbers: timeline, then the high and low parts of the segment number.
 * Inside a segment, WAL is written in 8 KiB pages (XLOG_BLCKSZ).
 */

export const PG_WAL_SEGMENT = 16 * 1024 * 1024;
export const PG_WAL_PAGE = 8192;

const hex = (n: number, w = 0) => n.toString(16).toUpperCase().padStart(w, "0");

/** "hi/lo" text form of an LSN (as pg_current_wal_lsn() prints it). */
export function pgLsnText(lsn: number): string {
  const hi = Math.floor(lsn / 2 ** 32), lo = lsn % 2 ** 32;
  return `${hex(hi)}/${hex(lo)}`;
}

export interface WalPlace { segment: number; file: string; offsetInSegment: number; walPage: number; offsetInPage: number }

/** Segment number, file name, and offsets of an LSN. */
export function pgWalPlace(lsn: number, timeline = 1, segBytes = PG_WAL_SEGMENT): WalPlace {
  const segment = Math.floor(lsn / segBytes);
  const perId = 2 ** 32 / segBytes; // segments per 4 GiB "xlogid"
  const file = hex(timeline, 8) + hex(Math.floor(segment / perId), 8) + hex(segment % perId, 8);
  const offsetInSegment = lsn % segBytes;
  return { segment, file, offsetInSegment, walPage: Math.floor(offsetInSegment / PG_WAL_PAGE), offsetInPage: offsetInSegment % PG_WAL_PAGE };
}
