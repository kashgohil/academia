//! Chunked arena: bump allocation inside fixed-size chunks taken from the backing heap.
//! Each chunk starts with a header. When a request doesn't fit, the rest of the
//! current chunk is abandoned and a new chunk is opened. Individual frees are no-ops.
use crate::region::*;

pub const CHUNK_HEADER: u32 = 16;

struct Chunk {
    off: u32,
    len: u32,
    used: u32, // bytes from `off`, including the header
}

struct A {
    start: u32,
    addr: u32,
    size: u32,
    dead: bool,
}

pub struct Arena {
    cap: u32,
    chunk: u32,
    chunks: Vec<Chunk>,
    allocs: Vec<A>,
}

impl Arena {
    pub fn new(cap: u32, chunk: u32) -> Self {
        Arena { cap, chunk: chunk.max(CHUNK_HEADER * 2), chunks: Vec::new(), allocs: Vec::new() }
    }

    fn end(&self) -> u32 {
        self.chunks.last().map_or(0, |c| c.off + c.len)
    }

    fn try_in_last(&mut self, size: u32, align: u32) -> Option<u32> {
        let c = self.chunks.last_mut()?;
        let start = c.off + c.used;
        let addr = align_up(start, align);
        if addr + size > c.off + c.len {
            return None;
        }
        c.used = addr + size - c.off;
        self.allocs.push(A { start, addr, size, dead: false });
        Some(addr)
    }
}

impl Allocator for Arena {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        if let Some(a) = self.try_in_last(size, align) {
            return Some(a);
        }
        // Oversized requests get a chunk that is a whole multiple of the chunk size.
        let need = CHUNK_HEADER + size + align;
        let len = need.div_ceil(self.chunk) * self.chunk;
        let off = self.end();
        if off.checked_add(len)? > self.cap {
            return None;
        }
        self.chunks.push(Chunk { off, len, used: CHUNK_HEADER });
        self.try_in_last(size, align)
    }

    fn free(&mut self, addr: u32) -> bool {
        match self.allocs.iter_mut().find(|a| a.addr == addr && !a.dead) {
            Some(a) => {
                a.dead = true;
                true
            }
            None => false,
        }
    }

    fn reset(&mut self) {
        self.chunks.clear();
        self.allocs.clear();
    }

    /// Mark = (chunk count << 16) | used bytes of the last chunk.
    fn mark(&self) -> u32 {
        ((self.chunks.len() as u32) << 16) | self.chunks.last().map_or(0, |c| c.used)
    }

    fn restore(&mut self, m: u32) {
        let n = (m >> 16) as usize;
        if n > self.chunks.len() {
            return;
        }
        self.chunks.truncate(n);
        let boundary = match self.chunks.last_mut() {
            Some(c) => {
                c.used = (m & 0xFFFF).min(c.used);
                c.off + c.used
            }
            None => 0,
        };
        self.allocs.retain(|a| a.addr < boundary);
    }

    fn regions(&self) -> Regions {
        let mut r = Regions::default();
        let mut ai = 0;
        for (ci, c) in self.chunks.iter().enumerate() {
            r.push(c.off, CHUNK_HEADER, META);
            let mut cur = c.off + CHUNK_HEADER;
            while let Some(a) = self.allocs.get(ai).filter(|a| a.addr < c.off + c.len) {
                r.push(a.start, a.addr - a.start, PAD);
                r.push(a.addr, a.size, if a.dead { DEAD } else { LIVE });
                cur = a.addr + a.size;
                ai += 1;
            }
            let tail = c.off + c.len - cur;
            let last = ci + 1 == self.chunks.len();
            r.push(cur, tail, if last { FREE } else { SLACK });
        }
        let end = self.end();
        r.push(end, self.cap - end, FREE);
        r
    }
}
