/**
 * Sims for the async module of the concurrency track. Timing views run on the shared Runtime (src/sims/conc).
 *
 * - eventloop.ts: `runLoop(program)` steps the JavaScript event loop one callback at a time (browser: tasks and the
 *   microtask queue; Node: nextTick, microtasks and the libuv phases), with `candidates` and `isNext` for a learner
 *   who picks the next callback. `loopServer(params)` is a server on one event-loop thread (Runtime): one slow
 *   callback, run inline, in slices, or on a worker pool, and the latency of every other request.
 * - futures.ts: `gameStart/gameStep/gameReplay` is a pull executor that a learner drives (poll, wake, timers, a
 *   future that forgets its waker). `combine(children, combinator, cancel)` settles all/race/any/allSettled with JS
 *   semantics (no cancellation) or Rust semantics (drop the pending futures).
 * - statemachine.ts: `handlerStates` + `stateLayout` give the variants and size of an async fn's state machine,
 *   `pollTrace` steps it, `pinTrace` shows the self-reference that Pin protects, `taskMemory` compares futures,
 *   goroutines and threads.
 * - tokio.ts: `tokioSched(params)` models Tokio's multi-thread scheduler (local queues, LIFO slot, inject queue, work
 *   stealing, parking) on Runtime threads. `hogRun(params)` is a current_thread runtime with a heartbeat task and a
 *   task that hogs the thread (no budget, a budget, a blocking call, spawn_blocking).
 * - structured.ts: `runTree(tree, params)` runs a task tree with one failure under unstructured, structured and
 *   supervisor disciplines; `leakRun(params)` counts in-flight backend calls with and without cancellation at a timeout.
 */
export * from "./eventloop";
export * from "./futures";
export * from "./statemachine";
export * from "./tokio";
export * from "./structured";
