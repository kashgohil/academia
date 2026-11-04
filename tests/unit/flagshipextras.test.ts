/** Pins every number quoted in the three flagship lessons (gradient descent, RC transients, CLT). */
import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import * as X from "@/sims/flagshipextras";
import { getSurface, init, run, step } from "@/sims/optim";
import { eulerCharge, energy, tau } from "@/sims/rc";
import { getDist } from "@/sims/clt";
import { mulberry32, normal } from "@/sims/rng";
import { probit } from "@/sims/stats";

describe("gradient descent lesson", () => {
  const bowl = getSurface("bowl");

  test("largest stable learning rate on the bowl is 2/20 = 0.1", () => {
    expect(X.maxStableLr(20)).toBeCloseTo(0.1, 12);
    expect(Math.abs(X.gdFactor(0.099, 20))).toBeLessThan(1);
    expect(Math.abs(X.gdFactor(0.101, 20))).toBeGreaterThan(1);
  });

  test("κ = 20: 19/21 ≈ 0.905 and 23 steps per decade; momentum 0.63 and 5 steps", () => {
    const c = X.contraction(20);
    expect(c.gd).toBeCloseTo(19 / 21, 12);
    expect(c.gd.toFixed(3)).toBe("0.905");
    expect(Math.round(X.stepsPerDecade(c.gd))).toBe(23);
    expect(c.momentum.toFixed(2)).toBe("0.63");
    expect(Math.round(X.stepsPerDecade(c.momentum))).toBe(5);
  });

  test("κ = 10⁴: about 11,500 steps against about 115 steps", () => {
    const c = X.contraction(1e4);
    expect(Math.round(X.stepsPerDecade(c.gd) / 100) * 100).toBe(11_500);
    expect(Math.round(X.stepsPerDecade(c.momentum))).toBe(115);
  });

  test("tuned momentum for the bowl: η ≈ 0.13, β ≈ 0.40, and it converges fast", () => {
    const t = X.tunedMomentum(1, 20);
    expect(t.lr.toFixed(2)).toBe("0.13");
    expect(t.beta.toFixed(2)).toBe("0.40");
    expect(Math.sqrt(t.beta)).toBeCloseTo(X.contraction(20).momentum, 12);
    expect(X.summarize(bowl, "momentum", t, 400).stepsToConverge!).toBeLessThan(40);
  });

  test("bowl at η = 0.09: SGD 86 steps, momentum β 0.5 → 27, β 0.9 → 170, β 0.99 → not in 400", () => {
    expect(X.summarize(bowl, "sgd", { lr: 0.09, beta: 0 }, 400).stepsToConverge).toBe(86);
    expect(X.summarize(bowl, "momentum", { lr: 0.09, beta: 0.5 }, 400).stepsToConverge).toBe(27);
    expect(X.summarize(bowl, "momentum", { lr: 0.09, beta: 0.9 }, 400).stepsToConverge).toBe(170);
    const r = X.summarize(bowl, "momentum", { lr: 0.09, beta: 0.99 }, 400);
    expect(r.stepsToConverge).toBeNull();
    expect(r.diverged).toBe(false);
  });

  test("SGD diverges just above 0.1", () => {
    expect(X.summarize(bowl, "sgd", { lr: 0.105, beta: 0 }, 400).diverged).toBe(true);
  });

  test("saddle at η = 0.09: SGD stays near the ridge for 55 steps", () => {
    const path = run(getSurface("saddle"), "sgd", { lr: 0.09, beta: 0 }, 400);
    expect(X.firstBeyond(path, 1, 1)).toBe(55);
    const r = X.summarize(getSurface("saddle"), "sgd", { lr: 0.09, beta: 0 }, 400);
    expect(r.nearest[1]).toBeCloseTo(Math.sqrt(5), 6);
  });

  test("Himmelblau at η = 0.01: SGD ends at (3, 2) in 32 steps, momentum (β 0.9) ends near (3.58, −1.85)", () => {
    const him = getSurface("himmelblau");
    const sgd = X.summarize(him, "sgd", { lr: 0.01, beta: 0 }, 400);
    expect(sgd.nearest).toEqual([3, 2]);
    expect(sgd.stepsToConverge).toBe(32);
    const mom = X.summarize(him, "momentum", { lr: 0.01, beta: 0.9 }, 400);
    expect(mom.nearest[0].toFixed(2)).toBe("3.58");
    expect(mom.nearest[1].toFixed(2)).toBe("-1.85");
    expect(mom.finalGap).toBeLessThan(1e-6);
  });

  test("Rosenbrock at η = 0.01: SGD loss 0.0225 after 400 steps, momentum below 1e-6 at step 163", () => {
    const ros = getSurface("rosenbrock");
    const sgd = X.summarize(ros, "sgd", { lr: 0.01, beta: 0 }, 400);
    expect(sgd.finalLoss.toPrecision(3)).toBe("0.0225");
    expect(sgd.stepsToConverge).toBeNull();
    expect(X.summarize(ros, "momentum", { lr: 0.01, beta: 0.9 }, 400).stepsToConverge).toBe(163);
  });

  test("noise floor on the bowl with σ = 1: 0.25 at η = 0.09, 0.005 at η = 0.01 (formula and simulation)", () => {
    expect(X.noiseFloor(0.09, [1, 20], 1).toFixed(2)).toBe("0.25");
    expect(X.noiseFloor(0.01, [1, 20], 1).toFixed(3)).toBe("0.005");
    for (const lr of [0.09, 0.01]) {
      const r = mulberry32(11);
      let st = init([0, 0]);
      let sum = 0, count = 0;
      for (let k = 0; k < 60_000; k++) {
        const g = bowl.grad(st.p[0], st.p[1]);
        st = step("sgd", st, [g[0] + normal(r), g[1] + normal(r)], { lr, beta: 0 });
        if (k >= 5000) { sum += bowl.f(st.p[0], st.p[1]); count++; }
      }
      expect(sum / count / X.noiseFloor(lr, [1, 20], 1)).toBeGreaterThan(0.9);
      expect(sum / count / X.noiseFloor(lr, [1, 20], 1)).toBeLessThan(1.1);
    }
  });

  test("3D height map is in [0, 1] and lowest at the minimum", () => {
    for (const id of ["bowl", "rosenbrock", "saddle", "himmelblau"]) {
      const s = getSurface(id);
      const m = X.heightMap(s, 41, 41);
      for (const h of m.h) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1 + 1e-12);
      }
      const [mx, my] = s.minima[0]!;
      expect(m.height(s.f(mx, my))).toBeLessThan(0.02);
    }
  });
});

