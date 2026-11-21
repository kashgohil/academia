/** The out-of-order core must commit exactly what the hart computes, under every configuration. */
import { describe, expect, test } from "vitest";
import { assemble, Hart, PROGRAMS } from "../../src/sims/arch/rv";
import { runOoo, type OooOptions } from "../../src/sims/arch/ooo";

const CONFIGS: [string, OooOptions][] = [
  ["default", {}],
  ["narrow, tiny", { width: 1, robSize: 4, iqSize: 2, lqSize: 1, sqSize: 1, physRegs: 33 }],
  ["no rename", { rename: false }],
  ["conservative", { memDep: "conservative" }],
  ["store sets", { memDep: "store-sets" }],
  ["not-taken, recover at commit", { branch: "not-taken", recover: "commit" }],
  ["gshare, one bus, reservation stations", { branch: "gshare", cdb: 1, rs: { alu: 3, mul: 2, div: 1, mem: 3 } }],
  ["cache", { cache: { perfect: false, lines: 8 }, lat: { miss: 30 } }],
  ["wide", { width: 8, robSize: 256, iqSize: 96, physRegs: 300, units: { alu: 6, mem: 3 } }],
];

describe("out-of-order core: committed state equals the hart", () => {
  for (const p of PROGRAMS) {
    for (const [name, cfg] of CONFIGS) {
      test(`${p.id} / ${name}`, () => {
        const { program } = assemble(p.source);
        const hart = new Hart(program);
        hart.run();
        const r = runOoo(program, cfg);
        expect(r.errors).toEqual([]);
        expect(r.status).toBe("exited");
        expect(r.exitCode).toBe(p.expect.exit);
        expect(r.regs).toEqual(Array.from(hart.regs));
        expect(Array.from(r.mem)).toEqual(Array.from(hart.mem));
        expect(r.stats.committed).toBe(hart.instret);
        const committed = r.uops.filter((u) => u.commit >= 0).map((u) => u.seq);
        expect(committed).toEqual(committed.map((_, i) => i));
        expect(r.uops.filter((u) => u.wrong).every((u) => u.commit < 0)).toBe(true);
      });
    }
  }
});
