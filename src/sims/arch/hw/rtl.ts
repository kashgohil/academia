/**
 * A cycle-based RTL simulator for the Verilog subset of verilog.ts. Each cycle has two phases:
 *
 * 1. Settle: the combinational processes (`assign` and `always @*`) run until no signal changes. A process runs only
 *    when a signal or memory that it reads has changed, as in an event-driven simulator. The processes are sorted so
 *    that a writer runs before its readers; a design with no combinational loop settles in one pass. A loop that does
 *    not settle in MAX_PASSES passes is an error. At time 0 every combinational process runs once (as `always_comb`
 *    does in SystemVerilog; a Verilog-2001 `always @*` waits for its first input change).
 * 2. Clock edge: every `always @(posedge clk)` block runs, in source order. A blocking `=` writes at once, so later
 *    statements and later blocks see the new value. A nonblocking `<=` evaluates its right side (and the index on its
 *    left side) now and queues the write. After all blocks have run, the queued writes are applied in order. This is
 *    the two-step rule of IEEE 1364 scheduling: evaluate at the edge, update after the active events. Then the design
 *    settles again.
 *
 * The waveform column of cycle t shows the values after the inputs of cycle t are applied and the logic has settled,
 * just before the rising edge at the end of the cycle.
 *
 * Differences from a full Verilog simulator, all on purpose:
 * - Two states: every signal starts at 0 (Verilog starts a reg at x). Out-of-range reads give 0 (Verilog gives x),
 *   and out-of-range writes do nothing (as in Verilog).
 * - Clocked blocks run in source order. A real simulator may run them in any order, so a design whose result depends
 *   on that order (a race) has no defined result there.
 * - Combinational logic does not settle between two clocked blocks of the same edge.
 * - A nonblocking write in a combinational block is applied when that block finishes.
 */
import { VerilogError, elaborate, signExt, widthMask, type Design, type IR, type IStmt, type LV, type Signal, type VError } from "./verilog";

export const MAX_PASSES = 64;

type Fn = () => number;

/** One assignment during a clock edge, for the step-by-step view. */
export interface EdgeEvent {
  phase: "eval" | "update";
  line: number;
  target: string;
  value: number;
  nb: boolean;
}

export class RtlSim {
  readonly d: Design;
  readonly vals: number[];
  readonly mems: (Uint32Array | null)[];
  cycle = 0;
  /** Set to an array to collect the events of each clock edge. */
  edgeLog: EdgeEvent[] | null = null;
  /** Number of process runs so far (a cost measure). */
  evals = 0;

  private comb: { run: () => void; line: number }[] = [];
  private order: number[] = [];
  private dirty: boolean[] = [];
  private readersOf: number[][] = [];
  private memReadersOf: number[][] = [];
  private seq: (() => void)[] = [];
  private queue: (() => void)[] = [];
  private combQueue: (() => void)[] = [];
  private current = -1; // the comb process that runs now (it does not wake itself)

  constructor(d: Design) {
    this.d = d;
    this.vals = d.signals.map(() => 0);
    this.mems = d.signals.map((s) => (s.depth ? new Uint32Array(s.depth) : null));
    this.readersOf = d.signals.map(() => []);
    this.memReadersOf = d.signals.map(() => []);
    const combProcs = d.procs.filter((p) => p.kind !== "seq");
    combProcs.forEach((p, i) => {
      for (const r of p.reads) this.readersOf[r]!.push(i);
      for (const r of p.readsMem) this.memReadersOf[r]!.push(i);
      const body = this.stmt(p.body, false);
      const run = () => {
        body();
        // A nonblocking write in a combinational block: applied when the block finishes (documented approximation).
        if (this.combQueue.length) { const q = this.combQueue.splice(0); for (const c of q) c(); }
      };
      this.comb.push({ run, line: p.line });
    });
    this.order = topoOrder(combProcs.map((p) => ({ reads: p.reads, writes: p.writes })));
    this.dirty = combProcs.map(() => true);
    for (const p of d.procs) if (p.kind === "seq") this.seq.push(this.stmt(p.body, true));
    this.settle();
  }

  sig(name: string): Signal {
    const s = this.d.byName.get(name);
    if (!s) throw new Error(`no signal ${name}`);
    return s;
  }
  get(name: string): number { return this.vals[this.sig(name).id]!; }
  /** The value as a signed number, if the signal is declared signed or `signed` is true. */
  getSigned(name: string): number { const s = this.sig(name); return signExt(this.vals[s.id]!, s.width); }

