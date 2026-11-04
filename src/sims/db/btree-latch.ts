/**
 * Concurrency protocols for B+ trees, as small executable models.
 *
 * Part 1: a two-thread stepper. A reader searches for key 30 while a writer inserts 22 into the
 * full leaf B, which splits. The learner picks which thread runs the next step. Each protocol
 * gives each thread a program of atomic steps; a step that needs a latch the other thread holds
 * in a conflicting mode is blocked.
 *
 *   initial tree     R: [20 | 40]
 *                    A: [5, 10]   B: [20, 25, 30]   C: [40, 45]      (leaf capacity 3)
 *   after the insert R: [20 | 25 | 40]
 *                    A: [5, 10]   B: [20, 22]   B2: [25, 30]   C: [40, 45]
 *
 * Part 2: latch counts at the root over a real workload on a real BPlusTree, per protocol.
 */
import { BPlusTree, type BEvent, type BNode } from "./btree";
import { mulberry32 } from "../rng";

// ============================================================================
// Part 1: two-thread stepper
// ============================================================================

export type Protocol = "none" | "crabbing" | "blink" | "olc";
export type Who = "reader" | "writer";
export type Mode = "S" | "X";

export interface LNode {
  id: string;
  keys: number[];
  kids?: string[];
  /** High key: every key in this node is below it (B-link). Infinity for the rightmost node. */
  high: number;
  /** Right link (B-link). */
  right: string | null;
  /** Optimistic lock coupling: version counter; odd = locked. */
  version: number;
}

export interface ThreadState {
  pc: number;
  /** Node the thread is looking at. */
  at: string | null;
  held: Record<string, Mode>;
  done: boolean;
  result: string | null;
  /** OLC: versions read so far. */
  seen: Record<string, number>;
  restarts: number;
  /** Reader: keys of the leaf it read. */
  readKeys: number[] | null;
}

export interface LatchState {
  protocol: Protocol;
  nodes: Record<string, LNode>;
  reader: ThreadState;
  writer: ThreadState;
  log: { who: Who; text: string; kind: "ok" | "wait" | "bad" | "info" }[];
  /** Last node each thread touched, for highlighting. */
  touched: { reader: string | null; writer: string | null };
}

export const READ_KEY = 30;
export const WRITE_KEY = 22;

const node = (id: string, keys: number[], high: number, right: string | null, kids?: string[]): LNode => ({ id, keys, kids, high, right, version: 0 });
const thread = (): ThreadState => ({ pc: 0, at: null, held: {}, done: false, result: null, seen: {}, restarts: 0, readKeys: null });

export function initLatchState(protocol: Protocol): LatchState {
  return {
    protocol,
    nodes: {
      R: node("R", [20, 40], Infinity, null, ["A", "B", "C"]),
      A: node("A", [5, 10], 20, "B"),
      B: node("B", [20, 25, 30], 40, "C"),
      C: node("C", [40, 45], Infinity, null),
    },
    reader: thread(),
    writer: thread(),
    log: [],
    touched: { reader: null, writer: null },
  };
}

const childFor = (n: LNode, k: number) => n.kids![n.keys.filter((s) => s <= k).length]!;
const other = (w: Who): Who => (w === "reader" ? "writer" : "reader");

interface Step {
  /** What the step does, shown before it runs. */
  label: (s: LatchState, t: ThreadState) => string;
  /** Latches to acquire (kept until released by a later step). */
  acquire?: (s: LatchState, t: ThreadState) => [string, Mode][];
  /** Latches needed only for the duration of this step (a short read of one node). */
  brief?: (s: LatchState, t: ThreadState) => [string, Mode][];
  /** OLC: the step spins while this node is locked (odd version). */
  spinOn?: (s: LatchState, t: ThreadState) => string | null;
  run: (s: LatchState, t: ThreadState, log: (text: string, kind?: "ok" | "bad" | "info") => void) => void;
}

