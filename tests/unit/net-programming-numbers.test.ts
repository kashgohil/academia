/** Every number that the network programming lessons quote, computed by the sims. */
import { describe, expect, test } from "vitest";
import {
  COPY_PATHS, NET_URING_MODEL, SOCK_FACTS, ZC_DEFAULT_INPUTS, ZC_MODEL, acceptQueueRun, bufRingRun, ephemeralPorts, etAcceptRun, herdRun,
  lifecycleRun, pathCost, portLimitedRate, recvBufferMemory, requestCost, rxCores, streamRun, zcCrossover, zcHeldBytes, zcSendCost,
} from "../../src/sims/net/programming";

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

describe("sockets lesson", () => {
  test("connect() returns after one round trip (20 ms one-way): 40.1 ms", () => {
    const r = lifecycleRun();
    const c = r.calls.find((x) => x.node === 0 && x.call.startsWith("connect") && x.result.startsWith("0"))!;
    expect(r1(c.t)).toBe(40.1);
    expect(r.server!.states.at(-1)![1]).toBe("TIME_WAIT");
  });

  test("a late accept(): the connection waits in the queue from 60.1 ms, the program takes it at 150 ms", () => {
    const r = lifecycleRun({ scenario: "lateAccept" });
    const a = r.calls.find((x) => x.node === 1 && x.result.startsWith("4:"))!;
    expect(a.t).toBe(150);
    expect(a.result).toContain("queued since 60.1 ms");
    expect(r.clientGot).toBe(2000);
  });

  test("write after the peer closed: the first write succeeds, the next gets EPIPE and SIGPIPE", () => {
    const r = lifecycleRun({ scenario: "peerClosed" });
    expect(r.calls.filter((x) => x.node === 0 && x.call.startsWith("write")).map((x) => x.result.split(":")[0]!.split(",")[0])).toEqual(["300", "300", "-1"]);
    expect(r.sigpipe).toBe(true);
    expect(r.clientEnd).toBe("EPIPE");
  });

  test("close() with unread data: RST after 7,300 of 20,000 bytes; a lingering close delivers all 20,000", () => {
    const r = lifecycleRun({ scenario: "unreadClose" });
    expect(r.clientEnd).toBe("ECONNRESET");
    expect(r.clientGot).toBe(7300);
    expect(r.respBytes).toBe(20_000);
    const l = lifecycleRun({ scenario: "unreadClose", linger: true });
    expect(l.clientGot).toBe(20_000);
    expect(l.clientEnd).toBe("complete");
  });

  test("a burst of 24 against backlog 8 and 20 ms of work: last answer at 1,120 ms, not 480 ms", () => {
    const r = acceptQueueRun();
    expect((24 * 20) / 1).toBe(480);
    expect(Math.round(r.lastDone!)).toBe(1120);
    expect(r.ls.stats.synDrops).toBe(4);
    expect(r.ls.stats.ackDrops).toBe(20);
    expect(r.ls.listener.stats.cookiesSent).toBe(4);
    expect(r.clients.every((c) => !c.failed)).toBe(true);
    // the last four rows waited for a SYN retransmission after 1 s
    expect(r.clients.slice(-4).every((c) => c.synRetx === 1)).toBe(true);
    expect(r.clients.slice(0, -4).every((c) => c.synRetx === 0)).toBe(true);
    // an ignored ACK costs a 200 ms retransmission of the request (the minimum RTO)
    const ign = r.clients.filter((c) => c.dataRetx > 0);
    expect(ign.length).toBeGreaterThan(0);
    for (const c of ign) expect(Math.round(c.queued! - c.connected!)).toBe(205);
  });

  test("ss -lnt: Recv-Q reaches 9 with a backlog of 8 (one extra fits)", () => {
    expect(SOCK_FACTS.acceptQueueExtra).toBe(1);
    expect(acceptQueueRun().ls.stats.maxAcceptQueue).toBe(9);
  });

  test("backlog 32: nothing overflows, last answer at 500 ms; 5 ms of work: some wait 200 ms, two wait 1 s", () => {
    const big = acceptQueueRun({ backlog: 32 });
    expect(Math.round(big.lastDone!)).toBe(500);
    expect(big.ls.stats.synDrops + big.ls.stats.ackDrops).toBe(0);
    const fast = acceptQueueRun({ serviceMs: 5 });
    expect(fast.clients.filter((c) => c.dataRetx > 0).length).toBeGreaterThan(0);
    expect(fast.clients.filter((c) => c.synRetx > 0).length).toBe(2);
  });

  test("five 1000-byte messages: segments 1000, 1460, 1040, 1460, 40; 3 of 5 reads cut a message; 3 short writes and 3 EAGAINs", () => {
    const r = streamRun();
    expect(r.segments).toEqual([1000, 1460, 1040, 1460, 40]);
    const cuts = r.reads.filter((x) => r.messages.some(([s, e]) => (s > x.start && s < x.start + x.n) || (e > x.start && e < x.start + x.n)));
    expect([cuts.length, r.reads.length]).toEqual([3, 5]);
    expect(r.writes.filter((w) => w.got > 0 && w.got < w.asked).length).toBe(3);
    expect(r.writes.filter((w) => w.got < 0).length).toBe(3);
    expect(r.writes.find((w) => w.got > 0 && w.got < w.asked)).toMatchObject({ asked: 1000, got: 500 });
  });

  test("ephemeral ports: 28,232; about 470 new connections per second per destination; two destinations double it", () => {
    expect(ephemeralPorts()).toBe(28_232);
    expect(Math.floor(portLimitedRate())).toBe(470);
    expect(portLimitedRate(2)).toBe(2 * portLimitedRate());
    expect(SOCK_FACTS.somaxconn).toBe(4096);
  });
});

