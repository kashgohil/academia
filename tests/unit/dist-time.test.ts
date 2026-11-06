/** Time and order: properties of the clocks on random runs, and every number that the five lessons quote. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  LESSON_RUN, addLocal, addSend, deliver, emptyRun, happensBefore, inFlight, randomRun, relation, scriptRun, type Run,
} from "@/sims/dist/time/events";
import { concurrentShare, converseStats, lamportMutex, lamportStamps, lamportTotalLess } from "@/sims/dist/time/lamport";
import { vcCompare, vcLess, vcBytes, vectorStamps } from "@/sims/dist/time/vector";
import { KV_CONCURRENT, kvReplay, lostItems, type KvAction } from "@/sims/dist/time/kv";
import { driftPerDay, driftSeries, hoursToDiverge, lwwRun, measureDuration, smearAbsorbed, smearPpm, MS_PER_HOUR } from "@/sims/dist/time/clocks";
import { clockFilter, cristianEstimate, ntpExchange, syncRun, wedgeSamples, type NtpSample } from "@/sims/dist/time/ntp";
import { hlcLess, hlcPack, hlcRecv, hlcRun, hlcStamps, hlcUnpack, uncertainRead, UNCERTAIN_DEFAULT } from "@/sims/dist/time/hlc";

/** A random hand-built run, with messages delivered in a random order. */
function builderRun(seed: number, n: number, steps: number): Run {
  const rng = mulberry32(seed);
  let r = emptyRun(n);
  for (let k = 0; k < steps; k++) {
    const fly = inFlight(r);
    const x = rng();
    if (fly.length && x < 0.35) r = deliver(r, fly[Math.floor(rng() * fly.length)]!.id);
    else if (x < 0.65) r = addLocal(r, Math.floor(rng() * n));
    else { const a = Math.floor(rng() * n); let b = Math.floor(rng() * (n - 1)); if (b >= a) b++; r = addSend(r, a, b); }
  }
  return r;
}

const runs = (): Run[] => [
  ...Array.from({ length: 30 }, (_, s) => builderRun(s + 1, 2 + (s % 4), 30)),
  ...Array.from({ length: 30 }, (_, s) => randomRun({ seed: s + 1, n: 2 + (s % 4), sendProb: 0.1 + (s % 9) / 10, duration: 150 }).run),
];

describe("logical clocks against happens-before", () => {
  test("a → b if and only if V(a) < V(b), on random runs", () => {
    for (const run of runs()) {
      const hb = happensBefore(run);
      const V = vectorStamps(run);
      for (let a = 0; a < run.events.length; a++)
        for (let b = 0; b < run.events.length; b++) {
          if (a === b) continue;
          const r = relation(hb, a, b);
          expect(vcLess(V[a]!, V[b]!)).toBe(r === "before");
          expect(vcCompare(V[a]!, V[b]!) === "concurrent").toBe(r === "concurrent");
        }
    }
  });

  test("Lamport clocks satisfy the clock condition, and the total order extends it", () => {
    for (const run of runs()) {
      const hb = happensBefore(run);
      const L = lamportStamps(run);
      for (let a = 0; a < run.events.length; a++)
        for (let b = 0; b < run.events.length; b++)
          if (relation(hb, a, b) === "before") {
            expect(L[a]!).toBeLessThan(L[b]!);
            expect(lamportTotalLess(L[a]!, run.events[a]!.proc, L[b]!, run.events[b]!.proc)).toBe(true);
          }
      expect(converseStats(run).violations).toBe(0);
    }
  });

  test("the preset run: stamps, the marked pair, and the counts in the demo", () => {
    const run = scriptRun(3, LESSON_RUN);
    expect(lamportStamps(run)).toEqual([1, 2, 1, 2, 3, 1, 3, 4, 5, 3]);
    const V = vectorStamps(run);
    expect(V[9]).toEqual([3, 0, 0]); // j
    expect(V[7]).toEqual([2, 3, 0]); // h
    expect(V[8]).toEqual([2, 3, 4]); // i
    expect(vcCompare(V[9]!, V[7]!)).toBe("concurrent");
    const hb = happensBefore(run);
    expect(relation(hb, 0, 8)).toBe("before");
    const L = lamportStamps(run);
    let conc = 0, differ = 0;
    for (let a = 0; a < 10; a++) for (let b = a + 1; b < 10; b++) if (relation(hb, a, b) === "concurrent") { conc++; if (L[a] !== L[b]) differ++; }
    expect([conc, differ]).toEqual([24, 17]);
    // Clear, 3 local events on P3, then P1 sends to P3: the receive is 4.
    const r2 = deliver(addSend(addLocal(addLocal(addLocal(emptyRun(3), 2), 2), 2), 0, 2), 0);
    expect(lamportStamps(r2)[4]).toBe(4);
  });

  test("the converse fails: share of ordered pairs that are concurrent (lesson numbers)", () => {
    expect(concurrentShare(0.3)).toBeCloseTo(0.36, 2);
    expect(concurrentShare(0.05)).toBeCloseTo(0.55, 2);
    expect(concurrentShare(1)).toBeCloseTo(0.15, 2);
  });

  test("vector size: 1,000 writers at 16 bytes per entry is 16 KB", () => {
    expect(vcBytes(1000)).toBe(16_000);
  });
});

