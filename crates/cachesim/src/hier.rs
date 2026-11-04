//! Multi-level cache hierarchy with three inclusion policies.
//! - Non-inclusive (NINE): a miss fills every level above the one that hit; levels evict independently.
//! - Inclusive: same fill, but an eviction from a lower level back-invalidates the line above,
//!   so every level is a superset of the ones above it.
//! - Exclusive: a line lives in exactly one level. Hits below L1 move the line up; L1 victims
//!   cascade down. Effective capacity is the sum of the levels.
use crate::level::Level;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Inclusion {
    NonInclusive,
    Inclusive,
    Exclusive,
}

pub struct Hier {
    levels: Vec<Level>,
    mode: Inclusion,
    bits: u32,
}

impl Hier {
    /// `lines[k]`/`ways[k]` per level; `line` in bytes.
    pub fn new(lines: &[u32], ways: &[u32], line: u32, mode: Inclusion) -> Self {
        Hier {
            levels: lines.iter().zip(ways).map(|(&l, &w)| Level::new(l, w)).collect(),
            mode,
            bits: line.trailing_zeros(),
        }
    }

    /// Returns the index of the level that served the access (levels.len() = memory).
    pub fn access(&mut self, addr: u32) -> u8 {
        let l = addr >> self.bits;
        let n = self.levels.len();
        let hit_at = (0..n).find(|&k| self.levels[k].access(l).0).unwrap_or(n);
        match self.mode {
            Inclusion::Exclusive => {
                if hit_at == 0 {
                    return 0;
                }
                if hit_at < n {
                    self.levels[hit_at].remove(l);
                }
                let mut carry = Some(l);
                for k in 0..n {
                    let Some(x) = carry else { break };
                    carry = self.levels[k].insert(x, false, false).map(|v| v.line);
                }
            }
            _ => {
                for k in (0..hit_at).rev() {
                    if let Some(v) = self.levels[k].insert(l, false, false) {
                        if self.mode == Inclusion::Inclusive {
                            for j in 0..k {
                                self.levels[j].remove(v.line);
                            }
                        }
                    }
                }
            }
        }
        hit_at as u8
    }
}
