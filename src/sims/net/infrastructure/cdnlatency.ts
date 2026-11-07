/**
 * Where the time goes when a page comes from a CDN: a client, an edge server near it, and a far origin, on PacketNet.
 *
 * Each setup is a script of messages. A message leaves as soon as the messages it waits for have arrived. The time to
 * the first byte of the response (TTFB) falls out of the run. All setups use the same two links (client–edge and
 * edge–origin); without a CDN the edge node is only a router on the path.
 *
 * - "direct": no CDN. TCP and TLS run end to end with the origin.
 * - "hit": the edge ends TCP and TLS and has the object.
 * - "miss-warm": the edge ends TCP and TLS, misses, and sends the request on a connection to the origin that is
 *   already open (connection reuse).
 * - "miss-cold": the same, but the edge must first open TCP and TLS to the origin.
 *
 * Labels are short for diagrams: "Hello" is the ClientHello (with TCP's ACK), "Hello…Fin" is the server's flight from
 * ServerHello to Finished, "Fin, GET" is the client's Finished with the request.
 *
 * Model inputs: the two RTTs, message sizes, no processing time. TLS 1.3 needs one round trip after TCP's; TLS 1.2
 * (full handshake) needs two.
 */
import { PacketNet } from "../packet";

export type CdnPath = "direct" | "hit" | "miss-warm" | "miss-cold";
export const CDN_PATHS: CdnPath[] = ["direct", "hit", "miss-warm", "miss-cold"];
export const CDN_PATH_LABEL: Record<CdnPath, string> = { direct: "no CDN", hit: "edge hit", "miss-warm": "miss, warm origin connection", "miss-cold": "miss, new origin connection" };

export type TlsVersion = "1.3" | "1.2";

export const CDN_NODES = { client: 0, edge: 1, origin: 2 } as const;

interface Step {
  id: string;
  from: number;
  to: number;
  label: string;
  bytes: number;
  after: string[];
  response?: boolean;
}

export interface CdnMsg {
  id: string;
  label: string;
}

/** TCP and TLS setup between a and b, then a request: the steps, with ids prefixed by `p`. */
function handshake(p: string, a: number, b: number, tls: TlsVersion, after: string[]): Step[] {
  const s = (id: string, from: number, to: number, label: string, bytes: number, aft: string[]): Step => ({ id: p + id, from, to, label, bytes, after: aft });
  const out = [s("syn", a, b, "SYN", 60, after), s("synack", b, a, "SYN-ACK", 60, [p + "syn"]), s("ch", a, b, "Hello", 300, [p + "synack"])];
  if (tls === "1.3") out.push(s("sh", b, a, "Hello…Fin", 3000, [p + "ch"]));
  else out.push(s("sh", b, a, "Hello, Cert", 3000, [p + "ch"]), s("cke", a, b, "Key, Fin", 200, [p + "sh"]), s("sfin", b, a, "Fin", 100, [p + "cke"]));
  return out;
}

export function cdnScript(path: CdnPath, tls: TlsVersion): Step[] {
  const { client: C, edge: E, origin: O } = CDN_NODES;
  const hs = handshake("c.", C, path === "direct" ? O : E, tls, []);
  const ready = hs[hs.length - 1]!.id;
  const req = (id: string, from: number, to: number, after: string[]): Step => ({ id, from, to, label: tls === "1.3" ? "Fin, GET" : "GET", bytes: 250, after });
  const resp = (id: string, from: number, to: number, after: string[], response = false): Step => ({ id, from, to, label: "200", bytes: 1400, after, response });
  switch (path) {
    case "direct":
      return [...hs, req("req", C, O, [ready]), resp("resp", O, C, ["req"], true)];
    case "hit":
      return [...hs, req("req", C, E, [ready]), resp("resp", E, C, ["req"], true)];
    case "miss-warm":
      return [...hs, req("req", C, E, [ready]), { ...req("oreq", E, O, ["req"]), label: "GET" }, resp("oresp", O, E, ["oreq"]), resp("resp", E, C, ["oresp"], true)];
    case "miss-cold": {
      const ohs = handshake("o.", E, O, tls, ["req"]);
      return [...hs, req("req", C, E, [ready]), ...ohs, req("oreq", E, O, [ohs[ohs.length - 1]!.id]), resp("oresp", O, E, ["oreq"]), resp("resp", E, C, ["oresp"], true)];
    }
  }
}

export interface CdnLatencyOpts {
  path: CdnPath;
  tls?: TlsVersion;
  /** Client–edge round trip, ms (model input). */
  edgeRtt: number;
  /** Edge–origin round trip, ms. */
  originRtt: number;
  record?: boolean;
}

export interface CdnLatencyRun {
  net: PacketNet<CdnMsg>;
  ttfbMs: number;
  /** Round trips on each link that the client waited for. */
  steps: Step[];
}

export function cdnLatencyRun(o: CdnLatencyOpts): CdnLatencyRun {
  const tls = o.tls ?? "1.3";
  const steps = cdnScript(o.path, tls);
  const { client: C, edge: E, origin: O } = CDN_NODES;
  const net = new PacketNet<CdnMsg>(["client", "edge", "origin"], { seed: 1, record: o.record ?? true });
  net.connect(C, E, { rate: 1e9, delay: o.edgeRtt / 2 });
  net.connect(E, O, { rate: 1e9, delay: o.originRtt / 2 });
  net.computeRoutes();
  const arrived = new Set<string>(), sent = new Set<string>();
  let ttfb = NaN;
  const pump = () => {
    for (const s of steps) {
      if (sent.has(s.id) || !s.after.every((a) => arrived.has(a))) continue;
      sent.add(s.id);
      net.send(s.from, s.to, s.bytes, { id: s.id, label: s.label });
    }
  };
  net.setHandlers({
    onDeliver: (_n, pkt) => {
      arrived.add(pkt.payload.id);
      if (steps.find((s) => s.id === pkt.payload.id)?.response) ttfb = net.now;
      pump();
    },
  });
  pump();
  net.runAll();
  return { net, ttfbMs: ttfb, steps };
}

/** Round trips before the first byte, in closed form: handshake RTTs (TCP 1, TLS 1.3 1, TLS 1.2 2) plus the request. */
export function cdnTtfbFormula(path: CdnPath, tls: TlsVersion, edgeRtt: number, originRtt: number): number {
  const hs = tls === "1.3" ? 2 : 3;
  switch (path) {
    case "direct": return (hs + 1) * (edgeRtt + originRtt);
    case "hit": return (hs + 1) * edgeRtt;
    case "miss-warm": return (hs + 1) * edgeRtt + originRtt;
    case "miss-cold": return (hs + 1) * edgeRtt + (hs + 1) * originRtt;
  }
}
