/**
 * TLS handshakes on the reference TCP (../transport). Each handshake is a script of TLS messages. A side writes a
 * message into its TCP stream as soon as the messages it waits for have arrived. A message has arrived when the
 * receiver's TCP has delivered every byte of it in order. So TCP's handshake, segment sizes, initial window and
 * retransmissions all shape the result.
 *
 * Message sizes are bytes on the TLS stream: a 5-byte record header, and for a protected TLS 1.3 record, 1 byte of
 * inner content type and a 16-byte AEAD tag. Sizes from the RFC 8448 trace are facts about that trace; the
 * certificate chain, the signatures, the request and the response are model inputs.
 *
 * Model limits: one record per flight, no processing time, a server that sends its whole flight at once.
 */
import { PacketNet, type Packet } from "../packet";
import { TcpStack, type TcpConn, type CongestionControl, type TcpSegment } from "../transport";

export type TlsMode = "tls12" | "tls12-resume" | "tls13" | "tls13-hrr" | "tls13-psk" | "tls13-0rtt";

export const TLS_MODE_LABEL: Record<TlsMode, string> = {
  tls12: "TLS 1.2, full",
  "tls12-resume": "TLS 1.2, resumed",
  tls13: "TLS 1.3, full",
  "tls13-hrr": "TLS 1.3, HelloRetryRequest",
  "tls13-psk": "TLS 1.3, PSK resumption",
  "tls13-0rtt": "TLS 1.3, 0-RTT",
};

/** Who on the path can read a message. */
export type Visibility = "plain" | "encrypted";

export interface TlsMsg {
  id: string;
  from: "c" | "s";
  label: string;
  /** Bytes on the TLS stream. */
  bytes: number;
  /** Ids of messages that must have arrived at this side first. */
  after: string[];
  vis: Visibility;
  /** What an observer on the path learns from it. */
  sees: string;
  request?: boolean;
  response?: boolean;
}

export interface TlsSizes {
  /** Bytes of the certificate chain (DER certificates and their 3-byte length prefixes): a model input. */
  certBytes: number;
  /** Bytes of one signature: 256 for RSA-2048, about 72 for ECDSA P-256. A model input. */
  sigBytes: number;
  /** Hybrid post-quantum key exchange X25519MLKEM768: the key shares grow from 32 to 1216 and 1120 bytes. */
  pq: boolean;
  request: number;
  response: number;
}

export const TLS_SIZE_DEFAULTS: TlsSizes = { certBytes: 4000, sigBytes: 256, pq: false, request: 300, response: 1200 };

/** Record overheads: a 5-byte header; a protected TLS 1.3 record adds 1 byte of content type and a 16-byte tag. */
export const REC = 5, TLS13_PROT = 1 + 16;
/** A TLS 1.2 AES-GCM record adds an 8-byte explicit nonce and a 16-byte tag. */
export const TLS12_PROT = 8 + 16;
/** Sizes of the RFC 8448 messages (facts about that trace). */
export const RFC8448_SIZES = { clientHello: 196, serverHello: 90, encryptedExtensions: 40, finished: 36 } as const;
/** X25519MLKEM768 key shares: ML-KEM-768 encapsulation key 1184 + X25519 32; ciphertext 1088 + X25519 32. */
export const PQ_CLIENT_SHARE = 1216, PQ_SERVER_SHARE = 1120;

