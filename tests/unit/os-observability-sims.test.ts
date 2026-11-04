/** ptrace, breakpoints, patching, ring buffers, sampling, and each number that the Observability lessons quote. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import * as O from "@/sims/os/observability";

const text = (lesson: string) => readFileSync(new URL(`../../src/content/lessons/os/observability/${lesson}.mdx`, import.meta.url), "utf8");
const has = (lesson: string, ...needles: string[]) => { const t = text(lesson); for (const n of needles) expect(t, n).toContain(n); };
const fix = (x: number, d: number) => x.toFixed(d);

const PT = "ptrace-and-strace", FT = "tracepoints-and-ftrace", BP = "ebpf";
const lastCounters = (s: O.StraceStep[]) => s[s.length - 1]!.counters;
const GETPID: O.TraceeOp = { kind: "sys", name: "getpid", nr: 39, args: [], ret: 1, rip: 1 };

describe("the ptrace state machine", () => {
  test("real request numbers", () => {
    expect(O.PTRACE).toMatchObject({ TRACEME: 0, PEEKTEXT: 1, PEEKDATA: 2, POKETEXT: 4, CONT: 7, SINGLESTEP: 9, GETREGS: 12, SETREGS: 13, ATTACH: 16, DETACH: 17, SYSCALL: 24, SETOPTIONS: 0x4200, SEIZE: 0x4206, GET_SYSCALL_INFO: 0x420e });
    expect(O.PTRACE_O.TRACESYSGOOD).toBe(1);
    expect(O.PTRACE_O.TRACESECCOMP).toBe(128);
  });
  test("a request on a running tracee fails with ESRCH", () => {
    const m = new O.PtraceMachine(O.DEMO_PROGRAM);
    expect(m.getRegs()).toBe(-O.ERR.ESRCH); // No tracer yet.
    expect(m.attach(1)).toBe(0);
    expect(m.getRegs()).toBe(-O.ERR.ESRCH); // The stop has not been waited for.
    m.waitpid();
    expect(typeof m.getRegs()).toBe("object");
    expect(m.ptraceSyscall()).toBe(0);
    m.waitpid();
    expect(m.state).toBe("stopped");
    expect(m.stop).toBe("syscall-enter");
  });
  test("a second tracer fails with EPERM", () => {
    const m = new O.PtraceMachine(O.DEMO_PROGRAM);
    m.attach(1);
    expect(m.attach(2)).toBe(-O.ERR.EPERM);
  });
  test("a bad address fails with EIO, and detach frees the tracee", () => {
    const m = new O.PtraceMachine(O.DEMO_PROGRAM);
    m.attach(1);
    m.waitpid();
    expect(m.peekData(0xdead)).toBe(-O.ERR.EIO);
    expect(m.detach()).toBe(0);
    expect(m.tracer).toBeNull();
  });
  test("at the entry stop, orig_rax holds the number and rax holds -ENOSYS (-38)", () => {
    const m = new O.PtraceMachine(O.DEMO_PROGRAM);
    m.attach(1);
    m.waitpid();
    m.ptraceSyscall();
    m.waitpid();
    const r = m.getRegs() as O.UserRegs;
    expect(r.orig_rax).toBe(39);
    expect(r.rax).toBe(-38);
    m.ptraceSyscall();
    m.waitpid();
    expect((m.getRegs() as O.UserRegs).rax).toBe(4242);
  });
  test("TRACESYSGOOD sets bit 7 of the stop signal", () => {
    const m = new O.PtraceMachine(O.DEMO_PROGRAM);
    m.attach(1);
    m.waitpid();
    m.setOptions(O.PTRACE_O.TRACESYSGOOD);
    m.ptraceSyscall();
    const st = m.waitpid()!;
    expect((st.status >> 8) & 0xff).toBe(O.SIG.TRAP | 0x80);
  });
  test("for random programs: 2 stops and 4 switches for each call, except the one that does not return", () => {
    const r = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(r() * 12);
      const prog: O.TraceeOp[] = [];
      for (let k = 0; k < n; k++) {
        if (r() < 0.5) prog.push({ kind: "user", label: "work" });
        prog.push(GETPID);
      }
      const c = lastCounters(O.straceSteps(prog, { mode: "all" }));
      expect(c.traceeSyscalls).toBe(n);
      expect(c.stops).toBe(1 + 2 * n);
      expect(c.regReads).toBe(2 * n);
      // One switch to the tracer at the attach wait and at the exit wait, and 4 for each call, plus the first resume.
      expect(c.switches).toBe(3 + 4 * n);
    }
  });
  test("the cost of one more call: 2 stops, 4 switches, 7 tracer calls with a print", () => {
    const one = lastCounters(O.straceSteps([GETPID], { mode: "all" }));
    const two = lastCounters(O.straceSteps([GETPID, GETPID], { mode: "all" }));
    expect(two.stops - one.stops).toBe(O.STOPS_PER_CALL);
    expect(two.switches - one.switches).toBe(O.STOPS_PER_CALL * O.SWITCHES_PER_STOP);
    // waitpid, PTRACE_SYSCALL and PTRACE_GETREGS at each stop, and one write.
    expect(two.tracerSyscalls - one.tracerSyscalls).toBe(O.STOPS_PER_CALL * O.TRACER_CALLS_PER_STOP + 1);
  });
  test("a seccomp filter removes all stops of other calls", () => {
    const r = mulberry32(4);
    for (let i = 0; i < 100; i++) {
      const prog: O.TraceeOp[] = [];
      let w = 0;
      const n = 1 + Math.floor(r() * 20);
      for (let k = 0; k < n; k++) {
        if (r() < 0.2) {
          w++;
          prog.push({ kind: "sys", name: "write", nr: 1, args: [1, 0, 0], ret: 0, rip: 2 });
        } else prog.push(GETPID);
      }
      const c = lastCounters(O.straceSteps(prog, { mode: "seccomp", traced: ["write"] }));
      expect(c.stops).toBe(1 + 2 * w);
    }
  });
  test("strace -e changes the output, and not the stops", () => {
    const all = O.straceSteps(O.DEMO_PROGRAM, { mode: "all" });
    const only = O.straceSteps(O.DEMO_PROGRAM, { mode: "all", traced: ["write"] });
    expect(lastCounters(all).stops).toBe(lastCounters(only).stops);
    expect(all[all.length - 1]!.output).toEqual(['getpid() = 4242', 'write(1, "hello, ptrace\\n", 14) = 14', "exit_group(0) = ?", "+++ exited with 0 +++"]);
    expect(only[only.length - 1]!.output).toEqual(['write(1, "hello, ptrace\\n", 14) = 14', "+++ exited with 0 +++"]);
  });
  test("the string takes 2 peeks of 8 bytes, and the bytes are the real text", () => {
    const words = O.straceSteps(O.DEMO_PROGRAM, { mode: "all" }).flatMap((s) => (s.word ? [s.word] : []));
    expect(words).toHaveLength(2);
    expect(String.fromCharCode(...words[0]!.bytes)).toBe("hello, p");
    expect(String.fromCharCode(...words[1]!.bytes.slice(0, 6))).toBe("trace\n");
  });
});

describe("ptrace lesson numbers", () => {
  test("the plain run: 22 steps, 6 stops", () => {
    const s = O.straceSteps(O.DEMO_PROGRAM, { mode: "all" });
    expect(s).toHaveLength(22);
    expect(lastCounters(s).stops).toBe(6);
    expect(lastCounters(s).switches).toBe(13);
    has(PT, "It has 22 steps and 6 stops", "against 6 and 13");
  });
  test("--seccomp-bpf with -e trace=write: 3 stops, 7 switches", () => {
    const c = lastCounters(O.straceSteps(O.DEMO_PROGRAM, { mode: "seccomp", traced: ["write"] }));
    expect([c.stops, c.switches]).toEqual([3, 7]);
    has(PT, "The run has 3 stops and 7 switches");
  });
  test("a stop costs 4.51 µs in the model", () => {
    expect(O.TRACE_INPUTS.syscallNs).toBe(170);
    expect(O.TRACE_INPUTS.switchNs).toBe(2000);
    expect(O.stopNs()).toBe(4510);
    has(PT, "4.51 µs", "2 switches of 2 µs", "3 tracer calls of 170 ns");
  });
  test("slowdowns", () => {
    expect(fix(O.slowdown("strace", 200, 0), 1)).toBe("25.4");
    expect(fix(O.slowdown("strace", 200, 0.01), 1)).toBe("25.4");
    expect(fix(O.slowdown("seccomp", 200, 0.01), 2)).toBe("1.38");
    expect(fix(O.slowdown("ebpf", 200, 0.01), 2)).toBe("1.33");
    expect(fix(O.slowdown("strace", 100000, 0.01), 2)).toBe("1.09");
    expect(fix(O.slowdown("seccomp", 200, 1), 1)).toBe("31.3");
    expect(fix(O.slowdown("strace", 200, 1), 1)).toBe("31.2");
    expect(fix(O.slowdown("ebpf", 200, 1), 2)).toBe("1.54");
    has(PT, "25.4×", "1.38×", "1.33×", "1.09×", "31.3×", "31.2", "1.54×", "25.4 times");
  });
  test("real hardware facts in the text", () => {
    expect(O.INT3).toBe(0xcc);
    expect(O.TF_BIT).toBe(1 << 8);
    has(PT, "vector 3", "vector 1", "bit 8 of `RFLAGS`", "bit 7 of the signal", "`DR0` to `DR3`", "watch 4 addresses");
  });
});

describe("the x86 machine and the debugger", () => {
  test("the bytes decode to the expected text, as objdump prints them", () => {
    expect(O.instructionList().map((d) => d.text)).toEqual([
      "mov edi, 41", "call 0x40101a", "mov edi, eax", "call 0x40101a", "mov edi, eax", "mov eax, 60", "syscall",
      "push rbp", "mov rbp, rsp", "mov [rbp-4], edi", "mov eax, [rbp-4]", "add eax, 1", "pop rbp", "ret",
    ]);
    expect(O.FN_ADDR).toBe(0x40101a);
  });
  test("with no debugger the program exits with 43", () => {
    const c = new O.X86Cpu();
    expect(c.run()).toBe("EXIT");
    expect(c.exitStatus).toBe(O.PROGRAM_EXIT);
    expect(O.PROGRAM_EXIT).toBe(43);
  });
  const addrs = O.instructionList().map((d) => d.addr);
  test("any set of breakpoints gives the same result, and removal restores the original bytes", () => {
    const r = mulberry32(5);
    for (let i = 0; i < 400; i++) {
      const cpu = new O.X86Cpu();
      const d = new O.Debugger(cpu);
      const chosen = addrs.filter(() => r() < 0.3);
      for (const a of chosen) d.setBreakpoint(a);
      for (const a of chosen) expect(cpu.readText(a)).toBe(O.INT3);
      expect(d.shadowedBytes()).toEqual([...O.PROGRAM_BYTES]); // The user sees the original bytes.
      const removeEarly = r() < 0.3;
      if (removeEarly) {
        for (const a of chosen) d.removeBreakpoint(a);
        expect([...cpu.text]).toEqual([...O.PROGRAM_BYTES]);
      }
      expect(d.runToEnd()).toBe("EXIT");
      expect(cpu.exitStatus).toBe(43);
      if (!removeEarly) {
        for (const a of chosen) d.removeBreakpoint(a);
        expect([...cpu.text]).toEqual([...O.PROGRAM_BYTES]);
      }
    }
  });
  test("a breakpoint in f hits twice, and one in the main code hits once", () => {
    for (const a of addrs) {
      const d = new O.Debugger(new O.X86Cpu());
      d.setBreakpoint(a);
      d.runToEnd();
      expect(d.hits.length).toBe(a >= O.FN_ADDR ? 2 : 1);
    }
  });
  test("the saved RIP after int3 is one past the patched byte", () => {
    const c = new O.X86Cpu();
    const d = new O.Debugger(c);
    d.setBreakpoint(O.FN_ADDR);
    expect(c.run()).toBe("BP");
    expect(c.regs.rip).toBe(O.FN_ADDR + 1);
  });
  test("the trap flag gives one instruction and #DB", () => {
    const c = new O.X86Cpu();
    c.regs.rflags |= O.TF_BIT;
    expect(c.step()).toBe("DB");
    expect(c.regs.rip).toBe(O.TEXT_BASE + 5);
  });
  test("the stepper: 16 steps, 2 hits, exit 43; each stepper ends with the same text bytes as a clean debugger", () => {
    const s = O.breakpointSteps(O.FN_ADDR + 1);
    expect(s).toHaveLength(16);
    const last = s[s.length - 1]!;
    expect(last.end).toBe("exit");
    expect(last.hits).toBe(2);
    has(PT, "The session has 16 steps and 2 hits", "exits with status 43");
    for (const a of addrs) expect(O.breakpointSteps(a).at(-1)!.end).toBe("exit");
  });
  test("mistakes: the second byte of 48 89 e5 is mov ebp, esp, which crashes at 0x1fac", () => {
    const s = O.breakpointSteps(O.FN_ADDR + 1, "no-rewind");
    expect(s.at(-1)!.end).toBe("segv");
    expect(s.some((x) => x.next === "mov ebp, esp")).toBe(true);
    expect(s.at(-1)!.text).toContain("0x1fac");
    has(PT, "`48 89 e5`", "`89 e5`", "`mov ebp, esp`", "`0x1fac`");
  });
  test("forgetting to restore never makes progress, and forgetting to re-insert misses the second call", () => {
    expect(O.breakpointSteps(O.FN_ADDR + 1, "no-restore").at(-1)!.end).toBe("stuck");
    const miss = O.breakpointSteps(O.FN_ADDR + 1, "no-reinsert").at(-1)!;
    expect(miss.end).toBe("missed");
    expect(miss.hits).toBe(1);
    // A code address that runs once has nothing to miss.
    expect(O.breakpointSteps(O.TEXT_BASE, "no-reinsert").at(-1)!.end).toBe("exit");
  });
});

describe("live patching", () => {
  test("the bytes", () => {
    expect(O.NOP5).toEqual([0x0f, 0x1f, 0x44, 0x00, 0x00]);
    const rel = O.encodeRel32(0x1000n, 0x2000n);
    expect(rel).toEqual([0xe8, 0xfb, 0x0f, 0x00, 0x00]);
    expect(O.CALL_BYTES[0]).toBe(0xe8);
    has(FT, "`0f 1f 44 00 00`");
  });
  test("text_poke_bp: at each step a CPU sees the old instruction, a trap, or the new one", () => {
    for (const [a, b] of [[O.NOP5, O.CALL_BYTES], [O.CALL_BYTES, O.NOP5]] as const) {
      const steps = O.textPokeBp(a, b);
      expect(steps.map((s) => s.view)).toEqual(["old", "int3", "int3", "new"]);
      expect(steps.filter((s) => s.sync)).toHaveLength(3);
      for (const s of steps) expect(s.view).not.toBe("torn");
      expect(steps[steps.length - 1]!.bytes).toEqual([...b]);
    }
  });
  test("random bytes: the order is safe for any pair of instructions", () => {
    const r = mulberry32(8);
    for (let i = 0; i < 500; i++) {
      const a = Array.from({ length: 5 }, () => Math.floor(r() * 256));
      const b = Array.from({ length: 5 }, () => Math.floor(r() * 256));
      if (a[0] === O.INT3_BYTE || b[0] === O.INT3_BYTE) continue;
      for (const s of O.textPokeBp(a, b)) expect(s.view).not.toBe("torn");
    }
  });
  test("a byte-by-byte write shows 3 states from neither version", () => {
    const v = O.naivePatch(O.NOP5, O.CALL_BYTES).map((s) => s.view);
    expect(v.filter((x) => x === "torn")).toHaveLength(3);
    has(FT, "three of the states are bytes from neither version");
  });
  test("costs in the model", () => {
    expect(O.costPerCallNs("off")).toBe(0.25);
    expect(O.costPerCallNs("function")).toBe(102);
    expect(O.costPerCallNs("function_graph")).toBe(232);
    expect(O.FTRACE_INPUTS.callsPerSecond).toBe(5e6);
    expect(O.cpuShareAt("off", 5e6)).toBeCloseTo(0.00125, 8);
    expect(O.cpuShareAt("function", 5e6)).toBeCloseTo(0.51, 8);
    expect((O.costPerCallNs("function_graph") * 5e6) / 1e9).toBeGreaterThan(1);
    expect([O.FTRACE_INPUTS.tracepointNs, O.FTRACE_INPUTS.kprobeNs, O.FTRACE_INPUTS.uprobeNs]).toEqual([110, 350, 1500]);
    has(FT, "0.25 ns", "102 ns", "232 ns", "0.125% against 51%", "| 110 ns | 350 ns | 1500 ns |", "5 million calls per second");
  });
  test("a filter leaves the other sites as nops", () => {
    expect(O.filteredCostNs("function", 0)).toBe(O.costPerCallNs("off"));
    expect(O.filteredCostNs("function", 1)).toBe(O.costPerCallNs("function"));
  });
});

describe("the ring buffer", () => {
  const SMALL = 16 + 32 * 4;
  test("never reports more than was written, and counts each lost event", () => {
    const r = mulberry32(21);
    for (let round = 0; round < 300; round++) {
      const mode: O.RingMode = r() < 0.5 ? "overwrite" : "discard";
      const ring = new O.RingBuffer(0, 2 + Math.floor(r() * 5), SMALL, mode);
      const seen = new Set<number>();
      let last = -1, reported = 0;
      const n = 300;
      for (let i = 0; i < n; i++) {
        if (r() < 0.6) ring.write(16 + Math.floor(r() * 3) * 8);
        else {
          const e = ring.readEvent();
          if (e) {
            expect(e.event.id).toBeGreaterThan(last); // In order, with gaps only for lost events.
            expect(seen.has(e.event.id)).toBe(false);
            seen.add(e.event.id);
            last = e.event.id;
            reported += e.lostBefore;
          }
        }
        const s = ring.stats();
        expect(s.read + s.overwritten + s.dropped + s.held).toBe(s.written);
        expect(s.read).toBeLessThanOrEqual(s.written);
      }
      while (true) {
        const e = ring.readEvent();
        if (!e) break;
        expect(e.event.id).toBeGreaterThan(last);
        last = e.event.id;
        seen.add(e.event.id);
        reported += e.lostBefore;
      }
      const s = ring.stats();
      expect(seen.size).toBe(s.read);
      expect(s.held).toBe(0);
      expect(s.read + s.overwritten + s.dropped).toBe(s.written);
      // Each lost event was reported, or it waits for the next read.
      expect(reported + ring.lostSinceRead).toBe(s.overwritten + s.dropped);
    }
  });
  test("overwrite loses whole pages, the oldest first; discard keeps the old ones", () => {
    const o = new O.RingBuffer(0, 4, SMALL, "overwrite");
    for (let i = 0; i < 17; i++) o.write(32);
    expect(o.overwritten).toBe(4);
    expect(o.head).toBe(1);
    expect(o.drain()[0]!.id).toBe(4);
    const d = new O.RingBuffer(0, 4, SMALL, "discard");
    for (let i = 0; i < 17; i++) d.write(32);
    expect(d.dropped).toBe(1);
    expect(d.overwritten).toBe(0);
    const got = d.drain();
    expect(got[0]!.id).toBe(0);
    expect(got).toHaveLength(16);
  });
  test("a CPU buffer does not touch another", () => {
    const tb = new O.TraceBuffers(2, 4, SMALL);
    for (let i = 0; i < 100; i++) tb.rings[0]!.write(32);
    expect(tb.rings[1]!.written).toBe(0);
    expect(tb.rings[1]!.overwritten).toBe(0);
    expect(tb.total().written).toBe(100);
  });
  test("the reader swaps: the writer can keep going while the reader holds a page", () => {
    const r = new O.RingBuffer(0, 2, SMALL);
    for (let i = 0; i < 4; i++) r.write(32);
    expect(r.readEvent()!.event.id).toBe(0);
    // The reader owns the old page now, so writes cannot erase it.
    for (let i = 0; i < 40; i++) r.write(32);
    expect(r.readEvent()!.event.id).toBe(1);
    expect(r.readEvent()!.event.id).toBe(2);
    expect(r.readEvent()!.event.id).toBe(3);
  });
  test("lesson numbers: 1408 KiB holds 44,704 events of 32 bytes, 127 in each page", () => {
    expect(O.DEFAULT_BUFFER_KIB).toBe(1408);
    expect(O.DEFAULT_BUFFER_KIB * 1024).toBe(1441792);
    expect(Math.floor((O.PAGE_BYTES - O.PAGE_HEADER_BYTES) / 32)).toBe(127);
    expect(O.capacityEvents(1408, 32)).toBe(44704);
    const i = { eventRate: 1e6, eventBytes: 32, bufferKiB: 1408, readRate: 3e5, seconds: 1 };
    const m = O.lossModel(i);
    expect(fix(m.secondsToFill * 1000, 1)).toBe("63.9");
    expect(fix(m.share * 100, 1)).toBe("65.5");
    const big = O.lossModel({ ...i, bufferKiB: 1408 * 16 });
    expect(big.capacity).toBe(715264);
    expect(big.lost).toBe(0);
    has(FT, "44,704 events of 32 bytes", "63.9 ms", "65.5%", "715,264", "1408 KiB", "300,000 per second");
  });
  test("the loss formula agrees with a run of the real ring, within a few pages", () => {
    const pageEvents = 127;
    for (const i of [
      { eventRate: 1e6, eventBytes: 32, bufferKiB: 1408, readRate: 3e5, seconds: 1 },
      { eventRate: 5e5, eventBytes: 32, bufferKiB: 512, readRate: 1e5, seconds: 0.5 },
      { eventRate: 2e5, eventBytes: 32, bufferKiB: 1408, readRate: 1e5, seconds: 1 },
    ]) {
      const run = O.runBurst(i);
      const model = O.lossModel(i);
      expect(Math.abs(run.overwritten - model.lost)).toBeLessThanOrEqual(4 * pageEvents);
      expect(run.written).toBe(model.written);
      expect(run.read + run.overwritten + run.held).toBe(run.written);
    }
    // A buffer that holds the burst loses nothing.
    expect(O.runBurst({ eventRate: 1e5, eventBytes: 32, bufferKiB: 1408 * 16, readRate: 1e4, seconds: 1 }).overwritten).toBe(0);
  });
});

describe("the sampler", () => {
  test("formulas: 19.8% for 2 ms, 1.98% for 200 µs, 88.7% to miss all 6", () => {
    expect(O.PROFILER_HZ).toBe(99);
    expect(fix(O.pSeen(2) * 100, 1)).toBe("19.8");
    expect(fix(O.pSeen(0.2) * 100, 2)).toBe("1.98");
    expect(fix(O.pMissAll(0.2, 0.1, 60) * 100, 1)).toBe("88.7");
    expect(fix(1000 / 99, 1)).toBe("10.1");
    has(FT, "19.8%", "1.98%", "88.7%", "10.1 ms", "99 Hz");
  });
  test("the demo defaults: 69 events, 17 seen", () => {
    const r = O.simulateSampler({ eventMs: 2, eventRate: 1, seconds: 60, seed: 11 });
    expect([r.events, r.seen]).toEqual([69, 17]);
    expect(r.samples).toBe(5940);
    has(FT, "this run has 69 events and 17 of them get a sample");
    const rare = O.simulateSampler({ eventMs: 0.2, eventRate: 0.1, seconds: 60, seed: 11 });
    expect(rare.events).toBe(6);
    has(FT, "miss all 6");
  });
  test("the simulator agrees with the formula over many seeds", () => {
    let seen = 0, events = 0, hits = 0;
    for (let s = 1; s <= 60; s++) {
      const r = O.simulateSampler({ eventMs: 2, eventRate: 5, seconds: 60, seed: s }, 99, (s * 0.61803) % 1);
      seen += r.seen;
      events += r.events;
      hits += r.hits;
    }
    expect(Math.abs(seen / events - O.pSeen(2))).toBeLessThan(0.01);
    expect(Math.abs(hits - seen)).toBeLessThanOrEqual(1); // 2 ms is shorter than the gap, so one sample per event.
  });
  test("the sampler never reports a hit outside an event, and never more events than happened", () => {
    const r = mulberry32(31);
    for (let i = 0; i < 100; i++) {
      const w: O.Workload = { eventMs: 0.05 + r() * 30, eventRate: 0.1 + r() * 30, seconds: 10, seed: i + 1 };
      const res = O.simulateSampler(w, [49, 99, 997][i % 3]!, r());
      expect(res.seen).toBeLessThanOrEqual(res.events);
      expect(res.hits).toBeLessThanOrEqual(res.samples);
      for (const [a, b] of res.spans) expect(b - a).toBeCloseTo(w.eventMs / 1000, 9);
    }
  });
  test("lockstep at 100 Hz sees 0% or 100%; 99 Hz reports 9.6%", () => {
    expect(O.lockstepShare(100, 1, 100, 60, 0.37).estShare).toBe(0);
    expect(O.lockstepShare(100, 1, 100, 60, 0.05).estShare).toBe(1);
    const d = O.lockstepShare(100, 1, 99, 60, 0.37);
    expect(fix(d.trueShare * 100, 0)).toBe("10");
    expect(fix(d.estShare * 100, 1)).toBe("9.6");
    has(FT, "reports 0%", "reports 100%", "reports 9.6%", "The true share is 10%");
  });
  test("tool costs: 20% against about 0.05%", () => {
    expect(O.tracerCpuShare(1e6)).toBeCloseTo(0.2, 9);
    expect(fix(O.samplerCpuShare() * 100, 2)).toBe("0.05");
    expect(O.SAMPLE_INPUTS).toEqual({ sampleNs: 5000, traceEventNs: 200 });
    has(FT, "takes 20% of one CPU", "takes about 0.05%", "At 200 ns per event", "5 µs per sample");
  });
});

describe("the histogram", () => {
  test("in-kernel and shipped histograms are the same, for any latencies", () => {
    for (const seed of [1, 2, 3, 7, 99]) {
      const lat = O.latencySample(400, seed, seed % 2 ? 0.08 : 0.4);
      const run = O.runInKernel(lat);
      expect(run.hist).toEqual(O.aggregateInUser(lat));
      expect(run.hist.reduce((a, b) => a + b, 0)).toBe(400);
    }
  });
  test("lesson numbers: 3.2 MB per second against 512 bytes, a ratio of 6,250", () => {
    const i = { eventsPerSecond: 1e5, eventBytes: O.EVENT_BYTES_DEFAULT, readsPerSecond: 1 };
    expect(O.EVENT_BYTES_DEFAULT).toBe(32);
    expect(O.shipBytesPerSecond(i)).toBe(3.2e6);
    expect(O.HIST_BYTES).toBe(512);
    expect(O.bytesRatio(i)).toBe(6250);
    has(BP, "3.2 MB per second", "512 bytes", "6,250", "64 buckets of 8 bytes");
  });
  test("CPU: 2.3% against 0.6%, and 320 MB per second at 10 million", () => {
    expect(fix(O.shipCpuShare(1e5) * 100, 1)).toBe("2.3");
    expect(fix(O.mapCpuShare(1e5) * 100, 1)).toBe("0.6");
    expect(O.shipBytesPerSecond({ eventsPerSecond: 1e7, eventBytes: 32, readsPerSecond: 1 })).toBe(3.2e8);
    expect(O.shipCpuShare(1e7)).toBeGreaterThan(2);
    has(BP, "2.3% for shipping and 0.6% for the map", "320 MB per second", "more than two full CPUs");
  });
  test("about 36 instructions per event, for 400 events", () => {
    const run = O.runInKernel(O.latencySample(400, 7, 0.08));
    expect(fix(run.insnPerEvent, 0)).toBe("36");
    has(BP, "each of the 400 events", "about 36 instructions per event", "all 64 buckets match");
  });
  test("the map uses the bytes that the text says", () => {
    const run = O.runInKernel([1n]);
    expect(run.maps.bytesInKernel(0)).toBe(O.HIST_BYTES);
  });
});

describe("eBPF lesson numbers", () => {
  const asm = (id: string) => { const a = O.assemble(O.presetById(id).source); if (!a.ok) throw new Error(a.error); return a.prog; };
  test("the quoted walks and messages", () => {
    expect(O.verify(asm("mask")).processed).toBe(14);
    has(BP, "It processes 14 instructions");
    expect(O.verify(asm("offbyone")).error).toBe("invalid access to map value, value_size=64 off=64 size=1");
    has(BP, "`invalid access to map value, value_size=64 off=64 size=1`");
    const l = O.verify(asm("rangeloop"));
    expect([l.forks, l.pruned]).toEqual([7, 7]);
    has(BP, "The walk does 7 forks and prunes 7 paths");
    expect(O.verify(asm("bigloop")).processed).toBe(20001);
    has(BP, "after 20,001 instructions");
    expect(O.verify(asm("spinrange")).error).toContain("infinite loop detected");
    has(BP, "`infinite loop detected`");
  });
  test("preset counts and machine facts in the text", () => {
    expect(O.BPF_PRESETS.filter((p) => p.group === "unsafe")).toHaveLength(20);
    expect(O.BPF_PRESETS.filter((p) => p.group === "correct")).toHaveLength(3);
    has(BP, "Of the presets, 20 are unsafe", "The demo has 3 of them");
    expect(O.STACK_SIZE).toBe(512);
    expect(O.LINUX_COMPLEXITY_LIMIT).toBe(1_000_000);
    has(BP, "The stack has 512 bytes", "11 registers", "8 bytes", "1 million processed instructions");
  });
  test("the encoded listing in the text is correct", () => {
    const lines = text(BP).split("\n").filter((l) => /^[0-9a-f]{2}( [0-9a-f]{2}){7}\s/.test(l));
    expect(lines.length).toBe(5);
    for (const line of lines) {
      const hex = line.slice(0, 23), src = line.slice(23).trim();
      const a = O.assemble(`${src}\nexit`);
      expect(a.ok, src).toBe(true);
      if (a.ok) expect(O.hexOf(a.prog.insns[0]!), src).toBe(hex);
    }
  });
  test("the x - x range is [-7, 7] for r6 in [0, 7]", () => {
    const r = O.scalarAlu("sub", O.scalarBits(3), O.scalarBits(3), false);
    expect([r.smin, r.smax]).toEqual([-7n, 7n]);
    has(BP, "[0, 7] minus [0, 7] is [-7, 7]");
  });
  test("the walk log contains the states in the listing of the lesson", () => {
    const v = O.verify(asm("mask"));
    const after = v.log.find((e) => e.pc === 9 && e.kind === "insn") ?? v.log[0]!;
    const masks = v.log.filter((e) => e.regs[6]?.k === "scalar" && e.regs[6].s.umax === 63n);
    expect(masks.length).toBeGreaterThan(0);
    const m = masks[0]!.regs[6] as Extract<O.Reg, { k: "scalar" }>;
    expect(O.fmtTnum(m.s.t)).toBe("(0x0; 0x3f)");
    expect(after).toBeDefined();
    has(BP, "(0x0; 0x3f)");
  });
});
