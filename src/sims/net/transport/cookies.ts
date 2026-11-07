/**
 * SYN cookies, in the layout D. J. Bernstein described (cr.yp.to/syncookies.html). The server keeps no state for a
 * SYN. It puts the state into its initial sequence number instead:
 *
 *   bits 31..27  t mod 32, where t is a counter that goes up every 64 seconds
 *   bits 26..24  an index into a small table of MSS values (the client's MSS, rounded down)
 *   bits 23..0   a keyed hash of the client address and port, the server address and port, and t
 *
 * The client's ACK carries ISN + 1. The server subtracts 1, checks that t is recent and that the hash matches,
 * and rebuilds the connection with the MSS from the table. Other SYN options (window scale, SACK) are lost,
 * unless TCP timestamps carry them, as Linux does. The hash here is a simple mixing function, not a real MAC.
 */

/** The MSS values a cookie can encode: the four in Linux's IPv4 table (net/ipv4/syncookies.c). */
export const COOKIE_MSS = [536, 1300, 1440, 1460] as const;

/** The counter period in ms. */
export const COOKIE_PERIOD = 64_000;

/** A 32-bit mixing hash (the finalizer of MurmurHash3 over a few words). A model, not a cryptographic MAC. */
export function mix32(words: number[]): number {
  let h = 0x9747b28c;
  for (const w of words) {
    let k = Math.imul(w >>> 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const hash24 = (secret: number, src: number, sport: number, dst: number, dport: number, t: number) => mix32([secret, src, sport, dst, dport, t]) & 0xffffff;

/** The cookie (the server's ISN) for a SYN, and the MSS it encodes. */
export function makeCookie(now: number, secret: number, src: number, sport: number, dst: number, dport: number, clientMss: number) {
  const t = Math.floor(now / COOKIE_PERIOD);
  let idx = 0;
  for (let i = 0; i < COOKIE_MSS.length; i++) if (COOKIE_MSS[i]! <= clientMss) idx = i;
  const isn = (((t & 31) << 27) | (idx << 24) | hash24(secret, src, sport, dst, dport, t)) >>> 0;
  return { isn, mss: COOKIE_MSS[idx]!, t: t & 31, idx, hash: isn & 0xffffff };
}

/** Splits a cookie into its three fields. */
export const cookieFields = (isn: number) => ({ t: isn >>> 27, idx: (isn >>> 24) & 7, hash: isn & 0xffffff });

/**
 * Checks the ISN echoed by an ACK (ack − 1). Returns the MSS if the cookie is valid: t is now or one period ago,
 * the MSS index is in the table, and the hash matches. Otherwise undefined.
 */
export function checkCookie(isn: number, now: number, secret: number, src: number, sport: number, dst: number, dport: number): number | undefined {
  const { t, idx, hash } = cookieFields(isn);
  const cur = Math.floor(now / COOKIE_PERIOD);
  const age = (((cur - t) % 32) + 32) % 32;
  if (age > 1 || idx >= COOKIE_MSS.length) return undefined;
  return hash24(secret, src, sport, dst, dport, cur - age) === hash ? COOKIE_MSS[idx] : undefined;
}
