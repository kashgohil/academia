/**
 * Optimistic concurrency control (Kung and Robinson, 1981) as a step-by-step model.
 *
 * Each transaction has three phases. In the read phase, it reads committed data and buffers its writes in a
 * private write set. In the validation phase, it checks for conflicts. In the write phase, it installs its writes
 * and gets a transaction number tn from a global counter. Validation and write run as one critical section.
 *
 * - Backward validation: Tj compares its read set with the write sets of the transactions that committed after
 *   Tj started. Any overlap: Tj aborts. Tj may have read an old value.
 * - Forward validation: Tj compares its write set with the read sets of the transactions still in their read
 *   phase. Any overlap: here the readers abort (the validator could also abort itself). A read-only
 *   transaction never fails forward validation.
 */

export type OccMode = "backward" | "forward";
export type OccLine = { t: number; k: "r" | "w"; item: string } | { t: number; k: "v" };
export interface OccScript { id: string; name: string; txns: number; lines: OccLine[] }

const r = (t: number, item: string): OccLine => ({ t: t - 1, k: "r", item });
const w = (t: number, item: string): OccLine => ({ t: t - 1, k: "w", item });
const v = (t: number): OccLine => ({ t: t - 1, k: "v" });

export const OCC_SCRIPTS: OccScript[] = [
  { id: "stale", name: "Stale read", txns: 2, lines: [r(1, "x"), r(2, "x"), w(2, "x"), v(2), r(1, "y"), w(1, "y"), v(1)] },
  { id: "disjoint", name: "Disjoint sets", txns: 2, lines: [r(1, "x"), r(2, "y"), w(1, "x"), w(2, "y"), v(1), v(2)] },
  { id: "late", name: "Started after the commit", txns: 3, lines: [r(1, "y"), r(2, "x"), w(2, "x"), v(2), r(3, "x"), w(1, "y"), v(1), w(3, "x"), v(3)] },
  { id: "blind", name: "Two blind writes", txns: 2, lines: [w(1, "x"), w(2, "x"), v(2), v(1)] },
];

export const occLineText = (l: OccLine) => `T${l.t + 1} ${l.k === "v" ? "validate" : `${l.k}(${l.item})`}`;

export type OccPhase = "idle" | "read" | "committed" | "aborted";
export interface OccTxnView { t: number; phase: OccPhase; start: number; rs: string[]; ws: string[]; tn: number | null; work: number }
export interface OccCheck { against: number; mine: string[]; theirs: string[]; overlap: string[] }
export interface OccFrame {
  line: number;
  text: string;
  txns: OccTxnView[];
  committed: { t: number; tn: number; ws: string[] }[];
  /** Validation details of this step, if it was a validation. */
  check: { t: number; mode: OccMode; rows: OccCheck[]; ok: boolean } | null;
  /** Read and write operations thrown away by aborts so far. */
  wasted: number;
  tone: "good" | "bad" | null;
}

const add = (s: string[], x: string) => (s.includes(x) ? s : [...s, x].sort());

