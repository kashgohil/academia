/**
 * Extra simulations for the lock-free lessons (pure TS, no React).
 *
 * - casRace: many threads push onto one Treiber stack; counts CAS attempts.
 * - abaOrder: where T0's CAS lands among T1's four operations, with tags and two allocators.
 * - hpBound / hpSim: what a hazard-pointer scan keeps and frees.
 * - ebrSim: global epoch, per-thread epochs and three limbo lists, with an optional stalled thread.
 * - msqFrames / msqLagRun: the Michael-Scott queue's lagging tail and helping.
 *
 * casRace, abaOrder and the queue functions drive the shared step machine in ./lockfree.
 */
import { mulberry32 } from "./rng";
import { nodeName, type Ptr, type World } from "./lockfree/machine";
import { makeWorld, type Scenario } from "./lockfree/scenario";

const walk = (w: World, from: Ptr, limit = 24): { p: Ptr; value: number }[] => {
  const out: { p: Ptr; value: number }[] = [];
  const seen = new Set<Ptr>();
  for (let p = from; p && !seen.has(p) && out.length < limit; p = w.nodes[p]!.next.ptr) {
    seen.add(p);
    out.push({ p, value: w.nodes[p]!.value });
  }
  return out;
};

// ---------------------------------------------------------------- CAS race on a stack head

export interface RaceThread { node: Ptr; value: number; seen: Ptr | null; attempts: number; fails: number; done: boolean }
export interface RaceFrame {
  actor: number | null;
  kind: "start" | "alloc" | "load" | "cas-ok" | "cas-fail";
  stack: { p: Ptr; value: number }[];
  threads: RaceThread[];
}
export interface RaceResult { frames: RaceFrame[]; attempts: number; maxFails: number }

/**
 * `n` threads each push one value onto a stack that holds 1, 2.
 * "lockstep" runs the threads round-robin, one atomic step each: the worst case,
 * because every thread loads the same head before any CAS. "random" picks a thread at random.
 */
export function casRace(n: number, policy: "lockstep" | "random", seed = 1): RaceResult {
  const sc: Scenario = { kind: "stack", initial: [1, 2], threads: Array.from({ length: n }, (_, i) => [{ kind: "push", v: 10 * (i + 1) }]) };
  const w = makeWorld(sc, { scheme: "leak", tags: false, threshold: 2, pool: n + 4 });
  const th: RaceThread[] = Array.from({ length: n }, (_, i) => ({ node: 0, value: 10 * (i + 1), seen: null, attempts: 0, fails: 0, done: false }));
  const frames: RaceFrame[] = [];
  const snap = (actor: number | null, kind: RaceFrame["kind"]) =>
    frames.push({ actor, kind, stack: walk(w, w.roots.head!.ptr), threads: th.map((x) => ({ ...x })) });
  snap(null, "start");
  const r = mulberry32(seed);
  let rr = 0;
  while (!w.done()) {
    const ids = w.runnable();
    const t = policy === "lockstep" ? (ids.find((i) => i >= rr) ?? ids[0]!) : ids[Math.floor(r() * ids.length)]!;
    rr = t + 1;
    const me = th[t]!, wt = w.threads[t]!;
    const label = wt.next!;
    const before = w.roots.head!.ptr;
    w.step(t);
    if (label.startsWith("allocate")) { me.node = wt.ptrs.n ?? 0; snap(t, "alloc"); }
    else if (label === "load head") { me.seen = wt.ptrs.h ?? 0; snap(t, "load"); }
    else if (label.startsWith("CAS")) {
      me.attempts++;
      const ok = w.roots.head!.ptr !== before;
      if (ok) me.done = true; else me.fails++;
      snap(t, ok ? "cas-ok" : "cas-fail");
    }
  }
  return { frames, attempts: th.reduce((s, x) => s + x.attempts, 0), maxFails: Math.max(...th.map((x) => x.fails)) };
}

/** Mean number of CAS attempts for `n` pushes over `runs` random schedules. */
export function meanRaceAttempts(n: number, runs = 200, seed = 1): number {
  let s = 0;
  for (let i = 0; i < runs; i++) s += casRace(n, "random", seed * 7919 + i).attempts;
  return s / runs;
}

