/**
 * Small, exact models for the atomics lessons. Pure TypeScript, no React.
 *
 * 1. An interleaving machine for straight-line threads (lost update, torn 64-bit value).
 * 2. A CAS retry loop that the learner schedules, and an exhaustive worst case.
 * 3. The ABA problem on a Treiber stack, with and without a tag (version counter).
 * 4. Fence placement: builds litmus programs and runs the existing memory-model explorer.
 * 5. Happens-before graphs: sequenced-before, synchronizes-with, vector clocks, races.
 * 6. An x86-TSO store-buffer machine that the learner drives by hand.
 * 7. A copy of the CAS contention simulation (the lesson quotes its numbers).
 */
import { parse, runCxx, runTso, type Result } from "./memmodel";

// =====================================================================
// 1. Interleaving machine
// =====================================================================

export interface Line<S> { label: string; run: (s: S) => S }
export interface Machine<S> { init: S; threads: Line<S>[][]; result: (s: S) => string }

/** Runs a schedule (a list of thread indices). Steps for finished threads are ignored. */
export function replay<S>(m: Machine<S>, schedule: readonly number[]): { state: S; pcs: number[] } {
  let s = m.init;
  const pcs = m.threads.map(() => 0);
  for (const t of schedule) {
    const line = m.threads[t]?.[pcs[t]!];
    if (!line) continue;
    s = line.run(s);
    pcs[t]!++;
  }
  return { state: s, pcs };
}

