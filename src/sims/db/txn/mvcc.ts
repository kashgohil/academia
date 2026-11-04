/**
 * MVCC as PostgreSQL does it, reduced to one row.
 *
 * Every version is a heap tuple with xmin (the inserting transaction id), xmax (the deleting or updating
 * transaction id, 0 if none) and ctid (its own position, or the position of the next newer version).
 * An UPDATE sets xmax on the old tuple and appends a new tuple, so chains go from oldest to newest.
 * The commit log (pg_xact) stores the state of each transaction id.
 *
 * A snapshot is (xmin, xmax, xip): every id below xmin has finished, every id at or above xmax had not started,
 * and xip lists the ids in between that were still running. A transaction id is "visible to the snapshot" when it
 * committed and is below xmax and not in xip. Read-only transactions get no transaction id (only a virtual one).
 */

export type XidState = "in progress" | "committed" | "aborted";
export interface PgTuple { lp: number; value: number; xmin: number; xmax: number; ctid: number }
export interface PgSnapshot { xmin: number; xmax: number; xip: number[] }
export interface VisStep { q: string; a: string; pass: boolean | null }

/** Was transaction id x committed, and is it visible to this snapshot? */
export function xidVisible(x: number, snap: PgSnapshot, clog: Record<number, XidState>): boolean {
  return clog[x] === "committed" && x < snap.xmax && !snap.xip.includes(x);
}

/**
 * The MVCC visibility rule (a reduced HeapTupleSatisfiesMVCC), with each test that it makes.
 * `me` is the id of the reading transaction, or null for a read-only transaction.
 */
export function pgVisible(t: PgTuple, snap: PgSnapshot, clog: Record<number, XidState>, me: number | null = null): { visible: boolean; steps: VisStep[] } {
  const steps: VisStep[] = [];
  if (t.xmin !== me) {
    const st = clog[t.xmin] ?? "in progress";
    if (st !== "committed") {
      steps.push({ q: `Did xmin ${t.xmin} commit?`, a: `No, it is ${st}.`, pass: false });
      return { visible: false, steps };
    }
    steps.push({ q: `Did xmin ${t.xmin} commit?`, a: "Yes.", pass: true });
    if (!xidVisible(t.xmin, snap, clog)) {
      steps.push({ q: `Is ${t.xmin} visible to the snapshot?`, a: t.xmin >= snap.xmax ? `No: ${t.xmin} ≥ xmax ${snap.xmax}, it started after the snapshot.` : `No: ${t.xmin} is in xip, it was running at the snapshot.`, pass: false });
      return { visible: false, steps };
    }
    steps.push({ q: `Is ${t.xmin} visible to the snapshot?`, a: `Yes: ${t.xmin} < ${snap.xmax} and not in xip.`, pass: true });
  } else steps.push({ q: `Is xmin ${t.xmin} my own id?`, a: "Yes: I inserted it.", pass: true });
  if (t.xmax === 0) {
    steps.push({ q: "Is xmax set?", a: "No: no transaction deleted or updated it. Visible.", pass: true });
    return { visible: true, steps };
  }
  if (t.xmax === me) {
    steps.push({ q: `Is xmax ${t.xmax} my own id?`, a: "Yes: I deleted it. Not visible.", pass: false });
    return { visible: false, steps };
  }
  const xs = clog[t.xmax] ?? "in progress";
  if (xs !== "committed") {
    steps.push({ q: `Did xmax ${t.xmax} commit?`, a: `No, it is ${xs}: the delete does not count. Visible.`, pass: true });
    return { visible: true, steps };
  }
  if (!xidVisible(t.xmax, snap, clog)) {
    steps.push({ q: `Is xmax ${t.xmax} visible to the snapshot?`, a: `No: the delete happened after the snapshot. Visible.`, pass: true });
    return { visible: true, steps };
  }
  steps.push({ q: `Is xmax ${t.xmax} visible to the snapshot?`, a: "Yes: the snapshot sees the delete. Not visible.", pass: false });
  return { visible: false, steps };
}

// ---------------------------------------------------------------- the scripted timeline

export type MvEvent =
  | { k: "insert" | "update"; xid: number; value: number }
  | { k: "delete"; xid: number }
  | { k: "commit" | "abort"; xid: number }
  | { k: "snap"; reader: string };

export const MV_SCRIPT: MvEvent[] = [
  { k: "insert", xid: 100, value: 10 },
  { k: "commit", xid: 100 },
  { k: "update", xid: 101, value: 20 },
  { k: "snap", reader: "R1" },
  { k: "commit", xid: 101 },
  { k: "snap", reader: "R2" },
  { k: "update", xid: 102, value: 30 },
  { k: "abort", xid: 102 },
  { k: "delete", xid: 103 },
  { k: "snap", reader: "R3" },
  { k: "commit", xid: 103 },
  { k: "snap", reader: "R4" },
];

export interface MvFrame {
  event: number;
  text: string;
  tuples: PgTuple[];
  clog: Record<number, XidState>;
  readers: { name: string; snap: PgSnapshot; sees: number | null }[];
  /** The next transaction id to assign. */
  nextXid: number;
}

