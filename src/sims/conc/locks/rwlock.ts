/**
 * Reader-writer lock models for the "reader-writer-locks" lesson.
 *
 * - goRwProg: Go's sync.RWMutex as single atomic steps on the interleaving machine (src/sims/os/sync/machine.ts):
 *   readerCount, readerWait, the writer mutex w and the two semaphores. A pending writer subtracts 2³⁰ from
 *   readerCount, so a new RLock sees a negative count and sleeps. With `recursive`, reader R1 takes a second read lock
 *   while it holds the first one, which Go's documentation prohibits: the explorer finds the deadlock.
 *   With `policy: "reader"`, RLock ignores a pending writer (the glibc default), so the recursive read cannot deadlock.
 * - seqlockProg: a seqlock with one writer and one reader, with or without the reader's sequence check.
 * - rwLoop: readers and a writer on the shared Runtime, under reader, writer or fair preference, or a plain mutex.
 */
import { BLOCK, machineModel, explore, type Ins, type Prog, type Explored } from "../../os/sync/machine";
import { Runtime, type RunResult } from "../index";

/** Go's rwmutexMaxReaders. */
export const MAX_READERS = 2 ** 30;

/** readerCount as Go programmers read it: "2 − 2³⁰" when a writer is pending. */
export function showCount(c: number): string {
  if (c >= 0) return String(c);
  const r = c + MAX_READERS;
  return r === 0 ? "−2³⁰" : r > 0 ? `${r} − 2³⁰` : `−2³⁰ − ${-r}`;
}

const semacquire = (sem: string, text: string): Ins => ({
  text,
  kind: "sleep",
  run(c) {
    if (!c.r.need) return; // the condition was false: no wait
    if ((c.mem[sem] ?? 0) <= 0) return BLOCK;
    c.mem[sem] = c.mem[sem]! - 1;
    delete c.r.need;
    c.say(`wakes: takes a token from ${sem}`);
  },
});

function rlock(policy: "go" | "reader", nth: string): Ins[] {
  return [
    {
      text: `RLock${nth}: r = readerCount.Add(1)`,
      run(c) {
        c.mem.readerCount = c.mem.readerCount! + 1;
        c.r.r = c.mem.readerCount;
        if (policy === "go" && c.r.r < 0) {
          c.r.need = 1;
          c.say(`readerCount is ${showCount(c.mem.readerCount)} < 0: a writer is pending, so this reader must sleep`);
        } else if (policy === "reader" && c.mem.wActive) {
          c.r.need = 1;
          c.say("a writer holds the lock: this reader must sleep");
        } else c.say(`readerCount = ${showCount(c.mem.readerCount)}: read lock taken`);
      },
    },
    semacquire("readerSem", "  if r < 0: sleep on readerSem"),
  ];
}

function runlock(nth: string): Ins[] {
  return [
    {
      text: `RUnlock${nth}: r = readerCount.Add(−1)`,
      run(c) {
        c.mem.readerCount = c.mem.readerCount! - 1;
        c.r.r = c.mem.readerCount;
        if (c.r.r < 0) {
          c.mem.readerWait = c.mem.readerWait! - 1;
          if (c.mem.readerWait === 0) {
            c.mem.writerSem = c.mem.writerSem! + 1;
            c.say("a writer is pending and this was the last old reader: release writerSem");
          } else c.say(`a writer is pending: readerWait = ${c.mem.readerWait}`);
        } else c.say(`readerCount = ${c.mem.readerCount}`);
      },
    },
  ];
}

export interface GoRwOpts {
  recursive: boolean;
  policy: "go" | "reader";
}

