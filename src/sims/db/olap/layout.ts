/**
 * Row, column and PAX page layouts with exact byte accounting.
 *
 * - NSM (n-ary storage model, a row store): each page holds whole rows, one after the other.
 * - DSM (decomposition storage model, a column store): each page holds values of one column only.
 * - PAX (partition attributes across): each page holds whole rows, but inside the page every
 *   column has its own "minipage", so the values of one column are next to each other.
 *
 * The model ignores page headers, slot arrays and alignment, so the byte counts show only the
 * effect of the layout. A row ID is the position of the row (0, 1, 2, ...): no layout stores it.
 */

export interface ColumnDef { name: string; bytes: number }
export type LayoutKind = "nsm" | "dsm" | "pax";
export const CACHE_LINE = 64;

export interface Placement { page: number; offset: number; bytes: number }

/** A layout of `rows` rows of `schema` in pages of `pageBytes` bytes. */
export class Layout {
  readonly rowBytes: number;
  readonly colOffset: number[];
  /** NSM / PAX: rows per page. */
  readonly rowsPerPage: number;
  /** DSM: values per page for each column, and the first page id of each column. */
  readonly valuesPerPage: number[];
  readonly firstPage: number[];
  readonly pageCount: number;

  constructor(readonly kind: LayoutKind, readonly schema: readonly ColumnDef[], readonly rows: number, readonly pageBytes: number) {
    this.colOffset = [];
    let off = 0;
    for (const c of schema) { this.colOffset.push(off); off += c.bytes; }
    this.rowBytes = off;
    this.rowsPerPage = Math.floor(pageBytes / this.rowBytes);
    if (kind !== "dsm" && this.rowsPerPage < 1) throw new Error("a row does not fit in a page");
    this.valuesPerPage = schema.map((c) => Math.floor(pageBytes / c.bytes));
    this.firstPage = [];
    if (kind === "dsm") {
      let p = 0;
      for (let c = 0; c < schema.length; c++) { this.firstPage.push(p); p += Math.ceil(rows / this.valuesPerPage[c]!); }
      this.pageCount = p;
    } else {
      this.pageCount = Math.ceil(rows / this.rowsPerPage);
    }
  }

  /** Where the value of (row, col) is stored. */
  place(row: number, col: number): Placement {
    const w = this.schema[col]!.bytes;
    if (this.kind === "dsm") {
      const vpp = this.valuesPerPage[col]!;
      return { page: this.firstPage[col]! + Math.floor(row / vpp), offset: (row % vpp) * w, bytes: w };
    }
    const rpp = this.rowsPerPage;
    const page = Math.floor(row / rpp), slot = row % rpp;
    if (this.kind === "nsm") return { page, offset: slot * this.rowBytes + this.colOffset[col]!, bytes: w };
    // PAX: the minipage of a column starts at rpp × (sum of the widths of the earlier columns).
    return { page, offset: rpp * this.colOffset[col]! + slot * w, bytes: w };
  }

  /** For drawing: for each page, which (row, col) owns each byte (-1 = unused space). */
  pageMap(page: number): { col: Int16Array; row: Int32Array } {
    const col = new Int16Array(this.pageBytes).fill(-1);
    const row = new Int32Array(this.pageBytes).fill(-1);
    for (const [r, c] of this.cellsOfPage(page)) {
      const p = this.place(r, c);
      for (let b = 0; b < p.bytes; b++) { col[p.offset + b] = c; row[p.offset + b] = r; }
    }
    return { col, row };
  }

  /** All (row, col) cells stored in a page. */
  cellsOfPage(page: number): [number, number][] {
    const out: [number, number][] = [];
    if (this.kind === "dsm") {
      let c = this.firstPage.length - 1;
      while (this.firstPage[c]! > page) c--;
      const vpp = this.valuesPerPage[c]!;
      const r0 = (page - this.firstPage[c]!) * vpp;
      for (let r = r0; r < Math.min(this.rows, r0 + vpp); r++) out.push([r, c]);
      return out;
    }
    const r0 = page * this.rowsPerPage;
    for (let r = r0; r < Math.min(this.rows, r0 + this.rowsPerPage); r++) for (let c = 0; c < this.schema.length; c++) out.push([r, c]);
    return out;
  }
}

export interface Footprint {
  /** Bytes of the values that the query needs. */
  usefulBytes: number;
  /** Distinct pages that hold at least one needed value: the pages the engine reads from disk. */
  pages: number;
  /** Bytes read from disk: pages × page size. */
  diskBytes: number;
  /** Distinct 64-byte cache lines that hold a needed byte (pages start on a line boundary). */
  lines: number;
  /** Bytes moved from memory into the cache: lines × 64. */
  memoryBytes: number;
  /** The touched lines as "page:line" keys, for drawing. */
  lineKeys: Set<string>;
  pageIds: Set<number>;
}