// ---------------------------------------------------------------- ABA: where does T0's CAS land?

export type Reuse = "lifo" | "fresh";
export interface AbaFrame {
  label: string;
  actor: 0 | 1 | null;
  stack: { p: Ptr; value: number }[];
  head: { ptr: Ptr; tag: number };
  /** Nodes that are freed right now. */
  freed: Ptr[];
  /** The allocator's next three nodes, first one first. */
  freeTop: Ptr[];
}
export interface AbaResult {
  frames: AbaFrame[];
  /** Frame index of T0's first CAS. */
  casFrame: number;
  casOk: boolean;
  /** What T0 saw before it paused. */
  seen: { h: Ptr; next: Ptr; value: number; tag: number };
  t0Result: number | null;
  problems: string[];
  final: number[];
}

export const ABA_T1_OPS = ["pop", "pop", "push 7", "push 8"] as const;

/**
 * The stack holds A(1) → B(2) → C(3). T0 starts a pop and stops just before its CAS.
 * T1 then runs `k` of its four operations (pop, pop, push 7, push 8). Then T0 does its CAS
 * and finishes, and T1 finishes. Nodes are freed at once. "lifo" reuses the most recently
 * freed node first (as real allocators do); "fresh" gives out the oldest free node.
 */
export function abaOrder(k: number, tags: boolean, reuse: Reuse): AbaResult {
  const pop = { kind: "pop" } as const;
  const sc: Scenario = { kind: "stack", initial: [1, 2, 3], threads: [[pop], [pop, pop, { kind: "push", v: 7 }, { kind: "push", v: 8 }]] };
  const w = makeWorld(sc, { scheme: "immediate", tags, threshold: 2, pool: 8 });
  const used = new Set<Ptr>([1, 2, 3]);
  const baseAlloc = w.alloc.bind(w);
  w.alloc = (v: number) => { const p = baseAlloc(v); used.add(p); return p; };
  if (reuse === "fresh") {
    const base = w.free.bind(w);
    w.free = (p: Ptr) => {
      const n = w.freeList.length;
      base(p);
      if (w.freeList.length > n) w.freeList.unshift(w.freeList.pop()!);
    };
  }
  const frames: AbaFrame[] = [];
  const snap = (label: string, actor: 0 | 1 | null) =>
    frames.push({
      label, actor,
      stack: walk(w, w.roots.head!.ptr),
      head: { ...w.roots.head! },
      freed: [...used].filter((p) => w.nodes[p]!.state === "free").sort((a, b) => a - b),
      freeTop: [...w.freeList].reverse().slice(0, 3),
    });
  snap("Start: the stack is A(1) → B(2) → C(3).", null);
  const t0 = w.threads[0]!, t1 = w.threads[1]!;
  let tag = 0;
  while (t0.next && !t0.next.startsWith("CAS")) {
    if (t0.next === "load head") tag = w.roots.head!.tag;
    w.step(0);
  }
  const seen = { h: t0.ptrs.h ?? 0, next: t0.ptrs.next ?? 0, value: w.nodes[t0.ptrs.h ?? 0]!.value, tag };
  snap(`T0 reads head = ${nodeName(seen.h)}, ${nodeName(seen.h)}.next = ${nodeName(seen.next)} and the value ${seen.value}. Then T0 pauses.`, 0);
  for (let i = 0; i < k; i++) {
    const before = w.roots.head!.ptr;
    const op = t1.opIndex;
    while (t1.next && t1.opIndex === op) w.step(1);
    const after = w.roots.head!.ptr;
    snap(
      ABA_T1_OPS[i]!.startsWith("pop")
        ? `T1 pops ${nodeName(before)} and frees it.`
        : `T1 pushes ${w.nodes[after]!.value}. The allocator gives it node ${nodeName(after)}.`,
      1,
    );
  }
  const before = w.roots.head!.ptr;
  const tagBefore = w.roots.head!.tag;
  w.step(0);
  const casOk = w.roots.head!.ptr !== before || w.roots.head!.tag !== tagBefore;
  const want = tags ? `${nodeName(seen.h)}·v${seen.tag}` : nodeName(seen.h);
  const have = tags ? `${nodeName(before)}·v${tagBefore}` : nodeName(before);
  snap(
    casOk
      ? `T0 runs CAS(head, ${want} → ${nodeName(seen.next)}). Head is ${have}, so the CAS succeeds.`
      : `T0 runs CAS(head, ${want} → ${nodeName(seen.next)}). Head is ${have}, so the CAS fails and T0 tries again.`,
    0,
  );
  const casFrame = frames.length - 1;
  while (t0.next) w.step(0);
  while (t1.next) w.step(1);
  w.finalize();
  const t0Result = t0.results[0] ?? null;
  snap(`End: T0 returned ${t0Result ?? "empty"}. T1 returned ${t1.results.slice(0, 2).map((x) => x ?? "empty").join(" and ")}.`, null);
  return {
    frames, casFrame, casOk, seen, t0Result,
    problems: w.violations.map((v) => `${v.kind}: ${v.detail}`),
    final: walk(w, w.roots.head!.ptr).map((x) => x.value),
  };
}

