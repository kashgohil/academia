/**
 * The DNS message format (RFC 1035 section 4) with name compression, EDNS(0) (RFC 6891) and the HTTPS record
 * (RFC 9460). `encodeMessage` writes real wire bytes and records a span for each part, so a demo can colour them;
 * `decodeMessage` reads them back and follows compression pointers.
 *
 * - Header: 12 bytes. ID (16 bits), QR, Opcode (4), AA, TC, RD, RA, Z, AD, CD (RFC 4035 took two of the three
 *   bits RFC 1035 reserved as Z), RCODE (4), then four 16-bit counts.
 * - A name is a list of labels, each a length byte (1..63) and the label bytes, ended by a zero byte.
 *   Compression replaces the end of a name by a 2-byte pointer: the top two bits 11, then a 14-bit offset of an
 *   earlier copy of that suffix in the message.
 * - A resource record: owner name, TYPE (16), CLASS (16), TTL (32), RDLENGTH (16), RDATA.
 *   Names inside RDATA may be compressed for NS, CNAME, SOA and MX (the RFC 1035 types). The TargetName of an
 *   HTTPS record is never compressed (RFC 9460 section 2.2).
 */
import { parseIpv4, formatIpv4, type Field } from "../bytes";

export const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, OPT: 41, DS: 43, RRSIG: 46, DNSKEY: 48, HTTPS: 65 } as const;
export type RRType = keyof typeof TYPE;
const TYPE_NAME = new Map<number, RRType>(Object.entries(TYPE).map(([k, v]) => [v, k as RRType]));

export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;
export type RcodeName = keyof typeof RCODE;

/** The largest DNS message over UDP without EDNS (RFC 1035 section 4.2.1). */
export const UDP_LIMIT = 512;
/** The EDNS buffer size of DNS Flag Day 2020: a 1280-byte IPv6 minimum MTU minus 48 bytes of IPv6 and UDP headers. */
export const EDNS_FLAG_DAY = 1232;
export const HEADER_BYTES = 12;

export interface DnsFlags {
  qr: boolean; opcode: number; aa: boolean; tc: boolean; rd: boolean; ra: boolean; ad: boolean; cd: boolean; rcode: number;
}

export type RData =
  | { t: "A"; addr: string }
  | { t: "NS"; host: string }
  | { t: "CNAME"; host: string }
  | { t: "MX"; pref: number; host: string }
  | { t: "TXT"; text: string }
  | { t: "SOA"; mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number }
  | { t: "HTTPS"; priority: number; target: string; alpn?: string[]; port?: number; ipv4hint?: string[] }
  /** EDNS(0) pseudo-record: CLASS holds the UDP payload size and TTL holds the flags (DO bit). */
  | { t: "OPT"; udpSize: number; do?: boolean };

export interface DnsRecord { name: string; ttl: number; data: RData }
export interface DnsQuestion { name: string; type: RRType }

export interface DnsMessage {
  id: number;
  flags: DnsFlags;
  question: DnsQuestion[];
  answer: DnsRecord[];
  authority: DnsRecord[];
  additional: DnsRecord[];
}

export const NO_FLAGS: DnsFlags = { qr: false, opcode: 0, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: 0 };

export function query(id: number, name: string, type: RRType, o: { rd?: boolean; edns?: number } = {}): DnsMessage {
  return {
    id, flags: { ...NO_FLAGS, rd: o.rd ?? true }, question: [{ name, type }], answer: [], authority: [],
    additional: o.edns ? [{ name: "", ttl: 0, data: { t: "OPT", udpSize: o.edns } }] : [],
  };
}

