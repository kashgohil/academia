/**
 * Read-copy-update: a model with versions, readers, grace periods and deferred free, plus a read
 * scaling model on the MESI simulator.
 *
 * Quiescent states follow classic non-preemptible RCU. A CPU inside rcu_read_lock() cannot report one.
 * A grace period that starts at time g ends when every CPU has reported a quiescent state after g.
 * A retired version may be freed after a grace period that started after its retirement.
 */
import { mulberry32 } from "../../rng";
import { LineBus } from "./spinlocks";
import type { Model, Step } from "./machine";

export interface RcuCpu { inCs: boolean; holds: number | null; entered: number }

export interface RcuVersion { id: number; state: "live" | "retired" | "freed"; needGp: number }

export interface RcuState {
  ptr: number;
  versions: RcuVersion[];
  cpus: RcuCpu[];
  /** Grace periods started and completed. */
  started: number;
  completed: number;
  /** CPUs that still owe a quiescent state for the active grace period. */
  pending: number[];
  err: string | null;
  say: string;
}

export interface RcuOpts { cpus: number; maxVersions?: number; maxSections?: number; broken?: boolean }

export function rcuInit(cpus: number): RcuState {
  return {
    ptr: 1,
    versions: [{ id: 1, state: "live", needGp: 0 }],
    cpus: Array.from({ length: cpus }, () => ({ inCs: false, holds: null, entered: 0 })),
    started: 0,
    completed: 0,
    pending: [],
    err: null,
    say: "",
  };
}

const copy = (s: RcuState): RcuState => ({
  ...s,
  versions: s.versions.map((v) => ({ ...v })),
  cpus: s.cpus.map((c) => ({ ...c })),
  pending: [...s.pending],
  say: "",
});

export type RcuAction =
  | { kind: "enter"; cpu: number }
  | { kind: "exit"; cpu: number }
  | { kind: "qs"; cpu: number }
  | { kind: "publish" }
  | { kind: "startGp" }
  | { kind: "free"; id: number };

export const canFree = (s: RcuState, v: RcuVersion, broken = false) =>
  v.state === "retired" && (broken || s.completed >= v.needGp);

/** Every action that can run now. */
export function rcuActions(s: RcuState, o: RcuOpts): RcuAction[] {
  if (s.err) return [];
  const out: RcuAction[] = [];
  const maxV = o.maxVersions ?? 3;
  const maxS = o.maxSections ?? 2;
  s.cpus.forEach((c, cpu) => {
    if (c.inCs) out.push({ kind: "exit", cpu });
    else {
      if (c.entered < maxS) out.push({ kind: "enter", cpu });
      if (s.pending.includes(cpu)) out.push({ kind: "qs", cpu });
    }
  });
  if (s.versions.length < maxV) out.push({ kind: "publish" });
  const gpActive = s.started > s.completed;
  if (!gpActive && s.versions.some((v) => v.state === "retired" && v.needGp > s.started)) out.push({ kind: "startGp" });
  for (const v of s.versions) if (canFree(s, v, o.broken)) out.push({ kind: "free", id: v.id });
  return out;
}

export function rcuApply(s0: RcuState, a: RcuAction): RcuState {
  const s = copy(s0);
  switch (a.kind) {
    case "enter": {
      const c = s.cpus[a.cpu]!;
      c.inCs = true;
      c.holds = s.ptr;
      c.entered++;
      s.say = `CPU ${a.cpu}: rcu_read_lock(), then rcu_dereference() returns version ${s.ptr}.`;
      break;
    }
    case "exit": {
      const c = s.cpus[a.cpu]!;
      s.say = `CPU ${a.cpu}: rcu_read_unlock(). It no longer uses version ${c.holds}.`;
      c.inCs = false;
      c.holds = null;
      break;
    }
    case "qs": {
      s.pending = s.pending.filter((c) => c !== a.cpu);
      s.say = `CPU ${a.cpu}: a context switch reports a quiescent state.`;
      if (s.pending.length === 0) {
        s.completed = s.started;
        s.say += ` Every CPU reported, so grace period ${s.completed} ends.`;
      }
      break;
    }
    case "publish": {
      const old = s.versions.find((v) => v.state === "live")!;
      const id = Math.max(...s.versions.map((v) => v.id)) + 1;
      old.state = "retired";
      // The grace period must start after this retirement.
      old.needGp = s.started + 1;
      s.versions.push({ id, state: "live", needGp: 0 });
      s.ptr = id;
      s.say = `Writer: rcu_assign_pointer() publishes version ${id}. Version ${old.id} is retired.`;
      break;
    }
    case "startGp": {
      s.started++;
      s.pending = s.cpus.map((_, i) => i);
      s.say = `Grace period ${s.started} starts. Every CPU owes a quiescent state.`;
      break;
    }
    case "free": {
      const v = s.versions.find((x) => x.id === a.id)!;
      v.state = "freed";
      s.say = `Writer: kfree(version ${v.id}).`;
      const holder = s.cpus.findIndex((c) => c.holds === v.id);
      if (holder >= 0) s.err = `Use after free: CPU ${holder} still reads version ${v.id}.`;
      break;
    }
  }
  return s;
}

/** CPU 0 keeps a read section open, so it alone holds up the grace period. CPU 1 reads the new version. */
export const RCU_SETUP_SCRIPT: RcuAction[] = [
  { kind: "enter", cpu: 0 },
  { kind: "publish" },
  { kind: "startGp" },
  { kind: "qs", cpu: 1 },
  { kind: "qs", cpu: 2 },
  { kind: "enter", cpu: 1 },
];

