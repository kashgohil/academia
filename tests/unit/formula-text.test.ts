/**
 * Formulas must be math, not typed text. "2^20", "t_mem", "log_T(D/W)", "O(log N)" or "2ⁿ⁺¹" in a lesson
 * render as raw characters, with no real superscript or subscript. Write them as $2^{20}$, $t_{\text{mem}}$,
 * $\log_T(D/W)$, $O(\log N)$. In JS strings (Recall cards, Predict options) double the backslash.
 *
 * Checked: lesson prose, the question/explain attributes and options of Predict, the q/a of Recall cards,
 * and the label strings in demos. Math, code spans and fenced code are not checked. Real identifiers
 * (O_DIRECT, p_offset, n_distinct) are allowed; in prose, write them as code spans.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { compile } from "@mdx-js/mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, test } from "vitest";

const lessons = new URL("../../src/content/lessons", import.meta.url).pathname;
const demos = new URL("../../src/demos", import.meta.url).pathname;
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(p) ? [p] : [];
  });

/** Identifiers with a one-letter prefix that are real names, not a variable with an index. */
const IDENTIFIERS = new Set([
  "n_distinct", "t_ctid", "t_hoff", "i_blocks", "f_count",
  "p_offset", "p_vaddr", "p_paddr", "p_filesz", "p_memsz", "p_align", "p_type", "p_flags",
  "e_ident", "e_entry", "e_phoff", "e_phnum", "e_type", "d_tag", "d_val", "r_info", "r_offset",
]);
/** Units with a superscript are plain text: km², m², s². */
const UNIT_POWER = /(?<![\p{L}\p{N}])(?:[kcmµn]?m|s)[²³](?![\p{L}\p{N}])/gu;

/** [pattern, message, is a Unicode script check]. */
const CHECKS: [RegExp, string, boolean][] = [
  [/\^/, "caret power: write $x^{n}$", false],
  [/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼ]/u, "Unicode superscript or subscript: write $x^{n}$ or $x_{i}$", true],
  [/(?<![\p{L}\p{N}_])[OΘΩ]\((?:1|log|n|N|m|M|k)\b/u, "Big-O as text: write $O(\\log N)$", false],
  [/\blog_|\blog\d/u, "logarithm base as text: write $\\log_2 n$", false],
];

/**
 * Problems in one piece of user-visible text. Math between $…$ and code between backticks are skipped.
 * unicode: false allows Unicode scripts (log₂, 2³²), for text that cannot render math: SVG, titles, legends.
 */
