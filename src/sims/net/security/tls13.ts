/**
 * TLS 1.3 on real bytes: the key schedule of RFC 8446 section 7.1, the record layer of section 5, and the checks a
 * client makes in the handshake. The inputs are the messages and keys of the RFC 8448 trace (rfc8448.ts), so every
 * secret here is the one in that RFC, and the tests pin them.
 *
 * - `keySchedule`: the tree of secrets, from the PSK and the (EC)DHE shared secret down to traffic keys.
 * - `sealRecord` / `openRecord`: TLSInnerPlaintext, the per-record nonce (IV XOR sequence number), and the record
 *   header as additional data for AES-128-GCM.
 * - `parseHello`: the fields and extensions of a ClientHello or ServerHello, with byte offsets.
 * - `tamperRun`: an attacker on the path changes the handshake, and the client's checks find it (or not).
 */
import { HASH_LEN, aesGcmOpen, aesGcmSeal, ascii, concat, deriveSecret, equal, expandLabel, fromHex, hkdfExtract, hmac, rsaPssVerify, sha256, toHex, uint, x25519, x25519Public, xor, type Bytes } from "./crypto";
import { RFC8448 } from "./rfc8448";

const EMPTY = new Uint8Array(0);
const ZERO = new Uint8Array(HASH_LEN);

// ------------------------------------------------------------------ the key schedule

export type KsKind = "input" | "extract" | "derive" | "key";

export interface KsNode {
  id: string;
  /** The name RFC 8446 gives the value. */
  name: string;
  kind: KsKind;
  /** How it is computed, for example 'Derive-Secret(Handshake Secret, "c hs traffic", ClientHello…ServerHello)'. */
  formula: string;
  /** Ids of the nodes it is computed from. */
  from: string[];
  value: Bytes;
  /** What the value protects or proves. */
  use: string;
}

export interface KsInputs {
  /** The PSK from a ticket, or undefined for a full handshake (then 32 zero bytes go in). */
  psk?: Bytes;
  /** The (EC)DHE shared secret, or undefined for a PSK-only (psk_ke) resumption. */
  ecdhe?: Bytes;
  /** Transcript hashes: ClientHello, ClientHello…ServerHello, …server Finished, …client Finished. */
  thCh: Bytes;
  thSh: Bytes;
  thSf: Bytes;
  thCf: Bytes;
  /** AES-128-GCM: 16-byte keys. */
  keyLen?: number;
}

