/** seq_cst constrains values through one total order, but it does not create happens-before by itself. */
import { expect, test } from "vitest";
import { parse, runCxx } from "@/sims/memmodel";

const racy = (src: string) => runCxx(parse(src)).outcomes.some((o) => o.racy);

test("two seq_cst loads do not synchronize: relaxed hop leaves a data race", () => {
  expect(racy(`
T0:
  data = 42
  a.store(1, release)
T1:
  a.await(1, seq_cst)
  b.store(1, relaxed)
T2:
  b.await(1, seq_cst)
  r0 = data
`)).toBe(true);
});

test("the same chain with release on the hop is race-free", () => {
  const r = runCxx(parse(`
T0:
  data = 42
  a.store(1, release)
T1:
  a.await(1, seq_cst)
  b.store(1, release)
T2:
  b.await(1, seq_cst)
  r0 = data
`));
  expect(r.outcomes.some((o) => o.racy)).toBe(false);
  expect(r.outcomes.filter((o) => !o.hang).every((o) => o.regs.r0 === 42)).toBe(true);
});

test("seq_cst still forbids the store-buffering outcome", () => {
  const r = runCxx(parse(`
T0:
  x.store(1, seq_cst)
  r0 = y.load(seq_cst)
T1:
  y.store(1, seq_cst)
  r1 = x.load(seq_cst)
`));
  expect(r.outcomes.some((o) => o.regs.r0 === 0 && o.regs.r1 === 0)).toBe(false);
});
