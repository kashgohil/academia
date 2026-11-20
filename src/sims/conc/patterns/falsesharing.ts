/**
 * False sharing from the view of data layout and parallel loops.
 *
 * 1. `coherenceRun`: a small coherence model. Fields sit at byte offsets; lines are `lineBytes` long. Each thread runs
 *    on its own core and repeats its list of accesses. A read hits if the core holds the line (owned or shared). A
 *    write hits only if the core owns the line alone. Every other access is a miss: the line moves (or is
 *    invalidated in the other caches), which takes `missNs`, and the moves of one line happen one at a time. This is
 *    the MESI rule of "one writer or many readers", reduced to what decides the cost.
 *    `lineBytes: 128` treats a pair of 64-byte lines as one unit, the worst case of the adjacent-line prefetcher.
 * 2. `runParallelFor`: a parallel loop that writes out[i] for i in [0, n), on the shared Runtime. Chunks of `chunk`
 *    elements go to threads round-robin (OpenMP schedule(static, chunk)). Each cache line of `out` is a mutex that a
 *    core must own to write: lockNs is the cost of a write hit and transferNs the cost of a line move. Waiters spin
 *    (a stalled core) and the line goes to the oldest waiter (handoff).
 *
 * Costs are MODEL INPUTS: about 1 ns for a store that hits in L1, about 100 ns for a line that moves between cores
 * (the Runtime's DEFAULT_COSTS.transferNs).
 */
import { DEFAULT_COSTS, Runtime, type RunResult } from "../runtime";

export const HIT_NS = 1;
export const MISS_NS = DEFAULT_COSTS.transferNs;

// ---------------------------------------------------------------- the layout model

export interface FsField { name: string; offset: number; bytes: number }
/** One access of a thread: a field, read or write. */
export interface FsAccess { field: string; write: boolean }

export interface CoherenceConfig {
  fields: FsField[];
  /** The access loop of each thread (thread i runs on core i). */
  threads: FsAccess[][];
  lineBytes: number;
  /** Accesses per thread. */
  ops: number;
  hitNs: number;
  missNs: number;
  /** Other work between two accesses. */
  workNs: number;
}

export interface CoherenceResult {
  /** Line moves (misses) per line index. */
  transfers: Map<number, number>;
  /** Misses / accesses. */
  missRate: number;
  /** Accesses per µs of each thread. */
  rate: number[];
  /** Total accesses per µs. */
  total: number;
  /** Total accesses per µs if every access hit: the goal. */
  ideal: number;
  /** Lines that more than one thread uses, and how many threads write each. */
  lines: { line: number; threads: number[]; writers: number[]; fields: string[] }[];
  time: number;
}

export const lineOf = (f: FsField, lineBytes: number) => {
  const out: number[] = [];
  for (let l = Math.floor(f.offset / lineBytes); l <= Math.floor((f.offset + f.bytes - 1) / lineBytes); l++) out.push(l);
  return out;
};

