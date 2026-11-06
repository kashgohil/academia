/**
 * Sequence CRDTs for text.
 *
 * RGA, the Replicated Growable Array (Roh, Jeon, Kim, Lee 2011). Each character has a unique id (counter, replica),
 * where the counter is a Lamport clock. An insert names the id of the character to its left ("after"). A deleted
 * character stays as a tombstone, so later inserts can still refer to it. To apply insert(id, after):
 *   start just right of `after`, skip every element whose id is larger than the new id, and insert there.
 * Ids compare by counter, then by replica. A later sibling and everything typed after it have larger ids, so the
 * rule puts the newest sibling first, and keeps each sibling's own text together. Ops must arrive in causal order
 * (the char that an insert names must exist), so replicas use the causal broadcast layer (causal.ts).
 *
 * Logoot-style positions (Weiss, Urso, Molli 2009; the allocation is the "boundary+" idea of LSEQ, Nédelec et al.
 * 2013): each character has a dense position, a list of (digit, site) pairs, and the text is the characters sorted by
 * position. To insert between p and q, a replica picks a new position between them, close to p.
 *
 * Index-based ops with no CRDT: insert(index, char). Replicas apply the same ops at different indexes and diverge.
 */
import { CausalNet } from "./causal";

// ---------------------------------------------------------------- RGA

export interface RgaId { c: number; r: number }
export const idKey = (id: RgaId) => `${id.c}@${id.r}`;
/** Larger id: higher counter, then higher replica. */
export const idGreater = (a: RgaId, b: RgaId) => a.c > b.c || (a.c === b.c && a.r > b.r);

export interface RgaElem { id: RgaId; ch: string; after: string | null; deleted: boolean }
export type RgaOp = { k: "ins"; id: RgaId; after: string | null; ch: string } | { k: "del"; target: string };

export class Rga {
  readonly elems: RgaElem[] = [];
  private index = new Map<string, number>();
  clock = 0;
  constructor(readonly replica: number) {}

  private reindex(from: number) {
    for (let i = from; i < this.elems.length; i++) this.index.set(idKey(this.elems[i]!.id), i);
  }

  has(key: string) {
    return this.index.has(key);
  }

  /** Applies an op from any replica. It is idempotent: an insert whose id exists does nothing. */
  apply(op: RgaOp) {
    if (op.k === "del") {
      const i = this.index.get(op.target);
      if (i === undefined) throw new Error(`delete of unknown ${op.target}: ops must arrive in causal order`);
      this.elems[i]!.deleted = true;
      return;
    }
    const key = idKey(op.id);
    if (this.index.has(key)) return;
    this.clock = Math.max(this.clock, op.id.c);
    let i = 0;
    if (op.after !== null) {
      const a = this.index.get(op.after);
      if (a === undefined) throw new Error(`insert after unknown ${op.after}: ops must arrive in causal order`);
      i = a + 1;
    }
    while (i < this.elems.length && idGreater(this.elems[i]!.id, op.id)) i++;
    this.elems.splice(i, 0, { id: op.id, ch: op.ch, after: op.after, deleted: false });
    this.reindex(i);
  }

  /** The visible characters and their ids. */
  visible(): RgaElem[] {
    return this.elems.filter((e) => !e.deleted);
  }
  text() {
    return this.visible().map((e) => e.ch).join("");
  }

  /** Makes (and applies) the op that inserts ch at visible index pos. */
  insertAt(pos: number, ch: string): RgaOp {
    const vis = this.visible();
    const after = pos > 0 ? idKey(vis[pos - 1]!.id) : null;
    const op: RgaOp = { k: "ins", id: { c: this.clock + 1, r: this.replica }, after, ch };
    this.apply(op);
    return op;
  }

  /** Makes (and applies) the op that inserts ch right after the element `after` (null: at the start). */
  insertAfter(after: string | null, ch: string): RgaOp {
    const op: RgaOp = { k: "ins", id: { c: this.clock + 1, r: this.replica }, after, ch };
    this.apply(op);
    return op;
  }

  deleteAt(pos: number): RgaOp {
    const op: RgaOp = { k: "del", target: idKey(this.visible()[pos]!.id) };
    this.apply(op);
    return op;
  }
}

