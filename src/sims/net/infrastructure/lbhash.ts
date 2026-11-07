/**
 * What happens to open connections when the set of backends or the set of balancers changes.
 *
 * The model has no links or queues, so it does not use PacketNet. Routers spread flows over L balancers with ECMP.
 * Each balancer maps a flow to one of N backends. A flow is a pair of 32-bit hashes of its 5-tuple (one for ECMP,
 * one for the balancer), drawn from a seed.
 *
 * - ECMP "threshold" is hash-threshold (RFC 2992): the hash space is cut into L equal ranges, one per next hop.
 *   ECMP "resilient" keeps a table of buckets and moves only the buckets that must move (Linux resilient next-hop
 *   groups work this way).
 * - Backend lookup: "modulo" (hash mod N), "maglev" (the Maglev table from the partitioning module, 65,537 slots),
 *   or "random" (a random pick at the first packet, which only works with connection tracking).
 * - Connection tracking: each balancer remembers flow → backend for the flows it has seen. A flow that ECMP moves
 *   to another balancer arrives where nobody remembers it.
 *
 * After one change, each existing connection either keeps its backend, lands on a backend that has no socket for
 * it (the backend answers with RST: the connection breaks), or was on a backend that crashed.
 */
import { mulberry32 } from "../../rng";
import { maglevTable } from "../../dist/partitioning/hashing";

export type Lookup = "modulo" | "maglev" | "random";
export type EcmpKind = "threshold" | "resilient";
export type LbChange = "addBackend" | "crashBackend" | "drainBackend" | "addLb" | "removeLb" | "addBoth";

export const LOOKUPS: Lookup[] = ["modulo", "maglev", "random"];
export const LB_CHANGES: LbChange[] = ["addBackend", "crashBackend", "drainBackend", "addLb", "removeLb", "addBoth"];

export const LB_CHANGE_LABEL: Record<LbChange, string> = {
  addBackend: "add a backend",
  crashBackend: "a backend crashes",
  drainBackend: "drain a backend",
  addLb: "add a balancer",
  removeLb: "remove a balancer",
  addBoth: "add a balancer and a backend",
};

/** The Maglev paper's example table size, a prime. */
export const MAGLEV_M = 65537;

/** Buckets of a resilient ECMP group (a model input). */
export const RESILIENT_BUCKETS = 256;

export interface ChangeOpts {
  flows?: number;
  backends?: number;
  lbs?: number;
  lookup: Lookup;
  conntrack: boolean;
  ecmp?: EcmpKind;
  change: LbChange;
  seed?: number;
}

export type Fate = "kept" | "broken" | "dead";

export interface FlowFate {
  lbBefore: number;
  lbAfter: number;
  before: number;
  after: number;
  fate: Fate;
}

export interface ChangeResult {
  flows: FlowFate[];
  kept: number;
  broken: number;
  dead: number;
  /** Flows that ECMP sent to another balancer. */
  movedLb: number;
  /** The backend that the change removes or drains, if any. */
  victim?: number;
}

/** Hash-threshold (RFC 2992): the range of the 32-bit hash space that the hash falls in. */
export const thresholdPick = (h: number, n: number) => Math.min(n - 1, Math.floor((h / 4294967296) * n));

/** A resilient bucket table for `n` next hops: bucket → next hop. */
export function resilientTable(n: number, buckets = RESILIENT_BUCKETS): Int32Array {
  const t = new Int32Array(buckets);
  for (let i = 0; i < buckets; i++) t[i] = i % n;
  return t;
}

/** Next hop `gone` leaves: only its buckets move, spread over the others in turn. */
export function resilientRemove(t: Int32Array, gone: number): Int32Array {
  const out = Int32Array.from(t);
  const alive = [...new Set(t)].filter((x) => x !== gone).sort((a, b) => a - b);
  let k = 0;
  for (let i = 0; i < out.length; i++) if (out[i] === gone) out[i] = alive[k++ % alive.length]!;
  return out;
}

/** A new next hop joins: it takes buckets from the fullest next hops until it has its fair share. */
export function resilientAdd(t: Int32Array, added: number): Int32Array {
  const out = Int32Array.from(t);
  const n = new Set(t).size + 1;
  const share = Math.floor(out.length / n);
  for (let k = 0; k < share; k++) {
    const count = new Map<number, number>();
    for (const x of out) count.set(x, (count.get(x) ?? 0) + 1);
    let top = -1, topN = -1;
    for (const [x, c] of count) if (x !== added && (c > topN || (c === topN && x < top))) { top = x; topN = c; }
    const i = out.lastIndexOf(top);
    out[i] = added;
  }
  return out;
}

