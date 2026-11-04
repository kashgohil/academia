/**
 * Interrupts on one CPU.
 *
 * - irqTimeline: a preemptive model of a task, hard interrupts and softirqs, with one pending bit per vector
 *   (the APIC IRR), interrupt coalescing, and ksoftirqd when softirq work runs past its time limit.
 * - irqShares: the same model as a closed formula.
 * - rxGoodput: the receive path as a fluid model, for interrupt per packet, coalescing and NAPI.
 * - rxRun: the receive path as a discrete simulation with rings, drops and a conservation law.
 * - pollVsIrq: when polling uses less CPU than interrupts.
 *
 * IRQ_MODEL holds MODEL INPUTS: round figures of the right size, not measurements. IRQ_FACTS holds real values.
 */
import { mulberry32 } from "../../rng";

/** MODEL INPUTS, in microseconds. */
export const IRQ_MODEL = {
  /** One hard interrupt: entry, handler, EOI and exit, with its cache cost. */
  hardUs: 4,
  /** Softirq protocol work for one packet or event. */
  softUs: 3,
  /** Application work for one packet. */
  appUs: 5,
  /** One uncached read of a device status register. */
  mmioReadUs: 0.5,
  /** A poll loop reads the status register this often. */
  pollPeriodUs: 10,
  /** The share of the CPU that softirq work keeps when the application also wants the CPU. */
  softShareLimit: 0.5,
  /** The time slice when ksoftirqd and a task share the CPU. */
  fairQuantumUs: 500,
} as const;

/** Real values from the kernel source and the PCI specification. */
export const IRQ_FACTS = {
  /** Entries in the x86-64 IDT. */
  idtVectors: 256,
  /** Vectors 0 to 31 are CPU exceptions. */
  exceptionVectors: 32,
  /** NR_SOFTIRQS: HI, TIMER, NET_TX, NET_RX, BLOCK, IRQ_POLL, TASKLET, SCHED, HRTIMER, RCU. */
  softirqTypes: 10,
  /** MAX_SOFTIRQ_RESTART in kernel/softirq.c. */
  maxSoftirqRestart: 10,
  /** MAX_SOFTIRQ_TIME in kernel/softirq.c. */
  maxSoftirqTimeMs: 2,
  /** Vectors a device can have with MSI. */
  msiVectors: 32,
  /** Vectors a device can have with MSI-X. */
  msixVectors: 2048,
  /** net.core.netdev_budget default: packets in one softirq run. */
  netdevBudget: 300,
  /** NAPI_POLL_WEIGHT: packets in one poll call. */
  napiWeight: 64,
  /** net.core.netdev_max_backlog default. */
  netdevMaxBacklog: 1000,
  /** Priority of an irq/N-name thread: SCHED_FIFO, MAX_RT_PRIO / 2. */
  threadedIrqFifoPrio: 50,
  /** An MSI on x86 is a memory write to this address range, which the local APICs claim. */
  msiAddressBase: 0xfee00000,
} as const;

// ------------------------------------------------------------------- CPU timeline

export type CpuLane = "task" | "hard" | "soft" | "ksoftirqd";
export interface CpuSegment { kind: CpuLane; start: number; end: number }

export interface IrqTimelineOpts {
  /** Events per second. */
  rate: number;
  /** Time to simulate, in microseconds. */
  spanUs: number;
  /** The device raises an interrupt when this many events wait. */
  framesPerIrq?: number;
  /** ... or when the oldest event has waited this long. Zero: raise at once. */
  coalesceUs?: number;
  hardUs?: number;
  softUs?: number;
  /** Continuous softirq time before the rest goes to ksoftirqd. */
  softLimitUs?: number;
  quantumUs?: number;
  seed?: number;
}

export interface IrqTimelineResult {
  segments: CpuSegment[];
  /** Microseconds in each lane. */
  time: Record<CpuLane, number>;
  spanUs: number;
  events: number;
  interrupts: number;
  /** Events that finished softirq work. */
  handled: number;
  /** Events that still wait at the end. */
  backlog: number;
  meanLatencyUs: number;
  maxLatencyUs: number;
  /** ksoftirqd took over at least once. */
  deferred: boolean;
}

/**
 * Runs the priority rule hard > softirq > ksoftirqd and task. The pending interrupt is one bit: while a handler
 * runs, more events set the same bit, so that one later handler takes them all. This is how the APIC IRR works.
 * A handler with no waiting events can run: a bit that was set just before the last handler took the events.
 */
