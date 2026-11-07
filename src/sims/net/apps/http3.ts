/**
 * HTTP/3 (RFC 9114) on QUIC:
 *
 * - QUIC variable-length integers (RFC 9000 section 16): the top two bits give the length (1, 2, 4 or 8 bytes).
 * - HTTP/3 frames are a varint type, a varint length and a payload. A request is a HEADERS frame (a QPACK field
 *   section) and DATA frames on one client-opened bidirectional stream (ids 0, 4, 8, …).
 * - Each side also opens unidirectional streams, each starting with a stream type: control (0x00, carries
 *   SETTINGS first), QPACK encoder (0x02) and QPACK decoder (0x03). Client-opened unidirectional ids are 2, 6, 10, …
 * - `headerRace`: header blocks of several requests sent on separate streams over a lossy path, decoded as they
 *   arrive. With HPACK the decoder's table goes out of step; QPACK either blocks a stream or refuses to depend on
 *   entries that the decoder has not acknowledged.
 * - `discoveryRun`: how a client learns that a server speaks HTTP/3 (Alt-Svc, or an HTTPS DNS record), and what
 *   happens when UDP is blocked, with and without racing QUIC against TCP.
 */
import { PacketNet } from "../packet";
import { setupScript, type SetupKind } from "../cc";
import { HpackDecoder, HpackEncoder, HpackError, type Header } from "./hpack";
import { QpackDecoder, QpackEncoder } from "./qpack";
import { h2RequestHeaders } from "./pageload";

// ------------------------------------------------------------------------------------------------ varints

export function varint(v: number | bigint): Uint8Array {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 62n) throw new Error("varint out of range");
  const [len, prefix] = n < 64n ? [1, 0n] : n < 16384n ? [2, 1n] : n < 1n << 30n ? [4, 2n] : [8, 3n];
  const out = new Uint8Array(len);
  let x = n | (prefix << BigInt(8 * len - 2));
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function readVarint(b: Uint8Array, pos = 0): [bigint, number] {
  const len = 1 << (b[pos]! >> 6);
  let x = BigInt(b[pos]! & 0x3f);
  for (let i = 1; i < len; i++) x = (x << 8n) | BigInt(b[pos + i]!);
  return [x, pos + len];
}

export const varintLength = (v: number) => varint(v).length;

// ------------------------------------------------------------------------------------------------ frames and streams

export const H3_FRAME = { DATA: 0x00, HEADERS: 0x01, CANCEL_PUSH: 0x03, SETTINGS: 0x04, PUSH_PROMISE: 0x05, GOAWAY: 0x07, MAX_PUSH_ID: 0x0d } as const;
export const H3_STREAM_TYPE = { control: 0x00, push: 0x01, qpackEncoder: 0x02, qpackDecoder: 0x03 } as const;
export const H3_SETTING = { QPACK_MAX_TABLE_CAPACITY: 0x01, MAX_FIELD_SECTION_SIZE: 0x06, QPACK_BLOCKED_STREAMS: 0x07 } as const;

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export function h3Frame(type: number, payload: Uint8Array): Uint8Array {
  return cat(varint(type), varint(payload.length), payload);
}

export function settingsFrame(s: [number, number][]): Uint8Array {
  return h3Frame(H3_FRAME.SETTINGS, cat(...s.flatMap(([k, v]) => [varint(k), varint(v)])));
}

/** QUIC stream id: the low bit is the opener (0 client), the next bit is 1 for unidirectional. */
export const streamId = (n: number, client: boolean, uni: boolean) => 4 * n + (client ? 0 : 1) + (uni ? 2 : 0);

/** A QUIC STREAM frame header (RFC 9000 section 19.8) with OFF, LEN and optionally FIN set. */
export function streamFrameHeader(id: number, offset: number, length: number, fin: boolean): Uint8Array {
  return cat(new Uint8Array([0x08 | 0x04 | 0x02 | (fin ? 1 : 0)]), varint(id), varint(offset), varint(length));
}

export interface StreamBytes {
  id: number;
  label: string;
  /** Parts of the stream's payload, for colouring. */
  parts: { label: string; bytes: Uint8Array }[];
}

/**
 * The client's streams for `n` GET requests on a new connection: the control stream with SETTINGS, the QPACK
 * encoder and decoder streams, and one request stream per request.
 */
