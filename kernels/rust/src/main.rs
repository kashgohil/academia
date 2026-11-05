//! A small x86-64 kernel that boots in QEMU and tests itself. Each stage below matches a lesson in
//! "Writing a kernel". Run it with `pnpm test:kernels`.
#![no_std]
#![no_main]

extern crate alloc;

mod cpu;
mod heap;
mod idt;
mod mem;
mod sched;
mod serial;
mod user;

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;
use core::arch::{asm, global_asm};
use core::cell::UnsafeCell;
use core::panic::PanicInfo;
use core::sync::atomic::{AtomicU64, Ordering};
use mem::{Range, phys_to_virt};

pub const EXIT_PASS: u8 = 0x10;
pub const EXIT_PANIC: u8 = 0x20;
pub const EXIT_DOUBLE_FAULT: u8 = 0x11;

/// A global for one CPU. The caller must keep interrupt handlers away, as IrqGuard does.
pub struct Global<T>(UnsafeCell<T>);
unsafe impl<T> Sync for Global<T> {}
impl<T> Global<T> {
    pub const fn new(v: T) -> Self {
        Global(UnsafeCell::new(v))
    }
    #[allow(clippy::mut_from_ref)]
    pub fn get(&self) -> &mut T {
        unsafe { &mut *self.0.get() }
    }
}

global_asm!(include_str!("../../boot.s"));

