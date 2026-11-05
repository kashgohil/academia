//! Ring 3: address spaces, the syscall path, and small test programs.
use crate::cpu::{USER_CS, USER_SS, rdmsr, wrmsr};
use crate::mem::{self, P, PAGE, U, W, phys_to_virt, read_cr3};
use crate::{Global, sched, serial};
use alloc::vec::Vec;
use core::arch::{asm, global_asm};

const EFER: u32 = 0xC000_0080;
const STAR: u32 = 0xC000_0081;
const LSTAR: u32 = 0xC000_0082;
const SFMASK: u32 = 0xC000_0084;
const KERNEL_GS_BASE: u32 = 0xC000_0102;

const USER_BASE: usize = 0x40_0000;
const USER_STACK_TOP: usize = 0x7FFF_F000;

#[repr(C)]
pub struct PerCpu {
    kernel_rsp: u64, // gs:[0]
    user_rsp: u64,   // gs:[8]
}

static PERCPU: Global<PerCpu> = Global::new(PerCpu { kernel_rsp: 0, user_rsp: 0 });

pub fn set_kernel_stack(top: u64) {
    PERCPU.get().kernel_rsp = top;
}

// lesson:enter-user
/// Enters ring 3 for the first time: fabricate an interrupt frame, then iretq.
/// GS base stays 0 for user code. init_syscall put the per-CPU pointer in KERNEL_GS_BASE,
/// so this path must not run swapgs: the first syscall does that swap.
pub unsafe fn enter_user(rip: u64, rsp: u64, cr3: u64) -> ! {
    unsafe {
        asm!(
            "mov cr3, {cr3}",
            "push {ss}",       // ss: user data, RPL 3
            "push {rsp}",
            "push 0x202",      // rflags: IF = 1
            "push {cs}",       // cs: user code, RPL 3
            "push {rip}",
            "iretq",
            cr3 = in(reg) cr3, rsp = in(reg) rsp, rip = in(reg) rip,
            ss = const USER_SS, cs = const USER_CS,
            options(noreturn),
        )
    }
}
// end lesson:enter-user

// lesson:syscall-entry
pub unsafe fn init_syscall() {
    let percpu = PERCPU.get() as *mut PerCpu;
    unsafe {
        wrmsr(EFER, rdmsr(EFER) | 1); // SCE
        wrmsr(STAR, (0x10u64 << 48) | (0x08u64 << 32));
        wrmsr(LSTAR, syscall_entry as *const () as usize as u64);
        wrmsr(SFMASK, 0x4_0700); // AC, DF, IF, TF
        wrmsr(KERNEL_GS_BASE, percpu as u64);
    }
}

unsafe extern "C" {
    fn syscall_entry();
}

