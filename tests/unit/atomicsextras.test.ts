import { describe, expect, test } from "vitest";
import { parse, runCxx, runTso } from "@/sims/memmodel";
import { PRESETS } from "@/sims/memmodel/presets";
import { simulateCas } from "@/demos/CasContentionDemo";
import {
  completions, counterMachine, tearMachine, isTorn, total, replay,
  casInit, casStep, casDone, casAttempts, casAttemptRange,
  abaInit, abaStep, abaDone, abaBroken, abaList,
  fenceRun, fenceRule, fenceProgram, type FenceOrd, type FenceSlots,
  HB_SCENARIOS, hbAnalyze, hbCombos, hbLitmus,
  TSO_PROGRAMS, tsoInit, tsoExec, tsoDrain, tsoOutcomes, tsoKey, scOutcomes,
  casContention,
} from "@/sims/atomicsextras";

const obj = (m: Map<string, number>) => Object.fromEntries([...m].sort());

describe("lost update (atomic-operations lesson)", () => {
  test("2 threads, load + add + store: 18 of 20 orders lose an update", () => {
    const r = completions(counterMachine(2, "split"));
    expect(total(r)).toBe(20);
    expect(obj(r)).toEqual({ "1": 18, "2": 2 });
  });
  test("2 threads, fetch_add: 2 orders, both give 2", () => {
    expect(obj(completions(counterMachine(2, "rmw")))).toEqual({ "2": 2 });
  });
  test("3 threads, load + add + store: 1680 orders, only 6 give 3", () => {
    const r = completions(counterMachine(3, "split"));
    expect(total(r)).toBe(1680);
    expect(r.get("3")).toBe(6);
    expect([...r.keys()].sort()).toEqual(["1", "2", "3"]);
    expect(obj(completions(counterMachine(3, "rmw")))).toEqual({ "3": 6 });
  });
  test("completions narrow after a prefix: both loads first always lose", () => {
    expect(obj(completions(counterMachine(2, "split"), [0, 1]))).toEqual({ "1": 6 });
    expect(replay(counterMachine(2, "split"), [0, 0, 0, 1, 1, 1]).state.count).toBe(2);
  });
  test("the split counter agrees with the litmus explorer", () => {
    const r = runCxx(parse(PRESETS["lost-update-atomic"]!.src));
    expect(new Set(r.outcomes.map((o) => o.mem.count))).toEqual(new Set([1, 2]));
  });
});

describe("torn 64-bit value", () => {
  test("two halves: 6 orders, 4 values, 2 of them torn", () => {
    const r = completions(tearMachine(false));
    expect(total(r)).toBe(6);
    expect([...r.keys()].sort()).toEqual(["00", "01", "10", "11"]);
    expect([...r.keys()].filter(isTorn).length).toBe(2);
  });
  test("one 64-bit access: 2 orders, never torn", () => {
    const r = completions(tearMachine(true));
    expect(total(r)).toBe(2);
    expect([...r.keys()].sort()).toEqual(["00", "11"]);
  });
});

describe("CAS retry loop", () => {
  test("a failed CAS returns the current value and the retry succeeds", () => {
    let s = casInit(2, 1);
    s = casStep(s, 0, "inc").state; // T0 loads 1
    s = casStep(s, 1, "inc").state; // T1 loads 1
    s = casStep(s, 1, "inc").state; // T1 CAS 1 -> 2
    const f = casStep(s, 0, "inc");
    expect(f.event).toBe("fail");
    expect(f.state.th[0]!.cur).toBe(2);
    const ok = casStep(f.state, 0, "inc");
    expect(ok.event).toBe("ok");
    expect(ok.state.x).toBe(3);
    expect(casDone(ok.state)).toBe(true);
    expect(casAttempts(ok.state)).toBe(3);
  });
  test("worst case: n(n+1)/2 attempts; best case n; never a lost update", () => {
    for (const n of [1, 2, 3, 4]) {
      const r = casAttemptRange(n);
      expect(r.min).toBe(n);
      expect(r.max).toBe((n * (n + 1)) / 2);
      expect(r.finals).toEqual([1 + n]);
    }
    expect(casAttemptRange(4).max).toBe(10);
    expect(casAttemptRange(3, "double").finals).toEqual([8]);
  });
  test("contention numbers quoted in the lesson", () => {
    const f = (n: number, b: boolean) => Number(casContention(n, 200, b).toFixed(1));
    expect(f(1, false)).toBe(1);
    expect(f(8, false)).toBe(2.7);
    expect(f(16, false)).toBe(3.7);
    expect(f(8, true)).toBe(2.0);
    expect(f(16, true)).toBe(2.4);
    for (const n of [1, 2, 4, 8, 16]) for (const b of [false, true]) expect(casContention(n, 200, b)).toBe(simulateCas(n, 200, b));
  });
});

describe("ABA", () => {
  const run = (sched: (0 | 1)[], tagged: boolean) => {
    let s = abaInit();
    for (const t of sched) s = abaStep(s, t, tagged);
    return s;
  };
  test("T1 runs between T0's reads and its CAS: the untagged CAS succeeds and top is a freed node", () => {
    const s = run([0, 0, 1, 1, 1, 0], false);
    expect(abaDone(s)).toBe(true);
    expect(s.top).toBe("B");
    expect(abaBroken(s)).toBe(true);
  });
  test("with a tag, the CAS fails, T0 retries, and the stack is correct", () => {
    const s = run([0, 0, 1, 1, 1, 0, 0, 0, 0], true);
    expect(abaDone(s)).toBe(true);
    expect(s.t0.fails).toBe(1);
    expect(abaList(s)).toEqual(["C"]);
    expect(abaBroken(s)).toBe(false);
  });
  test("without overlap there is no problem", () => {
    const s = run([0, 0, 0, 1, 1, 1], false);
    expect(abaBroken(s)).toBe(false);
  });
});

