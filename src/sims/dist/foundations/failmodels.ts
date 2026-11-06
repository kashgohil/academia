/**
 * One small replicated write, run under each failure model.
 *
 * The protocol is a plain majority quorum, built for crash-stop failures with f = 1:
 *   - at t = 0 the client sends write(x = 1, version 1) to every replica; it reports "committed" when W replicas
 *     acknowledge before its deadline, and "failed" otherwise;
 *   - at t = 100 it reads x from the two nearest replicas (R1 and R2); a replica that does not answer within
 *     25 ms is replaced by the next one; it returns the value with the highest version.
 * In every run the network loses the write to R2 (a short partition). A majority quorum is built to survive that.
 * Replica R1 is the faulty node, and the failure model says what it may do.
 *
 * The fix for each model changes one thing: persist before the ack; retry the write; treat a timeout as "unknown";
 * or use 3f + 1 = 4 replicas and accept a value only when f + 1 = 2 replicas return it.
 */
import { Net } from "../net";
import { isolate, runScript, type Action } from "./script";

export type Model = "none" | "crash-stop" | "crash-recovery" | "omission" | "timing" | "byzantine";
export const MODELS: Model[] = ["none", "crash-stop", "crash-recovery", "omission", "timing", "byzantine"];

export const MODEL_TEXT: Record<Model, string> = {
  none: "no fault",
  "crash-stop": "crash-stop",
  "crash-recovery": "crash-recovery",
  omission: "omission",
  timing: "timing",
  byzantine: "Byzantine",
};

/** What R1 does under each model. */
export const FAULT_TEXT: Record<Model, string> = {
  none: "R1 works correctly.",
  "crash-stop": "R1 acknowledges the write, then crashes at 30 ms and never comes back.",
  "crash-recovery": "R1 acknowledges the write from memory, crashes at 30 ms and restarts at 60 ms with only what it saved to disk.",
  omission: "R1 is up, but it silently drops the write request. It still answers reads.",
  timing: "R1 is slow: it takes 70 ms to apply the write, so its ack comes after the client deadline.",
  byzantine: "R1 acknowledges the write without storing it, and answers the read with x = 666 at version 9.",
};

export const FIX_TEXT: Record<Model, string> = {
  none: "No fix is necessary.",
  "crash-stop": "No fix is necessary: 2f + 1 = 3 replicas tolerate one crash.",
  "crash-recovery": "Write the value to disk (fsync) before the ack.",
  omission: "Send the write again to the replicas that did not acknowledge it.",
  timing: "Report a timeout as \"outcome unknown\", not as \"failed\".",
  byzantine: "Use 3f + 1 = 4 replicas, wait for 3 acks, and accept a value only when 2 replicas return it.",
};

interface Val {
  x: number;
  ver: number;
}

type FmMsg =
  | { k: "write"; val: Val }
  | { k: "ack" }
  | { k: "read" }
  | { k: "value"; val: Val };

export const FM = { latency: 10, work: 1, slowWork: 70, deadline: 40, readAt: 100, readTimeout: 25, crashAt: 30, recoverAt: 60, end: 170 };

export type Claim = "committed" | "failed" | "unknown";

export interface FmResult {
  net: Net<FmMsg>;
  n: number;
  claim: Claim;
  claimAt: number;
  readValue: number | null;
  readAt?: number;
  /** True if the client claim and the read agree, and the read returned a value that some client wrote. */
  ok: boolean;
  why: string;
  /** Replica values at the end, for the view. */
  stores: (Val | null)[];
}