describe("RC lesson", () => {
  test("charge table: 63.2%, 86.5%, 95.0%, 99.3%", () => {
    expect([1, 2, 3, 5].map((n) => (X.chargedAfter(n) * 100).toFixed(1))).toEqual(["63.2", "86.5", "95.0", "99.3"]);
    expect([1, 2, 3, 5].map((n) => ((1 - X.chargedAfter(n)) * 100).toFixed(1))).toEqual(["36.8", "13.5", "5.0", "0.7"]);
  });

  test("units: 10 kΩ × 100 µF = 1 s, 10 kΩ × 100 pF = 1 µs", () => {
    expect(tau({ R: 10e3, C: 100e-6, Vs: 1 })).toBeCloseTo(1, 12);
    expect(tau({ R: 10e3, C: 100e-12, Vs: 1 })).toBeCloseTo(1e-6, 15);
  });

  test("bucket rule: 0.672 after 5 steps of 0.2, 0.642 after 20 steps of 0.05, exact 0.632", () => {
    expect(X.bucketLevels(0.2, 5)[5]!.toFixed(3)).toBe("0.672");
    expect(X.bucketLevels(0.05, 20)[20]!.toFixed(3)).toBe("0.642");
    expect(X.chargedAfter(1).toFixed(3)).toBe("0.632");
  });

  test("bucket rule is explicit Euler", () => {
    const p = { R: 1, C: 1, Vs: 1 };
    for (const h of [0.05, 0.2, 0.5]) expect(X.bucketLevels(h, 10)[10]).toBeCloseTo(eulerCharge(p, 10 * h, h), 12);
  });

  test("fixed flow reaches Vs at t = τ (5 steps of 0.2), in a straight line", () => {
    const f = X.bucketLevels(0.2, 6, "fixed");
    expect(f[4]).toBeCloseTo(0.8, 12);
    expect(f[5]).toBeCloseTo(1, 12);
    expect(f[6]).toBe(1);
  });

  test("energy: source 2.5 mJ, capacitor 1.25 mJ, resistor 1.25 mJ, for any R", () => {
    for (const R of [100, 10e3, 1e6]) {
      const p = { R, C: 100e-6, Vs: 5 };
      expect(X.sourceEnergy(p)).toBeCloseTo(2.5e-3, 12);
      expect(energy(p.C, p.Vs)).toBeCloseTo(1.25e-3, 12);
      expect(X.resistorHeat(p) / 1.25e-3).toBeCloseTo(1, 4);
    }
  });

  test("square wave: swing 98.7% at τ/P = 0.1, 24.5% at 1, 2.5% at 10; average 50%; f/f_c = 6.28 at τ = P", () => {
    expect((X.squareSteady(0.1).ripple * 100).toFixed(1)).toBe("98.7");
    expect((X.squareSteady(1).ripple * 100).toFixed(1)).toBe("24.5");
    expect((X.squareSteady(10).ripple * 100).toFixed(1)).toBe("2.5");
    expect(X.squareSteady(10).ripple).toBeCloseTo(Math.tanh(1 / 40), 12);
    expect(X.squareSteady(3).average).toBe(0.5);
    expect(X.freqOverCorner(1).toFixed(2)).toBe("6.28");
    // Each half period at τ/P = 0.1 lasts 5τ.
    expect(0.5 / 0.1).toBe(5);
  });

  test("square-wave trace is periodic and its mean is Vs/2", () => {
    for (const r of [0.1, 1, 10]) {
      const pts = X.squareWave(r, 3, 400);
      const st = X.squareSteady(r);
      expect(pts[0]!.vout).toBeCloseTo(st.vLow, 10);
      const atHalf = pts.find((p) => Math.abs(p.t - 0.5) < 1e-9)!;
      expect(atHalf.vout).toBeCloseTo(st.vHigh, 10);
      expect(pts[pts.length - 1]!.vout).toBeCloseTo(st.vLow, 10);
      let area = 0;
      for (let i = 1; i < pts.length; i++) area += ((pts[i]!.vout + pts[i - 1]!.vout) / 2) * (pts[i]!.t - pts[i - 1]!.t);
      expect(area / 3).toBeCloseTo(0.5, 3);
    }
  });

  test("the log slider (0.01 to 100) lands exactly on 0.1, 1 and 10", () => {
    const at = (x: number) => Number((0.01 * Math.pow(100 / 0.01, x / 1000)).toPrecision(3));
    expect([at(250), at(500), at(750)]).toEqual([0.1, 1, 10]);
  });

  test("Euler at Δt = 2.2τ multiplies the error by −1.2", () => {
    expect(1 - 2.2).toBeCloseTo(-1.2, 12);
    expect(Math.abs(eulerCharge({ R: 1, C: 1, Vs: 1 }, 22, 2.2))).toBeGreaterThan(3);
  });
});