/** Every secret of the TLS 1.3 key schedule, in the order of the RFC 8446 diagram. */
export function keySchedule(inp: KsInputs): KsNode[] {
  const keyLen = inp.keyLen ?? 16;
  const empty = sha256(EMPTY);
  const out: KsNode[] = [];
  const add = (n: KsNode) => (out.push(n), n.value);
  const psk = inp.psk ?? ZERO, ecdhe = inp.ecdhe ?? ZERO;
  add({ id: "psk", name: inp.psk ? "PSK (from a ticket)" : "PSK = 0 (none)", kind: "input", formula: inp.psk ? "HKDF-Expand-Label(resumption_master_secret, \"resumption\", ticket_nonce, 32)" : "32 zero bytes", from: [], value: psk, use: "resumption: proves the client had the earlier session" });
  const es = add({ id: "early", name: "Early Secret", kind: "extract", formula: "HKDF-Extract(salt = 0, IKM = PSK)", from: ["psk"], value: hkdfExtract(EMPTY, psk), use: "the root of the schedule" });
  add({ id: "binder", name: "binder_key", kind: "derive", formula: "Derive-Secret(Early Secret, \"res binder\", \"\")", from: ["early"], value: deriveSecret(es, "res binder", empty), use: "the PSK binder in the ClientHello" });
  const cet = add({ id: "cet", name: "client_early_traffic_secret", kind: "derive", formula: "Derive-Secret(Early Secret, \"c e traffic\", ClientHello)", from: ["early"], value: deriveSecret(es, "c e traffic", inp.thCh), use: "0-RTT data (no forward secrecy, can be replayed)" });
  add({ id: "cet-key", name: "early data key, iv", kind: "key", formula: "HKDF-Expand-Label(c e traffic, \"key\" / \"iv\", \"\", 16 / 12)", from: ["cet"], value: concat(expandLabel(cet, "key", EMPTY, keyLen), expandLabel(cet, "iv", EMPTY, 12)), use: "AEAD key and IV of 0-RTT records" });
  const d1 = add({ id: "derived1", name: "derived", kind: "derive", formula: "Derive-Secret(Early Secret, \"derived\", \"\")", from: ["early"], value: deriveSecret(es, "derived", empty), use: "the salt for the next extract" });
  add({ id: "ecdhe", name: inp.ecdhe ? "(EC)DHE shared secret" : "(EC)DHE = 0 (psk_ke)", kind: "input", formula: inp.ecdhe ? "X25519(own private key, peer key_share)" : "32 zero bytes: no key exchange", from: [], value: ecdhe, use: "fresh per connection: forward secrecy" });
  const hs = add({ id: "hs", name: "Handshake Secret", kind: "extract", formula: "HKDF-Extract(salt = derived, IKM = (EC)DHE)", from: ["derived1", "ecdhe"], value: hkdfExtract(d1, ecdhe), use: "the root of the handshake keys" });
  const chs = add({ id: "chs", name: "client_handshake_traffic_secret", kind: "derive", formula: "Derive-Secret(Handshake Secret, \"c hs traffic\", ClientHello…ServerHello)", from: ["hs"], value: deriveSecret(hs, "c hs traffic", inp.thSh), use: "the client's Finished" });
  const shs = add({ id: "shs", name: "server_handshake_traffic_secret", kind: "derive", formula: "Derive-Secret(Handshake Secret, \"s hs traffic\", ClientHello…ServerHello)", from: ["hs"], value: deriveSecret(hs, "s hs traffic", inp.thSh), use: "EncryptedExtensions … server Finished" });
  add({ id: "shs-key", name: "server handshake key, iv", kind: "key", formula: "HKDF-Expand-Label(s hs traffic, \"key\" / \"iv\", \"\", 16 / 12)", from: ["shs"], value: concat(expandLabel(shs, "key", EMPTY, keyLen), expandLabel(shs, "iv", EMPTY, 12)), use: "AEAD key and IV of the server's handshake records" });
  add({ id: "sfin-key", name: "server finished_key", kind: "key", formula: "HKDF-Expand-Label(s hs traffic, \"finished\", \"\", 32)", from: ["shs"], value: expandLabel(shs, "finished", EMPTY, HASH_LEN), use: "HMAC key of the server's Finished" });
  add({ id: "chs-key", name: "client handshake key, iv", kind: "key", formula: "HKDF-Expand-Label(c hs traffic, \"key\" / \"iv\", \"\", 16 / 12)", from: ["chs"], value: concat(expandLabel(chs, "key", EMPTY, keyLen), expandLabel(chs, "iv", EMPTY, 12)), use: "AEAD key and IV of the client's Finished record" });
  const d2 = add({ id: "derived2", name: "derived", kind: "derive", formula: "Derive-Secret(Handshake Secret, \"derived\", \"\")", from: ["hs"], value: deriveSecret(hs, "derived", empty), use: "the salt for the next extract" });
  const ms = add({ id: "ms", name: "Master Secret", kind: "extract", formula: "HKDF-Extract(salt = derived, IKM = 0)", from: ["derived2"], value: hkdfExtract(d2, ZERO), use: "the root of the application keys" });
  const cap = add({ id: "cap", name: "client_application_traffic_secret_0", kind: "derive", formula: "Derive-Secret(Master Secret, \"c ap traffic\", ClientHello…server Finished)", from: ["ms"], value: deriveSecret(ms, "c ap traffic", inp.thSf), use: "the client's application data" });
  add({ id: "cap-key", name: "client application key, iv", kind: "key", formula: "HKDF-Expand-Label(c ap traffic, \"key\" / \"iv\", \"\", 16 / 12)", from: ["cap"], value: concat(expandLabel(cap, "key", EMPTY, keyLen), expandLabel(cap, "iv", EMPTY, 12)), use: "AEAD key and IV of the client's data records" });
  const sap = add({ id: "sap", name: "server_application_traffic_secret_0", kind: "derive", formula: "Derive-Secret(Master Secret, \"s ap traffic\", ClientHello…server Finished)", from: ["ms"], value: deriveSecret(ms, "s ap traffic", inp.thSf), use: "the server's application data" });
  add({ id: "sap-key", name: "server application key, iv", kind: "key", formula: "HKDF-Expand-Label(s ap traffic, \"key\" / \"iv\", \"\", 16 / 12)", from: ["sap"], value: concat(expandLabel(sap, "key", EMPTY, keyLen), expandLabel(sap, "iv", EMPTY, 12)), use: "AEAD key and IV of the server's data records" });
  add({ id: "exp", name: "exporter_master_secret", kind: "derive", formula: "Derive-Secret(Master Secret, \"exp master\", ClientHello…server Finished)", from: ["ms"], value: deriveSecret(ms, "exp master", inp.thSf), use: "keys for other protocols (RFC 5705 exporters)" });
  add({ id: "res", name: "resumption_master_secret", kind: "derive", formula: "Derive-Secret(Master Secret, \"res master\", ClientHello…client Finished)", from: ["ms"], value: deriveSecret(ms, "res master", inp.thCf), use: "the PSK of the next connection (with a ticket nonce)" });
  return out;
}

