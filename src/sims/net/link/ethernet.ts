/**
 * Ethernet frames as bytes: MAC addresses, the header, padding to the minimum size, the FCS (a real CRC-32), the bytes
 * that a frame costs on the wire, and the CSMA/CD collision window that set the minimum frame size.
 *
 * Facts from IEEE 802.3 (not model results): preamble 7 bytes + SFD 1 byte, header 14 bytes (18 with an 802.1Q tag),
 * payload 46 to 1500 bytes, FCS 4 bytes, minimum frame 64 bytes, inter-frame gap 96 bit times (12 bytes), slot time
 * 512 bit times at 10 and 100 Mb/s.
 */
import { crc32, internetChecksum, type Field } from "../bytes";
import { mulberry32 } from "../../rng";

export const ETH = {
  preamble: 7,
  sfd: 1,
  header: 14,
  tag: 4,
  fcs: 4,
  minPayload: 46,
  maxPayload: 1500,
  minFrame: 64,
  maxFrame: 1518,
  ifg: 12,
  /** Slot time of 10 and 100 Mb/s Ethernet, in bit times. */
  slotBits: 512,
  /** Slot time of 1000BASE half duplex (carrier extension), in bit times. */
  gigSlotBits: 4096,
} as const;

export const ETHERTYPE = { ipv4: 0x0800, arp: 0x0806, ipv6: 0x86dd, vlan: 0x8100, qinq: 0x88a8, lldp: 0x88cc } as const;

export const ETHERTYPE_NAMES: Record<number, string> = {
  0x0800: "IPv4", 0x0806: "ARP", 0x86dd: "IPv6", 0x8100: "802.1Q tag", 0x88a8: "802.1ad tag", 0x88cc: "LLDP",
};

/** What the Type/Length field means: 1536 (0x0600) and above is an EtherType, 1500 and below is a length (802.3). */
export function typeOrLength(v: number): "type" | "length" | "invalid" {
  if (v >= 0x0600) return "type";
  if (v <= 1500) return "length";
  return "invalid";
}

// ---------------------------------------------------------------- MAC addresses

/** "02:00:5e:10:00:01" or "02-00-5e-10-00-01" → 6 bytes. Throws on bad text. */
export function parseMac(s: string): Uint8Array {
  const p = s.trim().split(/[:-]/);
  if (p.length !== 6 || p.some((x) => !/^[0-9a-fA-F]{1,2}$/.test(x))) throw new Error(`bad MAC address: ${s}`);
  return Uint8Array.from(p.map((x) => parseInt(x, 16)));
}

export interface MacInfo {
  /** I/G bit, the least significant bit of the first byte: 1 = group (multicast or broadcast). */
  group: boolean;
  /** U/L bit, the next bit: 1 = locally administered (set by software, not the maker). */
  local: boolean;
  broadcast: boolean;
  /** The first 3 bytes. For a universal address, the maker's Organizationally Unique Identifier. */
  oui: string;
  kind: "broadcast" | "IPv4 multicast" | "IPv6 multicast" | "STP bridge group" | "multicast" | "unicast";
}

