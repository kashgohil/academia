/**
 * Spinlock algorithms on real coherence traffic.
 *
 * Each core runs the real memory accesses of the algorithm against the MESI simulator in
 * src/sims/coherence.ts, so bus transactions and invalidations are counted, not assumed.
 * Time: a core's clock advances by the cycles that the simulator charges. An access that needs the
 * bus waits until the line is free, so traffic on one line is serialized. A spinner whose read hits
 * its cache sleeps in the simulation until another core writes the line: that loop has no traffic.
 */
import { Coherence, LAT } from "../../coherence";
import { mulberry32 } from "../../rng";

export { LAT };

export type SpinAlgo = "tas" | "ttas" | "backoff" | "ticket" | "mcs";

export const SPIN_LABEL: Record<SpinAlgo, string> = {
  tas: "Test-and-set",
  ttas: "Test-and-test-and-set",
  backoff: "TTAS + backoff",
  ticket: "Ticket",
  mcs: "MCS queue",
};

export const SPIN_ALGOS: SpinAlgo[] = ["tas", "ttas", "backoff", "ticket", "mcs"];

/** A coherent memory: MESI state plus per-line serialization of bus traffic. */
export class LineBus {
  c: Coherence;
  val = new Map<number, number>();
  private free = new Map<number, number>();
  constructor(public cores: number) {
    this.c = new Coherence(cores, 8, "MESI");
  }
  get(addr: number) { return this.val.get(addr) ?? 0; }
  /** If the access needs the bus and the line is busy, returns the time when the line is free. */
  waitUntil(core: number, addr: number, write: boolean, now: number): number | null {
    const st = this.c.state(core, addr);
    const hit = write ? st === "M" || st === "E" : st !== "I";
    if (hit) return null;
    const f = this.free.get(addr) ?? 0;
    return f > now ? f : null;
  }
  /** Performs an access at time `now` and returns its cost in cycles. A bus access keeps the line busy. */
  access(core: number, addr: number, write: boolean, now: number, value = 0): number {
    const before = this.c.c.cycles;
    const bus = this.c.busTransactions;
    if (write) { this.c.write(core, addr, value); this.val.set(addr, value); }
    else this.c.read(core, addr);
    this.c.log.length = 0;
    const cost = this.c.c.cycles - before;
    if (this.c.busTransactions > bus) this.free.set(addr, now + cost);
    return cost;
  }
}

export interface SpinConfig {
  algo: SpinAlgo;
  cores: number;
  /** Cycles inside the critical section. */
  cs?: number;
  /** Cycles of private work between acquisitions. */
  work?: number;
  /** Acquisitions to measure, after a warm-up. The default is 40 per core, and at least 400. */
  acquisitions?: number;
  seed?: number;
}

export interface SpinResult {
  algo: SpinAlgo;
  acquisitions: number;
  perCore: number[];
  /** Bus transactions per acquisition. */
  busPerAcq: number;
  invalPerAcq: number;
  cyclesPerAcq: number;
  /** Jain's fairness index: 1 is perfectly fair; 1/n means one core gets everything. */
  jain: number;
  /** Longest wait for the lock, and the mean wait, in cycles. */
  maxWait: number;
  meanWait: number;
  /** Largest number of times other cores got the lock while one waiter waited. */
  maxBypass: number;
  /** Core ids in acquisition order (the first 96 after warm-up). */
  order: number[];
}

export const SPIN_DEFAULTS = { cs: 300, work: 300, seed: 1 };

const LOCK = 0;
const node = (core: number) => 1 + core; // an MCS queue node, on its own line

type Phase = "work" | "acquire" | "hold" | "release";

interface Core {
  clock: number;
  phase: Phase;
  pc: number;
  ticket: number;
  backoff: number;
  parked: number | null;
  since: number;
  bypass: number;
  next: number; // MCS successor seen by this core
}

