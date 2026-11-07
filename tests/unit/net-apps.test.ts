/** Pins every number the apps lessons (dns, http-1-1, http-2, http-3, websockets) quote. */
import { describe, expect, test } from "vitest";
import { hex } from "../../src/sims/net";
import {
  AUTH, CACHE_BODY_DEFAULT, EVENT_JSON, FORGED_BYTES, HpackEncoder, LINUX_PORTS, POISON_PAYLOAD, PRIO_PAGE, RACE_PATHS, TLD,
  acceptKey, backpressureRun, browserRequest, byteLength, cacheRun, campaign, chunked, clientStreams, decodeFrame, decodeMessage, discoveryRun, dnsRun,
  encodeFrame, encodeMessage, h1PageLoad, h1RequestBytes, h1ResponseHead, h2PageLoad, h2RequestHeaders, headerRace, lookupMs, parseStream, poisonOdds,
  proxyView, pushCompare, rapidReset, readVarint, request, schedule, serialize, serve, sha1, varint, windowLimitMbps, zones, DEMO_PAGE,
} from "../../src/sims/net/apps";

const near = (x: number, want: number, tol = 0.5) => expect(Math.abs(x - want)).toBeLessThanOrEqual(tol);

// ================================================================================================ DNS

describe("DNS messages", () => {
  const z = zones({ glue: true });
  test("the referral from the com server: 67 bytes, 104 without compression, 3 pointers", () => {
    const ref = serve(z[TLD]!, { name: "www.example.com", type: "A" }, 0x1a2b);
    const e = encodeMessage(ref);
    expect(e.bytes.length).toBe(67);
    expect(e.saved).toBe(37);
    expect(e.pointers.length).toBe(3);
    expect(hex(e.bytes.subarray(0, 6))).toBe("1a 2b 80 00 00 01");
    expect(e.spans[1]!.end - e.spans[1]!.start - 4).toBe(17); // question name
    expect(e.pointers[0]).toMatchObject({ at: 33, to: 16, suffix: "example.com" });
    expect(hex(e.bytes.subarray(33, 35))).toBe("c0 10");
    expect(decodeMessage(e.bytes)).toEqual(ref);
  });
  test("40 A records: 1,273 bytes plain, 673 compressed (31 → 16 bytes per record)", () => {
    const big = serve(z[AUTH]!, { name: "big.example.com", type: "A" }, 1);
    const plain = encodeMessage(big, false).bytes.length, comp = encodeMessage(big).bytes.length;
    expect(plain).toBe(1273);
    expect(comp).toBe(673);
    expect((plain - comp) / 40).toBe(15);
  });
  test("an OPT record is 11 bytes", () => {
    const q = { id: 1, flags: { qr: false, opcode: 0, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: 0 }, question: [{ name: "www.example.com", type: "A" as const }], answer: [], authority: [], additional: [] };
    const withOpt = { ...q, additional: [{ name: "", ttl: 0, data: { t: "OPT" as const, udpSize: 1232 } }] };
    expect(encodeMessage(withOpt).bytes.length - encodeMessage(q).bytes.length).toBe(11);
  });
  test("a pointer loop is a format error", () => {
    const b = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1]);
    expect(() => decodeMessage(b)).toThrow(/loop/);
  });
});

