/**
 * The path from real mode to 64-bit mode as a small machine. Each action is one instruction or a short group,
 * and each applies the rule that the Intel SDM gives for it. The boot code has loaded an IDT with limit 0,
 * so any exception ends in a triple fault. That makes order mistakes visible at once.
 */
import { PageTable } from "../vm/pagetable";
import { PAGE_SIZE, SIZE_1G, SIZE_2M } from "../vm/addr";
import { CR0, CR4, EFER, code32, code64, data32, encodeDesc, setBit, testBit, type SegDesc } from "./x86";

export type CpuMode = "real" | "protected" | "compat" | "long" | "shutdown";

export const MODE_LABEL: Record<CpuMode, string> = {
  real: "real mode",
  protected: "protected mode",
  compat: "compatibility mode",
  long: "64-bit mode",
  shutdown: "shutdown",
};

export type MapKind = "none" | "identity" | "high-only";

export interface ModeState {
  cr0: number;
  cr3: MapKind;
  cr4: number;
  efer: number;
  gdt: boolean;
  /** Default operand size of the code that runs now. */
  csBits: 16 | 32 | 64;
  mode: CpuMode;
  /** The instruction that ended the machine, and why. */
  fault: string | null;
}

/** MODEL INPUT: CR0 as a BIOS leaves it. CD and NW are clear, so caches work. Only ET is set. */
export const START_CR0 = 1 << CR0.ET;

export const MODE_GDT: { sel: number; name: string; desc: SegDesc | null }[] = [
  { sel: 0x00, name: "null", desc: null },
  { sel: 0x08, name: "32-bit code", desc: code32(0) },
  { sel: 0x10, name: "data", desc: data32(0) },
  { sel: 0x18, name: "64-bit code", desc: code64(0) },
];
export const modeGdtValues = () => MODE_GDT.filter((g) => g.desc).map((g) => encodeDesc(g.desc!));

export const initialMode = (): ModeState => ({ cr0: START_CR0, cr3: "none", cr4: 0, efer: 0, gdt: false, csBits: 16, mode: "real", fault: null });

export type ModeAction = "lgdt" | "pe" | "ljmp32" | "pae" | "cr3" | "lme" | "pg" | "ljmp64";

export const ACTION_INFO: Record<ModeAction, { asm: string; label: string }> = {
  lgdt: { asm: "lgdt [gdt_ptr]", label: "Load the GDT" },
  pe: { asm: "mov cr0, eax    ; set PE", label: "CR0.PE = 1" },
  ljmp32: { asm: "jmp 0x08:pm32", label: "Far jump to 32-bit code" },
  pae: { asm: "mov cr4, eax    ; set PAE", label: "CR4.PAE = 1" },
  cr3: { asm: "mov cr3, eax    ; 4-level tables", label: "Load CR3" },
  lme: { asm: "wrmsr           ; EFER.LME = 1", label: "EFER.LME = 1" },
  pg: { asm: "mov cr0, eax    ; set PG", label: "CR0.PG = 1" },
  ljmp64: { asm: "jmp 0x18:lm64", label: "Far jump to 64-bit code" },
};

/** The order that Linux's trampoline and most small kernels use. */
export const GOOD_ORDER: ModeAction[] = ["lgdt", "pe", "ljmp32", "pae", "cr3", "lme", "pg", "ljmp64"];

const triple = (s: ModeState, why: string): ModeState => ({ ...s, mode: "shutdown", fault: why });
const END = "With IDT limit 0, the CPU cannot deliver it. That gives #DF, which also fails. The CPU shuts down, and the board resets.";

export interface ModeOpts {
  /** The tables that CR3 loads include an identity map of the running code. */
  identity: boolean;
}