export function macInfo(mac: Uint8Array): MacInfo {
  const group = (mac[0]! & 1) === 1;
  const local = (mac[0]! & 2) === 2;
  const broadcast = mac.every((b) => b === 0xff);
  const oui = [...mac.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(":");
  const kind: MacInfo["kind"] = broadcast ? "broadcast"
    : oui === "01:00:5e" && (mac[3]! & 0x80) === 0 ? "IPv4 multicast"
    : mac[0] === 0x33 && mac[1] === 0x33 ? "IPv6 multicast"
    : oui === "01:80:c2" && mac[3] === 0 && mac[4] === 0 && mac[5] === 0 ? "STP bridge group"
    : group ? "multicast" : "unicast";
  return { group, local, broadcast, oui, kind };
}

/** IPv4 multicast group → MAC: 01:00:5e and the low 23 bits of the group (RFC 1112). 32 groups share each MAC. */
export function ipv4MulticastMac(group: number): Uint8Array {
  return Uint8Array.from([0x01, 0x00, 0x5e, (group >>> 16) & 0x7f, (group >>> 8) & 0xff, group & 0xff]);
}

/** IPv6 multicast address (16 bytes) → MAC: 33:33 and the low 32 bits (RFC 2464). */
export function ipv6MulticastMac(addr: Uint8Array): Uint8Array {
  return Uint8Array.from([0x33, 0x33, addr[12]!, addr[13]!, addr[14]!, addr[15]!]);
}

// ---------------------------------------------------------------- frames

export interface VlanTag {
  /** Priority Code Point, 0..7 (802.1p class of service). */
  pcp: number;
  /** Drop Eligible Indicator. */
  dei: number;
  /** VLAN id, 1..4094. */
  vid: number;
}

export interface EthFrame {
  dst: Uint8Array;
  src: Uint8Array;
  vlan?: VlanTag;
  etherType: number;
  payload: Uint8Array;
}

/** The header as a field list (for HeaderDiagram and packFields): 14 bytes, or 18 with a tag. */
export function ethHeaderFields(f: EthFrame): Field[] {
  const fields: Field[] = [
    { name: "Destination MAC", short: "Dst", bits: 48, value: f.dst, note: "who should take the frame; ff:ff:ff:ff:ff:ff is everyone" },
    { name: "Source MAC", short: "Src", bits: 48, value: f.src, note: "the sending interface; switches learn from it" },
  ];
  if (f.vlan) {
    fields.push(
      { name: "TPID", bits: 16, value: ETHERTYPE.vlan, note: "0x8100: an 802.1Q tag follows" },
      { name: "PCP", bits: 3, value: f.vlan.pcp, note: "priority 0..7" },
      { name: "DEI", bits: 1, value: f.vlan.dei, note: "drop eligible" },
      { name: "VLAN ID", short: "VID", bits: 12, value: f.vlan.vid, note: "which virtual LAN, 1..4094" },
    );
  }
  fields.push({ name: "EtherType", short: "Type", bits: 16, value: f.etherType, note: "what the payload is: 0x0800 IPv4, 0x0806 ARP, 0x86DD IPv6" });
  return fields;
}

/** Payload bytes needed so that header + payload is at least 60 bytes (64 with the FCS). */
export function padBytes(payloadLen: number, tagged = false): number {
  const hdr = ETH.header + (tagged ? ETH.tag : 0);
  return Math.max(0, ETH.minFrame - ETH.fcs - hdr - payloadLen);
}

export interface Encoded {
  /** Destination MAC through FCS: what the CRC covers, plus the CRC. No preamble, no SFD. */
  bytes: Uint8Array;
  headerLen: number;
  payloadLen: number;
  pad: number;
  fcs: number;
}

/**
 * Builds the frame bytes. The FCS is CRC-32 over destination MAC .. last pad byte, appended least significant byte
 * first, as Ethernet sends it.
 */
export function encodeFrame(f: EthFrame): Encoded {
  const hdr = ETH.header + (f.vlan ? ETH.tag : 0);
  const pad = padBytes(f.payload.length, !!f.vlan);
  const body = new Uint8Array(hdr + f.payload.length + pad);
  body.set(f.dst, 0);
  body.set(f.src, 6);
  let o = 12;
  if (f.vlan) {
    body[o++] = 0x81;
    body[o++] = 0x00;
    const tci = ((f.vlan.pcp & 7) << 13) | ((f.vlan.dei & 1) << 12) | (f.vlan.vid & 0xfff);
    body[o++] = tci >> 8;
    body[o++] = tci & 0xff;
  }
  body[o++] = (f.etherType >> 8) & 0xff;
  body[o++] = f.etherType & 0xff;
  body.set(f.payload, o);
  const fcs = crc32(body);
  const bytes = new Uint8Array(body.length + 4);
  bytes.set(body, 0);
  for (let i = 0; i < 4; i++) bytes[body.length + i] = (fcs >>> (8 * i)) & 0xff;
  return { bytes, headerLen: hdr, payloadLen: f.payload.length, pad, fcs };
}

/** The FCS field as the receiver reads it (least significant byte first). */
export const readFcs = (bytes: Uint8Array) => (bytes[bytes.length - 4]! | (bytes[bytes.length - 3]! << 8) | (bytes[bytes.length - 2]! << 16) | (bytes[bytes.length - 1]! << 24)) >>> 0;

/**
 * The CRC of a correct frame, FCS included, is always this constant (the "residue" or "magic number"). Hardware
 * checks a frame this way: it runs the CRC over every byte and compares with one value.
 */
export const CRC32_RESIDUE = 0x2144df1c;

export interface FcsCheck {
  computed: number;
  received: number;
  ok: boolean;
  /** CRC over the whole frame, FCS included. Equals CRC32_RESIDUE exactly when ok. */
  residue: number;
}

export function checkFcs(bytes: Uint8Array): FcsCheck {
  const computed = crc32(bytes.subarray(0, bytes.length - 4));
  const received = readFcs(bytes);
  return { computed, received, ok: computed === received, residue: crc32(bytes) };
}

export interface Decoded {
  dst: Uint8Array;
  src: Uint8Array;
  vlan?: VlanTag;
  etherType: number;
  payload: Uint8Array;
}

/** Parses destination MAC .. FCS. The payload still holds any padding: only the upper layer knows its real length. */
export function decodeFrame(bytes: Uint8Array): Decoded {
  const dst = bytes.slice(0, 6), src = bytes.slice(6, 12);
  let o = 12;
  let type = (bytes[o]! << 8) | bytes[o + 1]!;
  let vlan: VlanTag | undefined;
  if (type === ETHERTYPE.vlan) {
    const tci = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    vlan = { pcp: tci >> 13, dei: (tci >> 12) & 1, vid: tci & 0xfff };
    o += 4;
    type = (bytes[o]! << 8) | bytes[o + 1]!;
  }
  return { dst, src, vlan, etherType: type, payload: bytes.slice(o + 2, bytes.length - 4) };
}

/** Flips bit `bit` of the frame (bit 0 = most significant bit of byte 0). Returns a copy. */
export function flipBit(bytes: Uint8Array, bit: number): Uint8Array {
  const c = bytes.slice();
  c[bit >> 3]! ^= 0x80 >> (bit & 7);
  return c;
}

// ---------------------------------------------------------------- CRC-32 against the Internet checksum

export type ErrorKind = "one bit" | "two bits" | "burst ≤ 32" | "swap two 16-bit words" | "random bytes";
export const ERROR_KINDS: ErrorKind[] = ["one bit", "two bits", "burst ≤ 32", "swap two 16-bit words", "random bytes"];

/**
 * Applies one random error of a kind to `bytes` (in place) over the bit range [0, nbits). Returns false if the error
 * left the bytes the same (for example a swap of two equal words), so the caller does not count it.
 */
export function applyError(bytes: Uint8Array, kind: ErrorKind, rnd: () => number, nbits = bytes.length * 8): boolean {
  const before = bytes.slice();
  const bit = () => Math.floor(rnd() * nbits);
  const flip = (b: number) => (bytes[b >> 3]! ^= 0x80 >> (b & 7));
  switch (kind) {
    case "one bit":
      flip(bit());
      break;
    case "two bits": {
      const a = bit();
      let b = bit();
      while (b === a) b = bit();
      flip(a);
      flip(b);
      break;
    }
    case "burst ≤ 32": {
      // A burst of length L: the first and last bits flip, the bits between are random.
      const L = 2 + Math.floor(rnd() * 31);
      const s = Math.floor(rnd() * (nbits - L + 1));
      flip(s);
      flip(s + L - 1);
      for (let k = s + 1; k < s + L - 1; k++) if (rnd() < 0.5) flip(k);
      break;
    }
    case "swap two 16-bit words": {
      const words = Math.floor(nbits / 16);
      const a = Math.floor(rnd() * words);
      let b = Math.floor(rnd() * words);
      while (b === a) b = Math.floor(rnd() * words);
      const t0 = bytes[2 * a]!, t1 = bytes[2 * a + 1]!;
      bytes[2 * a] = bytes[2 * b]!;
      bytes[2 * a + 1] = bytes[2 * b + 1]!;
      bytes[2 * b] = t0;
      bytes[2 * b + 1] = t1;
      break;
    }
    case "random bytes": {
      const n = Math.floor(nbits / 8);
      const s = Math.floor(rnd() * (n - 8));
      for (let k = s; k < s + 8; k++) bytes[k] = Math.floor(rnd() * 256);
      break;
    }
  }
  return bytes.some((b, i) => b !== before[i]);
}

export interface DetectResult {
  kind: ErrorKind;
  trials: number;
  crcMissed: number;
  sumMissed: number;
}

/**
 * Corrupts `trials` random 64-byte frames with one error of a kind, then asks each detector: CRC-32 (the FCS) and the
 * 16-bit Internet checksum (RFC 1071) over the same bytes. A miss is a changed frame that the detector accepts.
 */
export function detectionTrial(kind: ErrorKind, trials: number, seed = 1, frameLen = 60): DetectResult {
  const rnd = mulberry32(seed);
  let crcMissed = 0, sumMissed = 0, n = 0;
  while (n < trials) {
    const data = new Uint8Array(frameLen);
    for (let i = 0; i < frameLen; i++) data[i] = Math.floor(rnd() * 256);
    const crc = crc32(data), sum = internetChecksum(data);
    if (!applyError(data, kind, rnd)) continue;
    n++;
    if (crc32(data) === crc) crcMissed++;
    if (internetChecksum(data) === sum) sumMissed++;
  }
  return { kind, trials, crcMissed, sumMissed };
}

// ---------------------------------------------------------------- the wire

export interface WireCost {
  preamble: number;
  header: number;
  payload: number;
  pad: number;
  fcs: number;
  ifg: number;
  total: number;
  /** payload / total. */
  efficiency: number;
}

/** Bytes that one frame takes on the wire, gap included. */
export function wireCost(payload: number, tagged = false): WireCost {
  const header = ETH.header + (tagged ? ETH.tag : 0);
  const pad = padBytes(payload, tagged);
  const preamble = ETH.preamble + ETH.sfd;
  const total = preamble + header + payload + pad + ETH.fcs + ETH.ifg;
  return { preamble, header, payload, pad, fcs: ETH.fcs, ifg: ETH.ifg, total, efficiency: payload / total };
}

/** Frames per second at line rate. */
export const framesPerSecond = (rate: number, payload: number, tagged = false) => rate / (wireCost(payload, tagged).total * 8);

/** CPU cycles available per frame at line rate, for a core at `ghz` GHz (a model input). */
export const cyclesPerFrame = (rate: number, payload: number, ghz: number) => (ghz * 1e9) / framesPerSecond(rate, payload);

/** Payload bits per second at line rate. */
export const goodput = (rate: number, payload: number, tagged = false) => rate * wireCost(payload, tagged).efficiency;

// ---------------------------------------------------------------- CSMA/CD

/**
 * Model input: signal speed in coaxial cable, about 0.77 c. Twisted pair is near 0.6–0.7 c. The 802.3 delay budget
 * also counts repeaters and transceivers, so the real slot time (512 bits) is about twice the cable-only figure.
 */
export const COAX_SPEED = 0.77 * 299_792_458;

/** The largest 10 Mb/s collision domain of 802.3 (10BASE5 with four repeaters), in meters. */
export const STANDARD_DOMAIN_M = 2500;

/** The same 512-bit slot at another rate: the domain shrinks in proportion to the bit time. */
export const domainAtRate = (rate: number) => STANDARD_DOMAIN_M * (10e6 / rate);

export interface CollisionWindow {
  /** One-way propagation delay in µs. */
  propUs: number;
  /** Worst-case time for news of a collision to come back: 2 × propagation, in bit times. */
  roundTripBits: number;
  frameBits: number;
  /** The sender is still sending when the collision reaches it. */
  detected: boolean;
  /** The longest cable on which this frame size still detects every collision. */
  maxLengthM: number;
  /** The smallest frame that detects every collision on this cable, in bytes. */
  minFrameBytes: number;
}

/**
 * A sends a frame of `frameBytes` on a bus of `lengthM` meters. B, at the far end, starts to send just before A's
 * first bit arrives. The collision reaches A after 2 × the one-way delay. A knows about the collision only if it is
 * still sending then: once a frame is finished, the sender believes it went out fine.
 */
export function collisionWindow(rate: number, lengthM: number, frameBytes: number, speed = COAX_SPEED): CollisionWindow {
  const prop = lengthM / speed;
  const roundTripBits = 2 * prop * rate;
  const frameBits = frameBytes * 8;
  return {
    propUs: prop * 1e6,
    roundTripBits,
    frameBits,
    detected: frameBits >= roundTripBits,
    maxLengthM: (frameBits / rate / 2) * speed,
    minFrameBytes: Math.ceil(roundTripBits / 8),
  };
}
