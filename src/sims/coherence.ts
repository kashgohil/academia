/**
 * Snooping cache coherence (MSI, MESI, MOESI) on an atomic bus, with directory-protocol
 * message counts computed alongside for comparison.
 *
 * Each core has a small fully associative LRU cache of whole lines. A line holds one value
 * (enough to show who supplies data and when memory is stale).
 */

export type Protocol = "MSI" | "MESI" | "MOESI";
export type St = "M" | "O" | "E" | "S" | "I";

export interface Counters {
  hits: number;
  misses: number;
  busRd: number;
  busRdX: number;
  busUpgr: number;
  /** Lines written back to memory (evictions of dirty lines, and M flushes on BusRd in MSI/MESI). */
  memWrites: number;
  memReads: number;
  /** Data supplied by another cache instead of memory. */
  c2c: number;
  /** Copies invalidated in other caches. */
  invalidations: number;
  cycles: number;
  /** Point-to-point messages a directory protocol would need for the same accesses. */
  dirMsgs: number;
}

export const LAT = { hit: 4, c2c: 40, mem: 100, upgr: 30 };

interface Line { addr: number; st: St; val: number; lru: number }

export interface Event { core: number; text: string; bus: "BusRd" | "BusRdX" | "BusUpgr" | "WB" | null }

const zero = (): Counters => ({ hits: 0, misses: 0, busRd: 0, busRdX: 0, busUpgr: 0, memWrites: 0, memReads: 0, c2c: 0, invalidations: 0, cycles: 0, dirMsgs: 0 });

export class Coherence {
  caches: Line[][];
  mem = new Map<number, number>();
  c = zero();
  log: Event[] = [];
  private clock = 0;

  constructor(public cores: number, public capacity: number, public protocol: Protocol) {
    this.caches = Array.from({ length: cores }, () => []);
  }

  get busTransactions() {
    return this.c.busRd + this.c.busRdX + this.c.busUpgr;
  }

  state(core: number, addr: number): St {
    return this.caches[core]!.find((l) => l.addr === addr)?.st ?? "I";
  }

  value(core: number, addr: number): number | null {
    const l = this.caches[core]!.find((x) => x.addr === addr);
    return l ? l.val : null;
  }

  memValue(addr: number) {
    return this.mem.get(addr) ?? 0;
  }

  private emit(core: number, text: string, bus: Event["bus"] = null) {
    this.log.push({ core, text, bus });
  }

  private others(core: number, addr: number) {
    const out: { k: number; line: Line }[] = [];
    this.caches.forEach((c, k) => {
      if (k === core) return;
      const line = c.find((l) => l.addr === addr && l.st !== "I");
      if (line) out.push({ k, line });
    });
    return out;
  }

  private evictIfFull(core: number) {
    const c = this.caches[core]!;
    if (c.length < this.capacity) return;
    const victim = c.reduce((a, b) => (a.lru <= b.lru ? a : b));
    c.splice(c.indexOf(victim), 1);
    if (victim.st === "M" || victim.st === "O") {
      this.mem.set(victim.addr, victim.val);
      this.c.memWrites++;
      this.c.dirMsgs += 2; // writeback + ack
      this.emit(core, `evicts dirty line ${lineName(victim.addr)}: write back`, "WB");
    } else if (victim.st !== "I") {
      this.c.dirMsgs += 1; // eviction notice keeps the directory's sharer list exact
    }
  }

  private install(core: number, addr: number, st: St, val: number) {
    this.evictIfFull(core);
    this.caches[core]!.push({ addr, st, val, lru: ++this.clock });
  }

  read(core: number, addr: number): number {
    const mine = this.caches[core]!.find((l) => l.addr === addr && l.st !== "I");
    if (mine) {
      mine.lru = ++this.clock;
      this.c.hits++;
      this.c.cycles += LAT.hit;
      this.emit(core, `reads ${lineName(addr)}: hit (${mine.st})`);
      return mine.val;
    }
    this.c.misses++;
    this.c.busRd++;
    this.c.dirMsgs += 1; // request to directory
    const others = this.others(core, addr);
    const owner = others.find((o) => o.line.st === "M" || o.line.st === "O" || o.line.st === "E");
    let val: number;
    let from: string;
    if (owner && (owner.line.st === "M" || owner.line.st === "O" || this.protocol !== "MSI")) {
      val = owner.line.val;
      this.c.c2c++;
      this.c.cycles += LAT.c2c;
      this.c.dirMsgs += 2; // forward to owner + data to requester
      from = `C${owner.k} supplies it`;
      if (owner.line.st === "M") {
        if (this.protocol === "MOESI") owner.line.st = "O";
        else {
          owner.line.st = "S";
          this.mem.set(addr, val);
          this.c.memWrites++;
          this.c.dirMsgs += 1; // owner also updates memory
          from += " and writes memory back";
        }
      } else if (owner.line.st === "E") owner.line.st = "S";
    } else {
      val = this.memValue(addr);
      this.c.memReads++;
      this.c.cycles += LAT.mem;
      this.c.dirMsgs += 1; // data from memory
      from = "memory supplies it";
    }
    const st: St = this.protocol !== "MSI" && others.length === 0 ? "E" : "S";
    this.install(core, addr, st, val);
    this.emit(core, `reads ${lineName(addr)}: miss → BusRd; ${from}; now ${st}`, "BusRd");
    return val;
  }

