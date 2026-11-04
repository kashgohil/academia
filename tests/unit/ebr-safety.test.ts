/** Regression: epoch-based reclamation must never free a node that a pinned reader can still hold. */
import { expect, test } from "vitest";
import { stress, type Scenario } from "@/sims/lockfree/scenario";

const popOnly: Scenario = { kind: "stack", initial: [1, 2, 3, 4, 5, 6, 7, 8, 9], threads: [0, 1, 2].map(() => [{ kind: "pop" }, { kind: "pop" }, { kind: "pop" }]) };

test("EBR with threshold 1: no use-after-free over 20,000 random schedules", () => {
  const r = stress(popOnly, { tags: true, scheme: "epoch", threshold: 1, pool: 32 }, 20_000, 7);
  expect(r.byKind["use-after-free"] ?? 0).toBe(0);
  expect(r.anyViolation).toBe(0);
});
