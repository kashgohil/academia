// Usage: pnpm new:lesson <track>/<module>/<lesson>
// Creates the MDX file and a demo stub, and marks the lesson live in curriculum.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const path = process.argv[2];
if (!path || path.split("/").length !== 3) {
  console.error("usage: pnpm new:lesson <track>/<module>/<lesson>   (see the URL of the planned lesson)");
  process.exit(1);
}
const root = new URL("..", import.meta.url).pathname;
const curriculumFile = join(root, "src/content/curriculum.ts");
const curriculum = readFileSync(curriculumFile, "utf8");
const [track, mod, lesson] = path.split("/");

// Sanity check against the registry: the track slug must exist.
if (!curriculum.includes(`track("${track}"`)) {
  console.error(`unknown track "${track}"`);
  process.exit(1);
}

const pascal = lesson.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase()) + "Demo";
const mdxFile = join(root, "src/content/lessons", `${path}.mdx`);
const demoFile = join(root, "src/demos", `${pascal}.tsx`);
if (existsSync(mdxFile)) {
  console.error(`exists: ${mdxFile}`);
  process.exit(1);
}

mkdirSync(dirname(mdxFile), { recursive: true });
writeFileSync(
  mdxFile,
  `---
summary: One sentence on what this lesson makes click.
---
import { ${pascal} } from "@/demos/${pascal}";

Why this matters, in two or three sentences.

<Predict
  id="first"
  question="A question the learner answers before seeing the demo."
  options={["Option A", "Option B", "Option C"]}
  answer={1}
  explain="Why B, in one or two sentences."
>
<${pascal} />
</Predict>

Things to try:

1. …

## The idea

Explain, with $math$ where it earns its place. Use <Steps> for derivations.

## Where it breaks / goes deeper

Edge cases, real-world caveats, links to related modules.

<Recall cards={[
  { q: "…?", a: "…" },
]} />
`,
);

if (!existsSync(demoFile)) {
  writeFileSync(
    demoFile,
    `import { Demo, Controls, Plot, Line, useParams, range } from "../kit";

const schema = {
  k: range({ label: "Parameter k", min: 0, max: 10, step: 0.1, default: 1 }),
};

export function ${pascal}() {
  const params = useParams("${lesson.slice(0, 12)}", schema);
  const { k } = params.values;
  const pts = Array.from({ length: 101 }, (_, i) => [i / 10, Math.sin(k * (i / 10))] as [number, number]);
  return (
    <Demo title="${lesson.replace(/-/g, " ")}" controls={<Controls params={params} />}>
      <Plot x={[0, 10]} y={[-1.1, 1.1]}>
        <Line points={pts} />
      </Plot>
    </Demo>
  );
}
`,
  );
}

writeFileSync(curriculumFile, curriculum.replace(/export const LIVE = new Set<string>\(\[\n/, (m) => `${m}  "${path}",\n`));

console.log(`created ${mdxFile.replace(root, "")}`);
console.log(`created ${demoFile.replace(root, "")}`);
console.log("marked live in src/content/curriculum.ts. Run pnpm test to check the path matches the registry.");
