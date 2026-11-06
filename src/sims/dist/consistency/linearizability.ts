/**
 * An exact linearizability checker, in the style of Wing and Gong (1993) with the memoization of Lowe (2017), as in
 * Knossos and Porcupine.
 *
 * The search builds a total order one operation at a time. An operation may come next only if no other operation
 * that is not yet placed returned before it was invoked (the real-time rule). The model then decides if the
 * operation is legal in the current state. If no candidate fits, the search backtracks. A cache of the configurations
 * (set of placed operations, model state) that already failed stops the search from doing the same work twice.
 *
 * The worst case is exponential: checking a register history is NP-complete (Gibbons and Korach 1997). In practice
 * the cost depends on the concurrency, not on the length, and splitting the history by key (P-compositionality,
 * Horn and Kroening 2015) keeps each search small.
 */
import { INITIAL, isPending, partitionByKey, relevant, type HOp } from "./history";

/** A sequential specification. `step` returns the next state, or undefined if the operation is illegal there. */
export interface Model<S> {
  init(): S;
  step(state: S, op: HOp): S | undefined;
  /** A string that identifies the state, for the cache. */
  hash(state: S): string;
}

/** A single read/write/cas register that starts at `init`. */
export function registerModel(init = INITIAL): Model<number> {
  return {
    init: () => init,
    step(s, op) {
      if (op.f === "w") return op.value!;
      if (op.f === "r") return op.value === undefined || op.value === s ? s : undefined;
      // cas: if the result is unknown, either outcome is allowed; the search tries the success branch.
      const hit = s === op.expect;
      if (op.ok === true) return hit ? op.value! : undefined;
      if (op.ok === false) return hit ? undefined : s;
      return hit ? op.value! : s;
    },
    hash: (s) => String(s),
  };
}

/** Many registers, one per key, as one object. Use it to check a multi-key history without partitioning. */
export function kvModel(init = INITIAL): Model<Record<string, number>> {
  const reg = registerModel(init);
  return {
    init: () => ({}),
    step(s, op) {
      const next = reg.step(s[op.key] ?? init, op);
      return next === undefined ? undefined : next === (s[op.key] ?? init) ? s : { ...s, [op.key]: next };
    },
    hash: (s) => Object.keys(s).sort().map((k) => `${k}=${s[k]}`).join(","),
  };
}

/** One step of the search, for animation. */
export type SearchEvent =
  | { kind: "place"; op: number; depth: number } // the op is legal next: placed at this depth
  | { kind: "reject"; op: number; depth: number } // the op is a candidate, but the model rejects it
  | { kind: "cached"; depth: number } // this configuration failed before
  | { kind: "back"; op: number; depth: number } // undo the op at this depth
  | { kind: "done"; ok: boolean };

export interface LinResult {
  /** true: linearizable; false: not; null: the search hit its state budget. */
  ok: boolean | null;
  /** If ok: the ids in a valid linearization order (pending writes that took effect are included). */
  order: number[];
  /** Configurations visited (the search cost). */
  explored: number;
  /** Times the cache cut a branch. */
  cacheHits: number;
  /** The longest prefix the search could build, and the candidates that all failed after it. */
  best: number[];
  blocked: number[];
  trace?: SearchEvent[];
}

export interface CheckOpts {
  /** Cache failed configurations (default true). Without it the search is the plain Wing and Gong search. */
  memo?: boolean;
  /** Record each step for animation. */
  trace?: boolean;
  /** Give up after this many configurations (default 2e6). */
  maxStates?: number;
}

class Bits {
  w: Uint32Array;
  constructor(n: number) {
    this.w = new Uint32Array((n + 31) >>> 5);
  }
  set(i: number) { this.w[i >>> 5]! |= 1 << (i & 31); }
  clear(i: number) { this.w[i >>> 5]! &= ~(1 << (i & 31)); }
  has(i: number) { return (this.w[i >>> 5]! & (1 << (i & 31))) !== 0; }
  key() { return this.w.join("."); }
}

