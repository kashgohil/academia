/**
 * Inter-process communication reference models. Pure TypeScript, no React.
 *
 * pipe:   `Pipe` (the fs/pipe.c ring with merge, blocking, EOF, SIGPIPE, F_SETPIPE_SZ and splice), `findSplit`, `checkStream`,
 *         `pipeInterleaveModel` and `explorePipe` (all schedules of writers and a reader), `pipeTransfer`, `pipeThroughput`.
 * signal: `SignalTask` (pending, blocked, signal frames, EINTR, SA_RESTART, rt_sigreturn), `SigPending`, `defaultAction`, `pickThread`,
 *         `coalesceRun`, `zombiesLeft`, and `handlerProg`, a program for the sync interleaving machine.
 * spsc:   `spscSteps`, `spscModel`, `exploreSpsc` (a ring with explicit orderings in a view-based memory model), `spscLitmus`
 *         (the same ring for src/sims/memmodel), `spscLineTraffic` (the ring's accesses through the MESI simulator).
 * shm:    `ShmWorld` (two AddressSpaces and one shmem file), `buildList`, `walkList`, `privateBreaksSharing`, `ipcCost`.
 * uds:    `UdsWorld` (fd tables, descriptions, skbs, SCM_RIGHTS, credentials, unix_gc), `UnixNames`, `TCP_LAYERS`, `UNIX_LAYERS`, `pathCost`.
 *
 * Constants named *_COST or *_MODEL are model inputs, not measurements. Constants named *_FACTS are real values from Linux.
 */
export * from "./pipe";
export * from "./signal";
export * from "./spsc";
export * from "./shm";
export * from "./uds";
