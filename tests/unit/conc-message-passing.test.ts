/** Tests for the message-passing module: semantics of the models, and every number that the lessons quote. */
import { describe, expect, test } from "vitest";
import {
  CREDIT_DEFAULTS, ChanHb, Hchan, MAILBOX_DEFAULTS, Supervisor, creditBound, inFlightBound, quantile, replayHchan, runCredits, runHb, runLeak,
  runMailbox, runOverload, runPipeline, runProducerConsumer, runSelectFairness, selectBothReady, tippingBacklog, windowNeeded, type Side,
} from "@/sims/conc/message-passing";

const us = (ns: number) => Math.round(ns / 1_000);

describe("csp-and-channels", () => {
  test("a slow consumer sets the pace: 745 µs at every capacity, 23 producer blocks without a buffer", () => {
    for (let c = 0; c <= 8; c++) expect(us(runProducerConsumer({ capacity: c, record: false }).makespan)).toBe(745);
    const r = runProducerConsumer({ capacity: 0 });
    expect(r.producerBlocks).toBe(23);
    // The consumer's own work is the floor: 24 × 30 µs.
    expect(24 * 30).toBe(720);
  });

  test("equal speeds: a rendezvous blocks 12 times on each side (615 µs); capacity 1 takes 505 µs", () => {
    const zero = runProducerConsumer({ capacity: 0, consumeNs: 20_000 });
    expect(us(zero.makespan)).toBe(615);
    expect([zero.producerBlocks, zero.consumerBlocks]).toEqual([12, 12]);
    expect(us(runProducerConsumer({ capacity: 1, consumeNs: 20_000 }).makespan)).toBe(505);
  });

  test("with ±80% jitter a buffer helps: 649, 566 and 517 µs for capacity 0, 1 and 4", () => {
    const t = (capacity: number) => us(runProducerConsumer({ capacity, consumeNs: 20_000, jitter: 0.8 }).makespan);
    expect([t(0), t(1), t(4)]).toEqual([649, 566, 517]);
  });

  test("ChanHb: the sender is never more than C ahead, and the edges follow the Go memory model", () => {
    for (const C of [0, 1, 2, 3]) {
      const m = new ChanHb(C, 6);
      let maxLead = 0;
      // A random but fixed schedule.
      for (let i = 0, x = 7; i < 60 && !m.done; i++) {
        x = (x * 1103515245 + 12345) % 2147483648;
        const s: Side = x % 3 ? "producer" : "consumer";
        m.act(m.canAct(s) ? s : s === "producer" ? "consumer" : "producer");
        maxLead = Math.max(maxLead, m.lead);
      }
      expect(m.done).toBe(true);
      expect(maxLead).toBeLessThanOrEqual(C);
      for (const e of m.edges()) {
        if (e.rule === "send→recv") expect(e.from.start).toBeLessThanOrEqual(e.to.end!);
        else {
          expect(e.to.k).toBe(e.from.k + C);
          expect(e.from.end!).toBeLessThanOrEqual(e.to.end!);
        }
      }
    }
  });

  test("ChanHb scripts: capacity 0 completes each send with its receive; capacity 3 blocks the fourth send", () => {
    const zero = runHb(0, ["producer", "consumer", "producer", "consumer"], 2);
    for (const k of [1, 2]) {
      const s = zero.ops.find((o) => o.side === "producer" && o.k === k)!, r = zero.ops.find((o) => o.side === "consumer" && o.k === k)!;
      expect(s.end).toBe(r.end);
    }
    const three = runHb(3, ["producer", "producer", "producer", "producer"], 6);
    expect(three.pending.producer?.k).toBe(4);
    expect(three.lead).toBe(3);
    // With C = 1, send 2 waits for receive 1.
    const one = runHb(1, ["producer", "producer", "consumer"], 6);
    expect(one.ops[1]!.end).toBe(3);
  });
});

