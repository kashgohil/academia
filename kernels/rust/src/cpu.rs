//! The final GDT, the TSS, the MSRs for syscall, and the local APIC timer.
use crate::Global;
use crate::mem::{make_uncached, phys_to_virt};
use crate::serial::outb;
use core::arch::asm;

// lesson:gdt64
pub const KERNEL_CS: u16 = 0x08;
pub const KERNEL_DS: u16 = 0x10;
pub const USER_SS: u64 = 0x1B; // 0x18 | RPL 3
pub const USER_CS: u64 = 0x23; // 0x20 | RPL 3
const TSS_SEL: u16 = 0x28;

#[repr(C, packed)]
pub struct Tss {
    reserved0: u32,
    pub rsp0: u64, // the CPU loads this stack on a change from ring 3 to ring 0
    rsp12: [u64; 2],
    reserved1: u64,
    pub ist: [u64; 7], // IST1 is ist[0]
    reserved2: u64,
    reserved3: u16,
    iopb: u16,
}

#[repr(C, align(8))]
struct Gdt([u64; 7]);

static GDT: Global<Gdt> = Global::new(Gdt([
    0,
    0x00AF_9A00_0000_FFFF, // 0x08: kernel code, L = 1
    0x00CF_9200_0000_FFFF, // 0x10: kernel data
    0x00CF_F200_0000_FFFF, // 0x18: user data, DPL 3
    0x00AF_FA00_0000_FFFF, // 0x20: user code, DPL 3, L = 1
    0,                     // 0x28: the TSS takes two slots
    0,
]));
// end lesson:gdt64

pub static TSS: Global<Tss> = Global::new(Tss { reserved0: 0, rsp0: 0, rsp12: [0; 2], reserved1: 0, ist: [0; 7], reserved2: 0, reserved3: 0, iopb: 104 });

#[repr(C, align(16))]
struct Stack([u8; 16384]);
static DF_STACK: Global<Stack> = Global::new(Stack([0; 16384]));

pub fn init_gdt_tss() {
    let tss = TSS.get() as *mut Tss;
    let df_top = (DF_STACK.get() as *mut Stack as usize + 16384) as u64;
    unsafe { (*tss).ist[0] = df_top };

    let base = tss as u64;
    let limit = (core::mem::size_of::<Tss>() - 1) as u64;
    let gdt = GDT.get();
    gdt.0[5] = (limit & 0xFFFF) | ((base & 0xFF_FFFF) << 16) | (0x89 << 40) | (((limit >> 16) & 0xF) << 48) | (((base >> 24) & 0xFF) << 56);
    gdt.0[6] = base >> 32;

    #[repr(C, packed)]
    struct Ptr {
        limit: u16,
        base: u64,
    }
    let ptr = Ptr { limit: (core::mem::size_of::<Gdt>() - 1) as u16, base: gdt as *mut Gdt as u64 };
    unsafe {
        asm!(
            "lgdt [{ptr}]",
            "push {cs}",        // a far return is the way to load CS in 64-bit mode
            "lea {tmp}, [rip + 2f]",
            "push {tmp}",
            "retfq",
            "2:",
            "mov ds, {ds:x}",
            "mov es, {ds:x}",
            "mov ss, {ds:x}",
            "ltr {tss:x}",
            ptr = in(reg) &ptr,
            cs = in(reg) KERNEL_CS as u64,
            tmp = out(reg) _,
            ds = in(reg) KERNEL_DS,
            tss = in(reg) TSS_SEL,
        );
    }
}

pub unsafe fn rdmsr(msr: u32) -> u64 {
    let (lo, hi): (u32, u32);
    unsafe { asm!("rdmsr", in("ecx") msr, out("eax") lo, out("edx") hi, options(nomem, nostack, preserves_flags)) };
    ((hi as u64) << 32) | lo as u64
}

pub unsafe fn wrmsr(msr: u32, v: u64) {
    unsafe { asm!("wrmsr", in("ecx") msr, in("eax") v as u32, in("edx") (v >> 32) as u32, options(nomem, nostack, preserves_flags)) };
}

const LAPIC: usize = phys_to_virt(0xFEE0_0000);

fn lapic_write(reg: usize, v: u32) {
    unsafe { ((LAPIC + reg) as *mut u32).write_volatile(v) };
}

pub fn eoi() {
    lapic_write(0xB0, 0);
}

pub const TIMER_VECTOR: u32 = 32;
pub const SPURIOUS_VECTOR: u32 = 255;

/// Masks the old PIC and starts the local APIC timer in periodic mode.
pub fn init_timer(initial_count: u32) {
    unsafe {
        // Move the PIC away from the exception vectors, then mask every line.
        for (port, v) in [(0x20, 0x11), (0xA0, 0x11), (0x21, 0x20), (0xA1, 0x28), (0x21, 4), (0xA1, 2), (0x21, 1), (0xA1, 1), (0x21, 0xFF), (0xA1, 0xFF)] {
            outb(port, v);
        }
    }
    make_uncached(0xFEE0_0000);
    lapic_write(0xF0, 0x100 | SPURIOUS_VECTOR); // enable the APIC
    lapic_write(0x3E0, 3); //                      divide by 16
    lapic_write(0x320, (1 << 17) | TIMER_VECTOR); // periodic
    lapic_write(0x380, initial_count);
}