export function irqTimeline(o: IrqTimelineOpts): IrqTimelineResult {
  const hardUs = o.hardUs ?? IRQ_MODEL.hardUs;
  const softUs = o.softUs ?? IRQ_MODEL.softUs;
  const frames = Math.max(1, o.framesPerIrq ?? 1);
  const window = o.coalesceUs ?? 0;
  const softLimit = o.softLimitUs ?? IRQ_FACTS.maxSoftirqTimeMs * 1000;
  const quantum = o.quantumUs ?? IRQ_MODEL.fairQuantumUs;
  const rng = mulberry32(o.seed ?? 11);
  const gap = () => (-Math.log(1 - rng()) * 1e6) / o.rate;

  const segments: CpuSegment[] = [];
  const time: Record<CpuLane, number> = { task: 0, hard: 0, soft: 0, ksoftirqd: 0 };
  const emit = (kind: CpuLane, a: number, b: number) => {
    if (b <= a) return;
    time[kind] += b - a;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && Math.abs(last.end - a) < 1e-9) last.end = b;
    else segments.push({ kind, start: a, end: b });
  };

  let t = 0;
  let nextArrival = o.rate > 0 ? gap() : Infinity;
  const waiting: number[] = []; // in the device, no interrupt yet
  const backlog: number[] = []; // moved by a hard handler, softirq work to do
  let irqBit = false, inHard = 0, inSoft = 0, softOf = 0;
  let softRunStart = -1, deferred = false, everDeferred = false, fairTurn: "task" | "ksoftirqd" = "ksoftirqd", fairLeft = quantum;
  let events = 0, interrupts = 0, handled = 0, latSum = 0, latMax = 0;
  let deadline = Infinity; // the coalescing timer

  const checkRaise = () => {
    if (irqBit || waiting.length === 0) return;
    if (waiting.length >= frames || t >= deadline || (frames === 1 && window === 0)) { irqBit = true; deadline = Infinity; }
  };

  let guard = 0;
  while (t < o.spanUs && guard++ < 5e6) {
    while (nextArrival <= t + 1e-12) {
      events++;
      if (waiting.length === 0 && window > 0) deadline = nextArrival + window;
      waiting.push(nextArrival);
      nextArrival += gap();
    }
    checkRaise();
    if (inHard === 0 && irqBit) {
      irqBit = false;
      interrupts++;
      inHard = hardUs;
      // The handler acknowledges the device and takes every waiting event at its start. An event that arrives later sets the bit again.
      backlog.push(...waiting.splice(0));
      deadline = Infinity;
    }
    // Choose the lane.
    let lane: CpuLane;
    if (inHard > 0) lane = "hard";
    else {
      const softWork = inSoft > 0 || backlog.length > 0;
      if (softWork && !deferred) {
        if (softRunStart < 0) softRunStart = t;
        if (t - softRunStart >= softLimit) { deferred = true; everDeferred = true; fairTurn = "ksoftirqd"; fairLeft = quantum; }
      }
      if (!softWork) { softRunStart = -1; deferred = false; }
      if (softWork && !deferred) lane = "soft";
      else if (softWork && deferred) lane = fairTurn;
      else lane = "task";
    }
    // Run until the next thing that can change the choice.
    let until = Math.min(o.spanUs, nextArrival, deadline > t ? deadline : Infinity);
    if (lane === "hard") until = Math.min(until, t + inHard);
    if (lane === "soft" || lane === "ksoftirqd") {
      if (inSoft === 0) { softOf = backlog.shift()!; inSoft = softUs; }
      until = Math.min(until, t + inSoft);
    }
    if (deferred && lane !== "hard") until = Math.min(until, t + fairLeft);
    if (until <= t) until = t + 1e-6;
    const dt = until - t;
    emit(lane, t, until);
    t = until;
    if (lane === "hard") {
      inHard -= dt;
      if (inHard <= 1e-9) inHard = 0;
    } else if (lane === "soft" || lane === "ksoftirqd") {
      inSoft -= dt;
      if (inSoft <= 1e-9) {
        inSoft = 0;
        handled++;
        const lat = t - softOf;
        latSum += lat;
        if (lat > latMax) latMax = lat;
      }
    }
    if (deferred && lane !== "hard") {
      fairLeft -= dt;
      if (fairLeft <= 1e-9) { fairTurn = fairTurn === "task" ? "ksoftirqd" : "task"; fairLeft = quantum; }
    }
  }
  return {
    segments, time, spanUs: o.spanUs, events, interrupts, handled,
    backlog: waiting.length + backlog.length + (inSoft > 0 ? 1 : 0),
    meanLatencyUs: handled ? latSum / handled : 0, maxLatencyUs: latMax, deferred: everDeferred,
  };
}