describe("go-channels-and-select", () => {
  test("hchan: a full buffer with a parked sender refills the slot it reads", () => {
    const c = replayHchan(2, [{ g: 0, op: "send" }, { g: 0, op: "send" }, { g: 1, op: "send" }]);
    expect([c.sendx, c.recvx, c.qcount]).toEqual([0, 0, 2]);
    expect(c.sendq).toEqual([{ g: 1, elem: 3 }]);
    const s = c.recv(3)!;
    expect(s.path).toBe("buffer-recv-refill");
    expect(s.value).toBe(1);
    expect(c.buf).toEqual([3, 2]);
    expect([c.sendx, c.recvx]).toEqual([1, 1]);
    expect(c.status[1]).toBe("ready");
    // FIFO order holds: 2, then 3.
    expect([c.recv(3)!.value, c.recv(3)!.value]).toEqual([2, 3]);
  });

  test("hchan: a send to a parked receiver bypasses the buffer", () => {
    const c = replayHchan(2, [{ g: 2, op: "recv" }]);
    const s = c.send(0)!;
    expect(s.path).toBe("direct-send");
    expect(c.qcount).toBe(0);
    expect(c.last[2]).toBe("got 1, ok = true");
  });

  test("hchan: close wakes receivers with ok = false, panics parked senders, and keeps buffered values", () => {
    const a = replayHchan(1, [{ g: 2, op: "recv" }, { g: 3, op: "recv" }, { g: 0, op: "close" }]);
    expect(a.last.slice(2)).toEqual(["got 0, ok = false", "got 0, ok = false"]);
    expect(a.send(1)!.path).toBe("send-closed-panic");
    const b = replayHchan(2, [{ g: 0, op: "send" }, { g: 0, op: "send" }, { g: 1, op: "send" }, { g: 0, op: "close" }]);
    expect(b.status[1]).toBe("panicked");
    expect([b.recv(2)!.value, b.recv(2)!.value]).toEqual([1, 2]);
    expect(b.recv(2)!.path).toBe("recv-closed");
    expect(b.close(3)!.path).toBe("close-closed-panic");
  });

  test("hchan: a nil channel blocks send and receive forever, and close panics", () => {
    const c = new Hchan(null);
    expect(c.send(0)!.path).toBe("nil-block");
    expect(c.recv(1)!.path).toBe("nil-block");
    expect(c.close(2)!.path).toBe("close-nil-panic");
    expect(c.canAct(0)).toBe(false);
  });

  test("select between two always-ready channels picks the first case 505 times in 1,000", () => {
    expect(selectBothReady(1000)).toEqual([505, 495]);
  });

  test("select fairness at 90% high and 30% low load", () => {
    const go = runSelectFairness({ mode: "random" });
    expect([go.loServed, go.loMade]).toEqual([606, 606]);
    expect(Math.round(go.loMaxWaitNs / 1e5) / 10).toBe(0.3);
    const pri = runSelectFairness({ mode: "priority" });
    expect([pri.loServed, pri.loMade]).toEqual([178, 588]);
    expect(Math.round(pri.loMaxWaitNs / 1e5) / 10).toBe(14.1);
    expect(runSelectFairness({ mode: "priority", hiLoad: 1.2 }).loServed).toBe(1);
  });

  test("leaks: 3 of 5 requests time out and 3 workers leak; a buffer of 1 or a done channel leaks none", () => {
    const r = runLeak();
    expect(r.outcomes.filter((o) => o === "timeout")).toHaveLength(3);
    expect(r.leaked).toEqual(["worker 0", "worker 3", "worker 4"]);
    expect(runLeak({ mode: "buffered" }).leaked).toEqual([]);
    expect(runLeak({ mode: "context" }).leaked).toEqual([]);
    const slow = runLeak({ timeoutNs: 280_000 });
    expect(slow.outcomes.every((o) => o === "ok")).toBe(true);
    expect(slow.leaked).toEqual([]);
  });
});