function readerFinish(s: LatchState, t: ThreadState, keys: number[], log: (text: string, kind?: "ok" | "bad" | "info") => void) {
  t.done = true;
  t.readKeys = keys;
  const found = keys.includes(READ_KEY);
  t.result = found ? "found" : "not found";
  // 30 is in the tree at every moment, so "not found" is always wrong.
  log(found ? `Found ${READ_KEY}.` : `Says ${READ_KEY} is not in the tree. Wrong: ${READ_KEY} is in ${whereIs(s, READ_KEY)}.`, found ? "ok" : "bad");
}
function whereIs(s: LatchState, k: number): string {
  for (const n of Object.values(s.nodes)) if (!n.kids && n.keys.includes(k)) return n.id;
  return "no leaf";
}
function releaseAll(t: ThreadState) {
  t.held = {};
}

/** Writer: the split of B. `first` moves 25 and 30 into the new leaf B2; `second` puts 22 in B. */
function splitB(s: LatchState, links: boolean) {
  s.nodes.B2 = node("B2", [25, 30], links ? s.nodes.B!.high : 40, links ? s.nodes.B!.right : "C");
  s.nodes.B!.keys = [20];
}

const PROGRAMS: Record<Protocol, Record<Who, Step[]>> = {
  none: {
    reader: [
      { label: () => "Read R: 30 is in [20, 40), so the child is B", run: (s, t, log) => { t.at = childFor(s.nodes.R!, READ_KEY); log(`Read R → go to ${t.at}.`); } },
      { label: (_s, t) => `Read ${t.at} and search for 30`, run: (s, t, log) => readerFinish(s, t, [...s.nodes[t.at!]!.keys], log) },
    ],
    writer: [
      { label: () => "Read R: 22 goes to B", run: (s, t, log) => { t.at = childFor(s.nodes.R!, WRITE_KEY); log("Read R → go to B. B is full."); } },
      { label: () => "Split B: make B2 and move 25, 30 into it", run: (s, _t, log) => { splitB(s, false); log("B = [20], B2 = [25, 30]. R does not point to B2 yet.", "info"); } },
      { label: () => "Insert 22 into B", run: (s, _t, log) => { s.nodes.B!.keys = [20, 22]; log("B = [20, 22]."); } },
      { label: () => "Add separator 25 → B2 to R", run: (s, t, log) => { s.nodes.R!.keys = [20, 25, 40]; s.nodes.R!.kids = ["A", "B", "B2", "C"]; t.done = true; t.result = "inserted"; log("R = [20 | 25 | 40]. Insert done.", "ok"); } },
    ],
  },
  crabbing: {
    reader: [
      { label: () => "S-latch R, read R → child B", acquire: () => [["R", "S"]], run: (s, t, log) => { t.at = childFor(s.nodes.R!, READ_KEY); log(`S-latch R. Read R → ${t.at}.`); } },
      { label: (_s, t) => `S-latch ${t.at}, then release R`, acquire: (_s, t) => [[t.at!, "S"]], run: (_s, t, log) => { delete t.held.R; log(`S-latch ${t.at}. Release R.`); } },
      { label: (_s, t) => `Read ${t.at}, search for 30, release ${t.at}`, run: (s, t, log) => { readerFinish(s, t, [...s.nodes[t.at!]!.keys], log); releaseAll(t); } },
    ],
    writer: [
      { label: () => "X-latch R, read R → child B", acquire: () => [["R", "X"]], run: (s, t, log) => { t.at = childFor(s.nodes.R!, WRITE_KEY); log("X-latch R. Read R → B."); } },
      { label: () => "X-latch B. B is full (not safe), so keep R", acquire: () => [["B", "X"]], run: (_s, _t, log) => log("X-latch B. B is full, so the split can change R: keep R latched.") },
      { label: () => "Split B and insert 22", run: (s, t, log) => { splitB(s, false); s.nodes.B!.keys = [20, 22]; t.held.B2 = "X"; log("B = [20, 22], new B2 = [25, 30]."); } },
      { label: () => "Add separator 25 → B2 to R, release all", run: (s, t, log) => { s.nodes.R!.keys = [20, 25, 40]; s.nodes.R!.kids = ["A", "B", "B2", "C"]; releaseAll(t); t.done = true; t.result = "inserted"; log("R = [20 | 25 | 40]. Release R, B and B2.", "ok"); } },
    ],
  },
  blink: {
    reader: [
      { label: () => "Read R (short S latch) → child B", brief: () => [["R", "S"]], run: (s, t, log) => { t.at = childFor(s.nodes.R!, READ_KEY); log(`Read R → ${t.at}. Hold no latch.`); } },
      {
        label: (_s, t) => `Read ${t.at} (short S latch)`,
        brief: (_s, t) => [[t.at!, "S"]],
        run: (s, t, log) => {
          const n = s.nodes[t.at!]!;
          if (READ_KEY >= n.high) {
            log(`Read ${n.id}: 30 ≥ high key ${n.high}. Move right to ${n.right}.`, "info");
            t.at = n.right;
            t.pc--; // repeat this step at the right sibling
          } else readerFinish(s, t, [...n.keys], log);
        },
      },
    ],
    writer: [
      { label: () => "Read R (short S latch) → child B", brief: () => [["R", "S"]], run: (s, t, log) => { t.at = childFor(s.nodes.R!, WRITE_KEY); log("Read R → B. Hold no latch."); } },
      { label: () => "X-latch B. B is full", acquire: () => [["B", "X"]], run: (_s, _t, log) => log("X-latch B. Only B is latched.") },
      { label: () => "Make B2 = [25, 30] with high key 40 and right link C", run: (s, _t, log) => { s.nodes.B2 = node("B2", [25, 30], 40, "C"); log("B2 exists, but nothing points to it yet.", "info"); } },
      {
        label: () => "B = [20, 22], high key 25, right link B2; release B",
        run: (s, t, log) => { const b = s.nodes.B!; b.keys = [20, 22]; b.high = 25; b.right = "B2"; delete t.held.B; log("Half split done: B → B2 by the right link. Release B."); },
      },
      { label: () => "X-latch R, add separator 25 → B2, release R", brief: () => [["R", "X"]], run: (s, t, log) => { s.nodes.R!.keys = [20, 25, 40]; s.nodes.R!.kids = ["A", "B", "B2", "C"]; t.done = true; t.result = "inserted"; log("R = [20 | 25 | 40]. Insert done.", "ok"); } },
    ],
  },
  olc: {
    reader: [
      { label: () => "Read R's version, then R → child B", spinOn: () => "R", run: (s, t, log) => { t.seen.R = s.nodes.R!.version; t.at = childFor(s.nodes.R!, READ_KEY); log(`Version of R = ${t.seen.R}. Read R → ${t.at}. No latch, no write.`); } },
      {
        label: (_s, t) => `Read ${t.at}'s version, then check R's version`,
        spinOn: (_s, t) => t.at,
        run: (s, t, log) => {
          t.seen[t.at!] = s.nodes[t.at!]!.version;
          if (s.nodes.R!.version !== t.seen.R) { restart(t); log("R changed since we read it. Restart.", "info"); return; }
          log(`Version of ${t.at} = ${t.seen[t.at!]}. R is unchanged, so ${t.at} was the right child.`);
        },
      },
      { label: (_s, t) => `Read ${t.at} and search for 30 (not yet trusted)`, run: (s, t, log) => { t.readKeys = [...s.nodes[t.at!]!.keys]; log(`Read ${t.at} = [${t.readKeys.join(", ")}].`); } },
      {
        label: (_s, t) => `Check ${t.at}'s version again`,
        run: (s, t, log) => {
          const v = s.nodes[t.at!]!.version;
          if (v !== t.seen[t.at!]) { restart(t); log(`Version of ${t.at} is ${v}, not ${t.seen[t.at!] ?? "?"}: a writer changed it. Discard the read and restart.`, "info"); return; }
          readerFinish(s, t, t.readKeys!, log);
        },
      },
    ],
    writer: [
      { label: () => "Read R's version, then R → child B", spinOn: () => "R", run: (s, t, log) => { t.seen.R = s.nodes.R!.version; t.at = "B"; log(`Version of R = ${t.seen.R}. Read R → B.`); } },
      { label: () => "Lock B (version + 1, now odd)", spinOn: () => "B", run: (s, t, log) => { s.nodes.B!.version++; t.held.B = "X"; log(`Lock B: version ${s.nodes.B!.version}.`); } },
      { label: () => "Lock R (B is full, so R changes too)", spinOn: () => "R", run: (s, t, log) => { s.nodes.R!.version++; t.held.R = "X"; log(`Lock R: version ${s.nodes.R!.version}.`); } },
      { label: () => "Split B: B = [20, 22], new B2 = [25, 30]", run: (s, _t, log) => { splitB(s, false); s.nodes.B!.keys = [20, 22]; log("B = [20, 22], B2 = [25, 30]."); } },
      {
        label: () => "Add separator 25 → B2 to R, unlock R and B",
        run: (s, t, log) => {
          s.nodes.R!.keys = [20, 25, 40]; s.nodes.R!.kids = ["A", "B", "B2", "C"];
          s.nodes.R!.version++; s.nodes.B!.version++;
          releaseAll(t); t.done = true; t.result = "inserted";
          log(`Unlock: R version ${s.nodes.R!.version}, B version ${s.nodes.B!.version}. Insert done.`, "ok");
        },
      },
    ],
  },
};

