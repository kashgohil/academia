/**
 * WebSockets (RFC 6455) and the other ways a server pushes data to a browser.
 *
 * - The opening handshake: an HTTP/1.1 GET with `Upgrade: websocket` and a random 16-byte `Sec-WebSocket-Key`
 *   (base64). The server proves it understood by returning `Sec-WebSocket-Accept` = base64(SHA-1(key + GUID)).
 *   RFC 8441 runs the same thing on one HTTP/2 stream with an extended CONNECT (`:protocol = websocket`).
 * - Frames: FIN, RSV1-3, opcode (4 bits), MASK, a 7-bit length (126: a 16-bit length follows; 127: a 64-bit
 *   length follows), a 4-byte masking key when MASK is set, then the payload. A client must mask every frame,
 *   a server must not. Masking XORs the payload with the key, byte i with key[i mod 4].
 * - Why masking: a transparent proxy that does not understand the upgrade may parse the bytes after it as HTTP.
 *   Without masking, a script could write bytes that look like a request and poison the proxy's cache
 *   (Huang et al., "Talking to Yourself for Fun and Profit", W2SP 2011). With a random key per frame, the script
 *   cannot choose the bytes on the wire.
 * - `backpressureRun`: a server that sends faster than the client reads, on the reference TCP.
 * - `pushCompare`: long polling, Server-Sent Events and WebSockets carrying the same stream of events.
 */
import type { Field } from "../bytes";
import { PacketNet } from "../packet";
import { TcpStack } from "../transport";
import { mulberry32 } from "../../rng";
import { base64, sha1 } from "./sha1";
import { browserRequest, byteLength, parseStream, response, serialize, type HttpMessage, type ParseResult } from "./http1";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const acceptKey = (key: string) => base64(sha1(new TextEncoder().encode(key + WS_GUID)));

export function upgradeRequest(key: string, host = "chat.example.com", path = "/chat"): HttpMessage {
  return {
    start: `GET ${path} HTTP/1.1`,
    headers: [["Host", host], ["Upgrade", "websocket"], ["Connection", "Upgrade"], ["Sec-WebSocket-Key", key], ["Sec-WebSocket-Version", "13"], ["Origin", `https://${host}`]],
    body: "",
  };
}

export const upgradeResponse = (key: string): HttpMessage =>
  response(101, "Switching Protocols", [["Upgrade", "websocket"], ["Connection", "Upgrade"], ["Sec-WebSocket-Accept", acceptKey(key)]]);

/** The RFC 8441 form: an extended CONNECT on an HTTP/2 stream. */
export const h2ConnectHeaders = (host = "chat.example.com", path = "/chat"): [string, string][] => [
  [":method", "CONNECT"], [":protocol", "websocket"], [":scheme", "https"], [":path", path], [":authority", host], ["sec-websocket-version", "13"], ["origin", `https://${host}`],
];

/** SETTINGS_ENABLE_CONNECT_PROTOCOL (RFC 8441): the server sends 1 to allow extended CONNECT. */
export const SETTINGS_ENABLE_CONNECT_PROTOCOL = 0x8;

// ------------------------------------------------------------------------------------------------ frames

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
export type Opcode = keyof typeof OPCODE;

export interface WsFrame {
  fin: boolean;
  opcode: Opcode;
  /** Present for client-to-server frames. */
  mask?: Uint8Array;
  payload: Uint8Array;
}

export const maskBytes = (p: Uint8Array, key: Uint8Array) => p.map((b, i) => b ^ key[i % 4]!);

/** Bytes of the frame header: 2, plus 2 or 8 for a long length, plus 4 for a mask. */
export const wsHeaderBytes = (len: number, masked: boolean) => 2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + (masked ? 4 : 0);

