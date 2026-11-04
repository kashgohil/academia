/**
 * Durability models for the Storage lessons.
 *
 * 1. `crc32c`: CRC-32C (Castagnoli), the checksum of InnoDB pages, PostgreSQL WAL records, ext4 metadata and Btrfs.
 * 2. `WriteStack`: the layers between write() and stable media: the OS page cache, the device's volatile
 *    cache, and the media. A crash loses both caches. Models fsync, directory fsync, rename, and the Linux
 *    behaviour behind the 2018 PostgreSQL "fsyncgate": a failed writeback marks the page clean and reports
 *    the error once.
 * 3. `tornUpdate` + `crashRecover`: one page update under four protections (none, checksum, doublewrite,
 *    full-page writes), with a crash after any step and the result of recovery.
 * 4. `checkpointCost`: WAL and page-write volume of full-page writes and doublewrite.
 */

// =====================================================================================
// CRC-32C
// =====================================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32C of `data`. crc32c("123456789") = 0xE3069283. */
export function crc32c(data: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export const hex32 = (v: number) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");

// =====================================================================================
// The write-back stack
// =====================================================================================

export type DeviceCache = "flush" | "lies" | "plp";
export const DEVICE_LABEL: Record<DeviceCache, string> = {
  flush: "Volatile cache, honours FLUSH",
  lies: "Volatile cache, ignores FLUSH",
  plp: "Power-loss protection",
};

export type StackOp =
  | { kind: "write"; key: string; value: string }
  | { kind: "fsync"; file: string }
  | { kind: "fsyncdir" }
  | { kind: "create"; file: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "writeback" }
  | { kind: "io-error"; key: string }
  | { kind: "panic" };

export interface StepResult { op: StackOp; ret: "ok" | "EIO" | "PANIC" | ""; note: string }

/**
 * Keys look like "file#block" for data and "dir:file" for directory entries.
 * Directory entries are only durable after an fsync of the directory.
 */
export class WriteStack {
  readonly cache = new Map<string, string>();
  readonly dirty = new Set<string>();
  readonly device = new Map<string, string>();
  readonly media: Map<string, string>;
  /** Files with an unreported writeback error. */
  private errors = new Set<string>();
  /** Keys whose next writeback will fail. */
  private failing = new Set<string>();
  /** Keys the application believes are durable (it got "ok" from fsync after writing them). */
  readonly believed = new Map<string, string>();
  private pendingSince = new Map<string, string>();
  crashed = false;

  constructor(readonly deviceCache: DeviceCache, initial: Record<string, string> = {}) {
    this.media = new Map(Object.entries(initial));
    for (const [k, v] of this.media) { this.cache.set(k, v); this.believed.set(k, v); }
  }

  static fileOf(key: string) { return key.startsWith("dir:") ? "dir" : key.split("#")[0]!; }

  /** What a read sees now (page cache first, then the lower layers). */
  view(key: string) { return this.cache.get(key) ?? this.device.get(key) ?? this.media.get(key); }

  keys(): string[] {
    const s = new Set([...this.cache.keys(), ...this.device.keys(), ...this.media.keys(), ...this.believed.keys()]);
    return [...s].sort();
  }

  private toDevice(key: string) {
    if (this.failing.has(key)) {
      // Writeback fails. Linux marks the page clean anyway and records the error for the file.
      this.failing.delete(key);
      this.dirty.delete(key);
      this.errors.add(WriteStack.fileOf(key));
      return;
    }
    const v = this.cache.get(key)!;
    if (this.deviceCache === "plp") this.media.set(key, v);
    else this.device.set(key, v);
    this.dirty.delete(key);
  }

  private flushDevice() {
    if (this.deviceCache !== "flush") return;
    for (const [k, v] of this.device) this.media.set(k, v);
    this.device.clear();
  }

  apply(op: StackOp): StepResult {
    switch (op.kind) {
      case "write":
        this.cache.set(op.key, op.value);
        this.dirty.add(op.key);
        this.pendingSince.set(op.key, op.value);
        return { op, ret: "", note: "The kernel copies the bytes into the page cache and marks the page dirty. write() returns at once." };
      case "create":
        this.cache.set(`dir:${op.file}`, "entry");
        this.dirty.add(`dir:${op.file}`);
        this.pendingSince.set(`dir:${op.file}`, "entry");
        return { op, ret: "", note: `The directory now has an entry for ${op.file}, but only in memory.` };
      case "rename": {
        // The data blocks stay with the inode (still keyed by the old name); only the directory changes.
        this.cache.set(`dir:${op.to}`, `→ ${op.from}`);
        this.cache.delete(`dir:${op.from}`);
        this.dirty.add(`dir:${op.to}`);
        this.pendingSince.set(`dir:${op.to}`, `→ ${op.from}`);
        return { op, ret: "", note: `rename() replaces the name atomically, but only in memory. On disk, ${op.to} still names the old data.` };
      }
      case "writeback": {
        for (const k of [...this.dirty]) this.toDevice(k);
        return { op, ret: "", note: "Background writeback sends dirty pages to the device. Nothing waits for it, and the device may only cache them." };
      }
      case "io-error":
        this.failing.add(op.key);
        return { op, ret: "", note: `The next writeback of ${op.key} will fail with an I/O error.` };
      case "fsync": {
        for (const k of [...this.dirty]) if (WriteStack.fileOf(k) === op.file) this.toDevice(k);
        this.flushDevice();
        if (this.errors.has(op.file)) {
          this.errors.delete(op.file); // reported once, then forgotten
          return { op, ret: "EIO", note: "fsync reports the writeback error and clears it. The failed page is now clean in the cache, with no copy on disk." };
        }
        for (const [k, v] of this.pendingSince) if (WriteStack.fileOf(k) === op.file) { this.believed.set(k, v); this.pendingSince.delete(k); }
        const note = this.deviceCache === "lies"
          ? "fsync returns ok. The device acknowledged FLUSH but kept the data in its volatile cache."
          : "fsync waits until the file's dirty pages are on stable media, then returns ok.";
        return { op, ret: "ok", note };
      }
      case "fsyncdir": {
        for (const k of [...this.dirty]) if (k.startsWith("dir:")) this.toDevice(k);
        this.flushDevice();
        for (const k of [...this.media.keys()]) if (k.startsWith("dir:") && !this.cache.has(k)) this.media.delete(k);
        for (const [k, v] of this.pendingSince) {
          if (!k.startsWith("dir:")) continue;
          this.pendingSince.delete(k);
          const name = k.slice(4);
          if (!v.startsWith("→ ")) continue;
          // The name now durably points at the renamed inode: the app expects its blocks under the new name.
          const from = v.slice(2);
          for (const [bk, bv] of [...this.believed]) if (bk.startsWith(from + "#")) { this.believed.set(name + bk.slice(from.length), bv); this.believed.delete(bk); }
        }
        return { op, ret: "ok", note: "fsync on the directory makes its entries durable, including the new name." };
      }
      case "panic":
        return { op, ret: "PANIC", note: "The database stops at once. On restart it replays the WAL, which still has the lost change." };
    }
  }

  /** Power loss: the page cache and the volatile device cache are gone. */
  crash(): Map<string, string> {
    this.crashed = true;
    return new Map(this.media);
  }
}

export interface Scenario { id: string; label: string; initial: Record<string, string>; ops: StackOp[] }

export const SCENARIOS: Scenario[] = [
  {
    id: "nofsync", label: "write, no fsync",
    initial: { "dir:a.db": "entry", "a.db#0": "v1" },
    ops: [{ kind: "write", key: "a.db#0", value: "v2" }, { kind: "writeback" }],
  },
  {
    id: "fsync", label: "write + fsync",
    initial: { "dir:a.db": "entry", "a.db#0": "v1", "a.db#1": "v1" },
    ops: [{ kind: "write", key: "a.db#0", value: "v2" }, { kind: "write", key: "a.db#1", value: "v2" }, { kind: "fsync", file: "a.db" }],
  },
  {
    id: "newfile", label: "new file, no directory fsync",
    initial: {},
    ops: [{ kind: "create", file: "b.log" }, { kind: "write", key: "b.log#0", value: "v1" }, { kind: "fsync", file: "b.log" }],
  },
  {
    id: "replace", label: "atomic replace (write, fsync, rename, fsync dir)",
    initial: { "dir:cfg": "entry", "cfg#0": "v1" },
    ops: [
      { kind: "create", file: "cfg.tmp" }, { kind: "write", key: "cfg.tmp#0", value: "v2" }, { kind: "fsync", file: "cfg.tmp" },
      { kind: "rename", from: "cfg.tmp", to: "cfg" }, { kind: "fsyncdir" },
    ],
  },
  {
    id: "fsyncgate", label: "fsync error, then retry",
    initial: { "dir:a.db": "entry", "a.db#0": "v1", "a.db#1": "v1" },
    ops: [
      { kind: "write", key: "a.db#0", value: "v2" }, { kind: "write", key: "a.db#1", value: "v2" },
      { kind: "io-error", key: "a.db#1" }, { kind: "writeback" },
      { kind: "fsync", file: "a.db" }, { kind: "fsync", file: "a.db" },
    ],
  },
  {
    id: "panic", label: "fsync error, then PANIC",
    initial: { "dir:a.db": "entry", "a.db#0": "v1", "a.db#1": "v1" },
    ops: [
      { kind: "write", key: "a.db#0", value: "v2" }, { kind: "write", key: "a.db#1", value: "v2" },
      { kind: "io-error", key: "a.db#1" }, { kind: "writeback" },
      { kind: "fsync", file: "a.db" }, { kind: "panic" },
    ],
  },
];

export interface StackFrame { step: number; result: StepResult | null; cache: Map<string, string>; dirty: Set<string>; device: Map<string, string>; media: Map<string, string>; believed: Map<string, string> }

/** Runs a scenario and snapshots the layers after each step (frame 0 = before the first op). */
export function runScenario(s: Scenario, dev: DeviceCache): { frames: StackFrame[]; keys: string[] } {
  const st = new WriteStack(dev, s.initial);
  const snap = (step: number, result: StepResult | null): StackFrame => ({
    step, result, cache: new Map(st.cache), dirty: new Set(st.dirty), device: new Map(st.device), media: new Map(st.media), believed: new Map(st.believed),
  });
  const frames = [snap(0, null)];
  s.ops.forEach((op, i) => frames.push(snap(i + 1, st.apply(op))));
  return { frames, keys: st.keys() };
}

/**
 * Files as a reader sees them through the directory: "dir:NAME" = "entry" names NAME's own blocks,
 * "→ OTHER" names the blocks written under OTHER (a rename). Blocks with no entry are invisible (orphans).
 */
export function visible(layer: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of layer) {
    if (!k.startsWith("dir:")) continue;
    const name = k.slice(4), target = v.startsWith("→ ") ? v.slice(2) : name;
    for (const [bk, bv] of layer) if (bk.startsWith(target + "#")) out.set(name + bk.slice(target.length), bv);
  }
  return [...out.keys()].sort().reduce((m, k) => m.set(k, out.get(k)!), new Map<string, string>());
}

