/**
 * Shared code for the concurrency track.
 *
 * - runtime.ts: Runtime, a deterministic discrete-event simulator of threads on P cores, with mutexes (block, spin,
 *   adaptive; handoff or barging), reader-writer locks, condition variables, semaphores, Go-style channels with
 *   select, spawn and join. Costs (context switch, wake-up, atomic acquire, cache-line transfer) are model inputs with
 *   documented defaults (DEFAULT_COSTS). Read its header comment first.
 * - For single atomic steps, interleavings chosen by a learner and exhaustive exploration, import
 *   src/sims/os/sync/machine.ts directly. It is not re-exported here.
 *
 * A thread is a generator function. Blocking operations are sub-generators, used with `yield*`, so results are typed:
 *
 * ```ts
 * const rt = new Runtime({ cores: 2, seed: 1 });
 * const m = rt.mutex("m");
 * const ch = rt.channel<number>("jobs", 4);
 * rt.spawn("producer", function* (t) {
 *   for (let i = 0; i < 10; i++) { yield* t.work(1_000, "make"); yield* t.send(ch, i); }
 *   t.close(ch);
 * });
 * rt.spawn("consumer", function* (t) {
 *   for (;;) { const r = yield* t.recv(ch); if (!r.ok) break; yield* t.lock(m); yield* t.work(500, "cs"); t.unlock(m); }
 * });
 * const res = rt.run();               // or rt.run({ untilNs }), and rt.step() for steppers
 * ```
 *
 * Runtime:
 * - `new Runtime({ cores, seed, sched: "fifo" | "random", quantumNs, switchNs, wakeNs, lockNs, transferNs, record })`
 * - `rt.mutex(name, { wait: "block" | "spin" | "adaptive", handoff, spinNs })`, `rt.rwlock(name, { prefer })`,
 *   `rt.cond(name, { spuriousRate })`, `rt.semaphore(name, n)`, `rt.channel<T>(name, capacity)`
 * - `rt.spawn(name, fn)`, `rt.at(tNs, (rt) => ...)`, `rt.run({ untilNs, maxEvents })`, `rt.step()`, `rt.result()`
 *
 * Thread handle `t` (blocking calls need `yield*`):
 * - time: `work(ns, label?)`, `sleep(ns)`, `yieldNow()`, `now()`, `rand()`, `id`, `name`
 * - mutex: `lock(m)`, `unlock(m)`, `tryLock(m)`; rwlock: `rlock`, `runlock`, `wlock`, `wunlock`
 * - condition variable: `wait(cv, m)`, `signal(cv)`, `broadcast(cv)`; semaphore: `acquire(s)`, `release(s)`
 * - channel: `send(ch, v)`, `recv(ch)` → `{ ok, value }`, `trySend`, `tryRecv`, `close(ch)`,
 *   `select([{ recv: a }, { send: b, value: 1 }], { default: true })` → `{ index, value?, ok? }` (index -1: default)
 * - threads: `spawn(name, fn)` → id, `join(id)` → the thread's return value
 *
 * The result (`RunResult`): `spans` per core (run, spin, switch), `states` per thread (running, runnable, blocked,
 * sleeping, spinning, with `on`), `events`, statistics per thread, core, mutex, rwlock, semaphore, cond and channel,
 * `makespan`, `error` (a panic) and `deadlock`. The view for it is ThreadTimeline in src/demos/conc/ConcViews.tsx.
 */
export * from "./runtime";
