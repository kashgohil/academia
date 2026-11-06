/** Distributed Systems, Foundations: the models behind the six lessons, and every number that the lessons quote. */
import { describe, expect, test } from "vitest";
import {
  BIG_MACHINE, amdahl, availability, downtimeMinutesPerYear, machineKvOps, machineNicBytes, usl, uslPeak,
  partialFailureRun, FATES, type Fate,
  generalsRun, knowledge, protocolTable, workingProtocols,
  playgroundRun, defaultSends,
  replicatedWrite, MODELS,
  bruteMinOverlap, checkQuorum, minOverlap, nodesNeeded, quorumSize, QMODELS,
  DEFAULT_BACKEND, backendCdf, backendQuantile, hitsSlow, requestQuantile,
  TCP_MAX_SCALED, TCP_MAX_UNSCALED, bdpBytes, windowThroughput, sequentialMs, RTT_MODEL,
  POLICIES, fullJitterBound, layeredAttempts, retryPreset, retrySim,
  allFates, chargeRun,
  heartbeatRun, phiOf, phiTrace, timeoutSuspicions, tradeoff, PHI_DEFAULTS,
  atLeast, bisect, choose, log10NormTail, normCdf,
} from "@/sims/dist/foundations";
import { mulberry32 } from "@/sims/rng";

describe("math", () => {
  test("atLeast matches the direct binomial sum, also for large n", () => {
    for (const [n, k, p] of [[3, 2, 0.99], [10, 7, 0.3], [25, 1, 0.01], [40, 40, 0.97]] as const) {
      let s = 0;
      for (let j = k; j <= n; j++) s += choose(n, j) * p ** j * (1 - p) ** (n - j);
      expect(atLeast(n, k, p)).toBeCloseTo(s, 12);
    }
    expect(atLeast(200, 200, 0.5)).toBeCloseTo(0.5 ** 200 / 1, 70);
  });
  test("the normal tail is accurate and finite far out", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(-log10NormTail(0)).toBeCloseTo(Math.log10(2), 6);
    expect(Number.isFinite(log10NormTail(60))).toBe(true);
    // phi = 8 for a normal model is a silence 5.61 standard deviations above the mean.
    expect(bisect((z) => -log10NormTail(z), 8, 0, 20)).toBeCloseTo(5.612, 2);
  });
});

describe("why distribute", () => {
  test("availability of any, majority and all of N nodes, each down 1% of the time", () => {
    expect(availability("any", 3, 0.01)).toBeCloseTo(0.999999, 9);
    expect(availability("majority", 3, 0.01)).toBeCloseTo(0.999702, 9);
    expect(availability("all", 3, 0.01)).toBeCloseTo(0.970299, 9);
    expect(availability("majority", 5, 0.01)).toBeCloseTo(0.99999015, 8);
    expect(availability("all", 10, 0.01)).toBeCloseTo(0.9044, 4);
    // An even N adds no fault tolerance: 4 nodes need 3, so the majority is less available than with 3 nodes.
    expect(availability("majority", 4, 0.01)).toBeLessThan(availability("majority", 3, 0.01));
  });
  test("downtime per year", () => {
    expect(downtimeMinutesPerYear(0.99) / 60).toBeCloseTo(87.66, 2); // 3.65 days
    expect(downtimeMinutesPerYear(availability("majority", 3, 0.01))).toBeCloseTo(156.7, 1); // 2.6 hours
  });
  test("Amdahl and the USL", () => {
    expect(amdahl(0.05, 16)).toBeCloseTo(9.14, 2);
    expect(amdahl(0.05, 1e9)).toBeCloseTo(20, 3);
    expect(amdahl(0.2, 15)).toBeCloseTo(3.95, 2); // below 4; the limit is 5
    expect(uslPeak(0.05, 0.001)).toBeCloseTo(30.8, 1);
    expect(usl(60, 0.05, 0.001)).toBeLessThan(usl(31, 0.05, 0.001)); // past the peak, more nodes are slower
  });
  test("one big machine (model inputs)", () => {
    expect(BIG_MACHINE.cores).toBe(192);
    expect(machineKvOps()).toBe(19_200_000);
    expect(machineNicBytes()).toBe(12.5e9);
  });
});

