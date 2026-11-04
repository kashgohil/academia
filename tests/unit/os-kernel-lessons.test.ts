/** Every number that the kernel lessons quote, computed by src/sims/os/kernel, and checked against the text. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as K from "@/sims/os/kernel";

const text = (l: string) => readFileSync(new URL(`../../src/content/lessons/os/kernel/${l}.mdx`, import.meta.url), "utf8");
const has = (l: string, ...needles: string[]) => { const t = text(l); for (const n of needles) expect(t, n).toContain(n); };
const n = (v: number) => v.toLocaleString("en-US");
const hx = (v: number) => `0x${v.toString(16).toUpperCase()}`;

describe("booting", () => {
  test("reset, Multiboot2, MBR", () => {
    has("booting", hx(K.RESET_VECTOR), "0x60000010", "0xFFFF0000", "0xFFF0", hx(K.mb2Header().checksum), hx(K.MB2.BOOT_MAGIC), "32 KiB", "24 bytes", "0x7C00", "offset 510", "0xB8000");
    expect(K.RESET_CR0).toBe(0x60000010);
  });
  test("the linker numbers", () => {
    const hi = 0xffffffff80000000n;
    const d = K.layout(K.DEFAULT_ORDER, hi, true);
    const b = K.layout([".text", ".bss", ".rodata", ".data"], hi, false);
    has("booting", n(d.fileBytes), n(d.memBytes), n(b.fileBytes), n(b.fileBytes - K.layout(K.DEFAULT_ORDER, hi, false).fileBytes));
    expect(d.fileBytes).toBe(25600);
    expect(d.memBytes).toBe(46080);
  });
});

describe("protected mode and long mode", () => {
  test("orders and registers", () => {
    const r = K.countGoodOrders();
    has("protected-mode-and-long-mode", n(r.total), n(r.good), n(r.shutdown), n(r.other), "0x80000011", "0x00000020", "0x00000500", "0x00AF9A000000FFFF", "0x00CF9A000000FFFF");
  });
  test("tables", () => {
    expect(K.buildBootTables({ identity: true, higherHalf: true, kernelPage: "2m", directMap: false }).tablePages).toBe(5);
    has("protected-mode-and-long-mode", "PML4[511], PDPT[510], PD[0]", "PML4[256]", "that is 5 frames");
  });
});

describe("interrupt handling", () => {
  test("sizes and counts", () => {
    expect(K.IDT_ENTRIES).toBe(256);
    expect(K.GATE_BYTES).toBe(16);
    expect(K.vectorsWithErrorCode().join(", ").replace(", 21", " and 21")).toBe("8, 10, 11, 12, 13, 14, 17 and 21");
    has("interrupt-handling", "256 entries of 16 bytes", "40 bytes", "176 bytes", "8, 10, 11, 12, 13, 14, 17 and 21", "104-byte", "offset 36", "offset 4");
    expect(K.TRAP_FRAME_BYTES).toBe(176);
  });
  test("cascade numbers", () => {
    expect(K.cascade(K.GOOD_CFG, "bug-in-handler").deepest).toBe(36);
    has("interrupt-handling", "36 levels", "384 pairs", "278 end in a shutdown", "0xFEE00000", "0xB0", "0x380", "0x320");
  });
});

describe("a simple allocator", () => {
  test("carving and bitmap", () => {
    const c = K.carve(K.DEMO_MAP);
    expect(c.usableFrames).toBe(3551);
    expect(K.carve(K.DEMO_MAP, { skipFrameZero: true }).usableFrames).toBe(3550);
    has("a-simple-allocator", "3,551 whole frames out of 4,096, and 3,550", "3,072 bytes", "1/32,768", "512 bytes here, 256 KiB for 8 GiB, and 2 MiB for 64 GiB", "frame 448");
  });
  test("heap", () => {
    const b = K.heapSnaps("bump", "frames").at(-1)!, l = K.heapSnaps("list", "frames").at(-1)!;
    expect(b.liveBytes).toBe(9920);
    has("a-simple-allocator", n(b.liveBytes), n(b.usedSpan), "offset 72", "offset 4,176", "8 levels", "4 table frames");
    expect(l.blocks.find((x) => x.name === "d")!.off).toBe(72);
  });
});

describe("a simple scheduler", () => {
  test("frame and race table", () => {
    expect(K.FAKE_FRAME_BYTES).toBe(56);
    has("a-simple-scheduler", "56 bytes", "7 rows");
    const row = (m: K.RaceMode) => { const r = K.raceReport(m); return `${r.good} | ${r.corrupt} | ${r.deadlock} |`; };
    has("a-simple-scheduler", `no protection | ${row("none")}`, `\`cli\` and \`sti\` | ${row("cli")}`, `spinlock only | ${row("lock-only")}`);
    const two = K.raceReport("cli-two-cpus");
    has("a-simple-scheduler", `${two.good} | ${two.corrupt} | 0`, "Of 126 schedules, 100", "All 50 schedules", "Of 6 schedules, 4");
    expect(K.raceReport("irqsave-two-cpus").good).toBe(50);
  });
});

describe("userspace", () => {
  test("frames", () => {
    const os = K.bootedTinyOs();
    expect(os.totalFrames - K.TINY.kernelFrames).toBe(480);
    has("userspace", "480 frames", "takes 4 of them".replace("takes", "take"));
    const a = os.spawn("ping")!;
    expect(os.framesOf(a).length).toBe(7);
    const t = os.tasks.get(a)!;
    while (t.faultsHandled === 0) os.step();
    expect(os.framesOf(a).length).toBe(11);
    has("userspace", "7 frames", "11 frames", "error 6", "error 5", "error 7", "-14");
  });
  test("MSR values and GDT", () => {
    has("userspace", K.hexN(K.TINY_STAR, 16).replace("0X", "0x"), "0x40700", "0x0023001000000000", "0x00AFFA000000FFFF", "0x00CFF2000000FFFF", "0xC0000081", "0xC0000082", "0xC0000084");
    expect(K.hexN(K.TINY_STAR, 16)).toBe("0x0010000800000000");
    expect(K.TINY_SFMASK).toBe(0x40700);
  });
});
