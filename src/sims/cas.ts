import { mulberry32 } from "./rng";

/**
 * N threads each perform K increments of one shared counter with a CAS loop
 * (load, then compare_exchange; retry on failure). A random scheduler picks which thread
 * takes its next step. Returns attempts per successful increment.
 */
export function simulateCas(n: number, perThread: number, backoff: boolean, seed = 1): number {
  const r = mulberry32(seed);
  let x = 0, attempts = 0, done = 0;
  const loaded = new Array<number | null>(n).fill(null);
  const left = new Array<number>(n).fill(perThread);
  const sleep = new Array<number>(n).fill(0);
  const fails = new Array<number>(n).fill(0);
  const total = n * perThread;
  while (done < total) {
    const t = Math.floor(r() * n);
    if (left[t] === 0) continue;
    if (sleep[t]! > 0) { sleep[t]!--; continue; }
    if (loaded[t] === null) { loaded[t] = x; continue; }
    attempts++;
    if (x === loaded[t]) { x++; done++; left[t]!--; fails[t] = 0; }
    else if (backoff) { fails[t]!++; sleep[t] = Math.floor(r() * 2 ** Math.min(6, fails[t]!)); }
    loaded[t] = null;
  }
  return attempts / total;
}