export function clientStreams(paths: string[], o: { capacity: number; blocked: number; allowBlocking: boolean }): StreamBytes[] {
  const enc = new QpackEncoder(o.capacity);
  const control: StreamBytes = {
    id: streamId(0, true, true), label: "control",
    parts: [
      { label: "stream type 0x00 (control)", bytes: varint(H3_STREAM_TYPE.control) },
      { label: "SETTINGS", bytes: settingsFrame([[H3_SETTING.QPACK_MAX_TABLE_CAPACITY, o.capacity], [H3_SETTING.QPACK_BLOCKED_STREAMS, o.blocked]]) },
    ],
  };
  const encoder: StreamBytes = { id: streamId(1, true, true), label: "QPACK encoder", parts: [{ label: "stream type 0x02 (encoder)", bytes: varint(H3_STREAM_TYPE.qpackEncoder) }] };
  const decoder: StreamBytes = { id: streamId(2, true, true), label: "QPACK decoder", parts: [{ label: "stream type 0x03 (decoder)", bytes: varint(H3_STREAM_TYPE.qpackDecoder) }] };
  const reqs: StreamBytes[] = paths.map((p, i) => {
    const sec = enc.encodeSection(h2RequestHeaders(p), { allowBlocking: o.allowBlocking });
    for (const ins of sec.instructions) encoder.parts.push({ label: ins.text, bytes: ins.bytes });
    return {
      id: streamId(i, true, false), label: `GET ${p}`,
      parts: [{ label: `HEADERS (QPACK, Required Insert Count ${sec.requiredInsertCount})`, bytes: h3Frame(H3_FRAME.HEADERS, sec.bytes) }],
    };
  });
  return [control, encoder, decoder, ...reqs];
}

// ------------------------------------------------------------------------------------------------ header blocks on independent streams

export type HeaderScheme = "hpack" | "qpack-blocking" | "qpack-safe";

export interface RacePacket {
  pn: number;
  /** "enc": QPACK encoder stream data; "req": a request's header block on its own stream. */
  kind: "enc" | "req";
  req: number;
  stream: number;
  bytes: number;
  label: string;
}

export interface StreamOutcome {
  req: number;
  stream: number;
  /** When its header block arrived, and when it could be decoded. */
  arrivedAt: number;
  decodedAt: number;
  result: string;
  ok: boolean;
  blockBytes: number;
}

export interface HeaderRace {
  net: PacketNet<RacePacket>;
  packets: RacePacket[];
  outcomes: StreamOutcome[];
  /** Header bytes of all requests (blocks + encoder stream). */
  totalBytes: number;
}

/** The requests of the demo: the same browser asks for three paths. */
export const RACE_PATHS = ["/", "/style.css", "/app.js"];

/**
 * Sends the header blocks of RACE_PATHS (and, for QPACK, the encoder stream) one per packet, 1 ms apart,
 * over a path with `rttMs`. Packets in `drop` are lost once and sent again when the sender notices (the packet
 * threshold of RFC 9002: an ACK for a packet 3 numbers later; or after 9/8 RTT when no later packet exists).
 * The server decodes each stream as soon as QUIC hands it over: QUIC orders bytes only within a stream.
 */
