//! Physical frames and page tables.
use crate::Global;
use core::arch::asm;

pub const PAGE: usize = 4096;
pub const DIRECT_MAP: usize = 0xFFFF_8000_0000_0000;
const KERNEL_VMA: usize = 0xFFFF_FFFF_8000_0000;

pub const fn phys_to_virt(pa: usize) -> usize {
    pa + DIRECT_MAP
}

// lesson:bitmap
pub struct BitmapFrames {
    words: &'static mut [u64],
    hint: usize,
}

impl BitmapFrames {
    pub fn alloc(&mut self) -> Option<usize> {
        let n = self.words.len();
        for k in 0..n {
            let i = (self.hint + k) % n;
            let w = self.words[i];
            if w != u64::MAX {
                let bit = (!w).trailing_zeros() as usize;
                self.words[i] = w | (1 << bit);
                self.hint = i;
                return Some(i * 64 + bit);
            }
        }
        None
    }
    pub fn free(&mut self, frame: usize) {
        let (i, bit) = (frame / 64, frame % 64);
        debug_assert!(self.words[i] & (1 << bit) != 0, "double free");
        self.words[i] &= !(1 << bit);
        self.hint = self.hint.min(i);
    }
}
// end lesson:bitmap

impl BitmapFrames {
    pub fn free_count(&self) -> usize {
        self.words.iter().map(|w| w.count_zeros() as usize).sum()
    }
}

const MAX_FRAMES: usize = 256 * 1024 * 1024 / PAGE;
static BITS: Global<[u64; MAX_FRAMES / 64]> = Global::new([u64::MAX; MAX_FRAMES / 64]);
static FRAMES: Global<Option<BitmapFrames>> = Global::new(None);

pub fn frames() -> &'static mut BitmapFrames {
    FRAMES.get().as_mut().expect("frame allocator is not ready")
}

/// One usable range from the boot memory map.
#[derive(Clone, Copy)]
pub struct Range {
    pub base: usize,
    pub len: usize,
}

/// Carves the memory map: whole frames only, never below 1 MiB, never inside the kernel image.
pub fn init_frames(ranges: &[Range]) -> usize {
    unsafe extern "C" {
        static _kernel_end: u8;
    }
    let kernel_end = (&raw const _kernel_end) as usize - KERNEL_VMA;
    let bits = BITS.get();
    let mut frames = BitmapFrames { words: &mut bits[..], hint: 0 };
    let mut usable = 0;
    for r in ranges {
        let start = r.base.div_ceil(PAGE).max(kernel_end.div_ceil(PAGE));
        let end = ((r.base + r.len) / PAGE).min(MAX_FRAMES);
        for f in start..end {
            frames.free(f);
            usable += 1;
        }
    }
    *FRAMES.get() = Some(frames);
    usable
}

pub const P: u64 = 1;
pub const W: u64 = 2;
pub const U: u64 = 4;
const HUGE: u64 = 1 << 7;
const ADDR: u64 = 0x000F_FFFF_FFFF_F000;

fn table(pa: u64) -> &'static mut [u64; 512] {
    unsafe { &mut *(phys_to_virt((pa & ADDR) as usize) as *mut [u64; 512]) }
}

pub fn zeroed_frame() -> Option<usize> {
    let pa = frames().alloc()? * PAGE;
    unsafe { core::ptr::write_bytes(phys_to_virt(pa) as *mut u8, 0, PAGE) };
    Some(pa)
}

pub fn read_cr3() -> u64 {
    let v: u64;
    unsafe { asm!("mov {}, cr3", out(reg) v, options(nomem, nostack, preserves_flags)) };
    v
}

pub unsafe fn write_cr3(v: u64) {
    unsafe { asm!("mov cr3, {}", in(reg) v, options(nostack, preserves_flags)) };
}

/// Maps one 4 KiB page. It takes table frames from the frame allocator, never from the heap.
/// `new_tables` receives the frame of each table that it creates, so that a caller can free them.
pub fn map_page(pml4: u64, va: usize, pa: usize, flags: u64, new_tables: &mut dyn FnMut(usize)) -> bool {
    let mut t = table(pml4);
    for level in [39, 30, 21] {
        let e = &mut t[(va >> level) & 511];
        if *e & P == 0 {
            let Some(f) = zeroed_frame() else { return false };
            new_tables(f);
            *e = f as u64 | P | W | (flags & U);
        }
        assert!(*e & HUGE == 0, "map_page into a huge page");
        *e |= flags & U;
        t = table(*e);
    }
    t[(va >> 12) & 511] = pa as u64 | flags | P;
    unsafe { asm!("invlpg [{}]", in(reg) va, options(nostack, preserves_flags)) };
    true
}

/// True if user code may read this page: present and user at every level.
pub fn user_readable(pml4: u64, va: usize) -> bool {
    let mut t = table(pml4);
    for level in [39, 30, 21, 12] {
        let e = t[(va >> level) & 511];
        if e & P == 0 || e & U == 0 {
            return false;
        }
        if level > 12 {
            t = table(e);
        }
    }
    true
}

/// A new address space. The upper half comes from the kernel's table, so the kernel stays mapped.
pub fn new_address_space(kernel_pml4: u64) -> Option<usize> {
    let pa = zeroed_frame()?;
    let new = table(pa as u64);
    let old = table(kernel_pml4);
    new[256..512].copy_from_slice(&old[256..512]);
    Some(pa)
}

/// Removes the identity map, now that the CPU runs at high addresses.
pub fn drop_identity_map() {
    let cr3 = read_cr3();
    table(cr3)[0] = 0;
    unsafe { write_cr3(cr3) };
}

/// The APIC registers need uncached access. They sit in the 2 MiB leaf at 0xFEE00000 of the direct map.
pub fn make_uncached(pa: usize) {
    const PWT_PCD: u64 = 0x18;
    let pdpt = table(table(read_cr3())[256]);
    let pd = table(pdpt[pa >> 30]);
    pd[(pa >> 21) & 511] |= PWT_PCD;
    unsafe { write_cr3(read_cr3()) };
}
