/**
 * A tiny language for litmus tests.
 *
 *   x = 1                         initial value (before the first thread; default 0)
 *   T0:                           start a thread
 *     x.store(1, relaxed)         atomic store          (default order: seq_cst)
 *     r0 = x.load(acquire)        atomic load
 *     r0 = x.fetch_add(1, rlx)    atomic RMW, returns the old value
 *     r0 = x.exchange(5)          atomic RMW
 *     r0 = x.cas(0, 1, acq_rel)   strong compare-exchange: r0 = 1 on success, 0 on failure
 *     x.await(1, acquire)         spin until a load returns 1
 *     x.await_cas(0, 1, acquire)  spin until a CAS 0 → 1 succeeds
 *     m.lock() / m.unlock()       = m.await_cas(0, 1, acquire) / m.store(0, release)
 *     fence(seq_cst)              atomic_thread_fence
 *     data = r0 + 1               plain (non-atomic) store
 *     r1 = data                   plain (non-atomic) load
 *
 * Registers are r<digits> and must be unique across threads. Everything else is a location.
 */

export type Ord = "rlx" | "acq" | "rel" | "acq_rel" | "sc" | "na";

export type Val = { reg: string | null; add: number };

export type Instr =
  | { op: "load"; reg: string | null; loc: string; ord: Ord; await: number | null; line: number }
  | { op: "store"; loc: string; val: Val; ord: Ord; line: number }
  | { op: "rmw"; kind: "add" | "xchg" | "cas"; reg: string | null; loc: string; a: Val; b: Val; ord: Ord; blocking: boolean; line: number }
  | { op: "fence"; ord: Ord; line: number };

export interface Program {
  init: Record<string, number>;
  threads: Instr[][];
  locs: string[];
  regs: string[];
}

export class ParseError extends Error {
  constructor(public line: number, msg: string) {
    super(`line ${line}: ${msg}`);
  }
}

const ORDS: Record<string, Ord> = {
  relaxed: "rlx", rlx: "rlx",
  acquire: "acq", acq: "acq",
  release: "rel", rel: "rel",
  acq_rel: "acq_rel",
  seq_cst: "sc", sc: "sc",
};

export const ORD_NAME: Record<Ord, string> = { rlx: "relaxed", acq: "acquire", rel: "release", acq_rel: "acq_rel", sc: "seq_cst", na: "plain" };

const isReg = (s: string) => /^r\d+$/.test(s);
const IDENT = /^[A-Za-z_]\w*$/;

