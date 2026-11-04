//! Write policies: write-back vs write-through, write-allocate vs no-write-allocate.
//! Memory traffic is counted in bytes: line fills, line write-backs, and word writes.
use crate::level::Level;

pub const WORD: u32 = 4;

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteStats {
    pub hits: u32,
    pub misses: u32,
    pub mem_read: u32,
    pub mem_write: u32,
    pub writebacks: u32,
    pub dirty_at_end: u32,
}

/// `writes[i] != 0` marks a store. Outcome per access: 0 hit, 1 miss.
pub fn run(addrs: &[u32], writes: &[u8], lines: u32, line: u32, ways: u32, write_back: bool, write_allocate: bool, out: &mut [u8]) -> WriteStats {
    let mut c = Level::new(lines, ways);
    let bits = line.trailing_zeros();
    let mut s = WriteStats::default();
    for (i, (&a, &w)) in addrs.iter().zip(writes).enumerate() {
        let l = a >> bits;
        let is_write = w != 0;
        let (hit, _) = c.access(l);
        out[i] = !hit as u8;
        if hit {
            s.hits += 1;
        } else {
            s.misses += 1;
        }
        let resident = if hit {
            true
        } else if !is_write || write_allocate {
            s.mem_read += line;
            if let Some(v) = c.insert(l, false, false) {
                if v.dirty {
                    s.mem_write += line;
                    s.writebacks += 1;
                }
            }
            true
        } else {
            false
        };
        if is_write {
            if write_back && resident {
                c.mark_dirty(l);
            } else {
                s.mem_write += WORD;
            }
        }
    }
    s.dirty_at_end = c.dirty_lines();
    s
}
