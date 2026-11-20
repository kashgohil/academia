/**
 * Lesson "atomicity".
 *
 * 1. A transfer and an audit over two accounts on the step-level machine: an atomicity violation that needs no data
 *    race, and five ways to fix it (lock in both, packed word with one CAS, a seqlock, a copy-on-write snapshot).
 * 2. Torn multiword values: a Go interface (two words) and a Go slice header (three words) written by plain stores,
 *    against one atomic pointer to an immutable value.
 * 3. The cost of each fix under load, on the shared Runtime: a mutex, a reader-writer lock, a seqlock and
 *    copy-on-write with a pointer swap.
 */
import { Runtime, type Thread } from "../runtime";
import { BLOCK, countSchedules, explore, machineModel, type Ins, type MState, type Prog } from "../../os/sync/machine";

// ---------------------------------------------------------------- 1. transfer and audit

export type TransferScheme = "two-adds" | "lock-writer" | "lock-both" | "packed-cas" | "seqlock" | "cow";

export const TRANSFER_LABELS: Record<TransferScheme, string> = {
  "two-adds": "Two atomic adds, no lock",
  "lock-writer": "Lock in the transfer only",
  "lock-both": "Lock in transfer and audit",
  "packed-cas": "Both balances in one word, CAS",
  seqlock: "Seqlock: the audit retries",
  cow: "Copy-on-write, swap a pointer",
};

/** Accounts start at 100 each. The transfer moves 30 from A to B. */
export const START = 100;
export const AMOUNT = 30;
const pack = (a: number, b: number) => a * 1000 + b;
const unpackA = (w: number) => Math.floor(w / 1000);
const unpackB = (w: number) => w % 1000;

const lockI = (kind: Ins["kind"] = "user"): Ins => ({
  text: "lock(m)",
  kind,
  run(c) {
    if (c.mem.m) return BLOCK;
    c.mem.m = 1;
    c.say("takes m");
  },
});
const unlockI: Ins = { text: "unlock(m)", run(c) { c.mem.m = 0; c.say("releases m"); } };

function transferThread(s: TransferScheme): Ins[] {
  const debit: Ins = { text: `A -= ${AMOUNT}  (atomic)`, sync: true, kind: s.startsWith("lock") ? "cs" : "user", run(c) { c.mem.A = c.mem.A! - AMOUNT; c.say(`A = ${c.mem.A}. The ${AMOUNT} is in neither account now.`); } };
  const credit: Ins = { text: `B += ${AMOUNT}  (atomic)`, sync: true, kind: s.startsWith("lock") ? "cs" : "user", run(c) { c.mem.B = c.mem.B! + AMOUNT; c.say(`B = ${c.mem.B}. The transfer is complete.`); } };
  switch (s) {
    case "two-adds":
      return [debit, credit];
    case "lock-writer":
    case "lock-both":
      return [lockI(), debit, credit, unlockI];
    case "packed-cas":
      return [
        { label: "load", text: "old = AB  (one 64-bit word)", run(c) { c.r.old = c.mem.AB!; c.say(`reads A = ${unpackA(c.r.old)}, B = ${unpackB(c.r.old)} in one load`); } },
        {
          text: `CAS(AB, old, {A-${AMOUNT}, B+${AMOUNT}})`,
          sync: true,
          run(c) {
            if (c.mem.AB !== c.r.old) { c.say("CAS fails: the word changed. Try again."); return "load"; }
            c.mem.AB = pack(unpackA(c.r.old!) - AMOUNT, unpackB(c.r.old!) + AMOUNT);
            c.say(`one CAS writes A = ${unpackA(c.mem.AB)} and B = ${unpackB(c.mem.AB)} together`);
          },
        },
      ];
    case "seqlock":
      return [
        { text: "seq++  (now odd: writing)", run(c) { c.mem.seq = c.mem.seq! + 1; c.say(`seq = ${c.mem.seq}: a write is in progress`); } },
        debit,
        credit,
        { text: "seq++  (now even: done)", run(c) { c.mem.seq = c.mem.seq! + 1; c.say(`seq = ${c.mem.seq}: the write is complete`); } },
      ];
    case "cow":
      return [
        { text: "p = current", run(c) { c.r.p = c.mem.cur!; c.say(`reads the pointer to snapshot #${c.r.p}`); } },
        {
          text: `n = copy of *p, with A-${AMOUNT}, B+${AMOUNT}`,
          run(c) {
            const p = c.r.p!;
            c.mem.n = p + 1;
            c.mem[`A${p + 1}`] = c.mem[`A${p}`]! - AMOUNT;
            c.mem[`B${p + 1}`] = c.mem[`B${p}`]! + AMOUNT;
            c.say(`builds snapshot #${p + 1} privately. Nobody can see it yet.`);
          },
        },
        { text: "current = n  (atomic swap)", sync: true, run(c) { c.mem.cur = c.mem.n!; c.say(`publishes snapshot #${c.mem.cur} with one pointer store`); } },
      ];
  }
}