describe("DNS resolution", () => {
  test("cold, warm, after the A record expires", () => {
    const r = dnsRun({ lookups: [{ at: 0, name: "www.example.com" }, { at: 10, name: "www.example.com" }, { at: 410, name: "www.example.com" }, { at: 420, name: "shop.example.com" }] });
    const [a, b, c, d] = r.lookups;
    near(lookupMs(a!), 124);
    expect(a!.upstream.length).toBe(3);
    near(lookupMs(b!), 8);
    expect(b!.upstream.length).toBe(0);
    near(lookupMs(c!), 88);
    expect(c!.upstream.length).toBe(1);
    near(lookupMs(d!), 140);
    expect(d!.answer.map((x) => x.data.t)).toEqual(["CNAME", "A"]);
  });
  test("negative caching for min(SOA TTL, MINIMUM) = 300 s", () => {
    const r = dnsRun({ lookups: [{ at: 0, name: "www.example.com" }, { at: 20, name: "nope.example.com" }, { at: 30, name: "nope.example.com" }] });
    expect(r.lookups[1]!.rcode).toBe("NXDOMAIN");
    near(lookupMs(r.lookups[1]!), 88);
    near(lookupMs(r.lookups[2]!), 8);
    expect(r.lookups[1]!.cacheAfter.find((c) => c.neg)!.left).toBe(300);
  });
  test("truncation and TCP fallback, EDNS(0), glueless delegation, a lost query", () => {
    // After a lookup of www.example.com, so example.com's server is known.
    const L = [{ at: 0, name: "www.example.com" }, { at: 20, name: "big.example.com" }];
    const tcp = dnsRun({ lookups: L });
    near(lookupMs(tcp.lookups[1]!), 248);
    expect(tcp.upstream.some((u) => u.tcp)).toBe(true);
    expect(tcp.lookups[1]!.answer.length).toBe(40);
    near(lookupMs(dnsRun({ edns: 1232, lookups: L }).lookups[1]!), 88);
    near(lookupMs(dnsRun({ glue: false, lookups: [{ at: 0, name: "www.example.com" }] }).lookups[0]!), 160);
    near(lookupMs(dnsRun({ dropFirstTo: TLD, lookups: [{ at: 0, name: "www.example.com" }] }).lookups[0]!), 924);
  });
});

describe("cache poisoning", () => {
  test("ID only, at 100 Mbit/s and 40 ms", () => {
    const o = poisonOdds({ attackerMbps: 100, rttMs: 40, randomPorts: false });
    expect(FORGED_BYTES).toBe(97);
    expect(o.forgedPerRace).toBe(5154);
    near(o.pRace * 100, 7.86, 0.005);
    near(o.expectedRaces, 12.7, 0.05);
    near(o.expectedSeconds, 0.509, 0.001);
    near(o.expectedSecondsOldStyle(86400) / 86400, 12.7, 0.05);
    expect(campaign({ attackerMbps: 100, rttMs: 40, randomPorts: false }).races).toBe(12);
  });
  test("random ports: 65,536 × 28,232 values, about 4 hours; DNSSEC: never", () => {
    expect(LINUX_PORTS).toBe(28232);
    const o = poisonOdds({ attackerMbps: 100, rttMs: 40, randomPorts: true });
    near(o.expectedSeconds / 3600, 4, 0.05);
    expect(poisonOdds({ attackerMbps: 100, rttMs: 40, randomPorts: false, dnssec: true }).pRace).toBe(0);
  });
});

// ================================================================================================ HTTP/1.1

describe("HTTP/1.1 messages and framing", () => {
  test("request and response head sizes", () => {
    expect(h1RequestBytes("app.js")).toBe(331);
    expect(h1ResponseHead(80000)).toBe(174);
    expect(byteLength(serialize(browserRequest("/style.css")))).toBe(334);
  });
  test("Content-Length, chunked, and the CL.TE split", () => {
    const body = '{"item":42,"qty":1}';
    const two = serialize(request("POST", "/cart", "shop.example", [["Content-Length", String(body.length)]], body)) + serialize(request("GET", "/cart", "shop.example"));
    expect(parseStream(two, "request").messages.map((m) => m.start)).toEqual(["POST /cart HTTP/1.1", "GET /cart HTTP/1.1"]);
    const ch = serialize(request("POST", "/c", "h", [["Transfer-Encoding", "chunked"]], chunked(body, 8)));
    expect(parseStream(ch, "request").messages[0]!.body).toBe(body);
    const sm = `0\r\n\r\nGET /admin HTTP/1.1\r\nHost: shop.example\r\n\r\n`;
    const text = serialize(request("POST", "/search", "shop.example", [["Content-Length", String(sm.length)], ["Transfer-Encoding", "chunked"]], sm));
    expect(parseStream(text, "request", { ignoreTE: true }).messages.length).toBe(1);
    expect(parseStream(text, "request").messages.map((m) => m.start)).toEqual(["POST /search HTTP/1.1", "GET /admin HTTP/1.1"]);
    const wrong = serialize(request("POST", "/cart", "shop.example", [["Content-Length", String(body.length - 6)]], body)) + serialize(request("GET", "/cart", "shop.example"));
    expect(parseStream(wrong, "request").messages[1]!.error).toMatch(/not an HTTP request line/);
  });
});

