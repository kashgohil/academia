/**
 * A Go-style M:N scheduler: G (goroutine), M (OS thread), P (processor with a local run queue).
 *
 * It follows runtime/proc.go in these rules:
 * - An M needs a P to run Go code. There are GOMAXPROCS Ps.
 * - A new G goes in runnext, and the old runnext moves to the local queue (runqput).
 * - A full local queue (256) moves half of itself to the global queue (runqputslow).
 * - schedule: every 61st tick the global queue first; then runnext, the local queue, the global queue;
 *   then steal half of a random victim's local queue (findRunnable, runqsteal).
 * - A G in a blocking syscall keeps its M. sysmon retakes the P after a short time and hands it to another M.
 * - After the syscall, the M tries to get its old P, then any idle P. If it gets none, the G goes on the
 *   global queue and the M parks (exitsyscall).
 * - A G that runs for a whole time slice is preempted and goes on the global queue.
 * Time is in ticks. It has no network poller, no GC, no timers and no spinning Ms.
 */
import { mulberry32, type Rng } from "../../rng";

export const LOCAL_QUEUE_CAP = 256;
export const GLOBAL_CHECK_EVERY = 61;
/** Ticks before sysmon retakes a P from a blocking syscall. The real value starts at about 20 µs. */
export const RETAKE_TICKS = 1;
/** Time slice in ticks. The real value is 10 ms (forcePreemptNS). */
export const TIME_SLICE_TICKS = 10;
/** The default limit of debug.SetMaxThreads. */
export const MAX_THREADS = 10000;

export type GOp = { op: "run"; ticks: number } | { op: "syscall"; ticks: number } | { op: "spawn"; prog: GOp[] };
export type GState = "runnable" | "running" | "syscall" | "done";

export interface G { id: number; state: GState; prog: GOp[]; pc: number; left: number; onM: number | null; slice: number }
export interface P { id: number; m: number | null; cur: number | null; runnext: number | null; q: number[]; tick: number }
export interface M { id: number; p: number | null; g: number | null; syscallLeft: number; syscallFor: number; state: "running" | "syscall" | "idle"; oldP: number | null }

export interface GmpEvent { tick: number; kind: "start" | "spawn" | "syscall" | "handoff" | "return" | "steal" | "global" | "done" | "preempt" | "newM" | "park"; text: string }

export interface GmpStats { handoffs: number; steals: number; stolenGs: number; mCreated: number; spawned: number; preempted: number; toGlobal: number }

export class Gmp {
  gs = new Map<number, G>();
  ps: P[] = [];
  ms: M[] = [];
  globalQ: number[] = [];
  tick = 0;
  events: GmpEvent[] = [];
  stats: GmpStats = { handoffs: 0, steals: 0, stolenGs: 0, mCreated: 0, spawned: 0, preempted: 0, toGlobal: 0 };
  private nextG = 1;
  private rng: Rng;

  constructor(gomaxprocs: number, seed = 1) {
    for (let i = 0; i < gomaxprocs; i++) this.ps.push({ id: i, m: null, cur: null, runnext: null, q: [], tick: 0 });
    this.rng = mulberry32(seed);
  }

  private ev(kind: GmpEvent["kind"], text: string) { this.events.push({ tick: this.tick, kind, text }); }

  /** Adds a G to P p, as the go statement does from a G on that P. */
  go(prog: GOp[], p = 0): number {
    const g: G = { id: this.nextG++, state: "runnable", prog, pc: 0, left: 0, onM: null, slice: 0 };
    this.gs.set(g.id, g);
    this.stats.spawned++;
    this.runqput(this.ps[p]!, g.id, true);
    return g.id;
  }

  /** Adds a G to P p's local queue, with no runnext. This sets up a start state. */
  enqueue(prog: GOp[], p = 0): number {
    const g: G = { id: this.nextG++, state: "runnable", prog, pc: 0, left: 0, onM: null, slice: 0 };
    this.gs.set(g.id, g);
    this.stats.spawned++;
    this.runqput(this.ps[p]!, g.id, false);
    return g.id;
  }

