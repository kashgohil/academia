/**
 * Mark and sweep on the shared object graph, a conservative stack scan on the shared machine, and the cost model of
 * a tracing collector.
 *
 * - `layoutHeap` gives each object an address in allocation order, as a bump or first-fit allocator would.
 * - `markSweep` returns the frames of one collection: mark with an explicit mark stack (depth first), then sweep in
 *   address order, coalescing dead neighbors into free runs (the free list of the next allocation).
 * - `stackScan` builds a small C program in the shared machine (src/sims/sys/mem), then finds its roots in two ways.
 *   Precise: only the slots whose type is a pointer (a stack map). Conservative: every aligned 8-byte word of the
 *   live frames and of the reachable blocks, as the Boehm-Demers-Weiser collector does. A word that looks like a
 *   pointer keeps its block alive. Then it frees the blocks that were not retained, with the machine's free.
 * - `tracingCost`: work per collection and per allocated byte for mark-sweep and for a semispace copier, with
 *   per-byte costs that are MODEL INPUTS, not measurements.
 */
import { Machine, T, hex, ptr, struct, type Snapshot } from "../mem";
import { obj, type Graph } from "./heap";

export type Tri = "white" | "gray" | "black";

/** Addresses in allocation order from `base`, each object rounded up to 16 bytes. */
export function layoutHeap(g: Graph, base = 0x1000): Record<number, number> {
  const out: Record<number, number> = {};
  let a = base;
  for (const o of g.objs) { out[o.id] = a; a += Math.ceil(o.size / 16) * 16; }
  return out;
}

export interface FreeRun { addr: number; size: number }

export interface MsFrame {
  phase: "roots" | "mark" | "sweep" | "done";
  color: Record<number, Tri>;
  stack: number[];
  /** Objects freed so far by the sweep. */
  freed: number[];
  /** Index (in address order) of the next object the sweep looks at. */
  sweepAt: number;
  free: FreeRun[];
  focus?: number;
  text: string;
  /** Work counters so far: objects scanned by mark, pointer fields read, objects visited by sweep. */
  work: { scanned: number; fields: number; swept: number };
}

/**
 * One full collection, as frames. The mark bit is set when an object is pushed (gray), so no object is pushed twice.
 * An object is black when it is popped and its fields are read. The sweep frees every white object and clears the
 * mark bits of the black ones for the next cycle.
 */
export function markSweep(g: Graph, addr: Record<number, number> = layoutHeap(g)): MsFrame[] {
  const color: Record<number, Tri> = {};
  for (const o of g.objs) color[o.id] = "white";
  const stack: number[] = [];
  const freed: number[] = [];
  const free: FreeRun[] = [];
  const work = { scanned: 0, fields: 0, swept: 0 };
  const frames: MsFrame[] = [];
  const name = (id: number) => obj(g, id).name;
  const snap = (phase: MsFrame["phase"], text: string, sweepAt: number, focus?: number) =>
    frames.push({ phase, color: { ...color }, stack: [...stack], freed: [...freed], sweepAt, free: free.map((r) => ({ ...r })), focus, text, work: { ...work } });

  snap("roots", "The mutator is stopped. Every object is white: not marked yet.", -1);
  for (const r of g.roots) {
    if (r.to === null || color[r.to] !== "white") continue;
    color[r.to] = "gray"; stack.push(r.to);
    snap("roots", `Root ${r.name} points to ${name(r.to)}: set its mark bit and push it.`, -1, r.to);
  }
  while (stack.length) {
    const id = stack.pop()!;
    work.scanned++;
    const pushed: string[] = [];
    for (const t of obj(g, id).fields) {
      work.fields++;
      if (t !== null && color[t] === "white") { color[t] = "gray"; stack.push(t); pushed.push(name(t)); }
    }
    color[id] = "black";
    snap("mark", `Pop ${name(id)} and read its ${obj(g, id).fields.length} fields. ${pushed.length ? `Push ${pushed.join(", ")}.` : "Nothing new to push."}`, -1, id);
  }
  const order = [...g.objs].sort((a, b) => addr[a.id]! - addr[b.id]!);
  snap("sweep", "The mark stack is empty: every live object is black. Now sweep the heap in address order.", 0);
  order.forEach((o, i) => {
    work.swept++;
    if (color[o.id] === "white") {
      freed.push(o.id);
      const a = addr[o.id]!, size = Math.ceil(o.size / 16) * 16;
      const last = free[free.length - 1];
      if (last && last.addr + last.size === a) last.size += size;
      else free.push({ addr: a, size });
      snap("sweep", `${o.name} is white: free it${last && last.addr + last.size === a + size && last.size > size ? " and join it to the free run before it" : ""}.`, i + 1, o.id);
    } else {
      color[o.id] = "white";
      snap("sweep", `${o.name} is marked: keep it, and clear its mark bit for the next cycle.`, i + 1, o.id);
    }
  });
  const total = free.reduce((s, r) => s + r.size, 0), big = free.reduce((m, r) => Math.max(m, r.size), 0);
  snap("done", `Freed ${freed.length} objects: ${total} bytes in ${free.length} free run${free.length === 1 ? "" : "s"}; the largest is ${big} bytes.`, order.length);
  return frames;
}

