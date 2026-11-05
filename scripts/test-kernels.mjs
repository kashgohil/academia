// Builds the kernels in kernels/ and boots each one in QEMU. Each kernel tests itself and reports over COM1.
// Needs qemu-system-x86_64 and the Rust target x86_64-unknown-none. Zig and GRUB cases run if those tools exist.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../kernels/", import.meta.url).pathname;
const has = (cmd, arg = "--version") => spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;
const results = [];

function need(cond, hint) {
  if (cond) return;
  console.error(`[kernels] ${hint}`);
  process.exit(1);
}

function build(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`build failed: ${cmd} ${args.join(" ")}`);
  }
}

function qemu(args) {
  const r = spawnSync("qemu-system-x86_64", ["-machine", "q35", "-accel", "tcg", "-m", "64M", "-serial", "stdio", "-display", "none", "-no-reboot", "-device", "isa-debug-exit,iobase=0xf4,iosize=1", ...args], { encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: r.stdout ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}

/** `checks` holds strings that the output must contain, or functions that return an error message or null. */
function run(name, { boot, status, checks }) {
  const r = qemu(boot);
  const problems = [];
  if (r.timedOut) problems.push("timed out: the kernel hung");
  if (r.status !== status) problems.push(`exit status ${r.status}, expected ${status}`);
  for (const c of checks) {
    const p = typeof c === "string" ? (r.out.includes(c) ? null : `no line with "${c}"`) : c(r.out);
    if (p) problems.push(p);
  }
  results.push({ name, ok: problems.length === 0 });
  console.log(`${problems.length ? "FAIL" : "ok  "} ${name}`);
  if (problems.length) console.log(`  ${problems.join("\n  ")}\n--- output\n${r.out}---`);
}

const count = (out, text) => out.split("\n").filter((l) => l === text).length;
const selfTest = (protocol) => [
  "boot: 64-bit mode",
  `via ${protocol}`,
  "cpu: GDT, TSS and IDT loaded",
  "heap: sum 1999007",
  "preempt: ",
  "user c: bad pointers and bad calls refused",
  "page fault in user code at 0xffffffff80000000",
  "trap 13 in user code",
  "all tests passed",
  (o) => (count(o, "user a") === 3 && count(o, "user b") === 3 ? null : "each printer must print 3 lines"),
  (o) => (o.indexOf("user b") < o.lastIndexOf("user a") ? null : "the timer must interleave the two printers"),
  (o) => {
    const m = o.match(/frames: (\d+) free before the tasks, (\d+) after/);
    return m && m[1] === m[2] ? null : "dead tasks must return every frame";
  },
];

need(has("qemu-system-x86_64"), "qemu-system-x86_64 is missing. Install it: brew install qemu");
need(has("cargo"), "cargo is missing. Install Rust from https://rustup.rs");
const targets = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" }).stdout ?? "";
need(targets.includes("x86_64-unknown-none"), "the Rust target is missing: rustup target add x86_64-unknown-none");

build("cargo", ["build", "--release"], join(root, "rust"));
const rust = join(root, "rust/target/x86_64-unknown-none/release/tinykernel");

run("rust: self-test, direct boot (PVH)", { boot: ["-kernel", rust], status: 33, checks: selfTest("PVH") });
run("rust: stack overflow reaches the double fault handler on its IST stack", {
  boot: ["-kernel", rust, "-append", "test=double-fault"],
  status: 35,
  checks: ["test: overflowing the kernel stack", "double fault: rsp", "on the IST stack"],
});
run("rust: the same overflow with no IDT is a triple fault", {
  boot: ["-kernel", rust, "-append", "test=triple-fault"],
  status: 0,
  checks: ["with no IDT", (o) => (o.includes("double fault") || o.includes("all tests") ? "the kernel must not continue" : null)],
});

const mkrescue = ["grub-mkrescue", "i686-elf-grub-mkrescue"].find((c) => has(c));
if (mkrescue && has("xorriso")) {
  const dir = mkdtempSync(join(tmpdir(), "tinykernel-"));
  mkdirSync(join(dir, "iso/boot/grub"), { recursive: true });
  copyFileSync(rust, join(dir, "iso/boot/kernel.elf"));
  writeFileSync(join(dir, "iso/boot/grub/grub.cfg"), 'set timeout=0\nmenuentry "tinykernel" {\n  multiboot2 /boot/kernel.elf\n  boot\n}\n');
  build(mkrescue, ["-o", join(dir, "kernel.iso"), join(dir, "iso")], dir);
  run("rust: self-test through GRUB (Multiboot2)", { boot: ["-cdrom", join(dir, "kernel.iso")], status: 33, checks: selfTest("Multiboot2") });
  rmSync(dir, { recursive: true, force: true });
} else {
  console.log("skip rust through GRUB: brew install i686-elf-grub xorriso mtools");
}

if (has("zig", "version")) {
  build("zig", ["build-exe", "kernel.zig", "../boot.s", "-target", "x86_64-freestanding-none", "-mcpu=x86_64-sse-sse2-mmx-avx+soft_float", "-mcmodel=kernel", "-mno-red-zone", "-fllvm", "-flld", "-O", "ReleaseSafe", "-T", "../kernel.ld", "-fentry=boot32", "-femit-bin=kernel.elf"], join(root, "zig"));
  run("zig: heap behind std.mem.Allocator", { boot: ["-kernel", join(root, "zig/kernel.elf")], status: 33, checks: ["zig: 64-bit mode", "zig: heap holds 2000 values in 4 mapped pages", "all tests passed"] });
} else {
  console.log("skip zig: brew install zig");
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} of ${results.length} kernel boots passed`);
process.exit(failed ? 1 : 0);
