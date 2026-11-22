/** Archives, code models, GNU hash, loader scope and glibc versions: checked against ld.lld 22.1.8, clang 22.1.8 and zig cc 0.17.1. */
import { describe, expect, test } from "vitest";
import {
  LIBLOG, LIBZ, MAIN_OBJ, bindAllCost, buildGnuHash, checkRun, dlNewHash, fakeLibrary, gnuHashBytes, gnuLookup, picOutcome,
  runLoader, scanArchives, scopeLookup, toHex, type CmdItem,
} from "../../src/sims/sys/linking";

describe("archive order", () => {
  const cases: [string, CmdItem[], [number, number] | null][] = [
    ["main.o libz.a liblog.a", [MAIN_OBJ, LIBZ, LIBLOG], null],
    ["main.o liblog.a libz.a", [MAIN_OBJ, LIBLOG, LIBZ], null],
    ["libz.a liblog.a main.o", [LIBZ, LIBLOG, MAIN_OBJ], null],
    ["main.o libz.a liblog.a libz.a", [MAIN_OBJ, LIBZ, LIBLOG, LIBZ], null],
    ["main.o --start-group libz.a liblog.a --end-group", [MAIN_OBJ, LIBZ, LIBLOG], [1, 2]],
  ];
  // ld.lld 22.1.8 --warn-backrefs output for each command line.
  const LLD_WARNINGS: Record<string, string[]> = {
    "main.o libz.a liblog.a": ["backward reference detected: crc32 in liblog.a(log.o) refers to libz.a(crc.o)"],
    "main.o liblog.a libz.a": ["backward reference detected: log_msg in libz.a(deflate.o) refers to liblog.a(log.o)"],
    "libz.a liblog.a main.o": [
      "backward reference detected: compress in main.o refers to libz.a(deflate.o)",
      "backward reference detected: crc32 in liblog.a(log.o) refers to libz.a(crc.o)",
    ],
    "main.o libz.a liblog.a libz.a": [],
    "main.o --start-group libz.a liblog.a --end-group": [],
  };
  // What GNU ld leaves undefined (from its documented rules: each archive is searched once, at its place).
  const GNU_UNDEF: Record<string, string[]> = {
    "main.o libz.a liblog.a": ["crc32"],
    "main.o liblog.a libz.a": ["log_msg"],
    "libz.a liblog.a main.o": ["compress"],
    "main.o libz.a liblog.a libz.a": [],
    "main.o --start-group libz.a liblog.a --end-group": [],
  };
  for (const [name, items, group] of cases) {
    test(name, () => {
      const l = scanArchives(items, "lld", group);
      expect(l.ok).toBe(true);
      expect(l.warnings).toEqual(LLD_WARNINGS[name]);
      expect([...l.extracted].sort()).toEqual(["libz.a(crc.o)", "libz.a(deflate.o)", "liblog.a(log.o)"].sort());
      expect(scanArchives(items, "gnu", group).undefined).toEqual(GNU_UNDEF[name]);
    });
  }
});

describe("code models against ld.lld", () => {
  // Rows from the real links (clang 22.1.8 -O2, ld.lld 22.1.8): [code model, output, defs] → dynamic relocations or errors.
  const REAL: [string, string, string, string][] = [
    ["no-pic", "exe", "same", ""],
    ["no-pic", "exe", "so", "R_X86_64_COPY counter,R_X86_64_JUMP_SLOT add"],
    ["no-pic", "pie", "same", ""],
    ["no-pic", "pie", "so", "R_X86_64_COPY counter,R_X86_64_JUMP_SLOT add"],
    ["no-pic", "shared", "same", "error hits,hits,counter"],
    ["no-pic", "shared", "so", "error hits,hits,counter"],
    ["pie", "exe", "same", ""],
    ["pie", "exe", "so", "R_X86_64_GLOB_DAT counter,R_X86_64_JUMP_SLOT add"],
    ["pie", "pie", "same", ""],
    ["pie", "pie", "so", "R_X86_64_GLOB_DAT counter,R_X86_64_JUMP_SLOT add"],
    ["pie", "shared", "same", "error hits,hits"],
    ["pie", "shared", "so", "error hits,hits"],
    ["pic", "exe", "same", ""],
    ["pic", "exe", "so", "R_X86_64_GLOB_DAT counter,R_X86_64_JUMP_SLOT add"],
    ["pic", "pie", "same", ""],
    ["pic", "pie", "so", "R_X86_64_GLOB_DAT counter,R_X86_64_JUMP_SLOT add"],
    ["pic", "shared", "same", "R_X86_64_GLOB_DAT hits,R_X86_64_GLOB_DAT counter,R_X86_64_JUMP_SLOT add"],
    ["pic", "shared", "so", "R_X86_64_GLOB_DAT hits,R_X86_64_GLOB_DAT counter,R_X86_64_JUMP_SLOT add"],
  ];
  for (const [cm, out, defs, want] of REAL) {
    test(`${cm} → ${out}, defs in ${defs}`, () => {
      const r = picOutcome(cm as "pic", out as "exe", defs as "so");
      const got = r.errors.length ? `error ${r.errors.map((e) => e.match(/symbol '(\w+)'/)![1]).join(",")}` : r.dynRelocs.join(",");
      expect(got).toBe(want);
    });
  }
  test("PIE code relaxes the GOT load of counter when counter is in the same link", () => {
    expect(picOutcome("pie", "pie", "same").refs[1]!.code).toBe("lea rax, [rip + counter]");
  });
  test("-Bsymbolic removes the dynamic relocations of a library's own symbols", () => {
    expect(picOutcome("pic", "shared", "same", true).dynRelocs).toEqual([]);
  });
});

