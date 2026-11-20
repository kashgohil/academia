/**
 * Lesson "race conditions".
 *
 * 1. Check-then-act programs on the step-level machine (src/sims/os/sync/machine.ts): a bank withdrawal, a lazy
 *    initialization, and a TOCTOU file-system attack. Each access is one atomic step, so these programs have no data
 *    race, and they still have a race condition.
 * 2. The race window: how often a check-then-act fires, from the shared Runtime, against the simple estimate.
 * 3. A happens-before race detector with vector clocks (the method of ThreadSanitizer and Go's -race), built into
 *    machine programs, so that the learner can step it and the explorer can count schedules.
 */
import { Runtime } from "../runtime";
import { BLOCK, countSchedules, explore, machineModel, type Ins, type MState, type Prog } from "../../os/sync/machine";

// ---------------------------------------------------------------- 1. check-then-act

export type CtaProgram =
  | "withdraw" | "withdraw-lock" | "withdraw-cas"
  | "lazy" | "lazy-once"
  | "toctou" | "toctou-nofollow";

export const CTA_LABELS: Record<CtaProgram, string> = {
  withdraw: "Withdraw: check, subtract",
  "withdraw-lock": "Withdraw: one lock",
  "withdraw-cas": "Withdraw: CAS loop",
  lazy: "Lazy init: if nil, create",
  "lazy-once": "Lazy init: sync.Once",
  toctou: "TOCTOU: access, open",
  "toctou-nofollow": "TOCTOU: O_NOFOLLOW, fstat",
};

const lock = (m: string): Ins => ({
  text: `lock(${m})`,
  run(c) {
    if (c.mem[m]) return BLOCK;
    c.mem[m] = 1;
    c.say(`takes ${m}`);
  },
});
const unlock = (m: string): Ins => ({ text: `unlock(${m})`, run(c) { c.mem[m] = 0; c.say(`releases ${m}`); } });

function withdrawThread(variant: "plain" | "lock" | "cas", t: number): Ins[] {
  const check: Ins = {
    label: "check",
    text: variant === "cas" ? "old = balance" : "if balance < 80: refuse",
    kind: variant === "lock" ? "cs" : "user",
    run(c) {
      const b = c.load("balance");
      c.r.old = b;
      if (b < 80) { c.say(`reads balance = ${b}: refuses`); c.mem[`paid${t}`] = 0; return "end"; }
      c.say(`reads balance = ${b}: enough money`);
    },
  };
  if (variant === "cas") {
    return [
      check,
      {
        text: "CAS(balance, old, old - 80)",
        sync: true,
        run(c) {
          const cur = c.mem.balance!;
          if (cur !== c.r.old) { c.say(`CAS fails: balance is ${cur}, not ${c.r.old}. Try again.`); return "check"; }
          c.mem.balance = cur - 80;
          c.mem[`paid${t}`] = 1;
          c.say(`CAS succeeds: balance = ${c.mem.balance}. Pays 80.`);
        },
      },
    ];
  }
  const act: Ins = {
    text: "balance -= 80  (atomic)",
    kind: variant === "lock" ? "cs" : "user",
    sync: true,
    run(c) {
      c.mem.balance = c.mem.balance! - 80;
      c.mem[`paid${t}`] = 1;
      c.say(`subtracts 80: balance = ${c.mem.balance}. Pays 80.`);
    },
  };
  return variant === "lock" ? [lock("m"), check, act, unlock("m")] : [check, act];
}

function lazyThread(once: boolean): Ins[] {
  if (once) {
    return [
      {
        text: "once.Do(create)",
        run(c) {
          if (c.mem.once === 2) { c.r.cfg = c.mem.cfg!; c.say(`init is done: uses config #${c.mem.cfg}`); return; }
          if (c.mem.once === 1) return BLOCK; // another thread runs create: wait for it
          c.mem.once = 1;
          c.say("runs create; other callers wait");
        },
      },
      {
        text: "  create (inside Do)",
        kind: "cs",
        run(c) {
          if (c.r.cfg) return "end";
          c.mem.made = c.mem.made! + 1;
          c.mem.cfg = c.mem.made!;
          c.mem.once = 2;
          c.r.cfg = c.mem.cfg;
          c.say(`creates config #${c.mem.cfg}`);
        },
      },
    ];
  }
  return [
    {
      text: "if cfg == nil:",
      run(c) {
        const v = c.load("cfg");
        if (v) { c.r.cfg = v; c.say(`cfg is #${v}: uses it`); return "end"; }
        c.say("cfg is nil: will create it");
      },
    },
    {
      text: "  cfg = create()",
      run(c) {
        c.mem.made = c.mem.made! + 1;
        c.store("cfg", c.mem.made!);
        c.r.cfg = c.mem.made!;
        c.say(`creates config #${c.mem.made} and stores it`);
      },
    },
  ];
}

