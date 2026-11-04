import { loadWasm } from "./load";
/** Typed bindings for crates/cachesim (raw C ABI, no bindgen). */
export type Policy = "lru" | "fifo" | "random";
export const OUTCOME = { hit: 0, compulsory: 1, capacity: 2, conflict: 3 } as const;

export interface CacheConfig { size: number; line: number; ways: number; policy: Policy }

interface Exports {
  memory: WebAssembly.Memory;
  alloc(bytes: number): number;
  dealloc(ptr: number, bytes: number): void;
  cachesim_run(addrs: number, n: number, out: number, size: number, line: number, ways: number, policy: number): number;
}

export async function loadCacheSim(source?: () => Promise<BufferSource>): Promise<Exports> {
  return (await loadWasm("cachesim", source)).exports as unknown as Exports;
}

const POLICY: Record<Policy, number> = { lru: 0, fifo: 1, random: 2 };

/** Runs the simulator. Returns one outcome byte per access (see OUTCOME). */
export function runCache(w: Exports, addrs: Uint32Array, cfg: CacheConfig): Uint8Array {
  const n = addrs.length;
  const aPtr = w.alloc(n * 4);
  const oPtr = w.alloc(n);
  // Views are created after alloc: memory may have grown and detached older buffers.
  new Uint32Array(w.memory.buffer, aPtr, n).set(addrs);
  w.cachesim_run(aPtr, n, oPtr, cfg.size, cfg.line, cfg.ways, POLICY[cfg.policy]);
  const out = new Uint8Array(w.memory.buffer, oPtr, n).slice();
  w.dealloc(aPtr, n * 4);
  w.dealloc(oPtr, n);
  return out;
}
