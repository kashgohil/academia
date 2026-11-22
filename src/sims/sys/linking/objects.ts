/** The golden objects, parsed once. See golden.ts for how they were built. */
import { APP_FS_O, APP_O, DISASM, EXTRA_FS_O, EXTRA_O, LIB_O, LIB_PIE_O, MAIN_O, MAIN_PIE_O, UTIL_FS_O, UTIL_O } from "./golden";
import { fromHex, parseObject, type ObjFile } from "./objfile";

const HEX: Record<string, string> = {
  "main.o": MAIN_O, "lib.o": LIB_O, "main-pie.o": MAIN_PIE_O, "lib-pie.o": LIB_PIE_O,
  "app.o": APP_O, "util.o": UTIL_O, "extra.o": EXTRA_O, "app-fs.o": APP_FS_O, "util-fs.o": UTIL_FS_O, "extra-fs.o": EXTRA_FS_O,
};
export type GoldenName = keyof typeof HEX & string;
const cache = new Map<string, ObjFile>();

/** A fresh parse each call would be cheap, but objects are shared read-only, so one parse is enough. */
export function golden(name: string): ObjFile {
  let o = cache.get(name);
  if (!o) {
    const hex = HEX[name];
    if (!hex) throw new Error(`no golden object ${name}`);
    const dis = (DISASM[name] ?? []).map(([offset, size, text]) => ({ offset, size, text }));
    o = parseObject(name, fromHex(hex), dis);
    cache.set(name, o);
  }
  return o;
}

/** The three files of the --gc-sections example, with or without -ffunction-sections -fdata-sections. */
export const gcInputs = (split: boolean) => (split ? ["app-fs.o", "util-fs.o", "extra-fs.o"] : ["app.o", "util.o", "extra.o"]).map(golden);
