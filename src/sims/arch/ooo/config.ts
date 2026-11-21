/**
 * Configuration and record types of the out-of-order core model (core.ts). Every size and latency here is a MODEL
 * INPUT: a round number that makes the lesson's point, not a fact about one product.
 */
import type { DynInst, HartError, InstClass } from "../rv";

/** The functional unit classes. Branches, jumps and system instructions use an ALU. Loads and stores use a memory port. */
export type Unit = "alu" | "mul" | "div" | "mem";
export const UNITS: Unit[] = ["alu", "mul", "div", "mem"];

/**
 * How a load treats older stores whose address is not known yet:
 * - "conservative": the load waits until every older store address is known.
 * - "speculative": the load goes; if an older store later turns out to write the same bytes, the core squashes the load
 *   and everything younger and fetches again from the load (a machine clear).
 * - "store-sets": speculative, but a load that caused a violation is put in a store set with the store, and later
 *   instances of that load wait for the last fetched store of the set (after Chrysos and Emer, ISCA 1998, simplified).
 */
export type MemDep = "conservative" | "speculative" | "store-sets";
export const MEM_DEPS: MemDep[] = ["conservative", "speculative", "store-sets"];

/** Direction prediction of conditional branches. Jumps (jal, jalr) always go to the right target in this model. */
export type BranchMode = "perfect" | "not-taken" | "two-bit" | "gshare";

/** When a mispredicted branch squashes the wrong path: as soon as it executes, or only when it commits. */
export type Recover = "execute" | "commit";

export interface CacheConfig {
  /** Every load hits (the default). Otherwise a fully associative LRU data cache of `lines` lines. */
  perfect: boolean;
  lines: number;
  lineBytes: number;
  /** Address ranges [lo, hi) that are flushed before every access: loads there always miss and never fill. */
  flushed: [number, number][];
}

export interface Latencies {
  alu: number;
  mul: number;
  /** The divider is not pipelined: one division at a time. */
  div: number;
  /** Address generation of a store. */
  agu: number;
  /** Load to use on an L1 hit (address generation included). Store-to-load forwarding takes the same time. */
  hit: number;
  /** Load to use on a miss. */
  miss: number;
}

export interface OooConfig {
  /** Instructions fetched, renamed and committed per cycle. */
  width: number;
  /** Cycles from fetch to rename (the front-end depth). A mispredict costs at least this much. */
  frontDepth: number;
  robSize: number;
  /** Unified issue queue entries (used when `rs` is null). */
  iqSize: number;
  /** Distributed reservation stations per unit class, as in Tomasulo's design. Null: one unified issue queue. */
  rs: Record<Unit, number> | null;
  lqSize: number;
  sqSize: number;
  /** Physical registers (at least 33). Unused when `rename` is false. */
  physRegs: number;
  /** false: no renaming. Write-after-read and write-after-write hazards then stall the instruction, as in a scoreboard. */
  rename: boolean;
  /** Functional units of each class (each pipelined, except the divider). */
  units: Record<Unit, number>;
  lat: Latencies;
  /** Results broadcast per cycle on the common data bus (result buses). */
  cdb: number;
  branch: BranchMode;
  recover: Recover;
  memDep: MemDep;
  cache: CacheConfig;
  /** Stop after this many cycles (a guard). */
  maxCycles: number;
  /** Keep one Frame per cycle, for steppers (up to `maxFrames`). */
  record: boolean;
  maxFrames: number;
  /** Keep a record of every instruction, squashed ones included (for timelines). */
  timeline: boolean;
  memBytes: number;
}

export type OooOptions = Partial<Omit<OooConfig, "lat" | "units" | "cache">> & {
  lat?: Partial<Latencies>;
  units?: Partial<Record<Unit, number>>;
  cache?: Partial<CacheConfig>;
};

export const DEFAULT_CONFIG: OooConfig = {
  width: 4, frontDepth: 3, robSize: 64, iqSize: 32, rs: null, lqSize: 24, sqSize: 16, physRegs: 128, rename: true,
  units: { alu: 3, mul: 1, div: 1, mem: 2 },
  lat: { alu: 1, mul: 3, div: 20, agu: 1, hit: 4, miss: 100 },
  cdb: 4, branch: "two-bit", recover: "execute", memDep: "speculative",
  cache: { perfect: true, lines: 512, lineBytes: 64, flushed: [] },
  maxCycles: 200_000, record: false, maxFrames: 2000, timeline: true, memBytes: 64 * 1024,
};

export function resolveConfig(o: OooOptions = {}): OooConfig {
  const c: OooConfig = {
    ...DEFAULT_CONFIG, ...o,
    lat: { ...DEFAULT_CONFIG.lat, ...o.lat },
    units: { ...DEFAULT_CONFIG.units, ...o.units },
    cache: { ...DEFAULT_CONFIG.cache, ...o.cache },
  } as OooConfig;
  c.physRegs = Math.max(33, c.physRegs);
  c.width = Math.max(1, c.width);
  c.frontDepth = Math.max(1, c.frontDepth);
  c.robSize = Math.max(1, c.robSize);
  return c;
}