/** Free bytes, the largest free run, and external fragmentation 1 − largest / total, after a sweep. */
export function freeStats(free: FreeRun[]) {
  const total = free.reduce((s, r) => s + r.size, 0), largest = free.reduce((m, r) => Math.max(m, r.size), 0);
  return { total, largest, runs: free.length, frag: total ? 1 - largest / total : 0 };
}

// ---------------------------------------------------------------- conservative vs precise stack scanning

export type WordValue = "small" | "base" | "interior";

export interface ScanRoot { where: string; addr: number; value: number; block: string; typed: boolean }

export interface ScanResult {
  /** The machine after the collection: the blocks that were not retained are freed. */
  snap: Snapshot;
  before: Snapshot;
  roots: ScanRoot[];
  retained: string[];
  freed: string[];
  /** Retained although the program can never use them again. */
  falseRetained: string[];
  wordsScanned: number;
  source: string[];
}

/** A list node in C: `struct node { struct node *next; long val; }`. */
export const NODE = struct("node", [["next", ptr()], ["val", T.long]]);

/**
 * The program: `list` points to a 3-node list A → B → C. D → E was the old list; nothing points to it any more.
 * The local `long n` holds a plain number: 42, or by bad luck the address of D, or an address inside D.
 */
export function stackScan(nValue: WordValue, mode: "precise" | "conservative", interior = true): ScanResult {
  const m = new Machine();
  const blocks = ["A", "B", "C", "D", "E"].map((l) => [l, m.allocNamed("node", l, { type: NODE })] as const);
  const p = Object.fromEntries(blocks);
  const link = (a: string, b: string) => m.store(m.field(p[a]!, NODE, "next"), ptr(), p[b]!);
  link("A", "B"); link("B", "C"); link("D", "E");
  ["A", "B", "C", "D", "E"].forEach((l, i) => m.store(m.field(p[l]!, NODE, "val"), T.long, 10 * (i + 1)));
  m.call("main", [{ name: "list", type: ptr(NODE) }, { name: "n", type: T.long }, { name: "x", type: T.double }]);
  m.set("list", p.A!);
  const dAddr = p.D!.addr;
  m.set("n", nValue === "small" ? 42 : nValue === "base" ? dAddr : dAddr + 8);
  m.set("x", 2.5);
  const before = m.snapshot();
  const heap = before.heap.filter((b) => b.state === "live");
  const label = (id: number) => heap.find((b) => b.id === id)!.label;
  const hit = (v: number) => heap.find((b) => (interior ? v >= b.addr && v < b.addr + b.size : v === b.addr));
  const roots: ScanRoot[] = [];
  let words = 0;
  const frame = before.frames.find((f) => f.live)!;
  if (mode === "precise") {
    for (const s of frame.slots) {
      if (s.kind !== "local") continue;
      words += 1;
      if (s.type?.k === "ptr" && s.value && typeof s.value === "object" && "addr" in s.value) {
        const b = heap.find((x) => x.addr === (s.value as { addr: number }).addr);
        if (b) roots.push({ where: s.name, addr: s.addr, value: b.addr, block: b.label, typed: true });
      }
    }
  } else {
    // every aligned 8-byte word between rsp and the frame top
    for (let a = frame.lo; a < frame.hi; a += 8) {
      words += 1;
      const v = Number(m.rawLoad(a, T.u64));
      const b = hit(v);
      if (b) {
        const s = frame.slots.find((x) => a >= x.addr && a < x.addr + x.size);
        roots.push({ where: s?.name ?? hex(a), addr: a, value: v, block: b.label, typed: s?.type?.k === "ptr" });
      }
    }
  }
  // trace through the heap: precise follows the next field; conservative reads every word of the block
  const retained = new Set<number>();
  const work = roots.map((r) => heap.find((b) => b.label === r.block)!.id);
  while (work.length) {
    const id = work.pop()!;
    if (retained.has(id)) continue;
    retained.add(id);
    const b = heap.find((x) => x.id === id)!;
    for (let off = 0; off < b.size; off += 8) {
      if (mode === "precise" && off !== 0) continue;
      words += mode === "conservative" ? 1 : 0;
      const v = Number(m.rawLoad(b.addr + off, T.u64));
      const t = mode === "precise" ? heap.find((x) => x.addr === v) : hit(v);
      if (t && !retained.has(t.id)) work.push(t.id);
    }
  }
  const reallyLive = new Set(["A", "B", "C"]);
  const freedIds = heap.filter((b) => !retained.has(b.id));
  for (const b of freedIds) m.free({ addr: b.addr, alloc: b.id });
  return {
    snap: m.snapshot(), before, roots,
    retained: [...retained].map(label).sort(), freed: freedIds.map((b) => b.label),
    falseRetained: [...retained].map(label).filter((l) => !reallyLive.has(l)),
    wordsScanned: words,
    source: [
      "struct node { struct node *next; long val; };",
      "int main(void) {",
      "    struct node *list = make_list(3);  /* A -> B -> C */",
      `    long n = ${nValue === "small" ? "42;" : nValue === "base" ? `${hex(dAddr)};  /* by chance: the address of D */` : `${hex(dAddr + 8)};  /* by chance: inside D */`}`,
      "    double x = 2.5;",
      "    GC_gcollect();  /* D -> E is garbage */",
    ],
  };
}

