/** Pins every number that the I/O lessons quote, by lesson. */
import { describe, expect, test } from "vitest";
import {
  BLOCK_SCRIPTS, DMA_DEVICES, DMA_MODEL, DOORBELL_MODEL, DRIVER_FACTS, EVENT_FACTS, EVENT_MODEL, IO_MODEL_NAMES, IRQ_FACTS, IRQ_MODEL, IRQ_PATH, NO_MITIGATIONS, RX_DEFAULTS, SCHED_FACTS, SCHED_MODEL, STARVE_MODEL, SWIOTLB_DEFAULT_BYTES, URING_FACTS, URING_MODEL,
  dmaCrossoverBytes, dmaMapSg, doorbellCostPerPacket, drainNeverEndsMBps, iommuCpuPerIo, iommuCpuShare, iotlbReach, iotlbRun, ioPathCost, irqSaturationRate, irqShares, irqTimeline, jobDepths, lockCapIops, maxConnections, pioVsDma, pollVsIrq, pollsPerByte, recvActions, replayDescRing, replayDevice, runElevator, runReader, rxGoodput, rxLandmarks, schedRun, sendActions, serverCost, starvationRun, threadsLimit,
  type ElevatorPolicy, type IoPath, type SchedId,
} from "@/sims/os/io";

const close = (got: number, want: number, digits = 0) => expect(got).toBeCloseTo(want, digits);

describe("interrupts", () => {
  test("model inputs and real values", () => {
    expect(IRQ_MODEL).toMatchObject({ hardUs: 4, softUs: 3, appUs: 5, mmioReadUs: 0.5, pollPeriodUs: 10, softShareLimit: 0.5 });
    expect(IRQ_FACTS).toMatchObject({ idtVectors: 256, exceptionVectors: 32, softirqTypes: 10, maxSoftirqRestart: 10, maxSoftirqTimeMs: 2, msiVectors: 32, msixVectors: 2048, netdevBudget: 300, napiWeight: 64, threadedIrqFifoPrio: 50, msiAddressBase: 0xfee00000 });
    expect(IRQ_PATH.length).toBe(8);
    expect(RX_DEFAULTS.windowUs).toBe(50);
  });

  test("the predict answer and the timeline readouts", () => {
    const s = irqShares(100000);
    close(s.hard * 100, 37, -0.5);
    close(s.soft * 100, 30);
    close(s.task * 100, 32.6, 1);
    const pct = (o: Parameters<typeof irqTimeline>[0]) => { const r = irqTimeline(o); return { task: (r.time.task / o.spanUs) * 100, hard: (r.time.hard / o.spanUs) * 100, lat: r.meanLatencyUs, deferred: r.deferred }; };
    const a = pct({ rate: 100000, spanUs: 20000 });
    close(a.task, 32.1, 1); close(a.hard, 37.5, 1); close(a.lat, 19.4, 1);
    const b = pct({ rate: 100000, spanUs: 20000, framesPerIrq: 8, coalesceUs: 50 });
    close(b.task, 62.6, 1); close(b.hard, 7.0, 1); close(b.lat, 42.1, 1);
    close(pct({ rate: 20000, spanUs: 20000 }).task, 84.8, 1);
    const c = pct({ rate: 200000, spanUs: 20000 });
    close(c.task, 15.6, 1);
    expect(c.deferred).toBe(true);
    expect(irqShares(200000).task).toBe(0);
  });

  test("polling against interrupts", () => {
    const p = pollVsIrq(1000);
    expect(p.pollShare).toBe(0.05);
    expect(p.pollWaitUs).toBe(5);
    expect(p.breakEvenRate).toBe(12500);
  });

  test("the goodput curves", () => {
    const irq = rxLandmarks("irq");
    close(irq.peakGoodput / 100, 847);
    expect(irq.zeroRate).toBe(155000);
    close(irqSaturationRate() / 1000, 155);
    close(rxLandmarks("irq", RX_DEFAULTS).peakRate / 1000, 85);
    const co = rxLandmarks("coalesce");
    expect(co.zeroRate).toBe(308500);
    expect(Math.round(rxGoodput("coalesce", 200000).goodput)).toBe(65455);
    const na = rxLandmarks("napi");
    close(na.peakGoodput / 100, 1198);
    expect(na.zeroRate).toBeNull();
    close(na.floor, 100000);
    expect(rxGoodput("irq", 200000).goodput).toBe(0);
    expect(rxGoodput("irq", 200000).app).toBe(0);
    close(rxGoodput("napi", 200000).goodput, 100000);
    close(rxGoodput("napi", 200000).ringDrop, 33333);
    const w5 = { ...RX_DEFAULTS, windowUs: 5 };
    close(rxLandmarks("napi", w5).peakGoodput / 100, 1065);
    // The dip in the middle at a short window.
    expect(rxGoodput("napi", 160000, w5).goodput).toBeLessThan(rxGoodput("napi", 200000, w5).goodput);
  });
});

