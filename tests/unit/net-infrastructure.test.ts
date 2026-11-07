/** Properties of the infrastructure sims: they hold for any seed or parameter, not just the lesson's numbers. */
import { describe, expect, test } from "vitest";
import {
  LB_MODES, LruCache, RESILIENT_BUCKETS, anycastRoutes, cdnLatencyRun, cdnTtfbFormula, changeRun, cheLru, defaultSites, hitRatio, lbPathRun,
  makeCache, objectProbs, policyRun, resilientAdd, resilientRemove, resilientTable, supermarketMean, thresholdPick, tierRun, zipfStream,
  CDN_PATHS, freshRun, healthRun, ddosLoad, breakChance,
} from "../../src/sims/net/infrastructure";

describe("forwarding modes", () => {
  test("every mode delivers the whole response over one connection", () => {
    for (const mode of LB_MODES) {
      const r = lbPathRun({ mode, respBytes: 50_000, record: false });
      expect(r.client.stats.delivered).toBe(50_000);
      expect(r.client.state).toBe("ESTABLISHED");
    }
  });
  test("NAT and proxy carry both directions; DSR and the tunnel never send toward the client", () => {
    for (const mode of ["dsr", "tunnel"] as const) expect(lbPathRun({ mode, record: false }).lbToClientBytes).toBe(0);
    for (const mode of ["nat", "proxy"] as const) expect(lbPathRun({ mode, record: false }).lbToClientBytes).toBeGreaterThan(20_000);
  });
  test("the tunnel adds 20 bytes to each forwarded packet", () => {
    const d = lbPathRun({ mode: "dsr", record: false }), t = lbPathRun({ mode: "tunnel", record: false });
    expect(t.lbToBackendBytes - d.lbToBackendBytes).toBe(20 * t.lbPackets);
  });
});

describe("hashing and ECMP", () => {
  test("hash-threshold moves between 1/4 and 1/2 of flows when a next hop joins (RFC 2992)", () => {
    for (const L of [2, 3, 4, 6, 8]) {
      let moved = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        const h = Math.floor(((i + 0.5) / n) * 4294967296);
        if (thresholdPick(h, L) !== thresholdPick(h, L + 1)) moved++;
      }
      expect(moved / n).toBeGreaterThanOrEqual(0.25 - 1e-3);
      expect(moved / n).toBeLessThanOrEqual(0.5 + 1e-3);
    }
  });
  test("resilient tables move only what must move", () => {
    const t = resilientTable(4);
    const r = resilientRemove(t, 2);
    for (let i = 0; i < t.length; i++) if (t[i] !== 2) expect(r[i]).toBe(t[i]);
    expect([...r].includes(2)).toBe(false);
    const a = resilientAdd(t, 4);
    const changed = [...a].filter((x, i) => x !== t[i]!).length;
    expect(changed).toBe(Math.floor(RESILIENT_BUCKETS / 5));
    expect([...a].filter((x, i) => x !== t[i]!).every((x) => x === 4)).toBe(true);
  });
  test("connection tracking never breaks a connection when only backends are added", () => {
    for (const lookup of ["modulo", "maglev", "random"] as const) for (const seed of [1, 2, 3]) expect(changeRun({ change: "addBackend", lookup, conntrack: true, seed }).broken).toBe(0);
  });
  test("stateless hashing survives a balancer change", () => {
    for (const lookup of ["modulo", "maglev"] as const) expect(changeRun({ change: "removeLb", lookup, conntrack: false }).broken).toBe(0);
  });
});

describe("policies", () => {
  test("random dispatch matches M/M/1, two choices match the supermarket model (100 servers)", () => {
    const n = 300_000;
    expect(policyRun({ policy: "random", load: 0.7, servers: 100, requests: n }).mean / 10).toBeCloseTo(supermarketMean(0.7, 1), 0);
    const p2c = policyRun({ policy: "p2c", load: 0.9, servers: 100, requests: n }).mean / 10;
    expect(Math.abs(p2c - supermarketMean(0.9, 2)) / supermarketMean(0.9, 2)).toBeLessThan(0.03);
  });
  test("least connections with exact counts beats every other policy", () => {
    const lc = policyRun({ policy: "lc", load: 0.85 }).p99;
    for (const p of ["random", "rr", "p2c"] as const) expect(lc).toBeLessThan(policyRun({ policy: p, load: 0.85 }).p99);
  });
});

