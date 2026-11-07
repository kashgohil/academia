/**
 * Connection setup on a PacketNet path: TCP + TLS 1.2, TCP + TLS 1.3, TCP + TLS 1.3 early data, TCP Fast Open
 * with TLS 1.3 early data, QUIC (1-RTT) and QUIC 0-RTT. Each setup is a script: a message is sent as soon as the
 * messages it waits for have arrived. The time to the first byte of the response falls out of the run.
 *
 * Model inputs: message sizes (a certificate chain of `certBytes`), no processing time, one link between client and
 * server. An attacker node has its own link to the server.
 * QUIC's anti-amplification limit (RFC 9000 section 8.1) is modelled: before the client's address is validated,
 * the server sends at most 3 times the bytes it received. A client Initial is padded to 1200 bytes, so a server
 * flight above 3600 bytes waits for one more client packet.
 *
 * With `replay`, the attacker copies the client's first packet from the wire and sends it to the server again
 * later, as an attacker on the path could. Early data (0-RTT) in that packet then runs a second time, unless the server has
 * anti-replay protection (it remembers ClientHellos or uses single-use tickets, RFC 8446 section 8).
 */
import { PacketNet } from "..";

export type SetupKind = "tcp-tls12" | "tcp-tls13" | "tcp-tls13-0rtt" | "tfo-tls13-0rtt" | "quic" | "quic-0rtt";

export const SETUP_LABEL: Record<SetupKind, string> = {
  "tcp-tls12": "TCP + TLS 1.2",
  "tcp-tls13": "TCP + TLS 1.3",
  "tcp-tls13-0rtt": "TCP + TLS 1.3 early data",
  "tfo-tls13-0rtt": "TCP Fast Open + TLS 1.3 early data",
  quic: "QUIC",
  "quic-0rtt": "QUIC 0-RTT",
};

export const QUIC_MIN_INITIAL = 1200;
export const AMPLIFICATION_FACTOR = 3;

export interface HsMsg {
  id: string;
  label: string;
  /** Carries the request (early data or not). */
  request?: boolean;
  response?: boolean;
  early?: boolean;
  replayed?: boolean;
}

interface Step {
  id: string;
  from: "c" | "s";
  label: string;
  bytes: number;
  after: string[];
  request?: boolean;
  response?: boolean;
  early?: boolean;
}

/** Whether a setup can send the request before the handshake ends. */
export const isEarly = (k: SetupKind) => k.endsWith("0rtt");

export function setupScript(kind: SetupKind, certBytes: number): Step[] {
  const c = (id: string, label: string, bytes: number, after: string[], x: Partial<Step> = {}): Step => ({ id, from: "c", label, bytes, after, ...x });
  const s = (id: string, label: string, bytes: number, after: string[], x: Partial<Step> = {}): Step => ({ id, from: "s", label, bytes, after, ...x });
  const req = "GET /";
  switch (kind) {
    case "tcp-tls12":
      return [
        c("syn", "SYN", 60, []),
        s("synack", "SYN-ACK", 60, ["syn"]),
        c("ch", "ACK, ClientHello", 300, ["synack"]),
        s("sh", "ServerHello, Certificate, ServerHelloDone", certBytes, ["ch"]),
        c("cke", "ClientKeyExchange, ChangeCipherSpec, Finished", 200, ["sh"]),
        s("sfin", "ChangeCipherSpec, Finished", 100, ["cke"]),
        c("req", req, 200, ["sfin"], { request: true }),
        s("resp", "response", 1400, ["req"], { response: true }),
      ];
    case "tcp-tls13":
      return [
        c("syn", "SYN", 60, []),
        s("synack", "SYN-ACK", 60, ["syn"]),
        c("ch", "ACK, ClientHello", 300, ["synack"]),
        s("sh", "ServerHello … Certificate … Finished", certBytes, ["ch"]),
        c("req", `Finished, ${req}`, 250, ["sh"], { request: true }),
        s("resp", "response", 1400, ["req"], { response: true }),
      ];
    case "tcp-tls13-0rtt":
      return [
        c("syn", "SYN", 60, []),
        s("synack", "SYN-ACK", 60, ["syn"]),
        c("ch", `ClientHello + early data: ${req}`, 500, ["synack"], { request: true, early: true }),
        s("sh", "ServerHello, Finished", 300, ["ch"]),
        s("resp", "response", 1400, ["ch"], { response: true }),
        c("cfin", "EndOfEarlyData, Finished", 100, ["sh"]),
      ];
    case "tfo-tls13-0rtt":
      return [
        c("ch", `SYN + cookie, ClientHello + early data: ${req}`, 560, [], { request: true, early: true }),
        s("sh", "SYN-ACK, ServerHello, Finished", 360, ["ch"]),
        s("resp", "response", 1400, ["ch"], { response: true }),
        c("cfin", "ACK, EndOfEarlyData, Finished", 100, ["sh"]),
      ];
    case "quic": {
      const limit = AMPLIFICATION_FACTOR * QUIC_MIN_INITIAL;
      if (certBytes <= limit)
        return [
          c("ci", "Initial: ClientHello", QUIC_MIN_INITIAL, []),
          s("sh", "Initial + Handshake: ServerHello … Finished", certBytes, ["ci"]),
          c("req", `Handshake: Finished, 1-RTT: ${req}`, 250, ["sh"], { request: true }),
          s("resp", "1-RTT: response", 1400, ["req"], { response: true }),
        ];
      return [
        c("ci", "Initial: ClientHello", QUIC_MIN_INITIAL, []),
        s("sh", "Initial + Handshake (3 × 1200 bytes, the limit)", limit, ["ci"]),
        c("ack", "Initial: ACK (1200 bytes)", QUIC_MIN_INITIAL, ["sh"]),
        s("sh2", "Handshake: rest of Certificate … Finished", certBytes - limit, ["ack"]),
        c("req", `Handshake: Finished, 1-RTT: ${req}`, 250, ["sh2"], { request: true }),
        s("resp", "1-RTT: response", 1400, ["req"], { response: true }),
      ];
    }
    case "quic-0rtt":
      return [
        c("ci", `Initial: ClientHello, 0-RTT: ${req}`, QUIC_MIN_INITIAL, [], { request: true, early: true }),
        s("sh", "Initial + Handshake: ServerHello, Finished", 400, ["ci"]),
        s("resp", "1-RTT: response", 1400, ["ci"], { response: true }),
        c("cfin", "Handshake: Finished", 100, ["sh"]),
      ];
  }
}

