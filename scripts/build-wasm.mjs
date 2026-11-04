// Builds every crate in crates/ to wasm32 and copies the .wasm into public/wasm/.
import { execSync } from "node:child_process";
import { readdirSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
mkdirSync(join(root, "public/wasm"), { recursive: true });

for (const name of readdirSync(join(root, "crates"))) {
  const dir = join(root, "crates", name);
  execSync("cargo build --release --target wasm32-unknown-unknown", { cwd: dir, stdio: "inherit" });
  copyFileSync(join(dir, "target/wasm32-unknown-unknown/release", `${name}.wasm`), join(root, "public/wasm", `${name}.wasm`));
  console.log(`wasm: ${name}.wasm`);
}
