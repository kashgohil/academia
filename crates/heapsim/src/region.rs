//! What every allocator reports about the heap: a complete, ordered tiling into regions.

pub const FREE: u32 = 0; // available to this allocator
pub const META: u32 = 1; // headers, slab/chunk descriptors
pub const PAD: u32 = 2; // alignment padding before a payload
pub const LIVE: u32 = 3; // bytes the program asked for
pub const SLACK: u32 = 4; // inside a block but unused (rounding, abandoned tails)
pub const DEAD: u32 = 5; // freed by the program but not reclaimed by the allocator

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub off: u32,
    pub len: u32,
    pub kind: u32,
}

#[derive(Default)]
pub struct Regions(pub Vec<Region>);

impl Regions {
    pub fn push(&mut self, off: u32, len: u32, kind: u32) {
        if len > 0 {
            self.0.push(Region { off, len, kind });
        }
    }
}

pub fn align_up(x: u32, a: u32) -> u32 {
    debug_assert!(a.is_power_of_two());
    (x + a - 1) & !(a - 1)
}

pub trait Allocator {
    /// Returns the payload address, or None when the request can't be satisfied.
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32>;
    /// Returns false for addresses that aren't live allocations.
    fn free(&mut self, addr: u32) -> bool;
    fn reset(&mut self);
    /// Scope support (bump/arena). Others ignore it.
    fn mark(&self) -> u32 {
        0
    }
    fn restore(&mut self, _m: u32) {}
    /// Ordered, gap-free tiling of [0, capacity).
    fn regions(&self) -> Regions;
    /// Free-list order as (from, to) addresses, where meaningful.
    fn links(&self) -> Vec<(u32, u32)> {
        Vec::new()
    }
}