  private runqput(p: P, g: number, next: boolean) {
    if (next) {
      const old = p.runnext;
      p.runnext = g;
      if (old === null) return;
      g = old;
    }
    if (p.q.length < LOCAL_QUEUE_CAP) { p.q.push(g); return; }
    // runqputslow: half of the local queue and this G go to the global queue.
    const half = p.q.splice(0, Math.floor(p.q.length / 2));
    this.globalQ.push(...half, g);
    this.stats.toGlobal += half.length + 1;
  }

  /** An M for P p: an idle one, else a new one. */
  private startM(p: P) {
    let m = this.ms.find((x) => x.state === "idle");
    if (!m) {
      if (this.ms.length >= MAX_THREADS) throw new Error("program exceeds 10000-thread limit");
      m = { id: this.ms.length, p: null, g: null, syscallLeft: 0, syscallFor: 0, state: "idle", oldP: null };
      this.ms.push(m);
      this.stats.mCreated++;
      this.ev("newM", `The runtime starts a new OS thread, M${m.id}, for P${p.id}.`);
    }
    m.state = "running";
    m.p = p.id;
    p.m = m.id;
  }

  /** Work that an idle P could take now. */
  private workExists(except?: P): boolean {
    if (this.globalQ.length > 0) return true;
    return this.ps.some((p) => p !== except && (p.q.length > 0));
  }

  private findRunnable(p: P): number | null {
    p.tick++;
    if (p.tick % GLOBAL_CHECK_EVERY === 0 && this.globalQ.length > 0) {
      this.ev("global", `P${p.id} checks the global queue first. It does this on each ${GLOBAL_CHECK_EVERY}st pass, so that no G there starves.`);
      return this.globalQ.shift()!;
    }
    if (p.runnext !== null) { const g = p.runnext; p.runnext = null; return g; }
    if (p.q.length > 0) return p.q.shift()!;
    if (this.globalQ.length > 0) {
      const n = Math.min(this.globalQ.length, Math.floor(this.globalQ.length / this.ps.length) + 1, Math.floor(LOCAL_QUEUE_CAP / 2));
      const batch = this.globalQ.splice(0, n);
      p.q.push(...batch.slice(1));
      this.ev("global", `P${p.id} has nothing local, so it takes ${n} G${n === 1 ? "" : "s"} from the global queue.`);
      return batch[0]!;
    }
    return this.steal(p);
  }

  private steal(p: P): number | null {
    const victims = this.ps.filter((x) => x !== p && x.q.length > 0);
    if (victims.length === 0) return null;
    const v = victims[Math.floor(this.rng() * victims.length)]!;
    const n = v.q.length - Math.floor(v.q.length / 2);
    const taken = v.q.splice(0, n);
    const last = taken.pop()!;
    p.q.push(...taken);
    this.stats.steals++;
    this.stats.stolenGs += n;
    this.ev("steal", `P${p.id} is out of work, so it steals ${n} G${n === 1 ? "" : "s"} from P${v.id}: half of that queue.`);
    return last;
  }

  /** One tick of the whole system. */
  step() {
    this.tick++;
    this.finishSyscalls();
    this.sysmon();
    this.wakeIdleP();
    for (const p of this.ps) if (p.m !== null) this.runP(p);
    this.parkIdle();
  }

  private finishSyscalls() {
    for (const m of this.ms) {
      if (m.state !== "syscall") continue;
      m.syscallLeft--;
      m.syscallFor++;
      if (m.syscallLeft > 0) continue;
      const g = this.gs.get(m.g!)!;
      g.pc++;
      g.left = 0;
      let p: P | undefined;
      if (m.p !== null) {
        p = this.ps[m.p]!; // The P never left: a short syscall.
      } else {
        const old = m.oldP !== null ? this.ps[m.oldP]! : undefined;
        p = old && old.m === null ? old : this.ps.find((x) => x.m === null);
      }
      m.oldP = null;
      if (p) {
        m.p = p.id;
        p.m = m.id;
        p.cur = g.id;
        m.state = "running";
        g.state = "running";
        g.onM = m.id;
        g.slice = 0;
        this.ev("return", `G${g.id} returns from its syscall. M${m.id} gets P${p.id}, and G${g.id} keeps running.`);
      } else {
        g.state = "runnable";
        g.onM = null;
        this.globalQ.push(g.id);
        this.stats.toGlobal++;
        m.g = null;
        m.state = "idle";
        this.ev("return", `G${g.id} returns from its syscall, but no P is free. G${g.id} goes on the global queue, and M${m.id} parks.`);
      }
    }
  }

