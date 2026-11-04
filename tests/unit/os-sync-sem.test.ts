/** Semaphores, bounded buffer, dining philosophers, readers and writers. */
import { describe, expect, test } from "vitest";
import { Semaphore, checkBuffer, checkDining, simulateRw, type RwPolicy } from "../../src/sims/os/sync";

describe("Semaphore", () => {
  test("counts, queues in FIFO order, and hands off", () => {
    const s = new Semaphore(1);
    expect(s.P(1)).toBe(true);
    expect(s.P(2)).toBe(false);
    expect(s.P(3)).toBe(false);
    expect(s.V()).toBe(2);
    expect(s.V()).toBe(3);
    expect(s.V()).toBeNull();
    expect(s.count).toBe(1);
  });
});

describe("bounded buffer", () => {
  test("correct order: no error and no deadlock in 4334 states", () => {
    expect(checkBuffer()).toMatchObject({ states: 4334, violation: null, stuck: null, trapped: 0, truncated: false });
  });
  test("mutex first: a 17-step deadlock", () => {
    const r = checkBuffer({ variant: "mutex-first" });
    expect(r.stuck?.schedule.length).toBe(17);
  });
  test("no mutex: an overwrite in 6 steps", () => {
    const r = checkBuffer({ variant: "no-mutex" });
    expect(r.violation?.schedule.length).toBe(6);
    expect(r.violation?.message).toContain("overwritten");
  });
});

describe("dining philosophers", () => {
  test("naive: deadlock in 5 steps", () => {
    expect(checkDining(5, "naive").stuck?.schedule.length).toBe(5);
  });
  test("ordered forks and the room semaphore have no deadlock", () => {
    for (const v of ["ordered", "room"] as const) expect(checkDining(5, v)).toMatchObject({ stuck: null, trapped: 0, truncated: false });
  });
});

describe("readers and writers", () => {
  const run = (policy: RwPolicy, readerRate = 6, writerRate = 0.3) => simulateRw({ policy, readerRate, writerRate, readMs: 1, writeMs: 1 });

  test("a writer never overlaps any holder, under any policy", () => {
    for (const p of ["reader", "writer", "fair"] as RwPolicy[]) for (const seed of [1, 2, 3]) {
      const r = simulateRw({ policy: p, readerRate: 4, writerRate: 0.5, readMs: 1, writeMs: 1, seed });
      expect(r.overlapBug).toBe(false);
      const ran = r.requests.filter((x) => x.start >= 0);
      for (const w of ran.filter((x) => x.kind === "W")) {
        for (const o of ran) if (o !== w) expect(o.end <= w.start || o.start >= w.end).toBe(true);
      }
    }
  });
  test("reader preference starves writers: 3 of 58 run, worst wait 199 ms", () => {
    const r = run("reader");
    expect(r.readers.meanWait.toFixed(2)).toBe("0.01");
    expect([r.writers.served, r.writers.arrived]).toEqual([3, 58]);
    expect(Math.round(r.writers.maxWait)).toBe(199);
  });
  test("writer preference: all writers run", () => {
    const r = run("writer");
    expect([r.writers.served, r.writers.arrived]).toEqual([58, 58]);
    expect(r.writers.meanWait.toFixed(2)).toBe("1.31");
    expect(r.readers.meanWait.toFixed(2)).toBe("0.85");
  });
  test("fair: 1.72 ms and 2.89 ms", () => {
    const r = run("fair");
    expect(r.readers.meanWait.toFixed(2)).toBe("1.72");
    expect(r.writers.meanWait.toFixed(2)).toBe("2.89");
  });
  test("many writers: writer preference starves readers", () => {
    const r = run("writer", 2, 0.8);
    expect([r.readers.served, r.readers.arrived]).toEqual([325, 414]);
    expect(Math.round(r.readers.maxWait)).toBe(41);
  });
});
