//! Pool allocator: fixed-size slots threaded on an intrusive LIFO free list.
use crate::region::*;

const NONE: u32 = u32::MAX;

pub struct Pool {
    cap: u32,
    slot: u32,
    head: u32,
    next: Vec<u32>,
    used: Vec<u32>, // requested size, 0 = free
}

impl Pool {
    pub fn new(cap: u32, slot: u32) -> Self {
        let slot = slot.max(8);
        let mut p = Pool { cap, slot, head: NONE, next: Vec::new(), used: Vec::new() };
        p.reset();
        p
    }
    fn n(&self) -> u32 {
        self.cap / self.slot
    }
}

impl Allocator for Pool {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        // Slots are aligned to the largest power of two dividing the slot size.
        let slot_align = self.slot & self.slot.wrapping_neg();
        if size == 0 || size > self.slot || align > slot_align || self.head == NONE {
            return None;
        }
        let i = self.head;
        self.head = self.next[i as usize];
        self.used[i as usize] = size;
        Some(i * self.slot)
    }

    fn free(&mut self, addr: u32) -> bool {
        let i = addr / self.slot;
        if addr % self.slot != 0 || i >= self.n() || self.used[i as usize] == 0 {
            return false;
        }
        self.used[i as usize] = 0;
        self.next[i as usize] = self.head;
        self.head = i;
        true
    }

    fn reset(&mut self) {
        let n = self.n();
        self.next = (1..=n).map(|i| if i == n { NONE } else { i }).collect();
        self.used = vec![0; n as usize];
        self.head = if n > 0 { 0 } else { NONE };
    }

    fn regions(&self) -> Regions {
        let mut r = Regions::default();
        for i in 0..self.n() {
            let off = i * self.slot;
            match self.used[i as usize] {
                0 => r.push(off, self.slot, FREE),
                s => {
                    r.push(off, s, LIVE);
                    r.push(off + s, self.slot - s, SLACK);
                }
            }
        }
        let end = self.n() * self.slot;
        r.push(end, self.cap - end, SLACK);
        r
    }

    fn links(&self) -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        let mut i = self.head;
        while i != NONE && out.len() <= self.n() as usize {
            let j = self.next[i as usize];
            out.push((i * self.slot, if j == NONE { NONE } else { j * self.slot }));
            i = j;
        }
        out
    }
}
