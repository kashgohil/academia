/** Property tests for the I/O module: rings, merging, readiness, translation and conservation laws. */
import { describe, expect, test } from "vitest";
import {
  COMMAND, DescRing, DmaLine, EpollSocket, Iommu, IoRing, STATUS, ToyDevice, URING_FACTS, irqShares, irqTimeline, recvActions, replayDevice, requestIsContiguous,
  rxGoodput, rxRun, runElevator, runReader, schedRun, sectorsOf, sendActions, sgList, submitBio, u32, BLOCK_SCRIPTS,
  type BlkRequest, type Bio, type Cqe, type ElevatorPolicy, type RxMode, type TriggerMode,
} from "@/sims/os/io";
import { mulberry32 } from "@/sims/rng";

const PAYLOAD = [76, 65, 66];

describe("io_uring ring: u32 indices", () => {
  test("u32 arithmetic wraps", () => {
    expect(u32(2 ** 32)).toBe(0);
    expect(u32(1 - 4294967295)).toBe(2);
  });

  test("no completion is lost or duplicated, for any start, including across the wrap", () => {
    for (const start of [0, 2 ** 32 - 1, 2 ** 32 - 3, 2 ** 32 - 17, 2 ** 31, 12345]) {
      for (const entries of [2, 4, 8]) {
        const rng = mulberry32(start % 1000 + entries);
        const r = new IoRing({ entries, start });
        let next = 1;
        const seen: number[] = [];
        const finished: number[] = [];
        for (let k = 0; k < 4000; k++) {
          const x = rng();
          if (x < 0.3) { if (r.push({ userData: next, op: "read" })) next++; }
          else if (x < 0.5) r.enter();
          else if (x < 0.75 && r.inflight.length) {
            const f = r.inflight[Math.floor(rng() * r.inflight.length)]!;
            r.complete(f.sqe.userData);
            finished.push(f.sqe.userData);
          } else { const c = r.reap(); if (c) seen.push(c.userData); }
          expect(r.sqReady).toBeLessThanOrEqual(r.entries);
          expect(r.sqSpace).toBe(r.entries - r.sqReady);
          expect(r.cqReady).toBeLessThanOrEqual(r.cqEntries);
          for (const v of [r.sqHead, r.sqTail, r.cqHead, r.cqTail]) { expect(Number.isInteger(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(2 ** 32); }
        }
        // Finish and read everything.
        r.enter();
        while (r.inflight.length) { const id = r.inflight[0]!.sqe.userData; r.complete(id); finished.push(id); let c: Cqe | null; while ((c = r.reap())) seen.push(c.userData); }
        let c: Cqe | null;
        while ((c = r.reap())) seen.push(c.userData);
        expect(seen).toEqual(finished); // reads follow completion order, with no loss or duplicate
        expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: next - 1 }, (_, i) => i + 1));
      }
    }
  });

  test("the tail really wraps, and the fill level stays correct", () => {
    const r = new IoRing({ entries: 4, start: 2 ** 32 - 2 });
    for (let i = 1; i <= 4; i++) expect(r.push({ userData: i, op: "read" })).toBe(true);
    expect(r.sqTail).toBe(2);
    expect(r.sqHead).toBe(2 ** 32 - 2);
    expect(r.sqReady).toBe(4);
    expect(r.push({ userData: 5, op: "read" })).toBe(false);
    expect(r.enter()).toBe(4);
    expect(r.sqHead).toBe(2);
    expect(r.sqReady).toBe(0);
  });

  test("full and empty differ, and all slots are usable", () => {
    const r = new IoRing({ entries: 8 });
    expect(r.sqReady).toBe(0);
    for (let i = 0; i < 8; i++) r.push({ userData: i, op: "x" });
    expect(r.sqSpace).toBe(0);
    expect(r.sqHead & r.sqMask).toBe(r.sqTail & r.sqMask); // same slot, and the count tells them apart
  });

  test("sizes round up to a power of two, and the CQ is twice the SQ", () => {
    const r = new IoRing({ entries: 5 });
    expect(r.entries).toBe(8);
    expect(r.cqEntries).toBe(16);
  });

  test("CQ overflow keeps every CQE and keeps its order", () => {
    const r = new IoRing({ entries: 4, cqEntries: 2 });
    for (let i = 1; i <= 4; i++) r.push({ userData: i, op: "x" });
    r.enter();
    for (const id of [3, 1, 4, 2]) r.complete(id);
    expect(r.overflow.length).toBe(2);
    const got: number[] = [];
    let c: Cqe | null;
    while ((c = r.reap())) got.push(c.userData);
    expect(got).toEqual([3, 1, 4, 2]);
  });

  test("a link waits for its parent, and a failure cancels the rest of the chain", () => {
    const r = new IoRing({ entries: 8 });
    r.push({ userData: 1, op: "open", link: true });
    r.push({ userData: 2, op: "read", link: true });
    r.push({ userData: 3, op: "close" });
    r.push({ userData: 4, op: "other" });
    r.enter();
    expect(r.canComplete(1)).toBe(true);
    expect(r.canComplete(2)).toBe(false);
    expect(r.complete(2)).toBe(false);
    expect(r.canComplete(4)).toBe(true);
    r.complete(1, -2);
    const got = [r.reap()!, r.reap()!, r.reap()!];
    expect(got.map((c) => [c.userData, c.res])).toEqual([[1, -2], [2, -URING_FACTS.ECANCELED], [3, -URING_FACTS.ECANCELED]]);
    expect(r.inflight.map((f) => f.sqe.userData)).toEqual([4]);
  });

  test("a successful link releases the next step", () => {
    const r = new IoRing({ entries: 8 });
    r.push({ userData: 1, op: "open", link: true });
    r.push({ userData: 2, op: "read" });
    r.enter();
    r.complete(1, 3);
    expect(r.canComplete(2)).toBe(true);
  });

  test("multishot posts many CQEs from one SQE", () => {
    const r = new IoRing({ entries: 4 });
    r.push({ userData: 7, op: "accept", multishot: true });
    r.enter();
    r.complete(7, 10, { more: true });
    r.complete(7, 11, { more: true });
    r.complete(7, 12);
    const got = [r.reap()!, r.reap()!, r.reap()!];
    expect(got.map((c) => [c.res, c.more])).toEqual([[10, true], [11, true], [12, false]]);
    expect(r.inflight.length).toBe(0);
    expect(r.consumed).toBe(1);
  });

  test("SQPOLL takes SQEs with no system call, until the thread sleeps", () => {
    const r = new IoRing({ entries: 4, sqpoll: true });
    r.push({ userData: 1, op: "x" });
    expect(r.sqpollTick()).toBe(1);
    expect(r.enterCalls).toBe(0);
    r.sqpollSleep();
    r.push({ userData: 2, op: "x" });
    expect(r.sqpollTick()).toBe(0);
    expect(r.needWakeup).toBe(true);
    r.enter();
    expect(r.enterCalls).toBe(1);
    expect(r.wakeups).toBe(1);
    expect(r.sqpollTick()).toBe(1);
  });
});