  /** sysmon: retake a P from a long syscall if other work needs it. */
  private sysmon() {
    for (const m of this.ms) {
      if (m.state !== "syscall" || m.p === null || m.syscallFor < RETAKE_TICKS) continue;
      const p = this.ps[m.p]!;
      const others = p.q.length > 0 || p.runnext !== null || this.globalQ.length > 0 || this.ps.some((x) => x !== p && x.q.length > 0);
      if (!others) continue;
      m.oldP = p.id;
      m.p = null;
      p.m = null;
      p.cur = null;
      this.stats.handoffs++;
      this.ev("handoff", `sysmon sees G${m.g} stuck in a syscall on M${m.id}, and it takes P${p.id} away. G${m.g} and M${m.id} stay in the kernel.`);
      this.startM(p);
    }
  }

  /** wakep: an idle P with no M gets one when work exists. */
  private wakeIdleP() {
    for (const p of this.ps) {
      if (p.m !== null) continue;
      if (p.q.length > 0 || p.runnext !== null || this.workExists(p)) this.startM(p);
    }
  }

  private runP(p: P) {
    const mid = p.m!;
    const m = this.ms[mid]!;
    if (m.state === "syscall") return;
    if (p.cur === null) {
      const gid = this.findRunnable(p);
      if (gid === null) return;
      const g = this.gs.get(gid)!;
      g.state = "running";
      g.onM = mid;
      g.slice = 0;
      p.cur = gid;
      m.g = gid;
      this.ev("start", `P${p.id} on M${mid} runs G${gid}.`);
    }
    const g = this.gs.get(p.cur)!;
    m.g = g.id;
    this.advance(g, p, m);
  }

  private advance(g: G, p: P, m: M) {
    // Spawns take no time.
    while (g.pc < g.prog.length && g.prog[g.pc]!.op === "spawn") {
      const op = g.prog[g.pc] as Extract<GOp, { op: "spawn" }>;
      const id = this.go(op.prog, p.id);
      this.ev("spawn", `G${g.id} runs a go statement. New G${id} goes in the runnext slot of P${p.id}.`);
      g.pc++;
    }
    if (g.pc >= g.prog.length) { this.finish(g, p, m); return; }
    const op = g.prog[g.pc]!;
    if (op.op === "syscall") {
      g.state = "syscall";
      m.state = "syscall";
      m.syscallLeft = op.ticks;
      m.syscallFor = 0;
      this.ev("syscall", `G${g.id} enters a blocking syscall. M${m.id} goes into the kernel with it. P${p.id} waits a moment.`);
      return;
    }
    if (op.op === "run") {
      if (g.left === 0) g.left = op.ticks;
      g.left--;
      g.slice++;
      if (g.left === 0) {
        g.pc++;
        if (g.pc >= g.prog.length) { this.finish(g, p, m); return; }
      } else if (g.slice >= TIME_SLICE_TICKS) {
        g.state = "runnable";
        g.onM = null;
        g.slice = 0;
        this.globalQ.push(g.id);
        this.stats.toGlobal++;
        this.stats.preempted++;
        p.cur = null;
        m.g = null;
        this.ev("preempt", `G${g.id} used its time slice. It is preempted and goes on the global queue.`);
      }
    }
  }

  private finish(g: G, p: P, m: M) {
    g.state = "done";
    g.onM = null;
    p.cur = null;
    m.g = null;
    this.ev("done", `G${g.id} finishes.`);
  }

