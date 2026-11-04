/**
 * A per-CPU trace ring buffer, modelled on kernel/trace/ring_buffer.c.
 *
 * Each CPU has its own ring of pages, so that a writer on one CPU never waits for another CPU.
 * The writer appends to the tail page. When the next page is the head (the oldest data):
 * - overwrite mode (the ftrace default, options/overwrite = 1) moves the head on, and it loses the whole oldest page;
 * - discard mode drops the new event, and it keeps the old data.
 * The reader never reads inside the ring. It owns one spare page and swaps it with the head page.
 *
 * Invariant at each moment: written = read + overwritten + dropped + held. A test checks this.
 */

/** Default sub-buffer size. Linux uses the page size. */
export const PAGE_BYTES = 4096;
/** The page header: a timestamp and a commit field. */
export const PAGE_HEADER_BYTES = 16;
/** The default of buffer_size_kb on many x86-64 kernels: TRACE_BUF_SIZE_DEFAULT is 1441792 bytes. */
export const DEFAULT_BUFFER_KIB = 1408;

export interface TraceEvent { id: number; cpu: number; bytes: number; t: number }
interface Page { events: TraceEvent[]; used: number }

export type RingMode = "overwrite" | "discard";

export interface RingStats { written: number; read: number; overwritten: number; dropped: number; held: number }

export class RingBuffer {
  /** The ring. */
  readonly pages: Page[];
  head = 0;
  tail = 0;
  /** The spare page that the reader owns. */
  readerPage: Page = { events: [], used: 0 };
  private readerPos = 0;
  written = 0;
  read = 0;
  overwritten = 0;
  dropped = 0;
  /** Sequence for the check that the reader sees events in order. */
  private nextId = 0;
  /** Events lost since the last read, as trace_pipe reports them. */
  lostSinceRead = 0;

  constructor(readonly cpu: number, readonly pageCount: number, readonly pageBytes = PAGE_BYTES, public mode: RingMode = "overwrite") {
    if (pageCount < 2) throw new Error("A ring needs at least 2 pages.");
    this.pages = Array.from({ length: pageCount }, () => ({ events: [], used: 0 }));
  }

  private capacityOfPage() {
    return this.pageBytes - PAGE_HEADER_BYTES;
  }

  /** Write one event. It returns false if the event was dropped. */
  write(bytes: number, t = 0): boolean {
    if (bytes > this.capacityOfPage()) throw new Error("An event must fit in a page.");
    this.written++;
    const ev: TraceEvent = { id: this.nextId++, cpu: this.cpu, bytes, t };
    let page = this.pages[this.tail]!;
    if (page.used + bytes > this.capacityOfPage()) {
      const next = (this.tail + 1) % this.pageCount;
      if (next === this.head) {
        if (this.mode === "discard") {
          this.dropped++;
          this.lostSinceRead++;
          return false;
        }
        // Overwrite: the oldest page is gone, and all its events are lost.
        const lost = this.pages[this.head]!;
        this.overwritten += lost.events.length;
        this.lostSinceRead += lost.events.length;
        lost.events = [];
        lost.used = 0;
        this.head = (this.head + 1) % this.pageCount;
      }
      this.tail = next;
      page = this.pages[this.tail]!;
      page.events = [];
      page.used = 0;
    }
    page.events.push(ev);
    page.used += bytes;
    return true;
  }

  /** Swap the spare page with the head page. It returns false if the ring has no data. */
  private swapReaderPage(): boolean {
    const head = this.pages[this.head]!;
    if (head.events.length === 0) return false;
    const spare = this.readerPage;
    spare.events = [];
    spare.used = 0;
    this.pages[this.head] = spare;
    this.readerPage = head;
    this.readerPos = 0;
    // If the writer was in this page, it continues in the empty page, in the same slot. Otherwise the head moves on.
    if (this.head !== this.tail) this.head = (this.head + 1) % this.pageCount;
    return true;
  }

  /** Read one event, or null if there is none. */
  readEvent(): { event: TraceEvent; lostBefore: number } | null {
    if (this.readerPos >= this.readerPage.events.length && !this.swapReaderPage()) return null;
    const event = this.readerPage.events[this.readerPos++]!;
    this.read++;
    const lostBefore = this.lostSinceRead;
    this.lostSinceRead = 0;
    return { event, lostBefore };
  }

