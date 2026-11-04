import { describe, expect, test } from "vitest";
import { initLatchState, stepLatch, blockedBy, nextLabel, runSchedule, race, rootContention, ROOT_PROTOCOLS, type Protocol, type LatchState } from "@/sims/db/btree-latch";

const leaves = (s: LatchState) => Object.values(s.nodes).filter((n) => !n.kids);
const allKeys = (s: LatchState) => leaves(s).flatMap((n) => n.keys).sort((a, b) => a - b);

/** Every interleaving of the two programs (blocked steps excluded). */
function allSchedules(p: Protocol): LatchState[] {
  const out: LatchState[] = [];
  const go = (s: LatchState, depth: number) => {
    if (depth > 40) throw new Error("too deep");
    if (s.reader.done && s.writer.done) { out.push(s); return; }
    let moved = false;
    for (const who of ["reader", "writer"] as const) {
      if (s[who].done || blockedBy(s, who)) continue;
      moved = true;
      go(stepLatch(s, who), depth + 1);
    }
    if (!moved) throw new Error(`deadlock under ${p}`);
  };
  go(initLatchState(p), 0);
  return out;
}

describe("two-thread stepper", () => {
  test("without a protocol, the race gives a wrong answer", () => {
    const s = race("none");
    expect(s.reader.done && s.writer.done).toBe(true);
    expect(s.reader.result).toBe("not found");
    expect(s.log.some((l) => l.kind === "bad")).toBe(true);
    // The reader saw B after the split: [20, 22].
    expect(s.reader.readKeys).toEqual([20, 22]);
    // And the schedule "read R, split, read B" shows B = [20] in the middle of the split.
    expect(runSchedule("none", "rwwr").reader.readKeys).toEqual([20]);
  });

  test("the writer always ends with the same tree", () => {
    for (const p of ["none", "crabbing", "blink", "olc"] as const) {
      const s = runSchedule(p, "wwwwww");
      expect(s.writer.done, p).toBe(true);
      expect(allKeys(s)).toEqual([5, 10, 20, 22, 25, 30, 40, 45]);
      expect(s.nodes.R!.keys).toEqual([20, 25, 40]);
    }
  });

  test("no protocol: some interleavings are wrong", () => {
    const ends = allSchedules("none");
    const wrong = ends.filter((s) => s.reader.result === "not found");
    expect(ends.length).toBe(15);
    expect(wrong.length).toBe(11);
  });

  for (const p of ["crabbing", "blink", "olc"] as const) {
    test(`${p}: every interleaving finds 30, with no deadlock`, () => {
      const ends = allSchedules(p);
      expect(ends.length).toBeGreaterThanOrEqual(3);
      for (const s of ends) expect(s.reader.result).toBe("found");
    });
  }

  test("crabbing blocks the writer while the reader holds R", () => {
    const s = stepLatch(initLatchState("crabbing"), "reader");
    expect(s.reader.held).toEqual({ R: "S" });
    expect(blockedBy(s, "writer")).toMatch(/S on R/);
    const s2 = stepLatch(s, "writer");
    expect(s2.writer.pc).toBe(0);
    expect(s2.log.at(-1)!.kind).toBe("wait");
  });

  test("B-link: the reader moves right past the split", () => {
    const s = race("blink");
    expect(s.reader.result).toBe("found");
    expect(s.log.some((l) => /Move right to B2/.test(l.text))).toBe(true);
    expect(s.reader.held).toEqual({});
  });

  test("OLC: a reader that overlaps the split restarts", () => {
    // Reader reads R's version and R, reads B's version; the writer then does all its work.
    const s = race("olc");
    expect(s.reader.result).toBe("found");
    const s2 = runSchedule("olc", "rrwwwwwrr" + "rrrr");
    expect(s2.reader.restarts).toBe(1);
    expect(s2.reader.result).toBe("found");
  });

  test("labels exist for every step", () => {
    for (const p of ["none", "crabbing", "blink", "olc"] as const) {
      let s = initLatchState(p);
      while (!s.writer.done) { expect(nextLabel(s, "writer")).toBeTruthy(); s = stepLatch(s, "writer"); }
      expect(nextLabel(s, "writer")).toBeNull();
    }
  });
});

describe("root latch counts (lesson 3 numbers)", () => {
  const r = rootContention({ order: 64, n: 20_000, ops: 10_000, writeFrac: 0.5 });
  test("structure facts", () => {
    expect(r.height).toBe(3);
    expect(r.writes).toBe(4984);
  });
  test("crabbing X-latches the root on every write", () => {
    expect(r.byProtocol.crabbing.rootX).toBe(r.writes);
    expect(r.byProtocol.crabbing.rootS).toBe(r.ops - r.writes);
  });
  test("optimistic descent restarts only on leaf splits", () => {
    // A full leaf forces a restart; with random keys the insert then splits it.
    expect(r.byProtocol.optimistic.restarts).toBe(r.leafSplits);
    expect(r.byProtocol.optimistic.rootX).toBe(r.byProtocol.optimistic.restarts);
  });
  test("B-link and OLC lock the root only when it changes; OLC readers write nothing", () => {
    expect(r.byProtocol.blink.rootX).toBe(r.rootChanges);
    expect(r.byProtocol.olc.rootX).toBe(r.rootChanges);
    expect(r.byProtocol.olc.rootS).toBe(0);
    expect(r.byProtocol.olc.rootLineWrites).toBe(2 * r.rootChanges);
    expect(r.byProtocol.crabbing.rootLineWrites).toBe(2 * r.ops);
  });
  test("pinned numbers", () => {
    expect(r.leafSplits).toBe(119);
    expect(r.rootChanges).toBe(7);
    expect(ROOT_PROTOCOLS.map((p) => r.byProtocol[p].rootX)).toEqual([4984, 119, 7, 7]);
    expect(ROOT_PROTOCOLS.map((p) => r.byProtocol[p].rootLineWrites)).toEqual([20000, 20238, 20014, 14]);
    expect(ROOT_PROTOCOLS.map((p) => r.byProtocol[p].maxHeld)).toEqual([3, 3, 2, 3]);
  });
});