describe("device drivers", () => {
  const LAB = [76, 65, 66];
  test("the toy device readouts", () => {
    expect(replayDevice("send", 3, sendActions(3, 3, "no-wait"), LAB).dev.wire).toEqual([65, 66]);
    expect(replayDevice("send", 3, sendActions(3, 3, "correct"), LAB).dev.cycle).toBe(16);
    expect(pollsPerByte(3)).toBe(3);
    expect(replayDevice("send", 1, sendActions(3, 1, "no-wait"), LAB).dev.wire).toEqual(LAB);
    expect(replayDevice("send", 1, sendActions(3, 1, "command-first"), LAB).dev.wire[0]).toBe(0);
    const later = replayDevice("send", 2, sendActions(3, 2, "command-first"), LAB).dev;
    expect(later.wire).toEqual(LAB);
    expect(later.problems).toBeGreaterThan(0);
    expect(replayDevice("recv", 3, recvActions(3, 3, "no-wait"), LAB).dev.got).toEqual([0, 76, 76]);
  });
  test("the ring and the doorbell", () => {
    const full = replayDescRing(8, Array.from({ length: 8 }, () => ({ a: "post" as const }))).ring;
    expect(full.capacity).toBe(7);
    expect(full.posted).toBe(7);
    expect(full.fullRejects).toBe(1);
    expect(DOORBELL_MODEL).toMatchObject({ doorbellNs: 300, descriptorNs: 10 });
    expect(doorbellCostPerPacket(1)).toBe(310);
    close(doorbellCostPerPacket(32), 19.4, 1);
    expect(DRIVER_FACTS).toMatchObject({ x86Ports: 65536, pciBars: 6 });
  });
});

describe("DMA and the IOMMU", () => {
  const nvme = { mbps: DMA_DEVICES.nvme.mbps };
  test("inputs", () => {
    expect(DMA_DEVICES.nvme.mbps).toBe(3200);
    expect(DMA_MODEL).toMatchObject({ mmioWordUs: 0.5, wordBytes: 4, setupUs: 2, irqUs: 4, iotlbEntries: 64 });
    expect(SWIOTLB_DEFAULT_BYTES).toBe(64 * 2 ** 20);
  });
  test("4 KiB", () => {
    const c = pioVsDma(4096, nvme);
    close(4096 / nvme.mbps, 1.28, 2);
    expect(c.pio.cpuUs).toBe(512);
    expect(c.dma.cpuUs).toBe(6);
    close(c.dma.elapsedUs, 7.28, 2);
    close(c.dma.share * 100, 82, 0);
    close(c.cpuRatio, 85, 0);
  });
  test("1 MiB and the crossover", () => {
    const c = pioVsDma(2 ** 20, nvme);
    close(c.dma.cpuUs, 31.5, 1);
    close(c.pio.cpuUs / 1000, 131, 0);
    expect(Math.round(c.cpuRatio)).toBe(4161);
    close(c.dma.share * 100, 8.8, 1);
    expect(c.segments).toBe(256);
    expect(dmaCrossoverBytes(nvme)).toBe(52);
    expect(pioVsDma(4096, { mbps: DMA_DEVICES.hdd.mbps }).dma.share).toBeLessThan(c.dma.share + 0.2);
    expect(pioVsDma(4096, { mbps: DMA_DEVICES.hdd.mbps }).dma.cpuUs).toBe(6);
  });
  test("segments and bounce buffers", () => {
    const frames = [0x1a3, 0x07c, 0x2f1, 0x0d5];
    expect(dmaMapSg(frames, { iommu: false, maskBits: 32 }).segments.length).toBe(4);
    expect(dmaMapSg(frames, { iommu: true, maskBits: 32 }).segments.length).toBe(1);
    const high = dmaMapSg([2 ** 20, 2 ** 20 + 1, 5], { iommu: false, maskBits: 32 });
    expect(high.bounced).toBe(2);
    expect(2 ** 32).toBe(4 * 2 ** 30);
  });
  test("IOTLB and invalidation", () => {
    expect(iotlbReach(64, 4096)).toBe(256 * 1024);
    expect(iotlbReach(64, 2 * 2 ** 20)).toBe(128 * 2 ** 20);
    expect(iotlbRun(64).hitRate).toBe(1);
    const w = iotlbRun(128);
    expect(w.hitRate).toBe(0);
    expect(w.readsPerAccess).toBe(4);
    expect(w.nsPerAccess).toBe(400);
    expect(iommuCpuPerIo("strict")).toBe(2600);
    expect(iommuCpuPerIo("lazy")).toBe(600);
    expect(iommuCpuPerIo("passthrough")).toBe(0);
    close(iommuCpuShare(1e6, "strict"), 2.6, 5);
    close(iommuCpuShare(1e6, "lazy"), 0.6, 5);
  });
});

