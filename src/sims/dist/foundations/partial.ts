/**
 * Partial failure: a client calls three services at once. The adversary chooses what happens to each call.
 * At its timeout the client sees the same thing for every failure: no reply. But the services are in different states:
 * some did the work and some did not. This is the central difficulty of distributed systems.
 */
import { Net } from "../net";
import { isolateAll, runScript, type Action } from "./script";

export type Fate = "ok" | "request-lost" | "reply-lost" | "slow" | "crashed";
export const FATES: Fate[] = ["ok", "request-lost", "reply-lost", "slow", "crashed"];

export const FATE_TEXT: Record<Fate, string> = {
  ok: "works",
  "request-lost": "request lost",
  "reply-lost": "reply lost",
  slow: "slow",
  crashed: "crashed",
};

export interface PartialMsg {
  k: "req" | "reply";
  svc: number;
}

/** Timing of the scenario in ms. One-way latency is fixed so that the adversary can aim at single messages. */
export const PARTIAL = { latency: 10, work: 2, slowWork: 60, timeout: 40, end: 100 };

export interface SvcOutcome {
  fate: Fate;
  /** True if the service did the work (for example, it wrote the row). */
  applied: boolean;
  appliedAt?: number;
  /** When the reply reached the client, if it did. */
  replyAt?: number;
  /** What the client knows at its timeout. */
  clientSees: "reply" | "no reply";
}

export function partialFailureRun(fates: Fate[]) {
  const n = fates.length + 1;
  const { latency, work, slowWork, timeout, end } = PARTIAL;
  const out: SvcOutcome[] = fates.map((fate) => ({ fate, applied: false, clientSees: "no reply" }));
  const net = new Net<PartialMsg>(n, { seed: 1, latency: { min: latency, max: latency } }, {
    onMessage(node, msg, nt) {
      const p = msg.payload;
      if (p.k === "req") nt.setTimer(node, fates[p.svc] === "slow" ? slowWork : work, "done");
      else if (node === 0) {
        out[p.svc]!.replyAt = nt.now;
        if (nt.now <= timeout) out[p.svc]!.clientSees = "reply";
      }
    },
    onTimer(node, tag, nt) {
      if (tag === "done") {
        const o = out[node - 1]!;
        o.applied = true;
        o.appliedAt = nt.now;
        nt.note(node, "applied");
        nt.send(node, 0, { k: "reply", svc: node - 1 });
      } else if (tag === "timeout") nt.note(0, "timeout");
    },
  });
  const svcs = (f: Fate) => fates.flatMap((x, i) => (x === f ? [i + 1] : []));
  const actions: Action<PartialMsg>[] = [
    // The request is in flight during [0, latency]: cut those services off while it arrives.
    ...isolateAll<PartialMsg>(n, svcs("request-lost"), 0.5, latency + 0.5),
    // The fast reply is in flight during [latency + work, 2 latency + work].
    ...isolateAll<PartialMsg>(n, svcs("reply-lost"), latency + 0.75, 2 * latency + work + 0.5),
    {
      t: 0,
      run: (nt) => {
        for (const i of svcs("crashed")) nt.crash(i);
        for (let s = 0; s < fates.length; s++) nt.send(0, s + 1, { k: "req", svc: s });
        nt.setTimer(0, timeout, "timeout");
      },
    },
  ];
  runScript(net, actions, end);
  return { net, out };
}
