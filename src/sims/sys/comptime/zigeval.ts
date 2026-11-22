/**
 * A model of Zig comptime: a tiny partial evaluator for a Zig-like subset.
 *
 * It runs the parts of a function that are known at compile time, counts backward branches against the
 * eval branch quota, and emits "residual" code for the parts that depend on runtime values. It is a teaching
 * model, not Zig's Sema: real Zig emits the runtime code as AIR and leaves the folding of runtime values
 * (1 * x becomes x, dead multiplies go away) to LLVM. The model folds those as it goes, and marks dead lines.
 *
 * What is measured with zig 0.17.1 (pinned in tests/unit/sys-comptime.test.ts):
 * - the default quota is 1000 (`DEFAULT_QUOTA`);
 * - each iteration of an `inline for`, an `inline while` or a comptime `while` counts one branch, and each
 *   function call at comptime counts one branch. So `inline for (0..1000)` compiles and `0..1001` does not;
 *   `comptime sumTo(999)` compiles and `sumTo(1000)` does not (1 call + 1000 iterations).
 */

export const DEFAULT_QUOTA = 1000;

export type Op = "+" | "-" | "*" | "&" | ">>" | "==" | ">" | "<";
export type Ex = { k: "num"; v: number } | { k: "var"; name: string } | { k: "bin"; op: Op; a: Ex; b: Ex };
export type St =
  | { k: "decl"; name: string; comptime: boolean; init: Ex; line: number }
  | { k: "set"; name: string; e: Ex; line: number }
  | { k: "inlineFor"; n: Ex; body: St[]; line: number }
  | { k: "loop"; inline: boolean; cond: Ex; cont?: St; body: St[]; line: number }
  | { k: "if"; cond: Ex; then: St[]; line: number }
  | { k: "ret"; e: Ex; line: number };

export interface ZParam { name: string; type: string; comptime: boolean }
export interface ZFn {
  id: "power" | "powsq" | "sumto";
  name: string;
  /** Source lines, as shown. */
  lines: string[];
  params: ZParam[];
  ret: string;
  body: St[];
  /** The whole call runs at compile time (`comptime f(n)`), so every variable is comptime. */
  callAtComptime: boolean;
  /** The line of the call site, shown under the function. */
  callLine: (n: number) => string;
}

const num = (v: number): Ex => ({ k: "num", v });
const v = (name: string): Ex => ({ k: "var", name });
const bin = (op: Op, a: Ex, b: Ex): Ex => ({ k: "bin", op, a, b });

export const ZIG_FNS: ZFn[] = [
  {
    id: "power", name: "power", ret: "i64", callAtComptime: false,
    params: [{ name: "x", type: "i64", comptime: false }, { name: "n", type: "u32", comptime: true }],
    lines: [
      "fn power(x: i64, comptime n: u32) i64 {",
      "    var r: i64 = 1;",
      "    inline for (0..n) |_| {",
      "        r = r * x;",
      "    }",
      "    return r;",
      "}",
    ],
    body: [
      { k: "decl", name: "r", comptime: false, init: num(1), line: 1 },
      { k: "inlineFor", n: v("n"), line: 2, body: [{ k: "set", name: "r", e: bin("*", v("r"), v("x")), line: 3 }] },
      { k: "ret", e: v("r"), line: 5 },
    ],
    callLine: (n) => `const y = power(x, ${n});`,
  },
  {
    id: "powsq", name: "powSq", ret: "i64", callAtComptime: false,
    params: [{ name: "x", type: "i64", comptime: false }, { name: "n", type: "u32", comptime: true }],
    lines: [
      "fn powSq(x: i64, comptime n: u32) i64 {",
      "    comptime var e = n;",
      "    var base = x;",
      "    var r: i64 = 1;",
      "    inline while (e > 0) : (e >>= 1) {",
      "        if (e & 1 == 1) r = r * base;",
      "        base = base * base;",
      "    }",
      "    return r;",
      "}",
    ],
    body: [
      { k: "decl", name: "e", comptime: true, init: v("n"), line: 1 },
      { k: "decl", name: "base", comptime: false, init: v("x"), line: 2 },
      { k: "decl", name: "r", comptime: false, init: num(1), line: 3 },
      {
        k: "loop", inline: true, cond: bin(">", v("e"), num(0)), line: 4,
        cont: { k: "set", name: "e", e: bin(">>", v("e"), num(1)), line: 4 },
        body: [
          { k: "if", cond: bin("==", bin("&", v("e"), num(1)), num(1)), line: 5, then: [{ k: "set", name: "r", e: bin("*", v("r"), v("base")), line: 5 }] },
          { k: "set", name: "base", e: bin("*", v("base"), v("base")), line: 6 },
        ],
      },
      { k: "ret", e: v("r"), line: 8 },
    ],
    callLine: (n) => `const y = powSq(x, ${n});`,
  },
  {
    id: "sumto", name: "sumTo", ret: "u64", callAtComptime: true,
    params: [{ name: "n", type: "u32", comptime: true }],
    lines: [
      "fn sumTo(n: u32) u64 {",
      "    var s: u64 = 0;",
      "    var i: u32 = 0;",
      "    while (i < n) : (i += 1) s += i;",
      "    return s;",
      "}",
    ],
    body: [
      { k: "decl", name: "s", comptime: true, init: num(0), line: 1 },
      { k: "decl", name: "i", comptime: true, init: num(0), line: 2 },
      {
        k: "loop", inline: false, cond: bin("<", v("i"), v("n")), line: 3,
        cont: { k: "set", name: "i", e: bin("+", v("i"), num(1)), line: 3 },
        body: [{ k: "set", name: "s", e: bin("+", v("s"), v("i")), line: 3 }],
      },
      { k: "ret", e: v("s"), line: 4 },
    ],
    callLine: (n) => `const total = comptime sumTo(${n});`,
  },
];

