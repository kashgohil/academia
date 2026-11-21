/**
 * Virtual memory from the hardware side, for the architecture track's vm module. The OS track's sims
 * (src/sims/os/vm) model x86-64 tables, the kernel fault path and shootdown costs; these model the circuits
 * and the ISA rules.
 *
 * - vipt: cacheGeometry (index bits, alias bits, colors, the ways × page size limit), REAL_L1D, hitTiming for
 *   PIPT, VIPT and VIVT, and AliasCache, a tiny cache that shows the synonym bug (ALIAS_SCENE, aliasScene).
 * - sv39: the RISC-V Sv39 translation algorithm step by step (walkSv39), PTE bits, Sv39Space (builds tables
 *   in PhysMem), PAGE_FAULT_CAUSE (12, 13, 15), Svade and Svadu, and sv39Scene for the walker demo.
 * - walkcache: runWalks (a TLB plus one walk cache per non-leaf level), pageTrace, walkPoint, WALK_MODEL.
 * - tlbarray: TlbArray (sets, ways, LRU, tree pseudo-LRU, FIFO, random, coalescing of contiguous pages),
 *   tlbMissRate, contiguity, reachBytes, tlbSetIndex.
 * - fence: FENCES (sfence.vma, invlpg, invpcid, mov cr3, tlbi), applyFence on two cores, staleTimeline.
 * - trap: runTrapPipeline, a 5-stage pipeline with precise (or draining) page-fault traps; trapCost.
 * - multipage: repMovsb and misalignedStore, faults in the middle of an instruction that spans two pages.
 *
 * Constants named *_MODEL are model inputs, not measurements.
 */
export * from "./vipt";
export * from "./sv39";
export * from "./walkcache";
export * from "./tlbarray";
export * from "./fence";
export * from "./trap";
export * from "./multipage";
