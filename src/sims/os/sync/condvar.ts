/**
 * Condition variables on the interleaving machine.
 *
 * wait(cv, m) has three steps here. It releases m and joins the cv queue (one atomic step), it sleeps
 * until a notifier or a spurious wakeup removes it, and it takes m again.
 *
 * Variants: `if` or `while`; signal or broadcast; Mesa or Hoare handoff; spurious wakeups; a broken
 * non-atomic wait that unlocks and then joins the queue (the lost wakeup); and the futex sequence
 * condvar that Rust's standard library uses on Linux.
 */
import { BLOCK, explore, machineModel, mutualExclusion, type Ins, type Prog } from "./machine";

export type Guard = "if" | "while";
export type Notify = "signal" | "broadcast";
export type CvScenario = "consumers" | "bounded";

export interface CvOpts {
  guard: Guard;
  notify: Notify;
  /**
   * "consumers": 2 consumers and 2 producers, each with 1 item, and an unbounded queue.
   * "bounded": 2 consumers and 1 producer with 2 items, capacity 1, and ONE condvar for both directions.
   */
  scenario?: CvScenario;
  hoare?: boolean;
  spurious?: boolean;
  /** Broken wait: unlock first, then join the queue in a separate step. */
  nonAtomicWait?: boolean;
  consumers?: number;
  producers?: number;
}

const lockIns = (text = "lock(m)"): Ins => ({
  text,
  run(c) {
    if (c.mem.m === c.t + 1) { c.say("already owns m (handed over)"); return undefined; }
    if (c.mem.m !== 0) return BLOCK;
    c.mem.m = c.t + 1;
    c.say("takes m");
    return undefined;
  },
});
const unlockIns: Ins = { text: "unlock(m)", run(c) { c.mem.m = 0; c.say("releases m"); } };

function waitIns(o: CvOpts, retry: string | null): Ins[] {
  const out: Ins[] = [];
  if (o.nonAtomicWait) {
    out.push(
      { text: "unlock(m)", run(c) { c.mem.m = 0; c.say("releases m. It has not joined the queue yet."); } },
      { text: "join cv queue", run(c) { c.q("cv").push(c.t); c.count("sleeps"); c.say("joins the cv queue"); } },
    );
  } else {
    out.push({
      text: "wait: unlock(m) + join cv",
      run(c) {
        c.mem.m = 0;
        c.q("cv").push(c.t);
        c.count("sleeps");
        if (c.r.woken) c.count("resleeps");
        c.say("releases m and joins the cv queue in one atomic step");
      },
    });
  }
  out.push(
    {
      text: "(asleep on cv)",
      kind: "sleep",
      run(c) {
        const q = c.q("cv");
        const i = q.indexOf(c.t);
        if (i >= 0) {
          if (!o.spurious) return BLOCK;
          q.splice(i, 1);
          c.count("spurious");
          c.say("wakes with no notify: a spurious wakeup");
        } else c.say("was notified, so it wakes");
        c.count("wakeups");
        c.r.woken = 1;
        return undefined;
      },
    },
    lockIns("lock(m) again"),
  );
  if (retry) out.push({ text: "goto check", run() { return retry; } });
  return out;
}

function notifyIns(o: CvOpts): Ins[] {
  const signal: Ins = {
    text: o.notify === "signal" ? "signal(cv)" : "broadcast(cv)",
    run(c) {
      const q = c.q("cv");
      if (o.notify === "broadcast") {
        c.say(q.length ? `wakes ${q.length} waiter(s)` : "nobody waits");
        q.length = 0;
      } else {
        const w = q.shift();
        c.say(w === undefined ? "nobody waits: the signal is lost, by design" : `wakes thread ${w}`);
        if (o.hoare && w !== undefined) {
          c.mem.m = w + 1;
          c.r.gave = 1;
          c.say(`hands m to thread ${w} at once (Hoare)`);
        }
      }
    },
  };
  if (!o.hoare) return [signal];
  return [signal, { text: "lock(m) if handed over", run(c) {
    if (!c.r.gave) return undefined;
    if (c.mem.m !== 0) return BLOCK;
    c.mem.m = c.t + 1;
    c.r.gave = 0;
    return undefined;
  } }];
}

function consumer(o: CvOpts): Ins[] {
  const cap = o.scenario === "bounded";
  return [
    lockIns(),
    {
      label: "check",
      text: `${o.guard} count == 0: wait`,
      run(c) {
        const empty = c.mem.count === 0;
        c.say(`count = ${c.mem.count}`);
        return empty ? "wait" : "take";
      },
    },
    { ...waitIns(o, o.guard === "while" ? "check" : null)[0]!, label: "wait" },
    ...waitIns(o, o.guard === "while" ? "check" : null).slice(1),
    {
      label: "take",
      text: "count = count - 1",
      run(c) {
        if (c.mem.count === 0) { c.fail("Underflow: the thread took an item from an empty queue."); return undefined; }
        c.mem.count = c.mem.count! - 1;
        c.say(`takes an item: count = ${c.mem.count}`);
        return undefined;
      },
    },
    ...(cap ? notifyIns(o) : []),
    unlockIns,
  ];
}

