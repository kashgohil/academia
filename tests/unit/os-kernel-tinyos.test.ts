/** TinyOS: real ELF loading, syscalls, faults, isolation, and random runs that must keep every invariant. */
import { describe, expect, test } from "vitest";
import { mulberry32 } from "@/sims/rng";
import { EHDR_SIZE, parseElf, PT } from "@/sims/os/processes/elf";
import { traceProblems } from "@/sims/os/scheduling/types";
import { PAGE_SIZE } from "@/sims/os/vm/addr";
import { FREE, UNMOVABLE } from "@/sims/os/vm/physmem";
import { DATA_VADDR, INJECT_LABEL, KERNEL_TEXT, PROGRAMS, SYS, TINY, TinyOS, USER_BASE, WILD_ADDR, bootedTinyOs, kstackTop, programNamed, type Inject } from "@/sims/os/kernel";

const noBad = (os: TinyOS) => expect(os.invariants()).toEqual([]);
const consoleText = (os: TinyOS, pid?: number) => os.console.filter((c) => pid === undefined || c.pid === pid).map((c) => c.text).join("");

describe("user programs are real ELF files", () => {
  test("parseElf reads them with the spec offsets", () => {
    for (const p of PROGRAMS) {
      const e = parseElf(p.elf);
      expect(e.magicOk && e.class64 && e.littleEndian).toBe(true);
      expect(e.type).toBe(2);
      expect(e.machine).toBe(62);
      expect(e.entry).toBe(USER_BASE + EHDR_SIZE + 2 * 56);
      const load = e.phdrs.filter((x) => x.type === PT.LOAD);
      expect(load.length).toBe(2);
      expect(load[0]!.flags).toBe(5);
      expect(load[1]!.flags).toBe(6);
      expect(load[1]!.vaddr).toBe(DATA_VADDR);
      expect(load[0]!.offset % PAGE_SIZE).toBe(load[0]!.vaddr % PAGE_SIZE);
      expect(load[1]!.offset % PAGE_SIZE).toBe(load[1]!.vaddr % PAGE_SIZE);
      expect(e.sections.map((s) => s.name)).toEqual(["", ".text", ".data", ".shstrtab"]);
    }
  });
  test("hand-checked encodings", () => {
    const t = programNamed("ping").text;
    // push rax; mov eax, 1
    expect([...t.slice(0, 6)]).toEqual([0x50, 0xb8, 0x01, 0, 0, 0]);
    // mov edi, 1
    expect([...t.slice(6, 11)]).toEqual([0xbf, 0x01, 0, 0, 0]);
    // lea rsi, [rip+rel32] with a target of DATA_VADDR
    expect([...t.slice(11, 14)]).toEqual([0x48, 0x8d, 0x35]);
    const rel = new DataView(t.buffer, t.byteOffset + 14, 4).getInt32(0, true);
    expect(USER_BASE + EHDR_SIZE + 112 + 18 + rel).toBe(DATA_VADDR);
    expect(SYS.WRITE).toBe(1);
    expect(SYS.EXIT).toBe(60);
  });
});

describe("boot", () => {
  test("boot takes 6 steps and leaves the CPU idle with IF = 1", () => {
    const os = new TinyOS();
    os.boot();
    let n = 0;
    while (!os.booted) { os.step(); n++; }
    expect(n).toBe(6);
    expect(os.ifFlag).toBe(true);
    expect(os.gdtEntries).toBe(5);
    expect(os.idtGates).toBe(256);
    expect(os.freeFrames).toBeLessThan(TINY.blocks * 512 - TINY.kernelFrames);
    noBad(os);
  });
  test("the kernel keeps 32 of 512 frames, and its tables use 4 more at boot", () => {
    const os = bootedTinyOs();
    expect(os.totalFrames).toBe(512);
    expect(TINY.kernelFrames).toBe(32);
    expect(512 - os.freeFrames - TINY.kernelFrames).toBe(os.mem.count);
    expect(os.mem.count).toBe(4);
  });
});

