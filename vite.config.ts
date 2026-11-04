/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
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
        rehypePlugins: [rehypeKatex],
      }),
    },
    react({ include: /\.(mdx|tsx|ts)$/ }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["tests/unit/**/*.test.ts"] },
});
