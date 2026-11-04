/** 2D loss surfaces and first-order optimizers. */
export type Vec2 = [number, number];

export interface Surface {
  id: string;
  label: string;
  f: (x: number, y: number) => number;
  grad: (x: number, y: number) => Vec2;
  domain: { x: [number, number]; y: [number, number] };
  start: Vec2;
  minima: Vec2[];
}

export const SURFACES: Surface[] = [
  {
    id: "bowl",
    label: "Ill-conditioned bowl",
    // Condition number 20: the classic zig-zag case.
    f: (x, y) => 0.5 * (x * x + 20 * y * y),
    grad: (x, y) => [x, 20 * y],
    domain: { x: [-5, 5], y: [-2.5, 2.5] },
    start: [-4.5, 2],
    minima: [[0, 0]],
  },
  {
    id: "rosenbrock",
    label: "Rosenbrock valley",
    f: (x, y) => (1 - x) ** 2 + 10 * (y - x * x) ** 2,
    grad: (x, y) => [-2 * (1 - x) - 40 * x * (y - x * x), 20 * (y - x * x)],
    domain: { x: [-2, 2], y: [-1, 3] },
    start: [-1.5, 2.5],
    minima: [[1, 1]],
  },
  {
    id: "saddle",
    label: "Saddle point",
    f: (x, y) => 0.5 * x * x - 0.5 * y * y + 0.05 * y ** 4,
    grad: (x, y) => [x, -y + 0.2 * y ** 3],
    domain: { x: [-3, 3], y: [-3.5, 3.5] },
    start: [-2.8, 0.01],
    minima: [[0, Math.sqrt(5)], [0, -Math.sqrt(5)]],
  },
  {
    id: "himmelblau",
    label: "Himmelblau (four minima)",
    f: (x, y) => (x * x + y - 11) ** 2 + (x + y * y - 7) ** 2,
    grad: (x, y) => [
      4 * x * (x * x + y - 11) + 2 * (x + y * y - 7),
      2 * (x * x + y - 11) + 4 * y * (x + y * y - 7),
    ],
    domain: { x: [-5, 5], y: [-5, 5] },
    start: [0, 0],
    minima: [[3, 2], [-2.805118, 3.131312], [-3.77931, -3.283186], [3.584428, -1.848126]],
  },
];

export function getSurface(id: string): Surface {
  return SURFACES.find((s) => s.id === id) ?? SURFACES[0]!;
}

export type OptimizerId = "sgd" | "momentum" | "adam";

export interface OptimizerState { p: Vec2; v: Vec2; m: Vec2; s: Vec2; t: number }

export interface OptimizerConfig { lr: number; beta: number; beta2?: number; eps?: number }

export function init(p: Vec2): OptimizerState {
  return { p: [...p], v: [0, 0], m: [0, 0], s: [0, 0], t: 0 };
}

export function step(id: OptimizerId, st: OptimizerState, g: Vec2, cfg: OptimizerConfig): OptimizerState {
  const { lr, beta } = cfg;
  const t = st.t + 1;
  switch (id) {
    case "sgd":
      return { ...st, t, p: [st.p[0] - lr * g[0], st.p[1] - lr * g[1]] };
    case "momentum": {
      const v: Vec2 = [beta * st.v[0] + g[0], beta * st.v[1] + g[1]];
      return { ...st, t, v, p: [st.p[0] - lr * v[0], st.p[1] - lr * v[1]] };
    }
    case "adam": {
      const b2 = cfg.beta2 ?? 0.999;
      const eps = cfg.eps ?? 1e-8;
      const m: Vec2 = [beta * st.m[0] + (1 - beta) * g[0], beta * st.m[1] + (1 - beta) * g[1]];
      const s: Vec2 = [b2 * st.s[0] + (1 - b2) * g[0] ** 2, b2 * st.s[1] + (1 - b2) * g[1] ** 2];
      const mh: Vec2 = [m[0] / (1 - beta ** t), m[1] / (1 - beta ** t)];
      const sh: Vec2 = [s[0] / (1 - b2 ** t), s[1] / (1 - b2 ** t)];
      return {
        ...st,
        t,
        m,
        s,
        p: [st.p[0] - (lr * mh[0]) / (Math.sqrt(sh[0]) + eps), st.p[1] - (lr * mh[1]) / (Math.sqrt(sh[1]) + eps)],
      };
    }
  }
}

/** Run an optimizer and return its trajectory. Stops early on divergence. */
export function run(
  surface: Surface,
  id: OptimizerId,
  cfg: OptimizerConfig,
  steps: number,
  start: Vec2 = surface.start,
): Vec2[] {
  let st = init(start);
  const path: Vec2[] = [[...st.p]];
  for (let k = 0; k < steps; k++) {
    st = step(id, st, surface.grad(st.p[0], st.p[1]), cfg);
    if (!Number.isFinite(st.p[0]) || !Number.isFinite(st.p[1]) || Math.hypot(...st.p) > 1e6) break;
    path.push([...st.p]);
  }
  return path;
}