export function applyMode(s0: ModeState, a: ModeAction, opts: ModeOpts = { identity: true }): { next: ModeState; text: string } {
  const s: ModeState = { ...s0 };
  if (s.mode === "shutdown") return { next: s, text: "The CPU is in shutdown. Only a reset helps." };
  const pe = testBit(s.cr0, CR0.PE), pg = testBit(s.cr0, CR0.PG), pae = testBit(s.cr4, CR4.PAE), lme = testBit(s.efer, EFER.LME), lma = testBit(s.efer, EFER.LMA);
  const die = (why: string) => { const next = triple(s, `${why} ${END}`); return { next, text: next.fault! }; };
  switch (a) {
    case "lgdt":
      s.gdt = true;
      return { next: s, text: "GDTR now points to the table. Nothing else changes: CS keeps its cached base and limit." };
    case "pe":
      s.cr0 = setBit(s.cr0, CR0.PE);
      if (s.mode === "real") s.mode = "protected";
      return { next: s, text: "PE is set, and the CPU is in protected mode. CS still holds its cached 16-bit attributes, so code still decodes as 16-bit." };
    case "ljmp32":
    case "ljmp64": {
      const wide = a === "ljmp64";
      if (!pe) return die("In real mode the selector is only a segment number, so this jump goes to a wrong address. The bytes there decode as garbage and raise #UD.");
      if (!s.gdt) return die("The selector indexes a GDT that is not loaded, so the limit check raises #GP.");
      if (wide) {
        if (!lma) return die("EFER.LMA is 0, so the CPU ignores L and runs the target as 32-bit code. The 64-bit bytes decode wrongly and raise #UD.");
        s.csBits = 64;
        s.mode = "long";
        return { next: s, text: "CS now holds a descriptor with L = 1. The CPU is in 64-bit mode and rip has 64 bits." };
      }
      s.csBits = 32;
      if (s.mode === "long") s.mode = "compat";
      return { next: s, text: lma ? "CS now holds a 32-bit descriptor. The CPU is in compatibility mode: long mode with 32-bit code." : "The far jump loads CS from the GDT. The prefetched 16-bit instructions are gone, and code now decodes as 32-bit." };
    }
    case "pae":
      s.cr4 = setBit(s.cr4, CR4.PAE);
      return { next: s, text: "PAE is set. Long mode needs the PAE table format with 64-bit entries." };
    case "cr3":
      s.cr3 = opts.identity ? "identity" : "high-only";
      return { next: s, text: opts.identity ? "CR3 holds the top table. Paging is off, so the CPU does not read the table yet." : "CR3 holds the top table. It maps only the higher half, and not the low addresses of this code. Paging is off, so nothing fails yet." };
    case "lme":
      if (pg) return die("Software cannot change EFER.LME while paging is on, so wrmsr raises #GP.");
      s.efer = setBit(s.efer, EFER.LME);
      return { next: s, text: "LME is set. It only arms long mode. LMA stays 0 until paging turns on." };
    case "pg":
      if (!pe) return die("Setting PG with PE clear raises #GP.");
      if (lme && !pae) return die("Setting PG with LME = 1 and PAE = 0 raises #GP.");
      if (!lme) {
        s.cr0 = setBit(s.cr0, CR0.PG);
        return die(pae
          ? "LME is 0, so this is 32-bit PAE paging. CR3 is read as four PDPTEs, not as a PML4. The next fetch raises #PF or the load raises #GP."
          : "LME is 0, so this is plain 32-bit paging. The CPU reads the 64-bit tables as 32-bit entries, and the next fetch raises #PF.");
      }
      if (s.cr3 === "none") { s.cr0 = setBit(s.cr0, CR0.PG); s.efer = setBit(s.efer, EFER.LMA); return die("CR3 still holds an old value, so the next fetch walks garbage and raises #PF."); }
      s.cr0 = setBit(s.cr0, CR0.PG);
      s.efer = setBit(s.efer, EFER.LMA);
      if (s.cr3 === "high-only") return die("The next instruction fetch uses the low address of this code. No table maps it, so the fetch raises #PF.");
      s.mode = "compat";
      return { next: s, text: "PG is set, and the CPU sets EFER.LMA. Long mode is active, but CS has L = 0. This is compatibility mode. The next fetch works only because of the identity map." };
  }
}

/** Runs a list of actions. Stops at the first fatal one. */
export function runModes(actions: readonly ModeAction[], opts: ModeOpts = { identity: true }): ModeState {
  let s = initialMode();
  for (const a of actions) {
    s = applyMode(s, a, opts).next;
    if (s.mode === "shutdown") return s;
  }
  return s;
}

/** Tries every order of the eight steps. */
export function countGoodOrders(opts: ModeOpts = { identity: true }): { total: number; good: number; shutdown: number; other: number } {
  const acts = [...GOOD_ORDER];
  let total = 0, good = 0, shutdown = 0, other = 0;
  const rec = (i: number) => {
    if (i === acts.length) {
      total++;
      const s = runModes(acts, opts);
      if (s.mode === "long") good++;
      else if (s.mode === "shutdown") shutdown++;
      else other++;
      return;
    }
    for (let j = i; j < acts.length; j++) {
      [acts[i], acts[j]] = [acts[j]!, acts[i]!];
      rec(i + 1);
      [acts[i], acts[j]] = [acts[j]!, acts[i]!];
    }
  };
  rec(0);
  return { total, good, shutdown, other };
}

// ---------------------------------------------------------------- the boot page tables

export const KERNEL_VMA = 0xffffffff80000000n;
export const DIRECT_MAP = 0xffff800000000000n;
/** MODEL INPUT: the physical address of the kernel. */
export const KERNEL_PHYS = 0x200000;

export interface BootMapOpts {
  /** Maps the first 4 MiB at the same addresses, with two 2 MiB leaves. */
  identity: boolean;
  /** Maps 2 MiB of kernel at KERNEL_VMA. */
  higherHalf: boolean;
  /** "2m" uses one huge leaf. "4k" uses 512 small leaves. */
  kernelPage: "2m" | "4k";
  /** Maps the first 1 GiB of physical memory at DIRECT_MAP with one huge leaf. */
  directMap: boolean;
}

/** Builds real tables with the same PageTable as the vm module. */
export function buildBootTables(o: BootMapOpts): PageTable {
  const pt = new PageTable();
  const k = { user: false, writable: true };
  if (o.identity) for (let i = 0; i < 2; i++) pt.map(i * SIZE_2M, (i * SIZE_2M) / PAGE_SIZE, { ...k, size: SIZE_2M });
  if (o.higherHalf) {
    if (o.kernelPage === "2m") pt.map(KERNEL_VMA, KERNEL_PHYS / PAGE_SIZE, { ...k, size: SIZE_2M });
    else for (let i = 0; i < 512; i++) pt.map(KERNEL_VMA + BigInt(i * PAGE_SIZE), KERNEL_PHYS / PAGE_SIZE + i, k);
  }
  if (o.directMap) pt.map(DIRECT_MAP, 0, { ...k, size: SIZE_1G });
  return pt;
}