describe("Lamport's mutual exclusion", () => {
  test("defaults: 18 messages for 3 grants, 3(N − 1) per grant, safe", () => {
    const r = lamportMutex();
    expect(r.messages).toBe(18);
    expect(r.holds.length).toBe(3);
    expect(r.violation).toBe(false);
  });

  test("the adversary: a slow request breaks it without FIFO, not with FIFO", () => {
    expect(lamportMutex({ fifo: false, slow: { from: 0, to: 1, delay: 30 } }).violation).toBe(true);
    expect(lamportMutex({ fifo: true, slow: { from: 0, to: 1, delay: 30 } }).violation).toBe(false);
  });

  test("random latencies 1 to 30 ms: 6 of 200 seeds break without FIFO, none with FIFO", () => {
    const count = (fifo: boolean) => Array.from({ length: 200 }, (_, s) => lamportMutex({ fifo, seed: s + 1, latency: { min: 1, max: 30 } })).filter((r) => r.violation).length;
    expect(count(false)).toBe(6);
    expect(count(true)).toBe(0);
  });

  test("every request is granted exactly once with FIFO", () => {
    for (let s = 1; s <= 50; s++) expect(lamportMutex({ fifo: true, seed: s, latency: { min: 1, max: 30 } }).holds.length).toBe(3);
  });
});

describe("version-vector store", () => {
  test("concurrent adds through one replica: lww and per-replica vectors lose milk; dotted vectors keep siblings", () => {
    expect(lostItems(kvReplay("lww", KV_CONCURRENT))).toEqual(["milk"]);
    expect(lostItems(kvReplay("vv", KV_CONCURRENT))).toEqual(["milk"]);
    const d = kvReplay("dvv", KV_CONCURRENT);
    expect(lostItems(d)).toEqual([]);
    expect(d.replicas[0]!.values).toEqual([["milk"], ["eggs"]]);
    expect(d.replicas[0]!.dots).toEqual([[0, 1], [0, 2]]);
  });

  test("a read and a write merge the siblings; a concurrent write on R2 makes a sibling after sync", () => {
    const merge: KvAction[] = [...KV_CONCURRENT, { k: "read", c: 0, r: 0 }, { k: "write", c: 0, r: 0, item: "bread" }];
    const m = kvReplay("dvv", merge);
    expect(m.clients[0]!.read!.ctx).toEqual([2, 0]);
    expect(m.replicas[0]!.values).toEqual([["bread", "eggs", "milk"]]);
    const s = kvReplay("dvv", [...merge, { k: "write", c: 1, r: 1, item: "tea" }, { k: "sync", from: 1, to: 0 }]);
    expect(s.replicas[0]!.values).toEqual([["bread", "eggs", "milk"], ["tea"]]);
  });

  test("dotted vectors never lose an item on random action lists, after a full sync", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    for (let seed = 1; seed <= 100; seed++) {
      const rng = mulberry32(seed);
      const acts: KvAction[] = [];
      let w = 0;
      for (let k = 0; k < 14; k++) {
        const x = rng(), c = Math.floor(rng() * 2), r = Math.floor(rng() * 2);
        if (x < 0.35) acts.push({ k: "read", c, r });
        else if (x < 0.75 && w < items.length) acts.push({ k: "write", c, r, item: items[w++]! });
        else acts.push({ k: "sync", from: r, to: 1 - r });
      }
      acts.push({ k: "sync", from: 0, to: 1 }, { k: "sync", from: 1, to: 0 });
      const st = kvReplay("dvv", acts);
      expect(lostItems(st), `seed ${seed}`).toEqual([]);
      const norm = (vs: string[][]) => vs.map((v) => v.join(",")).sort();
      expect(norm(st.replicas[0]!.values)).toEqual(norm(st.replicas[1]!.values));
    }
  });
});

