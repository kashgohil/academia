# Writing a lesson

Every lesson follows one loop: **Predict → Play → Explain → Recall**. A lesson with no demo you can manipulate doesn't ship.

## 1. Pick a planned lesson

Browse the sidebar. Grey lessons are planned. The URL is the path, e.g. `/math/vectors/dot-product-and-projection`.

```bash
pnpm new:lesson math/vectors/dot-product-and-projection
```

This creates:

- `src/content/lessons/<path>.mdx`: the lesson
- `src/demos/<Name>Demo.tsx`: a demo stub
- an entry in `LIVE` in `src/content/curriculum.ts`

## 2. Put the math in `src/sims/`

Simulation logic is plain TypeScript with no React, so it can be unit-tested. Add tests in `tests/unit/`, especially for any number the lesson text quotes.

Use Rust → WASM (`crates/<name>`, raw `extern "C"` exports, see `crates/cachesim`) only when TS is measurably too slow, or when the implementation itself is part of the lesson.

## 3. Build the demo from the kit (`src/kit`)

| Piece | Use |
|---|---|
| `useParams(id, schema)` + `<Controls>` | typed sliders, selects and toggles, synced to the URL (shareable state) |
| `range`, `select`, `toggle` | schema builders (`log: true` for log sliders, `segmented: true` for small option sets) |
| `useSim({ step, reset, dt })` | fixed-timestep loop with play, pause, step and reset |
| `<Demo title actions controls>` | the standard frame |
| `<Plot x y>` + `Line Area Bars Dots RuleX RuleY Label` | SVG charts in data coordinates; `usePlot()` gives the scales for custom marks |
| `<Canvas2D draw deps>` | DPR-aware canvas for dense views; `cssVar("--c1")` for theme colors |
| `<Stats>`, `<Legend>`, `<Graph>` | readouts, keys, node/edge diagrams |
| `seg`, `mono`, `tint`, `<Btn>`, `<ButtonRow>` | a segmented select, monospace style, a theme-safe tint, buttons |
| `<Note>`, `<SmallLabel>`, `<SectionLabel>` | muted remarks and headings inside a demo |
| `<Banner tone>`, `<StepCaption>` | a result strip with a colored edge; the text for the current step |
| `<Panel>`, `<Chip>`, `<Meter>`, `<Bar>`, `<StackBar>`, `<MiniTable>` | boxes, labels, bars, a compact table |
| `useStepper` + `<StepButtons>` + `<StepSlider>` | frames with play, back and step |
| `<IndexButtons>` + `<IndexSlider>` | back and next for a position that the demo holds itself |
| `useChunked(key, jobs)` | heavy sweeps in time slices, so that a render never blocks |
| `int`, `fixed`, `sig`, `ms`, `si`, `bytes`, `pct` | number formats: `fixed(3.14159)` is `3.14`, and `sig(1234.5)` is `1,230` |

Use these before you write a helper. Put a view that only one module needs in `src/demos/<track>/<Module>Ui.tsx`. `tests/unit/architecture.test.ts` fails if a demo redefines a kit helper, or if a sim imports React, the kit or a demo.

Colors: use only `var(--c1)`…`var(--c5)`, `--fg`, `--muted`, `--faint` and `--border`. They switch with the theme.

## 4. Write the MDX

Available in MDX without importing: `<Predict>`, `<Recall>`, `<Callout>`, `<Steps>`, `<Tex>`. Math uses `$inline$` and `$$display$$`. Inside JSX props, use `<Tex>{"..."}</Tex>` instead of `$`.

Two MDX traps, both checked by `tests/unit/mdx-prose.test.ts`:

- Never write `{...}` in prose. MDX runs it as JavaScript, and the lesson goes blank at runtime. Use a code span.
- In a pipe table, write a literal pipe as `\|`, even inside a code span. Otherwise the row silently loses cells.

- **Predict**: ask something with a plausible wrong answer. Wrap the demo in it so it unlocks after answering.
- **Things to try**: 3–5 concrete experiments, each revealing one idea.
- **Explain**: derive, don't just state. Use `<Steps>` for derivations, and say *why*, *how fast*, and *when it breaks*.
- **Connect**: point to related modules in other tracks.
- **Recall**: 4–6 cards. Questions should need recall, not recognition.

Style: ASD-STE100 (Simplified Technical English). At most 25 words per sentence, at most 6 sentences per paragraph, no contractions, no filler, no emoji. `tests/unit/style.test.ts` checks this; `STE_CHECK=track/module/lesson npx vitest run tests/unit/style.test.ts` checks one lesson.

## 5. Check

```bash
pnpm typecheck && pnpm test
```

```bash
pnpm build && pnpm test:e2e
```

The e2e test clicks through every live lesson in both themes and at phone width, fails on console errors, and saves screenshots to `tests/e2e/shots/`.
