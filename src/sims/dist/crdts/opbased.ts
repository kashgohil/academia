/**
 * Operation-based CRDTs on the causal broadcast layer (causal.ts).
 *
 * An op-based replica sends each update as an operation, not its whole state. Shapiro et al. (2011) require that
 * every op reaches every replica exactly once, in an order consistent with causality, and that concurrent ops
 * commute. This file shows what breaks when the delivery layer gives less:
 *
 * - The op-based counter: inc and dec commute in any order, so reordering is harmless. A duplicate counts twice,
 *   so the counter needs exactly-once delivery (or op ids to drop duplicates).
 * - The op-based OR-Set: add(e) makes a unique tag; remove(e) carries the tags that its origin has seen. If a
 *   remove arrives before the add that it removes, it removes nothing, and the add then stays forever. So the set
 *   needs causal delivery.
 */
import { CausalNet, type CbConfig } from "./causal";

// ---------------------------------------------------------------- the op-based OR-Set (one replica's state)

export type Tag = string;
/** e -> the tags of its adds that are not removed. e is in the set if it has a tag. */
export type OrState = Map<string, Set<Tag>>;
export type SetOp = { k: "add"; e: string; tag: Tag } | { k: "rmv"; e: string; tags: Tag[] };
export type CounterOp = { k: "inc"; d: number };
export type AnyOp = CounterOp | SetOp;

/** A tag or op id as the lesson writes it: replica number (from 1), then its sequence number. */
export const tagOf = (m: { origin: number; seq: number }) => `${m.origin + 1}.${m.seq}`;

export function orApply(s: OrState, op: SetOp) {
  if (op.k === "add") {
    if (!s.has(op.e)) s.set(op.e, new Set());
    s.get(op.e)!.add(op.tag);
  } else {
    const t = s.get(op.e);
    if (!t) return;
    for (const x of op.tags) t.delete(x);
    if (!t.size) s.delete(op.e);
  }
}
export const orElements = (s: OrState) => [...s.keys()].sort();
export const orTags = (s: OrState, e: string) => [...(s.get(e) ?? [])].sort();

/** The op that replica i sends to remove e: every tag of e that i has seen. The tag of an add is set on broadcast. */
export const removeOp = (s: OrState, e: string): SetOp => ({ k: "rmv", e, tags: orTags(s, e) });

// ---------------------------------------------------------------- random runs

export type OpObject = "counter" | "set";

export interface OpRunConfig {
  seed: number;
  object: OpObject;
  n: number;
  /** Updates (counter) or items (set). */
  ops: number;
  /** Updates happen at random times in [0, window] ms. */
  window: number;
  dupRate: number;
  dropRate: number;
  causal: boolean;
  dedupe: boolean;
  latency: { min: number; max: number };
}

export const DEFAULT_OPRUN: OpRunConfig = { seed: 1, object: "counter", n: 3, ops: 12, window: 200, dupRate: 0, dropRate: 0, causal: false, dedupe: true, latency: { min: 5, max: 80 } };

export interface OpRun {
  cfg: OpRunConfig;
  cb: CausalNet<AnyOp>;
  /** Per replica: the counter value, or the elements of the set. */
  values: (number | string[])[];
  /** What every replica should show once all ops are delivered. */
  expected: number | string[];
  /** Replicas whose final value differs from the expected one. */
  wrong: number[];
  /** Every update: replica, time, text. */
  updates: { r: number; t: number; text: string }[];
}

