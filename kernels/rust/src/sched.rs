//! Kernel threads, the context switch and a round-robin run queue.
use crate::cpu::TSS;
use crate::mem::{read_cr3, write_cr3};
use crate::{Global, user};
use alloc::alloc::{Layout, alloc};
use alloc::boxed::Box;
use alloc::collections::VecDeque;
use alloc::vec::Vec;
use core::arch::{asm, global_asm};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Ready,
    Running,
    Dead,
}

// lesson:thread
#[repr(C)]
pub struct Thread {
    rsp: u64, // must stay at offset 0: switch_to uses it
    pub stack_top: u64,
    pub state: State,
    pub cr3: u64,
    pub frames: Vec<usize>, // the frames to free when the thread is dead
}

global_asm!(r#"
    .text
    .globl switch_to
// extern "C" fn switch_to(prev: *mut Thread, next: *const Thread)
switch_to:
    push rbp
    push rbx
    push r12
    push r13
    push r14
    push r15
    mov [rdi], rsp        // save prev's stack pointer
    mov rsp, [rsi]        // load next's: this is the switch
    pop r15
    pop r14
    pop r13
    pop r12
    pop rbx
    pop rbp
    ret                   // a new thread "returns" to thread_trampoline

    .globl thread_trampoline
thread_trampoline:
    sti                   // the switch ran with interrupts off
    mov rdi, rbx          // the argument
    call r12              // the thread's function; rsp is 16-byte aligned here
    call thread_exit
    ud2
"#);
// end lesson:thread

// lesson:fabricate
#[allow(improper_ctypes)] // the assembly reads only the rsp field
unsafe extern "C" {
    fn switch_to(prev: *mut Thread, next: *const Thread);
    fn thread_trampoline();
}

/// Builds the stack that the first switch_to pops.
pub unsafe fn fabricate(t: &mut Thread, f: extern "C" fn(usize), arg: usize) {
    let mut sp = t.stack_top as *mut u64;
    let mut push = |v: u64| unsafe {
        sp = sp.sub(1);
        sp.write(v);
    };
    push(thread_trampoline as *const () as usize as u64); // ret
    push(0);                                 // rbp
    push(arg as u64);                        // rbx
    push(f as *const () as usize as u64);    // r12
    push(0);                                 // r13
    push(0);                                 // r14
    push(0);                                 // r15
    t.rsp = sp as u64;
}
// end lesson:fabricate

pub struct RunQueue {
    current: *mut Thread,
    queue: VecDeque<*mut Thread>,
}

impl RunQueue {
    fn push(&mut self, t: *mut Thread) {
        self.queue.push_back(t);
    }
    fn pop(&mut self) -> *mut Thread {
        self.queue.pop_front().expect("the run queue is empty: the boot thread must always be runnable")
    }
}

static RQ: Global<Option<RunQueue>> = Global::new(None);
static TICKS: Global<u64> = Global::new(0);
static PREEMPT: Global<bool> = Global::new(false);

fn rq() -> &'static mut RunQueue {
    RQ.get().as_mut().expect("the scheduler is not ready")
}

// lesson:schedule
/// Saves IF and turns interrupts off. The guard restores the old state.
pub struct IrqGuard(u64);
impl IrqGuard {
    pub fn new() -> IrqGuard {
        let flags: u64;
        unsafe { asm!("pushfq", "pop {}", "cli", out(reg) flags, options(nomem)) };
        IrqGuard(flags)
    }
}
impl Drop for IrqGuard {
    fn drop(&mut self) {
        if self.0 & (1 << 9) != 0 {
            unsafe { asm!("sti", options(nomem, nostack)) };
        }
    }
}

/// Picks the next thread. A running thread goes to the back of the queue. A dead thread does not.
pub fn schedule() {
    let _irq = IrqGuard::new();
    let rq = rq();
    let prev = rq.current;
    unsafe {
        if (*prev).state == State::Running {
            (*prev).state = State::Ready;
            rq.push(prev);
        }
        let next = rq.pop();
        (*next).state = State::Running;
        if next != prev {
            rq.current = next;
            activate(next);
            switch_to(prev, next);
        }
    }
}

/// Everything that the CPU reads from a place other than the kernel stack.
unsafe fn activate(next: *mut Thread) {
    unsafe {
        let top = (*next).stack_top;
        (*TSS.get()).rsp0 = top; //        for an interrupt that arrives in ring 3
        user::set_kernel_stack(top); //    for the syscall instruction
        if read_cr3() != (*next).cr3 {
            write_cr3((*next).cr3);
        }
    }
}
// end lesson:schedule

/// Makes the running boot code into the first thread. It becomes the idle thread.
pub fn init() {
    let boot = Box::into_raw(Box::new(Thread { rsp: 0, stack_top: 0, state: State::Running, cr3: read_cr3(), frames: Vec::new() }));
    *RQ.get() = Some(RunQueue { current: boot, queue: VecDeque::with_capacity(32) });
}

const STACK: usize = 16384;

/// A new thread. Its stack comes from the heap, and the bump allocator never frees it.
pub fn spawn(f: extern "C" fn(usize), arg: usize, cr3: u64, frames: Vec<usize>) -> *mut Thread {
    let stack = unsafe { alloc(Layout::from_size_align(STACK, 16).unwrap()) } as u64;
    let t = Box::into_raw(Box::new(Thread { rsp: 0, stack_top: stack + STACK as u64, state: State::Ready, cr3, frames }));
    unsafe { fabricate(&mut *t, f, arg) };
    let _irq = IrqGuard::new();
    rq().push(t);
    t
}

/// Takes a thread out of the run queue, so that it never runs again.
pub unsafe fn stop(t: *mut Thread) {
    let _irq = IrqGuard::new();
    rq().queue.retain(|&q| q != t);
    unsafe { (*t).state = State::Dead };
}

pub fn tick() {
    *TICKS.get() += 1;
    if *PREEMPT.get() {
        schedule();
    }
}

pub fn ticks() -> u64 {
    let _irq = IrqGuard::new();
    *TICKS.get()
}

pub fn enable_preemption() {
    *PREEMPT.get() = true;
}

/// Ends the current thread. It does not return.
pub fn kill_current() -> ! {
    let _irq = IrqGuard::new();
    unsafe { (*rq().current).state = State::Dead };
    schedule();
    unreachable!("a dead thread was scheduled");
}

#[unsafe(no_mangle)]
extern "C" fn thread_exit() -> ! {
    kill_current()
}

/// Gives the CPU away, then sleeps until the next interrupt if nothing else ran.
pub fn idle_once() {
    schedule();
    unsafe { asm!("sti; hlt", options(nomem, nostack)) };
}