describe("GNU hash matches ld.lld", () => {
  const names = ["puts", "printf", "malloc", "free", "memcpy", "strlen", "exit", "fopen", "fclose", "fread", "fwrite", "qsort"];
  const t = buildGnuHash(names);
  test("the bytes of .gnu.hash in a .so from ld.lld 22.1.8", () => {
    expect(toHex(gnuHashBytes(t))).toBe(
      "0300000001000000040000001a00000008004280020000a08800000000000020a80001a000000001100000000000004001000000040000000c000000107b9c7c9cbb931c4701750fb82b6b153cad390d86f0967c3e7e967c7c8b730f20cf09fd16ea76feffc73c109175820d",
    );
    expect(t.names).toEqual(["puts", "strlen", "fread", "printf", "malloc", "free", "exit", "fopen", "fclose", "fwrite", "qsort", "memcpy"]);
  });
  test("hash values", () => {
    expect(dlNewHash("puts")).toBe(0x7c9c7b11);
    expect(dlNewHash("")).toBe(5381);
  });
  test("lookup", () => {
    const hit = gnuLookup(t, "malloc");
    expect(hit.found).toBe(5);
    expect(hit.strcmps).toBe(1);
    expect(gnuLookup(t, "pthread_create").found).toBe(null);
  });
  test("every name of a large table is found, and the bloom filter rejects most misses", () => {
    const libs = Array.from({ length: 20 }, (_, i) => fakeLibrary(i, 400));
    const tables = libs.map((n) => buildGnuHash(n));
    for (const n of libs[7]!.slice(0, 50)) expect(scopeLookup(tables, n).foundIn).toBe(7);
    const s = scopeLookup(tables, libs[19]![3]!);
    expect(s.visits.length).toBe(20);
    const cost = bindAllCost(tables, libs, 1000);
    expect(cost.bloomRejects / (cost.visits - 1000)).toBeGreaterThan(0.9);
  });
});

describe("loader scope", () => {
  const base = { preload: false, withBar: false, fix: "none" as const, pluginGlobal: false };
  test("global scope order: executable, preload, needed (breadth-first)", () => {
    expect(runLoader({ ...base, preload: true, withBar: true }).globalScope).toEqual(["app", "libtrace.so", "libbar.so", "libfoo.so", "libc.so.6"]);
  });
  test("LD_PRELOAD wins for malloc, for the program and for libraries", () => {
    const r = runLoader({ ...base, preload: true });
    expect(r.bindings.filter((b) => b.ref.name === "malloc").map((b) => b.to)).toEqual(["libtrace.so", "libtrace.so"]);
    expect(runLoader(base).bindings[0]!.to).toBe("libc.so.6");
  });
  test("an earlier library interposes fmt unless libfoo opts out", () => {
    expect(runLoader({ ...base, withBar: true }).bindings[2]!.to).toBe("libbar.so");
    for (const fix of ["bsymbolic", "hidden", "protected", "no-semantic-interposition"] as const) expect(runLoader({ ...base, withBar: true, fix }).bindings[2]!.to).toBe("libfoo.so");
  });
  test("RTLD_LOCAL hides plugin.so from plugin2.so", () => {
    expect(runLoader(base).bindings[4]!.text).toBe("plugin2.so: undefined symbol: plugin_api");
    expect(runLoader({ ...base, pluginGlobal: true }).bindings[4]!.to).toBe("plugin.so");
  });
});

describe("glibc versions (zig cc 0.17.1)", () => {
  test("recorded versions", () => {
    expect(checkRun("2.39", "2.39", ["puts", "memcpy", "pthread_create", "getrandom"]).needs.map((n) => `${n.fn}@${n.version}`)).toEqual([
      "__libc_start_main@GLIBC_2.34", "puts@GLIBC_2.2.5", "memcpy@GLIBC_2.14", "getrandom@GLIBC_2.25", "pthread_create@GLIBC_2.34",
    ]);
    expect(checkRun("2.28", "2.28", ["pthread_create"]).needs.map((n) => `${n.fn}@${n.version} ${n.lib}`)).toEqual(["__libc_start_main@GLIBC_2.2.5 libc.so.6", "pthread_create@GLIBC_2.2.5 libpthread.so.0"]);
  });
  test("ld.so refuses a newer version", () => {
    expect(checkRun("2.35", "2.31", ["puts"]).error).toBe("./app: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found (required by ./app)");
    expect(checkRun("2.28", "2.39", ["puts", "memcpy"]).error).toBe(null);
    expect(checkRun("2.17", "2.17", ["getrandom"]).compileErrors).toEqual(["getrandom"]);
  });
});

describe("numbers quoted in the lessons", () => {
  test("GNU hash scope of 20 libraries with 500 names", () => {
    const names = Array.from({ length: 20 }, (_, i) => fakeLibrary(i, 500));
    const tables = names.map((n) => buildGnuHash(n));
    const s = scopeLookup(tables, names[19]![0]!);
    expect([s.visits.length, s.bloomRejects, s.falsePositives, s.strcmps]).toEqual([20, 19, 0, 1]);
    const c = bindAllCost(tables, names, 500);
    expect(c).toEqual({ visits: 5286, bloomRejects: 4710, falsePositives: 76, strcmps: 500 });
    expect(((c.bloomRejects / (c.visits - 500)) * 100).toFixed(1)).toBe("98.4");
  });
  test("12-name table: 3 buckets, 4 bloom words", () => {
    const t = buildGnuHash(["puts", "printf", "malloc", "free", "memcpy", "strlen", "exit", "fopen", "fclose", "fread", "fwrite", "qsort"]);
    expect([t.nbuckets, t.bloom.length]).toEqual([3, 4]);
  });
});
