/**
 * WireGuard's control logic (the WireGuard paper, sections 2 and 6), on PacketNet.
 *
 * Cryptokey routing: each peer has a public key and a list of AllowedIPs. To send, the interface picks the peer
 * whose AllowedIPs hold the destination with the longest prefix. On receipt, a decrypted packet is dropped unless its
 * inner source address is in the AllowedIPs of the peer whose key decrypted it.
 *
 * Sessions and timers (constants from the paper, table in section 6.1): a handshake (initiation 148 bytes, response
 * 92 bytes) makes a session; the initiator starts a new one after Rekey-After-Time = 120 s; keys are refused after
 * Reject-After-Time = 180 s; an unanswered initiation is sent again after Rekey-Timeout = 5 s, for up to
 * Rekey-Attempt-Time = 90 s; a peer that received data and has sent nothing for Keepalive-Timeout = 10 s sends an
 * empty keepalive; a peer that sent data and heard nothing for 15 s starts a new handshake. With PersistentKeepalive
 * set, a peer sends a keepalive at that interval no matter what (wg(8); 25 s is the usual advice for NAT).
 *
 * Roaming: the server sends to the outer address of the last authenticated packet from the peer. In the session run
 * the laptop sits behind a NAT on each network; a NAT forgets a UDP mapping after `natTimeoutS` without outbound
 * packets (a model input) and then drops what the server sends.
 */
import { PacketNet } from "../packet";
import { inPrefix, parseIpv4 } from "../bytes";
import { parseCidr, type Prefix } from "../ip";

// ------------------------------------------------------------------ cryptokey routing

export interface WgPeer {
  name: string;
  allowed: string[];
}

export interface RouteResult {
  /** The peer that gets the packet, or undefined: the packet leaves outside the tunnel. */
  peer?: string;
  prefix?: string;
}

/** Longest-prefix match over every peer's AllowedIPs. */
export function wgRoute(peers: WgPeer[], dst: string): RouteResult {
  const a = parseIpv4(dst);
  let best: { peer: string; p: Prefix; text: string } | undefined;
  for (const peer of peers)
    for (const c of peer.allowed) {
      const p = parseCidr(c);
      if (inPrefix(a, p.net, p.len) && (!best || p.len > best.p.len)) best = { peer: peer.name, p, text: c };
    }
  return best ? { peer: best.peer, prefix: best.text } : {};
}

/** The receive check: is `innerSrc` allowed for the peer whose key decrypted the packet? */
export function wgAcceptFrom(peer: WgPeer, innerSrc: string): boolean {
  const a = parseIpv4(innerSrc);
  return peer.allowed.some((c) => {
    const p = parseCidr(c);
    return inPrefix(a, p.net, p.len);
  });
}

// ------------------------------------------------------------------ what a VPN hides

export type VpnConfig = "off" | "full" | "split" | "split-leak";
export const VPN_CONFIG_LABEL: Record<VpnConfig, string> = {
  off: "No VPN",
  full: "Full tunnel (0.0.0.0/0)",
  split: "Split: office only, DNS in tunnel",
  "split-leak": "Split: office only, DNS outside",
};

export const VPN_PEERS: Record<VpnConfig, WgPeer[]> = {
  off: [],
  full: [{ name: "vpn", allowed: ["0.0.0.0/0"] }],
  split: [{ name: "vpn", allowed: ["10.0.0.0/8"] }],
  "split-leak": [{ name: "vpn", allowed: ["10.0.0.0/8"] }],
};

export interface Flow {
  id: string;
  label: string;
  dst: string;
  /** The name the user typed. */
  name: string;
  proto: "dns" | "https" | "http";
}

export const FLOWS: Flow[] = [
  { id: "dns", label: "DNS lookup of bank.example", dst: "203.0.113.53", name: "bank.example", proto: "dns" },
  { id: "bank", label: "HTTPS to bank.example", dst: "198.51.100.10", name: "bank.example", proto: "https" },
  { id: "old", label: "Plain HTTP to old.example", dst: "198.51.100.20", name: "old.example", proto: "http" },
  { id: "wiki", label: "HTTP to the office wiki", dst: "10.1.2.3", name: "wiki.office", proto: "http" },
];

/** The DNS resolver the laptop uses: inside the tunnel for "full" and "split", the network's own for the others. */
const resolverFor = (cfg: VpnConfig) => (cfg === "full" || cfg === "split" ? "10.0.0.53" : "203.0.113.53");