function producer(o: CvOpts, items: number): Ins[] {
  const cap = o.scenario === "bounded";
  const code: Ins[] = [{ ...lockIns(), label: "start" }];
  if (cap) {
    code.push({
      label: "check",
      text: `${o.guard} count == 1: wait`,
      run(c) { c.say(`count = ${c.mem.count}`); return c.mem.count === 1 ? "wait" : "put"; },
    });
    const w = waitIns(o, o.guard === "while" ? "check" : null);
    code.push({ ...w[0]!, label: "wait" }, ...w.slice(1));
  }
  code.push({
    label: "put",
    text: "count = count + 1",
    run(c) {
      if (cap && c.mem.count! >= 1) { c.fail("Overflow: the thread wrote to a full buffer."); return undefined; }
      c.mem.count = c.mem.count! + 1;
      c.say(`adds an item: count = ${c.mem.count}`);
      return undefined;
    },
  });
  code.push(...notifyIns(o));
  code.push({
    ...unlockIns,
    run(c) {
      c.mem.m = 0;
      c.r.k = (c.r.k ?? 0) + 1;
      if (c.r.k < items) return "start";
      return undefined;
    },
  });
  return code;
}

export function condvarProg(o: CvOpts): Prog {
  const scenario = o.scenario ?? "consumers";
  const nc = o.consumers ?? 2;
  const np = o.producers ?? (scenario === "bounded" ? 1 : nc);
  const items = scenario === "bounded" ? nc : 1;
  const threads = [
    ...Array.from({ length: nc }, () => consumer({ ...o, scenario })),
    ...Array.from({ length: np }, () => producer({ ...o, scenario }, items)),
  ];
  return {
    name: `condvar-${o.guard}-${o.notify}`,
    threads,
    names: [...Array.from({ length: nc }, (_, i) => `C${i}`), ...Array.from({ length: np }, (_, i) => `P${i}`)],
    mem: { m: 0, count: 0 },
    queues: ["cv"],
  };
}

export function checkCondvar(o: CvOpts) {
  const p = condvarProg(o);
  return explore(machineModel(p));
}

// ---------------------------------------------------------------- a condvar on a futex word

/**
 * The sequence-counter condvar. wait reads seq, unlocks, then calls FUTEX_WAIT(seq, seen). A notify
 * adds 1 to seq and calls FUTEX_WAKE. If the notify runs between the unlock and the syscall, the value
 * check fails, so the waiter does not sleep. `check: false` removes that protection.
 */
export function futexCondvarProg(check: boolean): Prog {
  const consumer: Ins[] = [
    lockIns(),
    { label: "check", text: "while ready == 0:", run(c) { c.say(`ready = ${c.mem.ready}`); return c.mem.ready ? "take" : undefined; } },
    { text: "seen = seq", run(c) { c.r.seen = c.mem.seq!; c.say(`seen = ${c.r.seen}`); } },
    unlockIns,
    { text: "FUTEX_WAIT(seq, seen)", kind: "kernel", run(c) {
      if (check && c.mem.seq !== c.r.seen) { c.say(`seq = ${c.mem.seq}, not ${c.r.seen}, so EAGAIN`); return "relock"; }
      c.q("seq").push(c.t);
      c.say("joins the wait queue");
      return undefined;
    } },
    { text: "(asleep on seq)", kind: "sleep", run(c) { if (c.q("seq").includes(c.t)) return BLOCK; c.say("wakes"); return undefined; } },
    { ...lockIns("lock(m) again"), label: "relock" },
    { text: "goto check", run() { return "check"; } },
    { label: "take", text: "use the data", kind: "cs", run(c) { c.say("sees ready = 1"); } },
    unlockIns,
  ];
  const producer: Ins[] = [
    lockIns(),
    { text: "ready = 1", run(c) { c.mem.ready = 1; c.say("ready = 1"); } },
    unlockIns,
    { text: "seq = seq + 1", sync: true, run(c) { c.mem.seq = c.mem.seq! + 1; c.say(`seq = ${c.mem.seq}`); } },
    { text: "FUTEX_WAKE(seq, 1)", kind: "kernel", run(c) { const w = c.q("seq").shift(); c.say(w === undefined ? "nobody waits" : `wakes thread ${w}`); } },
  ];
  return { name: `futex-condvar-${check}`, threads: [consumer, producer], names: ["waiter", "notifier"], mem: { m: 0, ready: 0, seq: 0 }, queues: ["seq"] };
}

export function checkFutexCondvar(check: boolean) {
  const p = futexCondvarProg(check);
  return explore(machineModel(p, { check: mutualExclusion(p) }));
}

// ---------------------------------------------------------------- the thundering herd

export interface HerdResult { waiters: number; wakeups: number; resleeps: number; items: number; contextSwitches: number; cpuNs: number }

/** MODEL INPUT: CPU cost of one sleep or wake, as in the spin-versus-block model. */
export const HERD_SWITCH_NS = 2_000;

/**
 * `waiters` threads wait for items. Items arrive one at a time, and each arrival notifies the condvar.
 * Each woken thread takes the mutex and checks the condition. If no item is left, it sleeps again.
 */
export function simulateHerd(waiters: number, notify: Notify, switchNs = HERD_SWITCH_NS): HerdResult {
  let queue = waiters;
  let wakeups = 0;
  let resleeps = 0;
  for (let item = 0; item < waiters; item++) {
    const woken = notify === "signal" ? Math.min(1, queue) : queue;
    wakeups += woken;
    queue -= woken;
    // The first woken thread takes the item. Each other woken thread finds nothing and sleeps again.
    const again = woken - 1;
    resleeps += again;
    queue += again;
  }
  const contextSwitches = wakeups + resleeps;
  return { waiters, wakeups, resleeps, items: waiters, contextSwitches, cpuNs: contextSwitches * switchNs };
}