/** File kinds in the TOCTOU model. */
export const FILE_KIND = ["the user's own file", "missing", "a symlink to /etc/passwd"] as const;

function toctouVictim(nofollow: boolean): Ins[] {
  if (nofollow) {
    return [
      {
        text: "fd = open(path, O_WRONLY|O_NOFOLLOW)",
        run(c) {
          const k = c.mem.file!;
          if (k === 1) { c.say("ENOENT: no file, stops"); c.mem.result = 1; return "end"; }
          if (k === 2) { c.say("ELOOP: the path is a symlink, stops"); c.mem.result = 1; return "end"; }
          c.r.fd = 1;
          c.say("opens the user's file");
        },
      },
      { text: "fstat(fd): owner is the user?", run(c) { c.say("checks the open file itself: owner is the user"); } },
      { text: "write(fd, report)", run(c) { c.mem.result = 2; c.say("writes the user's file"); } },
    ];
  }
  return [
    {
      text: "access(path, W_OK)",
      run(c) {
        const k = c.mem.file!;
        if (k === 1) { c.say("ENOENT: stops"); c.mem.result = 1; return "end"; }
        if (k === 2) { c.say("EACCES: the user cannot write /etc/passwd, stops"); c.mem.result = 1; return "end"; }
        c.say("OK: the real user can write this file");
      },
    },
    {
      text: "fd = open(path, O_WRONLY)",
      run(c) {
        const k = c.mem.file!;
        if (k === 1) { c.say("ENOENT: stops"); c.mem.result = 1; return "end"; }
        c.r.target = k;
        c.say(k === 2 ? "follows the symlink and opens /etc/passwd as root" : "opens the user's file");
      },
    },
    {
      text: "write(fd, report)",
      run(c) {
        c.mem.result = c.r.target === 2 ? 3 : 2;
        c.say(c.r.target === 2 ? "writes into /etc/passwd" : "writes the user's file");
      },
    },
  ];
}

const toctouAttacker: Ins[] = [
  { text: "unlink(path)", run(c) { c.mem.file = 1; c.say("removes the file"); } },
  { text: "symlink(\"/etc/passwd\", path)", run(c) { c.mem.file = 2; c.say("puts a symlink in its place"); } },
];

export function ctaProg(p: CtaProgram): Prog {
  switch (p) {
    case "withdraw":
    case "withdraw-lock":
    case "withdraw-cas": {
      const v = p === "withdraw" ? "plain" : p === "withdraw-lock" ? "lock" : "cas";
      return { name: p, threads: [withdrawThread(v, 0), withdrawThread(v, 1)], mem: { balance: 100, m: 0, paid0: 0, paid1: 0 } };
    }
    case "lazy":
    case "lazy-once":
      return { name: p, threads: [lazyThread(p === "lazy-once"), lazyThread(p === "lazy-once")], mem: { cfg: 0, made: 0, once: 0 } };
    case "toctou":
    case "toctou-nofollow":
      return { name: p, threads: [toctouVictim(p === "toctou-nofollow"), toctouAttacker], mem: { file: 0, result: 0 }, names: ["root", "attacker"] };
  }
}

/** The outcome of a finished run, and whether it is a bug. */
export function ctaOutcome(p: CtaProgram, s: MState): { text: string; bad: boolean } {
  if (p.startsWith("withdraw")) {
    const paid = s.mem.paid0! + s.mem.paid1!;
    return { text: `paid ${paid} × 80, balance ${s.mem.balance}`, bad: s.mem.balance! < 0 };
  }
  if (p.startsWith("lazy")) {
    const same = s.th[0]!.r.cfg === s.th[1]!.r.cfg;
    return { text: `created ${s.mem.made} config${s.mem.made === 1 ? "" : "s"}${same ? "" : ", threads use different ones"}`, bad: s.mem.made! > 1 };
  }
  const r = s.mem.result!;
  return { text: r === 3 ? "root wrote /etc/passwd" : r === 2 ? "wrote the user's file" : "stopped safely", bad: r === 3 };
}

