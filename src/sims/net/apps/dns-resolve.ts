/**
 * DNS resolution on PacketNet: a stub, a recursive resolver with a cache, and authoritative servers for the root,
 * for com and net, for example.com and for a CDN's zone (edgecdn.net).
 *
 * - The resolver follows RFC 1034 section 5.3.3: answer from the cache if it can; otherwise ask the closest
 *   servers it knows (root hints at first), follow referrals and their glue, and restart at the target of a CNAME.
 * - The cache keeps each record set until its TTL runs out. NXDOMAIN and NODATA answers are cached too (RFC 2308),
 *   for min(SOA TTL, SOA MINIMUM).
 * - Queries go over UDP. A reply larger than the client's limit (512 bytes, or the EDNS(0) buffer size) comes back
 *   with TC set and no records, and the resolver asks again over TCP (RFC 7766), with the reference TCP of the
 *   transport module. The two-byte length prefix of DNS over TCP is counted.
 * - A lost UDP query is sent again after `retryMs`.
 *
 * The resolver logic is a generator: it yields "send this query to that server" and gets the reply back, so the
 * code reads like the algorithm. Model inputs: the link delays (DNS_LINKS) and the zone data (zones()).
 */
import { PacketNet, type Packet } from "../packet";
import { TcpStack, type TcpConn } from "../transport";
import { RCODE, UDP_LIMIT, messageSize, query, type DnsMessage, type DnsRecord, type RRType } from "./dns-msg";

export const STUB = 0, RESOLVER = 1, ROOT = 2, TLD = 3, AUTH = 4, CDN = 5;
export const DNS_NODES = ["stub", "resolver", "root", "com/net", "example", "edgecdn"];

/** One-way delays in ms from the resolver (model inputs): a nearby root instance, a far authoritative server. */
export const DNS_LINKS: Record<number, number> = { [STUB]: 4, [ROOT]: 6, [TLD]: 12, [AUTH]: 40, [CDN]: 8 };

/** UDP + IPv4 headers around a DNS message. */
export const UDP_IP_BYTES = 28;

const ADDR: Record<string, number> = { "198.41.0.4": ROOT, "192.5.6.30": TLD, "192.0.2.53": AUTH, "198.51.100.53": CDN };

export interface Delegation { zone: string; ns: string[]; glue: { name: string; addr: string }[] }
export interface Zone { origin: string; soa: DnsRecord; records: DnsRecord[]; cuts: Delegation[] }

const soa = (origin: string, mname: string, ttl: number, minimum: number): DnsRecord => ({
  name: origin, ttl, data: { t: "SOA", mname, rname: `hostmaster.${origin || "root"}`, serial: 2026110701, refresh: 7200, retry: 3600, expire: 1209600, minimum },
});