export type Observer = "wifi" | "isp" | "vpn" | "site";
export const OBSERVER_LABEL: Record<Observer, string> = { wifi: "Café Wi-Fi", isp: "Your ISP", vpn: "VPN server", site: "The destination" };

export interface Sight {
  /** What this observer learns. */
  text: string;
  /** How much it learns: 0 nothing, 1 only metadata of the tunnel, 2 the destination, 3 the content. */
  level: 0 | 1 | 2 | 3;
}

export function exposureMatrix(cfg: VpnConfig): { flow: Flow; route: RouteResult; dst: string; sights: Record<Observer, Sight> }[] {
  const peers = VPN_PEERS[cfg];
  return FLOWS.map((f) => {
    const dst = f.proto === "dns" ? resolverFor(cfg) : f.dst;
    const route = wgRoute(peers, dst);
    const tunneled = !!route.peer;
    const inner: Sight =
      f.proto === "dns" ? { text: `the name ${f.name} (DNS is plain text)`, level: 3 }
      : f.proto === "https" ? { text: `${dst} and the name ${f.name} (SNI), but not the page`, level: 2 }
      : { text: `${dst} and the whole page`, level: 3 };
    const office = f.dst.startsWith("10.");
    const sights: Record<Observer, Sight> = {
      wifi: tunneled ? { text: "UDP to the VPN server: sizes and timing only", level: 1 } : office ? { text: "nothing: unreachable without the tunnel", level: 0 } : inner,
      isp: tunneled ? { text: "UDP to the VPN server: sizes and timing only", level: 1 } : office ? { text: "nothing", level: 0 } : inner,
      vpn: tunneled ? inner : { text: "nothing: this flow does not use the tunnel", level: 0 },
      site: f.proto === "dns"
        ? { text: tunneled ? `a query from the VPN's address for ${f.name}` : `a query from your address for ${f.name}`, level: 3 }
        : { text: tunneled ? (office ? "a request from your tunnel address" : "a request from the VPN server's address") : "a request from your own address", level: 3 },
    };
    return { flow: { ...f, dst }, route, dst, sights };
  });
}

// ------------------------------------------------------------------ sessions, timers and roaming

export const REKEY_AFTER_TIME = 120, REJECT_AFTER_TIME = 180, REKEY_ATTEMPT_TIME = 90, REKEY_TIMEOUT = 5, KEEPALIVE_TIMEOUT = 10;
export const WG_INIT_BYTES = 148, WG_RESP_BYTES = 92, WG_DATA_OVERHEAD = 32, WG_KEEPALIVE_BYTES = 32;

export type WgKind = "init" | "resp" | "data" | "keepalive";
export interface WgMsg {
  kind: WgKind;
  /** Which network the laptop's side of the packet uses. */
  via: "wifi" | "lte";
  from: "laptop" | "server";
}

export interface WgEvent {
  t: number;
  from: "laptop" | "server";
  kind: WgKind;
  via: "wifi" | "lte";
  /** Arrived (true), or lost and why. */
  ok: boolean;
  why?: string;
}

export interface WgRunOpts {
  /** PersistentKeepalive interval in seconds, 0 for off. */
  persistentKeepalive: number;
  /** Time (s) at which Wi-Fi goes away and the laptop moves to LTE; 0 for never. */
  roamAt: number;
  /** A NAT drops a mapping after this many seconds without outbound packets (a model input). */
  natTimeoutS: number;
  /** The laptop sends a message every this many seconds while it is active (model input). */
  laptopEvery: number;
  /** The laptop is active until this time (s); after that only the server talks. */
  laptopUntil: number;
  /** The server pushes a message every this many seconds (model input). */
  serverEvery: number;
  durationS: number;
}

export const WG_RUN_DEFAULTS: WgRunOpts = { persistentKeepalive: 0, roamAt: 155, natTimeoutS: 30, laptopEvery: 7, laptopUntil: 60, serverEvery: 20, durationS: 300 };

export interface WgRun {
  events: WgEvent[];
  /** Handshake times (s) and who started them. */
  handshakes: { t: number; by: "laptop" | "server" }[];
  pushes: { t: number; ok: boolean }[];
  /** When the server learned each new endpoint. */
  endpointChanges: { t: number; via: "wifi" | "lte" }[];
  sessionAges: [number, number][];
}