function restart(t: ThreadState) {
  t.pc = -1; // incremented to 0 after the step
  t.at = null;
  t.seen = {};
  t.readKeys = null;
  t.restarts++;
}

export function programLength(p: Protocol, who: Who): number {
  return PROGRAMS[p][who].length;
}

/** Label of the next step of a thread, or null when it is done. */
export function nextLabel(s: LatchState, who: Who): string | null {
  const t = s[who];
  if (t.done) return null;
  return PROGRAMS[s.protocol][who][t.pc]!.label(s, t);
}

/** Why a thread cannot run its next step now (null = it can run). */
export function blockedBy(s: LatchState, who: Who): string | null {
  const t = s[who];
  if (t.done) return null;
  const st = PROGRAMS[s.protocol][who][t.pc]!;
  const o = s[other(who)];
  const need = [...(st.acquire?.(s, t) ?? []), ...(st.brief?.(s, t) ?? [])];
  for (const [id, mode] of need) {
    const h = o.held[id];
    if (h && (h === "X" || mode === "X")) return `${other(who)} holds ${h} on ${id}`;
  }
  const spin = st.spinOn?.(s, t);
  if (spin && s.nodes[spin]!.version % 2 === 1 && !t.held[spin]) return `${spin} is locked (odd version)`;
  return null;
}