export function formulaProblems(text: string, { unicode = true } = {}): string[] {
  const t = text
    .replace(/(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g, " ")
    .replace(/(?<!\\)\$[^$]+?(?<!\\)\$/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(UNIT_POWER, " ");
  const out: string[] = [];
  for (const [re, why, isUnicode] of CHECKS) {
    if (isUnicode && !unicode) continue;
    const m = t.match(re);
    if (m) out.push(`${why}: "…${t.slice(Math.max(0, m.index! - 20), m.index! + 20).trim()}…"`);
  }
  // An index: one letter (and an optional digit) before "_", as in t_mem, C_out, λ_max. Not O_DIRECT.
  for (const m of t.matchAll(/(?<![\p{L}\p{N}_])[\p{L}]\p{N}?_[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*/gu)) {
    const id = m[0];
    if (IDENTIFIERS.has(id) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(id)) continue;
    out.push(`underscore index: write $x_{\\text{name}}$, or a code span for an identifier: "${id}"`);
  }
  return out;
}

type Estree = { type: string; [k: string]: unknown };
type Node = {
  type: string; value?: string | { data?: { estree?: Estree } } | null; name?: string | null;
  attributes?: Node[]; children?: Node[]; position?: { start: { line: number } };
};

/** String literals of a JS expression: every string in options={[…]}, and the q/a values in cards={[…]}. */
function literals(n: unknown, key: string | null, want: (key: string | null) => boolean, out: string[]) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) return n.forEach((x) => literals(x, key, want, out));
  const e = n as Estree;
  // <Tex>{"…"}</Tex> inside a JSX prop is math.
  if (e.type === "JSXElement" && ((e.openingElement as Estree).name as Estree).name === "Tex") return;
  if ((e.type === "Literal" || e.type === "JSXText") && typeof e.value === "string" && want(key)) out.push(e.value);
  if (e.type === "TemplateLiteral") for (const q of e.quasis as { value: { cooked: string } }[]) if (want(key)) out.push(q.value.cooked);
  if (e.type === "Property") {
    const k = e.key as Estree;
    const name = k.type === "Identifier" ? (k.name as string) : String(k.value);
    return literals(e.value, name, want, out);
  }
  for (const [k, v] of Object.entries(e)) if (k !== "loc" && k !== "range" && k !== "position") literals(v, key, want, out);
}

const STRING_ATTRS = new Set(["question", "explain"]);

/** Collects [line, text] for each piece of user-visible text in a lesson. */
function collect(n: Node, out: [number, string][]) {
  const line = n.position?.start.line ?? 0;
  if (n.type === "text" && typeof n.value === "string") out.push([line, n.value]);
  if (n.type === "mdxJsxFlowElement" || n.type === "mdxJsxTextElement") {
    for (const a of n.attributes ?? []) {
      if (a.type !== "mdxJsxAttribute" || !a.name) continue;
      if (typeof a.value === "string") {
        if (STRING_ATTRS.has(a.name)) out.push([line, a.value]);
      } else if (a.value?.data?.estree) {
        const found: string[] = [];
        const est = a.value.data.estree;
        if (a.name === "options" || STRING_ATTRS.has(a.name)) literals(est, null, () => true, found);
        if (a.name === "cards") literals(est, null, (k) => k === "q" || k === "a", found);
        for (const s of found) out.push([line, s]);
      }
    }
  }
  // Text inside <Tex>, <code> and <pre> is math or code.
  if ((n.type === "mdxJsxFlowElement" || n.type === "mdxJsxTextElement") && (n.name === "Tex" || n.name === "code" || n.name === "pre")) return;
  n.children?.forEach((c) => collect(c, out));
}

describe("formulas are math, not typed text", () => {
  test("the check finds typed formulas and accepts math, code and identifiers", () => {
    for (const bad of ["about 2^20 bytes", "a cost of t_mem", "about log_T(D/W) writes", "it is O(log N)", "(3ⁿ − 2ⁿ⁺¹ + 1)/2", "η < 2/λ_max", "C_out of a plan", "log₂(lanes) steps", "log2(B) bits"])
      expect(formulaProblems(bad), bad).not.toEqual([]);
    for (const good of ["about $2^{20}$ bytes", "a cost of $t_{\\text{mem}}$", "it is $O(\\log N)$", "the `next ^ key` mask", "open with O_DIRECT", "seq_cst and fetch_add", "n_distinct is -1", "an area of 3 km²", "costs \\$5 and $x^2$"])
      expect(formulaProblems(good), good).toEqual([]);
  });

  test("lesson prose, Predict and Recall text", async () => {
    const problems: string[] = [];
    for (const f of files(lessons, /\.mdx$/)) {
      const found: [number, string][] = [];
      await compile(readFileSync(f, "utf8"), {
        remarkPlugins: [remarkFrontmatter, [remarkGfm, { singleTilde: false }], remarkMath, () => (tree: Node) => collect(tree, found)],
      });
      for (const [line, text] of found) for (const p of formulaProblems(text)) problems.push(`${relative(lessons, f)}:${line} ${p}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  }, 60_000);

  test("demo labels", () => {
    const problems: string[] = [];
    for (const f of files(demos, /\.tsx?$/)) {
      readFileSync(f, "utf8").split("\n").forEach((l, i) => {
        for (const m of l.matchAll(/\b(?:label|title|xLabel|yLabel)[:=]\s*\{?\s*(?:"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g)) {
          const text = (m[1] ?? m[2]!).replace(/\$\{[^}]*\}/g, "0");
          // Demo titles, legends and SVG labels cannot render math, so Unicode scripts are correct there.
          for (const p of formulaProblems(text, { unicode: false })) problems.push(`${relative(demos, f)}:${i + 1} ${p}`);
        }
      });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