describe("partial failure", () => {
  test("every failure looks the same to the client at its timeout, but the services differ", () => {
    const bad: Fate[] = ["request-lost", "reply-lost", "slow", "crashed"];
    const { out } = partialFailureRun(bad);
    expect(out.map((o) => o.clientSees)).toEqual(["no reply", "no reply", "no reply", "no reply"]);
    expect(out.map((o) => o.applied)).toEqual([false, true, true, false]);
    expect(out[2]!.replyAt).toBe(80); // the slow reply comes after the 40 ms timeout
    expect(out.map((o) => o.appliedAt)).toEqual([undefined, 12, 70, undefined]);
    expect(partialFailureRun(["ok"]).out[0]!.replyAt).toBe(22);
  });
  test("the client sees a reply exactly when the fate is ok", () => {
    for (const f of FATES) expect(partialFailureRun([f]).out[0]!.clientSees).toBe(f === "ok" ? "reply" : "no reply");
  });
});

describe("network model", () => {
  test("FIFO links never reorder; without FIFO the default script reorders", () => {
    const opts = { seed: 3, latency: { min: 1, max: 60 }, dropRate: 0, dupRate: 0 };
    const sends = defaultSends(3, 40, 3);
    expect(playgroundRun(3, sends, { ...opts, fifo: true }).stats.reordered).toBe(0);
    expect(playgroundRun(3, sends, { ...opts, fifo: false }).stats.reordered).toBeGreaterThan(0);
  });
  test("a partition loses exactly the messages that arrive at the cut node during the cut", () => {
    const { net, stats } = playgroundRun(3, defaultSends(), { seed: 1, latency: { min: 5, max: 40 }, dropRate: 0, dupRate: 0, fifo: false, partition: { cut: 2, from: 30, to: 110 } });
    const cut = net.messages.filter((m) => m.lost === "partition");
    expect(stats.cut).toBe(cut.length);
    for (const m of cut) expect((m.to === 2 || m.from === 2) && m.lostAt! >= 30 && m.lostAt! < 110).toBe(true);
  });
  test("two generals: the chain stops at the captured messenger", () => {
    expect(generalsRun(4, 0).delivered).toBe(4);
    expect(generalsRun(4, 3).delivered).toBe(2);
    expect(knowledge(3)).toBe("B knows that A knows that B knows the plan.");
  });
  test("two generals: no threshold rule meets the three rules, for any number of messengers", () => {
    for (let k = 1; k <= 10; k++) expect(workingProtocols(k)).toEqual([]);
    // The default rule of the demo (attack after one messenger) fails only when m2 is captured.
    expect(protocolTable(3, 1, 1).filter((r) => !r.ok).map((r) => r.lost)).toEqual([2]);
  });
});

describe("failure models", () => {
  test("the quorum write under each model", () => {
    const got = Object.fromEntries(MODELS.map((m) => [m, [false, true].map((fix) => { const r = replicatedWrite(m, fix); return [r.claim, r.readValue, r.ok]; })]));
    expect(got).toEqual({
      none: [["committed", 1, true], ["committed", 1, true]],
      "crash-stop": [["committed", 1, true], ["committed", 1, true]],
      "crash-recovery": [["committed", 0, false], ["committed", 1, true]],
      omission: [["failed", 0, false], ["committed", 1, true]],
      timing: [["failed", 1, false], ["unknown", 1, true]],
      byzantine: [["committed", 666, false], ["committed", 1, true]],
    });
    expect(replicatedWrite("none", false).claimAt).toBe(21);
    expect(replicatedWrite("omission", true).claimAt).toBe(61);
    // The slow replica R1 (node 2) applies the write and sends its ack at 80 ms, after the 40 ms deadline.
    const slowAck = replicatedWrite("timing", false).net.messages.find((m) => m.from === 2 && m.payload.k === "ack");
    expect(slowAck?.sentAt).toBe(80);
  });
  test("nodes needed: f + 1, 2f + 1, 3f + 1", () => {
    expect([1, 2, 3].map((f) => QMODELS.map((m) => nodesNeeded(m, f)))).toEqual([[2, 3, 4], [3, 5, 7], [4, 7, 10]]);
    expect(quorumSize("crash", 5, 2)).toBe(3);
    expect(quorumSize("crash", 4, 1)).toBe(3);
    expect(quorumSize("byzantine", 4, 1)).toBe(3);
    expect(quorumSize("byzantine", 7, 2)).toBe(5);
  });
  test("the smallest quorum overlap formula matches brute force", () => {
    for (let n = 1; n <= 9; n++) for (let q = 1; q <= n; q++) expect(minOverlap(n, q)).toBe(bruteMinOverlap(n, q));
  });
  test("the minimum configurations are safe and live, and one node fewer is not", () => {
    for (let f = 1; f <= 4; f++) {
      for (const m of ["crash", "byzantine"] as const) {
        const n = nodesNeeded(m, f);
        const c = checkQuorum(m, n, quorumSize(m, n, f), f);
        expect(c.live && c.safe).toBe(true);
        // With n - 1 nodes, every quorum size fails one of the two checks.
        for (let q = 1; q < n; q++) {
          const d = checkQuorum(m, n - 1, q, f);
          expect(d.live && d.safe).toBe(false);
        }
      }
    }
    expect(checkQuorum("byzantine", 4, 3, 1).overlap).toBe(2);
  });
});