describe("physical clocks (lesson 1 numbers)", () => {
  test("drift per day", () => {
    expect(driftPerDay(1)).toBeCloseTo(86.4, 6);
    expect(driftPerDay(20)).toBeCloseTo(1728, 6);
    expect(driftPerDay(50)).toBeCloseTo(4320, 6);
    expect(driftPerDay(100)).toBeCloseTo(8640, 6);
  });

  test("the drift demo defaults: 4.75 s apart after 24 h, 100 ms after about 30 minutes", () => {
    const s = driftSeries({ ppm: [20, -35, 5], offset: [0, 0, 0], hours: 24, samples: 120 });
    expect(s.finalSpread / 1000).toBeCloseTo(4.75, 2);
    expect(s.spread.find((p) => p[1] > 100)![0]).toBeCloseTo(0.6, 6);
    expect(hoursToDiverge(100, 55) * 3600).toBeCloseTo(1818, 0);
    expect(hoursToDiverge(100, 55) * 60).toBeCloseTo(30.3, 1);
  });

  test("the drift demo uses Net's clock: error grows linearly", () => {
    const s = driftSeries({ ppm: [20], offset: [300], hours: 72, samples: 3 });
    expect(s.error[0]!.map((p) => p[1])).toEqual([300, 300 + 24 * MS_PER_HOUR * 20e-6, 300 + 48 * MS_PER_HOUR * 20e-6, 300 + 72 * MS_PER_HOUR * 20e-6].map((x) => expect.closeTo(x, 6)));
  });

  test("wall versus monotonic: −700 ms and 300 ms; a +500 ms step gives 800 ms", () => {
    expect(measureDuration({ work: 300, stepAt: 120, step: -1000 })).toEqual({ wall: -700, monotonic: 300 });
    expect(measureDuration({ work: 300, stepAt: -50, step: -1000 })).toEqual({ wall: 300, monotonic: 300 });
    expect(measureDuration({ work: 300, stepAt: 120, step: 500 }).wall).toBe(800);
  });

  test("a 24-hour smear is about 11.6 ppm, and half the second is absorbed at the middle", () => {
    expect(smearPpm()).toBeCloseTo(11.574, 3);
    expect(smearAbsorbed(12 * MS_PER_HOUR)).toBe(500);
  });

  test("last write wins loses the later write exactly when skew > gap", () => {
    expect(lwwRun().lost).toBe(true); // skew 40, gap 25
    expect(lwwRun({ skew: 20, gap: 25 }).lost).toBe(false);
    for (let skew = 0; skew <= 100; skew += 5) for (let gap = 0; gap <= 100; gap += 5) expect(lwwRun({ skew, gap }).lost).toBe(skew > gap);
  });
});