/** For every way to finish from `schedule`, the final result. Returns result → number of schedules. */
export function completions<S>(m: Machine<S>, schedule: readonly number[] = []): Map<string, number> {
  const out = new Map<string, number>();
  const { state, pcs } = replay(m, schedule);
  const go = (s: S, pc: number[]) => {
    let any = false;
    m.threads.forEach((th, t) => {
      const line = th[pc[t]!];
      if (!line) return;
      any = true;
      const next = pc.slice();
      next[t]!++;
      go(line.run(s), next);
    });
    if (!any) {
      const k = m.result(s);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  };
  go(state, pcs);
  return out;
}

export const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

// ---------- lost update ----------

export type CounterMode = "split" | "rmw";
export interface CounterState { count: number; r: (number | null)[] }

/**
 * n threads each add 1 to a shared counter.
 * "split": load into a register, add 1, store back (three separate steps).
 * "rmw": one fetch_add.
 */
export function counterMachine(n: number, mode: CounterMode): Machine<CounterState> {
  const set = (s: CounterState, i: number, v: number | null): (number | null)[] => s.r.map((x, j) => (j === i ? v : x));
  const threads = Array.from({ length: n }, (_, i): Line<CounterState>[] =>
    mode === "rmw"
      ? [{ label: "count.fetch_add(1)", run: (s) => ({ count: s.count + 1, r: set(s, i, s.count) }) }]
      : [
          { label: `r${i} = count`, run: (s) => ({ ...s, r: set(s, i, s.count) }) },
          { label: `r${i} = r${i} + 1`, run: (s) => ({ ...s, r: set(s, i, (s.r[i] ?? 0) + 1) }) },
          { label: `count = r${i}`, run: (s) => ({ ...s, count: s.r[i] ?? 0 }) },
        ],
  );
  return { init: { count: 0, r: Array(n).fill(null) }, threads, result: (s) => String(s.count) };
}

// ---------- torn 64-bit value ----------

/** Halves: 0 = old value, 1 = new value. */
export interface TearState { lo: 0 | 1; hi: 0 | 1; rlo: 0 | 1 | null; rhi: 0 | 1 | null }

/** A writer changes a 64-bit value from old to new; a reader reads it. Without atomics, each 32-bit half is a separate step. */
export function tearMachine(atomic: boolean): Machine<TearState> {
  const writer: Line<TearState>[] = atomic
    ? [{ label: "store all 64 bits", run: (s) => ({ ...s, lo: 1, hi: 1 }) }]
    : [
        { label: "store low half", run: (s) => ({ ...s, lo: 1 }) },
        { label: "store high half", run: (s) => ({ ...s, hi: 1 }) },
      ];
  const reader: Line<TearState>[] = atomic
    ? [{ label: "load all 64 bits", run: (s) => ({ ...s, rlo: s.lo, rhi: s.hi }) }]
    : [
        { label: "load low half", run: (s) => ({ ...s, rlo: s.lo }) },
        { label: "load high half", run: (s) => ({ ...s, rhi: s.hi }) },
      ];
  return { init: { lo: 0, hi: 0, rlo: null, rhi: null }, threads: [writer, reader], result: (s) => `${s.rhi}${s.rlo}` };
}

/** "00" and "11" are values the writer really stored; "01" and "10" are torn. */
export const isTorn = (k: string) => k === "01" || k === "10";

// =====================================================================
// 2. CAS retry loop
// =====================================================================

export type CasFn = "inc" | "double";
export const casApply = (fn: CasFn, v: number) => (fn === "inc" ? v + 1 : v * 2);

export interface CasThread { pc: 0 | 1 | 2; cur: number | null; attempts: number; fails: number }
export interface CasState { x: number; th: CasThread[] }

/** pc 0: cur = x.load(). pc 1: x.compare_exchange(cur, f(cur)). pc 2: done. */
export function casInit(n: number, x0: number): CasState {
  return { x: x0, th: Array.from({ length: n }, () => ({ pc: 0, cur: null, attempts: 0, fails: 0 })) };
}

export function casStep(s: CasState, t: number, fn: CasFn): { state: CasState; event: "load" | "ok" | "fail" | "idle" } {
  const th = s.th[t]!;
  const put = (nt: CasThread, x = s.x): CasState => ({ x, th: s.th.map((o, j) => (j === t ? nt : o)) });
  if (th.pc === 2) return { state: s, event: "idle" };
  if (th.pc === 0) return { state: put({ ...th, pc: 1, cur: s.x }), event: "load" };
  const cur = th.cur ?? 0;
  if (s.x === cur) return { state: put({ ...th, pc: 2, attempts: th.attempts + 1 }, casApply(fn, cur)), event: "ok" };
  // Failure: compare_exchange returns the current value, and the loop retries with it.
  return { state: put({ ...th, cur: s.x, attempts: th.attempts + 1, fails: th.fails + 1 }), event: "fail" };
}

export const casDone = (s: CasState) => s.th.every((t) => t.pc === 2);
export const casAttempts = (s: CasState) => s.th.reduce((a, t) => a + t.attempts, 0);

/** Exhaustive search over all schedules: the fewest and the most CAS attempts for n threads, one update each. */
export function casAttemptRange(n: number, fn: CasFn = "inc"): { min: number; max: number; finals: number[] } {
  let min = Infinity, max = 0;
  const finals = new Set<number>();
  const seen = new Set<string>();
  const go = (s: CasState) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return;
    seen.add(key);
    if (casDone(s)) {
      const a = casAttempts(s);
      min = Math.min(min, a);
      max = Math.max(max, a);
      finals.add(s.x);
      return;
    }
    s.th.forEach((th, t) => { if (th.pc !== 2) go(casStep(s, t, fn).state); });
  };
  go(casInit(n, 1));
  return { min, max, finals: [...finals].sort((a, b) => a - b) };
}

// =====================================================================
// 3. ABA on a Treiber stack
// =====================================================================

export type Node = "A" | "B" | "C";
export interface AbaState {
  top: Node | null;
  tag: number;
  next: Record<Node, Node | null>;
  freed: Node[];
  /** T0 pops one node with a CAS loop. pc 0: read top. pc 1: read top.next. pc 2: CAS. pc 3: done. */
  t0: { pc: number; seenTop: Node | null; seenTag: number; seenNext: Node | null; fails: number; popped: Node | null };
  /** T1 runs three whole operations: pop, pop (and free), push the first node back. */
  t1: { pc: number; held: Node[] };
}