/** The messages of one handshake and the request that follows it. */
export function tlsScript(mode: TlsMode, s: TlsSizes = TLS_SIZE_DEFAULTS): TlsMsg[] {
  const c = (id: string, label: string, bytes: number, after: string[], vis: Visibility, sees: string, x: Partial<TlsMsg> = {}): TlsMsg => ({ id, from: "c", label, bytes, after, vis, sees, ...x });
  const sv = (id: string, label: string, bytes: number, after: string[], vis: Visibility, sees: string, x: Partial<TlsMsg> = {}): TlsMsg => ({ id, from: "s", label, bytes, after, vis, sees, ...x });
  const pq = s.pq && mode.startsWith("tls13"); // the hybrid groups exist only for TLS 1.3
  const pqC = pq ? PQ_CLIENT_SHARE + 4 + 2 : 0; // a second key share entry and one more supported group
  const pqS = pq ? PQ_SERVER_SHARE - 32 : 0;
  const ch = REC + RFC8448_SIZES.clientHello + pqC;
  const sh = REC + RFC8448_SIZES.serverHello + pqS;
  const certMsg = 4 + 1 + 3 + s.certBytes + 2; // handshake header, context, list length, chain, one empty extensions block
  const cv = 4 + 2 + 2 + s.sigBytes;
  const fin13 = RFC8448_SIZES.finished;
  const app13 = (n: number) => REC + n + TLS13_PROT;
  const app12 = (n: number) => REC + n + TLS12_PROT;
  const ticket = 200; // a session ticket the server issued earlier (model input)
  const chSees = "SNI, ALPN, cipher suites, key shares";
  switch (mode) {
    case "tls12": {
      const ske = 4 + 4 + 32 + 4 + s.sigBytes; // ECDHE x25519 params + signature
      return [
        c("ch", "ClientHello", ch, [], "plain", chSees),
        sv("sflight", "ServerHello, Certificate, ServerKeyExchange, ServerHelloDone", REC + 4 + 70 + REC + 4 + 3 + s.certBytes + REC + ske + REC + 4, ["ch"], "plain", "the chosen suite and the whole certificate chain, names included"),
        c("cfin", "ClientKeyExchange, ChangeCipherSpec, Finished", REC + 4 + 33 + REC + 1 + app12(16), ["sflight"], "plain", "key exchange; Finished is encrypted"),
        sv("sfin", "ChangeCipherSpec, Finished", REC + 1 + app12(16), ["cfin"], "plain", "only that the handshake is done"),
        c("req", "request", app12(s.request), ["sfin"], "encrypted", "record sizes and timing", { request: true }),
        sv("resp", "response", app12(s.response), ["req"], "encrypted", "record sizes and timing", { response: true }),
      ];
    }
    case "tls12-resume":
      return [
        c("ch", "ClientHello + session ticket", ch + 4 + ticket, [], "plain", chSees + ", the ticket"),
        sv("sfin", "ServerHello, ChangeCipherSpec, Finished", REC + 4 + 70 + REC + 1 + app12(16), ["ch"], "plain", "that the session was resumed"),
        c("req", "ChangeCipherSpec, Finished, request", REC + 1 + app12(16) + app12(s.request), ["sfin"], "encrypted", "record sizes and timing", { request: true }),
        sv("resp", "response", app12(s.response), ["req"], "encrypted", "record sizes and timing", { response: true }),
      ];
    case "tls13":
      return [
        c("ch", "ClientHello (key_share)", ch, [], "plain", chSees),
        sv("sflight", "ServerHello | EncryptedExtensions, Certificate, CertificateVerify, Finished", sh + app13(RFC8448_SIZES.encryptedExtensions + certMsg + cv + fin13), ["ch"], "encrypted", "ServerHello only; the certificate is encrypted"),
        c("req", "Finished, request", app13(fin13) + app13(s.request), ["sflight"], "encrypted", "record sizes and timing", { request: true }),
        sv("resp", "response", app13(s.response), ["req"], "encrypted", "record sizes and timing", { response: true }),
      ];
    case "tls13-hrr":
      return [
        c("ch", "ClientHello (key_share: a group the server does not take)", ch, [], "plain", chSees),
        sv("hrr", "HelloRetryRequest (key_share: x25519)", REC + 4 + 2 + 32 + 1 + 3 + 2 + 6 + 6 + 44, ["ch"], "plain", "the group the server wants"),
        c("ch2", "ClientHello 2 (key_share: x25519)", ch, ["hrr"], "plain", chSees),
        sv("sflight", "ServerHello | EncryptedExtensions, Certificate, CertificateVerify, Finished", sh + app13(RFC8448_SIZES.encryptedExtensions + certMsg + cv + fin13), ["ch2"], "encrypted", "ServerHello only"),
        c("req", "Finished, request", app13(fin13) + app13(s.request), ["sflight"], "encrypted", "record sizes and timing", { request: true }),
        sv("resp", "response", app13(s.response), ["req"], "encrypted", "record sizes and timing", { response: true }),
      ];
    case "tls13-psk":
      return [
        c("ch", "ClientHello (key_share, pre_shared_key)", ch + 4 + 2 + 2 + ticket + 4 + 2 + 33, [], "plain", chSees + ", the ticket"),
        sv("sflight", "ServerHello | EncryptedExtensions, Finished", sh + 6 + app13(RFC8448_SIZES.encryptedExtensions + fin13), ["ch"], "encrypted", "ServerHello only; no certificate is sent"),
        c("req", "Finished, request", app13(fin13) + app13(s.request), ["sflight"], "encrypted", "record sizes and timing", { request: true }),
        sv("resp", "response", app13(s.response), ["req"], "encrypted", "record sizes and timing", { response: true }),
      ];
    case "tls13-0rtt":
      return [
        c("ch", "ClientHello (pre_shared_key, early_data) + 0-RTT request", ch + 4 + 2 + 2 + ticket + 4 + 2 + 33 + 4 + app13(s.request), [], "plain", chSees + ", the ticket; the request is encrypted", { request: true }),
        sv("sflight", "ServerHello | EncryptedExtensions, Finished", sh + 6 + app13(RFC8448_SIZES.encryptedExtensions + 4 + fin13), ["ch"], "encrypted", "ServerHello only"),
        sv("resp", "response", app13(s.response), ["ch", "sflight"], "encrypted", "record sizes and timing", { response: true }),
        c("cfin", "EndOfEarlyData, Finished", app13(4) + app13(fin13), ["sflight"], "encrypted", "record sizes"),
      ];
  }
}