export function encodeFrame(f: WsFrame): Uint8Array {
  const n = f.payload.length;
  const out = new Uint8Array(wsHeaderBytes(n, !!f.mask) + n);
  out[0] = (f.fin ? 0x80 : 0) | OPCODE[f.opcode];
  let at = 2;
  if (n < 126) out[1] = n;
  else if (n < 65536) {
    out[1] = 126;
    out[2] = n >> 8;
    out[3] = n & 0xff;
    at = 4;
  } else {
    out[1] = 127;
    let x = n;
    for (let i = 9; i >= 2; i--) {
      out[i] = x % 256;
      x = Math.floor(x / 256);
    }
    at = 10;
  }
  if (f.mask) {
    out[1]! |= 0x80;
    out.set(f.mask, at);
    at += 4;
    out.set(maskBytes(f.payload, f.mask), at);
  } else out.set(f.payload, at);
  return out;
}

export function decodeFrame(b: Uint8Array): WsFrame & { length: number } {
  const fin = !!(b[0]! & 0x80);
  const op = b[0]! & 0x0f;
  const masked = !!(b[1]! & 0x80);
  let n = b[1]! & 0x7f, at = 2;
  if (n === 126) {
    n = (b[2]! << 8) | b[3]!;
    at = 4;
  } else if (n === 127) {
    n = 0;
    for (let i = 2; i < 10; i++) n = n * 256 + b[i]!;
    at = 10;
  }
  const mask = masked ? b.slice(at, at + 4) : undefined;
  if (masked) at += 4;
  const raw = b.slice(at, at + n);
  const opcode = (Object.entries(OPCODE).find(([, v]) => v === op)?.[0] ?? "binary") as Opcode;
  return { fin, opcode, mask, payload: mask ? maskBytes(raw, mask) : raw, length: at + n };
}

export function frameFields(f: WsFrame): Field[] {
  const n = f.payload.length;
  const fields: Field[] = [
    { name: "FIN", bits: 1, value: f.fin ? 1 : 0, note: "last fragment of a message" },
    { name: "RSV1", bits: 1, value: 0, short: "R1", note: "used by extensions (permessage-deflate)" },
    { name: "RSV2", bits: 1, value: 0, short: "R2", note: "reserved" },
    { name: "RSV3", bits: 1, value: 0, short: "R3", note: "reserved" },
    { name: "Opcode", bits: 4, value: OPCODE[f.opcode], short: "Op", note: "0 continuation, 1 text, 2 binary, 8 close, 9 ping, 10 pong" },
    { name: "MASK", bits: 1, value: f.mask ? 1 : 0, short: "M", note: "1 on every client-to-server frame" },
    { name: "Payload len", bits: 7, value: n < 126 ? n : n < 65536 ? 126 : 127, short: "Len", note: "0..125, or 126 / 127 for a longer length" },
  ];
  if (n >= 126 && n < 65536) fields.push({ name: "Extended payload length", bits: 16, value: n, short: "Ext len", note: "16-bit length" });
  if (n >= 65536) fields.push({ name: "Extended payload length", bits: 64, value: BigInt(n), short: "Ext len", note: "64-bit length" });
  if (f.mask) fields.push({ name: "Masking key", bits: 32, value: f.mask, short: "Key", note: "random per frame; XOR with the payload" });
  return fields;
}

// ------------------------------------------------------------------------------------------------ proxy confusion

/**
 * What a transparent proxy sees if it ignored the 101 response and kept parsing the client's bytes as HTTP:
 * the frame that carries `text`, parsed with an HTTP/1.1 request parser.
 */
export function proxyView(text: string, mask: Uint8Array | undefined): { frame: Uint8Array; parsed: ParseResult; asText: string } {
  const frame = encodeFrame({ fin: true, opcode: "text", mask, payload: new TextEncoder().encode(text) });
  // The proxy skips nothing: it reads the stream from the first byte of the frame. The header bytes become part of
  // the "request line", so the attack payload starts with a line break to begin a fresh line after them.
  const asText = String.fromCharCode(...frame);
  const parsed = parseStream(asText, "request");
  return { frame, parsed, asText };
}

/** The attacker's payload: after the frame header, a complete request with a Host of the attacker's choice. */
export const POISON_PAYLOAD = "\r\n\r\nGET /lib/jquery.js HTTP/1.1\r\nHost: cdn.example.net\r\n\r\n";

