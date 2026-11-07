/**
 * The security module's cryptography against the test vectors of its standards, and the sims' invariants.
 * Vectors: FIPS 180-4 / NIST examples (SHA-256), RFC 4231 (HMAC), RFC 5869 (HKDF), RFC 7748 (X25519),
 * FIPS 197 appendix C.1 (AES-128), RFC 8448 section 3 (the whole TLS 1.3 key schedule, AES-128-GCM records and RSA-PSS).
 */
import { describe, expect, test } from "vitest";
import {
  RFC8448, aesEncryptBlock, aesExpandKey, aesGcmOpen, ascii, buildTree, concat, consistencyProof, ctEntry, deriveSecret, expandLabel, fromHex,
  hkdfExpand, hkdfExtract, hmac, inclusionProof, inclusionProofLength, leafHash, mth, nameMatches, openRecord, pkiScenario, rfc8448Keys,
  rfc8448Messages, rfc8448Schedule, rsaPssVerify, sealRecord, sha256, tamperRun, toHex, toyKey, toySign, toyVerify, validateChain,
  verifyConsistency, verifyInclusion, wgAcceptFrom, wgRoute, x25519, x25519Public, CT_APPLICATION, PKI_BREAK_LABEL, encapsulate, outerSize,
  espPad, wgPadded, tlsRun, type PkiBreak,
} from "../../src/sims/net/security";

const hx = (b: Uint8Array) => toHex(b);

