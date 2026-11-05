//! The IDT, the interrupt stubs and the trap handler.
use crate::cpu::{self, TSS};
use crate::{Global, println, sched, serial};
use core::arch::{asm, global_asm};

// lesson:gate
#[repr(C, packed)]
#[derive(Clone, Copy)]
pub struct Gate {
    offset_low: u16,
    selector: u16,
    ist: u8,        // bits 0..2 are the IST index
    flags: u8,      // P, DPL, 0, type: 0x8E = interrupt gate, ring 0
    offset_mid: u16,
    offset_high: u32,
    reserved: u32,
}

impl Gate {
    pub const fn missing() -> Gate {
        Gate { offset_low: 0, selector: 0, ist: 0, flags: 0, offset_mid: 0, offset_high: 0, reserved: 0 }
    }
    pub fn new(handler: usize, ist: u8) -> Gate {
        Gate {
            offset_low: handler as u16,
            selector: 0x08,
            ist,
            flags: 0x8E,
            offset_mid: (handler >> 16) as u16,
            offset_high: (handler >> 32) as u32,
            reserved: 0,
        }
    }
}

#[repr(C)]
pub struct TrapFrame {
    pub r15: u64, pub r14: u64, pub r13: u64, pub r12: u64,
    pub r11: u64, pub r10: u64, pub r9: u64, pub r8: u64,
    pub rdi: u64, pub rsi: u64, pub rbp: u64, pub rbx: u64,
    pub rdx: u64, pub rcx: u64, pub rax: u64,
    pub vector: u64,
    pub error: u64,
    // Pushed by the CPU:
    pub rip: u64, pub cs: u64, pub rflags: u64, pub rsp: u64, pub ss: u64,
}

// One stub per vector. Vectors with no CPU error code push a dummy.
global_asm!(r#"
    .text
    .macro STUB_NOERR vec
    .globl isr\vec
isr\vec:
    push 0
    push \vec
    jmp isr_common
    .endm

    .macro STUB_ERR vec
    .globl isr\vec
isr\vec:
    push \vec
    jmp isr_common
    .endm

    STUB_NOERR 0
    STUB_ERR 8
    STUB_ERR 13
    STUB_ERR 14
    STUB_NOERR 32
    STUB_NOERR 255

isr_common:
    push rax
    push rcx
    push rdx
    push rbx
    push rbp
    push rsi
    push rdi
    push r8
    push r9
    push r10
    push r11
    push r12
    push r13
    push r14
    push r15
    cld
    mov rdi, rsp          // the argument: &mut TrapFrame
    call {handler}
    pop r15
    pop r14
    pop r13
    pop r12
    pop r11
    pop r10
    pop r9
    pop r8
    pop rdi
    pop rsi
    pop rbp
    pop rbx
    pop rdx
    pop rcx
    pop rax
    add rsp, 16           // the vector and the error code
    iretq
"#, handler = sym handle_trap);
// end lesson:gate

static IDT: Global<[Gate; 256]> = Global::new([Gate::missing(); 256]);

unsafe extern "C" {
    fn isr0();
    fn isr8();
    fn isr13();
    fn isr14();
    fn isr32();
    fn isr255();
}

pub fn init() {
    let idt = IDT.get();
    idt[0] = Gate::new(isr0 as *const () as usize, 0);
    idt[8] = Gate::new(isr8 as *const () as usize, 1); // the double fault gets its own stack
    idt[13] = Gate::new(isr13 as *const () as usize, 0);
    idt[14] = Gate::new(isr14 as *const () as usize, 0);
    idt[32] = Gate::new(isr32 as *const () as usize, 0);
    idt[255] = Gate::new(isr255 as *const () as usize, 0);
    load(idt.as_ptr() as u64, (core::mem::size_of::<[Gate; 256]>() - 1) as u16);
    let _ = TSS.get();
}

pub fn load(base: u64, limit: u16) {
    #[repr(C, packed)]
    struct Ptr {
        limit: u16,
        base: u64,
    }
    let ptr = Ptr { limit, base };
    unsafe { asm!("lidt [{}]", in(reg) &ptr, options(nostack, preserves_flags)) };
}

// lesson:trap
fn read_cr2() -> u64 {
    let v: u64;
    unsafe { asm!("mov {}, cr2", out(reg) v, options(nomem, nostack, preserves_flags)) };
    v
}

extern "C" fn handle_trap(f: &mut TrapFrame) {
    let from_user = f.cs & 3 == 3;
    match f.vector {
        14 => page_fault(f, read_cr2()),
        32 => {
            // First the EOI: tick may switch to another thread, and that thread may run
            // for a long time before this function continues.
            cpu::eoi();
            sched::tick();
        }
        255 => {} // a spurious interrupt needs no EOI
        8 => {
            println!("double fault: rsp {:#x}, on the IST stack", f as *mut TrapFrame as u64);
            serial::qemu_exit(crate::EXIT_DOUBLE_FAULT);
        }
        v if from_user => {
            println!("trap {} in user code at {:#x}: task killed", v, f.rip);
            sched::kill_current();
        }
        v => panic!("trap {} at {:#x}, error {:#x}", v, f.rip, f.error),
    }
}

fn page_fault(f: &mut TrapFrame, addr: u64) {
    let present = f.error & 1 != 0;
    let write = f.error & 2 != 0;
    let user = f.error & 4 != 0;
    if user {
        println!("page fault in user code at {:#x}: present={} write={}: task killed", addr, present, write);
        sched::kill_current();
    }
    panic!("page fault at {:#x}: present={} write={} user={}", addr, present, write, user);
}
// end lesson:trap
