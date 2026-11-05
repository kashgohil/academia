/* lesson:linker */
ENTRY(boot32)
KERNEL_VMA = 0xFFFFFFFF80000000;

PHDRS {
  boot   PT_LOAD FLAGS(7); /* rwx: the 32-bit stub, its GDT and its page tables */
  text   PT_LOAD FLAGS(5); /* r-x */
  rodata PT_LOAD FLAGS(4); /* r-- */
  data   PT_LOAD FLAGS(6); /* rw- */
  notes  PT_NOTE FLAGS(4);
}

SECTIONS {
  /* Linked and loaded at 1 MiB. The CPU runs this part with paging off. */
  . = 1M;
  .boot : { KEEP(*(.multiboot2)) *(.boot .boot.*) } :boot
  .note.pvh : { KEEP(*(.note.pvh)) } :boot :notes

  /* Linked in the top 2 GiB, but loaded just above the stub. AT() sets the load address. */
  . = ALIGN(4K) + KERNEL_VMA;
  _kernel_start = .;
  .text : AT(ADDR(.text) - KERNEL_VMA) { *(.text .text.*) } :text
  . = ALIGN(4K);
  .rodata : AT(ADDR(.rodata) - KERNEL_VMA) { *(.rodata .rodata.*) } :rodata
  . = ALIGN(4K);
  .data : AT(ADDR(.data) - KERNEL_VMA) { *(.data .data.*) } :data
  .bss : AT(ADDR(.bss) - KERNEL_VMA) { *(.bss .bss.*) *(COMMON) } :data
  _kernel_end = .;

  /DISCARD/ : { *(.comment) *(.eh_frame*) *(.note.GNU-stack) }
}
/* end lesson:linker */
