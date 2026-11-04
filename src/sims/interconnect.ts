/** Interconnect topologies and coherence message scaling. */
import { runWorkload, type Access } from "./coherence";

export type Topology = "bus" | "ring" | "mesh" | "torus" | "crossbar";

/** Closest-to-square factorization r × c = n. */
function grid(n: number): [number, number] {
  let r = Math.floor(Math.sqrt(n));
  while (n % r) r--;
  return [r, n / r];
}

/** Average number of hops between two distinct nodes. */
export function avgHops(t: Topology, n: number): number {
  if (n < 2) return 0;
  if (t === "bus" || t === "crossbar") return 1;
  let sum = 0, pairs = 0;
  const [r, c] = grid(n);
  for (let a = 0; a < n; a++)
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      pairs++;
      if (t === "ring") { const d = Math.abs(a - b); sum += Math.min(d, n - d); continue; }
      const dr = Math.abs(Math.floor(a / c) - Math.floor(b / c)), dc = Math.abs((a % c) - (b % c));
      sum += t === "mesh" ? dr + dc : Math.min(dr, r - dr) + Math.min(dc, c - dc);
    }
  return sum / pairs;
}

/** Links (wires) needed: the cost side of the trade-off. */
export function links(t: Topology, n: number): number {
  const [r, c] = grid(n);
  switch (t) {
    case "bus": return 1;
    case "ring": return n;
    case "mesh": return r * (c - 1) + c * (r - 1);
    case "torus": return 2 * n;
    case "crossbar": return n * n;
  }
}

export type SharingPattern = "private" | "shared-counter" | "broadcast";

export function sharingTrace(p: SharingPattern, n: number): Access[] {
  const out: Access[] = [];
  if (p === "private") for (let j = 0; j < 4; j++) for (let k = 0; k < n; k++) out.push({ core: k, op: "R", addr: 100 + k * 4 + j }, { core: k, op: "W", addr: 100 + k * 4 + j });
  if (p === "shared-counter") for (let i = 0; i < 4 * n; i++) out.push({ core: i % n, op: "R", addr: 0 }, { core: i % n, op: "W", addr: 0 });
  if (p === "broadcast") for (let r = 0; r < 4; r++) { out.push({ core: 0, op: "W", addr: 0 }); for (let k = 1; k < n; k++) out.push({ core: k, op: "R", addr: 0 }); }
  return out;
}

/** Messages per coherence transaction: snooping broadcasts to every other cache; a directory contacts only the sharers involved. */
export function coherenceMessages(p: SharingPattern, n: number) {
  const c = runWorkload(sharingTrace(p, n), n, "MESI", 16);
  const tx = c.busTransactions || 1;
  return { snoopLookups: (n - 1), directory: c.c.dirMsgs / tx };
}
