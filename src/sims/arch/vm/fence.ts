/**
 * What the TLB invalidation instructions of three ISAs remove, on which cores, and what happens when software
 * changes a PTE and skips the fence.
 *
 * RISC-V: SFENCE.VMA rs1, rs2 (privileged spec, "Supervisor Memory-Management Fence Instruction").
 * x86-64 with CR4.PCIDE = 1: INVLPG, INVPCID types 0 to 3, MOV to CR3 (Intel SDM vol. 2 and vol. 3A ch. 4).
 * AArch64: TLBI VAE1IS, VAAE1IS, ASIDE1IS, VMALLE1IS (Arm ARM). The IS forms reach every core in the Inner
 * Shareable domain. The other two ISAs act on the local core only; other cores need an IPI.
 *
 * The model keeps the minimum that each instruction must remove. The specs allow an implementation to
 * remove more ("it is always legal to over-fence").
 */

export interface TEntry {
  id: number;
  /** 4 KiB virtual page number. */
  vpn: number;
  asid: number;
  global: boolean;
  /** Physical frame that the entry maps. */
  pfn: number;
}

export type Isa = "riscv" | "x86" | "arm";

export interface FenceOp {
  isa: Isa;
  /** Display text, such as "sfence.vma a0, a1". */
  text: string;
  /** Which entries the instruction must remove, given the address and ASID operands and the current ASID. */
  removes: (e: TEntry, ctx: { va: number; asid: number; current: number }) => boolean;
  /** True when the operation reaches every core (Arm IS forms). */
  broadcast: boolean;
  note: string;
}

const covers = (e: TEntry, va: number) => e.vpn === Math.floor(va / 4096);

export const FENCES: FenceOp[] = [
  { isa: "riscv", text: "sfence.vma x0, x0", broadcast: false, removes: () => true, note: "rs1 = x0 and rs2 = x0: every entry, every address space, global ones too." },
  { isa: "riscv", text: "sfence.vma x0, a1", broadcast: false, removes: (e, c) => !e.global && e.asid === c.asid, note: "rs1 = x0: all addresses, but only for the ASID in a1. Global entries stay." },
  { isa: "riscv", text: "sfence.vma a0, x0", broadcast: false, removes: (e, c) => covers(e, c.va), note: "rs2 = x0: the page that holds the address in a0, for every ASID, global ones too." },
  { isa: "riscv", text: "sfence.vma a0, a1", broadcast: false, removes: (e, c) => covers(e, c.va) && !e.global && e.asid === c.asid, note: "One page for one ASID. Global entries stay." },
  { isa: "x86", text: "invlpg [va]", broadcast: false, removes: (e, c) => covers(e, c.va) && (e.global || e.asid === c.current), note: "The page, for the current PCID, and global entries for the page." },
  { isa: "x86", text: "invpcid type 0", broadcast: false, removes: (e, c) => covers(e, c.va) && !e.global && e.asid === c.asid, note: "Individual address: one page for one PCID, except global entries." },
  { isa: "x86", text: "invpcid type 1", broadcast: false, removes: (e, c) => !e.global && e.asid === c.asid, note: "Single context: every non-global entry of one PCID." },
  { isa: "x86", text: "invpcid type 2", broadcast: false, removes: () => true, note: "All contexts, global entries included." },
  { isa: "x86", text: "invpcid type 3", broadcast: false, removes: (e) => !e.global, note: "All contexts, except global entries." },
  { isa: "x86", text: "mov cr3 (bit 63 = 0)", broadcast: false, removes: (e, c) => !e.global && e.asid === c.asid, note: "Switch to the PCID in bits 11:0 and drop its non-global entries." },
  { isa: "x86", text: "mov cr3 (bit 63 = 1)", broadcast: false, removes: () => false, note: "Switch to the PCID and keep its entries: no invalidation." },
  { isa: "arm", text: "tlbi vae1is", broadcast: true, removes: (e, c) => covers(e, c.va) && (e.global || e.asid === c.asid), note: "By address and ASID, plus global entries for the address, on every core in the Inner Shareable domain." },
  { isa: "arm", text: "tlbi vaae1is", broadcast: true, removes: (e, c) => covers(e, c.va), note: "By address, for all ASIDs, on every core." },
  { isa: "arm", text: "tlbi aside1is", broadcast: true, removes: (e, c) => !e.global && e.asid === c.asid, note: "Every non-global entry of one ASID, on every core." },
  { isa: "arm", text: "tlbi vmalle1is", broadcast: true, removes: () => true, note: "Every EL1 stage 1 entry, on every core." },
];

export interface FenceResult { removed: number[][]; kept: TEntry[][] }

/** Applies a fence that core `core` executes to the TLBs of all cores. */
export function applyFence(tlbs: TEntry[][], op: FenceOp, core: number, ctx: { va: number; asid: number; current: number }): FenceResult {
  const removed: number[][] = [], kept: TEntry[][] = [];
  tlbs.forEach((t, i) => {
    const reach = op.broadcast || i === core;
    const out = reach ? t.filter((e) => op.removes(e, ctx)).map((e) => e.id) : [];
    removed.push(out);
    kept.push(t.filter((e) => !out.includes(e.id)));
  });
  return { removed, kept };
}

/** Two cores with a few cached translations: ASIDs 1 and 2, and one global kernel page. */
export function fenceScene(): TEntry[][] {
  let id = 0;
  const e = (vpn: number, asid: number, pfn: number, global = false): TEntry => ({ id: id++, vpn, asid, global, pfn });
  return [
    [e(0x10, 1, 0x200), e(0x11, 1, 0x201), e(0x10, 2, 0x350), e(0x40, 2, 0x351), e(0xfff00, 0, 0x001, true)],
    [e(0x10, 1, 0x200), e(0x40, 2, 0x351), e(0x12, 1, 0x202), e(0xfff00, 0, 0x001, true)],
  ];
}

// ---------------------------------------------------------------- the stale translation

export interface StaleStep { action: string; pte: number | null; tlb: number | null; result?: string; danger: boolean }

/**
 * The kernel unmaps page P (frame F), frees F, and gives F to another process. If it skips the fence, the
 * old TLB entry still maps P to F, and a load through P reads the other process's data.
 */
export function staleTimeline(fence: boolean): StaleStep[] {
  const F = 0x2a0;
  const steps: StaleStep[] = [];
  let pte: number | null = F, tlb: number | null = null;
  steps.push({ action: "Load from page P: TLB miss, the walker fills the entry", pte, tlb: (tlb = F), result: `frame 0x${F.toString(16)}`, danger: false });
  steps.push({ action: "Kernel clears the PTE of P (munmap)", pte: (pte = null), tlb, danger: false });
  if (fence) steps.push({ action: "Kernel executes the fence for P", pte, tlb: (tlb = null), danger: false });
  steps.push({ action: `Kernel frees frame 0x${F.toString(16)} and gives it to another process`, pte, tlb, danger: false });
  const hit = tlb !== null;
  steps.push({
    action: "Load from page P again", pte, tlb,
    result: hit ? `TLB hit: frame 0x${F.toString(16)}, which now holds the other process's data` : "TLB miss: the walker finds V = 0, so a page fault",
    danger: hit,
  });
  return steps;
}
