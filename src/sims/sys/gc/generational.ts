/**
 * Generational collection: a lifetime model and a card-table stepper.
 *
 * - `genSim` allocates objects whose lifetimes come from a two-part distribution (MODEL INPUTS): a fraction `young`
 *   die after a short exponential lifetime, the others live long. Lifetimes are in bytes allocated, the usual clock
 *   of GC research. The generational collector copies the survivors of a full nursery into the old generation
 *   (promotion after one survival) and marks the old generation when it reaches twice its size after the last major
 *   collection. The baseline is a non-generational mark-sweep collector with the same peak memory. Both count work in
 *   bytes traced or copied, not in time.
 * - `cardFrames` steps through one old-to-young store and the next minor collection, with or without a card-marking
 *   write barrier. Cards are 512 bytes, as in HotSpot's card table (card shift 9).
 */
import { rng } from "./heap";

export interface GenInputs {
  /** Fraction of objects that die young, 0..1. */
  young: number;
  /** Mean lifetime of a young-dying object, KiB allocated. */
  youngLife: number;
  /** Mean lifetime of a long-lived object, KiB allocated. */
  oldLife: number;
  /** Nursery size, KiB. */
  nursery: number;
  /** Total allocation, KiB. */
  total: number;
  /** Object size, bytes. */
  objSize: number;
  seed: number;
}

export const GEN_DEFAULTS: GenInputs = { young: 0.95, youngLife: 16, oldLife: 8192, nursery: 512, total: 32768, objSize: 256, seed: 1 };

export interface GenResult {
  minors: number;
  majors: number;
  /** Bytes copied out of the nursery (all promoted). */
  copied: number;
  /** Bytes marked by major collections. */
  majorMarked: number;
  /** Bytes of objects that were promoted and then died in the old generation. */
  promotedDied: number;
  /** Largest single collection, bytes of work: a proxy for the pause. */
  maxMinor: number;
  maxMajor: number;
  /** Mean survival rate of a minor collection. */
  survival: number;
  peak: number;
  genWork: number;
  /** The non-generational baseline with the same peak memory. */
  full: { gcs: number; work: number; maxPause: number };
  /** Heap occupancy over time for a plot: [KiB allocated, KiB in use]. */
  trace: [number, number][];
  minorAt: number[];
  majorAt: number[];
}

/** A binary min-heap of numbers. */
class MinHeap {
  a: number[] = [];
  get size() { return this.a.length; }
  peek() { return this.a[0]!; }
  push(x: number) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p]! <= x) break; a[i] = a[p]!; i = p; }
    a[i] = x;
  }
  pop() {
    const a = this.a; const top = a[0]!; const last = a.pop()!;
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, v = last;
        if (l < a.length && a[l]! < v) { m = l; v = a[l]!; }
        if (r < a.length && a[r]! < v) { m = r; }
        if (m === i) break;
        a[i] = a[m]!; i = m;
      }
      a[i] = last;
    }
    return top;
  }
}

/** Death times (bytes allocated) of every object, in allocation order. */
export function lifetimes(p: GenInputs): Float64Array {
  const n = Math.floor((p.total * 1024) / p.objSize);
  const r = rng(p.seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const birth = i * p.objSize;
    const mean = (r() < p.young ? p.youngLife : p.oldLife) * 1024;
    out[i] = birth + p.objSize - mean * Math.log(1 - r());
  }
  return out;
}

export function genSim(p: GenInputs): GenResult {
  const death = lifetimes(p);
  const n = death.length, S = p.objSize, N = p.nursery * 1024;
  const old = new MinHeap();
  let oldOcc = 0, oldTrigger = Math.max(N, 256 * 1024);
  let minors = 0, majors = 0, copied = 0, majorMarked = 0, maxMinor = 0, maxMajor = 0, promotedDied = 0, survSum = 0, peak = 0;
  let nurseryStart = 0;
  const trace: [number, number][] = [];
  const minorAt: number[] = [], majorAt: number[] = [];
  const every = Math.max(1, Math.floor(n / 400));
  for (let i = 0; i < n; i++) {
    const t = (i + 1) * S;
    const inNursery = (i + 1 - nurseryStart) * S;
    peak = Math.max(peak, oldOcc + inNursery);
    if (i % every === 0) trace.push([t / 1024, (oldOcc + inNursery) / 1024]);
    if (inNursery < N && i < n - 1) continue;
    // minor collection: copy the survivors to the old generation
    minors++; minorAt.push(t / 1024);
    let surv = 0;
    for (let j = nurseryStart; j <= i; j++) if (death[j]! > t) { surv++; old.push(death[j]!); }
    nurseryStart = i + 1;
    copied += surv * S; maxMinor = Math.max(maxMinor, surv * S); survSum += surv / Math.max(1, inNursery / S);
    oldOcc += surv * S;
    if (oldOcc >= oldTrigger) {
      majors++; majorAt.push(t / 1024);
      while (old.size && old.peek() <= t) { old.pop(); promotedDied += S; }
      oldOcc = old.size * S;
      majorMarked += oldOcc; maxMajor = Math.max(maxMajor, oldOcc);
      oldTrigger = Math.max(N, 256 * 1024, 2 * oldOcc);
    }
    trace.push([t / 1024, oldOcc / 1024]);
  }
  // baseline: one heap of size `peak`, mark-sweep of all live objects when it is full
  const live = new MinHeap();
  let used = 0, gcs = 0, work = 0, maxPause = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) * S;
    live.push(death[i]!); used += S;
    if (used >= peak) {
      while (live.size && live.peek() <= t) live.pop();
      gcs++; const w = live.size * S; work += w; maxPause = Math.max(maxPause, w);
      used = live.size * S;
      if (used >= peak) break;
    }
  }
  return {
    minors, majors, copied, majorMarked, promotedDied, maxMinor, maxMajor, survival: minors ? survSum / minors : 0, peak,
    genWork: copied + majorMarked, full: { gcs, work, maxPause }, trace, minorAt, majorAt,
  };
}