/** The zone data. `glue: false` puts example.com's name server in another zone (dnshost.net) with no glue. */
export function zones(o: { glue: boolean }): Record<number, Zone[]> {
  const ns1 = o.glue ? "ns1.example.com" : "ns1.dnshost.net";
  const big: DnsRecord[] = Array.from({ length: 40 }, (_, i) => ({ name: "big.example.com", ttl: 300, data: { t: "A", addr: `203.0.113.${i + 1}` } }));
  return {
    [ROOT]: [{
      origin: "", soa: soa("", "a.root-servers.net", 86400, 86400), records: [],
      cuts: ["com", "net"].map((z) => ({ zone: z, ns: ["a.gtld-servers.net"], glue: [{ name: "a.gtld-servers.net", addr: "192.5.6.30" }] })),
    }],
    [TLD]: [
      {
        origin: "com", soa: soa("com", "a.gtld-servers.net", 900, 900), records: [],
        cuts: [{ zone: "example.com", ns: [ns1], glue: o.glue ? [{ name: ns1, addr: "192.0.2.53" }] : [] }],
      },
      {
        origin: "net", soa: soa("net", "a.gtld-servers.net", 900, 900), records: [],
        cuts: [
          { zone: "edgecdn.net", ns: ["ns1.edgecdn.net"], glue: [{ name: "ns1.edgecdn.net", addr: "198.51.100.53" }] },
          { zone: "dnshost.net", ns: ["ns1.dnshost.net"], glue: [{ name: "ns1.dnshost.net", addr: "192.0.2.53" }] },
        ],
      },
    ],
    [AUTH]: [
      {
        origin: "example.com", soa: soa("example.com", ns1, 3600, 300), cuts: [],
        records: [
          { name: "example.com", ttl: 86400, data: { t: "NS", host: ns1 } },
          ...(o.glue ? [{ name: "ns1.example.com", ttl: 86400, data: { t: "A", addr: "192.0.2.53" } } as DnsRecord] : []),
          { name: "www.example.com", ttl: 300, data: { t: "A", addr: "192.0.2.10" } },
          { name: "www.example.com", ttl: 300, data: { t: "HTTPS", priority: 1, target: "", alpn: ["h3", "h2"], ipv4hint: ["192.0.2.10"] } },
          { name: "api.example.com", ttl: 3600, data: { t: "CNAME", host: "www.example.com" } },
          { name: "shop.example.com", ttl: 3600, data: { t: "CNAME", host: "shop.edgecdn.net" } },
          ...big,
        ],
      },
      {
        origin: "dnshost.net", soa: soa("dnshost.net", "ns1.dnshost.net", 3600, 300), cuts: [],
        records: [
          { name: "dnshost.net", ttl: 86400, data: { t: "NS", host: "ns1.dnshost.net" } },
          { name: "ns1.dnshost.net", ttl: 86400, data: { t: "A", addr: "192.0.2.53" } },
        ],
      },
    ],
    [CDN]: [{
      origin: "edgecdn.net", soa: soa("edgecdn.net", "ns1.edgecdn.net", 3600, 30), cuts: [],
      records: [
        { name: "edgecdn.net", ttl: 86400, data: { t: "NS", host: "ns1.edgecdn.net" } },
        { name: "shop.edgecdn.net", ttl: 60, data: { t: "A", addr: "198.51.100.7" } },
      ],
    }],
  };
}

const under = (name: string, zone: string) => zone === "" || name === zone || name.endsWith(`.${zone}`);
const depth = (z: string) => (z === "" ? 0 : z.split(".").length);

/** An authoritative server's answer to one question (RFC 1034 section 4.3.2, simplified). */
export function serve(zs: Zone[], q: { name: string; type: RRType }, id: number): DnsMessage {
  const base: DnsMessage = { id, flags: { qr: true, opcode: 0, aa: true, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: 0 }, question: [q], answer: [], authority: [], additional: [] };
  const zone = zs.filter((z) => under(q.name, z.origin)).sort((a, b) => depth(b.origin) - depth(a.origin))[0];
  if (!zone) return { ...base, flags: { ...base.flags, aa: false, rcode: RCODE.REFUSED } };
  const cut = zone.cuts.filter((c) => under(q.name, c.zone)).sort((a, b) => depth(b.zone) - depth(a.zone))[0];
  if (cut) {
    return {
      ...base, flags: { ...base.flags, aa: false },
      authority: cut.ns.map((h) => ({ name: cut.zone, ttl: 172800, data: { t: "NS", host: h } })),
      additional: cut.glue.map((g) => ({ name: g.name, ttl: 172800, data: { t: "A", addr: g.addr } })),
    };
  }
  const answer: DnsRecord[] = [];
  let name = q.name;
  for (let i = 0; i < 8; i++) {
    const at = zone.records.filter((r) => r.name === name);
    const hit = at.filter((r) => r.data.t === q.type);
    if (hit.length) return { ...base, answer: [...answer, ...hit] };
    const cname = at.find((r) => r.data.t === "CNAME");
    if (cname && cname.data.t === "CNAME") {
      answer.push(cname);
      name = cname.data.host;
      if (!under(name, zone.origin)) return { ...base, answer };
      continue;
    }
    if (answer.length) return { ...base, answer };
    const exists = zone.records.some((r) => r.name === name || r.name.endsWith(`.${name}`));
    return { ...base, flags: { ...base.flags, rcode: exists ? RCODE.NOERROR : RCODE.NXDOMAIN }, authority: [zone.soa] };
  }
  return { ...base, answer };
}

// ------------------------------------------------------------------------------------------------ the run

export type DnsPayload = { proto: "dns"; msg: DnsMessage; lookup: number; upstream: number };

interface CacheEntry { records: DnsRecord[]; expires: number; neg?: "NXDOMAIN" | "NODATA"; storedAt: number }

