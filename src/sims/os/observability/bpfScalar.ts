/**
 * What the eBPF verifier knows about a number: unsigned bounds, signed bounds and a tristate number.
 * The arithmetic follows kernel/bpf/tnum.c and the scalar_min_max_* functions of kernel/bpf/verifier.c.
 * Each result must contain every concrete result. tests/unit/os-observability-bpf.test.ts checks this at random.
 */

export const U64_MAX = (1n << 64n) - 1n;
export const U32_MAX = (1n << 32n) - 1n;
export const S64_MIN = -(1n << 63n);
export const S64_MAX = (1n << 63n) - 1n;
export const S32_MAX = (1n << 31n) - 1n;
const SIGN = 1n << 63n;

export const u64 = (x: bigint) => BigInt.asUintN(64, x);
export const s64 = (x: bigint) => BigInt.asIntN(64, x);
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);

// ---------------------------------------------------------------------------- tnum

/** A tristate number. A bit in `m` is unknown. Other bits have the value in `v`. Invariant: v & m = 0. */
export interface Tnum { v: bigint; m: bigint }

export const tnumConst = (x: bigint): Tnum => ({ v: u64(x), m: 0n });
export const tnumUnknown: Tnum = { v: 0n, m: U64_MAX };
export const tnumIsConst = (t: Tnum) => t.m === 0n;
export const tnumContains = (t: Tnum, x: bigint) => (u64(x) & ~t.m & U64_MAX) === t.v;

export function tnumAdd(a: Tnum, b: Tnum): Tnum {
  const sm = u64(a.m + b.m), sv = u64(a.v + b.v), sigma = u64(sm + sv);
  const chi = sigma ^ sv, mu = chi | a.m | b.m;
  return { v: sv & ~mu & U64_MAX, m: mu };
}
export function tnumSub(a: Tnum, b: Tnum): Tnum {
  const dv = u64(a.v - b.v), alpha = u64(dv + a.m), beta = u64(dv - b.m);
  const chi = alpha ^ beta, mu = chi | a.m | b.m;
  return { v: dv & ~mu & U64_MAX, m: mu };
}
export function tnumAnd(a: Tnum, b: Tnum): Tnum {
  const alpha = a.v | a.m, beta = b.v | b.m, v = a.v & b.v;
  return { v, m: alpha & beta & ~v & U64_MAX };
}
export function tnumOr(a: Tnum, b: Tnum): Tnum {
  const v = a.v | b.v, mu = a.m | b.m;
  return { v, m: mu & ~v & U64_MAX };
}
export function tnumXor(a: Tnum, b: Tnum): Tnum {
  const v = a.v ^ b.v, mu = a.m | b.m;
  return { v: v & ~mu & U64_MAX, m: mu };
}
export const tnumLsh = (a: Tnum, s: bigint): Tnum => ({ v: u64(a.v << s), m: u64(a.m << s) });
export const tnumRsh = (a: Tnum, s: bigint): Tnum => ({ v: a.v >> s, m: a.m >> s });
export const tnumArsh = (a: Tnum, s: bigint): Tnum => ({ v: u64(s64(a.v) >> s), m: u64(s64(a.m) >> s) });

export function tnumMul(a0: Tnum, b0: Tnum): Tnum {
  let a = a0, b = b0;
  const accV = u64(a.v * b.v);
  let accM: Tnum = { v: 0n, m: 0n };
  while (a.v !== 0n || a.m !== 0n) {
    if ((a.v & 1n) === 1n) accM = tnumAdd(accM, { v: 0n, m: b.m });
    else if ((a.m & 1n) === 1n) accM = tnumAdd(accM, { v: 0n, m: b.v | b.m });
    a = tnumRsh(a, 1n);
    b = tnumLsh(b, 1n);
  }
  return tnumAdd({ v: accV, m: 0n }, accM);
}

/** The smallest tnum that holds the range [min, max]. */
export function tnumRange(min: bigint, max: bigint): Tnum {
  const chi = min ^ max;
  let bits = 0n;
  for (let c = chi; c > 0n; c >>= 1n) bits++;
  if (bits > 63n) return tnumUnknown;
  const delta = (1n << bits) - 1n;
  return { v: min & ~delta & U64_MAX, m: delta };
}

