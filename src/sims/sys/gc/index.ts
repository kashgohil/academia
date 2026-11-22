/**
 * Sims of the gc module (systems/gc): collectors as algorithms with measurable costs. Every collector runs on ONE
 * object-graph model (heap.ts), so the lessons compare like with like.
 *
 * - heap.ts: the model. `Graph` (objects with pointer fields, named roots), `build`, `apply` (a mutator operation),
 *   `reachable`, `garbage`, `dangling`, `without`, `rng` (deterministic), and `toMachine`, which copies a graph into
 *   the shared program-memory machine (src/sims/sys/mem) for the shared heap views and its LeakSanitizer check.
 * - rc.ts: reference counting (`rcInit`, `rcStore` with the cascade of frees, `rcLeaked`), Bacon and Rajan's trial
 *   deletion (`trialDeletion`), and measured Rc/Arc count costs (`RC_BENCH`, `rcBench`).
 * - marksweep.ts: `markSweep` frames (mark stack, sweep into free runs), `freeStats`, `stackScan` (precise vs
 *   conservative root finding on the shared machine), and `tracingCost` (a cost model with MODEL INPUTS).
 * - copying.ts: Cheney's algorithm (`cheney`), copy orders (`copyOrder`), layouts (`scattered`, `packed`), and
 *   `lineSwitches` for locality.
 * - generational.ts: `genSim` (a lifetime model: minor and major work against a non-generational baseline) and
 *   `cardFrames` (an old-to-young store with and without a card-marking barrier).
 * - concurrent.ts: a mutator and a marker that take turns (`mutatorStep`, `markerStep`, `runSchedule`, `verdict`)
 *   under four barriers (none, Dijkstra, Yuasa, Go's hybrid), two scenarios, and `barrierTrials` over random runs.
 * - gogc.ts: Go's heap goal (`heapGoal`), a steady-state pacing model (`goCycle`, `sawtooth`), and real gctrace
 *   output from go1.25.6 (`GCTRACE`, `parseTrace`).
 * - scenarios.ts: the graphs of the lessons, with positions for the views.
 */
export * from "./heap";
export * from "./rc";
export * from "./marksweep";
export * from "./copying";
export * from "./generational";
export * from "./concurrent";
export * from "./gogc";
export * from "./scenarios";
