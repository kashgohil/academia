/** Correctness properties of the partitioning sims. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  jumpHash, jumpHashBig, HashRing, rendezvous, maglevTable, keyName, nodeNames, CountMin, SpaceSaving, Zipf,
  moveKeys, simulateRebalance, simulateSplits, rangePartitioner, scanCost, route, makeCars, indexRace, buildLookup, benchKeys,
  type SchemeName,
} from "@/sims/dist/partitioning";

/**
 * Outputs of JumpConsistentHash, computed by compiling the C++ of Figure 1 of Lamping and Veach (2014) with
 * `c++ -O2` and printing JumpConsistentHash(key, n) for n = 1, 2, 3, 7, 10, 100, 1000, 65536.
 */
const JUMP_NS = [1, 2, 3, 7, 10, 100, 1000, 65536];
const JUMP_REF: [string, number[]][] = [
  ["0", [0, 0, 0, 0, 0, 0, 0, 0]],
  ["1", [0, 0, 0, 6, 6, 55, 549, 21134]],
  ["2", [0, 0, 0, 6, 6, 62, 338, 3927]],
  ["3", [0, 0, 2, 3, 8, 8, 961, 59579]],
  ["42", [0, 1, 2, 2, 2, 43, 571, 5747]],
  ["1000", [0, 0, 0, 5, 9, 93, 93, 31613]],
  ["123456789", [0, 0, 0, 0, 7, 34, 294, 42483]],
  ["3735928559", [0, 1, 2, 5, 5, 87, 285, 64244]],
  ["18446744073709551615", [0, 1, 2, 2, 9, 92, 313, 18311]],
  ["9223372036854775807", [0, 0, 2, 2, 8, 97, 972, 8550]],
  ["18446744073709551000", [0, 0, 2, 6, 6, 42, 42, 44607]],
];

describe("jump consistent hash", () => {
  test("matches the paper's C++ bit for bit", () => {
    for (const [k, outs] of JUMP_REF) {
      const b = BigInt(k);
      const hi = Number(b >> 32n), lo = Number(b & 0xffffffffn);
      expect(JUMP_NS.map((n) => jumpHash(hi, lo, n)), k).toEqual(outs);
      expect(JUMP_NS.map((n) => jumpHashBig(b, n)), k).toEqual(outs);
    }
  });

  test("the 32-bit version agrees with the BigInt version on random keys", () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 2000; i++) {
      const hi = Math.floor(rng() * 2 ** 32), lo = Math.floor(rng() * 2 ** 32);
      const n = 1 + Math.floor(rng() * 5000);
      expect(jumpHash(hi, lo, n)).toBe(jumpHashBig((BigInt(hi) << 32n) | BigInt(lo), n));
    }
  });

  test("going from n to n + 1 buckets moves keys only into the new bucket", () => {
    const rng = mulberry32(4);
    for (let i = 0; i < 3000; i++) {
      const hi = Math.floor(rng() * 2 ** 32), lo = Math.floor(rng() * 2 ** 32);
      for (const n of [1, 5, 17, 100]) {
        const a = jumpHash(hi, lo, n), b = jumpHash(hi, lo, n + 1);
        if (a !== b) expect(b).toBe(n);
      }
    }
  });
});

describe("adding a node moves only keys to the new node", () => {
  const K = 5000;
  for (const scheme of ["ring", "rendezvous", "jump"] as SchemeName[]) {
    test(scheme, () => {
      for (const N of [1, 3, 8, 20]) {
        const r = moveKeys(scheme, N, "add", K, { vnodes: 20 });
        expect(r.needless, `${scheme} N=${N}`).toBe(0);
        expect(r.moved).toBe(r.minimum);
      }
    });
  }
  test("removing a node moves only that node's keys (ring, rendezvous)", () => {
    for (const scheme of ["ring", "rendezvous"] as SchemeName[]) for (const ch of ["removeLast", "removeMiddle"] as const) {
      const r = moveKeys(scheme, 9, ch, K, { vnodes: 20 });
      expect(r.needless).toBe(0);
    }
  });
  test("modulo and Maglev do move other keys", () => {
    expect(moveKeys("modulo", 10, "add", K).needless).toBeGreaterThan(K / 2);
    expect(moveKeys("maglev", 10, "add", K).needless).toBeGreaterThan(0);
  });
});