/** null when the two tnums disagree on a known bit: no number satisfies both. */
export function tnumIntersect(a: Tnum, b: Tnum): Tnum | null {
  if (((a.v ^ b.v) & ~(a.m | b.m) & U64_MAX) !== 0n) return null;
  const mu = a.m & b.m;
  return { v: (a.v | b.v) & ~mu & U64_MAX, m: mu };
}

/** True when each number in `inner` is also in `outer`. */
export const tnumIn = (outer: Tnum, inner: Tnum) => (inner.m & ~outer.m & U64_MAX) === 0n && (inner.v & ~outer.m & U64_MAX) === outer.v;

// ---------------------------------------------------------------------------- scalar bounds

export interface Scalar { umin: bigint; umax: bigint; smin: bigint; smax: bigint; t: Tnum }

export const scalarConst = (x: bigint): Scalar => {
  const u = u64(x), s = s64(x);
  return { umin: u, umax: u, smin: s, smax: s, t: { v: u, m: 0n } };
};
export const scalarUnknown = (): Scalar => ({ umin: 0n, umax: U64_MAX, smin: S64_MIN, smax: S64_MAX, t: tnumUnknown });
/** A zero-extended load or a 32-bit result of `bits` bits. */
export const scalarBits = (bits: number): Scalar => {
  const mask = (1n << BigInt(bits)) - 1n;
  return bits === 64 ? scalarUnknown() : { umin: 0n, umax: mask, smin: 0n, smax: mask, t: { v: 0n, m: mask } };
};
export const scalarIsConst = (s: Scalar) => tnumIsConst(s.t);
export const scalarContains = (s: Scalar, x: bigint) => {
  const u = u64(x), i = s64(x);
  return u >= s.umin && u <= s.umax && i >= s.smin && i <= s.smax && tnumContains(s.t, u);
};
/** True when each number in `inner` is also in `outer`. */
export const scalarIn = (outer: Scalar, inner: Scalar) =>
  inner.umin >= outer.umin && inner.umax <= outer.umax && inner.smin >= outer.smin && inner.smax <= outer.smax && tnumIn(outer.t, inner.t);
export const scalarEq = (a: Scalar, b: Scalar) =>
  a.umin === b.umin && a.umax === b.umax && a.smin === b.smin && a.smax === b.smax && a.t.v === b.t.v && a.t.m === b.t.m;

/**
 * Each view of the number narrows the others (reg_bounds_sync in the kernel).
 * It returns null when the views have no number in common, so that this path cannot happen.
 */
export function syncBounds(s0: Scalar): Scalar | null {
  let { umin, umax, smin, smax, t } = s0;
  for (let i = 0; i < 3; i++) {
    umin = maxB(umin, t.v);
    umax = minB(umax, t.v | t.m);
    smin = maxB(smin, s64(t.v | (t.m & SIGN)));
    smax = minB(smax, s64(t.v | (t.m & ~SIGN & U64_MAX)));
    if (s64(umin) <= s64(umax)) {
      smin = maxB(smin, s64(umin));
      smax = minB(smax, s64(umax));
    }
    if (u64(smin) <= u64(smax)) {
      umin = maxB(umin, u64(smin));
      umax = minB(umax, u64(smax));
    }
    if (umin > umax || smin > smax) return null;
    const nt = tnumIntersect(t, tnumRange(umin, umax));
    if (!nt) return null;
    t = nt;
  }
  if (umin > umax || smin > smax) return null;
  return { umin, umax, smin, smax, t };
}

/** Use after arithmetic: the input can be a set with no member, on a path that cannot run. */
const synced = (s: Scalar, fallback: () => Scalar = scalarUnknown): Scalar => syncBounds(s) ?? fallback();

/** Keep the low 32 bits and zero-extend. */
export function trunc32(a: Scalar): Scalar {
  if (a.umax <= U32_MAX) return a;
  const t = { v: a.t.v & U32_MAX, m: a.t.m & U32_MAX };
  return synced({ umin: t.v, umax: t.v | t.m, smin: t.v, smax: t.v | t.m, t }, () => scalarBits(32));
}

// ---------------------------------------------------------------------------- arithmetic

export type AluName = "add" | "sub" | "mul" | "div" | "or" | "and" | "lsh" | "rsh" | "neg" | "mod" | "xor" | "arsh";