export function ctaCounts(p: CtaProgram) {
  const by = countSchedules(machineModel(ctaProg(p), { outcome: (s) => (ctaOutcome(p, s).bad ? "bad" : "ok") }));
  const bad = by.get("bad") ?? 0, ok = by.get("ok") ?? 0;
  return { total: bad + ok, bad };
}

/** The shortest schedule that ends in the bug, if one exists. */
export function ctaBugSchedule(p: CtaProgram): string[] | null {
  const prog = ctaProg(p);
  const m = machineModel(prog, { check: (s) => (s.th.every((_, t) => s.th[t]!.pc >= prog.threads[t]!.length) && ctaOutcome(p, s).bad ? "bug" : null) });
  return explore(m).violation?.schedule ?? null;
}

// ---------------------------------------------------------------- 2. the race window

export interface WindowParams {
  /** Threads that run the same check-then-act. */
  threads: number;
  cores: number;
  /** Time from the check to the act, in ns: the window. */
  windowNs: number;
  /** Mean time between two operations of one thread (other work), in ns. Exponential. */
  thinkNs: number;
  /** Operations per thread. */
  ops: number;
  seed: number;
  /** Preemption quantum when threads share cores (model input). */
  quantumNs?: number;
}

/** The default quantum for the window model: a model input of the order of a Linux time slice. */
export const WINDOW_QUANTUM_NS = 1_000_000;

/**
 * Runs `threads` threads that each do `ops` times: other work (exponential, mean thinkNs), then check-then-act on a
 * shared counter: read it, hold it for windowNs, write read + 1. `fired` counts the operations where another write
 * landed inside the window, and `p` is their fraction. `lost` counts the lost increments: on one core, one firing can
 * lose a whole time slice of the other thread's increments.
 */
export function windowRun(p: WindowParams): { fired: number; lost: number; total: number; p: number; makespan: number } {
  const rt = new Runtime({ cores: p.cores, seed: p.seed, record: false });
  const q = p.quantumNs ?? WINDOW_QUANTUM_NS;
  const timeShared = p.threads > p.cores;
  let x = 0, version = 0, fired = 0;
  for (let i = 0; i < p.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      // A timer interrupt: when a thread has run for q since it got its core, it goes to the back of the run queue,
      // even in the middle of the window.
      let used = 0;
      const run = function* (ns: number) {
        while (timeShared && used + ns >= q) {
          yield* t.work(q - used);
          ns -= q - used;
          used = 0;
          yield* t.yieldNow();
        }
        used += ns;
        yield* t.work(ns);
      };
      for (let k = 0; k < p.ops; k++) {
        yield* run(-Math.log(1 - t.rand()) * p.thinkNs);
        const r = x, v = version; // check
        yield* run(p.windowNs); // the window
        if (version !== v) fired++; // another write landed in the window
        x = r + 1; // act
        version++;
      }
    });
  }
  const res = rt.run();
  const total = p.threads * p.ops;
  return { fired, lost: total - x, total, p: fired / total, makespan: res.makespan };
}

/**
 * The simple estimate of the chance that one operation loses its update. With threads on their own cores, another
 * thread's write lands in my window with a chance of about (n − 1) × w / (T + w). On one core, the window breaks only
 * when the quantum ends inside it: about w / q.
 */
export function windowEstimate(threads: number, cores: number, windowNs: number, thinkNs: number, quantumNs = WINDOW_QUANTUM_NS) {
  if (threads < 2) return 0;
  if (cores === 1) return Math.min(1, windowNs / quantumNs);
  return Math.min(1, ((Math.min(threads, cores) - 1) * windowNs) / (thinkNs + windowNs));
}

/** The chance that a test of n operations sees the race at least once. */
export const chanceToSee = (p: number, n: number) => 1 - Math.pow(1 - p, n);

/** Operations needed to see the race with a chance of `q` (0.99: 99%). */
export const opsToSee = (p: number, q = 0.99) => (p <= 0 ? Infinity : Math.ceil(Math.log(1 - q) / Math.log(1 - p)));

