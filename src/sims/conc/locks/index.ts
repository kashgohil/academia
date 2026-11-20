/**
 * Sims for the locks module of the concurrency track. Timing models run on the shared Runtime (src/sims/conc);
 * step-level models run on the interleaving machine (src/sims/os/sync/machine.ts).
 *
 * - mutex.ts: `lockLoop` (handoff against barging on a Runtime mutex) and `GoMutex` / `goMutexLoop`, a reference model
 *   of Go's sync.Mutex with its state word, spinning, LIFO requeue and starvation mode.
 * - rwlock.ts: `goRwProg` (Go's RWMutex as atomic steps; recursive read locking deadlocks), `seqlockProg`, and
 *   `rwLoop` (reader, writer preference or a plain mutex on the Runtime).
 * - condvar.ts: `barrierRun` (a reusable barrier with and without a generation number) and `timedWaitRun`
 *   (a relative timeout in a loop against a fixed deadline).
 * - deadlock.ts: `transfers` (try-lock with back-off, livelock, std::lock style, lock order) and `abba` (a deadlock
 *   and when the runtime can see it).
 * - contention.ts: `contendedLoop` (throughput against threads for block, spin and adaptive waiting), `lockBound`,
 *   and `stripedLoop` (lock striping with a Zipf key distribution).
 *
 * Costs are the Runtime's model inputs (DEFAULT_COSTS), plus the ones each file labels as MODEL INPUT.
 */
export * from "./mutex";
export * from "./rwlock";
export * from "./condvar";
export * from "./deadlock";
export {
  contendedLoop, idealPerMs, lockBound, saturationThreads, SWEEP_THREADS, zipfCdf, pickKey, stripedLoop, STRIPE_DEFAULTS,
  LOOP_DEFAULTS as CONTENTION_DEFAULTS,
  type WaitPolicy, type LoopStats, type StripeSpec, type StripeStats,
  type LoopSpec as ContentionSpec,
} from "./contention";
