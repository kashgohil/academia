/**
 * HTTP/2 (RFC 9113) pieces that the lesson needs besides HPACK (hpack.ts) and the page loads (pageload.ts):
 *
 * - The 9-byte frame header and the frame types, as bytes and as fields for HeaderDiagram.
 * - Stream scheduling with priorities: none (round-robin), the RFC 7540 dependency tree with weights (deprecated
 *   by RFC 9113), and the Extensible Priorities of RFC 9218 (urgency 0..7 and an incremental flag).
 * - Rapid Reset (CVE-2023-44487): how many requests per second one connection can make a server start, when the
 *   client cancels each request at once and cancelled streams stop counting against SETTINGS_MAX_CONCURRENT_STREAMS.
 * - Flow control: a window of W bytes allows at most W bytes per round trip.
 */
import type { Field } from "../bytes";
import { HpackEncoder } from "./hpack";
import { h2RequestHeaders } from "./pageload";

export const FRAME_TYPES = {
  DATA: 0x0, HEADERS: 0x1, PRIORITY: 0x2, RST_STREAM: 0x3, SETTINGS: 0x4, PUSH_PROMISE: 0x5, PING: 0x6, GOAWAY: 0x7, WINDOW_UPDATE: 0x8, CONTINUATION: 0x9,
} as const;
export type FrameType = keyof typeof FRAME_TYPES;
export const FLAG = { END_STREAM: 0x1, ACK: 0x1, END_HEADERS: 0x4, PADDED: 0x8, PRIORITY: 0x20 } as const;

/** RFC 9113 section 6.5.2 initial values. */
export const H2_SETTINGS_DEFAULTS = {
  HEADER_TABLE_SIZE: 4096, ENABLE_PUSH: 1, MAX_CONCURRENT_STREAMS: Infinity, INITIAL_WINDOW_SIZE: 65535, MAX_FRAME_SIZE: 16384, MAX_HEADER_LIST_SIZE: Infinity,
} as const;

export function frameHeaderFields(f?: { length: number; type: FrameType; flags: number; stream: number }): Field[] {
  return [
    { name: "Length", bits: 24, value: f?.length, note: "payload bytes, not counting these 9 (at most 16,384 unless SETTINGS allows more)" },
    { name: "Type", bits: 8, value: f ? FRAME_TYPES[f.type] : undefined, note: "DATA 0, HEADERS 1, RST_STREAM 3, SETTINGS 4, GOAWAY 7, WINDOW_UPDATE 8, …" },
    { name: "Flags", bits: 8, value: f?.flags, note: "END_STREAM 0x1, END_HEADERS 0x4, PADDED 0x8, PRIORITY 0x20" },
    { name: "R", bits: 1, value: 0, note: "reserved, zero" },
    { name: "Stream Identifier", bits: 31, value: f?.stream, short: "Stream", note: "0 for the connection; odd numbers for client-opened streams" },
  ];
}

export function frameBytes(type: FrameType, flags: number, stream: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  const n = payload.length;
  out[0] = (n >> 16) & 0xff;
  out[1] = (n >> 8) & 0xff;
  out[2] = n & 0xff;
  out[3] = FRAME_TYPES[type];
  out[4] = flags;
  out[5] = (stream >>> 24) & 0x7f;
  out[6] = (stream >>> 16) & 0xff;
  out[7] = (stream >>> 8) & 0xff;
  out[8] = stream & 0xff;
  out.set(payload, 9);
  return out;
}

/** RST_STREAM: a 9-byte header and a 4-byte error code (CANCEL is 0x8). */
export const RST_STREAM_BYTES = 9 + 4;
export const ERROR_CANCEL = 0x8;

// ------------------------------------------------------------------------------------------------ flow control

/** The most a window of `window` bytes allows, in Mbit/s, at round-trip time `rttMs`. */
export const windowLimitMbps = (window: number, rttMs: number) => (window * 8) / (rttMs * 1000);

// ------------------------------------------------------------------------------------------------ priorities

export interface PrioResource {
  name: string;
  bytes: number;
  /** RFC 9218: urgency 0 (most urgent) .. 7, default 3; incremental: the client can use partial data. */
  urgency: number;
  incremental: boolean;
  /** RFC 7540: weight 1..256 under the parent (`parent` = index of another resource, or -1 for the root). */
  weight: number;
  parent: number;
  /** Needed before the browser can draw the page (style sheets, scripts in the head). */
  blocking: boolean;
}

/** The demo's resources and priorities (model inputs, in the spirit of what browsers send). */
export const PRIO_PAGE: PrioResource[] = [
  { name: "style.css", bytes: 25_000, urgency: 0, incremental: false, weight: 256, parent: -1, blocking: true },
  { name: "app.js", bytes: 80_000, urgency: 1, incremental: false, weight: 220, parent: -1, blocking: true },
  { name: "font.woff2", bytes: 30_000, urgency: 2, incremental: false, weight: 183, parent: -1, blocking: false },
  { name: "hero.jpg", bytes: 120_000, urgency: 3, incremental: true, weight: 147, parent: -1, blocking: false },
  { name: "img1.jpg", bytes: 60_000, urgency: 5, incremental: true, weight: 110, parent: -1, blocking: false },
  { name: "img2.jpg", bytes: 60_000, urgency: 5, incremental: true, weight: 110, parent: -1, blocking: false },
  { name: "analytics.js", bytes: 40_000, urgency: 6, incremental: false, weight: 32, parent: -1, blocking: false },
];

export type Scheme = "none" | "rfc7540" | "rfc9218";

export interface PrioRun {
  /** [start, end, resource] for each DATA frame, in ms. */
  frames: [number, number, number][];
  done: number[];
  /** When every blocking resource is complete: the browser can start to draw. */
  renderAt: number;
  total: number;
}