describe("NTP (lesson 2 numbers and the error bound)", () => {
  test("Cristian: 500 + (120 − 100) / 2 = 510", () => {
    expect(cristianEstimate(100, 500, 120)).toBe(510);
  });

  test("the exchange demo: symmetric paths are exact; 20 out, 5 back is off by 7.5 with δ = 25", () => {
    const sym = ntpExchange({ clientOffset: 30, out: 10, back: 10, proc: 2 }).sample;
    expect(sym.theta).toBeCloseTo(-30, 9);
    expect(sym.delta).toBeCloseTo(20, 9);
    const a = ntpExchange({ clientOffset: 30, out: 20, back: 5, proc: 2 }).sample;
    expect(a.theta).toBeCloseTo(-22.5, 9);
    expect(a.error).toBeCloseTo(7.5, 9);
    expect(a.delta).toBeCloseTo(25, 9);
    expect(ntpExchange({ clientOffset: 30, out: 20, back: 5, proc: 15 }).sample.theta).toBeCloseTo(-22.5, 9);
  });

  test("property: error = (out − back) / 2 exactly, and |error| ≤ δ / 2", () => {
    const rng = mulberry32(9);
    for (let k = 0; k < 500; k++) {
      const out = 0.1 + rng() * 80, back = 0.1 + rng() * 80;
      const s = ntpExchange({ clientOffset: (rng() - 0.5) * 1000, out, back, proc: rng() * 20 }).sample;
      expect(s.error).toBeCloseTo((out - back) / 2, 6);
      expect(Math.abs(s.error)).toBeLessThanOrEqual(s.delta / 2 + 1e-9);
    }
  });

  test("property: with drift during the exchange, the error stays within half the asymmetry plus the drift over the round trip", () => {
    const rng = mulberry32(10);
    for (let k = 0; k < 300; k++) {
      const out = rng() * 50, back = rng() * 50, ppm = (rng() - 0.5) * 200, proc = rng() * 10;
      const s = ntpExchange({ clientOffset: 7, out, back, proc, driftPpm: ppm, start: rng() * 1e6 }).sample;
      expect(Math.abs(s.error)).toBeLessThanOrEqual(Math.abs(out - back) / 2 + Math.abs(ppm) * 1e-6 * (out + back + proc) + 1e-6);
    }
  });

  test("the wedge: every sample within δ / 2; filter picks are better (3.86 vs 1.00 ms)", () => {
    const w = wedgeSamples();
    for (const s of w) expect(Math.abs(s.error)).toBeLessThanOrEqual(s.delta / 2);
    const picks = Array.from({ length: 25 }, (_, k) => clockFilter(w, k * 8 + 7));
    const mean = (xs: NtpSample[]) => xs.reduce((a, s) => a + Math.abs(s.error), 0) / xs.length;
    expect(mean(w)).toBeCloseTo(3.86, 2);
    expect(mean(picks)).toBeCloseTo(1.0, 2);
  });

  test("the saw-tooth: walk 3.2 ms at 50 ppm and 64 s, largest error 4.5 ms; 51.2 ms at 1024 s", () => {
    const r = syncRun();
    expect(r.walk).toBeCloseTo(3.2, 9);
    expect(r.maxAfter).toBeCloseTo(4.48, 2);
    expect(syncRun({ interval: 1024, duration: 8192 }).walk).toBeCloseTo(51.2, 9);
  });

  test("frequency correction and the filter reduce the error", () => {
    const base = syncRun({ queue: 10, seed: 3, duration: 4096 });
    const better = syncRun({ queue: 10, seed: 3, duration: 4096, filter: true, freq: true });
    expect(better.maxAfter).toBeLessThan(base.maxAfter);
  });

  test("slewing at 0.5 ms per second takes 2,000 s per second of error", () => {
    expect(1000 / 0.5).toBe(2000);
  });
});

