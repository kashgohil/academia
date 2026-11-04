/** Allocation traces for comparing allocators. Ops refer to allocations by trace-local id. */
import { mulberry32 } from "./rng";

export type Op = { t: "a"; id: number; size: number } | { t: "f"; id: number };

export interface Trace { id: string; label: string; note: string; ops: Op[] }

function build(seed: number, f: (r: () => number, alloc: (size: number) => number, free: (id: number) => void) => void): Op[] {
  const r = mulberry32(seed);
  const ops: Op[] = [];
  let next = 0;
  f(r, (size) => (ops.push({ t: "a", id: next, size: Math.max(1, Math.round(size)) }), next++), (id) => ops.push({ t: "f", id }));
  return ops;
}

const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

export const TRACES: Trace[] = [
  {
    id: "random",
    label: "Random sizes and lifetimes",
    note: "Sizes uniform in 8–512 B, random frees. A neutral baseline.",
    ops: build(1, (r, alloc, free) => {
      const live: number[] = [];
      for (let i = 0; i < 1500; i++) {
        if (live.length < 40 || r() < 0.5) live.push(alloc(randInt(r, 8, 512)));
        else free(live.splice(Math.floor(r() * live.length), 1)[0]!);
      }
    }),
  },
  {
    id: "holes",
    label: "Small pins between big frees",
    note: "Alternate big (300–400 B) and small (16–32 B) allocations, free the big ones, then ask for 500 B blocks. The small survivors pin the holes apart.",
    ops: build(2, (r, alloc, free) => {
      for (let round = 0; round < 6; round++) {
        const big: number[] = [];
        for (let i = 0; i < 20; i++) {
          big.push(alloc(randInt(r, 300, 400)));
          alloc(randInt(r, 16, 32)); // long-lived
        }
        big.forEach(free);
        const mids: number[] = [];
        for (let i = 0; i < 12; i++) mids.push(alloc(500));
        mids.forEach(free);
      }
    }),
  },
  {
    id: "growing",
    label: "Growing buffers",
    note: "Several vectors double their capacity (allocate new, copy, free old) while small objects are allocated in between.",
    ops: build(3, (r, alloc, free) => {
      const bufs = Array.from({ length: 4 }, () => ({ id: alloc(16), cap: 16 }));
      for (let i = 0; i < 400; i++) {
        const b = bufs[Math.floor(r() * bufs.length)]!;
        if (b.cap < 2048 && r() < 0.3) {
          const id = alloc(b.cap * 2);
          free(b.id);
          b.id = id;
          b.cap *= 2;
        }
        if (r() < 0.6) alloc(randInt(r, 8, 64));
      }
    }),
  },
  {
    id: "requests",
    label: "Request-scoped (server)",
    note: "Each request allocates 5–30 objects and frees all of them when it finishes; up to 8 requests overlap.",
    ops: build(4, (r, alloc, free) => {
      const active: number[][] = [];
      for (let i = 0; i < 300; i++) {
        if (active.length < 8 && r() < 0.6) active.push([]);
        for (const req of active) if (r() < 0.5) req.push(alloc(randInt(r, 16, 300)));
        if (active.length && r() < 0.35) active.splice(Math.floor(r() * active.length), 1)[0]!.forEach(free);
      }
    }),
  },
];