export function simulateSpin(cfg: SpinConfig): SpinResult {
  const { algo, cores: n } = cfg;
  const cs = cfg.cs ?? SPIN_DEFAULTS.cs;
  const work = cfg.work ?? SPIN_DEFAULTS.work;
  const target = cfg.acquisitions ?? Math.max(400, 40 * n);
  const rng = mulberry32(cfg.seed ?? SPIN_DEFAULTS.seed);
  const bus = new LineBus(n);

  // Logical memory of the algorithms. The coherence simulator charges for each access.
  let locked = 0;
  let nextTicket = 0;
  let serving = 0;
  let tail = -1; // MCS tail: core id or -1
  const mcsWait = new Array<number>(n).fill(0);
  const mcsNext = new Array<number>(n).fill(-1);

  const core: Core[] = Array.from({ length: n }, (_, i) => ({
    clock: i * 7, phase: "acquire", pc: 0, ticket: 0, backoff: 0, parked: null, since: i * 7, bypass: 0, next: -1,
  }));
  const perCore = new Array<number>(n).fill(0);
  const order: number[] = [];
  let acq = 0, waitSum = 0, maxWait = 0, maxBypass = 0;
  // Warm-up: the first acquisitions fill the caches, so counters start after them.
  const warm = n * 4;
  let bus0 = 0, inv0 = 0, t0 = 0;

  const wakeParked = (addr: number, at: number) => {
    for (const c of core) if (c.parked === addr) { c.parked = null; c.clock = Math.max(c.clock, at); }
  };

  /** Runs an access if the line is free. Returns false if the core must retry later. */
  const go = (i: number, addr: number, write: boolean): boolean => {
    const c = core[i]!;
    const until = bus.waitUntil(i, addr, write, c.clock);
    if (until !== null) { c.clock = until; return false; }
    c.clock += bus.access(i, addr, write, c.clock);
    if (write) wakeParked(addr, c.clock);
    return true;
  };

  const acquired = (i: number) => {
    const c = core[i]!;
    const wait = c.clock - c.since;
    acq++;
    if (acq === warm) { bus0 = bus.c.busTransactions; inv0 = bus.c.c.invalidations; t0 = c.clock; perCore.fill(0); waitSum = 0; maxWait = 0; maxBypass = 0; for (const x of core) x.bypass = 0; }
    if (acq > warm) {
      perCore[i]!++;
      waitSum += wait;
      maxWait = Math.max(maxWait, wait);
      if (order.length < 96) order.push(i);
      for (let k = 0; k < n; k++) if (k !== i && core[k]!.phase === "acquire") { core[k]!.bypass++; maxBypass = Math.max(maxBypass, core[k]!.bypass); }
    }
    c.bypass = 0;
    c.phase = "hold";
    c.pc = 0;
    c.backoff = 0;
    c.clock += cs;
  };

  const released = (i: number) => {
    const c = core[i]!;
    c.phase = "work";
    c.pc = 0;
    c.clock += work;
  };

  const stepAcquire = (i: number) => {
    const c = core[i]!;
    switch (algo) {
      case "tas":
        if (!go(i, LOCK, true)) return;
        if (locked === 0) { locked = 1; acquired(i); }
        return;
      case "ttas":
      case "backoff": {
        if (c.pc === 0) {
          if (!go(i, LOCK, false)) return;
          if (locked) { c.parked = LOCK; return; }
          c.pc = 1;
          return;
        }
        if (!go(i, LOCK, true)) return;
        if (locked === 0) { locked = 1; acquired(i); return; }
        c.pc = 0;
        if (algo === "backoff") {
          c.backoff = Math.min(c.backoff ? c.backoff * 2 : 64, 4096);
          c.clock += Math.floor(rng() * c.backoff);
        }
        return;
      }
      case "ticket": {
        if (c.pc === 0) {
          if (!go(i, LOCK, true)) return; // fetch_add on the next-ticket field
          c.ticket = nextTicket++;
          c.pc = 1;
          return;
        }
        if (!go(i, LOCK, false)) return;
        if (serving === c.ticket) { acquired(i); return; }
        c.parked = LOCK;
        return;
      }
      case "mcs": {
        if (c.pc === 0) {
          if (!go(i, node(i), true)) return; // my.next = null; my.wait = 1
          mcsNext[i] = -1;
          mcsWait[i] = 1;
          c.pc = 1;
          return;
        }
        if (c.pc === 1) {
          if (!go(i, LOCK, true)) return; // pred = swap(tail, me)
          const pred = tail;
          tail = i;
          if (pred === -1) { mcsWait[i] = 0; acquired(i); return; }
          c.next = pred;
          c.pc = 2;
          return;
        }
        if (c.pc === 2) {
          if (!go(i, node(c.next), true)) return; // pred.next = me
          mcsNext[c.next] = i;
          c.pc = 3;
          return;
        }
        if (!go(i, node(i), false)) return; // spin on my own line
        if (mcsWait[i] === 0) { acquired(i); return; }
        c.parked = node(i);
        return;
      }
    }
  };

  const stepRelease = (i: number) => {
    const c = core[i]!;
    switch (algo) {
      case "tas":
      case "ttas":
      case "backoff":
        if (!go(i, LOCK, true)) return;
        locked = 0;
        released(i);
        return;
      case "ticket":
        if (!go(i, LOCK, true)) return;
        serving++;
        released(i);
        return;
      case "mcs": {
        if (c.pc === 0) {
          if (!go(i, node(i), false)) return; // read my.next
          if (mcsNext[i] !== -1) { c.pc = 2; return; }
          c.pc = 1;
          return;
        }
        if (c.pc === 1) {
          if (!go(i, LOCK, true)) return; // CAS(tail, me → null)
          if (tail === i) { tail = -1; released(i); return; }
          c.pc = 3;
          return;
        }
        if (c.pc === 3) {
          // A successor swapped the tail but has not linked itself yet: wait for it.
          if (!go(i, node(i), false)) return;
          if (mcsNext[i] !== -1) { c.pc = 2; return; }
          c.parked = node(i);
          return;
        }
        if (!go(i, node(mcsNext[i]!), true)) return; // successor.wait = 0
        mcsWait[mcsNext[i]!] = 0;
        released(i);
        return;
      }
    }
  };

  let now = 0;
  while (acq < warm + target) {
    // The earliest core that is not parked takes the next step. Ties are broken at random.
    let best = -1;
    let ties = 0;
    for (let i = 0; i < n; i++) {
      const c = core[i]!;
      if (c.parked !== null) continue;
      if (best === -1 || c.clock < core[best]!.clock) { best = i; ties = 1; }
      else if (c.clock === core[best]!.clock && rng() * ++ties < 1) best = i;
    }
    if (best === -1) throw new Error("all cores parked: the lock is lost");
    const c = core[best]!;
    now = c.clock;
    if (c.phase === "acquire") stepAcquire(best);
    else if (c.phase === "hold") { c.phase = "release"; c.pc = 0; }
    else if (c.phase === "release") stepRelease(best);
    else { c.phase = "acquire"; c.pc = 0; c.since = c.clock; }
  }

  const counted = Math.max(1, acq - warm);
  const sum = perCore.reduce((a, b) => a + b, 0);
  const sq = perCore.reduce((a, b) => a + b * b, 0);
  return {
    algo,
    acquisitions: counted,
    perCore,
    busPerAcq: (bus.c.busTransactions - bus0) / counted,
    invalPerAcq: (bus.c.c.invalidations - inv0) / counted,
    cyclesPerAcq: (now - t0) / counted,
    jain: sq > 0 ? (sum * sum) / (n * sq) : 1,
    maxWait,
    meanWait: waitSum / counted,
    maxBypass,
    order,
  };
}