export function mvText(e: MvEvent): string {
  switch (e.k) {
    case "insert": return `T${e.xid} inserts a = ${e.value}`;
    case "update": return `T${e.xid} updates a = ${e.value}`;
    case "delete": return `T${e.xid} deletes a`;
    case "commit": return `T${e.xid} commits`;
    case "abort": return `T${e.xid} aborts`;
    case "snap": return `${e.reader} takes a snapshot`;
  }
}

/** The tuple that a reader sees (by lp), or null. */
export function readRow(tuples: PgTuple[], snap: PgSnapshot, clog: Record<number, XidState>, me: number | null = null): number | null {
  for (const t of tuples) if (pgVisible(t, snap, clog, me).visible) return t.lp;
  return null;
}

export function runMvScript(script: MvEvent[] = MV_SCRIPT): MvFrame[] {
  const tuples: PgTuple[] = [];
  const clog: Record<number, XidState> = {};
  const readers: { name: string; snap: PgSnapshot }[] = [];
  let nextXid = 100;
  const frames: MvFrame[] = [];
  const running = () => Object.entries(clog).filter(([, s]) => s === "in progress").map(([x]) => Number(x)).sort((a, b) => a - b);
  const snapNow = (): PgSnapshot => {
    const xip = running();
    return { xmin: xip.length ? xip[0]! : nextXid, xmax: nextXid, xip };
  };
  const writer = (xid: number) => {
    if (!(xid in clog)) { clog[xid] = "in progress"; nextXid = Math.max(nextXid, xid + 1); }
  };
  script.forEach((e, i) => {
    let text = "";
    if (e.k === "insert") {
      writer(e.xid);
      const lp = tuples.length + 1;
      tuples.push({ lp, value: e.value, xmin: e.xid, xmax: 0, ctid: lp });
      text = `T${e.xid} gets a transaction id and inserts a new tuple at (0,${lp}) with xmin = ${e.xid}.`;
    } else if (e.k === "update" || e.k === "delete") {
      writer(e.xid);
      const snap = snapNow();
      const cur = tuples.find((t) => pgVisible(t, snap, clog, e.xid).visible)!;
      cur.xmax = e.xid;
      if (e.k === "update") {
        const lp = tuples.length + 1;
        tuples.push({ lp, value: e.value, xmin: e.xid, xmax: 0, ctid: lp });
        cur.ctid = lp;
        text = `T${e.xid} sets xmax = ${e.xid} on (0,${cur.lp}) and appends a new tuple (0,${lp}). The old tuple's ctid now points to it.`;
      } else text = `T${e.xid} sets xmax = ${e.xid} on (0,${cur.lp}). A delete adds no tuple.`;
    } else if (e.k === "commit" || e.k === "abort") {
      clog[e.xid] = e.k === "commit" ? "committed" : "aborted";
      text = e.k === "commit" ? `T${e.xid} commits: the commit log marks ${e.xid} committed. No tuple changes.` : `T${e.xid} aborts: the commit log marks ${e.xid} aborted. Its tuple stays in the heap until VACUUM.`;
    } else if (e.k === "snap") {
      const s = snapNow();
      readers.push({ name: e.reader, snap: s });
      text = `${e.reader} takes a snapshot: xmin = ${s.xmin}, xmax = ${s.xmax}, xip = [${s.xip.join(", ")}].`;
    }
    frames.push({
      event: i,
      text,
      tuples: tuples.map((t) => ({ ...t })),
      clog: { ...clog },
      readers: readers.map((r) => ({ name: r.name, snap: r.snap, sees: readRow(tuples, r.snap, clog) })),
      nextXid,
    });
  });
  return frames;
}

// ---------------------------------------------------------------- version storage layouts

export type Layout = "pg-hot" | "pg" | "innodb";
export const LAYOUTS: { id: Layout; label: string }[] = [
  { id: "pg-hot", label: "PostgreSQL, HOT update" },
  { id: "pg", label: "PostgreSQL, indexed column changed" },
  { id: "innodb", label: "InnoDB (undo log)" },
];

/**
 * A row updated n times (versions 0..n). A reader whose snapshot sees version j must find it.
 * Returns how many index entries point at the row and how many versions the reader examines.
 */
export function chainCost(layout: Layout, n: number, j: number): { indexEntries: number; visits: number; order: number[] } {
  switch (layout) {
    // Index → root tuple (version 0), then follow ctid to newer versions until the visible one.
    case "pg-hot": return { indexEntries: 1, visits: j + 1, order: Array.from({ length: j + 1 }, (_, i) => i) };
    // One index entry per version: the scan finds and checks all of them.
    case "pg": return { indexEntries: n + 1, visits: n + 1, order: Array.from({ length: n + 1 }, (_, i) => i) };
    // The clustered record holds the newest version; undo records lead back to older ones.
    case "innodb": return { indexEntries: 1, visits: n - j + 1, order: Array.from({ length: n - j + 1 }, (_, i) => n - i) };
  }
}
