/**
 * The run queue against an interrupt, on the interleaving machine of the sync module.
 *
 * A thread enqueues A. An interrupt handler enqueues B. The queue is a singly linked list with a tail pointer, and
 * it holds R at the start. One enqueue is three steps. On one CPU, the handler runs to its end once it has started,
 * and the thread cannot run until then. `explore` checks all schedules.
 */
import { BLOCK, countSchedules, explore, machineModel, allDone, type Ins, type MState, type Prog } from "../sync/machine";

export type RaceMode = "none" | "cli" | "lock-only" | "cli-two-cpus" | "irqsave-two-cpus";

export const RACE_LABEL: Record<RaceMode, string> = {
  none: "One CPU, no protection",
  cli: "One CPU, cli and sti",
  "lock-only": "One CPU, spinlock only",
  "cli-two-cpus": "Two CPUs, cli and sti",
  "irqsave-two-cpus": "Two CPUs, cli and spinlock",
};

export const NODE = { R: 3, A: 1, B: 2 } as const;
const nodeName = (n: number) => (n === NODE.R ? "R" : n === NODE.A ? "A" : n === NODE.B ? "B" : "none");

const enqueue = (n: number, name: string): Ins[] => [
  { text: "t = tail", run(c) { c.r.t = c.load("tail"); c.say(`reads tail = ${nodeName(c.r.t)}`); } },
  { text: `t.next = ${name}`, run(c) { c.store(`next${c.r.t}`, n); c.say(`${nodeName(c.r.t!)}.next = ${name}`); } },
  { text: `tail = ${name}`, kind: "cs", run(c) { c.store("tail", n); c.say(`tail = ${name}`); } },
];

const lock = (who: string): Ins => ({
  text: "spin_lock(rq)",
  run(c) {
    if (c.load("lock")) return BLOCK;
    c.store("lock", 1);
    c.say(`${who} takes the lock`);
    return undefined;
  },
});
const unlock: Ins = { text: "spin_unlock(rq)", run(c) { c.store("lock", 0); c.say("the lock is free"); } };
const cli: Ins = { text: "cli", run(c) { c.store("irqoff", 1); c.say("interrupts off on this CPU"); } };
const sti: Ins = { text: "sti", run(c) { c.store("irqoff", 0); c.say("interrupts on"); } };
const fire: Ins = { text: "IRQ arrives", run(c) { c.say("the handler starts"); } };

export function raceProg(mode: RaceMode): Prog {
  const oneCpu = mode === "none" || mode === "cli" || mode === "lock-only";
  const usesCli = mode === "cli" || mode === "cli-two-cpus" || mode === "irqsave-two-cpus";
  const usesLock = mode === "lock-only" || mode === "irqsave-two-cpus";
  const thread: Ins[] = [
    ...(usesCli ? [cli] : []),
    ...(usesLock ? [lock("the thread")] : []),
    ...enqueue(NODE.A, "A"),
    ...(usesLock ? [unlock] : []),
    ...(usesCli ? [sti] : []),
  ];
  const irq: Ins[] = [
    fire,
    ...(usesLock ? [lock("the handler")] : []),
    ...enqueue(NODE.B, "B"),
    ...(usesLock ? [unlock] : []),
  ];
  const mem: Record<string, number> = { head: NODE.R, tail: NODE.R, next1: 0, next2: 0, next3: 0, lock: 0, irqoff: 0 };
  return {
    name: `race-${mode}`,
    threads: [thread, irq],
    names: ["thread", "IRQ"],
    mem,
    gate: oneCpu
      ? (s, t) => {
          const hPc = s.th[1]!.pc;
          const hDone = hPc >= irq.length;
          if (t === 0) return hPc === 0 || hDone; // the handler runs to its end
          return hPc > 0 || !s.mem.irqoff; // it can start only with IF = 1
        }
      : undefined,
  };
}

/** Walks the list from head. */
export function queueOf(mem: Record<string, number>): string[] {
  const out: string[] = [];
  let n = mem.head ?? 0;
  for (let i = 0; n && i < 5; i++) {
    out.push(nodeName(n));
    n = mem[`next${n}`] ?? 0;
  }
  return out;
}

/** A finished queue must hold all 3 nodes, and tail must be the last one. */
export function queueProblem(mem: Record<string, number>): string | null {
  const q = queueOf(mem);
  if (q.length !== 3) return `The queue lost a node: it holds ${q.join(", ")}.`;
  if (q[2] !== nodeName(mem.tail!)) return `tail points to ${nodeName(mem.tail!)}, but the last node is ${q[2]}.`;
  return null;
}

const outcomeOf = (p: Prog) => (s: MState) => (allDone(p, s) ? `${queueProblem(s.mem) ? "corrupt" : "ok"}:${queueOf(s.mem).join(",")}` : "deadlock");

export function raceModel(mode: RaceMode) {
  const p = raceProg(mode);
  return machineModel(p, {
    check: (s) => (allDone(p, s) ? queueProblem(s.mem) : null),
    outcome: outcomeOf(p),
  });
}

export function raceReport(mode: RaceMode) {
  const m = raceModel(mode);
  const ex = explore(m);
  // The unchecked model counts schedules of all final states, including the corrupt ones.
  const p = raceProg(mode);
  const counts = countSchedules(machineModel(p, { outcome: outcomeOf(p) }));
  let total = 0, good = 0, deadlock = 0, corrupt = 0;
  for (const [o, n] of counts) {
    total += n;
    if (o === "deadlock") deadlock += n;
    else if (o.startsWith("ok")) good += n;
    else corrupt += n;
  }
  return { explored: ex, total, good, corrupt, deadlock, outcomes: [...counts.entries()], violation: ex.violation, stuck: ex.stuck };
}