function auditThread(s: TransferScheme): Ins[] {
  const readA: Ins = { text: "a = A", kind: s === "lock-both" ? "cs" : "user", run(c) { c.r.a = c.mem.A!; c.say(`reads A = ${c.r.a}`); } };
  const readB: Ins = { text: "b = B", kind: s === "lock-both" ? "cs" : "user", run(c) { c.r.b = c.mem.B!; c.say(`reads B = ${c.r.b}. Total seen: ${c.r.a! + c.r.b}`); } };
  switch (s) {
    case "two-adds":
    case "lock-writer":
      return [readA, readB];
    case "lock-both":
      return [lockI(), readA, readB, unlockI];
    case "packed-cas":
      return [{ text: "w = AB; a, b = unpack(w)", run(c) { const w = c.mem.AB!; c.r.a = unpackA(w); c.r.b = unpackB(w); c.say(`reads A = ${c.r.a}, B = ${c.r.b} in one load. Total seen: ${c.r.a + c.r.b}`); } }];
    case "seqlock":
      return [
        {
          label: "begin",
          text: "s1 = seq  (wait while odd)",
          run(c) {
            const v = c.mem.seq!;
            if (v % 2) return BLOCK;
            c.r.s1 = v;
            c.say(`seq = ${v}: no write in progress`);
          },
        },
        readA,
        { ...readB, run(c) { c.r.b = c.mem.B!; c.say(`reads B = ${c.r.b}`); } },
        {
          text: "if seq != s1: retry",
          run(c) {
            if (c.mem.seq !== c.r.s1) { c.say(`seq is ${c.mem.seq}, not ${c.r.s1}: a write overlapped. Retry.`); c.mem.retries = c.mem.retries! + 1; return "begin"; }
            c.say(`seq is still ${c.r.s1}: the pair is consistent. Total seen: ${c.r.a! + c.r.b!}`);
          },
        },
      ];
    case "cow":
      return [
        { text: "p = current", run(c) { c.r.p = c.mem.cur!; c.say(`takes snapshot #${c.r.p}`); } },
        { text: "a = p.A", run(c) { c.r.a = c.mem[`A${c.r.p}`]!; c.say(`reads A = ${c.r.a} from snapshot #${c.r.p}`); } },
        { text: "b = p.B", run(c) { c.r.b = c.mem[`B${c.r.p}`]!; c.say(`reads B = ${c.r.b} from snapshot #${c.r.p}. Total seen: ${c.r.a! + c.r.b}`); } },
      ];
  }
}

export function transferProg(s: TransferScheme): Prog {
  const mem: Record<string, number> = { A: START, B: START, m: 0 };
  if (s === "packed-cas") { delete mem.A; delete mem.B; mem.AB = pack(START, START); }
  if (s === "seqlock") { mem.seq = 0; mem.retries = 0; }
  if (s === "cow") { delete mem.A; delete mem.B; mem.cur = 0; mem.n = 0; mem.A0 = START; mem.B0 = START; }
  return { name: s, threads: [transferThread(s), auditThread(s)], mem, names: ["transfer", "audit"] };
}

/** The total that the audit saw, once it has read both values. */
export const auditTotal = (s: MState): number | undefined => {
  const r = s.th[1]!.r;
  return r.a !== undefined && r.b !== undefined ? r.a + r.b : undefined;
};

export function transferCounts(s: TransferScheme) {
  const by = countSchedules(machineModel(transferProg(s), { outcome: (st) => String(auditTotal(st)) }));
  let total = 0, bad = 0;
  const totals: Record<string, number> = {};
  for (const [k, n] of by) {
    total += n;
    totals[k] = n;
    if (k !== String(2 * START)) bad += n;
  }
  return { total, bad, totals };
}

export function transferViolation(s: TransferScheme): string[] | null {
  const prog = transferProg(s);
  const done = (st: MState) => st.th.every((t, i) => t.pc >= prog.threads[i]!.length);
  const m = machineModel(prog, { check: (st) => (done(st) && auditTotal(st) !== 2 * START ? `audit saw ${auditTotal(st)}` : null) });
  return explore(m).violation?.schedule ?? null;
}

// ---------------------------------------------------------------- 2. torn multiword values

export type TornCase = "iface" | "slice" | "atomic-ptr";

export const TORN_LABELS: Record<TornCase, string> = {
  iface: "Go interface: 2 words",
  slice: "Go slice header: 3 words",
  "atomic-ptr": "atomic.Pointer to an immutable value",
};

