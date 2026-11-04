/** Scenarios, scripted schedules and stress configurations for the lock-free lessons. */
import type { Scenario } from "../sims/lockfree/scenario";
import type { Script } from "./LockFreeStepper";
import type { StressConfig } from "./LockFreeStress";

const push = (v: number) => ({ kind: "push", v }) as const;
const pop = { kind: "pop" } as const;
const enq = (v: number) => ({ kind: "enq", v }) as const;
const deq = { kind: "deq" } as const;

export const STACK_RACE: Scenario = { kind: "stack", initial: [1, 2, 3], threads: [[push(4)], [pop]] };
export const STACK_RACE_SCRIPTS: Script[] = [
  { label: "T1 pops between T0's load and CAS", steps: [[0, { before: "CAS" }], [1, "done"], [0, "done"]] },
];

export const ABA: Scenario = { kind: "stack", initial: [1, 2, 3], threads: [[pop], [pop, pop, push(7), push(8)]] };
export const ABA_SCRIPTS: Script[] = [
  { label: "Play the ABA schedule", steps: [[0, { before: "CAS" }], [1, "done"], [0, "done"]] },
];

export const HP: Scenario = { kind: "stack", initial: [1, 2, 3], threads: [[pop], [pop, pop]] };
export const HP_SCRIPTS: Script[] = [
  { label: "T1 pops and frees while T0 holds A", steps: [[0, { before: "read A.next" }], [1, "done"], [0, "done"]] },
];

export const EBR: Scenario = { kind: "stack", initial: [1, 2, 3, 4], threads: [[pop], [pop, pop, pop]] };
export const EBR_SCRIPTS: Script[] = [
  { label: "T0 pinned while T1 retires three nodes", steps: [[0, { before: "read A.next" }], [1, "done"], [0, "done"]] },
];

export const MSQ: Scenario = { kind: "queue", initial: [1], threads: [[enq(10)], [enq(20)], [deq, deq]] };
export const MSQ_SCRIPTS: Script[] = [
  { label: "T0 links its node, then stalls before swinging tail", steps: [[0, { before: "swing tail" }], [1, "done"], [0, "done"], [2, "done"]] },
];

const STACK_MIX: Scenario = { kind: "stack", initial: [1, 2, 3], threads: [[pop, push(10), pop], [pop, pop, push(20), push(21)], [push(30), pop]] };
const QUEUE_MIX: Scenario = { kind: "queue", initial: [1, 2], threads: [[deq, enq(10), deq], [enq(20), deq, enq(21)], [deq, enq(30)]] };

export const STRESS_ABA: StressConfig[] = [
  { label: "Stack · free immediately", scenario: STACK_MIX, scheme: "immediate", tags: false },
  { label: "Stack · free immediately + tags", scenario: STACK_MIX, scheme: "immediate", tags: true },
  { label: "Stack · never free", scenario: STACK_MIX, scheme: "leak", tags: false },
];

export const STRESS_HP: StressConfig[] = [
  { label: "Stack · free immediately + tags", scenario: STACK_MIX, scheme: "immediate", tags: true },
  { label: "Stack · hazard pointers", scenario: STACK_MIX, scheme: "hazard", tags: false },
  { label: "Queue · free immediately", scenario: QUEUE_MIX, scheme: "immediate", tags: false },
  { label: "Queue · hazard pointers", scenario: QUEUE_MIX, scheme: "hazard", tags: false },
];

export const STRESS_EBR: StressConfig[] = [
  { label: "Stack · epoch-based", scenario: STACK_MIX, scheme: "epoch", tags: false },
  { label: "Queue · epoch-based", scenario: QUEUE_MIX, scheme: "epoch", tags: false },
  { label: "Queue · free immediately", scenario: QUEUE_MIX, scheme: "immediate", tags: false },
];

export const STRESS_MSQ: StressConfig[] = [
  { label: "Queue · never free", scenario: QUEUE_MIX, scheme: "leak", tags: false },
  { label: "Queue · hazard pointers", scenario: QUEUE_MIX, scheme: "hazard", tags: false },
  { label: "Queue · epoch-based", scenario: QUEUE_MIX, scheme: "epoch", tags: false },
];
