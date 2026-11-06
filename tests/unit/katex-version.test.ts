/**
 * Lesson math is rendered at build time by rehype-katex, and styled by the KaTeX CSS that src/styles.css imports.
 * Both must come from one KaTeX version. With 0.16 HTML and 0.19 CSS, every sub- and superscript lost its size.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const repo = new URL("../..", import.meta.url).pathname;
const version = (pkgJson: string) => (JSON.parse(readFileSync(pkgJson, "utf8")) as { version: string }).version;

test("rehype-katex renders with the same KaTeX version as the CSS", () => {
  const app = version(join(repo, "node_modules/katex/package.json"));
  const rehype = version(join(realpathSync(join(repo, "node_modules/rehype-katex")), "../katex/package.json"));
  expect(rehype, "pin katex in pnpm-workspace.yaml overrides").toBe(app);
});