describe("descriptor ring", () => {
  test("every buffer is sent and reaped exactly once, in order, under random actions", () => {
    for (const size of [2, 4, 8, 16]) {
      const rng = mulberry32(size);
      const r = new DescRing(size);
      let next = 1;
      const accepted: number[] = [];
      for (let k = 0; k < 5000; k++) {
        const x = rng();
        if (x < 0.35) { if (r.post(next)) { accepted.push(next); next++; } }
        else if (x < 0.5) r.doorbell();
        else if (x < 0.75) r.deviceStep();
        else r.reap();
        expect(r.inUse).toBeLessThanOrEqual(r.capacity);
        expect(r.deviceOwned + r.unpublished).toBeLessThanOrEqual(r.inUse);
      }
      r.doorbell();
      while (r.deviceStep()) { /* finish */ }
      while (r.reap() !== null) { /* free */ }
      expect(r.sent).toEqual(accepted);
      expect(r.reapedBufs).toEqual(accepted);
      expect(r.inUse).toBe(0);
      expect(r.staleReads).toBe(0);
    }
  });

  test("N slots hold N - 1 buffers", () => {
    const r = new DescRing(8);
    let n = 0;
    while (r.post(++n)) { /* fill */ }
    expect(r.posted).toBe(7);
    expect(r.isFull).toBe(true);
    expect(r.fullRejects).toBe(1);
  });

  test("the device cannot see a descriptor before the doorbell", () => {
    const r = new DescRing(4);
    r.post(1);
    expect(r.deviceIdle).toBe(true);
    expect(r.deviceStep()).toBeNull();
    r.doorbell();
    expect(r.deviceStep()!.buf).toBe(1);
  });

  test("a doorbell with no barrier lets the device read a stale descriptor", () => {
    const r = new DescRing(4);
    r.post(1, false);
    r.doorbell(false);
    const d = r.deviceStep()!;
    expect(d.stale).toBe(true);
    expect(d.buf).toBeNull();
    expect(r.staleReads).toBe(1);
    const ok = new DescRing(4);
    ok.post(1, false);
    ok.doorbell(true);
    expect(ok.deviceStep()!.stale).toBe(false);
  });

  test("a driver cannot reap a slot that the device still owns", () => {
    const r = new DescRing(4);
    r.post(1);
    r.doorbell();
    expect(r.reap()).toBeNull();
  });
});

