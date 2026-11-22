/**
 * Go's GC pacing as a calculator, and real gctrace output.
 *
 * - `heapGoal`: the heap target of the Go GC guide (go.dev/doc/gc-guide), "Target heap memory = Live heap + (Live
 *   heap + GC roots) * GOGC / 100", with the minimum total heap of 4 MiB scaled by GOGC/100 (src/runtime/mgcpacer.go
 *   in Go 1.25: `heapMinimum = defaultHeapMinimum * GOGC / 100`, `defaultHeapMinimum` = 4 MiB). With a memory
 *   limit, the goal is at most the limit minus the memory that is not heap (a SIMPLIFIED form of
 *   `memoryLimitHeapGoal`, which also counts free and unscavenged pages).
 * - `goCycle`: the GC cycles and GC CPU for a steady program: allocation rate, live heap, roots, GOGC, limit. The CPU
 *   cost of a cycle follows the guide's model, a fixed cost plus a cost per live byte; both are MODEL INPUTS. The
 *   GC CPU limiter of the memory limit (about 50% over a window, per the guide) is modeled as a cap: when the limit
 *   would need more GC CPU than that, the heap grows past the limit instead.
 * - `GCTRACE`: lines from real runs with GODEBUG=gctrace=1 (go1.25.6 darwin/arm64, Apple M4 Pro, 14 P), and
 *   `parseTrace` that splits a line into its fields as documented in src/runtime/extern.go.
 */

export const MIN_HEAP_MIB = 4;
/** Background mark workers use 25% of GOMAXPROCS (gcBackgroundUtilization in src/runtime/mgcpacer.go). */
export const BACKGROUND_UTILIZATION = 0.25;
/** The GC CPU limiter's cap, "roughly 50%" (go.dev/doc/gc-guide, Memory limit). */
export const LIMITER_CAP = 0.5;

export interface GoIn {
  /** Live heap after marking, MiB. */
  live: number;
  /** Scannable stacks and globals, MiB. */
  roots: number;
  /** GOGC; null = off. */
  gogc: number | null;
  /** GOMEMLIMIT, MiB; null = no limit (math.MaxInt64). */
  limit: number | null;
  /** Memory that is not heap (stacks, runtime metadata), MiB. Counts against the limit. A model input. */
  nonHeap: number;
}

/** The heap goal in MiB, and which rule set it. Infinity when GOGC is off and there is no limit. */
export function heapGoal(p: GoIn): { goal: number; by: "gogc" | "minimum" | "limit" | "none" } {
  let goal = Infinity, by: "gogc" | "minimum" | "limit" | "none" = "none";
  if (p.gogc !== null) {
    goal = p.live + ((p.live + p.roots) * p.gogc) / 100; by = "gogc";
    const min = (MIN_HEAP_MIB * p.gogc) / 100;
    if (goal < min) { goal = min; by = "minimum"; }
  }
  if (p.limit !== null) {
    const lim = p.limit - p.nonHeap;
    if (lim < goal) { goal = lim; by = "limit"; }
  }
  return { goal, by };
}

export interface CycleIn extends GoIn {
  /** Allocation rate, MiB per second of program time. */
  rate: number;
  /** GOMAXPROCS. */
  procs: number;
  /** MODEL INPUTS: CPU ms per cycle that does not depend on the heap, and CPU ms to mark one MiB of live heap. */
  fixedMs: number;
  markMsPerMiB: number;
}

export const CYCLE_DEFAULTS: CycleIn = { live: 100, roots: 2, gogc: 100, limit: null, nonHeap: 20, rate: 500, procs: 8, fixedMs: 0.1, markMsPerMiB: 1 };

/**
 * Steady state: each cycle the heap grows from `live` to the goal, so a cycle runs every (goal − live) / rate seconds.
 * GC CPU share = cycles per second × CPU per cycle / (procs × 1000 ms). When the share is over the limiter cap
 * because of the memory limit, the heap overshoots: the runway grows until the share is at the cap.
 */
export function goCycle(p: CycleIn) {
  const g = heapGoal(p);
  const perCycleMs = p.fixedMs + p.markMsPerMiB * (p.live + p.roots);
  const shareFor = (runway: number) => (runway > 0 ? (p.rate / runway) * perCycleMs / (p.procs * 1000) : Infinity);
  let runway = g.goal - p.live;
  let share = shareFor(runway);
  let capped = false;
  const wanted = share;
  if (g.by === "limit" && share > LIMITER_CAP) {
    capped = true;
    runway = (p.rate * perCycleMs) / (LIMITER_CAP * p.procs * 1000);
    share = LIMITER_CAP;
  }
  const peak = p.live + Math.max(0, runway);
  return {
    goal: g.goal, by: g.by, peak, runway,
    cyclesPerSec: runway > 0 && Number.isFinite(runway) ? p.rate / runway : 0,
    perCycleMs, share: Number.isFinite(runway) ? share : 0, wanted, capped,
    overLimit: p.limit !== null && peak + p.nonHeap > p.limit,
    total: peak + p.nonHeap,
  };
}

/** Points of the heap over time for a plot: a sawtooth from live to the peak. */
export function sawtooth(p: CycleIn, seconds: number): [number, number][] {
  const c = goCycle(p);
  if (!c.cyclesPerSec) return [[0, p.live], [seconds, Math.min(p.live + p.rate * seconds, 1e9)]];
  const period = 1 / c.cyclesPerSec;
  const pts: [number, number][] = [];
  const n = Math.min(400, Math.ceil(seconds / period));
  for (let i = 0; i <= n; i++) {
    const t0 = i * period;
    if (t0 > seconds) break;
    pts.push([t0, p.live], [Math.min(seconds, t0 + period), p.live + Math.min(period, seconds - t0) * p.rate]);
  }
  return pts;
}

