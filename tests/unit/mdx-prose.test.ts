/**
 * MDX treats `{...}` in prose as a JavaScript expression. `{x, y}` in a sentence compiles, then throws
 * "x is not defined" at runtime and the whole lesson fails to render. Prose must write sets and
 * placeholders in code spans (`{x, y}`) or escape the brace (\{x\}).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import { expect, test } from "vitest";

const root = new URL("../../src/content/lessons", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".mdx") ? [p] : [];
  });

type Node = { type: string; value?: string; position?: { start: { line: number } }; children?: Node[] };
const collect = (n: Node, out: string[]) => {
  if (n.type === "mdxTextExpression") out.push(`line ${n.position?.start.line}: {${n.value}}`);
  n.children?.forEach((c) => collect(c, out));
};

test("no JavaScript expressions inside prose text", async () => {
  const problems: string[] = [];
  for (const f of files(root)) {
    const found: string[] = [];
    await compile(readFileSync(f, "utf8"), {
      remarkPlugins: [remarkFrontmatter, remarkMath, () => (tree: Node) => collect(tree, found)],
    });
    for (const x of found) problems.push(`${relative(root, f)} ${x}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
}, 60_000);