export const ABA_T0 = ["old = top", "next = old.next", "CAS(top, old, next)"];
export const ABA_T1 = ["n1 = pop()", "n2 = pop(); free(n2)", "push(n1)"];

export const abaInit = (): AbaState => ({
  top: "A",
  tag: 0,
  next: { A: "B", B: "C", C: null },
  freed: [],
  t0: { pc: 0, seenTop: null, seenTag: 0, seenNext: null, fails: 0, popped: null },
  t1: { pc: 0, held: [] },
});

export function abaStep(s: AbaState, t: 0 | 1, tagged: boolean): AbaState {
  if (t === 0) {
    const a = s.t0;
    if (a.pc === 0) return { ...s, t0: { ...a, pc: 1, seenTop: s.top, seenTag: s.tag } };
    if (a.pc === 1) return { ...s, t0: { ...a, pc: 2, seenNext: a.seenTop ? s.next[a.seenTop] : null } };
    if (a.pc === 2) {
      const match = s.top === a.seenTop && (!tagged || s.tag === a.seenTag);
      if (match) return { ...s, top: a.seenNext, tag: s.tag + 1, t0: { ...a, pc: 3, popped: a.seenTop } };
      return { ...s, t0: { ...a, pc: 0, fails: a.fails + 1 } };
    }
    return s;
  }
  const b = s.t1;
  if (b.pc >= 3 || (!s.top && b.pc < 2)) return s;
  if (b.pc === 0 || b.pc === 1) {
    const n = s.top!;
    const freed = b.pc === 1 ? [...s.freed, n] : s.freed;
    return { ...s, top: s.next[n], tag: s.tag + 1, freed, t1: { pc: b.pc + 1, held: [...b.held, n] } };
  }
  const a = b.held[0] ?? "A";
  return { ...s, next: { ...s.next, [a]: s.top }, top: a, tag: s.tag + 1, t1: { ...b, pc: 3 } };
}

/** The nodes reachable from top (stops at 5 to guard against cycles). */
export function abaList(s: AbaState): Node[] {
  const out: Node[] = [];
  for (let n = s.top; n && out.length < 5; n = s.next[n]) out.push(n);
  return out;
}

export const abaDone = (s: AbaState) => s.t0.pc === 3 && s.t1.pc === 3;
/** The stack is broken if a freed node is still reachable from top. */
export const abaBroken = (s: AbaState) => abaList(s).some((n) => s.freed.includes(n));

// =====================================================================
// 4. Fence placement
// =====================================================================

export type FenceOrd = "none" | "acquire" | "release" | "seq_cst";
export type FenceMode = "mp" | "sb";
/** Fence slots: for each thread, before / between / after its two operations. */
export type FenceSlots = [FenceOrd, FenceOrd, FenceOrd, FenceOrd, FenceOrd, FenceOrd];

export const FENCE_OPS: Record<FenceMode, [string[], string[]]> = {
  mp: [["data.store(42, relaxed)", "flag.store(1, relaxed)"], ["r0 = flag.load(relaxed)", "r1 = data.load(relaxed)"]],
  sb: [["x.store(1, relaxed)", "r0 = y.load(relaxed)"], ["y.store(1, relaxed)", "r1 = x.load(relaxed)"]],
};
/** The outcome that the fences should forbid. */
export const FENCE_WEAK: Record<FenceMode, string> = { mp: "r0=1 r1=0", sb: "r0=0 r1=0" };

export function fenceProgram(mode: FenceMode, slots: FenceSlots): string {
  const lines: string[] = [];
  FENCE_OPS[mode].forEach((ops, t) => {
    lines.push(`T${t}:`);
    for (let k = 0; k < 3; k++) {
      const f = slots[t * 3 + k]!;
      if (f !== "none") lines.push(`  fence(${f})`);
      if (k < 2) lines.push(`  ${ops[k]}`);
    }
  });
  return lines.join("\n");
}