/** Slow start from an initial window of `iw` segments (RFC 6928: 10). Enough for a handshake, which never sees loss here. */
export class SlowStart implements CongestionControl {
  readonly name = "slow start";
  cwnd: number;
  constructor(private iw: number, private mss = 1460) {
    this.cwnd = iw * mss;
  }
  init(mss: number) {
    this.mss = mss;
    this.cwnd = this.iw * mss;
  }
  onAck(a: { ackedBytes: number }) {
    this.cwnd += a.ackedBytes;
  }
  onLoss() {
    this.cwnd = Math.max(2 * this.mss, this.cwnd / 2);
  }
}

export interface TlsRunOpts {
  mode: TlsMode;
  rttMs: number;
  /** Link rate in Mbit/s (a model input). */
  mbps?: number;
  /** TCP initial window in segments (RFC 6928: 10). */
  iw?: number;
  sizes?: Partial<TlsSizes>;
  /** Lose the first data segment of the server's first flight once. */
  loseServerSegment?: boolean;
}

export interface MsgTiming {
  msg: TlsMsg;
  /** Relative sequence range [start, end) in its side's TCP stream. */
  start: number;
  end: number;
  sentAt: number;
  arrivedAt?: number;
}

export interface TlsRun {
  net: PacketNet<TcpSegment>;
  msgs: MsgTiming[];
  client: TcpConn;
  server?: TcpConn;
  tcpEstablishedAt: number;
  /** The client sends the request (it may still finish the handshake in the same flight). */
  requestAt: number;
  /** The last byte of the response reached the client. */
  responseAt: number;
  rtts: number;
  /** Bytes each side wrote on its TLS stream. */
  clientBytes: number;
  serverBytes: number;
  /** Data segments each side sent (retransmissions included). */
  clientSegs: number;
  serverSegs: number;
  tEnd: number;
}