/** Where an instruction is at the end of a cycle. */
export type UopState = "front" | "waiting" | "executing" | "done" | "committed" | "squashed";

/** Why an instruction left the machine without committing. */
export type SquashCause = "mispredict" | "violation" | "trap";

/** One fetched instruction (a micro-op here: one per RISC-V instruction). Cycles are -1 until they happen. */
export interface Uop {
  id: number;
  /** The index in the hart's trace, or -1 on a wrong path. */
  seq: number;
  d: DynInst;
  text: string;
  /** On a wrong path (after a mispredicted branch or a faulting instruction). The core does not know this; views do. */
  wrong: boolean;
  /** Fetched again after a machine clear (memory-order violation). */
  replay: boolean;
  cls: InstClass;
  unit: Unit;
  /** Architectural destination (0 = none) and sources (x0 left out). */
  rd: number;
  srcs: number[];
  fetch: number;
  rename: number;
  issue: number;
  /** The cycle its result is ready (on the bus) or, for a store, when its address and data are both known. */
  ready: number;
  commit: number;
  squash: number;
  squashCause: SquashCause | null;
  /** Physical destination, the previous mapping of rd (freed at commit), and physical sources (parallel to srcs). */
  pd: number;
  old: number;
  ps: number[];
  /** The in-flight producers of the sources at rename (null: the value was already in the register file). */
  prod: (Uop | null)[];
  /** The previous in-flight writer of rd, to restore on a squash. */
  prevWriter: Uop | null;
  /** Conditional branches: the predicted direction, and whether it was wrong. */
  pred: boolean | null;
  mispredict: boolean;
  fault: HartError | null;
  /** Memory: address and size (loads and stores), when the store address is known, the store whose data a load used. */
  addr: number;
  size: number;
  addrAt: number;
  fwd: Uop | null;
  /** A load waits for this store first (store sets). */
  waitStore: Uop | null;
  /** The value this instruction produced (a load: the value it read, which can be stale before a violation). */
  value: number;
  /** A load that missed in the cache. */
  missed: boolean;
  /** The last reason it could not issue (for views). */
  why: string;
  /** Its slot in the circular ROB (-1 before rename). */
  slot: number;
}

export interface UopView {
  id: number; seq: number; pc: number; text: string; wrong: boolean; replay: boolean; cls: InstClass; unit: Unit; state: UopState; slot: number;
  rd: number; pd: number; old: number; srcs: number[]; ps: number[];
  /** Per source: ready in this cycle, and the tag (producer's physical register) or value. */
  srcReady: boolean[]; srcVal: number[];
  fetch: number; rename: number; issue: number; ready: number; commit: number; squash: number;
  why: string; mispredict: boolean; fault: boolean;
  addr: number; size: number; addrKnown: boolean; dataReady: boolean; fwdFrom: number; value: number; missed: boolean;
}

export interface Frame {
  cycle: number;
  /** ROB contents, oldest first, and the instructions still in the front end. */
  rob: UopView[];
  front: UopView[];
  /** The speculative map (rename table), the retirement map, and the free list (head first). */
  rat: number[];
  rrat: number[];
  free: number[];
  /** Physical registers: ready (value on the bus) and value. */
  prfReady: boolean[];
  prfVal: number[];
  /** Results broadcast in this cycle: instruction id, physical register, value. */
  cdb: { id: number; pd: number; value: number; text: string }[];
  fetched: number[]; renamed: number[]; issued: number[]; committed: number[];
  squashed: { count: number; cause: SquashCause; by: number } | null;
  /** Why rename stopped in this cycle, if it did. */
  stall: string | null;
  /** Cache lines present at the end of the cycle (line addresses), when the cache is not perfect. */
  lines: number[];
  events: string[];
}

export interface OooStats {
  fetched: number;
  committed: number;
  wrongPath: number;
  replayed: number;
  branches: number;
  mispredicts: number;
  violations: number;
  forwards: number;
  loads: number;
  misses: number;
  renameStalls: { rob: number; iq: number; lsq: number; regs: number };
  /** Results that waited for a free bus slot, and the cycles they waited in total. */
  cdbWaits: number;
  cdbWaitCycles: number;
  /** Average and largest ROB occupancy. */
  robAvg: number;
  robMax: number;
}

export interface OooResult {
  config: OooConfig;
  cycles: number;
  ipc: number;
  stats: OooStats;
  /** Every instruction (when `timeline`), in fetch order, squashed ones included. */
  uops: Uop[];
  frames: Frame[];
  /** Per cycle: ROB occupancy, and how many of those entries are on a wrong path. */
  occupancy: { rob: number; wrong: number }[];
  /** Committed architectural registers and memory. */
  regs: number[];
  mem: Uint8Array;
  status: "exited" | "ebreak" | "trap" | "timeout" | "end";
  exitCode: number | null;
  trap: HartError | null;
  /** Committed instructions that read a wrong value, or other broken invariants. Empty for a correct model. */
  errors: string[];
  /** Cache lines present at the end (line addresses). */
  lines: number[];
}
