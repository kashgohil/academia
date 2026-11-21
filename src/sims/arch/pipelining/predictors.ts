/**
 * Conditional branch direction predictors, small and readable, each with its storage cost in bits. They follow the
 * papers in simplified form:
 * - bimodal: a table of 2-bit saturating counters indexed by pc (J. E. Smith, ISCA 1981).
 * - local: two-level adaptive with a per-branch history table and one shared pattern table of 2-bit counters
 *   (Yeh and Patt, MICRO 1991; the "PAg" form).
 * - gshare: 2-bit counters indexed by pc XOR global history (McFarling, DEC WRL TN-36, 1993).
 * - tournament: a local and a global predictor with a chooser, laid out as in the Alpha 21264 (Kessler, IEEE Micro
 *   1999): local histories of 10 bits feed 3-bit counters; global history indexes 2-bit counters and the chooser.
 * - perceptron: one perceptron per pc over the global history, threshold ⌊1.93h + 14⌋ and signed weights of
 *   1 + ⌈log₂ θ⌉ bits (Jiménez and Lin, HPCA 2001).
 * - tage: a bimodal base and 5 tagged tables with geometric history lengths; the longest matching table predicts
 *   (Seznec and Michaud, JILP 2006). Simplified: no alternate-prediction counter and a plain usefulness reset.
 *
 * Every predictor is called as predict(pc) then update(pc, taken) for the same branch, in program order. pc is the
 * byte address; tables index with pc >>> 2. Table sizes come from a storage budget in bits (`makeBP(id, bits)`). The
 * sizes and history lengths for each budget are MODEL INPUTS, chosen to fit the budget; at 2¹⁵ bits the tournament
 * predictor has the table sizes of the Alpha 21264.
 */

export type BPId = "static" | "bimodal" | "local" | "gshare" | "tournament" | "perceptron" | "tage";
export const BP_IDS: BPId[] = ["bimodal", "local", "gshare", "tournament", "perceptron", "tage"];
export const BP_LABEL: Record<BPId, string> = {
  static: "Static: backward taken",
  bimodal: "Bimodal (2-bit counters)",
  local: "Local two-level",
  gshare: "gshare",
  tournament: "Tournament (21264-style)",
  perceptron: "Perceptron",
  tage: "TAGE (simplified)",
};

/** What a stepper shows about one prediction of the simple predictors. */
export interface Inspect {
  /** The history bits used (local or global), newest in bit 0, and their count. */
  hist: number;
  histBits: number;
  /** The index into the counter table, and the table size. */
  index: number;
  size: number;
  /** The counter value (0..3) before the update. */
  counter: number;
}

export interface BP {
  id: BPId;
  bits: number;
  /** A short description of the sizes. */
  shape: string;
  predict(pc: number): boolean;
  update(pc: number, taken: boolean): void;
  inspect?(pc: number): Inspect;
  /** The counter table, for the stepper (bimodal, local, gshare). */
  table?: Uint8Array;
}

const sat = (v: number, taken: boolean, max: number) => (taken ? Math.min(max, v + 1) : Math.max(0, v - 1));
const pow2Floor = (n: number) => (n < 1 ? 0 : 2 ** Math.floor(Math.log2(n)));

/** A global history of up to 64 outcomes, newest at index 0. */
class History {
  private bits: Uint8Array;
  private head = 0;
  constructor(readonly len: number) { this.bits = new Uint8Array(Math.max(1, len)); }
  push(t: boolean) { this.head = (this.head + this.bits.length - 1) % this.bits.length; this.bits[this.head] = +t; }
  /** Outcome i back (0 = newest), 0 or 1. */
  at(i: number) { return this.bits[(this.head + i) % this.bits.length]!; }
  /** The newest n bits as a number, newest in bit 0 (n ≤ 30). */
  low(n: number) { let v = 0; for (let i = n - 1; i >= 0; i--) v = (v << 1) | this.at(i); return v; }
  /** The newest n bits folded by XOR into w bits. */
  fold(n: number, w: number) {
    let v = 0;
    for (let i = 0; i < n; i++) v ^= this.at(i) << (i % w);
    return v;
  }
}

// ---------------------------------------------------------------- the simple ones

export function staticBackward(): BP & { setTarget(pc: number, target: number): void } {
  let back = new Map<number, boolean>();
  return {
    id: "static", bits: 0, shape: "no state: the sign of the offset",
    setTarget(pc, target) { back.set(pc, target <= pc); },
    predict: (pc) => back.get(pc) ?? false,
    update() {},
  };
}

