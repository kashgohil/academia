/** Shared memory: one frame in two address spaces, pointers and offsets, the SPSC ring, cache lines, and the cost model. */
import { describe, expect, test } from "vitest";
import {
  CORRECT_ORDERS, IPC_COST, LIST_NODES, RELAXED_ORDERS, SHM_FACTS, SHM_FILE, ShmWorld, buildList, exploreSpsc, ipcCost, privateBreaksSharing,
  spscDone, spscInitial, spscLineTraffic, spscLitmus, spscModel, spscSteps, walkList, type SpscOrders, type SpscSpec,
} from "../../src/sims/os/ipc";
import { parse, runCxx, runTso } from "../../src/sims/memmodel";
import { replay } from "../../src/sims/os/sync/machine";
import { mulberry32 } from "../../src/sims/rng";

const BASE_A = 0x7f0000000000;
const BASE_B = 0x7f5500000000;

describe("one frame, two address spaces", () => {
  test("each page reaches the same frame at different addresses", () => {
    const w = new ShmWorld(2);
    w.addProcess("A", BASE_A);
    w.addProcess("B", BASE_B);
    for (const off of [0, 0x1000]) expect(w.frameOf("A", off)).toBe(w.frameOf("B", off));
    expect(w.frameOf("A", 0)).not.toBe(w.frameOf("A", 0x1000));
    expect(w.kernel.frames.get(w.frameOf("A", 0)!)!.refs).toBe(SHM_FACTS.refsWithTwoMappers);
    expect(w.kernel.pageCache.get(`${SHM_FILE}:0`)).toBe(w.frameOf("A", 0));
    expect(w.kernel.usedFrames).toBe(2);
  });
  test("a store in one process is a load in the other", () => {
    const w = new ShmWorld(2);
    w.addProcess("A", BASE_A);
    w.addProcess("B", BASE_B);
    w.store("A", BASE_A + 0x10, 99);
    expect(w.load("B", BASE_B + 0x10).value).toBe(99);
    w.store("B", BASE_B + 0x1020, 7);
    expect(w.load("A", BASE_A + 0x1020).value).toBe(7);
  });
  test("each mapping takes its own faults", () => {
    const w = new ShmWorld(2);
    const a = w.addProcess("A", BASE_A);
    const b = w.addProcess("B", BASE_B);
    w.store("A", BASE_A, 1);
    expect(a.as.minorFaults).toBeGreaterThan(0);
    expect(b.as.minorFaults).toBe(0);
    w.load("B", BASE_B);
    expect(b.as.minorFaults).toBe(1);
  });
  test("MAP_PRIVATE breaks sharing at the first store", () => {
    const r = privateBreaksSharing();
    expect(r.sharedSees).toBe("old");
    expect(r.privateSees).toBe("from B");
  });
});

describe("stored pointers and offsets", () => {
  const values = LIST_NODES.map((n) => n.value);
  const world = (mode: "pointer" | "offset", baseB: number, heapAt?: number) => {
    const w = new ShmWorld(2);
    w.addProcess("A", BASE_A);
    w.addProcess("B", baseB, { heapAt });
    buildList(w, "A", mode);
    return w;
  };
  test("the builder can always walk its own list", () => {
    for (const m of ["pointer", "offset"] as const) expect(walkList(world(m, BASE_B), "A", m)).toMatchObject({ verdict: "ok", values });
  });
  test("offsets work at any base", () => {
    expect(walkList(world("offset", BASE_B), "B", "offset")).toMatchObject({ verdict: "ok", values });
  });
  test("a stored pointer faults in B", () => {
    const r = walkList(world("pointer", BASE_B), "B", "pointer");
    expect(r.verdict).toBe("segv");
    expect(r.hops[0]!.outcome).toBe("segv-maperr");
    expect(r.values).toEqual([]);
  });
  test("a stored pointer can read the wrong data with no fault", () => {
    const r = walkList(world("pointer", BASE_B, BASE_A), "B", "pointer");
    expect(r.verdict).toBe("garbage");
    expect(r.hops[0]!.ok).toBe(true);
    expect(r.hops[0]!.inShared).toBe(false);
    expect(r.hops[0]!.value).toBe(0);
  });
  test("a stored pointer works only if the base addresses match", () => {
    expect(walkList(world("pointer", BASE_A), "B", "pointer")).toMatchObject({ verdict: "ok", values });
  });
});

