/**
 * One out-of-order core, cycle by cycle, for the whole ooo module. It is trace-driven: the shared hart supplies every
 * instruction with its values (oracle.ts), and the core decides only WHEN each one is fetched, renamed, issued,
 * completed and committed. Loads are the exception: the core reads their value itself, from store-to-load forwarding
 * or from its own committed memory, so a load that runs too early really reads a stale value. Every committed load
 * is checked against the hart; `errors` lists any mismatch (tests require none).
 *
 * Each cycle runs these phases, in this order, so that a resource freed in cycle t is used from cycle t + 1:
 *  1. Resolve. A store whose address becomes known checks younger loads that already ran (a memory-order violation
 *     squashes the oldest such load and everything younger). A mispredicted branch that completes squashes everything
 *     younger (recover "execute"). Only the oldest squash point acts.
 *  2. Commit, in order, up to `width`: the ROB head must be complete. Commit frees the previous physical register of
 *     rd, writes a store to memory (and the cache), and raises a fault (trap: squash all, stop).
 *  3. Issue, oldest first, limited by functional units: sources ready (a result is usable in the cycle its producer's
 *     result is on the bus), a free result-bus slot reserved for the result, and the load and store rules below.
 *  4. Rename, in order, up to `width`, from instructions fetched at least `frontDepth` cycles ago. It needs a ROB entry,
 *     an issue-queue (or reservation-station) entry, a load- or store-queue entry, and a free physical register.
 *  5. Fetch, up to `width`, ending after a predicted-taken branch or jump. After a mispredicted branch, fetch follows
 *     the wrong path until the squash.
 *
 * Loads and stores. A store issues its address part when rs1 is ready (address known `agu` cycles later); its data
 * arrives when rs2's producer is done; it completes when both are known. A load searches older stores, youngest
 * first: a known address that covers the load and has its data forwards it (latency `hit`); a partial overlap, or data
 * not ready, makes the load wait; an unknown address makes it wait under "conservative", or under "store-sets" when it
 * is the predicted store. A system instruction (ecall, ebreak, fence) issues only at the ROB head, and no younger
 * instruction issues before it completes, like x86 LFENCE. That is a property of this model: the RISC-V `fence`
 * instruction orders memory accesses, and the ISA does not say that it stops speculation.
 *
 * Simplifications: one micro-op per instruction; jumps always predicted right (an ideal BTB and return stack); the
 * branch predictor is trained in program order at the first fetch of each branch; wrong-path branches follow their own
 * outcomes; stores write memory at commit (no post-commit store buffer); no instruction cache; a squashed instruction's
 * miss still fills the cache when it returns (as in hardware); the divider stays busy after a squash.
 */
import { makePredictor, type Predictor } from "../../perf/cpu";
import { disasm, type Program } from "../rv";
import {
  resolveConfig, type Frame, type OooConfig, type OooOptions, type OooResult, type OooStats, type SquashCause, type Unit, type Uop,
  type UopState, type UopView,
} from "./config";
import { Oracle, type FetchInst, type WrongPath } from "./oracle";

const unitOf = (cls: Uop["cls"]): Unit => (cls === "mul" ? "mul" : cls === "div" ? "div" : cls === "load" || cls === "store" ? "mem" : "alu");
const overlap = (a: Uop, b: Uop) => a.addr < b.addr + b.size && b.addr < a.addr + a.size;
const covers = (st: Uop, ld: Uop) => st.addr <= ld.addr && ld.addr + ld.size <= st.addr + st.size;
/**
 * A store's address is visible to loads that issue in the same cycle as its address part or later: both compute
 * their addresses in parallel, and the load checks the store queue in its next stage, when both addresses exist.
 */
const staDone = (st: Uop, t: number) => st.issue >= 0 && st.issue <= t;