/**
 * Blocks the application believes durable that a crash at this frame would lose or show with older data.
 * (Values are versions "v1" < "v2", so a newer value on media is not a loss.)
 */
export function lostOnCrash(f: StackFrame): string[] {
  const after = visible(f.media);
  return [...f.believed].filter(([k, v]) => {
    if (k.startsWith("dir:")) return false;
    const got = after.get(k);
    return got === undefined || got < v;
  }).map(([k]) => k);
}

// =====================================================================================
// Torn pages
// =====================================================================================

export type Protection = "none" | "checksum" | "doublewrite" | "fpw";
export const PROTECTION_LABEL: Record<Protection, string> = {
  none: "None",
  checksum: "Checksum only",
  doublewrite: "Doublewrite (InnoDB)",
  fpw: "Full-page writes (PostgreSQL)",
};

export type TornStep =
  | { kind: "wal"; fpi: boolean }
  | { kind: "dw"; sector: number }
  | { kind: "dw-sync" }
  | { kind: "page"; sector: number }
  | { kind: "page-sync" };

export type SectorOrder = "in-order" | "reverse" | "shuffled";

/** The write sequence for one page update from version 1 to version 2. */
export function tornUpdate(p: Protection, sectors: number, order: SectorOrder = "in-order", seed = 3): TornStep[] {
  const idx = [...Array(sectors).keys()];
  if (order === "reverse") idx.reverse();
  if (order === "shuffled") {
    let a = seed;
    for (let i = idx.length - 1; i > 0; i--) { a = (a * 1103515245 + 12345) >>> 0; const j = a % (i + 1); [idx[i], idx[j]] = [idx[j]!, idx[i]!]; }
  }
  const steps: TornStep[] = [{ kind: "wal", fpi: p === "fpw" }];
  if (p === "doublewrite") {
    for (let i = 0; i < sectors; i++) steps.push({ kind: "dw", sector: i });
    steps.push({ kind: "dw-sync" });
  }
  for (const i of idx) steps.push({ kind: "page", sector: i });
  steps.push({ kind: "page-sync" });
  return steps;
}