describe("SHA-256, HMAC, HKDF", () => {
  test("SHA-256 (FIPS 180-4 examples)", () => {
    expect(hx(sha256(ascii("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hx(sha256(new Uint8Array(0)))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hx(sha256(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    // Messages around the 55/56/64-byte padding edges hash without error and differ.
    const seen = new Set([54, 55, 56, 63, 64, 65].map((n) => hx(sha256(new Uint8Array(n)))));
    expect(seen.size).toBe(6);
  });
  test("HMAC-SHA-256 (RFC 4231 test cases 1, 2, 6)", () => {
    expect(hx(hmac(fromHex("0b".repeat(20)), ascii("Hi There")))).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    expect(hx(hmac(ascii("Jefe"), ascii("what do ya want for nothing?")))).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(hx(hmac(fromHex("aa".repeat(131)), ascii("Test Using Larger Than Block-Size Key - Hash Key First")))).toBe("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  });
  test("HKDF (RFC 5869 test case 1)", () => {
    const prk = hkdfExtract(fromHex("000102030405060708090a0b0c"), fromHex("0b".repeat(22)));
    expect(hx(prk)).toBe("077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5");
    expect(hx(hkdfExpand(prk, fromHex("f0f1f2f3f4f5f6f7f8f9"), 42))).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });
});

describe("X25519 and AES", () => {
  test("X25519 (RFC 7748 sections 5.2 and 6.1)", () => {
    expect(hx(x25519(fromHex("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"), fromHex("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"))))
      .toBe("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552");
    const a = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const b = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
    expect(hx(x25519Public(a))).toBe("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    expect(hx(x25519Public(b))).toBe("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    expect(hx(x25519(a, x25519Public(b)))).toBe("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
  });
  test("AES-128 (FIPS 197 appendix C.1)", () => {
    const rk = aesExpandKey(fromHex("000102030405060708090a0b0c0d0e0f"));
    expect(hx(aesEncryptBlock(rk, fromHex("00112233445566778899aabbccddeeff")))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
  });
});

describe("TLS 1.3 against RFC 8448", () => {
  const ks = rfc8448Schedule();
  const v = (id: string) => hx(ks.find((n) => n.id === id)!.value);
  test("the X25519 shared secret of the trace", () => {
    expect(hx(x25519(fromHex(RFC8448.clientPriv), fromHex(RFC8448.serverPub)))).toBe("8bd4054fb55b9d63fdfbacf9f04b9f0d35e6d63f537563efd46272900f89492d");
    expect(hx(x25519Public(fromHex(RFC8448.serverPriv)))).toBe(RFC8448.serverPub);
  });
  test("every secret of the key schedule", () => {
    expect(v("early")).toBe("33ad0a1c607ec03b09e6cd9893680ce210adf300aa1f2660e1b22e10f170f92a");
    expect(v("hs")).toBe("1dc826e93606aa6fdc0aadc12f741b01046aa6b99f691ed221a9f0ca043fbeac");
    expect(v("chs")).toBe("b3eddb126e067f35a780b3abf45e2d8f3b1a950738f52e9600746a0e27a55a21");
    expect(v("shs")).toBe("b67b7d690cc16c4e75e54213cb2d37b4e9c912bcded9105d42befd59d391ad38");
    expect(v("ms")).toBe("18df06843d13a08bf2a449844c5f8a478001bc4d4c627984d5a41da8d0402919");
    expect(v("cap")).toBe("9e40646ce79a7f9dc05af8889bce6552875afa0b06df0087f792ebb7c17504a5");
    expect(v("sap")).toBe("a11af9f05531f856ad47116b45a950328204b4f44bfb6b3a4b4f1f3fcb631643");
    expect(v("exp")).toBe("fe22f881176eda18eb8f44529e6792c50c9a3f89452f68d8ae311b4309d3cf50");
    expect(v("res")).toBe("7df235f2031d2a051287d02b0241b0bfdaf86cc856231f2d5aba46c434ec196c");
    expect(v("shs-key")).toBe("3fce516009c21727d0f2e4e86ee403bc" + "5d313eb2671276ee13000b30");
    expect(v("chs-key")).toBe("dbfaa693d1762c5b666af5d950258d01" + "5bd3c71b836e0b76bb73265f");
    expect(v("cap-key")).toBe("17422dda596ed5d9acd890e3c63f5051" + "5b78923dee08579033e523d9");
    expect(v("sap-key")).toBe("9f02283b6c9c07efc26bb9f2ac92e356" + "cf782b88dd83549aadf1e984");
    // The PSK of a resumption: HKDF-Expand-Label(res master, "resumption", ticket nonce 0x0000, 32).
    expect(hx(expandLabel(fromHex(v("res")), "resumption", new Uint8Array([0, 0]), 32))).toBe("4ecd0eb6ec3b4d87f5d6028f922ca4c5851a277fd41311c9e62d2c9492e1c4f3");
    expect(hx(deriveSecret(fromHex(v("early")), "derived", sha256(new Uint8Array(0))))).toBe("6f2615a108c702c5678f54fc9dbab69716c076189c48250cebeac3576c3611ba");
  });
  test("both Finished MACs", () => {
    const M = rfc8448Messages();
    const sfin = hmac(fromHex(v("sfin-key")), sha256(concat(M.ch, M.sh, M.ee, M.cert, M.cv)));
    expect(hx(sfin)).toBe("9b9b141d906337fbd2cbdce71df4deda4ab42c309572cb7fffee5454b78f0718");
    const cfk = expandLabel(fromHex(v("chs")), "finished", new Uint8Array(0), 32);
    expect(hx(hmac(cfk, sha256(concat(M.ch, M.sh, M.ee, M.cert, M.cv, M.sfin))))).toBe("a8ec436d677634ae525ac1fcebe11a039ec17694fac6e98527b642f2edd5ce61");
  });
  test("AES-128-GCM opens the server's flight and seals the client's data record byte for byte", () => {
    const k = rfc8448Keys();
    const rec = fromHex(RFC8448.serverHsRecord);
    expect(rec.length).toBe(679);
    const o = openRecord(k.serverHs.key, k.serverHs.iv, 0, rec);
    expect(o.ok).toBe(true);
    expect(o.type).toBe(22);
    const M = rfc8448Messages();
    expect(hx(o.content!)).toBe(hx(concat(M.ee, M.cert, M.cv, M.sfin)));
    const mine = sealRecord(k.clientApp.key, k.clientApp.iv, 0, fromHex(RFC8448.clientAppPayload), CT_APPLICATION);
    expect(hx(mine)).toBe(RFC8448.clientAppRecord);
    expect(mine.length).toBe(72);
    // The client's Finished record is sealed with the client handshake key.
    const cf = openRecord(k.clientHs.key, k.clientHs.iv, 0, fromHex(RFC8448.clientFinishedRecord));
    expect(cf.ok && hx(cf.content!)).toBe(hx(M.cfin));
    // Tampering, a wrong sequence number, or a wrong key all fail the tag.
    const bad = rec.slice();
    bad[100]! ^= 1;
    expect(openRecord(k.serverHs.key, k.serverHs.iv, 0, bad).ok).toBe(false);
    expect(openRecord(k.serverHs.key, k.serverHs.iv, 1, rec).ok).toBe(false);
    expect(aesGcmOpen(k.clientHs.key, k.clientHs.iv, rec.slice(5), rec.slice(0, 5))).toBeNull();
  });
  test("RSA-PSS verifies the CertificateVerify, and fails on another transcript", () => {
    const M = rfc8448Messages();
    const content = (th: Uint8Array) => concat(new Uint8Array(64).fill(0x20), ascii("TLS 1.3, server CertificateVerify"), new Uint8Array([0]), th);
    const th = sha256(concat(M.ch, M.sh, M.ee, M.cert));
    expect(rsaPssVerify(fromHex(RFC8448.rsaModulus), 65537, content(th), M.cv.slice(8)).ok).toBe(true);
    const th2 = th.slice();
    th2[0]! ^= 1;
    expect(rsaPssVerify(fromHex(RFC8448.rsaModulus), 65537, content(th2), M.cv.slice(8)).ok).toBe(false);
  });
  test("the attacker scenarios fail at the right check", () => {
    const first = (t: Parameters<typeof tamperRun>[0]) => tamperRun(t).checks.find((c) => !c.ok)?.step;
    expect(tamperRun("none").safe).toBe(true);
    expect(first("sni")).toBe("decrypt EncryptedExtensions … Finished");
    expect(first("flipbyte")).toBe("decrypt EncryptedExtensions … Finished");
    expect(first("keyshare")).toBe("CertificateVerify signature");
    expect(first("downgrade")).toBe("downgrade sentinel");
    expect(hx(tamperRun("downgrade").serverHello.slice(30, 38))).toBe("444f574e47524401");
  });
});

describe("PKI and CT", () => {
  test("toy RSA signs and verifies", () => {
    const k = toyKey("t", 2147483647n, 2147483579n);
    const s = toySign(k, ascii("hello"));
    expect(toyVerify(k, ascii("hello"), s)).toBe(true);
    expect(toyVerify(k, ascii("hellp"), s)).toBe(false);
  });
  test("each broken link fails exactly where the lesson says", () => {
    const want: Record<PkiBreak, [string, string] | null> = {
      none: null, tampered: ["leaf", "signature"], intNotCa: ["int", "basicConstraints"], leafSigns: ["evil", "basicConstraints"],
      missingInt: ["leaf", "find the issuer"], untrustedRoot: ["root", "find the issuer"], wrongEku: ["leaf", "extendedKeyUsage"],
      revoked: ["leaf", "revocation"], noScts: ["leaf", "Certificate Transparency"],
    };
    for (const b of Object.keys(PKI_BREAK_LABEL) as PkiBreak[]) {
      const v = validateChain(pkiScenario(b), { host: "www.example.com", day: 30, minScts: 2 });
      expect(v.failed ? [v.failed.cert, v.failed.check] : null, b).toEqual(want[b]);
    }
  });
  test("validity and names", () => {
    const sc = pkiScenario("none");
    expect(validateChain(sc, { host: "example.com", day: 89 }).ok).toBe(true);
    expect(validateChain(sc, { host: "example.com", day: 90 }).failed?.check).toBe("validity");
    expect(validateChain(sc, { host: "api.example.com", day: 30 }).failed?.check).toBe("name");
    expect(nameMatches("*.example.com", "api.example.com")).toBe(true);
    expect(nameMatches("*.example.com", "a.b.example.com")).toBe(false);
    expect(nameMatches("*.example.com", "example.com")).toBe(false);
  });
  test("Merkle proofs verify for every leaf and size, and fail after a rewrite", () => {
    for (let n = 1; n <= 17; n++) {
      const e = Array.from({ length: n }, (_, i) => ctEntry(`n${i}`, i));
      const root = mth(e);
      expect(hx(buildTree(e).hash)).toBe(hx(root));
      for (let m = 0; m < n; m++) {
        const p = inclusionProof(m, e);
        expect(p.length).toBe(inclusionProofLength(m, n));
        expect(verifyInclusion(leafHash(e[m]!), m, n, p, root)).toBe(true);
        expect(verifyInclusion(leafHash(ctEntry("x", 99)), m, n, p, root)).toBe(false);
      }
      for (let m = 1; m < n; m++) {
        expect(verifyConsistency(m, n, mth(e.slice(0, m)), root, consistencyProof(m, e)), `${m}→${n}`).toBe(true);
        const forged = e.map((x, i) => (i === 0 ? ctEntry("evil", 0) : x));
        expect(verifyConsistency(m, n, mth(e.slice(0, m)), mth(forged), consistencyProof(m, forged))).toBe(false);
      }
    }
  });
});

describe("tunnels and WireGuard", () => {
  test("header sizes add up", () => {
    expect(encapsulate("wg4", 100).map((l) => l.bytes)).toEqual([20, 8, 16, 100, 12, 16]);
    expect(wgPadded(1419)).toBe(1420);
    expect(wgPadded(1420)).toBe(1420);
    expect(wgPadded(1430)).toBe(1430); // never past the interface MTU
    expect([0, 1, 2, 3].map((k) => espPad(1400 + k))).toEqual([2, 1, 0, 3]);
    expect(outerSize("gre", 1000)).toBe(1024);
  });
  test("cryptokey routing: longest prefix out, AllowedIPs check in", () => {
    const peers = [{ name: "all", allowed: ["0.0.0.0/0"] }, { name: "office", allowed: ["10.0.0.0/8", "192.168.50.0/24"] }];
    expect(wgRoute(peers, "10.2.3.4").peer).toBe("office");
    expect(wgRoute(peers, "8.8.8.8").peer).toBe("all");
    expect(wgRoute([peers[1]!], "8.8.8.8").peer).toBeUndefined();
    expect(wgAcceptFrom(peers[1]!, "192.168.50.9")).toBe(true);
    expect(wgAcceptFrom(peers[1]!, "192.168.51.9")).toBe(false);
  });
});

describe("TLS on TCP", () => {
  test("the request waits for the handshake, and each message arrives after it is sent", () => {
    for (const mode of ["tls12", "tls13", "tls13-0rtt"] as const) {
      const r = tlsRun({ mode, rttMs: 40 });
      for (const t of r.msgs) expect(t.arrivedAt!).toBeGreaterThan(t.sentAt);
      expect(r.responseAt).toBeGreaterThan(r.requestAt);
      expect(r.tcpEstablishedAt).toBeCloseTo(40, 0);
    }
  });
});