export class OooCore {
  readonly cfg: OooConfig;
  readonly program: Program;
  readonly oracle: Oracle;
  cycle = 0;
  done = false;
  status: OooResult["status"] = "end";
  trapErr: OooResult["trap"] = null;
  readonly uops: Uop[] = [];
  readonly frames: Frame[] = [];
  readonly occupancy: { rob: number; wrong: number }[] = [];
  readonly errors: string[] = [];
  readonly stats: OooStats = {
    fetched: 0, committed: 0, wrongPath: 0, replayed: 0, branches: 0, mispredicts: 0, violations: 0, forwards: 0, loads: 0,
    misses: 0, renameStalls: { rob: 0, iq: 0, lsq: 0, regs: 0 }, cdbWaits: 0, cdbWaitCycles: 0, robAvg: 0, robMax: 0,
  };

  // front end
  private nextSeq = 0;
  private wrong: WrongPath | null = null;
  private readonly fq: Uop[] = [];
  private readonly predictor: Predictor | null;
  private readonly predicted = new Map<number, boolean>();
  private readonly fetchedSeqs = new Set<number>();
  private nextId = 0;
  private endFetch = false;

  // back end
  private readonly rob: Uop[] = [];
  private readonly iq: Uop[] = [];
  private readonly lq: Uop[] = [];
  private readonly sq: Uop[] = [];
  readonly rat: number[] = Array.from({ length: 32 }, (_, r) => r);
  readonly rrat: number[] = Array.from({ length: 32 }, (_, r) => r);
  readonly free: number[] = [];
  readonly prfVal: number[];
  /** The producer of each physical register's current value (null: architectural, ready). */
  private readonly prfProd: (Uop | null)[];
  private readonly writer: (Uop | null)[] = Array(32).fill(null);
  readonly archVal: number[];
  readonly mem: Uint8Array;
  private readonly cdbUse = new Map<number, number>();
  private divBusyUntil = 0;
  private robTail = 0;

  // cache: line address -> fill cycle and last use
  private readonly cache = new Map<number, { fill: number; used: number }>();

  // store sets
  private readonly ssit = new Map<number, number>();
  private readonly lfst = new Map<number, Uop>();
  private nextSsid = 0;

  // per-cycle log
  private log: { fetched: number[]; renamed: number[]; issued: number[]; committed: number[]; squashed: Frame["squashed"]; stall: string | null; events: string[] } = this.freshLog();
  private robSum = 0;
  private readonly names: Map<number, string>;

  constructor(program: Program, opts: OooOptions = {}) {
    this.cfg = resolveConfig(opts);
    this.program = program;
    this.oracle = new Oracle(program, this.cfg.memBytes);
    this.mem = this.oracle.initialMem.slice();
    const n = this.cfg.rename ? this.cfg.physRegs : 32;
    this.prfVal = Array(n).fill(0);
    this.prfProd = Array(n).fill(null);
    for (let p = 32; p < n; p++) this.free.push(p);
    this.archVal = Array.from(this.oracle.hart.regs);
    for (let r = 0; r < 32; r++) this.prfVal[r] = this.archVal[r]!;
    const b = this.cfg.branch;
    this.predictor = b === "two-bit" || b === "gshare" ? makePredictor(b) : null;
    this.names = new Map<number, string>();
    for (const [name, a] of Object.entries(program.labels)) if (!this.names.has(a)) this.names.set(a, name);
  }

  private freshLog() {
    return { fetched: [] as number[], renamed: [] as number[], issued: [] as number[], committed: [] as number[], squashed: null as Frame["squashed"], stall: null as string | null, events: [] as string[] };
  }

  // ---------------------------------------------------------------- fetch

  private makeUop(f: FetchInst, seq: number, wrong: boolean): Uop {
    const d = f.d;
    const srcs: number[] = [];
    if (d.rs1) srcs.push(d.rs1);
    if (d.rs2) srcs.push(d.rs2);
    const replay = !wrong && this.fetchedSeqs.has(seq);
    if (!wrong) this.fetchedSeqs.add(seq);
    const text = f.fault && d.cls === "system" && d.word !== 0 ? `illegal 0x${(d.word >>> 0).toString(16)}` : disasm(d.inst, d.pc, { pseudo: true, symbol: (a) => this.names.get(a) });
    return {
      id: this.nextId++, seq, d, text, wrong, replay, cls: d.cls, unit: unitOf(d.cls), rd: f.rd, srcs,
      fetch: this.cycle, rename: -1, issue: -1, ready: -1, commit: -1, squash: -1, squashCause: null,
      pd: -1, old: -1, ps: [], prod: [], prevWriter: null, pred: null, mispredict: false, fault: f.fault,
      addr: d.memAddr ?? 0, size: d.memSize ?? 0, addrAt: -1, fwd: null, waitStore: null, value: d.result, missed: false, why: "", slot: -1,
    };
  }