/** Positions of T0's CAS (0..4 of T1's operations) that break the stack. */
export function abaBadPositions(tags: boolean, reuse: Reuse): number[] {
  return [0, 1, 2, 3, 4].filter((k) => abaOrder(k, tags, reuse).problems.length > 0);
}

/** A b-bit version tag returns to the same value after 2^b successful CAS operations. */
export const tagWrap = (bits: number) => 2 ** bits;
/** Does a tag of `bits` bits look unchanged after `changes` successful CAS operations? */
export const tagLooksSame = (bits: number, changes: number) => changes % tagWrap(bits) === 0;

// ---------------------------------------------------------------- hazard pointers

/** Worst-case numbers for one scan: `threads` threads, `slots` hazard slots each, threshold R. */
export function hpBound(threads: number, slots: number, R: number) {
  const hp = threads * slots;
  return {
    /** Slots that a scan reads. */
    readsPerScan: hp,
    /** Most nodes that a scan can keep. */
    keptMax: Math.min(R, hp),
    /** Fewest nodes that a scan frees. */
    freedMin: Math.max(0, R - hp),
    /** Slot reads per freed node in the worst case. */
    readsPerFreed: R > hp ? hp / (R - hp) : Infinity,
    /** Longest that a retired list can get. */
    maxRetired: Math.max(R, hp + 1),
  };
}

export type HpMark = "waiting" | "kept" | "freed";
export interface HpFrame {
  phase: "retire" | "scan" | "free";
  label: string;
  retired: { id: number; mark: HpMark }[];
  /** hazards[t][slot] for t = 1..threads-1 (index 0 is the reclaimer, always empty). */
  hazards: number[][];
  scanning: number | null;
  freedTotal: number;
  slotReads: number;
  scans: number;
  maxRetired: number;
}

/**
 * T0 pops node after node and retires each one. T1..T(threads-1) are readers with two
 * hazard slots each. A reader can only protect a node that is still in the stack (one of
 * the next three to pop). "working" readers move their slots often; "stalled" readers
 * protect two nodes each at the start and then never run again.
 * When T0's retired list reaches R, T0 reads every slot and frees what nobody protects.
 */