describe("actor-model", () => {
  test("tipping point of the mailbox model: 400 messages, 233 at 12 per ms, 1,600 at 25 ns per message", () => {
    expect(tippingBacklog(MAILBOX_DEFAULTS)).toBe(400);
    expect(Math.round(tippingBacklog({ ...MAILBOX_DEFAULTS, perMs: 12 }))).toBe(233);
    expect(tippingBacklog({ ...MAILBOX_DEFAULTS, scanNs: 25 })).toBe(1600);
    // Capacity with an empty mailbox: 1 / 70 µs ≈ 14 per ms.
    expect(Math.round(1e6 / (MAILBOX_DEFAULTS.handleNs + MAILBOX_DEFAULTS.callNs))).toBe(14);
  });

  test("a burst of 600: the pattern receive ends at 1,899 messages; the reference receive drains in about 180 ms", () => {
    const plain = runMailbox();
    expect(plain.finalLen).toBe(1899);
    const opt = runMailbox({ refOpt: true });
    expect(opt.finalLen).toBeLessThanOrEqual(5);
    const drained = opt.samples.find((s) => s[1] <= 5)![0];
    expect(Math.round(drained / 1e7) * 10).toBe(180);
  });

  test("a burst of 300 drains; at 12 per ms it grows to 1,777 unless the receive skips old messages", () => {
    expect(runMailbox({ burst: 300 }).finalLen).toBeLessThanOrEqual(5);
    expect(runMailbox({ burst: 300, perMs: 12 }).finalLen).toBe(1777);
    expect(runMailbox({ burst: 300, perMs: 12, refOpt: true }).finalLen).toBeLessThanOrEqual(5);
  });

  test("supervisor strategies restart the right children", () => {
    const pids = (s: Supervisor) => s.children.map((c) => c.pid);
    const one = new Supervisor({ strategy: "one_for_one", intensity: 3, period: 5 });
    const before = pids(one);
    one.crash(1);
    expect(pids(one).map((p, i) => p !== before[i])).toEqual([false, true, false]);
    const rest = new Supervisor({ strategy: "rest_for_one", intensity: 3, period: 5 });
    const b2 = pids(rest);
    rest.crash(1);
    expect(pids(rest).map((p, i) => p !== b2[i])).toEqual([false, true, true]);
    const all = new Supervisor({ strategy: "one_for_all", intensity: 3, period: 5 });
    const b3 = pids(all);
    all.crash(2);
    expect(pids(all).map((p, i) => p !== b3[i])).toEqual([true, true, true]);
  });

  test("restart intensity: with 1 in 5 s, a second crash within 5 s escalates; a restart counts while now − t ≤ period", () => {
    const s = new Supervisor();
    s.crash(1);
    expect(s.log.some((e) => e.text.includes("exits with reason shutdown"))).toBe(false);
    s.tick(5);
    s.crash(1);
    expect(s.log.some((e) => e.text.includes("exits with reason shutdown"))).toBe(true);
    const t = new Supervisor();
    t.crash(1);
    t.tick(6);
    t.crash(1);
    expect(t.log.some((e) => e.text.includes("shutdown"))).toBe(false);
    // The parent has the same limit: a second escalation within the period stops the application.
    const u = new Supervisor();
    u.crash(0);
    u.crash(0);
    u.crash(0);
    u.crash(0);
    expect(u.stopped).toBe(true);
    // one_for_all with intensity 3: the fourth crash in the period escalates.
    const v = new Supervisor({ strategy: "one_for_all", intensity: 3, period: 5 });
    for (let i = 0; i < 3; i++) v.crash(i);
    expect(v.log.some((e) => e.text.includes("shutdown"))).toBe(false);
    v.crash(0);
    expect(v.log.some((e) => e.text.includes("shutdown"))).toBe(true);
  });
});

