/**
 * SM-2 spaced repetition (SuperMemo 2).
 * grade: 0–5. < 3 means "forgot" → relearn from interval 1 day.
 */
export interface Sched { ef: number; interval: number; reps: number; due: number }

export const DAY = 86_400_000;

export const fresh = (now: number): Sched => ({ ef: 2.5, interval: 0, reps: 0, due: now });

export function grade(s: Sched, q: number, now: number): Sched {
  const ef = Math.max(1.3, s.ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  if (q < 3) return { ef, interval: 1, reps: 0, due: now + DAY };
  const reps = s.reps + 1;
  const interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(s.interval * ef);
  return { ef, interval, reps, due: now + interval * DAY };
}