export function hpSim(o: { threads: number; R: number; mode: "working" | "stalled"; ticks: number; seed?: number }): HpFrame[] {
  const SLOTS = 2;
  const r = mulberry32(o.seed ?? 1);
  const readers = o.threads - 1;
  const hz: number[][] = Array.from({ length: o.threads }, () => Array<number>(SLOTS).fill(0));
  let nextId = 1; // the node at the top of the stack
  let retired: { id: number; mark: HpMark }[] = [];
  let freedTotal = 0, slotReads = 0, scans = 0, maxRetired = 0;
  const frames: HpFrame[] = [];
  const snap = (phase: HpFrame["phase"], label: string, scanning: number | null) =>
    frames.push({ phase, label, retired: retired.map((x) => ({ ...x })), hazards: hz.map((s) => [...s]), scanning, freedTotal, slotReads, scans, maxRetired });
  if (o.mode === "stalled") for (let t = 1; t <= readers; t++) for (let s = 0; s < SLOTS; s++) hz[t]![s] = 1 + (t - 1) * SLOTS * 2 + s * 2;
  for (let tick = 0; tick < o.ticks; tick++) {
    if (o.mode === "working") {
      for (let t = 1; t <= readers; t++) for (let s = 0; s < SLOTS; s++) {
        const x = r();
        if (x < 0.3) hz[t]![s] = nextId + Math.floor(r() * 3);
        else if (x < 0.45) hz[t]![s] = 0;
      }
    }
    const id = nextId++;
    retired.push({ id, mark: "waiting" });
    maxRetired = Math.max(maxRetired, retired.length);
    snap("retire", `T0 pops node ${id} and puts it on its retired list (${retired.length} of R = ${o.R}).`, null);
    if (retired.length < o.R) continue;
    scans++;
    const prot = new Set<number>();
    for (let t = 0; t < o.threads; t++) {
      for (const h of hz[t]!) { slotReads++; if (h) prot.add(h); }
      if (t === 0) continue;
      retired = retired.map((x) => (prot.has(x.id) ? { ...x, mark: "kept" } : x));
      snap("scan", `T0 reads the ${SLOTS} hazard slots of T${t}: ${hz[t]!.map((h) => (h ? `node ${h}` : "empty")).join(", ")}.`, t);
    }
    const drop = retired.filter((x) => !prot.has(x.id)).length;
    retired = retired.map((x) => (prot.has(x.id) ? { ...x, mark: "kept" } : { ...x, mark: "freed" }));
    freedTotal += drop;
    snap("free", `T0 frees ${drop} node${drop === 1 ? "" : "s"}. ${retired.length - drop} protected node${retired.length - drop === 1 ? "" : "s"} stay on the list.`, null);
    retired = retired.filter((x) => x.mark === "kept").map((x) => ({ ...x, mark: "waiting" }));
  }
  return frames;
}

// ---------------------------------------------------------------- epoch-based reclamation

export interface EbrFrame {
  step: number;
  actor: number | null;
  label: string;
  global: number;
  /** Each thread's announced epoch, or null when the thread is not in an operation. */
  local: (number | null)[];
  /** Limbo list i holds nodes retired while the global epoch was `epoch` (epoch % 3 === i). */
  limbo: { epoch: number; count: number }[];
  waiting: number;
  freed: number;
}

/**
 * Each step, one thread (not the stalled one) takes its next action:
 * pin (announce the global epoch) → retire one node → unpin and try to advance.
 * A retired node goes on the limbo list of the global epoch at that moment.
 * The global epoch moves from G to G + 1 only if every pinned thread announced G.
 * When it reaches G + 1, the list of epoch G − 1 is freed: two epochs have passed.
 * With `stalled`, T0 pins in epoch 0 and then never runs again.
 */
export function ebrSim(o: { threads: number; stalled: boolean; steps: number; seed?: number }): EbrFrame[] {
  const r = mulberry32(o.seed ?? 1);
  let global = 0, waiting = 0, freed = 0;
  const local: (number | null)[] = Array(o.threads).fill(null);
  const phase: number[] = Array(o.threads).fill(0);
  const limbo = [0, 1, 2].map((i) => ({ epoch: i - 3, count: 0 }));
  const frames: EbrFrame[] = [];
  const snap = (step: number, actor: number | null, label: string) =>
    frames.push({ step, actor, label, global, local: [...local], limbo: limbo.map((x) => ({ ...x })), waiting, freed });
  if (o.stalled) local[0] = 0;
  snap(0, null, o.stalled ? "T0 pins in epoch 0. Then the operating system stops T0." : "All threads are idle. The global epoch is 0.");
  const runners = Array.from({ length: o.threads }, (_, i) => i).filter((i) => !(o.stalled && i === 0));
  for (let step = 1; step <= o.steps; step++) {
    const t = runners[Math.floor(r() * runners.length)]!;
    let label: string;
    if (phase[t] === 0) {
      local[t] = global;
      label = `T${t} pins: it announces epoch ${global}.`;
    } else if (phase[t] === 1) {
      const l = limbo[global % 3]!;
      if (l.epoch !== global) { l.epoch = global; l.count = 0; }
      l.count++;
      waiting++;
      label = `T${t} removes a node and puts it on the limbo list of epoch ${global}.`;
    } else {
      local[t] = null;
      const old = local.findIndex((e) => e !== null && e !== global);
      if (old >= 0) label = `T${t} unpins. T${old} still announces epoch ${local[old]}, so the epoch cannot move.`;
      else {
        global++;
        const l = limbo[(global + 1) % 3]!; // the list of epoch global − 2
        const n = l.epoch === global - 2 ? l.count : 0;
        freed += n;
        waiting -= n;
        l.count = 0;
        label = `T${t} unpins. All pinned threads announce epoch ${global - 1}, so the global epoch moves to ${global}.` +
          (global >= 2 ? ` The ${n} node${n === 1 ? "" : "s"} of epoch ${global - 2} are freed.` : "");
      }
    }
    phase[t] = (phase[t]! + 1) % 3;
    snap(step, t, label);
  }
  return frames;
}

