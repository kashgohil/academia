# Lab

Interactive lessons for learning deeply: electronics, statistics, ML, systems, compilers, graphics and more. Every lesson is built around a demo you can manipulate.

- **20 tracks**, each running from Foundations → Core → Advanced → Frontier. The full map lives in [`src/content/curriculum.ts`](src/content/curriculum.ts).
- **Lesson loop**: predict → play → explain → recall. Recall cards feed a spaced-repetition (SM-2) review queue stored in IndexedDB.
- **Shareable state**: every demo parameter is kept in the URL.

## Run

```bash
pnpm install
```

```bash
pnpm build:wasm
```

```bash
pnpm dev
```

`build:wasm` needs Rust with `rustup target add wasm32-unknown-unknown`.

## Stack

Vite · React 19 · TypeScript · MDX + KaTeX · d3-scale/shape/contour · Rust → WebAssembly · idb-keyval · Vitest · Playwright

## Layout

```
src/app/        shell: routing, sidebar, search (/ or ⌘K), pages
src/kit/        demo building blocks (params, sim loop, plots, predict, recall)
src/sims/       pure simulation logic, unit-tested
src/demos/      one component per demo
src/wasm/       bindings for crates/
src/content/    curriculum registry + lessons/<track>/<module>/<lesson>.mdx
src/review/     spaced repetition
crates/         Rust simulators compiled to wasm32
```

## Add a lesson

```bash
pnpm new:lesson <track>/<module>/<lesson>
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Test

```bash
pnpm test
```

```bash
cargo test --manifest-path crates/cachesim/Cargo.toml
```

```bash
pnpm build && pnpm test:e2e
```