/**
 * Sends the resources' DATA frames over a link of `mbps`, one frame at a time, choosing each frame by the scheme.
 * All requests arrive at time 0 (the server has every response ready), so only the scheduler differs.
 */
export function schedule(res: PrioResource[], scheme: Scheme, mbps: number, frame = 16384): PrioRun {
  const left = res.map((r) => r.bytes);
  const sent = res.map(() => 0);
  const done = res.map(() => NaN);
  const frames: [number, number, number][] = [];
  let t = 0, rr = 0;
  const hasData = (i: number) => left[i]! > 0;
  // RFC 7540: data of a stream's subtree, for the weighted share among siblings.
  const subtree = (i: number): boolean => hasData(i) || res.some((r, j) => r.parent === i && subtree(j));
  const pick7540 = (parent: number): number => {
    const kids = res.map((r, j) => ({ r, j })).filter(({ r, j }) => r.parent === parent && subtree(j));
    if (!kids.length) return -1;
    // Stride scheduling: the child that has had the least service per unit of weight goes next.
    kids.sort((a, b) => sent[a.j]! / a.r.weight - sent[b.j]! / b.r.weight || a.j - b.j);
    const k = kids[0]!.j;
    if (hasData(k)) return k;
    return pick7540(k);
  };
  while (left.some((x) => x > 0)) {
    let i: number;
    if (scheme === "none") {
      const live = res.map((_, j) => j).filter(hasData);
      i = live[rr++ % live.length]!;
    } else if (scheme === "rfc7540") i = pick7540(-1);
    else {
      const u = Math.min(...res.filter((_, j) => hasData(j)).map((r) => r.urgency));
      const level = res.map((r, j) => ({ r, j })).filter(({ r, j }) => r.urgency === u && hasData(j));
      const seq = level.filter(({ r }) => !r.incremental);
      if (seq.length) i = seq[0]!.j;
      else i = level[rr++ % level.length]!.j;
    }
    const n = Math.min(frame, left[i]!);
    const dt = ((n + 9) * 8) / (mbps * 1000);
    frames.push([t, t + dt, i]);
    t += dt;
    left[i]! -= n;
    sent[i]! += n;
    if (left[i] === 0) done[i] = t;
  }
  const renderAt = Math.max(...res.map((r, j) => (r.blocking ? done[j]! : 0)));
  return { frames, done, renderAt, total: t };
}

// ------------------------------------------------------------------------------------------------ Rapid Reset

/** SETTINGS_MAX_CONCURRENT_STREAMS that many servers send (RFC 9113 says it should be at least 100). */
export const COMMON_MAX_STREAMS = 100;

/** Bytes per request in a flood: a HEADERS frame whose HPACK block is all indexed after the first request. */
export function floodRequestBytes(): { headers: number; rst: number } {
  const e = new HpackEncoder();
  e.encode(h2RequestHeaders("/"));
  const block = e.encode(h2RequestHeaders("/")).bytes.length;
  return { headers: 9 + block, rst: RST_STREAM_BYTES };
}

export type Mitigation = "none" | "count-until-done" | "goaway";

export interface RapidOpts {
  rttMs: number;
  uplinkMbps: number;
  /** Time the server (and its back end) works on a request, in ms. */
  workMs: number;
  maxStreams?: number;
  /** "count-until-done": a cancelled stream counts against the limit until its work stops.
   *  "goaway": the server closes the connection after `goawayAfter` resets; the client reconnects (TCP + TLS, 2 RTTs). */
  mitigation: Mitigation;
  goawayAfter?: number;
}

export interface RapidResult {
  /** Requests per second one connection makes the server start: a well-behaved client, and an attacker. */
  normalRps: number;
  attackRps: number;
  /** Requests in progress at the server on average (Little's law: rate × work time). */
  normalBusy: number;
  attackBusy: number;
  /** The limit that binds the attacker. */
  limit: "uplink" | "streams" | "reconnects";
  bytesPerRequest: number;
}

export function rapidReset(o: RapidOpts): RapidResult {
  const maxStreams = o.maxStreams ?? COMMON_MAX_STREAMS;
  const { headers, rst } = floodRequestBytes();
  const bytesPerRequest = headers + rst;
  const uplinkRps = (o.uplinkMbps * 1e6) / 8 / bytesPerRequest;
  // A normal client keeps at most maxStreams open; each lives one RTT plus the work time.
  const normalRps = Math.min((maxStreams * 1000) / (o.rttMs + o.workMs), (o.uplinkMbps * 1e6) / 8 / headers);
  let attackRps: number, limit: RapidResult["limit"];
  if (o.mitigation === "none") {
    attackRps = uplinkRps;
    limit = "uplink";
  } else if (o.mitigation === "count-until-done") {
    // The streams stay counted until the work stops: at most maxStreams in progress, so maxStreams per workMs.
    const streamRps = (maxStreams * 1000) / Math.max(o.workMs, 1e-9);
    attackRps = Math.min(uplinkRps, streamRps);
    limit = streamRps < uplinkRps ? "streams" : "uplink";
  } else {
    const n = o.goawayAfter ?? 1000;
    const cycleMs = (n / uplinkRps) * 1000 + 2 * o.rttMs;
    attackRps = (n * 1000) / cycleMs;
    limit = (2 * o.rttMs) > (n / uplinkRps) * 1000 ? "reconnects" : "uplink";
  }
  return {
    normalRps, attackRps, limit, bytesPerRequest,
    normalBusy: (normalRps * o.workMs) / 1000,
    attackBusy: (attackRps * o.workMs) / 1000,
  };
}