// ---------------------------------------------------------------- cost model

export interface CostInputs {
  /** Live bytes L, MiB. */
  live: number;
  /** Heap size H, MiB: the memory the collector may use. For the copier, each semispace is H / 2. */
  heap: number;
  /** MODEL INPUTS, ns per byte: marking a live byte, sweeping a heap byte, copying a live byte. */
  markNs: number;
  sweepNs: number;
  copyNs: number;
}

/** Typical model inputs. They are assumptions for the model, not measurements. */
export const COST_DEFAULTS: CostInputs = { live: 100, heap: 300, markNs: 1, sweepNs: 0.1, copyNs: 2 };

const MiB = 1 << 20;

/**
 * Work of one collection and its cost per allocated byte. A collection runs when the free memory is used up, so
 * mark-sweep runs once per H − L allocated bytes, and the copier once per H/2 − L bytes. Infinity when the live data
 * does not fit. Pauses are for a stop-the-world collector; mark-sweep with lazy sweeping pauses only to mark.
 */
export function tracingCost(c: CostInputs) {
  const L = c.live * MiB, H = c.heap * MiB;
  const msWork = c.markNs * L + c.sweepNs * H;
  const msPeriod = H - L;
  const cpWork = c.copyNs * L;
  const cpPeriod = H / 2 - L;
  return {
    ms: { pauseMs: msWork / 1e6, markOnlyMs: (c.markNs * L) / 1e6, perByte: msPeriod > 0 ? msWork / msPeriod : Infinity, gcsPerGiB: msPeriod > 0 ? 1024 * MiB / msPeriod : Infinity },
    copy: { pauseMs: cpWork / 1e6, perByte: cpPeriod > 0 ? cpWork / cpPeriod : Infinity, gcsPerGiB: cpPeriod > 0 ? 1024 * MiB / cpPeriod : Infinity },
  };
}

/** The smallest H / L at which the semispace copier does less work per allocated byte than mark-sweep (bisection). */
export function copyWinsAbove(c: Omit<CostInputs, "heap">): number {
  const diff = (m: number) => { const r = tracingCost({ ...c, heap: c.live * m }); return r.copy.perByte - r.ms.perByte; };
  let lo = 2.000001, hi = 1e6;
  if (diff(hi) > 0) return Infinity;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (diff(mid) > 0) lo = mid; else hi = mid; }
  return hi;
}
