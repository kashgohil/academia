/**
 * The cgroup v2 CPU controller math: cpu.weight shares at each level, and the cpu.max format.
 * A weight only matters between siblings that want CPU, so an idle group gives its share to its siblings.
 */
export const CPU_WEIGHT = { min: 1, def: 100, max: 10000 } as const;
/** cpu.max limits, in microseconds (min_cfs_quota_period, max_cfs_quota_period, min_cfs_rq_runtime). */
export const CPU_MAX_LIMITS = { minPeriodUs: 1000, maxPeriodUs: 1_000_000, minQuotaUs: 1000, defaultPeriodUs: 100_000 } as const;
/** kernel.sched_cfs_bandwidth_slice_us: the time a CPU takes from the group's pool at one go. */
export const DEFAULT_SLICE_MS = 5;

export interface CgNode { name: string; weight: number; /** A group with no runnable tasks. Only leaves set this. */ idle?: boolean; children?: CgNode[] }

export interface ShareRow {
  path: string;
  name: string;
  depth: number;
  weight: number;
  /** Fraction of the parent's CPU when all siblings that want CPU compete. 0 for an idle group. */
  local: number;
  /** Fraction of the whole machine. */
  global: number;
  idle: boolean;
}

/** A group wants CPU if it is a non-idle leaf, or if a descendant wants CPU. */
export const wantsCpu = (n: CgNode): boolean => (n.children?.length ? n.children.some(wantsCpu) : !n.idle);

/** Rows in tree order. The local shares of the siblings that want CPU sum to 1 at each level. */
export function weightShares(root: CgNode): ShareRow[] {
  const out: ShareRow[] = [];
  const walk = (n: CgNode, path: string, depth: number, local: number, global: number) => {
    out.push({ path, name: n.name, depth, weight: n.weight, local, global, idle: !wantsCpu(n) });
    const kids = n.children ?? [];
    const total = kids.filter(wantsCpu).reduce((a, c) => a + c.weight, 0);
    for (const c of kids) {
      const l = wantsCpu(c) ? c.weight / total : 0;
      walk(c, `${path === "/" ? "" : path}/${c.name}`, depth + 1, l, global * l);
    }
  };
  walk(root, "/", 0, 1, 1);
  return out;
}

/** The sums that must be 1: one for each parent with a child that wants CPU. */
export function levelSums(root: CgNode): number[] {
  const out: number[] = [];
  const rows = weightShares(root);
  const walk = (n: CgNode, path: string) => {
    const kids = n.children ?? [];
    const childPaths = kids.map((c) => `${path === "/" ? "" : path}/${c.name}`);
    if (kids.some(wantsCpu)) out.push(childPaths.reduce((a, p) => a + rows.find((r) => r.path === p)!.local, 0));
    kids.forEach((c, i) => walk(c, childPaths[i]!));
  };
  walk(root, "/");
  return out;
}

export const EXAMPLE_TREE: CgNode = {
  name: "/", weight: 100, children: [
    { name: "system.slice", weight: 100, children: [{ name: "sshd", weight: 100 }, { name: "journald", weight: 100 }] },
    { name: "user.slice", weight: 100 },
    { name: "kubepods", weight: 800, children: [{ name: "api", weight: 300 }, { name: "batch", weight: 100 }] },
  ],
};

/** The kernel keeps a weight scaled to 1024: cpu.weight 100 is the same as nice 0 (sched_weight_from_cgroup). */
export const weightToKernel = (w: number) => Math.round((w * 1024) / 100);

export interface CpuMax { quotaUs: number | null; periodUs: number }

/** Parses the text of cpu.max: "max 100000" or "50000 100000". */
export function parseCpuMax(text: string): CpuMax {
  const [q, p] = text.trim().split(/\s+/);
  const periodUs = p === undefined ? CPU_MAX_LIMITS.defaultPeriodUs : Number(p);
  if (!Number.isInteger(periodUs) || periodUs < CPU_MAX_LIMITS.minPeriodUs || periodUs > CPU_MAX_LIMITS.maxPeriodUs) throw new Error("EINVAL: period");
  if (q === "max") return { quotaUs: null, periodUs };
  const quotaUs = Number(q);
  if (!Number.isInteger(quotaUs) || quotaUs < CPU_MAX_LIMITS.minQuotaUs) throw new Error("EINVAL: quota");
  return { quotaUs, periodUs };
}

/** How many CPUs a cpu.max value allows on average. */
export const cpusAllowed = (m: CpuMax) => (m.quotaUs === null ? Infinity : m.quotaUs / m.periodUs);

/** Closed form for N busy threads, one on each CPU: they burn the quota in quota/N, then wait for the next period. */
export function throttleStall(quotaMs: number, periodMs: number, threads: number) {
  const burnMs = Math.min(periodMs, quotaMs / threads);
  const stallMs = periodMs - burnMs;
  return { burnMs, stallMs, stallFraction: stallMs / periodMs };
}