export const SPIN_CORES = [2, 4, 8, 16, 32];

/** Acquisitions per point in the demo sweep and in the tests that pin its numbers. */
export const SPIN_SWEEP_ACQ = 240;

/** Bus transactions per acquisition against core count, for one algorithm. */
export function spinSweep(algo: SpinAlgo, cfg: Omit<SpinConfig, "algo" | "cores"> = {}) {
  return SPIN_CORES.map((cores) => ({ cores, ...simulateSpin({ acquisitions: SPIN_SWEEP_ACQ, ...cfg, algo, cores }) }));
}

// ---------------------------------------------------------------- spin or block

export interface SpinBlockConfig {
  /** Critical section length, ns. */
  cs: number;
  /** Threads that want the lock. */
  threads: number;
  /** CPU cores. If threads exceed cores, the lock holder can lose its CPU. */
  cores: number;
  /** MODEL INPUT: CPU cost of one sleep or one wake, including the context switch, ns. */
  switchNs: number;
  /** MODEL INPUT: scheduler time slice, ns. */
  sliceNs: number;
}

export const SPIN_BLOCK_DEFAULTS = { switchNs: 2_000, sliceNs: 4_000_000 };

/**
 * CPU time wasted per contended acquisition, in ns.
 * Wait: a thread queues behind half of the other runnable threads, on average.
 * Spin: burns the whole wait. If threads exceed cores, a preempted holder adds half a time slice,
 *       with probability equal to the share of threads that do not have a core.
 * Block: pays one sleep and one wake.
 * Adaptive: spins for 2 × switchNs (the block cost), then blocks. So the cost is at most twice the
 *       better of spin and block: the ski-rental argument.
 */
export function spinBlockCost(c: SpinBlockConfig) {
  const running = Math.min(c.threads, c.cores);
  const wait = c.cs * (running - 1) / 2;
  const off = c.threads > c.cores ? 1 - c.cores / c.threads : 0;
  const spin = wait + off * c.sliceNs / 2;
  const block = c.threads > 1 ? 2 * c.switchNs : 0;
  const limit = 2 * c.switchNs;
  const adaptive = spin <= limit ? spin : limit + block;
  return { spin, block, adaptive, best: Math.min(spin, block) };
}

/** The critical section length (ns) at which spin and block cost the same, with no oversubscription. */
export function spinBlockCrossover(threads: number, switchNs: number): number {
  const contenders = Math.max(1, threads - 1);
  return (2 * switchNs * 2) / contenders;
}