/** The transcript of the RFC 8448 connection as handshake messages (no record headers). */
export function rfc8448Messages() {
  const m = (h: string) => fromHex(h);
  return {
    ch: m(RFC8448.clientHello), sh: m(RFC8448.serverHello), ee: m(RFC8448.encryptedExtensions), cert: m(RFC8448.certificate),
    cv: m(RFC8448.certificateVerify), sfin: m(RFC8448.serverFinished), cfin: m(RFC8448.clientFinished),
  };
}

/** The key schedule of the RFC 8448 connection. `flipEcdheBit` flips one bit of the shared secret; `withPsk` resumes with the trace's ticket. */
export function rfc8448Schedule(o: { flipEcdheBit?: number; withPsk?: boolean; pskOnly?: boolean } = {}): KsNode[] {
  const M = rfc8448Messages();
  let ecdhe: Bytes | undefined = x25519(fromHex(RFC8448.clientPriv), fromHex(RFC8448.serverPub));
  if (o.flipEcdheBit !== undefined) {
    ecdhe = ecdhe.slice();
    ecdhe[o.flipEcdheBit >> 3]! ^= 0x80 >> (o.flipEcdheBit & 7);
  }
  if (o.pskOnly) ecdhe = undefined;
  const th = (...xs: Bytes[]) => sha256(concat(...xs));
  let psk: Bytes | undefined;
  if (o.withPsk || o.pskOnly) {
    const full = rfc8448Schedule();
    const res = full.find((n) => n.id === "res")!.value;
    psk = expandLabel(res, "resumption", new Uint8Array([0, 0]), HASH_LEN);
  }
  return keySchedule({
    psk, ecdhe,
    thCh: th(M.ch), thSh: th(M.ch, M.sh), thSf: th(M.ch, M.sh, M.ee, M.cert, M.cv, M.sfin), thCf: th(M.ch, M.sh, M.ee, M.cert, M.cv, M.sfin, M.cfin),
  });
}

// ------------------------------------------------------------------ the record layer

export const CT_ALERT = 21, CT_HANDSHAKE = 22, CT_APPLICATION = 23;
export const MAX_PLAINTEXT = 2 ** 14;

/** The per-record nonce: the 64-bit sequence number, left-padded to the IV length, XOR the IV (RFC 8446 section 5.3). */
export const recordNonce = (iv: Bytes, seq: number) => xor(iv, uint(seq, iv.length));

/** TLSInnerPlaintext: content ‖ real content type ‖ zero padding. */
export const innerPlaintext = (content: Bytes, type: number, pad = 0) => concat(content, new Uint8Array([type]), new Uint8Array(pad));

/** The 5-byte header of a protected record: opaque type 23, legacy version 0x0303, length of the ciphertext with its tag. */
export const recordHeader = (len: number) => new Uint8Array([CT_APPLICATION, 0x03, 0x03, len >> 8, len & 0xff]);

/** Protects one record. Returns header ‖ ciphertext ‖ tag. */
export function sealRecord(key: Bytes, iv: Bytes, seq: number, content: Bytes, type: number, pad = 0): Bytes {
  const inner = innerPlaintext(content, type, pad);
  const header = recordHeader(inner.length + 16);
  return concat(header, aesGcmSeal(key, recordNonce(iv, seq), inner, header));
}

export interface Opened {
  ok: boolean;
  content?: Bytes;
  type?: number;
  pad?: number;
  why?: string;
}