const LAPTOP = 0, WIFI = 1, LTE = 2, SERVER = 3;

/**
 * A laptop and a server with one WireGuard session. Time is in seconds here (PacketNet runs in ms underneath).
 * The laptop is the initiator. It sends application messages while active; the server pushes messages all the time.
 */
export function wgSessionRun(opts: Partial<WgRunOpts> = {}): WgRun {
  const o = { ...WG_RUN_DEFAULTS, ...opts };
  const net = new PacketNet<WgMsg>(["laptop", "wifi NAT", "LTE NAT", "server"], { seed: 5, record: false });
  const wifiLink = net.connect(LAPTOP, WIFI, { rate: 50e6, delay: 5 });
  net.connect(LAPTOP, LTE, { rate: 20e6, delay: 25 });
  net.connect(WIFI, SERVER, { rate: 1e9, delay: 10 });
  net.connect(LTE, SERVER, { rate: 1e9, delay: 15 });
  net.computeRoutes();
  const ms = (s: number) => s * 1000;
  const now = () => net.now / 1000;
  const events: WgEvent[] = [], handshakes: WgRun["handshakes"] = [], pushes: WgRun["pushes"] = [], endpointChanges: WgRun["endpointChanges"] = [];
  const sessionAges: [number, number][] = [];
  // NAT state: the last outbound time per network.
  const natOut: Record<"wifi" | "lte", number> = { wifi: -1e9, lte: -1e9 };
  let iface: "wifi" | "lte" = "wifi";
  let endpoint: "wifi" | "lte" | undefined; // the server's view of the laptop
  // Session state (shared keys; each side tracks its own timers).
  let session: { start: number } | undefined;
  let pendingInit: { firstAt: number; lastAt: number; by: "laptop" | "server" } | undefined;
  const side = {
    // keepaliveDue: data arrived and nothing went back yet. silentSince: data went out and nothing came back yet.
    laptop: { lastSent: -1e9, queue: 0, keepaliveDue: undefined as number | undefined, silentSince: undefined as number | undefined },
    server: { lastSent: -1e9, queue: 0, keepaliveDue: undefined as number | undefined, silentSince: undefined as number | undefined },
  };
  const gwOf = (v: "wifi" | "lte") => (v === "wifi" ? WIFI : LTE);
  const size = (k: WgKind) => 28 + (k === "init" ? WG_INIT_BYTES : k === "resp" ? WG_RESP_BYTES : k === "keepalive" ? WG_KEEPALIVE_BYTES : WG_DATA_OVERHEAD + 120);
  const sendFrom = (from: "laptop" | "server", kind: WgKind) => {
    const s = side[from];
    s.lastSent = now();
    s.keepaliveDue = undefined;
    if (kind === "data" && s.silentSince === undefined) s.silentSince = now();
    if (from === "laptop") {
      const via = iface;
      natOut[via] = now();
      const pkt = net.packet(LAPTOP, SERVER, size(kind), { kind, via, from });
      const port = net.portTo(LAPTOP, gwOf(via));
      if (!port.up) {
        events.push({ t: now(), from, kind, via, ok: false, why: "link down" });
        return;
      }
      net.transmit(port.id, pkt);
    } else {
      if (!endpoint) return;
      const via = endpoint;
      net.transmit(net.portTo(SERVER, gwOf(via)).id, net.packet(SERVER, LAPTOP, size(kind), { kind, via, from }));
    }
  };
  const valid = () => session !== undefined && now() - session.start < REJECT_AFTER_TIME;
  const initiate = (by: "laptop" | "server") => {
    if (pendingInit && now() - pendingInit.lastAt < REKEY_TIMEOUT) return;
    if (by === "server" && !endpoint) return;
    pendingInit = pendingInit && pendingInit.by === by ? { ...pendingInit, lastAt: now() } : { firstAt: now(), lastAt: now(), by };
    sendFrom(by, "init");
  };
  const appSend = (from: "laptop" | "server") => {
    const s = side[from];
    if (!valid()) {
      s.queue++;
      initiate(from);
      return false;
    }
    sendFrom(from, "data");
    // The initiator of the session rekeys after Rekey-After-Time when it sends.
    if (from === "laptop" && now() - session!.start >= REKEY_AFTER_TIME) initiate("laptop");
    return true;
  };
  net.setHandlers({
    onReceive(node, pkt) {
      // The NATs: outbound always passes; inbound only while the mapping is fresh.
      if ((node === WIFI || node === LTE) && pkt.src === SERVER) {
        const via = node === WIFI ? "wifi" : "lte";
        if (now() - natOut[via] > o.natTimeoutS) {
          events.push({ t: now(), from: "server", kind: pkt.payload.kind, via, ok: false, why: "NAT mapping expired" });
          if (pkt.payload.kind === "data") pushes[pushes.length - 1]!.ok = false;
          return true;
        }
        if (!net.portTo(node, LAPTOP).up) {
          events.push({ t: now(), from: "server", kind: pkt.payload.kind, via, ok: false, why: "the laptop left this network" });
          if (pkt.payload.kind === "data") pushes[pushes.length - 1]!.ok = false;
          return true;
        }
      }
      return false;
    },
    onDeliver(node, pkt) {
      const m = pkt.payload;
      events.push({ t: now(), from: m.from, kind: m.kind, via: m.via, ok: true });
      const me = node === LAPTOP ? "laptop" : "server";
      const s = side[me];
      s.silentSince = undefined;
      if (me === "server" && endpoint !== m.via) {
        endpoint = m.via;
        endpointChanges.push({ t: now(), via: m.via });
      }
      if (m.kind === "init") {
        sendFrom(me, "resp");
        session = { start: now() };
        handshakes.push({ t: now(), by: m.from });
        pendingInit = undefined;
      } else if (m.kind === "resp") {
        session = { start: now() };
        pendingInit = undefined;
        // Flush the queue; the initiator must send first so the responder can use the session.
        const q = s.queue;
        s.queue = 0;
        if (q) for (let i = 0; i < q; i++) sendFrom(me, "data");
        else sendFrom(me, "keepalive");
      } else if (m.kind === "data") {
        if (s.keepaliveDue === undefined) s.keepaliveDue = now() + KEEPALIVE_TIMEOUT;
        // The receiver of data starts a new handshake when the session nears Reject-After-Time.
        if (session && now() - session.start >= REJECT_AFTER_TIME - KEEPALIVE_TIMEOUT - REKEY_TIMEOUT) initiate(me);
      }
      if (me === "laptop" && m.kind === "data") pushes[pushes.length - 1]!.ok = true;
    },
  });
  // A tick every 100 ms runs the timers of both sides.
  const TICK = 0.1;
  for (let k = 0; k * TICK <= o.durationS; k++) {
    net.at(ms(k * TICK), () => {
      for (const who of ["laptop", "server"] as const) {
        const s = side[who];
        if (valid() && s.keepaliveDue !== undefined && now() >= s.keepaliveDue) sendFrom(who, "keepalive");
        if (s.silentSince !== undefined && now() - s.silentSince >= KEEPALIVE_TIMEOUT + REKEY_TIMEOUT && !pendingInit) {
          s.silentSince = undefined;
          initiate(who);
        }
        if (who === "laptop" && o.persistentKeepalive > 0 && now() - s.lastSent >= o.persistentKeepalive && session) sendFrom(who, valid() ? "keepalive" : "init");
        if (pendingInit && pendingInit.by === who && now() - pendingInit.lastAt >= REKEY_TIMEOUT) {
          if (now() - pendingInit.firstAt < REKEY_ATTEMPT_TIME) {
            pendingInit.lastAt = now();
            sendFrom(who, "init");
          } else pendingInit = undefined;
        }
      }
      if (k % 10 === 0) sessionAges.push([k * TICK, session ? k * TICK - session.start : -1]);
    });
  }
  for (let t = 1; t < Math.min(o.laptopUntil, o.durationS); t += o.laptopEvery) net.at(ms(t), () => appSend("laptop"));
  for (let t = 3; t < o.durationS; t += o.serverEvery)
    net.at(ms(t), () => {
      pushes.push({ t: now(), ok: false });
      appSend("server");
    });
  if (o.roamAt > 0)
    net.at(ms(o.roamAt), () => {
      net.setLinkUp(wifiLink, false);
      iface = "lte";
    });
  net.runUntil(ms(o.durationS) + 1000);
  return { events, handshakes, pushes, endpointChanges, sessionAges };
}