  /** Drive an input. Call settle() (or step()) afterwards. */
  set(name: string, v: number) {
    const s = this.sig(name);
    if (s.kind !== "input") throw new Error(`${name} is not an input`);
    this.write(s.id, v);
  }

  peekMem(name: string, i: number): number { return this.mems[this.sig(name).id]![i] ?? 0; }
  pokeMem(name: string, i: number, v: number) {
    const s = this.sig(name);
    const m = this.mems[s.id]!;
    if (i < 0 || i >= m.length) return;
    m[i] = (v & widthMask(s.width)) >>> 0;
    for (const p of this.memReadersOf[s.id]!) this.dirty[p] = true;
  }

  /** Run the combinational processes until nothing changes. */
  settle() {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let ran = false;
      for (const p of this.order) {
        if (!this.dirty[p]) continue;
        this.dirty[p] = false;
        this.current = p;
        this.comb[p]!.run();
        this.evals++;
        this.current = -1;
        ran = true;
      }
      if (!ran) return;
      if (!this.dirty.some(Boolean)) return;
    }
    const p = this.order.find((i) => this.dirty[i]);
    throw new VerilogError(p === undefined ? 0 : this.comb[p]!.line, `combinational loop: the logic does not settle after ${MAX_PASSES} passes`);
  }

  /** The rising clock edge: run the clocked blocks, apply the queued nonblocking writes, settle. */
  edge() {
    for (const s of this.seq) s();
    const q = this.queue;
    this.queue = [];
    for (const w of q) w();
    this.settle();
    this.cycle++;
  }

  // ------------------------------------------------------------ compile

  private write(id: number, v: number) {
    const s = this.d.signals[id]!;
    const nv = (v & widthMask(s.width)) >>> 0;
    if (this.vals[id] === nv) return;
    this.vals[id] = nv;
    for (const p of this.readersOf[id]!) if (p !== this.current) this.dirty[p] = true;
  }

  private writeMem(id: number, i: number, v: number) {
    const m = this.mems[id]!;
    if (i < 0 || i >= m.length) return;
    const nv = (v & widthMask(this.d.signals[id]!.width)) >>> 0;
    if (m[i] === nv) return;
    m[i] = nv;
    for (const p of this.memReadersOf[id]!) this.dirty[p] = true;
  }

  private stmt(s: IStmt, clocked: boolean): () => void {
    switch (s.k) {
      case "block": {
        const body = s.body.map((b) => this.stmt(b, clocked));
        return () => { for (const b of body) b(); };
      }
      case "if": {
        const c = this.expr(s.cond), t = this.stmt(s.then, clocked), e = s.else ? this.stmt(s.else, clocked) : null;
        return () => { if (c()) t(); else if (e) e(); };
      }
      case "case": {
        const sel = this.expr(s.sel);
        const items = s.items.map((i) => ({ labels: i.labels?.map((l) => this.expr(l)) ?? null, body: this.stmt(i.body, clocked) }));
        return () => {
          const v = sel();
          for (const it of items) if (!it.labels || it.labels.some((l) => l() === v)) { it.body(); return; }
        };
      }
      case "assign": {
        const rhs = this.expr(s.rhs);
        const prep = this.lv(s.lhs);
        const name = lvName(s.lhs, this.d.signals);
        const line = s.line, nb = s.nb;
        if (!nb) {
          return () => {
            const v = rhs();
            if (clocked && this.edgeLog) this.edgeLog.push({ phase: "eval", line, target: name, value: v, nb: false });
            prep()(v);
          };
        }
        return () => {
          const v = rhs();
          const w = prep();
          if (this.edgeLog) this.edgeLog.push({ phase: "eval", line, target: name, value: v, nb: true });
          const commit = () => {
            if (this.edgeLog) this.edgeLog.push({ phase: "update", line, target: name, value: v, nb: true });
            w(v);
          };
          if (clocked) this.queue.push(commit); else this.combQueue.push(commit);
        };
      }
    }
  }

  /** A left side compiles to `prepare`, which evaluates the indexes now and returns the writer. */
  private lv(l: LV): () => (v: number) => void {
    switch (l.k) {
      case "sig": { const id = l.id; const w = (v: number) => this.write(id, v); return () => w; }
      case "slice": {
        const { id, lo } = l, m = widthMask(l.w);
        const w = (v: number) => this.write(id, (this.vals[id]! & ~((m << lo) >>> 0)) | (((v & m) << lo) >>> 0));
        return () => w;
      }
      case "bit": {
        const { id, off } = l, idx = this.expr(l.idx), width = this.d.signals[id]!.width;
        return () => {
          const b = idx() - off;
          if (b < 0 || b >= width) return () => {};
          return (v: number) => this.write(id, (this.vals[id]! & ~(1 << b)) | ((v & 1) << b));
        };
      }
      case "mem": {
        const { mem } = l, idx = this.expr(l.idx);
        return () => { const i = idx(); return (v: number) => this.writeMem(mem, i, v); };
      }
      case "concat": {
        const parts = l.parts.map((p) => ({ prep: this.lv(p), w: p.w }));
        return () => {
          const ws = parts.map((p) => ({ f: p.prep(), w: p.w }));
          return (v: number) => {
            let shift = 0;
            for (let i = ws.length - 1; i >= 0; i--) { const p = ws[i]!; p.f(Math.floor(v / 2 ** shift) % 2 ** p.w); shift += p.w; }
          };
        };
      }
    }
  }

  /** Compile an expression to a closure that returns an unsigned value below 2^w. */
  expr(e: IR): Fn {
    const m = widthMask(e.w);
    const vals = this.vals;
    switch (e.k) {
      case "const": { const v = (e.v & m) >>> 0; return () => v; }
      case "sig": { const id = e.id; return () => vals[id]!; }
      case "resize": {
        const a = this.expr(e.a), aw = e.a.w;
        if (e.sx && e.w > aw) return () => (signExt(a(), aw) & m) >>> 0;
        if (e.w >= aw) return a;
        return () => (a() & m) >>> 0;
      }
      case "bin": {
        const a = this.expr(e.a), b = this.expr(e.b);
        switch (e.op) {
          case "+": return () => ((a() + b()) & m) >>> 0;
          case "-": return () => ((a() - b()) & m) >>> 0;
          case "&": return () => (a() & b()) >>> 0;
          case "|": return () => (a() | b()) >>> 0;
          case "^": return () => (a() ^ b()) >>> 0;
        }
        break;
      }
      case "not": { const a = this.expr(e.a); return () => (~a() & m) >>> 0; }
      case "neg": { const a = this.expr(e.a); return () => (-a() & m) >>> 0; }
      case "cmp": {
        const a0 = this.expr(e.a), b0 = this.expr(e.b), w = e.a.w;
        const a = e.signed ? () => signExt(a0(), w) : a0, b = e.signed ? () => signExt(b0(), w) : b0;
        switch (e.op) {
          case "==": return () => (a() === b() ? 1 : 0);
          case "!=": return () => (a() !== b() ? 1 : 0);
          case "<": return () => (a() < b() ? 1 : 0);
          case "<=": return () => (a() <= b() ? 1 : 0);
          case ">": return () => (a() > b() ? 1 : 0);
          case ">=": return () => (a() >= b() ? 1 : 0);
        }
        break;
      }
      case "logic": {
        const a = this.expr(e.a), b = this.expr(e.b);
        return e.op === "&&" ? () => (a() && b() ? 1 : 0) : () => (a() || b() ? 1 : 0);
      }
      case "lnot": { const a = this.expr(e.a); return () => (a() ? 0 : 1); }
      case "red": {
        const a = this.expr(e.a), am = widthMask(e.a.w);
        if (e.op === "&") return () => (a() === am ? 1 : 0);
        if (e.op === "|") return () => (a() ? 1 : 0);
        return () => { let x = a(), p = 0; while (x) { p ^= x & 1; x >>>= 1; } return p; };
      }
      case "shift": {
        const a = this.expr(e.a), b = this.expr(e.b), w = e.w;
        if (e.op === "<<") return () => { const s = b(); return s >= 32 ? 0 : ((a() << s) & m) >>> 0; };
        if (e.op === ">>" || !e.s) return () => { const s = b(); return s >= 32 ? 0 : a() >>> s; };
        return () => ((signExt(a(), w) >> Math.min(b(), 31)) & m) >>> 0;
      }
      case "cond": {
        const c = this.expr(e.c), a = this.expr(e.a), b = this.expr(e.b);
        return () => (c() ? a() : b());
      }
      case "bit": {
        const a = this.expr(e.a), idx = this.expr(e.idx), off = e.off, aw = e.a.w;
        return () => { const i = idx() - off; return i < 0 || i >= aw ? 0 : (a() >>> i) & 1; };
      }
      case "slice": {
        const a = this.expr(e.a), lo = e.lo;
        return () => ((a() >>> lo) & m) >>> 0;
      }
      case "mem": {
        const mem = this.mems[e.mem]!, idx = this.expr(e.idx);
        return () => mem[idx()] ?? 0;
      }
      case "concat": {
        const parts = e.parts.map((p) => ({ f: this.expr(p), w: p.w }));
        return () => {
          let v = 0;
          for (const p of parts) v = v * 2 ** p.w + p.f();
          return v >>> 0;
        };
      }
    }
    throw new Error("unreachable");
  }
}