describe("HTTP/1.1 page loads (80 ms, 10 Mbit/s, TLS)", () => {
  const base = { rttMs: 80, mbps: 10, loss: 0, record: false };
  const plt = (o: object) => Math.round(h1PageLoad({ ...base, conns: 1, persistent: true, pipelining: false, ...o }).plt);
  test("the page is 453 KB, 362 ms on the link alone", () => {
    const total = DEMO_PAGE.html.bytes + DEMO_PAGE.resources.reduce((a, r) => a + r.bytes, 0);
    expect(total).toBe(453_000);
    near((total * 8) / 10e3, 362.4, 0.1);
  });
  test("connection strategies", () => {
    expect(plt({})).toBe(1802);
    near(plt({}) / 80, 22.5, 0.05);
    expect(plt({ conns: 6 })).toBe(896);
    expect(plt({ conns: 6, persistent: false })).toBe(1176);
    expect(plt({ pipelining: true })).toBe(832);
  });
  test("a slow style.css, and a 200 ms RTT", () => {
    const slow = { slow: { index: 0, ms: 300 } };
    expect(plt({ ...slow, pipelining: true })).toBe(1132);
    expect(plt({ ...slow, conns: 6 })).toBe(963);
    expect(plt({ rttMs: 200 })).toBe(3842);
    expect(plt({ rttMs: 200, pipelining: true })).toBe(1716);
    expect(plt({ rttMs: 200, conns: 6 })).toBe(1944);
  });
});

describe("HTTP caching (11 visits, 2 deploys)", () => {
  const V = [0, 60, 240, 600, 900, 1500, 2400, 3000, 4200, 6000, 7200], C = [1000, 5000];
  const run = (policy: Parameters<typeof cacheRun>[0]["policy"], maxAge = 600, etag = true) => cacheRun({ policy, maxAge, etag, visits: V, changes: C, bodyBytes: CACHE_BODY_DEFAULT });
  test("max-age=600 with an ETag", () => {
    const r = run("max-age");
    near(r.bytes / 1000, 154, 0.5);
    expect(r.rtts).toBe(8);
    expect(r.staleViews).toBe(0);
    expect(r.events.find((e) => e.outcome === "304")!.bytes).toBe(439);
  });
  test("max-age=3600, no ETag, no-store, no-cache, heuristic, versioned URL", () => {
    const long = run("max-age", 3600);
    expect([long.rtts, long.staleViews]).toEqual([2, 5]);
    near(long.bytes / 1000, 101, 0.5);
    near(run("max-age", 600, false).bytes / 1000, 404, 0.5);
    const ns = run("no-store");
    expect(ns.rtts).toBe(11);
    near(ns.bytes / 1000, 555, 0.5);
    expect(run("no-cache").rtts).toBe(11);
    expect(run("heuristic").staleViews).toBe(6);
    near((0.1 * 3 * 86400) / 3600, 7.2, 0.01);
    const im = run("immutable");
    expect(im.events.filter((e) => e.outcome.startsWith("200")).length).toBe(3);
    expect(im.staleViews).toBe(0);
  });
});

// ================================================================================================ HTTP/2

