/** Systems performance models: queues, tail latency, batching, closed-loop load, and I/O. */
import { mulberry32, normal, type Rng } from "../rng";

const expo = (r: Rng, mean: number) => -Math.log(1 - r()) * mean;

export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

// ---------------- queueing ----------------

export interface QueueConfig {
  /** Arrivals per ms. */
  lambda: number;
  /** Mean service time in ms. */
  service: number;
  servers: number;
  /** "random" = exponential service times (M/M/c); "fixed" = constant (M/D/c). */
  variability: "random" | "fixed";
  jobs: number;
}

export interface QueueResult { meanResponse: number; p50: number; p99: number; utilization: number; meanInSystem: number; throughput: number; responses: number[] }

/** Event-driven FIFO queue with c identical servers and Poisson arrivals. */
export function simulateQueue(cfg: QueueConfig, seed = 1): QueueResult {
  const r = mulberry32(seed);
  const free = new Array<number>(cfg.servers).fill(0); // time each server becomes free
  let t = 0, busy = 0, area = 0;
  const responses: number[] = [];
  const events: [number, number][] = []; // (time, +1 arrival / -1 departure) for time-average of L
  for (let i = 0; i < cfg.jobs; i++) {
    t += expo(r, 1 / cfg.lambda);
    const s = cfg.variability === "random" ? expo(r, cfg.service) : cfg.service;
    let k = 0;
    for (let j = 1; j < free.length; j++) if (free[j]! < free[k]!) k = j;
    const start = Math.max(t, free[k]!);
    free[k] = start + s;
    busy += s;
    responses.push(free[k]! - t);
    events.push([t, 1], [free[k]!, -1]);
  }
  events.sort((a, b) => a[0] - b[0]);
  let n = 0, last = 0;
  for (const [time, d] of events) { area += n * (time - last); n += d; last = time; }
  const end = last;
  const warm = Math.floor(cfg.jobs * 0.1); // skip the start-up transient
  const rs = responses.slice(warm);
  return {
    meanResponse: rs.reduce((a, b) => a + b, 0) / rs.length,
    p50: percentile(rs, 0.5),
    p99: percentile(rs, 0.99),
    utilization: busy / (end * cfg.servers),
    meanInSystem: area / end,
    throughput: cfg.jobs / end,
    responses: rs,
  };
}

/** M/M/1 mean response time: S / (1 − ρ). */
export const mm1Response = (service: number, rho: number) => (rho >= 1 ? Infinity : service / (1 - rho));

// ---------------- tail latency ----------------

/** Backend latency: lognormal body (median 10 ms) plus a 1% slow tail (median 150 ms). */
export function backendLatency(r: Rng): number {
  return r() < 0.01 ? 150 * Math.exp(0.4 * normal(r)) : 10 * Math.exp(0.25 * normal(r));
}

/** A request fans out to n backends and waits for all of them. */
export function fanout(n: number, requests = 4000, seed = 2): { p50: number; p99: number; slowShare: number; samples: number[] } {
  const r = mulberry32(seed);
  const samples: number[] = [];
  let slow = 0;
  for (let i = 0; i < requests; i++) {
    let m = 0;
    for (let k = 0; k < n; k++) m = Math.max(m, backendLatency(r));
    samples.push(m);
    if (m > 50) slow++;
  }
  return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99), slowShare: slow / requests, samples };
}

/** Hedged request: if no reply after `hedgeAfter` ms, send a second copy and take the first reply. */
export function hedged(hedgeAfter: number | null, requests = 40000, seed = 3): { p50: number; p99: number; p999: number; extraLoad: number; samples: number[] } {
  const r = mulberry32(seed);
  const samples: number[] = [];
  let extra = 0;
  for (let i = 0; i < requests; i++) {
    const a = backendLatency(r);
    if (hedgeAfter === null || a <= hedgeAfter) { samples.push(a); continue; }
    extra++;
    samples.push(Math.min(a, hedgeAfter + backendLatency(r)));
  }
  return { p50: percentile(samples, 0.5), p99: percentile(samples, 0.99), p999: percentile(samples, 0.999), extraLoad: extra / requests, samples };
}

// ---------------- latency vs throughput ----------------

/** Batching: fixed cost per batch plus per-item cost; items arrive at `rate` per ms. */
export function batching(batch: number, fixedMs: number, perItemMs: number, rate: number) {
  const serviceMs = fixedMs + batch * perItemMs;
  const capacity = batch / serviceMs; // items per ms the worker can process
  const fillWait = (batch - 1) / (2 * rate); // average wait for the batch to fill
  return { capacity, latency: fillWait + serviceMs, utilization: Math.min(1, rate / capacity) };
}

/** Closed system: N users, think time Z, demand D per request at the bottleneck (asymptotic bounds). */
export function closedLoop(users: number, demandMs: number, thinkMs: number) {
  const throughput = Math.min(users / (demandMs + thinkMs), 1 / demandMs); // per ms
  const response = Math.max(demandMs, users * demandMs - thinkMs);
  return { throughput, response, knee: (demandMs + thinkMs) / demandMs };
}

// ---------------- I/O ----------------

export const SYSCALL_NS = 300;

/** Reading `total` bytes with a buffer of `buf` bytes: one syscall per buffer plus copying at 10 GB/s. */
export function bufferedRead(buf: number, total = 64 << 20) {
  const calls = Math.ceil(total / buf);
  const ns = calls * SYSCALL_NS + total / 10; // 10 bytes per ns = 10 GB/s copy
  return { calls, gbps: total / ns, nsPerByte: ns / total };
}

/** Storage device: IOPS at a given queue depth (Little's law, capped by the device's internal parallelism). */
export const DEVICES = [
  { id: "hdd", label: "Hard disk", latencyUs: 8000, maxIops: 200 },
  { id: "sata", label: "SATA SSD", latencyUs: 100, maxIops: 90_000 },
  { id: "nvme", label: "NVMe SSD", latencyUs: 80, maxIops: 800_000 },
] as const;

export function deviceIops(dev: (typeof DEVICES)[number], qd: number) {
  const iops = Math.min(qd / (dev.latencyUs / 1e6), dev.maxIops);
  const latencyUs = qd / iops * 1e6; // Little's law: W = L / λ
  return { iops, latencyUs };
}

export const IO_MODELS = [
  { id: "threads", label: "Thread per connection, blocking read()", syscallsPerOp: 1, switchesPerOp: 2, note: "Each request sleeps in read(); the kernel switches threads twice per request." },
  { id: "epoll", label: "Event loop with epoll", syscallsPerOp: 2, switchesPerOp: 0, note: "One thread waits for many sockets; epoll_wait, then read(), for each event." },
  { id: "uring", label: "io_uring, batched", syscallsPerOp: 1 / 32, switchesPerOp: 0, note: "Requests and completions go through shared rings; one io_uring_enter for a batch of 32." },
] as const;

export const CONTEXT_SWITCH_NS = 3000;

export function ioCostPerOp(model: (typeof IO_MODELS)[number]) {
  return model.syscallsPerOp * SYSCALL_NS + model.switchesPerOp * CONTEXT_SWITCH_NS + 500; // + 500 ns of request work
}
