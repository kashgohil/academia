/**
 * Code models and output types: what the compiler emits for -fno-pic, -fPIE and -fPIC, and what the linker then
 * does for a non-PIE executable, a PIE and a shared library.
 *
 * The source is
 *
 *   extern int counter;           // defined elsewhere
 *   int hits;                     // defined here
 *   int add(int a, int b);        // defined elsewhere
 *   int get(void) { hits += 1; return add(counter, hits); }
 *
 * and counter and add are defined either in another object of the same link, or in a shared library.
 *
 * The rules are the ones that ld.lld applies (and GNU ld too, for these cases):
 * - A symbol is preemptible if a definition in another module may replace it at load time. In an executable,
 *   only symbols from shared libraries are preemptible. In a shared library, every default-visibility global
 *   symbol is preemptible, unless -Bsymbolic binds it locally.
 * - PC32 to a preemptible symbol: an executable gets a copy relocation (R_X86_64_COPY); a shared library is an error.
 * - GOTPCRELX to a non-preemptible symbol: relaxed to lea. To a preemptible symbol: a GOT slot with R_X86_64_GLOB_DAT.
 * - PLT32 to a non-preemptible symbol: a direct jump. To a preemptible symbol: a PLT stub with R_X86_64_JUMP_SLOT.
 *
 * tests/unit/sys-linking-more.test.ts compares all 18 combinations with clang 22.1.8 and ld.lld 22.1.8.
 */

export type CodeModel = "no-pic" | "pie" | "pic";
export type Output = "exe" | "pie" | "shared";
export type DefsIn = "same" | "so";

export interface PicRef {
  symbol: "hits" | "counter" | "add";
  /** What the compiler wrote in the object file. */
  objReloc: "R_X86_64_PC32" | "R_X86_64_REX_GOTPCRELX" | "R_X86_64_PLT32";
  objCode: string;
  preemptible: boolean;
  action: "direct" | "relaxed to lea" | "GOT slot" | "copy relocation" | "PLT stub" | "direct jump" | "error";
  /** The instruction in the output file. */
  code: string;
  dynReloc?: "R_X86_64_GLOB_DAT" | "R_X86_64_COPY" | "R_X86_64_JUMP_SLOT";
  error?: string;
}

export interface PicOutcome {
  refs: PicRef[];
  dynRelocs: string[];
  errors: string[];
}

const COMPILED: Record<CodeModel, Record<PicRef["symbol"], PicRef["objReloc"]>> = {
  "no-pic": { hits: "R_X86_64_PC32", counter: "R_X86_64_PC32", add: "R_X86_64_PLT32" },
  pie: { hits: "R_X86_64_PC32", counter: "R_X86_64_REX_GOTPCRELX", add: "R_X86_64_PLT32" },
  pic: { hits: "R_X86_64_REX_GOTPCRELX", counter: "R_X86_64_REX_GOTPCRELX", add: "R_X86_64_PLT32" },
};

/** How many relocations of each symbol the function has (hits is read and written). */
export const REF_COUNT = { hits: 2, counter: 1, add: 1 } as const;

const reg = { hits: "esi", counter: "edi" } as const;

export function picOutcome(cm: CodeModel, out: Output, defs: DefsIn, bsymbolic = false): PicOutcome {
  const refs: PicRef[] = (["hits", "counter", "add"] as const).map((symbol) => {
    const objReloc = COMPILED[cm][symbol];
    const fromSo = symbol !== "hits" && defs === "so";
    const preemptible = out === "shared" ? fromSo || !bsymbolic : fromSo;
    const r = symbol === "add" ? "" : reg[symbol];
    const objCode = objReloc === "R_X86_64_PLT32" ? "jmp add" : objReloc === "R_X86_64_PC32" ? `mov ${r}, [rip + ${symbol}]` : `mov rax, [rip + ${symbol}@GOTPCREL]`;
    if (objReloc === "R_X86_64_PLT32") {
      return preemptible
        ? { symbol, objReloc, objCode, preemptible, action: "PLT stub", code: "jmp add@plt", dynReloc: "R_X86_64_JUMP_SLOT" }
        : { symbol, objReloc, objCode, preemptible, action: "direct jump", code: "jmp add" };
    }
    if (objReloc === "R_X86_64_PC32") {
      if (!preemptible) return { symbol, objReloc, objCode, preemptible, action: "direct", code: objCode };
      if (out !== "shared") return { symbol, objReloc, objCode, preemptible, action: "copy relocation", code: `${objCode} (a copy in this file)`, dynReloc: "R_X86_64_COPY" };
      return { symbol, objReloc, objCode, preemptible, action: "error", code: "", error: `relocation R_X86_64_PC32 cannot be used against symbol '${symbol}'; recompile with -fPIC` };
    }
    return preemptible
      ? { symbol, objReloc, objCode, preemptible, action: "GOT slot", code: `mov rax, [rip + GOT slot of ${symbol}]`, dynReloc: "R_X86_64_GLOB_DAT" }
      : { symbol, objReloc, objCode, preemptible, action: "relaxed to lea", code: `lea rax, [rip + ${symbol}]` };
  });
  const errors = refs.filter((r) => r.error).flatMap((r) => Array<string>(REF_COUNT[r.symbol]).fill(r.error!));
  const dynRelocs = errors.length ? [] : refs.filter((r) => r.dynReloc).map((r) => `${r.dynReloc} ${r.symbol}`);
  return { refs, dynRelocs, errors };
}
