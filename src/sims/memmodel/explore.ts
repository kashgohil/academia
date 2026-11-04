import type { Program } from "./ast";

export interface Outcome {
  key: string;
  regs: Record<string, number>;
  mem: Record<string, number>;
  /** Some thread was still spinning when nothing else could run. */
  hang: boolean;
  /** Reached by at least one execution containing a data race (undefined behavior in C++). */
  racy: boolean;
  /** Reached by at least one race-free execution. */
  clean: boolean;
}

export interface Result {
  outcomes: Outcome[];
  states: number;
  truncated: boolean;
}

export const MAX_STATES = 200_000;

export function outcomeKey(p: Program, regs: Record<string, number>, mem: Record<string, number>, hang: boolean) {
  const r = p.regs.map((x) => `${x}=${regs[x] ?? 0}`).join(" ");
  const m = p.locs.map((x) => `${x}=${mem[x] ?? 0}`).join(" ");
  return `${r}${r && m ? " · " : ""}${m}${hang ? " · hangs" : ""}`;
}

/**
 * Generic exhaustive search with state memoization. `successors` returns the next states;
 * an empty list means the state is terminal, and `finish` describes its outcome.
 */
export function explore<S>(
  start: S,
  keyOf: (s: S) => string,
  successors: (s: S) => S[],
  finish: (s: S) => { key: string; regs: Record<string, number>; mem: Record<string, number>; hang: boolean; race: boolean },
): Result {
  const seen = new Set<string>();
  const outcomes = new Map<string, Outcome>();
  const stack: S[] = [start];
  let truncated = false;
  while (stack.length) {
    const s = stack.pop()!;
    const k = keyOf(s);
    if (seen.has(k)) continue;
    seen.add(k);
    if (seen.size > MAX_STATES) {
      truncated = true;
      break;
    }
    const next = successors(s);
    if (next.length === 0) {
      const f = finish(s);
      const o = outcomes.get(f.key) ?? { key: f.key, regs: f.regs, mem: f.mem, hang: f.hang, racy: false, clean: false };
      if (f.race) o.racy = true;
      else o.clean = true;
      outcomes.set(f.key, o);
    } else stack.push(...next);
  }
  return { outcomes: [...outcomes.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })), states: seen.size, truncated };
}
