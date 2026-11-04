use super::*;
use crate::region::*;

const ALL: &[(u32, u32, u32, u32)] = &[
    // kind, cap, a, b
    (KIND_BUMP, 4096, 0, 0),
    (KIND_ARENA, 4096, 512, 0),
    (KIND_POOL, 4096, 64, 0),
    (KIND_FREELIST, 4096, 0, 1),
    (KIND_FREELIST, 4096, 1, 1),
    (KIND_FREELIST, 4096, 2, 1),
    (KIND_FREELIST, 4096, 3, 0),
    (KIND_BUDDY, 4096, 0, 0),
    (KIND_SLAB, 4096, 512, 1),
    (KIND_SLAB, 4096, 512, 0),
    (KIND_SIZECLASS, 16384, 1024, 0),
    (KIND_SIZECLASS, 16384, 1024, 1),
];

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
}

fn check_tiling(r: &Regions, cap_hint: u32) {
    let mut cur = 0;
    for g in &r.0 {
        assert_eq!(g.off, cur, "gap or overlap at {cur}: {:?}", g);
        assert!(g.len > 0);
        cur += g.len;
    }
    assert!(cur == cap_hint || cur.is_power_of_two(), "tiling ends at {cur}, cap {cap_hint}");
}

#[test]
fn every_allocator_tiles_the_heap_and_keeps_payloads_intact() {
    for &(kind, cap, a, b) in ALL {
        let mut h = Heap::new(make(kind, cap, a, b).unwrap());
        let mut rng = Rng(0xdead_beef ^ kind ^ a << 8 ^ b << 16);
        let mut live: Vec<(u32, u32)> = Vec::new();
        for step in 0..3000 {
            if live.is_empty() || rng.next() % 3 != 0 {
                let size = 1 + rng.next() % if kind == KIND_POOL { 64 } else { 300 };
                let align = 1 << (rng.next() % 4);
                if let Some(addr) = h.malloc(size, align) {
                    assert_eq!(addr % align, 0, "kind {kind}: misaligned");
                    for &(x, s) in &live {
                        assert!(addr + size <= x || x + s <= addr, "kind {kind}: overlap at step {step}");
                    }
                    live.push((addr, size));
                }
            } else {
                let i = (rng.next() as usize) % live.len();
                let (addr, _) = live.swap_remove(i);
                assert!(h.alloc.free(addr), "kind {kind}: free({addr}) rejected");
                assert!(!h.alloc.free(addr) || kind == KIND_BUMP, "kind {kind}: double free accepted");
            }
            if step % 50 == 0 {
                let r = h.alloc.regions();
                check_tiling(&r, cap);
                // Every live allocation appears as a LIVE region at its address with its size,
                // except bump/arena which may report frees as DEAD.
                for &(x, s) in &live {
                    assert!(r.0.iter().any(|g| g.kind == LIVE && g.off == x && g.len == s), "kind {kind}: lost allocation {x}+{s}");
                }
                assert_eq!(stats(&r).live_count as usize, live.len(), "kind {kind}");
            }
        }
        h.alloc.reset();
        let s = stats(&h.alloc.regions());
        assert_eq!(s.live, 0);
    }
}

#[test]
fn bump_alignment_padding() {
    // char, double, char, double: 1 + 7 pad + 8 + 1 + 7 pad + 8 = 32 bytes for 18 bytes of data.
    let mut h = Heap::new(make(KIND_BUMP, 1024, 0, 0).unwrap());
    for (s, a) in [(1, 1), (8, 8), (1, 1), (8, 8)] {
        h.malloc(s, a).unwrap();
    }
    let st = stats(&h.alloc.regions());
    assert_eq!((st.live, st.pad, st.free), (18, 14, 1024 - 32));
    // Reordered: double, double, char, char → 18 bytes, no padding.
    h.alloc.reset();
    for (s, a) in [(8, 8), (8, 8), (1, 1), (1, 1)] {
        h.malloc(s, a).unwrap();
    }
    assert_eq!(stats(&h.alloc.regions()).pad, 0);
}