/** The header fields for HeaderDiagram. */
export function dnsHeaderFields(m?: Pick<DnsMessage, "id" | "flags"> & Partial<DnsMessage>): Field[] {
  const f = m?.flags ?? NO_FLAGS;
  const b = (x: boolean) => (x ? 1 : 0);
  return [
    { name: "ID", bits: 16, value: m?.id, note: "copied into the reply; matches a reply to its query" },
    { name: "QR", bits: 1, value: b(f.qr), note: "0 query, 1 response" },
    { name: "Opcode", bits: 4, value: f.opcode, short: "Op", note: "0 is a standard query" },
    { name: "AA", bits: 1, value: b(f.aa), note: "authoritative answer" },
    { name: "TC", bits: 1, value: b(f.tc), note: "truncated: retry over TCP" },
    { name: "RD", bits: 1, value: b(f.rd), note: "recursion desired" },
    { name: "RA", bits: 1, value: b(f.ra), note: "recursion available" },
    { name: "Z", bits: 1, value: 0, note: "reserved, zero" },
    { name: "AD", bits: 1, value: b(f.ad), note: "authentic data: DNSSEC validated (RFC 4035)" },
    { name: "CD", bits: 1, value: b(f.cd), note: "checking disabled (RFC 4035)" },
    { name: "RCODE", bits: 4, value: f.rcode, short: "Rcode", note: "0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN" },
    { name: "QDCOUNT", bits: 16, value: m?.question?.length ?? 1, note: "questions" },
    { name: "ANCOUNT", bits: 16, value: m?.answer?.length ?? 0, note: "answer records" },
    { name: "NSCOUNT", bits: 16, value: m?.authority?.length ?? 0, note: "authority records" },
    { name: "ARCOUNT", bits: 16, value: m?.additional?.length ?? 0, note: "additional records (glue, OPT)" },
  ];
}

// ------------------------------------------------------------------------------------------------ encoding

export type SpanKind = "header" | "question" | "answer" | "authority" | "additional";
export interface Span { start: number; end: number; kind: SpanKind; label: string }
export interface Pointer { at: number; to: number; suffix: string }

export interface Encoded {
  bytes: Uint8Array;
  spans: Span[];
  pointers: Pointer[];
  /** Bytes saved by compression, against the same message without it. */
  saved: number;
}

const labelsOf = (name: string) => (name === "" || name === "." ? [] : name.replace(/\.$/, "").split("."));

class Writer {
  out: number[] = [];
  names = new Map<string, number>();
  pointers: Pointer[] = [];
  constructor(readonly compress: boolean) {}
  u8(x: number) { this.out.push(x & 0xff); }
  u16(x: number) { this.out.push((x >> 8) & 0xff, x & 0xff); }
  u32(x: number) { this.u16(Math.floor(x / 65536) & 0xffff); this.u16(x & 0xffff); }
  bytes(b: Iterable<number>) { for (const x of b) this.out.push(x); }
  name(name: string, compressible = true) {
    const labels = labelsOf(name);
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join(".").toLowerCase();
      const at = this.compress && compressible ? this.names.get(suffix) : undefined;
      if (at !== undefined) {
        this.pointers.push({ at: this.out.length, to: at, suffix });
        this.u16(0xc000 | at);
        return;
      }
      if (this.out.length < 0x4000 && compressible) this.names.set(suffix, this.out.length);
      const b = new TextEncoder().encode(labels[i]!);
      if (b.length < 1 || b.length > 63) throw new Error(`bad label "${labels[i]}"`);
      this.u8(b.length);
      this.bytes(b);
    }
    this.u8(0);
  }
}

function typeOf(d: RData): number {
  return TYPE[d.t];
}