export function ebrSummary(frames: EbrFrame[]) {
  const last = frames.at(-1)!;
  return { maxWaiting: Math.max(...frames.map((f) => f.waiting)), finalWaiting: last.waiting, global: last.global, freed: last.freed };
}

// ---------------------------------------------------------------- Michael-Scott queue

export interface MsqFrame {
  actor: number | null;
  caption: string;
  kind: "start" | "alloc" | "link" | "swing" | "help" | "deq" | "fail" | "end";
  chain: { p: Ptr; value: number }[];
  head: Ptr;
  tail: Ptr;
  /** Nodes between tail and the real last node (0 or 1). */
  lag: number;
  /** Nodes that a thread made but has not linked yet. */
  pending: { t: number; p: Ptr; value: number }[];
  results: (number | null)[][];
}

export type MsqScenario = "stall" | "deqhelp" | "plain";
const enq = (v: number) => ({ kind: "enq", v }) as const;
const deq = { kind: "deq" } as const;

export const MSQ_SCENARIOS: Record<MsqScenario, { sc: Scenario; plan: [number, "done" | string][] }> = {
  plain: { sc: { kind: "queue", initial: [1], threads: [[enq(10)], [enq(20)], [deq, deq]] }, plan: [[0, "done"], [1, "done"], [2, "done"]] },
  stall: { sc: { kind: "queue", initial: [1], threads: [[enq(10)], [enq(20)], [deq, deq]] }, plan: [[0, "swing tail"], [1, "done"], [0, "done"], [2, "done"]] },
  deqhelp: { sc: { kind: "queue", initial: [], threads: [[enq(10)], [deq]] }, plan: [[0, "swing tail"], [1, "done"], [0, "done"]] },
};

const lagOf = (w: World): number => {
  let n = 0;
  for (let p = w.roots.tail!.ptr; w.nodes[p]!.next.ptr && n < 50; p = w.nodes[p]!.next.ptr) n++;
  return n;
};