function lvName(l: LV, sigs: Signal[]): string {
  switch (l.k) {
    case "sig": return sigs[l.id]!.name;
    case "slice": return `${sigs[l.id]!.name}[${l.lo + sigs[l.id]!.lsb + l.w - 1}:${l.lo + sigs[l.id]!.lsb}]`;
    case "bit": return `${sigs[l.id]!.name}[i]`;
    case "mem": return `${sigs[l.mem]!.name}[i]`;
    case "concat": return `{${l.parts.map((p) => lvName(p, sigs)).join(", ")}}`;
  }
}

/** Writers before readers. Processes on a cycle keep their source order, after the others. */
export function topoOrder(ps: { reads: number[]; writes: number[] }[]): number[] {
  const writersOf = new Map<number, number[]>();
  ps.forEach((p, i) => p.writes.forEach((w) => writersOf.set(w, [...(writersOf.get(w) ?? []), i])));
  const indeg = ps.map(() => 0);
  const out: number[][] = ps.map(() => []);
  ps.forEach((p, i) => {
    const deps = new Set<number>();
    for (const r of p.reads) for (const w of writersOf.get(r) ?? []) if (w !== i) deps.add(w);
    for (const w of deps) { out[w]!.push(i); indeg[i]!++; }
  });
  const order: number[] = [];
  const ready = ps.map((_, i) => i).filter((i) => indeg[i] === 0);
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.push(i);
    for (const j of out[i]!) if (--indeg[j]! === 0) ready.push(j);
  }
  ps.forEach((_, i) => { if (!order.includes(i)) order.push(i); });
  return order;
}

