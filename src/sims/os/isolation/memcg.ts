/**
 * A memory cgroup: the charge path in try_charge_memcg and mem_cgroup_handle_over_high, in MiB steps.
 * Over memory.high: reclaim, then sleep. Over memory.max: reclaim, then the cgroup OOM killer.
 * Clean page cache goes first. Anonymous memory needs swap. The victim comes from the OOM code in ../memory/oom.
 */
import { pickVictim, type OomProc } from "../memory/oom";

/** MEMCG_MAX_HIGH_DELAY_JIFFIES: the longest sleep per return to user mode. */
export const MAX_HIGH_DELAY_MS = 2000;
/** MEMCG_CHARGE_BATCH: pages charged at one go, in the penalty formula. */
export const CHARGE_BATCH_PAGES = 64;
const PAGES_PER_MIB = 256;

/** The kernel's penalty for going over memory.high: 64 * overage^2 seconds per charge batch (DELAY_PRECISION_SHIFT 20, DELAY_SCALING_SHIFT 14). */
export function highPenaltyMs(usage: number, high: number, chargedPages: number): number {
  if (usage <= high) return 0;
  const frac = (usage - high) / high;
  const ms = 64 * frac * frac * 1000 * (chargedPages / CHARGE_BATCH_PAGES);
  // The kernel skips sleeps below 10 ms (HZ / 100).
  return ms < 10 ? 0 : Math.min(MAX_HIGH_DELAY_MS, ms);
}

export type MemEventKind = "alloc" | "reclaim" | "swap" | "high" | "throttle" | "max" | "oom" | "free" | "low";
export interface MemEvent { kind: MemEventKind; text: string }

export interface MemcgConfig { maxMiB: number; highMiB: number; lowMiB?: number; swapMaxMiB?: number; oomGroup?: boolean }
export interface MemProc { name: string; anon: number; swapped: number; alive: boolean; adj: number }

export class Memcg {
  cfg: MemcgConfig;
  procs: MemProc[];
  file = 0;
  /** memory.events */
  counters = { low: 0, high: 0, max: 0, oom: 0, oomKill: 0 };
  reclaimedMiB = 0;
  stallMs = 0;
  peak = 0;
  events: MemEvent[] = [];
  private pendingFile = 0;
  private pendingSwap = 0;

  constructor(cfg: MemcgConfig, procs: { name: string; anon?: number; adj?: number }[] = [{ name: "app" }, { name: "sidecar", anon: 40 }]) {
    this.cfg = cfg;
    this.procs = procs.map((p) => ({ name: p.name, anon: p.anon ?? 0, swapped: 0, alive: true, adj: p.adj ?? 0 }));
  }

  /** memory.current: anonymous memory plus page cache. */
  get current() { return this.procs.reduce((a, p) => a + p.anon, 0) + this.file; }
  get swap() { return this.procs.reduce((a, p) => a + p.swapped, 0); }
  private get swapRoom() { return Math.max(0, (this.cfg.swapMaxMiB ?? 0) - this.swap); }

  /** Frees up to `want` MiB: clean page cache first, then anonymous pages if swap has room. Returns what it freed. */
  private reclaim(want: number, floor = 0): number {
    let need = Math.min(want, Math.max(0, this.current - floor));
    const before = need;
    const f = Math.min(this.file, need);
    this.file -= f;
    need -= f;
    let swapped = 0;
    for (const p of [...this.procs].sort((a, b) => b.anon - a.anon)) {
      if (need <= 0) break;
      const s = Math.min(p.anon, need, this.swapRoom);
      p.anon -= s;
      p.swapped += s;
      need -= s;
      swapped += s;
    }
    const freed = before - need;
    this.reclaimedMiB += freed;
    this.pendingFile += f;
    this.pendingSwap += swapped;
    return freed;
  }

  /** One event per operation, not one per MiB. */
  private flushReclaim() {
    const f = this.pendingFile, s = this.pendingSwap;
    if (f + s > 0) this.events.push({ kind: s ? "swap" : "reclaim", text: `Reclaim freed ${f + s} MiB: ${f} MiB of page cache${s ? `, ${s} MiB of anonymous memory to swap` : ""}.` });
    this.pendingFile = 0;
    this.pendingSwap = 0;
  }