describe("backpressure", () => {
  test("quantile uses the nearest rank", () => {
    expect(quantile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.99)).toBe(4);
  });

  test("overload at 120%: the unbounded queue reaches 435 items, p50 20.3 ms and p99 35.4 ms", () => {
    const r = runOverload();
    expect([r.arrived, r.delivered, r.maxQueue]).toEqual([2432, 1999, 435]);
    expect([Math.round(r.p50 / 1e5) / 10, Math.round(r.p99 / 1e5) / 10]).toEqual([20.3, 35.4]);
    // (λ − μ) t = 2 per ms × 200 ms.
    expect((12 - 10) * 200).toBe(400);
  });

  test("blocking the source keeps the queue at 50 but gives exactly the same latencies", () => {
    const u = runOverload(), b = runOverload({ policy: "block" });
    expect(b.maxQueue).toBe(50);
    expect([b.p50, b.p99]).toEqual([u.p50, u.p99]);
    expect(b.samples[b.samples.length - 1]![2]).toBeGreaterThan(300);
  });

  test("dropping: 385 of 2,432 lost (16%), p99 5.1 ms (newest) and 5.0 ms (oldest), under C/μ = 5 ms", () => {
    const n = runOverload({ policy: "drop-newest" }), o = runOverload({ policy: "drop-oldest" });
    expect(n.dropped).toBe(385);
    expect(Math.round((n.dropped / n.arrived) * 100)).toBe(16);
    expect(o.dropped).toBe(385);
    expect(Math.round(n.p99 / 1e5) / 10).toBe(5.1);
    expect(Math.round(o.p99 / 1e5) / 10).toBe(5);
  });

  test("at 90% load the policies do not matter: no drops and the same short queue", () => {
    const runs = (["unbounded", "block", "drop-newest", "drop-oldest"] as const).map((policy) => runOverload({ policy, load: 0.9 }));
    for (const r of runs) {
      expect(r.dropped).toBe(0);
      expect(r.maxQueue).toBe(runs[0]!.maxQueue);
      expect(r.maxQueue).toBeLessThan(50);
    }
  });

  test("pipeline: capacity 2 keeps 10 items in flight (the bound), unbounded lets 28 in, capacity 0 only 4", () => {
    const b = runPipeline();
    expect([b.maxInFlight, inFlightBound(3, 2), us(b.meanLatency), us(b.makespan)]).toEqual([10, 10, 333, 1240]);
    const u = runPipeline({ unbounded: true });
    expect([u.maxInFlight, us(u.meanLatency), us(u.maxLatency), us(u.makespan)]).toEqual([28, 588, 1095, 1240]);
    const z = runPipeline({ capacity: 0 });
    expect([z.maxInFlight, us(z.meanLatency), us(z.makespan)]).toEqual([4, 142, 1240]);
  });

  test("pipeline: with stage 1 slow, only the source blocks on send", () => {
    const r = runPipeline({ stageNs: [40_000, 10_000, 10_000] });
    expect(r.result.channels.map((c) => c.sendBlockedNs > 0)).toEqual([true, false, false]);
    expect(r.result.threads.filter((t) => t.name.startsWith("stage") && t.name !== "stage 1").every((t) => t.blockedNs > 0)).toBe(true);
  });

  test("credits: window 4 gives 37.2 items per ms, the knee is at 11.1, and window 12 reaches 100", () => {
    expect(Math.round(windowNeeded(CREDIT_DEFAULTS) * 10) / 10).toBe(11.1);
    const four = runCredits({ window: 4 });
    expect(Math.round(four.steadyPerMs * 10) / 10).toBe(37.2);
    expect(Math.round(creditBound({ ...CREDIT_DEFAULTS, window: 4 }) * 10) / 10).toBe(36);
    expect(four.maxBuffered).toBeLessThanOrEqual(4);
    expect(Math.round(runCredits({ window: 12 }).steadyPerMs)).toBe(100);
    for (const w of [1, 2, 8, 16]) {
      const r = runCredits({ window: w, record: false });
      expect(r.maxBuffered).toBeLessThanOrEqual(w);
      expect(r.steadyPerMs).toBeLessThanOrEqual(100.01);
    }
    expect(windowNeeded({ ...CREDIT_DEFAULTS, delayNs: 100_000 })).toBeGreaterThan(windowNeeded(CREDIT_DEFAULTS));
  });
});