export function bimodal(indexBits: number): BP {
  const size = 1 << indexBits, mask = size - 1, t = new Uint8Array(size).fill(2);
  return {
    id: "bimodal", bits: 2 * size, shape: `${size} counters`, table: t,
    predict: (pc) => t[(pc >>> 2) & mask]! >= 2,
    update: (pc, k) => { const i = (pc >>> 2) & mask; t[i] = sat(t[i]!, k, 3); },
    inspect: (pc) => ({ hist: 0, histBits: 0, index: (pc >>> 2) & mask, size, counter: t[(pc >>> 2) & mask]! }),
  };
}

/** Yeh and Patt's two-level predictor with local histories (PAg): `entries` histories of `histBits` bits. */
export function local(entries: number, histBits: number): BP {
  const lht = new Uint32Array(entries), size = 1 << histBits, hmask = size - 1, t = new Uint8Array(size).fill(2);
  const slot = (pc: number) => (pc >>> 2) % entries;
  return {
    id: "local", bits: entries * histBits + 2 * size, shape: `${entries} histories × ${histBits} bits, ${size} counters`, table: t,
    predict: (pc) => t[lht[slot(pc)]!]! >= 2,
    update: (pc, k) => { const s = slot(pc), h = lht[s]!; t[h] = sat(t[h]!, k, 3); lht[s] = ((h << 1) | +k) & hmask; },
    inspect: (pc) => { const h = lht[slot(pc)]!; return { hist: h, histBits, index: h, size, counter: t[h]! }; },
  };
}

/** McFarling's gshare: `indexBits` of pc XOR the newest `histBits` (≤ indexBits) global outcomes. */
export function gshare(indexBits: number, histBits = indexBits): BP {
  const size = 1 << indexBits, mask = size - 1, t = new Uint8Array(size).fill(2), hmask = (1 << histBits) - 1;
  let h = 0;
  const idx = (pc: number) => ((pc >>> 2) ^ h) & mask;
  return {
    id: "gshare", bits: 2 * size + histBits, shape: `${size} counters, ${histBits}-bit history`, table: t,
    predict: (pc) => t[idx(pc)]! >= 2,
    update: (pc, k) => { const i = idx(pc); t[i] = sat(t[i]!, k, 3); h = ((h << 1) | +k) & hmask; },
    inspect: (pc) => ({ hist: h, histBits, index: idx(pc), size, counter: t[idx(pc)]! }),
  };
}

// ---------------------------------------------------------------- tournament

/**
 * Local: `lEntries` histories of `lBits` bits index 2^lBits 3-bit counters. Global: `gBits` of global history index
 * 2^gBits 2-bit counters, and the same index picks a 2-bit chooser (high = trust global).
 */
export function tournament(lEntries: number, lBits: number, gBits: number): BP {
  const lht = new Uint32Array(lEntries), lSize = 1 << lBits, lMask = lSize - 1, lc = new Uint8Array(lSize).fill(4);
  const gSize = 1 << gBits, gMask = gSize - 1, gc = new Uint8Array(gSize).fill(2), ch = new Uint8Array(gSize).fill(2);
  let h = 0;
  let lp = false, gp = false;
  const ls = (pc: number) => (pc >>> 2) % lEntries;
  return {
    id: "tournament", bits: lEntries * lBits + 3 * lSize + 2 * gSize + 2 * gSize + gBits,
    shape: `local ${lEntries} × ${lBits} bits + ${lSize} 3-bit counters; global and chooser ${gSize} each`,
    predict(pc) {
      lp = lc[lht[ls(pc)]!]! >= 4;
      gp = gc[h]! >= 2;
      return ch[h]! >= 2 ? gp : lp;
    },
    update(pc, k) {
      if (lp !== gp) ch[h] = sat(ch[h]!, gp === k, 3);
      const s = ls(pc), lh = lht[s]!;
      lc[lh] = sat(lc[lh]!, k, 7);
      lht[s] = ((lh << 1) | +k) & lMask;
      gc[h] = sat(gc[h]!, k, 3);
      h = ((h << 1) | +k) & gMask;
    },
  };
}

// ---------------------------------------------------------------- perceptron

export const perceptronTheta = (h: number) => Math.floor(1.93 * h + 14);
/** Bits per weight: a sign bit and enough bits for θ, 1 + ⌈log₂ θ⌉. Jiménez and Lin report 7 bits at h = 12 and 9 at h = 62. */
export const perceptronWeightBits = (h: number) => 1 + Math.ceil(Math.log2(perceptronTheta(h)));