describe("fallacies: fan-out and the bandwidth-delay product", () => {
  test("the Tail at Scale example: 1 in 100 slow, fan-out 100, 63% of requests slow", () => {
    expect(hitsSlow(100, 0.01)).toBeCloseTo(0.634, 3);
    expect(hitsSlow(100, 0.001)).toBeCloseTo(0.095, 3); // about 1 in 10
    // From 69 backends on, more than half of all requests wait for a stall.
    expect([...Array(200).keys()].find((n) => hitsSlow(n, 0.01) >= 0.5)).toBe(69);
  });
  test("request latency from the backend model", () => {
    const b = DEFAULT_BACKEND;
    expect(backendQuantile(0.5, b)).toBeCloseTo(10, 0);
    expect(requestQuantile(0.5, 100, 100, b)).toBeGreaterThan(1000); // the median request waits for a stall
    expect(requestQuantile(0.99, 100, 100, b)).toBeGreaterThan(1000);
    expect(requestQuantile(0.99, 100, 95, b)).toBeCloseTo(20.5, 0); // skip the 5 slowest: back to milliseconds
  });
  test("bandwidth-delay product", () => {
    expect(bdpBytes(10e9, 100)).toBe(125e6);
    expect(windowThroughput(TCP_MAX_UNSCALED, 100, 10e9)).toBeCloseTo(5.2428e6, 0);
    expect(windowThroughput(TCP_MAX_UNSCALED, 0.5, 10e9)).toBeCloseTo(1.0486e9, -5);
    expect(TCP_MAX_SCALED).toBe(1_073_725_440);
    expect((8e9 / windowThroughput(TCP_MAX_UNSCALED, 100, 10e9)) / 60).toBeCloseTo(25.4, 1); // 1 GB in minutes
    expect(bdpBytes(10e9, 100) / 2 ** 20).toBeCloseTo(119.2, 1); // MiB
    expect(1 - windowThroughput(TCP_MAX_UNSCALED, 100, 10e9) / 10e9).toBeCloseTo(0.9995, 4); // the link is 99.95% idle
    expect(bdpBytes(100e6, 100)).toBe(1.25e6);
  });
  test("latency is not zero: 100 calls one after another", () => {
    expect(sequentialMs(100, RTT_MODEL.sameDc)).toBe(50);
    expect(sequentialMs(100, RTT_MODEL.crossContinent)).toBe(7000);
  });
});