/** Events per interrupt: the first event opens a window, and the window collects more. `frames` is the hard limit. */
export const batchPerIrq = (rate: number, windowUs: number, frames = Infinity) => Math.max(1, Math.min(frames, 1 + (rate * windowUs) / 1e6));

/**
 * The share of the CPU in hard handlers with one interrupt per event and Poisson arrivals. A handler takes all waiting
 * events when it starts. Another handler follows at once if any event arrives during this one. With x = L h exp(L h),
 * where L is the rate and h the handler time, the busy share is x / (1 + x).
 */
export function hardShareNoWindow(rate: number, hardUs: number = IRQ_MODEL.hardUs): number {
  const lh = (rate * hardUs) / 1e6;
  const x = lh * Math.exp(lh);
  return x / (1 + x);
}

export interface IrqShares { interruptsPerSec: number; hard: number; soft: number; task: number }

/** The long-run shares of the CPU, by the priority rule, with no ksoftirqd. */
export function irqShares(rate: number, o: { hardUs?: number; softUs?: number; framesPerIrq?: number; coalesceUs?: number } = {}): IrqShares {
  const hUs = o.hardUs ?? IRQ_MODEL.hardUs;
  const h = hUs / 1e6, s = (o.softUs ?? IRQ_MODEL.softUs) / 1e6;
  const frames = o.framesPerIrq ?? 1;
  const w = o.coalesceUs ?? 0;
  let hard: number;
  if (frames === 1 && w === 0) hard = hardShareNoWindow(rate, hUs);
  else hard = Math.min(1, (rate / (w > 0 ? batchPerIrq(rate, w, frames) : frames)) * h);
  const soft = Math.min(1 - hard, rate * s);
  return { interruptsPerSec: hard / h, hard, soft, task: 1 - hard - soft };
}

/** The event rate at which hard and softirq work use the whole CPU, with one interrupt per event. */
export function irqSaturationRate(hardUs: number = IRQ_MODEL.hardUs, softUs: number = IRQ_MODEL.softUs): number {
  let lo = 0, hi = 1e6 / softUs;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hardShareNoWindow(mid, hardUs) + (mid * softUs) / 1e6 >= 1) hi = mid; else lo = mid;
  }
  return hi;
}

// ------------------------------------------------------------------- polling against interrupts

export interface PollVsIrq { pollShare: number; pollWaitUs: number; irqShare: number; breakEvenRate: number }

/** Polling costs CPU at every rate and adds half a period of delay. Interrupts cost CPU per event. */
export function pollVsIrq(rate: number, periodUs: number = IRQ_MODEL.pollPeriodUs, readUs: number = IRQ_MODEL.mmioReadUs, hardUs: number = IRQ_MODEL.hardUs): PollVsIrq {
  const pollShare = readUs / periodUs;
  return { pollShare, pollWaitUs: periodUs / 2, irqShare: (rate * hardUs) / 1e6, breakEvenRate: (pollShare * 1e6) / hardUs };
}

// ------------------------------------------------------------------- receive path: fluid model

export type RxMode = "irq" | "coalesce" | "napi";
export const RX_LABEL: Record<RxMode, string> = { irq: "Interrupt per packet", coalesce: "Coalescing", napi: "NAPI" };

export interface RxInputs { hardUs: number; softUs: number; appUs: number; windowUs: number; softLimit: number }
export const RX_DEFAULTS: RxInputs = { hardUs: IRQ_MODEL.hardUs, softUs: IRQ_MODEL.softUs, appUs: IRQ_MODEL.appUs, windowUs: 50, softLimit: IRQ_MODEL.softShareLimit };

export interface RxPoint {
  rate: number;
  /** Packets per second that reach the application. */
  goodput: number;
  interruptsPerSec: number;
  hard: number;
  soft: number;
  app: number;
  /** Packets per second that softirq work paid for and then dropped, because the socket was full. */
  lateDrop: number;
  /** Packets per second dropped in the NIC ring. They cost no CPU. */
  ringDrop: number;
}

/**
 * The fluid model. Interrupt per packet and coalescing keep the old rule: hard work first, then softirq work with no
 * limit, then the application. NAPI differs in two ways: no interrupt fires while a poll runs, and softirq work keeps
 * at most `softLimit` of the CPU, because the rest moves to ksoftirqd. The excess then drops in the ring at no cost.
 */
