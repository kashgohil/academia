//! General-purpose size-class allocator in the style of mimalloc/tcmalloc (single thread):
//! small requests round up to a size class and are served from pages dedicated to that class;
//! large requests take a run of whole pages. Metadata lives in a side table (no headers).
use crate::region::*;

pub const POW2: [u32; 6] = [16, 32, 64, 128, 256, 512];
pub const FINE: [u32; 16] = [16, 32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512];

#[derive(Clone)]
enum PageState {
    Free,
    Small { class: usize, used: Vec<u32> },
    LargeHead { pages: u32, req: u32 },
    LargeTail,
}

pub struct SizeClass {
    cap: u32,
    page: u32,
    classes: Vec<u32>,
    pages: Vec<PageState>,
}

impl SizeClass {
    pub fn new(cap: u32, page: u32, fine: bool) -> Self {
        let classes = if fine { FINE.to_vec() } else { POW2.to_vec() };
        let mut s = SizeClass { cap, page: page.max(512), classes, pages: Vec::new() };
        s.reset();
        s
    }
}

impl Allocator for SizeClass {
    fn alloc(&mut self, size: u32, align: u32) -> Option<u32> {
        if size == 0 {
            return None;
        }
        let small = self.classes.iter().position(|&c| c >= size && align <= 16);
        if let Some(c) = small {
            let obj = self.classes[c];
            let found = self.pages.iter().position(|p| matches!(p, PageState::Small { class, used } if *class == c && used.contains(&0)));
            let pi = match found {
                Some(i) => i,
                None => {
                    let i = self.pages.iter().position(|p| matches!(p, PageState::Free))?;
                    self.pages[i] = PageState::Small { class: c, used: vec![0; (self.page / obj) as usize] };
                    i
                }
            };
            let PageState::Small { used, .. } = &mut self.pages[pi] else { unreachable!() };
            let oi = used.iter().position(|&u| u == 0).unwrap();
            used[oi] = size;
            return Some(pi as u32 * self.page + oi as u32 * obj);
        }
        // Large: first-fit run of free pages.
        let n = size.div_ceil(self.page) as usize;
        let start = (0..=self.pages.len().checked_sub(n)?).find(|&s| self.pages[s..s + n].iter().all(|p| matches!(p, PageState::Free)))?;
        self.pages[start] = PageState::LargeHead { pages: n as u32, req: size };
        for p in &mut self.pages[start + 1..start + n] {
            *p = PageState::LargeTail;
        }
        Some(start as u32 * self.page)
    }

    fn free(&mut self, addr: u32) -> bool {
        let pi = (addr / self.page) as usize;
        let rel = addr % self.page;
        match self.pages.get_mut(pi) {
            Some(PageState::LargeHead { pages, .. }) if rel == 0 => {
                let n = *pages as usize;
                for p in &mut self.pages[pi..pi + n] {
                    *p = PageState::Free;
                }
                true
            }
            Some(PageState::Small { class, used }) => {
                let obj = self.classes[*class];
                let oi = (rel / obj) as usize;
                if rel % obj != 0 || oi >= used.len() || used[oi] == 0 {
                    return false;
                }
                used[oi] = 0;
                if used.iter().all(|&u| u == 0) {
                    self.pages[pi] = PageState::Free;
                }
                true
            }
            _ => false,
        }
    }

    fn reset(&mut self) {
        self.pages = vec![PageState::Free; (self.cap / self.page) as usize];
    }

    fn regions(&self) -> Regions {
        let mut r = Regions::default();
        for (i, p) in self.pages.iter().enumerate() {
            let base = i as u32 * self.page;
            match p {
                PageState::Free => r.push(base, self.page, FREE),
                PageState::Small { class, used } => {
                    let obj = self.classes[*class];
                    for (k, &u) in used.iter().enumerate() {
                        let o = base + k as u32 * obj;
                        if u == 0 {
                            r.push(o, obj, FREE);
                        } else {
                            r.push(o, u, LIVE);
                            r.push(o + u, obj - u, SLACK);
                        }
                    }
                    let used_end = base + used.len() as u32 * obj;
                    r.push(used_end, base + self.page - used_end, SLACK);
                }
                PageState::LargeHead { pages, req } => {
                    r.push(base, *req, LIVE);
                    r.push(base + req, pages * self.page - req, SLACK);
                }
                PageState::LargeTail => {}
            }
        }
        let end = self.pages.len() as u32 * self.page;
        r.push(end, self.cap - end, SLACK);
        r
    }
}