// ---------------------------------------------------------------- card marking

export const CARD = 512;
export const CARD_SHIFT = 9;
export const OLD_BASE = 0x10000;

export interface CardObj { name: string; gen: "old" | "young"; addr: number; size: number; fields: (string | null)[] }

export interface CardFrame {
  objs: CardObj[];
  roots: Record<string, string | null>;
  dirty: number[];
  /** Objects whose fields the minor collection reads (dirty cards). */
  scanned: string[];
  /** Young objects marked live by the minor collection. */
  live: string[];
  freed: string[];
  dangling: string[];
  code?: string;
  text: string;
  phase: "run" | "barrier" | "minor" | "done";
}

const cardOf = (addr: number) => (addr - OLD_BASE) >> CARD_SHIFT;

/**
 * Old objects O0..O7 (256 bytes each, so 2 per card) and young objects Y1..Y3. The mutator stores a new young object
 * into O5 and drops its stack pointer to it. A minor collection traces from the roots and, with the barrier, from the
 * objects on dirty cards.
 */
export function cardFrames(barrier: boolean): CardFrame[] {
  const objs: CardObj[] = [
    ...Array.from({ length: 8 }, (_, i): CardObj => ({ name: `O${i}`, gen: "old", addr: OLD_BASE + 256 * i, size: 256, fields: [null, null] })),
    { name: "Y1", gen: "young", addr: 0x40000, size: 32, fields: ["Y2", null] },
    { name: "Y2", gen: "young", addr: 0x40020, size: 32, fields: [null, null] },
  ];
  const roots: Record<string, string | null> = { cfg: "O0", req: "Y1", tmp: null };
  const dirty: number[] = [];
  const frames: CardFrame[] = [];
  const snap = (phase: CardFrame["phase"], text: string, extra: Partial<CardFrame> = {}) =>
    frames.push({ objs: objs.map((o) => ({ ...o, fields: [...o.fields] })), roots: { ...roots }, dirty: [...dirty], scanned: [], live: [], freed: [], dangling: [], phase, text, ...extra });
  snap("run", "The old generation holds O0 to O7 in 4 cards of 512 bytes. The nursery holds Y1 and Y2. Only Y1 has a root.");
  objs.push({ name: "Y3", gen: "young", addr: 0x40040, size: 32, fields: [null, null] });
  roots.tmp = "Y3";
  snap("run", "tmp = new(Y3): a new object in the nursery, held by a local.", { code: "tmp := &Y{}" });
  objs.find((o) => o.name === "O5")!.fields[1] = "Y3";
  if (barrier) {
    dirty.push(cardOf(objs.find((o) => o.name === "O5")!.addr));
    snap("barrier", `O5.f1 = tmp: an old-to-young pointer. The barrier dirties card ${cardOf(OLD_BASE + 256 * 5)}, the card that holds O5.`, { code: "o5.f1 = tmp\ncard[(&o5.f1) >> 9] = DIRTY" });
  } else {
    snap("barrier", "O5.f1 = tmp: an old-to-young pointer. With no barrier, nothing records it.", { code: "o5.f1 = tmp" });
  }
  roots.tmp = null;
  snap("run", "tmp = nil. Now the only pointer to Y3 is in an old object.", { code: "tmp = nil" });
  // minor collection
  const young = objs.filter((o) => o.gen === "young");
  const scanned = objs.filter((o) => o.gen === "old" && dirty.includes(cardOf(o.addr))).map((o) => o.name);
  const live = new Set<string>();
  const visit = (n: string | null) => {
    const o = objs.find((x) => x.name === n);
    if (!o || o.gen !== "young" || live.has(o.name)) return;
    live.add(o.name);
    o.fields.forEach(visit);
  };
  Object.values(roots).forEach(visit);
  for (const s of scanned) objs.find((o) => o.name === s)!.fields.forEach(visit);
  snap("minor", `Minor collection. It traces from the roots${barrier ? ` and from the ${scanned.length} objects on dirty cards (${scanned.join(", ")})` : " only; it does not read the old generation"}. Live young objects: ${[...live].join(", ")}.`, { scanned, live: [...live] });
  const freed = young.filter((o) => !live.has(o.name)).map((o) => o.name);
  const dangling = objs.filter((o) => o.gen === "old" && o.fields.some((f) => f !== null && freed.includes(f))).map((o) => o.name);
  const kept = objs.filter((o) => !freed.includes(o.name));
  dirty.length = 0;
  frames.push({
    objs: kept.map((o) => ({ ...o, fields: [...o.fields] })), roots: { ...roots }, dirty: [], scanned, live: [...live], freed, dangling, phase: "done",
    text: dangling.length
      ? `The nursery is reset. ${freed.join(", ")} freed, but ${dangling.join(", ")} still points to Y3: a dangling pointer in a memory-safe language.`
      : `The nursery is reset. ${[...live].join(", ")} survived and moved to the old generation; ${freed.join(", ") || "nothing"} freed. The cards are clean again.`,
  });
  return frames;
}