export type Outcome = "ok-new" | "ok-old" | "detected" | "silent";
export const OUTCOME_LABEL: Record<Outcome, string> = {
  "ok-new": "Correct: the page has the committed change",
  "ok-old": "Correct: the change never committed, the old page is intact",
  detected: "Detected: the checksum fails, and the page cannot be repaired from the WAL",
  silent: "Silent corruption: redo runs on a torn page, and nothing reports an error",
};

export interface CrashState {
  /** Version (1 or 2) of each sector of the page in the data file. */
  page: number[];
  /** Sectors of the new page in the doublewrite area. */
  dw: number;
  dwSynced: boolean;
  walDurable: boolean;
  walFpi: boolean;
}

export interface Recovery { state: CrashState; outcome: Outcome; actions: string[]; torn: boolean; checksumOk: boolean | null }

/** State on disk after the first `k` steps. */
export function crashState(steps: TornStep[], k: number, sectors: number): CrashState {
  const st: CrashState = { page: Array(sectors).fill(1), dw: 0, dwSynced: false, walDurable: false, walFpi: false };
  for (const s of steps.slice(0, k)) {
    if (s.kind === "wal") { st.walDurable = true; st.walFpi = s.fpi; }
    else if (s.kind === "dw") st.dw++;
    else if (s.kind === "dw-sync") st.dwSynced = true;
    else if (s.kind === "page") st.page[s.sector] = 2;
  }
  return st;
}