// ---------------------------------------------------------------- waveforms

export interface Wave {
  /** Signals in declaration order (memories left out). */
  signals: { name: string; width: number; kind: Signal["kind"] }[];
  /** values[s][t]: signal s in cycle t. */
  values: number[][];
  cycles: number;
}

export type Stimulus = (cycle: number, sim: RtlSim) => Record<string, number> | void;

export interface RunResult {
  ok: boolean;
  error: VError | null;
  warnings: VError[];
  design: Design | null;
  wave: Wave | null;
  sim: RtlSim | null;
}

/** Elaborate `src`, then run `cycles` cycles. `stim` gives the inputs of each cycle (the clock is implicit). */
export function simulate(src: string, cycles: number, stim?: Stimulus, opts: { edgeLog?: boolean } = {}): RunResult {
  let design: Design;
  try { design = elaborate(src); } catch (e) { return fail(e, null); }
  let sim: RtlSim;
  try { sim = new RtlSim(design); } catch (e) { return fail(e, design); }
  if (opts.edgeLog) sim.edgeLog = [];
  const shown = design.signals.filter((s) => !s.depth && s !== design.clock);
  const values = shown.map(() => [] as number[]);
  try {
    for (let t = 0; t < cycles; t++) {
      const inp = stim?.(t, sim);
      if (inp) for (const [k, v] of Object.entries(inp)) if (design.byName.get(k)?.kind === "input") sim.set(k, v);
      sim.settle();
      shown.forEach((s, i) => values[i]!.push(sim.vals[s.id]!));
      sim.edge();
    }
  } catch (e) {
    const r = fail(e, design);
    return { ...r, sim, wave: { signals: shown.map((s) => ({ name: s.name, width: s.width, kind: s.kind })), values, cycles: values[0]?.length ?? 0 } };
  }
  return {
    ok: true, error: null, warnings: design.warnings, design, sim,
    wave: { signals: shown.map((s) => ({ name: s.name, width: s.width, kind: s.kind })), values, cycles },
  };
}

function fail(e: unknown, design: Design | null): RunResult {
  if (e instanceof VerilogError) return { ok: false, error: { line: e.line, message: e.message }, warnings: design?.warnings ?? [], design, wave: null, sim: null };
  throw e;
}
