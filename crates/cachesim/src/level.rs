//! A set-associative LRU cache level operating on line numbers, with dirty and prefetch bits.
//! Used by the write-policy, hierarchy and prefetch simulators.

#[derive(Clone, Copy, Default)]
struct Way {
    tag: u32,
    valid: bool,
    dirty: bool,
    prefetched: bool,
    stamp: u64,
}

pub struct Evicted {
    pub line: u32,
    pub dirty: bool,
    pub prefetched: bool,
}

pub struct Level {
    sets: Vec<Vec<Way>>,
    set_bits: u32,
    clock: u64,
}

impl Level {
    /// `lines` total lines, `ways` per set (0 = fully associative). Both are powers of two.
    pub fn new(lines: u32, ways: u32) -> Self {
        let lines = lines.max(1);
        let ways = if ways == 0 { lines } else { ways.clamp(1, lines) };
        let n_sets = (lines / ways).max(1);
        Level {
            sets: vec![vec![Way::default(); ways as usize]; n_sets as usize],
            set_bits: n_sets.trailing_zeros(),
            clock: 0,
        }
    }

    fn split(&self, line: u32) -> (usize, u32) {
        ((line & ((1 << self.set_bits) - 1)) as usize, line >> self.set_bits)
    }

    fn find(&mut self, line: u32) -> Option<&mut Way> {
        let (s, tag) = self.split(line);
        self.sets[s].iter_mut().find(|w| w.valid && w.tag == tag)
    }

    /// Looks up a line, updating LRU on hit. Returns (hit, was_prefetched) and clears the prefetch flag.
    pub fn access(&mut self, line: u32) -> (bool, bool) {
        self.clock += 1;
        let now = self.clock;
        match self.find(line) {
            Some(w) => {
                w.stamp = now;
                let p = w.prefetched;
                w.prefetched = false;
                (true, p)
            }
            None => (false, false),
        }
    }

    pub fn contains(&self, line: u32) -> bool {
        let (s, tag) = self.split(line);
        self.sets[s].iter().any(|w| w.valid && w.tag == tag)
    }

    pub fn mark_dirty(&mut self, line: u32) {
        if let Some(w) = self.find(line) {
            w.dirty = true;
        }
    }

    /// Inserts a line (must not be present) and returns the evicted victim, if any.
    pub fn insert(&mut self, line: u32, dirty: bool, prefetched: bool) -> Option<Evicted> {
        self.clock += 1;
        let now = self.clock;
        let set_bits = self.set_bits;
        let (s, tag) = self.split(line);
        let set = &mut self.sets[s];
        let i = set.iter().position(|w| !w.valid).unwrap_or_else(|| (0..set.len()).min_by_key(|&i| set[i].stamp).unwrap());
        let old = set[i];
        set[i] = Way { tag, valid: true, dirty, prefetched, stamp: now };
        old.valid.then(|| Evicted { line: (old.tag << set_bits) | s as u32, dirty: old.dirty, prefetched: old.prefetched })
    }

    /// Removes a line if present; returns its dirty bit.
    pub fn remove(&mut self, line: u32) -> Option<bool> {
        let w = self.find(line)?;
        w.valid = false;
        Some(w.dirty)
    }

    pub fn dirty_lines(&self) -> u32 {
        self.sets.iter().flatten().filter(|w| w.valid && w.dirty).count() as u32
    }
}
