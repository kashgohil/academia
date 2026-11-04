/**
 * Semaphores: a plain counting semaphore, the bounded buffer and the dining philosophers as programs
 * for the interleaving machine, and an event simulator for readers-writers policies.
 */
import { mulberry32 } from "../../rng";
import { BLOCK, explore, machineModel, type Ins, type Prog } from "./machine";

/** A counting semaphore with a FIFO wait queue. P returns false if the caller must sleep. */
export class Semaphore {
  queue: number[] = [];
  constructor(public count: number) {}
  P(thread: number): boolean {
    if (this.count > 0) { this.count--; return true; }
    this.queue.push(thread);
    return false;
  }
  /** Direct handoff: if a thread waits, it gets the unit and the count does not change. */
  V(): number | null {
    const w = this.queue.shift();
    if (w !== undefined) return w;
    this.count++;
    return null;
  }
}

const P = (name: string): Ins => ({
  text: `P(${name})`,
  run(c) {
    if (c.mem[name]! <= 0) return BLOCK;
    c.mem[name] = c.mem[name]! - 1;
    c.say(`${name} goes down to ${c.mem[name]}`);
    return undefined;
  },
});
const V = (name: string): Ins => ({
  text: `V(${name})`,
  run(c) {
    c.mem[name] = c.mem[name]! + 1;
    c.say(`${name} goes up to ${c.mem[name]}`);
  },
});

// ---------------------------------------------------------------- bounded buffer

export type BufferVariant = "correct" | "mutex-first" | "no-mutex";

export interface BufferOpts {
  slots?: number;
  producers?: number;
  consumers?: number;
  /** Items per producer. Consumers share them out evenly. */
  items?: number;
  variant?: BufferVariant;
}

export const BUFFER_DEFAULTS = { slots: 2, producers: 2, consumers: 2, items: 2, variant: "correct" as BufferVariant };

export function boundedBufferProg(opts: BufferOpts = {}): Prog {
  const o = { ...BUFFER_DEFAULTS, ...opts };
  const mem: Record<string, number> = { empty: o.slots, full: 0, mutex: 1, in: 0, out: 0, produced: 0, consumed: 0 };
  for (let i = 0; i < o.slots; i++) mem[`buf${i}`] = 0;
  const lock = o.variant === "no-mutex" ? [] : [P("mutex")];
  const unlock = o.variant === "no-mutex" ? [] : [V("mutex")];
  const total = o.producers * o.items;
  const perConsumer = Math.floor(total / o.consumers);

  const producer = (t: number): Ins[] => {
    const wait = P("empty");
    const entry = o.variant === "mutex-first" ? [...lock, wait] : [wait, ...lock];
    return [
      { ...entry[0]!, label: "loop" },
      ...entry.slice(1),
      { text: "i = in", run(c) { c.r.i = c.mem.in!; c.say(`i = ${c.r.i}`); } },
      { text: "buf[i] = item", run(c) {
        const item = (t + 1) * 10 + (c.r.k ?? 0) + 1;
        if (c.mem[`buf${c.r.i}`]) c.fail(`Item ${c.mem[`buf${c.r.i}`]} was overwritten in slot ${c.r.i}.`);
        c.mem[`buf${c.r.i}`] = item;
        c.mem.produced = c.mem.produced! + 1;
        c.say(`writes item ${item} to slot ${c.r.i}`);
      } },
      { text: `in = (i + 1) mod ${o.slots}`, run(c) { c.mem.in = (c.r.i! + 1) % o.slots; } },
      ...unlock,
      { ...V("full"), run(c) {
        c.mem.full = c.mem.full! + 1;
        c.say(`full goes up to ${c.mem.full}`);
        c.r.k = (c.r.k ?? 0) + 1;
        if (c.r.k < o.items) return "loop";
        return undefined;
      } },
    ];
  };
  const consumer = (): Ins[] => [
    { ...P("full"), label: "loop" },
    ...lock,
    { text: "o = out", run(c) { c.r.o = c.mem.out!; c.say(`o = ${c.r.o}`); } },
    { text: "item = buf[o]", run(c) {
      const v = c.mem[`buf${c.r.o}`]!;
      if (!v) c.fail(`Slot ${c.r.o} was empty: the consumer read nothing.`);
      c.mem[`buf${c.r.o}`] = 0;
      c.mem.consumed = c.mem.consumed! + 1;
      c.say(`takes item ${v} from slot ${c.r.o}`);
    } },
    { text: `out = (o + 1) mod ${o.slots}`, run(c) { c.mem.out = (c.r.o! + 1) % o.slots; } },
    ...unlock,
    { ...V("empty"), run(c) {
      c.mem.empty = c.mem.empty! + 1;
      c.say(`empty goes up to ${c.mem.empty}`);
      c.r.k = (c.r.k ?? 0) + 1;
      if (c.r.k < perConsumer) return "loop";
      return undefined;
    } },
  ];
  return {
    name: `buffer-${o.variant}`,
    threads: [...Array.from({ length: o.producers }, (_, t) => producer(t)), ...Array.from({ length: o.consumers }, () => consumer())],
    names: [...Array.from({ length: o.producers }, (_, t) => `P${t}`), ...Array.from({ length: o.consumers }, (_, t) => `C${t}`)],
    mem,
  };
}