// ------------------------------------------------------------------------------------------------ backpressure

export interface BackpressureOpts {
  /** Messages the server produces per second, and their size. */
  rate: number;
  msgBytes: number;
  /** Bytes per second the client application reads. */
  readBps: number;
  rttMs: number;
  mbps: number;
  /** Client receive buffer in bytes (a model input). */
  rcvBuf: number;
  /** Pause when the send buffer holds more than this (bytes); on pause the server keeps only the newest message. */
  backpressure: boolean;
  highWater: number;
  durationMs: number;
}

export interface BackpressureRun {
  /** [t, send-buffer bytes (bufferedAmount), client unread bytes, age of the message the client just read]. */
  samples: [number, number, number, number][];
  produced: number;
  sent: number;
  /** Messages replaced by a newer one while paused. */
  coalesced: number;
  maxBuffered: number;
}

export function backpressureRun(o: BackpressureOpts): BackpressureRun {
  const net = new PacketNet<any>(["server", "client"], { seed: 1, record: false });
  net.connect(0, 1, { rate: o.mbps * 1e6, delay: o.rttMs / 2 });
  net.computeRoutes();
  const stack = new TcpStack(net, { nagle: false, delayedAck: 0, rcvBuf: o.rcvBuf, rcvBufMax: o.rcvBuf, timeWait: 0, log: false });
  net.setHandlers({
    onDeliver: (n, p) => void stack.deliver(n, p),
    onTimer: (n, tag) => {
      if (stack.timer(n, tag)) return;
      if (tag === "produce") produce();
      else if (tag === "read") readTick();
    },
  });
  let server: ReturnType<TcpStack["connect"]> | undefined;
  stack.listen(1, 443, { conn: { autoRead: false }, onAccept: () => {} });
  const frame = wsHeaderBytes(o.msgBytes, false) + o.msgBytes;
  // Byte offsets of each message in the stream, and when it was produced.
  const ends: { end: number; at: number }[] = [];
  let written = 0, produced = 0, sent = 0, coalesced = 0, held: number | undefined, maxBuffered = 0, readTotal = 0, lastAge = 0, mi = 0;
  const samples: BackpressureRun["samples"] = [];
  const writeMsg = (at: number) => {
    server!.write(frame);
    written += frame;
    ends.push({ end: written, at });
    sent++;
  };
  const produce = () => {
    if (net.now > o.durationMs) return;
    produced++;
    if (o.backpressure && server!.unsent > o.highWater) {
      if (held !== undefined) coalesced++;
      held = net.now;
    } else {
      if (held !== undefined) {
        // Room again: send the newest held message, not a backlog.
        coalesced++;
        held = undefined;
      }
      writeMsg(net.now);
    }
    net.setTimer(0, 1000 / o.rate, "produce");
  };
  const tickMs = 10;
  const readTick = () => {
    const client = stack.conns.find((c) => c.node === 1);
    if (client) {
      if (o.backpressure && held !== undefined && server!.unsent <= o.highWater) {
        writeMsg(held);
        held = undefined;
      }
      const n = client.read((o.readBps * tickMs) / 1000);
      readTotal += n;
      while (mi < ends.length && ends[mi]!.end <= readTotal) lastAge = net.now - ends[mi++]!.at;
      maxBuffered = Math.max(maxBuffered, server!.unsent);
      samples.push([net.now, server!.unsent, client.unread, lastAge]);
    }
    if (net.now < o.durationMs) net.setTimer(0, tickMs, "read");
  };
  server = stack.connect(0, 1, 443);
  server.onEstablished = () => {
    produce();
    readTick();
  };
  net.runUntil(o.durationMs + 50);
  return { samples, produced, sent, coalesced, maxBuffered };
}

// ------------------------------------------------------------------------------------------------ push methods

export type PushMethod = "long-polling" | "sse" | "websocket";

/** The event the demos push (a model input). */
export const EVENT_JSON = '{"type":"quote","sym":"ACME","bid":101.25,"ask":101.27}';
/** IPv4 + TCP headers per packet. */
export const TCPIP_BYTES = 40;