describe("ring, rendezvous and Maglev", () => {
  test("ring ownership sums to 1 and agrees with lookups", () => {
    const ring = new HashRing(nodeNames(5), 30);
    const own = ring.ownership();
    expect([...own.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    const counts = new Map<string, number>();
    for (let k = 0; k < 40000; k++) { const n = ring.lookup(keyName(k)); counts.set(n, (counts.get(n) ?? 0) + 1); }
    for (const [n, f] of own) expect(Math.abs(counts.get(n)! / 40000 - f)).toBeLessThan(0.01);
  });

  test("weighted rendezvous gives each node its weight's share", () => {
    const nodes = ["a", "b", "c"], w = { a: 1, b: 2, c: 5 };
    const c: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let k = 0; k < 40000; k++) c[rendezvous(keyName(k), nodes, w)]!++;
    expect(c.a! / 40000).toBeCloseTo(1 / 8, 1);
    expect(c.c! / 40000).toBeCloseTo(5 / 8, 1);
  });

  test("a Maglev table is full and each backend owns M/N slots, plus or minus one", () => {
    const M = 65537, N = 7;
    const t = maglevTable(nodeNames(N), M);
    const c = new Array(N).fill(0);
    for (const e of t) { expect(e).toBeGreaterThanOrEqual(0); c[e]++; }
    for (const x of c) expect(Math.abs(x - M / N)).toBeLessThanOrEqual(1);
  });

  test("the integer lookups of the speed test agree with each other's ranges", () => {
    const keys = benchKeys(1000);
    for (const s of ["ring", "rendezvous", "jump", "maglev"] as const) {
      const L = buildLookup(s, 13, 20);
      for (const h of keys) { const n = L.find(h); expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThan(13); }
    }
  });
});

describe("count-min sketch and Space-Saving", () => {
  test("count-min never undercounts", () => {
    for (const [w, d] of [[8, 1], [16, 3], [64, 4], [272, 5]] as const) {
      const cms = new CountMin(w, d);
      const truth = new Map<string, number>();
      const z = new Zipf(500, 1.1), rng = mulberry32(w * d);
      for (let i = 0; i < 20000; i++) {
        const k = `key:${z.rank(rng)}`;
        cms.add(k);
        truth.set(k, (truth.get(k) ?? 0) + 1);
      }
      for (const [k, n] of truth) expect(cms.estimate(k)).toBeGreaterThanOrEqual(n);
      // and a key never seen has an estimate of at least 0
      expect(cms.estimate("never")).toBeGreaterThanOrEqual(0);
    }
  });

  test("Space-Saving never undercounts a monitored key, and over-counts by at most its error", () => {
    const ss = new SpaceSaving(20);
    const truth = new Map<string, number>();
    const z = new Zipf(1000, 1.0), rng = mulberry32(2);
    for (let i = 0; i < 20000; i++) { const k = `key:${z.rank(rng)}`; ss.add(k); truth.set(k, (truth.get(k) ?? 0) + 1); }
    for (const [k, v] of ss.counts) {
      expect(v.n).toBeGreaterThanOrEqual(truth.get(k)!);
      expect(v.n - v.err).toBeLessThanOrEqual(truth.get(k)!);
    }
  });

  test("the Zipf sampler matches its shares", () => {
    const z = new Zipf(100, 1), rng = mulberry32(1);
    let top = 0;
    for (let i = 0; i < 50000; i++) if (z.rank(rng) === 1) top++;
    let H = 0; for (let r = 1; r <= 100; r++) H += 1 / r;
    expect(top / 50000).toBeCloseTo(1 / H, 2);
  });
});

describe("rebalancing", () => {
  for (const strategy of ["modulo", "fixed", "dynamic", "proportional"] as const) {
    test(`${strategy}: no data is lost, and every planned move completes`, () => {
      const r = simulateRebalance({ strategy, minutes: 400 });
      for (const f of r.frames) {
        const D = 300 + (150 * f.t) / 400;
        expect(f.perNode.reduce((a, b) => a + b, 0)).toBeCloseTo(D, 6);
      }
      expect(r.frames[r.frames.length - 1]!.pendingGB).toBeCloseTo(0, 6);
      expect(r.frames[r.frames.length - 1]!.nodes).toBe(6);
    });
  }

  test("split and merge keep the ranges contiguous and covering the key space", () => {
    for (const burst of ["sequential", "hot-range", "uniform"] as const) for (const loadSplitQps of [0, 400]) {
      for (const f of simulateSplits({ burst, loadSplitQps })) {
        expect(f.ranges[0]!.lo).toBe(0);
        expect(f.ranges[f.ranges.length - 1]!.hi).toBe(1000);
        for (let i = 1; i < f.ranges.length; i++) expect(f.ranges[i]!.lo).toBe(f.ranges[i - 1]!.hi);
      }
    }
  });
});

describe("routing", () => {
  test("a range scan touches at most two shards when it fits in one range", () => {
    const p = rangePartitioner(1000, 10);
    for (let from = 0; from + 100 <= 1000; from += 7) expect(scanCost(p, from, 100).shards).toBeLessThanOrEqual(2);
  });

  test("a local index query asks every partition; a global one asks one index partition", () => {
    const cars = makeCars(200);
    const L = route("local", { kind: "query", color: "red" }, cars, 8);
    expect(L.readFanOut).toBe(8);
    const G = route("global", { kind: "query", color: "red" }, cars, 8, true);
    expect(G.readFanOut).toBe(1);
    expect(L.matches).toEqual(G.matches);
    expect(route("local", { kind: "update", id: 3, to: cars[3]!.color === "red" ? "blue" : "red" }, cars, 8).writeFanOut).toBe(1);
  });

  test("an async global index can miss an acknowledged write; a sync one cannot", () => {
    for (let readAt = 0; readAt <= 100; readAt += 5) {
      const s = indexRace("sync", readAt, 40);
      if (readAt >= s.ackAt) expect(s.sawWrite).toBe(true);
    }
    expect(indexRace("async", 30, 40).stale).toBe(true);
    expect(indexRace("async", 30, 0).stale).toBe(false);
  });
});