function writeRecord(w: Writer, r: DnsRecord) {
  const d = r.data;
  w.name(r.name);
  w.u16(typeOf(d));
  if (d.t === "OPT") {
    w.u16(d.udpSize);
    w.u32(d.do ? 0x8000 : 0);
  } else {
    w.u16(1); // class IN
    w.u32(r.ttl);
  }
  const lenAt = w.out.length;
  w.u16(0);
  const start = w.out.length;
  switch (d.t) {
    case "A":
      w.u32(parseIpv4(d.addr));
      break;
    case "NS":
    case "CNAME":
      w.name(d.host);
      break;
    case "MX":
      w.u16(d.pref);
      w.name(d.host);
      break;
    case "TXT": {
      const b = new TextEncoder().encode(d.text);
      for (let i = 0; i < b.length || i === 0; i += 255) {
        const part = b.subarray(i, i + 255);
        w.u8(part.length);
        w.bytes(part);
      }
      break;
    }
    case "SOA":
      w.name(d.mname);
      w.name(d.rname);
      for (const x of [d.serial, d.refresh, d.retry, d.expire, d.minimum]) w.u32(x);
      break;
    case "HTTPS": {
      w.u16(d.priority);
      w.name(d.target, false);
      if (d.alpn) {
        w.u16(1);
        const ids = d.alpn.map((a) => new TextEncoder().encode(a));
        w.u16(ids.reduce((a, b) => a + 1 + b.length, 0));
        for (const b of ids) {
          w.u8(b.length);
          w.bytes(b);
        }
      }
      if (d.port !== undefined) {
        w.u16(3);
        w.u16(2);
        w.u16(d.port);
      }
      if (d.ipv4hint) {
        w.u16(4);
        w.u16(4 * d.ipv4hint.length);
        for (const a of d.ipv4hint) w.u32(parseIpv4(a));
      }
      break;
    }
    case "OPT":
      break;
  }
  const len = w.out.length - start;
  w.out[lenAt] = len >> 8;
  w.out[lenAt + 1] = len & 0xff;
}

function encodeWith(m: DnsMessage, compress: boolean) {
  const w = new Writer(compress);
  const spans: Span[] = [];
  const f = m.flags;
  w.u16(m.id);
  w.u8((f.qr ? 0x80 : 0) | ((f.opcode & 15) << 3) | (f.aa ? 4 : 0) | (f.tc ? 2 : 0) | (f.rd ? 1 : 0));
  w.u8((f.ra ? 0x80 : 0) | (f.ad ? 0x20 : 0) | (f.cd ? 0x10 : 0) | (f.rcode & 15));
  for (const n of [m.question.length, m.answer.length, m.authority.length, m.additional.length]) w.u16(n);
  spans.push({ start: 0, end: 12, kind: "header", label: "header" });
  for (const q of m.question) {
    const s = w.out.length;
    w.name(q.name);
    w.u16(TYPE[q.type]);
    w.u16(1);
    spans.push({ start: s, end: w.out.length, kind: "question", label: `${q.name} ${q.type}` });
  }
  const sec = (rs: DnsRecord[], kind: SpanKind) => {
    for (const r of rs) {
      const s = w.out.length;
      writeRecord(w, r);
      spans.push({ start: s, end: w.out.length, kind, label: rrText(r) });
    }
  };
  sec(m.answer, "answer");
  sec(m.authority, "authority");
  sec(m.additional, "additional");
  return { bytes: new Uint8Array(w.out), spans, pointers: w.pointers };
}

export function encodeMessage(m: DnsMessage, compress = true): Encoded {
  const e = encodeWith(m, compress);
  const plain = compress ? encodeWith(m, false).bytes.length : e.bytes.length;
  return { ...e, saved: plain - e.bytes.length };
}

export const messageSize = (m: DnsMessage, compress = true) => encodeWith(m, compress).bytes.length;

// ------------------------------------------------------------------------------------------------ decoding

export class DnsFormatError extends Error {}

