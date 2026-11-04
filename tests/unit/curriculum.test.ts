import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { TRACKS, LIVE, allLessons } from "@/content/curriculum";

const root = new URL("../../src/content/lessons", import.meta.url).pathname;
function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? mdxFiles(p) : p.endsWith(".mdx") ? [relative(root, p).replace(/\.mdx$/, "")] : [];
  });
}

describe("curriculum", () => {
  const lessons = allLessons();

  test("slugs are unique at every level", () => {
    expect(new Set(TRACKS.map((t) => t.slug)).size).toBe(TRACKS.length);
    for (const t of TRACKS) {
      expect(new Set(t.modules.map((m) => m.slug)).size, t.slug).toBe(t.modules.length);
      for (const m of t.modules) expect(new Set(m.lessons.map((l) => l.slug)).size, `${t.slug}/${m.slug}`).toBe(m.lessons.length);
    }
  });

  test("every LIVE path exists in the curriculum", () => {
    const paths = new Set(lessons.map((l) => l.path));
    for (const p of LIVE) expect(paths.has(p), p).toBe(true);
  });

  test("LIVE matches exactly the MDX files on disk", () => {
    expect(new Set(mdxFiles(root))).toEqual(LIVE);
  });

  test("breadth and depth: every track spans ≥ 3 levels and every module has ≥ 3 lessons", () => {
    for (const t of TRACKS) {
      expect(new Set(t.modules.map((m) => m.level)).size, t.slug).toBeGreaterThanOrEqual(3);
      for (const m of t.modules) expect(m.lessons.length, `${t.slug}/${m.slug}`).toBeGreaterThanOrEqual(3);
    }
  });

  test("front matter summaries are valid YAML scalars", () => {
    for (const path of mdxFiles(root)) {
      const src = readFileSync(join(root, `${path}.mdx`), "utf8");
      const m = src.match(/^---\nsummary: (.*)\n---/);
      expect(m, `${path}: missing summary`).not.toBeNull();
      const v = m![1]!;
      if (!v.startsWith('"')) expect(v.includes(": "), `${path}: quote the summary, it contains ": "`).toBe(false);
    }
  });
});