/** `n` perceptrons of h + 1 signed weights over `h` bits of global history. */
export function perceptron(n: number, h: number): BP {
  const w = new Int16Array(n * (h + 1)), hist = new History(h), theta = perceptronTheta(h), wb = perceptronWeightBits(h);
  const lo = -(2 ** (wb - 1)), hi = 2 ** (wb - 1) - 1;
  let y = 0;
  const base = (pc: number) => ((pc >>> 2) % n) * (h + 1);
  return {
    id: "perceptron", bits: n * (h + 1) * wb + h, shape: `${n} perceptrons × ${h + 1} weights of ${wb} bits, ${h}-bit history`,
    predict(pc) {
      const b = base(pc);
      y = w[b]!;
      for (let i = 0; i < h; i++) y += hist.at(i) ? w[b + 1 + i]! : -w[b + 1 + i]!;
      return y >= 0;
    },
    update(pc, k) {
      if ((y >= 0) !== k || Math.abs(y) <= theta) {
        const b = base(pc), t = k ? 1 : -1;
        const clamp = (v: number) => Math.max(lo, Math.min(hi, v));
        w[b] = clamp(w[b]! + t);
        for (let i = 0; i < h; i++) w[b + 1 + i] = clamp(w[b + 1 + i]! + (hist.at(i) ? t : -t));
      }
      hist.push(k);
    },
  };
}

// ---------------------------------------------------------------- TAGE

export const TAGE_TAG_BITS = 8;
/** The history lengths of the demo's TAGE: 5 tables, geometric from 3 to 48. MODEL INPUT. */
export const TAGE_LENGTHS = [3, 6, 12, 24, 48];

/** Geometric history lengths from `min` to `max` over `n` tables. */
export const geometric = (n: number, min: number, max: number) =>
  Array.from({ length: n }, (_, i) => Math.round(min * (max / min) ** (n === 1 ? 0 : i / (n - 1))));

/**
 * A base bimodal table of 2^baseBits counters and one tagged table of `size` entries per history length. An entry is a
 * 3-bit signed counter (-4..3, taken when ≥ 0), an 8-bit tag and a 2-bit usefulness counter.
 */
export function tage(baseBits: number, size: number, lengths: number[]): BP {
  const base = new Uint8Array(1 << baseBits).fill(2), bMask = (1 << baseBits) - 1;
  const n = lengths.length, tBits = Math.max(1, Math.ceil(Math.log2(size))), tagMask = (1 << TAGE_TAG_BITS) - 1;
  const ctr = lengths.map(() => new Int8Array(size)), tag = lengths.map(() => new Uint16Array(size)), u = lengths.map(() => new Uint8Array(size));
  const hist = new History(Math.max(...lengths));
  const idx = new Int32Array(n), tg = new Int32Array(n);
  let provider = -1, alt = -1, pred = false, altPred = false, updates = 0;
  return {
    id: "tage", bits: 2 * (1 << baseBits) + n * size * (3 + TAGE_TAG_BITS + 2) + hist.len,
    shape: `base ${1 << baseBits} counters + ${n} tables × ${size} entries, histories ${lengths.join(", ")}`,
    predict(pc) {
      const p = pc >>> 2;
      provider = -1; alt = -1;
      for (let i = 0; i < n; i++) {
        idx[i] = ((p ^ (p >>> tBits) ^ hist.fold(lengths[i]!, tBits)) >>> 0) % size;
        tg[i] = (p ^ hist.fold(lengths[i]!, TAGE_TAG_BITS) ^ (hist.fold(lengths[i]!, TAGE_TAG_BITS - 1) << 1)) & tagMask;
      }
      for (let i = n - 1; i >= 0; i--) {
        if (tag[i]![idx[i]!] !== tg[i]) continue;
        if (provider < 0) provider = i;
        else { alt = i; break; }
      }
      const basePred = base[p & bMask]! >= 2;
      altPred = alt >= 0 ? ctr[alt]![idx[alt]!]! >= 0 : basePred;
      pred = provider >= 0 ? ctr[provider]![idx[provider]!]! >= 0 : basePred;
      return pred;
    },
    update(pc, k) {
      const p = pc >>> 2;
      if (provider >= 0) {
        const c = ctr[provider]!, i = idx[provider]!;
        c[i] = k ? Math.min(3, c[i]! + 1) : Math.max(-4, c[i]! - 1);
        if (pred !== altPred) u[provider]![i] = sat(u[provider]![i]!, pred === k, 3);
      } else {
        base[p & bMask] = sat(base[p & bMask]!, k, 3);
      }
      // On a mispredict, take an entry in a longer table whose usefulness is 0.
      if (pred !== k && provider < n - 1) {
        let done = false;
        for (let j = provider + 1; j < n; j++) {
          if (u[j]![idx[j]!] === 0) { tag[j]![idx[j]!] = tg[j]!; ctr[j]![idx[j]!] = k ? 0 : -1; done = true; break; }
        }
        if (!done) for (let j = provider + 1; j < n; j++) u[j]![idx[j]!] = Math.max(0, u[j]![idx[j]!]! - 1);
      }
      // Age the usefulness counters now and then, so that old entries can be replaced.
      if (++updates % 4096 === 0) for (const t of u) for (let i = 0; i < size; i++) t[i] = t[i]! >> 1;
      hist.push(k);
    },
  };
}