export function rxGoodput(mode: RxMode, rate: number, i: RxInputs = RX_DEFAULTS): RxPoint {
  const h = i.hardUs / 1e6, s = i.softUs / 1e6, a = i.appUs / 1e6, w = i.windowUs;
  if (mode !== "napi") {
    const hard = mode === "irq" ? hardShareNoWindow(rate, i.hardUs) : Math.min(1, (rate / batchPerIrq(rate, w)) * h);
    const irq = hard / h;
    const admitted = Math.min(rate, (1 - hard) / s);
    const soft = admitted * s;
    const app = 1 - hard - soft;
    const goodput = Math.min(admitted, app / a);
    return { rate, goodput, interruptsPerSec: irq, hard, soft, app: goodput * a, lateDrop: admitted - goodput, ringDrop: rate - admitted };
  }
  const soft = Math.min(rate * s, i.softLimit);
  const saturated = rate * s >= i.softLimit;
  // A poll that cannot finish keeps interrupts off. Otherwise an interrupt fires when a packet finds no poll running.
  const irq = saturated ? 0 : (rate * (1 - rate * s)) / batchPerIrq(rate, w) / (1 + (rate * h) / batchPerIrq(rate, w));
  const hard = irq * h;
  const admitted = soft / s;
  const goodput = Math.min(admitted, (1 - hard - soft) / a);
  return { rate, goodput, interruptsPerSec: irq, hard, soft, app: goodput * a, lateDrop: admitted - goodput, ringDrop: rate - admitted };
}

export interface RxLandmarks { peakRate: number; peakGoodput: number; zeroRate: number | null; floor: number }

/** Finds the top of the curve, the rate where goodput reaches zero (if it does), and the goodput under a very high load. */
export function rxLandmarks(mode: RxMode, i: RxInputs = RX_DEFAULTS, maxRate = 2e6): RxLandmarks {
  let peakRate = 0, peakGoodput = 0, zeroRate: number | null = null;
  const steps = 8000;
  for (let k = 1; k <= steps; k++) {
    const rate = (k / steps) * maxRate;
    const g = rxGoodput(mode, rate, i).goodput;
    if (g > peakGoodput) { peakGoodput = g; peakRate = rate; }
    if (zeroRate === null && peakGoodput > 0 && g <= peakGoodput * 1e-9) zeroRate = rate;
  }
  return { peakRate, peakGoodput, zeroRate, floor: rxGoodput(mode, maxRate, i).goodput };
}

// ------------------------------------------------------------------- receive path: discrete simulation

export interface RxRunOpts extends Partial<RxInputs> {
  mode: RxMode;
  /** Packets per second. */
  rate: number;
  spanUs?: number;
  ringSize?: number;
  socketSize?: number;
  seed?: number;
  stepUs?: number;
}

export interface RxRun {
  arrived: number;
  delivered: number;
  ringDrops: number;
  backlogDrops: number;
  socketDrops: number;
  /** Packets that are still in a ring or a queue, or on the CPU. */
  inFlight: number;
  interrupts: number;
  goodput: number;
  time: { hard: number; soft: number; app: number; idle: number };
}

/**
 * The same rules as rxGoodput, packet by packet, on a fixed time step. Each arriving packet ends in exactly one of:
 * delivered, one of three drop counters, or in flight. The test checks this law.
 */