export function replicatedWrite(model: Model, fix: boolean): FmResult {
  const bft = model === "byzantine" && fix;
  const n = bft ? 4 : 3;
  const N = n + 1;
  const W = bft ? 3 : 2;
  const R1 = 2; // node id of replica R1
  const R2 = 3;
  const { latency, work, slowWork, deadline, readAt, readTimeout, crashAt, recoverAt, end } = FM;
  const persist = model === "crash-recovery" && fix;
  const mem: (Val | null)[] = Array.from({ length: N }, () => ({ x: 0, ver: 0 }));
  const disk: (Val | null)[] = Array.from({ length: N }, () => ({ x: 0, ver: 0 }));
  const acked = new Set<number>();
  let claim = null as Claim | null;
  let claimAt = 0;
  const replies = new Map<number, Val>();
  const asked = new Set<number>();
  let readValue: number | null = null;
  let readDoneAt: number | undefined;
  const readOrder = bft ? [2, 3, 4, 1] : [2, 3, 1]; // R1, R2, (R3), then R0
  const quorumR = bft ? 3 : 2;

  const tryFinishRead = (nt: Net<FmMsg>) => {
    if (readValue !== null) return;
    const vals = [...replies.values()];
    if (bft) {
      // f + 1 = 2 matching answers: at least one of them comes from a correct replica.
      for (const v of vals) {
        if (vals.filter((u) => u.x === v.x && u.ver === v.ver).length >= 2) {
          readValue = v.x;
          readDoneAt = nt.now;
          nt.note(0, `read x = ${v.x}`);
          return;
        }
      }
      return;
    }
    if (vals.length >= quorumR) {
      const best = vals.reduce((a, b) => (b.ver > a.ver ? b : a));
      readValue = best.x;
      readDoneAt = nt.now;
      nt.note(0, `read x = ${best.x}`);
    }
  };

  const net = new Net<FmMsg>(N, { seed: 1, latency: { min: latency, max: latency } }, {
    onMessage(node, msg, nt) {
      const p = msg.payload;
      if (node === 0) {
        if (p.k === "ack") {
          acked.add(msg.from);
          if (claim === null && acked.size >= W) {
            claim = "committed";
            claimAt = nt.now;
            nt.note(0, "committed");
          }
        } else if (p.k === "value" && readValue === null) {
          replies.set(msg.from, p.val);
          tryFinishRead(nt);
        }
        return;
      }
      if (p.k === "write") {
        if (node === R1 && model === "omission") return; // silently dropped
        if (node === R1 && model === "byzantine") return void nt.send(node, 0, { k: "ack" }); // lies
        const delay = node === R1 && model === "timing" ? slowWork : work;
        nt.setTimer(node, delay, "apply");
        pending[node] = p.val;
      } else if (p.k === "read") {
        const v = node === R1 && model === "byzantine" ? { x: 666, ver: 9 } : mem[node]!;
        nt.send(node, 0, { k: "value", val: v });
      }
    },
    onTimer(node, tag, nt) {
      if (tag === "apply") {
        const v = pending[node]!;
        mem[node] = v;
        if (persist || node !== R1) disk[node] = v;
        nt.send(node, 0, { k: "ack" });
      } else if (tag === "deadline" && claim === null) {
        if (model === "omission" && fix) {
          // Send the write again to every replica that has not acknowledged it.
          for (let r = 1; r < N; r++) if (!acked.has(r)) nt.send(0, r, { k: "write", val: { x: 1, ver: 1 } });
          nt.setTimer(0, deadline, "deadline2");
        } else {
          claim = model === "timing" && fix ? "unknown" : "failed";
          claimAt = nt.now;
          nt.note(0, claim === "failed" ? "failed" : "unknown");
        }
      } else if (tag === "deadline2" && claim === null) {
        claim = "failed";
        claimAt = nt.now;
      } else if (tag === "readTimeout" && readValue === null) {
        // Ask the next replicas that have not been asked yet, one per missing answer.
        const missing = Math.max(1, quorumR - replies.size);
        const next = readOrder.filter((r) => !asked.has(r)).slice(0, missing);
        for (const r of next) {
          asked.add(r);
          nt.send(0, r, { k: "read" });
        }
        if (next.length) nt.setTimer(0, readTimeout, "readTimeout");
      }
    },
    onRecover(node) {
      mem[node] = disk[node]!;
    },
  });
  const pending: (Val | null)[] = Array.from({ length: N }, () => null);

  const actions: Action<FmMsg>[] = [
    { t: 0, run: (nt) => {
      for (let r = 1; r < N; r++) nt.send(0, r, { k: "write", val: { x: 1, ver: 1 } });
      nt.setTimer(0, deadline, "deadline");
    } },
    // The network loses the first write to R2.
    ...isolate<FmMsg>(N, R2, 0.5, latency + 0.5),
    { t: readAt, run: (nt) => {
      for (const r of readOrder.slice(0, quorumR)) {
        asked.add(r);
        nt.send(0, r, { k: "read" });
      }
      nt.setTimer(0, readTimeout, "readTimeout");
    } },
  ];
  if (model === "crash-stop" || model === "crash-recovery") actions.push({ t: crashAt, run: (nt) => nt.crash(R1) });
  if (model === "crash-recovery") actions.push({ t: recoverAt, run: (nt) => nt.recover(R1) });
  runScript(net, actions, end);

  const c: Claim = claim ?? "failed";
  let ok: boolean;
  let why: string;
  if (readValue === null) {
    ok = false;
    why = "The read did not finish.";
  } else if (readValue !== 0 && readValue !== 1) {
    ok = false;
    why = `The read returned x = ${readValue}, a value that no client wrote.`;
  } else if (c === "committed" && readValue !== 1) {
    ok = false;
    why = "The client was told \"committed\", but the read returned the old value. A committed write is lost.";
  } else if (c === "failed" && readValue === 1) {
    ok = false;
    why = "The client was told \"failed\", but the read returned the new value. The write took effect.";
  } else if (c === "failed" && mem.some((v, i) => i > 0 && v?.ver === 1)) {
    ok = false;
    const holders = mem.flatMap((v, i) => (i > 0 && v?.ver === 1 ? [`R${i - 1}`] : []));
    why = `The client was told "failed", and this read returned the old value. But ${holders.join(" and ")} kept the new value, so a read that reaches ${holders.length > 1 ? "them" : "it"} returns x = 1.`;
  } else if (c === "unknown") {
    ok = true;
    why = `The client knows that the outcome is unknown. The read shows x = ${readValue}, so it can find out.`;
  } else {
    ok = true;
    why = c === "committed" ? "The write committed, and the read returned it." : "The write failed, and the read returned the old value.";
  }
  return { net, n, claim: c, claimAt, readValue, readAt: readDoneAt, ok, why, stores: mem.slice(1) };
}