describe("retries", () => {
  test("burst of 195 requests: the three policies (seed 1)", () => {
    const res = POLICIES.map((p) => retrySim({ ...retryPreset("burst", 0.65), policy: p }));
    const last = (r: (typeof res)[number]) => { let t = 0; r.good.forEach((g, i) => { if (g > 0) t = (i + 1) * 10; }); return t; };
    expect(res.map((r) => [r.requests, r.attempts, r.succeeded, r.gaveUp, last(r)])).toEqual([
      [195, 1437, 106, 89, 120],
      [195, 811, 195, 0, 720],
      [195, 779, 195, 0, 300],
    ]);
  });
  test("full jitter beats no-jitter exponential on time to finish, averaged over seeds", () => {
    const mean = (p: "exponential" | "full-jitter") => {
      let s = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const r = retrySim({ ...retryPreset("burst", 0.65), policy: p, seed });
        let t = 0;
        r.good.forEach((g, i) => { if (g > 0) t = (i + 1) * 10; });
        s += t;
      }
      return s / 10;
    };
    expect(mean("full-jitter")).toBeLessThan(mean("exponential") * 0.7);
  });
  test("outage under steady load: without a budget every policy collapses; with a budget the server recovers", () => {
    for (const p of POLICIES) {
      const r = retrySim({ ...retryPreset("outage", 0.65), policy: p });
      expect(r.goodputBefore).toBeCloseTo(0.675, 3);
      expect(r.goodputEnd).toBe(0);
      expect(r.wastedMs / r.workMs).toBeGreaterThan(0.8);
      const b = retrySim({ ...retryPreset("outage", 0.65, 40, 10, true), policy: p });
      expect(b.goodputEnd).toBeGreaterThan(0.6);
      expect(b.wastedMs).toBe(0);
      expect(b.attempts / b.requests).toBeLessThan(1.05);
    }
    expect(retrySim({ ...retryPreset("outage", 0.65), policy: "none" }).attempts / 1313).toBeCloseTo(5.03, 2);
    // With a 100 ms timeout the queue (50 ms of work) never outlives the client, and every policy recovers.
    for (const p of POLICIES) expect(retrySim({ ...retryPreset("outage", 0.65, 100), policy: p }).goodputEnd).toBeGreaterThan(0.6);
  });
  test("full jitter: the mean number of retries in any window stays under the density bound", () => {
    // 100 requests at t = 0 against a server that never answers; each retries until it gives up.
    const cfg = { burst: 100, load: 0, outage: { from: 0, to: 1e9 }, timeoutMs: 40, baseMs: 100, capMs: 1000, maxAttempts: 6, horizon: 4000, bucket: 4000 };
    const w = 10, seeds = 300;
    const counts = new Array<number>(Math.ceil(4000 / w)).fill(0);
    for (let seed = 1; seed <= seeds; seed++) for (const t of retrySim({ ...cfg, policy: "full-jitter", seed }).retryTimes) counts[Math.floor(t / w)]! += 1;
    const bound = fullJitterBound(100, w, 100, 1000, 6);
    expect(bound).toBeCloseTo(19.75, 6);
    const worst = Math.max(...counts) / seeds;
    expect(worst).toBeLessThanOrEqual(bound);
    // Without jitter, the retries of all 100 requests land in one window, far above the full-jitter peak.
    const none = retrySim({ ...cfg, policy: "exponential", seed: 1 }).retryTimes;
    const peak = Math.max(...Object.values(none.reduce<Record<number, number>>((a, t) => ((a[Math.floor(t / w)] = (a[Math.floor(t / w)] ?? 0) + 1), a), {})));
    expect(peak).toBeGreaterThanOrEqual(95);
    expect(worst).toBeLessThan(15);
  });
});

describe("timeouts", () => {
  test("a 50 ms timeout on the backend model fires on about 1% of calls: the stalls", () => {
    expect(1 - backendCdf(50, DEFAULT_BACKEND)).toBeCloseTo(0.01, 4);
    expect(1 - backendCdf(20, DEFAULT_BACKEND)).toBeCloseTo(0.0203, 4); // half of these are normal answers, just slow
  });
  test("retries multiply across layers", () => {
    expect(layeredAttempts(3, 3)).toBe(27);
  });
});

describe("idempotency", () => {
  test("lost reply then retry: two charges without a key, one with", () => {
    expect(chargeRun(["reply-lost", "ok"], false).charges).toBe(2);
    expect(chargeRun(["reply-lost", "ok"], true).charges).toBe(1);
    expect(chargeRun(["dup"], false).charges).toBe(2);
    expect(chargeRun(["dup"], true).charges).toBe(1);
    expect(chargeRun(["slow", "ok"], false).charges).toBe(2);
    expect(chargeRun(["slow", "ok"], true).charges).toBe(1);
    // The key expires after 40 ms: the third attempt arrives 60 ms after the first and charges again.
    expect(chargeRun(["reply-lost", "reply-lost", "ok"], true, 40).charges).toBe(2);
    expect(chargeRun(["reply-lost", "reply-lost", "ok"], true).charges).toBe(1);
  });
  test("exhaustive: the keyed server never charges twice, and charges once if any request arrived", () => {
    for (let len = 1; len <= 4; len++) {
      for (const fates of allFates(len)) {
        const r = chargeRun(fates, true);
        expect(r.charges).toBeLessThanOrEqual(1);
        expect(r.charges).toBe(r.arrived > 0 ? 1 : 0);
        if (r.done) expect(r.chargeId).toBe(1001);
      }
    }
  });
  test("counts over all 125 fate sequences of 3 attempts", () => {
    const seqs = allFates(3);
    expect(seqs.length).toBe(125);
    expect(seqs.filter((s) => chargeRun(s, false).charges > 1).length).toBe(87);
    expect(seqs.filter((s) => chargeRun(s, true).charges > 1).length).toBe(0);
    expect(seqs.filter((s) => chargeRun(s, true, 40).charges > 1).length).toBe(28); // keys that expire too soon
  });
});

