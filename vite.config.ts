/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeShiki from "@shikijs/rehype";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      ...mdx({
        providerImportSource: "@mdx-js/react",
        // singleTilde off: prose such as "~5 ms and ~10 ms" must not become strikethrough.
        remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, [remarkGfm, { singleTilde: false }], remarkMath],
        // Code is highlighted at build time, in a light and a dark theme. src/styles.css picks one with --shiki-*.
        rehypePlugins: [
          rehypeKatex,
          [rehypeShiki, {
            themes: { light: "github-light", dark: "github-dark" },
            defaultColor: false,
            langs: ["rust", "go", "zig", "c", "cpp", "ts", "sql", "sh", "bash", "toml", "text"],
            // Shiki's asm grammar treats // comments in GNU assembler as code. Plain text is better than wrong colors.
            langAlias: { asm: "text" },
            fallbackLanguage: "text",
          }],
        ],
      }),
    },
    react({ include: /\.(mdx|tsx|ts)$/ }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/unit/**/*.test.ts"] },
});
