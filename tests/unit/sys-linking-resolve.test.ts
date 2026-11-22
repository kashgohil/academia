/** All 72 two-file symbol-resolution cases, compared with ld.lld 22.1.8 (objects from clang 22.1.8, -fno-pic -O1). */
import { describe, expect, test } from "vitest";
import { DECLS, resolveTwo } from "../../src/sims/sys/linking";

/** "<-fcommon or not>/<a.c decl>/<b.c decl>": ld.lld's first error line, or what get_a and get_b read (from the link map). */
const LLD: Record<string, string> = {
  "nocommon/none/none": "nothing | nothing",
  "nocommon/none/extern": "undefined symbol: x",
  "nocommon/none/tentative": "nothing | b.o:(.bss)",
  "nocommon/none/init": "nothing | b.o:(.data)",
  "nocommon/none/weak": "nothing | b.o:(.data)",
  "nocommon/none/static": "nothing | own static",
  "nocommon/extern/none": "undefined symbol: x",
  "nocommon/extern/extern": "undefined symbol: x",
  "nocommon/extern/tentative": "b.o:(.bss) | b.o:(.bss)",
  "nocommon/extern/init": "b.o:(.data) | b.o:(.data)",
  "nocommon/extern/weak": "b.o:(.data) | b.o:(.data)",
  "nocommon/extern/static": "undefined symbol: x",
  "nocommon/tentative/none": "a.o:(.bss) | nothing",
  "nocommon/tentative/extern": "a.o:(.bss) | a.o:(.bss)",
  "nocommon/tentative/tentative": "duplicate symbol: x",
  "nocommon/tentative/init": "duplicate symbol: x",
  "nocommon/tentative/weak": "a.o:(.bss) | a.o:(.bss)",
  "nocommon/tentative/static": "a.o:(.bss) | own static",
  "nocommon/init/none": "a.o:(.data) | nothing",
  "nocommon/init/extern": "a.o:(.data) | a.o:(.data)",
  "nocommon/init/tentative": "duplicate symbol: x",
  "nocommon/init/init": "duplicate symbol: x",
  "nocommon/init/weak": "a.o:(.data) | a.o:(.data)",
  "nocommon/init/static": "a.o:(.data) | own static",
  "nocommon/weak/none": "a.o:(.data) | nothing",
  "nocommon/weak/extern": "a.o:(.data) | a.o:(.data)",
  "nocommon/weak/tentative": "b.o:(.bss) | b.o:(.bss)",
  "nocommon/weak/init": "b.o:(.data) | b.o:(.data)",
  "nocommon/weak/weak": "a.o:(.data) | a.o:(.data)",
  "nocommon/weak/static": "a.o:(.data) | own static",
  "nocommon/static/none": "own static | nothing",
  "nocommon/static/extern": "undefined symbol: x",
  "nocommon/static/tentative": "own static | b.o:(.bss)",
  "nocommon/static/init": "own static | b.o:(.data)",
  "nocommon/static/weak": "own static | b.o:(.data)",
  "nocommon/static/static": "own static | own static",
  "common/none/none": "nothing | nothing",
  "common/none/extern": "undefined symbol: x",
  "common/none/tentative": "nothing | b.o:(COMMON)",
  "common/none/init": "nothing | b.o:(.data)",
  "common/none/weak": "nothing | b.o:(.data)",
  "common/none/static": "nothing | own static",
  "common/extern/none": "undefined symbol: x",
  "common/extern/extern": "undefined symbol: x",
  "common/extern/tentative": "b.o:(COMMON) | b.o:(COMMON)",
  "common/extern/init": "b.o:(.data) | b.o:(.data)",
  "common/extern/weak": "b.o:(.data) | b.o:(.data)",
  "common/extern/static": "undefined symbol: x",
  "common/tentative/none": "a.o:(COMMON) | nothing",
  "common/tentative/extern": "a.o:(COMMON) | a.o:(COMMON)",
  "common/tentative/tentative": "a.o:(COMMON) | a.o:(COMMON)",
  "common/tentative/init": "b.o:(.data) | b.o:(.data)",
  "common/tentative/weak": "a.o:(COMMON) | a.o:(COMMON)",
  "common/tentative/static": "a.o:(COMMON) | own static",
  "common/init/none": "a.o:(.data) | nothing",
  "common/init/extern": "a.o:(.data) | a.o:(.data)",
  "common/init/tentative": "a.o:(.data) | a.o:(.data)",
  "common/init/init": "duplicate symbol: x",
  "common/init/weak": "a.o:(.data) | a.o:(.data)",
  "common/init/static": "a.o:(.data) | own static",
  "common/weak/none": "a.o:(.data) | nothing",
  "common/weak/extern": "a.o:(.data) | a.o:(.data)",
  "common/weak/tentative": "b.o:(COMMON) | b.o:(COMMON)",
  "common/weak/init": "b.o:(.data) | b.o:(.data)",
  "common/weak/weak": "a.o:(.data) | a.o:(.data)",
  "common/weak/static": "a.o:(.data) | own static",
  "common/static/none": "own static | nothing",
  "common/static/extern": "undefined symbol: x",
  "common/static/tentative": "own static | b.o:(COMMON)",
  "common/static/init": "own static | b.o:(.data)",
  "common/static/weak": "own static | b.o:(.data)",
  "common/static/static": "own static | own static",
};

describe("two-file resolution matches ld.lld", () => {
  for (const common of [false, true]) for (const a of DECLS) for (const b of DECLS) {
    const key = `${common ? "common" : "nocommon"}/${a}/${b}`;
    test(key, () => {
      const r = resolveTwo(a, b, common);
      const got = r.error ? r.error.text : `${r.a.reads} | ${r.b.reads}`;
      expect(got).toBe(LLD[key]);
    });
  }
  test("main's return value", () => {
    expect(resolveTwo("init", "weak", false).ret).toBe(11);
    expect(resolveTwo("weak", "init", false).ret).toBe(22);
    expect(resolveTwo("tentative", "tentative", true).ret).toBe(0);
    expect(resolveTwo("static", "init", false).ret).toBe(12);
    expect(resolveTwo("tentative", "tentative", false).error?.text).toBe("duplicate symbol: x");
  });
});
