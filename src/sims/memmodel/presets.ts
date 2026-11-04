/** Litmus tests used by the lessons. `weak` names the interesting outcome to look for. */
export interface Preset { id: string; label: string; note: string; src: string }

const p = (id: string, label: string, note: string, src: string): Preset => ({ id, label, note, src: src.replace(/^\n/, "") });

export const PRESETS: Record<string, Preset> = Object.fromEntries(
  [
    // ---------- atomic operations ----------
    p("lost-update-plain", "Counter: plain read + write", "Two threads each increment a plain int. Look for count=1, and for the data-race marker.", `
T0:
  r0 = count
  count = r0 + 1
T1:
  r1 = count
  count = r1 + 1
`),
    p("lost-update-atomic", "Counter: atomic load, then atomic store", "Each access is atomic, so there's no data race, but the increment as a whole is not. count=1 is still possible.", `
T0:
  r0 = count.load(relaxed)
  count.store(r0 + 1, relaxed)
T1:
  r1 = count.load(relaxed)
  count.store(r1 + 1, relaxed)
`),
    p("fetch-add", "Counter: fetch_add", "One indivisible read-modify-write. Even with relaxed ordering, count is always 2.", `
T0:
  r0 = count.fetch_add(1, relaxed)
T1:
  r1 = count.fetch_add(1, relaxed)
`),
    p("corr", "Coherence (CoRR)", "Even relaxed atomics agree on one order of writes per location: no thread sees x go from 2 back to 1.", `
T0:
  x.store(1, relaxed)
  x.store(2, relaxed)
T1:
  r0 = x.load(relaxed)
  r1 = x.load(relaxed)
`),
    // ---------- CAS ----------
    p("cas-race", "Two CAS on the same value", "Both threads try 0 → their id. Exactly one succeeds in every execution.", `
T0:
  r0 = x.cas(0, 1)
T1:
  r1 = x.cas(0, 2)
`),
    p("spinlock", "Spinlock protecting a plain counter", "lock() is a CAS loop with acquire; unlock() is a release store. The plain counter is race-free and always ends at 2.", `
T0:
  m.lock()
  r0 = count
  count = r0 + 1
  m.unlock()
T1:
  m.lock()
  r1 = count
  count = r1 + 1
  m.unlock()
`),
    p("spinlock-relaxed", "Spinlock with relaxed ordering", "The same lock with relaxed CAS and relaxed unlock. Mutual exclusion still holds, but nothing orders the counter accesses: data race.", `
T0:
  m.await_cas(0, 1, relaxed)
  r0 = count
  count = r0 + 1
  m.store(0, relaxed)
T1:
  m.await_cas(0, 1, relaxed)
  r1 = count
  count = r1 + 1
  m.store(0, relaxed)
`),
    // ---------- orderings ----------
    p("mp-relaxed", "Message passing, relaxed", "T0 writes data, then sets a flag. Can T1 see the flag but old data (r0=1, r1=0)?", `
T0:
  data.store(42, relaxed)
  flag.store(1, relaxed)
T1:
  r0 = flag.load(relaxed)
  r1 = data.load(relaxed)
`),
    p("mp-relacq", "Message passing, release/acquire", "Release on the flag store, acquire on the flag load: seeing the flag guarantees seeing the data.", `
T0:
  data.store(42, relaxed)
  flag.store(1, release)
T1:
  r0 = flag.load(acquire)
  r1 = data.load(relaxed)
`),
    p("sb-relaxed", "Store buffering, relaxed", "Each thread writes one variable, then reads the other. Can both read 0? This is the core of Dekker's algorithm.", `
T0:
  x.store(1, relaxed)
  r0 = y.load(relaxed)
T1:
  y.store(1, relaxed)
  r1 = x.load(relaxed)
`),
    p("sb-relacq", "Store buffering, release/acquire", "Release/acquire does not forbid r0=0, r1=0: it orders earlier writes before later writes, not a write before a later read.", `
T0:
  x.store(1, release)
  r0 = y.load(acquire)
T1:
  y.store(1, release)
  r1 = x.load(acquire)
`),
    p("sb-sc", "Store buffering, seq_cst", "seq_cst puts all four operations in one total order, so at least one thread sees the other's write.", `
T0:
  x.store(1)
  r0 = y.load()
T1:
  y.store(1)
  r1 = x.load()
`),
    p("iriw-acq", "IRIW, acquire loads", "Two writers, two readers. Can the readers disagree about which write happened first (r0=1 r1=0 r2=1 r3=0)?", `
T0:
  x.store(1, release)
T1:
  y.store(1, release)
T2:
  r0 = x.load(acquire)
  r1 = y.load(acquire)
T3:
  r2 = y.load(acquire)
  r3 = x.load(acquire)
`),
    p("iriw-sc", "IRIW, seq_cst", "With seq_cst everywhere, all threads agree on a single order of the two writes.", `
T0:
  x.store(1)
T1:
  y.store(1)
T2:
  r0 = x.load()
  r1 = y.load()
T3:
  r2 = y.load()
  r3 = x.load()
`),
    // ---------- fences ----------
    p("mp-fences", "Message passing with fences", "Relaxed accesses, plus a release fence before the flag store and an acquire fence after the flag load. The fences pair up and forbid r0=1, r1=0.", `
T0:
  data.store(42, relaxed)
  fence(release)
  flag.store(1, relaxed)
T1:
  r0 = flag.load(relaxed)
  fence(acquire)
  r1 = data.load(relaxed)
`),
    p("mp-one-fence", "Message passing, release fence only", "Without the matching acquire fence (or acquire load), the reader is not synchronized: r0=1, r1=0 is back.", `
T0:
  data.store(42, relaxed)
  fence(release)
  flag.store(1, relaxed)
T1:
  r0 = flag.load(relaxed)
  r1 = data.load(relaxed)
`),
    p("sb-fence-sc", "Store buffering with seq_cst fences", "A seq_cst fence between the store and the load forbids r0=0, r1=0. On x86 this is the MFENCE.", `
T0:
  x.store(1, relaxed)
  fence(seq_cst)
  r0 = y.load(relaxed)
T1:
  y.store(1, relaxed)
  fence(seq_cst)
  r1 = x.load(relaxed)
`),
    p("sb-fence-acqrel", "Store buffering with acq_rel fences", "acq_rel fences don't help here: store → load ordering needs seq_cst.", `
T0:
  x.store(1, relaxed)
  fence(acq_rel)
  r0 = y.load(relaxed)
T1:
  y.store(1, relaxed)
  fence(acq_rel)
  r1 = x.load(relaxed)
`),
    // ---------- happens-before ----------
    p("hb-race", "Plain data, relaxed flag", "The reader spins until it sees the flag, then reads plain data. The flag is relaxed, so there is no happens-before edge: data race.", `
T0:
  data = 42
  flag.store(1, relaxed)
T1:
  flag.await(1, relaxed)
  r0 = data
`),
    p("hb-ok", "Plain data, release/acquire flag", "Release store synchronizes with the acquire load that reads it: data = 42 happens-before r0 = data. No race, r0 is always 42.", `
T0:
  data = 42
  flag.store(1, release)
T1:
  flag.await(1, acquire)
  r0 = data
`),
    p("hb-chain", "Happens-before is transitive", "T0 → T1 via flag a, T1 → T2 via flag b. T2 can read T0's plain write safely even though they never touch the same atomic.", `
T0:
  data = 42
  a.store(1, release)
T1:
  a.await(1, acquire)
  b.store(1, release)
T2:
  b.await(1, acquire)
  r0 = data
`),
    p("hb-release-seq", "Release sequence through an RMW", "T1's relaxed fetch_add sits between T0's release store and T2's acquire load. RMWs continue the release sequence, so T2 still synchronizes with T0. (If T1 runs before T0, flag never reaches 2 and T2 spins forever: the "hangs" outcome.)", `
T0:
  data = 42
  flag.store(1, release)
T1:
  r0 = flag.fetch_add(1, relaxed)
T2:
  flag.await(2, acquire)
  r1 = data
`),
  ].map((x) => [x.id, x]),
);

export const LESSON_PRESETS = {
  atomics: ["lost-update-plain", "lost-update-atomic", "fetch-add", "corr"],
  cas: ["cas-race", "spinlock", "spinlock-relaxed", "fetch-add"],
  orderings: ["mp-relaxed", "mp-relacq", "sb-relaxed", "sb-relacq", "sb-sc", "iriw-acq", "iriw-sc", "corr"],
  fences: ["mp-fences", "mp-one-fence", "mp-relaxed", "sb-fence-sc", "sb-fence-acqrel"],
  hb: ["hb-race", "hb-ok", "hb-chain", "hb-release-seq", "spinlock", "spinlock-relaxed"],
} as const;