const spec = (capacity: number, messages: number, orders: SpscOrders): SpscSpec => ({ capacity, messages, orders });

describe("the SPSC ring with correct orderings", () => {
  for (const [c, m] of [[1, 2], [1, 3], [2, 3], [2, 4], [3, 4], [2, 5]] as const) {
    test(`capacity ${c}, ${m} messages: no stale read in any schedule`, () => {
      const r = exploreSpsc(spec(c, m, CORRECT_ORDERS));
      expect(r).toMatchObject({ violation: null, stuck: null, trapped: 0, truncated: false });
      const expected = Array.from({ length: m }, (_, i) => i + 1).join(",");
      expect(r.outcomes).toEqual([expected]);
    });
  }
  test("random schedules deliver in order", () => {
    const s = spec(4, 40, CORRECT_ORDERS);
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed);
      let st = spscInitial(s);
      while (!spscDone(s, st)) {
        const next = spscSteps(s, st);
        st = next[Math.floor(rng() * next.length)]!.next;
      }
      expect(st.got).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(st.stale).toBeNull();
      expect(st.racy).toBe(false);
    }
  });
});

describe("the SPSC ring with relaxed orderings", () => {
  test("the consumer can read a stale slot, and the shortest schedule shows it", () => {
    const s = spec(2, 2, RELAXED_ORDERS);
    const r = exploreSpsc(s);
    expect(r.violation).not.toBeNull();
    expect(r.violation!.schedule).toEqual(["P0", "P", "P", "C1", "C0"]);
    const trail = replay(spscModel(s, { stopAtStale: true }), r.violation!.schedule);
    const end = trail[trail.length - 1]!;
    expect(end.got).toEqual([0]);
    expect(end.c.seen).toBe(1);
    expect(end.racy).toBe(true);
  });
  test("each one of the two orderings on the tail is needed", () => {
    for (const o of [{ ...CORRECT_ORDERS, tailStore: "relaxed" }, { ...CORRECT_ORDERS, tailLoad: "relaxed" }] as SpscOrders[]) {
      expect(exploreSpsc(spec(2, 2, o)).violation).not.toBeNull();
    }
  });
  test("relaxed orderings on the head let the producer overwrite a slot in use", () => {
    const o: SpscOrders = { ...CORRECT_ORDERS, headStore: "relaxed", headLoad: "relaxed" };
    const r = exploreSpsc(spec(1, 2, o), false);
    expect(r.outcomes.some((x) => x.includes("racy"))).toBe(true);
    // With a correct tail, the values stay right in this small ring, but the race itself is undefined behavior.
    expect(exploreSpsc(spec(1, 2, CORRECT_ORDERS), false).outcomes).toEqual(["1,2"]);
  });
});