export const zigFn = (id: ZFn["id"]) => ZIG_FNS.find((f) => f.id === id)!;

/** A value during partial evaluation: known at compile time, or a runtime expression. */
type Val = { c: true; v: number } | { c: false; s: string; atom: boolean };

export interface ResidualLine { text: string; name?: string; uses: string[]; dead: boolean }
export interface TraceEvent {
  /** Line in `ZFn.lines`, or -1 for the call site. */
  line: number;
  text: string;
  branches: number;
  /** Comptime-known variables after this event. */
  known: [string, number][];
  /** Residual lines emitted so far. */
  emitted: number;
}
export interface SpecializeResult {
  ok: boolean;
  /** Zig's compile error text (the model reproduces the messages of zig 0.17.1). */
  error?: string;
  errorNote?: string;
  branches: number;
  quota: number;
  trace: TraceEvent[];
  residual: ResidualLine[];
  /** The residual function header, or the residual constant for a comptime call. */
  header: string;
  /** Multiplications left in live residual code. */
  liveMuls: number;
  /** The value of the comptime call, if the whole call runs at compile time. */
  value?: number;
}

class QuotaError extends Error {}

/**
 * Specializes `fn` for comptime argument n.
 * nKnown = false models a call that passes a runtime n to a comptime parameter.
 */