describe("health", () => {
  test("more retries never add client errors", () => {
    const e = [0, 1, 2].map((retries) => healthRun({ retries }).clientErrors);
    expect(e[1]).toBeLessThanOrEqual(e[0]!);
    expect(e[2]).toBeLessThanOrEqual(e[1]!);
  });
});

describe("CDN latency", () => {
  test("the PacketNet run matches the round-trip formula", () => {
    for (const p of CDN_PATHS) for (const tls of ["1.3", "1.2"] as const) {
      const r = cdnLatencyRun({ path: p, tls, edgeRtt: 12, originRtt: 90, record: false });
      expect(r.ttfbMs).toBeGreaterThanOrEqual(cdnTtfbFormula(p, tls, 12, 90));
      expect(r.ttfbMs - cdnTtfbFormula(p, tls, 12, 90)).toBeLessThan(0.5); // serialization only
    }
  });
});

describe("caches", () => {
  test("LRU evicts the least recently used object", () => {
    const c = new LruCache(2);
    c.get(1); c.get(2); c.get(1); c.get(3);
    expect(c.has(1)).toBe(true);
    expect(c.has(2)).toBe(false);
  });
  test("Che's approximation tracks simulated LRU", () => {
    const K = 5000;
    for (const theta of [0.7, 1.0]) for (const C of [50, 500]) {
      const s = zipfStream({ K, theta, requests: 200_000, seed: 9 });
      expect(Math.abs(hitRatio(s, makeCache("lru", C)) - cheLru(objectProbs(K, theta), C).hit)).toBeLessThan(0.01);
    }
  });
  test("Che with V variants equals Che over the expanded catalog", () => {
    const a = cheLru(objectProbs(500, 0.8), 300, 4).hit, b = cheLru(objectProbs(500, 0.8, 4), 300).hit;
    expect(a).toBeCloseTo(b, 6);
  });
  test("hit ratio grows with cache size and the ideal static cache bounds LRU", () => {
    const s = zipfStream({ K: 5000, theta: 0.8, requests: 60_000 });
    let last = 0;
    for (const C of [10, 100, 1000]) {
      const h = hitRatio(s, makeCache("lru", C));
      expect(h).toBeGreaterThan(last);
      expect(h).toBeLessThan(hitRatio(s, makeCache("static", C)) + 0.01);
      last = h;
    }
  });
  test("a shield never raises origin load", () => {
    for (const edges of [2, 16]) {
      const no = tierRun({ K: 5000, theta: 0.8, edges, edgeSize: 1000, shieldSize: 0, requests: 50_000 });
      const sh = tierRun({ K: 5000, theta: 0.8, edges, edgeSize: 1000, shieldSize: 5000, requests: 50_000 });
      expect(sh.originRate).toBeLessThanOrEqual(no.originRate);
    }
  });
  test("collapsing sends at most one fetch at a time", () => {
    const r = freshRun({ outage: null, collapse: true, rate: 400 });
    expect(r.maxBurst).toBe(1);
    expect(r.counts.error).toBe(0);
  });
});

describe("anycast", () => {
  test("every ISP reaches some site while at least one site announces", () => {
    const r = anycastRoutes(defaultSites().map((s) => ({ ...s, on: s.asn === 45 })));
    for (const asn of [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) expect(r.has(asn)).toBe(true);
  });
  test("site loads add up to the attack and the users", () => {
    const r = ddosLoad({ sites: defaultSites(), attackGbps: 250, capacityGbps: 100 });
    expect(r.sites.reduce((s, x) => s + x.attack, 0)).toBeCloseTo(250, 6);
    expect(r.sites.reduce((s, x) => s + x.legit, 0)).toBeCloseTo(158 * 0.5, 6);
  });
  test("the reset chance is increasing in duration", () => {
    expect(breakChance(1, 600)).toBeLessThan(breakChance(10, 600));
    expect(breakChance(0, 600)).toBe(0);
  });
});
