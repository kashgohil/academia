/**
 * Jepsen-style helpers: a run of the register store with a fault schedule, checked by the linearizability checker,
 * and sweeps of the checker's cost.
 */
import { mulberry32 } from "../../rng";
import { INITIAL, randomHistory, type HOp } from "./history";
import { checkLinearizable, checkRegister, registerModel } from "./linearizability";
import { runStore, type ReadPath, type StoreFault } from "./store";

export type Nemesis = "none" | "isolate" | "crash";

export function nemesisFaults(n: Nemesis, start = 60, end = 160): StoreFault[] {
  if (n === "isolate") return [{ kind: "isolate", node: 2, at: start, until: end }];
  if (n === "crash") return [{ kind: "crash", node: 1, at: start, until: end }];
  return [];
}

/** A short run that the demo can draw and animate: 3 clients, about 20 operations. */
export function miniJepsen(seed: number, readPath: ReadPath, nemesis: Nemesis) {
  const run = runStore({ seed, readPath, duration: 200, think: 15, heartbeat: 50, faults: nemesisFaults(nemesis) });
  const result = checkLinearizable(run.history, registerModel(), { trace: true });
  return { run, result };
}

/**
 * A history that is linearizable except for its last operation: a read, after all other operations, that returns the
 * initial value although writes returned before it. The checker must rule out every order of the earlier operations,
 * which is its worst case.
 */
export function hardHistory(seed: number, clients: number, opsPerClient: number, keys = 1): HOp[] {
  const h = randomHistory(mulberry32(seed), { clients, ops: opsPerClient, keys, readFrac: 0.5, len: 10, gap: 1 });
  const end = Math.max(...h.map((o) => o.ret));
  // Make sure some write returned, so that reading the initial value is wrong.
  if (!h.some((o) => o.f === "w")) h[0] = { ...h[0]!, f: "w", value: 999 };
  const key = h.find((o) => o.f === "w")!.key;
  return [...h, { id: h.length, client: clients, key, f: "r", value: INITIAL, call: end + 1, ret: end + 2 }];
}

export interface CostPoint { ops: number; clients: number; memo: number; plain: number | null; partitioned: number }

/** One hard history: configurations explored with the cache, without it (null: over budget), and split by key. */
export function checkerCostOne(seed: number, clients: number, opsPerClient: number, keys = 4, budget = 2e5): CostPoint {
  const h1 = hardHistory(seed, clients, opsPerClient, 1);
  const memo = checkLinearizable(h1, registerModel()).explored;
  const p = checkLinearizable(h1, registerModel(), { memo: false, maxStates: budget });
  // The same shape spread over several keys, checked key by key.
  const partitioned = checkRegister(hardHistory(seed, clients, opsPerClient, keys)).explored;
  return { ops: h1.length, clients, memo, plain: p.ok === null ? null : p.explored, partitioned };
}

/** The mean cost over seeds 1..seeds. plain is null if any seed went over budget. */
export function checkerCost(clients: number, opsPerClient: number, seeds: number, keys = 4, budget = 2e5): CostPoint {
  const xs = Array.from({ length: seeds }, (_, s) => checkerCostOne(s + 1, clients, opsPerClient, keys, budget));
  const mean = (f: (x: CostPoint) => number) => xs.reduce((a, x) => a + f(x), 0) / seeds;
  return { ops: xs[0]!.ops, clients, memo: mean((x) => x.memo), plain: xs.some((x) => x.plain === null) ? null : mean((x) => x.plain!), partitioned: mean((x) => x.partitioned) };
}
