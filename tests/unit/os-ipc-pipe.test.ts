/** Pipes: the ring rules, properties under random sizes, exhaustive interleavings, and the quoted numbers. */
import { describe, expect, test } from "vitest";
import {
  PIPE_COST, PIPE_FACTS, Pipe, checkStream, explorePipe, findSplit, pipeInterleaveModel, pipeThroughput, pipeTransfer, pushRun, roundPipeSize,
  type Run,
} from "../../src/sims/os/ipc";
import { replay } from "../../src/sims/os/sync/machine";
import { mulberry32 } from "../../src/sims/rng";

/** Fills a fresh pipe with writes of one size. Returns the bytes in the pipe when a write first sleeps. */
function fillUntilBlocked(size: number, slots = 16) {
  const p = new Pipe({ slots });
  for (;;) {
    const r = p.write("w", size);
    if (r.status === "blocked") return { bytes: p.buffered, writes: p.stats.writes, p, partial: r.written };
  }
}

describe("facts", () => {
  test("default capacity and limits", () => {
    expect(PIPE_FACTS.defaultCapacity).toBe(65536);
    expect(new Pipe().capacity).toBe(65536);
    expect(PIPE_FACTS.pipeBuf).toBe(4096);
    expect(PIPE_FACTS.pipeMaxSize).toBe(1048576);
    expect(PIPE_FACTS.pipesAtSoftLimit).toBe(1024);
    expect(PIPE_FACTS.capacityOn16kPages).toBe(262144);
    expect(new Pipe({ pageSize: 16384 }).capacity).toBe(262144);
    expect(PIPE_FACTS.macosPipeBuf).toBe(512);
  });
  test("F_SETPIPE_SZ rounds up to a power of two pages", () => {
    expect(roundPipeSize(5000)).toEqual({ slots: 2, bytes: 8192 });
    expect(roundPipeSize(65537)).toEqual({ slots: 32, bytes: 131072 });
    const p = new Pipe();
    expect(p.setSize(100000)).toBe(131072);
    expect(p.capacity).toBe(131072);
    expect(p.setSize(2 << 20)).toBe("EPERM");
    expect(p.setSize(2 << 20, { privileged: true })).toBe(2097152);
    const q = new Pipe();
    q.write("w", 8192);
    q.write("w", 4096);
    expect(q.setSize(4096)).toBe("EBUSY");
    expect(q.setSize(16384)).toBe(16384);
    expect(q.buffered).toBe(12288);
    expect(q.read("r", 100000).n).toBe(12288);
  });
});

describe("the ring: quoted capacities", () => {
  test("the bytes that fit depend on the write size", () => {
    expect(fillUntilBlocked(1).bytes).toBe(65536);
    expect(fillUntilBlocked(100).bytes).toBe(64000);
    expect(fillUntilBlocked(2048).bytes).toBe(65536);
    expect(fillUntilBlocked(2049).bytes).toBe(32784);
    expect(fillUntilBlocked(2049).writes).toBe(17);
    expect(fillUntilBlocked(3000).bytes).toBe(48000);
    expect(fillUntilBlocked(4096).bytes).toBe(65536);
    expect(fillUntilBlocked(4096).writes).toBe(17);
  });
  test("a small write merges into the last slot", () => {
    const p = new Pipe();
    p.write("w", 100);
    p.write("w", 100);
    expect(p.used).toBe(1);
    expect(p.buffered).toBe(200);
    expect(p.stats.merges).toBe(1);
  });
  test("a write of a whole page never merges", () => {
    const p = new Pipe();
    p.write("w", 100);
    p.write("w", 4096);
    expect(p.used).toBe(2);
  });
  test("a larger write merges only its part below one page", () => {
    const p = new Pipe();
    p.write("w", 100);
    p.write("w", 5000); // 904 bytes merge, then one whole page
    expect(p.used).toBe(2);
    expect(p.slots[0]!.buf.len).toBe(1004);
    expect(p.slots[1]!.buf.len).toBe(4096);
  });
});