export function headerRace(o: { scheme: HeaderScheme; drop: number[]; rttMs: number }): HeaderRace {
  const reqs = RACE_PATHS.map((p) => h2RequestHeaders(p));
  const packets: RacePacket[] = [];
  const blocks: Uint8Array[] = [];
  let totalBytes = 0;
  let pn = 0;
  if (o.scheme === "hpack") {
    const e = new HpackEncoder();
    reqs.forEach((h, i) => {
      const b = e.encode(h).bytes;
      blocks.push(b);
      totalBytes += b.length;
      packets.push({ pn: pn++, kind: "req", req: i, stream: streamId(i, true, false), bytes: b.length, label: `stream ${streamId(i, true, false)}: HEADERS (${b.length} B)` });
    });
  } else {
    const e = new QpackEncoder(4096);
    const encChunks: Uint8Array[][] = [];
    reqs.forEach((h, i) => {
      const s = e.encodeSection(h, { allowBlocking: o.scheme === "qpack-blocking" });
      blocks.push(s.bytes);
      encChunks.push(s.instructions.map((x) => x.bytes));
      const encBytes = s.instructions.reduce((a, x) => a + x.bytes.length, 0);
      totalBytes += s.bytes.length + encBytes;
      const inserts = s.instructions.filter((x) => x.text.startsWith("Insert")).length;
      if (encBytes) packets.push({ pn: pn++, kind: "enc", req: i, stream: streamId(1, true, true), bytes: encBytes, label: `encoder stream: ${inserts} insert${inserts === 1 ? "" : "s"} (${encBytes} B)` });
      packets.push({ pn: pn++, kind: "req", req: i, stream: streamId(i, true, false), bytes: s.bytes.length, label: `stream ${streamId(i, true, false)}: HEADERS (${s.bytes.length} B), needs ${s.requiredInsertCount} inserts` });
    });
    (packets as (RacePacket & { chunks?: Uint8Array[] })[]).forEach((p) => {
      if (p.kind === "enc") (p as RacePacket & { chunks?: Uint8Array[] }).chunks = encChunks[p.req];
    });
  }

  const net = new PacketNet<RacePacket>(["client", "server"], { seed: 1, record: true });
  net.connect(0, 1, { rate: 100e6, delay: o.rttMs / 2 });
  net.computeRoutes();
  const sendAt = (p: RacePacket) => p.pn;
  const lostOnce = new Set(o.drop);
  net.dropIf = (pkt) => {
    if (pkt.src === 0 && lostOnce.has(pkt.payload.pn) && !(pkt.payload as RacePacket & { again?: boolean }).again) return true;
    return false;
  };
  for (const p of packets) {
    net.at(sendAt(p), () => net.send(0, 1, p.bytes + 40, p));
    if (lostOnce.has(p.pn)) {
      const later = packets.find((q) => q.pn === p.pn + 3 && !lostOnce.has(q.pn));
      const detect = later ? sendAt(later) + o.rttMs : sendAt(packets[packets.length - 1]!) + (9 / 8) * o.rttMs;
      net.at(Math.max(detect, sendAt(p) + o.rttMs), () => net.send(0, 1, p.bytes + 40, { ...p, again: true } as RacePacket));
    }
  }

  const outcomes: StreamOutcome[] = reqs.map((_, i) => ({ req: i, stream: streamId(i, true, false), arrivedAt: NaN, decodedAt: NaN, result: "", ok: false, blockBytes: blocks[i]!.length }));
  const hdec = new HpackDecoder();
  const qdec = new QpackDecoder(4096);
  // The encoder stream is one ordered stream: its chunks apply in order, a gap holds back what follows.
  const encArrived = new Map<number, Uint8Array[]>();
  let encNext = 0;
  const encOrder = packets.filter((p) => p.kind === "enc").map((p) => p.req);
  const waiting: number[] = [];
  const describe = (got: Header[], want: readonly Header[]) => {
    const bad = got.length !== want.length || got.some((h, k) => h[0] !== want[k]![0] || h[1] !== want[k]![1]);
    if (!bad) return { ok: true, result: `decoded: ${got.find((h) => h[0] === ":path")?.[1]}` };
    const path = got.find((h) => h[0] === ":path")?.[1];
    return { ok: false, result: `wrong headers: path ${path ?? "missing"}, ${got.length} fields` };
  };
  const tryQpack = (i: number) => {
    const r = qdec.decodeSection(blocks[i]!);
    if (r === "blocked") return false;
    const out = outcomes[i]!;
    out.decodedAt = net.now;
    Object.assign(out, describe(r, reqs[i]!));
    return true;
  };
  net.setHandlers({
    onDeliver(_n, pkt) {
      const p = pkt.payload as RacePacket & { chunks?: Uint8Array[] };
      if (p.kind === "req") {
        const out = outcomes[p.req]!;
        if (!Number.isNaN(out.arrivedAt)) return;
        out.arrivedAt = net.now;
        if (o.scheme === "hpack") {
          out.decodedAt = net.now;
          try {
            Object.assign(out, describe(hdec.decode(blocks[p.req]!), reqs[p.req]!));
          } catch (e) {
            out.ok = false;
            out.result = `COMPRESSION_ERROR: ${(e as HpackError).message}`;
          }
        } else if (!tryQpack(p.req)) {
          waiting.push(p.req);
          out.result = "blocked";
        }
      } else {
        if (encArrived.has(p.req)) return;
        encArrived.set(p.req, p.chunks ?? []);
        while (encNext < encOrder.length && encArrived.has(encOrder[encNext]!)) {
          for (const c of encArrived.get(encOrder[encNext]!)!) qdec.onEncoderStream(c);
          encNext++;
        }
        for (const i of [...waiting]) if (tryQpack(i)) waiting.splice(waiting.indexOf(i), 1);
      }
    },
  });
  net.runAll();
  return { net, packets, outcomes, totalBytes };
}

// ------------------------------------------------------------------------------------------------ discovery

export type Discovery = "alt-svc" | "https-rr";

export interface VisitResult {
  visit: number;
  protocol: "HTTP/2 over TCP" | "HTTP/3 over QUIC";
  /** The client already knew the server speaks h3 before it connected. */
  knewH3: boolean;
  /** First byte of the response, from the start of the visit (DNS included). */
  firstByteMs: number;
  dnsMs: number;
  net: PacketNet<DiscoveryMsg>;
  note: string;
}

export interface DiscoveryMsg { label: string; proto: "dns" | "tcp" | "quic"; response?: boolean }

export const DISCOVERY_NODES = ["browser", "resolver", "server"];

/** The Alt-Svc header field a server sends to announce HTTP/3 (RFC 7838; ma = max age in seconds). */
export const ALT_SVC = 'Alt-Svc: h3=":443"; ma=86400';

/**
 * Two visits to a site. Model inputs: the resolver RTT, the server RTT, and the time a client without racing
 * waits for a QUIC handshake before it falls back to TCP (`fallbackMs`).
 */