describe("fence placement agrees with the explorer", () => {
  const ORDS: FenceOrd[] = ["none", "acquire", "release", "seq_cst"];
  const all: FenceSlots[] = [];
  for (let i = 0; i < 4 ** 6; i++) all.push(Array.from({ length: 6 }, (_, k) => ORDS[Math.floor(i / 4 ** k) % 4]!) as FenceSlots);
  test("presets", () => {
    expect(fenceRun("mp", ["none", "release", "none", "none", "acquire", "none"]).weakCxx).toBe(false);
    expect(fenceRun("mp", ["none", "release", "none", "none", "none", "none"]).weakCxx).toBe(true);
    expect(fenceRun("sb", ["none", "seq_cst", "none", "none", "seq_cst", "none"]).weakTso).toBe(false);
    expect(fenceRun("sb", ["none", "release", "none", "none", "acquire", "none"]).weakCxx).toBe(true);
  });
  for (const mode of ["mp", "sb"] as const) {
    test(`${mode}: the stated rule matches runCxx for all 4096 placements`, () => {
      for (const s of all) expect(fenceRun(mode, s).weakCxx, fenceProgram(mode, s)).toBe(fenceRule(mode, s));
    }, 60_000);
  }
  test("x86: MP is never weak; SB is weak unless a seq_cst fence sits between store and load in both threads", () => {
    for (const s of all.filter((_, i) => i % 7 === 0)) {
      expect(fenceRun("mp", s).weakTso).toBe(false);
      expect(fenceRun("sb", s).weakTso).toBe(!(s[1] === "seq_cst" && s[4] === "seq_cst"));
    }
  });
});

describe("happens-before graphs agree with the explorer", () => {
  for (const sc of HB_SCENARIOS) {
    test(`${sc.id}: race verdict matches runCxx for every choice of orders`, () => {
      for (const c of hbCombos(sc)) {
        const a = hbAnalyze(sc, c);
        const r = runCxx(parse(hbLitmus(sc, c)));
        expect(r.truncated).toBe(false);
        expect(a.races.length > 0, hbLitmus(sc, c)).toBe(r.outcomes.some((o) => o.racy));
        if (!a.races.length) expect(r.outcomes.filter((o) => !o.hang).every((o) => o.regs.r0 === 42)).toBe(true);
      }
    }, 60_000);
  }
  test("vector clocks", () => {
    const chain = HB_SCENARIOS.find((s) => s.id === "chain")!;
    const a = hbAnalyze(chain, { sa: "release", la: "acquire", sb: "release", lb: "acquire" });
    expect(a.vc.r).toEqual([2, 2, 2]);
    expect(a.hb("w", "r")).toBe(true);
    const b = hbAnalyze(chain, { sa: "release", la: "acquire", sb: "relaxed", lb: "acquire" });
    expect(b.vc.r).toEqual([0, 0, 2]);
    expect(b.races).toEqual([["w", "r"]]);
    const rs = HB_SCENARIOS.find((s) => s.id === "relseq")!;
    expect(hbAnalyze(rs, { s: "release", l: "acquire" }).sw).toEqual([["s", "l"]]);
    const st = HB_SCENARIOS.find((s) => s.id === "store")!;
    expect(hbAnalyze(st, { s: "release", l: "acquire" }).sw).toEqual([]);
  });
});

describe("store-buffer stepper agrees with x86-TSO", () => {
  const regs = (id: string, buffered: boolean) =>
    [...new Set(runTso(parse(PRESETS[id]!.src), buffered).outcomes.map((o) => o.key.split(" · ")[0]!))].sort();
  for (const p of TSO_PROGRAMS) {
    test(p.id, () => {
      expect(tsoOutcomes(p)).toEqual(regs(p.litmus, true));
      expect(scOutcomes(p)).toEqual(regs(p.litmus, false));
    });
  }
  test("numbers quoted: SB has 4 outcomes on x86 and 3 under SC; seq_cst removes the fourth", () => {
    const sb = TSO_PROGRAMS.find((p) => p.id === "sb")!;
    expect(tsoOutcomes(sb).length).toBe(4);
    expect(scOutcomes(sb).length).toBe(3);
    expect(tsoOutcomes(sb)).toContain(sb.weak);
    expect(tsoOutcomes(TSO_PROGRAMS.find((p) => p.id === "sb-sc")!)).not.toContain(sb.weak);
    expect(tsoOutcomes(TSO_PROGRAMS.find((p) => p.id === "mp")!)).not.toContain("r0=1 r1=0");
  });
  test("by hand: both stores wait in the buffers while both loads read 0", () => {
    const p = TSO_PROGRAMS.find((x) => x.id === "sb")!;
    let s = tsoInit(p);
    s = tsoExec(p, s, 0); s = tsoExec(p, s, 1); s = tsoExec(p, s, 0); s = tsoExec(p, s, 1);
    expect(s.mem).toEqual({ x: 0, y: 0 });
    s = tsoDrain(tsoDrain(s, 0), 1);
    expect(tsoKey(p, s)).toBe("r0=0 r1=0");
    expect(s.mem).toEqual({ x: 1, y: 1 });
  });
});
