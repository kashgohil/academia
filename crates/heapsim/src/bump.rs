//! Bump allocator: one pointer that only moves forward.
//! Freeing the most recent allocation rolls the pointer back (stack-like); any other free is a no-op.
use crate::region::*;

struct A {
    start: u32, // where padding begins (the old top)
    addr: u32,
    size: u32,
    dead: bool,
}

pub struct Bump {
    cap: u32,
    top: u32,
    allocs: Vec<A>,
}

impl Bump {
    pub fn new(cap: u32) -> Self {
        Bump { cap, top: 0, allocs: Vec::new() }
    }
}

impl Allocator for Bump {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        let addr = align_up(self.top, align);
        let end = addr.checked_add(size)?;
        if end > self.cap {
            return None;
        }
        self.allocs.push(A { start: self.top, addr, size, dead: false });
        self.top = end;
        Some(addr)
    }

    fn free(&mut self, addr: u32) -> bool {
        let Some(i) = self.allocs.iter().position(|a| a.addr == addr && !a.dead) else { return false };
        self.allocs[i].dead = true;
        // Roll back over every dead allocation at the top.
        while self.allocs.last().is_some_and(|a| a.dead) {
            self.top = self.allocs.pop().unwrap().start;
        }
        true
    }

    fn reset(&mut self) {
        self.top = 0;
        self.allocs.clear();
    }

    fn mark(&self) -> u32 {
        self.top
    }

    fn restore(&mut self, m: u32) {
        if m <= self.top {
            self.allocs.retain(|a| a.start < m);
            self.top = m;
        }
    }

    fn regions(&self) -> Regions {
        let mut r = Regions::default();
        for a in &self.allocs {
            r.push(a.start, a.addr - a.start, PAD);
            r.push(a.addr, a.size, if a.dead { DEAD } else { LIVE });
        }
        r.push(self.top, self.cap - self.top, FREE);
        r
    }
}
