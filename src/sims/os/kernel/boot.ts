/**
 * The boot sequence from reset to the first printed character, as a list of stages, on two paths:
 * UEFI with the Limine protocol, and BIOS with GRUB and Multiboot2. Each stage says what the CPU and memory look like.
 */
import { RESET_VECTOR, hexN } from "./x86";

export type BootPath = "uefi" | "bios";
export type StageMode = "real" | "protected" | "long";
export type StageOwner = "firmware" | "loader" | "kernel";
export type RegionKind = "rom" | "firmware" | "loader" | "kernel" | "free" | "unknown" | "device";

export interface BootRegion { label: string; range: string; kind: RegionKind }

export interface BootStage {
  id: string;
  title: string;
  text: string;
  owner: StageOwner;
  mode: StageMode;
  paging: string;
  interrupts: string;
  stack: string;
  rip: string;
  regions: BootRegion[];
  console: string;
}

/** Multiboot2 constants, from the specification. */
export const MB2 = { HEADER_MAGIC: 0xe85250d6, BOOT_MAGIC: 0x36d76289, ARCH_I386: 0, SEARCH_BYTES: 32768, END_TAG_BYTES: 8, HEADER_FIXED_BYTES: 16 } as const;

/** The Multiboot2 header. The four fields must sum to 0 modulo 2^32. `tagBytes` excludes the end tag. */
export function mb2Header(tagBytes = 0) {
  const length = MB2.HEADER_FIXED_BYTES + tagBytes + MB2.END_TAG_BYTES;
  const checksum = (0x100000000 - ((MB2.HEADER_MAGIC + MB2.ARCH_I386 + length) % 0x100000000)) % 0x100000000;
  return { magic: MB2.HEADER_MAGIC, arch: MB2.ARCH_I386, length, checksum };
}

/** A BIOS loads the first sector here, and it requires 0x55 0xAA at the end of that sector. */
export const MBR = { LOAD_ADDR: 0x7c00, SECTOR_BYTES: 512, SIG_OFFSET: 510, SIG: [0x55, 0xaa] as const };

/** The classic text screen: each cell is a character byte and an attribute byte. */
export const VGA_TEXT = 0xb8000;
export const vgaCell = (ch: string, attr = 0x0f) => (attr << 8) | ch.charCodeAt(0);

/** The first serial port. Writing a byte to this I/O port sends it. */
export const COM1 = 0x3f8;

const ROM: BootRegion = { label: "Flash ROM, mapped below 4 GiB", range: "0xFF000000 to 0xFFFFFFFF", kind: "rom" };
const DRAM_UNKNOWN: BootRegion = { label: "DRAM: not usable yet", range: "whole range", kind: "unknown" };
const LOW = "0x00000000 to 0x0009FFFF";