export function checkBuffer(opts: BufferOpts = {}) {
  return explore(machineModel(boundedBufferProg(opts)));
}

// ---------------------------------------------------------------- dining philosophers

export type DiningVariant = "naive" | "ordered" | "room";

export function diningProg(n = 5, variant: DiningVariant = "naive"): Prog {
  const mem: Record<string, number> = { room: n - 1 };
  for (let i = 0; i < n; i++) mem[`fork${i}`] = 1;
  const thread = (i: number): Ins[] => {
    const left = i;
    const right = (i + 1) % n;
    const [a, b] = variant === "ordered" ? [Math.min(left, right), Math.max(left, right)] : [left, right];
    const code: Ins[] = [];
    if (variant === "room") code.push(P("room"));
    code.push(
      { ...P(`fork${a}`), text: `P(fork ${a})` },
      { ...P(`fork${b}`), text: `P(fork ${b})` },
      { text: "eat", kind: "cs", run(c) { c.say(`philosopher ${i} eats`); } },
      { ...V(`fork${b}`), text: `V(fork ${b})` },
      { ...V(`fork${a}`), text: `V(fork ${a})` },
    );
    if (variant === "room") code.push(V("room"));
    return code;
  };
  return { name: `dining-${variant}`, threads: Array.from({ length: n }, (_, i) => thread(i)), mem };
}

export function checkDining(n = 5, variant: DiningVariant = "naive") {
  return explore(machineModel(diningProg(n, variant)));
}

// ---------------------------------------------------------------- readers and writers

export type RwPolicy = "reader" | "writer" | "fair";

export const RW_LABEL: Record<RwPolicy, string> = { reader: "Reader preference", writer: "Writer preference", fair: "Fair (FIFO)" };

export interface RwConfig {
  policy: RwPolicy;
  /** Arrivals per ms. */
  readerRate: number;
  writerRate: number;
  /** Mean hold times, ms. */
  readMs: number;
  writeMs: number;
  /** Simulated ms. */
  horizon?: number;
  seed?: number;
}

export interface RwRequest { kind: "R" | "W"; arrive: number; start: number; end: number; id: number }

export interface RwClassStats { arrived: number; served: number; meanWait: number; p95Wait: number; maxWait: number; stillWaiting: number; oldestWaiting: number }

export interface RwResult {
  requests: RwRequest[];
  readers: RwClassStats;
  writers: RwClassStats;
  /** A writer ran together with another holder. It must stay false. */
  overlapBug: boolean;
  horizon: number;
}

export const RW_DEFAULTS = { readerRate: 6, writerRate: 0.3, readMs: 1, writeMs: 1, horizon: 200, seed: 1 };

