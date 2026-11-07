/** Every number that the infrastructure lessons quote, pinned to the sims that compute it. */
import { describe, expect, test } from "vitest";
import { fiberRttMs } from "../../src/sims/net/foundations";
import {
  IPIP_BYTES, SYDNEY_PEERING, breakChance, budgetAmplification, catchments, cdnLatencyRun, changeMatrix, changeRun, checkDetectWorstS, cheLru,
  ddosLoad, defaultSites, freshRun, healthRun, herdExpected, hitRatio, inflation, lbPathRun, makeCache, objectProbs, openAfterDrain, policyRun,
  retryAmplification, staticHit, supermarketMean, supermarketTail, tierRun, tunnelMss, anycastTcpRun, zipfStream, type LbChange, type Lookup,
} from "../../src/sims/net/infrastructure";

/** As the demos print them: kit pct() is (x·100).toFixed(digits). */
const pct1 = (x: number) => Number((x * 100).toFixed(1));
const pct2 = (x: number) => Number((x * 100).toFixed(2));

describe("load balancers: forwarding modes", () => {
  const share = (mode: "nat" | "dsr" | "tunnel" | "proxy", kb: number) => {
    const r = lbPathRun({ mode, respBytes: kb * 1000, record: false });
    return pct2(r.lbBytes / r.wanBytes);
  };
  test("bytes through the balancer", () => {
    expect(share("dsr", 1000)).toBe(1.36);
    expect(share("nat", 20)).toBe(100);
    expect(share("dsr", 20)).toBe(3.33);
    expect(share("dsr", 200)).toBe(1.53);
    expect(share("tunnel", 20)).toBe(4.27);
  });
  test("a pooled proxy saves one data-center round trip (2 ms)", () => {
    const pooled = lbPathRun({ mode: "proxy", pooled: true }).ttfbMs, cold = lbPathRun({ mode: "proxy", pooled: false }).ttfbMs;
    expect(cold - pooled).toBeCloseTo(2, 3);
  });
  test("the tunnel header and the MSS", () => {
    expect(IPIP_BYTES).toBe(20);
    expect(tunnelMss()).toBe(1440);
    expect(tunnelMss(1500, 0)).toBe(1460);
  });
});

describe("load balancers: changes", () => {
  const broken = (change: LbChange, lookup: Lookup, conntrack: boolean, ecmp: "threshold" | "resilient" = "threshold") => {
    const r = changeRun({ change, lookup, conntrack, ecmp, flows: 2000 });
    return { broken: pct1(r.broken / 2000), moved: pct1(r.movedLb / 2000) };
  };
  test("add a backend", () => {
    expect(broken("addBackend", "modulo", false).broken).toBe(91.0);
    expect(broken("addBackend", "maglev", false).broken).toBe(8.8);
    for (const m of changeMatrix({ change: "addBackend", flows: 2000 })) if (m.conntrack) expect(m.r.broken).toBe(0);
  });
  test("add a balancer", () => {
    expect(broken("addLb", "random", true)).toEqual({ broken: 42.8, moved: 47.5 });
    expect(broken("addLb", "maglev", false).broken).toBe(0);
    expect(broken("addLb", "modulo", false).broken).toBe(0);
  });
  test("add both", () => {
    expect(broken("addBoth", "maglev", true).broken).toBe(4.1);
    expect(broken("addBoth", "maglev", true, "resilient")).toEqual({ broken: 1.7, moved: 19.9 });
  });
  test("crash and drain", () => {
    expect(broken("crashBackend", "maglev", false).broken).toBe(0.3);
    expect(broken("drainBackend", "maglev", true).broken).toBe(0);
    expect(broken("drainBackend", "modulo", true).broken).toBe(0);
  });
});

describe("load balancers: policies", () => {
  const p99 = (policy: "random" | "rr" | "lc" | "p2c", o: { slow?: number; staleMs?: number } = {}) => policyRun({ policy, load: 0.8, requests: 40_000, ...o });
  test("p99 at 80% load with exact counts", () => {
    expect(Math.round(p99("random").p99)).toBe(321);
    expect(Math.round(p99("rr").p99)).toBe(128);
    expect(Math.round(p99("lc").p99 * 10) / 10).toBe(58.6);
    expect(Math.round(p99("p2c").p99 * 10) / 10).toBe(79.0);
  });
  test("a slow server", () => {
    for (const p of ["random", "rr"] as const) expect(p99(p, { slow: 3 }).p99).toBeGreaterThan(60_000);
    for (const p of ["lc", "p2c"] as const) {
      const r = p99(p, { slow: 3 });
      expect(pct1(r.perServer[0]! / r.perServer.reduce((a, b) => a + b, 0))).toBe(4.1);
    }
  });
  test("stale counts", () => {
    expect(Math.round(p99("lc", { staleMs: 50 }).p99)).toBe(369);
    expect(Math.round(p99("p2c", { staleMs: 50 }).p99)).toBe(118);
    expect(Math.round(p99("lc", { staleMs: 50 }).p99)).toBeGreaterThan(Math.round(p99("rr").p99));
    expect(Math.round(p99("lc", { staleMs: 200 }).p99)).toBe(1497);
    expect(Math.round(p99("p2c", { staleMs: 200 }).p99)).toBe(202);
  });
  test("the supermarket model", () => {
    expect(supermarketTail(0.9, 1, 3)).toBeCloseTo(0.729, 10);
    expect(Math.round(supermarketTail(0.9, 2, 3) * 1000) / 1000).toBe(0.478);
    expect(supermarketMean(0.9, 1)).toBeCloseTo(10, 10);
    expect(Math.round(supermarketMean(0.9, 2) * 100) / 100).toBe(2.61);
  });
});