  /** Read all that the ring holds now. */
  drain(max = Infinity): TraceEvent[] {
    const out: TraceEvent[] = [];
    while (out.length < max) {
      const r = this.readEvent();
      if (!r) break;
      out.push(r.event);
    }
    return out;
  }

  /** Events in the ring and in the reader page. */
  held(): number {
    return this.pages.reduce((n, p) => n + p.events.length, 0) + (this.readerPage.events.length - this.readerPos);
  }

  stats(): RingStats {
    return { written: this.written, read: this.read, overwritten: this.overwritten, dropped: this.dropped, held: this.held() };
  }

  /** The ring for display, from the head to the tail. */
  view() {
    return this.pages.map((p, i) => ({ index: i, events: p.events.length, used: p.used, isHead: i === this.head, isTail: i === this.tail, firstId: p.events[0]?.id ?? null, lastId: p.events[p.events.length - 1]?.id ?? null }));
  }
}

/** The set of per-CPU rings. */
export class TraceBuffers {
  readonly rings: RingBuffer[];
  constructor(cpus: number, pagesPerCpu: number, pageBytes = PAGE_BYTES, mode: RingMode = "overwrite") {
    this.rings = Array.from({ length: cpus }, (_, c) => new RingBuffer(c, pagesPerCpu, pageBytes, mode));
  }
  total(): RingStats {
    const t: RingStats = { written: 0, read: 0, overwritten: 0, dropped: 0, held: 0 };
    for (const r of this.rings) {
      const s = r.stats();
      t.written += s.written;
      t.read += s.read;
      t.overwritten += s.overwritten;
      t.dropped += s.dropped;
      t.held += s.held;
    }
    return t;
  }
}

// ---------------------------------------------------------------------------- how many events are lost

export interface LossInput {
  /** Events per second that one CPU writes. */
  eventRate: number;
  eventBytes: number;
  /** buffer_size_kb: the size per CPU. */
  bufferKiB: number;
  /** Events per second that the reader takes from this CPU. */
  readRate: number;
  seconds: number;
  /** The page size. */
  pageBytes?: number;
}

/** Events that one CPU buffer holds. */
export function capacityEvents(bufferKiB: number, eventBytes: number, pageBytes = PAGE_BYTES): number {
  const pages = Math.max(2, Math.floor((bufferKiB * 1024) / pageBytes));
  return pages * Math.floor((pageBytes - PAGE_HEADER_BYTES) / eventBytes);
}

/**
 * The share of events lost in a burst: the surplus over the reader, less what the buffer can hold.
 * The tests compare this formula with a run of the real RingBuffer.
 */
export function lossModel(i: LossInput): { written: number; lost: number; share: number; capacity: number; secondsToFill: number } {
  const written = i.eventRate * i.seconds;
  const capacity = capacityEvents(i.bufferKiB, i.eventBytes, i.pageBytes);
  const surplus = Math.max(0, i.eventRate - i.readRate);
  const lost = Math.max(0, surplus * i.seconds - capacity);
  return { written, lost, share: written > 0 ? lost / written : 0, capacity, secondsToFill: surplus > 0 ? capacity / surplus : Infinity };
}

/** The same burst on a real RingBuffer. The reader takes `readRate` events per second in small steps. */
export function runBurst(i: LossInput, mode: RingMode = "overwrite", stepsPerSecond = 1000): RingStats {
  const pages = Math.max(2, Math.floor((i.bufferKiB * 1024) / (i.pageBytes ?? PAGE_BYTES)));
  const ring = new RingBuffer(0, pages, i.pageBytes ?? PAGE_BYTES, mode);
  const steps = Math.round(i.seconds * stepsPerSecond);
  let wDebt = 0, rDebt = 0;
  for (let s = 0; s < steps; s++) {
    wDebt += i.eventRate / stepsPerSecond;
    rDebt += i.readRate / stepsPerSecond;
    for (; wDebt >= 1; wDebt--) ring.write(i.eventBytes, s);
    for (; rDebt >= 1; rDebt--) if (!ring.readEvent()) { rDebt = 0; break; }
  }
  return ring.stats();
}
