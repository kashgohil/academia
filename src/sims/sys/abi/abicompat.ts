/**
 * ABI compatibility of a public C struct: one header change, checked on the six target ABIs of the memory toolkit,
 * and what happens at run time when an old program meets a new library.
 *
 * The struct of version 1 (a library's public header):
 *
 *   struct cfg {
 *     uint32_t size;      // sizeof the struct the caller knows (the Win32 cbSize pattern)
 *     int flags;
 *     long count;
 *     double scale;
 *     const char *name;
 *   };
 *
 * A change is ABI-compatible on a target when every field of version 1 keeps its offset and size, and the struct keeps
 * its size and alignment. A change that only appends fields keeps the old offsets but grows the size: it breaks any
 * caller that allocates or copies the struct (sizeof is compiled into the caller), and it is safe when only the library
 * allocates it, or when the caller passes its size. Every number comes from layoutC (src/sims/sys/mem), which is
 * checked against zig cc for each target.
 */
import { array, layoutC, ptr, struct, T, TARGET_IDS, TARGETS, Machine, type Layout, type Ptr, type Snapshot, type TargetId, type Type, type UbReport } from "../mem";

const named = (t: Type, label: string): Type => ({ ...t, label }) as Type;
const u32 = named(T.u32, "uint32_t");
const i64 = named(T.i64, "int64_t");
const cstr = named(ptr(T.char), "const char *");

export type FieldSpec = [string, Type];

export const V1_FIELDS: FieldSpec[] = [["size", u32], ["flags", T.int], ["count", T.long], ["scale", T.double], ["name", cstr]];

export interface Change { id: string; label: string; diff: string; fields: FieldSpec[] }

const replace = (name: string, f: FieldSpec): FieldSpec[] => V1_FIELDS.map((x) => (x[0] === name ? f : x));

export const CHANGES: Change[] = [
  { id: "same", label: "No change", diff: "(nothing)", fields: V1_FIELDS },
  { id: "int64", label: "long → int64_t", diff: "-  long count;\n+  int64_t count;", fields: replace("count", ["count", i64]) },
  { id: "append", label: "Append a field", diff: "   const char *name;\n+  int retries;", fields: [...V1_FIELDS, ["retries", T.int]] },
  { id: "insert", label: "Insert a field", diff: "   int flags;\n+  int retries;\n   long count;", fields: [V1_FIELDS[0]!, V1_FIELDS[1]!, ["retries", T.int], ...V1_FIELDS.slice(2)] },
  { id: "flags-char", label: "int flags → char flags", diff: "-  int flags;\n+  char flags;", fields: replace("flags", ["flags", T.char]) },
  { id: "ldouble", label: "double → long double", diff: "-  double scale;\n+  long double scale;", fields: replace("scale", ["scale", T["long double"]]) },
  { id: "sizet", label: "uint32_t size → size_t size", diff: "-  uint32_t size;\n+  size_t size;", fields: replace("size", ["size", T.size_t]) },
  { id: "swap", label: "Swap count and scale", diff: "-  long count;\n-  double scale;\n+  double scale;\n+  long count;", fields: [V1_FIELDS[0]!, V1_FIELDS[1]!, V1_FIELDS[3]!, V1_FIELDS[2]!, V1_FIELDS[4]!] },
  { id: "rename", label: "Rename flags → options", diff: "-  int flags;\n+  int options;", fields: replace("flags", ["options", T.int]) },
];

export const cfgType = (fields: FieldSpec[]) => struct("cfg", fields);

export type Verdict = "same" | "grows" | "breaks";

export interface TargetDiff {
  target: TargetId;
  v1: Layout;
  v2: Layout;
  verdict: Verdict;
  /** Old fields that moved or changed size: "count: offset 8 → 8, size 8 → 4". */
  moved: string[];
}

