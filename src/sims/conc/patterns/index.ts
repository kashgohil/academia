/**
 * Sims for the "patterns" module of the concurrency track. All timing views run on the shared Runtime
 * (src/sims/conc/runtime.ts); costs are MODEL INPUTS, labelled where they are defined.
 *
 * - forkjoin.ts: the work-span model. `sumDag` (the DAG of a recursive parallel sum with a grain size), `workSpan`
 *   (T1, T∞, parallelism), `greedy` (a list schedule on P processors; it meets Brent's bound), `bounds`,
 *   `nodeStates`, `grainPoint` (T_P and speedup for one grain), `algoWorkSpan` (work and span recurrences of a sum
 *   and two merge sorts).
 * - stealing.ts: `runSharing`, a loop of n items shared by P workers on the Runtime: static blocks, one central queue
 *   behind a mutex, or work stealing with per-worker deques (owner LIFO or FIFO, thieves take the top). It can record
 *   deque snapshots for a stepper.
 * - reduce.ts: float32 sums that depend on P and the combine order (`chunkedSum`, `referenceSum`), combine strategies
 *   on the Runtime (`runReduction`: shared accumulator, linear, tree), and key skew in a MapReduce shuffle
 *   (`shuffleLoad`, with or without a combiner).
 * - pipeline.ts: `runPipeline`, stages with replicas connected by bounded channels, ordered or unordered output,
 *   live tokens, batching. `stageRate` gives the capacity of one stage.
 * - falsesharing.ts: `coherenceRun`, a coherence model of fields in cache lines and the threads that touch them, and
 *   `runParallelFor`, a parallel loop with OpenMP-style static chunks that writes an array on the Runtime.
 */
export * from "./forkjoin";
export * from "./stealing";
export * from "./reduce";
export * from "./pipeline";
export * from "./falsesharing";
