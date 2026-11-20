/**
 * A model of Go's channel object, `hchan` in src/runtime/chan.go, for a stepper that the learner drives.
 *
 * It keeps the fields that decide what an operation does: the ring buffer `buf` of `dataqsiz` slots with `qcount`
 * values, the indices `sendx` and `recvx`, the `closed` flag, and the wait queues `sendq` and `recvq` of sudogs (a
 * parked goroutine plus the value it sends). Every operation runs with the channel's one lock held, so in this model an
 * operation is one atomic step. The paths follow chansend, chanrecv and closechan:
 *
 * - send: nil channel → block forever. closed → panic. A receiver waits → copy straight to it (send, sendDirect).
 *   A free slot → write buf[sendx]. Else → park on sendq.
 * - receive: nil channel → block forever. closed and empty → zero value, ok = false. A sender waits → for capacity 0,
 *   copy straight from it; for a full buffer, take buf[recvx] and put the sender's value in the same slot. A value in
 *   the buffer → take buf[recvx]. Else → park on recvq.
 * - close: nil or already closed → panic. Else set closed, wake every receiver (zero value, ok = false) and every
 *   sender (it panics when it runs).
 */

export type GStatus = "ready" | "blocked-send" | "blocked-recv" | "blocked-forever" | "panicked";

export interface Sudog { g: number; elem?: number }

export type ChanPath =
  | "direct-send" | "buffer-send" | "park-send" | "send-closed-panic"
  | "direct-recv" | "buffer-recv" | "buffer-recv-refill" | "park-recv" | "recv-closed"
  | "close" | "close-closed-panic" | "close-nil-panic" | "nil-block";

export interface ChanStep {
  g: number;
  op: "send" | "recv" | "close";
  path: ChanPath;
  /** The value sent, or the value received. */
  value?: number;
  ok?: boolean;
  /** Goroutines that this step made runnable (goready). */
  woke: number[];
}

/** What each path does, in the words of chan.go. */
export const PATH_TEXT: Record<ChanPath, string> = {
  "direct-send": "chansend found a receiver in recvq. send() copies the value straight to the receiver's stack (sendDirect) and calls goready. The buffer is not used.",
  "buffer-send": "chansend found a free slot. It writes buf[sendx], advances sendx (wrapping to 0), and increments qcount.",
  "park-send": "No receiver waits and the buffer is full. chansend puts a sudog with the value on sendq and calls gopark.",
  "send-closed-panic": "The channel is closed. chansend panics: \"send on closed channel\".",
  "direct-recv": "chanrecv found a sender in sendq and the channel has no buffer. recv() copies the value straight from the sender and calls goready.",
  "buffer-recv": "chanrecv takes buf[recvx], clears the slot, advances recvx and decrements qcount.",
  "buffer-recv-refill": "The buffer is full and a sender waits. recv() takes buf[recvx], copies the sender's value into the same slot, advances recvx, sets sendx = recvx, and readies the sender. FIFO order holds.",
  "park-recv": "No value and no sender. chanrecv puts a sudog on recvq and calls gopark.",
  "recv-closed": "The channel is closed and empty. chanrecv returns the zero value with ok = false at once.",
  "close": "closechan sets closed = 1, then readies every goroutine in recvq (zero value, ok = false) and in sendq (each one panics when it runs).",
  "close-closed-panic": "closechan panics: \"close of closed channel\".",
  "close-nil-panic": "closechan panics: \"close of nil channel\".",
  "nil-block": "A send or receive on a nil channel calls gopark with no channel to wake it. The goroutine blocks forever.",
};

export class Hchan {
  /** null: a nil channel. */
  readonly dataqsiz: number | null;
  buf: (number | null)[];
  qcount = 0;
  sendx = 0;
  recvx = 0;
  closed = false;
  sendq: Sudog[] = [];
  recvq: Sudog[] = [];
  status: GStatus[];
  /** The last result of each goroutine, for display. */
  last: (string | null)[];
  readonly log: ChanStep[] = [];
  private next = 1;

  constructor(capacity: number | null, goroutines = 4) {
    this.dataqsiz = capacity;
    this.buf = Array.from({ length: capacity ?? 0 }, () => null);
    this.status = Array.from({ length: goroutines }, () => "ready");
    this.last = Array.from({ length: goroutines }, () => null);
  }

  get isNil() {
    return this.dataqsiz === null;
  }

  canAct(g: number) {
    return this.status[g] === "ready";
  }

  /** The value the next send will carry. */
  get nextValue() {
    return this.next;
  }

