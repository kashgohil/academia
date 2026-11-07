/**
 * Small, readable cryptography for the security module. These are real algorithms, tested against the test
 * vectors of their standards (tests/unit/net-security*.test.ts). They are for teaching: they are slow, and they do
 * not run in constant time, so never use them to protect real data.
 *
 * - SHA-256 (FIPS 180-4), HMAC (RFC 2104), HKDF (RFC 5869).
 * - TLS 1.3 HKDF-Expand-Label and Derive-Secret (RFC 8446, section 7.1).
 * - X25519 (RFC 7748), with BigInt arithmetic modulo 2²⁵⁵ − 19.
 * - AES-128 (FIPS 197) and GCM (NIST SP 800-38D), the AEAD of TLS_AES_128_GCM_SHA256.
 * - RSA-PSS signature verification with MGF1 and SHA-256 (RFC 8017), as TLS 1.3 uses for rsa_pss_rsae_sha256.
 * - A toy RSA with a 62-bit modulus, for certificate chains that a demo can sign in a millisecond.
 */

// ------------------------------------------------------------------ bytes

export type Bytes = Uint8Array;

export function fromHex(h: string): Bytes {
  const s = h.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Hex without spaces: "3f0a…". */
export const toHex = (b: Bytes) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `n` as a big-endian unsigned integer of `len` bytes. */
export function uint(n: number, len: number): Bytes {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
}

export const ascii = (s: string) => new TextEncoder().encode(s);

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function xor(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i % b.length]!;
  return out;
}

// ------------------------------------------------------------------ SHA-256

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of `msg` (FIPS 180-4). 32 bytes. */
export function sha256(msg: Bytes): Bytes {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  // Padding: a 1 bit, zeros, then the bit length as a 64-bit big-endian number; the total is a multiple of 64 bytes.
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const p = new Uint8Array(total);
  p.set(msg);
  p[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(p.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  dv.setUint32(total - 4, bits >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0]! += a; h[1]! += b; h[2]! += c; h[3]! += d; h[4]! += e; h[5]! += f; h[6]! += g; h[7]! += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(4 * i, h[i]!);
  return out;
}

export const HASH_LEN = 32;

// ------------------------------------------------------------------ HMAC and HKDF

/** HMAC-SHA256 (RFC 2104): H((K ⊕ opad) ‖ H((K ⊕ ipad) ‖ m)). */
export function hmac(key: Bytes, msg: Bytes): Bytes {
  let k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  k = block;
  const ipad = k.map((x) => x ^ 0x36), opad = k.map((x) => x ^ 0x5c);
  return sha256(concat(opad, sha256(concat(ipad, msg))));
}

/** HKDF-Extract (RFC 5869): PRK = HMAC(salt, IKM). An empty salt means 32 zero bytes. */
export const hkdfExtract = (salt: Bytes, ikm: Bytes) => hmac(salt.length ? salt : new Uint8Array(HASH_LEN), ikm);

/** HKDF-Expand (RFC 5869): T(i) = HMAC(PRK, T(i−1) ‖ info ‖ i), concatenated and cut to `len` bytes. */
export function hkdfExpand(prk: Bytes, info: Bytes, len: number): Bytes {
  const out = new Uint8Array(len);
  let t: Bytes = new Uint8Array(0);
  for (let i = 1, o = 0; o < len; i++) {
    t = hmac(prk, concat(t, info, new Uint8Array([i])));
    out.set(t.slice(0, Math.min(t.length, len - o)), o);
    o += t.length;
  }
  return out;
}

/** The HkdfLabel struct of RFC 8446 section 7.1: uint16 length, opaque label<7..255> = "tls13 " + label, opaque context<0..255>. */
export function hkdfLabel(label: string, context: Bytes, len: number): Bytes {
  const l = ascii("tls13 " + label);
  return concat(uint(len, 2), uint(l.length, 1), l, uint(context.length, 1), context);
}

/** HKDF-Expand-Label(Secret, Label, Context, Length) of TLS 1.3. */
export const expandLabel = (secret: Bytes, label: string, context: Bytes, len: number) => hkdfExpand(secret, hkdfLabel(label, context, len), len);

/** Derive-Secret(Secret, Label, Messages) = HKDF-Expand-Label(Secret, Label, Transcript-Hash(Messages), Hash.length). */
export const deriveSecret = (secret: Bytes, label: string, transcriptHash: Bytes) => expandLabel(secret, label, transcriptHash, HASH_LEN);

// ------------------------------------------------------------------ X25519

const P25519 = (1n << 255n) - 19n;
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

export function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

const leToBig = (b: Bytes) => b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
function bigToLe(n: bigint, len: number): Bytes {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
export const beToBig = (b: Bytes) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
export function bigToBe(n: bigint, len: number): Bytes {
  return bigToLe(n, len).reverse();
}

/** X25519(k, u) of RFC 7748: the Montgomery ladder on Curve25519. Both inputs and the output are 32 bytes. */
export function x25519(scalar: Bytes, u: Bytes): Bytes {
  const k = scalar.slice();
  k[0]! &= 248;
  k[31]! &= 127;
  k[31]! |= 64;
  const kk = leToBig(k);
  const uu = u.slice();
  uu[31]! &= 127;
  const x1 = mod(leToBig(uu), P25519);
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
  const p = P25519;
  for (let t = 254n; t >= 0n; t--) {
    const kt = (kk >> t) & 1n;
    swap ^= kt;
    if (swap) [x2, x3, z2, z3] = [x3, x2, z3, z2];
    swap = kt;
    const A = (x2 + z2) % p, AA = (A * A) % p, B = mod(x2 - z2, p), BB = (B * B) % p, E = mod(AA - BB, p);
    const C = (x3 + z3) % p, D = mod(x3 - z3, p), DA = (D * A) % p, CB = (C * B) % p;
    x3 = ((DA + CB) * (DA + CB)) % p;
    const dm = mod(DA - CB, p);
    z3 = (x1 * ((dm * dm) % p)) % p;
    x2 = (AA * BB) % p;
    z2 = (E * ((AA + 121665n * E) % p)) % p;
  }
  if (swap) [x2, z2] = [x3, z3];
  return bigToLe((x2 * modPow(z2, p - 2n, p)) % p, 32);
}

/** The X25519 public key of a private key: X25519(k, 9). */
export const x25519Public = (priv: Bytes) => x25519(priv, bigToLe(9n, 32));

// ------------------------------------------------------------------ AES-128 and GCM

const SBOX = (() => {
  // The AES S-box from its definition: the inverse in GF(2⁸), then an affine map.
  const s = new Uint8Array(256);
  const mul = (a: number, b: number) => {
    let r = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) r ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b;
      b >>= 1;
    }
    return r;
  };
  for (let x = 0; x < 256; x++) {
    let inv = 0;
    if (x) for (let y = 1; y < 256; y++) if (mul(x, y) === 1) { inv = y; break; }
    let r = inv;
    for (let i = 1; i <= 4; i++) r ^= ((inv << i) | (inv >> (8 - i))) & 0xff;
    s[x] = r ^ 0x63;
  }
  return s;
})();

const xtime = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

/** The 11 round keys of AES-128 (FIPS 197 key expansion), 176 bytes. */
export function aesExpandKey(key: Bytes): Bytes {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t = [w[i - 4]!, w[i - 3]!, w[i - 2]!, w[i - 1]!];
    if (i % 16 === 0) {
      t = [SBOX[t[1]!]! ^ rcon, SBOX[t[2]!]!, SBOX[t[3]!]!, SBOX[t[0]!]!];
      rcon = xtime(rcon);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j]! ^ t[j]!;
  }
  return w;
}

