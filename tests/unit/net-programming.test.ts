/** Behaviour of the network programming models: queue rules, conservation and determinism. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "../../src/sims/rng";
import { MIN_FRAME, REQ_DESIGNS, SocketWorld, TimerHeap, acceptQueueRun, bufRingRun, etAcceptRun, herdRun, pathCost, COPY_PATHS, requestCost, streamRun } from "../../src/sims/net/programming";

describe("ListenSocket", () => {
  test("the accept queue holds backlog + 1; the overflow is dropped, not refused, and retries get in", () => {
    const w = new SocketWorld(["c", "s"], { tcp: { delayedAck: 0 } });
    w.net.connect(0, 1, { rate: 1e9, delay: 1 });
    const ls = w.listen(1, 80, 2, { synCookies: true });
    const conns = Array.from({ length: 6 }, (_, i) => w.stack.connect(0, 1, 80, { port: 50000 + i }));
    // Each client sends a request, so an ignored handshake ACK is repaired by the data retransmission.
    for (const c of conns) c.onEstablished = () => c.write(10);
    w.net.runUntil(100);
    expect(ls.acceptQueue.length).toBe(3);
    expect(ls.stats.synDrops + ls.stats.ackDrops).toBeGreaterThan(0);
    expect(conns.every((c) => c.reason === undefined)).toBe(true);
    // accept() makes room, and the retried handshakes finish
    while (ls.accept());
    w.net.runUntil(10_000);
    while (ls.accept());
    expect(ls.stats.accepted).toBe(6);
  });

  test("every client of a burst is served exactly once, in any configuration", () => {
    for (const o of [{}, { backlog: 2 }, { workers: 3 }, { synCookies: false }, { clients: 40, serviceMs: 2 }]) {
      const r = acceptQueueRun(o);
      expect(r.ls.stats.accepted).toBe(r.clients.length);
      for (const c of r.clients) {
        expect(c.done).toBeDefined();
        expect(c.accepted!).toBeGreaterThanOrEqual(c.queued!);
        expect(c.done!).toBeGreaterThan(c.accepted!);
      }
    }
  });
});

describe("streams", () => {
  test("reads deliver every byte once, in order, whatever the buffer sizes", () => {
    for (const o of [{}, { msgBytes: 3000, sndBuf: 1000 }, { readBuf: 256 }, { readEvery: 7, nagle: false }]) {
      const r = streamRun(o);
      const total = r.messages.at(-1)![1];
      let pos = 0;
      for (const x of r.reads) {
        expect(x.start).toBe(pos);
        pos += x.n;
      }
      expect(pos).toBe(total);
      expect(r.writes.reduce((a, w) => a + Math.max(0, w.got), 0)).toBe(total);
      expect(r.segments.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});

describe("event loops", () => {
  test("herd runs are deterministic and serve every connection", () => {
    const a = herdRun({ n: 3000 }), b = herdRun({ n: 3000 });
    expect(a).toEqual(b);
    for (const mode of ["accept", "epoll", "exclusive", "reuseport"] as const) {
      const r = herdRun({ mode, n: 3000 });
      expect(r.share.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
      if (mode !== "epoll") expect(r.eagain).toBe(0);
    }
  });

  test("level mode or a drain loop never strands a connection", () => {
    for (let burst = 1; burst <= 8; burst++) {
      expect(etAcceptRun({ burst, trigger: "level" }).stuck).toBe(0);
      expect(etAcceptRun({ burst, drain: true }).stuck).toBe(0);
    }
  });

  test("TimerHeap pops deadlines in order and gives the epoll_wait timeout", () => {
    const h = new TimerHeap();
    const rng = mulberry32(3);
    const ds = Array.from({ length: 200 }, () => Math.floor(rng() * 10_000));
    ds.forEach((d, i) => h.push(d, i));
    expect(h.timeout(0)).toBe(Math.min(...ds));
    const out: number[] = [];
    while (h.size) out.push(h.pop()!.at);
    expect(out).toEqual([...ds].sort((a, b) => a - b));
    expect(h.timeout(0)).toBe(-1);
  });
});

describe("io_uring", () => {
  test("a buffer ring loses no message and never hands out more buffers than it has", () => {
    for (const o of [{}, { buffers: 2 }, { buffers: 3, conns: 32, msgsPerConn: 4 }, { procUs: 20 }]) {
      const r = bufRingRun(o);
      expect(r.delivered).toBe(r.opts.conns * r.opts.msgsPerConn);
      expect(r.maxInUse).toBeLessThanOrEqual(r.opts.buffers);
      expect(r.inUse.at(-1)![1]).toBe(0);
      expect(r.rearms).toBe(r.enobufs);
      for (const c of r.cqes) if (c.res < 0) expect(c.more).toBe(false);
    }
  });

  test("each step in the list of designs removes cost or system calls", () => {
    const c = REQ_DESIGNS.map((d) => requestCost(d, 16));
    expect(c[1]!.syscalls).toBeLessThan(c[0]!.syscalls);
    expect(c[2]!.ns).toBeLessThan(c[1]!.ns);
    expect(c[3]!.ns).toBeLessThan(c[2]!.ns);
  });
});

describe("zero copy", () => {
  test("paths with no CPU pass scale with pages, not bytes", () => {
    for (const p of COPY_PATHS) {
      const c = pathCost(p.id, 2 ** 20);
      if (c.cpuCopies + c.cryptoPasses === 0) expect(c.parts.copy + c.parts.crypto).toBe(0);
      expect(c.crossings).toBe(2 * c.calls);
    }
    expect(MIN_FRAME).toBe(64);
  });
});