const same = (a: number | string[], b: number | string[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A random run on n replicas.
 * counter: `ops` updates of +1 or −1 at random replicas and times; expected = their sum.
 * set: for each of `ops` items, replica 0 adds it at a random time. Replica 1 removes each item 1 ms after the add
 *      reaches it (a cleaner that reacts to what it sees). Expected: every item is removed, so every set is empty.
 */
export function runOpBased(partial: Partial<OpRunConfig> = {}): OpRun {
  const cfg = { ...DEFAULT_OPRUN, ...partial };
  const N = cfg.n;
  const counters = new Array<number>(N).fill(0);
  const sets: OrState[] = Array.from({ length: N }, () => new Map());
  const updates: OpRun["updates"] = [];
  const cbCfg: Partial<CbConfig> = { causal: cfg.causal, dedupe: cfg.dedupe };
  const cb = new CausalNet<AnyOp>(N, { seed: cfg.seed, latency: cfg.latency, dupRate: cfg.dupRate, dropRate: cfg.dropRate }, cbCfg, (i, op, meta) => {
    if (op.k === "inc") counters[i]! += op.d;
    else {
      // The tag of an add is its op id, known only once the layer has numbered it.
      orApply(sets[i]!, op.k === "add" ? { ...op, tag: tagOf(meta) } : op);
      if (op.k === "add" && i === 1 && !meta.local) cb.net.setTimer(1, 1, `rm:${op.e}`);
    }
  });
  cb.onTimer = (i, tag) => {
    if (tag.startsWith("rm:")) {
      const e = tag.slice(3);
      updates.push({ r: i, t: cb.net.now, text: `−${e}` });
      cb.broadcast(i, removeOp(sets[i]!, e));
    } else if (tag.startsWith("op:")) {
      const [, r, what] = tag.split(":");
      const ri = Number(r);
      if (cfg.object === "counter") {
        const d = Number(what);
        updates.push({ r: ri, t: cb.net.now, text: d > 0 ? "+1" : "−1" });
        cb.broadcast(ri, { k: "inc", d });
      } else {
        updates.push({ r: ri, t: cb.net.now, text: `+${what}` });
        cb.broadcast(ri, { k: "add", e: what!, tag: "" });
      }
    }
  };
  // Schedule the workload with the network's own generator, so that one seed is one run.
  const items = "abcdefghijklmnopqrstuvwxyz";
  for (let k = 0; k < cfg.ops; k++) {
    const t = cb.net.random() * cfg.window;
    if (cfg.object === "counter") {
      const r = Math.floor(cb.net.random() * N);
      const d = cb.net.random() < 0.7 ? 1 : -1;
      cb.net.setTimer(r, t, `op:${r}:${d}`);
    } else cb.net.setTimer(0, t, `op:0:${items[k % items.length]}`);
  }
  cb.net.runAll();
  const values: (number | string[])[] = cfg.object === "counter" ? [...counters] : sets.map(orElements);
  let sum = 0;
  for (const u of updates) if (u.text === "+1") sum++; else if (u.text === "−1") sum--;
  const expected: number | string[] = cfg.object === "counter" ? sum : [];
  return { cfg, cb, values, expected, wrong: values.flatMap((v, i) => (same(v, expected) ? [] : [i])), updates };
}

/** Over many seeds: the share of runs in which some replica ends with a wrong value. */
export function brokenShare(partial: Partial<OpRunConfig>, runs = 200, seed0 = 1): number {
  let bad = 0;
  for (let s = 0; s < runs; s++) if (runOpBased({ ...partial, seed: seed0 + s }).wrong.length) bad++;
  return bad / runs;
}

// ---------------------------------------------------------------- the stepper: the learner is the network

export type StepAction =
  | { k: "add"; r: number; e: string }
  | { k: "rmv"; r: number; e: string }
  | { k: "deliver"; id: number }
  | { k: "drop"; id: number };

export interface StepState {
  cb: CausalNet<SetOp>;
  sets: OrState[];
  /** A sentence per action. */
  log: string[];
}

export const STEP_NAMES = ["R1", "R2", "R3"];

/**
 * Replays the learner's actions on 3 replicas in hold mode: every op waits in net.held() until the learner
 * delivers or drops it. With `causal`, an op that arrives too early waits in the replica's buffer.
 */
export function replaySteps(actions: StepAction[], causal: boolean): StepState {
  const sets: OrState[] = [new Map(), new Map(), new Map()];
  const log: string[] = [];
  const cb = new CausalNet<SetOp>(3, { seed: 1, latency: { min: 10, max: 10 } }, { causal, dedupe: true }, (i, op, meta) => {
    const real: SetOp = op.k === "add" ? { ...op, tag: tagOf(meta) } : op;
    const before = orElements(sets[i]!).includes(op.e);
    orApply(sets[i]!, real);
    if (!meta.local) {
      const after = orElements(sets[i]!).includes(op.e);
      const what = op.k === "add" ? `add(${op.e}) with tag ${tagOf(meta)}` : `remove(${op.e}) of tags [${op.tags.join(", ")}]`;
      log.push(`${STEP_NAMES[i]} applies ${what} from ${STEP_NAMES[meta.origin]}: ${op.e} is ${after ? "in" : "not in"} its set${before === after ? " (no change)" : ""}.`);
    }
  });
  cb.net.hold = true;
  for (const a of actions) {
    if (a.k === "add") {
      const m = cb.broadcast(a.r, { k: "add", e: a.e, tag: "" });
      log.push(`${STEP_NAMES[a.r]} adds ${a.e} with the unique tag ${tagOf(m)}, and sends the op to both others.`);
    } else if (a.k === "rmv") {
      const op = removeOp(sets[a.r]!, a.e) as Extract<SetOp, { k: "rmv" }>;
      cb.broadcast(a.r, op);
      log.push(op.tags.length
        ? `${STEP_NAMES[a.r]} removes ${a.e}: it sends the tags that it has seen, [${op.tags.join(", ")}].`
        : `${STEP_NAMES[a.r]} removes ${a.e}, but it has seen no add of ${a.e}, so the op removes nothing.`);
    } else if (a.k === "deliver") {
      const m = cb.net.held().find((x) => x.id === a.id);
      const n0 = log.length;
      cb.net.deliverHeld(a.id);
      if (m && m.payload.k === "op" && log.length === n0) {
        const b = cb.buffer[m.to]!.find((x) => x.msgId === m.id);
        if (b) {
          const miss = cb.missing(m.to, b).map((x) => (x.from === x.to ? `op ${x.origin + 1}.${x.from}` : `ops ${x.origin + 1}.${x.from} to ${x.origin + 1}.${x.to}`));
          log.push(`${STEP_NAMES[m.to]} buffers op ${tagOf(m.payload)}: it first needs ${miss.join(" and ")}.`);
        }
      }
    } else {
      const m = cb.net.held().find((x) => x.id === a.id);
      cb.net.dropHeld(a.id);
      if (m && m.payload.k === "op") log.push(`The network loses op ${tagOf(m.payload)} to ${STEP_NAMES[m.to]}. Without a resend, ${STEP_NAMES[m.to]} never sees it.`);
    }
  }
  return { cb, sets, log };
}

/** The preset: R1 adds x, R2 sees the add and removes x, and R2's remove reaches R3 first. */
export function presetSteps(): StepAction[] {
  // Message ids are deterministic: R1's add goes out as 1 (to R2) and 2 (to R3); R2's remove as 3 (to R1) and 4 (to R3).
  return [{ k: "add", r: 0, e: "x" }, { k: "deliver", id: 1 }, { k: "rmv", r: 1, e: "x" }, { k: "deliver", id: 4 }];
}