/** Removes protection from one record, as the receiver does with its own expected sequence number. */
export function openRecord(key: Bytes, iv: Bytes, seq: number, record: Bytes): Opened {
  if (record.length < 5 + 17) return { ok: false, why: "record too short" };
  const header = record.slice(0, 5);
  const len = (header[3]! << 8) | header[4]!;
  if (len !== record.length - 5) return { ok: false, why: "length field does not match the record" };
  if (len > MAX_PLAINTEXT + 256) return { ok: false, why: "record_overflow" };
  const inner = aesGcmOpen(key, recordNonce(iv, seq), record.slice(5), header);
  if (!inner) return { ok: false, why: "bad_record_mac: the authentication tag does not match" };
  let end = inner.length - 1;
  while (end >= 0 && inner[end] === 0) end--;
  if (end < 0) return { ok: false, why: "unexpected_message: no content type" };
  return { ok: true, content: inner.slice(0, end), type: inner[end], pad: inner.length - 1 - end };
}

/** Keys of the RFC 8448 connection. */
export function rfc8448Keys() {
  const ks = rfc8448Schedule();
  const kv = (id: string) => {
    const v = ks.find((n) => n.id === id)!.value;
    return { key: v.slice(0, 16), iv: v.slice(16) };
  };
  return { serverHs: kv("shs-key"), clientHs: kv("chs-key"), clientApp: kv("cap-key"), serverApp: kv("sap-key"), ks };
}

// ------------------------------------------------------------------ hello messages

export interface HelloField {
  name: string;
  offset: number;
  len: number;
  /** A short decoded value. */
  value: string;
}

export const EXT_NAMES: Record<number, string> = {
  0: "server_name (SNI)", 10: "supported_groups", 13: "signature_algorithms", 16: "ALPN", 28: "record_size_limit",
  35: "session_ticket", 41: "pre_shared_key", 42: "early_data", 43: "supported_versions", 45: "psk_key_exchange_modes",
  51: "key_share", 65281: "renegotiation_info", 65037: "encrypted_client_hello",
};

const GROUPS: Record<number, string> = { 0x1d: "x25519", 0x17: "secp256r1", 0x18: "secp384r1", 0x19: "secp521r1", 0x100: "ffdhe2048", 0x101: "ffdhe3072", 0x102: "ffdhe4096", 0x103: "ffdhe6144", 0x104: "ffdhe8192", 0x11ec: "X25519MLKEM768" };
const SUITES: Record<number, string> = { 0x1301: "TLS_AES_128_GCM_SHA256", 0x1302: "TLS_AES_256_GCM_SHA384", 0x1303: "TLS_CHACHA20_POLY1305_SHA256" };

