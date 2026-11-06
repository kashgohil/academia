import { describe, expect, test } from "vitest";
import { Net, type Message } from "@/sims/dist/net";

type P = { k: string };

function echoRun(seed: number, cfg = {}) {
  const net = new Net<P>(3, { seed, ...cfg }, {
    onMessage: (node, msg, n) => {
      if (msg.payload.k === "ping") n.send(node, msg.from, { k: "pong" });
    },
  });
  for (let i = 0; i < 20; i++) net.send(0, 1 + (i % 2), { k: "ping" });
  net.runAll();
  return net;
}

describe("Net", () => {
  test("the same seed gives the same run", () => {
    const a = echoRun(7, { latency: { min: 1, max: 50 } });
    const b = echoRun(7, { latency: { min: 1, max: 50 } });
    expect(a.messages.map((m) => [m.from, m.to, m.deliveredAt])).toEqual(b.messages.map((m) => [m.from, m.to, m.deliveredAt]));
  });

  test("events run in time order, and every delivery waits a latency in range", () => {
    const net = echoRun(3, { latency: { min: 5, max: 9 } });
    const ts = net.trace.map((e) => e.t);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
    for (const m of net.messages) expect(m.deliveredAt! - m.sentAt).toBeGreaterThanOrEqual(5), expect(m.deliveredAt! - m.sentAt).toBeLessThanOrEqual(9);
  });

  test("without FIFO a link can reorder; with FIFO it never does", () => {
    const order = (fifo: boolean) => {
      const got: number[] = [];
      const net = new Net<{ i: number }>(2, { seed: 11, latency: { min: 1, max: 40 }, fifo }, { onMessage: (_n, m) => got.push(m.payload.i) });
      for (let i = 0; i < 50; i++) net.send(0, 1, { i });
      net.runAll();
      return got;
    };
    expect(order(false)).not.toEqual([...Array(50).keys()]);
    expect(order(true)).toEqual([...Array(50).keys()]);
  });

  test("a partition loses messages between groups only, and heal restores them", () => {
    const net = new Net<P>(4, { seed: 1 });
    net.partition([[0, 1], [2, 3]]);
    const across = net.send(0, 2, { k: "x" }), inside = net.send(0, 1, { k: "x" });
    net.runAll();
    expect(across.lost).toBe("partition");
    expect(inside.deliveredAt).toBeDefined();
    net.heal();
    const later = net.send(0, 2, { k: "x" });
    net.runAll();
    expect(later.deliveredAt).toBeDefined();
  });

  test("a crashed node receives nothing and its timers do not fire", () => {
    const fired: string[] = [];
    const net = new Net<P>(2, { seed: 1 }, { onTimer: (n, tag) => fired.push(`${n}:${tag}`) });
    net.setTimer(1, 100, "tick");
    net.crash(1);
    const m = net.send(0, 1, { k: "x" });
    net.runAll();
    expect(m.lost).toBe("crashed");
    expect(fired).toEqual([]);
  });

  test("drop and duplicate rates are close to their settings", () => {
    const net = new Net<P>(2, { seed: 5, dropRate: 0.2, dupRate: 0.1 });
    const sent: Message<P>[] = [];
    for (let i = 0; i < 5000; i++) sent.push(net.send(0, 1, { k: "x" }));
    net.runAll();
    const dropped = sent.filter((m) => m.lost === "dropped").length / sent.length;
    const dups = net.messages.filter((m) => m.dupOf).length / (sent.length - sent.filter((m) => m.lost).length);
    expect(dropped).toBeGreaterThan(0.18), expect(dropped).toBeLessThan(0.22);
    expect(dups).toBeGreaterThan(0.08), expect(dups).toBeLessThan(0.12);
  });

  test("a cancelled timer does not fire; a node clock drifts and has an offset", () => {
    const fired: string[] = [];
    const net = new Net<P>(2, { seed: 1 }, { onTimer: (_n, tag) => fired.push(tag) });
    const id = net.setTimer(0, 10, "a");
    net.setTimer(0, 20, "b");
    net.cancelTimer(id);
    net.drift[1] = 100e-6;
    net.offset[1] = 3;
    net.runAll();
    expect(fired).toEqual(["b"]);
    expect(net.clock(1)).toBeCloseTo(20 * (1 + 100e-6) + 3, 9);
  });

  test("hold mode: the learner chooses the order, and drops; timers still fire", () => {
    const got: number[] = [], fired: string[] = [];
    const net = new Net<{ i: number }>(2, { seed: 1 }, { onMessage: (_n, m) => got.push(m.payload.i), onTimer: (_n, tag) => fired.push(tag) });
    net.hold = true;
    const ids = [0, 1, 2].map((i) => net.send(0, 1, { i }).id);
    net.setTimer(0, 5, "t");
    net.runAll();
    expect(got).toEqual([]);
    expect(fired).toEqual(["t"]);
    expect(net.held().map((m) => m.id)).toEqual(ids);
    net.deliverHeld(ids[2]!);
    net.dropHeld(ids[0]!);
    net.deliverHeld(ids[1]!);
    expect(got).toEqual([2, 1]);
    expect(net.messages.find((m) => m.id === ids[0])!.lost).toBe("dropped");
    expect(net.held()).toEqual([]);
  });
});
