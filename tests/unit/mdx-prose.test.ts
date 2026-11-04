/**
 * MDX treats `{...}` in prose as a JavaScript expression. `{x, y}` in a sentence compiles, then throws
 * "x is not defined" at runtime and the whole lesson fails to render. Prose must write sets and
 * placeholders in code spans (`{x, y}`) or escape the brace (\{x\}).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compile, type CompileOptions } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { expect, test } from "vitest";

const root = new URL("../../src/content/lessons", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".mdx") ? [p] : [];
  });

type Node = { type: string; value?: string; position?: { start: { line: number } }; children?: Node[] };

/** Same parsing as vite.config.ts. Without remark-gfm, a pipe table renders as literal "| a | b |" text. */
const remarkPlugins: NonNullable<CompileOptions["remarkPlugins"]> = [remarkFrontmatter, [remarkGfm, { singleTilde: false }], remarkMath];

/** GFM splits a row at every unescaped pipe, even inside code or math. Extra cells are dropped silently. */
const cellCount = (row: string) => row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).length;

const collectTables = (n: Node, lines: string[], out: string[]) => {
  if (n.type === "paragraph") {
    const first = n.children?.[0];
    if (first?.type === "text" && first.value?.startsWith("|")) out.push(`line ${n.position?.start.line}: pipe table did not parse`);
  }
  if (n.type === "table") {
    const start = n.position!.start.line;
    const want = cellCount(lines[start - 1]!);
    n.children?.forEach((row) => {
      const line = row.position!.start.line;
      const got = cellCount(lines[line - 1]!);
      if (got !== want) out.push(`line ${line}: row has ${got} cells, header has ${want} (escape "|" as "\\|")`);
    });
  }
  n.children?.forEach((c) => collectTables(c, lines, out));
};
const collect = (n: Node, out: string[]) => {
  if (n.type === "mdxTextExpression") out.push(`line ${n.position?.start.line}: {${n.value}}`);
  n.children?.forEach((c) => collect(c, out));
};

test("no JavaScript expressions inside prose text", async () => {
  const problems: string[] = [];
  for (const f of files(root)) {
    const found: string[] = [];
    await compile(readFileSync(f, "utf8"), {
      remarkPlugins: [...remarkPlugins, () => (tree: Node) => collect(tree, found)],
    });
    for (const x of found) problems.push(`${relative(root, f)} ${x}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
}, 60_000);

test("every pipe table parses, and every row has the same cell count as its header", async () => {
  const problems: string[] = [];
  for (const f of files(root)) {
    const src = readFileSync(f, "utf8");
    const found: string[] = [];
    await compile(src, { remarkPlugins: [...remarkPlugins, () => (tree: Node) => collectTables(tree, src.split("\n"), found)] });
    for (const x of found) problems.push(`${relative(root, f)} ${x}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
}, 60_000);
