/**
 * The QUIC short header (RFC 9000 section 17.3.1) and header protection (RFC 9001 section 5.4).
 *
 * Short header: Header Form (1) = 0, Fixed Bit (1) = 1, Spin Bit (1), Reserved Bits (2), Key Phase (1),
 * Packet Number Length (2, the length minus 1), Destination Connection ID (0..160 bits), Packet Number (8..32 bits).
 *
 * Header protection: the sender takes a 16-byte sample of the encrypted payload and computes a 5-byte mask from it
 * with the header protection key. It XORs mask[0] & 0x1f into the first byte (the low 5 bits: reserved bits, key
 * phase and packet number length) and the next bytes of the mask into the packet number. RFC 9001 makes the mask
 * with AES-ECB or ChaCha20. This model uses a toy keyed function in their place (it is not secure); what it
 * shows is which bits change and that the same packet number looks different in every packet.
 */
import { type Field, packFields } from "..";
import { mulberry32 } from "../../rng";

export interface ShortHeader {
  spin: 0 | 1;
  keyPhase: 0 | 1;
  /** Bytes of the packet number on the wire: 1 to 4. */
  pnLen: 1 | 2 | 3 | 4;
  dcid: Uint8Array;
  /** The truncated packet number that goes on the wire. */
  pn: number;
}

export function shortHeaderFields(h: ShortHeader): Field[] {
  return [
    { name: "Header Form", short: "H", bits: 1, value: 0, note: "0: short header" },
    { name: "Fixed Bit", short: "F", bits: 1, value: 1, note: "always 1 in QUIC v1" },
    { name: "Spin Bit", short: "S", bits: 1, value: h.spin, note: "optional; flips once per RTT, so an observer can measure the RTT" },
    { name: "Reserved Bits", short: "R", bits: 2, value: 0, note: "must be 0; protected" },
    { name: "Key Phase", short: "K", bits: 1, value: h.keyPhase, note: "which packet keys; protected" },
    { name: "Packet Number Length", short: "PL", bits: 2, value: h.pnLen - 1, note: "length minus 1; protected" },
    { name: "Destination Connection ID", short: "DCID", bits: h.dcid.length * 8, value: h.dcid, note: "chosen by the receiver; visible, so load balancers can route on it" },
    { name: "Packet Number", short: "PN", bits: h.pnLen * 8, value: h.pn, note: "protected" },
  ];
}

/** Toy stand-in for AES-ECB(hp_key, sample): 5 bytes that depend on the key and on all of the sample. */
export function toyMask(key: number, sample: Uint8Array): Uint8Array {
  let h = key >>> 0;
  for (const b of sample) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  const r = mulberry32(h);
  return Uint8Array.from({ length: 5 }, () => Math.floor(r() * 256));
}

/** A 16-byte sample of a payload, as RFC 9001 takes it (here: the first 16 bytes of `payload`). */
export const sampleOf = (payload: Uint8Array) => payload.slice(0, 16);

/** The header as it goes on the wire: the first byte and the packet number masked. */
export function protect(h: ShortHeader, mask: Uint8Array): Uint8Array {
  const b = packFields(shortHeaderFields(h));
  b[0] = b[0]! ^ (mask[0]! & 0x1f);
  const pnAt = 1 + h.dcid.length;
  for (let i = 0; i < h.pnLen; i++) b[pnAt + i] = b[pnAt + i]! ^ mask[1 + i]!;
  return b;
}

/** Removes protection: the receiver unmasks the first byte first, to learn the packet number length. */
export function unprotect(wire: Uint8Array, dcidLen: number, mask: Uint8Array): { header: Uint8Array; pnLen: number } {
  const b = wire.slice();
  b[0] = b[0]! ^ (mask[0]! & 0x1f);
  const pnLen = (b[0]! & 0x03) + 1;
  const pnAt = 1 + dcidLen;
  for (let i = 0; i < pnLen; i++) b[pnAt + i] = b[pnAt + i]! ^ mask[1 + i]!;
  return { header: b, pnLen };
}
