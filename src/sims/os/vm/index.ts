/**
 * Virtual memory reference implementations, for the vm lessons and for later modules.
 *
 * - addr: bit arithmetic, canonical checks, splitVa, hexVa, flatTableBytes, nestedWalkReads, granule.
 * - pagetable: PTE bits, TableMem (table frames), PageTable (map, unmap, walk with an event log, nodes),
 *   tablesForStride (exact table count without building the tree).
 * - vma: VmaTree (find, findFirstAfter, insert with merge, remove and protect with split).
 * - fault: VmKernel (frames, page cache, swap, zero page), AddressSpace (mmap, munmap, mprotect, fork, swapOut,
 *   access = the fault path with a decision log), FAULT_COST_NS, effectiveAccessNs, overcommitCheck, touchRun.
 * - tlb: Tlb (set-associative, LRU, ASIDs, global entries), Mmu (TLB levels in front of a PageTable),
 *   tlbPattern, chase and reachRow (reach model), shootdown (IPI cost model).
 * - physmem: PhysMem (2 MiB blocks, fragment, allocSmall, allocBlock, compactOne), ThpSim (huge fault, fallback,
 *   khugepaged, compaction counters).
 * - layout: procMaps, addressMap, processBases (ASLR), twoProcesses.
 *
 * Cost and size constants named *_MODEL or *_COST or *_NS are model inputs, not measurements.
 */
export * from "./addr";
export * from "./pagetable";
export * from "./vma";
export * from "./fault";
export * from "./tlb";
export * from "./physmem";
export * from "./layout";
