/**
 * RISC-V Sv39 as the privileged specification defines it ("Virtual Address Translation Process"): a 3-level
 * table of 8-byte PTEs, VPN[2..0] fields of 9 bits, leaf PTEs at any level (4 KiB pages, 2 MiB megapages,
 * 1 GiB gigapages), the superpage alignment rule, the U/SUM/MXR checks, and the two A/D schemes:
 * Svade (fault when A or D must be set) and Svadu (the walker sets them with an atomic update).
 *
 * The walker returns every step it takes, so that a view can show it as a state machine.
 * Not modelled: PMP and PMA checks, Svnapot, Svpbmt, the shadow stack rules and the hypervisor G-stage.
 */

export const PAGE_SHIFT = 12;
export const PAGE_BYTES = 1 << PAGE_SHIFT;
export const LEVELS = 3;
export const PTESIZE = 8;
export const VPN_BITS = 9;
export const VA_BITS = 39;

/** PTE bits 7..0. */
export const PTE = { V: 1n << 0n, R: 1n << 1n, W: 1n << 2n, X: 1n << 3n, U: 1n << 4n, G: 1n << 5n, A: 1n << 6n, D: 1n << 7n } as const;
export type PteBit = keyof typeof PTE;
export const PTE_BITS: PteBit[] = ["D", "A", "G", "U", "X", "W", "R", "V"];
/** Bits 63..54 must be zero when Svnapot and Svpbmt are not implemented (bit 63 is N, 62..61 are PBMT). */
export const RESERVED_MASK = ((1n << 10n) - 1n) << 54n;
const PPN_MASK = ((1n << 44n) - 1n) << 10n;

export type Access = "fetch" | "load" | "store";
/** scause exception codes for page faults. */
export const PAGE_FAULT_CAUSE: Record<Access, number> = { fetch: 12, load: 13, store: 15 };
export const CAUSE_NAME: Record<number, string> = { 12: "Instruction page fault", 13: "Load page fault", 15: "Store/AMO page fault" };
/** satp.MODE values for SXLEN = 64. */
export const SATP_MODE = { Bare: 0, Sv39: 8, Sv48: 9, Sv57: 10 } as const;

export const ptePpn = (pte: bigint) => (pte & PPN_MASK) >> 10n;
export const makePte = (ppn: bigint, bits: bigint) => (ppn << 10n) | bits;
export const has = (pte: bigint, b: PteBit) => (pte & PTE[b]) !== 0n;

/** VPN[i] of a virtual address: bits 12+9i .. 20+9i. */
export const vpn = (va: bigint, i: number) => Number((va >> BigInt(PAGE_SHIFT + VPN_BITS * i)) & 0x1ffn);

/** Bits 63..39 must all equal bit 38. */
export function vaIsValid(va: bigint): boolean {
  const top = (va >> 38n) & ((1n << 26n) - 1n);
  return top === 0n || top === (1n << 26n) - 1n;
}

/** Physical memory: one bigint per 8-byte word, keyed by byte address. Missing words read as 0. */
export class PhysMem {
  private words = new Map<bigint, bigint>();
  reads = 0;
  writes = 0;
  read(addr: bigint): bigint { this.reads++; return this.words.get(addr) ?? 0n; }
  peek(addr: bigint): bigint { return this.words.get(addr) ?? 0n; }
  write(addr: bigint, v: bigint) { this.writes++; this.words.set(addr, v); }
  /** Compare-and-swap, as the walker's atomic A/D update needs. */
  cas(addr: bigint, expect: bigint, v: bigint): boolean {
    if (this.peek(addr) !== expect) return false;
    this.write(addr, v);
    return true;
  }
  clone(): PhysMem { const m = new PhysMem(); for (const [k, v] of this.words) m.words.set(k, v); return m; }
}

export interface MapOpts { level?: 0 | 1 | 2; r?: boolean; w?: boolean; x?: boolean; u?: boolean; g?: boolean; a?: boolean; d?: boolean }

