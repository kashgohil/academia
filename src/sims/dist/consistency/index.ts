/**
 * Consistency models for replicated objects, and checkers for them. Other modules (the capstone, Jepsen-style tests
 * of a Raft store) import from here.
 *
 * Histories (history.ts)
 *   HOp: { id, client, key, f: "r" | "w" | "cas", value, call, ret }. ret = Infinity marks a pending operation.
 *   mk([[client, "w"|"r", key, value, call, ret], ...]) writes a history by hand. randomHistory(rng, opts) makes one
 *   from a real atomic register (linearizable), with optional corrupted reads and pending writes.
 *
 * Linearizability (linearizability.ts)
 *   checkLinearizable(history, model, { memo, trace, maxStates }) -> LinResult
 *     The exact search of Wing and Gong with the configuration cache of Lowe (as in Knossos and Porcupine).
 *     ok: true | false | null (budget hit); order: a valid linearization; explored, cacheHits: the cost;
 *     best, blocked: the longest valid prefix and the candidates that all failed after it; trace: search steps.
 *   checkRegister(history, { partition }) checks a register history key by key (the default) or as one object.
 *   Models: registerModel(), kvModel(), or your own { init, step, hash }.
 *   bruteForceLinearizable (tests only), linearizationPoints (for drawing), provablyStaleReads (a quick sufficient test).
 *
 * Weaker models (models.ts, litmus.ts)
 *   checkSequential, checkCausal, checkEventual, checkModel(name, history) -> { ok, order?, why? }. LITMUS: histories with
 *   their expected verdicts.
 *
 * Systems on Net
 *   store.ts    runStore(cfg): a leader-based replicated register with read paths readindex | leader | follower, and faults.
 *   gossip.ts   runGossip(cfg): last-writer-wins replicas that converge by anti-entropy (push, pull, push-pull).
 *   pbs.ts      PBS (probabilistically bounded staleness) for partial quorums, and quorum latency.
 *   session.ts  runSession(cfg): a mobile client and weakly consistent servers with the four session guarantees.
 *   tokens.ts   runTokens(cfg): read-your-writes with an LSN token: none, wait or redirect.
 *   cap.ts      runCap(choice): the two-node partition from the proof of Gilbert and Lynch.
 *   causal.ts   runCausal(cfg): a reply seen before its question, and the fix with dependency metadata (COPS).
 *   jepsen.ts   miniJepsen (a store run with a nemesis, checked with a trace) and checkerCost sweeps.
 */
export * from "./history";
export * from "./linearizability";
export * from "./models";
export * from "./litmus";
export * from "./store";
export * from "./gossip";
export * from "./pbs";
export * from "./session";
export * from "./tokens";
export * from "./cap";
export * from "./jepsen";
export * from "./causal";