/** The exact result of one ALU instruction, with the BPF rules: x / 0 = 0, x % 0 = x, and the shift amount is masked. */
export function aluEval(op: AluName, dst: bigint, src: bigint, is32: boolean): bigint {
  const a = is32 ? dst & U32_MAX : dst;
  const b = is32 ? src & U32_MAX : src;
  const width = is32 ? 32n : 64n;
  const sh = b & (width - 1n);
  let r: bigint;
  switch (op) {
    case "add": r = a + b; break;
    case "sub": r = a - b; break;
    case "mul": r = a * b; break;
    case "div": r = b === 0n ? 0n : a / b; break;
    case "mod": r = b === 0n ? a : a % b; break;
    case "or": r = a | b; break;
    case "and": r = a & b; break;
    case "xor": r = a ^ b; break;
    case "lsh": r = a << sh; break;
    case "rsh": r = a >> sh; break;
    case "neg": r = -a; break;
    case "arsh": r = (is32 ? BigInt.asIntN(32, a) : s64(a)) >> sh; break;
  }
  return is32 ? r & U32_MAX : u64(r);
}

function add(a: Scalar, b: Scalar): Scalar {
  const smin = a.smin + b.smin, smax = a.smax + b.smax;
  const sOk = smin >= S64_MIN && smax <= S64_MAX;
  const uOk = a.umax + b.umax <= U64_MAX;
  return {
    umin: uOk ? a.umin + b.umin : 0n, umax: uOk ? a.umax + b.umax : U64_MAX,
    smin: sOk ? smin : S64_MIN, smax: sOk ? smax : S64_MAX, t: tnumAdd(a.t, b.t),
  };
}
function sub(a: Scalar, b: Scalar): Scalar {
  const smin = a.smin - b.smax, smax = a.smax - b.smin;
  const sOk = smin >= S64_MIN && smax <= S64_MAX;
  const uOk = a.umin >= b.umax;
  return {
    umin: uOk ? a.umin - b.umax : 0n, umax: uOk ? a.umax - b.umin : U64_MAX,
    smin: sOk ? smin : S64_MIN, smax: sOk ? smax : S64_MAX, t: tnumSub(a.t, b.t),
  };
}
function mul(a: Scalar, b: Scalar): Scalar {
  const t = tnumMul(a.t, b.t);
  if (a.umax > U32_MAX || b.umax > U32_MAX) return { ...scalarUnknown(), t };
  const umin = a.umin * b.umin, umax = a.umax * b.umax;
  const sOk = umax <= S64_MAX;
  return { umin, umax, smin: sOk ? umin : S64_MIN, smax: sOk ? umax : S64_MAX, t };
}
function and(a: Scalar, b: Scalar): Scalar {
  const t = tnumAnd(a.t, b.t);
  const umin = t.v, umax = minB(a.umax, b.umax);
  const pos = a.smin >= 0n && b.smin >= 0n;
  return { umin, umax, smin: pos ? umin : S64_MIN, smax: pos ? umax : S64_MAX, t };
}
function or(a: Scalar, b: Scalar): Scalar {
  const t = tnumOr(a.t, b.t);
  const umin = maxB(a.umin, b.umin), umax = t.v | t.m;
  const pos = a.smin >= 0n && b.smin >= 0n;
  return { umin, umax, smin: pos ? umin : S64_MIN, smax: pos ? umax : S64_MAX, t };
}
function xor(a: Scalar, b: Scalar): Scalar {
  const t = tnumXor(a.t, b.t);
  const umin = t.v, umax = t.v | t.m;
  const pos = a.smin >= 0n && b.smin >= 0n;
  return { umin, umax, smin: pos ? umin : S64_MIN, smax: pos ? umax : S64_MAX, t };
}
function lsh(a: Scalar, b: Scalar): Scalar {
  const t = b.umin === b.umax ? tnumLsh(a.t, b.umin) : tnumUnknown;
  if (b.umax > 63n) return { ...scalarUnknown(), t: tnumUnknown };
  const big = a.umax > U64_MAX >> b.umax;
  const umin = big ? 0n : a.umin << b.umin, umax = big ? U64_MAX : a.umax << b.umax;
  return { umin, umax, smin: S64_MIN, smax: S64_MAX, t };
}
function rsh(a: Scalar, b: Scalar): Scalar {
  const t = b.umin === b.umax ? tnumRsh(a.t, b.umin) : tnumUnknown;
  return { umin: a.umin >> b.umax, umax: a.umax >> b.umin, smin: S64_MIN, smax: S64_MAX, t };
}
function arsh(a: Scalar, s: bigint): Scalar {
  return { umin: 0n, umax: U64_MAX, smin: a.smin >> s, smax: a.smax >> s, t: tnumArsh(a.t, s) };
}