const names = (ids: number[]) => ids.map((i) => `backend-${i}`);

/** Maglev tables are pure functions of the backend names, so they are built once per set. */
const tables = new Map<string, Int32Array>();
function maglevFor(ids: number[]): Int32Array {
  const k = ids.join(",");
  let t = tables.get(k);
  if (!t) {
    t = maglevTable(names(ids), MAGLEV_M);
    if (tables.size > 64) tables.clear();
    tables.set(k, t);
  }
  return t;
}

export function changeRun(o: ChangeOpts): ChangeResult {
  const F = o.flows ?? 1000, N = o.backends ?? 10, L = o.lbs ?? 4;
  const ecmp = o.ecmp ?? "threshold";
  const rng = mulberry32(o.seed ?? 7);
  const hashes = Array.from({ length: F }, () => [Math.floor(rng() * 4294967296), Math.floor(rng() * 4294967296)] as const);

  // Backend sets before and after (backend ids, in order). The victim of a crash or drain is backend 3.
  const victim = o.change === "crashBackend" || o.change === "drainBackend" ? Math.min(3, N - 1) : undefined;
  const before = Array.from({ length: N }, (_, i) => i);
  const after = o.change === "addBackend" || o.change === "addBoth" ? [...before, N] : victim !== undefined ? before.filter((b) => b !== victim) : before;
  const lbsAfter = o.change === "addLb" || o.change === "addBoth" ? L + 1 : o.change === "removeLb" ? L - 1 : L;
  const removedLb = o.change === "removeLb" ? 1 : -1;

  const tBefore = o.lookup === "maglev" ? maglevFor(before) : undefined;
  const tAfter = o.lookup === "maglev" ? maglevFor(after) : undefined;
  const pick = (h: number, set: number[], table?: Int32Array): number => {
    if (o.lookup === "modulo") return set[h % set.length]!;
    if (o.lookup === "maglev") return set[table![h % MAGLEV_M]!]!;
    return set[Math.floor(rng() * set.length)]!;
  };

  // ECMP before and after. Balancer ids stay stable; a removed balancer is id 1, an added one is id L.
  let ecmpBefore: (h: number) => number, ecmpAfter: (h: number) => number;
  if (ecmp === "threshold") {
    ecmpBefore = (h) => thresholdPick(h, L);
    const ids = Array.from({ length: L }, (_, i) => i).filter((i) => i !== removedLb);
    if (lbsAfter > L) ids.push(L);
    ecmpAfter = (h) => ids[thresholdPick(h, ids.length)]!;
  } else {
    const t0 = resilientTable(L);
    const t1 = lbsAfter > L ? resilientAdd(t0, L) : removedLb >= 0 ? resilientRemove(t0, removedLb) : t0;
    ecmpBefore = (h) => t0[h % t0.length]!;
    ecmpAfter = (h) => t1[h % t1.length]!;
  }

  const flows: FlowFate[] = [];
  let kept = 0, broken = 0, dead = 0, movedLb = 0;
  for (const [h1, h2] of hashes) {
    const lbBefore = ecmpBefore(h1), lbAfter = ecmpAfter(h1);
    const b0 = pick(h2, before, tBefore);
    let b1: number;
    const remembered = o.conntrack && lbAfter === lbBefore;
    if (remembered && b0 !== victim) b1 = b0;
    else if (remembered && o.change === "drainBackend") b1 = b0; // draining: old connections stay
    else if (!o.conntrack && o.lookup === "random") b1 = pick(h2, after, tAfter); // every packet picks again
    else b1 = pick(h2, after, tAfter);
    if (lbAfter !== lbBefore) movedLb++;
    const fate: Fate = b0 === victim && o.change === "crashBackend" ? "dead" : b1 === b0 ? "kept" : "broken";
    if (fate === "kept") kept++;
    else if (fate === "broken") broken++;
    else dead++;
    flows.push({ lbBefore, lbAfter, before: b0, after: b1, fate });
  }
  return { flows, kept, broken, dead, movedLb, victim };
}

/** Broken connections for every lookup, with and without connection tracking. Random without tracking is not a
 *  working balancer (each packet picks a backend), so it is left out. */
export function changeMatrix(o: Omit<ChangeOpts, "lookup" | "conntrack">) {
  return LOOKUPS.flatMap((lookup) => [false, true].filter((ct) => ct || lookup !== "random").map((conntrack) => ({ lookup, conntrack, r: changeRun({ ...o, lookup, conntrack }) })));
}

/** The share of connections still open after a drain timeout, when lifetimes are exponential with this mean. */
export const openAfterDrain = (timeoutS: number, meanLifeS: number) => Math.exp(-timeoutS / meanLifeS);