/** R1 reads (twice if recursive), W writes once, R2 reads once. */
export function goRwProg({ recursive, policy }: GoRwOpts): Prog {
  const read = (who: string): Ins => ({ text: `read the data`, kind: "cs", run(c) { c.say(`${who} reads`); } });
  const r1: Ins[] = recursive
    ? [...rlock(policy, ""), read("R1"), ...rlock(policy, " again"), read("R1"), ...runlock(""), ...runlock("")]
    : [...rlock(policy, ""), read("R1"), ...runlock("")];
  const r2: Ins[] = [...rlock(policy, ""), read("R2"), ...runlock("")];
  const w: Ins[] =
    policy === "go"
      ? [
          { text: "Lock: w.Lock()", run(c) { if (c.mem.w) return BLOCK; c.mem.w = 1; c.say("takes the writer mutex w"); } },
          {
            text: "  r = readerCount.Add(−2³⁰) + 2³⁰",
            run(c) {
              c.mem.readerCount = c.mem.readerCount! - MAX_READERS;
              c.r.r = c.mem.readerCount + MAX_READERS;
              c.say(`announces a pending writer; ${c.r.r} reader${c.r.r === 1 ? "" : "s"} still inside`);
            },
          },
          {
            text: "  if r ≠ 0: readerWait.Add(r)",
            run(c) {
              if (c.r.r !== 0) {
                c.mem.readerWait = c.mem.readerWait! + c.r.r!;
                if (c.mem.readerWait !== 0) c.r.need = 1;
                c.say(`readerWait = ${c.mem.readerWait}: wait for ${c.mem.readerWait} reader(s) to leave`);
              }
            },
          },
          semacquire("writerSem", "  if waiting: sleep on writerSem"),
          { text: "write the data", kind: "cs", run(c) { c.say("W writes"); } },
          {
            text: "Unlock: r = readerCount.Add(2³⁰)",
            run(c) {
              c.mem.readerCount = c.mem.readerCount! + MAX_READERS;
              c.r.r = c.mem.readerCount;
              c.mem.readerSem = c.mem.readerSem! + c.r.r;
              c.say(`no writer now; wakes the ${c.r.r} reader(s) that sleep on readerSem`);
            },
          },
          { text: "  w.Unlock()", run(c) { c.mem.w = 0; } },
        ]
      : [
          // Reader preference: the writer waits until no reader is inside, and it never blocks new readers.
          {
            text: "wrlock: wait until readerCount = 0",
            kind: "sleep",
            run(c) {
              if (c.mem.readerCount !== 0 || c.mem.wActive) return BLOCK;
              c.mem.wActive = 1;
              c.say("no reader inside: the writer enters");
            },
          },
          { text: "write the data", kind: "cs", run(c) { c.say("W writes"); } },
          {
            text: "unlock: wake sleeping readers",
            run(c) {
              c.mem.wActive = 0;
              c.mem.readerSem = c.mem.readerSem! + 2;
            },
          },
        ];
  return {
    name: `go-rwmutex-${policy}-${recursive ? "rec" : "plain"}`,
    threads: [r1, w, r2],
    names: ["R1", "W", "R2"],
    mem: { readerCount: 0, readerWait: 0, readerSem: 0, writerSem: 0, w: 0, wActive: 0 },
  };
}

/** Exhaustive search over all schedules: does any schedule get stuck? */
export function exploreGoRw(opts: GoRwOpts): Explored {
  // readerSem tokens left over after the run are not part of the problem; the key is the full state.
  return explore(machineModel(goRwProg(opts)));
}

// ---------------------------------------------------------------- seqlock

export interface SeqOpts {
  /** The reader compares the sequence before and after, and retries. */
  check: boolean;
}

/** The writer stores (1, 1) and then (2, 2), each inside seq++ … seq++. The reader must never see x ≠ y. */
export function seqlockProg({ check }: SeqOpts): Prog {
  const writeOnce = (v: number): Ins[] => [
    { text: `seq++  (now odd: write in progress)`, run(c) { c.mem.seq = c.mem.seq! + 1; } },
    { text: `x = ${v}`, kind: "cs", run(c) { c.mem.x = v; } },
    { text: `y = ${v}`, kind: "cs", run(c) { c.mem.y = v; } },
    { text: `seq++  (even again)`, run(c) { c.mem.seq = c.mem.seq! + 1; } },
  ];
  const reader: Ins[] = [
    { label: "top", text: "s1 = seq", run(c) { c.r.s1 = c.mem.seq!; } },
    ...(check ? [{ text: "if s1 is odd: retry", run(c: Parameters<Ins["run"]>[0]) { if (c.r.s1! % 2 === 1) { c.count("retries"); c.say("a write is in progress: retry"); return "top"; } } } as Ins] : []),
    { text: "a = x", run(c) { c.r.a = c.mem.x!; } },
    { text: "b = y", run(c) { c.r.b = c.mem.y!; } },
    ...(check
      ? [{ text: "if seq ≠ s1: retry", run(c: Parameters<Ins["run"]>[0]) { if (c.mem.seq !== c.r.s1) { c.count("retries"); c.say("a write happened during the read: retry"); return "top"; } } } as Ins]
      : []),
    {
      text: "use (a, b)",
      run(c) {
        if (c.r.a !== c.r.b) c.fail(`Torn read: the reader got a = ${c.r.a} and b = ${c.r.b}, a pair that never existed.`);
        else c.say(`the reader got a consistent pair (${c.r.a}, ${c.r.b})`);
      },
    },
  ];
  return { name: `seqlock-${check}`, threads: [[...writeOnce(1), ...writeOnce(2)], reader], names: ["writer", "reader"], mem: { seq: 0, x: 0, y: 0 } };
}