// ---------------------------------------------------------------- by budget

/** Budgets the demos offer: 2^10 to 2^17 bits (128 B to 16 KiB). */
export const BUDGET_LOG2 = { min: 10, max: 17, default: 13 } as const;

/** A predictor whose tables fit in 2^k bits. The split of the budget is a MODEL INPUT (see the file header). */
export function makeBP(id: BPId, k: number): BP {
  const B = 2 ** k;
  switch (id) {
    case "static": return staticBackward();
    case "bimodal": return bimodal(k - 1);
    case "gshare": return gshare(k - 1);
    case "local": {
      const hb = Math.min(10, k - 3);
      return local(pow2Floor((B - 2 ** (hb + 1)) / hb), hb);
    }
    case "tournament": {
      const gb = k - 3, lb = Math.max(2, Math.min(10, k - 5));
      return tournament(pow2Floor((B / 2 - 3 * 2 ** lb) / lb), lb, gb);
    }
    case "perceptron": {
      const h = Math.min(32, Math.max(8, 2 * (k - 8) + 4));
      return perceptron(Math.max(1, Math.floor((B - h) / ((h + 1) * perceptronWeightBits(h)))), h);
    }
    case "tage": {
      const tables = TAGE_LENGTHS.length;
      return tage(k - 3, Math.max(1, Math.floor((B * 3) / 4 / tables / (3 + TAGE_TAG_BITS + 2))), TAGE_LENGTHS);
    }
  }
}

// ---------------------------------------------------------------- running

export interface BranchEvent { pc: number; taken: boolean; target: number }

export interface BPScore { branches: number; misses: number; rate: number }

/** Run a fresh predictor over the conditional branches of a trace. */
export function score(bp: BP, events: readonly BranchEvent[], warmup = 0): BPScore {
  let misses = 0, n = 0;
  const st = bp.id === "static" ? (bp as ReturnType<typeof staticBackward>) : null;
  events.forEach((e, i) => {
    st?.setTarget(e.pc, e.target);
    const p = bp.predict(e.pc);
    bp.update(e.pc, e.taken);
    if (i < warmup) return;
    n++;
    if (p !== e.taken) misses++;
  });
  return { branches: n, misses, rate: n ? misses / n : 0 };
}

/** One step of a stepper: the prediction, the outcome, and what the predictor looked at. */
export interface BPStep { i: number; pc: number; taken: boolean; pred: boolean; look: Inspect }

/** The first `n` predictions of a simple predictor, with what it looked at; the table state after each step is replayed by the caller. */
export function steps(make: () => BP, events: readonly BranchEvent[], n = events.length): BPStep[] {
  const bp = make(), out: BPStep[] = [];
  for (let i = 0; i < Math.min(n, events.length); i++) {
    const e = events[i]!;
    const look = bp.inspect!(e.pc);
    const pred = bp.predict(e.pc);
    bp.update(e.pc, e.taken);
    out.push({ i, pc: e.pc, taken: e.taken, pred, look });
  }
  return out;
}

/** The table of a simple predictor after the first k events (a replay: predictors are deterministic). */
export function tableAfter(make: () => BP, events: readonly BranchEvent[], k: number): Uint8Array {
  const bp = make();
  for (let i = 0; i < k && i < events.length; i++) { bp.predict(events[i]!.pc); bp.update(events[i]!.pc, events[i]!.taken); }
  return bp.table!.slice();
}
