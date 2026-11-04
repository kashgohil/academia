/** Hash indexes: correctness against a reference Set, and every number quoted in hash-indexes.mdx. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  StaticHash, ExtendibleHash, LinearHash, hashKey, lowBits, staticCost, linearCost, extendibleStats, openAddressingCost,
  linearProbingHit, linearProbingMiss, cuckooMaxLoad, keydirBytes, KEYDIR_FIELDS, EXT_SEQUENCE, LIN_SEQUENCE, type ExtEvent, type LinEvent,
} from "@/sims/db/indexes/hash";

const r2 = (v: number) => Math.round(v * 100) / 100;
const pct1 = (v: number) => Math.round(v * 1000) / 10;

describe("hash structures match a reference set", () => {
  test("extendible hashing: random inserts and deletes, invariants hold", () => {
    for (const cap of [1, 2, 4]) {
      const t = new ExtendibleHash(cap, 1, 14);
      const ref = new Set<number>();
      const rng = mulberry32(cap);
      for (let i = 0; i < 3000; i++) {
        const k = Math.floor(rng() * 2000);
        if (rng() < 0.7) expect(t.insert(k)).toBe(!ref.has(k)), ref.add(k);
        else expect(t.delete(k)).toBe(ref.has(k)), ref.delete(k);
      }
      expect(t.size).toBe(ref.size);
      for (let k = 0; k < 2000; k++) expect(t.get(k)).toBe(ref.has(k));
      expect(t.check()).toEqual([]);
      expect(t.dir.length).toBe(2 ** t.global);
    }
  });

  test("linear hashing: random inserts and deletes; every key sits at its address", () => {
    for (const [cap, load] of [[1, 0.75], [2, 0.8], [4, 1.2]] as const) {
      const t = new LinearHash(cap, load);
      const ref = new Set<number>();
      const rng = mulberry32(9 + cap);
      for (let i = 0; i < 3000; i++) {
        const k = Math.floor(rng() * 2000);
        if (rng() < 0.7) expect(t.insert(k)).toBe(!ref.has(k)), ref.add(k);
        else expect(t.delete(k)).toBe(ref.has(k)), ref.delete(k);
      }
      expect(t.size).toBe(ref.size);
      for (let k = 0; k < 2000; k++) expect(t.get(k)).toBe(ref.has(k));
      t.buckets.forEach((b, i) => b.forEach((k) => expect(t.addr(hashKey(k)).addr).toBe(i)));
      expect(t.buckets.length).toBe(t.n0 * 2 ** t.level + t.next);
    }
  });

  test("static hashing finds every key and reports chain length on a miss", () => {
    const t = new StaticHash(16, 2);
    for (let k = 0; k < 100; k++) t.insert(k);
    for (let k = 0; k < 100; k++) expect(t.lookup(k).found).toBe(true);
    expect(t.lookup(1000).found).toBe(false);
    expect(t.pages).toBeGreaterThan(16);
  });

  test("lowBits shows the low bits", () => {
    expect(lowBits(0b1011, 3)).toBe("011");
    expect(lowBits(5, 0)).toBe("");
  });
});

describe("extendible hashing stepper (cap 2)", () => {
  const run = () => {
    const t = new ExtendibleHash(2, 1, 5);
    const log: { key: number; ev: ExtEvent["t"][]; g: number; buckets: number }[] = [];
    for (const k of EXT_SEQUENCE.slice(0, 8)) {
      const ev: ExtEvent["t"][] = [];
      t.listener = (e) => ev.push(e.t);
      t.insert(k);
      log.push({ key: k, ev, g: t.global, buckets: t.buckets().length });
    }
    return log;
  };
  test("64 and 90 end in bit 0; 12 and 50 end in bit 1", () => {
    expect([64, 90].map((k) => hashKey(k) & 1)).toEqual([0, 0]);
    expect([12, 50].map((k) => hashKey(k) & 1)).toEqual([1, 1]);
    expect(EXT_SEQUENCE.slice(0, 4)).toEqual([64, 12, 50, 90]);
  });
  test("7 doubles to 4 slots; 21 doubles to 8; 31 splits without doubling", () => {
    const log = run();
    const at = (k: number) => log.find((x) => x.key === k)!;
    expect(at(7).ev).toContain("double");
    expect(at(7).g).toBe(2);
    expect(at(21).ev.filter((e) => e === "double")).toHaveLength(1);
    expect(at(21).g).toBe(3);
    expect(at(19).ev).toEqual(["hash", "slot", "put"]);
    expect(at(31).ev).toContain("split");
    expect(at(31).ev).not.toContain("double");
    expect([at(31).g, at(31).buckets]).toEqual([3, 5]);
  });
  test("21: the split moves no old key, and 21 lands in the new bucket", () => {
    const t = new ExtendibleHash(2, 1, 5);
    for (const k of EXT_SEQUENCE.slice(0, 5)) t.insert(k);
    let into = -1;
    t.listener = (e) => { if (e.t === "split") into = e.into; };
    t.insert(21);
    const nb = t.buckets().find((b) => b.id === into)!;
    expect(nb.keys).toEqual([21]);
  });
});

describe("linear hashing stepper (cap 2, split above 75%)", () => {
  const log = (() => {
    const t = new LinearHash(2, 0.75, 2);
    const out: Record<number, string[]> = {};
    for (const k of LIN_SEQUENCE.slice(0, 9)) {
      const ev: string[] = [];
      t.listener = (e: LinEvent) => ev.push(e.t === "put" ? `put${e.bucket}${e.overflow ? "+ov" : ""}` : e.t === "split" ? `split${e.bucket}` : e.t === "hash" ? `addr${e.addr}${e.usedNext ? "*" : ""}` : e.t);
      t.insert(k);
      out[k] = ev;
    }
    return out;
  })();
  test("90, the 4th key, makes the load 100% and splits bucket 0 with no overflow page", () => {
    expect(LIN_SEQUENCE.indexOf(90)).toBe(3);
    expect(log[90]).toEqual(["addr0", "put0", "trigger", "split0"]);
    expect([64, 12, 50].every((k) => !log[k]!.some((e) => e.includes("+ov")))).toBe(true);
  });
  test("7 overflows bucket 1 and splits it; the round ends", () => {
    expect(log[7]).toEqual(["addr1", "put1+ov", "trigger", "split1", "round"]);
  });
  test("21 adds an overflow page; 19 then splits bucket 0, not bucket 1", () => {
    expect(log[21]).toEqual(["addr1", "put1+ov"]);
    expect(log[19]).toEqual(["addr3", "put3", "trigger", "split0"]);
  });
  test("33: mod 4 gives 1, before the pointer, so mod 8 gives bucket 5", () => {
    expect(hashKey(33) % 4).toBe(1);
    expect(log[33]![0]).toBe("addr5*");
  });
});

describe("cost against load factor (demo settings)", () => {
  test("static hashing, 4 keys per page, 256 buckets: 1.21 / 1.40 at 100%, 1.66 / 2.33 at 200%", () => {
    const a = staticCost(1, 4, 256), b = staticCost(2, 4, 256);
    expect([r2(a.hit), r2(a.miss)]).toEqual([1.21, 1.4]);
    expect([r2(b.hit), r2(b.miss)]).toEqual([1.66, 2.33]);
  });
  test("linear hashing at 80%, 4 keys per page: 1.16 pages per hit", () => {
    expect(r2(linearCost(0.8, 4, 6000).hit)).toBe(1.16);
  });
  test("extendible, 6,000 keys: 2,175 buckets / 16,384 slots (cap 4), 544 / 1,024 (cap 16), 69.0% full", () => {
    const a = extendibleStats(6000, 4), b = extendibleStats(6000, 16);
    expect([a.buckets, a.dirSlots]).toEqual([2175, 16384]);
    expect([b.buckets, b.dirSlots]).toEqual([544, 1024]);
    expect(pct1(a.utilization)).toBe(69.0);
    expect(pct1(Math.LN2)).toBe(69.3);
  });
  test("in memory, 4,096 slots, 80%: linear probing miss 11.78, Robin Hood 3.19; longest hit 93 vs 10", () => {
    const lp = openAddressingCost("linear", 0.8, 1 << 12), rh = openAddressingCost("robinhood", 0.8, 1 << 12);
    expect(r2(lp.miss)).toBe(11.78);
    expect(r2(rh.miss)).toBe(3.19);
    expect([lp.maxHit, rh.maxHit]).toEqual([93, 10]);
    expect(lp.hit).toBeCloseTo(rh.hit, 10); // Robin Hood does not change the mean hit cost
    expect(linearProbingHit(0.8)).toBeCloseTo(3, 10);
    expect(linearProbingMiss(0.8)).toBeCloseTo(13, 10);
  });
  test("cuckoo with one key per slot: first failure at 53.4%", () => {
    expect(pct1(cuckooMaxLoad(1 << 12))).toBe(53.4);
  });
  test("Bitcask keydir: 100 M keys of 16 bytes, 20 bytes of fields: 3.35 GiB", () => {
    expect(KEYDIR_FIELDS).toBe(20);
    expect(r2(keydirBytes(1e8, 16) / 2 ** 30)).toBe(3.35);
  });
});