function stats(all: RwRequest[], kind: "R" | "W", horizon: number): RwClassStats {
  const reqs = all.filter((r) => r.kind === kind);
  const served = reqs.filter((r) => r.start >= 0);
  const waits = served.map((r) => r.start - r.arrive).sort((a, b) => a - b);
  const pending = reqs.filter((r) => r.start < 0).map((r) => horizon - r.arrive);
  // A request that never ran also counts in the worst wait: it waited at least this long.
  const maxServed = waits.length ? waits[waits.length - 1]! : 0;
  return {
    arrived: reqs.length,
    served: served.length,
    meanWait: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
    p95Wait: waits.length ? waits[Math.min(waits.length - 1, Math.floor(waits.length * 0.95))]! : 0,
    maxWait: Math.max(maxServed, pending.length ? Math.max(...pending) : 0),
    stillWaiting: pending.length,
    oldestWaiting: pending.length ? Math.max(...pending) : 0,
  };
}

export function simulateRw(cfg: RwConfig): RwResult {
  const horizon = cfg.horizon ?? RW_DEFAULTS.horizon;
  const rng = mulberry32(cfg.seed ?? RW_DEFAULTS.seed);
  const exp = (mean: number) => -Math.log(1 - rng()) * mean;
  const requests: RwRequest[] = [];
  const gen = (kind: "R" | "W", rate: number) => {
    if (rate <= 0) return;
    for (let t = exp(1 / rate); t < horizon; t += exp(1 / rate)) requests.push({ kind, arrive: t, start: -1, end: -1, id: 0 });
  };
  gen("R", cfg.readerRate);
  gen("W", cfg.writerRate);
  requests.sort((a, b) => a.arrive - b.arrive);
  requests.forEach((r, i) => (r.id = i));

  const waiting: RwRequest[] = [];
  const active: RwRequest[] = [];
  let bug = false;
  let writer = false;

  const start = (r: RwRequest, now: number) => {
    if (r.kind === "W" && active.length) bug = true;
    if (r.kind === "R" && writer) bug = true;
    r.start = now;
    // Hold times are uniform around the mean, from 0.5 to 1.5 times it.
    r.end = now + (r.kind === "R" ? cfg.readMs : cfg.writeMs) * (0.5 + rng());
    active.push(r);
    if (r.kind === "W") writer = true;
    waiting.splice(waiting.indexOf(r), 1);
  };

  const dispatch = (now: number) => {
    if (cfg.policy === "reader") {
      if (writer) return;
      const readers = waiting.filter((r) => r.kind === "R");
      for (const r of readers) start(r, now);
      if (!active.length && !readers.length) {
        const w = waiting.find((r) => r.kind === "W");
        if (w) start(w, now);
      }
    } else if (cfg.policy === "writer") {
      if (writer) return;
      const w = waiting.find((r) => r.kind === "W");
      if (w) { if (!active.length) start(w, now); return; }
      for (const r of waiting.filter((x) => x.kind === "R")) start(r, now);
    } else {
      while (waiting.length && !writer) {
        const h = waiting[0]!;
        if (h.kind === "R") start(h, now);
        else if (!active.length) start(h, now);
        else break;
      }
    }
  };

  let next = 0;
  for (;;) {
    const arrive = next < requests.length ? requests[next]!.arrive : Infinity;
    let leaving: RwRequest | null = null;
    for (const a of active) if (!leaving || a.end < leaving.end) leaving = a;
    const end = leaving ? leaving.end : Infinity;
    const now = Math.min(arrive, end);
    if (now === Infinity || now > horizon) break;
    if (end <= arrive) {
      active.splice(active.indexOf(leaving!), 1);
      if (leaving!.kind === "W") writer = false;
    } else waiting.push(requests[next++]!);
    dispatch(now);
  }

  return { requests, readers: stats(requests, "R", horizon), writers: stats(requests, "W", horizon), overlapBug: bug, horizon };
}