export interface Upstream {
  id: number;
  lookup: number;
  server: number;
  qname: string;
  qtype: RRType;
  tcp: boolean;
  sentAt: number;
  doneAt?: number;
  outcome?: string;
  retries: number;
}

export interface Lookup {
  id: number;
  name: string;
  type: RRType;
  start: number;
  end?: number;
  rcode?: string;
  answer: DnsRecord[];
  upstream: number[];
  /** What the resolver found in its cache on the way. */
  hits: string[];
  /** The cache after this lookup: [key, seconds left]. */
  cacheAfter: { key: string; left: number; neg?: string; text: string }[];
}

export interface DnsRunOpts {
  /** Lookups: a name and a type, and the time in seconds when the stub asks. */
  lookups: { at: number; name: string; type?: RRType }[];
  glue?: boolean;
  /** EDNS(0) buffer size the resolver offers, or 0 for none (512-byte limit). */
  edns?: number;
  /** Drop the first UDP query sent to this server node. */
  dropFirstTo?: number;
  retryMs?: number;
  seed?: number;
}

type Ask = { server: number; qname: string; qtype: RRType };

export interface DnsRun {
  net: PacketNet<any>;
  lookups: Lookup[];
  upstream: Upstream[];
  /** TCP connection id → lookup id, to label TCP segments. */
  tcpLookup: Map<number, number>;
  tcpUpstream: Map<number, number>;
}