describe("toy device", () => {
  test("the correct driver delivers every byte at every speed, with no protocol error", () => {
    for (let l = 1; l <= 20; l++) {
      const { dev } = replayDevice("send", l, sendActions(3, l, "correct"), PAYLOAD);
      expect(dev.wire).toEqual(PAYLOAD);
      expect(dev.problems).toBe(0);
      const rx = replayDevice("recv", l, recvActions(3, l, "correct"), PAYLOAD).dev;
      expect(rx.got).toEqual(PAYLOAD);
      expect(rx.problems).toBe(0);
    }
  });

  test("a driver with no wait works only on the fastest device", () => {
    expect(replayDevice("send", 1, sendActions(3, 1, "no-wait"), PAYLOAD).dev.wire).toEqual(PAYLOAD);
    for (let l = 2; l <= 20; l++) {
      const { dev } = replayDevice("send", l, sendActions(3, l, "no-wait"), PAYLOAD);
      expect(dev.wire).not.toEqual(PAYLOAD);
      expect(dev.problems).toBeGreaterThan(0);
    }
  });

  test("a read with no wait gets stale data on a device of 2 cycles or more", () => {
    for (let l = 2; l <= 12; l++) {
      const { dev } = replayDevice("recv", l, recvActions(3, l, "no-wait"), PAYLOAD);
      expect(dev.got).not.toEqual(PAYLOAD);
      expect(dev.problems).toBeGreaterThan(0);
    }
  });

  test("the device never invents a byte: the wire holds only values written to DATA", () => {
    const rng = mulberry32(9);
    for (let run = 0; run < 100; run++) {
      const d = new ToyDevice(1 + Math.floor(rng() * 5));
      const written = new Set([0]);
      for (let k = 0; k < 60; k++) {
        const x = rng();
        if (x < 0.35) { const v = 100 + Math.floor(rng() * 50); written.add(v); d.writeData(v); }
        else if (x < 0.7) d.writeCommand(COMMAND.SEND);
        else d.readStatus();
      }
      for (const v of d.wire) expect(written.has(v)).toBe(true);
    }
  });

  test("a command during BUSY is ignored and sets ERR", () => {
    const d = new ToyDevice(5);
    d.writeCommand(COMMAND.SEND);
    d.writeCommand(COMMAND.SEND);
    expect(d.status & STATUS.ERR).toBe(STATUS.ERR);
    expect(d.log.at(-1)!.problem).toBe("command-while-busy");
  });
});

describe("DMA", () => {
  test("map and unmap give correct data in both directions on both systems", () => {
    for (const coherent of [false, true]) {
      const tx = new DmaLine(coherent);
      tx.cpuWrite("new"); tx.mapForDevice("to-device");
      expect(tx.deviceRead()).toBe("new");
      tx.mapForCpu("to-device");
      expect(tx.staleReads).toBe(0);
      const rx = new DmaLine(coherent);
      rx.cpuRead(); rx.mapForDevice("from-device"); rx.deviceWrite("dev"); rx.mapForCpu("from-device");
      expect(rx.cpuRead()).toBe("dev");
      expect(rx.staleReads).toBe(0);
    }
  });

  test("with no API calls, only the non-coherent system reads stale data", () => {
    const a = new DmaLine(false);
    a.cpuWrite("new");
    expect(a.deviceRead()).toBe("old");
    expect(a.staleReads).toBe(1);
    const b = new DmaLine(false);
    b.cpuRead(); b.deviceWrite("dev");
    expect(b.cpuRead()).toBe("old");
    expect(b.staleReads).toBe(1);
    const c = new DmaLine(true);
    c.cpuWrite("new");
    expect(c.deviceRead()).toBe("new");
    c.deviceWrite("dev");
    expect(c.cpuRead()).toBe("dev");
    expect(c.staleReads).toBe(0);
  });

  test("an unmap also drops a line that the CPU fetched while the device owned the buffer", () => {
    const l = new DmaLine(false);
    l.mapForDevice("from-device");
    l.cpuRead(); // a speculative fetch
    l.deviceWrite("dev");
    l.mapForCpu("from-device");
    expect(l.cpuRead()).toBe("dev");
  });

  test("sgList merges adjacent frames and keeps every page", () => {
    const rng = mulberry32(3);
    for (let run = 0; run < 100; run++) {
      const pfns = Array.from({ length: 1 + Math.floor(rng() * 30) }, () => Math.floor(rng() * 40));
      const sg = sgList(pfns);
      expect(sg.flatMap((s) => Array.from({ length: s.pages }, (_, i) => s.addr + i))).toEqual(pfns);
      for (let i = 1; i < sg.length; i++) expect(sg[i - 1]!.addr + sg[i - 1]!.pages).not.toBe(sg[i]!.addr);
    }
  });
});

