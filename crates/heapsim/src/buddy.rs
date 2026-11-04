//! Binary buddy allocator. Block sizes are powers of two; a block's buddy is at `off ^ size`.
//! Sizes are kept in a side table, so blocks carry no header.
use crate::region::*;
use std::collections::{BTreeMap, BTreeSet};

pub const MIN: u32 = 16;

pub struct Buddy {
    max_order: u32,
    free: Vec<BTreeSet<u32>>,
    used: BTreeMap<u32, (u32, u32)>, // addr -> (order, requested)
}

fn bsize(k: u32) -> u32 {
    MIN << k
}

impl Buddy {
    pub fn new(cap: u32) -> Self {
        let cap = if cap.is_power_of_two() { cap } else { cap.next_power_of_two() / 2 }.max(MIN);
        let max_order = (cap / MIN).trailing_zeros();
        let mut b = Buddy { max_order, free: Vec::new(), used: BTreeMap::new() };
        b.reset();
        b
    }

    pub fn free_counts(&self) -> Vec<usize> {
        self.free.iter().map(|s| s.len()).collect()
    }
}

impl Allocator for Buddy {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        let need = size.max(align).max(MIN).checked_next_power_of_two()?;
        let k = (need / MIN).trailing_zeros();
        if k > self.max_order {
            return None;
        }
        let mut j = (k..=self.max_order).find(|&j| !self.free[j as usize].is_empty())?;
        let off = self.free[j as usize].pop_first()?;
        while j > k {
            j -= 1;
            self.free[j as usize].insert(off + bsize(j));
        }
        self.used.insert(off, (k, size));
        Some(off)
    }

    fn free(&mut self, addr: u32) -> bool {
        let Some((mut k, _)) = self.used.remove(&addr) else { return false };
        let mut off = addr;
        while k < self.max_order {
            let buddy = off ^ bsize(k);
            if !self.free[k as usize].remove(&buddy) {
                break;
            }
            off = off.min(buddy);
            k += 1;
        }
        self.free[k as usize].insert(off);
        true
    }

    fn reset(&mut self) {
        self.free = (0..=self.max_order).map(|_| BTreeSet::new()).collect();
        self.free[self.max_order as usize].insert(0);
        self.used.clear();
    }

    fn regions(&self) -> Regions {
        let mut blocks: Vec<(u32, u32, Option<u32>)> = Vec::new();
        for (k, s) in self.free.iter().enumerate() {
            blocks.extend(s.iter().map(|&o| (o, bsize(k as u32), None)));
        }
        blocks.extend(self.used.iter().map(|(&o, &(k, req))| (o, bsize(k), Some(req))));
        blocks.sort_unstable_by_key(|b| b.0);
        let mut r = Regions::default();
        for (o, sz, req) in blocks {
            match req {
                None => r.push(o, sz, FREE),
                Some(q) => {
                    r.push(o, q, LIVE);
                    r.push(o + q, sz - q, SLACK);
                }
            }
        }
        r
    }
}
