/** Every number that the security lessons quote from a model, pinned to the sim that produces it. */
import { describe, expect, test } from "vitest";
import {
  ascii, consistencyProof, ctEntry, exposure, EXPOSURE_DEFAULTS, inclusionProof, inclusionProofLength, maxInner, maxValidity, meltdownRun, outerSize,
  PQ_CLIENT_SHARE, PQ_SERVER_SHARE, renewalsPerYear, rfc8448Keys, rfc8448Messages, rfc8448Schedule, sealRecord, secrecyRun, toHex, tlsRun, tunnelPath,
  WG_DEFAULT_MTU, WG_INIT_BYTES, WG_RESP_BYTES, wgSessionRun, CT_APPLICATION, RFC8448, fromHex, type KsNode, type TlsMode,
} from "../../src/sims/net/security";

describe("tls-handshake", () => {
  const run = (mode: TlsMode, o: Parameters<typeof tlsRun>[0] extends infer T ? Partial<T> : never = {}) => tlsRun({ mode, rttMs: 50, ...o });
  test("RFC 8448 message sizes", () => {
    const M = rfc8448Messages();
    expect(M.ch.length).toBe(196);
    expect(M.sh.length).toBe(90);
    expect(fromHex(RFC8448.serverHsRecord).length).toBe(679);
  });
  test("round trips at a 50 ms RTT with a 4 KB chain", () => {
    expect(Math.round(run("tls13").responseAt)).toBe(151);
    expect(Math.round(run("tls12").responseAt)).toBe(201);
    expect(Math.round(run("tls13-hrr").responseAt)).toBe(201);
    expect(Math.round(run("tls13-0rtt").responseAt)).toBe(100);
    expect(Math.round(run("tls13", { loseServerSegment: true }).responseAt)).toBe(201);
    expect(Math.round(run("tls13", { sizes: { certBytes: 16000 } }).responseAt)).toBe(201);
    expect(10 * 1460).toBe(14600);
  });
  test("message sizes on the wire", () => {
    const full = run("tls13"), pq = run("tls13", { sizes: { pq: true } }), psk = run("tls13-psk");
    expect(full.msgs[0]!.msg.bytes).toBe(201);
    expect(pq.msgs[0]!.msg.bytes).toBe(1423);
    expect(pq.msgs[0]!.msg.bytes).toBeLessThanOrEqual(1460);
    expect([PQ_CLIENT_SHARE, PQ_SERVER_SHARE]).toEqual([1216, 1120]);
    expect(Math.round(pq.responseAt)).toBe(151);
    expect(full.msgs[1]!.msg.bytes).toBe(4467);
    expect(psk.msgs[1]!.msg.bytes).toBe(199);
  });
  test("key schedule: values that change", () => {
    const base = rfc8448Schedule();
    const changed = (a: KsNode[]) => a.filter((n, i) => toHex(n.value) !== toHex(base[i]!.value)).length;
    expect(base.length).toBe(21);
    expect(changed(rfc8448Schedule({ flipEcdheBit: 5 }))).toBe(15);
    expect(changed(rfc8448Schedule({ withPsk: true }))).toBe(20);
  });
  test("forward secrecy (12 days, leak on day 9, a new ticket key every 4 days)", () => {
    const n = (mode: Parameters<typeof secrecyRun>[0]["mode"], leak: "cert" | "stek", stekDays = 4) => secrecyRun({ mode, leak, leakDay: 9, stekDays }).filter((s) => s.exposed).length;
    expect(n("rsa12", "cert")).toBe(12);
    expect(n("ecdhe12-tickets", "cert")).toBe(0);
    expect(n("ecdhe12-tickets", "stek")).toBe(3);
    expect(n("ecdhe12-tickets", "stek", 0)).toBe(12);
    expect(n("tls13-psk-ke", "stek")).toBe(2);
    expect(n("tls13-dhe", "stek")).toBe(0);
    expect(n("tls13-dhe", "cert")).toBe(0);
  });
  test("a 14-byte request becomes a 36-byte record", () => {
    const k = rfc8448Keys().clientApp;
    const content = ascii("GET / HTTP/1.1");
    expect(content.length).toBe(14);
    expect(sealRecord(k.key, k.iv, 0, content, CT_APPLICATION).length).toBe(36);
  });
});

describe("certificates-and-pki", () => {
  test("exposure after a key theft (defaults)", () => {
    const h = Object.fromEntries(exposure(EXPOSURE_DEFAULTS).map((e) => [e.method, e.hours]));
    expect(h.none! / 24).toBe(67.5);
    expect(h.crl! / 24).toBe(67.5);
    expect(h.ocsp! / 24).toBe(67.5);
    expect(h.stapling! / 24).toBe(67.5);
    expect(h.mustStaple).toBe(24 + 168);
    expect(h.mustStaple! / 24).toBe(8);
    expect(h.push! / 24).toBe(2);
    expect(h.shortLived).toBe(120);
    const off = Object.fromEntries(exposure({ ...EXPOSURE_DEFAULTS, attackerOnPath: false }).map((e) => [e.method, e.hours]));
    expect([off.crl! / 24, off.ocsp! / 24]).toEqual([8, 8]);
  });
  test("Merkle proof sizes", () => {
    const e = Array.from({ length: 7 }, (_, i) => ctEntry(`n${i}`, i));
    expect(inclusionProof(1, e).length).toBe(3);
    expect(consistencyProof(4, e).length).toBe(1);
    expect(inclusionProofLength(333_333, 1_000_000)).toBe(20);
    for (const m of [0, 1, 999_999]) expect(inclusionProofLength(m, 1_000_000)).toBeLessThanOrEqual(20);
    expect(inclusionProofLength(12345, 2 ** 30)).toBe(30);
    expect(30 * 32).toBeLessThan(1024);
  });
  test("validity schedule and renewals", () => {
    expect([maxValidity("2026-01-01"), maxValidity("2026-03-15"), maxValidity("2027-03-15"), maxValidity("2029-03-15")]).toEqual([398, 200, 100, 47]);
    expect(renewalsPerYear(90).toFixed(1)).toBe("6.1");
    expect(renewalsPerYear(47).toFixed(1)).toBe("11.6");
    expect(Math.round(renewalsPerYear(160 / 24))).toBe(82);
  });
});

