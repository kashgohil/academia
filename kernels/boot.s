// The shared first stage of both kernels. QEMU's direct boot (PVH) and GRUB (Multiboot2) both start here:
// 32-bit protected mode, paging off, EBX = boot information. high_entry belongs to each kernel.
    .intel_syntax noprefix

// lesson:headers
    .section .multiboot2, "a"
    .align 8
    .long 0xE85250D6              // Multiboot2 magic
    .long 0                       // architecture: i386
    .long 24                      // header length
    .long 0x17ADAF12              // checksum: the four fields sum to 0
    .short 0, 0                   // end tag: type 0, flags 0
    .long 8                       // end tag: size 8

    .section .note.pvh, "a", @note
    .long 4                       // name size: "Xen" and its 0 byte
    .long 4                       // data size
    .long 18                      // XEN_ELFNOTE_PHYS32_ENTRY
    .asciz "Xen"
    .long boot32                  // the 32-bit entry point
// end lesson:headers

// lesson:boot32
    .section .boot, "awx"
    .code32
    .globl boot32
boot32:
    cli
    mov esi, eax                  // the Multiboot2 magic, if GRUB started us
    mov edi, ebx                  // the boot information
    mov esp, offset boot_stack_top

    mov eax, cr4
    or  eax, 1 << 5               // CR4.PAE
    mov cr4, eax

    mov eax, offset boot_pml4
    mov cr3, eax

    mov ecx, 0xC0000080           // EFER
    rdmsr
    or  eax, 1 << 8               // EFER.LME
    wrmsr

    mov eax, cr0
    or  eax, 1 << 31              // CR0.PG: now LMA = 1, compatibility mode
    mov cr0, eax

    lgdt [gdt_ptr]
    .byte 0xEA                    // far jump: load CS with the L = 1 descriptor
    .long boot64
    .short 0x18

    .code64
boot64:
    mov ax, 0x10
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov edi, edi                  // clear the high halves: they are undefined after the switch
    mov esi, esi
    movabs rax, offset high_entry
    jmp rax
// end lesson:boot32

// lesson:gdt
    .align 8
boot_gdt:
    .quad 0
    .quad 0x00CF9A000000FFFF      // 0x08: 32-bit code
    .quad 0x00CF92000000FFFF      // 0x10: data
    .quad 0x00AF9A000000FFFF      // 0x18: 64-bit code, L = 1
gdt_ptr:
    .short 4 * 8 - 1
    .long boot_gdt
// end lesson:gdt

    .align 16
    .fill 4096, 1, 0
boot_stack_top:

// lesson:tables
    // Three maps of physical memory, with 2 MiB leaves:
    //   entry 0   identity, 1 GiB: keeps the running code valid for now
    //   entry 256 direct map at 0xFFFF800000000000, 4 GiB
    //   entry 511 the kernel at 0xFFFFFFFF80000000, 1 GiB
    .section .boot.tables, "aw"
    .balign 4096
    .globl boot_pml4
boot_pml4:
    .quad boot_pdpt_low + 3       // 3 = present, writable
    .fill 255, 8, 0
    .quad boot_pdpt_direct + 3
    .fill 254, 8, 0
    .quad boot_pdpt_high + 3
boot_pdpt_low:
    .quad boot_pd0 + 3
    .fill 511, 8, 0
boot_pdpt_direct:
    .quad boot_pd0 + 3, boot_pd1 + 3, boot_pd2 + 3, boot_pd3 + 3
    .fill 508, 8, 0
boot_pdpt_high:
    .fill 510, 8, 0
    .quad boot_pd0 + 3
    .quad 0

    .macro PD gib
    .set i, 0
    .rept 512
    .quad (\gib << 30) + (i << 21) + 0x83 // 0x83 = present, writable, 2 MiB
    .set i, i + 1
    .endr
    .endm

boot_pd0:
    PD 0
boot_pd1:
    PD 1
boot_pd2:
    PD 2
boot_pd3:
    PD 3
// end lesson:tables