function readName(b: Uint8Array, pos: number): [string, number] {
  const labels: string[] = [];
  let end = -1, jumps = 0;
  for (;;) {
    if (pos >= b.length) throw new DnsFormatError("name runs past the end");
    const len = b[pos]!;
    if ((len & 0xc0) === 0xc0) {
      if (++jumps > 64) throw new DnsFormatError("compression loop");
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | b[pos + 1]!;
      continue;
    }
    if (len === 0) {
      if (end < 0) end = pos + 1;
      return [labels.join("."), end];
    }
    labels.push(new TextDecoder().decode(b.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
  }
}

export function decodeMessage(b: Uint8Array): DnsMessage {
  if (b.length < 12) throw new DnsFormatError("shorter than a header");
  const u16 = (p: number) => (b[p]! << 8) | b[p + 1]!;
  const u32 = (p: number) => u16(p) * 65536 + u16(p + 2);
  const f1 = b[2]!, f2 = b[3]!;
  const flags: DnsFlags = { qr: !!(f1 & 0x80), opcode: (f1 >> 3) & 15, aa: !!(f1 & 4), tc: !!(f1 & 2), rd: !!(f1 & 1), ra: !!(f2 & 0x80), ad: !!(f2 & 0x20), cd: !!(f2 & 0x10), rcode: f2 & 15 };
  const counts = [u16(4), u16(6), u16(8), u16(10)];
  let pos = 12;
  const question: DnsQuestion[] = [];
  for (let i = 0; i < counts[0]!; i++) {
    const [name, p] = readName(b, pos);
    question.push({ name, type: TYPE_NAME.get(u16(p)) ?? "A" });
    pos = p + 4;
  }
  const rr = (): DnsRecord => {
    const [name, p] = readName(b, pos);
    const type = u16(p), cls = u16(p + 2), ttl = u32(p + 4), len = u16(p + 8);
    const s = p + 10;
    pos = s + len;
    if (pos > b.length) throw new DnsFormatError("record runs past the end");
    const t = TYPE_NAME.get(type);
    let data: RData;
    switch (t) {
      case "A": data = { t, addr: formatIpv4(u32(s)) }; break;
      case "NS": case "CNAME": data = { t, host: readName(b, s)[0] }; break;
      case "MX": data = { t, pref: u16(s), host: readName(b, s + 2)[0] }; break;
      case "TXT": data = { t, text: new TextDecoder().decode(b.subarray(s + 1, s + 1 + b[s]!)) }; break;
      case "SOA": {
        const [mname, a] = readName(b, s);
        const [rname, c] = readName(b, a);
        data = { t, mname, rname, serial: u32(c), refresh: u32(c + 4), retry: u32(c + 8), expire: u32(c + 12), minimum: u32(c + 16) };
        break;
      }
      case "OPT": data = { t, udpSize: cls, do: !!(ttl & 0x8000) }; break;
      case "HTTPS": {
        const [target, q] = readName(b, s + 2);
        const d: RData = { t, priority: u16(s), target };
        let k = q;
        while (k < s + len) {
          const key = u16(k), l = u16(k + 2), v = k + 4;
          if (key === 1) {
            d.alpn = [];
            for (let j = v; j < v + l; j += 1 + b[j]!) d.alpn.push(new TextDecoder().decode(b.subarray(j + 1, j + 1 + b[j]!)));
          } else if (key === 3) d.port = u16(v);
          else if (key === 4) d.ipv4hint = Array.from({ length: l / 4 }, (_, j) => formatIpv4(u32(v + 4 * j)));
          k = v + l;
        }
        data = d;
        break;
      }
      default: throw new DnsFormatError(`type ${type} not modelled`);
    }
    return { name, ttl: t === "OPT" ? 0 : ttl, data };
  };
  const answer = Array.from({ length: counts[1]! }, rr);
  const authority = Array.from({ length: counts[2]! }, rr);
  const additional = Array.from({ length: counts[3]! }, rr);
  return { id: u16(0), flags, question, answer, authority, additional };
}

// ------------------------------------------------------------------------------------------------ text

export function rdataText(d: RData): string {
  switch (d.t) {
    case "A": return d.addr;
    case "NS": case "CNAME": return `${d.host}.`;
    case "MX": return `${d.pref} ${d.host}.`;
    case "TXT": return `"${d.text}"`;
    case "SOA": return `${d.mname}. ${d.rname}. ${d.serial} ${d.refresh} ${d.retry} ${d.expire} ${d.minimum}`;
    case "HTTPS": {
      const p = [String(d.priority), d.target ? `${d.target}.` : "."];
      if (d.alpn) p.push(`alpn=${d.alpn.join(",")}`);
      if (d.port !== undefined) p.push(`port=${d.port}`);
      if (d.ipv4hint) p.push(`ipv4hint=${d.ipv4hint.join(",")}`);
      return p.join(" ");
    }
    case "OPT": return `udp=${d.udpSize}${d.do ? " do" : ""}`;
  }
}

/** Zone-file style text: "www.example.com. 300 IN A 192.0.2.10". */
export const rrText = (r: DnsRecord) => (r.data.t === "OPT" ? `OPT ${rdataText(r.data)}` : `${r.name}. ${r.ttl} IN ${r.data.t} ${rdataText(r.data)}`);
