//! Implicit free list with boundary headers: every block starts with an 8-byte header.
//! Placement: first, next, best or worst fit. Optional immediate coalescing.
use crate::region::*;

pub const HEADER: u32 = 8;
pub const MIN_BLOCK: u32 = 16;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fit {
    First,
    Next,
    Best,
    Worst,
}

#[derive(Clone, Copy, Debug)]
struct Blk {
    off: u32,
    size: u32, // including header
    free: bool,
    req: u32,
    pad: u32,
}

pub struct FreeList {
    cap: u32,
    blocks: Vec<Blk>,
    fit: Fit,
    coalesce: bool,
    rover: u32,
}

impl FreeList {
    pub fn new(cap: u32, fit: Fit, coalesce: bool) -> Self {
        let mut f = FreeList { cap: cap & !7, blocks: Vec::new(), fit, coalesce, rover: 0 };
        f.reset();
        f
    }

    fn need(b: &Blk, size: u32, align: u32) -> (u32, u32) {
        let p0 = b.off + HEADER;
        let pad = align_up(p0, align) - p0;
        (align_up(HEADER + pad + size, 8).max(MIN_BLOCK), pad)
    }

    fn pick(&self, size: u32, align: u32) -> Option<usize> {
        let fits = |i: &usize| {
            let b = &self.blocks[*i];
            b.free && b.size >= Self::need(b, size, align).0
        };
        let n = self.blocks.len();
        match self.fit {
            Fit::First => (0..n).find(fits),
            Fit::Next => {
                let s = self.blocks.iter().position(|b| b.off >= self.rover).unwrap_or(0);
                (s..n).chain(0..s).find(fits)
            }
            Fit::Best => (0..n).filter(fits).min_by_key(|&i| (self.blocks[i].size, i)),
            Fit::Worst => (0..n).filter(fits).max_by_key(|&i| (self.blocks[i].size, n - i)),
        }
    }

    fn merge_with_next(&mut self, i: usize) {
        if i + 1 < self.blocks.len() && self.blocks[i].free && self.blocks[i + 1].free {
            self.blocks[i].size += self.blocks[i + 1].size;
            self.blocks.remove(i + 1);
        }
    }

    pub fn free_block_sizes(&self) -> Vec<u32> {
        self.blocks.iter().filter(|b| b.free).map(|b| b.size).collect()
    }
}

impl Allocator for FreeList {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        let align = align.max(8);
        let i = self.pick(size, align)?;
        let (need, pad) = Self::need(&self.blocks[i], size, align);
        let b = self.blocks[i];
        if b.size - need >= MIN_BLOCK {
            self.blocks.insert(i + 1, Blk { off: b.off + need, size: b.size - need, free: true, req: 0, pad: 0 });
            self.blocks[i].size = need;
        }
        let blk = &mut self.blocks[i];
        blk.free = false;
        blk.req = size;
        blk.pad = pad;
        self.rover = blk.off + blk.size;
        Some(blk.off + HEADER + pad)
    }

    fn free(&mut self, addr: u32) -> bool {
        let Some(i) = self.blocks.iter().position(|b| !b.free && b.off + HEADER + b.pad == addr) else { return false };
        let b = &mut self.blocks[i];
        b.free = true;
        b.req = 0;
        b.pad = 0;
        if self.coalesce {
            self.merge_with_next(i);
            if i > 0 {
                self.merge_with_next(i - 1);
            }
        }
        true
    }

    fn reset(&mut self) {
        self.blocks = vec![Blk { off: 0, size: self.cap, free: true, req: 0, pad: 0 }];
        self.rover = 0;
    }

    fn regions(&self) -> Regions {
        let mut r = Regions::default();
        for b in &self.blocks {
            r.push(b.off, HEADER, META);
            if b.free {
                r.push(b.off + HEADER, b.size - HEADER, FREE);
            } else {
                let p = b.off + HEADER;
                r.push(p, b.pad, PAD);
                r.push(p + b.pad, b.req, LIVE);
                r.push(p + b.pad + b.req, b.size - HEADER - b.pad - b.req, SLACK);
            }
        }
        r
    }

    fn links(&self) -> Vec<(u32, u32)> {
        let free: Vec<u32> = self.blocks.iter().filter(|b| b.free).map(|b| b.off).collect();
        free.windows(2).map(|w| (w[0], w[1])).collect()
    }
}
