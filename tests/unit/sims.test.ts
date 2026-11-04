import { describe, expect, test } from "vitest";
import { charge, discharge, eulerCharge, tau } from "@/sims/rc";
import { DISTS, getDist, sampleMeans } from "@/sims/clt";
import { mean, variance, probit, histogram } from "@/sims/stats";
import { mulberry32 } from "@/sims/rng";
import { getSurface, run } from "@/sims/optim";

describe("rc", () => {
  const p = { R: 10e3, C: 100e-6, Vs: 5 };
  test("τ = RC and 63.2% after one τ", () => {
    expect(tau(p)).toBeCloseTo(1);
    expect(charge(p, 1).v / 5).toBeCloseTo(1 - Math.exp(-1), 10);
  });
  test("initial current is Vs/R, discharge mirrors charge", () => {
    expect(charge(p, 0).i).toBeCloseTo(5 / 10e3);
    expect(discharge(p, 1, 5).v).toBeCloseTo(5 - charge(p, 1).v, 10);
  });
  test("Euler converges to the analytic solution as dt → 0", () => {
    const exact = charge(p, 2).v;
    const e1 = Math.abs(eulerCharge(p, 2, 0.01) - exact);
    const e2 = Math.abs(eulerCharge(p, 2, 0.005) - exact);
    expect(e1).toBeLessThan(0.01);
    expect(e1 / e2).toBeCloseTo(2, 0); // first-order method
  });
  test("Euler is unstable for dt > 2τ", () => {
    expect(Math.abs(eulerCharge(p, 50, 2.2))).toBeGreaterThan(100);
    expect(eulerCharge(p, 300, 1.9)).toBeCloseTo(5, 3); // factor −0.9: rings but decays
  });
});

describe("clt", () => {
  test("variance of sample means ≈ σ²/n for every finite-variance population", () => {
    for (const d of DISTS.filter((d) => Number.isFinite(d.sigma2))) {
      const m = sampleMeans(d, 16, 20_000, mulberry32(3));
      expect(mean(m)).toBeCloseTo(d.mu, 1);
      expect(variance(m) / (d.sigma2 / 16)).toBeGreaterThan(0.93);
      expect(variance(m) / (d.sigma2 / 16)).toBeLessThan(1.07);
    }
  });
  test("cauchy means do not concentrate", () => {
    const d = getDist("cauchy");
    const iqr = (xs: Float64Array) => {
      const s = Float64Array.from(xs).sort();
      return s[Math.floor(0.75 * s.length)]! - s[Math.floor(0.25 * s.length)]!;
    };
    const a = iqr(sampleMeans(d, 1, 20_000, mulberry32(1)));
    const b = iqr(sampleMeans(d, 100, 20_000, mulberry32(2)));
    expect(b / a).toBeGreaterThan(0.85);
  });
  test("probit inverts the normal CDF at known points", () => {
    expect(probit(0.5)).toBeCloseTo(0, 8);
    expect(probit(0.975)).toBeCloseTo(1.959964, 5);
    expect(probit(0.01)).toBeCloseTo(-2.326348, 5);
  });
  test("histogram counts everything in range", () => {
    const h = histogram([0, 0.5, 0.99, 2], 0, 1, 4);
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(3);
  });
});

describe("optimizers", () => {
  const bowl = getSurface("bowl");
  const last = (p: [number, number][]) => p[p.length - 1]!;
  test("SGD converges below 2/λmax and diverges above", () => {
    const ok = run(bowl, "sgd", { lr: 0.095, beta: 0 }, 400);
    expect(Math.hypot(...last(ok))).toBeLessThan(1e-6);
    const bad = run(bowl, "sgd", { lr: 0.105, beta: 0 }, 400);
    expect(bad.length).toBeLessThan(401); // stopped early on divergence
  });
  test("momentum beats SGD on the ill-conditioned bowl", () => {
    const sgd = run(bowl, "sgd", { lr: 0.09, beta: 0 }, 60);
    const mom = run(bowl, "momentum", { lr: 0.09, beta: 0.6 }, 60);
    expect(bowl.f(...last(mom))).toBeLessThan(bowl.f(...last(sgd)));
  });
  test("Adam gets near the bowl minimum", () => {
    const p = run(bowl, "adam", { lr: 0.05, beta: 0.9 }, 400);
    expect(Math.hypot(...last(p))).toBeLessThan(0.1);
  });
  test("analytic gradients match finite differences", () => {
    for (const id of ["bowl", "rosenbrock", "saddle", "himmelblau"]) {
      const s = getSurface(id);
      const [x, y] = [0.37, -0.81];
      const h = 1e-6;
      const g = s.grad(x, y);
      expect(g[0]).toBeCloseTo((s.f(x + h, y) - s.f(x - h, y)) / (2 * h), 4);
      expect(g[1]).toBeCloseTo((s.f(x, y + h) - s.f(x, y - h)) / (2 * h), 4);
    }
  });
});