/** The ops that turn the text `before` into `after`, as one replace of the changed middle (typing, paste, delete). */
export function editOps(doc: Rga, after: string): RgaOp[] {
  const before = doc.text();
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const ops: RgaOp[] = [];
  for (let k = 0; k < before.length - p - s; k++) ops.push(doc.deleteAt(p));
  for (let k = 0; k < after.length - p - s; k++) ops.push(doc.insertAt(p + k, after[p + k]!));
  return ops;
}

// ---------------------------------------------------------------- Logoot-style positions

export type Pos = [number, number][];
export const POS_BASE = 32;
export const POS_BOUNDARY = 10;

/** Lexicographic order on (digit, site) pairs; a prefix is smaller. */
export function posCompare(a: Pos, b: Pos): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = a[i]![0] - b[i]![0] || a[i]![1] - b[i]![1];
    if (d) return d;
  }
  return a.length - b.length;
}

/** A position strictly between p and q (p < q), close to p, for `site`. `rnd` gives numbers in [0, 1). */
export function allocBetween(p: Pos, q: Pos | null, site: number, rnd: () => number): Pos {
  const out: Pos = [];
  let bounded = q !== null;
  for (let d = 0; ; d++) {
    const pd: [number, number] = d < p.length ? p[d]! : [0, -1];
    const qd: [number, number] = bounded && q && d < q.length ? q[d]! : [POS_BASE, Infinity];
    const gap = qd[0] - pd[0];
    if (gap > 1) {
      out.push([pd[0] + 1 + Math.floor(rnd() * Math.min(POS_BOUNDARY, gap - 1)), site]);
      return out;
    }
    out.push(pd);
    if (pd[0] !== qd[0] || pd[1] !== qd[1]) bounded = false;
  }
}

export interface PosElem { pos: Pos; ch: string; site: number }
export const posText = (els: PosElem[]) => [...els].sort((a, b) => posCompare(a.pos, b.pos)).map((e) => e.ch).join("");

// ---------------------------------------------------------------- the interleaving scenario

export type Algo = "rga" | "logoot" | "index";
export type Direction = "forward" | "backward";

export interface InterleaveResult {
  algo: Algo;
  /** The text at each replica after it has applied both users' ops. */
  texts: [string, string];
  converged: boolean;
  /** Both words appear whole in the merged text. */
  wordsKept: boolean;
  /** Owner of each character of replica 0's text: 0 (user A), 1 (user B), or -1 (the starting text). */
  owners: number[];
  /** For RGA: the merged elements with their ids, for the id view. */
  rga?: { ch: string; id: string; after: string | null; owner: number }[];
}

/**
 * Starting text `base`. User A types `wordA` and user B types `wordB` at the same index `at`, at the same time.
 * forward: each character goes right after the previous one. backward: the user types the word from its last
 * letter, moving the cursor left each time, so each character goes at the same index.
 */