// ---------------------------------------------------------------- gctrace

export interface TraceLine {
  n: number; at: number; pct: number;
  clock: [number, number, number];
  cpu: { stw1: number; assist: number; background: number; idle: number; stw2: number };
  heap: [number, number, number];
  goal: number; stacks: number; globals: number; procs: number; forced: boolean;
}

/** Splits one gctrace line. The format is in src/runtime/extern.go (Go 1.25); it may change between versions. */
export function parseTrace(line: string): TraceLine {
  const re = /^gc (\d+) @([\d.]+)s (\d+)%: ([\d.]+)\+([\d.]+)\+([\d.]+) ms clock, ([\d.]+)\+([\d.]+)\/([\d.]+)\/([\d.]+)\+([\d.]+) ms cpu, (\d+)->(\d+)->(\d+) MB, (\d+) MB goal, (\d+) MB stacks, (\d+) MB globals, (\d+) P( \(forced\))?$/;
  const m = re.exec(line.trim());
  if (!m) throw new Error(`not a gctrace line: ${line}`);
  const f = (i: number) => Number(m[i]);
  return {
    n: f(1), at: f(2), pct: f(3), clock: [f(4), f(5), f(6)],
    cpu: { stw1: f(7), assist: f(8), background: f(9), idle: f(10), stw2: f(11) },
    heap: [f(12), f(13), f(14)], goal: f(15), stacks: f(16), globals: f(17), procs: f(18), forced: !!m[19],
  };
}

/**
 * Real output. The program keeps 131,072 objects of 64 bytes live (8 MiB plus a 1 MiB slice), and allocates 200 MiB
 * more in 64-byte objects that die soon. Built with go1.25.6 (darwin/arm64), run on an Apple M4 Pro, GOMAXPROCS 14.
 * "MB" in gctrace is MiB: the runtime prints bytes >> 20. Lines are copied as printed; counts are of one run each.
 */
export const GCTRACE = {
  program: [
    "type node struct {",
    "    next *node",
    "    data [48]byte",
    "}",
    "",
    "var keep []*node",
    "",
    "func main() {",
    "    for i := 0; i < 8<<20/64; i++ { // about 8 MiB that stays live",
    "        keep = append(keep, &node{})",
    "    }",
    "    var sink *node",
    "    for i := 0; i < 200<<20/64; i++ { // 200 MiB of short-lived chains",
    "        sink = &node{next: sink}",
    "        if i%1000 == 0 {",
    "            sink = nil",
    "        }",
    "    }",
    "}",
  ],
  gogc100: [
    "gc 1 @0.000s 6%: 0.009+0.51+0.014 ms clock, 0.12+0.023/0.77/0.14+0.20 ms cpu, 3->4->3 MB, 4 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 2 @0.001s 8%: 0.003+1.2+0.011 ms clock, 0.054+0/1.9/1.2+0.16 ms cpu, 5->7->6 MB, 6 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 3 @0.003s 9%: 0.004+2.0+0.011 ms clock, 0.062+0/4.4/5.8+0.16 ms cpu, 11->13->11 MB, 13 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 4 @0.007s 8%: 0.005+0.71+0.013 ms clock, 0.082+0.024/2.1/3.1+0.18 ms cpu, 19->21->10 MB, 23 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 5 @0.009s 8%: 0.003+0.72+0.010 ms clock, 0.046+0.019/1.9/2.5+0.14 ms cpu, 18->20->11 MB, 21 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 6 @0.012s 8%: 0.002+0.89+0.012 ms clock, 0.033+0.010/2.7/2.8+0.17 ms cpu, 19->20->10 MB, 22 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 7 @0.014s 8%: 0.002+0.93+0.013 ms clock, 0.036+0.014/2.4/3.2+0.18 ms cpu, 18->20->11 MB, 21 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 8 @0.017s 8%: 0.016+0.81+0.012 ms clock, 0.22+0.023/2.4/4.3+0.17 ms cpu, 19->21->11 MB, 23 MB goal, 0 MB stacks, 0 MB globals, 14 P",
  ],
  /** Number of gc lines of one run with each setting (the lines above come from these same runs). */
  cycles: { gogc50: 43, gogc100: 23, gogc400: 5, offLimit40: 11 } as Record<string, number>,
  gogc400: [
    "gc 2 @0.015s 3%: 0.009+1.5+0.018 ms clock, 0.12+0.48/5.0/0.010+0.26 ms cpu, 49->51->11 MB, 51 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 3 @0.028s 2%: 0.015+1.0+0.020 ms clock, 0.21+0.064/3.0/0.012+0.29 ms cpu, 54->56->11 MB, 57 MB goal, 0 MB stacks, 0 MB globals, 14 P",
  ],
  offLimit40: [
    "gc 1 @0.006s 3%: 0.012+0.79+0.006 ms clock, 0.17+0.31/2.5/1.9+0.084 ms cpu, 31->32->9 MB, 31 MB goal, 0 MB stacks, 0 MB globals, 14 P",
    "gc 2 @0.010s 3%: 0.006+0.99+0.005 ms clock, 0.088+0.16/2.7/3.8+0.076 ms cpu, 30->31->10 MB, 30 MB goal, 0 MB stacks, 0 MB globals, 14 P",
  ],
  gogc50first: "gc 1 @0.000s 8%: 0.011+0.35+0.012 ms clock, 0.16+0.007/0.64/0.016+0.18 ms cpu, 1->2->1 MB, 2 MB goal, 0 MB stacks, 0 MB globals, 14 P",
};
