//! Hardware prefetchers on top of one cache level.
//! - Next-line (tagged): on a miss, or the first hit to a prefetched line, fetch the next `degree` lines.
//! - Stride (global): detect a repeated address delta across all accesses.
//! - Stride (per-PC): a reference prediction table indexed by the load instruction, so
//!   interleaved streams from different instructions are tracked separately.
use crate::level::Level;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    None,
    NextLine,
    Stride,
    PcStride,
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct PfStats {
    pub hits: u32,
    pub covered: u32, // demand hits on lines brought in by the prefetcher
    pub misses: u32,
    pub issued: u32,
    pub useless: u32, // prefetched lines evicted without ever being used
}

#[derive(Default, Clone, Copy)]
struct StrideState {
    last: u32,
    delta: i64,
    confident: bool,
}

impl StrideState {
    /// Updates with a new address; returns the stride to prefetch along, if confident.
    fn observe(&mut self, a: u32) -> Option<i64> {
        let d = a as i64 - self.last as i64;
        self.confident = d != 0 && d == self.delta;
        self.delta = d;
        self.last = a;
        self.confident.then_some(d)
    }
}

/// Outcome per access: 0 hit, 1 covered (hit on a prefetched line), 2 miss.
#[allow(clippy::too_many_arguments)]
pub fn run(addrs: &[u32], pcs: &[u32], lines: u32, line: u32, ways: u32, kind: Kind, degree: u32, out: &mut [u8]) -> PfStats {
    let mut c = Level::new(lines, ways);
    let bits = line.trailing_zeros();
    let mut s = PfStats::default();
    let mut global = StrideState::default();
    let mut table: HashMap<u32, StrideState> = HashMap::new();

    for (i, &a) in addrs.iter().enumerate() {
        let l = a >> bits;
        let (hit, was_pf) = c.access(l);
        out[i] = match (hit, was_pf) {
            (true, false) => {
                s.hits += 1;
                0
            }
            (true, true) => {
                s.covered += 1;
                1
            }
            _ => {
                s.misses += 1;
                if let Some(v) = c.insert(l, false, false) {
                    s.useless += v.prefetched as u32;
                }
                2
            }
        };

        let mut targets: Vec<u32> = Vec::new();
        let along = |stride: i64, targets: &mut Vec<u32>| {
            // Step by whole lines in the stride's direction when the stride is smaller than a line.
            let step = if stride.unsigned_abs() < line as u64 { stride.signum() * line as i64 } else { stride };
            for d in 1..=degree as i64 {
                let t = a as i64 + d * step;
                if (0..=u32::MAX as i64).contains(&t) {
                    targets.push((t as u32) >> bits);
                }
            }
        };
        match kind {
            Kind::None => {}
            Kind::NextLine => {
                if !hit || was_pf {
                    targets.extend((1..=degree).map(|d| l.wrapping_add(d)));
                }
            }
            Kind::Stride => {
                if let Some(st) = global.observe(a) {
                    along(st, &mut targets);
                }
            }
            Kind::PcStride => {
                let pc = pcs.get(i).copied().unwrap_or(0);
                let e = table.entry(pc).or_insert(StrideState { last: a, ..Default::default() });
                if let Some(st) = e.observe(a) {
                    along(st, &mut targets);
                }
            }
        }
        for t in targets {
            if t == l || c.contains(t) {
                continue;
            }
            s.issued += 1;
            if let Some(v) = c.insert(t, false, true) {
                s.useless += v.prefetched as u32;
            }
        }
    }
    s
}