describe("vpns", () => {
  test("tunnel sizes on a 1500-byte path", () => {
    expect(outerSize("wg4", 1500)).toBe(1560);
    expect(Object.fromEntries((["gre", "wg4", "wg6", "esp-tunnel", "esp-transport", "esp-natt"] as const).map((k) => [k, maxInner(k, 1500)])))
      .toEqual({ gre: 1476, wg4: 1440, wg6: 1420, "esp-tunnel": 1446, "esp-transport": 1466, "esp-natt": 1438 });
    expect(maxInner("wg4", 1500) - 40).toBe(1400);
    for (const k of ["gre", "wg4", "esp-tunnel", "esp-transport", "esp-natt"] as const) expect(maxInner(k, 1492)).toBe(maxInner(k, 1500) - 8);
    expect(maxInner("wg6", 1500) - maxInner("wg6", 1492)).toBe(12); // the padding to 16 bytes costs a little more
    expect(tunnelPath("wg4", 1500, 1500, false).fragments.map((f) => f.packetLen)).toEqual([1500, 80]);
    expect(tunnelPath("wg4", 1500, 1500, true).outcome).toBe("blackhole");
    expect(Object.fromEntries((["gre", "wg4", "esp-tunnel", "esp-transport", "esp-natt"] as const).map((k) => [k, outerSize(k, 1400) - 1400])))
      .toEqual({ gre: 24, wg4: 68, "esp-tunnel": 56, "esp-transport": 36, "esp-natt": 64 });
    const espT = [0, 1, 2, 3].map((k) => outerSize("esp-tunnel", 1000 + k) - 1000 - k), espX = [0, 1, 2, 3].map((k) => outerSize("esp-transport", 1000 + k) - 1000 - k);
    expect([Math.min(...espT), Math.max(...espT), Math.min(...espX), Math.max(...espX)]).toEqual([54, 57, 34, 37]);
    expect(WG_DEFAULT_MTU).toBe(1500 - (32 + 8 + 40));
    expect([WG_INIT_BYTES, WG_RESP_BYTES]).toEqual([148, 92]);
  });
  test("TCP over TCP at 2% loss with a bulk download", () => {
    const u = meltdownRun({ tunnel: "udp", loss: 0.02, voice: true }), t = meltdownRun({ tunnel: "tcp", loss: 0.02, voice: true });
    const p = (a: number, b: number) => ((a / b) * 100).toFixed(1);
    expect(p(u.voice.lost, u.voice.sent)).toBe("1.6");
    expect(u.voice.late).toBe(0);
    expect(p(t.voice.lost, t.voice.sent)).toBe("0.7");
    expect(p(t.voice.late, t.voice.sent)).toBe("67.6");
    expect(t.inner.spurious).toBe(8);
    expect(u.inner.spurious).toBe(0);
    expect([u.goodputMbps.toFixed(2), t.goodputMbps.toFixed(2)]).toEqual(["1.52", "1.63"]);
  });
  test("TCP over TCP: voice alone, and no loss", () => {
    const u = meltdownRun({ tunnel: "udp", loss: 0.02, voice: true, bulk: false }), t = meltdownRun({ tunnel: "tcp", loss: 0.02, voice: true, bulk: false });
    expect(Math.round(Math.max(...t.voiceDelay.map((d) => d[1])))).toBe(141);
    expect(t.voice.late).toBe(0);
    expect(((u.voice.lost / u.voice.sent) * 100).toFixed(1)).toBe("2.0");
    for (const tunnel of ["udp", "tcp"] as const) expect(meltdownRun({ tunnel, loss: 0, voice: true }).voice.late).toBe(0);
  });
  test("WireGuard sessions", () => {
    const ok = (r: ReturnType<typeof wgSessionRun>) => [r.pushes.filter((p) => p.ok).length, r.pushes.length];
    const d = wgSessionRun();
    expect(ok(d)).toEqual([8, 15]);
    const k = wgSessionRun({ persistentKeepalive: 25 });
    expect(k.handshakes.map((h) => Math.round(h.t))).toEqual([1, 183]);
    expect(ok(k)).toEqual([14, 15]);
    expect(Math.round(k.endpointChanges[1]!.t)).toBe(178);
    expect(ok(wgSessionRun({ roamAt: 0, serverEvery: 45 }))).toEqual([2, 7]);
    expect(ok(wgSessionRun({ roamAt: 0, serverEvery: 45, persistentKeepalive: 25 }))).toEqual([7, 7]);
  });
});
