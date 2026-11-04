/**
 * Lesson "critical sections": an unprotected counter, interrupts off on one or two CPUs,
 * Peterson's algorithm on the interleaving machine, and the same entry protocol as a litmus test
 * for the C++ memory model explorer (src/sims/memmodel).
 */
import { parse, runCxx, runTso, type Result } from "../../memmodel";
import { countSchedules, explore, machineModel, mutualExclusion, type Ins, type MState, type Model, type Prog } from "./machine";

// ---------------------------------------------------------------- the counter

export type CounterMode = "plain" | "cli-one-cpu" | "cli-two-cpus" | "atomic";

const incr = (): Ins[] => [
  { text: "r = count", run(c) { c.r.r = c.load("count"); c.say(`reads count = ${c.r.r}`); } },
  { text: "r = r + 1", run(c) { c.r.r = c.r.r! + 1; c.say(`register r = ${c.r.r}`); } },
  { text: "count = r", run(c) { c.store("count", c.r.r!); c.say(`writes count = ${c.r.r}`); } },
];

/** Two threads each add 1 to a shared counter. */
export function counterProg(mode: CounterMode = "plain", threads = 2): Prog {
  const body = (t: number): Ins[] => {
    if (mode === "atomic") return [{ text: "lock add count, 1", sync: true, run(c) { c.mem.count = c.mem.count! + 1; c.say(`count = ${c.mem.count} in one atomic step`); } }];
    if (mode === "plain") return incr();
    return [
      { text: "cli", run(c) { c.mem[`irqoff${t}`] = 1; c.say(mode === "cli-one-cpu" ? "interrupts off: nothing can preempt this thread" : "interrupts off on this CPU only"); } },
      ...incr(),
      { text: "sti", run(c) { c.mem[`irqoff${t}`] = 0; c.say("interrupts on"); } },
    ];
  };
  const mem: Record<string, number> = { count: 0 };
  if (mode.startsWith("cli")) for (let t = 0; t < threads; t++) mem[`irqoff${t}`] = 0;
  return {
    name: `counter-${mode}`,
    threads: Array.from({ length: threads }, (_, t) => body(t)),
    mem,
    // On one CPU, a thread runs only if no other thread has interrupts off: no timer means no switch.
    gate: mode === "cli-one-cpu" ? (s, t) => s.th.every((_, o) => o === t || !s.mem[`irqoff${o}`]) : undefined,
  };
}

export function counterModel(mode: CounterMode = "plain", threads = 2): Model<MState> {
  return machineModel(counterProg(mode, threads), { outcome: (s) => `count=${s.mem.count}` });
}

/** Complete schedules by final count. */
export function counterSchedules(mode: CounterMode = "plain", threads = 2) {
  const by = countSchedules(counterModel(mode, threads));
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  const correct = by.get(`count=${threads}`) ?? 0;
  return { total, correct, lost: total - correct, by: Object.fromEntries(by) };
}

// ---------------------------------------------------------------- Peterson on the machine

export interface PetersonOpts {
  tso?: boolean;
  /** Put a full fence between the turn store and the first load. */
  fence?: boolean;
  /** Critical-section entries per thread. */
  rounds?: [number, number];
  /** Count entries of T1 while T0 waits (for the bounded-waiting check). */
  trackBypass?: boolean;
}

function petersonThread(me: number, o: PetersonOpts): Ins[] {
  const other = 1 - me;
  const rounds = o.rounds?.[me] ?? 1;
  const code: Ins[] = [
    { label: "start", text: `flag[${me}] = 1`, run(c) { c.store(`flag${me}`, 1); c.say(`thread ${me} wants to enter`); } },
    { text: `turn = ${other}`, run(c) { c.store("turn", other); c.say(`thread ${me} gives the turn to thread ${other}`); if (o.trackBypass && me === 0) c.mem.t0wants = 1; } },
  ];
  if (o.fence) code.push({ text: "mfence", sync: true, run(c) { c.say("store buffer is empty: earlier stores are in memory"); } });
  code.push(
    { label: "wait", text: `if flag[${other}] == 0 goto enter`, kind: "spin", run(c) {
      const f = c.load(`flag${other}`);
      c.say(`reads flag[${other}] = ${f}`);
      return f === 0 ? "enter" : undefined;
    } },
    { text: `if turn == ${other} goto wait`, kind: "spin", run(c) {
      const v = c.load("turn");
      c.say(`reads turn = ${v}`);
      return v === other ? "wait" : undefined;
    } },
    { label: "enter", text: "critical section", kind: "cs", run(c) {
      c.count(`enter${me}`);
      if (o.trackBypass && me === 1 && c.mem.t0wants) c.mem.bypass = (c.mem.bypass ?? 0) + 1;
      if (o.trackBypass && me === 0) { c.mem.t0wants = 0; c.mem.bypass = 0; }
      c.say(`thread ${me} leaves the critical section`);
    } },
    { text: `flag[${me}] = 0`, run(c) {
      c.store(`flag${me}`, 0);
      c.r.round = (c.r.round ?? 0) + 1;
      if (c.r.round < rounds) return "start";
      return undefined;
    } },
  );
  return code;
}

