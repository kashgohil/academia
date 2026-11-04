/** Invariants of the Processes and threads models. The numbers that the lessons quote are in os-processes-lessons.test.ts. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import {
  ProcTable, stateMachineTable, treeTable, statLetter,
  INSTRUCTIONS, instructionsFor, initialBits, timeline, ENTRY_US, type EntryKind,
  writeSteps, libcView, REG_ORDER, syscallNs, NO_MITIGATIONS, ALL_MITIGATIONS, type WriteVariant,
  Machine, pipeline, pageTables, forkUs, PAGE_4K, PAGE_2M, GIB,
  buildElf, parseElf, mapSegments, loaderSteps, initialStack, PT, PF, PIE_BASE, PAGE, randomBase, EHDR_SIZE, PHDR_SIZE, SHDR_SIZE, ET_DYN, EM_X86_64, INTERP_PATH, BSS_SIZE, STACK_TOP,
  runPlt, stepsToPuts, PUTS, EXIT,
  cloneError, CLONE, PTHREAD_FLAGS, newPair, writeX, openFd, exitGroup, chdir, sigaction,
  Gmp, scenario, runToEnd, randomProgram, LOCAL_QUEUE_CAP,
  switchSnaps, machineAfterPriorSwitch, USER_A, USER_B, switchCost, SWITCH_INPUTS,
} from "@/sims/os/processes";

describe("process table", () => {
  test("random events keep every rule: one runner, no zombie without a live parent, every exit reaped or re-parented", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = mulberry32(seed);
      const t = treeTable();
      if (r() < 0.5) t.get(305)!.subreaper = true;
      if (r() < 0.3) t.get(212)!.ignoresSigchld = true;
      for (let i = 0; i < 300; i++) {
        const pids = t.list().map((p) => p.pid);
        const x = r();
        if (x < 0.3) t.schedule();
        else if (x < 0.45) t.block();
        else if (x < 0.6) t.ioDone(pids[Math.floor(r() * pids.length)]!);
        else if (x < 0.7) t.exit();
        else if (x < 0.8) t.wait();
        else if (x < 0.9) t.kill(pids[Math.floor(r() * pids.length)]!);
        else if (t.running !== null && t.procs.size < 40) t.spawn(1000 + i, "new", t.running);
        expect(t.check(), `seed ${seed} event ${i}`).toEqual([]);
      }
    }
  });
  test("every process that exits ends reaped, once all ancestors are gone", () => {
    const t = treeTable();
    for (const p of [520, 410, 305, 210, 330, 331, 212, 521]) t.kill(p);
    expect(t.list().map((p) => p.pid)).toEqual([1]);
    expect(t.stats.exits).toBe(t.stats.reaped);
  });
  test("a zombie stays until wait; wait frees it and returns its status", () => {
    const t = stateMachineTable();
    t.schedule(); // shell runs
    t.schedule(); // A runs
    expect(t.running).toBe(101);
    t.exit(3);
    expect(t.get(101)!.state).toBe("zombie");
    expect(statLetter(t.get(101)!)).toBe("Z");
    expect(t.wait(100).text).toContain("status 3");
    expect(t.get(101)).toBeUndefined();
  });
  test("a parent blocked in wait wakes on child exit and reaps when it runs", () => {
    const t = stateMachineTable();
    t.schedule();
    expect(t.running).toBe(100);
    t.wait();
    expect(t.get(100)!.state).toBe("blocked");
    t.schedule();
    t.exit(0);
    expect(t.get(100)!.state).toBe("ready");
    expect(t.get(101)!.state).toBe("zombie");
    while (t.running !== 100) t.schedule();
    expect(t.get(101)).toBeUndefined();
    expect(t.get(100)!.reason).toBeUndefined();
  });
  test("only the running process can block, exit or wait", () => {
    const t = stateMachineTable();
    expect(t.block().ok).toBe(false);
    expect(t.exit().ok).toBe(false);
    expect(t.wait().ok).toBe(false);
  });
  test("children go to the nearest subreaper, and zombies go with them", () => {
    const t = treeTable();
    t.get(305)!.subreaper = true;
    t.kill(520);
    t.kill(410);
    expect(t.get(521)!.ppid).toBe(305);
    expect(t.get(520)!.ppid).toBe(305);
    expect(t.get(520)!.state).toBe("zombie");
    expect(t.wait(305).text).toContain("PID 410");
    expect(t.wait(305).text).toContain("PID 520");
    expect(t.get(520)).toBeUndefined();
  });
  test("SIGCHLD ignored means no zombie stage; PID 1 cannot die", () => {
    const t = treeTable();
    t.get(212)!.ignoresSigchld = true;
    t.kill(330);
    expect(t.get(330)).toBeUndefined();
    expect(t.kill(1).ok).toBe(false);
    expect(new ProcTable().get(1)!.state).toBe("blocked");
  });
});

describe("privilege", () => {
  test("every instruction either runs or names a fault, from both modes", () => {
    for (const i of INSTRUCTIONS) for (const m of ["user", "kernel"] as const) {
      const o = i.run(initialBits(m));
      if (o.fault) { expect(o.exception, i.id).toBeTruthy(); expect(o.signal, i.id).toBeTruthy(); }
      expect(o.text.length, i.id).toBeGreaterThan(5);
    }
  });
  test("x86: privileged instructions fault in ring 3 and run in ring 0", () => {
    for (const id of ["cli", "sti", "hlt", "cr3", "wrmsr", "in", "invlpg", "sysret"]) {
      const i = INSTRUCTIONS.find((x) => x.id === id)!;
      expect(i.run(initialBits("user")).exception, id).toBe("#GP(0)");
      expect(i.run(initialBits("kernel")).fault, id).toBe(false);
    }
    expect(INSTRUCTIONS.find((x) => x.id === "popf")!.run(initialBits("user")).fault).toBe(false);
    expect(INSTRUCTIONS.find((x) => x.id === "popf")!.run(initialBits("user")).next.interrupts).toBe(true);
  });
  test("SMAP: kernel access to user pages needs stac", () => {
    const load = INSTRUCTIONS.find((x) => x.id === "load-user")!, stac = INSTRUCTIONS.find((x) => x.id === "stac")!;
    expect(load.run(initialBits("kernel")).fault).toBe(true);
    expect(load.run(stac.run(initialBits("kernel")).next).fault).toBe(false);
  });
  test("the only way up from user mode is the gate", () => {
    for (const a of ["x86", "arm"] as const) {
      const up = instructionsFor(a).filter((i) => { const o = i.run(initialBits("user")); return !o.fault && o.next.mode === "kernel"; });
      expect(up.map((i) => i.kind)).toEqual(["gate"]);
    }
  });
  test("timeline: time adds up, and a tick in a kernel slice is not a mode change", () => {
    const events: EntryKind[] = ["getpid", "read", "fault", "disk", "read", "getpid"];
    for (const hz of [100, 250, 1000]) {
      const t = timeline(events, hz, 700);
      const sum = t.segments.reduce((a, s) => a + s.durUs, 0);
      expect(sum).toBeCloseTo(t.userUs + t.kernelUs, 6);
      let time = 0;
      for (const s of t.segments) { expect(s.startUs).toBeCloseTo(time, 6); time += s.durUs; }
      expect(t.entries).toBe(events.length + t.ticks - t.nestedTicks);
      const kernelWork = events.reduce((a, e) => a + ENTRY_US[e], 0) + t.ticks * ENTRY_US.timer;
      expect(t.kernelUs).toBeCloseTo(kernelWork, 6);
    }
    // 2 ms in the kernel at 1000 Hz always contains a tick.
    expect(timeline(["read"], 1000, 100).nestedTicks).toBeGreaterThanOrEqual(1);
  });
});

describe("syscall stepper", () => {
  const variants: WriteVariant[] = ["ok", "badfd", "kernelptr", "unmapped", "badnr"];
  test("all paths end in user mode with the old rip + 2, the old rsp, and rcx and r11 clobbered", () => {
    for (const v of variants) for (const kpti of [true, false]) {
      const s = writeSteps(v, kpti);
      const last = s[s.length - 1]!, first = s[0]!;
      expect(last.mode).toBe("user");
      expect(last.cr3).toBe("user");
      expect(last.ac).toBe(false);
      expect(last.regs.rsp).toBe(first.regs.rsp);
      expect(last.regs.rcx).toBe(last.regs.rip);
      expect(last.regs.r11).toBe("0x246");
      expect(first.regs.rcx).not.toBe(last.regs.rcx);
      // Arguments survive.
      expect(last.regs.rdi).toBe(s[1]!.regs.rdi);
      expect(last.regs.rdx).toBe(s[1]!.regs.rdx);
      for (const r of ["r10", "r8", "r9"] as const) expect(last.regs[r]).toBe(first.regs[r]);
      expect(REG_ORDER).toHaveLength(11);
    }
  });
  test("return values and the libc view", () => {
    const ret = (v: WriteVariant) => writeSteps(v).at(-1)!.ret!;
    expect(ret("ok")).toBe(2);
    expect(ret("badfd")).toBe(-9);
    expect(ret("kernelptr")).toBe(-14);
    expect(ret("unmapped")).toBe(-14);
    expect(ret("badnr")).toBe(-38);
    expect(libcView(2)).toEqual({ ret: 2, errno: 0 });
    expect(libcView(-9)).toEqual({ ret: -1, errno: 9 });
    expect(libcView(-4096).ret).toBe(-4096);
  });
  test("bytes reach the kernel only inside the SMAP window, and only the good path prints", () => {
    expect(writeSteps("ok").at(-1)!.output).toBe("hi");
    for (const v of ["badfd", "kernelptr", "unmapped", "badnr"] as const) expect(writeSteps(v).at(-1)!.output).toBe("");
    const s = writeSteps("ok");
    const i = s.findIndex((x) => x.kernelBuf === "hi");
    expect(s[i]!.ac).toBe(true);
  });
  test("mitigations only add cost", () => {
    expect(syscallNs(ALL_MITIGATIONS)).toBeGreaterThan(syscallNs(NO_MITIGATIONS));
  });
});

describe("fork and exec", () => {
  test("the pipeline keeps all reference counts right at every step", () => {
    for (const closeInParent of [true, false]) for (const cloexec of [true, false]) {
      for (const s of pipeline({ closeInParent, cloexec })) expect(s.bad, s.code).toEqual([]);
    }
  });
  test("with close: wc sees EOF, prints 2 2 12, and all finish", () => {
    const s = pipeline({ closeInParent: true, cloexec: true });
    const last = s.at(-1)!.snap;
    expect(last.tty).toBe("2 2 12\n");
    expect(last.tasks.map((t) => t.pid)).toEqual([100]);
  });
  test("without close: wc blocks forever and prints nothing", () => {
    const s = pipeline({ closeInParent: false, cloexec: true });
    const last = s.at(-1)!.snap;
    expect(last.tty).toBe("");
    expect(last.tasks.find((t) => t.image === "wc")!.state).toBe("blocked");
  });
  test("close-on-exec: the fd closes at exec, or leaks into both children", () => {
    const fdsOf = (cloexec: boolean) => {
      const s = pipeline({ closeInParent: true, cloexec });
      const i = s.findIndex((x) => x.code.startsWith("execve(\"/bin/ls"));
      return s[i]!.snap.tasks.find((t) => t.image === "ls")!.fds.map(([n]) => n);
    };
    expect(fdsOf(true)).toEqual([0, 1, 2]);
    expect(fdsOf(false)).toEqual([0, 1, 2, 3]);
  });
  test("fork returns the child PID to the parent and 0 to the child; pages stay shared until a write", () => {
    const m = new Machine();
    const c = m.fork(100);
    const snap = m.snap();
    expect(snap.tasks.find((t) => t.pid === 100)!.ret).toBe(String(c));
    expect(snap.tasks.find((t) => t.pid === c)!.ret).toBe("0");
    expect(snap.frames.every((f) => f.refs === 2)).toBe(true);
    expect(m.check()).toEqual([]);
    expect(m.touch(c, "stack", "x")).toBe(true);
    expect(m.check()).toEqual([]);
    // The parent is now the only owner, so its write needs no copy.
    expect(m.touch(100, "stack", "y")).toBe(false);
    expect(m.snap().frames.filter((f) => f.content === "x" || f.content === "y")).toHaveLength(2);
    expect(m.check()).toEqual([]);
  });
  test("a fuzz of fork, touch, dup2, close, exec and exit keeps all counts right", () => {
    const r = mulberry32(5);
    const m = new Machine();
    for (let i = 0; i < 2000; i++) {
      const live = [...m.tasks.values()].filter((t) => t.state !== "exited");
      if (live.length === 0) break;
      const t = live[Math.floor(r() * live.length)]!;
      const x = r();
      if (x < 0.15 && live.length < 12) m.fork(t.pid);
      else if (x < 0.4 && t.pages.length) m.touch(t.pid, t.pages[Math.floor(r() * t.pages.length)]!.name === "code" ? "data" : "stack", `v${i}`);
      else if (x < 0.55 && t.fds.length) m.dup2(t.pid, t.fds[Math.floor(r() * t.fds.length)]![0], Math.floor(r() * 6));
      else if (x < 0.7 && t.fds.length > 1) m.close(t.pid, t.fds[Math.floor(r() * t.fds.length)]![0]);
      else if (x < 0.8) m.exec(t.pid, "prog");
      else if (x < 0.9 && live.length > 1) m.exit(t.pid);
      else if (x < 0.95) m.open(t.pid, "f", r() < 0.5);
      expect(m.check(), `event ${i}`).toEqual([]);
    }
  });
  test("page tables: a dense GiB has 262144 PTEs in 512 pages", () => {
    const t = pageTables(GIB, PAGE_4K);
    expect(t.entries).toBe(262144);
    expect(t.leafPages).toBe(512);
    expect(pageTables(GIB, PAGE_2M).entries).toBe(512);
    expect(forkUs(2 * GIB)).toBeGreaterThan(forkUs(GIB));
    expect(forkUs(GIB, true)).toBeLessThan(forkUs(GIB) / 10);
  });
});

describe("ELF", () => {
  const e = buildElf();
  const p = parseElf(e.bytes);
  test("the parser, which uses only spec offsets, reads back what the builder wrote", () => {
    expect(p.magicOk && p.class64 && p.littleEndian).toBe(true);
    expect(p.type).toBe(ET_DYN);
    expect(p.machine).toBe(EM_X86_64);
    expect(p.entry).toBe(e.entry);
    expect(p.phoff).toBe(EHDR_SIZE);
    expect(p.ehsize).toBe(64);
    expect(p.phentsize).toBe(56);
    expect(p.shentsize).toBe(64);
    expect(p.phdrs).toEqual(e.phdrs);
    expect(p.sections.map((s) => s.name)).toEqual(e.sections.map((s) => s.name));
    expect(p.shoff + p.shnum * SHDR_SIZE).toBe(e.bytes.length);
    expect(PHDR_SIZE).toBe(56);
  });
  test("recorded fields sit at the spec offsets, and no two fields overlap", () => {
    const at = (n: string) => e.fields.find((f) => f.name === n)!;
    expect(at("e_type").offset).toBe(0x10);
    expect(at("e_machine").offset).toBe(0x12);
    expect(at("e_version").offset).toBe(0x14);
    expect(at("e_entry").offset).toBe(0x18);
    expect(at("e_phoff").offset).toBe(0x20);
    expect(at("e_shoff").offset).toBe(0x28);
    expect(at("e_flags").offset).toBe(0x30);
    expect(at("e_ehsize").offset).toBe(0x34);
    expect(at("e_phentsize").offset).toBe(0x36);
    expect(at("e_phnum").offset).toBe(0x38);
    expect(at("e_shentsize").offset).toBe(0x3a);
    expect(at("e_shnum").offset).toBe(0x3c);
    expect(at("e_shstrndx").offset).toBe(0x3e);
    const first = e.fields.filter((f) => f.name.startsWith("phdr[0]"));
    expect(first.map((f) => f.offset - 64)).toEqual([0, 4, 8, 0x10, 0x18, 0x20, 0x28, 0x30]);
    const sorted = [...e.fields].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.offset, sorted[i]!.name).toBeGreaterThanOrEqual(sorted[i - 1]!.offset + sorted[i - 1]!.size);
    expect(e.fieldAt(0x18)!.name).toBe("e_entry");
    expect(e.fieldAt(0x1f)!.name).toBe("e_entry");
  });
  test("segments obey the loader's rules", () => {
    const loads = p.phdrs.filter((h) => h.type === PT.LOAD);
    expect(loads).toHaveLength(3);
    for (const l of loads) {
      expect(l.vaddr % l.align).toBe(l.offset % l.align);
      expect(l.memsz).toBeGreaterThanOrEqual(l.filesz);
    }
    for (let i = 1; i < loads.length; i++) expect(loads[i]!.vaddr).toBeGreaterThan(loads[i - 1]!.vaddr + loads[i - 1]!.memsz - 1);
    const rx = loads.find((l) => l.flags & PF.X)!;
    expect(p.entry).toBeGreaterThanOrEqual(rx.vaddr);
    expect(p.entry).toBeLessThan(rx.vaddr + rx.filesz);
    expect(rx.flags & PF.W).toBe(0);
    const rw = loads.find((l) => l.flags & PF.W)!;
    expect(rw.memsz - rw.filesz).toBe(BSS_SIZE);
    const interp = p.phdrs.find((h) => h.type === PT.INTERP)!;
    expect(new TextDecoder().decode(e.bytes.slice(interp.offset, interp.offset + interp.filesz - 1))).toBe(INTERP_PATH);
  });
  test("maps: page aligned, no overlap, one anonymous part for .bss", () => {
    const m = mapSegments(e, PIE_BASE);
    for (const v of m) { expect(v.start % PAGE).toBe(0); expect(v.end % PAGE).toBe(0); expect(v.end).toBeGreaterThan(v.start); }
    for (let i = 1; i < m.length; i++) expect(m[i]!.start).toBeGreaterThanOrEqual(m[i - 1]!.end);
    expect(m.map((v) => v.perms)).toEqual(["r--p", "r-xp", "rw-p", "rw-p"]);
    expect(m[3]!.name).toBe("[bss]");
    expect(PIE_BASE % PAGE).toBe(0);
    expect(randomBase(0)).toBe(PIE_BASE);
    expect(randomBase(0.999) % PAGE).toBe(0);
  });
  test("loader steps grow the map and end at _start", () => {
    const s = loaderSteps(e);
    for (let i = 1; i < s.length; i++) expect(s[i]!.maps.length).toBeGreaterThanOrEqual(s[i - 1]!.maps.length);
    expect(s[0]!.maps).toEqual([]);
    expect(s.at(-1)!.mode).toBe("program");
    for (const x of s) if (x.field) expect(e.fields.some((f) => f.name === x.field), x.field).toBe(true);
  });
  test("initial stack: rsp is 16-byte aligned, argc is first, auxv ends in AT_NULL", () => {
    const { rsp, rows } = initialStack(["./hello", "x"], ["HOME=/root"], e);
    expect(rsp % 16).toBe(0);
    expect(rows[0]!.label).toBe("argc");
    expect(rows[0]!.addr).toBe(rsp);
    expect(rows[0]!.value).toBe("2");
    expect(rows.find((r) => r.label === "AT_NULL")).toBeTruthy();
    expect(rows.at(-1)!.addr).toBeLessThan(STACK_TOP);
    const order = rows.map((r) => r.addr);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("PLT and GOT", () => {
  test("lazy: the first call runs the resolver, the second goes direct", () => {
    const run = runPlt(false);
    expect(run.resolverRuns).toBe(2); // puts once and exit once
    expect(stepsToPuts(run)).toEqual([7, 2]);
    expect(run.steps.at(-1)!.region).toBe("libc");
    expect(run.steps.at(-1)!.gotPuts).toBe(PUTS);
    expect(run.steps.at(-1)!.gotExit).toBe(EXIT);
    expect(run.steps.at(-1)!.output).toEqual(["hi from lab", "hi from lab"]);
    const start = run.steps[0]!;
    expect(start.gotPuts).toBe(run.base + buildElf().sym.pltPuts + 6);
  });
  test("bind now: no resolver at run time, and both calls go direct", () => {
    const run = runPlt(true);
    expect(run.resolverRuns).toBe(0);
    expect(stepsToPuts(run)).toEqual([2, 2]);
    expect(run.steps[0]!.gotPuts).toBe(PUTS);
  });
  test("the stack balances: it is empty after each call returns", () => {
    const run = runPlt(false);
    const leas = run.steps.filter((s) => s.asm.startsWith("lea"));
    for (const s of leas) expect(s.stack).toEqual([]);
  });
});

describe("clone", () => {
  test("the kernel's validity rules", () => {
    expect(cloneError(CLONE.THREAD)).toContain("SIGHAND");
    expect(cloneError(CLONE.SIGHAND)).toContain("CLONE_VM");
    expect(cloneError(CLONE.VM | CLONE.SIGHAND | CLONE.THREAD)).toBeNull();
    expect(cloneError(PTHREAD_FLAGS)).toBeNull();
    expect(cloneError(17)).toBeNull();
  });
  test("each flag shares exactly its own resource", () => {
    const f = newPair(17);
    expect(writeX(f, 0, 42).x).toEqual([42, 7]);
    expect(openFd(f, 0).fds).toEqual([[3], []]);
    expect(chdir(f, 0, "/tmp").cwd).toEqual(["/tmp", "/home"]);
    expect(sigaction(f, 0, "h").handler).toEqual(["h", "default"]);
    expect(exitGroup(f, 0).alive).toEqual([false, true]);
    const t = newPair(PTHREAD_FLAGS);
    expect(writeX(t, 0, 42).x).toEqual([42, 42]);
    expect(openFd(t, 1).fds).toEqual([[3], [3]]);
    expect(chdir(t, 0, "/tmp").cwd).toEqual(["/tmp", "/tmp"]);
    expect(sigaction(t, 0, "h").handler).toEqual(["h", "h"]);
    expect(exitGroup(t, 0).alive).toEqual([false, false]);
    expect(t.pid[0]).toBe(t.pid[1]);
    expect(t.tid[0]).not.toBe(t.tid[1]);
    // CLONE_VM alone is not a thread: a new PID.
    const v = newPair(CLONE.VM | CLONE.FILES);
    expect(v.pid[0]).not.toBe(v.pid[1]);
    expect(writeX(v, 1, 1).x).toEqual([1, 1]);
  });
});

describe("GMP", () => {
  test("fuzz: no G is ever lost or duplicated, and all finish", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = mulberry32(seed);
      const procs = 1 + Math.floor(r() * 4);
      const g = new Gmp(procs, seed);
      const n = 1 + Math.floor(r() * 15);
      for (let i = 0; i < n; i++) g.enqueue(randomProgram(r), Math.floor(r() * procs));
      let ticks = 0;
      while (!g.done) {
        g.step();
        expect(g.check(), `seed ${seed} tick ${g.tick}`).toEqual([]);
        expect(g.ps.filter((p) => p.m !== null).length).toBeLessThanOrEqual(procs);
        ticks++;
        if (ticks > 20000) throw new Error(`seed ${seed} did not finish`);
      }
      expect([...g.gs.values()].every((x) => x.state === "done")).toBe(true);
      expect(g.globalQ).toEqual([]);
    }
  });
  test("a blocking syscall hands off the P: others run during it", () => {
    const g = scenario("handoff", 1);
    let ranDuringSyscall = false;
    while (!g.done) {
      g.step();
      const blocked = g.ms.some((m) => m.state === "syscall" && m.p === null);
      if (blocked && g.ps[0]!.cur !== null) ranDuringSyscall = true;
    }
    expect(ranDuringSyscall).toBe(true);
    expect(g.stats.handoffs).toBe(1);
    expect(g.stats.mCreated).toBe(2);
  });
  test("work stealing evens out the queues", () => {
    const g = scenario("steal", 4);
    runToEnd(g);
    expect(g.stats.steals).toBeGreaterThanOrEqual(3);
    // 8 Gs of 4 ticks on 4 Ps: far less than the 32 ticks that one P needs.
    expect(g.tick).toBeLessThan(16);
  });
  test("a full local queue spills half to the global queue, and nothing is lost", () => {
    const g = new Gmp(1, 1);
    for (let i = 0; i < LOCAL_QUEUE_CAP + 5; i++) g.enqueue([{ op: "run", ticks: 1 }]);
    expect(g.globalQ.length).toBeGreaterThan(0);
    expect(g.ps[0]!.q.length).toBeLessThanOrEqual(LOCAL_QUEUE_CAP);
    expect(g.check()).toEqual([]);
    runToEnd(g);
    expect(g.done).toBe(true);
  });
  test("a long G is preempted, so a short one still runs", () => {
    const g = new Gmp(1, 1);
    const long = g.enqueue([{ op: "run", ticks: 100 }]);
    const short = g.enqueue([{ op: "run", ticks: 1 }]);
    runToEnd(g);
    expect(g.stats.preempted).toBeGreaterThan(0);
    const ids = g.events.filter((e) => e.kind === "done").map((e) => e.text);
    expect(ids[0]).toContain(`G${short}`);
    expect(ids[1]).toContain(`G${long}`);
  });
});

describe("context switch", () => {
  const regsEq = (r: Record<string, string>, want: Record<string, string>) => { for (const k of Object.keys(want)) expect(r[k], k).toBe(want[k]); };
  test("A to B: B's registers come back exactly, from its stack only", () => {
    const s = switchSnaps();
    const last = s.at(-1)!;
    expect(last.cpu.mode).toBe("user");
    expect(last.cpu.current).toBe("B");
    regsEq(last.cpu.regs, USER_B);
    expect(last.tasks.B!.kstack).toEqual([]);
  });
  test("a round trip A to B to A restores A exactly", () => {
    const m = machineAfterPriorSwitch();
    regsEq(m.cpu.regs, USER_A);
    m.switchTo("B");
    m.switchTo("A");
    regsEq(m.cpu.regs, USER_A);
    m.switchTo("B");
    m.switchTo("A");
    regsEq(m.cpu.regs, USER_A);
    expect(m.tasks.A!.kstack).toEqual([]);
    expect(m.cpu.cr3).toBe("pgd(A)");
  });
  test("the switch happens at the load of rsp; CR3 changes only across processes", () => {
    const s = switchSnaps();
    const i = s.findIndex((x) => x.phase === "switch");
    expect(s[i - 1]!.onStack).toBe("A");
    expect(s[i]!.onStack).toBe("B");
    expect(s[i]!.changed).toEqual(["rsp"]);
    expect(s[0]!.cpu.cr3).toBe("pgd(A)");
    expect(s.at(-1)!.cpu.cr3).toBe("pgd(B)");
    const t = switchSnaps({ sameMm: true });
    expect(new Set(t.map((x) => x.cpu.cr3)).size).toBe(1);
  });
  test("A's user state stays on A's stack while B runs", () => {
    const last = switchSnaps().at(-1)!;
    const a = last.tasks.A!.kstack.map((x) => x.value);
    for (const r of ["rip", "rsp", "rax", "rbx", "rbp", "r12", "r13", "r14", "r15"] as const) expect(a, r).toContain(USER_A[r]);
  });
  test("cost model: more of everything costs more; cap at 100%", () => {
    const base = { workingSetBytes: 1 << 20, switchesPerSec: 1000, evictedShare: 0.5, sameMm: false, pcid: true };
    const c = switchCost(base);
    expect(c.totalNs).toBeGreaterThan(c.directNs);
    expect(switchCost({ ...base, workingSetBytes: 1 << 21 }).totalNs).toBeGreaterThan(c.totalNs);
    expect(switchCost({ ...base, sameMm: true }).totalNs).toBeLessThan(c.totalNs);
    expect(switchCost({ ...base, pcid: false }).totalNs).toBeGreaterThan(c.totalNs);
    expect(switchCost({ ...base, switchesPerSec: 1e9 }).cpuLost).toBe(1);
    // A working set above the cache size adds no more cache refill.
    expect(switchCost({ ...base, workingSetBytes: SWITCH_INPUTS.cacheBytes * 8 }).cacheNs).toBe(switchCost({ ...base, workingSetBytes: SWITCH_INPUTS.cacheBytes }).cacheNs);
  });
});