describe("hybrid logical clocks", () => {
  const cases = Array.from({ length: 40 }, (_, s) => {
    const rng = mulberry32(100 + s);
    const n = 2 + (s % 4);
    return {
      n, seed: s + 1, duration: 200, meanGap: 0.3 + rng() * 30, sendProb: rng(), latency: { min: 1, max: 1 + rng() * 30 },
      drift: Array.from({ length: n }, () => (rng() - 0.5) * 0.02), offset: Array.from({ length: n }, () => Math.round((rng() - 0.5) * 200)),
    };
  });

  test("property: l never lags physical time, and l − pt ≤ ε, the largest clock gap", () => {
    for (const c of cases) {
      const h = hlcRun(c);
      expect(h.minAhead).toBeGreaterThanOrEqual(0);
      expect(h.maxAhead).toBeLessThanOrEqual(h.eps);
      h.run.events.forEach((e, i) => expect(h.hlc[i]!.l).toBeGreaterThanOrEqual(e.pt!));
    }
  });

  test("property: a → b implies HLC(a) < HLC(b)", () => {
    for (const c of cases.slice(0, 20)) {
      const h = hlcRun({ ...c, duration: 80 });
      const hb = happensBefore(h.run);
      for (let a = 0; a < h.run.events.length; a++)
        for (let b = 0; b < h.run.events.length; b++)
          if (relation(hb, a, b) === "before") expect(hlcLess(h.hlc[a]!, h.hlc[b]!)).toBe(true);
    }
  });

  test("property: c stays below N(ε + 1)", () => {
    for (const c of cases) {
      const h = hlcRun(c);
      expect(h.maxC).toBeLessThan(c.n * (h.eps + 1));
    }
  });

  test("the receive rule of the Predict: (10,0) with pt 10 receiving (52,0) gives (52,1)", () => {
    expect(hlcRecv({ l: 10, c: 0 }, { l: 52, c: 0 }, 10).h).toEqual({ l: 52, c: 1 });
  });

  test("the stepper demo defaults: ε 60, largest l − pt 54, smallest 0, largest c 5; P1 takes (47,1)", () => {
    const h = hlcRun({ duration: 160, meanGap: 22, seed: 3, sendProb: 0.6, drift: [0, 0, 0.05], offset: [0, 40, -20], latency: { min: 4, max: 14 } });
    expect([h.eps, h.maxAhead, h.minAhead, h.maxC]).toEqual([60, 54, 0, 5]);
    expect(h.hlc[0]).toEqual({ l: 40, c: 0 });
    expect(h.hlc[4]).toEqual({ l: 47, c: 1 });
    expect([h.hlc[6], h.hlc[9], h.hlc[11]]).toEqual([{ l: 47, c: 2 }, { l: 47, c: 3 }, { l: 48, c: 0 }]);
    const z = hlcRun({ duration: 160, meanGap: 22, seed: 3, sendProb: 0.6, drift: [0, 0, 0], offset: [0, 0, 0], latency: { min: 4, max: 14 } });
    expect(z.maxAhead).toBe(0);
  });

  test("the compare demo: at 10 ms both hybrids stay near; at 0.3 ms the naive one runs 615 ms ahead and HLC stays at 57 ≤ 60", () => {
    const run = (meanGap: number, spread = 40) => hlcRun({ duration: 300, meanGap, seed: 4, sendProb: 0.6, drift: [0, 0, 0], offset: [0, spread, -spread / 2], latency: { min: 3, max: 12 } });
    const slow = run(10);
    expect([slow.maxNaiveAhead, slow.maxAhead, slow.eps]).toEqual([55, 54, 60]);
    const fast = run(0.3);
    expect([fast.maxNaiveAhead, fast.maxAhead, fast.eps, fast.maxC]).toEqual([615, 57, 60, 35]);
    const flat = run(10, 0);
    expect([flat.eps, flat.maxAhead]).toEqual([0, 0]);
  });

  test("48-bit l and 16-bit c pack into 64 bits and back", () => {
    const h = { l: 2 ** 47 + 12345, c: 65535 };
    expect(hlcUnpack(hlcPack(h))).toEqual(h);
    expect(hlcPack(h) < 2n ** 64n).toBe(true);
  });

  test("hlcStamps on a hand-built run with pt = 0 counts like a Lamport clock in c", () => {
    const run = scriptRun(3, LESSON_RUN);
    const s = hlcStamps(run);
    expect(s.hlc.map((h) => h.c + 1)).toEqual(lamportStamps(run));
  });

  test("the uncertainty demo: restart by default, stale with the check off, stale when the bound breaks", () => {
    expect(uncertainRead(UNCERTAIN_DEFAULT)).toEqual({ w: 120, r: 50, outcome: "restart", upper: 300 });
    expect(uncertainRead({ ...UNCERTAIN_DEFAULT, check: false }).outcome).toBe("stale");
    expect(uncertainRead({ ...UNCERTAIN_DEFAULT, writerOffset: 400 }).outcome).toBe("stale");
    expect(uncertainRead({ ...UNCERTAIN_DEFAULT, writerOffset: 400, gap: 200 })).toEqual({ w: 400, r: 200, outcome: "restart", upper: 450 });
  });

  test("property: with the check on, a stale read needs a real clock gap above the max offset", () => {
    for (let w = -300; w <= 600; w += 10) for (let r = -300; r <= 300; r += 10) for (const gap of [0, 50, 200]) {
      const o = uncertainRead({ writerOffset: w, readerOffset: r, maxOffset: 250, gap, check: true });
      if (o.outcome === "stale") expect(w - r).toBeGreaterThan(250);
    }
  });

  test("CockroachDB: 80% of the 500 ms default is 400 ms", () => {
    expect(0.8 * 500).toBe(400);
  });
});
