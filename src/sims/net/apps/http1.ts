/**
 * HTTP/1.1 messages as bytes (RFC 9112), a parser that finds where each message ends, chunked transfer coding,
 * and a model of a browser cache (RFC 9111).
 *
 * Message framing (RFC 9112 section 6.3), in order:
 *  1. Transfer-Encoding with "chunked" last: the body is a series of chunks, each a hex size line, the data and
 *     CRLF, ended by a zero-size chunk and an optional trailer section.
 *  2. Content-Length: exactly that many bytes.
 *  3. A request with neither has no body. A response with neither runs until the server closes the connection.
 * A message with both headers is suspect: RFC 9112 says Transfer-Encoding wins, and that a server ought to treat
 * the message as an error. If a front-end proxy and a back-end server pick different rules, they split one byte
 * stream into different requests: that is request smuggling. `parseStream(..., { ignoreTE: true })` is such a
 * non-compliant parser.
 */
import type { Header } from "./hpack";

export interface HttpMessage {
  start: string;
  headers: Header[];
  body: string;
}

export const serialize = (m: HttpMessage) => `${m.start}\r\n${m.headers.map(([n, v]) => `${n}: ${v}\r\n`).join("")}\r\n${m.body}`;
export const byteLength = (s: string) => new TextEncoder().encode(s).length;

export function request(method: string, path: string, host: string, extra: Header[] = [], body = ""): HttpMessage {
  return { start: `${method} ${path} HTTP/1.1`, headers: [["Host", host], ...extra], body };
}

/** A typical browser request (headers are a model input, like Chrome's for a script). */
export function browserRequest(path: string, host = "www.example.com", extra: Header[] = []): HttpMessage {
  return request("GET", path, host, [
    ["User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"],
    ["Accept", "*/*"],
    ["Accept-Encoding", "gzip, deflate, br, zstd"],
    ["Accept-Language", "en-US,en;q=0.9"],
    ["Referer", `https://${host}/`],
    ["Cookie", "session=8f2c1a9e4b7d6c3a; theme=dark"],
    ...extra,
  ]);
}

export function response(status: number, reason: string, headers: Header[], body = ""): HttpMessage {
  return { start: `HTTP/1.1 ${status} ${reason}`, headers, body };
}

/** Chunked transfer coding of `body` in chunks of at most `size` bytes. */
export function chunked(body: string, size: number): string {
  let out = "";
  for (let i = 0; i < body.length; i += size) {
    const part = body.slice(i, i + size);
    out += `${byteLength(part).toString(16)}\r\n${part}\r\n`;
  }
  return `${out}0\r\n\r\n`;
}

// ------------------------------------------------------------------------------------------------ parser

export type Framing = "chunked" | "content-length" | "none" | "close";

export interface Parsed {
  start: string;
  headers: Header[];
  body: string;
  framing: Framing;
  /** Byte offsets [from, to) of the whole message in the stream (characters here: the text is ASCII). */
  from: number;
  to: number;
  /** Offsets where the head ends and the body begins. */
  bodyFrom: number;
  error?: string;
  /** Both Content-Length and Transfer-Encoding were present. */
  ambiguous?: boolean;
}

export interface ParseResult {
  messages: Parsed[];
  /** Bytes left that do not form a complete message yet. */
  rest: string;
  restFrom: number;
}

const getHeader = (hs: Header[], name: string) => hs.find(([n]) => n.toLowerCase() === name)?.[1];

/**
 * Splits a byte stream (as text) into messages. `role` says if they are requests or responses. With `closed`,
 * the stream ended (a close-delimited response is then complete). `ignoreTE` parses as a broken proxy that
 * only reads Content-Length.
 */
