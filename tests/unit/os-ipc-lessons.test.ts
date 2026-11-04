/** Numbers that the IPC lessons quote, computed from the sims and found in the lesson text. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CORRECT_ORDERS, IPC_COST, PIPE_FACTS, Pipe, RELAXED_ORDERS, SHM_FACTS, SIG, SIGNAL_FACTS, TCP_LAYERS, UNIX_LAYERS, UDS_FACTS, UdsWorld, coalesceRun, exploreSpsc, explorePipe, handlerProg, ipcCost, pathCost,
  pipeThroughput, pipeTransfer, roundPipeSize, spscLineTraffic, spscLitmus,
} from "../../src/sims/os/ipc";
import { parse, runCxx } from "../../src/sims/memmodel";
import { explore, machineModel } from "../../src/sims/os/sync/machine";

const lesson = (n: string) => readFileSync(new URL(`../../src/content/lessons/os/ipc/${n}.mdx`, import.meta.url), "utf8");
const has = (text: string, ...parts: string[]) => { for (const p of parts) expect(text, p).toContain(p); };
const us = (ns: number) => `${(ns / 1000).toFixed(2)} µs`;

function fill(size: number) {
  const p = new Pipe();
  for (;;) if (p.write("w", size).status === "blocked") return p;
}

describe("pipes", () => {
  const t = lesson("pipes");
  test("capacities", () => {
    expect(PIPE_FACTS.defaultCapacity.toLocaleString("en-US")).toBe("65,536");
    expect(PIPE_FACTS.capacityOn16kPages.toLocaleString("en-US")).toBe("262,144");
    const p = fill(2049);
    expect(p.buffered.toLocaleString("en-US")).toBe("32,784");
    expect(p.stats.writes).toBe(17);
    expect(4096 - 2049).toBe(2047);
    expect(fill(100).buffered.toLocaleString("en-US")).toBe("64,000");
    expect(fill(3000).buffered.toLocaleString("en-US")).toBe("48,000");
    expect(Math.floor(65536 / 2049)).toBe(31);
    expect(31 * 2049).toBe(63519);
    expect(Math.floor(4096 / 100)).toBe(40);
    has(t, "65,536", "262,144", "32,784", "64,000", "48,000", "63,519", "2047", "1,048,576", "16,384 pages", "1024 default pipes", "only 2 slots", "status 141");
    expect(roundPipeSize(5000).bytes).toBe(8192);
    has(t, "5000 bytes gives 8192");
  });
  test("search results", () => {
    const run = (size: number) => explorePipe({ slots: 2, writers: { A: [size, size], B: [size, size] }, readSize: 4096 });
    expect(run(4096).states).toBe(190);
    expect(run(4096).violation).toBeNull();
    expect(run(512).violation).toBeNull();
    expect(run(4097).violation!.schedule.length).toBe(6);
    expect(run(12288).violation).not.toBeNull();
    has(t, "all 190 states", "has 6 steps");
  });
  test("throughput", () => {
    const T = 1 << 22;
    const g = (slots: number, w: number) => pipeThroughput({ slots, writeSize: w, readSize: 65536, totalBytes: T });
    const f = (x: { bytesPerSec: number }) => `${(x.bytesPerSec / 2 ** 30).toFixed(2)} GiB/s`;
    expect(f(g(1, 4096))).toBe("0.73 GiB/s");
    expect(f(g(16, 4096))).toBe("2.91 GiB/s");
    expect(f(g(16, 512))).toBe("1.62 GiB/s");
    expect(f(g(16, 65536))).toBe("3.26 GiB/s");
    expect(f(g(256, 65536))).toBe("4.08 GiB/s");
    has(t, "0.73 GiB/s", "2.91 GiB/s", "1.62 GiB/s", "3.26 GiB/s", "4.08 GiB/s", "77%", "86%", "16 times");
    expect(Math.round((g(1, 4096).parts.switches / g(1, 4096).totalNs) * 100)).toBe(77);
    expect(Math.round((g(256, 65536).parts.copies / g(256, 65536).totalNs) * 100)).toBe(86);
    const a = pipeTransfer({ slots: 1, writeSize: 4096, readSize: 65536, totalBytes: T }).switches;
    const b = pipeTransfer({ slots: 16, writeSize: 4096, readSize: 65536, totalBytes: T }).switches;
    expect(a / b).toBe(16);
  });
});

describe("signals", () => {
  const t = lesson("signals");
  test("facts in the text", () => {
    expect(SIG.SIGKILL + SIGNAL_FACTS.shellBase).toBe(137);
    has(t, "64 signal numbers", "`SIGRTMIN` is 34", "128-byte red zone", "128 bytes below", "It loads 15", "number is 139", "back 2 bytes", "10 ms", "status `128 + n`", "137", "31 standard signals", "SIGCHLD is 20 and SIGUSR1 is 30");
  });
  test("search and run results", () => {
    const run = (v: Parameters<typeof handlerProg>[0]) => explore(machineModel(handlerProg(v)));
    expect(run("malloc").stuck!.schedule.length).toBe(2);
    expect(run("masked").states).toBe(31);
    expect(run("self-pipe").states).toBe(29);
    has(t, "has 2 steps", "in 31 states", "covers 29 states");
    const r = coalesceRun({ sig: SIG.SIGCHLD, sends: 5, gap: 3, handlerTicks: 20, maskedTicks: 0 });
    expect([r.handlerRuns, r.merged]).toEqual([2, 3]);
    has(t, "runs the handler 2 times, and 3 sends merge", "runs it 5 times", "**zombies left**: 3", "into 1 handler run");
  });
});

describe("shared memory", () => {
  const t = lesson("shared-memory");
  test("the ring", () => {
    const s = { capacity: 2, messages: 3 };
    const ok = exploreSpsc({ ...s, orders: CORRECT_ORDERS });
    expect(ok.states).toBe(122);
    expect(ok.violation).toBeNull();
    expect(exploreSpsc({ ...s, orders: RELAXED_ORDERS }).violation!.schedule.length).toBe(5);
    has(t, "122 states", "In 5 steps", "4 outcomes", "3 references", "2 frames");
    const out = runCxx(parse(spscLitmus({ capacity: 2, messages: 2, orders: RELAXED_ORDERS }))).outcomes.filter((o) => !o.hang);
    expect(new Set(out.map((o) => `${o.regs.r0},${o.regs.r1}`)).size).toBe(4);
    expect(SHM_FACTS.refsWithTwoMappers).toBe(3);
    expect(SHM_FACTS.appleCacheLineBytes).toBe(128);
    has(t, "128 bytes", "alignas(64)");
  });
  test("cache lines", () => {
    const a = spscLineTraffic({ padded: true, cached: false });
    const b = spscLineTraffic({ padded: true, cached: true });
    expect(a.perMessage.toFixed(2)).toBe("5.00");
    expect(b.perMessage.toFixed(2)).toBe("2.26");
    expect(b.indexReadsPerMessage.toFixed(2)).toBe("0.14");
    expect(Math.round(a.perMessage * IPC_COST.lineNs)).toBe(200);
    expect(Math.round(b.perMessage * IPC_COST.lineNs)).toBe(90);
    has(t, "5.00 transfers", "falls to 2.26", "2 per message to 0.14", "40 ns", "200 ns to 90 ns");
  });
  test("the comparison", () => {
    const l = (k: "shm" | "pipe" | "unix", spin: boolean) => ipcCost(k, 64, spin).latencyNs;
    expect(l("shm", true).toFixed(1)).toBe("98.8");
    expect(Math.round(l("pipe", true))).toBe(459);
    expect(Math.round(l("unix", true))).toBe(659);
    expect(us(l("shm", false))).toBe("5.25 µs");
    expect(us(l("pipe", false))).toBe("5.42 µs");
    expect(us(l("unix", false))).toBe("5.62 µs");
    has(t, "98.8 ns", "459 ns", "659 ns", "5.25 µs", "5.42 µs", "5.62 µs", "19 million", "3.9 million", "2.19 million", "between 4.71 and 4.75 GiB/s");
    expect(Number((ipcCost("shm", 64, true).msgsPerSec / 1e6).toPrecision(3))).toBe(19);
    expect(Number((ipcCost("pipe", 64, true).msgsPerSec / 1e6).toPrecision(3))).toBe(3.9);
    expect(Number((ipcCost("unix", 64, true).msgsPerSec / 1e6).toPrecision(3))).toBe(2.19);
    for (const k of ["shm", "pipe", "unix"] as const) expect(["4.71", "4.75"]).toContain((ipcCost(k, 65536, true).bytesPerSec / 2 ** 30).toFixed(2));
  });
});

describe("Unix domain sockets", () => {
  const t = lesson("unix-domain-sockets");
  test("the loopback model", () => {
    const o = { bytes: 64, rules: 0, readerSleeps: false };
    const a = pathCost(TCP_LAYERS, o).totalNs, b = pathCost(UNIX_LAYERS, o).totalNs;
    expect(us(a)).toBe("1.66 µs");
    expect(Math.round(b)).toBe(649);
    expect((a / b).toFixed(2)).toBe("2.56");
    has(t, "14 layers", "6 layers", "1.66 µs", "649 ns", "2.56", "1.18", "1.05", "17.97", "4 hooks", "5 µs");
  });
  test("facts", () => {
    expect(UDS_FACTS.scmMaxFd).toBe(253);
    has(t, "108 bytes on Linux and 104 on macOS", "at most 253 fds", "from fd 3", ".s.PGSQL.5432", "65,536 bytes");
  });
  test("the stepper's numbers", () => {
    const w = new UdsWorld();
    w.addProcess("A", { pid: 1, uid: 1, gid: 1 });
    w.addProcess("B", { pid: 2, uid: 1, gid: 1 });
    w.open("B", "config");
    const [sa, sb] = w.socketpair("stream", "A", "B");
    const f = w.open("A", "log.txt");
    expect(f).toBe(4);
    const id = w.ofdOf("A", f)!.id;
    const counts = [w.ofds.get(id)!.refs];
    w.send("A", sa, "x", { fds: [f] });
    counts.push(w.ofds.get(id)!.refs);
    w.close("A", f);
    counts.push(w.ofds.get(id)!.refs);
    expect(counts).toEqual([1, 2, 1]);
    expect(w.recv("B", sb, 10).fds).toEqual([5]);
    has(t, "`f_count` goes 1, 2, 1", "gets fd 5 in B", "A had fd 4", "offset reaches 200");
  });
  test("boundaries: 11 bytes of 14", () => {
    has(t, "14: the", "11: it gets 4, then 3, then 4", "It loses 3 bytes");
  });
});