export const TLS_CLIENT = 0, TLS_SERVER = 1;

export function tlsRun(o: TlsRunOpts): TlsRun {
  const sizes = { ...TLS_SIZE_DEFAULTS, ...o.sizes };
  const script = tlsScript(o.mode, sizes);
  const net = new PacketNet<TcpSegment>(["client", "server"], { seed: 7, record: true });
  net.connect(TLS_CLIENT, TLS_SERVER, { rate: (o.mbps ?? 50) * 1e6, delay: o.rttMs / 2 });
  const iw = o.iw ?? 10;
  const stack = new TcpStack(net, { nagle: false, delayedAck: 0, isn: 0, timeWait: 0, cc: () => new SlowStart(iw) }).install();
  const timings: MsgTiming[] = [];
  const off = { c: 1, s: 1 };
  const arrived = { c: new Set<string>(), s: new Set<string>() };
  const sent = new Set<string>();
  let server: TcpConn | undefined;
  let dropped = false;
  net.dropIf = (pkt: Packet<TcpSegment>) => {
    if (!o.loseServerSegment || dropped || pkt.src !== TLS_SERVER || pkt.payload.len === 0) return false;
    dropped = true;
    return true;
  };
  const conn = (side: "c" | "s") => (side === "c" ? client : server);
  const fire = () => {
    for (const m of script) {
      if (sent.has(m.id)) continue;
      const cn = conn(m.from);
      if (!cn || !cn.synchronized) continue;
      // A dependency is a message from the other side that has arrived, or one of this side's own that is sent.
      if (!m.after.every((a) => arrived[m.from].has(a) || (sent.has(a) && script.find((x) => x.id === a)!.from === m.from))) continue;
      sent.add(m.id);
      timings.push({ msg: m, start: off[m.from], end: off[m.from] + m.bytes, sentAt: net.now });
      off[m.from] += m.bytes;
      cn.write(m.bytes);
    }
  };
  const onData = (side: "c" | "s") => (cn: TcpConn) => {
    const got = cn.stats.delivered + 1;
    const other = side === "c" ? "s" : "c";
    for (const t of timings) if (t.msg.from === other && t.arrivedAt === undefined && t.end <= got) {
      t.arrivedAt = net.now;
      arrived[side].add(t.msg.id);
    }
    fire();
  };
  stack.listen(TLS_SERVER, 443, { onAccept: (s) => { server = s; s.onData = onData("s"); fire(); } });
  const client = stack.connect(TLS_CLIENT, TLS_SERVER, 443);
  client.onData = onData("c");
  client.onEstablished = () => fire();
  net.runAll();
  const req = timings.find((t) => t.msg.request), resp = timings.find((t) => t.msg.response);
  const responseAt = resp?.arrivedAt ?? NaN;
  const dataSegs = (node: number) => net.trace.filter((e) => e.kind === "send" && e.node === node && e.pkt.payload.len > 0).length;
  return {
    net, msgs: timings, client, server,
    tcpEstablishedAt: client.stats.establishedAt ?? NaN,
    requestAt: req?.sentAt ?? NaN,
    responseAt,
    rtts: responseAt / o.rttMs,
    clientBytes: off.c - 1, serverBytes: off.s - 1,
    clientSegs: dataSegs(TLS_CLIENT), serverSegs: dataSegs(TLS_SERVER),
    tEnd: net.now,
  };
}

/** The TLS messages a TCP segment carries: names of the messages whose byte range overlaps the segment. */
export function segmentMessages(run: TlsRun, pkt: Packet<TcpSegment>): TlsMsg[] {
  const s = pkt.payload;
  if (s.len === 0) return [];
  const side = pkt.src === TLS_CLIENT ? "c" : "s";
  const a = s.info.rseq, b = a + s.len;
  return run.msgs.filter((t) => t.msg.from === side && t.start < b && t.end > a).map((t) => t.msg);
}
