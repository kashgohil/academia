/**
 * SIMT execution of one warp. A program is a list of instructions; every lane has its own registers.
 *
 * Two schedulers:
 * - "stack": the pre-Volta reconvergence stack (Fung et al., MICRO 2007). A divergent branch pushes one entry
 *   for each path. Each entry carries the reconvergence PC, which is the branch's immediate post-dominator (IPDOM).
 *   When the top entry reaches its reconvergence PC, it is popped and the paths run together again.
 * - "its": a MODEL of independent thread scheduling (Volta and later). Each lane has its own PC. In each step the
 *   scheduler runs all lanes that share one PC, and it takes the PCs in turn in increasing order, with wrap-around.
 *   NVIDIA does not publish its real policy; this one is fair, so every group makes progress.
 */

export interface LaneRegs { lane: number; x: number; i: number; s: number; y: number; old: number }
export interface Shared { lock: number; count: number }

export type Instr =
  | { kind: "op"; text: string; run?: (r: LaneRegs, m: Shared) => void }
  | { kind: "br"; text: string; cond: (r: LaneRegs) => boolean; target: number }
  | { kind: "jmp"; text: string; target: number }
  | { kind: "sync"; text: string }
  | { kind: "exit"; text: string };

export interface Program { id: string; label: string; code: Instr[] }

// ---------------------------------------------------------------- post-dominators

const succ = (code: Instr[], pc: number): number[] => {
  const ins = code[pc]!;
  const end = code.length; // virtual exit node
  if (ins.kind === "exit") return [end];
  if (ins.kind === "jmp") return [ins.target];
  if (ins.kind === "br") return [...new Set([ins.target, pc + 1])];
  return [pc + 1];
};

/** Immediate post-dominator of every instruction. code.length stands for the exit of the program. */
export function ipdoms(code: Instr[]): number[] {
  const n = code.length;
  const all = new Set(Array.from({ length: n + 1 }, (_, k) => k));
  const pdom: Set<number>[] = Array.from({ length: n + 1 }, (_, k) => (k === n ? new Set([n]) : new Set(all)));
  let changed = true;
  while (changed) {
    changed = false;
    for (let v = n - 1; v >= 0; v--) {
      const ss = succ(code, v);
      const inter = new Set([...pdom[ss[0]!]!].filter((d) => ss.every((s) => pdom[s]!.has(d))));
      inter.add(v);
      if (inter.size !== pdom[v]!.size) { pdom[v] = inter; changed = true; }
    }
  }
  // The immediate post-dominator is the strict post-dominator with the largest set of its own post-dominators.
  return Array.from({ length: n }, (_, v) => {
    const strict = [...pdom[v]!].filter((d) => d !== v);
    return strict.reduce((a, d) => (pdom[d]!.size > pdom[a]!.size ? d : a), strict[0]!);
  });
}

// ---------------------------------------------------------------- execution

export interface StackEntry { pc: number; rpc: number; mask: number[] }

export interface Frame {
  /** The instruction this step issued (-1 when nothing could run). */
  pc: number;
  /** Lanes that executed it. */
  active: number[];
  /** Per-lane PC after the step (-1 = exited). */
  pcs: number[];
  stack: StackEntry[];
  regs: LaneRegs[];
  shared: Shared;
  note: string;
}

export interface Run {
  frames: Frame[];
  finished: boolean;
  /** Steps that issued an instruction. */
  issued: number;
  /** Sum over issued steps of the active lanes. */
  laneOps: number;
  utilization: number;
  lanes: number;
}

export type Scheduler = "stack" | "its";

const clone = (r: LaneRegs[]) => r.map((x) => ({ ...x }));
const bits = (lanes: number[], n: number) => Array.from({ length: n }, (_, k) => (lanes.includes(k) ? "1" : "0")).join("");