describe("two programs", () => {
  const two = () => {
    const os = bootedTinyOs();
    const a = os.spawn("ping")!, b = os.spawn("pong")!;
    return { os, a, b };
  };
  test("both write to the console and neither stops the other", () => {
    const { os, a, b } = two();
    os.run(400);
    noBad(os);
    expect(consoleText(os, a)).toContain("ping ping");
    expect(consoleText(os, b)).toContain("pong pong");
    expect(os.syscalls.some((s) => s.name === "sleep")).toBe(true);
  });
  test("the same virtual address names different frames in the two tasks", () => {
    const { os, a, b } = two();
    const ta = os.tasks.get(a)!, tb = os.tasks.get(b)!;
    const fa = os.userFrameAt(ta, BigInt(DATA_VADDR))!, fb = os.userFrameAt(tb, BigInt(DATA_VADDR))!;
    expect(fa).not.toBe(fb);
    expect(os.userFrameAt(ta, BigInt(USER_BASE))).not.toBe(os.userFrameAt(tb, BigInt(USER_BASE)));
    expect(os.phys.owner[fa]).toBe(a);
    expect(os.phys.owner[fb]).toBe(b);
  });
  test("frames per task: load and the first stack touch", () => {
    const os = bootedTinyOs();
    const before = os.freeFrames;
    const a = os.spawn("ping")!;
    const t = os.tasks.get(a)!;
    // Top table, PDPT, PD, PT; text page, data page; kernel stack; kernel tables for the stack area: PD and PT.
    expect(os.framesOf(a).length).toBe(7);
    expect(t.pages.size).toBe(2);
    expect(before - os.freeFrames).toBe(9);
    while (t.faultsHandled === 0) os.step();
    // The stack page needs a data frame and 3 new tables, because it is far from the code.
    expect(os.framesOf(a).length).toBe(11);
    expect(t.pages.size).toBe(3);
    noBad(os);
  });
  test("the first push is a page fault with error 6 that the kernel handles", () => {
    const os = bootedTinyOs();
    const a = os.spawn("ping")!;
    const t = os.tasks.get(a)!;
    while (t.faultsHandled === 0) os.step();
    expect(os.log.some((l) => l.kind === "fault" && l.text.includes("error 6"))).toBe(true);
    os.run(60);
    expect(t.state).not.toBe("dead");
    expect(consoleText(os, a)).toContain("ping");
  });
  test("pong writes 6 times, exits, and returns all its frames", () => {
    const os = bootedTinyOs();
    const start = os.freeFrames;
    const b = os.spawn("pong")!;
    os.run(2000);
    const t = os.tasks.get(b)!;
    expect(t.state).toBe("dead");
    expect(t.exit).toBe("exit(0)");
    expect(consoleText(os, b)).toBe("pong ".repeat(6));
    expect(os.framesOf(b)).toEqual([]);
    expect(os.freeFrames).toBe(start);
    noBad(os);
  });
  test("a spin loop gets preempted by the timer only", () => {
    const os = bootedTinyOs();
    const a = os.spawn("spin")!, b = os.spawn("ping")!;
    os.run(500);
    noBad(os);
    expect(os.tasks.get(a)!.retired).toBeGreaterThan(100);
    expect(consoleText(os, b)).toContain("ping");
    expect(traceProblems(os.trace())).toEqual([]);
  });
  test("TSS.RSP0 and the kernel rsp follow the current task", () => {
    const { os } = two();
    for (let i = 0; i < 300; i++) {
      os.step();
      if (os.ring === 3) expect(os.tssRsp0).toBe(kstackTop(os.current!.pid));
    }
  });
});

describe("faults kill only the guilty task", () => {
  const killed: [Inject, string][] = [
    ["read-kernel", "error 5"],
    ["write-kernel", "error 7"],
    ["write-own-text", "error 7"],
    ["read-unmapped", "error 4"],
    ["non-canonical", "general protection"],
  ];
  for (const [what, frag] of killed) {
    test(`a task that ${INJECT_LABEL[what]} dies with ${frag}`, () => {
      const os = bootedTinyOs();
      const a = os.spawn("ping")!, b = os.spawn("pong")!;
      os.run(40);
      const tb = os.tasks.get(b)!;
      const before = tb.retired;
      os.injectBug(a, what);
      for (let i = 0; i < 200 && os.tasks.get(a)!.state !== "dead"; i++) os.step();
      expect(os.tasks.get(a)!.state).toBe("dead");
      expect(os.tasks.get(a)!.exit).toContain(frag.startsWith("error") ? frag : frag);
      expect(tb.state).not.toBe("dead");
      expect(tb.retired).toBeGreaterThanOrEqual(before);
      os.run(80);
      expect(tb.retired).toBeGreaterThan(before);
      noBad(os);
    });
  }
  test("write(1, kernel address, 8) returns -14 and the task lives", () => {
    const os = bootedTinyOs();
    const a = os.spawn("ping")!;
    os.run(30);
    const n = os.console.length;
    os.injectBug(a, "write-kernel-ptr");
    for (let i = 0; i < 60 && !os.syscalls.some((s) => s.ret === "-14"); i++) os.step();
    expect(os.syscalls.some((s) => s.name === "write" && s.ret === "-14")).toBe(true);
    expect(os.tasks.get(a)!.state).not.toBe("dead");
    expect(os.console.slice(n).map((c) => c.text).join("")).not.toContain("\x7fELF");
  });
  test("the wild program dies by itself and the kernel text stays closed", () => {
    const os = bootedTinyOs();
    const w = os.spawn("wild")!, p = os.spawn("ping")!;
    os.run(200);
    expect(WILD_ADDR).toBe(KERNEL_TEXT);
    expect(os.tasks.get(w)!.state).toBe("dead");
    expect(os.tasks.get(w)!.exit).toContain("error 5");
    expect(consoleText(os, p)).toContain("ping");
    noBad(os);
  });
  test("kill from outside: running, ready and sleeping", () => {
    const os = bootedTinyOs();
    const ids = [os.spawn("spin")!, os.spawn("ping")!, os.spawn("pong")!];
    os.run(100);
    noBad(os);
    for (const id of ids) { os.kill(id); noBad(os); os.run(20); noBad(os); expect(os.tasks.get(id)!.state).toBe("dead"); }
    expect(os.framesOf(ids[0]!)).toEqual([]);
  });
});