export function petersonProg(o: PetersonOpts = {}): Prog {
  const mem: Record<string, number> = { flag0: 0, flag1: 0, turn: 0 };
  if (o.trackBypass) { mem.t0wants = 0; mem.bypass = 0; }
  return { name: "peterson", threads: [petersonThread(0, o), petersonThread(1, o)], mem, tso: o.tso };
}

/** Exhaustive search over all schedules (and, under TSO, all drain points). */
export function checkPeterson(o: PetersonOpts = {}) {
  const p = petersonProg(o);
  return explore(machineModel(p, { check: mutualExclusion(p) }));
}

/**
 * Bounded waiting: the most times T1 enters after T0 finished "turn = 1" and before T0 enters.
 * T1 tries 3 rounds, so a value above 1 would show that T1 can pass T0 again and again.
 */
export function petersonMaxBypass(): number {
  const p = petersonProg({ rounds: [1, 3], trackBypass: true });
  const m = machineModel(p);
  const seen = new Set<string>([m.key(m.init)]);
  const stack = [m.init];
  let max = 0;
  while (stack.length) {
    const s = stack.pop()!;
    // The counter is updated when T1 leaves its critical section, so read it on every state.
    max = Math.max(max, s.mem.bypass ?? 0);
    for (const st of m.steps(s)) {
      const k = m.key(st.next);
      if (!seen.has(k)) { seen.add(k); stack.push(st.next); }
    }
  }
  return max;
}

// ---------------------------------------------------------------- Peterson as a litmus test

export type PetersonStores = "plain" | "fence" | "seq-cst";

/**
 * One try of the entry protocol. T0 enters if r0 = 0 or r1 != 1. T1 enters if r2 = 0 or r3 != 0.
 * "plain" uses relaxed atomics, which compile to plain MOV on x86. "fence" adds MFENCE. "seq-cst"
 * uses XCHG for the stores.
 */
export function petersonLitmusSrc(kind: PetersonStores): string {
  const st = kind === "seq-cst" ? "seq_cst" : "relaxed";
  const ld = kind === "seq-cst" ? "seq_cst" : "relaxed";
  const f = kind === "fence" ? "  fence(seq_cst)\n" : "";
  return `T0:
  flag0.store(1, ${st})
  turn.store(1, ${st})
${f}  r0 = flag1.load(${ld})
  r1 = turn.load(${ld})
T1:
  flag1.store(1, ${st})
  turn.store(0, ${st})
${f}  r2 = flag0.load(${ld})
  r3 = turn.load(${ld})
`;
}

export interface LitmusRow { r0: number; r1: number; r2: number; r3: number; t0: boolean; t1: boolean; both: boolean; sc: boolean; tso: boolean; cxx: boolean }

export interface PetersonLitmus { rows: LitmusRow[]; sc: Result; tso: Result; cxx: Result; failsSc: boolean; failsTso: boolean; failsCxx: boolean }

const enters = (regs: Record<string, number>) => {
  const t0 = regs.r0 === 0 || regs.r1 !== 1;
  const t1 = regs.r2 === 0 || regs.r3 !== 0;
  return { t0, t1, both: t0 && t1 };
};

export function petersonLitmus(kind: PetersonStores): PetersonLitmus {
  const prog = parse(petersonLitmusSrc(kind));
  const sc = runTso(prog, false);
  const tso = runTso(prog, true);
  const cxx = runCxx(prog);
  const rows = new Map<string, LitmusRow>();
  const add = (res: Result, m: "sc" | "tso" | "cxx") => {
    for (const o of res.outcomes) {
      const r = { r0: o.regs.r0 ?? 0, r1: o.regs.r1 ?? 0, r2: o.regs.r2 ?? 0, r3: o.regs.r3 ?? 0 };
      const k = `${r.r0}${r.r1}${r.r2}${r.r3}`;
      const row = rows.get(k) ?? { ...r, ...enters(r), sc: false, tso: false, cxx: false };
      row[m] = true;
      rows.set(k, row);
    }
  };
  add(sc, "sc"); add(tso, "tso"); add(cxx, "cxx");
  const list = [...rows.values()].sort((a, b) => Number(b.both) - Number(a.both) || `${a.r0}${a.r1}${a.r2}${a.r3}`.localeCompare(`${b.r0}${b.r1}${b.r2}${b.r3}`));
  const fails = (res: Result) => res.outcomes.some((o) => enters(o.regs).both);
  return { rows: list, sc, tso, cxx, failsSc: fails(sc), failsTso: fails(tso), failsCxx: fails(cxx) };
}

