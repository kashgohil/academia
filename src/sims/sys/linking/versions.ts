/**
 * glibc symbol versions: the version that a program records for each function, and the check that ld.so makes
 * at startup.
 *
 * The program refers to a versioned name such as memcpy@GLIBC_2.14. The static linker takes the default version
 * from the libc.so that it links against. ld.so refuses to start the program if the libc.so.6 that it finds at run
 * time does not define every version that the program needs ("version `GLIBC_2.34' not found").
 *
 * The data was checked on 2026-11-22 with zig cc 0.17.1, which ships the symbol lists of each glibc release:
 * zig cc -target x86_64-linux-gnu.<version>, then llvm-readelf --dyn-syms on the output.
 */

/** glibc releases that the demo offers, oldest first. */
export const GLIBCS = ["2.17", "2.26", "2.28", "2.31", "2.34", "2.35", "2.39"] as const;
export type Glibc = (typeof GLIBCS)[number];

/** Compare "2.9" < "2.14" correctly. */
export const verCmp = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

export interface VersionedFn {
  name: string;
  /** [first glibc that gives this version, version tag], newest last. */
  history: [string, string][];
  /** The function does not exist before this glibc. */
  since?: string;
  /** The library that holds it, before glibc 2.34 moved libpthread into libc. */
  lib?: (built: string) => string;
}

export const FUNCTIONS: VersionedFn[] = [
  { name: "__libc_start_main", history: [["2.2.5", "GLIBC_2.2.5"], ["2.34", "GLIBC_2.34"]] },
  { name: "puts", history: [["2.2.5", "GLIBC_2.2.5"]] },
  { name: "memcpy", history: [["2.2.5", "GLIBC_2.2.5"], ["2.14", "GLIBC_2.14"]] },
  { name: "getrandom", history: [["2.25", "GLIBC_2.25"]], since: "2.25" },
  { name: "pthread_create", history: [["2.2.5", "GLIBC_2.2.5"], ["2.34", "GLIBC_2.34"]], lib: (b) => (verCmp(b, "2.34") < 0 ? "libpthread.so.0" : "libc.so.6") },
];

/** The version tag that a program built against glibc `built` records for `fn`, or null if fn does not exist yet. */
export function versionFor(fn: VersionedFn, built: string): string | null {
  if (fn.since && verCmp(built, fn.since) < 0) return null;
  let v: string | null = null;
  for (const [from, tag] of fn.history) if (verCmp(built, from) >= 0) v = tag;
  return v;
}

export interface RunCheck {
  needs: { fn: string; version: string | null; lib: string }[];
  /** Functions that do not compile against the build glibc (no declaration in its headers). */
  compileErrors: string[];
  /** ld.so's error, or null if the program starts. */
  error: string | null;
  missing: string[];
}

/** Build against glibc `built`, run on glibc `run`, with the functions `used` (main always needs __libc_start_main). */
export function checkRun(built: string, run: string, used: string[]): RunCheck {
  const fns = FUNCTIONS.filter((f) => f.name === "__libc_start_main" || used.includes(f.name));
  const needs = fns.map((f) => ({ fn: f.name, version: versionFor(f, built), lib: f.lib?.(built) ?? "libc.so.6" }));
  const compileErrors = needs.filter((n) => n.version === null).map((n) => n.fn);
  if (compileErrors.length) return { needs, compileErrors, error: null, missing: [] };
  const missing = [...new Set(needs.map((n) => n.version!).filter((v) => verCmp(v.replace("GLIBC_", ""), run) > 0))];
  missing.sort((a, b) => verCmp(a.replace("GLIBC_", ""), b.replace("GLIBC_", "")));
  const error = missing.length ? `./app: /lib/x86_64-linux-gnu/libc.so.6: version \`${missing[missing.length - 1]}' not found (required by ./app)` : null;
  return { needs, compileErrors, error, missing };
}