describe("property: random runs keep the invariants", () => {
  const injects = Object.keys(INJECT_LABEL) as Inject[];
  const names = PROGRAMS.map((p) => p.name);
  for (let seed = 1; seed <= 12; seed++) {
    test(`seed ${seed}`, () => {
      const r = mulberry32(seed * 7919);
      const os = bootedTinyOs();
      const empty = os.freeFrames;
      for (let i = 0; i < 2500; i++) {
        const x = r();
        const live = os.live();
        const any = live[Math.floor(r() * live.length)];
        if (x < 0.012) os.spawn(names[Math.floor(r() * names.length)]!);
        else if (x < 0.018 && any) {
          // Killing one task must not change any other task's progress.
          const others = live.filter((t) => t !== any).map((t) => ({ t, retired: t.retired, bytes: t.bytesWritten, regs: { ...t.regs }, pages: t.pages.size }));
          const out = new Map(others.map((o) => [o.t.pid, os.console.filter((c) => c.pid === o.t.pid).map((c) => c.text).join("")]));
          os.kill(any.pid);
          for (const o of others) {
            expect(o.t.state).not.toBe("dead");
            expect(o.t.retired).toBe(o.retired);
            expect(o.t.bytesWritten).toBe(o.bytes);
            expect(o.t.pages.size).toBe(o.pages);
            expect(o.t.regs).toEqual(o.regs);
            expect(os.console.filter((c) => c.pid === o.t.pid).map((c) => c.text).join("")).toBe(out.get(o.t.pid));
          }
        } else if (x < 0.03 && any) os.injectBug(any.pid, injects[Math.floor(r() * injects.length)]!);
        else os.step();
        if (i % 7 === 0) {
          const bad = os.invariants();
          expect(bad, `step ${i}: ${bad.join("; ")}`).toEqual([]);
          // A user task can reach only its own frames, at random addresses and at the other tasks' addresses.
          const cur = os.live();
          for (const t of cur) {
            for (const o of cur) {
              if (o === t) continue;
              for (const va of o.pages.keys()) {
                const f = os.userFrameAt(t, va);
                if (f !== null) expect(os.phys.owner[f]).toBe(t.pid);
              }
            }
            const va = BigInt(Math.floor(r() * 2 ** 47)) & ~0xfffn;
            const f = os.userFrameAt(t, va);
            if (f !== null) expect(os.phys.owner[f]).toBe(t.pid);
            expect(os.userFrameAt(t, KERNEL_TEXT)).toBeNull();
          }
        }
      }
      expect(traceProblems(os.trace())).toEqual([]);
      for (const t of os.live()) os.kill(t.pid);
      os.run(30);
      expect(os.live()).toEqual([]);
      noBad(os);
      // All frames come back, including the tables. Only kernel frames stay used.
      for (let f = 0; f < os.totalFrames; f++) expect(os.phys.owner[f] === FREE || os.phys.owner[f] === UNMOVABLE).toBe(true);
      expect(os.freeFrames).toBe(empty);
    });
  }
  test("a new owner of a frame reads zeros, not the old data", () => {
    const os = bootedTinyOs();
    const a = os.spawn("ping")!;
    os.run(40);
    const frames = os.framesOf(a);
    os.kill(a);
    os.run(10);
    for (const f of frames) expect(os.frameMem.has(f)).toBe(false);
  });
});
