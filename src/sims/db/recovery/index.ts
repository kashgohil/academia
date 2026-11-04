/**
 * Recovery sims: a WAL engine with a buffer pool, LSNs, CLRs, fuzzy checkpoints, crash injection
 * and ARIES restart recovery, plus the models behind the recovery lessons.
 *
 * Engine API (reused by the capstone engine module):
 *   const db = new Db({ nPages, nSlots });            // enforceWal defaults to true
 *   const t = db.begin(); db.update(t, page, slot, v); db.commit(t);   // or db.abort(t)
 *   db.flushPage(p); db.flushLog(); db.checkpoint();   // or beginCheckpoint() / endCheckpoint()
 *   const after = db.crash();                          // durable state only
 *   new Recovery(after).run();                         // or step() for a stepper
 *   after.diffFromAcked()                              // [] when recovery is correct
 */
export * from "./core";
export * from "./aries";
export * from "./workload";
export * from "./scenarios";
export * from "./policy";
export * from "./groupcommit";
export * as logforms from "./logforms";
export * as checkpointsim from "./checkpointsim";
export * from "./pgwal";