  private fetchPhase() {
    const t = this.cycle, c = this.cfg;
    const cap = c.width * (c.frontDepth + 1);
    for (let n = 0; n < c.width && this.fq.length < cap; n++) {
      let f: FetchInst | null, u: Uop;
      if (this.wrong) {
        f = this.wrong.next();
        if (!f) break;
        u = this.makeUop(f, -1, true);
        this.stats.wrongPath++;
      } else {
        if (this.endFetch) break;
        f = this.oracle.at(this.nextSeq);
        if (!f) { this.endFetch = true; break; }
        u = this.makeUop(f, this.nextSeq, false);
        if (u.replay) this.stats.replayed++;
        this.nextSeq++;
        if (f.last && !f.fault) this.endFetch = true;
      }
      this.stats.fetched++;
      this.fq.push(u);
      if (this.cfg.timeline) this.uops.push(u);
      this.log.fetched.push(u.id);
      let takenNow = u.cls === "jump" || (u.cls === "branch" && !!u.d.taken);
      if (!u.wrong && u.cls === "branch") {
        const pred = this.predict(u);
        u.pred = pred;
        u.mispredict = pred !== !!u.d.taken;
        takenNow = pred;
        if (u.mispredict) {
          const target = pred ? (u.d.pc + u.d.inst.imm) >>> 0 : (u.d.pc + 4) >>> 0;
          this.wrong = this.oracle.fork(target, u.seq + 1);
        }
      }
      if (!u.wrong && u.fault) {
        this.wrong = this.oracle.fork((u.d.pc + 4) >>> 0, u.seq);
        this.endFetch = true;
      }
      if (takenNow) break;
      void t;
    }
  }

  private predict(u: Uop): boolean {
    const seen = this.predicted.get(u.seq);
    if (seen !== undefined) return seen;
    const taken = !!u.d.taken;
    let p: boolean;
    switch (this.cfg.branch) {
      case "perfect": p = taken; break;
      case "not-taken": p = false; break;
      default: p = this.predictor!.predict(u.d.pc >>> 2); this.predictor!.update(u.d.pc >>> 2, taken);
    }
    this.predicted.set(u.seq, p);
    return p;
  }

  // ---------------------------------------------------------------- rename

  private renamePhase() {
    const t = this.cycle, c = this.cfg;
    for (let n = 0; n < c.width && this.fq.length; n++) {
      const u = this.fq[0]!;
      if (u.fetch + c.frontDepth > t) break;
      let stall: keyof OooStats["renameStalls"] | null = null;
      if (this.rob.length >= c.robSize) stall = "rob";
      else if (c.rs ? this.iq.filter((x) => x.unit === u.unit).length >= c.rs[u.unit] : this.iq.length >= c.iqSize) stall = "iq";
      else if ((u.cls === "load" && this.lq.length >= c.lqSize) || (u.cls === "store" && this.sq.length >= c.sqSize)) stall = "lsq";
      else if (c.rename && u.rd && this.free.length === 0) stall = "regs";
      if (stall) {
        this.stats.renameStalls[stall]++;
        this.log.stall = stall === "rob" ? "ROB full" : stall === "iq" ? (c.rs ? "reservation stations full" : "issue queue full") : stall === "lsq" ? "load/store queue full" : "no free physical register";
        break;
      }
      this.fq.shift();
      u.rename = t;
      u.slot = this.robTail++ % c.robSize;
      u.ps = u.srcs.map((r) => this.rat[r]!);
      u.prod = u.srcs.map((r) => this.writer[r] ?? null);
      if (u.rd) {
        u.old = this.rat[u.rd]!;
        u.pd = c.rename ? this.free.shift()! : u.rd;
        this.rat[u.rd] = u.pd;
        u.prevWriter = this.writer[u.rd]!;
        this.writer[u.rd] = u;
        if (c.rename) this.prfProd[u.pd] = u;
      }
      if (c.memDep === "store-sets") {
        const id = this.ssit.get(u.d.pc);
        if (id !== undefined) {
          if (u.cls === "load") u.waitStore = this.lfst.get(id) ?? null;
          if (u.cls === "store") this.lfst.set(id, u);
        }
      }
      this.rob.push(u);
      this.iq.push(u);
      if (u.cls === "load") this.lq.push(u);
      if (u.cls === "store") this.sq.push(u);
      this.log.renamed.push(u.id);
    }
  }