export function exploreSeqlock(opts: SeqOpts): Explored {
  return explore(machineModel(seqlockProg(opts), { outcome: (s) => `(${s.th[1]!.r.a}, ${s.th[1]!.r.b})` }));
}

// ---------------------------------------------------------------- policies on the Runtime

export type RwPolicy = "reader" | "writer" | "fair" | "mutex";

export interface RwSpec {
  readers: number;
  cores: number;
  /** Read section (ns). */
  readNs: number;
  /** Mean think time of a reader between reads (ns), drawn from 0.5x to 1.5x. */
  thinkNs: number;
  /** Write section (ns). */
  writeNs: number;
  /** The writer wants the lock every `writeEveryNs`. */
  writeEveryNs: number;
  policy: RwPolicy;
  durationNs: number;
  seed: number;
  record: boolean;
}

export const RW_DEFAULTS: RwSpec = {
  readers: 6, cores: 8, readNs: 4_000, thinkNs: 1_000, writeNs: 2_000, writeEveryNs: 20_000, policy: "reader", durationNs: 200_000, seed: 1, record: true,
};

export interface RwResult {
  result: RunResult;
  reads: number;
  writes: number;
  /** Writes the writer wanted but had not done by the end. */
  writesWanted: number;
  readsPerMs: number;
  meanReadWaitNs: number;
  maxReadWaitNs: number;
  meanWriteWaitNs: number;
  maxWriteWaitNs: number;
}

export function rwLoop(spec: Partial<RwSpec> = {}): RwResult {
  const s = { ...RW_DEFAULTS, ...spec };
  const rt = new Runtime({ cores: s.cores, seed: s.seed, record: s.record });
  const rw = rt.rwlock("rw", { prefer: s.policy === "mutex" ? "fair" : s.policy });
  const m = rt.mutex("m");
  const readWaits: number[] = [], writeWaits: number[] = [];
  let pending: number | undefined;
  for (let i = 0; i < s.readers; i++) {
    rt.spawn(`R${i}`, function* (t) {
      yield* t.work(t.rand() * s.thinkNs, "think");
      for (;;) {
        const from = t.now();
        if (s.policy === "mutex") yield* t.lock(m);
        else yield* t.rlock(rw);
        readWaits.push(t.now() - from);
        yield* t.work(s.readNs, "read");
        if (s.policy === "mutex") t.unlock(m);
        else t.runlock(rw);
        yield* t.sleep(s.thinkNs * (0.5 + t.rand()));
      }
    });
  }
  let wanted = 0;
  rt.spawn("W", function* (t) {
    // Writes are due at 0.5, 1.5, 2.5, ... times writeEveryNs. A late writer does the next one at once.
    for (let k = 0; ; k++) {
      const due = (k + 0.5) * s.writeEveryNs;
      if (t.now() < due) yield* t.sleep(due - t.now());
      wanted++;
      const from = t.now();
      pending = from;
      if (s.policy === "mutex") yield* t.lock(m);
      else yield* t.wlock(rw);
      pending = undefined;
      writeWaits.push(t.now() - from);
      yield* t.work(s.writeNs, "write");
      if (s.policy === "mutex") t.unlock(m);
      else t.wunlock(rw);
    }
  });
  const result = rt.run({ untilNs: s.durationNs });
  if (pending !== undefined) writeWaits.push(result.now - pending);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    result,
    reads: readWaits.length,
    writes: writeWaits.length - (pending !== undefined ? 1 : 0),
    writesWanted: wanted,
    readsPerMs: readWaits.length / (s.durationNs / 1e6),
    meanReadWaitNs: mean(readWaits),
    maxReadWaitNs: Math.max(0, ...readWaits),
    meanWriteWaitNs: mean(writeWaits),
    maxWriteWaitNs: Math.max(0, ...writeWaits),
  };
}