export function parse(src: string): Program {
  const init: Record<string, number> = {};
  const threads: Instr[][] = [];
  const locs = new Set<string>();
  const regs = new Set<string>();

  const ord = (s: string | undefined, line: number, allowed: Ord[]): Ord => {
    if (s === undefined || s.trim() === "") return "sc";
    const o = ORDS[s.trim()];
    if (!o) throw new ParseError(line, `unknown memory order "${s.trim()}"`);
    if (!allowed.includes(o)) throw new ParseError(line, `${ORD_NAME[o]} is not a valid order here`);
    return o;
  };
  const val = (s: string, line: number): Val => {
    const t = s.replace(/\s+/g, "");
    let m = t.match(/^(-?\d+)$/);
    if (m) return { reg: null, add: Number(m[1]) };
    m = t.match(/^(r\d+)(?:([+-])(\d+))?$/);
    if (m) {
      if (!regs.has(m[1]!)) throw new ParseError(line, `register ${m[1]} is used before it is set`);
      return { reg: m[1]!, add: m[2] ? (m[2] === "-" ? -1 : 1) * Number(m[3]) : 0 };
    }
    throw new ParseError(line, `expected a number or register, got "${s.trim()}"`);
  };
  const loc = (s: string, line: number) => {
    if (!IDENT.test(s) || isReg(s)) throw new ParseError(line, `"${s}" is not a location name`);
    locs.add(s);
    return s;
  };
  const reg = (s: string, line: number) => {
    if (!isReg(s)) throw new ParseError(line, `"${s}" is not a register (use r0, r1, …)`);
    if (regs.has(s)) throw new ParseError(line, `register ${s} is assigned twice; use a new register`);
    regs.add(s);
    return s;
  };

  const LOADS: Ord[] = ["rlx", "acq", "sc"];
  const STORES: Ord[] = ["rlx", "rel", "sc"];
  const ALL: Ord[] = ["rlx", "acq", "rel", "acq_rel", "sc"];

  src.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const s = raw.replace(/\/\/.*$/, "").trim();
    if (!s) return;
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^T(\d+):$/))) {
      threads.push([]);
      return;
    }
    const cur = threads[threads.length - 1];
    if (!cur) {
      m = s.match(/^(\w+)\s*=\s*(-?\d+)$/);
      if (!m) throw new ParseError(line, `before the first thread, only initial values like "x = 1" are allowed`);
      init[loc(m[1]!, line)] = Number(m[2]);
      return;
    }
    const push = (x: Instr) => cur.push(x);
    if ((m = s.match(/^(r\d+)\s*=\s*(\w+)\.load\(\s*(\w*)\s*\)$/)))
      return push({ op: "load", loc: loc(m[2]!, line), ord: ord(m[3], line, LOADS), reg: reg(m[1]!, line), await: null, line });
    if ((m = s.match(/^(\w+)\.await\(\s*(-?\d+)\s*(?:,\s*(\w+))?\s*\)$/)))
      return push({ op: "load", loc: loc(m[1]!, line), ord: ord(m[3], line, LOADS), reg: null, await: Number(m[2]), line });
    if ((m = s.match(/^(\w+)\.store\(\s*([^,]+?)\s*(?:,\s*(\w+))?\s*\)$/)))
      return push({ op: "store", loc: loc(m[1]!, line), val: val(m[2]!, line), ord: ord(m[3], line, STORES), line });
    if ((m = s.match(/^(r\d+)\s*=\s*(\w+)\.(fetch_add|exchange)\(\s*([^,]+?)\s*(?:,\s*(\w+))?\s*\)$/))) {
      const a = val(m[4]!, line);
      return push({ op: "rmw", kind: m[3] === "fetch_add" ? "add" : "xchg", loc: loc(m[2]!, line), a, b: a, ord: ord(m[5], line, ALL), reg: reg(m[1]!, line), blocking: false, line });
    }
    if ((m = s.match(/^(r\d+)\s*=\s*(\w+)\.(?:cas|compare_exchange)\(\s*([^,]+?)\s*,\s*([^,]+?)\s*(?:,\s*(\w+))?\s*\)$/))) {
      const a = val(m[3]!, line), b = val(m[4]!, line);
      return push({ op: "rmw", kind: "cas", loc: loc(m[2]!, line), a, b, ord: ord(m[5], line, ALL), reg: reg(m[1]!, line), blocking: false, line });
    }
    if ((m = s.match(/^(\w+)\.await_cas\(\s*([^,]+?)\s*,\s*([^,]+?)\s*(?:,\s*(\w+))?\s*\)$/)))
      return push({ op: "rmw", kind: "cas", loc: loc(m[1]!, line), a: val(m[2]!, line), b: val(m[3]!, line), ord: ord(m[4], line, ALL), reg: null, blocking: true, line });
    if ((m = s.match(/^(\w+)\.lock\(\)$/)))
      return push({ op: "rmw", kind: "cas", loc: loc(m[1]!, line), a: { reg: null, add: 0 }, b: { reg: null, add: 1 }, ord: "acq", reg: null, blocking: true, line });
    if ((m = s.match(/^(\w+)\.unlock\(\)$/)))
      return push({ op: "store", loc: loc(m[1]!, line), val: { reg: null, add: 0 }, ord: "rel", line });
    if ((m = s.match(/^fence\(\s*(\w*)\s*\)$/)))
      return push({ op: "fence", ord: ord(m[1], line, ALL), line });
    if ((m = s.match(/^(r\d+)\s*=\s*([A-Za-z_]\w*)$/)) && !isReg(m[2]!))
      return push({ op: "load", loc: loc(m[2]!, line), ord: "na", reg: reg(m[1]!, line), await: null, line });
    if ((m = s.match(/^([A-Za-z_]\w*)\s*=\s*(.+)$/)) && !isReg(m[1]!))
      return push({ op: "store", loc: loc(m[1]!, line), val: val(m[2]!, line), ord: "na", line });
    throw new ParseError(line, `can't read "${s}"`);
  });

  if (threads.length === 0) throw new ParseError(1, "no threads: start one with T0:");
  if (threads.length > 4) throw new ParseError(1, "at most 4 threads");
  if (threads.some((t) => t.length > 8)) throw new ParseError(1, "at most 8 instructions per thread");
  return { init, threads, locs: [...locs].sort(), regs: [...regs] };
}

export const evalVal = (v: Val, regs: Record<string, number>) => (v.reg ? (regs[v.reg] ?? 0) : 0) + v.add;