describe("agreement with src/sims/memmodel", () => {
  const cxxValues = (s: SpscSpec) => {
    const res = runCxx(parse(spscLitmus(s)));
    expect(res.truncated).toBe(false);
    return res.outcomes;
  };
  const mine = (s: SpscSpec) => exploreSpsc(s, false).outcomes;
  const norm = (regs: Record<string, number>, m: number) => Array.from({ length: m }, (_, i) => regs[`r${i}`]).join(",");
  for (const [c, m] of [[1, 2], [2, 2], [2, 3], [1, 3]] as const) {
    test(`correct orderings, capacity ${c}, ${m} messages`, () => {
      const out = cxxValues(spec(c, m, CORRECT_ORDERS));
      const want = Array.from({ length: m }, (_, i) => i + 1).join(",");
      expect(out.map((o) => norm(o.regs, m))).toEqual([want]);
      expect(out.every((o) => o.clean && !o.racy && !o.hang)).toBe(true);
    });
    test(`relaxed orderings, capacity ${c}, ${m} messages: the same values`, () => {
      const out = cxxValues(spec(c, m, RELAXED_ORDERS));
      const fromCxx = [...new Set(out.filter((o) => !o.hang).map((o) => norm(o.regs, m)))].sort();
      const fromRing = [...new Set(mine(spec(c, m, RELAXED_ORDERS)).map((x) => x.replace(" racy", "")))].sort();
      expect(fromRing).toEqual(fromCxx);
      expect(fromCxx.length).toBeGreaterThan(1);
      expect(out.filter((o) => norm(o.regs, m) !== Array.from({ length: m }, (_, i) => i + 1).join(",")).every((o) => o.racy)).toBe(true);
    });
  }
  test("the relaxed litmus has a stale outcome in the C++ model, but not on x86-TSO", () => {
    const src = spscLitmus(spec(2, 2, RELAXED_ORDERS));
    const p = parse(src);
    expect(runCxx(p).outcomes.map((o) => o.regs.r0)).toContain(0);
    const tso = runTso(p, true);
    // An exact-value await can also hang if the value moves on first. That is a limit of the litmus, so skip those.
    const done = tso.outcomes.filter((o) => !o.hang);
    expect(done.map((o) => norm(o.regs, 2))).toEqual(["1,2"]);
  });
});

describe("cache lines of the ring indices", () => {
  test("quoted transfers per message", () => {
    const t = (padded: boolean, cached: boolean) => spscLineTraffic({ padded, cached });
    // Both sides read the other index on each message: padding alone changes nothing in this schedule.
    expect(t(false, false).perMessage).toBeCloseTo(5, 2);
    expect(t(true, false).perMessage).toBeCloseTo(5, 2);
    // Cached copies alone also change nothing: each index write takes the one shared line.
    expect(t(false, true).perMessage).toBeCloseTo(5, 2);
    // Only both together help.
    expect(t(true, true).perMessage).toBeCloseTo(2.26, 2);
    expect(t(true, true).indexReadsPerMessage).toBeCloseTo(0.14, 2);
    expect(t(true, false).indexReadsPerMessage).toBe(2);
  });
});

describe("the IPC cost model", () => {
  const gib = (b: number) => b / 2 ** 30;
  test("inputs", () => {
    expect(IPC_COST).toMatchObject({ syscallNs: 150, copy4kNs: 400, coldCopy4kNs: 800, lineNs: 40, wakeNs: 5000, pipePageNs: 100, skbNs: 300 });
  });
  test("quoted latencies", () => {
    expect(ipcCost("shm", 64, true).latencyNs).toBeCloseTo(98.75, 2);
    expect(ipcCost("pipe", 64, true).latencyNs).toBeCloseTo(458.75, 2);
    expect(ipcCost("unix", 64, true).latencyNs).toBeCloseTo(658.75, 2);
    expect(ipcCost("shm", 64, false).latencyNs).toBeCloseTo(5248.75, 2);
    expect(ipcCost("pipe", 64, false).latencyNs).toBeCloseTo(5418.75, 2);
    expect(ipcCost("unix", 64, false).latencyNs).toBeCloseTo(5618.75, 2);
  });
  test("quoted rates", () => {
    expect(ipcCost("shm", 64, true).msgsPerSec / 1e6).toBeCloseTo(19.05, 2);
    expect(ipcCost("pipe", 64, true).msgsPerSec / 1e6).toBeCloseTo(3.90, 2);
    expect(ipcCost("unix", 64, true).msgsPerSec / 1e6).toBeCloseTo(2.19, 2);
    expect(gib(ipcCost("shm", 65536, true).bytesPerSec)).toBeCloseTo(4.75, 2);
    expect(gib(ipcCost("pipe", 65536, true).bytesPerSec)).toBeCloseTo(4.71, 2);
    expect(gib(ipcCost("unix", 65536, true).bytesPerSec)).toBeCloseTo(4.71, 2);
    expect(ipcCost("shm", 64, true).kernelEntries).toBe(0);
    expect(ipcCost("pipe", 64, true).kernelEntries).toBe(2);
  });
});