const regsOnly = (r: Result) => [...new Set(r.outcomes.map((o) => o.key.split(" · ")[0]!))].sort();

export interface FenceRun { cxx: string[]; tso: string[]; sc: string[]; weakCxx: boolean; weakTso: boolean }

export function fenceRun(mode: FenceMode, slots: FenceSlots): FenceRun {
  const p = parse(fenceProgram(mode, slots));
  const cxx = regsOnly(runCxx(p)), tso = regsOnly(runTso(p, true)), sc = regsOnly(runTso(p, false));
  const w = FENCE_WEAK[mode];
  return { cxx, tso, sc, weakCxx: cxx.includes(w), weakTso: tso.includes(w) };
}

/** The rule the lesson states, to compare with the explorer. */
export function fenceRule(mode: FenceMode, slots: FenceSlots): boolean {
  const rel = (f: FenceOrd) => f === "release" || f === "seq_cst";
  const acq = (f: FenceOrd) => f === "acquire" || f === "seq_cst";
  // Only the slot between the two operations of a thread can order them.
  if (mode === "mp") return !(rel(slots[1]) && acq(slots[4]));
  return !(slots[1] === "seq_cst" && slots[4] === "seq_cst");
}

/** What a fence compiles to (C++ / Rust mappings for GCC and Clang). */
export const FENCE_ASM: Record<Exclude<FenceOrd, "none">, { x86: string; arm: string }> = {
  acquire: { x86: "no instruction", arm: "dmb ishld" },
  release: { x86: "no instruction", arm: "dmb ish" },
  seq_cst: { x86: "mfence", arm: "dmb ish" },
};

// =====================================================================
// 5. Happens-before graphs
// =====================================================================

export type HbOrd = "relaxed" | "release" | "acquire" | "seq_cst";
export interface HbEvent {
  id: string;
  t: number;
  label: string;
  /** w: write, r: read, rmw: read-modify-write. */
  kind: "w" | "r" | "rmw";
  loc: string;
  atomic: boolean;
  /** For reads: the write it reads from. */
  rf?: string;
  /** Orders the learner can choose; empty for plain accesses and fixed ones. */
  choices: HbOrd[];
  /** Default (and fixed) order. */
  ord: HbOrd;
  /** Litmus source for a given order. */
  src: (o: HbOrd) => string;
}
export interface HbScenario { id: string; label: string; threads: number; events: HbEvent[] }

// seq_cst is left out on purpose: a seq_cst store is also a release, a seq_cst load is also an acquire.
// (The explorer's seq_cst model also lets two seq_cst loads synchronize, which C++ does not promise.)
const W: HbOrd[] = ["relaxed", "release"];
const R: HbOrd[] = ["relaxed", "acquire"];
const plainW = (id: string, t: number): HbEvent => ({ id, t, label: "data = 42", kind: "w", loc: "data", atomic: false, choices: [], ord: "relaxed", src: () => "data = 42" });
const plainR = (id: string, t: number, rf: string): HbEvent => ({ id, t, label: "r0 = data", kind: "r", loc: "data", atomic: false, rf, choices: [], ord: "relaxed", src: () => "r0 = data" });
const store = (id: string, t: number, loc: string, v: number): HbEvent => ({ id, t, label: `${loc}.store(${v})`, kind: "w", loc, atomic: true, choices: W, ord: "relaxed", src: (o) => `${loc}.store(${v}, ${o})` });
const wait = (id: string, t: number, loc: string, v: number, rf: string): HbEvent => ({ id, t, label: `wait ${loc} == ${v}`, kind: "r", loc, atomic: true, rf, choices: R, ord: "relaxed", src: (o) => `${loc}.await(${v}, ${o})` });