describe("IOMMU", () => {
  const base = 0x1000_0000;
  const setup = () => {
    const u = new Iommu();
    u.attach("nic", 1);
    u.attach("gpu", 2);
    u.map(1, base, 0x123, { write: true });
    u.map(1, base + 4096, 0x456, { write: false });
    return u;
  };

  test("a mapped address translates, with its offset, through a 4-level walk", () => {
    const u = setup();
    const r = u.translate("nic", base + 0x10, "r");
    expect(r.ok).toBe(true);
    expect(r.pa).toBe(0x123 * 4096 + 0x10);
    expect(r.events.length).toBe(4);
    expect(r.iotlbHit).toBe(false);
    const again = u.translate("nic", base + 0x20, "r");
    expect(again.iotlbHit).toBe(true);
    expect(again.events.length).toBe(0);
    expect(again.pa).toBe(0x123 * 4096 + 0x20);
  });

  test("bad addresses and bad rights are blocked and logged, both on a walk and on an IOTLB hit", () => {
    const u = setup();
    expect(u.translate("nic", 0x9000, "r").fault).toBe("not-mapped");
    expect(u.translate("nic", base + 4096, "w").fault).toBe("read-only");
    expect(u.translate("nic", base + 4096, "r").ok).toBe(true);
    const hit = u.translate("nic", base + 4096, "w");
    expect(hit.iotlbHit).toBe(true);
    expect(hit.fault).toBe("read-only");
    expect(u.translate("stranger", base, "r").fault).toBe("no-domain");
    expect(u.faults.length).toBe(4);
  });

  test("domains are isolated", () => {
    const u = setup();
    expect(u.translate("nic", base, "r").ok).toBe(true);
    expect(u.translate("gpu", base, "r").ok).toBe(false);
  });

  test("strict unmap closes the window at once. Lazy unmap leaves it open until the flush", () => {
    const strict = setup();
    strict.translate("nic", base, "r");
    strict.unmap(1, base, "strict");
    expect(strict.translate("nic", base, "r").ok).toBe(false);
    const lazy = setup();
    lazy.translate("nic", base, "r");
    lazy.unmap(1, base, "lazy");
    expect(lazy.pendingFlush).toBe(1);
    expect(lazy.translate("nic", base, "r").ok).toBe(true);
    lazy.flush();
    expect(lazy.translate("nic", base, "r").ok).toBe(false);
  });
});