/** Runs a program on a warp of `inputs.length` lanes. Stops after `limit` steps (a warp that spins forever). */
export function runWarp(prog: Program, inputs: number[], sched: Scheduler, limit = 400): Run {
  const n = inputs.length;
  const code = prog.code;
  const ip = ipdoms(code);
  const regs: LaneRegs[] = inputs.map((x, lane) => ({ lane, x, i: 0, s: 0, y: 0, old: 0 }));
  const shared: Shared = { lock: 0, count: 0 };
  const pcs = new Array<number>(n).fill(0);
  const exited = new Array<boolean>(n).fill(false);
  const atSync = new Array<boolean>(n).fill(false);
  const all = Array.from({ length: n }, (_, k) => k);
  const stack: StackEntry[] = [{ pc: 0, rpc: code.length, mask: all }];
  const frames: Frame[] = [{ pc: -1, active: [], pcs: [...pcs], stack: sched === "stack" ? stack.map((e) => ({ ...e, mask: [...e.mask] })) : [], regs: clone(regs), shared: { ...shared }, note: "Start: all lanes at instruction 0." }];
  let issued = 0, laneOps = 0, lastPc = -1;

  /** Executes instruction `pc` for `active`. Returns the next PC of each active lane. */
  const exec = (pc: number, active: number[]): Map<number, number> => {
    const ins = code[pc]!;
    const next = new Map<number, number>();
    for (const l of active) {
      const r = regs[l]!;
      if (ins.kind === "op") { ins.run?.(r, shared); next.set(l, pc + 1); }
      else if (ins.kind === "br") next.set(l, ins.cond(r) ? ins.target : pc + 1);
      else if (ins.kind === "jmp") next.set(l, ins.target);
      else if (ins.kind === "sync") next.set(l, pc + 1);
      else { exited[l] = true; next.set(l, -1); }
    }
    return next;
  };

  for (let step = 0; step < limit; step++) {
    if (exited.every(Boolean)) break;
    let pc = -1, active: number[] = [], note = "";
    if (sched === "stack") {
      // Pop entries that are empty or that reached their reconvergence point.
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        top.mask = top.mask.filter((l) => !exited[l]);
        if (top.mask.length === 0 || top.pc === top.rpc) stack.pop();
        else break;
      }
      if (!stack.length) break;
      const top = stack[stack.length - 1]!;
      pc = top.pc; active = [...top.mask];
      const ins = code[pc]!;
      const next = exec(pc, active);
      if (ins.kind === "br") {
        const taken = active.filter((l) => next.get(l) === ins.target);
        const fall = active.filter((l) => next.get(l) !== ins.target);
        if (taken.length && fall.length) {
          const r = ip[pc]!;
          top.pc = r; // the entry now waits at the reconvergence point
          if (r !== pc + 1) stack.push({ pc: pc + 1, rpc: r, mask: fall });
          if (r !== ins.target) stack.push({ pc: ins.target, rpc: r, mask: taken });
          note = `Divergent branch: ${bits(taken, n)} jump to ${ins.target}, ${bits(fall, n)} fall through to ${pc + 1}. They meet again at ${r === code.length ? "the end" : r}.`;
        } else {
          top.pc = taken.length ? ins.target : pc + 1;
          note = `All active lanes go the same way, to ${top.pc}. No divergence.`;
        }
      } else if (ins.kind === "exit") {
        top.mask = [];
        note = `Lanes ${bits(active, n)} exit.`;
      } else {
        top.pc = ins.kind === "jmp" ? ins.target : pc + 1;
      }
      for (const [l, p] of next) pcs[l] = p;
    } else {
      // Independent thread scheduling (model): group lanes by PC; lanes at a sync wait for every lane that has not exited.
      const live = all.filter((l) => !exited[l]);
      const waiting = live.filter((l) => atSync[l]);
      if (waiting.length === live.length && live.length) {
        for (const l of live) { atSync[l] = false; pcs[l] = pcs[l]! + 1; }
        note = "Every lane reached __syncwarp(). They continue together.";
        frames.push({ pc: -1, active: [], pcs: [...pcs], stack: [], regs: clone(regs), shared: { ...shared }, note });
        continue;
      }
      const runnable = live.filter((l) => !atSync[l]);
      const pcSet = [...new Set(runnable.map((l) => pcs[l]!))].sort((a, b) => a - b);
      pc = pcSet.find((p) => p > lastPc) ?? pcSet[0]!;
      active = runnable.filter((l) => pcs[l] === pc);
      const ins = code[pc]!;
      if (ins.kind === "sync") {
        for (const l of active) atSync[l] = true;
        note = `Lanes ${bits(active, n)} wait at __syncwarp() for the other lanes.`;
      } else {
        const next = exec(pc, active);
        for (const [l, p] of next) pcs[l] = p;
        if (ins.kind === "br") {
          const taken = active.filter((l) => next.get(l) === ins.target);
          if (taken.length && taken.length < active.length) note = `Divergent branch: the lanes now have ${new Set(active.map((l) => pcs[l])).size} different PCs. Each group is scheduled on its own.`;
        }
        if (ins.kind === "exit") note = `Lanes ${bits(active, n)} exit.`;
      }
      lastPc = pc;
    }
    issued++;
    laneOps += active.length;
    if (!note && pcs.filter((p) => p >= 0).length) note = `Instruction ${pc} runs for ${active.length} of ${n} lanes.`;
    frames.push({ pc, active, pcs: [...pcs], stack: sched === "stack" ? stack.map((e) => ({ ...e, mask: [...e.mask] })) : [], regs: clone(regs), shared: { ...shared }, note });
  }
  const finished = exited.every(Boolean);
  return { frames, finished, issued, laneOps, utilization: issued ? laneOps / (issued * n) : 1, lanes: n };
}

// ---------------------------------------------------------------- programs

