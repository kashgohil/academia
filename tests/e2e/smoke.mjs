// Smoke test: build must exist (pnpm build). Starts `vite preview`, visits every page and
// live lesson, unlocks demos, moves a slider, fails on any console error. Saves screenshots.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PORT = 4179;
const BASE = `http://localhost:${PORT}`;
const SHOTS = new URL("./shots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

// Spawn vite directly (not via npx) so kill() reaches the server process.
const vite = new URL("../../node_modules/vite/bin/vite.js", import.meta.url).pathname;
const server = spawn(process.execPath, [vite, "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((res, rej) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && res());
  server.on("exit", rej);
  setTimeout(() => rej(new Error("preview did not start")), 15000);
});

// Live lessons, read from the curriculum registry.
const curriculum = readFileSync(new URL("../../src/content/curriculum.ts", import.meta.url), "utf8");
const liveBlock = curriculum.slice(curriculum.indexOf("export const LIVE"), curriculum.indexOf("]);", curriculum.indexOf("export const LIVE")));
const LIVE = [...liveBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const browser = await chromium.launch();
const failures = [];
try {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));

    const visit = async (path, name) => {
      errors.length = 0;
      await page.goto(`${BASE}/${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      return name;
    };

    await visit("", "home");
    await page.screenshot({ path: `${SHOTS}${theme}-home.png` });
    await visit("electronics", "track");
    await page.screenshot({ path: `${SHOTS}${theme}-track.png` });
    await visit("math/vectors/dot-product-and-projection", "planned");
    if (errors.length) failures.push(`[${theme}] pages: ${errors.join(" | ")}`);

    for (const path of LIVE) {
      try {
      await visit(path, path);
      // Answer every prediction (first option) to unlock gated demos.
      for (const block of await page.locator(".predict").all()) {
        const first = block.locator(".choice").first();
        if (await first.isEnabled()) await first.click();
      }
      await page.waitForSelector(".demo", { timeout: 20000 });
      await page.waitForTimeout(800);
      const demo = page.locator(".demo").first();
      const before = await demo.innerHTML();
      const slider = demo.locator('input[type="range"]').first();
      if (await slider.count()) {
        await slider.focus();
        for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(600);
        if ((await demo.innerHTML()) === before) failures.push(`[${theme}] ${path}: slider did not change the demo`);
      }
      const short = path.split("/").pop();
      await demo.screenshot({ path: `${SHOTS}${theme}-${short}.png` });
      if (errors.length) failures.push(`[${theme}] ${path}: ${errors.join(" | ")}`);
      } catch (e) {
        failures.push(`[${theme}] ${path}: ${String(e).split("\n")[0]}`);
      }
    }
    await ctx.close();
  }

  // Phone width: no horizontal page scroll.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const path of ["", LIVE[1], "systems/allocators/free-lists"]) {
    await phone.goto(`${BASE}/${path}`, { waitUntil: "networkidle" });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) failures.push(`phone ${path || "home"}: horizontal overflow ${overflow}px`);
  }
  await phone.screenshot({ path: `${SHOTS}phone-clt.png`, fullPage: false });
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error("FAIL\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${LIVE.length} lessons × 2 themes, screenshots in tests/e2e/shots`);
process.exit(0);
