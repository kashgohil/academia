/**
 * A model of the comptime format check in Zig's `std.Io.Writer.print` (zig 0.17.1, lib/std/Io/Writer.zig).
 *
 * `print` takes `comptime fmt: []const u8` and an args tuple. An `inline while` walks the format string at
 * compile time. It emits one `writeAll` for each literal run and one `printValue` for each placeholder, and it
 * calls `@compileError` when the string and the arguments do not match. This file ports that walk for the
 * subset `{}`, `{spec}`, `{[N]spec}`, `{{` and `}}`. Width, fill and precision options (after ':') are outside
 * the model.
 *
 * `SPEC_TABLE` holds what zig 0.17.1 does for each specifier and each argument type, measured by compiling
 * `std.debug.print("{<spec>}", .{v})` for each pair: the printed text, or the compile error.
 */

export type ZType = "u32" | "f64" | "bool" | "[]const u8";
export interface ZArg { name: string; type: ZType; value: string }

/** The arguments the demo passes, in order. */
export const FMT_ARGS: ZArg[] = [
  { name: "count", type: "u32", value: "42" },
  { name: "name", type: "[]const u8", value: '"zig"' },
  { name: "ratio", type: "f64", value: "2.5" },
  { name: "ok", type: "bool", value: "true" },
];

type Cell = { out: string } | { err: string };
const bad = (s: string, t: ZType): Cell => ({ err: `invalid format string '${s}' for type '${t}'` });
const row = (s: string, cells: Partial<Record<ZType, string>>): Record<ZType, Cell> => {
  const types: ZType[] = ["u32", "f64", "bool", "[]const u8"];
  return Object.fromEntries(types.map((t) => [t, cells[t] !== undefined ? { out: cells[t]! } : bad(s, t)])) as Record<ZType, Cell>;
};

/** Measured with zig 0.17.1 for count = 42, ratio = 2.5, ok = true, name = "zig". */
export const SPEC_TABLE: Record<string, Record<ZType, Cell>> = {
  "": { ...row("", { u32: "42", f64: "2.5", bool: "true" }), "[]const u8": { err: "cannot format slice without a specifier (i.e. {s}, {x}, {b64}, or {any})" } },
  d: row("d", { u32: "42", f64: "2.5" }),
  x: row("x", { u32: "2a", f64: "0x1.4p1", "[]const u8": "7a6967" }),
  X: row("X", { u32: "2A", f64: "0x1.4p1", "[]const u8": "7A6967" }),
  b: row("b", { u32: "101010" }),
  o: row("o", { u32: "52" }),
  e: row("e", { f64: "2.5e0" }),
  s: row("s", { "[]const u8": "zig" }),
  q: row("q", { "[]const u8": '"zig"' }),
  any: row("any", { u32: "42", f64: "2.5", bool: "true", "[]const u8": "{ 122, 105, 103 }" }),
};

export type FmtPiece =
  | { kind: "lit"; text: string; from: number; to: number }
  | { kind: "arg"; spec: string; index: number; out: string; from: number; to: number };

export interface FmtResult {
  pieces: FmtPiece[];
  /** The compile error, as zig 0.17.1 prints it, or a note that the model does not cover the input. */
  error?: string;
  /** True when the input is outside the model (not a Zig error). */
  outside?: boolean;
  /** Where the error is, as a range in the format string. */
  at?: [number, number];
  /** What the program prints, when it compiles. */
  output?: string;
  /** The quota that print sets: @setEvalBranchQuota(fmt.len * 1000). */
  quota: number;
  /** Arguments that no placeholder used. */
  unused: number[];
}

/** Runs the comptime walk of `print` over `fmt` with the first `argc` arguments of FMT_ARGS. */
export function checkFormat(fmt: string, argc: number): FmtResult {
  const args = FMT_ARGS.slice(0, argc);
  const pieces: FmtPiece[] = [];
  const quota = fmt.length * 1000;
  let used = 0;
  let next = 0;
  let i = 0;
  let lit = "";
  let litFrom = 0;
  const fail = (error: string, at: [number, number], outside = false): FmtResult => ({ pieces, error, at, outside, quota, unused: [] });
  const flush = (to: number) => {
    if (lit) pieces.push({ kind: "lit", text: lit, from: litFrom, to });
    lit = "";
  };
  for (;;) {
    const start = i;
    while (i < fmt.length && fmt[i] !== "{" && fmt[i] !== "}") i++;
    let end = i;
    let unescape = false;
    if (i + 1 < fmt.length && fmt[i + 1] === fmt[i]) {
      unescape = true;
      end += 1;
      i += 2;
    }
    if (!lit) litFrom = start;
    lit += fmt.slice(start, end);
    if (unescape) continue;
    flush(end);
    if (i >= fmt.length) break;
    if (fmt[i] === "}") return fail("missing opening {", [i, i + 1]);
    const open = i;
    i++;
    const begin = i;
    while (i < fmt.length && fmt[i] !== "}") i++;
    if (i >= fmt.length) return fail("missing closing }", [open, fmt.length]);
    const body = fmt.slice(begin, i);
    i++;
    let pos: number | null = null;
    let spec = body;
    const m = /^\[(\d+)\](.*)$/.exec(body);
    if (m) { pos = Number(m[1]); spec = m[2]!; }
    if (spec.includes(":") || spec.includes("[")) return fail("This model does not cover width, fill or named arguments.", [open, i], true);
    const index = pos ?? next++;
    if (index >= args.length) return fail("too few arguments", [open, i]);
    used |= 1 << index;
    const arg = args[index]!;
    const cell = SPEC_TABLE[spec]?.[arg.type];
    if (!cell) return fail(`The model does not know the specifier '${spec}'.`, [open, i], true);
    if ("err" in cell) return fail(cell.err, [open, i]);
    pieces.push({ kind: "arg", spec, index, out: cell.out, from: open, to: i });
  }
  const unused = args.map((_, k) => k).filter((k) => !(used & (1 << k)));
  if (unused.length === 1) return { pieces, quota, unused, error: `unused argument in '${fmt}'`, at: [0, fmt.length] };
  if (unused.length > 1) return { pieces, quota, unused, error: `${unused.length} unused arguments in '${fmt}'`, at: [0, fmt.length] };
  const output = pieces.map((p) => (p.kind === "lit" ? p.text : p.out)).join("");
  return { pieces, quota, unused, output };
}

/** The code that the comptime walk leaves for runtime, one call per piece. */
export function emittedCalls(r: FmtResult): string[] {
  return r.pieces.map((p) => (p.kind === "lit" ? `try w.writeAll(${JSON.stringify(p.text)});` : `try w.printValue("${p.spec}", args.@"${p.index}");`));
}
