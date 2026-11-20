/**
 * Sims for the message-passing module of the concurrency track. Timing models run on the shared Runtime
 * (src/sims/conc/runtime.ts); step models are small state machines that a learner drives.
 *
 * - csp.ts: `runProducerConsumer` (a producer and a consumer on one channel of capacity C) and `ChanHb` (one channel,
 *   step by step, with the happens-before edges of the Go memory model).
 * - hchan.ts: `Hchan`, a model of Go's runtime channel (ring buffer, sendx/recvx, sendq/recvq of sudogs, close), with
 *   the code path of chan.go that each operation takes.
 * - select.ts: `runSelectFairness` (Go's random select against the priority idiom), `selectBothReady`, and `runLeak`
 *   (goroutine leaks from a blocked send after a timeout). GO_COSTS are the goroutine cost model inputs.
 * - actor.ts: `runMailbox` (selective receive on a long mailbox, with and without the reference optimization),
 *   `tippingBacklog`, and `Supervisor` (OTP restart strategies and restart intensity).
 * - backpressure.ts: `runOverload` (full-queue policies under overload), `runPipeline` (backpressure across stages),
 *   `runCredits` (credit-based flow control, as in Reactive Streams), and `quantile`.
 */
export * from "./csp";
export * from "./hchan";
export * from "./select";
export * from "./actor";
export * from "./backpressure";