/** Runs the next step of `who`. Returns a new state (the input is not changed). */
export function stepLatch(s0: LatchState, who: Who): LatchState {
  const s: LatchState = structuredClone(s0);
  const t = s[who];
  if (t.done) return s;
  const why = blockedBy(s, who);
  if (why) {
    s.log.push({ who, text: `Waits: ${why}.`, kind: "wait" });
    return s;
  }
  const st = PROGRAMS[s.protocol][who][t.pc]!;
  for (const [id, mode] of st.acquire?.(s, t) ?? []) t.held[id] = mode;
  const at = t.at;
  st.run(s, t, (text, kind = "ok") => s.log.push({ who, text, kind }));
  s.touched[who] = t.at ?? at;
  t.pc++;
  return s;
}

/** Runs a schedule such as "rwwwwr" (r = reader step, w = writer step). A blocked step only logs a wait. */
export function runSchedule(protocol: Protocol, schedule: string): LatchState {
  let s = initLatchState(protocol);
  for (const c of schedule) if (c === "r" || c === "w") s = stepLatch(s, c === "r" ? "reader" : "writer");
  return s;
}

/** Runs `who` until it is done or blocked (at most `max` steps). */
export function runUntilStuck(s0: LatchState, who: Who, max = 20): LatchState {
  let s = s0;
  for (let i = 0; i < max && !s[who].done && !blockedBy(s, who); i++) s = stepLatch(s, who);
  return s;
}