global_asm!(r#"
    .text
    .globl syscall_entry
syscall_entry:
    swapgs
    mov gs:[8], rsp       // no free register yet
    mov rsp, gs:[0]
    push qword ptr gs:[8] // the user rsp
    push r11              // user rflags
    push rcx              // user rip
    push rax              // syscall number, then the return value
    push rdi
    push rsi
    push rdx
    push r10
    push r8
    push r9
    mov rdi, rsp          // the argument: &mut SyscallFrame
    call {handler}
    pop r9
    pop r8
    pop r10
    pop rdx
    pop rsi
    pop rdi
    pop rax
    pop rcx
    pop r11
    pop rsp               // the user stack; IF stays 0 until sysretq
    swapgs
    sysretq
"#, handler = sym handle_syscall);
// end lesson:syscall-entry

#[repr(C)]
pub struct SyscallFrame {
    r9: u64, r8: u64, r10: u64, rdx: u64, rsi: u64, rdi: u64,
    rax: u64, rcx: u64, r11: u64, user_rsp: u64,
}

// lesson:sys-write
const USER_TOP: u64 = 1 << 47;

extern "C" fn handle_syscall(f: &mut SyscallFrame) {
    // A non-canonical rcx would make sysretq raise #GP in ring 0 on Intel CPUs.
    if f.rcx >= USER_TOP {
        exit_from_syscall();
    }
    f.rax = match f.rax {
        1 => sys_write(f.rdi, f.rsi, f.rdx),
        60 => exit_from_syscall(),
        _ => -38i64 as u64, // -ENOSYS
    };
}

/// The other threads run with the GS state of user code, so undo the swapgs of syscall_entry.
fn exit_from_syscall() -> ! {
    unsafe { asm!("swapgs", options(nomem, nostack, preserves_flags)) };
    sched::kill_current();
}

fn sys_write(fd: u64, buf: u64, len: u64) -> u64 {
    if fd != 1 && fd != 2 {
        return -9i64 as u64; // -EBADF
    }
    if buf >= USER_TOP || len > USER_TOP - buf {
        return -14i64 as u64; // -EFAULT
    }
    // The range check is not enough. An unmapped page below USER_TOP would fault here, in ring 0.
    let cr3 = read_cr3();
    let first = buf as usize & !(PAGE - 1);
    let last = (buf + len).saturating_sub(1) as usize & !(PAGE - 1);
    if len > 0 && !(first..=last).step_by(PAGE).all(|va| mem::user_readable(cr3, va)) {
        return -14i64 as u64; // -EFAULT
    }
    for i in 0..len {
        serial::putc(unsafe { ((buf + i) as *const u8).read() });
    }
    len
}
// end lesson:sys-write

// lesson:user-programs
global_asm!(r#"
    .section .rodata.user, "a"

    // Prints its name three times, and spins between prints so that the timer preempts it.
    .macro PRINTER name, text
    .globl \name\()_start
\name\()_start:
    mov r12d, 3
2:
    mov eax, 1                  // write
    mov edi, 1
    lea rsi, [rip + 4f]
    lea rdx, [rip + 5f]
    sub rdx, rsi                // the length
    syscall
    mov ecx, 40000000
3:
    dec ecx
    jnz 3b
    dec r12d
    jnz 2b
    mov eax, 60                 // exit
    syscall
4:
    .ascii "\text\n"
5:
    .globl \name\()_end
\name\()_end:
    .endm

    PRINTER user_a, "user a"
    PRINTER user_b, "user b"

    // The kernel must refuse bad pointers and unknown calls, and must survive.
    .globl user_c_start
user_c_start:
    mov eax, 1
    mov edi, 1
    movabs rsi, 0xFFFFFFFF80000000 // kernel memory
    mov edx, 16
    syscall
    cmp rax, -14
    jne 9f
    mov eax, 1
    mov edi, 1
    mov esi, 0x1000             // below USER_TOP, but not mapped
    mov edx, 16
    syscall
    cmp rax, -14
    jne 9f
    mov eax, 999                // no such call
    syscall
    cmp rax, -38
    jne 9f
    mov eax, 1
    mov edi, 1
    lea rsi, [rip + 8f]
    lea rdx, [rip + 7f]
    sub rdx, rsi
    syscall
    mov eax, 60
    syscall
9:
    ud2
8:
    .ascii "user c: bad pointers and bad calls refused\n"
7:
    .globl user_c_end
user_c_end:

    // Reads kernel memory: a page fault that kills only this task.
    .globl user_d_start
user_d_start:
    movabs rax, 0xFFFFFFFF80000000
    mov rax, [rax]
    ud2
    .globl user_d_end
user_d_end:

    // A privileged instruction in ring 3: #GP, which kills only this task.
    .globl user_e_start
user_e_start:
    cli
    ud2
    .globl user_e_end
user_e_end:
"#);
// end lesson:user-programs

extern "C" fn user_thread(cr3: usize) {
    unsafe { enter_user(USER_BASE as u64, USER_STACK_TOP as u64, cr3 as u64) }
}

/// Loads a flat program at USER_BASE in a new address space, and starts a thread for it.
pub fn spawn_user(kernel_pml4: u64, code: &[u8]) -> *mut sched::Thread {
    let mut owned = Vec::new();
    let pml4 = mem::new_address_space(kernel_pml4).expect("no frame for a top-level table");
    owned.push(pml4);

    for (i, chunk) in code.chunks(PAGE).enumerate() {
        let f = mem::zeroed_frame().expect("no frame for code");
        unsafe { core::ptr::copy_nonoverlapping(chunk.as_ptr(), phys_to_virt(f) as *mut u8, chunk.len()) };
        assert!(mem::map_page(pml4 as u64, USER_BASE + i * PAGE, f, P | U, &mut |t| owned.push(t)));
        owned.push(f);
    }
    let stack = mem::zeroed_frame().expect("no frame for a stack");
    assert!(mem::map_page(pml4 as u64, USER_STACK_TOP - PAGE, stack, P | W | U, &mut |t| owned.push(t)));
    owned.push(stack);

    sched::spawn(user_thread, pml4, pml4 as u64, owned)
}

macro_rules! program {
    ($start:ident, $end:ident) => {{
        unsafe extern "C" {
            static $start: u8;
            static $end: u8;
        }
        let s = &raw const $start;
        let e = &raw const $end;
        unsafe { core::slice::from_raw_parts(s, e as usize - s as usize) }
    }};
}

pub fn programs() -> [&'static [u8]; 5] {
    [
        program!(user_a_start, user_a_end),
        program!(user_b_start, user_b_end),
        program!(user_c_start, user_c_end),
        program!(user_d_start, user_d_end),
        program!(user_e_start, user_e_end),
    ]
}
