/**
 * Writing-style checks based on ASD-STE100 (Simplified Technical English):
 * - a descriptive sentence has at most 25 words (instructions: 20; we check 25 for all),
 * - a paragraph has at most 6 sentences,
 * - no contractions.
 * Lessons written before this standard are listed in ste-pending.json until they are rewritten.
 * STE_CHECK=a/b/c,d/e/f checks only the named lessons, even if they are pending.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import pending from "./ste-pending.json";

const root = new URL("../../src/content/lessons", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".mdx") ? [relative(root, p).replace(/\.mdx$/, "")] : [];
  });

const MAX_WORDS = 25;
const MAX_SENTENCES = 6;
const CONTRACTION = /\b\w+n't\b|\b\w+'(re|ve|ll|d)\b|\b(it|that|there|what|who|here|let)'s\b/i;

/** Extracts checkable prose: paragraphs and list items, plus question/explain/q/a strings in JSX. */
export function prose(src: string): string[] {
  const strings = [...src.matchAll(/\b(question|explain|q|a)[=:]\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[2]!.replace(/(?<!\\)\$[^$]+?(?<!\\)\$/g, "X")); // math is one word, as in prose
  let s = src
    .replace(/^---[\s\S]*?---/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "X")
    .replace(/\$[^$\n]+\$/g, "X")
    .replace(/`[^`\n]+`/g, "X")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[A-Z][\s\S]*?\/>/g, "") // self-closing components (props checked above)
    .replace(/<\/?[A-Za-z][^>]*>/g, "\n"); // other tags: keep their text content
  const paras = s
    .split(/\n\s*\n/)
    .flatMap((p) => p.split(/\n(?=\s*(?:[-*]|\d+\.)\s)/)) // each list item is its own paragraph
    .map((p) => p.replace(/\n/g, " ").replace(/\*\*/g, "").replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .filter((p) => p && !p.startsWith("import ") && !p.startsWith("#") && !p.startsWith("|") && !/^[{}()[\],;]*$/.test(p));
  return [...paras, ...strings];
}

export const sentences = (p: string) => p.split(/(?<=[.!?])\s+(?=[A-Z0-9"(“])/).filter((x) => /[A-Za-z]/.test(x));
export const words = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

describe("ASD-STE100 style", () => {
  const only = process.env.STE_CHECK?.split(",").map((x) => x.trim()).filter(Boolean);
  const done = only ?? files(root).filter((f) => !(pending as string[]).includes(f));
  test("pending list only names real lessons", () => {
    for (const f of pending as string[]) expect(files(root), f).toContain(f);
  });
  for (const f of done) {
    test(f, () => {
      const problems: string[] = [];
      for (const p of prose(readFileSync(join(root, `${f}.mdx`), "utf8"))) {
        const ss = sentences(p);
        if (ss.length > MAX_SENTENCES) problems.push(`paragraph has ${ss.length} sentences: "${p.slice(0, 60)}…"`);
        for (const x of ss) {
          if (words(x) > MAX_WORDS) problems.push(`${words(x)} words: "${x}"`);
          if (CONTRACTION.test(x)) problems.push(`contraction: "${x.match(CONTRACTION)![0]}" in "${x.slice(0, 60)}…"`);
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});