  // ---------------------------------------------------------------- issue

  private isReady(p: Uop | null): boolean { return !p || (p.ready >= 0 && p.ready <= this.cycle); }
  private prodOf(u: Uop, reg: number): Uop | null { return reg ? u.prod[u.srcs.indexOf(reg)] ?? null : null; }
  /** When a store's data is ready, or -1 if not known yet. */
  dataAt(st: Uop): number {
    const p = this.prodOf(st, st.d.rs2);
    return !p ? st.rename : p.ready;
  }

  /** Reserve a result-bus slot at or after cycle `at`. */
  private bus(at: number): number {
    let c = at;
    while ((this.cdbUse.get(c) ?? 0) >= this.cfg.cdb) c++;
    this.cdbUse.set(c, (this.cdbUse.get(c) ?? 0) + 1);
    if (c > at) { this.stats.cdbWaits++; this.stats.cdbWaitCycles += c - at; }
    return c;
  }

  /** For a load that may issue now: the store to forward from (or null), or a reason to wait. */
  private loadPlan(u: Uop): { fwd: Uop | null } | string {
    const t = this.cycle;
    if (u.waitStore && u.waitStore.squash < 0 && !staDone(u.waitStore, t)) return "waits for the store its store set predicts";
    for (let i = this.sq.length - 1; i >= 0; i--) {
      const st = this.sq[i]!;
      if (st.id > u.id) continue;
      if (!staDone(st, t)) {
        if (this.cfg.memDep === "conservative") return "an older store address is unknown";
        continue;
      }
      if (!overlap(st, u)) continue;
      if (!covers(st, u)) return "partial overlap with an older store: waits for it to commit";
      const da = this.dataAt(st);
      if (da < 0 || da > t) return "the matching store has no data yet";
      return { fwd: st };
    }
    return { fwd: null };
  }

  private canIssue(u: Uop, systemBlock: number): string | null {
    const c = this.cfg;
    if (u.id > systemBlock) return "an older fence or ecall has not completed";
    if (u.cls === "system") return this.rob[0] === u ? null : "waits to be the oldest instruction";
    if (u.cls === "load" || u.cls === "store") {
      if (!this.isReady(this.prodOf(u, u.d.rs1))) return "address register not ready";
    } else {
      for (let k = 0; k < u.prod.length; k++) if (!this.isReady(u.prod[k]!)) return `waits for ${u.srcs.length > 1 ? (k === 0 ? "the first source" : "the second source") : "its source"}`;
    }
    if (!c.rename && u.rd) {
      for (const o of this.rob) {
        if (o.id >= u.id) break;
        if (o.rd === u.rd && !(o.ready >= 0 && o.ready <= this.cycle)) return "write after write: an older write of the same register";
        if (o.issue < 0 && o.srcs.includes(u.rd)) return "write after read: an older reader has not read the register";
      }
    }
    return null;
  }

