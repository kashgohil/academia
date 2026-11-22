/**
 * The dynamic loader's symbol lookup: the lookup scope, interposition, and the ways to opt out of it.
 *
 * glibc's ld.so (elf/dl-lookup.c, _dl_lookup_symbol_x) searches a list of loaded objects in order and takes the
 * first one that exports a definition of the name:
 * - The global scope: the executable, then the LD_PRELOAD libraries, then the DT_NEEDED libraries in
 *   breadth-first order (ld.so(8)). An object opened with dlopen(RTLD_GLOBAL) is added at the end.
 * - A library opened with dlopen(RTLD_LOCAL), the default, gets its own local scope: itself and its own
 *   dependencies. Its lookups search the global scope first, then the local scope. Other objects do not see it.
 *
 * A reference never reaches ld.so if the static linker or the compiler bound it already. That happens for a
 * hidden or protected definition in the same library, for -Bsymbolic, and for -fno-semantic-interposition
 * (calls to functions in the same translation unit). The checks of the scenario are in the test file.
 */

export type Fix = "none" | "bsymbolic" | "hidden" | "protected" | "no-semantic-interposition";

export interface LoaderConfig {
  preload: boolean;
  /** libbar.so is linked into the program before libfoo.so, and it happens to define fmt too. */
  withBar: boolean;
  fix: Fix;
  pluginGlobal: boolean;
}

export interface LoadedObject { name: string; needed: string[]; exports: string[]; role: string }

export const OBJECTS: Record<string, LoadedObject> = {
  app: { name: "app", needed: [], exports: [], role: "the executable" },
  "libtrace.so": { name: "libtrace.so", needed: ["libc.so.6"], exports: ["malloc"], role: "LD_PRELOAD: a malloc wrapper that counts calls" },
  "libbar.so": { name: "libbar.so", needed: ["libc.so.6"], exports: ["fmt", "bar_init"], role: "another library that also has a function named fmt" },
  "libfoo.so": { name: "libfoo.so", needed: ["libc.so.6"], exports: ["logopen", "fmt"], role: "the logging library; logopen calls its own fmt" },
  "libc.so.6": { name: "libc.so.6", needed: [], exports: ["malloc", "free", "puts"], role: "the C library" },
  "plugin.so": { name: "plugin.so", needed: [], exports: ["plugin_api"], role: "opened with dlopen" },
  "plugin2.so": { name: "plugin2.so", needed: [], exports: ["plugin2_run"], role: "opened later with dlopen; uses plugin_api but does not list plugin.so in DT_NEEDED" },
};

export interface Ref { from: string; name: string; note: string }

export const REFS: Ref[] = [
  { from: "app", name: "malloc", note: "main calls malloc" },
  { from: "app", name: "logopen", note: "main calls logopen" },
  { from: "libfoo.so", name: "fmt", note: "logopen calls fmt, in the same file" },
  { from: "libfoo.so", name: "malloc", note: "fmt calls malloc" },
  { from: "plugin2.so", name: "plugin_api", note: "plugin2_run calls plugin_api" },
];

export interface Binding {
  ref: Ref;
  /** The object whose definition wins, or null if none. */
  to: string | null;
  how: "scope" | "link time" | "error";
  /** Objects that the lookup checked, in order. */
  searched: string[];
  text: string;
}

export interface LoaderResult {
  globalScope: string[];
  pluginScope: string[];
  bindings: Binding[];
}

function bfs(roots: string[], needed: (n: string) => string[]): string[] {
  const out: string[] = [];
  const q = [...roots];
  while (q.length) {
    const n = q.shift()!;
    if (out.includes(n)) continue;
    out.push(n);
    q.push(...needed(n));
  }
  return out;
}

export function runLoader(cfg: LoaderConfig): LoaderResult {
  const appNeeded = [...(cfg.withBar ? ["libbar.so"] : []), "libfoo.so", "libc.so.6"];
  const needed = (n: string) => (n === "app" ? appNeeded : OBJECTS[n]!.needed);
  const globalScope = bfs(["app", ...(cfg.preload ? ["libtrace.so"] : []), ...appNeeded], needed);
  // dlopen("plugin.so") first, then dlopen("plugin2.so").
  if (cfg.pluginGlobal) globalScope.push("plugin.so");
  const pluginScope = bfs(["plugin2.so"], needed);
  const exportsOf = (o: string) => {
    const e = OBJECTS[o]!.exports;
    return o === "libfoo.so" && cfg.fix === "hidden" ? e.filter((x) => x !== "fmt") : e;
  };
  const bindings = REFS.map((ref): Binding => {
    if (ref.from === "libfoo.so" && ref.name === "fmt" && cfg.fix !== "none") {
      const why = {
        bsymbolic: "-Bsymbolic: the static linker bound every reference to a definition in the same library",
        hidden: "fmt is hidden: it is not in .dynsym, and the static linker bound the call",
        protected: "fmt is protected: it is exported, but calls from libfoo.so bind to its own copy",
        "no-semantic-interposition": "-fno-semantic-interposition: the compiler calls fmt directly, with no PLT",
      }[cfg.fix as Exclude<Fix, "none">];
      return { ref, to: "libfoo.so", how: "link time", searched: [], text: why };
    }
    const scope = ref.from === "plugin2.so" ? [...globalScope, ...pluginScope.filter((x) => !globalScope.includes(x))] : globalScope;
    const searched: string[] = [];
    for (const o of scope) {
      searched.push(o);
      if (exportsOf(o).includes(ref.name)) return { ref, to: o, how: "scope", searched, text: `found in ${o}, object ${searched.length} of the scope` };
    }
    return { ref, to: null, how: "error", searched, text: `${ref.from}: undefined symbol: ${ref.name}` };
  });
  return { globalScope, pluginScope, bindings };
}
