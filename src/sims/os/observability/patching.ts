/**
 * Live patching of kernel text, over real x86-64 bytes.
 *
 * With `-pg -mfentry`, the compiler starts each traceable function with `call __fentry__`. A build step records these
 * sites in the __mcount_loc section. At boot, ftrace rewrites each one to a 5-byte nop. To turn tracing on, ftrace
 * rewrites the nop to a call of its trampoline. Other CPUs run this code during the write, and five bytes are not
 * written atomically, so x86 uses text_poke_bp: first int3 on the first byte, then the tail, then the first byte.
 * A static key uses the same steps to turn a nop into a jmp.
 */

/** The 5-byte nop of x86-64: `nopl 0x0(%rax,%rax,1)`. */
export const NOP5: readonly number[] = [0x0f, 0x1f, 0x44, 0x00, 0x00];
export const OPCODE_CALL = 0xe8;
export const OPCODE_JMP = 0xe9;
export const INT3_BYTE = 0xcc;
export const SITE_LEN = 5;

/** Example addresses in the kernel text. */
export const FN_ENTRY = 0xffffffff81234560n;
export const TRAMPOLINE = 0xffffffff81a00000n;

/** The real bytes after the site: push rbp; mov rbp,rsp. */
export const BODY_AFTER_SITE: readonly number[] = [0x55, 0x48, 0x89, 0xe5];

/** `e8 rel32`: the offset counts from the next instruction. */
export function encodeRel32(site: bigint, target: bigint, opcode = OPCODE_CALL): number[] {
  const rel = Number(BigInt.asIntN(32, target - (site + 5n)));
  const u = rel >>> 0;
  return [opcode, u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff];
}
export const CALL_BYTES: readonly number[] = encodeRel32(FN_ENTRY, TRAMPOLINE);

/** What a CPU does if it fetches these bytes at the site, during a change from `from` to `to`. */
export type SiteView = "old" | "new" | "int3" | "torn";
export function viewOf(bytes: readonly number[], from: readonly number[], to: readonly number[]): SiteView {
  const same = (x: readonly number[]) => x.every((b, i) => b === bytes[i]);
  if (same(to)) return "new";
  if (same(from)) return "old";
  if (bytes[0] === INT3_BYTE) return "int3";
  return "torn";
}

export interface PatchStep { title: string; text: string; bytes: number[]; hot: number[]; view: SiteView; sync: boolean }

/** The steps of text_poke_bp from `from` to `to`. A CPU that runs the site at any step sees old, new, or a trap. */
export function textPokeBp(from: readonly number[], to: readonly number[]): PatchStep[] {
  const bytes = [...from];
  const out: PatchStep[] = [];
  const mk = (title: string, text: string, hot: number[], sync: boolean) => out.push({ title, text, bytes: [...bytes], hot, view: viewOf(bytes, from, to), sync });
  mk("Before", "All CPUs run the old instruction.", [], false);
  bytes[0] = INT3_BYTE;
  mk("Step 1: write int3", "One byte is an atomic write. A CPU that reaches the site now traps, and the handler emulates the instruction, so that CPU continues safely. An interrupt to all CPUs then clears old fetches.", [0], true);
  for (let i = 1; i < SITE_LEN; i++) bytes[i] = to[i]!;
  mk("Step 2: write the tail", "No CPU decodes these four bytes now, because each CPU stops at the int3 first. Sync all CPUs again.", [1, 2, 3, 4], true);
  bytes[0] = to[0]!;
  mk("Step 3: write the first byte", "The new instruction is whole. Sync all CPUs a last time, and then no CPU needs the int3 handler.", [0], true);
  return out;
}

/** A naive write of one byte at a time. Some steps show bytes that are not an instruction of either version. */
export function naivePatch(from: readonly number[], to: readonly number[]): PatchStep[] {
  const bytes = [...from];
  const out: PatchStep[] = [{ title: "Before", text: "All CPUs run the old instruction.", bytes: [...bytes], hot: [], view: "old", sync: false }];
  for (let i = 0; i < SITE_LEN; i++) {
    bytes[i] = to[i]!;
    const view = viewOf(bytes, from, to);
    out.push({ title: `Write byte ${i}`, text: view === "torn" ? "A CPU that fetches now gets an instruction from neither version. The result is a jump to a wrong address or a crash." : "The write is complete.", bytes: [...bytes], hot: [i], view, sync: false });
  }
  return out;
}

// ---------------------------------------------------------------------------- cost

/** MODEL INPUTS. Round figures of the right size, and not measurements. */
export const FTRACE_INPUTS = {
  /** A 5-byte nop: it decodes and takes one slot. */
  nopNs: 0.25,
  /** Call the trampoline, save the argument registers, restore them, return. */
  trampolineNs: 12,
  /** Check the filter, read the clock, reserve and commit in the ring buffer. */
  recordNs: 90,
  /** function_graph takes a second record at the return, and swaps a return address. */
  graphExtraNs: 130,
  /** A static tracepoint that is on: the jump, the argument copy and one record. */
  tracepointNs: 110,
  /** An int3-based kprobe: a trap, the handler and one record. */
  kprobeNs: 350,
  /** A uprobe: a trap from user mode into the kernel, and a return. */
  uprobeNs: 1500,
  /** Kernel functions called per second on one busy CPU. */
  callsPerSecond: 5e6,
} as const;

export type FnTracer = "off" | "function" | "function_graph";

export function costPerCallNs(t: FnTracer): number {
  const c = FTRACE_INPUTS;
  switch (t) {
    case "off": return c.nopNs;
    case "function": return c.trampolineNs + c.recordNs;
    case "function_graph": return c.trampolineNs + c.recordNs + c.graphExtraNs;
  }
}

/** The share of one CPU that the tracer takes at this call rate. */
export const cpuShareAt = (t: FnTracer, callsPerSecond: number) => Math.min(1, (costPerCallNs(t) * callsPerSecond) / 1e9);

/** Filtering: only `share` of the calls reach a patched site. The other sites stay as nops. */
export const filteredCostNs = (t: FnTracer, share: number) => share * costPerCallNs(t) + (1 - share) * costPerCallNs("off");
