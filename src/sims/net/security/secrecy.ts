/**
 * Forward secrecy: "record now, decrypt later". A passive attacker records every connection to a server. Later, one
 * of the server's long-lived secrets leaks: the certificate's private key, or the key that encrypts session tickets
 * (the STEK). Which recorded connections can the attacker now decrypt?
 *
 * The key exchanges use small numbers so a learner can follow them, and they are labelled as toys:
 * - Diffie-Hellman in the group of integers modulo the prime p = 2³¹ − 1 with generator 7 (a primitive root).
 *   Real TLS uses X25519 (crypto.ts) or a 2048-bit or larger group; the algebra is the same.
 * - RSA key transport with a toy 62-bit RSA key (crypto.ts).
 *
 * The rules come from the protocols: TLS 1.2 RSA key transport encrypts the premaster secret to the certificate key;
 * (EC)DHE derives it from ephemeral keys that both sides delete; a TLS 1.2 session ticket carries the master secret
 * encrypted under the STEK (RFC 5077); a TLS 1.3 ticket carries a resumption PSK, and a psk_ke resumption uses only
 * that PSK, while psk_dhe_ke mixes in a fresh (EC)DHE secret (RFC 8446 section 4.2.9).
 */
import { modPow, toyKey, type ToyKey } from "./crypto";

export const DH_P = 2147483647n;
export const DH_G = 7n;

export interface DhExchange {
  a: bigint;
  b: bigint;
  /** A = g^a mod p, sent by the client. */
  A: bigint;
  /** B = g^b mod p, sent by the server. */
  B: bigint;
  /** g^(ab) mod p, which only the two ends can compute. */
  secret: bigint;
}

/** A toy Diffie-Hellman exchange with fixed private exponents. */
export function dhExchange(a: bigint, b: bigint): DhExchange {
  const A = modPow(DH_G, a, DH_P), B = modPow(DH_G, b, DH_P);
  const s1 = modPow(B, a, DH_P), s2 = modPow(A, b, DH_P);
  if (s1 !== s2) throw new Error("DH mismatch");
  return { a, b, A, B, secret: s1 };
}

/** The server's certificate key (toy RSA). */
export const SERVER_RSA: ToyKey = toyKey("server", 2147483629n, 2147483587n);

export type KxMode = "rsa12" | "ecdhe12-tickets" | "tls13-dhe" | "tls13-psk-ke";
export const KX_LABEL: Record<KxMode, string> = {
  rsa12: "TLS 1.2, RSA key transport",
  "ecdhe12-tickets": "TLS 1.2, ECDHE + session tickets",
  "tls13-dhe": "TLS 1.3, resumption with psk_dhe_ke",
  "tls13-psk-ke": "TLS 1.3, resumption with psk_ke",
};

export type Leak = "cert" | "stek";

export interface Session {
  day: number;
  /** A full handshake, or a resumption with the ticket from the session before it. */
  resumed: boolean;
  /** Index of the ticket key (STEK) that protects the ticket this session issued or used. */
  stek: number;
  dh?: DhExchange;
  /** RSA key transport: the premaster secret and its encryption under the certificate key. */
  rsa?: { premaster: bigint; encrypted: bigint };
  /** Can the attacker decrypt this recorded session after the leak? */
  exposed: boolean;
  why: string;
}

export interface SecrecyOpts {
  mode: KxMode;
  leak: Leak;
  /** The day the secret leaks (sessions run on days 1..days). */
  leakDay: number;
  /** The server makes a new ticket key every this many days (a model input; a STEK that never changes is 0). */
  stekDays: number;
  days?: number;
}

/** One connection per day; days 1, 4, 7, … are full handshakes, and the days between resume with a ticket. */
export function secrecyRun(o: SecrecyOpts): Session[] {
  const days = o.days ?? 12;
  const out: Session[] = [];
  const stekOf = (day: number) => (o.stekDays > 0 ? Math.floor((day - 1) / o.stekDays) : 0);
  const leakedStek = stekOf(o.leakDay);
  for (let day = 1; day <= days; day++) {
    const resumed = o.mode !== "rsa12" && (day - 1) % 3 !== 0;
    // The ticket a session uses was issued the day before; a full session issues a ticket under today's STEK.
    const stek = resumed ? stekOf(day - 1) : stekOf(day);
    const a = BigInt(1000 + 37 * day), b = BigInt(5000 + 91 * day);
    const s: Session = { day, resumed, stek, exposed: false, why: "" };
    const stekLeaked = o.leak === "stek" && stek === leakedStek;
    if (o.mode === "rsa12") {
      const premaster = BigInt(123456 + 7919 * day);
      s.rsa = { premaster, encrypted: modPow(premaster, SERVER_RSA.e, SERVER_RSA.n) };
      s.exposed = o.leak === "cert";
      s.why = s.exposed ? "the premaster secret was encrypted to the certificate key: decrypt it with the leaked key" : "the ticket key protects nothing here";
    } else {
      if (!(o.mode === "tls13-psk-ke" && resumed)) s.dh = dhExchange(a, b);
      if (o.leak === "cert") {
        s.why = "the certificate key only signs; the session key came from ephemeral DH values that were deleted";
      } else if (o.mode === "ecdhe12-tickets") {
        // The ticket holds this session's master secret (full session that issued it, or the resumed one).
        s.exposed = stekLeaked;
        s.why = s.exposed ? "the ticket carries the master secret, encrypted under the leaked ticket key" : "this ticket was encrypted under another ticket key";
      } else if (o.mode === "tls13-psk-ke") {
        s.exposed = stekLeaked && resumed;
        s.why = !resumed ? "a full handshake: keys from ephemeral DH; a ticket only gives the PSK for the next session" : s.exposed ? "the ticket gives the PSK, and psk_ke derives every key from the PSK alone" : "this ticket was encrypted under another ticket key";
      } else {
        s.why = resumed ? "the PSK is mixed with a fresh DH secret: the PSK alone is not enough" : "a full handshake: keys from ephemeral DH";
      }
    }
    out.push(s);
  }
  return out;
}