describe("select, poll and epoll lesson", () => {
  const run = (o: Parameters<typeof herdRun>[0]) => herdRun({ n: 10_000, ...o });

  test("8 workers, 2,000 connections/s: epoll wakes 6.00 per connection, 5.00 EAGAIN, about 9,500 ns wasted", () => {
    const r = run({ mode: "epoll" });
    expect(r2(r.wakeups)).toBe(6);
    expect(r2(r.eagain)).toBe(5);
    expect(Math.round(r.wastedNs / 100) * 100).toBe(9500);
    expect(r2(run({ mode: "exclusive" }).wakeups)).toBe(1);
  });

  test("EPOLLEXCLUSIVE at 300/s: w0 to w3 serve nothing, the busiest serves 28%", () => {
    const r = run({ mode: "exclusive", rate: 300 });
    for (const s of r.share.slice(0, 4)) expect(Math.round(s * 100)).toBe(0); // the demo shows 0
    expect(Math.round(Math.max(...r.share) * 100)).toBe(28);
  });

  test("blocking accept(): 12% to 13% each", () => {
    const r = run({ mode: "accept" });
    for (const s of r.share) expect(Math.round(s * 100)).toBeGreaterThanOrEqual(12), expect(Math.round(s * 100)).toBeLessThanOrEqual(13);
  });

  test("SO_REUSEPORT at 2,000/s: 25% wait while a worker is idle, p99 4.38 ms; at 6,000/s 13.67 ms against 2.05 ms", () => {
    const r = run({ mode: "reuseport" });
    expect(Math.round(r.waitedWhileIdle * 100)).toBe(25);
    expect(r2(r.waitP99)).toBe(4.38);
    expect(run({ mode: "epoll" }).waitP99).toBe(0);
    expect(r2(run({ mode: "reuseport", rate: 6000 }).waitP99)).toBe(13.67);
    for (const mode of ["accept", "epoll", "exclusive"] as const) expect(r2(run({ mode, rate: 6000 }).waitP99)).toBe(2.05);
  });

  test("16 workers: 14 wake per connection", () => {
    expect(r2(run({ mode: "epoll", workers: 16 }).wakeups)).toBe(14);
  });

  test("edge-triggered, accept once per event, burst of 4: 2 never accepted; the late client releases connection 3 only", () => {
    const r = etAcceptRun();
    expect(r.stuck).toBe(2);
    expect(r.conns.map((c) => (c.accepted === undefined ? undefined : r1(c.accepted)))).toEqual([25, 27, 315, undefined, undefined]);
    expect(etAcceptRun({ burst: 8 }).stuck).toBe(6);
    expect(etAcceptRun({ drain: true }).stuck).toBe(0);
    expect(etAcceptRun({ trigger: "level" }).stuck).toBe(0);
  });
});

describe("io_uring for networking lesson", () => {
  test("10,000 connections × 16 KiB: 156 MiB with a buffer per recv, 4 MiB for a ring of 256, 16 KiB for epoll", () => {
    const m = recvBufferMemory(10_000, 16384, { ringBuffers: 256 });
    expect(r2(m.perRequest / 2 ** 20)).toBe(156.25);
    expect(m.ring / 2 ** 20).toBe(4);
    expect(m.epoll).toBe(16384);
  });

  test("ring of 8, 16 connections × 2 messages, 5 µs each: 18 -ENOBUFS and 18 re-arms; full after about 12 µs", () => {
    const r = bufRingRun();
    expect([r.enobufs, r.rearms, r.delivered, r.maxInUse]).toEqual([18, 18, 32, 8]);
    expect(Math.round(r.inUse.find((x) => x[1] === 8)![0])).toBe(12);
    const big = bufRingRun({ buffers: 32 });
    expect([big.enobufs, big.maxInUse]).toEqual([0, 27]);
    expect(bufRingRun({ procUs: 1 }).enobufs).toBe(0);
  });

  test("batch 16: epoll 2,123 ns and 471k/s, best io_uring 1,693 ns and 591k/s; 33 times fewer calls, 1.25 times less CPU", () => {
    const ep = requestCost("epoll", 16), best = requestCost("fixed", 16);
    expect(Math.round(ep.ns)).toBe(2123);
    expect(Math.round(best.ns)).toBe(1693);
    expect(Math.round(ep.perCore / 1000)).toBe(471);
    expect(Math.round(best.perCore / 1000)).toBe(591);
    expect(Math.round(ep.syscalls / best.syscalls)).toBe(33);
    expect(r2(ep.ns / best.ns)).toBe(1.25);
    expect(2 * NET_URING_MODEL.opWorkNs).toBe(1600);
    expect(Math.round((ep.parts.syscall / ep.ns) * 100)).toBe(19); // about a fifth
  });

  test("batch 1: epoll 3 calls, io_uring 1; SQPOLL 0 calls but more CPU than registered files", () => {
    expect(requestCost("epoll", 1).syscalls).toBe(3);
    expect(requestCost("uring", 1).syscalls).toBe(1);
    expect(requestCost("sqpoll", 16).syscalls).toBe(0);
    expect(requestCost("sqpoll", 16).ns).toBeGreaterThan(requestCost("fixed", 16).ns);
    expect(requestCost("epoll", 16, { mitigations: false }).parts.syscall).toBeCloseTo(60 * 2.0625, 6);
  });
});