#[test]
fn bump_rolls_back_only_from_the_top() {
    let mut h = Heap::new(make(KIND_BUMP, 1024, 0, 0).unwrap());
    let a = h.malloc(100, 1).unwrap();
    let b = h.malloc(100, 1).unwrap();
    assert!(h.alloc.free(a));
    assert_eq!(stats(&h.alloc.regions()).dead, 100);
    assert!(h.alloc.free(b)); // top: rolls back over b and the dead a
    assert_eq!(stats(&h.alloc.regions()).free, 1024);
}

#[test]
fn arena_opens_second_chunk_and_abandons_tail() {
    let mut h = Heap::new(make(KIND_ARENA, 2048, 256, 0).unwrap());
    for _ in 0..3 {
        h.malloc(100, 1).unwrap();
    }
    let st = stats(&h.alloc.regions());
    assert_eq!(st.meta, 32); // two chunk headers
    assert_eq!(st.slack, 256 - 16 - 200); // abandoned tail of chunk 1
    // Scope: mark, allocate, restore.
    let m = h.alloc.mark();
    h.malloc(500, 1).unwrap(); // oversized: gets its own 512-byte chunk
    assert_eq!(stats(&h.alloc.regions()).live, 800);
    h.alloc.restore(m);
    assert_eq!(stats(&h.alloc.regions()).live, 300);
}

#[test]
fn pool_free_list_is_lifo() {
    let mut h = Heap::new(make(KIND_POOL, 1024, 64, 0).unwrap());
    let a = h.malloc(64, 8).unwrap();
    let _b = h.malloc(64, 8).unwrap();
    let c = h.malloc(64, 8).unwrap();
    h.alloc.free(a);
    h.alloc.free(c);
    assert_eq!(h.malloc(10, 8), Some(c));
    assert_eq!(h.malloc(10, 8), Some(a));
    assert_eq!(h.malloc(65, 8), None);
}

#[test]
fn freelist_needs_coalescing() {
    // Fill the heap with 8 blocks, free them all, then ask for one big block.
    for coalesce in [0, 1] {
        let mut h = Heap::new(make(KIND_FREELIST, 1024, 0, coalesce).unwrap());
        let xs: Vec<u32> = (0..8).map(|_| h.malloc(120, 8).unwrap()).collect();
        for x in xs {
            h.alloc.free(x);
        }
        let big = h.malloc(600, 8);
        assert_eq!(big.is_some(), coalesce == 1);
    }
}

#[test]
fn buddy_rounds_up_and_merges() {
    let mut h = Heap::new(make(KIND_BUDDY, 1024, 0, 0).unwrap());
    let a = h.malloc(33, 1).unwrap();
    let st = stats(&h.alloc.regions());
    assert_eq!((st.live, st.slack), (33, 31));
    assert_eq!(h.malloc(513, 1), None); // would need 1024, half is split already
    h.alloc.free(a);
    let r = h.alloc.regions();
    assert_eq!(r.0.len(), 1);
    assert_eq!(r.0[0], Region { off: 0, len: 1024, kind: FREE });
}

#[test]
fn slab_keep_empty_prevents_thrashing() {
    for (keep, grabs) in [(false, 10), (true, 1)] {
        let mut s = slab::Slab::new(4096, 512, keep);
        for _ in 0..10 {
            let a = s.alloc(40, 8).unwrap();
            s.free(a);
        }
        assert_eq!(s.page_grabs, grabs);
    }
}

#[test]
fn sizeclass_rounding_waste() {
    let mut pow2 = Heap::new(make(KIND_SIZECLASS, 16384, 1024, 0).unwrap());
    pow2.malloc(33, 8).unwrap();
    let mut fine = Heap::new(make(KIND_SIZECLASS, 16384, 1024, 1).unwrap());
    fine.malloc(33, 8).unwrap();
    let slack_of_object = |h: &Heap| h.alloc.regions().0.iter().find(|g| g.kind == SLACK).unwrap().len;
    assert_eq!(slack_of_object(&pow2), 64 - 33);
    assert_eq!(slack_of_object(&fine), 48 - 33);
}