describe("blocking, non-blocking, EOF and SIGPIPE", () => {
  test("a reader sleeps on an empty pipe and wakes with data", () => {
    const p = new Pipe();
    expect(p.read("r", 10).status).toBe("blocked");
    expect(p.canResumeRead("r")).toBe(false);
    p.write("w", 5);
    expect(p.canResumeRead("r")).toBe(true);
    const r = p.resumeRead("r");
    expect(r).toMatchObject({ status: "ok", n: 5 }); // a short read: it returns what exists
  });
  test("a writer sleeps on a full pipe with its bytes in, and continues", () => {
    const p = new Pipe({ slots: 2 });
    const w = p.write("w", 12288);
    expect(w).toMatchObject({ status: "blocked", written: 8192 });
    expect(p.canResumeWrite("w")).toBe(false);
    p.read("r", 4096);
    expect(p.canResumeWrite("w")).toBe(true);
    expect(p.resumeWrite("w")).toMatchObject({ status: "ok", written: 12288 });
  });
  test("non-blocking: small write is all or nothing, larger write can be partial", () => {
    const p = new Pipe({ slots: 2 });
    p.write("w", 8192);
    expect(p.write("w", 100, { nonblock: true })).toMatchObject({ status: "EAGAIN", written: 0 });
    const q = new Pipe({ slots: 2 });
    q.write("w", 4096);
    expect(q.write("w", 8192, { nonblock: true })).toMatchObject({ status: "ok", written: 4096 });
    expect(new Pipe().read("r", 1, { nonblock: true }).status).toBe("EAGAIN");
  });
  test("EOF needs every write end closed", () => {
    const p = new Pipe();
    p.dupWrite(); // a shell that forgot to close its copy
    p.write("w", 3);
    p.closeWrite();
    expect(p.read("r", 10).n).toBe(3);
    expect(p.read("r2", 10).status).toBe("blocked");
    p.closeWrite();
    expect(p.canResumeRead("r2")).toBe(true);
    expect(p.resumeRead("r2").status).toBe("EOF");
  });
  test("data before EOF is still delivered", () => {
    const p = new Pipe();
    p.write("w", 3);
    p.closeWrite();
    expect(p.read("r", 10)).toMatchObject({ status: "ok", n: 3 });
    expect(p.read("r", 10).status).toBe("EOF");
  });
  test("SIGPIPE on a pipe with no reader", () => {
    const p = new Pipe();
    p.closeRead();
    expect(p.write("w", 10)).toEqual({ status: "EPIPE", written: 0, total: 10, sigpipe: true });
  });
  test("a sleeping writer gets SIGPIPE when the last reader closes, and reports its partial count", () => {
    const p = new Pipe({ slots: 2 });
    p.write("w", 12288);
    p.closeRead();
    expect(p.canResumeWrite("w")).toBe(true);
    expect(p.resumeWrite("w")).toMatchObject({ status: "ok", written: 8192, sigpipe: true });
  });
});

describe("splice", () => {
  test("a spliced page has no merge flag, so a later write cannot enter it", () => {
    // The merge flag on a spliced page was the Dirty Pipe bug.
    const p = new Pipe();
    p.spliceIn("file", 100);
    expect(p.slots[0]!.buf.canMerge).toBe(false);
    p.write("w", 10);
    expect(p.used).toBe(2);
    expect(p.slots[0]!.buf.len).toBe(100);
  });
  test("spliced bytes are not copied", () => {
    const p = new Pipe();
    p.spliceIn("file", 4096);
    expect(p.read("r", 4096).n).toBe(4096);
    expect(p.stats.bytesCopied).toBe(0);
  });
});

describe("property: bytes arrive in order with none lost", () => {
  for (const slots of [1, 2, 4, 16]) {
    test(`random reads and writes, ${slots} slots`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const r = mulberry32(seed * 7 + slots);
        const sizes = Array.from({ length: 40 }, () => 1 + Math.floor(r() * (r() < 0.5 ? 300 : 20000)));
        const p = new Pipe({ slots });
        const stream: Run[] = [];
        let next = 0;
        let eof = false;
        let writerAsleep = false;
        let readerAsleep = false;
        const onRead = (x: { runs: Run[]; status: string }) => {
          for (const y of x.runs) pushRun(stream, y);
          readerAsleep = x.status === "blocked";
          if (x.status === "EOF") eof = true;
        };
        let guard = 0;
        while (!eof) {
          expect(guard++).toBeLessThan(200000);
          const w = r() < 0.5;
          if (w && writerAsleep) {
            if (p.canResumeWrite("w")) writerAsleep = p.resumeWrite("w").status === "blocked";
          } else if (w && next < sizes.length) {
            writerAsleep = p.write("w", sizes[next++]!).status === "blocked";
          } else if (w && next === sizes.length && p.writers === 1) {
            p.closeWrite();
          } else if (readerAsleep) {
            if (p.canResumeRead("r")) onRead(p.resumeRead("r"));
          } else {
            onRead(p.read("r", 1 + Math.floor(r() * 9000)));
          }
          // The closed flag is only safe once all writes are in.
          if (!writerAsleep && next === sizes.length && p.writers === 1) p.closeWrite();
        }
        expect(checkStream(stream, { w: sizes })).toBeNull();
        expect(p.stats.bytesOut).toBe(sizes.reduce((a, b) => a + b, 0));
        expect(p.empty).toBe(true);
      }
    });
  }
});