describe("zero copy lesson", () => {
  test("100 Gbit/s is 12.5 GB/s of payload; one copy at 8 GB/s needs more than a core", () => {
    expect(100e9 / 8 / 1e9).toBe(12.5);
    expect(12.5 / ZC_MODEL.copyGBps).toBeGreaterThan(1);
  });

  test("1 MiB from the page cache: read + write 268.5 µs (2 copies, 32 calls, 3.20 cores); sendfile with gather 5.3 µs", () => {
    const rw = pathCost("readwrite", 2 ** 20);
    expect([rw.cpuCopies, rw.calls, r1(rw.ns / 1000), r2(rw.coresAt(100))]).toEqual([2, 32, 268.5, 3.2]);
    expect(r1(pathCost("sendfileSg", 2 ** 20).ns / 1000)).toBe(5.3);
    expect(r1(pathCost("sendfile", 2 ** 20).ns / 1000)).toBe(131.3);
    const tls = pathCost("userTls", 2 ** 20);
    expect([tls.cpuCopies + tls.cryptoPasses, r2(tls.coresAt(100))]).toEqual([3, 6.33]);
    expect(r2(pathCost("ktls", 2 ** 20).coresAt(100))).toBe(3.19);
    expect(r2(pathCost("ktlsHw", 2 ** 20).coresAt(100))).toBe(0.06);
    expect(COPY_PATHS.length).toBe(11);
  });

  test("at 4 KiB the gap between read + write and sendfile is smaller than at 1 MiB", () => {
    const ratio = (b: number) => pathCost("readwrite", b).ns / pathCost("sendfileSg", b).ns;
    expect(ratio(4096)).toBeLessThan(ratio(2 ** 20));
  });

  test("MSG_ZEROCOPY crossover 9.75 KiB; at 64 KiB 2,210 ns vs 8,392 ns; 59.6 MiB held at 10 Gbit/s and 50 ms", () => {
    expect(zcCrossover()).toBe(9984);
    expect(9984 / 1024).toBe(9.75);
    const c = zcSendCost(65536);
    expect([Math.round(c.zc), Math.round(c.copy)]).toEqual([2210, 8392]);
    expect(r1(zcHeldBytes(10, 50) / 2 ** 20)).toBe(59.6);
    expect(zcCrossover({ ...ZC_DEFAULT_INPUTS, copyGBps: 20 })!).toBeGreaterThan(9984);
    expect(zcCrossover({ ...ZC_DEFAULT_INPUTS, sendsPerNotify: 1 })!).toBeGreaterThan(9984);
  });

  test("100 Gbit/s receive: 8.13 Mpps and 123 ns per frame; 11.6, 10.4 and 2.5 cores; 64-byte frames 148.81 Mpps, 6.7 ns, 163.9 vs 8.9 cores", () => {
    const plain = rxCores("plain", 100, 1518, "bulk");
    expect(r2(plain.pps / 1e6)).toBe(8.13);
    expect(r1(plain.budgetNs)).toBe(123);
    expect(r1(plain.cores)).toBe(11.6);
    expect(r1(rxCores("csum", 100, 1518, "bulk").cores)).toBe(10.4);
    const gro = rxCores("gro", 100, 1518, "bulk");
    expect(r1(gro.cores)).toBe(2.5);
    expect(gro.parts.copy).toBeGreaterThan(Math.max(gro.parts.driver, gro.parts.stack, gro.parts.csum));
    const small = rxCores("gro", 100, 64, "small");
    expect(r2(small.pps / 1e6)).toBe(148.81);
    expect(r1(small.budgetNs)).toBe(6.7);
    expect(r1(small.cores)).toBe(163.8);
    expect(r1(rxCores("plain", 100, 64, "small").cores)).toBe(163.9);
    expect(r1(rxCores("bypass", 100, 64, "small").cores)).toBe(8.9);
  });
});