describe("HPACK on three browser requests", () => {
  const paths = ["/", "/style.css", "/app.js"];
  const sizes = (o: ConstructorParameters<typeof HpackEncoder>[1]) => {
    const e = new HpackEncoder(4096, o);
    return paths.map((p) => e.encode(h2RequestHeaders(p)));
  };
  test("183, 18, 17 bytes; 245 bytes of frames against 990 bytes of HTTP/1.1 text", () => {
    const r = sizes({ huffman: "auto" });
    expect(r.map((x) => x.bytes.length)).toEqual([183, 18, 17]);
    expect(r.reduce((a, x) => a + 9 + x.bytes.length, 0)).toBe(245);
    expect(paths.reduce((a, p) => a + byteLength(serialize(browserRequest(p))), 0)).toBe(990);
    const second = r[1]!.reps;
    expect(second.filter((x) => x.bytes.length === 1).length).toBe(9);
    expect(second.find((x) => x.header[0] === ":path")!.bytes.length).toBe(9);
  });
  test("the dynamic table after request 1: 7 entries, 509 bytes", () => {
    const e = new HpackEncoder(4096, { huffman: "auto" });
    e.encode(h2RequestHeaders("/"));
    expect(e.table.entries.length).toBe(7);
    expect(e.table.size).toBe(509);
  });
  test("without Huffman 233; without the dynamic table about 190 each", () => {
    expect(sizes({ huffman: false })[0]!.bytes.length).toBe(233);
    expect(sizes({ huffman: "auto", noIndexing: true }).map((x) => x.bytes.length)).toEqual([189, 197, 196]);
  });
});

describe("HTTP/2 flow control, loss, priorities, Rapid Reset", () => {
  test("window limits", () => {
    near(windowLimitMbps(65535, 100), 5.24, 0.005);
    near(windowLimitMbps(65535, 20), 26.2, 0.05);
    near(windowLimitMbps(16 * 1024 * 1024, 100), 1342, 0.5);
  });
  test("six HTTP/1.1 connections against one HTTP/2 connection, medians over 10 seeds", () => {
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return Math.round((s[4]! + s[5]!) / 2);
    };
    const runs = (loss: number) => {
      const a: number[] = [], b: number[] = [];
      for (let seed = 1; seed <= 10; seed++) {
        const o = { rttMs: 80, mbps: 10, loss: loss / 100, seed, record: false };
        a.push(h1PageLoad({ ...o, conns: 6, persistent: true, pipelining: false }).plt);
        b.push(h2PageLoad(o).plt);
      }
      return [med(a), med(b)];
    };
    expect(runs(0)).toEqual([896, 833]);
    expect(runs(1)).toEqual([1364, 2252]);
    expect(runs(4)).toEqual([2587, 6526]);
  });
  test("first paint by scheduler at 10 Mbit/s", () => {
    const [rr, w, u] = (["none", "rfc7540", "rfc9218"] as const).map((s) => schedule(PRIO_PAGE, s, 10));
    expect(Math.round(rr!.done[0]!)).toBe(99);
    expect([rr, w, u].map((r) => Math.round(r!.renderAt))).toEqual([302, 213, 84]);
    expect(Math.round(u!.total)).toBe(332);
  });
  test("Rapid Reset at 100 Mbit/s, 50 ms RTT, 20 ms of work", () => {
    const o = { rttMs: 50, uplinkMbps: 100, workMs: 20 };
    const none = rapidReset({ ...o, mitigation: "none" });
    expect(none.bytesPerRequest).toBe(32);
    near(none.normalRps, 1430, 2);
    near(none.attackRps, 391000, 500);
    near(none.attackRps / none.normalRps, 273, 0.5);
    expect(rapidReset({ ...o, mitigation: "count-until-done" }).attackRps).toBe(5000);
    near(rapidReset({ ...o, mitigation: "goaway" }).attackRps, 9750, 1);
  });
});

// ================================================================================================ HTTP/3

describe("HTTP/3 bytes", () => {
  test("QUIC varints (RFC 9000 appendix A.1)", () => {
    expect(hex(varint(151288809941952652n))).toBe("c2 19 7c 5e ff 14 e8 8c");
    expect(hex(varint(494878333))).toBe("9d 7f 3e 7d");
    expect(hex(varint(15293))).toBe("7b bd");
    expect(hex(varint(37))).toBe("25");
    expect(readVarint(new Uint8Array([0x40, 0x25]))).toEqual([37n, 2]);
    expect([63, 64, 16383, 16384].map((v) => varint(v).length)).toEqual([1, 2, 2, 4]);
  });
  test("the client's streams for three requests", () => {
    const len = (s: ReturnType<typeof clientStreams>[number]) => s.parts.reduce((a, p) => a + p.bytes.length, 0);
    const on = clientStreams(RACE_PATHS, { capacity: 4096, blocked: 100, allowBlocking: true });
    expect(on.map((s) => s.id)).toEqual([2, 6, 10, 0, 4, 8]);
    expect(on[0]!.parts[1]!.bytes.length).toBe(8);
    expect(len(on[1]!)).toBe(252);
    expect(hex(on[3]!.parts[0]!.bytes.subarray(0, 2))).toBe("01 0c");
    expect(on.slice(3).map(len)).toEqual([14, 14, 14]);
    expect(on.reduce((a, s) => a + len(s), 0)).toBe(304);
    const off = clientStreams(RACE_PATHS, { capacity: 0, blocked: 0, allowBlocking: true });
    expect(off.slice(3).map(len)).toEqual([237, 248, 245]);
    expect(off.reduce((a, s) => a + len(s), 0)).toBe(739);
  });
});