describe("the block layer", () => {
  const end = (k: keyof typeof BLOCK_SCRIPTS, policy: ElevatorPolicy, merge = true) => runElevator(BLOCK_SCRIPTS[k], { policy, merge }).at(-1)!;
  test("real defaults", () => {
    expect(SCHED_FACTS).toMatchObject({ readExpireMs: 500, writeExpireMs: 5000, fifoBatch: 16, writesStarved: 2, kyberReadTargetMs: 2, kyberWriteTargetMs: 10, bfqSliceIdleMs: 8, bfqExpireSyncMs: 125, bfqExpireAsyncMs: 250, nvmeMaxQueues: 65535, nvmeMaxQueueDepth: 65536 });
    expect(SCHED_MODEL).toMatchObject({ nvmeWriteUs: 100, mqDeadlineLockUs: 3, bfqLockUs: 8, bfqReadBudget: 16, bfqWriteBudget: 4 });
  });
  test("the stepper", () => {
    const s = end("sequential", "look");
    expect(s.bios).toBe(12);
    expect(s.done.length).toBe(3);
    expect(s.merges).toBe(9);
    close(s.nowMs, 38.9, 1);
    close(end("sequential", "fifo", false).nowMs, 179.2, 1);
    close(end("sequential", "look", false).nowMs, 43.4, 1);
    close(end("mixed", "look").nowMs, 68.0, 1);
    close(end("mixed", "fifo").nowMs, 93.7, 1);
    close(end("starve", "look").finishMs[1]!, 155.9, 1);
    close(end("starve", "fifo").finishMs[1]!, 20.3, 1);
    close(end("starve", "deadline").finishMs[1]!, 82.8, 1);
    expect(end("starve", "deadline").nowMs).toBeGreaterThan(end("starve", "look").nowMs);
    expect(runElevator(BLOCK_SCRIPTS.starve, { policy: "deadline", merge: true }).some((x) => x.expired)).toBe(true);
  });
  test("the plots", () => {
    const run = (device: "hdd" | "nvme", sched: SchedId, qd: number) => schedRun({ device, sched, qd, readShare: 0.7 });
    expect(jobDepths(32, 0.7)).toEqual({ reader: 22, writer: 10 });
    for (const q of [2, 4, 8, 16, 32, 64, 128]) close(run("hdd", "none", q).iops, 78, -0.5);
    close(run("hdd", "mq-deadline", 32).iops, 127);
    close(run("hdd", "bfq", 32).iops, 121);
    close(run("hdd", "none", 32).readIops, 53);
    close(run("hdd", "mq-deadline", 32).readIops, 88);
    close(run("hdd", "bfq", 32).readIops, 97);
    close(run("hdd", "none", 2).readP99Ms, 39);
    close(run("hdd", "mq-deadline", 2).readP99Ms, 69);
    for (const s of ["none", "mq-deadline", "bfq"] as SchedId[]) close(run("nvme", s, 2).readP99Ms, 0.155, 1);
    close(run("nvme", "none", 1024).iops / 100, 3717);
    close(run("nvme", "mq-deadline", 1024).iops / 100, 3298);
    close(run("nvme", "bfq", 1024).iops / 100, 1248);
    expect(lockCapIops("bfq")).toBe(125000);
    close(lockCapIops("mq-deadline"), 333333);
  });
});