/** Encrypts one 16-byte block with AES-128. */
export function aesEncryptBlock(rk: Bytes, block: Bytes): Bytes {
  const s = block.slice();
  for (let i = 0; i < 16; i++) s[i]! ^= rk[i]!;
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;
    // ShiftRows: row r (bytes r, r+4, r+8, r+12) rotates left by r.
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[4 * c + r] = t[4 * ((c + r) % 4) + r]!;
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[4 * c]!, a1 = s[4 * c + 1]!, a2 = s[4 * c + 2]!, a3 = s[4 * c + 3]!;
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[4 * c] = a0 ^ all ^ xtime(a0 ^ a1);
        s[4 * c + 1] = a1 ^ all ^ xtime(a1 ^ a2);
        s[4 * c + 2] = a2 ^ all ^ xtime(a2 ^ a3);
        s[4 * c + 3] = a3 ^ all ^ xtime(a3 ^ a0);
      }
    }
    for (let i = 0; i < 16; i++) s[i]! ^= rk[16 * round + i]!;
  }
  return s;
}

const R_GCM = 0xe1n << 120n;
/** Multiplication in GF(2¹²⁸) with GCM's bit order (SP 800-38D, algorithm 1). */
function gfMul(x: bigint, y: bigint): bigint {
  let z = 0n, v = y;
  for (let i = 127n; i >= 0n; i--) {
    if ((x >> i) & 1n) z ^= v;
    v = v & 1n ? (v >> 1n) ^ R_GCM : v >> 1n;
  }
  return z;
}

function ghash(h: bigint, aad: Bytes, ct: Bytes): bigint {
  let y = 0n;
  const absorb = (data: Bytes) => {
    for (let i = 0; i < data.length; i += 16) {
      const blk = new Uint8Array(16);
      blk.set(data.slice(i, i + 16));
      y = gfMul(y ^ beToBig(blk), h);
    }
  };
  absorb(aad);
  absorb(ct);
  const lens = concat(uint(aad.length * 8, 8), uint(ct.length * 8, 8));
  return gfMul(y ^ beToBig(lens), h);
}

function gctr(rk: Bytes, j0: Bytes, data: Bytes, firstCounter: number): Bytes {
  const out = new Uint8Array(data.length);
  const cb = j0.slice();
  const base = new DataView(j0.buffer, j0.byteOffset).getUint32(12);
  for (let i = 0, n = 0; i < data.length; i += 16, n++) {
    new DataView(cb.buffer).setUint32(12, (base + firstCounter + n) >>> 0);
    const ks = aesEncryptBlock(rk, cb);
    for (let j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j]! ^ ks[j]!;
  }
  return out;
}

