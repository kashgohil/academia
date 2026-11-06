/**
 * Event-time windows with watermarks, fed by the shared Net.
 *
 * Sensors (nodes 1..S) create events with an event time (when it happened) and send them to one operator
 * (node 0). Most events take 20 to 80 ms. A few are stragglers: with probability `stragglerP` an event waits an
 * extra exponential time with mean `stragglerMean` ms (a phone in a tunnel, a retry). So events arrive out of order.
 *
 * The operator keeps a watermark: W = (largest event time seen so far) − `delay`. The watermark is a promise: "no
 * event older than W will come". A window [start, end) fires when W ≥ end. An event that arrives for a window that
 * has already fired is late. Within `allowedLateness` after the end, a late event updates the result (a second
 * firing); after that it is dropped. When the input ends, a final watermark of +∞ fires every open window.
 *
 * Windows: tumbling (size), sliding (size, slide) and session (gap). The batch result groups all events by event
 * time, with no watermark; a stream result is correct when it equals the batch result.
 * The latencies and the straggler model are MODEL INPUTS.
 */
import { Net } from "../net";

export type WindowKind = "tumbling" | "sliding" | "session";

export interface StreamConfig {
  seed: number;
  sensors: number;
  /** Each sensor creates an event every `every` ms (with jitter), from 0 to `duration`. */
  every: number;
  duration: number;
  latency: { min: number; max: number };
  stragglerP: number;
  stragglerMean: number;
  /** After an event, a sensor goes quiet for `idle` ms with probability `idleP` (this makes sessions). */
  idleP: number;
  idle: number;
  kind: WindowKind;
  size: number;
  slide: number;
  gap: number;
  /** Watermark delay: the bounded out-of-orderness, in ms. */
  delay: number;
  allowedLateness: number;
}

export const STREAM_DEFAULTS: StreamConfig = {
  seed: 5, sensors: 3, every: 150, duration: 8000, latency: { min: 20, max: 80 }, stragglerP: 0.1, stragglerMean: 600, idleP: 0.15, idle: 700,
  kind: "tumbling", size: 1000, slide: 500, gap: 300, delay: 200, allowedLateness: 0,
};

export interface StEvent { id: number; sensor: number; et: number; arrival: number }

/** A window, identified by its bounds. Session windows of different sensors are separate (keyed by sensor). */
export interface Win { start: number; end: number; key: number }
export const winKey = (w: Win) => `${w.key}:${w.start}:${w.end}`;

export interface Firing { win: Win; count: number; at: number; watermark: number; update: boolean }

export interface StreamRun {
  cfg: StreamConfig;
  events: StEvent[];
  /** Watermark after each arrival: [arrival time, watermark]. */
  watermarks: [number, number][];
  firings: Firing[];
  /** Events that came after their window closed for good. */
  dropped: StEvent[];
  /** Events that arrived after their window first fired, but within the allowed lateness. */
  updatedLate: StEvent[];
  /** The final count per window from the stream, and from the batch. */
  stream: Map<string, { win: Win; count: number }>;
  batch: Map<string, { win: Win; count: number }>;
  /** Batch windows that the stream did not reproduce exactly (a missing window, or another count). */
  wrong: string[];
  /** Mean time from a window's end (in event time) to its first firing (in processing time). */
  meanLatency: number;
  /** The largest out-of-orderness actually seen: max over events of (max event time before it) − its event time. */
  maxDisorder: number;
}

/** The windows that an event belongs to, for tumbling and sliding windows. */
export function windowsOf(kind: WindowKind, et: number, size: number, slide: number, key = 0): Win[] {
  if (kind === "tumbling") {
    const s = Math.floor(et / size) * size;
    return [{ start: s, end: s + size, key }];
  }
  const out: Win[] = [];
  const last = Math.floor(et / slide) * slide;
  for (let s = last; s > et - size; s -= slide) out.push({ start: s, end: s + size, key });
  return out.reverse();
}

/** Session windows from a set of event times of one key: events closer than `gap` join one session. */
export function sessions(times: number[], gap: number, key: number): { win: Win; count: number }[] {
  const ts = [...times].sort((a, b) => a - b);
  const out: { win: Win; count: number }[] = [];
  for (const t of ts) {
    const cur = out[out.length - 1];
    if (cur && t < cur.win.end) { cur.win.end = Math.max(cur.win.end, t + gap); cur.count++; }
    else out.push({ win: { start: t, end: t + gap, key }, count: 1 });
  }
  return out;
}

/** Makes the events on Net: each sensor sends each event to the operator, with its own delay. */
export function streamEvents(cfgIn: Partial<StreamConfig> = {}): StEvent[] {
  const cfg = { ...STREAM_DEFAULTS, ...cfgIn, latency: { ...STREAM_DEFAULTS.latency, ...cfgIn.latency } };
  const events: StEvent[] = [];
  let id = 0;
  const net = new Net<{ id: number; et: number }>(cfg.sensors + 1, { seed: cfg.seed, latency: cfg.latency }, {
    onMessage(node, m, nt) {
      if (node === 0) events.push({ id: m.payload.id, sensor: m.from, et: m.payload.et, arrival: nt.now });
    },
    onTimer(node, _tag, nt) {
      const et = Math.round(nt.now);
      if (et > cfg.duration) return;
      let d = cfg.latency.min + nt.random() * (cfg.latency.max - cfg.latency.min);
      if (nt.random() < cfg.stragglerP) d += -cfg.stragglerMean * Math.log(1 - nt.random());
      nt.send(node, 0, { id: id++, et }, { delay: d });
      const quiet = nt.random() < cfg.idleP ? cfg.idle : 0;
      nt.setTimer(node, cfg.every * (0.5 + nt.random()) + quiet, "tick");
    },
  });
  for (let s = 1; s <= cfg.sensors; s++) net.setTimer(s, net.random() * cfg.every, "tick");
  net.runAll();
  return events;
}