/**
 * The race: the reader takes one step (it reads R), the writer runs as far as it can, then the
 * reader runs as far as it can, then the writer, then the reader again.
 */
export function race(protocol: Protocol): LatchState {
  return raceStates(protocol).at(-1)!;
}

/** Every intermediate state of the race, starting with the initial state. */
export function raceStates(protocol: Protocol): LatchState[] {
  let s = initLatchState(protocol);
  const out = [s];
  const push = (who: Who) => { s = stepLatch(s, who); out.push(s); };
  push("reader");
  for (let i = 0; i < 3; i++) {
    for (const who of ["writer", "reader"] as const) {
      let guard = 0;
      while (!s[who].done && !blockedBy(s, who) && guard++ < 20) push(who);
      // Show one wait so the learner sees the block.
      if (!s[who].done && blockedBy(s, who) && !(s.log.at(-1)?.kind === "wait" && s.log.at(-1)?.who === who)) push(who);
    }
    if (s.reader.done && s.writer.done) break;
  }
  return out;
}

// ============================================================================
// Part 2: root latch counts on a real tree
// ============================================================================

export type RootProtocol = "crabbing" | "optimistic" | "blink" | "olc";
export const ROOT_PROTOCOLS: RootProtocol[] = ["crabbing", "optimistic", "blink", "olc"];

export interface RootCounts {
  /** Shared latch acquisitions on the root. */
  rootS: number;
  /** Exclusive latch acquisitions on the root. */
  rootX: number;
  /** Writes to the root's latch word (acquire + release = 2 writes; OLC readers write nothing). */
  rootLineWrites: number;
  /** Descents that had to start again with stronger latches. */
  restarts: number;
  /** Largest number of latches one writer held at the same time. */
  maxHeld: number;
  /** Writes that kept the root exclusively latched while they changed the leaf. */
  rootBlocking: number;
}

/** Nodes on the search path for k, root first (no instrumentation). */
export function pathTo<K, V>(t: BPlusTree<K, V>, k: K): BNode<K, V>[] {
  const out: BNode<K, V>[] = [];
  let n = t.root;
  for (;;) {
    out.push(n);
    if (n.kind === "leaf") return out;
    let i = 0;
    while (i < n.keys.length && t.cmp(n.keys[i]!, k) <= 0) i++;
    n = n.kids[i]!;
  }
}

export interface ContentionResult {
  ops: number;
  writes: number;
  height: number;
  leafSplits: number;
  rootChanges: number;
  byProtocol: Record<RootProtocol, RootCounts>;
}

/**
 * Runs `ops` operations (a fraction `writeFrac` are inserts of new random keys, the rest are
 * lookups) on a tree preloaded with `n` random keys, and counts what each protocol would do at
 * the root. The structural facts (did the leaf split, how far did the split go, did the root
 * change) come from the real tree's event log.
 */
