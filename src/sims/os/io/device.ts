/**
 * A toy device with three registers, and a descriptor ring.
 *
 * ToyDevice follows one rule: each bus access takes one cycle, and the device moves forward by one cycle before the
 * access happens. A driver that is faster than the device can therefore see a stale status or overwrite a latch.
 * DescRing is an e1000-style ring: head and tail are indices below the ring size, and one slot stays empty.
 */

/** Real values. */
export const DRIVER_FACTS = {
  /** x86 port numbers are 16 bits wide. arm64 has no port instructions. */
  x86Ports: 65536,
  /** PCI base address registers per function. */
  pciBars: 6,
} as const;

export const STATUS = { BUSY: 1, DRDY: 2, ERR: 4 } as const;
export const COMMAND = { SEND: 1, RECV: 2, RESET: 3 } as const;
export type DevProblem = "overwrote-latch" | "command-while-busy" | "stale-read" | "overrun";

export interface DevLogEntry { cycle: number; text: string; problem?: DevProblem }

export class ToyDevice {
  readonly latency: number;
  cycle = 0;
  status = 0;
  data = 0;
  busyLeft = 0;
  private op: "send" | "recv" | null = null;
  /** Bytes that left on the wire, in order. */
  readonly wire: number[] = [];
  /** Bytes that the device can receive, in order. */
  readonly input: number[];
  /** Bytes that the driver got from the DATA register. */
  readonly got: number[] = [];
  readonly log: DevLogEntry[] = [];
  problems = 0;

  constructor(latency: number, input: number[] = []) {
    this.latency = Math.max(1, latency);
    this.input = [...input];
  }

  private note(text: string, problem?: DevProblem) {
    if (problem) this.problems++;
    this.log.push({ cycle: this.cycle, text, problem });
  }

  /** One device cycle. */
  private tick() {
    this.cycle++;
    if (this.busyLeft === 0) return;
    this.busyLeft--;
    if (this.busyLeft > 0) return;
    this.status &= ~STATUS.BUSY;
    if (this.op === "send") {
      this.wire.push(this.data);
      this.note(`The device finishes and sends the byte in DATA: ${show(this.data)}.`);
    } else if (this.op === "recv") {
      if (this.status & STATUS.DRDY) {
        this.status |= STATUS.ERR;
        this.note(`A new byte replaces ${show(this.data)}, which the driver did not read.`, "overrun");
      }
      this.data = this.input.shift() ?? 0;
      this.status |= STATUS.DRDY;
      this.note(`A byte is ready in DATA: ${show(this.data)}.`);
    }
    this.op = null;
  }

  readStatus(): number {
    this.tick();
    this.note(`Read STATUS: ${statusText(this.status)}.`);
    return this.status;
  }

  writeData(v: number) {
    this.tick();
    if (this.status & STATUS.BUSY) {
      this.data = v;
      this.note(`Write DATA = ${show(v)} while BUSY. The device has not used the old byte, so that byte is gone.`, "overwrote-latch");
      return;
    }
    this.data = v;
    this.note(`Write DATA = ${show(v)}.`);
  }

  readData(): number {
    this.tick();
    const v = this.data;
    if (this.status & STATUS.DRDY) {
      this.status &= ~STATUS.DRDY;
      this.got.push(v);
      this.note(`Read DATA = ${show(v)}. DRDY clears.`);
    } else {
      this.got.push(v);
      this.note(`Read DATA = ${show(v)} with DRDY clear. This value is stale.`, "stale-read");
    }
    return v;
  }

  writeCommand(c: number) {
    this.tick();
    if (c === COMMAND.RESET) {
      this.status = 0; this.busyLeft = 0; this.op = null;
      this.note("Write COMMAND = RESET. The device is idle.");
      return;
    }
    if (this.status & STATUS.BUSY) {
      this.status |= STATUS.ERR;
      this.note(`Write COMMAND = ${c === COMMAND.SEND ? "SEND" : "RECV"} while BUSY. The device ignores it and sets ERR.`, "command-while-busy");
      return;
    }
    this.op = c === COMMAND.SEND ? "send" : "recv";
    this.busyLeft = this.latency;
    this.status |= STATUS.BUSY;
    this.note(`Write COMMAND = ${c === COMMAND.SEND ? "SEND" : "RECV"}. The device is BUSY for ${this.latency} cycles.`);
  }