  write(core: number, addr: number, val: number) {
    const mine = this.caches[core]!.find((l) => l.addr === addr && l.st !== "I");
    const others = this.others(core, addr);
    const invalidate = () => {
      for (const o of others) o.line.st = "I";
      this.c.invalidations += others.length;
      this.c.dirMsgs += 2 * others.length; // invalidation + ack per sharer
    };
    if (mine && (mine.st === "M" || mine.st === "E")) {
      const was = mine.st;
      mine.st = "M";
      mine.val = val;
      mine.lru = ++this.clock;
      this.c.hits++;
      this.c.cycles += LAT.hit;
      this.emit(core, `writes ${lineName(addr)}: hit in ${was}${was === "E" ? ", silently → M" : ""}`);
      return;
    }
    if (mine) {
      // S or O: we have the data but not exclusive ownership.
      this.c.hits++;
      this.c.busUpgr++;
      this.c.dirMsgs += 2; // request + grant
      invalidate();
      mine.st = "M";
      mine.val = val;
      mine.lru = ++this.clock;
      this.c.cycles += LAT.upgr;
      this.emit(core, `writes ${lineName(addr)}: upgrade → BusUpgr; invalidates ${others.map((o) => `C${o.k}`).join(", ") || "nobody"}; now M`, "BusUpgr");
      return;
    }
    this.c.misses++;
    this.c.busRdX++;
    this.c.dirMsgs += 1;
    const owner = others.find((o) => o.line.st === "M" || o.line.st === "O");
    if (owner) {
      this.c.c2c++;
      this.c.cycles += LAT.c2c;
      this.c.dirMsgs += 2;
    } else {
      this.c.memReads++;
      this.c.cycles += LAT.mem;
      this.c.dirMsgs += 1;
    }
    invalidate();
    this.install(core, addr, "M", val);
    this.emit(core, `writes ${lineName(addr)}: miss → BusRdX; ${owner ? `C${owner.k} supplies data` : "memory supplies data"}; invalidates ${others.map((o) => `C${o.k}`).join(", ") || "nobody"}; now M`, "BusRdX");
  }

  /** Single-writer / multiple-reader invariant and value agreement; returns a problem or null. */
  check(): string | null {
    const addrs = new Set(this.caches.flatMap((c) => c.map((l) => l.addr)));
    for (const a of addrs) {
      const holders = this.caches.map((c) => c.find((l) => l.addr === a && l.st !== "I")).filter((l): l is Line => !!l);
      const excl = holders.filter((l) => l.st === "M" || l.st === "E");
      if (excl.length && holders.length > 1) return `${lineName(a)}: ${excl[0]!.st} copy coexists with other copies`;
      if (holders.filter((l) => l.st === "O").length > 1) return `${lineName(a)}: two owners`;
      const vals = new Set(holders.map((l) => l.val));
      if (vals.size > 1) return `${lineName(a)}: caches disagree on its value`;
      if (holders.length && !holders.some((l) => l.st === "M" || l.st === "O") && holders[0]!.val !== this.memValue(a)) return `${lineName(a)}: clean copy differs from memory`;
    }
    return null;
  }
}

export const lineName = (addr: number) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[addr] ?? `L${addr}`;

// ---------------- workloads ----------------

export type Access = { core: number; op: "R" | "W"; addr: number };

export interface Workload { id: string; label: string; note: string; gen: (cores: number) => Access[] }

export const WORKLOADS: Workload[] = [
  {
    id: "private",
    label: "Private read-then-write",
    note: "Each core reads, then updates, its own lines.",
    gen: (n) => {
      const out: Access[] = [];
      for (let j = 0; j < 4; j++) for (let k = 0; k < n; k++) out.push({ core: k, op: "R", addr: k * 4 + j }, { core: k, op: "W", addr: k * 4 + j });
      return out;
    },
  },
  {
    id: "read-shared",
    label: "Read-shared table",
    note: "Every core reads the same 4 lines repeatedly (a lookup table).",
    gen: (n) => Array.from({ length: 16 * n }, (_, i) => ({ core: i % n, op: "R" as const, addr: Math.floor(i / n) % 4 })),
  },
  {
    id: "producer-consumer",
    label: "Producer → consumers",
    note: "Core 0 rewrites a line; every other core then reads it. Repeated 8 times.",
    gen: (n) => Array.from({ length: 8 }, () => [{ core: 0, op: "W" as const, addr: 0 }, ...Array.from({ length: n - 1 }, (_, k) => ({ core: k + 1, op: "R" as const, addr: 0 }))]).flat(),
  },
  {
    id: "migratory",
    label: "Shared counter (migratory)",
    note: "Cores take turns doing counter += 1 (read, then write) on one line.",
    gen: (n) => Array.from({ length: 8 * n }, (_, i) => [{ core: i % n, op: "R" as const, addr: 0 }, { core: i % n, op: "W" as const, addr: 0 }]).flat(),
  },
  {
    id: "false-sharing",
    label: "False sharing",
    note: "Each core increments its own counter, but all counters sit in one 64-byte line.",
    gen: (n) => Array.from({ length: 8 * n }, (_, i) => [{ core: i % n, op: "R" as const, addr: 0 }, { core: i % n, op: "W" as const, addr: 0 }]).flat(),
  },
  {
    id: "padded",
    label: "Padded counters",
    note: "The same counters, each padded to its own line.",
    gen: (n) => Array.from({ length: 8 * n }, (_, i) => [{ core: i % n, op: "R" as const, addr: i % n }, { core: i % n, op: "W" as const, addr: i % n }]).flat(),
  },
];

export function runWorkload(accesses: Access[], cores: number, protocol: Protocol, capacity = 8): Coherence {
  const c = new Coherence(cores, capacity, protocol);
  let v = 0;
  for (const a of accesses) {
    if (a.op === "R") c.read(a.core, a.addr);
    else c.write(a.core, a.addr, ++v);
  }
  return c;
}