export function coherenceRun(cfg: Partial<CoherenceConfig> & Pick<CoherenceConfig, "fields" | "threads">): CoherenceResult {
  const c: CoherenceConfig = { lineBytes: 64, ops: 2_000, hitNs: HIT_NS, missNs: MISS_NS, workNs: 2, ...cfg };
  const byName = new Map(c.fields.map((f) => [f.name, f]));
  const T = c.threads.length;
  const owner = new Map<number, number>(); // line -> owning core, or -1 when shared
  const sharers = new Map<number, Set<number>>();
  const busy = new Map<number, number>();
  const transfers = new Map<number, number>();
  const clock = new Float64Array(T);
  const done = new Int32Array(T);
  let misses = 0, accesses = 0;
  const lineInfo = new Map<number, { threads: Set<number>; writers: Set<number>; fields: Set<string> }>();
  c.threads.forEach((acc, t) => {
    for (const a of acc) {
      const f = byName.get(a.field);
      if (!f) continue;
      for (const l of lineOf(f, c.lineBytes)) {
        const info = lineInfo.get(l) ?? { threads: new Set(), writers: new Set(), fields: new Set() };
        info.threads.add(t);
        if (a.write) info.writers.add(t);
        info.fields.add(f.name);
        lineInfo.set(l, info);
      }
    }
  });
  for (;;) {
    // The thread with the smallest clock goes next, so the accesses interleave as they would in time.
    let t = -1;
    for (let i = 0; i < T; i++) if (done[i]! < c.ops && c.threads[i]!.length && (t < 0 || clock[i]! < clock[t]!)) t = i;
    if (t < 0) break;
    const a = c.threads[t]![done[t]! % c.threads[t]!.length]!;
    const f = byName.get(a.field);
    done[t]!++;
    if (!f) continue;
    accesses++;
    let now = clock[t]!;
    for (const l of lineOf(f, c.lineBytes)) {
      const own = owner.get(l) ?? -1;
      const sh = sharers.get(l) ?? new Set<number>();
      const hit = a.write ? own === t : own === t || sh.has(t);
      if (hit) {
        now += c.hitNs;
        continue;
      }
      misses++;
      transfers.set(l, (transfers.get(l) ?? 0) + 1);
      const start = Math.max(now, busy.get(l) ?? 0);
      now = start + c.missNs;
      busy.set(l, now);
      if (a.write) {
        owner.set(l, t);
        sharers.set(l, new Set([t]));
      } else {
        if (own >= 0) sh.add(own);
        sh.add(t);
        owner.set(l, -1);
        sharers.set(l, sh);
      }
    }
    clock[t] = now + c.workNs;
  }
  const time = Math.max(...clock, 1e-9);
  const rate = Array.from(clock, (x, i) => (x > 0 ? (done[i]! * 1_000) / x : 0));
  const per = c.hitNs + c.workNs;
  const ideal = c.threads.filter((a) => a.length).length * (1_000 / per);
  return {
    transfers,
    missRate: accesses ? misses / accesses : 0,
    rate,
    total: (accesses * 1_000) / time,
    ideal,
    lines: [...lineInfo.entries()].sort((a, b) => a[0] - b[0]).map(([line, i]) => ({ line, threads: [...i.threads].sort(), writers: [...i.writers].sort(), fields: [...i.fields] })),
    time,
  };
}

// ---------------------------------------------------------------- a parallel loop that writes an array

export interface ForConfig {
  threads: number;
  /** Elements of out[]. */
  n: number;
  /** Elements per chunk; chunks go to threads round-robin. */
  chunk: number;
  elemBytes: number;
  lineBytes: number;
  /** Work to compute one element (model input). */
  computeNs: number;
  record: boolean;
}

export const FOR_DEFAULTS: ForConfig = { threads: 4, n: 2_048, chunk: 1, elemBytes: 8, lineBytes: 64, computeNs: 5, record: true };

export interface ForResult {
  run: RunResult;
  makespan: number;
  /** One thread: n × (computeNs + a write hit). */
  serialNs: number;
  speedup: number;
  /** Writes that had to move the line from another core. */
  transfers: number;
  /** Lines that more than one thread writes. */
  sharedLines: number;
  lines: number;
}

export function runParallelFor(cfg: Partial<ForConfig> = {}): ForResult {
  const c: ForConfig = { ...FOR_DEFAULTS, ...cfg };
  const P = Math.max(1, Math.floor(c.threads));
  const per = Math.max(1, Math.floor(c.lineBytes / c.elemBytes));
  const nLines = Math.ceil(c.n / per);
  const rt = new Runtime({ cores: P, seed: 1, record: c.record, lockNs: HIT_NS, transferNs: MISS_NS });
  const lines = Array.from({ length: nLines }, (_, i) => rt.mutex(`line ${i}`, { wait: "spin", handoff: true }));
  const lastWriter = new Int32Array(nLines).fill(-1);
  const writers = Array.from({ length: nLines }, () => new Set<number>());
  let transfers = 0;
  const chunks = Math.ceil(c.n / c.chunk);
  for (let k = 0; k < P; k++) {
    rt.spawn(`T${k}`, function* (t) {
      for (let ch = k; ch < chunks; ch += P) {
        for (let i = ch * c.chunk; i < Math.min(c.n, (ch + 1) * c.chunk); i++) {
          yield* t.work(c.computeNs, "compute");
          const l = Math.floor(i / per);
          yield* t.lock(lines[l]!);
          if (lastWriter[l]! >= 0 && lastWriter[l] !== k) transfers++;
          lastWriter[l] = k;
          writers[l]!.add(k);
          t.unlock(lines[l]!);
        }
      }
    });
  }
  const run = rt.run();
  const serialNs = c.n * (c.computeNs + HIT_NS);
  return {
    run, makespan: run.makespan, serialNs, speedup: serialNs / run.makespan, transfers,
    sharedLines: writers.filter((w) => w.size > 1).length, lines: nLines,
  };
}
