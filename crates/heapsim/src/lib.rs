//! Heap allocator simulators with a shared region model, exported to WebAssembly.
//!
//! Every allocator manages a simulated heap of `cap` bytes (addresses 0..cap) and can
//! describe it as an ordered tiling of regions: free, metadata, padding, live payload,
//! slack (allocated but unused) and dead (freed but not reclaimed).

pub mod arena;
pub mod buddy;
pub mod bump;
pub mod freelist;
pub mod pool;
pub mod region;
pub mod sizeclass;
pub mod slab;

use region::*;
use std::cell::RefCell;
use std::collections::HashMap;

pub const KIND_BUMP: u32 = 0;
pub const KIND_ARENA: u32 = 1;
pub const KIND_POOL: u32 = 2;
pub const KIND_FREELIST: u32 = 3;
pub const KIND_BUDDY: u32 = 4;
pub const KIND_SLAB: u32 = 5;
pub const KIND_SIZECLASS: u32 = 6;

/// Builds an allocator. Parameter meaning depends on the kind:
/// - arena: a = chunk size
/// - pool: a = slot size
/// - freelist: a = fit (0 first, 1 next, 2 best, 3 worst), b = coalesce (0/1)
/// - slab: a = page size, b = keep one empty slab per cache (0/1)
/// - sizeclass: a = page size, b = fine classes (0/1)
pub fn make(kind: u32, cap: u32, a: u32, b: u32) -> Option<Box<dyn Allocator>> {
    Some(match kind {
        KIND_BUMP => Box::new(bump::Bump::new(cap)),
        KIND_ARENA => Box::new(arena::Arena::new(cap, a)),
        KIND_POOL => Box::new(pool::Pool::new(cap, a)),
        KIND_FREELIST => {
            let fit = match a {
                1 => freelist::Fit::Next,
                2 => freelist::Fit::Best,
                3 => freelist::Fit::Worst,
                _ => freelist::Fit::First,
            };
            Box::new(freelist::FreeList::new(cap, fit, b != 0))
        }
        KIND_BUDDY => Box::new(buddy::Buddy::new(cap)),
        KIND_SLAB => Box::new(slab::Slab::new(cap, a, b != 0)),
        KIND_SIZECLASS => Box::new(sizeclass::SizeClass::new(cap, a, b != 0)),
        _ => return None,
    })
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct Stats {
    pub live: u32,
    pub meta: u32,
    pub pad: u32,
    pub slack: u32,
    pub dead: u32,
    pub free: u32,
    pub largest_free: u32,
    pub live_count: u32,
}

pub fn stats(r: &Regions) -> Stats {
    let mut s = Stats::default();
    for g in &r.0 {
        match g.kind {
            LIVE => {
                s.live += g.len;
                s.live_count += 1;
            }
            META => s.meta += g.len,
            PAD => s.pad += g.len,
            SLACK => s.slack += g.len,
            DEAD => s.dead += g.len,
            _ => {
                s.free += g.len;
                s.largest_free = s.largest_free.max(g.len);
            }
        }
    }
    s
}

/// An allocator plus allocation ids (so the UI can track an allocation across moves of focus).
pub struct Heap {
    pub alloc: Box<dyn Allocator>,
    ids: HashMap<u32, u32>,
    next_id: u32,
    buf: Vec<u32>,
}

impl Heap {
    pub fn new(alloc: Box<dyn Allocator>) -> Self {
        Heap { alloc, ids: HashMap::new(), next_id: 1, buf: Vec::new() }
    }
    pub fn malloc(&mut self, size: u32, align: u32) -> Option<u32> {
        let align = if align.is_power_of_two() { align } else { 1 };
        let a = self.alloc.alloc(size.max(1), align)?;
        self.ids.insert(a, self.next_id);
        self.next_id += 1;
        Some(a)
    }
    pub fn id_of(&self, addr: u32) -> u32 {
        self.ids.get(&addr).copied().unwrap_or(0)
    }
}

// ---------------- WebAssembly C ABI ----------------

thread_local! {
    static HEAPS: RefCell<Vec<Option<Heap>>> = const { RefCell::new(Vec::new()) };
}

fn with<R>(h: u32, f: impl FnOnce(&mut Heap) -> R) -> Option<R> {
    HEAPS.with(|hs| hs.borrow_mut().get_mut(h as usize).and_then(|x| x.as_mut()).map(f))
}

#[no_mangle]
pub extern "C" fn heap_new(kind: u32, cap: u32, a: u32, b: u32) -> u32 {
    let Some(alloc) = make(kind, cap, a, b) else { return u32::MAX };
    HEAPS.with(|hs| {
        let mut hs = hs.borrow_mut();
        let heap = Some(Heap::new(alloc));
        match hs.iter().position(|x| x.is_none()) {
            Some(i) => {
                hs[i] = heap;
                i as u32
            }
            None => {
                hs.push(heap);
                (hs.len() - 1) as u32
            }
        }
    })
}

#[no_mangle]
pub extern "C" fn heap_drop(h: u32) {
    HEAPS.with(|hs| {
        if let Some(x) = hs.borrow_mut().get_mut(h as usize) {
            *x = None;
        }
    });
}

/// Returns the payload address or u32::MAX on failure.
#[no_mangle]
pub extern "C" fn heap_alloc(h: u32, size: u32, align: u32) -> u32 {
    with(h, |x| x.malloc(size, align)).flatten().unwrap_or(u32::MAX)
}

#[no_mangle]
pub extern "C" fn heap_free(h: u32, addr: u32) -> u32 {
    with(h, |x| x.alloc.free(addr) as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn heap_reset(h: u32) {
    with(h, |x| x.alloc.reset());
}

#[no_mangle]
pub extern "C" fn heap_mark(h: u32) -> u32 {
    with(h, |x| x.alloc.mark()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn heap_restore(h: u32, m: u32) {
    with(h, |x| x.alloc.restore(m));
}

/// Fills the heap's buffer with (off, len, kind, id) quadruples; returns the region count.
/// Read them at `heap_buf(h)` before the next call.
#[no_mangle]
pub extern "C" fn heap_regions(h: u32) -> u32 {
    with(h, |x| {
        let r = x.alloc.regions();
        let mut buf = Vec::with_capacity(r.0.len() * 4);
        for g in &r.0 {
            let id = if g.kind == LIVE || g.kind == DEAD { x.id_of(g.off) } else { 0 };
            buf.extend_from_slice(&[g.off, g.len, g.kind, id]);
        }
        x.buf = buf;
        r.0.len() as u32
    })
    .unwrap_or(0)
}

/// Fills the buffer with (from, to) free-list links; returns the link count.
#[no_mangle]
pub extern "C" fn heap_links(h: u32) -> u32 {
    with(h, |x| {
        let l = x.alloc.links();
        x.buf = l.iter().flat_map(|&(a, b)| [a, b]).collect();
        l.len() as u32
    })
    .unwrap_or(0)
}

/// Fills the buffer with 8 stats: live, meta, pad, slack, dead, free, largest_free, live_count.
#[no_mangle]
pub extern "C" fn heap_stats(h: u32) -> u32 {
    with(h, |x| {
        let s = stats(&x.alloc.regions());
        x.buf = vec![s.live, s.meta, s.pad, s.slack, s.dead, s.free, s.largest_free, s.live_count];
        8
    })
    .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn heap_buf(h: u32) -> *const u32 {
    with(h, |x| x.buf.as_ptr()).unwrap_or(std::ptr::null())
}

fn layout(bytes: usize) -> std::alloc::Layout {
    std::alloc::Layout::from_size_align(bytes.max(1), 8).unwrap()
}

#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    unsafe { std::alloc::alloc(layout(bytes)) }
}

/// # Safety
/// `p` must come from `alloc(bytes)` with the same `bytes`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, bytes: usize) {
    std::alloc::dealloc(p, layout(bytes));
}

#[cfg(test)]
mod tests;