/** Checks one history (all keys together) against a model. */
export function checkLinearizable<S>(history: HOp[], model: Model<S>, opts: CheckOpts = {}): LinResult {
  const memo = opts.memo ?? true;
  const maxStates = opts.maxStates ?? 2e6;
  const ops = relevant(history).sort((a, b) => a.call - b.call || a.id - b.id);
  const n = ops.length;
  const trace: SearchEvent[] | undefined = opts.trace ? [] : undefined;
  const placed = new Bits(n);
  const cache = new Set<string>();
  const order: number[] = [];
  let remaining = ops.filter((o) => !isPending(o)).length;
  let explored = 0, cacheHits = 0, aborted = false;
  let best: number[] = [], blocked: number[] = [];

  const dfs = (state: S): boolean => {
    if (remaining === 0) return true;
    if (memo) {
      const k = placed.key() + "|" + model.hash(state);
      if (cache.has(k)) {
        cacheHits++;
        trace?.push({ kind: "cached", depth: order.length });
        return false;
      }
      cache.add(k);
    }
    if (++explored > maxStates) { aborted = true; return false; }
    // The real-time rule: a candidate must be invoked no later than the earliest response still open.
    let minRet = Infinity;
    for (let i = 0; i < n; i++) if (!placed.has(i) && ops[i]!.ret < minRet) minRet = ops[i]!.ret;
    const tried: number[] = [];
    for (let i = 0; i < n && !aborted; i++) {
      const op = ops[i]!;
      if (placed.has(i) || op.call > minRet) continue;
      tried.push(op.id);
      const next = model.step(state, op);
      if (next === undefined) { trace?.push({ kind: "reject", op: op.id, depth: order.length }); continue; }
      trace?.push({ kind: "place", op: op.id, depth: order.length });
      placed.set(i); order.push(op.id);
      if (!isPending(op)) remaining--;
      if (dfs(next)) return true;
      placed.clear(i); order.pop();
      if (!isPending(op)) remaining++;
      trace?.push({ kind: "back", op: op.id, depth: order.length });
    }
    if (order.length >= best.length) { best = [...order]; blocked = tried; }
    return false;
  };

  const ok = dfs(model.init());
  trace?.push({ kind: "done", ok });
  return { ok: aborted ? null : ok, order: ok ? [...order] : [], explored, cacheHits, best, blocked, trace };
}

/** A register history: checks each key alone (the default) or all keys as one object. */
export function checkRegister(history: HOp[], opts: CheckOpts & { partition?: boolean } = {}): LinResult & { parts: number } {
  if (opts.partition === false) return { ...checkLinearizable(history, kvModel(), opts), parts: 1 };
  const parts = [...partitionByKey(history).values()];
  let explored = 0, cacheHits = 0;
  const order: number[] = [];
  for (const p of parts) {
    const r = checkLinearizable(p, registerModel(), opts);
    explored += r.explored;
    cacheHits += r.cacheHits;
    if (r.ok !== true) return { ...r, explored, cacheHits, parts: parts.length };
    order.push(...r.order);
  }
  return { ok: true, order, explored, cacheHits, best: order, blocked: [], parts: parts.length };
}

/**
 * The obvious algorithm, for tests: try every order of the completed operations, with every subset of the pending
 * ones, and keep the orders that respect real time and the model. Use it only for about 8 operations or fewer.
 */
export function bruteForceLinearizable<S>(history: HOp[], model: Model<S>): boolean {
  const ops = relevant(history);
  const done = ops.filter((o) => !isPending(o));
  const pend = ops.filter(isPending);
  for (let mask = 0; mask < 1 << pend.length; mask++) {
    const use = [...done, ...pend.filter((_, i) => mask & (1 << i))];
    const perm: HOp[] = [];
    const used = new Array<boolean>(use.length).fill(false);
    const rec = (): boolean => {
      if (perm.length === use.length) {
        for (let i = 0; i < perm.length; i++) for (let j = i + 1; j < perm.length; j++) if (perm[j]!.ret < perm[i]!.call) return false;
        let s: S | undefined = model.init();
        for (const o of perm) if ((s = model.step(s!, o)) === undefined) return false;
        return true;
      }
      for (let i = 0; i < use.length; i++) {
        if (used[i]) continue;
        used[i] = true; perm.push(use[i]!);
        if (rec()) return true;
        used[i] = false; perm.pop();
      }
      return false;
    };
    if (rec()) return true;
  }
  return false;
}

/**
 * A time inside each interval for a given order, so that the points rise along the order: the linearization points
 * to draw. Each point is the middle of the latest feasible start and the earliest feasible end.
 */
export function linearizationPoints(history: HOp[], order: number[], tEnd: number): Map<number, number> {
  const byId = new Map(history.map((o) => [o.id, o]));
  const seq = order.map((id) => byId.get(id)!);
  const lo: number[] = [], hi: number[] = [];
  seq.forEach((o, i) => (lo[i] = Math.max(o.call, i ? lo[i - 1]! : -Infinity)));
  for (let i = seq.length - 1; i >= 0; i--) hi[i] = Math.min(Number.isFinite(seq[i]!.ret) ? seq[i]!.ret : tEnd, i < seq.length - 1 ? hi[i + 1]! : Infinity);
  const out = new Map<number, number>();
  seq.forEach((o, i) => out.set(o.id, (lo[i]! + Math.max(lo[i]!, hi[i]!)) / 2));
  return out;
}

/**
 * A quick sufficient test for a stale read: a read that returned a value which a later write had already replaced
 * before the read began. Each write must have a unique value. Any such read makes the history not linearizable.
 */
export function provablyStaleReads(history: HOp[]): HOp[] {
  const out: HOp[] = [];
  for (const [, ops] of partitionByKey(relevant(history))) {
    const writeOf = new Map<number, HOp>();
    for (const o of ops) if (o.f === "w") writeOf.set(o.value!, o);
    for (const r of ops) {
      if (r.f !== "r") continue;
      const src = writeOf.get(r.value!);
      // A write w2 that began after src returned (so it follows src) and returned before r began.
      const stale = ops.some((w2) => w2.f === "w" && w2 !== src && w2.ret < r.call && (src ? src.ret < w2.call : true));
      if (stale) out.push(r);
    }
  }
  return out;
}
