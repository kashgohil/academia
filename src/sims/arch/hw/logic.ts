/**
 * Two-level logic minimization for small truth tables (2 to 4 inputs), as the first step of synthesis.
 *
 * - `minimize(n, on, dc)`: the Quine-McCluskey method (Quine 1952, McCluskey 1956). Merge minterms that differ in one
 *   bit until no merge is possible: the survivors are the prime implicants. Then pick a cover: first the essential
 *   primes (the only prime that covers some minterm), then the smallest set of the rest, found by exhaustive search
 *   (Petrick's method gives the same answer; for 4 inputs a search is small). Ties go to fewer literals.
 * - `kmapLayout(n)`: the cell order of a Karnaugh map (Karnaugh 1953): rows and columns in Gray code, so that
 *   neighbouring cells differ in one variable.
 * - `sopCost`: the gate count and depth of the sum of products with 2-input AND and OR gates and inverters.
 *
 * Variables are named A, B, C, D; A is the most significant bit of the minterm index.
 */

export interface Implicant {
  /** The bits that are fixed. */
  value: number;
  /** 1 where the variable is eliminated (a dash in the Quine-McCluskey table). */
  dash: number;
}

export const VARS = ["A", "B", "C", "D"];

export const covers = (p: Implicant, m: number) => (m & ~p.dash) === (p.value & ~p.dash);
export const literals = (p: Implicant, n: number) => n - popcount(p.dash & ((1 << n) - 1));
const popcount = (x: number) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

/** "AB'D" for an implicant; "1" for the implicant that covers everything. */
export function termText(p: Implicant, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    const bit = 1 << (n - 1 - i);
    if (p.dash & bit) continue;
    s += VARS[i]! + (p.value & bit ? "" : "'");
  }
  return s || "1";
}

export interface MinResult {
  primes: Implicant[];
  essential: Implicant[];
  cover: Implicant[];
  /** The minimized sum of products, e.g. "AB + C'D". "0" or "1" for constants. */
  text: string;
}

export function primeImplicants(n: number, on: number[], dc: number[]): Implicant[] {
  let cur = new Map<string, Implicant & { used: boolean }>();
  for (const m of [...on, ...dc]) cur.set(`${m}/0`, { value: m, dash: 0, used: false });
  const primes: Implicant[] = [];
  while (cur.size) {
    const next = new Map<string, Implicant & { used: boolean }>();
    const list = [...cur.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        if (a.dash !== b.dash) continue;
        const diff = (a.value ^ b.value) & ~a.dash;
        if (popcount(diff) !== 1) continue;
        a.used = b.used = true;
        const dash = a.dash | diff, value = a.value & ~dash;
        next.set(`${value}/${dash}`, { value, dash, used: false });
      }
    }
    for (const x of list) if (!x.used) primes.push({ value: x.value & ~x.dash, dash: x.dash });
    cur = next;
  }
  // a prime that covers only don't-cares is never needed
  return primes.filter((p) => on.some((m) => covers(p, m))).sort((a, b) => literals(a, n) - literals(b, n) || a.value - b.value);
}

export function minimize(n: number, on: number[], dc: number[] = []): MinResult {
  if (on.length === 0) return { primes: [], essential: [], cover: [], text: "0" };
  const primes = primeImplicants(n, on, dc);
  const essential: Implicant[] = [];
  for (const m of on) {
    const who = primes.filter((p) => covers(p, m));
    if (who.length === 1 && !essential.includes(who[0]!)) essential.push(who[0]!);
  }
  const left = on.filter((m) => !essential.some((p) => covers(p, m)));
  const rest = primes.filter((p) => !essential.includes(p));
  let best: Implicant[] = [];
  if (left.length) {
    let bestCost = Infinity;
    const k = rest.length;
    for (let s = 1; s < 1 << k; s++) {
      const pick = rest.filter((_, i) => (s >> i) & 1);
      if (!left.every((m) => pick.some((p) => covers(p, m)))) continue;
      const cost = pick.length * 100 + pick.reduce((t, p) => t + literals(p, n), 0);
      if (cost < bestCost) { bestCost = cost; best = pick; }
    }
  }
  const cover = [...essential, ...best].sort((a, b) => b.value - a.value || a.dash - b.dash);
  const text = cover.some((p) => literals(p, n) === 0) ? "1" : cover.map((p) => termText(p, n)).join(" + ");
  return { primes, essential, cover, text };
}

export interface SopCost {
  terms: number;
  literals: number;
  inverters: number;
  /** 2-input AND and OR gates. */
  gates2: number;
  /** Levels of 2-input gates on the longest path, not counting inverters. */
  depth: number;
}

export function sopCost(cover: Implicant[], n: number): SopCost {
  const lits = cover.map((p) => literals(p, n)).filter((l) => l > 0);
  let inv = 0;
  for (let i = 0; i < n; i++) {
    const bit = 1 << (n - 1 - i);
    if (cover.some((p) => !(p.dash & bit) && !(p.value & bit))) inv++;
  }
  const ands = lits.reduce((t, l) => t + Math.max(0, l - 1), 0);
  const ors = Math.max(0, lits.length - 1);
  const log2 = (x: number) => (x <= 1 ? 0 : Math.ceil(Math.log2(x)));
  return { terms: lits.length, literals: lits.reduce((t, l) => t + l, 0), inverters: inv, gates2: ands + ors, depth: Math.max(0, ...lits.map(log2)) + log2(lits.length) };
}

/** The unminimized sum of minterms: one AND per 1 in the table. */
export function canonicalCost(n: number, on: number[]): SopCost {
  return sopCost(on.map((m) => ({ value: m, dash: 0 })), n);
}

const GRAY = (bits: number) => Array.from({ length: 1 << bits }, (_, i) => i ^ (i >> 1));

/** Rows and columns of a K-map: row variables are the high bits. cell[r][c] is the minterm index. */
export function kmapLayout(n: number): { rowVars: number; colVars: number; rows: number[]; cols: number[]; cell: number[][] } {
  const rowVars = Math.floor(n / 2), colVars = n - rowVars;
  const rows = GRAY(rowVars), cols = GRAY(colVars);
  return { rowVars, colVars, rows, cols, cell: rows.map((r) => cols.map((c) => (r << colVars) | c)) };
}
