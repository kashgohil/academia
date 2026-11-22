/**
 * Linking sims for the Systems track, module "linking".
 *
 * - objfile.ts: a reader for ELF64 relocatable objects that labels every byte (parseObject, fieldAt, relocName).
 * - golden.ts / objects.ts: real objects from clang 22.1.8, parsed (golden, gcInputs).
 * - link.ts: a static linker: symbol resolution, --gc-sections, layout as ld.lld does it, and relocation with the
 *   x86-64 psABI formulas, relaxation and range checks (link, resolveSymbols, gcSections).
 * - resolve.ts: the symbol-resolution cases of two C files (strong, weak, tentative, COMMON, static).
 * - archive.ts: archive member extraction with GNU ld rules and with ld.lld rules (scanArchives).
 * - pic.ts: what the compiler emits for -fno-pic, -fPIE and -fPIC, and what the linker makes of it for each output.
 * - loader.ts: the dynamic loader's lookup scope, interposition, -Bsymbolic, visibility and dlopen.
 * - gnuhash.ts: the GNU hash table (.gnu.hash) that ld.so searches, built as ld.lld builds it.
 * - versions.ts: glibc symbol versions and the "version not found" check.
 */
export * from "./objfile";
export * from "./golden";
export * from "./objects";
export * from "./link";
export * from "./resolve";
export * from "./archive";
export * from "./pic";
export * from "./loader";
export * from "./gnuhash";
export * from "./versions";