describe("load balancers: health and retries", () => {
  test("health checks every 5 s, 3 failures", () => {
    const r = healthRun({});
    expect(r.clientErrors).toBe(1199);
    expect(Math.round(r.removedAt * 10) / 10).toBe(16.9);
    expect(Math.round(r.removedAt - 5)).toBe(12);
  });
  test("AWS defaults: 30 s, 2 failures", () => {
    expect(healthRun({ check: { intervalS: 30, unhealthy: 2 } }).clientErrors).toBe(3623);
    expect(checkDetectWorstS(30, 2)).toBe(60);
  });
  test("outlier detection", () => {
    expect(healthRun({ outlier: { consecutive: 5, ejectS: 30 } }).clientErrors).toBe(5);
    expect(healthRun({ failure: "hang", outlier: { consecutive: 5, ejectS: 30 } }).clientErrors).toBe(106);
  });
  test("one retry", () => {
    expect(healthRun({ retries: 1 }).clientErrors).toBe(0);
    const h = healthRun({ failure: "hang", retries: 1 });
    expect(h.clientErrors).toBe(0);
    expect(h.extraMs / h.rescued).toBeCloseTo(1000, 6);
  });
  test("amplification, budgets and draining", () => {
    expect(retryAmplification(3, 3)).toBe(64);
    expect(Math.round(budgetAmplification(3, 0.2) * 100) / 100).toBe(1.73);
    expect(Math.round(openAfterDrain(300, 3600) * 100)).toBe(92);
  });
});

describe("CDNs", () => {
  const o = fiberRttMs("syd", "nyc");
  const t = (path: "direct" | "hit" | "miss-warm" | "miss-cold", tls: "1.3" | "1.2" = "1.3") => Math.round(cdnLatencyRun({ path, tls, edgeRtt: 10, originRtt: o, record: false }).ttfbMs);
  test("time to first byte, Sydney to New York", () => {
    expect(Math.round(o)).toBe(157);
    expect(t("hit")).toBe(30);
    expect(t("direct")).toBe(500);
    expect(t("miss-warm")).toBe(187);
    expect(t("miss-cold")).toBe(500);
    expect(t("direct", "1.2")).toBe(666);
    expect(t("hit", "1.2")).toBe(40);
  });
  test("edges and a shield", () => {
    const run = (edges: number, shieldSize: number) => tierRun({ K: 10_000, theta: 0.8, edges, edgeSize: 5000, shieldSize, ttl: 60, requests: 100_000 });
    expect(Math.round(run(1, 0).originRate)).toBe(220);
    expect(Math.round(run(64, 0).originRate)).toBe(672);
    expect(Math.round(run(1, 10_000).originRate)).toBe(113);
    expect(Math.round(run(64, 10_000).originRate)).toBe(113);
    const s = run(64, 10_000);
    expect(pct1(s.edgeHit)).toBe(28.1);
    expect(s.shieldHit).toBeGreaterThan(0.8);
  });
  test("hit ratio against cache size", () => {
    const K = 10_000, s = zipfStream({ K, theta: 0.8, requests: 100_000 }), p = objectProbs(K, 0.8);
    expect(pct1(hitRatio(s, makeCache("lru", 1000)))).toBe(43.5);
    expect(pct1(hitRatio(s, makeCache("fifo", 1000)))).toBe(39.3);
    expect(pct1(hitRatio(s, makeCache("lfu", 1000)))).toBe(56.0);
    expect(pct1(cheLru(p, 1000).hit)).toBe(43.7);
    expect(pct1(staticHit(p, 1000))).toBe(57.1);
    expect(pct1(hitRatio(s, makeCache("lru", 2000)))).toBe(56.6);
    expect(Math.round(pct1(hitRatio(s, makeCache("lru", 2000))) - pct1(hitRatio(s, makeCache("lru", 1000))))).toBe(13);
    expect(pct1(hitRatio(zipfStream({ K, theta: 0.8, variants: 2, requests: 100_000 }), makeCache("lru", 1000)))).toBe(33.2);
    expect(pct1(hitRatio(zipfStream({ K, theta: 0.8, variants: 50, requests: 100_000 }), makeCache("lru", 1000)))).toBe(5.3);
  });
  test("the thundering herd, collapsing, SWR and SIE", () => {
    expect(herdExpected(200)).toBe(36);
    const herd = freshRun({ outage: null });
    expect(herd.maxBurst).toBe(42);
    expect(freshRun({ outage: null, collapse: true }).fetches.length).toBe(6);
    expect(freshRun({}).counts.error).toBe(2845);
    expect(freshRun({ collapse: true }).counts.error).toBe(2962);
    expect(freshRun({ collapse: true, sie: 60 }).counts.error).toBe(0);
    expect(freshRun({ sie: 60 }).counts.error).toBe(0);
    const both = freshRun({ sie: 60, swr: 30 }).requests.map((q) => q.latency).sort((a, b) => a - b);
    expect(Math.round(both[Math.floor(both.length * 0.99)]!)).toBe(10);
    const swr = freshRun({ collapse: true, swr: 30 });
    const lat = swr.requests.map((q) => q.latency).sort((a, b) => a - b);
    expect(Math.round(lat[Math.floor(lat.length * 0.99)]!)).toBe(10);
  });
});