describe("failure detectors", () => {
  test("fixed timeout: the trade-off on the default network (2 simulated minutes)", () => {
    const hb = heartbeatRun({ horizon: 120_000 });
    const t250 = tradeoff(hb, 250, 120_000), t500 = tradeoff(hb, 500, 120_000);
    expect(t250.falsePerMin).toBeCloseTo(10.5, 6);
    expect(t250.detectMean).toBeCloseTo(214, 0);
    expect(t500.falsePerMin).toBeCloseTo(1, 6);
    expect(t500.detectMean).toBeCloseTo(461, 0);
    // With no pauses, even a 150 ms timeout gives no false suspicion; with 5-150 ms latency it gives many.
    expect(tradeoff(heartbeatRun({ pauseP: 0, horizon: 120_000 }), 150, 120_000).falsePerMin).toBe(0);
    expect(tradeoff(heartbeatRun({ pauseP: 0, latency: { min: 5, max: 150 }, horizon: 120_000 }), 150, 120_000).falsePerMin).toBeGreaterThan(100);
  });
  test("a longer timeout never gives more false suspicions on the same run", () => {
    const hb = heartbeatRun({ horizon: 60_000 });
    let prev = Infinity;
    for (let T = 110; T <= 1000; T += 10) {
      const n = timeoutSuspicions(hb.arrivals, T, 60_000).length;
      expect(n).toBeLessThanOrEqual(prev);
      prev = n;
    }
  });
  test("phi is monotone in the time since the last heartbeat", () => {
    const rng = mulberry32(9);
    for (let trial = 0; trial < 200; trial++) {
      const len = 2 + Math.floor(rng() * 50);
      const xs = Array.from({ length: len }, () => 50 + rng() * 300);
      for (const dist of ["normal", "exponential"] as const) {
        const cfg = { ...PHI_DEFAULTS, dist, minStd: rng() * 50, acceptablePause: rng() * 200 };
        let prev = -Infinity;
        for (let e = 0; e <= 5000; e += 7) {
          const p = phiOf(e, xs, cfg);
          expect(Number.isFinite(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = p;
        }
      }
    }
  });
  test("phi thresholds in real systems", () => {
    // Akka defaults: 1 s heartbeats, acceptable pause 3 s, min std 100 ms, threshold 8 -> about 4.56 s of silence.
    const steady = new Array(100).fill(1000);
    expect(bisect((e) => phiOf(e, steady, { maxSamples: 1000, minStd: 100, acceptablePause: 3000, dist: "normal" }), 8, 0, 1e6)).toBeCloseTo(4561, 0);
    // Exponential model (Cassandra), mean 1 s: phi = 8 after 8 ln 10 = 18.4 s.
    expect(bisect((e) => phiOf(e, steady, { ...PHI_DEFAULTS, dist: "exponential" }), 8, 0, 1e6)).toBeCloseTo(18421, 0);
  });
  test("the phi demo run: detects the crash 200 ms after it, with no false suspicion", () => {
    const run = heartbeatRun({ seed: 5, crashAt: 3000, horizon: 4000 });
    const tr = phiTrace(run.arrivals, 4000, 8);
    expect(tr.crossings).toEqual([{ from: 3200 }]);
    // Steps of the demo: threshold 2 suspects after the pause near 1600 ms; the exponential model is too slow to
    // convict within the run; a pause chance of 20% makes even phi = 8 suspect a live node near 1250 ms.
    expect(phiTrace(run.arrivals, 4000, 2).crossings[0]!.from).toBe(1590);
    expect(phiTrace(run.arrivals, 4000, 8, { ...PHI_DEFAULTS, dist: "exponential" }).crossings).toEqual([]);
    const noisy = heartbeatRun({ seed: 5, pauseP: 0.2, crashAt: 3000, horizon: 4000 });
    expect(phiTrace(noisy.arrivals, 4000, 8).crossings[0]!.from).toBe(1245);
    expect(bisect((e) => phiOf(e, tr.detector.window), 8, 0, 1e5)).toBeCloseTo(215, 0);
  });
});
