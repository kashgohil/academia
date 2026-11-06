/**
 * Checkers for weaker models than linearizability, on small multi-register histories with unique write values.
 *
 * - Sequential consistency (Lamport 1979): one total order of all operations that keeps the order of each process
 *   and that a single register would give. Real time does not count.
 * - Causal consistency (causal memory, Ahamad et al. 1995): the causal order is program order plus "read returns the
 *   value of that write", closed under transitivity. Each process must see some legal order of all writes and its
 *   own reads that keeps the causal order. Different processes may see concurrent writes in different orders.
 * - Eventual consistency: a liveness promise. A finite history can break it only by reading a value that nobody
 *   wrote.
 */
import { INITIAL, byClient, isPending, relevant, type HOp } from "./history";
import { checkRegister, kvModel } from "./linearizability";

export type ModelName = "linearizable" | "sequential" | "causal" | "eventual";
export const MODEL_NAMES: ModelName[] = ["linearizable", "sequential", "causal", "eventual"];

export interface Verdict {
  ok: boolean;
  /** A witness order (ids) when ok, where the model has one total order. */
  order?: number[];
  /** Why not, in one sentence. */
  why?: string;
}

/** Sequential consistency: a search over the next operation of each process. */
export function checkSequential(history: HOp[]): Verdict {
  const ops = relevant(history);
  const lanes = [...byClient(ops).values()];
  const model = kvModel();
  const idx = lanes.map(() => 0);
  const cache = new Set<string>();
  const order: number[] = [];
  // Done when every completed operation is placed; a pending write may stay out (it is last in its lane).
  const finished = () => lanes.every((l, i) => idx[i] === l.length || (idx[i] === l.length - 1 && isPending(l[idx[i]!]!)));
  const dfs = (s: Record<string, number>): boolean => {
    if (finished()) return true;
    const k = idx.join(",") + "|" + model.hash(s);
    if (cache.has(k)) return false;
    cache.add(k);
    for (let c = 0; c < lanes.length; c++) {
      const op = lanes[c]![idx[c]!];
      if (!op) continue;
      const next = model.step(s, op);
      if (next === undefined) continue;
      idx[c]!++; order.push(op.id);
      if (dfs(next)) return true;
      idx[c]!--; order.pop();
    }
    return false;
  };
  if (dfs(model.init())) return { ok: true, order: [...order] };
  return { ok: false, why: "No single order of all operations keeps each process in program order and gives these reads." };
}

/** The causal order as a reachability matrix, or a reason why the history has no causal order. */
export function causalOrder(history: HOp[]): { ops: HOp[]; before: boolean[][] } | { why: string } {
  const ops = relevant(history);
  const n = ops.length;
  const index = new Map(ops.map((o, i) => [o.id, i]));
  const before = ops.map(() => new Array<boolean>(n).fill(false));
  for (const lane of byClient(ops).values()) for (let i = 0; i + 1 < lane.length; i++) before[index.get(lane[i]!.id)!]![index.get(lane[i + 1]!.id)!] = true;
  const writer = new Map<string, HOp>();
  for (const o of ops) if (o.f === "w") writer.set(`${o.key}=${o.value}`, o);
  for (const r of ops) {
    if (r.f !== "r" || r.value === INITIAL) continue;
    const w = writer.get(`${r.key}=${r.value}`);
    if (!w) return { why: `${r.key} = ${r.value} was never written.` };
    before[index.get(w.id)!]![index.get(r.id)!] = true;
  }
  // Transitive closure (Warshall).
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) if (before[i]![k]) for (let j = 0; j < n; j++) if (before[k]![j]) before[i]![j] = true;
  for (let i = 0; i < n; i++) if (before[i]![i]) return { why: "The causal order has a cycle: an operation would have to happen before itself." };
  return { ops, before };
}

/** Causal consistency: each process needs its own legal view that keeps the causal order. */
export function checkCausal(history: HOp[]): Verdict {
  const co = causalOrder(history);
  if ("why" in co) return { ok: false, why: co.why };
  const { ops, before } = co;
  const model = kvModel();
  for (const [client] of byClient(ops)) {
    const mine = ops.map((o, i) => (o.f !== "r" || o.client === client ? i : -1)).filter((i) => i >= 0);
    const placed = new Set<number>();
    const cache = new Set<string>();
    const dfs = (s: Record<string, number>): boolean => {
      if (placed.size === mine.length) return true;
      const k = [...placed].sort((a, b) => a - b).join(",") + "|" + model.hash(s);
      if (cache.has(k)) return false;
      cache.add(k);
      for (const i of mine) {
        if (placed.has(i) || mine.some((j) => !placed.has(j) && j !== i && before[j]![i])) continue;
        const next = model.step(s, ops[i]!);
        if (next === undefined) continue;
        placed.add(i);
        if (dfs(next)) return true;
        placed.delete(i);
      }
      return false;
    };
    if (!dfs(model.init())) return { ok: false, why: `Process ${client} has no view of the writes that keeps the causal order and explains its reads.` };
  }
  return { ok: true };
}

/** Eventual consistency, for a finite history: only values that someone wrote (or the initial value) may be read. */
export function checkEventual(history: HOp[]): Verdict {
  const written = new Set(relevant(history).filter((o) => o.f === "w").map((o) => `${o.key}=${o.value}`));
  const bad = relevant(history).find((o) => o.f === "r" && o.value !== INITIAL && !written.has(`${o.key}=${o.value}`));
  return bad ? { ok: false, why: `${bad.key} = ${bad.value} was never written.` } : { ok: true };
}

export function checkModel(m: ModelName, h: HOp[]): Verdict {
  if (m === "linearizable") {
    const r = checkRegister(h);
    return r.ok ? { ok: true, order: r.order } : { ok: false, why: "No order that respects real time gives these reads." };
  }
  return m === "sequential" ? checkSequential(h) : m === "causal" ? checkCausal(h) : checkEventual(h);
}