  private issuePhase() {
    const t = this.cycle, c = this.cfg;
    const used: Record<Unit, number> = { alu: 0, mul: 0, div: 0, mem: 0 };
    let systemBlock = Infinity;
    for (const o of this.rob) if (o.cls === "system" && !(o.ready >= 0 && o.ready <= t)) { systemBlock = o.id; break; }
    for (let i = 0; i < this.iq.length; i++) {
      const u = this.iq[i]!;
      if (used[u.unit] >= c.units[u.unit]) { u.why = `no free ${u.unit === "mem" ? "memory port" : u.unit === "alu" ? "ALU" : u.unit === "mul" ? "multiplier" : "divider"}`; continue; }
      if (u.unit === "div" && this.divBusyUntil > t) { u.why = "the divider is busy"; continue; }
      const why = this.canIssue(u, systemBlock);
      if (why) { u.why = why; continue; }
      let lat = c.lat.alu;
      if (u.cls === "load" && !u.fault) {
        const plan = this.loadPlan(u);
        if (typeof plan === "string") { u.why = plan; continue; }
        lat = this.loadAccess(u, plan.fwd);
      } else if (u.cls === "load" || u.cls === "store") lat = c.lat.agu;
      else if (u.unit === "mul") lat = c.lat.mul;
      else if (u.unit === "div") { lat = c.lat.div; this.divBusyUntil = t + lat; }
      used[u.unit]++;
      u.issue = t;
      u.why = "";
      this.iq.splice(i--, 1);
      this.log.issued.push(u.id);
      if (u.cls === "store") {
        u.addrAt = t + lat;
        if (c.memDep === "store-sets") { const id = this.ssit.get(u.d.pc); if (id !== undefined && this.lfst.get(id) === u) this.lfst.delete(id); }
        continue; // completes when its data is known too (resolve phase)
      }
      u.ready = u.rd && !u.fault ? this.bus(t + lat) : t + lat;
      if (u.rd && c.rename) this.prfVal[u.pd] = u.value | 0;
    }
  }

  /** A load reads its value now (forwarded or from committed memory) and touches the cache. Returns its latency. */
  private loadAccess(u: Uop, fwd: Uop | null): number {
    const t = this.cycle, c = this.cfg;
    this.stats.loads++;
    u.fwd = fwd;
    const signed = u.d.inst.op === "lb" || u.d.inst.op === "lh";
    let raw = 0;
    if (fwd) {
      this.stats.forwards++;
      raw = (fwd.d.result >>> (8 * (u.addr - fwd.addr))) >>> 0;
    } else for (let k = u.size - 1; k >= 0; k--) raw = ((raw << 8) | (this.mem[u.addr + k] ?? 0)) >>> 0;
    if (u.size < 4) raw &= (1 << (8 * u.size)) - 1;
    const v = signed ? (raw << (32 - 8 * u.size)) >> (32 - 8 * u.size) : raw | 0;
    if (!u.wrong) u.value = v; // a wrong-path load keeps the fork's value
    if (fwd) return c.lat.hit;
    return this.cacheAccess(u.addr, t, u);
  }

  private cacheAccess(addr: number, t: number, u: Uop | null): number {
    const c = this.cfg;
    if (c.cache.perfect) return c.lat.hit;
    const line = addr - (addr % c.cache.lineBytes);
    if (c.cache.flushed.some(([lo, hi]) => addr >= lo && addr < hi)) { this.stats.misses++; if (u) u.missed = true; return c.lat.miss; }
    const e = this.cache.get(line);
    if (e) { e.used = t; return Math.max(c.lat.hit, e.fill - t); }
    this.stats.misses++;
    if (u) u.missed = true;
    if (this.cache.size >= c.cache.lines) {
      let lru = -1, best = Infinity;
      for (const [l, x] of this.cache) if (x.used < best) { best = x.used; lru = l; }
      this.cache.delete(lru);
    }
    this.cache.set(line, { fill: t + c.lat.miss, used: t });
    return c.lat.miss;
  }

  // ---------------------------------------------------------------- resolve and squash