export function discoveryRun(o: { mode: Discovery; udpBlocked: boolean; race: boolean; rttMs: number; dnsRttMs: number; fallbackMs?: number }): VisitResult[] {
  const out: VisitResult[] = [];
  let altSvcKnown = false;
  for (const visit of [1, 2]) {
    const net = new PacketNet<DiscoveryMsg>(DISCOVERY_NODES, { seed: 1, record: true });
    net.connect(0, 1, { rate: 50e6, delay: o.dnsRttMs / 2 });
    net.connect(0, 2, { rate: 50e6, delay: o.rttMs / 2 });
    net.computeRoutes();
    net.dropIf = (pkt) => o.udpBlocked && pkt.payload.proto === "quic";
    let dnsAnswers = 0;
    let dnsDone = NaN, first = NaN, winner: "tcp" | "quic" | undefined, httpsRecord = false;
    const fallback = o.fallbackMs ?? 2000;
    type Run = { kind: SetupKind; proto: "tcp" | "quic"; arrived: Set<string>; sent: Set<string>; steps: ReturnType<typeof setupScript>; dead: boolean };
    const runs: Run[] = [];
    const fire = (r: Run) => {
      if (r.dead) return;
      for (const st of r.steps) {
        if (r.sent.has(st.id) || !st.after.every((a) => r.arrived.has(`${st.from}:${a}`))) continue;
        r.sent.add(st.id);
        const [from, to] = st.from === "c" ? [0, 2] : [2, 0];
        net.send(from, to, st.bytes, { label: st.label, proto: r.proto, response: st.response, ...{ step: st.id, run: runs.indexOf(r) } } as DiscoveryMsg);
      }
    };
    const start = (proto: "tcp" | "quic") => {
      const kind: SetupKind = proto === "tcp" ? "tcp-tls13" : "quic";
      const r: Run = { kind, proto, arrived: new Set(), sent: new Set(), steps: setupScript(kind, 3000), dead: false };
      runs.push(r);
      fire(r);
      return r;
    };
    const knewH3 = o.mode === "alt-svc" ? altSvcKnown : true;
    net.setHandlers({
      onDeliver(node, pkt) {
        const m = pkt.payload as DiscoveryMsg & { step?: string; run?: number; q?: string };
        if (m.proto === "dns") {
          if (node === 1) net.send(1, 0, m.q === "HTTPS" ? 120 : 80, { label: `${m.q} answer`, proto: "dns", response: true, q: m.q } as DiscoveryMsg);
          else if (node === 0) {
            if (m.q === "HTTPS") httpsRecord = true;
            const need = o.mode === "https-rr" ? 2 : 1;
            if (++dnsAnswers === need) {
              dnsDone = net.now;
              connect();
            }
          }
          return;
        }
        const r = runs[m.run!]!;
        if (r.dead) return;
        r.arrived.add(`${node === 0 ? "c" : "s"}:${m.step}`);
        if (node === 0 && m.response && Number.isNaN(first)) {
          first = net.now;
          winner = r.proto;
          for (const x of runs) if (x !== r) x.dead = true;
        }
        fire(r);
      },
    });
    const connect = () => {
      const h3 = o.mode === "https-rr" ? httpsRecord : altSvcKnown;
      if (!h3) {
        start("tcp");
        return;
      }
      start("quic");
      if (o.race) start("tcp");
      else net.at(net.now + fallback, () => {
        if (Number.isNaN(first)) {
          runs[0]!.dead = true;
          start("tcp");
        }
      });
    };
    net.send(0, 1, 80, { label: "A query", proto: "dns", q: "A" } as DiscoveryMsg);
    if (o.mode === "https-rr") net.send(0, 1, 80, { label: "HTTPS query", proto: "dns", q: "HTTPS" } as DiscoveryMsg);
    net.runAll();
    const protocol = winner === "quic" ? "HTTP/3 over QUIC" : "HTTP/2 over TCP";
    let note = "";
    if (winner === "tcp" && o.mode === "alt-svc" && !altSvcKnown) note = `The response carries ${ALT_SVC}: the browser remembers it.`;
    else if (winner === "tcp" && o.udpBlocked) note = o.race ? "QUIC got no answer; the TCP connection that raced it won." : `QUIC got no answer; the browser waited ${fallback} ms, then used TCP.`;
    else if (winner === "quic") note = o.mode === "https-rr" ? "The HTTPS record said alpn=h3, so the first connection was QUIC." : "The browser remembered the Alt-Svc header from visit 1.";
    // Any HTTP/2 response from this server carries the Alt-Svc header.
    if (winner === "tcp") altSvcKnown = true;
    out.push({ visit, protocol, knewH3, firstByteMs: first, dnsMs: dnsDone, net, note });
  }
  return out;
}
