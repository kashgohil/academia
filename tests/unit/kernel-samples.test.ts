/**
 * The code samples in "Writing a kernel" are exact copies of code that boots in QEMU (`pnpm test:kernels`).
 * Each fenced block follows a marker, {slash-star source: kernels/path#region star-slash}. The region lies between
 * `lesson:region` and `end lesson:region` comments in that file. When this test fails, copy the region into the lesson.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repo = new URL("../..", import.meta.url).pathname;
const dir = join(repo, "src/content/lessons/os/kernel");

function region(path: string, name: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of readFileSync(join(repo, path), "utf8").split("\n")) {
    const m = line.match(/^\s*(?:\/\/|#|\/\*)\s*(end )?lesson:([\w-]+)/);
    if (m && m[2] === name) {
      if (m[1]) {
        const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
        return out.map((l) => l.slice(indent)).join("\n").replace(/^\n+|\n+$/g, "");
      }
      on = true;
      continue;
    }
    if (on) out.push(line);
  }
  throw new Error(`${path} has no region ${name}`);
}

describe("kernel lesson samples match the kernel", () => {
  for (const file of readdirSync(dir)) {
    test(file, () => {
      const src = readFileSync(join(dir, file), "utf8");
      const fence = /```\w+\n([\s\S]*?)\n```/g;
      let n = 0;
      for (let m = fence.exec(src); m; m = fence.exec(src)) {
        n++;
        const before = src.slice(0, m.index).trimEnd();
        const mark = before.match(/\{\/\* source: ([^#]+)#([\w-]+) \*\/\}$/);
        expect(mark, `${file}: block ${n} needs a source marker on the line above it`).not.toBeNull();
        expect(m[1], `${file}: block ${n} differs from ${mark![1]}#${mark![2]}`).toBe(region(mark![1]!, mark![2]!));
      }
      expect(n).toBeGreaterThan(0);
    });
  }
});
