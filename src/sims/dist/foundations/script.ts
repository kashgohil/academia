/**
 * Scripted runs on Net: the demos play the adversary. A script is a list of actions at given times (send, partition,
 * heal, crash, recover). With a fixed latency, every delivery time is known, so a short partition window can lose
 * exactly one chosen message. Net then records it as a message lost at a cut-off node.
 */
import type { Net, NodeId } from "../net";

export interface Action<P> {
  t: number;
  run: (net: Net<P>) => void;
}

/** Runs the actions in time order, letting the network deliver everything due in between, then runs to `until`. */
export function runScript<P>(net: Net<P>, actions: Action<P>[], until: number) {
  const sorted = [...actions].sort((a, b) => a.t - b.t);
  for (const a of sorted) {
    net.runUntil(a.t);
    a.run(net);
  }
  net.runUntil(until);
}

/** Actions that cut `node` off from everyone in [from, to). Use half-ms bounds so that no delivery ties with them. */
export function isolate<P>(n: number, node: NodeId, from: number, to: number): Action<P>[] {
  const others = Array.from({ length: n }, (_, i) => i).filter((i) => i !== node);
  return [
    { t: from, run: (net) => net.partition([others, [node]]) },
    { t: to, run: (net) => net.heal() },
  ];
}

/** Actions that cut a set of nodes off (each one alone) in [from, to). */
export function isolateAll<P>(n: number, nodes: NodeId[], from: number, to: number): Action<P>[] {
  if (!nodes.length) return [];
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !nodes.includes(i));
  return [
    { t: from, run: (net) => net.partition([rest, ...nodes.map((x) => [x])]) },
    { t: to, run: (net) => net.heal() },
  ];
}