/** A page table in a PhysMem. Table frames come from a simple bump allocator. */
export class Sv39Space {
  readonly mem: PhysMem;
  readonly rootPpn: bigint;
  private nextPpn: bigint;
  constructor(rootPpn = 0x80000n, mem = new PhysMem()) {
    this.mem = mem;
    this.rootPpn = rootPpn;
    this.nextPpn = rootPpn + 1n;
  }
  /** Address of the PTE for va at level i, if every table above it exists. */
  pteAddr(va: bigint, level: number): bigint | null {
    let a = this.rootPpn << 12n;
    for (let i = LEVELS - 1; i >= level; i--) {
      const addr = a + BigInt(vpn(va, i) * PTESIZE);
      if (i === level) return addr;
      const pte = this.mem.peek(addr);
      if (!has(pte, "V") || has(pte, "R") || has(pte, "X")) return null;
      a = ptePpn(pte) << 12n;
    }
    return null;
  }
  /** Maps va to the physical page ppn at a level: 0 is 4 KiB, 1 is 2 MiB, 2 is 1 GiB. Creates tables as needed. */
  map(va: bigint, ppn: bigint, o: MapOpts = {}) {
    const level = o.level ?? 0;
    let a = this.rootPpn << 12n;
    for (let i = LEVELS - 1; i > level; i--) {
      const addr = a + BigInt(vpn(va, i) * PTESIZE);
      let pte = this.mem.peek(addr);
      if (!has(pte, "V")) { pte = makePte(this.nextPpn++, PTE.V | (o.g ? PTE.G : 0n)); this.mem.write(addr, pte); }
      a = ptePpn(pte) << 12n;
    }
    let bits = PTE.V;
    if (o.r ?? true) bits |= PTE.R;
    if (o.w) bits |= PTE.W;
    if (o.x) bits |= PTE.X;
    if (o.u ?? true) bits |= PTE.U;
    if (o.g) bits |= PTE.G;
    if (o.a ?? true) bits |= PTE.A;
    if (o.d ?? !!o.w) bits |= PTE.D;
    this.mem.write(a + BigInt(vpn(va, level) * PTESIZE), makePte(ppn, bits));
    this.mem.reads = 0;
    this.mem.writes = 0;
  }
}

export type StepKind = "va-check" | "read" | "pointer" | "leaf" | "align" | "u-check" | "rwx-check" | "ad" | "done" | "fault";

export interface WalkStep {
  kind: StepKind;
  /** Level i of the spec: 2 is the root table, 0 the last. */
  level: number;
  /** PTE address for a read or an A/D update. */
  addr?: bigint;
  pte?: bigint;
  ok: boolean;
  text: string;
}

export interface WalkOpts {
  priv?: "U" | "S";
  sum?: boolean;
  mxr?: boolean;
  /** "svade": fault when A = 0, or D = 0 on a store. "svadu": the walker sets them. */
  ad?: "svade" | "svadu";
}

export interface WalkResult {
  steps: WalkStep[];
  ok: boolean;
  pa?: bigint;
  /** Leaf level: 0, 1 or 2. */
  level?: number;
  cause?: number;
  stval?: bigint;
  /** Memory reads of PTEs, and A/D writes. */
  reads: number;
  writes: number;
}

const hex = (v: bigint) => `0x${v.toString(16)}`;