  private resolvePhase() {
    const t = this.cycle;
    for (const st of this.sq) {
      if (st.ready >= 0 || st.addrAt < 0) continue;
      const da = st.fault ? st.addrAt : this.dataAt(st);
      if (da >= 0) st.ready = Math.max(st.addrAt, da);
    }
    type Ev = { first: number; nextSeq: number; cause: SquashCause; by: Uop; store?: Uop };
    const evs: Ev[] = [];
    const consider = (e: Ev) => { evs.push(e); };
    for (const st of this.sq) {
      if (st.wrong || st.fault || st.addrAt !== t) continue;
      for (const ld of this.lq) {
        if (ld.id < st.id || ld.wrong || ld.fault || ld.issue < 0 || ld.issue >= st.issue || !overlap(st, ld)) continue;
        if (ld.fwd && ld.fwd.id > st.id) continue;
        consider({ first: ld.id, nextSeq: ld.seq, cause: "violation", by: ld, store: st });
        break;
      }
    }
    if (this.cfg.recover === "execute") {
      for (const u of this.rob) if (u.cls === "branch" && u.mispredict && !u.wrong && u.ready === t) { consider({ first: u.id + 1, nextSeq: u.seq + 1, cause: "mispredict", by: u }); break; }
    }
    if (!evs.length) return;
    const b = evs.reduce((x, y) => (y.first < x.first ? y : x));
    if (b.cause === "violation") {
      this.stats.violations++;
      this.log.events.push(`Memory-order violation: ${b.store!.text} wrote the bytes that ${b.by.text} already read. Squash from the load.`);
      if (this.cfg.memDep === "store-sets") this.train(b.store!.d.pc, b.by.d.pc);
    } else this.log.events.push(`${b.by.text} was mispredicted. Squash everything younger.`);
    this.squash(b.first, b.cause, b.by, b.nextSeq);
  }

  /** Store-set training after a violation: put the load and the store in one set (simplified merge: the smaller id). */
  private train(storePc: number, loadPc: number) {
    const a = this.ssit.get(storePc), l = this.ssit.get(loadPc);
    const id = a === undefined && l === undefined ? this.nextSsid++ : Math.min(a ?? Infinity, l ?? Infinity);
    this.ssit.set(storePc, id);
    this.ssit.set(loadPc, id);
  }

  /** Squash every instruction with id >= first, restore the rename state, and send fetch to `nextSeq` (-1: stop). */
  private squash(first: number, cause: SquashCause, by: Uop, nextSeq: number) {
    const t = this.cycle;
    let count = 0;
    const kill = (u: Uop) => { u.squash = t; u.squashCause = cause; count++; };
    for (const u of this.fq) kill(u);
    this.fq.length = 0;
    while (this.rob.length && this.rob[this.rob.length - 1]!.id >= first) {
      const u = this.rob.pop()!;
      kill(u);
      this.robTail--;
      if (u.rd) {
        this.rat[u.rd] = u.old;
        if (this.cfg.rename) this.free.unshift(u.pd);
        const pw = u.prevWriter;
        this.writer[u.rd] = pw && pw.commit < 0 && pw.squash < 0 ? pw : null;
        if (u.ready > t && u.issue >= 0) this.cdbUse.set(u.ready, (this.cdbUse.get(u.ready) ?? 1) - 1);
      }
    }
    const alive = (u: Uop) => u.squash < 0;
    for (const q of [this.iq, this.lq, this.sq]) { const keep = q.filter(alive); q.length = 0; q.push(...keep); }
    for (const [id, st] of this.lfst) if (st.squash >= 0) this.lfst.delete(id);
    this.wrong = null;
    if (nextSeq >= 0) { this.nextSeq = nextSeq; this.endFetch = false; } else this.endFetch = true;
    this.log.squashed = { count, cause, by: by.id };
  }

  // ---------------------------------------------------------------- commit