  /** The driver does other work for one cycle. */
  idle() {
    this.tick();
  }
}

const show = (v: number) => (v >= 32 && v < 127 ? `'${String.fromCharCode(v)}'` : `0x${v.toString(16)}`);
export const statusText = (s: number) => [s & STATUS.BUSY ? "BUSY" : "", s & STATUS.DRDY ? "DRDY" : "", s & STATUS.ERR ? "ERR" : ""].filter(Boolean).join(" ") || "idle";

export type DevAction = "status" | "data" | "command" | "wait" | "reset" | "read";

/** Drives the device in the send direction, from a list of learner actions. */
export function replayDevice(mode: "send" | "recv", latency: number, actions: DevAction[], payload: number[]): { dev: ToyDevice; nextByte: number } {
  const dev = new ToyDevice(latency, mode === "recv" ? payload : []);
  let k = 0;
  for (const a of actions) {
    if (a === "status") dev.readStatus();
    else if (a === "data") { dev.writeData(payload[Math.min(k, payload.length - 1)]!); k = Math.min(payload.length, k + 1); }
    else if (a === "command") dev.writeCommand(mode === "send" ? COMMAND.SEND : COMMAND.RECV);
    else if (a === "wait") dev.idle();
    else if (a === "reset") dev.writeCommand(COMMAND.RESET);
    else if (a === "read") dev.readData();
  }
  return { dev, nextByte: k };
}

/** The correct polled send: wait for idle, write DATA, write COMMAND. Returns the action list. */
export function sendActions(n: number, latency: number, kind: "correct" | "no-wait" | "command-first"): DevAction[] {
  // Runs against a shadow device, so that the polling loop stops when the real status says idle.
  const shadow = new ToyDevice(latency);
  const out: DevAction[] = [];
  const poll = () => { do { out.push("status"); } while (shadow.readStatus() & STATUS.BUSY); };
  for (let i = 0; i < n; i++) {
    if (kind !== "no-wait") poll();
    if (kind === "command-first") {
      out.push("command"); shadow.writeCommand(COMMAND.SEND);
      out.push("data"); shadow.writeData(i);
    } else {
      out.push("data"); shadow.writeData(i);
      out.push("command"); shadow.writeCommand(COMMAND.SEND);
    }
  }
  if (kind !== "no-wait") poll();
  else for (let i = 0; i < latency; i++) { out.push("wait"); shadow.idle(); }
  return out;
}

/** The correct polled receive: command, wait for DRDY, read DATA. `no-wait` reads after a command with no check. */
export function recvActions(n: number, latency: number, kind: "correct" | "no-wait"): DevAction[] {
  const shadow = new ToyDevice(latency, Array.from({ length: n }, (_, i) => i));
  const out: DevAction[] = [];
  for (let i = 0; i < n; i++) {
    out.push("command"); shadow.writeCommand(COMMAND.RECV);
    if (kind === "correct") { do { out.push("status"); } while (!(shadow.readStatus() & STATUS.DRDY)); }
    out.push("read"); shadow.readData();
  }
  return out;
}

/** Device access cost, as a check of the polling loop: how many status reads one byte takes. */
export const pollsPerByte = (latency: number) => {
  const a = sendActions(2, latency, "correct");
  const firstData = a.indexOf("data");
  const secondData = a.indexOf("data", firstData + 1);
  return a.slice(firstData, secondData).filter((x) => x === "status").length;
};

// ------------------------------------------------------------------- descriptor ring

export type SlotState = "free" | "posted" | "device" | "done";
export interface RingSlot { state: SlotState; buf: number | null; /** The value that a descriptor read sees. */ visible: number | null }

/**
 * A transmit ring, as in e1000. The driver owns the indices `next` (its private tail) and `clean`. The device owns
 * `head`. The doorbell publishes `tail`. Order along the ring: clean, then head, then tail, then next.
 * The ring is full when next + 1 == clean, so N slots hold N - 1 buffers: otherwise next == clean would be ambiguous.
 */
export class DescRing {
  readonly size: number;
  readonly slots: RingSlot[];
  next = 0;
  tail = 0;
  head = 0;
  clean = 0;
  doorbells = 0;
  posted = 0;
  consumed = 0;
  reaped = 0;
  fullRejects = 0;
  idlePolls = 0;
  /** Descriptors that the device read before the CPU store became visible. */
  staleReads = 0;
  readonly reapedBufs: number[] = [];
  readonly sent: number[] = [];
  /** Descriptor stores that are still in the store buffer. A dma_wmb() drains them. */
  private unflushed: number[] = [];