/** Crash after `k` steps, then recover. */
export function crashRecover(p: Protection, steps: TornStep[], k: number, sectors: number): Recovery {
  const state = crashState(steps, k, sectors);
  const torn = new Set(state.page).size > 1;
  const pageVersion = state.page[0]!;
  const hasChecksum = p !== "none";
  const checksumOk = hasChecksum ? !torn : null;
  const actions: string[] = [];
  if (!state.walDurable) {
    actions.push("The WAL has no commit record for the change, so recovery has nothing to redo.");
    actions.push("The WAL rule held: no sector of the page was written before the WAL.");
    return { state, outcome: "ok-old", actions, torn, checksumOk };
  }
  if (p === "fpw") {
    actions.push("The WAL record holds a full image of the page.");
    actions.push("Recovery writes the image over the page, whatever state the page is in.");
    return { state, outcome: "ok-new", actions, torn, checksumOk };
  }
  if (p === "doublewrite" && torn) {
    actions.push("The page checksum fails: the page is torn.");
    actions.push(`The doublewrite area has a complete copy (${state.dw} of ${sectors} sectors, synced). Recovery copies it over the page.`);
    actions.push("The page LSN is now at the change, so redo skips the record.");
    return { state, outcome: "ok-new", actions, torn, checksumOk };
  }
  if (!torn) {
    if (hasChecksum) actions.push("The page checksum is correct.");
    if (pageVersion === 2) { actions.push("The page LSN shows that the change is already on the page. Redo skips it."); return { state, outcome: "ok-new", actions, torn, checksumOk }; }
    actions.push("The page is the old version. Redo applies the WAL record to it.");
    return { state, outcome: "ok-new", actions, torn, checksumOk };
  }
  if (p === "checksum") {
    actions.push("The page checksum fails: the page is torn.");
    actions.push("The WAL record only says what changed. It needs a correct old page to apply to, and there is none.");
    return { state, outcome: "detected", actions, torn, checksumOk };
  }
  actions.push("There is no checksum, so the torn page looks normal.");
  actions.push(`The LSN is in sector 0, which has version ${pageVersion}. ${pageVersion === 2 ? "Redo skips the record" : "Redo applies the change to a half-new page"}.`);
  return { state, outcome: "silent", actions, torn, checksumOk };
}