export function rxRun(o: RxRunOpts): RxRun {
  const i = { ...RX_DEFAULTS, ...o };
  const dt = o.stepUs ?? 0.25;
  const span = o.spanUs ?? 20_000;
  const ringCap = o.ringSize ?? 256, sockCap = o.socketSize ?? 256, backlogCap = IRQ_FACTS.netdevMaxBacklog;
  const rng = mulberry32(o.seed ?? 5);
  const gap = () => (-Math.log(1 - rng()) * 1e6) / o.rate;
  const r: RxRun = { arrived: 0, delivered: 0, ringDrops: 0, backlogDrops: 0, socketDrops: 0, inFlight: 0, interrupts: 0, goodput: 0, time: { hard: 0, soft: 0, app: 0, idle: 0 } };
  let next = o.rate > 0 ? gap() : Infinity;
  let ring = 0, backlog = 0, sock = 0;
  let irqBit = false, irqOn = true, polling = false, window = -1;
  let hardLeft = 0, softLeft = 0, appLeft = 0;
  let softUsed = 0;
  const windowUs = o.mode === "irq" ? 0 : i.windowUs;
  for (let t = 0; t < span; t += dt) {
    while (next <= t) {
      r.arrived++;
      if (ring >= ringCap) r.ringDrops++; else { ring++; if (window < 0) window = t; }
      next += gap();
    }
    if (ring > 0 && !irqBit && irqOn && window >= 0 && t - window >= windowUs) irqBit = true;
    if (hardLeft === 0 && irqBit) {
      irqBit = false; r.interrupts++; hardLeft = i.hardUs;
      // The handler acknowledges the device and takes the packets at its start.
      window = -1;
      if (o.mode === "napi") { irqOn = false; polling = true; }
      else { const moved = Math.min(ring, backlogCap - backlog); r.backlogDrops += ring - moved; backlog += moved; ring = 0; }
    }
    if (hardLeft > 0) {
      hardLeft -= dt; r.time.hard += dt;
      if (hardLeft <= 1e-9) hardLeft = 0;
      continue;
    }
    const softPending = softLeft > 0 || (o.mode === "napi" ? polling && ring > 0 : backlog > 0);
    // NAPI: softirq work yields to the application when it has used its share. The other modes have no limit.
    const softMayRun = o.mode !== "napi" || sock === 0 || softUsed <= i.softLimit * t + 64 * i.softUs;
    if (softPending && softMayRun) {
      if (softLeft === 0) {
        if (o.mode === "napi") ring--; else backlog--;
        softLeft = i.softUs;
      }
      softLeft -= dt; softUsed += dt; r.time.soft += dt;
      if (softLeft <= 1e-9) {
        softLeft = 0;
        if (sock >= sockCap) r.socketDrops++; else sock++;
        if (o.mode === "napi" && ring === 0) { polling = false; irqOn = true; window = -1; }
      }
      continue;
    }
    if (appLeft > 0 || sock > 0) {
      if (appLeft === 0) { sock--; appLeft = i.appUs; }
      appLeft -= dt; r.time.app += dt;
      if (appLeft <= 1e-9) { appLeft = 0; r.delivered++; }
      continue;
    }
    r.time.idle += dt;
  }
  r.inFlight = ring + backlog + sock + (softLeft > 0 ? 1 : 0) + (appLeft > 0 ? 1 : 0);
  r.goodput = (r.delivered / span) * 1e6;
  return r;
}

// ------------------------------------------------------------------- the path of one interrupt

export type IrqPathStage = "device" | "apic" | "idt" | "entry" | "handler" | "eoi" | "softirq" | "return";
export interface IrqPathStep { stage: IrqPathStage; title: string; text: string; irqsOff: boolean; context: "task" | "hardirq" | "softirq" }

/** One NIC interrupt with MSI-X on x86-64 Linux, in order. Function names are from arch/x86/kernel/irq.c and kernel/softirq.c. */
export const IRQ_PATH: IrqPathStep[] = [
  { stage: "device", title: "The device has news", text: "A NIC writes a received packet to memory with DMA. It then sends a posted write to an address that the kernel gave it in the MSI-X table.", irqsOff: false, context: "task" },
  { stage: "apic", title: "The local APIC takes it", text: "That write targets the local APIC of one CPU and names one vector. The APIC sets the vector's bit in its IRR, the interrupt request register. If the bit is already set, the second event adds nothing.", irqsOff: false, context: "task" },
  { stage: "idt", title: "The CPU looks in the IDT", text: "At the next instruction boundary with interrupts on, the CPU moves the bit to the ISR, the in-service register. It reads the IDT entry for this vector.", irqsOff: true, context: "hardirq" },
  { stage: "entry", title: "Entry and stack switch", text: "The CPU pushes ss, rsp, rflags, cs and rip, and it clears the interrupt flag. The entry code saves the other registers and calls common_interrupt. A per-CPU table turns the vector into an irq_desc.", irqsOff: true, context: "hardirq" },
  { stage: "eoi", title: "End of interrupt", text: "For MSI the flow handler is handle_edge_irq. It first writes the APIC EOI register, which clears the ISR bit. A new event can now set the IRR again. The CPU flag still holds it off.", irqsOff: true, context: "hardirq" },
  { stage: "handler", title: "The top half runs", text: "handle_irq_event calls the driver's function. A NIC driver masks this queue's interrupt, schedules its poll, and so raises NET_RX. This function must not sleep.", irqsOff: true, context: "hardirq" },
  { stage: "softirq", title: "The bottom half runs", text: "On the way out, irq_exit_rcu sees pending softirqs. They run with interrupts on, so a new hard interrupt can preempt them. They still must not sleep.", irqsOff: false, context: "softirq" },
  { stage: "return", title: "Back to the task", text: "The exit code checks the need-resched flag. It then restores the registers, and iretq continues the task at the same instruction. The task did not see any of this.", irqsOff: false, context: "task" },
];