describe("header blocks on independent streams", () => {
  test("HPACK decodes out of order and fails", () => {
    const r = headerRace({ scheme: "hpack", drop: [0], rttMs: 40 });
    expect(r.outcomes.map((o) => Math.round(o.decodedAt))).toEqual([67, 21, 22]);
    expect(r.outcomes.map((o) => o.ok)).toEqual([true, false, false]);
    expect(r.outcomes[1]!.result).toBe("COMPRESSION_ERROR: index 68 is not in the table");
    const r1 = headerRace({ scheme: "hpack", drop: [1], rttMs: 40 });
    expect(r1.outcomes.map((o) => o.ok)).toEqual([true, true, false]);
  });
  test("QPACK blocks instead, or never blocks and sends more", () => {
    const b = headerRace({ scheme: "qpack-blocking", drop: [0], rttMs: 40 });
    expect(b.outcomes.map((o) => Math.round(o.decodedAt))).toEqual([63, 63, 63]);
    expect(b.outcomes.every((o) => o.ok && o.blockBytes === 12)).toBe(true);
    expect(b.totalBytes).toBe(287);
    const b2 = headerRace({ scheme: "qpack-blocking", drop: [2], rttMs: 40 });
    expect(Math.round(b2.outcomes[0]!.decodedAt)).toBe(21);
    expect(b2.outcomes[1]!.decodedAt).toBeGreaterThan(60);
    expect(b2.outcomes[2]!.decodedAt).toBeGreaterThan(60);
    const s = headerRace({ scheme: "qpack-safe", drop: [0], rttMs: 40 });
    expect(s.totalBytes).toBe(972);
    expect(s.outcomes.every((o) => o.ok && o.decodedAt < 30)).toBe(true);
  });
});

describe("HTTP/3 discovery", () => {
  const fb = (o: Parameters<typeof discoveryRun>[0]) => discoveryRun(o).map((v) => Math.round(v.firstByteMs));
  test("Alt-Svc, HTTPS record, blocked UDP with and without racing", () => {
    const o = { rttMs: 50, dnsRttMs: 20, udpBlocked: false, race: true } as const;
    expect(fb({ ...o, mode: "alt-svc" })).toEqual([171, 121]);
    expect(discoveryRun({ ...o, mode: "alt-svc" }).map((v) => v.protocol)).toEqual(["HTTP/2 over TCP", "HTTP/3 over QUIC"]);
    expect(fb({ ...o, mode: "https-rr" })).toEqual([121, 121]);
    expect(fb({ ...o, mode: "https-rr", udpBlocked: true, race: false })).toEqual([2171, 2171]);
    expect(fb({ ...o, mode: "https-rr", udpBlocked: true, race: true })).toEqual([171, 171]);
  });
});

// ================================================================================================ WebSockets