/**
 * The bounds of `dst op src`. Like the kernel, it gives up when the amount is not known for some operators.
 * Division and modulo give an unknown result: this is a real gap that rejects correct programs.
 */
export function scalarAlu(op: AluName, a0: Scalar, b0: Scalar, is32: boolean): Scalar {
  const a = is32 ? trunc32(a0) : a0;
  const b = is32 ? trunc32(b0) : b0;
  const giveUp = () => (is32 ? scalarBits(32) : scalarUnknown());
  const width = is32 ? 32n : 64n;
  let r: Scalar;
  switch (op) {
    case "add": r = add(a, b); break;
    case "sub": r = sub(a, b); break;
    case "mul": r = mul(a, b); break;
    case "and": r = and(a, b); break;
    case "or": r = or(a, b); break;
    case "xor": r = xor(a, b); break;
    case "lsh": if (b.umax >= width) return giveUp(); r = lsh(a, b); break;
    case "rsh": if (b.umax >= width) return giveUp(); r = rsh(a, b); break;
    case "arsh":
      if (!scalarIsConst(b) || b.umin >= width) return giveUp();
      if (is32) return scalarIsConst(a) ? scalarConst(aluEval(op, a.umin, b.umin, true)) : giveUp();
      r = arsh(a, b.umin);
      break;
    case "neg": return scalarIsConst(a) ? scalarConst(aluEval("neg", a.umin, 0n, is32)) : giveUp();
    case "div": case "mod": return giveUp();
  }
  const s = synced(r, giveUp);
  return is32 ? trunc32(s) : s;
}

// ---------------------------------------------------------------------------- conditions

export type CmpName = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "sgt" | "sge" | "slt" | "sle" | "set";

export const CMP_NEGATE: Record<Exclude<CmpName, "set">, Exclude<CmpName, "set">> = {
  eq: "ne", ne: "eq", gt: "le", le: "gt", ge: "lt", lt: "ge", sgt: "sle", sle: "sgt", sge: "slt", slt: "sge",
};

export function cmpEval(op: CmpName, a0: bigint, b0: bigint, is32: boolean): boolean {
  const ua = is32 ? a0 & U32_MAX : u64(a0), ub = is32 ? b0 & U32_MAX : u64(b0);
  const sa = is32 ? BigInt.asIntN(32, a0) : s64(a0), sb = is32 ? BigInt.asIntN(32, b0) : s64(b0);
  switch (op) {
    case "eq": return ua === ub;
    case "ne": return ua !== ub;
    case "gt": return ua > ub;
    case "ge": return ua >= ub;
    case "lt": return ua < ub;
    case "le": return ua <= ub;
    case "sgt": return sa > sb;
    case "sge": return sa >= sb;
    case "slt": return sa < sb;
    case "sle": return sa <= sb;
    case "set": return (ua & ub) !== 0n;
  }
}

/** 1 when the condition is always true, 0 when it is always false, and -1 when it can go both ways. */
export function branchKnown(op: CmpName, a: Scalar, b: Scalar): 1 | 0 | -1 {
  const r = (x: boolean | null): 1 | 0 | -1 => (x === null ? -1 : x ? 1 : 0);
  const tnumsDiffer = ((a.t.v ^ b.t.v) & ~(a.t.m | b.t.m) & U64_MAX) !== 0n;
  const disjoint = a.umin > b.umax || a.umax < b.umin || a.smin > b.smax || a.smax < b.smin || tnumsDiffer;
  switch (op) {
    case "eq": return disjoint ? 0 : scalarIsConst(a) && scalarIsConst(b) ? 1 : -1;
    case "ne": return disjoint ? 1 : scalarIsConst(a) && scalarIsConst(b) ? 0 : -1;
    case "gt": return r(a.umin > b.umax ? true : a.umax <= b.umin ? false : null);
    case "ge": return r(a.umin >= b.umax ? true : a.umax < b.umin ? false : null);
    case "lt": return r(a.umax < b.umin ? true : a.umin >= b.umax ? false : null);
    case "le": return r(a.umax <= b.umin ? true : a.umin > b.umax ? false : null);
    case "sgt": return r(a.smin > b.smax ? true : a.smax <= b.smin ? false : null);
    case "sge": return r(a.smin >= b.smax ? true : a.smax < b.smin ? false : null);
    case "slt": return r(a.smax < b.smin ? true : a.smin >= b.smax ? false : null);
    case "sle": return r(a.smax <= b.smin ? true : a.smin > b.smax ? false : null);
    case "set":
      if ((a.t.v & b.t.v) !== 0n) return 1;
      return ((a.t.v | a.t.m) & (b.t.v | b.t.m)) === 0n ? 0 : -1;
  }
}