/** Builds page bytes: each sector filled from its version, with a CRC-32C of the intended version in the first 4 bytes. */
export function pageBytes(versions: number[], sectorBytes: number): { bytes: Uint8Array; stored: number; computed: number } {
  const n = versions.length * sectorBytes;
  const make = (v: number) => {
    const b = new Uint8Array(n);
    for (let i = 4; i < n; i++) b[i] = (i * 31 + v * 97) & 0xff;
    return b;
  };
  const crcOf = (b: Uint8Array) => crc32c(b.subarray(4));
  const out = new Uint8Array(n);
  versions.forEach((v, s) => {
    const src = make(v);
    const c = crcOf(src);
    new DataView(src.buffer).setUint32(0, c, true);
    out.set(src.subarray(s * sectorBytes, (s + 1) * sectorBytes), s * sectorBytes);
  });
  const stored = new DataView(out.buffer).getUint32(0, true);
  return { bytes: out, stored, computed: crcOf(out) };
}

// =====================================================================================
// Cost of torn-page protection
// =====================================================================================

export interface CheckpointCostOpts {
  /** Pages in the table. */
  tablePages: number;
  /** Row updates between two checkpoints, each to a random page. */
  updates: number;
  /** WAL bytes of one update record without a page image. */
  recordBytes: number;
  pageBytes: number;
}

/**
 * Expected volumes for one checkpoint interval. Distinct pages touched by N random updates over P pages:
 * P × (1 − (1 − 1/P)^N). Full-page writes log each of them once; doublewrite writes each flushed page twice.
 */
export function checkpointCost(o: CheckpointCostOpts) {
  const distinct = o.tablePages * (1 - Math.pow(1 - 1 / o.tablePages, o.updates));
  const walPlain = o.updates * o.recordBytes;
  const walFpw = walPlain + distinct * o.pageBytes;
  const pageWrites = distinct * o.pageBytes;
  return {
    distinct,
    walPlain,
    walFpw,
    pageWrites,
    /** Bytes written per update: WAL + page flushes. */
    perUpdate: {
      plain: (walPlain + pageWrites) / o.updates,
      fpw: (walFpw + pageWrites) / o.updates,
      doublewrite: (walPlain + 2 * pageWrites) / o.updates,
    },
  };
}