/** Names of the old and new values, by number. */
export const IFACE_TYPES = ["", "*Small", "*Big"];

export function tornProg(k: TornCase): Prog {
  if (k === "iface") {
    return {
      name: k,
      names: ["writer", "reader"],
      mem: { tab: 1, data: 1 },
      threads: [
        [
          { text: "v.tab = itab(*Big)", run(c) { c.mem.tab = 2; c.say("writes the type word of the new value"); } },
          { text: "v.data = &big", run(c) { c.mem.data = 2; c.say("writes the data word of the new value"); } },
        ],
        [
          { text: "t = v.tab", run(c) { c.r.t = c.mem.tab!; c.say(`reads type ${IFACE_TYPES[c.r.t]}`); } },
          { text: "d = v.data", run(c) { c.r.d = c.mem.data!; c.say(`reads data ${c.r.d === 1 ? "&small" : "&big"}`); } },
        ],
      ],
    };
  }
  if (k === "slice") {
    return {
      name: k,
      names: ["writer", "reader"],
      mem: { ptr: 1, len: 4, cap: 4 },
      threads: [
        [
          { text: "s.ptr = &big[0]", run(c) { c.mem.ptr = 2; c.say("writes the pointer of the new slice"); } },
          { text: "s.len = 1000", run(c) { c.mem.len = 1000; c.say("writes the length of the new slice"); } },
          { text: "s.cap = 1000", run(c) { c.mem.cap = 1000; c.say("writes the capacity"); } },
        ],
        [
          { text: "p = s.ptr", run(c) { c.r.p = c.mem.ptr!; c.say(`reads the pointer to the ${c.r.p === 1 ? "old 4-element" : "new 1000-element"} array`); } },
          { text: "n = s.len", run(c) { c.r.n = c.mem.len!; c.say(`reads len = ${c.r.n}`); } },
        ],
      ],
    };
  }
  return {
    name: k,
    names: ["writer", "reader"],
    mem: { ptr: 1 },
    threads: [
      [{ text: "v.Store(&Big{...})", sync: true, run(c) { c.mem.ptr = 2; c.say("one atomic store of one pointer to a value that never changes"); } }],
      [{ text: "p := v.Load()", sync: true, run(c) { c.r.p = c.mem.ptr!; c.say(`loads ${c.r.p === 1 ? "the old" : "the new"} value, complete`); } }],
    ],
  };
}

/** What the reader got. `torn` is true when its words come from two different values. */
export function tornOutcome(k: TornCase, s: MState): { text: string; torn: boolean } | null {
  const r = s.th[1]!.r;
  if (k === "iface") {
    if (r.t === undefined || r.d === undefined) return null;
    const torn = r.t !== r.d;
    return { torn, text: torn ? `calls ${IFACE_TYPES[r.t]} methods on ${r.d === 1 ? "&small" : "&big"}: memory is misread` : `a whole ${IFACE_TYPES[r.t]} value` };
  }
  if (k === "slice") {
    if (r.p === undefined || r.n === undefined) return null;
    const torn = (r.p === 1) !== (r.n === 4);
    return { torn, text: torn ? (r.p === 1 ? `len ${r.n} over a 4-element array: reads past its end` : `len ${r.n} over the new array: safe, but stale`) : `a whole ${r.p === 1 ? "old" : "new"} slice` };
  }
  if (r.p === undefined) return null;
  return { torn: false, text: `a whole ${r.p === 1 ? "old" : "new"} value` };
}

export function tornCounts(k: TornCase) {
  const by = countSchedules(machineModel(tornProg(k), { outcome: (s) => { const o = tornOutcome(k, s)!; return o.torn ? `torn:${o.text}` : "whole"; } }));
  let total = 0, torn = 0, unsafe = 0;
  for (const [o, n] of by) {
    total += n;
    if (o.startsWith("torn")) torn += n;
    if (o.includes("past its end") || o.includes("misread")) unsafe += n;
  }
  return { total, torn, unsafe };
}

// ---------------------------------------------------------------- 3. the cost of each fix

export type Snapshot = "none" | "mutex" | "rwlock" | "seqlock" | "cow";

export const SNAPSHOT_LABELS: Record<Snapshot, string> = {
  none: "No protection",
  mutex: "Mutex",
  rwlock: "RW lock",
  seqlock: "Seqlock",
  cow: "Copy-on-write",
};

export interface SnapshotParams {
  scheme: Snapshot;
  /** Threads, one per core. */
  threads: number;
  /** Fraction of operations that only read the record. */
  readFrac: number;
  /** Record size in bytes. A read copies it out. A copy-on-write update copies it too. */
  bytes: number;
  /** Other work between operations, in ns. */
  thinkNs: number;
  /** Simulated time. */
  durationNs: number;
  seed: number;
  record?: boolean;
}