/**
 * Narrow both sides on the path where `a op b` holds (reg_set_min_max in the kernel).
 * It returns null when this path cannot happen.
 */
export function refine(op: Exclude<CmpName, "set">, a: Scalar, b: Scalar): [Scalar, Scalar] | null {
  const sync2 = (x: Scalar, y: Scalar): [Scalar, Scalar] | null => {
    const sx = syncBounds(x), sy = syncBounds(y);
    return sx && sy ? [sx, sy] : null;
  };
  switch (op) {
    case "eq": {
      const t = tnumIntersect(a.t, b.t);
      if (!t) return null;
      const m: Scalar = { umin: maxB(a.umin, b.umin), umax: minB(a.umax, b.umax), smin: maxB(a.smin, b.smin), smax: minB(a.smax, b.smax), t };
      return sync2(m, m);
    }
    case "ne": {
      const na = { ...a }, nb = { ...b };
      if (scalarIsConst(b)) {
        if (a.umin === b.umin) na.umin = a.umin + 1n;
        if (a.umax === b.umin) na.umax = a.umax - 1n;
        if (a.smin === b.smin) na.smin = a.smin + 1n;
        if (a.smax === b.smin) na.smax = a.smax - 1n;
      }
      if (scalarIsConst(a)) {
        if (b.umin === a.umin) nb.umin = b.umin + 1n;
        if (b.umax === a.umin) nb.umax = b.umax - 1n;
        if (b.smin === a.smin) nb.smin = b.smin + 1n;
        if (b.smax === a.smin) nb.smax = b.smax - 1n;
      }
      return sync2(na, nb);
    }
    case "gt": return a.umax === 0n ? null : sync2({ ...a, umin: maxB(a.umin, b.umin + 1n) }, { ...b, umax: minB(b.umax, a.umax - 1n) });
    case "ge": return sync2({ ...a, umin: maxB(a.umin, b.umin) }, { ...b, umax: minB(b.umax, a.umax) });
    case "lt": {
      const r = refine("gt", b, a);
      return r && [r[1], r[0]];
    }
    case "le": {
      const r = refine("ge", b, a);
      return r && [r[1], r[0]];
    }
    case "sgt": return a.smax === S64_MIN ? null : sync2({ ...a, smin: maxB(a.smin, b.smin + 1n) }, { ...b, smax: minB(b.smax, a.smax - 1n) });
    case "sge": return sync2({ ...a, smin: maxB(a.smin, b.smin) }, { ...b, smax: minB(b.smax, a.smax) });
    case "slt": {
      const r = refine("sgt", b, a);
      return r && [r[1], r[0]];
    }
    case "sle": {
      const r = refine("sge", b, a);
      return r && [r[1], r[0]];
    }
  }
}

/** A short text for a scalar. */
export function fmtScalar(s: Scalar): string {
  if (scalarIsConst(s)) return s.smin < 0n && s.smin > -(1n << 32n) ? `= ${s.smin}` : `= ${s.umin <= 0xffffn ? s.umin.toString() : "0x" + s.umin.toString(16)}`;
  const big = (x: bigint) => (x === U64_MAX ? "2^64-1" : x === S64_MAX ? "2^63-1" : x === S64_MIN ? "-2^63" : x === U32_MAX ? "2^32-1" : x.toString());
  if (s.umin === 0n && s.umax === U64_MAX && s.smin === S64_MIN && s.smax === S64_MAX) {
    return s.t.m === U64_MAX ? "unknown" : `unknown, bits ${fmtTnum(s.t)}`;
  }
  if (s.smin >= 0n) return `[${big(s.umin)}, ${big(s.umax)}]`;
  if (s.umin === 0n && s.umax === U64_MAX) return `s[${big(s.smin)}, ${big(s.smax)}]`;
  return `[${big(s.umin)}, ${big(s.umax)}] s[${big(s.smin)}, ${big(s.smax)}]`;
}

/** The kernel prints a tnum as (value; mask). */
export const fmtTnum = (t: Tnum) => `(0x${t.v.toString(16)}; 0x${t.m.toString(16)})`;
