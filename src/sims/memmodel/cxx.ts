/**
 * An operational approximation of the C++ memory model (in the style of view-based /
 * "promising"-family semantics, without promises).
 *
 * - Memory keeps every write ("message") to each location in modification order, with a timestamp.
 * - Each thread has a *view*: for each location, the oldest message it may still read.
 *   Reading or writing a location moves the view forward (coherence).
 * - A release write attaches the writer's view to its message; an acquire read of that message
 *   joins it into the reader's view. That's synchronizes-with.
 * - Relaxed reads collect message views into a pending set that a later acquire fence applies;
 *   relaxed writes after a release fence carry the view from that fence.
 * - RMWs read the latest message and extend its release sequence.
 * - seq_cst operations and fences synchronize through one global view (a total order).
 * - Views also carry one event counter per thread, which makes them vector clocks:
 *   a plain access races if it isn't ordered by happens-before with a conflicting access.
 *
 * Not modelled: load buffering / out-of-thin-air behaviors (they need speculation or
 * "promises"), and relaxed writes placed out of execution order in modification order.
 */
import { evalVal, type Instr, type Program } from "./ast";
import { explore, outcomeKey, type Result } from "./explore";

type View = Record<string, number>;
interface Msg { v: number; view: View }
interface T { pc: number; regs: Record<string, number>; cur: View; acq: View; rel: View | null; clock: number }
interface S { mem: Record<string, Msg[]>; th: T[]; sc: View; race: boolean; reads: Record<string, [number, number][]> }

const join = (a: View, b: View): View => {
  const out = { ...a };
  for (const k in b) if ((out[k] ?? 0) < b[k]!) out[k] = b[k]!;
  return out;
};
const clockKey = (i: number) => `#${i}`;
const canon = (v: View) => Object.keys(v).sort().map((k) => `${k}:${v[k]}`).join(",");