// ---------------------------------------------------------------- 3. a vector-clock race detector

export type HbProgram = "both-lock" | "one-forgets" | "flag-plain" | "flag-release";

export const HB_LABELS: Record<HbProgram, string> = {
  "both-lock": "Counter: both threads lock",
  "one-forgets": "Counter: T1 forgets the lock",
  "flag-plain": "Publish: plain flag",
  "flag-release": "Publish: release/acquire flag",
};

/** Variables that the detector watches, by program. */
export const HB_VARS: Record<HbProgram, string[]> = {
  "both-lock": ["x"],
  "one-forgets": ["x"],
  "flag-plain": ["data", "done"],
  "flag-release": ["data"],
};

/** Synchronization objects that carry a clock, by program. */
export const HB_SYNC: Record<HbProgram, string[]> = {
  "both-lock": ["m"],
  "one-forgets": ["m"],
  "flag-plain": [],
  "flag-release": ["done"],
};

/**
 * The detector state lives in machine memory, so the stepper shows it and the explorer counts it:
 * - `C<t>.<u>`: the vector clock of thread t (its entry for thread u). Thread t starts with C<t>.<t> = 1.
 * - `L<o>.<u>`: the clock of a lock or atomic flag o, set by a release and joined by an acquire.
 * - `W<x>.c`, `W<x>.t`: the last write to x as an epoch c@t (t = −1: none).
 * - `R<x>.<u>`: the clock entry of the last read of x by thread u (0: none).
 * - `race`: the number of races found. `race.<x>`: 1 if x raced.
 */
const N = 2;
const C = (t: number, u: number) => `C${t}.${u}`;

function initClocks(mem: Record<string, number>, vars: string[], sync: string[]) {
  for (let t = 0; t < N; t++) for (let u = 0; u < N; u++) mem[C(t, u)] = t === u ? 1 : 0;
  for (const o of sync) for (let u = 0; u < N; u++) mem[`L${o}.${u}`] = 0;
  for (const x of vars) {
    mem[`W${x}.c`] = 0;
    mem[`W${x}.t`] = -1;
    for (let u = 0; u < N; u++) mem[`R${x}.${u}`] = 0;
    mem[`race.${x}`] = 0;
  }
  mem.race = 0;
}

type Mem = Record<string, number>;

function raceOn(mem: Mem, x: string): void {
  mem.race = mem.race! + 1;
  mem[`race.${x}`] = 1;
}

/** Detector check for a read of x by thread t. Returns a description of a race, or "". */
export function hbRead(mem: Mem, t: number, x: string): string {
  const wt = mem[`W${x}.t`]!, wc = mem[`W${x}.c`]!;
  let msg = "";
  if (wt >= 0 && wt !== t && wc > mem[C(t, wt)]!) {
    raceOn(mem, x);
    msg = `RACE: the write ${wc}@T${wt} to ${x} does not happen before this read (T${t} knows T${wt} only up to ${mem[C(t, wt)]})`;
  }
  mem[`R${x}.${t}`] = mem[C(t, t)]!;
  return msg;
}

/** Detector check for a write of x by thread t. */
export function hbWrite(mem: Mem, t: number, x: string): string {
  const wt = mem[`W${x}.t`]!, wc = mem[`W${x}.c`]!;
  let msg = "";
  if (wt >= 0 && wt !== t && wc > mem[C(t, wt)]!) msg = `RACE: the write ${wc}@T${wt} to ${x} does not happen before this write`;
  for (let u = 0; u < N && !msg; u++) {
    const r = mem[`R${x}.${u}`]!;
    if (u !== t && r > mem[C(t, u)]!) msg = `RACE: the read ${r}@T${u} of ${x} does not happen before this write`;
  }
  if (msg) raceOn(mem, x);
  mem[`W${x}.c`] = mem[C(t, t)]!;
  mem[`W${x}.t`] = t;
  return msg;
}

/** Release: the object takes the thread's clock, then the thread starts a new epoch. */
export function hbRelease(mem: Mem, t: number, o: string) {
  for (let u = 0; u < N; u++) mem[`L${o}.${u}`] = mem[C(t, u)]!;
  mem[C(t, t)] = mem[C(t, t)]! + 1;
}