/** The translation algorithm for Sv39. It reads and may update mem. */
export function walkSv39(mem: PhysMem, rootPpn: bigint, va: bigint, access: Access, o: WalkOpts = {}): WalkResult {
  const priv = o.priv ?? "U";
  const ad = o.ad ?? "svadu";
  const steps: WalkStep[] = [];
  let reads = 0, writes = 0;
  const cause = PAGE_FAULT_CAUSE[access];
  const fault = (level: number, text: string): WalkResult => {
    steps.push({ kind: "fault", level, ok: false, text: `${CAUSE_NAME[cause]} (scause = ${cause}). ${text}` });
    return { steps, ok: false, cause, stval: va, reads, writes };
  };
  if (!vaIsValid(va)) {
    steps.push({ kind: "va-check", level: LEVELS - 1, ok: false, text: "Bits 63 to 39 are not all equal to bit 38." });
    return fault(LEVELS - 1, "No PTE was read.");
  }
  steps.push({ kind: "va-check", level: LEVELS - 1, ok: true, text: "Bits 63 to 39 equal bit 38." });
  let a = rootPpn << 12n;
  let i = LEVELS - 1;
  for (;;) {
    const addr = a + BigInt(vpn(va, i) * PTESIZE);
    let pte = mem.read(addr);
    reads++;
    steps.push({ kind: "read", level: i, addr, pte, ok: true, text: `Read the PTE at ${hex(a)} + VPN[${i}] × 8 = ${hex(addr)}.` });
    if (!has(pte, "V")) return fault(i, "V = 0.");
    if (!has(pte, "R") && has(pte, "W")) return fault(i, "W = 1 with R = 0 is a reserved encoding.");
    if ((pte & RESERVED_MASK) !== 0n) return fault(i, "A reserved bit (63 to 54) is set.");
    if (!has(pte, "R") && !has(pte, "X")) {
      if (i === 0) {
        steps.push({ kind: "pointer", level: i, addr, pte, ok: false, text: "R = W = X = 0 at the last level: a pointer with no level below it." });
        return fault(i, "The walk ran out of levels.");
      }
      if (has(pte, "D") || has(pte, "A") || has(pte, "U")) return fault(i, "D, A and U are reserved in a pointer entry, and one of them is set.");
      a = ptePpn(pte) << 12n;
      steps.push({ kind: "pointer", level: i, addr, pte, ok: true, text: `R = W = X = 0: a pointer to the next table at ${hex(a)}.` });
      i--;
      continue;
    }
    steps.push({ kind: "leaf", level: i, addr, pte, ok: true, text: `R or X is set: a leaf at level ${i}, so the page is ${["4 KiB", "2 MiB", "1 GiB"][i]}.` });
    if (i > 0) {
      const low = ptePpn(pte) & ((1n << BigInt(VPN_BITS * i)) - 1n);
      if (low !== 0n) {
        steps.push({ kind: "align", level: i, addr, pte, ok: false, text: `PPN bits below level ${i} are not zero: a misaligned superpage.` });
        return fault(i, "Misaligned superpage.");
      }
      steps.push({ kind: "align", level: i, addr, pte, ok: true, text: "The superpage is aligned to its size." });
    }
    const u = has(pte, "U");
    let uOk: boolean, uText: string;
    if (priv === "U") { uOk = u; uText = u ? "U = 1, and the access comes from U-mode." : "U = 0: U-mode cannot use this page."; }
    else if (!u) { uOk = true; uText = "U = 0: a supervisor page."; }
    else if (access === "fetch") { uOk = false; uText = "S-mode can never execute from a page with U = 1."; }
    else { uOk = !!o.sum; uText = o.sum ? "U = 1, and sstatus.SUM = 1 lets S-mode use it." : "U = 1, and sstatus.SUM = 0: S-mode cannot use it."; }
    steps.push({ kind: "u-check", level: i, ok: uOk, text: uText });
    if (!uOk) return fault(i, "The U bit check failed.");
    const r = has(pte, "R") || (!!o.mxr && has(pte, "X"));
    const allowed = access === "fetch" ? has(pte, "X") : access === "load" ? r : has(pte, "W");
    const need = access === "fetch" ? "X" : access === "load" ? (o.mxr ? "R, or X with MXR" : "R") : "W";
    steps.push({ kind: "rwx-check", level: i, ok: allowed, text: allowed ? `The ${access} needs ${need}, and the PTE has it.` : `The ${access} needs ${need}, and the PTE does not have it.` });
    if (!allowed) return fault(i, "Permission denied.");
    const needA = !has(pte, "A");
    const needD = access === "store" && !has(pte, "D");
    if (needA || needD) {
      const what = [needA ? "A" : "", needD ? "D" : ""].filter(Boolean).join(" and ");
      if (ad === "svade") {
        steps.push({ kind: "ad", level: i, addr, pte, ok: false, text: `${what} must be set, and Svade says: raise a page fault and let software set it.` });
        return fault(i, `${what} = 0 under Svade.`);
      }
      // Svadu: atomic compare-and-swap; on a failed compare, restart from the read (step 2 of the spec).
      const next = pte | PTE.A | (access === "store" ? PTE.D : 0n);
      if (!mem.cas(addr, pte, next)) { steps.push({ kind: "ad", level: i, addr, pte, ok: false, text: "The PTE changed under the walker. Read it again." }); continue; }
      writes++;
      steps.push({ kind: "ad", level: i, addr, pte: next, ok: true, text: `Svadu: set ${what} with one atomic update of the whole PTE.` });
      pte = next;
    }
    const offMask = (1n << BigInt(PAGE_SHIFT + VPN_BITS * i)) - 1n;
    const pa = ((ptePpn(pte) << 12n) & ~offMask) | (va & offMask);
    steps.push({ kind: "done", level: i, ok: true, text: `Physical address ${hex(pa)}.` });
    return { steps, ok: true, pa, level: i, reads, writes };
  }
}

/** The scene for the walker demo: a few user pages, a megapage, a kernel gigapage, and some traps. */
export function sv39Scene() {
  const s = new Sv39Space();
  const pages = [
    { name: "code", va: 0x0000_0000_1000_0000n, ppn: 0x81000n, o: { x: true } as MapOpts },
    { name: "heap", va: 0x0000_0000_2000_3000n, ppn: 0x81203n, o: { w: true, a: false, d: false } as MapOpts },
    { name: "read-only data", va: 0x0000_0000_1001_0000n, ppn: 0x81010n, o: {} as MapOpts },
    { name: "2 MiB megapage", va: 0x0000_0000_4000_0000n, ppn: 0x90000n, o: { level: 1, w: true } as MapOpts },
    { name: "misaligned megapage", va: 0x0000_0000_4020_0000n, ppn: 0x90201n, o: { level: 1, w: true } as MapOpts },
    { name: "kernel", va: 0xffff_ffc0_0000_0000n, ppn: 0xc0000n, o: { level: 2, w: true, x: true, u: false, g: true } as MapOpts },
  ];
  for (const p of pages) s.map(p.va, p.ppn, p.o);
  const samples = [
    ...pages.map((p) => ({ name: p.name, va: p.va + (p.o.level ? 0x12345n : 0x0abcn) })),
    { name: "unmapped", va: 0x0000_0000_2000_5000n },
    { name: "not sign-extended", va: 0x0000_0080_0000_0000n },
  ];
  return { space: s, samples };
}