describe("WebSocket handshake and frames", () => {
  test("SHA-1 (FIPS 180-4 test vector) and the RFC 6455 accept example", () => {
    expect(hex(sha1(new TextEncoder().encode("abc")))).toBe("a9 99 3e 36 47 06 81 6a ba 3e 25 71 78 50 c2 6c 9c d0 d8 9d");
    expect(hex(sha1(new TextEncoder().encode("")))).toBe("da 39 a3 ee 5e 6b 4b 0d 32 55 bf ef 95 60 18 90 af d8 07 09");
    const key = "dGhlIHNhbXBsZSBub25jZQ==";
    expect((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").length).toBe(60);
    expect(hex(sha1(new TextEncoder().encode(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))).startsWith("b3 7a 4f 2c")).toBe(true);
    expect(acceptKey(key)).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
  test("the masked 'Hello' of RFC 6455 section 5.7, and the length forms", () => {
    const f = encodeFrame({ fin: true, opcode: "text", mask: new Uint8Array([0x37, 0xfa, 0x21, 0x3d]), payload: new TextEncoder().encode("Hello") });
    expect(hex(f)).toBe("81 85 37 fa 21 3d 7f 9f 4d 51 58");
    expect(new TextDecoder().decode(decodeFrame(f).payload)).toBe("Hello");
    const big = encodeFrame({ fin: true, opcode: "binary", payload: new Uint8Array(300) });
    expect([big[1], big.length - 300]).toEqual([126, 4]);
    const huge = encodeFrame({ fin: true, opcode: "binary", mask: new Uint8Array(4), payload: new Uint8Array(70000) });
    expect([huge[1]! & 0x7f, huge.length - 70000]).toEqual([127, 14]);
  });
  test("a confused proxy parses the unmasked attack, not the masked one", () => {
    const plain = proxyView(POISON_PAYLOAD, undefined).parsed.messages.filter((m) => !m.error);
    expect(plain.map((m) => m.start)).toEqual(["GET /lib/jquery.js HTTP/1.1"]);
    expect(plain[0]!.headers).toEqual([["Host", "cdn.example.net"]]);
    expect(proxyView(POISON_PAYLOAD, new Uint8Array([0x37, 0xfa, 0x21, 0x3d])).parsed.messages.filter((m) => !m.error)).toEqual([]);
  });
});

describe("backpressure (500 msg/s of 200 bytes, read 50 KB/s, 5 s)", () => {
  const run = (o: { bp: boolean; rcv: number; hw: number }) => backpressureRun({ rate: 500, msgBytes: 200, readBps: 50000, rttMs: 40, mbps: 10, rcvBuf: o.rcv * 1024, backpressure: o.bp, highWater: o.hw * 1024, durationMs: 5000 });
  test("no backpressure: the send buffer grows to 193 KB, messages 2.5 s old", () => {
    expect((500 * 204) / 1000).toBe(102);
    const r = run({ bp: false, rcv: 64, hw: 16 });
    const l = r.samples[r.samples.length - 1]!;
    near(l[1] / 1024, 193, 0.5);
    near(l[3] / 1000, 2.5, 0.05);
  });
  test("with backpressure", () => {
    const a = run({ bp: true, rcv: 64, hw: 16 });
    const la = a.samples[a.samples.length - 1]!;
    near(la[1] / 1024, 16, 0.5);
    expect(a.coalesced).toBe(888);
    near(la[3] / 1000, 1.55, 0.005);
    expect(Math.round(run({ bp: true, rcv: 16, hw: 16 }).samples.at(-1)![3])).toBe(576);
    expect(Math.round(run({ bp: true, rcv: 16, hw: 4 }).samples.at(-1)![3])).toBe(336);
  });
});

describe("long polling, SSE, WebSockets (80 ms RTT, 30 s)", () => {
  test("20 events per second", () => {
    const [lp, sse, ws] = (["long-polling", "sse", "websocket"] as const).map((m) => pushCompare(m, { rate: 20, seconds: 30, rttMs: 80 }));
    near(sse!.meanMs, 40, 0.5);
    near(ws!.p99Ms, 40, 0.5);
    near(lp!.meanMs, 77, 0.5);
    near(lp!.p99Ms, 120, 0.5);
    expect([ws, sse, lp].map((r) => Math.round(r!.bytesPerEvent))).toEqual([97, 109, 332]);
  });
  test("1 event per second", () => {
    const lp = pushCompare("long-polling", { rate: 1, seconds: 30, rttMs: 80 });
    near(lp.meanMs, 45, 0.5);
    expect(Math.round(lp.bytesPerEvent)).toBe(573);
    expect(byteLength(EVENT_JSON)).toBe(55);
  });
});