/** Bytes on the wire for one delivery of `k` events by each method, from real message text. */
export function pushBytes(method: PushMethod, k: number) {
  const ev = byteLength(EVENT_JSON);
  if (method === "websocket") return k * (wsHeaderBytes(ev, false) + ev);
  if (method === "sse") {
    // "data: <json>\n\n" in one HTTP/1.1 chunk: hex size, CRLF, data, CRLF.
    const line = byteLength(`data: ${EVENT_JSON}\n\n`);
    return k * (line.toString(16).length + 2 + line + 2);
  }
  // A long-poll response with all waiting events as a JSON array, then the client's next poll request.
  const body = byteLength(`[${Array(k).fill(EVENT_JSON).join(",")}]`);
  const head = byteLength(serialize(response(200, "OK", [["Content-Type", "application/json"], ["Content-Length", String(body)], ["Cache-Control", "no-store"]])));
  return head + body + byteLength(serialize(browserRequest("/poll?since=1842")));
}

export interface PushResult {
  method: PushMethod;
  /** Delay from the event at the server to its arrival at the client, per event (ms). */
  delays: number[];
  meanMs: number;
  p99Ms: number;
  /** Bytes on the wire per event, both directions, headers included. */
  bytesPerEvent: number;
  /** Responses (long polling) or frames carrying events. */
  deliveries: number;
}

/**
 * Events at random times (Poisson, `rate` per second) for `seconds`, pushed to one client over a link with `rttMs`.
 * Long polling: the client always has one request waiting; the server answers it with every event it has, and the
 * client sends the next request at once. Events in between wait for that request. SSE and WebSockets send each event
 * as soon as it exists, on a connection that stays open.
 */
export function pushCompare(method: PushMethod, o: { rate: number; seconds: number; rttMs: number; seed?: number }): PushResult {
  const net = new PacketNet<{ k: "poll" | "resp" | "ev"; events: number[] }>(["server", "client"], { seed: o.seed ?? 5, record: false });
  net.connect(0, 1, { rate: 10e6, delay: o.rttMs / 2 });
  net.computeRoutes();
  const rng = mulberry32(o.seed ?? 5);
  const times: number[] = [];
  for (let t = 0; ; ) {
    t += (-Math.log(1 - rng()) / o.rate) * 1000;
    if (t > o.seconds * 1000) break;
    times.push(t);
  }
  const delays: number[] = [];
  let bytes = 0, deliveries = 0, pollWaiting = false;
  const queue: number[] = [];
  const deliver = (evs: number[]) => {
    deliveries++;
    const b = pushBytes(method, evs.length);
    bytes += b + TCPIP_BYTES * Math.ceil(b / 1460) * (method === "long-polling" ? 2 : 1);
    net.send(0, 1, b, { k: method === "long-polling" ? "resp" : "ev", events: evs });
  };
  net.setHandlers({
    onDeliver(node, pkt) {
      const p = pkt.payload;
      if (node === 0 && p.k === "poll") {
        if (queue.length) deliver(queue.splice(0));
        else pollWaiting = true;
      } else if (node === 1) {
        for (const t of p.events) delays.push(net.now - t);
        if (p.k === "resp") net.send(1, 0, byteLength(serialize(browserRequest("/poll?since=1842"))), { k: "poll", events: [] });
      }
    },
  });
  for (const t of times) {
    net.at(t, () => {
      if (method !== "long-polling") return deliver([t]);
      queue.push(t);
      if (pollWaiting) {
        pollWaiting = false;
        deliver(queue.splice(0));
      }
    });
  }
  if (method === "long-polling") net.send(1, 0, 400, { k: "poll", events: [] });
  net.runAll();
  const sorted = [...delays].sort((a, b) => a - b);
  return {
    method, delays,
    meanMs: delays.reduce((a, b) => a + b, 0) / Math.max(1, delays.length),
    p99Ms: sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] ?? NaN,
    bytesPerEvent: bytes / Math.max(1, delays.length),
    deliveries,
  };
}