/** Key frames of a scripted Michael-Scott queue run: only steps that change shared pointers, plus failed CAS and helping. */
export function msqFrames(which: MsqScenario): MsqFrame[] {
  const { sc, plan } = MSQ_SCENARIOS[which];
  const w = makeWorld(sc, { scheme: "leak", tags: false, threshold: 2, pool: 12 });
  const frames: MsqFrame[] = [];
  const snap = (actor: number | null, kind: MsqFrame["kind"], caption: string) => {
    const chain = walk(w, w.roots.head!.ptr);
    const inChain = new Set(chain.map((c) => c.p));
    const pending = w.threads.flatMap((t) => (t.ptrs.n && !inChain.has(t.ptrs.n) && w.nodes[t.ptrs.n]!.state === "private" ? [{ t: t.id, p: t.ptrs.n, value: w.nodes[t.ptrs.n]!.value }] : []));
    frames.push({ actor, kind, caption, chain, head: w.roots.head!.ptr, tail: w.roots.tail!.ptr, lag: lagOf(w), pending, results: w.threads.map((t) => [...t.results]) });
  };
  snap(null, "start", sc.initial.length ? `The queue holds ${sc.initial.join(", ")}. Head points to the dummy node. Tail points to the last node.` : "The queue is empty: only the dummy node. Head and tail both point to it.");
  const N = (p: Ptr) => nodeName(p);
  const stepOne = (t: number) => {
    const th = w.threads[t]!;
    const label = th.next!;
    const head = w.roots.head!.ptr, tail = w.roots.tail!.ptr;
    const tl = th.ptrs.tail ?? 0, n = th.ptrs.n ?? 0, next = th.ptrs.next ?? 0;
    w.step(t);
    const head2 = w.roots.head!.ptr, tail2 = w.roots.tail!.ptr;
    if (label.startsWith("allocate")) snap(t, "alloc", `T${t} makes node ${N(th.ptrs.n ?? 0)} for ${w.nodes[th.ptrs.n ?? 0]!.value}. Only T${t} can see it.`);
    else if (label.startsWith("CAS") && label.includes(".next")) {
      if (w.nodes[tl]!.next.ptr === n) snap(t, "link", `T${t} links ${N(n)} after ${N(tl)} (first CAS, on ${N(tl)}.next). Tail still points to ${N(tl)}.`);
      else snap(t, "fail", `T${t} tries to link ${N(n)} after ${N(tl)}, but ${N(tl)}.next is not null now. T${t} tries again.`);
    } else if (label.startsWith("swing tail")) {
      if (tail2 !== tail) snap(t, "swing", `T${t} moves tail from ${N(tail)} to ${N(tail2)} (second CAS). The enqueue is complete.`);
      else snap(t, "fail", `T${t} tries to move tail from ${N(tl)}, but another thread moved it already. The CAS fails, and that is correct.`);
    } else if (label.startsWith("help")) {
      if (tail2 !== tail) snap(t, "help", `T${t} sees that tail.next is not null, so tail is behind. T${t} moves tail from ${N(tail)} to ${N(tail2)} for the other thread.`);
      else snap(t, "fail", `T${t} tries to help, but tail moved already.`);
    } else if (label.startsWith("CAS head")) {
      if (head2 !== head) snap(t, "deq", `T${t} moves head from ${N(head)} to ${N(next)} and takes the value ${w.nodes[next]!.value}. ${N(next)} is the new dummy.`);
      else snap(t, "fail", `T${t} tries to move head, but another thread moved it first. T${t} tries again.`);
    }
  };
  for (const [t, until] of plan) {
    const th = w.threads[t]!;
    while (th.next !== null && (until === "done" || !th.next.startsWith(until))) stepOne(t);
  }
  w.finalize();
  const res = w.threads.map((t) => `T${t.id}: ${t.results.map((x) => x ?? "empty").join(", ")}`).join(" · ");
  snap(null, "end", `All operations are complete. Return values: ${res}.${w.violations.length ? "" : " The checks found no problems."}`);
  return frames;
}

/**
 * One random schedule: `threads` threads, each enqueues one value, dequeues once and enqueues again.
 * Returns the largest tail lag seen after any step and the number of helping steps.
 */
export function msqLagRun(threads: number, run: number, seed = 1): { maxLag: number; helps: number; ok: boolean } {
  const sc: Scenario = { kind: "queue", initial: [1], threads: Array.from({ length: threads }, (_, i) => [enq(10 * i + 10), deq, enq(10 * i + 11)]) };
  const w = makeWorld(sc, { scheme: "leak", tags: false, threshold: 2, pool: 3 * threads + 4 });
  const r = mulberry32(seed * 100003 + run);
  let maxLag = 0, helps = 0;
  while (!w.done() && w.steps < 5000) {
    const ids = w.runnable();
    const t = ids[Math.floor(r() * ids.length)]!;
    if (w.threads[t]!.next!.startsWith("help")) helps++;
    w.step(t);
    maxLag = Math.max(maxLag, lagOf(w));
  }
  w.finalize();
  return { maxLag, helps, ok: w.done() && w.violations.length === 0 };
}

export function msqLagStats(threads: number, runs: number, seed = 1) {
  let maxLag = 0, helps = 0, runsWithHelp = 0, bad = 0;
  for (let i = 0; i < runs; i++) {
    const x = msqLagRun(threads, i, seed);
    maxLag = Math.max(maxLag, x.maxLag);
    helps += x.helps;
    if (x.helps) runsWithHelp++;
    if (!x.ok) bad++;
  }
  return { runs, maxLag, helps, runsWithHelp, bad };
}