  constructor(size: number) {
    this.size = size;
    this.slots = Array.from({ length: size }, () => ({ state: "free", buf: null, visible: null }));
  }

  get inUse() { return (this.next - this.clean + this.size) % this.size; }
  get capacity() { return this.size - 1; }
  get isFull() { return (this.next + 1) % this.size === this.clean; }
  /** The device has nothing to do. */
  get deviceIdle() { return this.head === this.tail; }
  /** Slots that the device owns. */
  get deviceOwned() { return (this.tail - this.head + this.size) % this.size; }
  /** Written, but no doorbell yet. */
  get unpublished() { return (this.next - this.tail + this.size) % this.size; }
  get nothingToReap() { return this.slots[this.clean]!.state !== "done"; }

  /** Writes one descriptor. It returns false when the ring is full. Then a driver stops its queue. */
  post(buf: number, barrier = true): boolean {
    if (this.isFull) { this.fullRejects++; return false; }
    const s = this.slots[this.next]!;
    s.state = "posted";
    s.buf = buf;
    if (barrier) s.visible = buf; else this.unflushed.push(this.next);
    this.next = (this.next + 1) % this.size;
    this.posted++;
    return true;
  }

  /** The MMIO write that publishes the tail. With a barrier, every descriptor is visible first. */
  doorbell(barrier = true) {
    if (barrier) this.flushStores();
    for (let i = this.tail; i !== this.next; i = (i + 1) % this.size) this.slots[i]!.state = "device";
    this.tail = this.next;
    this.doorbells++;
  }

  private flushStores() {
    for (const i of this.unflushed) this.slots[i]!.visible = this.slots[i]!.buf;
    this.unflushed = [];
  }

  /** The device fetches and finishes one descriptor. It returns the buffer that it sent, or null if it is idle. */
  deviceStep(): { slot: number; buf: number | null; stale: boolean } | null {
    if (this.deviceIdle) { this.idlePolls++; return null; }
    const slot = this.head;
    const s = this.slots[slot]!;
    const stale = s.visible !== s.buf;
    if (stale) this.staleReads++;
    if (s.visible !== null && !stale) this.sent.push(s.visible);
    s.state = "done";
    const buf = s.visible;
    this.head = (this.head + 1) % this.size;
    this.consumed++;
    // A store buffer drains soon after, but it can be too late.
    this.flushStores();
    return { slot, buf, stale };
  }

  /** The driver frees one finished buffer, in ring order. It returns null if the next slot is not done. */
  reap(): number | null {
    const s = this.slots[this.clean]!;
    if (s.state !== "done") return null;
    const b = s.buf!;
    this.reapedBufs.push(b);
    s.state = "free";
    s.buf = null;
    s.visible = null;
    this.clean = (this.clean + 1) % this.size;
    this.reaped++;
    return b;
  }
}

export type RingAction = { a: "post"; barrier?: boolean } | { a: "doorbell"; barrier?: boolean } | { a: "device" } | { a: "reap" };

/** Replays learner actions. Buffers count up from 1. */
export function replayRing(size: number, actions: RingAction[]): { ring: DescRing; nextBuf: number } {
  const ring = new DescRing(size);
  let nextBuf = 1;
  for (const x of actions) {
    if (x.a === "post") { if (ring.post(nextBuf, x.barrier ?? true)) nextBuf++; }
    else if (x.a === "doorbell") ring.doorbell(x.barrier ?? true);
    else if (x.a === "device") ring.deviceStep();
    else ring.reap();
  }
  return { ring, nextBuf };
}

/** MODEL INPUTS, in nanoseconds: why a driver batches doorbells. */
export const DOORBELL_MODEL = {
  /** One posted MMIO write, with its barrier. */
  doorbellNs: 300,
  /** Writing one descriptor into cached memory. */
  descriptorNs: 10,
} as const;

/** The CPU cost per packet when the driver rings the doorbell once per `batch` packets. */
export const doorbellCostPerPacket = (batch: number) => DOORBELL_MODEL.descriptorNs + DOORBELL_MODEL.doorbellNs / batch;
