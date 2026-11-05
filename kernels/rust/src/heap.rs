//! The kernel heap: a bump allocator that maps pages on demand.
use crate::mem::{self, P, W};
use core::alloc::{GlobalAlloc, Layout};
use core::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

static KERNEL_PML4: AtomicU64 = AtomicU64::new(0);

/// Creates the heap's top-level entry now, so that every later address space copies it.
pub fn init(kernel_pml4: u64) {
    KERNEL_PML4.store(kernel_pml4, Ordering::Relaxed);
}

// lesson:heap
pub const PAGE: usize = 4096;
pub const HEAP_BASE: usize = 0xFFFF_C000_0000_0000;

// Takes frames from the frame allocator, never from the heap.
fn map_heap_page(va: usize) -> bool {
    let Some(frame) = mem::frames().alloc() else { return false };
    mem::map_page(KERNEL_PML4.load(Ordering::Relaxed), va, frame * PAGE, P | W, &mut |_| {})
}

pub struct Bump {
    next: AtomicUsize,   // offset of the next free byte
    mapped: AtomicUsize, // bytes mapped from HEAP_BASE
}

// One CPU, and callers hold no lock that an interrupt handler also takes.
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let _irq = crate::sched::IrqGuard::new();
        let start = (self.next.load(Ordering::Relaxed) + l.align() - 1) & !(l.align() - 1);
        let end = start + l.size();
        while self.mapped.load(Ordering::Relaxed) < end {
            let va = HEAP_BASE + self.mapped.load(Ordering::Relaxed);
            if !map_heap_page(va) {
                return core::ptr::null_mut();
            }
            self.mapped.fetch_add(PAGE, Ordering::Relaxed);
        }
        self.next.store(end, Ordering::Relaxed);
        (HEAP_BASE + start) as *mut u8
    }
    unsafe fn dealloc(&self, _p: *mut u8, _l: Layout) {
        // A bump allocator frees nothing.
    }
}

#[global_allocator]
static HEAP: Bump = Bump { next: AtomicUsize::new(0), mapped: AtomicUsize::new(0) };
// end lesson:heap

/// Maps pages ahead of time, so that later frame counts do not include the heap's own growth.
pub fn premap(bytes: usize) {
    while HEAP.mapped.load(Ordering::Relaxed) < bytes {
        assert!(map_heap_page(HEAP_BASE + HEAP.mapped.load(Ordering::Relaxed)));
        HEAP.mapped.fetch_add(PAGE, Ordering::Relaxed);
    }
}

pub fn mapped_bytes() -> usize {
    HEAP.mapped.load(Ordering::Relaxed)
}
