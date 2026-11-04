//! LRU stack distances (Mattson et al., 1970). The distance of an access is the number of
//! distinct lines touched since the previous access to the same line. A fully associative
//! LRU cache of C lines hits exactly the accesses with distance < C, for every C at once.

pub const COLD: u32 = u32::MAX;

pub fn stack_distances(addrs: &[u32], line_bits: u32) -> Vec<u32> {
    let mut stack: Vec<u32> = Vec::new(); // most recent at the end
    addrs
        .iter()
        .map(|&a| {
            let l = a >> line_bits;
            match stack.iter().rposition(|&x| x == l) {
                Some(i) => {
                    let d = (stack.len() - 1 - i) as u32;
                    stack.remove(i);
                    stack.push(l);
                    d
                }
                None => {
                    stack.push(l);
                    COLD
                }
            }
        })
        .collect()
}