describe("exhaustive: writes up to PIPE_BUF are never split", () => {
  const cases: [number, Record<string, number[]>, number][] = [
    [2, { A: [4096, 4096], B: [4096, 4096] }, 4096],
    [2, { A: [3000, 3000], B: [3000, 3000] }, 4096],
    [2, { A: [2049, 1], B: [100, 4096] }, 1000],
    [1, { A: [4096, 100], B: [100, 4096] }, 2048],
    [4, { A: [1, 4096, 2049], B: [4095, 3] }, 512],
  ];
  for (const [slots, writers, readSize] of cases) {
    test(`${slots} slots, ${JSON.stringify(writers)}, reads of ${readSize}`, () => {
      const r = explorePipe({ slots, writers, readSize });
      expect(r).toMatchObject({ violation: null, stuck: null, truncated: false, trapped: 0 });
      expect(r.outcomes).toEqual(["ok"]);
    });
  }
  test("a small write stays whole even next to large writes, which do split", () => {
    const writers = { A: [100, 100, 100], B: [12288] };
    const small = explorePipe({ slots: 2, writers, readSize: 4096, splitLimit: 4096 });
    expect(small.violation).toBeNull();
    const all = explorePipe({ slots: 2, writers, readSize: 4096 });
    expect(all.violation).not.toBeNull();
    expect(all.violation!.message).toContain("B");
  });
  test("one byte over PIPE_BUF can split", () => {
    const r = explorePipe({ slots: 2, writers: { A: [4097, 4097], B: [4097] }, readSize: 4096 });
    expect(r.violation).not.toBeNull();
  });
  test("a large write can split, and the schedule replays to the split", () => {
    const spec = { slots: 2, writers: { A: [8192 + 4096], B: [8192 + 4096] }, readSize: 4096 };
    const r = explorePipe(spec);
    expect(r.violation).not.toBeNull();
    const m = pipeInterleaveModel(spec);
    const trail = replay(m, r.violation!.schedule);
    const end = trail[trail.length - 1]!;
    expect(findSplit(end.stream)).not.toBeNull();
    // A split does not lose bytes: the same schedule space ends in order for each writer.
    const noStop = explorePipe({ ...spec, splitLimit: 0 });
    expect(noStop.outcomes).toEqual(["ok"]);
    expect(noStop.violation).toBeNull();
  });
});

describe("the throughput model", () => {
  const T = 1 << 22;
  test("counts follow the ring", () => {
    const c = pipeTransfer({ slots: 16, writeSize: 4096, readSize: 65536, totalBytes: 1 << 20 });
    expect(c.slots).toBe(256);
    expect(c.writes).toBe(256);
    expect(c.bytes).toBe(1 << 20);
    expect(c.reads).toBe(16);
    expect(c.switches).toBe(32);
  });
  test("a larger pipe means fewer switches", () => {
    const small = pipeTransfer({ slots: 1, writeSize: 4096, readSize: 65536, totalBytes: T });
    const big = pipeTransfer({ slots: 256, writeSize: 4096, readSize: 65536, totalBytes: T });
    expect(small.switches).toBeGreaterThan(big.switches * 100);
  });
  test("model inputs are the labelled ones", () => {
    expect(PIPE_COST).toEqual({ syscallNs: 150, copy4kNs: 400, pageNs: 100, pageRefNs: 30, switchNs: 2000 });
  });
  const gib = (slots: number, w: number, splice = false) => pipeThroughput({ slots, writeSize: w, readSize: 65536, totalBytes: T }, { splice }).bytesPerSec / 2 ** 30;
  test("quoted throughputs", () => {
    expect(gib(1, 4096)).toBeCloseTo(0.73, 2);
    expect(gib(16, 4096)).toBeCloseTo(2.91, 2);
    expect(gib(16, 512)).toBeCloseTo(1.62, 2);
    expect(gib(16, 65536)).toBeCloseTo(3.26, 2);
    expect(gib(256, 65536)).toBeCloseTo(4.08, 2);
    expect(gib(256, 65536, true)).toBeGreaterThan(gib(256, 65536) * 5);
  });
  test("share of copies with a large pipe", () => {
    const r = pipeThroughput({ slots: 256, writeSize: 65536, readSize: 65536, totalBytes: T });
    expect(r.parts.copies / r.totalNs).toBeCloseTo(0.86, 2);
    const s = pipeThroughput({ slots: 1, writeSize: 4096, readSize: 65536, totalBytes: T });
    expect(s.parts.switches / s.totalNs).toBeCloseTo(0.77, 2);
  });
});