/** if (taken[lane]) { a instructions } else { b instructions }. The branch jumps to the else part. */
export function ifElse(a: number, b: number): Program {
  // 0: branch to ELSE; 1..a: then; a+1: jump to JOIN; a+2..a+1+b: else; a+2+b: JOIN (exit).
  const code: Instr[] = [{ kind: "br", text: "@!p bra ELSE", cond: (r) => r.x === 0, target: a + 2 }];
  for (let k = 0; k < a; k++) code.push({ kind: "op", text: `then ${k + 1}` });
  code.push({ kind: "jmp", text: "bra JOIN", target: a + 2 + b });
  for (let k = 0; k < b; k++) code.push({ kind: "op", text: `else ${k + 1}` });
  code.push({ kind: "exit", text: "exit" });
  return { id: "ifelse", label: "if / else", code };
}

/** Lanes with taken = 1 run the then part. Counts issued instructions and lane utilization (exit not counted). */
export function divergenceCost(taken: boolean[], a: number, b: number) {
  const run = runWarp(ifElse(a, b), taken.map((t) => (t ? 1 : 0)), "stack");
  const body = run.frames.filter((f) => f.pc >= 0 && ifElse(a, b).code[f.pc]!.kind !== "exit");
  const issued = body.length;
  const laneOps = body.reduce((s, f) => s + f.active.length, 0);
  return { issued, laneOps, utilization: laneOps / (issued * taken.length), frames: body };
}

export const PROGRAMS: Program[] = [
  {
    id: "ifelse", label: "if / else",
    code: [
      { kind: "br", text: "if (x is odd) goto 4", cond: (r) => r.x % 2 === 1, target: 4 },
      { kind: "op", text: "y = x * 2", run: (r) => { r.y = r.x * 2; } },
      { kind: "op", text: "y = y + 1", run: (r) => { r.y = r.y + 1; } },
      { kind: "jmp", text: "goto 5", target: 5 },
      { kind: "op", text: "y = x + 100", run: (r) => { r.y = r.x + 100; } },
      { kind: "op", text: "out[lane] = y" },
      { kind: "exit", text: "exit" },
    ],
  },
  {
    id: "nested", label: "nested if",
    code: [
      { kind: "br", text: "if (x >= 4) goto 7", cond: (r) => r.x >= 4, target: 7 },
      { kind: "br", text: "if (x is odd) goto 5", cond: (r) => r.x % 2 === 1, target: 5 },
      { kind: "op", text: "y = 1", run: (r) => { r.y = 1; } },
      { kind: "op", text: "y = y * x", run: (r) => { r.y = r.y * r.x; } },
      { kind: "jmp", text: "goto 6", target: 6 },
      { kind: "op", text: "y = 2", run: (r) => { r.y = 2; } },
      { kind: "jmp", text: "goto 8", target: 8 },
      { kind: "op", text: "y = 3", run: (r) => { r.y = 3; } },
      { kind: "op", text: "out[lane] = y" },
      { kind: "exit", text: "exit" },
    ],
  },
  {
    id: "loop", label: "loop: x trips",
    code: [
      { kind: "op", text: "i = 0; s = 0", run: (r) => { r.i = 0; r.s = 0; } },
      { kind: "br", text: "if (i >= x) goto 5", cond: (r) => r.i >= r.x, target: 5 },
      { kind: "op", text: "s = s + i", run: (r) => { r.s += r.i; } },
      { kind: "op", text: "i = i + 1", run: (r) => { r.i += 1; } },
      { kind: "jmp", text: "goto 1", target: 1 },
      { kind: "op", text: "y = s * 2", run: (r) => { r.y = r.s * 2; } },
      { kind: "op", text: "out[lane] = y" },
      { kind: "exit", text: "exit" },
    ],
  },
  {
    id: "loopsync", label: "loop + __syncwarp",
    code: [
      { kind: "op", text: "i = 0; s = 0", run: (r) => { r.i = 0; r.s = 0; } },
      { kind: "br", text: "if (i >= x) goto 5", cond: (r) => r.i >= r.x, target: 5 },
      { kind: "op", text: "s = s + i", run: (r) => { r.s += r.i; } },
      { kind: "op", text: "i = i + 1", run: (r) => { r.i += 1; } },
      { kind: "jmp", text: "goto 1", target: 1 },
      { kind: "sync", text: "__syncwarp()" },
      { kind: "op", text: "y = s * 2", run: (r) => { r.y = r.s * 2; } },
      { kind: "op", text: "out[lane] = y" },
      { kind: "exit", text: "exit" },
    ],
  },
  {
    id: "spin", label: "spin lock",
    code: [
      { kind: "op", text: "old = atomicCAS(&lock, 0, 1)", run: (r, m) => { r.old = m.lock; if (m.lock === 0) m.lock = 1; } },
      { kind: "br", text: "if (old != 0) goto 0", cond: (r) => r.old !== 0, target: 0 },
      { kind: "op", text: "count = count + 1", run: (_r, m) => { m.count += 1; } },
      { kind: "op", text: "lock = 0", run: (_r, m) => { m.lock = 0; } },
      { kind: "exit", text: "exit" },
    ],
  },
];

export const program = (id: string) => PROGRAMS.find((p) => p.id === id)!;