export function runCxx(p: Program): Result {
  const start: S = {
    mem: Object.fromEntries(p.locs.map((l) => [l, [{ v: p.init[l] ?? 0, view: {} }]])),
    th: p.threads.map(() => ({ pc: 0, regs: {}, cur: {}, acq: {}, rel: null, clock: 0 })),
    sc: {},
    race: false,
    reads: {},
  };

  const step = (s: S, i: number): S[] => {
    const t = s.th[i]!;
    const ins: Instr | undefined = p.threads[i]![t.pc];
    if (!ins) return [];
    const isAcq = (o: string) => o === "acq" || o === "acq_rel" || o === "sc";
    const isRel = (o: string) => o === "rel" || o === "acq_rel" || o === "sc";
    const commit = (nt: T, patch: Partial<S> = {}): S => ({ ...s, ...patch, th: s.th.map((x, j) => (j === i ? nt : x)) });
    const out: S[] = [];

    if (ins.op === "fence") {
      let cur = t.cur, acq = t.acq, rel = t.rel, sc = s.sc;
      if (isAcq(ins.ord)) cur = join(cur, acq);
      if (ins.ord === "sc") { cur = join(cur, sc); sc = join(sc, cur); }
      if (isRel(ins.ord)) rel = { ...cur };
      return [commit({ ...t, pc: t.pc + 1, cur, rel }, { sc })];
    }

    const msgs = s.mem[ins.loc]!;
    const latest = msgs.length - 1;
    const pre = ins.ord === "sc" ? join(t.cur, s.sc) : t.cur;
    const from = pre[ins.loc] ?? 0;

    // Happens-before checks for plain (non-atomic) accesses.
    const plainRace = (write: boolean): boolean => {
      if (ins.ord !== "na") return false;
      // Any write to this location not in our view is concurrent with us.
      if (latest > from) return true;
      if (!write) return false;
      // A write also conflicts with plain reads by other threads that we haven't synchronized with.
      return (s.reads[ins.loc] ?? []).some(([u, c]) => u !== i && (pre[clockKey(u)] ?? 0) < c);
    };
    const tick = (v: View, clock: number): View => ({ ...v, [clockKey(i)]: clock });

    if (ins.op === "load") {
      const race = s.race || plainRace(false);
      const clock = t.clock + 1;
      const reads = ins.ord === "na" ? { ...s.reads, [ins.loc]: [...(s.reads[ins.loc] ?? []), [i, clock] as [number, number]] } : s.reads;
      for (let ts = from; ts <= latest; ts++) {
        const m = msgs[ts]!;
        if (ins.await !== null && m.v !== ins.await) continue;
        let cur = tick({ ...pre, [ins.loc]: ts }, clock);
        let acq = t.acq;
        if (isAcq(ins.ord)) cur = join(cur, m.view);
        else acq = join(acq, m.view);
        const sc = ins.ord === "sc" ? join(s.sc, cur) : s.sc;
        const regs = ins.reg ? { ...t.regs, [ins.reg]: m.v } : t.regs;
        out.push(commit({ ...t, pc: t.pc + 1, regs, cur, acq, clock }, { sc, race, reads }));
      }
      return out;
    }

    if (ins.op === "store") {
      const race = s.race || plainRace(true);
      const clock = t.clock + 1;
      const ts = latest + 1;
      const cur = tick({ ...pre, [ins.loc]: ts }, clock);
      const view = isRel(ins.ord) ? cur : t.rel ? join(t.rel, { [ins.loc]: ts }) : { [ins.loc]: ts };
      const mem = { ...s.mem, [ins.loc]: [...msgs, { v: evalVal(ins.val, t.regs), view }] };
      const sc = ins.ord === "sc" ? join(s.sc, cur) : s.sc;
      return [commit({ ...t, pc: t.pc + 1, cur, clock }, { mem, sc, race })];
    }

    // RMW: reads the latest message (atomicity), writes right after it.
    const m = msgs[latest]!;
    let nv: number | null;
    if (ins.kind === "add") nv = m.v + evalVal(ins.a, t.regs);
    else if (ins.kind === "xchg") nv = evalVal(ins.a, t.regs);
    else nv = m.v === evalVal(ins.a, t.regs) ? evalVal(ins.b, t.regs) : null;
    if (ins.blocking && nv === null) return [];
    const clock = t.clock + 1;
    let cur = tick({ ...pre, [ins.loc]: latest }, clock);
    let acq = t.acq;
    if (isAcq(ins.ord)) cur = join(cur, m.view);
    else acq = join(acq, m.view);
    const regs = ins.reg ? { ...t.regs, [ins.reg]: ins.kind === "cas" ? +(nv !== null) : m.v } : t.regs;
    if (nv === null) {
      const sc = ins.ord === "sc" ? join(s.sc, cur) : s.sc;
      return [commit({ ...t, pc: t.pc + 1, regs, cur, acq, clock }, { sc })];
    }
    const ts = latest + 1;
    cur = { ...cur, [ins.loc]: ts };
    // The new message continues the release sequence of the one it read.
    const own = isRel(ins.ord) ? cur : t.rel ? join(t.rel, { [ins.loc]: ts }) : { [ins.loc]: ts };
    const view = join(own, m.view);
    const mem = { ...s.mem, [ins.loc]: [...msgs, { v: nv, view }] };
    const sc = ins.ord === "sc" ? join(s.sc, cur) : s.sc;
    return [commit({ ...t, pc: t.pc + 1, regs, cur, acq, clock }, { mem, sc })];
  };

  return explore(
    start,
    (s) =>
      [
        s.race ? 1 : 0,
        canon(s.sc),
        p.locs.map((l) => s.mem[l]!.map((m) => `${m.v}{${canon(m.view)}}`).join("|")).join(";"),
        s.th.map((t) => `${t.pc}/${JSON.stringify(t.regs)}/${canon(t.cur)}/${canon(t.acq)}/${t.rel ? canon(t.rel) : "-"}/${t.clock}`).join(";"),
        Object.keys(s.reads).sort().map((k) => `${k}:${s.reads[k]!.join("/")}`).join(";"),
      ].join("#"),
    (s) => s.th.flatMap((_, i) => step(s, i)),
    (s) => {
      const regs = Object.assign({}, ...s.th.map((t) => t.regs));
      const mem = Object.fromEntries(p.locs.map((l) => [l, s.mem[l]!.at(-1)!.v]));
      const hang = s.th.some((t, i) => t.pc < p.threads[i]!.length);
      return { key: outcomeKey(p, regs, mem, hang), regs, mem, hang, race: s.race };
    },
  );
}