  private oom(): boolean {
    this.flushReclaim();
    this.counters.max++;
    this.counters.oom++;
    const live = this.procs.filter((p) => p.alive);
    const view: OomProc[] = live.map((p) => ({ name: p.name, rssPages: p.anon * PAGES_PER_MIB, swapPages: p.swapped * PAGES_PER_MIB, pgtablePages: 0, adj: p.adj }));
    const total = this.cfg.maxMiB * PAGES_PER_MIB;
    const i = pickVictim(view, total);
    if (i < 0) return false;
    const victims = this.cfg.oomGroup ? live : [live[i]!];
    for (const v of victims) {
      this.counters.oomKill++;
      v.alive = false;
      v.anon = 0;
      v.swapped = 0;
    }
    this.events.push({ kind: "oom", text: this.cfg.oomGroup ? `Cgroup OOM: memory.oom.group kills all ${victims.length} tasks.` : `Cgroup OOM: the kernel kills ${victims[0]!.name}, the largest task in this cgroup.` });
    return true;
  }

  /** Charges 1 MiB. Returns false if the task died or the charge cannot succeed. */
  private chargeOne(charge: () => void, isAlive: () => boolean): boolean {
    if (this.current + 1 > this.cfg.maxMiB) {
      const got = this.reclaim(this.current + 1 - this.cfg.maxMiB);
      if (this.current + 1 > this.cfg.maxMiB && got === 0) {
        if (!this.oom()) return false;
        if (!isAlive()) return false;
      }
    }
    charge();
    this.peak = Math.max(this.peak, this.current);
    if (this.current > this.cfg.highMiB) {
      this.counters.high++;
      const over = this.current - this.cfg.highMiB;
      this.reclaim(over);
      if (this.current > this.cfg.highMiB) {
        const ms = highPenaltyMs(this.current, this.cfg.highMiB, PAGES_PER_MIB);
        this.stallMs += ms;
      }
    }
    return true;
  }

  /** The named task touches `mib` MiB of new anonymous memory. Returns the MiB that it got. */
  allocAnon(name: string, mib: number): number {
    const p = this.procs.find((x) => x.name === name);
    if (!p || !p.alive) { this.events.push({ kind: "alloc", text: `${name} is dead.` }); return 0; }
    const stall0 = this.stallMs, high0 = this.counters.high;
    let got = 0;
    this.events.push({ kind: "alloc", text: `${name} touches ${mib} MiB of anonymous memory.` });
    for (; got < mib; got++) if (!this.chargeOne(() => { p.anon++; }, () => p.alive)) break;
    this.afterCharge(stall0, high0);
    return got;
  }

  /** A task reads a file: the page cache is charged to this cgroup. */
  readFile(mib: number): void {
    const stall0 = this.stallMs, high0 = this.counters.high;
    this.events.push({ kind: "alloc", text: `A read adds ${mib} MiB of page cache.` });
    for (let i = 0; i < mib; i++) if (!this.chargeOne(() => { this.file++; }, () => true)) break;
    this.afterCharge(stall0, high0);
  }

  private afterCharge(stall0: number, high0: number) {
    this.flushReclaim();
    if (this.counters.high > high0) {
      const slept = this.stallMs - stall0;
      this.events.push(slept > 0
        ? { kind: "throttle", text: `Over memory.high and reclaim is not enough: the task sleeps ${Math.round(slept)} ms in total (at most ${MAX_HIGH_DELAY_MS} ms per return to user mode).` }
        : { kind: "high", text: "Over memory.high: reclaim brings the usage back under it, with no sleep." });
    }
  }

  free(name: string, mib: number): void {
    const p = this.procs.find((x) => x.name === name);
    if (!p || !p.alive) return;
    const f = Math.min(p.anon, mib);
    p.anon -= f;
    this.events.push({ kind: "free", text: `${name} frees ${f} MiB.` });
  }

  /** Pressure from outside this cgroup, for example the node or the parent. memory.low protects up to that amount. */
  outsidePressure(mib: number): number {
    const floor = this.cfg.lowMiB ?? 0;
    const protectedNow = this.current <= floor;
    const got = this.reclaim(mib, floor);
    this.flushReclaim();
    if (protectedNow || got < mib) {
      this.counters.low++;
      this.events.push({ kind: "low", text: `memory.low protects ${Math.min(floor, this.current)} MiB. Reclaim from outside got only ${got} of ${mib} MiB here.` });
    }
    return got;
  }

  /** Restart a killed task. */
  restart(name: string): void {
    const p = this.procs.find((x) => x.name === name);
    if (p) { p.alive = true; p.anon = 0; p.swapped = 0; }
  }
}