export interface SetupOpts {
  kind: SetupKind;
  rttMs: number;
  /** Bottleneck rate in Mbit/s. */
  mbps?: number;
  certBytes?: number;
  replay?: boolean;
  antiReplay?: boolean;
  /** When the attacker sends the copy, in RTTs. */
  replayAtRtt?: number;
}

export interface SetupRun {
  net: PacketNet<HsMsg>;
  /** Time the first byte of the response reaches the client. */
  firstByteMs: number;
  rtts: number;
  /** How many times the server ran the request. */
  executions: number;
  serverLog: { t: number; text: string }[];
  tEnd: number;
}

export const CLIENT = 0, SERVER = 1, ATTACKER = 2;

export function setupRun(o: SetupOpts): SetupRun {
  const steps = setupScript(o.kind, o.certBytes ?? 3000);
  const rate = (o.mbps ?? 50) * 1e6;
  const net = new PacketNet<HsMsg>(["client", "server", "attacker"], { seed: 1, record: true });
  net.connect(CLIENT, SERVER, { rate, delay: o.rttMs / 2 });
  net.connect(ATTACKER, SERVER, { rate, delay: o.rttMs / 4 });
  net.computeRoutes();
  const arrivedAt = { c: new Set<string>(), s: new Set<string>() };
  const sent = new Set<string>();
  const serverLog: { t: number; text: string }[] = [];
  let firstByte = NaN, executions = 0, firstPacket: HsMsg | undefined, firstSize = 0;
  const seenHello = new Set<string>();
  const fire = () => {
    for (const st of steps) {
      if (sent.has(st.id)) continue;
      const have = arrivedAt[st.from];
      if (!st.after.every((a) => have.has(a))) continue;
      sent.add(st.id);
      const from = st.from === "c" ? CLIENT : SERVER, to = st.from === "c" ? SERVER : CLIENT;
      const msg: HsMsg = { id: st.id, label: st.label, request: st.request, response: st.response, early: st.early };
      if (!firstPacket && st.from === "c") {
        firstPacket = msg;
        firstSize = st.bytes;
      }
      net.send(from, to, st.bytes, msg);
    }
  };
  // The attacker taps the client's link: it records the first packet and sends a copy to the server later.
  net.dropIf = (pkt) => {
    if (o.replay && pkt.src === CLIENT && pkt.payload === firstPacket && !pkt.payload.replayed) {
      const copy: HsMsg = { ...pkt.payload, replayed: true, label: `replayed copy: ${pkt.payload.label}` };
      net.at((o.replayAtRtt ?? 3) * o.rttMs, () => net.send(ATTACKER, SERVER, firstSize, copy));
    }
    return false;
  };
  net.setHandlers({
    onDeliver(node, pkt) {
      const m = pkt.payload;
      if (node === SERVER) {
        if (m.replayed) {
          if (m.early && o.antiReplay && seenHello.has(m.id)) {
            serverLog.push({ t: net.now, text: "rejects the 0-RTT data: this ClientHello was already used" });
          } else if (m.early) {
            executions++;
            serverLog.push({ t: net.now, text: "runs the early-data request again" });
          } else serverLog.push({ t: net.now, text: "answers the copy, but no handshake can finish: nothing runs" });
          return;
        }
        if (m.early) seenHello.add(m.id);
        if (m.request) {
          executions++;
          serverLog.push({ t: net.now, text: m.early ? "runs the request from early data" : "runs the request" });
        }
        arrivedAt.s.add(m.id);
      } else if (node === CLIENT) {
        if (m.response && Number.isNaN(firstByte)) firstByte = net.now;
        arrivedAt.c.add(m.id);
      }
      fire();
    },
  });
  fire();
  net.runAll();
  return { net, firstByteMs: firstByte, rtts: firstByte / o.rttMs, executions, serverLog, tEnd: net.now };
}