describe("block layer", () => {
  const randomBios = (seed: number, n: number): Bio[] => {
    const rng = mulberry32(seed);
    const bios: Bio[] = [];
    const used = new Set<number>();
    for (let id = 0; bios.length < n; id++) {
      const sector = Math.floor(rng() * 200) * 8;
      const op = rng() < 0.7 ? "R" : "W";
      if (used.has(sector)) continue;
      used.add(sector);
      bios.push({ id, sector, sectors: 8, op });
    }
    return bios;
  };

  test("merging keeps every byte exactly once, and each request stays contiguous", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const bios = randomBios(seed, 80);
      const q: BlkRequest[] = [];
      let id = 1;
      for (const b of bios) submitBio(q, { ...b }, { nextId: id++, maxSectors: seed % 2 ? 64 : 4096 });
      expect(sectorsOf(q)).toEqual(sectorsOf([{ bios }]));
      expect(q.reduce((a, r) => a + r.sectors, 0)).toBe(bios.length * 8);
      for (const r of q) {
        expect(requestIsContiguous(r)).toBe(true);
        expect(r.sectors).toBeLessThanOrEqual(seed % 2 ? 64 : 4096);
      }
    }
  });

  test("reads and writes do not merge", () => {
    const q: BlkRequest[] = [];
    submitBio(q, { id: 1, sector: 0, sectors: 8, op: "R" });
    expect(submitBio(q, { id: 2, sector: 8, sectors: 8, op: "W" }).kind).toBe("none");
    expect(q.length).toBe(2);
  });

  test("back merge, front merge, and a bio that closes a gap", () => {
    const q: BlkRequest[] = [];
    submitBio(q, { id: 1, sector: 100, sectors: 8, op: "R" });
    expect(submitBio(q, { id: 2, sector: 108, sectors: 8, op: "R" }).kind).toBe("back");
    expect(submitBio(q, { id: 3, sector: 92, sectors: 8, op: "R" }).kind).toBe("front");
    submitBio(q, { id: 4, sector: 124, sectors: 8, op: "R" });
    expect(q.length).toBe(2);
    const join = submitBio(q, { id: 5, sector: 116, sectors: 8, op: "R" });
    expect(join.joined).toBe(true);
    expect(q.length).toBe(1);
    expect(q[0]!.sector).toBe(92);
    expect(q[0]!.sectors).toBe(40);
    expect(requestIsContiguous(q[0]!)).toBe(true);
  });

  test("the elevator serves each bio once, with every policy", () => {
    for (const key of Object.keys(BLOCK_SCRIPTS) as (keyof typeof BLOCK_SCRIPTS)[]) {
      for (const policy of ["fifo", "look", "deadline"] as ElevatorPolicy[]) {
        for (const merge of [true, false]) {
          const script = BLOCK_SCRIPTS[key];
          const end = runElevator(script, { policy, merge }).at(-1)!;
          const bios = script.steps.filter((s): s is Bio => s !== "dispatch");
          expect(end.queue.length).toBe(0);
          expect(sectorsOf(end.done)).toEqual(sectorsOf([{ bios }]));
          for (const r of end.done) expect(requestIsContiguous(r)).toBe(true);
        }
      }
    }
  });

  test("LOOK never reverses while work lies ahead of the head, when nothing new arrives", () => {
    const script = { label: "t", steps: [...randomBios(4, 30).map((b, i) => ({ ...b, sector: b.sector * 100, id: i })), "dispatch" as const] };
    const end = runElevator(script, { policy: "look", merge: false }).at(-1)!;
    const s = end.done.map((r) => r.sector);
    expect(s).toEqual([...s].sort((a, b) => a - b));
  });

  test("runs are deterministic, and a scheduler lock is a real cap", () => {
    const o = { device: "nvme" as const, sched: "bfq" as const, qd: 256, readShare: 0.7 };
    expect(schedRun(o).iops).toBe(schedRun(o).iops);
    expect(schedRun(o).iops).toBeLessThanOrEqual(125_001);
  });
});

describe("readiness", () => {
  const rng = mulberry32(21);
  const arrivals = () => Array.from({ length: 1 + Math.floor(rng() * 6) }, () => 1 + Math.floor(rng() * 20000));

  test("an edge-triggered reader that does not drain stalls, and a draining reader does not", () => {
    for (let k = 0; k < 300; k++) {
      const a = arrivals();
      const chunk = 1 + Math.floor(rng() * 4096);
      const total = a.reduce((x, y) => x + y, 0);
      const drain = runReader(a, { mode: "edge", chunk, drain: true });
      expect(drain.stalled).toBe(false);
      expect(drain.left).toBe(0);
      expect(drain.consumed).toBe(total);
      const partial = runReader(a, { mode: "edge", chunk, drain: false });
      // One read per event, and one event per arrival.
      expect(partial.reads).toBe(a.length);
      if (a.at(-1)! > chunk) {
        expect(partial.stalled).toBe(true);
        expect(partial.left).toBeGreaterThan(0);
      }
    }
  });

  test("a level-triggered reader never stalls, whatever it reads per event", () => {
    for (let k = 0; k < 300; k++) {
      const a = arrivals();
      const chunk = 1 + Math.floor(rng() * 4096);
      for (const drain of [true, false]) {
        const r = runReader(a, { mode: "level", chunk, drain });
        expect(r.stalled).toBe(false);
        expect(r.left).toBe(0);
        expect(r.consumed).toBe(a.reduce((x, y) => x + y, 0));
      }
    }
  });

  test("new data makes a new edge, even if the buffer was not empty", () => {
    const s = new EpollSocket("edge");
    s.arrive(100);
    expect(s.wait().event).toBe(true);
    s.read(10);
    expect(s.wait().event).toBe(false);
    expect(s.stalled).toBe(true);
    s.arrive(1);
    expect(s.stalled).toBe(false);
    expect(s.wait().event).toBe(true);
    expect(s.buffered).toBe(91);
  });

  test("bytes are conserved in both modes", () => {
    for (const mode of ["edge", "level"] as TriggerMode[]) {
      const s = new EpollSocket(mode);
      for (let k = 0; k < 2000; k++) {
        const x = rng();
        if (x < 0.3) s.arrive(Math.floor(rng() * 500));
        else if (x < 0.6) s.wait();
        else s.read(Math.floor(rng() * 500) + 1);
        expect(s.consumed + s.buffered).toBe(s.arrived);
      }
    }
  });

  test("EAGAIN only on an empty buffer", () => {
    const s = new EpollSocket("level");
    expect(s.read(10)).toBe(-1);
    s.arrive(5);
    expect(s.read(10)).toBe(5);
    expect(s.read(10)).toBe(-1);
    expect(s.eagains).toBe(2);
  });
});

