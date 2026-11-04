/**
 * A bandwidth model of a NUMA machine running a memory-streaming loop.
 * Each thread wants `coreBW`; each node's memory controller supplies `memBW`; sockets are
 * fully connected and each directed link carries `linkBW`. Throughput scales down uniformly
 * until no resource is over capacity.
 */
export type Placement = "serial-first-touch" | "parallel-first-touch" | "interleave";

export interface NumaConfig { sockets: number; threads: number; placement: Placement; coreBW: number; memBW: number; linkBW: number; latLocal: number; latRemote: number }

export const NUMA_DEFAULTS = { coreBW: 10, memBW: 60, linkBW: 40, latLocal: 90, latRemote: 150 };

export interface NumaResult { gbps: number; bottleneck: string; nodeLoad: number[]; remoteFraction: number; latency: number }

/** Threads are spread round-robin across sockets (what Linux tends to do for a parallel loop). */
export const socketOf = (t: number, sockets: number) => t % sockets;

export function simulateNuma(cfg: NumaConfig): NumaResult {
  const { sockets: s, threads: n } = cfg;
  const frac = (t: number, j: number) => {
    switch (cfg.placement) {
      case "serial-first-touch": return j === 0 ? 1 : 0;
      case "parallel-first-touch": return j === socketOf(t, s) ? 1 : 0;
      case "interleave": return 1 / s;
    }
  };
  const nodeLoad = Array.from({ length: s }, (_, j) => Array.from({ length: n }, (_, t) => cfg.coreBW * frac(t, j)).reduce((a, b) => a + b, 0));
  // Sockets are fully connected: one link per ordered pair (j → i), each carrying linkBW.
  let worstLink = 0;
  for (let j = 0; j < s; j++)
    for (let i = 0; i < s; i++) {
      if (i === j) continue;
      const flow = Array.from({ length: n }, (_, t) => (socketOf(t, s) === i ? cfg.coreBW * frac(t, j) : 0)).reduce((a, b) => a + b, 0);
      worstLink = Math.max(worstLink, flow);
    }
  const limits: [number, string][] = [
    [1, "cores"],
    [cfg.memBW / Math.max(...nodeLoad, 1e-9), "memory controller"],
    [cfg.linkBW / Math.max(worstLink, 1e-9), "interconnect link"],
  ];
  const [scale, bottleneck] = limits.reduce((a, b) => (b[0] < a[0] ? b : a));
  const remote = Array.from({ length: n }, (_, t) => 1 - frac(t, socketOf(t, s))).reduce((a, b) => a + b, 0) / Math.max(1, n);
  return {
    gbps: n * cfg.coreBW * scale,
    bottleneck,
    nodeLoad: nodeLoad.map((x) => x * scale),
    remoteFraction: remote,
    latency: cfg.latLocal * (1 - remote) + cfg.latRemote * remote,
  };
}