export const HB_SCENARIOS: HbScenario[] = [
  { id: "mp", label: "Two threads, one flag", threads: 2, events: [plainW("w", 0), store("s", 0, "flag", 1), wait("l", 1, "flag", 1, "s"), plainR("r", 1, "w")] },
  {
    id: "chain",
    label: "Three threads, a chain",
    threads: 3,
    events: [plainW("w", 0), store("sa", 0, "a", 1), wait("la", 1, "a", 1, "sa"), store("sb", 1, "b", 1), wait("lb", 2, "b", 1, "sb"), plainR("r", 2, "w")],
  },
  {
    id: "relseq",
    label: "fetch_add in the middle",
    threads: 3,
    events: [
      plainW("w", 0),
      store("s", 0, "flag", 1),
      { id: "m", t: 1, label: "flag.fetch_add(1)", kind: "rmw", loc: "flag", atomic: true, rf: "s", choices: [], ord: "relaxed", src: () => "r1 = flag.fetch_add(1, relaxed)" },
      wait("l", 2, "flag", 2, "m"),
      plainR("r", 2, "w"),
    ],
  },
  {
    id: "store",
    label: "store in the middle",
    threads: 3,
    events: [
      plainW("w", 0),
      store("s", 0, "flag", 1),
      { id: "m", t: 1, label: "flag.store(2)", kind: "w", loc: "flag", atomic: true, choices: [], ord: "relaxed", src: () => "flag.store(2, relaxed)" },
      wait("l", 2, "flag", 2, "m"),
      plainR("r", 2, "w"),
    ],
  },
];

export const hbOrds = (sc: HbScenario, chosen: Record<string, HbOrd>) =>
  Object.fromEntries(sc.events.map((e) => [e.id, e.choices.length ? (chosen[e.id] ?? e.ord) : e.ord])) as Record<string, HbOrd>;

export function hbLitmus(sc: HbScenario, chosen: Record<string, HbOrd>): string {
  const ords = hbOrds(sc, chosen);
  const lines: string[] = [];
  for (let t = 0; t < sc.threads; t++) {
    lines.push(`T${t}:`);
    for (const e of sc.events.filter((x) => x.t === t)) lines.push(`  ${e.src(ords[e.id]!)}`);
  }
  return lines.join("\n");
}

export interface HbResult {
  sb: [string, string][];
  rf: [string, string][];
  sw: [string, string][];
  /** Vector clock of each event: one counter per thread. */
  vc: Record<string, number[]>;
  hb: (a: string, b: string) => boolean;
  races: [string, string][];
}

const isRel = (o: HbOrd) => o === "release" || o === "seq_cst";
const isAcq = (o: HbOrd) => o === "acquire" || o === "seq_cst";