/** Acquire: the thread's clock becomes the element-wise maximum of its clock and the object's clock. */
export function hbAcquire(mem: Mem, t: number, o: string) {
  for (let u = 0; u < N; u++) mem[C(t, u)] = Math.max(mem[C(t, u)]!, mem[`L${o}.${u}`]!);
}

const say = (c: { say(m: string): void }, base: string, race: string) => c.say(race || base);

function hbLock(t: number): Ins {
  return {
    text: "lock(m)",
    run(c) {
      if (c.mem.m) return BLOCK;
      c.mem.m = 1;
      hbAcquire(c.mem, t, "m");
      c.say(`acquires m: C${t} = max(C${t}, L(m)) = [${c.mem[C(t, 0)]}, ${c.mem[C(t, 1)]}]`);
    },
  };
}
function hbUnlock(t: number): Ins {
  return {
    text: "unlock(m)",
    run(c) {
      c.mem.m = 0;
      hbRelease(c.mem, t, "m");
      c.say(`releases m: L(m) takes T${t}'s clock, and T${t} starts epoch ${c.mem[C(t, t)]}`);
    },
  };
}
function hbIncr(t: number, inCs: boolean): Ins[] {
  return [
    { text: "r = x", kind: inCs ? "cs" : "user", run(c) { c.r.r = c.mem.x!; say(c, `reads x = ${c.r.r}`, hbRead(c.mem, t, "x")); } },
    { text: "x = r + 1", kind: inCs ? "cs" : "user", run(c) { c.mem.x = c.r.r! + 1; say(c, `writes x = ${c.mem.x}`, hbWrite(c.mem, t, "x")); } },
  ];
}

export function hbProg(p: HbProgram): Prog {
  const mem: Mem = {};
  initClocks(mem, HB_VARS[p], HB_SYNC[p]);
  if (p === "both-lock" || p === "one-forgets") {
    mem.x = 0;
    mem.m = 0;
    const locked = (t: number) => [hbLock(t), ...hbIncr(t, true), hbUnlock(t)];
    return { name: p, threads: [locked(0), p === "both-lock" ? locked(1) : hbIncr(1, false)], mem };
  }
  const atomic = p === "flag-release";
  mem.data = 0;
  mem.done = 0;
  const writer: Ins[] = [
    { text: "data = 42", run(c) { c.mem.data = 42; say(c, "writes data = 42", hbWrite(c.mem, 0, "data")); } },
    {
      text: atomic ? "done.store(1, release)" : "done = 1",
      run(c) {
        c.mem.done = 1;
        if (atomic) { hbRelease(c.mem, 0, "done"); c.say("release store: L(done) takes T0's clock"); }
        else say(c, "writes done = 1 (plain)", hbWrite(c.mem, 0, "done"));
      },
    },
  ];
  const reader: Ins[] = [
    {
      text: atomic ? "wait until done.load(acquire) == 1" : "wait until done == 1",
      run(c) {
        if (c.mem.done !== 1) return BLOCK;
        if (atomic) { hbAcquire(c.mem, 1, "done"); c.say(`acquire load sees 1: C1 = [${c.mem[C(1, 0)]}, ${c.mem[C(1, 1)]}]`); }
        else say(c, "reads done = 1 (plain)", hbRead(c.mem, 1, "done"));
      },
    },
    { text: "r = data", run(c) { c.r.r = c.mem.data!; say(c, `reads data = ${c.r.r}`, hbRead(c.mem, 1, "data")); } },
  ];
  return { name: p, threads: [writer, reader], mem };
}

/** For each complete schedule: is the result wrong, and did the detector report a race? */
export function hbCounts(p: HbProgram) {
  const prog = hbProg(p);
  const wrong = (s: MState) => (p === "both-lock" || p === "one-forgets" ? s.mem.x !== 2 : s.th[1]!.r.r !== 42);
  const by = countSchedules(machineModel(prog, { outcome: (s) => `${wrong(s) ? "wrong" : "right"}|${s.mem.race! > 0 ? "race" : "clean"}` }));
  let total = 0, wrongN = 0, raced = 0;
  for (const [k, n] of by) {
    total += n;
    if (k.startsWith("wrong")) wrongN += n;
    if (k.endsWith("race")) raced += n;
  }
  return { total, wrong: wrongN, raced };
}