describe("CLT lesson", () => {
  test("exponential: γ = 2, and the mean of 30 draws has skewness ≈ 0.37", () => {
    const d = getDist("exponential");
    const r = mulberry32(9);
    const xs = Array.from({ length: 200_000 }, () => d.sample(r));
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
    const g = xs.reduce((s, x) => s + (x - m) ** 3, 0) / xs.length / v ** 1.5;
    expect(g).toBeGreaterThan(1.85);
    expect(g).toBeLessThan(2.15);
    expect(X.skewOfMean(2, 30).toFixed(2)).toBe("0.37");
  });

  test("√n law: 4× data halves the SE, 100× gives one more digit", () => {
    expect(X.seShrink(4)).toBe(0.5);
    expect(X.seShrink(100)).toBeCloseTo(0.1, 12);
  });

  test("Bernoulli(0.1): skewness 2.67, np ≥ 10 needs n = 100", () => {
    expect(X.bernoulliSkew(0.1).toFixed(2)).toBe("2.67");
    expect(X.bernoulliN(0.1)).toBe(100);
  });

  test("Pareto α = 1.5: fluctuations like n^(−1/3)", () => {
    expect(X.stableExponent(1.5)).toBeCloseTo(-1 / 3, 12);
  });

  test("correlation: n = 100, ρ = 0.1 → variance 10.9×, SE 3.3×", () => {
    expect(X.correlatedVarFactor(100, 0.1)).toBeCloseTo(10.9, 12);
    expect(Math.sqrt(X.correlatedVarFactor(100, 0.1)).toFixed(1)).toBe("3.3");
  });

  test("Berry–Esseen constant is below 0.48", () => {
    expect(X.BERRY_ESSEEN_C).toBeLessThan(0.48);
  });

  test("normal CDF matches probit", () => {
    for (const p of [0.01, 0.1, 0.5, 0.8, 0.975]) expect(X.normalCdf(probit(p))).toBeCloseTo(p, 6);
  });

  test("dice: loaded skewness 1.47 → 0.27 at n = 30; fair CDF gap 0.143 → 0.021; die B 0.072 vs die A 0.044", () => {
    const loaded = X.getDie("loaded"), fair = X.getDie("fair"), two = X.getDie("two");
    expect(loaded.probs[0]).toBe(0.6);
    const sum = (d: X.Die, n: number) => X.diceSum(d.probs, n);
    const skew = (d: X.Die, n: number) => { const s = sum(d, n); return X.pmfMoments(s.pmf, s.offset).skew; };
    const gap = (d: X.Die, n: number) => { const s = sum(d, n); return X.kolmogorovToNormal(s.pmf, s.offset); };
    expect(skew(loaded, 1).toFixed(2)).toBe("1.47");
    expect(skew(loaded, 30).toFixed(2)).toBe("0.27");
    expect(skew(loaded, 30)).toBeCloseTo(skew(loaded, 1) / Math.sqrt(30), 10);
    expect(Math.abs(skew(two, 1))).toBeLessThan(1e-12);
    expect(Math.abs(skew(two, 30))).toBeLessThan(1e-9);
    expect(gap(fair, 1).toFixed(3)).toBe("0.143");
    expect(gap(fair, 30).toFixed(3)).toBe("0.021");
    expect(gap(two, 30).toFixed(3)).toBe("0.072");
    expect(gap(loaded, 30).toFixed(3)).toBe("0.044");
  });

  test("dice: the CDF gap is always below the Berry–Esseen limit", () => {
    for (const d of X.DICE)
      for (let n = 1; n <= 30; n++) {
        const s = X.diceSum(d.probs, n);
        expect(X.kolmogorovToNormal(s.pmf, s.offset)).toBeLessThanOrEqual(X.berryEsseen(d.probs, n));
      }
  });

  test("dice sums: mean and variance add", () => {
    const s = X.diceSum(X.getDie("fair").probs, 3);
    const m = X.pmfMoments(s.pmf, s.offset);
    expect(m.mean).toBeCloseTo(10.5, 10);
    expect(m.variance).toBeCloseTo((3 * 35) / 12, 10);
    expect(s.pmf.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  test("Galton board: 10 rows, p = 0.5 → mean 5, SD 1.58; p = 0.1 → most balls in bins 0–2; 16 rows → mean 1.6, less skew", () => {
    expect(X.galtonMean(10, 0.5)).toBe(5);
    expect(X.galtonSd(10, 0.5).toFixed(2)).toBe("1.58");
    const p10 = X.galtonPmf(10, 0.1);
    expect(p10[0]! + p10[1]! + p10[2]!).toBeGreaterThan(0.9);
    expect(X.galtonMean(16, 0.1)).toBeCloseTo(1.6, 12);
    const sk = (rows: number) => X.pmfMoments(X.galtonPmf(rows, 0.1)).skew;
    expect(sk(16)).toBeLessThan(sk(10));
    expect(sk(10)).toBeGreaterThan(0.5);
  });

  test("Galton balls land with the binomial frequencies", () => {
    const r = mulberry32(5);
    const counts = new Array(11).fill(0);
    for (let i = 0; i < 20_000; i++) counts[X.galtonBall(10, 0.5, r).filter(Boolean).length]++;
    const pmf = X.galtonPmf(10, 0.5);
    for (let k = 0; k <= 10; k++) expect(Math.abs(counts[k] / 20_000 - pmf[k]!)).toBeLessThan(0.01);
  });
});

describe("flagship extra demos render", () => {
  test("2D demos render without errors", async () => {
    (globalThis as { location?: unknown }).location ??= { search: "", href: "http://localhost/" };
    const D = await import("@/demos/FlagshipExtras");
    for (const C of [D.RcBucketDemo, D.RcSquareWaveDemo, D.DiceSumDemo, D.GaltonBoardDemo]) {
      expect(renderToString(createElement(C)).length).toBeGreaterThan(100);
    }
  });
});
