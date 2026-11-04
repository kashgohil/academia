//! Set-associative cache simulator with 3C miss classification
//! (compulsory / capacity / conflict), exported to WebAssembly via a raw C ABI.
//!
//! Classification follows Hill's 3C model:
//! - compulsory: first access to the line, ever
//! - capacity:   would also miss in a fully-associative LRU cache of the same size
//! - conflict:   would hit in that fully-associative cache, missed only due to mapping

pub mod hier;
pub mod level;
pub mod prefetch;
pub mod reuse;
pub mod write;

use std::collections::HashSet;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Outcome {
    Hit = 0,
    Compulsory = 1,
    Capacity = 2,
    Conflict = 3,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Policy {
    Lru,
    Fifo,
    Random,
}

#[derive(Clone, Copy)]
struct Way {
    tag: u32,
    valid: bool,
    last_used: u64,
    inserted: u64,
}

pub struct Cache {
    sets: Vec<Vec<Way>>,
    line_bits: u32,
    set_bits: u32,
    policy: Policy,
    clock: u64,
    rng: u32,
    // Fully-associative LRU shadow for 3C classification: (line, last_used)
    shadow: Vec<(u32, u64)>,
    shadow_cap: usize,
    seen: HashSet<u32>,
}

impl Cache {
    /// `size` and `line` in bytes, both powers of two. `ways` divides size/line.
    pub fn new(size: u32, line: u32, ways: u32, policy: Policy) -> Self {
        let lines = (size / line).max(1);
        let ways = ways.clamp(1, lines);
        let n_sets = lines / ways;
        Cache {
            sets: vec![vec![Way { tag: 0, valid: false, last_used: 0, inserted: 0 }; ways as usize]; n_sets as usize],
            line_bits: line.trailing_zeros(),
            set_bits: n_sets.trailing_zeros(),
            policy,
            clock: 0,
            rng: 0x9e37_79b9,
            shadow: Vec::with_capacity(lines as usize),
            shadow_cap: lines as usize,
            seen: HashSet::new(),
        }
    }

    fn shadow_access(&mut self, line: u32) -> bool {
        let now = self.clock;
        if let Some(e) = self.shadow.iter_mut().find(|e| e.0 == line) {
            e.1 = now;
            return true;
        }
        if self.shadow.len() < self.shadow_cap {
            self.shadow.push((line, now));
        } else {
            let (idx, _) = self.shadow.iter().enumerate().min_by_key(|(_, e)| e.1).unwrap();
            self.shadow[idx] = (line, now);
        }
        false
    }

    fn next_rand(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    pub fn access(&mut self, addr: u32) -> Outcome {
        self.clock += 1;
        let now = self.clock;
        let line = addr >> self.line_bits;
        let set_idx = (line & ((1u32 << self.set_bits) - 1)) as usize;
        let tag = line >> self.set_bits;

        let shadow_hit = self.shadow_access(line);
        let first_touch = self.seen.insert(line);

        let policy = self.policy;
        let r = self.next_rand();
        let set = &mut self.sets[set_idx];
        if let Some(w) = set.iter_mut().find(|w| w.valid && w.tag == tag) {
            w.last_used = now;
            return Outcome::Hit;
        }

        let victim = match set.iter().position(|w| !w.valid) {
            Some(i) => i,
            None => match policy {
                Policy::Lru => (0..set.len()).min_by_key(|&i| set[i].last_used).unwrap(),
                Policy::Fifo => (0..set.len()).min_by_key(|&i| set[i].inserted).unwrap(),
                Policy::Random => (r as usize) % set.len(),
            },
        };
        set[victim] = Way { tag, valid: true, last_used: now, inserted: now };

        if first_touch {
            Outcome::Compulsory
        } else if shadow_hit {
            Outcome::Conflict
        } else {
            Outcome::Capacity
        }
    }
}

pub fn simulate(addrs: &[u32], size: u32, line: u32, ways: u32, policy: Policy) -> Vec<Outcome> {
    let mut c = Cache::new(size, line, ways, policy);
    addrs.iter().map(|&a| c.access(a)).collect()
}

// ---------------- WebAssembly C ABI ----------------

fn layout(bytes: usize) -> std::alloc::Layout {
    // 8-byte alignment so the buffer can be viewed as u32/f64 slices.
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

/// Simulates `n` accesses from `addrs` and writes one outcome byte per access into `out`.
/// policy: 0 = LRU, 1 = FIFO, 2 = random. Returns the number of hits.
///
/// # Safety
/// `addrs` must point to `n` u32s and `out` to `n` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn cachesim_run(addrs: *const u32, n: usize, out: *mut u8, size: u32, line: u32, ways: u32, policy: u32) -> u32 {
    let addrs = std::slice::from_raw_parts(addrs, n);
    let out = std::slice::from_raw_parts_mut(out, n);
    let pol = match policy {
        1 => Policy::Fifo,
        2 => Policy::Random,
        _ => Policy::Lru,
    };
    let mut hits = 0;
    let mut c = Cache::new(size, line, ways, pol);
    for (o, &a) in out.iter_mut().zip(addrs) {
        let r = c.access(a);
        if r == Outcome::Hit {
            hits += 1;
        }
        *o = r as u8;
    }
    hits
}

/// LRU stack distance per access (u32::MAX = first touch).
///
/// # Safety
/// `addrs` and `out` must point to `n` u32s.
#[no_mangle]
pub unsafe extern "C" fn cachesim_reuse(addrs: *const u32, n: usize, out: *mut u32, line: u32) {
    let a = std::slice::from_raw_parts(addrs, n);
    let o = std::slice::from_raw_parts_mut(out, n);
    o.copy_from_slice(&reuse::stack_distances(a, line.trailing_zeros()));
}

/// Write-policy simulation. `stats` receives 6 u32s: hits, misses, mem_read, mem_write, writebacks, dirty_at_end.
///
/// # Safety
/// `addrs` (n u32), `writes` (n u8), `out` (n u8) and `stats` (6 u32) must be valid.
#[no_mangle]
pub unsafe extern "C" fn cachesim_write(addrs: *const u32, writes: *const u8, n: usize, out: *mut u8, lines: u32, line: u32, ways: u32, write_back: u32, write_allocate: u32, stats: *mut u32) {
    let s = write::run(
        std::slice::from_raw_parts(addrs, n),
        std::slice::from_raw_parts(writes, n),
        lines, line, ways, write_back != 0, write_allocate != 0,
        std::slice::from_raw_parts_mut(out, n),
    );
    std::slice::from_raw_parts_mut(stats, 6).copy_from_slice(&[s.hits, s.misses, s.mem_read, s.mem_write, s.writebacks, s.dirty_at_end]);
}

/// Hierarchy simulation. `out[i]` = level that served access i (nlevels = memory).
/// mode: 0 non-inclusive, 1 inclusive, 2 exclusive.
///
/// # Safety
/// `addrs` (n u32), `out` (n u8), `lines`/`ways` (nlevels u32) must be valid.
#[no_mangle]
pub unsafe extern "C" fn cachesim_hier(addrs: *const u32, n: usize, out: *mut u8, nlevels: usize, lines: *const u32, ways: *const u32, line: u32, mode: u32) {
    let mode = match mode {
        1 => hier::Inclusion::Inclusive,
        2 => hier::Inclusion::Exclusive,
        _ => hier::Inclusion::NonInclusive,
    };
    let mut h = hier::Hier::new(std::slice::from_raw_parts(lines, nlevels), std::slice::from_raw_parts(ways, nlevels), line, mode);
    let o = std::slice::from_raw_parts_mut(out, n);
    for (x, &a) in o.iter_mut().zip(std::slice::from_raw_parts(addrs, n)) {
        *x = h.access(a);
    }
}

/// Prefetch simulation. kind: 0 none, 1 next-line, 2 stride, 3 per-PC stride.
/// `stats` receives 5 u32s: hits, covered, misses, issued, useless.
///
/// # Safety
/// `addrs`, `pcs` (n u32), `out` (n u8), `stats` (5 u32) must be valid.
#[no_mangle]
pub unsafe extern "C" fn cachesim_prefetch(addrs: *const u32, pcs: *const u32, n: usize, out: *mut u8, lines: u32, line: u32, ways: u32, kind: u32, degree: u32, stats: *mut u32) {
    let kind = match kind {
        1 => prefetch::Kind::NextLine,
        2 => prefetch::Kind::Stride,
        3 => prefetch::Kind::PcStride,
        _ => prefetch::Kind::None,
    };
    let s = prefetch::run(
        std::slice::from_raw_parts(addrs, n),
        std::slice::from_raw_parts(pcs, n),
        lines, line, ways, kind, degree,
        std::slice::from_raw_parts_mut(out, n),
    );
    std::slice::from_raw_parts_mut(stats, 5).copy_from_slice(&[s.hits, s.covered, s.misses, s.issued, s.useless]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use Outcome::*;

    #[test]
    fn sequential_one_miss_per_line() {
        // 64-byte lines, 4-byte elements: 16 accesses per line → 1 compulsory + 15 hits.
        let addrs: Vec<u32> = (0..256).map(|i| i * 4).collect();
        let r = simulate(&addrs, 1024, 64, 2, Policy::Lru);
        assert_eq!(r.iter().filter(|&&o| o == Compulsory).count(), 16);
        assert_eq!(r.iter().filter(|&&o| o == Hit).count(), 240);
    }

    #[test]
    fn direct_mapped_conflict_fixed_by_associativity() {
        // Two lines mapping to the same set, alternating: A B A B ...
        // 1 KiB direct-mapped, 64 B lines → 16 sets, addresses 0 and 1024 share set 0.
        let addrs: Vec<u32> = (0..20).map(|i| if i % 2 == 0 { 0 } else { 1024 }).collect();
        let dm = simulate(&addrs, 1024, 64, 1, Policy::Lru);
        assert_eq!(dm[0], Compulsory);
        assert_eq!(dm[1], Compulsory);
        assert!(dm[2..].iter().all(|&o| o == Conflict));
        let two_way = simulate(&addrs, 1024, 64, 2, Policy::Lru);
        assert!(two_way[2..].iter().all(|&o| o == Hit));
    }

    #[test]
    fn capacity_misses_when_working_set_too_big() {
        // Cycle over 32 lines in a 16-line fully associative LRU cache: LRU thrashes.
        let addrs: Vec<u32> = (0..32u32).cycle().take(96).map(|l| l * 64).collect();
        let r = simulate(&addrs, 1024, 64, 16, Policy::Lru);
        assert!(r[32..].iter().all(|&o| o == Capacity));
    }

    #[test]
    fn fifo_vs_lru_differs() {
        // A B A C (2-way, single set): LRU evicts B on C, FIFO evicts A.
        let line = 64;
        let a = 0;
        let b = 128; // 2 lines total, 1 set → every address maps to set 0
        let c = 256;
        let addrs = [a, b, a, c, a];
        let lru = simulate(&addrs, 128, line, 2, Policy::Lru);
        let fifo = simulate(&addrs, 128, line, 2, Policy::Fifo);
        assert_eq!(lru[4], Hit);
        assert_ne!(fifo[4], Hit);
    }

    #[test]
    fn stack_distance_predicts_fully_associative_lru() {
        let addrs: Vec<u32> = (0..2000u32).map(|i| ((i * 2654435761u32) >> 20) * 4).collect();
        let d = reuse::stack_distances(&addrs, 6);
        for lines in [4u32, 16, 64] {
            let predicted = d.iter().filter(|&&x| x < lines).count();
            let r = simulate(&addrs, lines * 64, 64, lines, Policy::Lru);
            assert_eq!(predicted, r.iter().filter(|&&o| o == Hit).count(), "lines {lines}");
        }
    }

    #[test]
    fn memset_traffic_by_policy() {
        // 16 KiB of 4-byte stores through a 1 KiB cache.
        let addrs: Vec<u32> = (0..4096).map(|i| i * 4).collect();
        let w = vec![1u8; addrs.len()];
        let mut out = vec![0u8; addrs.len()];
        let wb_wa = write::run(&addrs, &w, 16, 64, 4, true, true, &mut out);
        assert_eq!(wb_wa.mem_read, 16384); // read-for-ownership fills every line
        assert_eq!(wb_wa.mem_write + wb_wa.dirty_at_end * 64, 16384);
        let wt_nwa = write::run(&addrs, &w, 16, 64, 4, false, false, &mut out);
        assert_eq!((wt_nwa.mem_read, wt_nwa.mem_write), (0, 16384));
    }

    #[test]
    fn write_back_coalesces_repeated_stores() {
        // 100 passes of a[i] += 1 over 512 B that fit in cache.
        let mut addrs = Vec::new();
        let mut w = Vec::new();
        for _ in 0..100 {
            for i in 0..128u32 {
                addrs.extend([i * 4, i * 4]);
                w.extend([0u8, 1]);
            }
        }
        let mut out = vec![0u8; addrs.len()];
        let wb = write::run(&addrs, &w, 16, 64, 4, true, true, &mut out);
        let wt = write::run(&addrs, &w, 16, 64, 4, false, true, &mut out);
        assert_eq!(wb.mem_write, 0); // still dirty in cache
        assert_eq!(wt.mem_write, 100 * 128 * 4);
    }

    #[test]
    fn exclusive_hierarchy_holds_the_sum() {
        // Loop over 12 lines with L1 = 4 lines, L2 = 8 lines, both fully associative.
        let addrs: Vec<u32> = (0..12u32).cycle().take(12 * 20).map(|l| l * 64).collect();
        let served = |mode| {
            let mut h = hier::Hier::new(&[4, 8], &[0, 0], 64, mode);
            let served: Vec<u8> = addrs.iter().map(|&a| h.access(a)).collect();
            served[12 * 2..].iter().filter(|&&k| k == 2).count() // after warm-up
        };
        assert_eq!(served(hier::Inclusion::Exclusive), 0); // 4 + 8 = 12 lines fit
        assert!(served(hier::Inclusion::Inclusive) > 0); // only 8 fit
    }

    #[test]
    fn prefetchers() {
        let n = 4096u32;
        let seq: Vec<u32> = (0..n).map(|i| i * 4).collect();
        let pcs = vec![0u32; n as usize];
        let mut out = vec![0u8; n as usize];
        let none = prefetch::run(&seq, &pcs, 16, 64, 4, prefetch::Kind::None, 2, &mut out);
        let nl = prefetch::run(&seq, &pcs, 16, 64, 4, prefetch::Kind::NextLine, 2, &mut out);
        assert_eq!(none.misses, n / 16);
        assert!(nl.misses <= 2, "next-line should cover a sequential scan, got {}", nl.misses);
        // Two interleaved strided streams from different PCs: global stride fails, per-PC succeeds.
        let mut a = Vec::new();
        let mut p = Vec::new();
        for i in 0..2048u32 {
            a.extend([i * 192, 1 << 20 | i * 320]);
            p.extend([1, 2]);
        }
        let mut out = vec![0u8; a.len()];
        let g = prefetch::run(&a, &p, 64, 64, 4, prefetch::Kind::Stride, 2, &mut out);
        let pc = prefetch::run(&a, &p, 64, 64, 4, prefetch::Kind::PcStride, 2, &mut out);
        assert!(g.covered < 10);
        assert!(pc.covered > 3900);
    }
}