/** Splits a ClientHello or ServerHello handshake message into its fields and extensions. */
export function parseHello(msg: Bytes): HelloField[] {
  const f: HelloField[] = [];
  const u16 = (o: number) => (msg[o]! << 8) | msg[o + 1]!;
  const isClient = msg[0] === 1;
  f.push({ name: "handshake type", offset: 0, len: 1, value: isClient ? "1 (client_hello)" : "2 (server_hello)" });
  f.push({ name: "length", offset: 1, len: 3, value: String((msg[1]! << 16) | u16(2)) });
  f.push({ name: "legacy_version", offset: 4, len: 2, value: "0x0303 (TLS 1.2, frozen)" });
  f.push({ name: "random", offset: 6, len: 32, value: toHex(msg.slice(30, 38)).replace(/(..)/g, "$1 ").trim() + " (last 8)" });
  let o = 38;
  const sidLen = msg[o]!;
  f.push({ name: "legacy_session_id", offset: o, len: 1 + sidLen, value: `${sidLen} bytes` });
  o += 1 + sidLen;
  if (isClient) {
    const n = u16(o);
    const list: string[] = [];
    for (let i = 0; i < n; i += 2) list.push(SUITES[u16(o + 2 + i)] ?? `0x${u16(o + 2 + i).toString(16)}`);
    f.push({ name: "cipher_suites", offset: o, len: 2 + n, value: list.join(", ") });
    o += 2 + n;
    f.push({ name: "legacy_compression_methods", offset: o, len: 1 + msg[o]!, value: "null only" });
    o += 1 + msg[o]!;
  } else {
    f.push({ name: "cipher_suite", offset: o, len: 2, value: SUITES[u16(o)] ?? `0x${u16(o).toString(16)}` });
    o += 2;
    f.push({ name: "legacy_compression_method", offset: o, len: 1, value: "0" });
    o += 1;
  }
  const extEnd = o + 2 + u16(o);
  o += 2;
  while (o < extEnd) {
    const type = u16(o), len = u16(o + 2);
    const body = msg.slice(o + 4, o + 4 + len);
    let value = `${len} bytes`;
    if (type === 0 && len > 5) value = new TextDecoder().decode(body.slice(5));
    if (type === 51) {
      const g = isClient ? (body[2]! << 8) | body[3]! : (body[0]! << 8) | body[1]!;
      const keyLen = len - (isClient ? 6 : 4);
      value = `${GROUPS[g] ?? g}, ${keyLen}-byte key ${toHex(body.slice(isClient ? 6 : 4, (isClient ? 6 : 4) + 4)).replace(/(..)/g, "$1 ")}…`;
    }
    if (type === 43) value = isClient ? `TLS ${[...body.slice(1)].reduce((s: string[], _b, i, a) => (i % 2 === 0 ? [...s, `1.${a[i + 1]! - 1}`] : s), []).join(", ")}` : `TLS 1.${body[1]! - 1}`;
    if (type === 10) value = Array.from({ length: (len - 2) / 2 }, (_, i) => GROUPS[(body[2 + 2 * i]! << 8) | body[3 + 2 * i]!] ?? "?").join(", ");
    f.push({ name: EXT_NAMES[type] ?? `extension ${type}`, offset: o, len: 4 + len, value });
    o += 4 + len;
  }
  return f;
}

// ------------------------------------------------------------------ an attacker on the path

/** The last 8 bytes of ServerHello.random when a TLS 1.3 server negotiates TLS 1.2 (RFC 8446 section 4.1.3). */
export const DOWNGRADE_TLS12 = fromHex("444f574e47524401");
export const DOWNGRADE_TLS11 = fromHex("444f574e47524400");

export type Tamper = "none" | "sni" | "keyshare" | "downgrade" | "flipbyte";

export interface Check {
  step: string;
  ok: boolean;
  detail: string;
}

export interface TamperRun {
  /** What the attacker changed, as seen in the ClientHello or ServerHello. */
  change: string;
  checks: Check[];
  /** The client completes the handshake with the real server and nothing was changed without detection. */
  safe: boolean;
  /** The handshake completed but the attacker can read the traffic. */
  compromised: boolean;
  clientHello: Bytes;
  serverHello: Bytes;
}

/** An attacker's own X25519 key pair (a fixed private key, so the run repeats). */
export const ATTACKER_PRIV = fromHex("a8abababababababababababababababababababababababababababababab6b");

/**
 * The RFC 8448 handshake with an attacker on the path. The client checks, in order: the downgrade sentinel in
 * ServerHello.random, the AEAD tag of the first encrypted record, the CertificateVerify signature over the
 * transcript (real RSA-PSS with the trace's key), and the server's Finished MAC.
 */