describe("blocking, non-blocking and async I/O", () => {
  test("facts and inputs", () => {
    expect(IO_MODEL_NAMES.length).toBe(5);
    expect(EVENT_FACTS).toMatchObject({ fdSetSize: 1024, fdSetBytes: 128, pollfdBytes: 8, epollWatchBytes: 160, c10k: 10000 });
    expect(EVENT_FACTS.fdSetBytes * 8).toBe(EVENT_FACTS.fdSetSize);
    expect(EVENT_MODEL).toMatchObject({ syscallNs: 200, readWorkNs: 800, handlerNs: 2000, switchNs: 1500, connStateBytes: 1024 });
    expect(threadsLimit()).toBe(32765);
  });
  test("the server table", () => {
    const at = (m: "threads" | "select" | "poll" | "epoll", n: number) => serverCost(m, n, 10);
    close(at("epoll", 10000).cores, 0.325, 3);
    expect(at("poll", 10000).cores).toBe(1);
    close(at("poll", 10000).cores / at("epoll", 10000).cores, 3, 0);
    close(at("poll", 10000).batch, 57, 0);
    close(at("threads", 10000).memBytes / 2 ** 20, 322, 0);
    close(at("epoll", 10000).memBytes / 2 ** 20, 11.3, 1);
    close(at("threads", 10000).memBytes / 10000 / 1024, 33, 0);
    expect(at("threads", 10000).nsPerEvent).toBe(6000);
    expect(at("epoll", 10000).nsPerEvent).toBe(3250);
    close(at("select", 1024).cores * 100, 45, 0);
    close(at("epoll", 1024).cores * 100, 3.3, 1);
    expect(at("select", 1024).feasible).toBe(true);
    expect(at("select", 1025).feasible).toBe(false);
    expect(at("threads", 32765).feasible).toBe(true);
    expect(at("threads", 32766).feasible).toBe(false);
    expect(maxConnections("epoll", 10)).toBe(32786);
    expect(at("epoll", 100000).saturated).toBe(true);
  });
  test("the stall", () => {
    const r = runReader([4096], { mode: "edge", chunk: 1024, drain: false });
    expect(r.stalled).toBe(true);
    expect(r.left).toBe(3072);
  });
  test("starvation", () => {
    expect(STARVE_MODEL).toMatchObject({ readUs: 1, packetBytes: 1460, budget: 16 });
    expect(starvationRun({ policy: "drain", fastMBps: 1000 }).slowWaitUs).toBe(86);
    expect(starvationRun({ policy: "budget", fastMBps: 1000 }).slowWaitUs).toBe(16);
    expect(starvationRun({ policy: "budget", fastMBps: 3000 }).slowWaitUs).toBe(16);
    expect(drainNeverEndsMBps()).toBe(1460);
    close((1460 * 8) / 1000, 11.7, 1);
    expect(starvationRun({ policy: "drain", fastMBps: 1440 }).slowServed).toBe(true);
    expect(starvationRun({ policy: "drain", fastMBps: 1461 }).slowServed).toBe(false);
  });
});

describe("io_uring", () => {
  test("facts and inputs", () => {
    expect(URING_FACTS).toMatchObject({ sqeBytes: 64, cqeBytes: 16, cqPerSq: 2, maxEntries: 32768, firstKernel: "5.1", disabledSysctlKernel: "6.6", kctfShare: 0.6 });
    expect(URING_MODEL).toMatchObject({ opWorkNs: 800, arrivalGapNs: 5000, fileRefNs: 30 });
    expect(2 ** 32).toBe(4294967296);
    expect(((1 - 4294967295) >>> 0)).toBe(2);
  });
  test("the table at a batch of 16", () => {
    const c = (p: IoPath, o = {}) => ioPathCost(p, 16, o);
    expect(c("epoll").syscallsPerOp).toBe(1.0625);
    expect(c("uring").syscallsPerOp).toBe(0.0625);
    expect(c("epoll").syscallsPerOp / c("uring").syscallsPerOp).toBe(17);
    close(c("epoll").cpuNs, 1093, -0.5);
    close(c("uring").cpuNs, 883, -0.5);
    close(c("epoll").cpuNs / c("uring").cpuNs, 1.2, 1);
    expect((16 - 1) / 2 * 5).toBe(37.5);
    expect(c("read").latencyNs).toBe(4030);
    expect(c("sqpoll").syscallsPerOp).toBe(0);
    expect(c("sqpoll").latencyNs).toBe(1170);
    expect(c("sqpoll").extraCores).toBe(1);
  });
  test("mitigations and fixed files", () => {
    const no = { mitigations: NO_MITIGATIONS };
    close(ioPathCost("epoll", 16, no).cpuNs, 944, -0.5);
    close(ioPathCost("uring", 16, no).cpuNs, 874, -0.5);
    expect(ioPathCost("uring", 16).cpuNs - ioPathCost("uring", 16, { fixedFiles: true }).cpuNs).toBe(30);
  });
});