export function parseStream(text: string, role: "request" | "response", o: { closed?: boolean; ignoreTE?: boolean } = {}): ParseResult {
  const messages: Parsed[] = [];
  let pos = 0;
  while (pos < text.length) {
    const headEnd = text.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) break;
    const lines = text.slice(pos, headEnd).split("\r\n");
    const start = lines[0]!;
    const headers: Header[] = [];
    let error: string | undefined;
    for (const l of lines.slice(1)) {
      const c = l.indexOf(":");
      if (c <= 0 || /\s/.test(l.slice(0, c))) {
        error = `bad header line "${l.slice(0, 24)}"`;
        continue;
      }
      headers.push([l.slice(0, c), l.slice(c + 1).trim()]);
    }
    const startOk = role === "request" ? /^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(start) : /^HTTP\/1\.[01] \d{3}( .*)?$/.test(start);
    if (!startOk) error ??= `not an HTTP ${role} line: "${start.slice(0, 30)}"`;
    const bodyFrom = headEnd + 4;
    const te = getHeader(headers, "transfer-encoding");
    const cl = getHeader(headers, "content-length");
    const isChunked = !o.ignoreTE && te !== undefined && te.toLowerCase().split(",").pop()!.trim() === "chunked";
    const ambiguous = te !== undefined && cl !== undefined;
    if (isChunked) {
      let p = bodyFrom, body = "", done = false;
      for (;;) {
        const le = text.indexOf("\r\n", p);
        if (le < 0) break;
        const size = parseInt(text.slice(p, le).split(";")[0]!, 16);
        if (!Number.isFinite(size)) {
          error ??= "bad chunk size";
          break;
        }
        if (size === 0) {
          const end = text.indexOf("\r\n\r\n", le);
          const end2 = text.slice(le, le + 4) === "\r\n\r\n" ? le : end;
          if (end2 < 0) break;
          p = end2 + 4;
          done = true;
          break;
        }
        if (le + 2 + size + 2 > text.length) break;
        body += text.slice(le + 2, le + 2 + size);
        p = le + 2 + size + 2;
      }
      if (!done) break;
      messages.push({ start, headers, body, framing: "chunked", from: pos, to: p, bodyFrom, error, ambiguous });
      pos = p;
    } else if (cl !== undefined) {
      const n = Number(cl);
      if (!/^\d+$/.test(cl)) {
        messages.push({ start, headers, body: "", framing: "content-length", from: pos, to: bodyFrom, bodyFrom, error: "bad Content-Length", ambiguous });
        pos = bodyFrom;
        continue;
      }
      if (bodyFrom + n > text.length) break;
      messages.push({ start, headers, body: text.slice(bodyFrom, bodyFrom + n), framing: "content-length", from: pos, to: bodyFrom + n, bodyFrom, error, ambiguous });
      pos = bodyFrom + n;
    } else if (role === "request") {
      messages.push({ start, headers, body: "", framing: "none", from: pos, to: bodyFrom, bodyFrom, error });
      pos = bodyFrom;
    } else {
      if (!o.closed) break;
      messages.push({ start, headers, body: text.slice(bodyFrom), framing: "close", from: pos, to: text.length, bodyFrom, error });
      pos = text.length;
    }
  }
  return { messages, rest: text.slice(pos), restFrom: pos };
}

// ------------------------------------------------------------------------------------------------ caching

export type CachePolicy = "max-age" | "no-cache" | "no-store" | "heuristic" | "immutable";

export interface CacheOpts {
  policy: CachePolicy;
  /** max-age in seconds (for "max-age" and "immutable"). */
  maxAge: number;
  /** The response carries an ETag (a validator). Without one (and without Last-Modified), a stale copy is useless. */
  etag: boolean;
  /** Times in seconds when the user loads the resource. */
  visits: number[];
  /** Times in seconds when the site publishes a new version. */
  changes: number[];
  /** Size of the body in bytes (a model input). */
  bodyBytes: number;
}

export type CacheOutcome = "200" | "hit" | "stale hit" | "304" | "200 new URL";

export interface CacheEvent {
  t: number;
  outcome: CacheOutcome;
  /** Bytes on the wire (request + response). */
  bytes: number;
  /** Round trips to the server. */
  rtts: number;
  /** The version the user saw, and the newest one at that time. */
  shown: number;
  newest: number;
  /** Seconds of freshness left when it was a hit. */
  freshLeft?: number;
}

/** The cache demo's schedule (model inputs): 11 visits over two hours, two deploys, a 50 KB script. */
export const CACHE_VISITS = [0, 60, 240, 600, 900, 1500, 2400, 3000, 4200, 6000, 7200];
export const CACHE_CHANGES = [1000, 5000];
export const CACHE_BODY_DEFAULT = 50_000;

/** RFC 9111 section 4.2.2: a cache may use a fraction of (Date − Last-Modified); it suggests 10%. */
export const HEURISTIC_FRACTION = 0.1;

const versionAt = (changes: number[], t: number) => changes.filter((c) => c <= t).length;