/** Compares version 1 and version 2 by position: field i of v1 against field i of v2 (a rename keeps the position). */
export function compareOn(target: TargetId, change: Change): TargetDiff {
  const v1 = layoutC(cfgType(V1_FIELDS), target), v2 = layoutC(cfgType(change.fields), target);
  const moved: string[] = [];
  for (const f of v1.fields) {
    // match an old field to the new field that has its name, or else its declaration index (renames)
    const g = v2.fields.find((x) => x.name === f.name) ?? v2.fields.find((x) => x.decl === f.decl && !v1.fields.some((y) => y.name === x.name));
    if (!g) { moved.push(`${f.name}: removed`); continue; }
    if (g.offset !== f.offset || g.size !== f.size) moved.push(`${f.name}: offset ${f.offset} → ${g.offset}, size ${f.size} → ${g.size}`);
  }
  const verdict: Verdict = moved.length || v2.align !== v1.align ? "breaks" : v2.size !== v1.size ? "grows" : "same";
  return { target, v1, v2, verdict, moved };
}

export const compareAll = (change: Change) => TARGET_IDS.map((t) => compareOn(t, change));

/** The C source of a version of the struct. */
export const cfgSource = (fields: FieldSpec[]) => `struct cfg {\n${fields.map(([n, t]) => `  ${typeText(t)} ${n};`).join("\n")}\n};`;
function typeText(t: Type): string {
  if (t.label) return t.label;
  if (t.k === "scalar") return t.name;
  return "?";
}

// ---------------------------------------------------------------- old program, new library

/**
 * The program was compiled against version 1. The library is version 2: it appended `int retries` (and fills it with
 * 3), or inserted it after flags. The program calls `cfg_defaults(&c)` and then reads `c.scale`.
 *
 *   struct cfg c;               // sizeof(struct cfg) from the v1 header
 *   int budget = 100;           // the next local on the stack
 *   cfg_defaults(&c);           // the v2 library writes every v2 field
 *   use(c.scale);
 *
 * Designs: "public" (the struct as above), "sized" (the program sets c.size = sizeof c first, and the library writes
 * only the fields that fit in that size), "opaque" (the library allocates the struct and the program only holds a
 * pointer: `struct cfg *c = cfg_new(); double s = cfg_scale(c); cfg_free(c);`).
 */
export type Design = "public" | "sized" | "opaque";
export type LibChange = "append" | "insert";

export interface CompatStep { line: number; text: string; snap: Snapshot; ub?: UbReport; appView?: Layout; libView?: Layout; bytes?: { bytes: number[]; init: boolean[] }; read?: string }

export const compatSource = (d: Design): string[] => d === "opaque"
  ? ["struct cfg *c = cfg_new();   /* library allocates */", "int budget = 100;", "double s = cfg_scale(c);     /* accessor */", "cfg_free(c);"]
  : ["struct cfg c;                /* v1 size */", "int budget = 100;", ...(d === "sized" ? ["c.size = sizeof c;"] : []), "cfg_defaults(&c);            /* v2 library */", "double s = c.scale;"];

const V2: Record<LibChange, FieldSpec[]> = {
  append: [...V1_FIELDS, ["retries", T.int]],
  insert: [V1_FIELDS[0]!, V1_FIELDS[1]!, ["retries", T.int], ...V1_FIELDS.slice(2)],
};
const DEFAULTS: Record<string, number> = { flags: 1, count: 10, scale: 1.5, retries: 3 };

