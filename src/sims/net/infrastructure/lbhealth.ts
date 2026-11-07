/**
 * A backend fails behind a balancer: how many requests fail before the balancer stops using it, with active health
 * checks, passive outlier detection and retries. Also the arithmetic of retry storms across layers.
 *
 * Model (no links or queues, so no PacketNet): requests arrive as a Poisson stream and the balancer sends them round
 * robin over the backends that it considers healthy. At `failAt` one backend fails in one of two ways:
 * - "refuse": it answers at once with an error (a 503, or RST from a crashed process); the balancer learns of the
 *   failure after `errorMs`.
 * - "hang": it accepts the request and never answers (a stuck process, a black hole); the balancer learns of the
 *   failure only when its request timeout `timeoutMs` expires.
 * Active checks run every `interval` and remove the backend after `unhealthy` failed checks in a row (a hung
 * backend fails a check after `checkTimeoutMs`). Outlier detection ejects it after `consecutive` failed requests
 * in a row, for `ejectMs`. A failed request is retried up to `retries` times on the next backend.
 * Model inputs: the rate, the delays, and the detection settings (defaults below are those of real products, as the
 * lesson cites).
 */
import { mulberry32 } from "../../rng";

export interface HealthOpts {
  /** Requests per second at the balancer. */
  rate?: number;
  backends?: number;
  /** When the backend fails, in s. */
  failAt?: number;
  /** Length of the run, in s. */
  duration?: number;
  failure?: "refuse" | "hang";
  /** Active health checks; null: none. */
  check?: { intervalS: number; unhealthy: number } | null;
  /** Passive outlier detection; null: none. */
  outlier?: { consecutive: number; ejectS: number } | null;
  retries?: number;
  /** Time to learn of an error answer, ms. */
  errorMs?: number;
  /** Request timeout, ms. */
  timeoutMs?: number;
  /** Health check timeout, ms. */
  checkTimeoutMs?: number;
  seed?: number;
}

export interface HealthResult {
  /** When the balancer stopped sending to the failed backend (s), or NaN. */
  removedAt: number;
  /** What removed it. */
  removedBy: "check" | "outlier" | null;
  /** Requests sent to the failed backend (first tries and retries). */
  sentToDead: number;
  /** Requests the client saw fail. */
  clientErrors: number;
  retriesSent: number;
  /** Requests that succeeded only after a retry, and their extra latency in total (ms). */
  rescued: number;
  extraMs: number;
  total: number;
  /** Per 0.5 s bucket: [time s, client errors, requests sent to the dead backend]. */
  series: [number, number, number][];
}

export const BUCKET_S = 0.5;

export function healthRun(o: HealthOpts = {}): HealthResult {
  const rate = o.rate ?? 1000, N = o.backends ?? 10, failAt = (o.failAt ?? 5) * 1000, dur = (o.duration ?? 60) * 1000;
  const failure = o.failure ?? "refuse";
  const check = o.check === undefined ? { intervalS: 5, unhealthy: 3 } : o.check;
  const outlier = o.outlier === undefined ? null : o.outlier;
  const retries = o.retries ?? 0;
  const errorMs = o.errorMs ?? 1, timeoutMs = o.timeoutMs ?? 1000, checkTimeoutMs = o.checkTimeoutMs ?? 2000;
  const rng = mulberry32(o.seed ?? 11);
  const DEAD = 3;
  const failDelay = failure === "refuse" ? errorMs : timeoutMs;

  // Active checks: the k-th check starts at phase + k·interval; a failed check is known after its timeout.
  let removedAt = Infinity, removedBy: HealthResult["removedBy"] = null;
  if (check) {
    const iv = check.intervalS * 1000, phase = iv * 0.37; // a fixed phase, so that runs repeat
    const first = Math.ceil((failAt - phase) / iv);
    const t = phase + (first + check.unhealthy - 1) * iv + (failure === "refuse" ? errorMs : checkTimeoutMs);
    removedAt = t;
    removedBy = "check";
  }
  // Outlier detection: failures become known in order, `failDelay` after each send.
  const known: number[] = [];
  let ejectedUntil = -Infinity, ejectedAt = Infinity, streak = 0;
  const applyKnown = (now: number) => {
    while (known.length && known[0]! <= now) {
      const t = known.shift()!;
      if (!outlier || t >= removedAt || t < ejectedUntil) continue;
      if (++streak >= outlier.consecutive) {
        ejectedUntil = t + outlier.ejectS * 1000;
        ejectedAt = Math.min(ejectedAt, t);
        streak = 0;
      }
    }
  };
  const healthy = (b: number, now: number) => b !== DEAD || (now < removedAt && !(now >= ejectedAt && now < ejectedUntil));

  const nb = Math.ceil(dur / (BUCKET_S * 1000));
  const series: [number, number, number][] = Array.from({ length: nb }, (_, i) => [i * BUCKET_S, 0, 0]);
  let rr = 0, t = 0, total = 0, sentToDead = 0, clientErrors = 0, retriesSent = 0, rescued = 0, extraMs = 0;
  const next = (now: number, avoid: number) => {
    for (let k = 0; k < N; k++) {
      const b = rr;
      rr = (rr + 1) % N;
      if (b !== avoid && healthy(b, now)) return b;
    }
    return (avoid + 1) % N;
  };
  for (;;) {
    t += (-Math.log(1 - rng()) / rate) * 1000;
    if (t >= dur) break;
    applyKnown(t);
    total++;
    let now = t, avoid = -1, ok = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const b = next(now, avoid);
      const dead = b === DEAD && now >= failAt;
      if (attempt > 0) retriesSent++;
      if (!dead) { ok = true; if (attempt > 0) { rescued++; extraMs += now - t; } break; }
      sentToDead++;
      series[Math.floor(now / (BUCKET_S * 1000))]![2]++;
      known.push(now + failDelay);
      now += failDelay;
      avoid = b;
    }
    if (!ok) {
      clientErrors++;
      series[Math.floor(t / (BUCKET_S * 1000))]![1]++;
    }
  }
  applyKnown(Infinity);
  const out = Math.min(removedAt, ejectedAt);
  return {
    removedAt: Number.isFinite(out) ? out / 1000 : NaN,
    removedBy: !Number.isFinite(out) ? null : ejectedAt < removedAt ? "outlier" : removedBy,
    sentToDead, clientErrors, retriesSent, rescued, extraMs, total, series,
  };
}

/** The worst-case time from failure to removal with active checks: unhealthy × interval (+ one check timeout). */
export const checkDetectWorstS = (intervalS: number, unhealthy: number, timeoutS = 0) => unhealthy * intervalS + timeoutS;

/** Attempts that reach the bottom layer per user request when every one of `layers` retries `retries` times. */
export const retryAmplification = (layers: number, retries: number) => Math.pow(retries + 1, layers);

/** The same with a retry budget: each layer adds at most a fraction `budget` of extra attempts. */
export const budgetAmplification = (layers: number, budget: number) => Math.pow(1 + budget, layers);
