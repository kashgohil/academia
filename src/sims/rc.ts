/**
 * Series RC circuit driven by a step source.
 * Charging:    v(t) = Vs (1 - e^{-t/τ}),  i(t) = (Vs/R) e^{-t/τ}
 * Discharging: v(t) = V0 e^{-t/τ},       i(t) = -(V0/R) e^{-t/τ}
 */
export interface RcParams { R: number; C: number; Vs: number }

export const tau = ({ R, C }: RcParams) => R * C;

export function charge(p: RcParams, t: number, v0 = 0) {
  const k = Math.exp(-t / tau(p));
  const v = p.Vs + (v0 - p.Vs) * k;
  return { v, i: (p.Vs - v) / p.R };
}

export function discharge(p: RcParams, t: number, v0: number) {
  const k = Math.exp(-t / tau(p));
  return { v: v0 * k, i: -(v0 * k) / p.R };
}

/** Explicit Euler on dv/dt = (Vs - v)/(RC). Used to show integrator error vs the analytic solution. */
export function eulerCharge(p: RcParams, tEnd: number, dt: number, v0 = 0): number {
  let v = v0;
  const steps = Math.round(tEnd / dt);
  for (let s = 0; s < steps; s++) v += (dt * (p.Vs - v)) / tau(p);
  return v;
}

/** Energy stored in the capacitor. */
export const energy = (C: number, v: number) => 0.5 * C * v * v;
