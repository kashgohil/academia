/**
 * Sequential consistency and x86-TSO.
 * SC: every instruction is an atomic step on one shared memory (all interleavings).
 * TSO: each thread has a FIFO store buffer. Stores enter the buffer; a buffered store drains to
 * memory at any later point; loads see the thread's own newest buffered store first.
 * Locked instructions (RMWs, seq_cst stores compiled to XCHG, MFENCE for seq_cst fences)
 * require an empty buffer. This is how C++ atomics map onto x86.
 */
import { evalVal, type Program } from "./ast";
import { explore, outcomeKey, type Result } from "./explore";

interface T { pc: number; regs: Record<string, number>; buf: [string, number][] }
interface S { mem: Record<string, number>; th: T[] }

export function runTso(p: Program, buffered: boolean): Result {
  const start: S = { mem: Object.fromEntries(p.locs.map((l) => [l, p.init[l] ?? 0])), th: p.threads.map(() => ({ pc: 0, regs: {}, buf: [] })) };

  const read = (s: S, t: T, loc: string) => {
    for (let i = t.buf.length - 1; i >= 0; i--) if (t.buf[i]![0] === loc) return t.buf[i]![1];
    return s.mem[loc]!;
  };
  const withThread = (s: S, i: number, t: T, mem = s.mem): S => ({ mem, th: s.th.map((x, j) => (j === i ? t : x)) });

  const successors = (s: S): S[] => {
    const out: S[] = [];
    s.th.forEach((t, i) => {
      if (buffered && t.buf.length) {
        const [[loc, v], ...rest] = t.buf as [[string, number], ...[string, number][]];
        out.push(withThread(s, i, { ...t, buf: rest }, { ...s.mem, [loc]: v }));
      }
      const ins = p.threads[i]![t.pc];
      if (!ins) return;
      const next = { ...t, pc: t.pc + 1 };
      const empty = t.buf.length === 0;
      switch (ins.op) {
        case "load": {
          const v = read(s, t, ins.loc);
          if (ins.await !== null) { if (v === ins.await) out.push(withThread(s, i, next)); }
          else out.push(withThread(s, i, { ...next, regs: { ...t.regs, [ins.reg!]: v } }));
          break;
        }
        case "store": {
          const v = evalVal(ins.val, t.regs);
          if (!buffered) out.push(withThread(s, i, next, { ...s.mem, [ins.loc]: v }));
          else if (ins.ord === "sc") { if (empty) out.push(withThread(s, i, next, { ...s.mem, [ins.loc]: v })); }
          else out.push(withThread(s, i, { ...next, buf: [...t.buf, [ins.loc, v]] }));
          break;
        }
        case "rmw": {
          if (!empty) break;
          const old = s.mem[ins.loc]!;
          let nv: number | null;
          if (ins.kind === "add") nv = old + evalVal(ins.a, t.regs);
          else if (ins.kind === "xchg") nv = evalVal(ins.a, t.regs);
          else nv = old === evalVal(ins.a, t.regs) ? evalVal(ins.b, t.regs) : null;
          if (ins.blocking && nv === null) break;
          const regs = ins.reg ? { ...t.regs, [ins.reg]: ins.kind === "cas" ? +(nv !== null) : old } : t.regs;
          out.push(withThread(s, i, { ...next, regs }, nv === null ? s.mem : { ...s.mem, [ins.loc]: nv }));
          break;
        }
        case "fence":
          if (ins.ord !== "sc" || empty) out.push(withThread(s, i, next));
          break;
      }
    });
    return out;
  };

  return explore(
    start,
    (s) => JSON.stringify(s),
    successors,
    (s) => {
      const regs = Object.assign({}, ...s.th.map((t) => t.regs));
      const hang = s.th.some((t, i) => t.pc < p.threads[i]!.length);
      return { key: outcomeKey(p, regs, s.mem, hang), regs, mem: s.mem, hang, race: false };
    },
  );
}