export function rootContention(opts: { order: number; n: number; ops: number; writeFrac: number; seed?: number }): ContentionResult {
  const rng = mulberry32(opts.seed ?? 11);
  const space = 1 << 30;
  const t = new BPlusTree<number, number>({ order: opts.order });
  for (let i = 0; i < opts.n; i++) t.insert(Math.floor(rng() * space), 0);
  const zero = (): RootCounts => ({ rootS: 0, rootX: 0, rootLineWrites: 0, restarts: 0, maxHeld: 0, rootBlocking: 0 });
  const by: Record<RootProtocol, RootCounts> = { crabbing: zero(), optimistic: zero(), blink: zero(), olc: zero() };
  let writes = 0, leafSplits = 0, rootChanges = 0;
  let splitDepths: number[] = [];
  let newRoot = false;
  t.listener = (e: BEvent<number>) => {
    if (e.t === "split") splitDepths.push(e.depth);
    if (e.t === "newRoot") newRoot = true;
  };
  for (let i = 0; i < opts.ops; i++) {
    const h = t.height;
    const k = Math.floor(rng() * space);
    if (rng() >= opts.writeFrac) {
      t.get(k);
      // Readers: every protocol but OLC takes a shared latch on the root.
      for (const p of ["crabbing", "optimistic", "blink"] as const) { by[p].rootS++; by[p].rootLineWrites += 2; }
      continue;
    }
    writes++;
    // Before the insert: which nodes on the path are full (not "safe" for an insert)?
    const full = pathTo(t, k).map((n) => n.keys.length >= t.maxKeys);
    splitDepths = [];
    newRoot = false;
    t.insert(k, 0);
    const splits = splitDepths.length;
    const leafFull = full[h - 1]!;
    const rootChanged = newRoot || splitDepths.includes(1) || h === 1;
    if (splits > 0) leafSplits++;
    if (rootChanged) rootChanges++;
    // Pessimistic crabbing: X-latch each node on the way down; release all ancestors when the
    // newly latched node is safe (not full). held(d) = d - (deepest safe node above d) + 1.
    let maxHeld = 1, safeAbove = 0;
    for (let d = 1; d < h; d++) {
      maxHeld = Math.max(maxHeld, d - safeAbove + 1);
      if (!full[d]) safeAbove = d;
    }
    // The root stays latched while the leaf changes if no node below the root is safe.
    const rootHeldAtLeaf = safeAbove === 0;
    by.crabbing.rootX++;
    by.crabbing.rootLineWrites += 2;
    by.crabbing.maxHeld = Math.max(by.crabbing.maxHeld, maxHeld);
    if (rootHeldAtLeaf) by.crabbing.rootBlocking++;
    // Optimistic descent (Bayer-Schkolnick): S on inner nodes, X on the leaf. If the leaf is
    // full, release everything and run the pessimistic descent again.
    if (h === 1) { by.optimistic.rootX++; by.optimistic.rootLineWrites += 2; by.optimistic.rootBlocking++; }
    else {
      by.optimistic.rootS++;
      by.optimistic.rootLineWrites += 2;
      if (leafFull) {
        by.optimistic.restarts++;
        by.optimistic.rootX++;
        by.optimistic.rootLineWrites += 2;
        if (rootHeldAtLeaf) by.optimistic.rootBlocking++;
      }
    }
    by.optimistic.maxHeld = Math.max(by.optimistic.maxHeld, leafFull ? maxHeld : Math.min(2, h));
    // B-link: one short latch per node on the way down; X on the root only to add a separator.
    by.blink.rootS++;
    by.blink.rootLineWrites += 2;
    if (rootChanged) { by.blink.rootX++; by.blink.rootLineWrites += 2; }
    by.blink.maxHeld = Math.max(by.blink.maxHeld, splits > 0 ? 2 : 1);
    // OLC: no latch on the way down (read the version only). Lock the root only to change it.
    if (rootChanged) { by.olc.rootX++; by.olc.rootLineWrites += 2; }
    by.olc.maxHeld = Math.max(by.olc.maxHeld, Math.min(h, splits + 1));
  }
  return { ops: opts.ops, writes, height: t.height, leafSplits, rootChanges, byProtocol: by };
}