  private record(s: ChanStep) {
    this.log.push(s);
    return s;
  }

  private ready(g: number, text: string) {
    this.status[g] = "ready";
    this.last[g] = text;
  }

  send(g: number): ChanStep | null {
    if (!this.canAct(g)) return null;
    const v = this.next++;
    if (this.isNil) {
      this.status[g] = "blocked-forever";
      return this.record({ g, op: "send", path: "nil-block", value: v, woke: [] });
    }
    if (this.closed) {
      this.status[g] = "panicked";
      this.last[g] = "panic: send on closed channel";
      return this.record({ g, op: "send", path: "send-closed-panic", value: v, woke: [] });
    }
    const r = this.recvq.shift();
    if (r) {
      this.ready(r.g, `got ${v}, ok = true`);
      this.last[g] = `sent ${v}`;
      return this.record({ g, op: "send", path: "direct-send", value: v, woke: [r.g] });
    }
    if (this.qcount < this.dataqsiz!) {
      this.buf[this.sendx] = v;
      this.sendx = (this.sendx + 1) % this.dataqsiz!;
      this.qcount++;
      this.last[g] = `sent ${v}`;
      return this.record({ g, op: "send", path: "buffer-send", value: v, woke: [] });
    }
    this.sendq.push({ g, elem: v });
    this.status[g] = "blocked-send";
    this.last[g] = `waits to send ${v}`;
    return this.record({ g, op: "send", path: "park-send", value: v, woke: [] });
  }

  recv(g: number): ChanStep | null {
    if (!this.canAct(g)) return null;
    if (this.isNil) {
      this.status[g] = "blocked-forever";
      return this.record({ g, op: "recv", path: "nil-block", woke: [] });
    }
    if (this.closed && this.qcount === 0) {
      this.last[g] = "got 0, ok = false";
      return this.record({ g, op: "recv", path: "recv-closed", value: 0, ok: false, woke: [] });
    }
    const s = this.sendq.shift();
    if (s) {
      let v: number;
      let path: ChanPath;
      if (this.dataqsiz === 0) {
        v = s.elem!;
        path = "direct-recv";
      } else {
        // The buffer is full: take the head, and the sender's value goes into the same slot (the new tail).
        v = this.buf[this.recvx]!;
        this.buf[this.recvx] = s.elem!;
        this.recvx = (this.recvx + 1) % this.dataqsiz!;
        this.sendx = this.recvx;
        path = "buffer-recv-refill";
      }
      this.ready(s.g, `sent ${s.elem}`);
      this.last[g] = `got ${v}, ok = true`;
      return this.record({ g, op: "recv", path, value: v, ok: true, woke: [s.g] });
    }
    if (this.qcount > 0) {
      const v = this.buf[this.recvx]!;
      this.buf[this.recvx] = null;
      this.recvx = (this.recvx + 1) % this.dataqsiz!;
      this.qcount--;
      this.last[g] = `got ${v}, ok = true`;
      return this.record({ g, op: "recv", path: "buffer-recv", value: v, ok: true, woke: [] });
    }
    this.recvq.push({ g });
    this.status[g] = "blocked-recv";
    this.last[g] = "waits to receive";
    return this.record({ g, op: "recv", path: "park-recv", woke: [] });
  }

  close(g: number): ChanStep | null {
    if (!this.canAct(g)) return null;
    if (this.isNil || this.closed) {
      this.status[g] = "panicked";
      this.last[g] = `panic: close of ${this.isNil ? "nil" : "closed"} channel`;
      return this.record({ g, op: "close", path: this.isNil ? "close-nil-panic" : "close-closed-panic", woke: [] });
    }
    this.closed = true;
    const woke: number[] = [];
    for (const r of this.recvq.splice(0)) {
      this.ready(r.g, "got 0, ok = false");
      woke.push(r.g);
    }
    for (const s of this.sendq.splice(0)) {
      this.status[s.g] = "panicked";
      this.last[s.g] = "panic: send on closed channel";
      woke.push(s.g);
    }
    this.last[g] = "closed it";
    return this.record({ g, op: "close", path: "close", woke });
  }
}

export type ChanAction = { g: number; op: "send" | "recv" | "close" };

/** Replays a list of actions on a new channel. Actions by a goroutine that cannot act are skipped. */
export function replayHchan(capacity: number | null, actions: ChanAction[], goroutines = 4): Hchan {
  const c = new Hchan(capacity, goroutines);
  for (const a of actions) c[a.op](a.g);
  return c;
}