export function tamperRun(t: Tamper): TamperRun {
  const M = rfc8448Messages();
  const cPriv = fromHex(RFC8448.clientPriv), sPriv = fromHex(RFC8448.serverPriv);
  const chSent = M.ch;
  let chAtServer = M.ch, shAtClient = M.sh;
  let change = "nothing: the attacker only forwards the packets";
  const checks: Check[] = [];
  const finish = (compromised = false): TamperRun => ({ change, checks, safe: checks.every((c) => c.ok) && !compromised && t === "none", compromised, clientHello: chAtServer, serverHello: shAtClient });

  if (t === "downgrade") {
    change = "removes TLS 1.3 from supported_versions, so the server negotiates TLS 1.2";
    // The server answers as TLS 1.2. Its random ends in the sentinel. The ServerKeyExchange signature covers it.
    const sh = M.sh.slice();
    sh.set(DOWNGRADE_TLS12, 6 + 32 - 8);
    shAtClient = sh;
    const tail = sh.slice(30, 38);
    const hit = equal(tail, DOWNGRADE_TLS12);
    checks.push({ step: "downgrade sentinel", ok: !hit, detail: hit ? `ServerHello.random ends in ${toHex(tail)} ("DOWNGRD" 01). A client that offered TLS 1.3 aborts with illegal_parameter. The attacker cannot erase it: the server signs both randoms.` : "no sentinel" });
    return finish();
  }

  checks.push({ step: "downgrade sentinel", ok: true, detail: "ServerHello.random does not end in \"DOWNGRD\"" });
  if (t === "sni") {
    change = "rewrites the server name in the ClientHello from \"server\" to \"attack\"";
    const i = indexOf(M.ch, ascii("server"));
    chAtServer = M.ch.slice();
    chAtServer.set(ascii("attack"), i);
  }
  if (t === "flipbyte") {
    change = "flips one bit of the ClientHello's random";
    chAtServer = M.ch.slice();
    chAtServer[10]! ^= 0x01;
  }
  let attackerSees = false;
  let ssClient = x25519(cPriv, fromHex(RFC8448.serverPub));
  if (t === "keyshare") {
    change = "replaces the server's key_share with its own, and runs a second handshake with the server";
    const aPub = x25519Public(ATTACKER_PRIV);
    const sh = M.sh.slice();
    sh.set(aPub, indexOf(M.sh, fromHex(RFC8448.serverPub)));
    shAtClient = sh;
    ssClient = x25519(cPriv, aPub);
    // The attacker shares a secret with the client: without a signature check it could read everything.
    attackerSees = equal(ssClient, x25519(ATTACKER_PRIV, fromHex(RFC8448.clientPub)));
  }

  // The server's view: its transcript and keys.
  const ssServer = x25519(sPriv, fromHex(RFC8448.clientPub));
  const sched = (ch: Bytes, sh: Bytes, ss: Bytes) => keySchedule({ ecdhe: ss, thCh: sha256(ch), thSh: sha256(concat(ch, sh)), thSf: ZERO, thCf: ZERO });
  const val = (ks: KsNode[], id: string) => ks.find((n) => n.id === id)!.value;
  // Who encrypts the flight the client receives: the server, or (key share swap) the attacker with the client's keys.
  const senderKs = t === "keyshare" ? sched(chSent, shAtClient, x25519(ATTACKER_PRIV, fromHex(RFC8448.clientPub))) : sched(chAtServer, M.sh, ssServer);
  const clientKs = sched(chSent, shAtClient, ssClient);
  const sk = val(senderKs, "shs-key");
  const flight = concat(M.ee, M.cert, M.cv, M.sfin);
  const record = sealRecord(sk.slice(0, 16), sk.slice(16), 0, flight, CT_HANDSHAKE);
  const ck = val(clientKs, "shs-key");
  const opened = openRecord(ck.slice(0, 16), ck.slice(16), 0, record);
  checks.push({ step: "decrypt EncryptedExtensions … Finished", ok: opened.ok, detail: opened.ok ? "the AEAD tag matches: both sides derived the same handshake keys" : `${opened.why}. The handshake keys hang on the hash of ClientHello…ServerHello, and the two sides saw different bytes.` });
  if (!opened.ok) return finish();
  // CertificateVerify: the server's RSA-PSS signature over the transcript up to Certificate. The attacker can only forward it.
  const th = sha256(concat(chSent, shAtClient, M.ee, M.cert));
  const content = concat(new Uint8Array(64).fill(0x20), ascii("TLS 1.3, server CertificateVerify"), new Uint8Array([0]), th);
  const pss = rsaPssVerify(fromHex(RFC8448.rsaModulus), RFC8448.rsaExponent, content, M.cv.slice(8));
  checks.push({ step: "CertificateVerify signature", ok: pss.ok, detail: pss.ok ? "RSA-PSS over the transcript hash verifies with the key in the certificate" : `RSA-PSS fails: ${pss.why}. The server signed a transcript with its own key share, not the attacker's, and the attacker has no private key to sign a new one.` });
  if (!pss.ok) return finish();
  if (attackerSees) return finish(true);
  const fk = val(clientKs, "sfin-key");
  const want = hmac(fk, sha256(concat(chSent, shAtClient, M.ee, M.cert, M.cv)));
  const okFin = equal(want, M.sfin.slice(4));
  checks.push({ step: "server Finished", ok: okFin, detail: okFin ? "HMAC(finished_key, transcript hash) matches" : "the MAC does not match the client's transcript" });
  return finish(attackerSees);
}

function indexOf(hay: Bytes, needle: Bytes): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