  /** An M with no G and a P with no work: detach. The M parks and the P goes idle. */
  private parkIdle() {
    for (const p of this.ps) {
      if (p.m === null || p.cur !== null || p.runnext !== null || p.q.length > 0) continue;
      if (this.workExists(p)) continue;
      const m = this.ms[p.m]!;
      if (m.state === "syscall") continue;
      m.state = "idle";
      m.p = null;
      m.g = null;
      p.m = null;
    }
  }

  get done() { return [...this.gs.values()].every((g) => g.state === "done"); }

  /** Where each G is. Throws nothing. Returns every broken rule. */
  check(): string[] {
    const bad: string[] = [];
    const seen = new Map<number, number>();
    const note = (g: number) => seen.set(g, (seen.get(g) ?? 0) + 1);
    for (const g of this.globalQ) note(g);
    for (const p of this.ps) {
      for (const g of p.q) note(g);
      if (p.runnext !== null) note(p.runnext);
      if (p.cur !== null) note(p.cur);
      if (p.q.length > LOCAL_QUEUE_CAP) bad.push(`P${p.id} queue over capacity`);
      if (p.m !== null && this.ms[p.m]!.p !== p.id) bad.push(`P${p.id} and M${p.m} disagree`);
      if (p.cur !== null && p.m === null) bad.push(`P${p.id} has a current G with no M`);
    }
    for (const m of this.ms) {
      if (m.state === "syscall" && m.p === null) note(m.g!);
      if (m.state === "idle" && (m.p !== null || m.g !== null)) bad.push(`idle M${m.id} holds something`);
      if (m.p !== null && this.ps[m.p]!.m !== m.id) bad.push(`M${m.id} and P${m.p} disagree`);
    }
    for (const g of this.gs.values()) {
      const n = seen.get(g.id) ?? 0;
      if (g.state === "done" && n !== 0) bad.push(`done G${g.id} is still queued`);
      if (g.state !== "done" && n !== 1) bad.push(`G${g.id} (${g.state}) is in ${n} places`);
    }
    const onP = this.ps.filter((p) => p.m !== null).length;
    if (onP > this.ps.length) bad.push("more Ms with a P than GOMAXPROCS");
    return bad;
  }
}

export type GmpScenario = "handoff" | "steal" | "fanout";

export const SCENARIO_LABEL: Record<GmpScenario, string> = { handoff: "Blocking syscall", steal: "Work stealing", fanout: "Fan-out" };

const run = (ticks: number): GOp => ({ op: "run", ticks });
const sys = (ticks: number): GOp => ({ op: "syscall", ticks });

export function scenario(s: GmpScenario, gomaxprocs: number): Gmp {
  const g = new Gmp(gomaxprocs, 7);
  if (s === "handoff") {
    g.enqueue([run(1), sys(8), run(2)]);
    g.enqueue([run(3)]);
    g.enqueue([run(3)]);
    g.enqueue([run(3)]);
  } else if (s === "steal") {
    for (let i = 0; i < 8; i++) g.enqueue([run(4)]);
  } else {
    const child = (n: number): GOp => ({ op: "spawn", prog: [run(n), sys(2), run(1)] });
    g.enqueue([run(1), child(2), run(1), child(3), run(1), child(2), run(1), child(4), run(1), child(2), run(2)]);
  }
  return g;
}

/** Runs until all Gs finish. */
export function runToEnd(g: Gmp, maxTicks = 100000): Gmp {
  while (!g.done && g.tick < maxTicks) g.step();
  return g;
}

/** A random program for fuzz tests. */
export function randomProgram(rng: Rng, depth = 0): GOp[] {
  const n = 1 + Math.floor(rng() * 6);
  const prog: GOp[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    if (r < 0.5) prog.push(run(1 + Math.floor(rng() * 25)));
    else if (r < 0.8) prog.push(sys(1 + Math.floor(rng() * 12)));
    else if (depth < 3) prog.push({ op: "spawn", prog: randomProgram(rng, depth + 1) });
  }
  return prog.length ? prog : [run(1)];
}
