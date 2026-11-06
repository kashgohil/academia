/**
 * Histories of operations on replicated registers.
 *
 * A history is a list of operations. Each operation has an invocation time (`call`) and a response time (`ret`).
 * An operation whose response never arrived is "pending": `ret` is Infinity, and the checkers allow it to take
 * effect at any time after its call, or never. A read that never returned tells nothing, so the checkers ignore it.
 *
 * Registers start at 0 (INITIAL). Writes in generated histories write unique values, so that a read value names
 * the write that it came from. The causal checker needs this.
 */
import type { Rng } from "../../rng";

export const INITIAL = 0;

export type OpKind = "r" | "w" | "cas";

export interface HOp {
  /** A unique id. Checkers report operations by this id. */
  id: number;
  /** The process (client session) that issued it. Operations of one process do not overlap in time. */
  client: number;
  /** The register. Default "x". */
  key: string;
  f: OpKind;
  /** w: the value written. r: the value read (undefined: the read did not return). cas: the new value. */
  value?: number;
  /** cas only: the expected old value, and whether the cas succeeded (undefined: unknown). */
  expect?: number;
  ok?: boolean;
  call: number;
  /** Infinity: no response (pending). */
  ret: number;
}

export const isPending = (o: HOp) => !Number.isFinite(o.ret);

/** a must take effect before b, because a returned before b was invoked. */
export const precedes = (a: HOp, b: HOp) => a.ret < b.call;

/** Short text for an operation, e.g. "w(x,1)", "r(x)=1", "r(x)=?". */
export function opLabel(o: HOp, withKey = true): string {
  const k = withKey ? o.key : "";
  if (o.f === "w") return `w(${k}${withKey ? "," : ""}${o.value})`;
  if (o.f === "r") return `r(${k})=${o.value === undefined ? "?" : o.value}`;
  return `cas(${k}${withKey ? "," : ""}${o.expect}→${o.value})${o.ok === undefined ? "" : o.ok ? " ok" : " fail"}`;
}

/** Drops reads that never returned: they constrain nothing. */
export const relevant = (h: HOp[]) => h.filter((o) => !(o.f === "r" && (o.value === undefined || isPending(o))));

/** Operations grouped by process, each in call order. */
export function byClient(h: HOp[]): Map<number, HOp[]> {
  const m = new Map<number, HOp[]>();
  for (const o of [...h].sort((a, b) => a.call - b.call)) {
    if (!m.has(o.client)) m.set(o.client, []);
    m.get(o.client)!.push(o);
  }
  return m;
}

/** Number of operations that are open at the same instant, at most. */
export function maxConcurrency(h: HOp[]): number {
  const ev: [number, number][] = [];
  for (const o of h) ev.push([o.call, 1], [Number.isFinite(o.ret) ? o.ret : Number.MAX_VALUE, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, best = 0;
  for (const [, d] of ev) best = Math.max(best, (cur += d));
  return best;
}

/** Splits a history by key. Linearizability is local (Herlihy and Wing), so each part can be checked alone. */
export function partitionByKey(h: HOp[]): Map<string, HOp[]> {
  const m = new Map<string, HOp[]>();
  for (const o of h) {
    if (!m.has(o.key)) m.set(o.key, []);
    m.get(o.key)!.push(o);
  }
  return m;
}

/** A compact way to write a history by hand: [client, "w"|"r", key, value, call, ret]. */
export type OpSpec = [client: number, f: "w" | "r", key: string, value: number | undefined, call: number, ret: number];
export const mk = (specs: OpSpec[]): HOp[] => specs.map(([client, f, key, value, call, ret], id) => ({ id, client, f, key, value, call, ret }));

export interface RandomHistoryOpts {
  clients: number;
  /** Operations per client. */
  ops: number;
  keys?: number;
  /** Probability that an operation is a read. */
  readFrac?: number;
  /** Probability that a read returns a random older value instead of the true one. 0 gives a linearizable history. */
  corrupt?: number;
  /** Probability that a write never returns (it may still have taken effect). */
  pendingFrac?: number;
  /** Typical operation length and gap, in time units. */
  len?: number;
  gap?: number;
}

/**
 * A random history from a real atomic register: each operation takes effect at a random point inside its interval,
 * so the history is linearizable unless `corrupt` changes some reads. Write values are unique and never 0.
 */
export function randomHistory(rng: Rng, o: RandomHistoryOpts): HOp[] {
  const { clients, ops, keys = 1, readFrac = 0.5, corrupt = 0, pendingFrac = 0, len = 10, gap = 4 } = o;
  type Draft = HOp & { at: number };
  const drafts: Draft[] = [];
  let id = 0;
  for (let c = 0; c < clients; c++) {
    let t = rng() * gap;
    for (let i = 0; i < ops; i++) {
      const call = t;
      const ret = call + 1 + rng() * len;
      const key = String.fromCharCode(120 + Math.floor(rng() * keys)); // x, y, z, ...
      const f: OpKind = rng() < readFrac ? "r" : "w";
      drafts.push({ id: id++, client: c, key, f, call, ret, at: call + rng() * (ret - call) });
      t = ret + rng() * gap;
    }
  }
  let next = 1;
  for (const d of drafts) if (d.f === "w") d.value = next++;
  // A pending write is the last operation of its client.
  const pendingWrites = new Set<number>();
  for (let c = 0; c < clients; c++) {
    const last = drafts.filter((d) => d.client === c).at(-1);
    if (last && last.f === "w" && rng() < pendingFrac) pendingWrites.add(last.id);
  }
  // Apply in linearization-point order. A pending write takes effect or not, at random.
  const reg = new Map<string, number>();
  const seen = new Map<string, number[]>();
  for (const d of [...drafts].sort((a, b) => a.at - b.at)) {
    const cur = reg.get(d.key) ?? INITIAL;
    if (d.f === "w") {
      if (pendingWrites.has(d.id) && rng() < 0.5) continue;
      reg.set(d.key, d.value!);
      seen.set(d.key, [...(seen.get(d.key) ?? [INITIAL]), d.value!]);
    } else {
      d.value = cur;
      const old = seen.get(d.key) ?? [INITIAL];
      if (corrupt > 0 && rng() < corrupt && old.length > 1) d.value = old[Math.floor(rng() * (old.length - 1))]!;
    }
  }
  return drafts.map(({ at: _at, ...op }) => (pendingWrites.has(op.id) ? { ...op, ret: Infinity } : op));
}