export function runOcc(script: OccScript, mode: OccMode): OccFrame[] {
  const tx: OccTxnView[] = Array.from({ length: script.txns }, (_, t) => ({ t, phase: "idle", start: 0, rs: [], ws: [], tn: null, work: 0 }));
  const committed: { t: number; tn: number; ws: string[] }[] = [];
  let tnc = 0;
  let wasted = 0;
  const snap = (): Pick<OccFrame, "txns" | "committed" | "wasted"> => ({ txns: tx.map((x) => ({ ...x, rs: [...x.rs], ws: [...x.ws] })), committed: committed.map((c) => ({ ...c })), wasted });
  const frames: OccFrame[] = [{ line: -1, text: `Start. The transaction counter tnc = 0.`, ...snap(), check: null, tone: null }];
  script.lines.forEach((l, i) => {
    const x = tx[l.t]!;
    const T = `T${l.t + 1}`;
    if (x.phase === "aborted") {
      frames.push({ line: i, text: `Skip "${occLineText(l)}": ${T} was aborted. It would restart from the beginning.`, ...snap(), check: null, tone: null });
      return;
    }
    if (x.phase === "idle") { x.phase = "read"; x.start = tnc; }
    if (l.k === "r") {
      x.rs = add(x.rs, l.item);
      x.work++;
      frames.push({ line: i, text: `${T} reads ${l.item} (committed value) and adds it to its read set. It records start tn = ${x.start}.`, ...snap(), check: null, tone: null });
      return;
    }
    if (l.k === "w") {
      x.ws = add(x.ws, l.item);
      x.work++;
      frames.push({ line: i, text: `${T} writes ${l.item} into its private buffer. Other transactions cannot see it.`, ...snap(), check: null, tone: null });
      return;
    }
    // validation
    const rows: OccCheck[] = [];
    if (mode === "backward") {
      for (const c of committed) if (c.tn > x.start) rows.push({ against: c.t, mine: x.rs, theirs: c.ws, overlap: x.rs.filter((it) => c.ws.includes(it)) });
      const ok = rows.every((rw) => rw.overlap.length === 0);
      if (ok) {
        x.tn = ++tnc;
        x.phase = "committed";
        committed.push({ t: l.t, tn: x.tn, ws: [...x.ws] });
        frames.push({ line: i, text: rows.length ? `${T} checks its read set against ${rows.length} write set${rows.length > 1 ? "s" : ""} of transactions that committed after it started. No overlap: it writes and gets tn = ${x.tn}.` : `No transaction committed after ${T} started (tn > ${x.start}). ${T} writes and gets tn = ${x.tn}.`, ...snap(), check: { t: l.t, mode, rows, ok }, tone: "good" });
      } else {
        x.phase = "aborted";
        wasted += x.work;
        const bad = rows.find((rw) => rw.overlap.length)!;
        frames.push({ line: i, text: `${T} read ${bad.overlap.join(", ")}, but T${bad.against + 1} wrote it and committed after ${T} started. ${T} may have read an old value: abort.`, ...snap(), check: { t: l.t, mode, rows, ok }, tone: "bad" });
      }
      return;
    }
    for (const a of tx) if (a.t !== l.t && a.phase === "read") rows.push({ against: a.t, mine: x.ws, theirs: a.rs, overlap: x.ws.filter((it) => a.rs.includes(it)) });
    const victims = rows.filter((rw) => rw.overlap.length).map((rw) => rw.against);
    for (const vt of victims) { tx[vt]!.phase = "aborted"; wasted += tx[vt]!.work; }
    x.tn = ++tnc;
    x.phase = "committed";
    committed.push({ t: l.t, tn: x.tn, ws: [...x.ws] });
    const text = victims.length
      ? `${T} checks its write set against the read sets of ${rows.length} active transaction${rows.length > 1 ? "s" : ""}. ${victims.map((vt) => `T${vt + 1}`).join(", ")} read an item that ${T} writes: abort ${victims.length > 1 ? "them" : "it"} now. ${T} commits with tn = ${x.tn}.`
      : rows.length ? `${T} checks its write set against the read sets of ${rows.length} active transaction${rows.length > 1 ? "s" : ""}. No overlap: ${T} commits with tn = ${x.tn}.` : `No other transaction is in its read phase. ${T} commits with tn = ${x.tn}.`;
    frames.push({ line: i, text, ...snap(), check: { t: l.t, mode, rows, ok: true }, tone: victims.length ? "bad" : "good" });
  });
  return frames;
}

/** Final outcome of a script: committed and aborted transactions and wasted operations. */
export function occSummary(script: OccScript, mode: OccMode) {
  const f = runOcc(script, mode);
  const last = f[f.length - 1]!;
  return {
    committed: last.txns.filter((x) => x.phase === "committed").map((x) => x.t),
    aborted: last.txns.filter((x) => x.phase === "aborted").map((x) => x.t),
    wasted: last.wasted,
  };
}
