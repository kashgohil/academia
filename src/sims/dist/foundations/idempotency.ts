/**
 * Idempotency keys. A client asks a payment server to "charge $10". If no reply comes within its timeout, it sends
 * the request again. The adversary picks the fate of each attempt:
 *   ok: request and reply arrive;  request-lost;  reply-lost;  slow: the server takes longer than the client timeout;
 *   dup: the network delivers the request twice.
 *
 * Without a key, the server charges once per request that arrives. With a key, the server keeps a table
 * key -> (in progress | result). It records the key and the charge in one atomic step, and answers a repeat with the
 * stored result, so the charge runs at most once. The table forgets a key after `ttl` ms (Stripe keeps keys for a day;
 * the model uses a short time so that a demo can show what expiry does).
 */
import { Net } from "../net";
import { isolate, runScript, type Action } from "./script";

export type AttemptFate = "ok" | "request-lost" | "reply-lost" | "slow" | "dup";
export const ATTEMPT_FATES: AttemptFate[] = ["ok", "request-lost", "reply-lost", "slow", "dup"];
export const ATTEMPT_TEXT: Record<AttemptFate, string> = { ok: "arrives", "request-lost": "request lost", "reply-lost": "reply lost", slow: "slow server", dup: "duplicated" };

export const IDEM = { latency: 10, work: 2, slowWork: 45, timeout: 30, amount: 10 };

type IMsg = { k: "charge"; key: string | null; attempt: number } | { k: "result"; chargeId: number; attempt: number; replay: boolean } | { k: "busy"; attempt: number };

export interface IdemResult {
  net: Net<IMsg>;
  /** Number of times the server took money. */
  charges: number;
  /** True when the client got a reply, and the charge id it got. */
  done: boolean;
  chargeId?: number;
  doneAt?: number;
  attemptsSent: number;
  /** Requests that reached the server. */
  arrived: number;
  replays: number;
}

/**
 * Runs the attempts. Attempt i starts at i * timeout if the client has no reply yet. `ttl` is how long the server
 * keeps a key (Infinity: forever).
 */
export function chargeRun(fates: AttemptFate[], useKey: boolean, ttl = Infinity): IdemResult {
  const { latency: L, work, slowWork, timeout: T } = IDEM;
  let charges = 0;
  let arrived = 0;
  let replays = 0;
  let done = false;
  let chargeId: number | undefined;
  let doneAt: number | undefined;
  let sent = 0;
  const table = new Map<string, { at: number; result: number | null }>();

  const net = new Net<IMsg>(2, { seed: 1, latency: { min: L, max: L } }, {
    onMessage(node, msg, nt) {
      const p = msg.payload;
      if (node === 1 && p.k === "charge") {
        arrived++;
        const delay = fates[p.attempt] === "slow" ? slowWork : work;
        if (p.key !== null) {
          const e = table.get(p.key);
          if (e && nt.now - e.at <= ttl) {
            if (e.result !== null) {
              replays++;
              nt.send(1, 0, { k: "result", chargeId: e.result, attempt: p.attempt, replay: true });
            } else nt.send(1, 0, { k: "busy", attempt: p.attempt }); // the first request is still running
            return;
          }
          table.set(p.key, { at: nt.now, result: null });
        }
        nt.setTimer(1, delay, `charge:${p.attempt}:${p.key ?? ""}`);
      } else if (node === 0 && p.k === "result" && !done) {
        done = true;
        chargeId = p.chargeId;
        doneAt = nt.now;
        nt.note(0, "paid");
      }
    },
    onTimer(node, tag, nt) {
      if (node === 1) {
        const [, attempt, key] = tag.split(":");
        charges++;
        const id = 1000 + charges;
        // The charge and the key update are one atomic step (one database transaction).
        if (key) table.set(key, { at: table.get(key)?.at ?? nt.now, result: id });
        nt.note(1, `charge #${id}`);
        nt.send(1, 0, { k: "result", chargeId: id, attempt: Number(attempt), replay: false });
      } else if (tag.startsWith("try:")) {
        const i = Number(tag.slice(4));
        if (done || i >= fates.length) return;
        sendAttempt(i, nt);
      }
    },
  });

  const key = useKey ? "key-7f3a" : null;
  function sendAttempt(i: number, nt: Net<IMsg>) {
    sent++;
    nt.send(0, 1, { k: "charge", key, attempt: i });
    if (fates[i] === "dup") nt.send(0, 1, { k: "charge", key, attempt: i });
    nt.setTimer(0, T, `try:${i + 1}`);
  }

  const actions: Action<IMsg>[] = [{ t: 0, run: (nt) => sendAttempt(0, nt) }];
  fates.forEach((f, i) => {
    const s = i * T;
    if (f === "request-lost") actions.push(...isolate<IMsg>(2, 1, s + 0.5, s + L + 0.5));
    if (f === "reply-lost") actions.push(...isolate<IMsg>(2, 1, s + L + 0.75, s + 2 * L + work + 0.5));
  });
  runScript(net, actions, fates.length * T + slowWork + 3 * L);
  return { net, charges, done, chargeId, doneAt, attemptsSent: sent, arrived, replays };
}

/** Every fate sequence of the given length, for the exhaustive check. */
export function allFates(len: number): AttemptFate[][] {
  if (len === 0) return [[]];
  return allFates(len - 1).flatMap((xs) => ATTEMPT_FATES.map((f) => [...xs, f]));
}