/** Model inputs: the cost of copying the record, and of an update in place. */
export const COPY_FIXED_NS = 20;
export const COPY_NS_PER_BYTE = 0.1;
export const UPDATE_NS = 50;
export const copyNs = (bytes: number) => COPY_FIXED_NS + COPY_NS_PER_BYTE * bytes;

export const SNAPSHOT_DEFAULTS: Omit<SnapshotParams, "scheme"> = { threads: 8, readFrac: 0.9, bytes: 256, thinkNs: 500, durationNs: 400_000, seed: 1 };

export interface SnapshotResult {
  reads: number;
  writes: number;
  /** Operations per µs. */
  readsPerUs: number;
  writesPerUs: number;
  /** Mean time from the start of a read to its consistent result. */
  readLatencyNs: number;
  writeLatencyNs: number;
  /** Seqlock reads that had to start again. */
  retries: number;
  /** Reads that saw a mixed record. It is 0 for every scheme except "none". */
  inconsistent: number;
  result: ReturnType<Runtime["run"]>;
}

/**
 * Threads read or update a record of two fields that must stay equal (an invariant). Each scheme keeps the invariant
 * for its readers; the run checks it on every read.
 */
export function runSnapshot(p: SnapshotParams): SnapshotResult {
  const rt = new Runtime({ cores: p.threads, seed: p.seed, record: p.record ?? false });
  const m = rt.mutex("m", { wait: "adaptive" });
  const rw = rt.rwlock("rw", { prefer: "fair" });
  // The record. In-place schemes write `a`, then (after the update time) `b`. Copy-on-write swaps the whole object.
  let rec = { a: 0, b: 0 };
  let seq = 0;
  let reads = 0, writes = 0, readNs = 0, writeNs = 0, retries = 0, inconsistent = 0;
  const cp = copyNs(p.bytes);

  function* readOp(t: Thread) {
    const t0 = t.now();
    let a = 0, b = 0;
    if (p.scheme === "mutex" || p.scheme === "rwlock") {
      if (p.scheme === "mutex") yield* t.lock(m); else yield* t.rlock(rw);
      a = rec.a;
      yield* t.work(cp, "read");
      b = rec.b;
      if (p.scheme === "mutex") t.unlock(m); else t.runlock(rw);
    } else if (p.scheme === "seqlock") {
      for (;;) {
        const s1 = seq;
        if (s1 % 2) { yield* t.work(20, "wait"); continue; }
        a = rec.a;
        yield* t.work(cp, "read");
        b = rec.b;
        if (seq === s1) break;
        retries++;
      }
    } else if (p.scheme === "none") {
      a = rec.a;
      yield* t.work(cp, "read");
      b = rec.b;
    } else {
      const snap = rec; // one atomic pointer load
      a = snap.a;
      yield* t.work(cp, "read");
      b = snap.b;
    }
    if (a !== b) inconsistent++;
    reads++;
    readNs += t.now() - t0;
  }

  function* writeOp(t: Thread, v: number) {
    const t0 = t.now();
    if (p.scheme === "cow") {
      yield* t.lock(m); // writers still exclude each other
      const old = rec;
      yield* t.work(cp + UPDATE_NS, "copy");
      rec = { a: old.a + 1, b: old.b + 1 }; // the pointer swap
      t.unlock(m);
    } else {
      if (p.scheme === "rwlock") yield* t.wlock(rw); else yield* t.lock(m);
      if (p.scheme === "seqlock") seq++;
      rec.a = v;
      yield* t.work(UPDATE_NS, "write");
      rec.b = v;
      if (p.scheme === "seqlock") seq++;
      if (p.scheme === "rwlock") t.wunlock(rw); else t.unlock(m);
    }
    writes++;
    writeNs += t.now() - t0;
  }

  let v = 0;
  for (let i = 0; i < p.threads; i++) {
    rt.spawn(`T${i}`, function* (t) {
      for (;;) {
        yield* t.work(-Math.log(1 - t.rand()) * p.thinkNs, "other");
        if (t.rand() < p.readFrac) yield* readOp(t);
        else yield* writeOp(t, ++v);
      }
    });
  }
  const result = rt.run({ untilNs: p.durationNs });
  const us = p.durationNs / 1000;
  return {
    reads, writes, readsPerUs: reads / us, writesPerUs: writes / us,
    readLatencyNs: reads ? readNs / reads : 0, writeLatencyNs: writes ? writeNs / writes : 0,
    retries, inconsistent, result,
  };
}