describe("anycast", () => {
  const S = defaultSites;
  test("catchments", () => {
    const cs = catchments(S());
    const syd = cs.find((c) => c.asn === 27)!;
    expect(syd.site).toBe(41);
    expect(Math.round(syd.km)).toBe(15988);
    expect(Math.round(syd.rttMs - syd.nearestRttMs)).toBe(157);
    const inf = inflation(cs);
    expect(pct1(inf.usersOff / inf.usersAll)).toBe(11.4);
    expect(cs.some((c) => c.site === 44)).toBe(false); // Sydney is idle
    const peer = inflation(catchments(S(), [SYDNEY_PEERING]));
    expect(pct1(peer.usersOff / peer.usersAll)).toBe(5.1);
  });
  test("prepending, withdrawing and NO_EXPORT", () => {
    const p = S(); p[0]!.prepend = 1;
    const sf = catchments(p).find((c) => c.asn === 22)!;
    expect(sf.site).toBe(44);
    expect(Math.round(sf.km)).toBe(11947);
    expect(Math.round(sf.nearestKm)).toBe(4129);
    const off = S(); off[0]!.on = false;
    const co = catchments(off);
    expect(co.find((c) => c.asn === 21)!.site).toBe(44);
    expect(co.find((c) => c.asn === 22)!.site).toBe(44);
    const loc = S(); loc[2]!.local = true;
    const cl = catchments(loc);
    const inf = inflation(cl);
    expect(pct1(inf.usersOff / inf.usersAll)).toBe(46.2);
    expect(cl.find((c) => c.asn === 25)!.site).not.toBe(43);
    expect(cl.find((c) => c.asn === 30)!.site).not.toBe(43);
  });
  test("DDoS across sites", () => {
    const served = (sites: ReturnType<typeof S>, a = 300) => pct1(ddosLoad({ sites, attackGbps: a, capacityGbps: 100 }).usersServed);
    expect(served(S())).toBe(85.6);
    expect(served(S().map((s) => ({ ...s, on: s.asn === 41 })))).toBe(26.4);
    const noSgp = S(); noSgp[2]!.on = false;
    expect(served(noSgp)).toBe(68.7);
    expect(served(S(), 600)).toBe(60.7);
  });
  test("TCP and a route change", () => {
    const r = anycastTcpRun({ flipAt: 100 });
    expect(r.received).toBe(45260);
    expect(r.clientEnd).toBe("reset");
    expect(Math.round(r.resetAt)).toBe(213);
    expect(r.orphanSegs).toBe(77);
    const small = anycastTcpRun({ flipAt: 100, respBytes: 2000 });
    expect(small.received).toBe(2000);
    expect(Math.round(small.doneMs)).toBe(60);
    const flap = anycastTcpRun({ flipAt: 100, flipBack: 130 });
    expect(flap.rstFromB).toBe(5);
    expect(flap.received).toBe(100_000);
    expect(flap.clientEnd).toBeUndefined();
    expect(anycastTcpRun({ flipAt: 20, respBytes: 2000 }).received).toBe(0);
  });
  test("the chance of a reset", () => {
    expect(pct2(breakChance(10, 600))).toBe(1.65);
    expect(Math.round(breakChance(0.1, 600) * 1e5) / 1e3).toBe(0.017);
    expect(breakChance(3600, 600)).toBeGreaterThan(0.99);
  });
});
