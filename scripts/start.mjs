// One command to run the app: installs what is missing, builds the WASM, starts the dev server.
// Uses only Node built-ins, because it must run before `pnpm install`.
//
//   pnpm start                  opens the app in the browser
//   pnpm start --no-open        does not open the browser
//   pnpm start --port 3000      other arguments go to vite
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const WASM_TARGET = "wasm32-unknown-unknown";
const say = (msg) => console.log(`[start] ${msg}`);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status === 0;
const output = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
};

function installDependencies() {
  const marker = join(root, "node_modules/.modules.yaml");
  const lockfile = join(root, "pnpm-lock.yaml");
  if (existsSync(marker) && statSync(marker).mtimeMs >= statSync(lockfile).mtimeMs) return;
  if (output("pnpm", ["--version"]) === null) {
    console.error("[start] pnpm is not installed. Install it from https://pnpm.io/installation, then run this again.");
    process.exit(1);
  }
  say("installing dependencies");
  if (!run("pnpm", ["install", "--frozen-lockfile"])) process.exit(1);
}

/** WASM problems do not stop the app: only the cache and allocator demos need it. */
function buildWasm() {
  const dir = join(root, "public/wasm");
  const crates = readdirSync(join(root, "crates")).length;
  const built = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wasm")).length : 0;
  const warn = (why) => {
    if (built >= crates) say(`${why} Using the WASM files from the last build.`);
    else say(`WARNING: ${why} The cache and allocator demos will not work. Install Rust from https://rustup.rs, then run this again.`);
  };

  if (output("cargo", ["--version"]) === null) return warn("cargo is not installed.");
  const installed = output("rustup", ["target", "list", "--installed"]);
  if (installed !== null && !installed.includes(WASM_TARGET)) {
    say(`adding the Rust target ${WASM_TARGET}`);
    if (!run("rustup", ["target", "add", WASM_TARGET])) return warn(`could not add ${WASM_TARGET}.`);
  }
  say("building WASM");
  if (!run(process.execPath, ["scripts/build-wasm.mjs"])) warn("the WASM build failed.");
}

function startServer() {
  const args = process.argv.slice(2);
  const open = !args.includes("--no-open") && !args.includes("--open");
  const viteArgs = [join(root, "node_modules/vite/bin/vite.js"), ...args.filter((a) => a !== "--no-open"), ...(open ? ["--open"] : [])];
  const server = spawn(process.execPath, viteArgs, { cwd: root, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
  server.on("exit", (code) => process.exit(code ?? 0));
}

installDependencies();
buildWasm();
startServer();