export const GCM_TAG = 16;

/** AES-128-GCM encryption with a 12-byte nonce. Returns ciphertext ‖ 16-byte tag. */
export function aesGcmSeal(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes): Bytes {
  const rk = aesExpandKey(key);
  const h = beToBig(aesEncryptBlock(rk, new Uint8Array(16)));
  const j0 = concat(nonce, uint(1, 4));
  const ct = gctr(rk, j0, plaintext, 1);
  const s = ghash(h, aad, ct);
  const tag = xor(aesEncryptBlock(rk, j0), bigToBe(s, 16));
  return concat(ct, tag);
}

/** AES-128-GCM decryption. Returns the plaintext, or null if the tag does not match (the record is forged or damaged). */
export function aesGcmOpen(key: Bytes, nonce: Bytes, sealed: Bytes, aad: Bytes): Bytes | null {
  if (sealed.length < GCM_TAG) return null;
  const rk = aesExpandKey(key);
  const ct = sealed.slice(0, sealed.length - GCM_TAG), tag = sealed.slice(sealed.length - GCM_TAG);
  const h = beToBig(aesEncryptBlock(rk, new Uint8Array(16)));
  const j0 = concat(nonce, uint(1, 4));
  const want = xor(aesEncryptBlock(rk, j0), bigToBe(ghash(h, aad, ct), 16));
  if (!equal(want, tag)) return null;
  return gctr(rk, j0, ct, 1);
}

// ------------------------------------------------------------------ RSA-PSS verification

function mgf1(seed: Bytes, len: number): Bytes {
  const out = new Uint8Array(len);
  for (let c = 0, o = 0; o < len; c++, o += HASH_LEN) out.set(sha256(concat(seed, uint(c, 4))).slice(0, Math.min(HASH_LEN, len - o)), o);
  return out;
}

export interface PssCheck {
  ok: boolean;
  /** Which step of EMSA-PSS-VERIFY failed, if any. */
  why?: string;
}

/** RSASSA-PSS verification (RFC 8017, section 8.1.2) with SHA-256, MGF1-SHA-256 and a 32-byte salt. */
export function rsaPssVerify(modulus: Bytes, e: number, message: Bytes, sig: Bytes): PssCheck {
  const n = beToBig(modulus);
  const modBits = n.toString(2).length;
  const emBits = modBits - 1, emLen = Math.ceil(emBits / 8), sLen = HASH_LEN;
  const m = modPow(beToBig(sig), BigInt(e), n);
  const em = bigToBe(m, emLen);
  if (em[emLen - 1] !== 0xbc) return { ok: false, why: "the encoded message does not end in 0xbc" };
  const maskedDb = em.slice(0, emLen - HASH_LEN - 1), hh = em.slice(emLen - HASH_LEN - 1, emLen - 1);
  const top = 8 * emLen - emBits;
  if (maskedDb[0]! >> (8 - top)) return { ok: false, why: "the top bits are not zero" };
  const db = xor(maskedDb, mgf1(hh, maskedDb.length));
  db[0]! &= 0xff >> top;
  const ps = emLen - HASH_LEN - sLen - 2;
  for (let i = 0; i < ps; i++) if (db[i] !== 0) return { ok: false, why: "the padding is not zero" };
  if (db[ps] !== 1) return { ok: false, why: "the 0x01 separator is missing" };
  const salt = db.slice(db.length - sLen);
  const h2 = sha256(concat(new Uint8Array(8), sha256(message), salt));
  return equal(h2, hh) ? { ok: true } : { ok: false, why: "the hash does not match" };
}

// ------------------------------------------------------------------ toy RSA

/**
 * A toy RSA key with a 62-bit modulus (two fixed 31-bit primes per key). It shows the arithmetic of signing,
 * sig = h^d mod n, and checking, sig^e mod n = h. A 62-bit modulus factors in a moment; real certificates use
 * 2048-bit RSA or ECDSA P-256.
 */
export interface ToyKey {
  name: string;
  n: bigint;
  e: bigint;
  d: bigint;
}

function modInv(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return mod(s0, m);
}

export function toyKey(name: string, p: bigint, q: bigint, e = 65537n): ToyKey {
  return { name, n: p * q, e, d: modInv(e, (p - 1n) * (q - 1n)) };
}

/** The value a toy signature covers: the first 8 bytes of SHA-256, reduced modulo n. */
export const toyDigest = (msg: Bytes, n: bigint) => beToBig(sha256(msg).slice(0, 8)) % n;
export const toySign = (k: ToyKey, msg: Bytes) => modPow(toyDigest(msg, k.n), k.d, k.n);
export const toyVerify = (pub: { n: bigint; e: bigint }, msg: Bytes, sig: bigint) => modPow(sig, pub.e, pub.n) === toyDigest(msg, pub.n);