export function specialize(fn: ZFn, n: number, { quota = DEFAULT_QUOTA, nKnown = true }: { quota?: number; nKnown?: boolean } = {}): SpecializeResult {
  const trace: TraceEvent[] = [];
  const residual: ResidualLine[] = [];
  const env = new Map<string, Val>();
  const counters = new Map<string, number>();
  let branches = 0;
  const known = (): [string, number][] => [...env].filter(([, x]) => x.c).map(([k, x]) => [k, (x as { v: number }).v]);
  const ev = (line: number, text: string) => trace.push({ line, text, branches, known: known(), emitted: residual.length });

  const header = fn.callAtComptime
    ? `const total: ${fn.ret} = `
    : `fn ${fn.name}(${fn.params.filter((p) => !p.comptime).map((p) => `${p.name}: ${p.type}`).join(", ")}) ${fn.ret}`;

  const base = { quota, trace, residual, liveMuls: 0, header };
  if (!nKnown) {
    ev(-1, "The call passes a runtime value to a comptime parameter.");
    return { ...base, ok: false, branches: 0, error: "unable to resolve comptime value", errorNote: "argument to comptime parameter must be comptime-known" };
  }
  if (fn.callAtComptime) { branches = 1; ev(-1, `Call ${fn.name}(${n}) at compile time: 1 branch for the call.`); }
  for (const p of fn.params) env.set(p.name, p.comptime ? { c: true, v: n } : { c: false, s: p.name, atom: true });
  if (!fn.callAtComptime) ev(0, `New instance for n = ${n}. The parameter n is now a comptime constant.`);

  const branch = (line: number) => {
    branches++;
    if (branches > quota) throw new QuotaError(String(line));
  };
  const show = (x: Val) => (x.c ? String(x.v) : x.atom ? x.s : `(${x.s})`);
  const evalEx = (e: Ex): Val => {
    if (e.k === "num") return { c: true, v: e.v };
    if (e.k === "var") return env.get(e.name)!;
    const a = evalEx(e.a), b = evalEx(e.b);
    if (a.c && b.c) return { c: true, v: apply(e.op, a.v, b.v) };
    if (e.op === "*" && a.c && a.v === 1) return b;
    if (e.op === "*" && b.c && b.v === 1) return a;
    if (e.op === "+" && a.c && a.v === 0) return b;
    if (e.op === "+" && b.c && b.v === 0) return a;
    return { c: false, s: `${show(a)} ${e.op} ${show(b)}`, atom: false };
  };
  const fresh = (name: string) => {
    const k = (counters.get(name) ?? 0) + 1;
    counters.set(name, k);
    return `${name}${k}`;
  };
  const assign = (name: string, val: Val, comptime: boolean, line: number, verb: string) => {
    if (val.c) {
      env.set(name, val);
      ev(line, `${verb} ${name} = ${val.v}. ${comptime ? "Comptime variable: no code." : "The value is known, so the model emits no code yet."}`);
    } else if (val.atom) {
      env.set(name, val);
      ev(line, `${verb} ${name} = ${val.s}. A copy: no code, ${name} is another name for ${val.s}.`);
    } else {
      const t = fresh(name);
      residual.push({ text: `const ${t} = ${val.s};`, name: t, uses: names(val.s), dead: false });
      env.set(name, { c: false, s: t, atom: true });
      ev(line, `${verb} ${name}: runtime value. Emit const ${t} = ${val.s};`);
    }
  };
  const run = (body: St[]): Val | null => {
    for (const s of body) {
      switch (s.k) {
        case "decl": assign(s.name, evalEx(s.init), s.comptime, s.line, s.comptime ? "comptime var" : "var"); break;
        case "set": assign(s.name, evalEx(s.e), env.get(s.name)!.c && fn.callAtComptime, s.line, "Set"); break;
        case "inlineFor": {
          const cnt = evalEx(s.n) as { v: number };
          for (let i = 0; i < cnt.v; i++) {
            branch(s.line);
            ev(s.line, `inline for: copy the body for iteration ${i} (branch ${branches} of ${quota}).`);
            const r = run(s.body);
            if (r) return r;
          }
          ev(s.line, `inline for: done after ${cnt.v} copies of the body.`);
          break;
        }
        case "loop": {
          for (;;) {
            const c = evalEx(s.cond) as { v: number };
            if (!c.v) { ev(s.line, `${s.inline ? "inline while" : "while"}: the condition is false. Leave the loop.`); break; }
            const r = run(s.body);
            if (r) return r;
            if (s.cont) run([s.cont]);
            branch(s.line);
            ev(s.line, `Back to the top of the loop: branch ${branches} of ${quota}.`);
          }
          break;
        }
        case "if": {
          const c = evalEx(s.cond) as { v: number };
          ev(s.line, `Comptime if: the condition is ${c.v ? "true" : "false"}.${c.v ? "" : " Skip the body: no code."}`);
          if (c.v) { const r = run(s.then); if (r) return r; }
          break;
        }
        case "ret": return evalEx(s.e);
      }
    }
    return null;
  };

  let out: Val | null;
  try {
    out = run(fn.body);
  } catch (e) {
    if (!(e instanceof QuotaError)) throw e;
    ev(Number(e.message), `Branch ${branches} is more than the quota of ${quota}. Stop.`);
    return { ...base, ok: false, branches, error: `evaluation exceeded ${quota} backwards branches`, errorNote: `use @setEvalBranchQuota() to raise the branch limit from ${quota}` };
  }
  const r = out!;
  const retText = fn.callAtComptime ? `${show(r)};` : `return ${show(r)};`;
  // Liveness over the straight-line residual code, from the return value backward.
  const live = new Set(r.c ? [] : names(r.s));
  for (let i = residual.length - 1; i >= 0; i--) {
    const l = residual[i]!;
    l.dead = !live.has(l.name!);
    if (!l.dead) l.uses.forEach((u) => live.add(u));
  }
  residual.push({ text: retText, uses: [], dead: false });
  ev(fn.callAtComptime ? 4 : fn.lines.length - 2, fn.callAtComptime ? `Return ${show(r)}. Only this constant goes into the binary.` : `Return ${show(r)}. The instance is complete.`);
  const liveMuls = residual.filter((l) => !l.dead).reduce((a, l) => a + (l.text.match(/\*/g)?.length ?? 0), 0);
  return { ...base, ok: true, branches, residual, liveMuls, value: r.c ? r.v : undefined };
}

function apply(op: Op, a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "&": return a & b;
    case ">>": return a >> b;
    case "==": return a === b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
  }
}
const names = (s: string) => s.match(/[A-Za-z_]\w*/g) ?? [];

/** The largest n that fits the quota, found by running the model. */
export function largestN(fn: ZFn, quota = DEFAULT_QUOTA, hi = 5000): number {
  let lo = 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (specialize(fn, mid, { quota }).ok) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Instances that Zig creates for a list of calls. Calls with the same comptime arguments share one instance,
 * because Zig memoizes them. zig 0.17.1 names them `power__func_0`, `power__func_1`, ... in a Debug build.
 */
export function instancesFor(ns: number[]): { n: number; calls: number }[] {
  const m = new Map<number, number>();
  for (const n of ns) m.set(n, (m.get(n) ?? 0) + 1);
  return [...m].map(([n, calls]) => ({ n, calls }));
}