  private commitPhase() {
    const t = this.cycle, c = this.cfg;
    for (let n = 0; n < c.width && this.rob.length; n++) {
      const u = this.rob[0]!;
      if (!(u.ready >= 0 && u.ready <= t)) break;
      if (u.wrong) { this.errors.push(`cycle ${t}: a wrong-path instruction reached commit: ${u.text}`); this.done = true; break; }
      if (u.fault) {
        this.log.events.push(`${u.text} faults at the ROB head: ${u.fault.message}. Squash everything, then trap.`);
        this.squash(u.id + 1, "trap", u, -1);
        this.rob.shift();
        u.squash = t; u.squashCause = "trap";
        this.status = "trap"; this.trapErr = u.fault; this.done = true;
        break;
      }
      this.rob.shift();
      if (u.cls === "load") this.lq.shift();
      if (u.cls === "store") this.sq.shift();
      u.commit = t;
      this.stats.committed++;
      this.log.committed.push(u.id);
      if (u.rd) {
        this.archVal[u.rd] = u.value | 0;
        this.rrat[u.rd] = u.pd;
        if (c.rename) this.free.push(u.old);
        if (this.writer[u.rd] === u) this.writer[u.rd] = null;
      }
      if (u.cls === "load" && (u.value | 0) !== (u.d.result | 0)) this.errors.push(`cycle ${t}: ${u.text} (seq ${u.seq}) committed ${u.value | 0}, the hart read ${u.d.result | 0}`);
      if (u.cls === "store") {
        for (let k = 0; k < u.size; k++) this.mem[u.addr + k] = (u.d.result >>> (8 * k)) & 0xff;
        if (!c.cache.perfect && !c.cache.flushed.some(([lo, hi]) => u.addr >= lo && u.addr < hi)) {
          const line = u.addr - (u.addr % c.cache.lineBytes);
          const e = this.cache.get(line);
          if (e) e.used = t; else this.cacheFill(line, t);
        }
      }
      if (u.cls === "branch") { this.stats.branches++; if (u.mispredict) this.stats.mispredicts++; }
      const last = this.oracle.list[u.seq]!.last;
      if (u.mispredict && c.recover === "commit") {
        this.log.events.push(`${u.text} was mispredicted and is now the oldest. Squash everything younger.`);
        this.squash(u.id + 1, "mispredict", u, u.seq + 1);
        break;
      }
      if (last) { this.status = this.oracle.hart.status === "ebreak" ? "ebreak" : "exited"; this.done = true; break; }
    }
  }

  private cacheFill(line: number, t: number) {
    if (this.cache.size >= this.cfg.cache.lines) {
      let lru = -1, best = Infinity;
      for (const [l, x] of this.cache) if (x.used < best) { best = x.used; lru = l; }
      this.cache.delete(lru);
    }
    this.cache.set(line, { fill: t, used: t });
  }

  // ---------------------------------------------------------------- the cycle

  /** Run one cycle. Returns false once the core has stopped. */
  step(): boolean {
    if (this.done) return false;
    this.log = this.freshLog();
    this.resolvePhase();
    this.commitPhase();
    if (!this.done) {
      this.issuePhase();
      this.renamePhase();
      this.fetchPhase();
    }
    const wrong = this.rob.reduce((s, u) => s + (u.wrong ? 1 : 0), 0);
    this.occupancy.push({ rob: this.rob.length, wrong });
    this.robSum += this.rob.length;
    this.stats.robMax = Math.max(this.stats.robMax, this.rob.length);
    if (this.cfg.record && this.frames.length < this.cfg.maxFrames) this.frames.push(this.frame());
    this.cycle++;
    if (!this.done && this.endFetch && !this.wrong && !this.fq.length && !this.rob.length) {
      this.done = true;
      this.status = this.oracle.hart.status === "exited" ? "exited" : this.oracle.hart.status === "ebreak" ? "ebreak" : "end";
    }
    if (!this.done && this.cycle >= this.cfg.maxCycles) { this.done = true; this.status = "timeout"; }
    return !this.done;
  }

  run(): OooResult {
    while (this.step());
    return this.result();
  }

  stateOf(u: Uop, t = this.cycle): UopState {
    if (u.commit >= 0 && u.commit <= t) return "committed";
    if (u.squash >= 0 && u.squash <= t) return "squashed";
    if (u.rename < 0 || u.rename > t) return "front";
    if (u.issue < 0 || u.issue > t) return "waiting";
    if (u.ready < 0 || u.ready > t) return "executing";
    return "done";
  }

