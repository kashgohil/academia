/**
 * The "Writing a kernel" module: small models of bare-metal x86-64 and a composed kernel.
 *
 * - x86: control register and MSR bits, GDT, TSS and IDT encoders and decoders, the exception table,
 *   the double fault rules, the syscall MSR encoding, PIC and local APIC constants.
 * - boot: the reset-to-first-character stages on UEFI with Limine and BIOS with Multiboot2. Header checksum.
 * - link: a linker layout model: section order, base address, PT_LOAD segments, problems.
 * - modes: real mode to 64-bit mode as a machine. A wrong order triple-faults.
 * - irq: interrupt entry at stack level, and the fault cascade model.
 * - alloc: memory map carving, bitmap and free-list stack frame allocators, metadata sizes.
 * - heap: kernel heap bring-up on the real PageTable; FrameTableMem adapter; the recursion hazard.
 * - ksched: kernel threads at stack level, fabricated frames, preemption.
 * - race: the run queue against an interrupt, on the sync interleaving machine.
 * - userelf: real ELF files with real x86-64 bytes for user programs.
 * - tinyos: the composed kernel. Page tables, frames, scheduler, faults and syscalls, with an invariant checker.
 * - syscallentry: the syscall path, register by register.
 *
 * Numbers in *_MODEL, DEMO_* and TINY are model inputs. Bit positions and constants come from the Intel SDM,
 * the Multiboot2 specification and the Linux sources.
 */
export * from "./x86";
export * from "./boot";
export * from "./link";
export * from "./modes";
export * from "./irq";
export * from "./alloc";
export * from "./heap";
export * from "./ksched";
export * from "./race";
export * from "./userelf";
export * from "./tinyos";
export * from "./syscallentry";
