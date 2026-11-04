/** Every number that the Processes and threads lessons quote, computed by src/sims/os/processes, and checked against the text. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as P from "@/sims/os/processes";

const text = (lesson: string) => readFileSync(new URL(`../../src/content/lessons/os/processes/${lesson}.mdx`, import.meta.url), "utf8");
const has = (lesson: string, ...needles: string[]) => { const t = text(lesson); for (const n of needles) expect(t, n).toContain(n); };
const roundTo = (x: number, d: number) => Number(x.toFixed(d));

describe("what-a-process-is", () => {
  test("a zombie leak of one per second uses the default PID range in about 9.1 hours", () => {
    expect(P.PID_MAX_DEFAULT).toBe(32768);
    expect(roundTo(P.pidExhaustionHours(1), 1)).toBe(9.1);
    has("what-a-process-is", "32,768", "9.1 hours");
  });
  test("the tree demo: 9 processes, kill cc1, kill make", () => {
    const t = P.treeTable();
    expect(t.procs.size).toBe(9);
    t.kill(520);
    expect(t.procs.size).toBe(9);
    expect(t.zombies().map((z) => z.pid)).toEqual([520]);
    t.kill(410);
    expect(t.stats.reparented).toBe(2);
    expect(t.stats.reapedByInit).toBe(1);
    expect(t.procs.size).toBe(8);
    expect(t.zombies().map((z) => z.name)).toEqual(["make"]);
    expect(t.get(521)!.ppid).toBe(1);
    has("what-a-process-is", "still has 9 processes", "Its 2 children move to PID 1", "The table has 8 processes");
  });
  test("subreaper: 2 zombies wait for bash", () => {
    const t = P.treeTable();
    t.get(305)!.subreaper = true;
    t.kill(520);
    t.kill(410);
    expect(t.zombies().map((z) => z.ppid)).toEqual([305, 305]);
  });
  test("a kill shows status 137: 128 + 9", () => {
    const t = P.treeTable();
    t.kill(520);
    expect(t.get(520)!.exitCode).toBe(128 + 9);
    has("what-a-process-is", "137");
  });
  test("state machine: Exit with an idle CPU is refused; I/O done goes to ready", () => {
    const t = P.stateMachineTable();
    expect(t.exit().ok).toBe(false);
    t.schedule();
    t.schedule();
    expect(t.running).toBe(101);
    t.block();
    expect(t.running).toBeNull();
    t.ioDone(101);
    expect(t.get(101)!.state).toBe("ready");
  });
});

describe("kernel-mode-and-user-mode", () => {
  test("11 of 17 x86-64 instructions fault in ring 3 and run in ring 0", () => {
    expect(P.instructionsFor("x86")).toHaveLength(17);
    expect(P.faultsOnlyInUser("x86")).toHaveLength(11);
    has("kernel-mode-and-user-mode", "Of the 17 x86-64 instructions here, 11 fault");
  });
  test("address split: 128 TiB and 64 PiB", () => {
    expect(P.userHalfBytes(P.USER_BITS_4LEVEL)).toBe(128 * 2 ** 40);
    expect(P.userHalfBytes(P.USER_BITS_5LEVEL)).toBe(64 * 2 ** 50);
    has("kernel-mode-and-user-mode", "128 TiB", "64 PiB");
  });
  test("timeline: the start state and the Hz selections", () => {
    const ev: P.EntryKind[] = ["getpid", "fault", "read", "disk", "getpid"];
    const a = P.timeline(ev, 250, 700);
    expect([a.entries, a.ticks, a.nestedTicks]).toEqual([5, 1, 1]);
    expect(roundTo((a.kernelUs / (a.kernelUs + a.userUs)) * 100, 1)).toBe(32.4);
    const b = P.timeline(ev, 1000, 700);
    expect([b.entries, b.ticks, b.nestedTicks]).toEqual([9, 6, 2]);
    expect(P.timeline(ev, 100, 700).ticks).toBe(0);
    has("kernel-mode-and-user-mode", "It has 5 events at 250 Hz", "32.4%", "6 ticks hit", "2 of them", "Entries go to 9, not to 11");
  });
});

describe("system-calls", () => {
  test("stepper: 15 steps with KPTI, 13 without", () => {
    expect(P.writeSteps("ok", true)).toHaveLength(15);
    expect(P.writeSteps("ok", false)).toHaveLength(13);
    has("system-calls", "it takes 15 steps", "The run has 13 steps");
  });
  test("errors: -9, errno 9, -14", () => {
    expect(P.writeSteps("badfd").at(-1)!.ret).toBe(-9);
    expect(P.libcView(-9)).toEqual({ ret: -1, errno: 9 });
    expect(P.writeSteps("kernelptr").at(-1)!.ret).toBe(-14);
    expect(P.MAX_ERRNO).toBe(4095);
    has("system-calls", "returns -9", "errno 9", "`rax` is -14", "-4095 to -1");
  });
  test("real syscall numbers", () => {
    expect(P.SYSCALL_NR.x86.write).toBe(1);
    expect(P.SYSCALL_NR.arm.write).toBe(64);
    expect(P.SYSCALL_NR.x86.exit_group).toBe(231);
    expect(P.SYSCALL_NR.arm.exit_group).toBe(94);
    has("system-calls", "`write` is 1 on x86-64 and 64 on arm64", "`exit_group` is 231 and 94");
  });
  test("cost model: 60, 20, 200, 400 ns; 30% of one CPU", () => {
    expect(P.syscallNs(P.NO_MITIGATIONS)).toBe(60);
    expect(P.vdsoNs()).toBe(20);
    expect(P.syscallNs(P.NO_MITIGATIONS) / P.vdsoNs()).toBe(3);
    expect(P.syscallNs(P.ALL_MITIGATIONS)).toBe(200);
    expect(P.syscallNs(P.ALL_MITIGATIONS) / P.vdsoNs()).toBe(10);
    expect(P.syscallNs({ ...P.ALL_MITIGATIONS, pcid: false })).toBe(400);
    expect(P.cpuShare(1e6, P.ALL_MITIGATIONS, 100)).toBeCloseTo(0.3, 9);
    expect(P.vdsoRate(100)).toBe(1e9 / 120);
    has("system-calls", "60 ns", "20 ns: a factor of 3", "200 ns: a factor of 10", "400 ns", "30% of one CPU");
  });
});

describe("fork-and-exec", () => {
  test("pipeline: fork returns 101 and 0, one copy-on-write fault, peak 9 frames, 2 2 12, 17 steps when it hangs", () => {
    const s = P.pipeline({ closeInParent: true, cloexec: true });
    const f = s.find((x) => x.code.startsWith("fork()"))!;
    expect(f.snap.tasks.find((t) => t.pid === 100)!.ret).toBe("101");
    expect(f.snap.tasks.find((t) => t.pid === 101)!.ret).toBe("0");
    expect(f.snap.frames.every((x) => x.refs === 2)).toBe(true);
    expect(f.snap.frames).toHaveLength(3);
    expect(s.find((x) => x.code.includes("writes its stack"))!.snap.cowFaults).toBe(1);
    expect(Math.max(...s.map((x) => x.snap.frames.length))).toBe(9);
    expect(s.at(-1)!.snap.tty).toBe("2 2 12\n");
    expect(P.wcCounts(P.LS_OUTPUT)).toEqual({ lines: 2, words: 2, bytes: 12 });
    expect(P.pipeline({ closeInParent: false, cloexec: true })).toHaveLength(17);
    has("fork-and-exec", "101 in the shell and 0 in the child", "All 3 pages", "1 copy-on-write fault", "`2 2 12`", "2 lines, 2 words and 12 bytes", "9 physical frames", "The run has 17 steps");
  });
  test("page tables: 262,144 entries in 512 pages per GiB; about 128 MiB at 64 GiB; about 0.2%", () => {
    const g1 = P.pageTables(P.GIB, P.PAGE_4K);
    expect(g1.entries).toBe(262144);
    expect(g1.leafPages).toBe(512);
    const g64 = P.pageTables(64 * P.GIB, P.PAGE_4K);
    expect(Math.round(g64.bytes / 2 ** 20)).toBe(128);
    expect(roundTo((P.PTE_BYTES / P.PAGE_4K) * 100, 1)).toBe(0.2);
    has("fork-and-exec", "262,144 entries in 512 page table pages", "about 128 MiB", "about 0.2% of memory", "8-byte entry");
  });
  test("model times: 10.7 ms, 681 ms, 6.6 ms, 190 µs, 2.5 s, and about 1,000 times", () => {
    expect(roundTo(P.forkUs(P.GIB) / 1000, 1)).toBe(10.7);
    expect(Math.round(P.forkUs(64 * P.GIB) / 1000)).toBe(681);
    expect(roundTo(P.forkUs(64 * P.GIB, true) / 1000, 1)).toBe(6.6);
    expect(P.spawnUs(P.GIB)).toBe(190);
    expect(P.spawnUs(64 * P.GIB)).toBe(190);
    expect(roundTo(P.cowUs(64 * P.GIB, 0.1) / 1e6, 1)).toBe(2.5);
    const ratio = P.forkUs(64 * P.GIB) / P.forkUs(64 * 2 ** 20);
    expect(ratio).toBeGreaterThan(900);
    expect(ratio).toBeLessThan(1100);
    has("fork-and-exec", "10.7 ms", "681 ms", "6.6 ms", "190 µs", "2.5 s", "About 1,000 times longer");
  });
});

describe("loading-a-program-elf-and-the-dynamic-linker", () => {
  const e = P.buildElf();
  const L = "loading-a-program-elf-and-the-dynamic-linker";
  test("the file: 1,976 bytes, 7 program headers, 14 sections, header sizes", () => {
    expect(e.bytes.length).toBe(1976);
    expect(e.phdrs).toHaveLength(7);
    expect(e.phdrs.filter((p) => p.type === P.PT.LOAD)).toHaveLength(3);
    expect(e.sections).toHaveLength(14);
    expect([P.EHDR_SIZE, P.PHDR_SIZE, P.SHDR_SIZE]).toEqual([64, 56, 64]);
    expect([...e.bytes.slice(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    has(L, "1,976 bytes", "is 64 bytes at offset 0", "56 bytes each", "This file has 7", "64 bytes each, 14 here", "`PT_LOAD` (3 times)", "`7f 45 4c 46`");
  });
  test("second PT_LOAD: offset 0x2a0, vaddr 0x12a0; .bss is 0x2000 bytes", () => {
    const rx = e.phdrs.filter((p) => p.type === P.PT.LOAD)[1]!;
    expect(rx.offset).toBe(0x2a0);
    expect(rx.vaddr).toBe(0x12a0);
    expect(e.fieldAt(0x18)!.name).toBe("e_entry");
    expect(e.fieldAt(0x20)!.name).toBe("e_phoff");
    expect(P.BSS_SIZE).toBe(0x2000);
    has(L, "`0x2a0` and `0x12a0`", "by `0x2000` bytes", "offset `0x18`", "at `0x20`");
  });
  test("ASLR: base 0x555555554000, 28 bits, 268,435,456 positions, 1 TiB", () => {
    expect(P.PIE_BASE).toBe(0x555555554000);
    expect(P.aslrPositions()).toBe(268435456);
    expect(P.aslrSpanBytes()).toBe(2 ** 40);
    has(L, "`0x555555554000`", "is 28", "268,435,456", "1 TiB");
  });
  test("the PLT: 7 instructions, then 2; 2 with binding at load", () => {
    const lazy = P.runPlt(false);
    expect(P.stepsToPuts(lazy)).toEqual([7, 2]);
    expect(P.stepsToPuts(P.runPlt(true))).toEqual([2, 2]);
    has(L, "That is 7 instructions", "It takes 2 instructions", "both calls take 2 instructions");
  });
  test("rsp is aligned for all argument counts", () => {
    for (let a = 1; a <= 4; a++) for (let v = 0; v <= 3; v++) {
      const { rsp } = P.initialStack(["a", "bb", "ccc", "dddd"].slice(0, a), ["X=1", "YY=2", "ZZZ=3"].slice(0, v), e);
      expect(rsp % 16 === 0).toBe(true);
    }
  });
});

describe("threads", () => {
  test("pthread flags 0x3d0f00", () => {
    expect(P.PTHREAD_FLAGS).toBe(0x3d0f00);
    has("threads", "`0x3d0f00`");
  });
  test("stack defaults", () => {
    expect(P.STACK.glibcDefaultBytes).toBe(8 * 2 ** 20);
    expect(P.STACK.rustDefaultBytes).toBe(2 * 2 ** 20);
    expect(P.STACK.macSecondaryBytes).toBe(512 * 1024);
    expect(P.STACK.kernelStackBytes).toBe(16 * 1024);
    expect(P.STACK.goMinBytes).toBe(2048);
    expect(P.STACK.goMaxBytes).toBe(2 ** 30);
    has("threads", "8 MiB", "2 MiB", "512 KiB", "16 KiB", "2 KiB", "1 GiB");
  });
  test("a million: 7.6 TiB, 30.5 GiB, 2.4 GiB, 488 MiB", () => {
    const t = P.threadMemory(1e6), g = P.goroutineMemory(1e6), a = P.asyncMemory(1e6);
    expect(roundTo(t.virtualBytes / 2 ** 40, 1)).toBe(7.6);
    expect(roundTo(t.residentBytes / 2 ** 30, 1)).toBe(30.5);
    expect(roundTo(g.residentBytes / 2 ** 30, 1)).toBe(2.4);
    expect(Math.round(a.residentBytes / 2 ** 20)).toBe(488);
    has("threads", "about 7.6 TiB", "about 30.5 GiB", "about 2.4 GiB", "about 488 MiB");
  });
  test("map limit: 65,530 gives about 32,765 threads", () => {
    expect(P.STACK.maxMapCount).toBe(65530);
    expect(P.threadsAtMapLimit()).toBe(32765);
    has("threads", "65,530", "32,765");
  });
  test("creation: 60, 15, 0.3 µs; 4 and 50 times", () => {
    expect([P.TASK_INPUTS.forkUs, P.TASK_INPUTS.threadUs, P.TASK_INPUTS.goroutineUs]).toEqual([60, 15, 0.3]);
    expect(P.TASK_INPUTS.forkUs / P.TASK_INPUTS.threadUs).toBe(4);
    expect(roundTo(P.TASK_INPUTS.threadUs / P.TASK_INPUTS.goroutineUs, 6)).toBe(50);
    has("threads", "60 µs", "15 µs", "0.3 µs", "4 times less", "50 times less");
  });
  test("GMP demo: hand-off at 1 P ends at tick 13 with 2 threads; stealing 32, 16, 8", () => {
    const h = P.runToEnd(P.scenario("handoff", 1));
    expect(h.tick).toBe(13);
    expect(h.stats.mCreated).toBe(2);
    expect(h.stats.handoffs).toBe(1);
    expect(h.events.some((e) => e.text.includes("goes on the global queue"))).toBe(true);
    expect([1, 2, 4].map((n) => P.runToEnd(P.scenario("steal", n)).tick)).toEqual([32, 16, 8]);
    expect(P.LOCAL_QUEUE_CAP).toBe(256);
    expect(P.GLOBAL_CHECK_EVERY).toBe(61);
    expect(P.MAX_THREADS).toBe(10000);
    has("threads", "tick 13, with 2 OS threads and 1 hand-off", "32, 16 and then 8 ticks", "256 entries", "61st", "10,000");
  });
});

describe("context-switching", () => {
  const base = { workingSetBytes: 2 ** 20, switchesPerSec: 1000, evictedShare: 0.5, sameMm: false, pcid: true };
  const c = (x: Partial<typeof base> = {}) => P.switchCost({ ...base, ...x });
  test("the start state: 2 µs direct, about 205 µs refill, 21.1% lost, 0.2% direct only, about 1% share", () => {
    expect(c().directNs).toBe(2000);
    expect(Math.round(c().cacheNs / 1000)).toBe(205);
    expect(roundTo(c().cpuLost * 100, 1)).toBe(21.1);
    expect(roundTo((c().directNs * 1000) / 1e9 * 100, 1)).toBe(0.2);
    expect(Math.round(c().directShare * 100)).toBe(1);
    expect(Math.round(c().cacheNs / c().directNs)).toBe(102);
    expect(2 ** 20 / P.SWITCH_INPUTS.lineBytes).toBe(16384);
    has("context-switching", "direct cost of 2 µs", "about 205 µs", "21.1%", "0.2%", "about 1%", "16,384", "About 21%", "about 100 times", "25 ns");
  });
  test("sweeps: 0.85%, 43.5%, 83.7%, 20.6%", () => {
    expect(roundTo(c({ workingSetBytes: 32 * 1024 }).cpuLost * 100, 2)).toBe(0.85);
    expect(roundTo(c({ workingSetBytes: 16 * 2 ** 20 }).cpuLost * 100, 1)).toBe(43.5);
    expect(roundTo(c({ switchesPerSec: 10000 }).cpuLost * 100, 1)).toBe(83.7);
    expect(roundTo(c({ sameMm: true }).cpuLost * 100, 1)).toBe(20.6);
    expect(P.SWITCH_INPUTS.tlbEntries).toBe(1536);
    has("context-switching", "0.85%", "43.5%", "83.7%", "20.6%", "1,536 entries", "100 µs per slice");
  });
  test("__switch_to_asm saves 6 registers; kernel stack 16 KiB", () => {
    expect(P.CALLEE_SAVED).toHaveLength(6);
    expect(P.STACK.kernelStackBytes).toBe(16 * 1024);
    has("context-switching", "same 6 registers", "only six registers", "16 KiB");
  });
  test("XSAVE sizes", () => {
    expect(P.XSAVE_BYTES).toEqual({ sse: 576, avx: 832, avx512: 2688, amxTileData: 8192 });
    has("context-switching", "576 bytes", "832 bytes", "2,688 bytes", "8,192 bytes");
  });
});
