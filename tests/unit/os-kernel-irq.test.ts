/** Interrupt frames and the fault cascade. */
import { describe, expect, test } from "vitest";
import * as K from "@/sims/os/kernel";

const OPT: K.EntryOpts = { from: "user", errorCode: true, gate: "interrupt", quirkBug: false };

describe("interrupt entry", () => {
  test("sizes", () => {
    expect(K.FRAME_BYTES).toBe(40);
    expect(K.SAVED_BYTES).toBe(120);
    expect(K.TRAP_FRAME_BYTES).toBe(176);
    expect(K.SAVED_REGS.length).toBe(15);
  });
  for (const from of ["user", "kernel"] as const) for (const errorCode of [true, false]) {
    test(`${from}, error code ${errorCode}: the stack returns exactly, and rsp is aligned at the call`, () => {
      const s = K.entrySnaps({ ...OPT, from, errorCode });
      const first = s[0]!, last = s[s.length - 1]!;
      expect(last.rsp).toBe(first.rsp);
      expect(last.rip).toBe(first.rip);
      expect(last.ring).toBe(first.ring);
      const call = s.find((x) => x.rip === "handle_trap")!;
      expect(call.rsp % 16n).toBe(0n);
      expect(call.stack.length * 8).toBe(K.TRAP_FRAME_BYTES);
      expect(s.every((x) => !x.bad)).toBe(true);
    });
  }
  test("from user the stack comes from TSS.RSP0; from the kernel it is aligned down", () => {
    const u = K.entrySnaps(OPT);
    expect(u[1]!.rsp).toBe(K.RSP0);
    const k = K.entrySnaps({ ...OPT, from: "kernel" });
    expect(k[0]!.rsp % 16n).not.toBe(0n);
    expect(k[1]!.rsp % 16n).toBe(0n);
  });
  test("an interrupt gate clears IF, and a trap gate keeps it", () => {
    expect(K.entrySnaps(OPT).find((s) => s.title === "The CPU pushes the frame")!.ifFlag).toBe(false);
    expect(K.entrySnaps({ ...OPT, gate: "trap" }).find((s) => s.title === "The CPU pushes the frame")!.ifFlag).toBe(true);
  });
  test("the error code quirk: both wrong stubs end in a bad iretq", () => {
    for (const errorCode of [true, false]) {
      const s = K.entrySnaps({ ...OPT, errorCode, quirkBug: true });
      const last = s[s.length - 1]!;
      expect(last.phase).toBe("fault");
      expect(last.bad).toBe(true);
    }
    const short = K.entrySnaps({ ...OPT, errorCode: false, quirkBug: true });
    expect(short[short.length - 1]!.rip).toBe("0x23");
    const long = K.entrySnaps({ ...OPT, errorCode: true, quirkBug: true });
    expect(long[long.length - 1]!.rip).toBe("0x0006");
  });
});

describe("fault cascade", () => {
  const G = K.GOOD_CFG;
  test("a good setup never triple-faults", () => {
    for (const t of K.ALL_TRIGGERS) expect(K.cascade(G, t).outcome).not.toBe("triple");
  });
  test("no IDT: everything triple-faults", () => {
    for (const t of K.ALL_TRIGGERS) expect(K.cascade({ ...G, idtLoaded: false }, t).outcome).toBe("triple");
  });
  test("stack overflow: IST decides", () => {
    expect(K.cascade(G, "stack-overflow").outcome).toBe("double");
    expect(K.cascade({ ...G, dfIst: false }, "stack-overflow").outcome).toBe("triple");
    expect(K.cascade({ ...G, tss: false }, "stack-overflow").outcome).toBe("triple");
    expect(K.cascade({ ...G, gateDF: false }, "stack-overflow").outcome).toBe("triple");
  });
  test("a missing #PF gate gives #NP, then #DF", () => {
    const r = K.cascade({ ...G, gatePF: false }, "null-deref");
    expect(r.outcome).toBe("double");
    expect(r.events.some((e) => e.text.includes("#NP"))).toBe(true);
  });
  test("a user IRQ needs the TSS", () => {
    expect(K.cascade(G, "user-irq").outcome).toBe("handled");
    expect(K.cascade({ ...G, tss: false }, "user-irq").outcome).toBe("triple");
  });
  test("a bug in the handler is a new #PF each time, until the stack ends", () => {
    const r = K.cascade(G, "bug-in-handler");
    expect(r.deepest).toBe(36);
    expect(r.outcome).toBe("double");
    expect(K.STACK_MODEL.stackBytes).toBe(16384);
    expect(K.cascade({ ...G, dfIst: false }, "bug-in-handler").outcome).toBe("triple");
  });
  test("the timer on an unmapped PIC looks like a double fault", () => {
    expect(K.cascade(G, "pic-timer").outcome).toBe("misdiagnosed");
  });
  test("of all 384 setups and triggers, 278 end in shutdown", () => {
    let triple = 0, n = 0;
    for (const c of K.allCfgs()) for (const t of K.ALL_TRIGGERS) { n++; if (K.cascade(c, t).outcome === "triple") triple++; }
    expect(n).toBe(384);
    expect(triple).toBe(278);
  });
  test("a page fault in delivery with a good #DF always ends in the #DF handler", () => {
    for (const c of K.allCfgs()) {
      if (c.idtLoaded && c.gateDF && c.dfIst && c.tss) expect(K.cascade(c, "stack-overflow").outcome).toBe("double");
    }
  });
});
