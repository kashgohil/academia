/**
 * CRDTs: conflict-free replicated data types, as small reference implementations on the shared Net (../net.ts).
 * Later modules (the capstone) import from here.
 *
 * lattice.ts  State-based CRDTs as join-semilattices: StateCrdt<S, Op, V> { init, update, merge, leq, value, entries }.
 *             gCounter, pnCounter, maxRegister, lwwRegister, gSet, and lwwCounter (the naive counter that loses
 *             concurrent increments but still converges). checkLaws (commutative, associative, idempotent, upper
 *             bound, inflation). Finite lattices to draw: gCounterLattice, powersetLattice, chainLattice, hasseEdges,
 *             upperBounds. counterStateBytes (16 bytes per entry, a model input).
 * gossip.ts   runStateCluster(crdt, actions, cfg): replicas that gossip full states (or deltas) on Net, with
 *             partitions, duplicates and loss. PRESET_ACTIONS, agree, gossipBytes (full state versus delta size).
 * causal.ts   CausalNet<Op>: reliable causal broadcast (vector clocks, a buffer, duplicate drop, anti-entropy resend,
 *             causal stability). Modes without causal order or without dedupe show what breaks.
 * opbased.ts  Op-based counter and OR-Set on CausalNet: runOpBased(cfg), brokenShare. The hold-mode stepper:
 *             replaySteps(actions, causal), presetSteps.
 * sets.ts     2P-Set, LWW-element-Set, OR-Set with tombstones, the optimized OR-Set (dots and a version vector, no
 *             tombstones), OR-Map with nested PN-Counters. playSet (two replicas, the playground), SET_PRESETS.
 *             runTombstones(mode): metadata over time with tombstones kept, collected at causal stability, or none.
 * rga.ts      RGA (ids, tombstones, the skip rule), editOps (text diff to ops), Logoot-style dense positions
 *             (allocBetween, posCompare), interleave(algo, ...) for RGA, Logoot-style and index-based ops, and
 *             RgaNet: RGA replicas on CausalNet with anti-entropy.
 */
export * from "./lattice";
export * from "./gossip";
export * from "./causal";
export * from "./opbased";
export * from "./sets";
export * from "./rga";
