/**
 * The two generals. General A (node 0) sends the plan to general B (node 1). Each messenger that arrives is answered
 * by a new one, up to k messengers in all: m1 goes A to B, m2 goes B to A, and so on. The adversary may capture one
 * messenger; then the chain stops there, because the next messenger is sent only when this one arrives.
 *
 * A protocol here is a pair of thresholds: A attacks if it received at least tA messengers, B if it received at
 * least tB. The rules of the problem:
 *   1. agreement: in every run, both attack or neither does;
 *   2. if every messenger arrives, both attack;
 *   3. if no messenger arrives, neither attacks (B does not even know the plan).
 * `checkProtocol` shows that no thresholds meet all three, for every k. It is the induction of the classic proof:
 * capturing messenger j instead of j + 1 changes the view of exactly one general.
 */
import { Net } from "../net";
import { isolate, runScript } from "./script";

export interface Messenger {
  i: number;
}

export const GEN_LATENCY = 10;

/** Who sends messenger i (1-based): odd ones go A to B. */
export const senderOf = (i: number) => (i % 2 === 1 ? 0 : 1);

/** Messengers received by A and by B when messengers 1..delivered arrive. */
export function received(delivered: number) {
  return { a: Math.floor(delivered / 2), b: Math.ceil(delivered / 2) };
}

/** The knowledge that messenger i gives its receiver, as text: "B knows the plan", "A knows that B knows the plan" … */
export function knowledge(i: number): string {
  if (i <= 0) return "Only A knows the plan.";
  const who = (j: number) => (senderOf(j) === 0 ? "B" : "A");
  let s = "the plan";
  for (let j = 1; j <= i; j++) s = j === 1 ? `${who(j)} knows the plan` : `${who(j)} knows that ${s}`;
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** Runs the chain on Net. `lost` is the captured messenger (1..k), or 0 for none. */
export function generalsRun(k: number, lost: number) {
  let delivered = 0;
  const net = new Net<Messenger>(2, { seed: 1, latency: { min: GEN_LATENCY, max: GEN_LATENCY } }, {
    onMessage(node, msg, nt) {
      delivered = msg.payload.i;
      if (msg.payload.i < k) nt.send(node, 1 - node, { i: msg.payload.i + 1 });
    },
  });
  const actions = [
    { t: 0, run: (nt: Net<Messenger>) => void nt.send(0, 1, { i: 1 }) },
    // Messenger j is in flight during [(j - 1) L, j L]. Cut B off from A for that window only.
    ...(lost > 0 ? isolate<Messenger>(2, 1, (lost - 1) * GEN_LATENCY + 0.5, lost * GEN_LATENCY + 0.5) : []),
  ];
  runScript(net, actions, (k + 1) * GEN_LATENCY);
  return { net, delivered, ...received(delivered) };
}

export interface Row {
  /** The captured messenger, or 0 when all arrive. */
  lost: number;
  delivered: number;
  a: number;
  b: number;
  attackA: boolean;
  attackB: boolean;
  ok: boolean;
}

/** Every run of the k-messenger protocol: one row per captured messenger, plus the run where all arrive. */
export function protocolTable(k: number, tA: number, tB: number): Row[] {
  const rows: Row[] = [];
  for (let lost = 1; lost <= k + 1; lost++) {
    const delivered = lost - 1;
    const { a, b } = received(delivered);
    const attackA = a >= tA, attackB = b >= tB;
    const last = lost === k + 1;
    const first = delivered === 0;
    const ok = attackA === attackB && (!last || attackA) && (!first || !attackA);
    rows.push({ lost: last ? 0 : lost, delivered, a, b, attackA, attackB, ok });
  }
  return rows;
}

/** The thresholds that pass every run. The result is always empty: that is the theorem, for this family. */
export function workingProtocols(k: number) {
  const ok: [number, number][] = [];
  for (let tA = 0; tA <= k + 1; tA++) for (let tB = 0; tB <= k + 1; tB++) if (protocolTable(k, tA, tB).every((r) => r.ok)) ok.push([tA, tB]);
  return ok;
}