  view(u: Uop, t = this.cycle): UopView {
    const srcReady = u.prod.map((p) => !p || (p.ready >= 0 && p.ready <= t));
    const srcVal = u.srcs.map((r) => (r === u.d.rs1 ? u.d.rs1Val : u.d.rs2Val));
    const da = u.cls === "store" && u.rename >= 0 ? this.dataAt(u) : -1;
    return {
      id: u.id, seq: u.seq, pc: u.d.pc, text: u.text, wrong: u.wrong, replay: u.replay, cls: u.cls, unit: u.unit, state: this.stateOf(u, t), slot: u.slot,
      rd: u.rd, pd: u.pd, old: u.old, srcs: u.srcs, ps: u.ps, srcReady, srcVal,
      fetch: u.fetch, rename: u.rename, issue: u.issue, ready: u.ready, commit: u.commit, squash: u.squash,
      why: u.why, mispredict: u.mispredict && u.ready >= 0 && u.ready <= t, fault: !!u.fault,
      addr: u.addr, size: u.size, addrKnown: staDone(u, t) && u.cls === "store", dataReady: da >= 0 && da <= t,
      fwdFrom: u.fwd && u.issue >= 0 && u.issue <= t ? u.fwd.id : -1, value: u.value | 0, missed: u.missed,
    };
  }

  private frame(): Frame {
    const t = this.cycle;
    const n = this.prfVal.length;
    const prfReady = Array.from({ length: n }, (_, p) => { const q = this.prfProd[p]; return !q || (q.ready >= 0 && q.ready <= t); });
    const cdb: Frame["cdb"] = [];
    for (const u of [...this.rob, ...this.log.committed.map((id) => this.uops.find((x) => x.id === id)).filter((x): x is Uop => !!x)]) {
      if (u.rd && u.ready === t && u.issue >= 0 && u.issue < t && !u.fault && !cdb.some((x) => x.id === u.id)) cdb.push({ id: u.id, pd: u.pd, value: u.value | 0, text: u.text });
    }
    cdb.sort((a, b) => a.id - b.id);
    return {
      cycle: t, rob: this.rob.map((u) => this.view(u, t)), front: this.fq.map((u) => this.view(u, t)),
      rat: [...this.rat], rrat: [...this.rrat], free: [...this.free], prfReady, prfVal: [...this.prfVal], cdb,
      fetched: this.log.fetched, renamed: this.log.renamed, issued: this.log.issued, committed: this.log.committed,
      squashed: this.log.squashed, stall: this.log.stall, lines: this.presentLines(t), events: this.log.events,
    };
  }

  presentLines(t = this.cycle): number[] {
    if (this.cfg.cache.perfect) return [];
    return [...this.cache].filter(([, e]) => e.fill <= t).map(([l]) => l).sort((a, b) => a - b);
  }

  result(): OooResult {
    const cycles = this.cycle;
    this.stats.robAvg = cycles ? this.robSum / cycles : 0;
    const errors = [...this.errors];
    if (this.cfg.rename) for (let r = 1; r < 32; r++) if ((this.prfVal[this.rrat[r]!]! | 0) !== (this.archVal[r]! | 0)) errors.push(`x${r}: the retirement map points at p${this.rrat[r]} = ${this.prfVal[this.rrat[r]!]}, but the committed value is ${this.archVal[r]}`);
    return {
      config: this.cfg, cycles, ipc: cycles ? this.stats.committed / cycles : 0, stats: { ...this.stats, renameStalls: { ...this.stats.renameStalls } },
      uops: this.uops, frames: this.frames, occupancy: this.occupancy, regs: [...this.archVal], mem: this.mem,
      status: this.status, exitCode: this.status === "exited" ? this.oracle.hart.exitCode : null, trap: this.trapErr, errors,
      lines: this.presentLines(cycles),
    };
  }
}

/** Run a program on the out-of-order core to the end. */
export function runOoo(program: Program, opts: OooOptions = {}): OooResult {
  return new OooCore(program, opts).run();
}