// lesson:high-entry
global_asm!(r#"
    .text
    .globl high_entry
high_entry:
    lea rsp, [rip + kernel_stack_top]
    call kmain
    ud2

    .section .bss
    .balign 16
    .skip 65536
kernel_stack_top:
"#);
// end lesson:high-entry

const MULTIBOOT2_MAGIC: u32 = 0x36D7_6289;
const PVH_MAGIC: u32 = 0x336E_C578;

struct BootInfo {
    protocol: &'static str,
    ranges: Vec<Range>,
    cmdline: String,
}

unsafe fn read<T: Copy>(pa: usize) -> T {
    unsafe { (phys_to_virt(pa) as *const T).read_unaligned() }
}

unsafe fn c_string(pa: usize) -> String {
    let mut s = String::new();
    for i in 0..256 {
        let b: u8 = unsafe { read(pa + i) };
        if b == 0 {
            break;
        }
        s.push(b as char);
    }
    s
}

/// A fixed list, because the heap needs frames and frames need this map.
fn parse_boot_info(info: usize, magic: u32, out: &mut [Range; 32]) -> (usize, &'static str, usize) {
    let mut n = 0;
    let mut push = |base: u64, len: u64| {
        if n < out.len() {
            out[n] = Range { base: base as usize, len: len as usize };
            n += 1;
        }
    };
    unsafe {
        if magic == MULTIBOOT2_MAGIC {
            let total: u32 = read(info);
            let mut off = 8;
            let mut cmdline = 0;
            while off < total as usize {
                let (kind, size): (u32, u32) = (read(info + off), read(info + off + 4));
                match kind {
                    0 => break,
                    1 => cmdline = info + off + 8,
                    6 => {
                        let entry: u32 = read(info + off + 8);
                        let mut e = off + 16;
                        while e < off + size as usize {
                            if read::<u32>(info + e + 16) == 1 {
                                push(read(info + e), read(info + e + 8));
                            }
                            e += entry as usize;
                        }
                    }
                    _ => {}
                }
                off += (size as usize + 7) & !7;
            }
            (n, "Multiboot2", cmdline)
        } else if read::<u32>(info) == PVH_MAGIC {
            let cmdline: u64 = read(info + 24);
            let map: u64 = read(info + 40);
            let count: u32 = read(info + 48);
            for i in 0..count as usize {
                let e = map as usize + i * 24;
                if read::<u32>(e + 16) == 1 {
                    push(read(e), read(e + 8));
                }
            }
            (n, "PVH", cmdline as usize)
        } else {
            panic!("unknown boot protocol: eax {:#x}", magic);
        }
    }
}

static COUNTERS: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

/// Never yields. It leaves the CPU only if the timer takes it away.
extern "C" fn spinner(i: usize) {
    loop {
        COUNTERS[i].fetch_add(1, Ordering::Relaxed);
    }
}

/// Runs the kernel into a stack with nothing mapped below it.
fn overflow_the_stack() -> ! {
    unsafe {
        asm!(
            "movabs rsp, 0xFFFFD00000001000",
            "push rax",
            options(noreturn),
        )
    }
}

fn run_self_test(kernel_pml4: u64, usable_frames: usize) {
    // Timer and preemption: two threads that never yield must both make progress.
    let threads = [sched::spawn(spinner, 0, kernel_pml4, Vec::new()), sched::spawn(spinner, 1, kernel_pml4, Vec::new())];
    while sched::ticks() < 20 {
        sched::idle_once();
    }
    let counts = [COUNTERS[0].load(Ordering::Relaxed), COUNTERS[1].load(Ordering::Relaxed)];
    println!("preempt: {} timer ticks, spinners ran {} and {} times", sched::ticks(), counts[0], counts[1]);
    assert!(counts[0] > 0 && counts[1] > 0, "a thread that never yields must not stop the other");
    for t in threads {
        unsafe { sched::stop(t) };
    }

    // Ring 3: five programs in five address spaces.
    let free_before = mem::frames().free_count();
    let tasks: Vec<_> = user::programs().iter().map(|code| user::spawn_user(kernel_pml4, code)).collect();
    println!("user: {} tasks, {} frames in use", tasks.len(), free_before - mem::frames().free_count());
    while tasks.iter().any(|&t| unsafe { (*t).state != sched::State::Dead }) {
        sched::idle_once();
    }
    let _irq = sched::IrqGuard::new();
    for &t in &tasks {
        for &f in unsafe { &(*t).frames } {
            mem::frames().free(f / mem::PAGE);
        }
    }
    drop(_irq);
    println!("frames: {} free before the tasks, {} after", free_before, mem::frames().free_count());
    assert_eq!(free_before, mem::frames().free_count(), "dead tasks must return every frame");
    println!("usable frames at boot: {}", usable_frames);
}

#[unsafe(no_mangle)]
extern "C" fn kmain(info: usize, magic: u32) -> ! {
    serial::init();
    println!("boot: 64-bit mode, kmain at {:#x}", kmain as *const () as usize);

    let mut ranges = [Range { base: 0, len: 0 }; 32];
    let (n, protocol, cmdline_pa) = parse_boot_info(info, magic, &mut ranges);
    let usable = mem::init_frames(&ranges[..n]);
    println!("memory: {} via {}, {} usable frames ({} MiB)", n, protocol, usable, usable * mem::PAGE / (1024 * 1024));

    // The boot information is in low memory, and the direct map still reaches it after this.
    mem::drop_identity_map();
    let kernel_pml4 = mem::read_cr3();
    heap::init(kernel_pml4);
    let boot = BootInfo { protocol, ranges: ranges[..n].to_vec(), cmdline: if cmdline_pa != 0 { unsafe { c_string(cmdline_pa) } } else { String::new() } };
    println!("boot info: {} ranges from {}, command line \"{}\"", boot.ranges.len(), boot.protocol, boot.cmdline);

    cpu::init_gdt_tss();
    idt::init();
    println!("cpu: GDT, TSS and IDT loaded");

    if boot.cmdline.contains("test=double-fault") {
        println!("test: overflowing the kernel stack");
        overflow_the_stack();
    }
    if boot.cmdline.contains("test=triple-fault") {
        println!("test: overflowing the kernel stack with no IDT");
        idt::load(0, 0);
        overflow_the_stack();
    }

    // The heap maps pages on demand. Everything above has allocated only a little.
    let before = heap::mapped_bytes();
    let mut v: Vec<u64> = (0..2000).collect();
    v.push(7);
    let boxed = Box::new(v.iter().sum::<u64>());
    println!("heap: sum {} in a vec of {}, mapped {} KiB more", *boxed, v.len(), (heap::mapped_bytes() - before) / 1024);
    assert_eq!(*boxed, 1_999_000 + 7);

    heap::premap(1024 * 1024);
    sched::init();
    unsafe { user::init_syscall() };
    cpu::init_timer(625_000); // 1 GHz bus / 16 / 625,000 = 100 Hz
    sched::enable_preemption();
    unsafe { asm!("sti", options(nomem, nostack)) };

    run_self_test(kernel_pml4, usable);

    println!("all tests passed");
    serial::qemu_exit(EXIT_PASS);
}

#[panic_handler]
fn panic(info: &PanicInfo) -> ! {
    unsafe { asm!("cli", options(nomem, nostack)) };
    use core::fmt::Write;
    let _ = writeln!(serial::Serial, "PANIC: {}", info);
    serial::qemu_exit(EXIT_PANIC);
}