describe("interrupts", () => {
  test("the timeline accounts for all time, and hard work is never preempted by softirq work", () => {
    for (const rate of [1000, 20000, 100000, 300000]) {
      for (const framesPerIrq of [1, 8]) {
        const r = irqTimeline({ rate, spanUs: 10000, framesPerIrq, coalesceUs: framesPerIrq > 1 ? 50 : 0 });
        const total = r.time.hard + r.time.soft + r.time.ksoftirqd + r.time.task;
        expect(total).toBeCloseTo(10000, 3);
        for (let i = 1; i < r.segments.length; i++) expect(r.segments[i]!.start).toBeGreaterThanOrEqual(r.segments[i - 1]!.end - 1e-6);
        expect(r.handled + r.backlog).toBeGreaterThanOrEqual(r.events - 1);
        expect(r.handled).toBeLessThanOrEqual(r.events);
      }
    }
  });

  test("a softirq limit protects the task under overload", () => {
    const r = irqTimeline({ rate: 200000, spanUs: 20000 });
    expect(r.deferred).toBe(true);
    expect(r.time.ksoftirqd).toBeGreaterThan(0);
    expect(r.time.task).toBeGreaterThan(0);
    expect(irqShares(200000).task).toBe(0);
  });

  test("the formula agrees with the timeline when softirq work keeps up", () => {
    for (const c of [{ rate: 20000 }, { rate: 100000 }, { rate: 100000, framesPerIrq: 8, coalesceUs: 50 }]) {
      const r = irqTimeline({ ...c, spanUs: 200000 });
      const s = irqShares(c.rate, c);
      expect(r.time.task / 200000).toBeCloseTo(s.task, 1);
      expect(r.time.hard / 200000).toBeCloseTo(s.hard, 1);
    }
  });

  test("every packet ends in exactly one place", () => {
    for (const mode of ["irq", "coalesce", "napi"] as RxMode[]) {
      for (const rate of [5e4, 15e4, 4e5, 1e6]) {
        const r = rxRun({ mode, rate, spanUs: 10000, stepUs: 0.5 });
        expect(r.delivered + r.ringDrops + r.backlogDrops + r.socketDrops + r.inFlight).toBe(r.arrived);
        const t = r.time.hard + r.time.soft + r.time.app + r.time.idle;
        expect(t).toBeCloseTo(10000, 0);
      }
    }
  });

  test("the fluid curves agree with the packet simulation", () => {
    for (const mode of ["irq", "coalesce", "napi"] as RxMode[]) {
      for (const rate of [5e4, 12e4, 2e5, 3e5, 5e5]) {
        const d = rxRun({ mode, rate, spanUs: 50000 }).goodput;
        const f = rxGoodput(mode, rate).goodput;
        expect(Math.abs(d - f)).toBeLessThan(0.06 * Math.max(f, 1e5));
      }
    }
  });

  test("livelock: interrupt per packet falls to zero under load, and NAPI does not", () => {
    expect(rxRun({ mode: "irq", rate: 3e5, spanUs: 30000 }).delivered).toBe(0);
    expect(rxRun({ mode: "coalesce", rate: 5e5, spanUs: 30000 }).delivered).toBe(0);
    const n = rxRun({ mode: "napi", rate: 1e6, spanUs: 30000 });
    expect(n.goodput).toBeGreaterThan(9e4);
    expect(n.ringDrops).toBeGreaterThan(n.socketDrops);
    expect(n.interrupts).toBeLessThan(10);
  });
});
