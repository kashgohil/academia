/**
 * Predicates with SQL three-valued logic.
 *
 * A comparison with a NULL operand is UNKNOWN (`null`), not false. AND, OR and NOT follow the Kleene tables:
 * false AND unknown = false, true OR unknown = true, NOT unknown = unknown. WHERE (selection) keeps a row only
 * if the predicate is TRUE, so rows where it is UNKNOWN disappear.
 */
import { resolve, type Col, type Row, type Value } from "./relation";

export type Truth = boolean | null;
export type CmpOp = "=" | "<>" | "<" | "<=" | ">" | ">=";
export type Operand = { col: string } | { val: Value };
export type Pred =
  | { k: "cmp"; op: CmpOp; l: Operand; r: Operand }
  | { k: "and"; a: Pred; b: Pred }
  | { k: "or"; a: Pred; b: Pred }
  | { k: "not"; a: Pred }
  | { k: "isnull"; x: Operand; neg?: boolean }
  | { k: "true" };

// ------------------------------------------------------------------ builders
export const col = (c: string): Operand => ({ col: c });
export const val = (v: Value): Operand => ({ val: v });
const opnd = (x: string | number | Operand): Operand =>
  typeof x === "object" ? x : typeof x === "number" ? val(x) : x.startsWith("'") ? val(x.slice(1, -1)) : col(x);
/** cmp("salary", ">", 55), cmp("e.did", "=", "d.did"), cmp("city", "=", "'Berlin'") (quotes make a string). */
export const cmp = (l: string | number | Operand, op: CmpOp, r: string | number | Operand): Pred => ({ k: "cmp", op, l: opnd(l), r: opnd(r) });
export const and = (...ps: Pred[]): Pred => ps.reduce((a, b) => ({ k: "and", a, b }));
export const or = (a: Pred, b: Pred): Pred => ({ k: "or", a, b });
export const not = (a: Pred): Pred => ({ k: "not", a });
export const isNull = (c: string, neg = false): Pred => ({ k: "isnull", x: col(c), neg });

// ------------------------------------------------------------------ logic
export const and3 = (a: Truth, b: Truth): Truth => (a === false || b === false ? false : a === null || b === null ? null : true);
export const or3 = (a: Truth, b: Truth): Truth => (a === true || b === true ? true : a === null || b === null ? null : false);
export const not3 = (a: Truth): Truth => (a === null ? null : !a);

export function compare(op: CmpOp, x: Value, y: Value): Truth {
  if (x === null || y === null) return null;
  switch (op) {
    case "=": return x === y;
    case "<>": return x !== y;
    case "<": return x < y;
    case "<=": return x <= y;
    case ">": return x > y;
    case ">=": return x >= y;
  }
}

/** Compiles a predicate against a schema into a fast row function. Column names are resolved once. */
export function compilePred(p: Pred, cols: Col[]): (r: Row) => Truth {
  const get = (o: Operand): ((r: Row) => Value) => {
    if ("val" in o) { const v = o.val; return () => v; }
    const i = resolve(cols, o.col);
    return (r) => r[i]!;
  };
  switch (p.k) {
    case "true": return () => true;
    case "cmp": { const l = get(p.l), r = get(p.r), op = p.op; return (row) => compare(op, l(row), r(row)); }
    case "and": { const a = compilePred(p.a, cols), b = compilePred(p.b, cols); return (r) => and3(a(r), b(r)); }
    case "or": { const a = compilePred(p.a, cols), b = compilePred(p.b, cols); return (r) => or3(a(r), b(r)); }
    case "not": { const a = compilePred(p.a, cols); return (r) => not3(a(r)); }
    case "isnull": { const x = get(p.x), neg = !!p.neg; return (r) => (x(r) === null) !== neg; }
  }
}

/** All column references in a predicate. */
export function predCols(p: Pred): string[] {
  const o = (x: Operand) => ("col" in x ? [x.col] : []);
  switch (p.k) {
    case "true": return [];
    case "cmp": return [...o(p.l), ...o(p.r)];
    case "and": case "or": return [...predCols(p.a), ...predCols(p.b)];
    case "not": return predCols(p.a);
    case "isnull": return o(p.x);
  }
}

/** Splits a conjunction into its conjuncts: a AND (b AND c) -> [a, b, c]. */
export function conjuncts(p: Pred): Pred[] {
  return p.k === "and" ? [...conjuncts(p.a), ...conjuncts(p.b)] : p.k === "true" ? [] : [p];
}
export const conj = (ps: Pred[]): Pred => (ps.length ? and(...ps) : { k: "true" });

const opText = (o: Operand) => ("col" in o ? o.col : o.val === null ? "NULL" : typeof o.val === "string" ? `'${o.val}'` : String(o.val));
const SQL_OP: Record<CmpOp, string> = { "=": "=", "<>": "<>", "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
const ALG_OP: Record<CmpOp, string> = { "=": "=", "<>": "≠", "<": "<", "<=": "≤", ">": ">", ">=": "≥" };

/** Text form. `sql`: AND/OR/NOT and <>; otherwise ∧ ∨ ¬ and ≠. */
export function predText(p: Pred, sql = false, top = true): string {
  const paren = (s: string) => (top ? s : `(${s})`);
  switch (p.k) {
    case "true": return "true";
    case "cmp": return `${opText(p.l)} ${(sql ? SQL_OP : ALG_OP)[p.op]} ${opText(p.r)}`;
    case "and": return paren(`${predText(p.a, sql, p.a.k === "and")} ${sql ? "AND" : "∧"} ${predText(p.b, sql, p.b.k === "and")}`);
    case "or": return paren(`${predText(p.a, sql, false)} ${sql ? "OR" : "∨"} ${predText(p.b, sql, false)}`);
    case "not": return `${sql ? "NOT " : "¬"}${predText(p.a, sql, false)}`;
    case "isnull": return `${opText(p.x)} IS ${p.neg ? "NOT " : ""}NULL`;
  }
}