export function cacheHeaders(o: Pick<CacheOpts, "policy" | "maxAge" | "etag">, version: number): Header[] {
  const h: Header[] = [["Content-Type", "application/javascript"]];
  if (o.policy === "max-age") h.push(["Cache-Control", `max-age=${o.maxAge}`]);
  if (o.policy === "no-cache") h.push(["Cache-Control", "no-cache"]);
  if (o.policy === "no-store") h.push(["Cache-Control", "no-store"]);
  if (o.policy === "immutable") h.push(["Cache-Control", "max-age=31536000, immutable"]);
  if (o.etag && o.policy !== "no-store") h.push(["ETag", `"v${version}-5d8c72a1"`]);
  if (o.policy === "heuristic") h.push(["Last-Modified", "Tue, 03 Nov 2026 09:12:44 GMT"]);
  return h;
}

/** Bytes of the response head and of the request, from real message text. */
export function cacheMessageBytes(o: Pick<CacheOpts, "policy" | "maxAge" | "etag">) {
  const path = o.policy === "immutable" ? "/app.3f9a2c.js" : "/app.js";
  const req = byteLength(serialize(browserRequest(path)));
  const cond = byteLength(serialize(browserRequest(path, "www.example.com", o.etag ? [["If-None-Match", `"v0-5d8c72a1"`]] : [["If-Modified-Since", "Tue, 03 Nov 2026 09:12:44 GMT"]])));
  const head200 = byteLength(serialize(response(200, "OK", [...cacheHeaders(o, 0), ["Content-Length", "50000"]])));
  const head304 = byteLength(serialize(response(304, "Not Modified", cacheHeaders(o, 0).filter(([n]) => n !== "Content-Type"))));
  return { req, cond, head200, head304 };
}

export function cacheRun(o: CacheOpts): { events: CacheEvent[]; bytes: number; rtts: number; staleViews: number } {
  const sizes = cacheMessageBytes(o);
  const events: CacheEvent[] = [];
  let stored: { version: number; at: number; lastModified: number } | undefined;
  const lastChange = (t: number) => Math.max(-86400 * 3, ...o.changes.filter((c) => c <= t)); // first version: 3 days old
  const freshness = (s: { at: number; lastModified: number }) => {
    if (o.policy === "max-age") return o.maxAge;
    if (o.policy === "immutable") return 31536000;
    if (o.policy === "heuristic") return HEURISTIC_FRACTION * (s.at - s.lastModified);
    return 0;
  };
  for (const t of [...o.visits].sort((a, b) => a - b)) {
    const newest = versionAt(o.changes, t);
    const full = (outcome: CacheOutcome): CacheEvent => {
      if (o.policy !== "no-store") stored = { version: newest, at: t, lastModified: lastChange(t) };
      return { t, outcome, bytes: sizes.req + sizes.head200 + o.bodyBytes, rtts: 1, shown: newest, newest };
    };
    if (o.policy === "immutable") {
      // The page names the file by a hash of its content: a new version is a new URL, never in the cache.
      if (stored && stored.version === newest) events.push({ t, outcome: "hit", bytes: 0, rtts: 0, shown: newest, newest, freshLeft: Infinity });
      else events.push(full(stored ? "200 new URL" : "200"));
      continue;
    }
    if (!stored) {
      events.push(full("200"));
      continue;
    }
    const age = t - stored.at;
    const fresh = freshness(stored);
    if (age < fresh) {
      events.push({ t, outcome: stored.version === newest ? "hit" : "stale hit", bytes: 0, rtts: 0, shown: stored.version, newest, freshLeft: fresh - age });
      continue;
    }
    // A stale copy can be revalidated only with a validator: an ETag, or Last-Modified (sent in "heuristic").
    const canValidate = (o.etag && o.policy !== "no-store") || o.policy === "heuristic";
    if (canValidate && stored.version === newest) {
      stored = { ...stored, at: t };
      events.push({ t, outcome: "304", bytes: sizes.cond + sizes.head304, rtts: 1, shown: newest, newest });
    } else events.push(full("200"));
  }
  return {
    events,
    bytes: events.reduce((a, e) => a + e.bytes, 0),
    rtts: events.reduce((a, e) => a + e.rtts, 0),
    staleViews: events.filter((e) => e.outcome === "stale hit").length,
  };
}