/** Exact footprint of a set of (row, col) cells in a layout. */
export function footprint(layout: Layout, cells: Iterable<readonly [number, number]>): Footprint {
  const pages = new Set<number>();
  const lines = new Set<string>();
  let useful = 0;
  for (const [r, c] of cells) {
    const p = layout.place(r, c);
    useful += p.bytes;
    pages.add(p.page);
    for (let l = Math.floor(p.offset / CACHE_LINE); l <= Math.floor((p.offset + p.bytes - 1) / CACHE_LINE); l++) lines.add(`${p.page}:${l}`);
  }
  return { usefulBytes: useful, pages: pages.size, diskBytes: pages.size * layout.pageBytes, lines: lines.size, memoryBytes: lines.size * CACHE_LINE, lineKeys: lines, pageIds: pages };
}

/** Cells of a query that reads `cols` for the rows in `rows`. */
export function cellsOf(rows: Iterable<number>, cols: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of rows) for (const c of cols) out.push([r, c]);
  return out;
}
export const allRows = (n: number) => Array.from({ length: n }, (_, i) => i);

// ---------------- the small table of the visualizer ----------------

/** A 32-byte row: seven columns, as in a small sales fact table. */
export const ORDERS: readonly ColumnDef[] = [
  { name: "id", bytes: 4 },
  { name: "date", bytes: 4 },
  { name: "customer", bytes: 4 },
  { name: "product", bytes: 4 },
  { name: "qty", bytes: 4 },
  { name: "price", bytes: 8 },
  { name: "discount", bytes: 4 },
];

export type QueryName = "sum" | "filter" | "point" | "insert";
export interface QueryDef { name: QueryName; sql: string; cols: number[]; rows: (n: number) => number[] }
export const QUERIES: Record<QueryName, QueryDef> = {
  sum: { name: "sum", sql: "SELECT SUM(price) FROM orders", cols: [5], rows: allRows },
  filter: { name: "filter", sql: "SELECT SUM(qty * price) FROM orders WHERE date >= '2026-01-01'", cols: [1, 4, 5], rows: allRows },
  point: { name: "point", sql: "SELECT * FROM orders WHERE id = 13", cols: [0, 1, 2, 3, 4, 5, 6], rows: () => [13] },
  insert: { name: "insert", sql: "INSERT INTO orders VALUES (...)", cols: [0, 1, 2, 3, 4, 5, 6], rows: (n) => [n - 1] },
};

/** Footprint of one of the named queries on the small table. For "insert", the new row is the last row. */
export function queryFootprint(kind: LayoutKind, q: QueryName, rows: number, pageBytes: number): Footprint {
  const L = new Layout(kind, ORDERS, rows, pageBytes);
  const d = QUERIES[q];
  return footprint(L, cellsOf(d.rows(rows), d.cols));
}

// ---------------- closed-form scans of a large table ----------------

/** A wide table of `columns` columns of `width` bytes each. */
export const wideSchema = (columns: number, width = 8): ColumnDef[] => Array.from({ length: columns }, (_, i) => ({ name: `c${i}`, bytes: width }));

/**
 * Exact footprint of a full scan of the columns `cols` over `rows` rows, without visiting every row.
 * Every full page has the same pattern, so the function measures one full page and the last page.
 */
export function scanFootprint(kind: LayoutKind, schema: readonly ColumnDef[], rows: number, pageBytes: number, cols: readonly number[]): { pages: number; diskBytes: number; lines: number; memoryBytes: number; usefulBytes: number } {
  const useful = cols.reduce((s, c) => s + schema[c]!.bytes, 0) * rows;
  if (kind === "dsm") {
    let pages = 0, lines = 0;
    for (const c of cols) {
      const w = schema[c]!.bytes, vpp = Math.floor(pageBytes / w);
      const full = Math.floor(rows / vpp), rest = rows % vpp;
      pages += full + (rest ? 1 : 0);
      lines += full * Math.ceil((vpp * w) / CACHE_LINE) + Math.ceil((rest * w) / CACHE_LINE);
    }
    return { pages, diskBytes: pages * pageBytes, lines, memoryBytes: lines * CACHE_LINE, usefulBytes: useful };
  }
  const rowBytes = schema.reduce((s, c) => s + c.bytes, 0);
  const rpp = Math.floor(pageBytes / rowBytes);
  const full = Math.floor(rows / rpp), rest = rows % rpp;
  const linesIn = (n: number) => {
    if (n === 0) return 0;
    const L = new Layout(kind, schema, n, pageBytes);
    return footprint(L, cellsOf(allRows(n), cols)).lines;
  };
  const pages = full + (rest ? 1 : 0);
  const lines = full * linesIn(rpp) + linesIn(rest);
  return { pages, diskBytes: pages * pageBytes, lines, memoryBytes: lines * CACHE_LINE, usefulBytes: useful };
}

/** Pages and cache lines to fetch one whole row (or `cols` of it) by its position. */
export function pointFootprint(kind: LayoutKind, schema: readonly ColumnDef[], rows: number, pageBytes: number, cols: readonly number[], row = 0) {
  const L = new Layout(kind, schema, rows, pageBytes);
  return footprint(L, cellsOf([row], cols));
}