export function compatTrace(design: Design, change: LibChange): CompatStep[] {
  const v1T = cfgType(V1_FIELDS), v2T = cfgType(V2[change]);
  const v1 = layoutC(v1T), v2 = layoutC(v2T);
  const m = new Machine();
  const steps: CompatStep[] = [];
  const push = (line: number, text: string, extra: Partial<CompatStep> = {}) => steps.push({ line, text, snap: m.snapshot(), ...extra });
  const ubCount = () => m.ub.length;

  if (design === "opaque") {
    m.call("main", [{ name: "c", type: ptr(v1T) }, { name: "budget", type: T.int }, { name: "s", type: T.double }]);
    push(0, "The program reserves only a pointer. It never needs sizeof(struct cfg).");
    m.call("cfg_new", []);
    const p = m.malloc(v2.size, 16, "struct cfg (v2)");
    for (const f of v2.fields) m.store(offset(p, f.offset), f.type, f.name === "size" ? v2.size : f.name === "name" ? { addr: 0 } : DEFAULTS[f.name] ?? 0);
    m.ret();
    m.set("c", p);
    push(0, `cfg_new() is in the v2 library. It allocates ${v2.size} bytes, the v2 size, and fills every field. The program gets the pointer.`, { libView: v2 });
    m.set("budget", 100);
    push(1, "budget = 100, the next local. Nothing touches it.");
    m.call("cfg_scale", [{ name: "c", type: ptr(v2T), value: p }]);
    const s = m.load(offset(p, v2.fields.find((f) => f.name === "scale")!.offset), T.double) as number;
    m.ret();
    m.set("s", s);
    push(2, `cfg_scale() is library code, so it uses the v2 offsets. It returns ${s}: correct.`, { read: String(s) });
    m.free(p);
    push(3, "cfg_free() frees the block with the allocator that made it. The program never frees library memory itself.");
    m.exit();
    push(3, "No leak, no overflow. The price: a call for each field, and a heap allocation for each object.");
    return steps;
  }

  m.call("main", [{ name: "c", type: v1T }, { name: "budget", type: T.int }, { name: "s", type: T.double }]);
  const c = m.addrOf("c");
  push(0, `The program was built with the v1 header, so c is ${v1.size} bytes on its stack.`, { appView: v1, bytes: m.peek(c.addr, v1.size) });
  m.set("budget", 100);
  push(1, "budget = 100: another local, next to c.", { appView: v1, bytes: m.peek(c.addr, v1.size) });
  let line = 2;
  if (design === "sized") {
    m.store(c, u32, v1.size);
    push(line++, `The program writes c.size = ${v1.size}. That is the size it knows.`, { appView: v1, bytes: m.peek(c.addr, v1.size) });
  }
  m.call("cfg_defaults", [{ name: "c", type: ptr(v2T), value: c }]);
  const before = ubCount();
  const limit = design === "sized" ? (m.load(c, u32) as number) : Infinity;
  const skipped: string[] = [];
  for (const f of v2.fields) {
    if (f.name === "size" && design === "sized") continue;
    if (f.offset + f.size > limit) { skipped.push(f.name); continue; }
    const v = f.name === "size" ? v2.size : f.name === "name" ? { addr: 0 } : DEFAULTS[f.name] ?? 0;
    m.store(offset(c, f.offset), f.type, v);
  }
  m.ret();
  const ub = m.ub[before];
  const text = design === "sized"
    ? `The v2 library reads c.size = ${v1.size}. It writes only the fields that end within ${v1.size} bytes${skipped.length ? `, and skips ${skipped.join(", ")}` : ""}.${change === "insert" ? " But it still uses the v2 offsets for the fields it writes, so they land in the wrong places." : ""}`
    : ub
      ? `The v2 library writes all ${v2.size} bytes of a v2 struct into a ${v1.size}-byte object. The write of ${v2.fields.find((f) => ub.addr - c.addr >= f.offset && ub.addr - c.addr < f.offset + f.size)?.name ?? "a field"} goes past the end of c, into budget.`
      : `The v2 library writes every v2 field at its v2 offset.`;
  push(line++, text, { ub, libView: v2, appView: v1, bytes: m.peek(c.addr, v1.size) });
  const s = m.load(m.field(c, v1T, "scale"), T.double);
  m.set("s", s as number);
  const sText = typeof s === "number" ? (Number.isInteger(s) ? String(s) : String(+s.toPrecision(6))) : String(s);
  const ok = s === DEFAULTS.scale;
  const budget = m.get("budget") as number;
  push(line, ok
    ? `The program reads c.scale at its v1 offset and gets ${sText}: correct.${design === "public" && change === "append" ? ` But budget is now ${budget}, not 100. A sanitizer reports the overflow; a release build silently runs on.` : ""}`
    : `The program reads c.scale at its v1 offset ${v1.fields.find((f) => f.name === "scale")!.offset}, but the library wrote scale at ${v2.fields.find((f) => f.name === "scale")!.offset}. It gets ${sText}, not 1.5. No crash: a wrong value.${budget !== 100 ? ` And budget is now ${budget}.` : ""}`,
  { appView: v1, libView: v2, bytes: m.peek(c.addr, v1.size), read: sText });
  return steps;
}

const offset = (p: Ptr, n: number): Ptr => ({ addr: p.addr + n, alloc: p.alloc });
void array;
export const TARGET_NAMES = Object.fromEntries(TARGET_IDS.map((t) => [t, TARGETS[t].name])) as Record<TargetId, string>;