export function runStream(cfgIn: Partial<StreamConfig> = {}, given?: StEvent[]): StreamRun {
  const cfg = { ...STREAM_DEFAULTS, ...cfgIn, latency: { ...STREAM_DEFAULTS.latency, ...cfgIn.latency } };
  const events = given ?? streamEvents(cfg);
  const firings: Firing[] = [];
  const dropped: StEvent[] = [];
  const updatedLate: StEvent[] = [];
  const watermarks: [number, number][] = [];
  const stream = new Map<string, { win: Win; count: number }>();
  /** Open state: windows not yet purged, with whether they fired. */
  const open = new Map<string, { win: Win; count: number; fired: boolean }>();
  /** Session state per key: open sessions (merged as events come). */
  let maxEt = -Infinity, wm = -Infinity, maxDisorder = 0;

  const emit = (w: { win: Win; count: number; fired: boolean }, at: number, update: boolean) => {
    firings.push({ win: { ...w.win }, count: w.count, at, watermark: wm, update });
    stream.set(winKey(w.win), { win: { ...w.win }, count: w.count });
    w.fired = true;
  };
  const advance = (at: number) => {
    for (const [k, w] of [...open]) {
      if (!w.fired && wm >= w.win.end) emit(w, at, false);
      if (wm >= w.win.end + cfg.allowedLateness) open.delete(k);
    }
  };

  for (const e of events) {
    maxDisorder = Math.max(maxDisorder, maxEt - e.et);
    // Is the event too late? Its window(s) were purged: the watermark passed end + allowed lateness.
    if (cfg.kind === "session") {
      const mine = [...open.values()].filter((w) => w.win.key === e.sensor && e.et < w.win.end && e.et + cfg.gap > w.win.start);
      const startNew = e.et, endNew = e.et + cfg.gap;
      if (!mine.length && wm >= endNew + cfg.allowedLateness) dropped.push(e);
      else {
        // Merge the new event with every session it touches.
        const merged = { win: { start: Math.min(startNew, ...mine.map((w) => w.win.start)), end: Math.max(endNew, ...mine.map((w) => w.win.end)), key: e.sensor }, count: 1 + mine.reduce((a, w) => a + w.count, 0), fired: mine.some((w) => w.fired) };
        for (const w of mine) { open.delete(winKey(w.win)); if (w.fired) stream.delete(winKey(w.win)); }
        open.set(winKey(merged.win), merged);
        if (merged.fired) { updatedLate.push(e); if (wm >= merged.win.end) emit(merged, e.arrival, true); else merged.fired = false; }
      }
    } else {
      const ws = windowsOf(cfg.kind, e.et, cfg.size, cfg.slide);
      let late = false, drop = false;
      for (const win of ws) {
        const k = winKey(win);
        if (wm >= win.end + cfg.allowedLateness) { drop = true; continue; }
        let w = open.get(k);
        if (!w) { w = { win, count: 0, fired: false }; open.set(k, w); }
        w.count++;
        if (w.fired) { late = true; emit(w, e.arrival, true); }
      }
      if (drop) dropped.push(e);
      else if (late) updatedLate.push(e);
    }
    maxEt = Math.max(maxEt, e.et);
    wm = Math.max(wm, maxEt - cfg.delay);
    watermarks.push([e.arrival, wm]);
    advance(e.arrival);
  }
  // End of input: the final watermark is +∞.
  const endAt = events.length ? events[events.length - 1]!.arrival : 0;
  wm = Infinity;
  advance(endAt);

  const batch = batchResult(cfg, events);
  // A batch window is right if the stream produced the same window with the same count.
  const wrong = [...batch.keys()].filter((k) => batch.get(k)!.count !== (stream.get(k)?.count ?? 0));
  const firsts = firings.filter((f) => !f.update && Number.isFinite(f.watermark));
  const meanLatency = firsts.length ? firsts.reduce((a, f) => a + (f.at - f.win.end), 0) / firsts.length : NaN;
  return { cfg, events, watermarks, firings, dropped, updatedLate, stream, batch, wrong, meanLatency, maxDisorder };
}

/** The batch answer: all events, grouped by event time. */
export function batchResult(cfg: StreamConfig, events: StEvent[]): Map<string, { win: Win; count: number }> {
  const out = new Map<string, { win: Win; count: number }>();
  if (cfg.kind === "session") {
    const byKey = new Map<number, number[]>();
    for (const e of events) byKey.set(e.sensor, [...(byKey.get(e.sensor) ?? []), e.et]);
    for (const [k, ts] of byKey) for (const s of sessions(ts, cfg.gap, k)) out.set(winKey(s.win), s);
    return out;
  }
  for (const e of events) for (const win of windowsOf(cfg.kind, e.et, cfg.size, cfg.slide)) {
    const k = winKey(win);
    const cur = out.get(k) ?? { win, count: 0 };
    cur.count++;
    out.set(k, cur);
  }
  return out;
}

/** Processing-time tumbling windows, for contrast: each event counts in the window of its arrival time. */
export function processingTimeCounts(events: StEvent[], size: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of events) {
    const s = Math.floor(e.arrival / size) * size;
    out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}