const uefi = (): BootStage[] => {
  const fwRam: BootRegion = { label: "Firmware code and data (boot services)", range: "high DRAM", kind: "firmware" };
  const conv: BootRegion = { label: "Conventional memory: free", range: "rest of DRAM", kind: "free" };
  const kImage: BootRegion = { label: "Kernel image, at any physical address", range: "from the ELF PT_LOAD", kind: "kernel" };
  const loaderMem: BootRegion = { label: "Loader-reclaimable: tables, stack, boot data", range: "loader chooses", kind: "loader" };
  return [
    { id: "reset", title: "Power on: the reset vector", text: `One CPU core leaves reset in real mode. CS has a hidden base of 0xFFFF0000 and IP is 0xFFF0, so the first fetch is at ${hexN(RESET_VECTOR)}. That is 16 bytes below 4 GiB, in flash ROM. DRAM does not work yet. The other cores wait.`, owner: "firmware", mode: "real", paging: "off", interrupts: "off", stack: "none", rip: hexN(RESET_VECTOR), regions: [ROM, DRAM_UNKNOWN], console: "" },
    { id: "sec", title: "SEC and PEI: bring up memory", text: "The firmware enters flat 32-bit protected mode. It has no RAM yet, so it uses the CPU cache as RAM. Then it trains the memory controller. DRAM now works.", owner: "firmware", mode: "protected", paging: "off", interrupts: "off", stack: "in cache", rip: "in ROM", regions: [ROM, { label: "DRAM: trained and empty", range: "whole range", kind: "free" }], console: "" },
    { id: "dxe", title: "DXE and BDS: drivers and boot manager", text: "x86-64 firmware now runs in long mode with an identity map. It loads drivers, builds the memory map, sets up a framebuffer (GOP) and ACPI tables. The boot manager reads boot variables, or it uses the fallback path on the EFI system partition.", owner: "firmware", mode: "long", paging: "identity", interrupts: "firmware timer", stack: "firmware", rip: "in DRAM", regions: [ROM, fwRam, conv], console: "" },
    { id: "app", title: "The bootloader is a UEFI application", text: "The firmware loads \\EFI\\BOOT\\BOOTX64.EFI, a PE file, from the FAT partition and calls it. The loader runs in long mode on the identity map. It can use boot services for files, memory and the console.", owner: "loader", mode: "long", paging: "identity", interrupts: "firmware timer", stack: "firmware", rip: "in DRAM", regions: [ROM, fwRam, { label: "Bootloader", range: "firmware chooses", kind: "loader" }, conv], console: "" },
    { id: "load", title: "The loader reads the kernel ELF", text: "Limine reads its config, finds the kernel ELF, and copies each PT_LOAD to free memory. It scans the kernel for request structures. It builds new page tables: the kernel at its link address in the higher half, and a direct map of physical memory.", owner: "loader", mode: "long", paging: "identity", interrupts: "firmware timer", stack: "firmware", rip: "in DRAM", regions: [ROM, fwRam, { label: "Bootloader", range: "firmware chooses", kind: "loader" }, kImage, loaderMem, conv], console: "" },
    { id: "ebs", title: "ExitBootServices", text: "The loader calls GetMemoryMap and passes its key to ExitBootServices. If the map changed in between, the call fails and the loader must try again. After success, the firmware timer stops and boot services are gone. Runtime services stay.", owner: "loader", mode: "long", paging: "identity", interrupts: "off", stack: "firmware", rip: "in DRAM", regions: [ROM, { label: "Boot services memory: now free for use", range: "was firmware", kind: "free" }, kImage, loaderMem, conv], console: "" },
    { id: "entry", title: "Kernel entry", text: "The loader loads the new CR3, sets up a stack and a GDT, and jumps to the ELF entry point. The kernel starts in 64-bit mode, in the higher half, with IF clear. It has no IDT. Any fault now resets the machine.", owner: "kernel", mode: "long", paging: "higher half + direct map", interrupts: "off, no IDT", stack: "from the loader", rip: "0xFFFFFFFF80000000 + entry", regions: [ROM, kImage, loaderMem, conv], console: "" },
    { id: "print", title: "First character", text: "The kernel programs COM1 at I/O port 0x3F8 and writes one byte with the out instruction. QEMU shows it on your terminal. This one byte proves the CPU mode, the mapping, the stack and the toolchain.", owner: "kernel", mode: "long", paging: "higher half + direct map", interrupts: "off, no IDT", stack: "from the loader", rip: "in kmain", regions: [ROM, kImage, loaderMem, conv], console: "H" },
  ];
};

