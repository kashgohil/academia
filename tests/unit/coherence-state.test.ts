import { expect, test } from "vitest";
import { Coherence } from "@/sims/coherence";

test("state() reports the valid copy after invalidate and refetch", () => {
  const c = new Coherence(2, 8, "MESI");
  c.write(0, 0, 1);
  c.write(1, 0, 2);
  c.write(0, 0, 3);
  expect(c.state(0, 0)).toBe("M");
  expect(c.value(0, 0)).toBe(3);
  expect(c.state(1, 0)).toBe("I");
});