export function hbAnalyze(sc: HbScenario, chosen: Record<string, HbOrd>): HbResult {
  const ords = hbOrds(sc, chosen);
  const ev = new Map(sc.events.map((e) => [e.id, e]));
  const sb: [string, string][] = [];
  for (let t = 0; t < sc.threads; t++) {
    const es = sc.events.filter((e) => e.t === t);
    for (let i = 1; i < es.length; i++) sb.push([es[i - 1]!.id, es[i]!.id]);
  }
  const rf = sc.events.filter((e) => e.atomic && e.rf).map((e) => [e.rf!, e.id] as [string, string]);
  // Synchronizes-with: an acquire read that reads a write in the release sequence of a release write.
  // The release sequence (C++20) is the release write followed by RMWs that read from it, one after another.
  const sw: [string, string][] = [];
  for (const e of sc.events) {
    if (!e.atomic || !e.rf || !isAcq(ords[e.id]!)) continue;
    for (let w = ev.get(e.rf); w; w = w.kind === "rmw" && w.rf ? ev.get(w.rf) : undefined) {
      if (isRel(ords[w.id]!)) sw.push([w.id, e.id]);
      if (w.kind !== "rmw") break;
    }
  }
  // Vector clocks: join the clocks of all predecessors, then count this event in its own thread.
  const preds = new Map<string, string[]>(sc.events.map((e) => [e.id, []]));
  for (const [a, b] of [...sb, ...sw]) preds.get(b)!.push(a);
  const vc: Record<string, number[]> = {};
  const index = new Map<string, number>();
  for (let t = 0; t < sc.threads; t++) sc.events.filter((e) => e.t === t).forEach((e, i) => index.set(e.id, i + 1));
  let changed = true;
  for (const e of sc.events) vc[e.id] = Array(sc.threads).fill(0);
  while (changed) {
    changed = false;
    for (const e of sc.events) {
      const c = Array<number>(sc.threads).fill(0);
      for (const p of preds.get(e.id)!) vc[p]!.forEach((v, k) => (c[k] = Math.max(c[k]!, v)));
      c[e.t] = index.get(e.id)!;
      if (c.some((v, k) => v !== vc[e.id]![k])) { vc[e.id] = c; changed = true; }
    }
  }
  const hb = (a: string, b: string) => a !== b && vc[a]![ev.get(a)!.t]! <= vc[b]![ev.get(a)!.t]!;
  const races: [string, string][] = [];
  sc.events.forEach((a, i) =>
    sc.events.slice(i + 1).forEach((b) => {
      if (a.t === b.t || a.loc !== b.loc) return;
      if (a.kind === "r" && b.kind === "r") return;
      if (a.atomic && b.atomic) return;
      if (!hb(a.id, b.id) && !hb(b.id, a.id)) races.push([a.id, b.id]);
    }),
  );
  return { sb, rf, sw, vc, hb, races };
}

/** Every combination of the learner's choices in a scenario. */
export function hbCombos(sc: HbScenario): Record<string, HbOrd>[] {
  let out: Record<string, HbOrd>[] = [{}];
  for (const e of sc.events) if (e.choices.length) out = out.flatMap((c) => e.choices.map((o) => ({ ...c, [e.id]: o })));
  return out;
}

// =====================================================================
// 6. x86-TSO store buffers, driven by hand
// =====================================================================

export type TsoOp =
  | { k: "st"; loc: string; v: number; cxx: string; asm: string; locked?: boolean }
  | { k: "ld"; loc: string; reg: string; cxx: string; asm: string };
export interface TsoProgram { id: string; label: string; threads: TsoOp[][]; weak: string; litmus: string }

const st = (loc: string, v: number, ord: string): TsoOp =>
  ord === "seq_cst"
    ? { k: "st", loc, v, locked: true, cxx: `${loc}.store(${v}, seq_cst)`, asm: `xchg [${loc}], ${v}` }
    : { k: "st", loc, v, cxx: `${loc}.store(${v}, ${ord})`, asm: `mov [${loc}], ${v}` };
const ld = (reg: string, loc: string, ord: string): TsoOp => ({ k: "ld", loc, reg, cxx: `${reg} = ${loc}.load(${ord})`, asm: `mov ${reg}, [${loc}]` });

export const TSO_PROGRAMS: TsoProgram[] = [
  { id: "sb", label: "Store buffering, release/acquire", threads: [[st("x", 1, "release"), ld("r0", "y", "acquire")], [st("y", 1, "release"), ld("r1", "x", "acquire")]], weak: "r0=0 r1=0", litmus: "sb-relacq" },
  { id: "sb-sc", label: "Store buffering, seq_cst", threads: [[st("x", 1, "seq_cst"), ld("r0", "y", "seq_cst")], [st("y", 1, "seq_cst"), ld("r1", "x", "seq_cst")]], weak: "r0=0 r1=0", litmus: "sb-sc" },
  { id: "mp", label: "Message passing, relaxed", threads: [[st("data", 42, "relaxed"), st("flag", 1, "relaxed")], [ld("r0", "flag", "relaxed"), ld("r1", "data", "relaxed")]], weak: "r0=1 r1=0", litmus: "mp-relaxed" },
];