export function dnsRun(o: DnsRunOpts): DnsRun {
  const net = new PacketNet<any>(DNS_NODES, { seed: o.seed ?? 1, record: true });
  for (const [node, d] of Object.entries(DNS_LINKS)) net.connect(RESOLVER, Number(node), { rate: 100e6, delay: d });
  net.computeRoutes();
  const stack = new TcpStack(net, { nagle: false, delayedAck: 0, timeWait: 0 });
  const data = zones({ glue: o.glue ?? true });
  const edns = o.edns ?? 0;
  const retryMs = o.retryMs ?? 800;
  const cache = new Map<string, CacheEntry>();
  const lookups: Lookup[] = [];
  const upstream: Upstream[] = [];
  const tcpLookup = new Map<number, number>(), tcpUpstream = new Map<number, number>();
  let nextId = 0x1a2b;
  let dropped = false;

  // Root hints: the resolver starts out knowing the root's name server and its address. They never expire.
  cache.set("|NS", { records: [{ name: "", ttl: 518400, data: { t: "NS", host: "a.root-servers.net" } }], expires: Infinity, storedAt: 0 });
  cache.set("a.root-servers.net|A", { records: [{ name: "a.root-servers.net", ttl: 518400, data: { t: "A", addr: "198.41.0.4" } }], expires: Infinity, storedAt: 0 });

  const key = (n: string, t: string) => `${n}|${t}`;
  const get = (n: string, t: string) => {
    const e = cache.get(key(n, t));
    if (!e) return undefined;
    if (e.expires <= net.now) {
      cache.delete(key(n, t));
      return undefined;
    }
    return e;
  };
  const put = (rs: DnsRecord[]) => {
    const groups = new Map<string, DnsRecord[]>();
    for (const r of rs) {
      if (r.data.t === "OPT") continue;
      const k = key(r.name, r.data.t);
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const [k, g] of groups) {
      const ttl = Math.min(...g.map((r) => r.ttl));
      cache.set(k, { records: g, expires: net.now + ttl * 1000, storedAt: net.now });
    }
  };

  function* resolve(lk: Lookup, qname: string, qtype: RRType, level: number): Generator<Ask, { rcode: string; answer: DnsRecord[] }, DnsMessage | null> {
    const chain: DnsRecord[] = [];
    for (let step = 0; step < 24; step++) {
      const old = (e: CacheEntry) => e.storedAt < lk.start;
      const hit = get(qname, qtype);
      if (hit) {
        if (old(hit)) lk.hits.push(`${qname} ${qtype}`);
        return { rcode: "NOERROR", answer: [...chain, ...hit.records] };
      }
      const nx = get(qname, "NXDOMAIN") ?? get(qname, `NODATA ${qtype}`);
      if (nx) {
        if (old(nx)) lk.hits.push(`${qname} ${nx.neg} (negative)`);
        return { rcode: nx.neg === "NXDOMAIN" ? "NXDOMAIN" : "NOERROR", answer: chain };
      }
      const cn = get(qname, "CNAME");
      if (cn && cn.records[0]!.data.t === "CNAME") {
        if (old(cn)) lk.hits.push(`${qname} CNAME`);
        chain.push(cn.records[0]!);
        qname = cn.records[0]!.data.host;
        continue;
      }
      // The closest enclosing zone whose name servers we know.
      const labels = qname.split(".");
      let ns: DnsRecord[] = [];
      let zone = "";
      for (let i = 0; i <= labels.length; i++) {
        const z = labels.slice(i).join(".");
        const e = get(z, "NS");
        if (e) {
          ns = e.records;
          zone = z;
          if (z !== "" && old(e)) lk.hits.push(`${z} NS`);
          break;
        }
      }
      const host = ns[0]!.data.t === "NS" ? ns[0]!.data.host : "";
      let addr = get(host, "A");
      if (!addr) {
        if (level > 3) return { rcode: "SERVFAIL", answer: chain };
        // Glueless delegation: resolve the name server's own address first.
        const sub = yield* resolve(lk, host, "A", level + 1);
        if (sub.rcode !== "NOERROR" || !sub.answer.length) return { rcode: "SERVFAIL", answer: chain };
        addr = get(host, "A");
        if (!addr) return { rcode: "SERVFAIL", answer: chain };
      }
      const a = addr.records[0]!.data;
      const server = a.t === "A" ? ADDR[a.addr] : undefined;
      if (server === undefined) return { rcode: "SERVFAIL", answer: chain };
      const reply = yield { server, qname, qtype };
      if (!reply) return { rcode: "SERVFAIL", answer: chain };
      const r = reply;
      put(r.answer);
      put(r.authority.filter((x) => x.data.t === "NS"));
      // Accept glue only for names under the delegated zone ("in bailiwick"), as resolvers have done since about 1997.
      const cutZone = r.authority.find((x) => x.data.t === "NS")?.name;
      put(r.additional.filter((x) => x.data.t === "A" && (cutZone === undefined || under(x.name, zone))));
      if (r.flags.rcode === RCODE.NXDOMAIN || (r.flags.rcode === 0 && !r.answer.length && r.authority.some((x) => x.data.t === "SOA"))) {
        const s = r.authority.find((x) => x.data.t === "SOA");
        const negTtl = s && s.data.t === "SOA" ? Math.min(s.ttl, s.data.minimum) : 0;
        const nxd = r.flags.rcode === RCODE.NXDOMAIN;
        cache.set(key(qname, nxd ? "NXDOMAIN" : `NODATA ${qtype}`), { records: s ? [s] : [], expires: net.now + negTtl * 1000, neg: nxd ? "NXDOMAIN" : "NODATA", storedAt: net.now });
        return { rcode: nxd ? "NXDOMAIN" : "NOERROR", answer: chain };
      }
      // Answers and CNAMEs are now in the cache: the next pass of the loop finds them.
    }
    return { rcode: "SERVFAIL", answer: chain };
  }

  // ---- drivers: one generator per lookup, resumed by replies
  const running = new Map<number, { gen: Generator<Ask, { rcode: string; answer: DnsRecord[] }, DnsMessage | null>; lk: Lookup; up?: Upstream; timer?: number }>();
  const pending = new Map<number, number>(); // upstream id → lookup id
  const finish = (lk: Lookup, res: { rcode: string; answer: DnsRecord[] }) => {
    lk.rcode = res.rcode;
    lk.answer = res.answer;
    const reply: DnsMessage = { ...query(lk.id, lk.name, lk.type), flags: { qr: true, opcode: 0, aa: false, tc: false, rd: true, ra: true, ad: false, cd: false, rcode: RCODE[res.rcode as keyof typeof RCODE] ?? 2 }, answer: res.answer };
    net.send(RESOLVER, STUB, messageSize(reply) + UDP_IP_BYTES, { proto: "dns", msg: reply, lookup: lk.id, upstream: 0 } satisfies DnsPayload);
  };
  const advance = (lid: number, reply: DnsMessage | null) => {
    const r = running.get(lid)!;
    const step = r.gen.next(reply as DnsMessage | null);
    if (step.done) {
      running.delete(lid);
      finish(r.lk, step.value);
      return;
    }
    sendUdp(r.lk, step.value, false);
  };
  const sendUdp = (lk: Lookup, a: Ask, isRetry: boolean, prev?: Upstream) => {
    const up: Upstream = prev ?? { id: nextId++ & 0xffff, lookup: lk.id, server: a.server, qname: a.qname, qtype: a.qtype, tcp: false, sentAt: net.now, retries: 0 };
    if (!prev) {
      upstream.push(up);
      lk.upstream.push(upstream.length - 1);
    }
    if (isRetry) up.retries++;
    pending.set(up.id, lk.id);
    const msg = query(up.id, a.qname, a.qtype, { rd: false, edns: edns || undefined });
    const r = running.get(lk.id)!;
    r.up = up;
    r.timer = net.setTimer(RESOLVER, retryMs, `dns:retry:${lk.id}`);
    net.send(RESOLVER, a.server, messageSize(msg) + UDP_IP_BYTES, { proto: "dns", msg, lookup: lk.id, upstream: up.id } satisfies DnsPayload);
  };
  net.dropIf = (pkt) => {
    const p = pkt.payload as DnsPayload;
    if (o.dropFirstTo !== undefined && !dropped && p?.proto === "dns" && pkt.src === RESOLVER && pkt.dst === o.dropFirstTo && !p.msg.flags.qr) {
      dropped = true;
      return true;
    }
    return false;
  };

  // ---- TCP fallback: a mailbox carries the message objects next to the byte counts on the stream.
  const tcpBox = new Map<string, DnsMessage>();
  for (const node of [ROOT, TLD, AUTH, CDN]) {
    stack.listen(node, 53, {
      onAccept: (s) => {
        let got = 0;
        s.onData = (_c, n) => {
          got += n;
          const q = tcpBox.get(`q:${s.rnode}:${s.rport}`);
          if (!q || got < 2 + messageSize(q)) return;
          const reply = serve(data[node]!, q.question[0]!, q.id);
          tcpBox.set(`r:${s.rnode}:${s.rport}`, reply);
          s.write(2 + messageSize(reply));
          s.close();
        };
      },
    });
  }
  const tcpQuery = (lk: Lookup, up: Upstream) => {
    const c: TcpConn = stack.connect(RESOLVER, up.server, 53);
    tcpLookup.set(c.id, lk.id);
    tcpUpstream.set(c.id, up.id);
    const msg = query(up.id, up.qname, up.qtype, { rd: false });
    tcpBox.set(`q:${RESOLVER}:${c.lport}`, msg);
    let got = 0;
    c.onEstablished = () => c.write(2 + messageSize(msg));
    c.onData = (_c, n) => {
      got += n;
      const reply = tcpBox.get(`r:${RESOLVER}:${c.lport}`);
      if (!reply || got < 2 + messageSize(reply)) return;
      c.close();
      up.doneAt = net.now;
      up.outcome = outcomeText(reply);
      advance(lk.id, reply);
    };
  };

  net.setHandlers({
    onDeliver(node, pkt: Packet<any>) {
      if (stack.deliver(node, pkt)) return;
      const p = pkt.payload as DnsPayload;
      if (p?.proto !== "dns") return;
      if (node === RESOLVER && !p.msg.flags.qr) {
        // A query from the stub.
        const lk = lookups.find((l) => l.id === p.lookup)!;
        running.set(lk.id, { gen: resolve(lk, lk.name, lk.type, 0), lk });
        advance(lk.id, null as unknown as DnsMessage);
        return;
      }
      if (node === STUB) {
        const lk = lookups.find((l) => l.id === p.lookup)!;
        lk.end = net.now;
        lk.cacheAfter = snapshot();
        return;
      }
      if (node === RESOLVER && p.msg.flags.qr) {
        const lid = pending.get(p.msg.id);
        const r = lid !== undefined ? running.get(lid) : undefined;
        if (!r || r.up?.id !== p.msg.id) return; // late or unexpected: ignore
        pending.delete(p.msg.id);
        if (r.timer) net.cancelTimer(r.timer);
        const up = r.up!;
        if (p.msg.flags.tc) {
          up.outcome = "truncated (TC=1)";
          up.doneAt = net.now;
          const tcpUp: Upstream = { ...up, id: nextId++ & 0xffff, tcp: true, sentAt: net.now, doneAt: undefined, outcome: undefined, retries: 0 };
          upstream.push(tcpUp);
          r.lk.upstream.push(upstream.length - 1);
          r.up = tcpUp;
          tcpQuery(r.lk, tcpUp);
          return;
        }
        up.doneAt = net.now;
        up.outcome = outcomeText(p.msg);
        advance(lid!, p.msg);
        return;
      }
      // An authoritative server: answer over UDP, truncated if too big.
      const q = p.msg;
      const zs = data[node];
      if (!zs) return;
      let reply = serve(zs, q.question[0]!, q.id);
      const opt = q.additional.find((x) => x.data.t === "OPT");
      const limit = opt && opt.data.t === "OPT" ? opt.data.udpSize : UDP_LIMIT;
      if (opt) reply = { ...reply, additional: [...reply.additional, { name: "", ttl: 0, data: { t: "OPT", udpSize: 1232 } }] };
      if (messageSize(reply) > limit) reply = { ...reply, flags: { ...reply.flags, tc: true }, answer: [], authority: [], additional: [] };
      net.send(node, RESOLVER, messageSize(reply) + UDP_IP_BYTES, { proto: "dns", msg: reply, lookup: p.lookup, upstream: p.upstream } satisfies DnsPayload);
    },
    onTimer(node, tag) {
      if (stack.timer(node, tag)) return;
      if (!tag.startsWith("dns:retry:")) return;
      const lid = Number(tag.split(":")[2]);
      const r = running.get(lid);
      if (!r?.up || r.up.doneAt !== undefined) return;
      if (r.up.retries >= 2) {
        r.up.outcome = "no answer";
        running.delete(lid);
        finish(r.lk, { rcode: "SERVFAIL", answer: [] });
        return;
      }
      pending.delete(r.up.id);
      r.up.id = nextId++ & 0xffff;
      sendUdp(r.lk, { server: r.up.server, qname: r.up.qname, qtype: r.up.qtype }, true, r.up);
    },
  });

  const snapshot = () => {
    const out: Lookup["cacheAfter"] = [];
    for (const [k, e] of cache) {
      if (e.expires === Infinity || e.expires <= net.now) continue;
      const leftS = Math.max(0, Math.round((e.expires - net.now) / 1000));
      const text = e.neg ? `${k.split("|")[0]} ${e.neg}` : e.records.length > 3 ? `${k.replace("|", " ")} (${e.records.length} records)` : e.records.map((x) => `${x.name} ${x.data.t} ${"host" in x.data ? x.data.host : "addr" in x.data ? x.data.addr : ""}`.trim()).join(", ");
      out.push({ key: k, left: leftS, neg: e.neg, text });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  };

  o.lookups.forEach((l, i) => {
    const lk: Lookup = { id: i + 1, name: l.name, type: l.type ?? "A", start: l.at * 1000, answer: [], upstream: [], hits: [], cacheAfter: [] };
    lookups.push(lk);
    net.at(lk.start, () => {
      const msg = query(lk.id, lk.name, lk.type);
      net.send(STUB, RESOLVER, messageSize(msg) + UDP_IP_BYTES, { proto: "dns", msg, lookup: lk.id, upstream: 0 } satisfies DnsPayload);
    });
  });
  net.runAll();
  return { net, lookups, upstream, tcpLookup, tcpUpstream };
}

export function outcomeText(m: DnsMessage): string {
  if (m.flags.tc) return "truncated (TC=1)";
  if (m.flags.rcode === RCODE.NXDOMAIN) return "NXDOMAIN";
  if (m.answer.length) {
    const last = m.answer[m.answer.length - 1]!;
    return m.answer.some((r) => r.data.t === "CNAME") && last.data.t === "CNAME" ? `CNAME → ${last.data.host}` : `answer (${m.answer.length} record${m.answer.length > 1 ? "s" : ""})`;
  }
  if (m.authority.some((r) => r.data.t === "NS")) {
    const z = m.authority[0]!.name;
    return `referral to ${z}${m.additional.length ? " + glue" : ", no glue"}`;
  }
  if (m.authority.some((r) => r.data.t === "SOA")) return "NODATA";
  return "empty";
}

/** Total time of a lookup in ms. */
export const lookupMs = (l: Lookup) => (l.end ?? NaN) - l.start;
