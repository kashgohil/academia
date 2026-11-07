/**
 * Application protocols for the networking track: DNS, HTTP/1.1, HTTP/2, HTTP/3 and WebSockets. Everything that
 * moves packets runs on PacketNet (../packet.ts), and HTTP runs on the reference TCP of ../transport.
 *
 * ## DNS
 * - dns-msg.ts: the RFC 1035 message format with name compression, EDNS(0) and the HTTPS record (RFC 9460):
 *   `encodeMessage(msg, compress)` gives the bytes, spans per section and the pointers; `decodeMessage` reads them
 *   back. `dnsHeaderFields` feeds HeaderDiagram.
 * - dns-resolve.ts: `dnsRun({ lookups, glue, edns, dropFirstTo })`: a stub, a caching recursive resolver (a
 *   generator that yields queries) and authoritative servers for the root, com/net, example.com and a CDN zone.
 *   TTLs, negative caching (RFC 2308), glue, CNAME chains, truncation with TCP fallback (on the reference TCP) and
 *   retries. `serve(zones, question)` is the authoritative answer logic.
 * - dns-poison.ts: Kaminsky-style poisoning: `poisonOdds`, `campaign` (seeded races) and `raceRun` (one race on
 *   PacketNet), with or without source-port randomization and DNSSEC.
 *
 * ## HTTP
 * - http1.ts: HTTP/1.1 message text (`request`, `browserRequest`, `response`, `serialize`), `chunked`, the framing
 *   parser `parseStream` (with a Content-Length-only mode that shows request smuggling), and the cache model
 *   `cacheRun` (max-age, no-cache, no-store, heuristic freshness, versioned URLs, ETag revalidation).
 * - pageload.ts: page loads on the reference TCP: `h1PageLoad` (connections, keep-alive, pipelining) and
 *   `h2PageLoad` (one connection, interleaved DATA frames), with TLS 1.3 bytes, Reno (`RenoBytes`) and loss.
 * - hpack.ts, hpack-tables.ts: a real HPACK encoder and decoder (RFC 7541), checked against appendix C.
 * - http2.ts: the frame header, priority schedulers (round-robin, RFC 7540 weights, RFC 9218 urgency), Rapid Reset
 *   arithmetic, flow-control limits.
 * - qpack.ts: a QPACK encoder and decoder (RFC 9204) with the encoder stream, blocking and acknowledgments.
 * - http3.ts: QUIC varints, HTTP/3 frames and streams (`clientStreams`), `headerRace` (HPACK against QPACK when
 *   streams arrive out of order) and `discoveryRun` (Alt-Svc, HTTPS records, racing QUIC against TCP).
 *
 * ## WebSockets
 * - sha1.ts: SHA-1 and base64.
 * - ws.ts: the handshake (`acceptKey`), frames and masking (`encodeFrame`, `frameFields`), the proxy confusion that
 *   masking prevents (`proxyView`), `backpressureRun` on the reference TCP, and `pushCompare` (long polling, SSE,
 *   WebSockets) on PacketNet.
 *
 * Model inputs are named constants (DNS_LINKS, DEMO_PAGE, TLS_SERVER_FLIGHT, PRIO_PAGE, CACHE_VISITS, …); the
 * lessons label them as such.
 */
export * from "./hpack-tables";
export * from "./hpack";
export * from "./qpack";
export * from "./dns-msg";
export * from "./dns-resolve";
export * from "./dns-poison";
export * from "./http1";
export * from "./pageload";
export * from "./http2";
export * from "./http3";
export * from "./sha1";
export * from "./ws";