export interface TsoState { mem: Record<string, number>; buf: [string, number][][]; pc: number[]; regs: Record<string, number> }

export function tsoInit(p: TsoProgram): TsoState {
  const mem: Record<string, number> = {};
  for (const th of p.threads) for (const op of th) mem[op.loc] = 0;
  return { mem, buf: p.threads.map(() => []), pc: p.threads.map(() => 0), regs: {} };
}

/** Moves the oldest store in thread t's buffer to memory. */
export function tsoDrain(s: TsoState, t: number): TsoState {
  const b = s.buf[t]!;
  if (!b.length) return s;
  const [[loc, v], ...rest] = b as [[string, number], ...[string, number][]];
  return { ...s, mem: { ...s.mem, [loc]: v }, buf: s.buf.map((x, j) => (j === t ? rest : x)) };
}

/**
 * Runs thread t's next instruction. A plain store goes into the store buffer.
 * A locked store (xchg) first drains the whole buffer, then writes memory directly.
 * A load reads the newest matching store in its own buffer, else memory.
 */
export function tsoExec(p: TsoProgram, s: TsoState, t: number): TsoState {
  const op = p.threads[t]![s.pc[t]!];
  if (!op) return s;
  const pc = s.pc.map((x, j) => (j === t ? x + 1 : x));
  if (op.k === "st") {
    if (op.locked) {
      let d = s;
      while (d.buf[t]!.length) d = tsoDrain(d, t);
      return { ...d, mem: { ...d.mem, [op.loc]: op.v }, pc };
    }
    return { ...s, buf: s.buf.map((x, j) => (j === t ? [...x, [op.loc, op.v] as [string, number]] : x)), pc };
  }
  const own = [...s.buf[t]!].reverse().find(([l]) => l === op.loc);
  return { ...s, regs: { ...s.regs, [op.reg]: own ? own[1] : s.mem[op.loc]! }, pc };
}

export const tsoFinished = (p: TsoProgram, s: TsoState) => s.pc.every((x, t) => x >= p.threads[t]!.length) && s.buf.every((b) => !b.length);
export const tsoKey = (p: TsoProgram, s: TsoState) =>
  p.threads.flat().flatMap((o) => (o.k === "ld" ? [`${o.reg}=${s.regs[o.reg] ?? 0}`] : [])).join(" ");

/** Every outcome the hand-driven machine can reach. */
export function tsoOutcomes(p: TsoProgram, from: TsoState = tsoInit(p)): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const go = (s: TsoState) => {
    const k = JSON.stringify(s);
    if (seen.has(k)) return;
    seen.add(k);
    if (tsoFinished(p, s)) { out.add(tsoKey(p, s)); return; }
    p.threads.forEach((_, t) => {
      if (s.pc[t]! < p.threads[t]!.length) go(tsoExec(p, s, t));
      if (s.buf[t]!.length) go(tsoDrain(s, t));
    });
  };
  go(from);
  return [...out].sort();
}

/** The outcomes the same program has under sequential consistency (no store buffers). */
export function scOutcomes(p: TsoProgram): string[] {
  const out = new Set<string>();
  const go = (s: TsoState) => {
    if (s.pc.every((x, t) => x >= p.threads[t]!.length)) { out.add(tsoKey(p, s)); return; }
    p.threads.forEach((_, t) => {
      if (s.pc[t]! >= p.threads[t]!.length) return;
      let n = tsoExec(p, s, t);
      while (n.buf[t]!.length) n = tsoDrain(n, t);
      go(n);
    });
  };
  go(tsoInit(p));
  return [...out].sort();
}

// =====================================================================
// 7. CAS contention
// =====================================================================

export { simulateCas as casContention } from "./cas";
