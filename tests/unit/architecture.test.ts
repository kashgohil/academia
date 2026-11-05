/** Rules that keep the code base from growing near-duplicates. Each one has already gone wrong once. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const src = new URL("../../src", import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });

describe("architecture", () => {
  test("sims are pure: they import neither React nor demos", () => {
    const bad = walk(join(src, "sims")).flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/^(?:import|export) .*from "([^"]+)"/gm)]
        .filter((m) => /(^|\/)demos\/|^react($|-|\/)|\/kit($|\/)/.test(m[1]!))
        .map((m) => `${relative(src, f)} imports ${m[1]}`),
    );
    expect(bad, bad.join("\n")).toEqual([]);
  });

  test("demos use the kit's shared helpers and do not define their own", () => {
    const shared = ["seg", "mono", "MONO", "tint", "Note", "SmallLabel", "SectionLabel", "Banner", "StepCaption", "Btn", "ButtonRow", "Panel", "Meter", "StackBar", "MiniTable", "Arrow", "useChunked", "useStepper", "StepButtons", "StepSlider", "IndexButtons", "IndexSlider", "int", "fixed", "sig"];
    const def = new RegExp(`^(?:export )?(?:const|function) (${shared.join("|")})\\b`, "gm");
    const bad = walk(join(src, "demos")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(def)].map((m) => `${relative(src, f)} defines ${m[1]}`));
    // CacheExtrasDemos has a private stepper built on useSim, with a different shape.
    const allowed = new Set(["demos/CacheExtrasDemos.tsx defines useStepper"]);
    const real = bad.filter((b) => !allowed.has(b));
    expect(real, `Use the version in src/kit/ui.tsx:\n${real.join("\n")}`).toEqual([]);
  });
});
