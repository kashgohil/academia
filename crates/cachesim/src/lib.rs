//! Set-associative cache simulator with 3C miss classification
//! (compulsory / capacity / conflict), exported to WebAssembly via a raw C ABI.
//!
//! Classification follows Hill's 3C model:
//! - compulsory: first access to the line, ever
//! - capacity:   would also miss in a fully-associative LRU cache of the same size
//! - conflict:   would hit in that fully-associative cache, missed only due to mapping

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

#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(bytes);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `alloc(bytes)`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, bytes: usize) {
    drop(Vec::from_raw_parts(p, 0, bytes));
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
}
