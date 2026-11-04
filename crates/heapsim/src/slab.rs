//! Slab allocator: one cache per object size. Each slab is a page with a header
//! followed by equal-sized objects. Empty slabs return their page to the page pool,
//! unless `keep_empty` holds one back per cache to avoid thrashing.
use crate::region::*;

pub const SLAB_HEADER: u32 = 32;
pub const CLASSES: [u32; 5] = [16, 32, 64, 128, 256];

struct Page {
    class: usize,
    used: Vec<u32>, // requested size per object, 0 = free
}

pub struct Slab {
    cap: u32,
    page: u32,
    keep_empty: bool,
    pages: Vec<Option<Page>>,
    /// Pages taken from the page pool so far (shows thrashing).
    pub page_grabs: u32,
}

impl Slab {
    pub fn new(cap: u32, page: u32, keep_empty: bool) -> Self {
        let mut s = Slab { cap, page: page.max(SLAB_HEADER + 256), keep_empty, pages: Vec::new(), page_grabs: 0 };
        s.reset();
        s
    }
    fn per_page(&self, class: usize) -> u32 {
        (self.page - SLAB_HEADER) / CLASSES[class]
    }
}

impl Allocator for Slab {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        let c = CLASSES.iter().position(|&o| o >= size && align <= o.min(SLAB_HEADER))?;
        // Partial slabs first (so empty ones can drain back to the page pool), then empty ones.
        let has_free = |p: &Page| p.class == c && p.used.iter().any(|&u| u == 0);
        let has_live = |p: &Page| p.used.iter().any(|&u| u != 0);
        let found = self
            .pages
            .iter()
            .position(|p| p.as_ref().is_some_and(|p| has_free(p) && has_live(p)))
            .or_else(|| self.pages.iter().position(|p| p.as_ref().is_some_and(has_free)));
        let pi = match found {
            Some(i) => i,
            None => {
                let i = self.pages.iter().position(|p| p.is_none())?;
                self.pages[i] = Some(Page { class: c, used: vec![0; self.per_page(c) as usize] });
                self.page_grabs += 1;
                i
            }
        };
        let p = self.pages[pi].as_mut().unwrap();
        let oi = p.used.iter().position(|&u| u == 0).unwrap();
        p.used[oi] = size;
        Some(pi as u32 * self.page + SLAB_HEADER + oi as u32 * CLASSES[c])
    }

    fn free(&mut self, addr: u32) -> bool {
        let pi = (addr / self.page) as usize;
        let page = self.page;
        let Some(Some(p)) = self.pages.get_mut(pi) else { return false };
        let rel = addr - pi as u32 * page;
        let obj = CLASSES[p.class];
        if rel < SLAB_HEADER || (rel - SLAB_HEADER) % obj != 0 {
            return false;
        }
        let oi = ((rel - SLAB_HEADER) / obj) as usize;
        if oi >= p.used.len() || p.used[oi] == 0 {
            return false;
        }
        p.used[oi] = 0;
        if p.used.iter().all(|&u| u == 0) {
            let class = p.class;
            let other_empty = self.pages.iter().enumerate().any(|(j, q)| {
                j != pi && q.as_ref().is_some_and(|q| q.class == class && q.used.iter().all(|&u| u == 0))
            });
            if !self.keep_empty || other_empty {
                self.pages[pi] = None;
            }
        }
        true
    }

    fn reset(&mut self) {
        self.pages = (0..self.cap / self.page).map(|_| None).collect();
        self.page_grabs = 0;
    }

    fn regions(&self) -> Regions {
        let mut r = Regions::default();
        for (i, p) in self.pages.iter().enumerate() {
            let base = i as u32 * self.page;
            match p {
                None => r.push(base, self.page, FREE),
                Some(p) => {
                    r.push(base, SLAB_HEADER, META);
                    let obj = CLASSES[p.class];
                    let mut o = base + SLAB_HEADER;
                    for &u in &p.used {
                        if u == 0 {
                            r.push(o, obj, FREE);
                        } else {
                            r.push(o, u, LIVE);
                            r.push(o + u, obj - u, SLACK);
                        }
                        o += obj;
                    }
                    r.push(o, base + self.page - o, SLACK);
                }
            }
        }
        let end = self.pages.len() as u32 * self.page;
        r.push(end, self.cap - end, SLACK);
        r
    }
}