const bios = (): BootStage[] => {
  const ivt: BootRegion = { label: "IVT, BIOS data, and free low memory", range: LOW, kind: "firmware" };
  const hole: BootRegion = { label: "VGA memory and option ROMs", range: "0x000A0000 to 0x000FFFFF", kind: "device" };
  const free: BootRegion = { label: "Extended memory: free", range: "from 0x00100000", kind: "free" };
  const mbr: BootRegion = { label: "Boot sector", range: "0x00007C00 to 0x00007DFF", kind: "loader" };
  const grub: BootRegion = { label: "GRUB core and modules", range: "low memory", kind: "loader" };
  const kern: BootRegion = { label: "Kernel image", range: "from 0x00100000", kind: "kernel" };
  return [
    { id: "reset", title: "Power on: the reset vector", text: `The reset is the same on every x86 PC: real mode, and the first fetch at ${hexN(RESET_VECTOR)}. The ROM jumps to the BIOS.`, owner: "firmware", mode: "real", paging: "off", interrupts: "off", stack: "none", rip: hexN(RESET_VECTOR), regions: [ROM, DRAM_UNKNOWN], console: "" },
    { id: "post", title: "POST", text: "The BIOS trains DRAM, tests the machine and fills the interrupt vector table at address 0. It returns to real mode for the hand-off, so old disk calls keep working.", owner: "firmware", mode: "real", paging: "off", interrupts: "BIOS", stack: "BIOS", rip: "0xF0000 area", regions: [ivt, hole, free, ROM], console: "" },
    { id: "mbr", title: "The boot sector", text: "The BIOS reads the first 512-byte sector of the disk to 0x7C00. It checks for 0x55 0xAA at offset 510, and it jumps to 0000:7C00 with the drive number in DL. That sector has only room for a small loader.", owner: "loader", mode: "real", paging: "off", interrupts: "BIOS", stack: "loader", rip: "0x7C00", regions: [ivt, mbr, hole, free, ROM], console: "" },
    { id: "grub", title: "GRUB loads its core", text: "GRUB loads more of itself with BIOS disk calls (INT 0x13). It gets the memory map with INT 0x15, function 0xE820. It opens the A20 gate and moves to protected mode to reach memory above 1 MiB.", owner: "loader", mode: "protected", paging: "off", interrupts: "off", stack: "loader", rip: "low memory", regions: [ivt, grub, hole, free, ROM], console: "" },
    { id: "load", title: "GRUB finds the Multiboot2 header", text: "GRUB searches the first 32 KiB of the kernel file for the magic number 0xE85250D6. It checks that the header fields sum to 0. Then it loads each PT_LOAD at its physical address, normally 1 MiB.", owner: "loader", mode: "protected", paging: "off", interrupts: "off", stack: "loader", rip: "low memory", regions: [ivt, grub, hole, kern, free, ROM], console: "" },
    { id: "entry", title: "Kernel entry in 32-bit mode", text: "GRUB jumps to the kernel with EAX = 0x36D76289 and EBX = the address of the boot information. The CPU is in 32-bit protected mode with paging off. ESP is undefined, so the kernel must set up its own stack first. It must also load its own GDT.", owner: "kernel", mode: "protected", paging: "off", interrupts: "off, no IDT", stack: "undefined", rip: "0x00100000 + entry", regions: [ivt, hole, kern, free, ROM], console: "" },
    { id: "long", title: "The kernel's own path to long mode", text: "A 32-bit stub builds page tables, sets PAE, LME and PG, and does a far jump. The next lesson walks this path. UEFI and Limine did all of this before the kernel started.", owner: "kernel", mode: "long", paging: "identity + higher half", interrupts: "off, no IDT", stack: "kernel .bss", rip: "kernel", regions: [ivt, hole, kern, free, ROM], console: "" },
    { id: "print", title: "First character", text: "The kernel writes one byte to COM1. On this path it can also write the 16-bit cell 0x0F48 to the text screen at 0xB8000. That shows a white H on a black background. A UEFI boot has no text screen, only a framebuffer.", owner: "kernel", mode: "long", paging: "identity + higher half", interrupts: "off, no IDT", stack: "kernel .bss", rip: "in kmain", regions: [ivt, hole, kern, free, ROM], console: "H" },
  ];
};

export const bootStages = (path: BootPath): BootStage[] => (path === "uefi" ? uefi() : bios());