const actionId = (a: RcuAction) => JSON.stringify(a);

export function rcuModel(o: RcuOpts): Model<RcuState> {
  return {
    init: rcuInit(o.cpus),
    key: (s) => JSON.stringify([s.ptr, s.versions, s.cpus, s.started, s.completed, s.pending, s.err]),
    steps(s): Step<RcuState>[] {
      return rcuActions(s, o).map((a) => ({ actor: "cpu" in a ? a.cpu : o.cpus, id: actionId(a), text: a.kind, next: rcuApply(s, a) }));
    },
    done: () => true,
    check: (s) => s.err,
  };
}

// ---------------------------------------------------------------- read scaling

/** MODEL INPUT: clock rate, cycles per ns. It equals GHZ in src/sims/perf/contention.ts (a test checks this). */
export const GHZ = 3;

export type ReadLock = "mutex" | "rwlock" | "rcu";

export const READ_LABEL: Record<ReadLock, string> = { mutex: "Mutex", rwlock: "Reader-writer lock", rcu: "RCU" };

export interface ReadScaleResult {
  lock: ReadLock;
  cores: number;
  reads: number;
  /** Million reads per second, in total. */
  mReadsPerSec: number;
  /** Bus transactions per read. */
  busPerRead: number;
}

export const READ_DEFAULTS = { readCycles: 100, gapCycles: 20, horizon: 40_000, seed: 1 };

const LOCK = 0;
const DATA = 1;

/**
 * Each core repeats: enter the read side, read shared data for `readCycles`, leave the read side,
 * then do `gapCycles` of other work. Both lengths are model inputs.
 * mutex: a queue lock with one owner at a time. rwlock: fetch_add on a shared reader count, on entry
 * and on exit. rcu: no shared write, as on a non-preemptible kernel.
 */
export function readScale(lock: ReadLock, cores: number, cfg: Partial<typeof READ_DEFAULTS> = {}): ReadScaleResult {
  const { readCycles, gapCycles, horizon, seed } = { ...READ_DEFAULTS, ...cfg };
  const rng = mulberry32(seed);
  const bus = new LineBus(cores);
  const clock = Array.from({ length: cores }, (_, i) => i * 3);
  const phase = new Array<"enter" | "read" | "exit" | "queued">(cores).fill("enter");
  let holder = -1;
  const queue: number[] = [];
  const parked = new Array<boolean>(cores).fill(false);
  let reads = 0;
  // Warm-up: the first accesses fill caches, so counters start at a later time.
  const warmAt = horizon / 4;
  let warmReads = -1, warmBus = 0;

  const go = (i: number, addr: number, write: boolean): boolean => {
    const u = bus.waitUntil(i, addr, write, clock[i]!);
    if (u !== null) { clock[i] = u; return false; }
    clock[i]! += bus.access(i, addr, write, clock[i]!);
    return true;
  };

  for (;;) {
    let i = -1;
    let ties = 0;
    for (let k = 0; k < cores; k++) {
      if (parked[k]) continue;
      if (i < 0 || clock[k]! < clock[i]!) { i = k; ties = 1; }
      else if (clock[k] === clock[i] && rng() * ++ties < 1) i = k;
    }
    if (i < 0) throw new Error("all cores parked");
    const now = clock[i]!;
    if (now >= horizon) break;
    if (warmReads < 0 && now >= warmAt) { warmReads = reads; warmBus = bus.c.busTransactions; }
    switch (phase[i]) {
      case "enter":
        if (lock === "rcu") { phase[i] = "read"; break; }
        if (lock === "rwlock") { if (go(i, LOCK, true)) phase[i] = "read"; break; }
        if (holder < 0) { if (go(i, LOCK, true)) { holder = i; phase[i] = "read"; } }
        else { queue.push(i); parked[i] = true; phase[i] = "queued"; }
        break;
      case "queued":
        if (go(i, LOCK, true)) phase[i] = "read";
        break;
      case "read":
        if (go(i, DATA, false)) { clock[i]! += readCycles; phase[i] = "exit"; }
        break;
      case "exit":
        if (lock === "rcu") { reads++; phase[i] = "enter"; clock[i]! += gapCycles; break; }
        if (go(i, LOCK, true)) {
          reads++;
          phase[i] = "enter";
          clock[i]! += gapCycles;
          if (lock === "mutex") {
            const nx = queue.shift();
            holder = nx ?? -1;
            if (nx !== undefined) { parked[nx] = false; clock[nx] = Math.max(clock[nx]!, clock[i]!); }
          }
        }
        break;
    }
  }
  const counted = reads - Math.max(0, warmReads);
  const secs = (horizon - warmAt) / (GHZ * 1e9);
  return {
    lock,
    cores,
    reads: counted,
    mReadsPerSec: counted / secs / 1e6,
    busPerRead: (bus.c.busTransactions - warmBus) / Math.max(1, counted),
  };
}

export const READ_CORES = [1, 2, 4, 8, 16, 32, 64];

export const readSweep = (lock: ReadLock, cfg: Partial<typeof READ_DEFAULTS> = {}) => READ_CORES.map((c) => readScale(lock, c, cfg));

/** Linear reference for the plots: reads per second with one core and no read-side cost. */
export const idealReads = (cores: number, readCycles = READ_DEFAULTS.readCycles) => (cores * GHZ * 1000) / readCycles;
