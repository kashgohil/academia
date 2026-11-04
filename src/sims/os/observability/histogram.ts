/**
 * Two ways to get a latency histogram: aggregate in the kernel with an eBPF program and a map, or ship each event to
 * user space. The in-kernel path runs the real assembled program in the interpreter, event by event.
 */
import { assemble, type BpfProgram } from "./bpfIsa";
import { LOG2_HIST_SOURCE } from "./bpfPresets";
import { BpfMaps, BpfVm } from "./bpfVm";
import { mulberry32 } from "../../rng";

export const HIST_BUCKETS = 64;
const HIST_VALUE_BYTES = 8;
/** The bytes of one histogram: one u64 for each bucket. */
export const HIST_BYTES = HIST_BUCKETS * HIST_VALUE_BYTES;

/** MODEL INPUT: one event record. Timestamp, pid, latency and a small header. */
export const EVENT_BYTES_DEFAULT = 32;

let cachedProg: BpfProgram | null = null;
export function histProgram(): BpfProgram {
  if (!cachedProg) {
    const a = assemble(LOG2_HIST_SOURCE);
    if (!a.ok) throw new Error(a.error);
    cachedProg = a.prog;
  }
  return cachedProg;
}

/** floor(log2(x)), with 0 for x = 0 and x = 1. The check for the eBPF program. */
export function log2Bucket(x: bigint): number {
  let n = 0;
  for (let v = x; v > 1n; v >>= 1n) n++;
  return n;
}

/** Latencies in ns with two modes: fast calls and a slow tail. */
export function latencySample(n: number, seed = 7, slowShare = 0.08): bigint[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const slow = rng() < slowShare;
    const ns = Math.exp((slow ? Math.log(2_000_000) : Math.log(30_000)) + z * (slow ? 0.7 : 0.6));
    return BigInt(Math.max(1, Math.round(ns)));
  });
}

export interface InKernelRun { hist: number[]; maps: BpfMaps; steps: number; insnPerEvent: number }

/** Run the real program once for each latency. */
export function runInKernel(latencies: bigint[]): InKernelRun {
  const prog = histProgram();
  const maps = new BpfMaps(prog.maps);
  let steps = 0;
  for (const l of latencies) {
    const vm = new BpfVm(prog, { regs: { rdi: l }, maps });
    const r = vm.run(10_000);
    if (r.status !== "exit") throw new Error(`The program stopped with ${r.status}.`);
    steps += r.steps;
  }
  return { hist: maps.readU64s(0).map(Number), maps, steps, insnPerEvent: latencies.length ? steps / latencies.length : 0 };
}

/** The user-space path: each event crosses, and the tool adds it to a histogram there. */
export function aggregateInUser(latencies: bigint[]): number[] {
  const h = new Array<number>(HIST_BUCKETS).fill(0);
  for (const l of latencies) h[log2Bucket(l)]!++;
  return h;
}

export interface BytesInput {
  eventsPerSecond: number;
  eventBytes: number;
  /** How often the tool reads the map. */
  readsPerSecond: number;
}

/** Bytes per second across the kernel boundary. */
export const shipBytesPerSecond = (i: BytesInput) => i.eventsPerSecond * i.eventBytes;
export const mapBytesPerSecond = (i: BytesInput) => i.readsPerSecond * HIST_BYTES;
export const bytesRatio = (i: BytesInput) => shipBytesPerSecond(i) / mapBytesPerSecond(i);

/** MODEL INPUTS: the CPU cost of one event on each path. */
export const AGG_INPUTS = {
  /** Program run and an atomic add in a map. */
  mapUpdateNs: 60,
  /** Reserve and commit a record, and a share of the wakeup of the reader. */
  ringEventNs: 80,
  /** User space copies, parses and adds one record. */
  userEventNs: 150,
} as const;

export const shipCpuShare = (eventsPerSecond: number) => (eventsPerSecond * (AGG_INPUTS.ringEventNs + AGG_INPUTS.userEventNs)) / 1e9;
export const mapCpuShare = (eventsPerSecond: number) => (eventsPerSecond * AGG_INPUTS.mapUpdateNs) / 1e9;