export function interleave(algo: Algo, wordA: string, wordB: string, direction: Direction, base = "Hi !", at = 3, seed = 1): InterleaveResult {
  const words = [wordA, wordB];
  const order = (w: string) => (direction === "forward" ? [...w] : [...w].reverse());
  if (algo === "rga") {
    const docs = [new Rga(0), new Rga(1)];
    // The base text is made by a third replica (2), and both docs have it.
    const seedDoc = new Rga(2);
    const baseOps = [...base].map((ch, i) => seedDoc.insertAt(i, ch));
    for (const d of docs) for (const op of baseOps) d.apply(op);
    const opsBy: RgaOp[][] = docs.map((d, u) => {
      const ops: RgaOp[] = [];
      order(words[u]!).forEach((ch, k) => ops.push(d.insertAt(direction === "forward" ? at + k : at, ch)));
      return ops;
    });
    // Each replica then applies the other user's ops, in the order that user made them.
    for (const op of opsBy[1]!) docs[0]!.apply(op);
    for (const op of opsBy[0]!) docs[1]!.apply(op);
    const texts: [string, string] = [docs[0]!.text(), docs[1]!.text()];
    const vis = docs[0]!.visible();
    const owners = vis.map((e) => (e.id.r === 2 ? -1 : e.id.r));
    return {
      algo, texts, converged: texts[0] === texts[1], wordsKept: texts[0].includes(wordA) && texts[0].includes(wordB), owners,
      rga: vis.map((e) => ({ ch: e.ch, id: idKey(e.id), after: e.after, owner: e.id.r === 2 ? -1 : e.id.r })),
    };
  }
  if (algo === "logoot") {
    let x = seed >>> 0;
    const rnd = () => ((x = (Math.imul(x ^ (x >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
    // The base text gets evenly spread positions from site 9.
    const baseEls: PosElem[] = [...base].map((ch, i) => ({ pos: [[2 + i * 4, 9]], ch, site: -1 }));
    const users: PosElem[][] = [0, 1].map((u) => {
      const els = [...baseEls];
      for (const [k, ch] of order(words[u]!).entries()) {
        const sorted = [...els].sort((a, b) => posCompare(a.pos, b.pos));
        const idx = direction === "forward" ? at + k : at;
        const p = idx > 0 ? sorted[idx - 1]!.pos : [];
        const q = idx < sorted.length ? sorted[idx]!.pos : null;
        els.push({ pos: allocBetween(p, q, u, rnd), ch, site: u });
      }
      return els.slice(baseEls.length);
    });
    const all = [...baseEls, ...users[0]!, ...users[1]!].sort((a, b) => posCompare(a.pos, b.pos));
    const t = all.map((e) => e.ch).join("");
    return { algo, texts: [t, t], converged: true, wordsKept: t.includes(wordA) && t.includes(wordB), owners: all.map((e) => e.site) };
  }
  // index: each replica applies its own inserts, then the other's at the same indexes.
  const ops = [0, 1].map((u) => order(words[u]!).map((ch, k) => ({ i: direction === "forward" ? at + k : at, ch, u })));
  const run = (first: number) => {
    let s: { ch: string; u: number }[] = [...base].map((ch) => ({ ch, u: -1 }));
    for (const o of [...ops[first]!, ...ops[1 - first]!]) s = [...s.slice(0, o.i), { ch: o.ch, u: o.u }, ...s.slice(o.i)];
    return s;
  };
  const a = run(0), b = run(1);
  const texts: [string, string] = [a.map((e) => e.ch).join(""), b.map((e) => e.ch).join("")];
  return { algo, texts, converged: texts[0] === texts[1], wordsKept: texts[0].includes(wordA) && texts[0].includes(wordB), owners: a.map((e) => e.u) };
}

/** Over many seeds: the share of Logoot-style runs in which a word is split. */
export function logootSplitShare(wordA: string, wordB: string, direction: Direction, runs = 200): number {
  let split = 0;
  for (let s = 1; s <= runs; s++) if (!interleave("logoot", wordA, wordB, direction, "Hi !", 3, s).wordsKept) split++;
  return split / runs;
}

// ---------------------------------------------------------------- two editors on Net

/**
 * Two (or more) RGA replicas on the causal broadcast layer, with anti-entropy so that ops lost in a partition are
 * sent again after it heals. `latency` is one fixed delay, so a demo can drive the net with real time.
 */
export class RgaNet {
  readonly docs: Rga[];
  readonly cb: CausalNet<RgaOp>;
  constructor(n: number, delay: number, seed = 1, antiEntropy = 250) {
    this.docs = Array.from({ length: n }, (_, i) => new Rga(i));
    this.cb = new CausalNet<RgaOp>(n, { seed, latency: { min: delay, max: delay } }, { causal: true, dedupe: true, antiEntropy }, (i, op, meta) => {
      if (!meta.local) this.docs[i]!.apply(op);
    });
  }
  /** Replica i changes its text to `text`; the ops go out to the others. */
  edit(i: number, text: string, delay?: number) {
    const ops = editOps(this.docs[i]!, text);
    for (const op of ops) this.cb.broadcast(i, op, { delay: delay === undefined ? undefined : () => delay });
    return ops;
  }
  /** Ops sent but not yet applied at some replica. */
  pending(): number {
    const total = this.cb.D.map((d) => d.reduce((a, b) => a + b, 0));
    const made = this.cb.D.map((d, i) => d[i]!).reduce((a, b) => a + b, 0);
    return total.reduce((a, t) => a + (made - t), 0);
  }
}
