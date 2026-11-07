/**
 * Cache poisoning in the style of Kaminsky (2008), on PacketNet.
 *
 * A resolver accepts the first UDP reply that matches its query: the same question, from the server's address,
 * to the source port it used, with the same 16-bit ID. An off-path attacker cannot see the query, so it guesses.
 *
 * - One **race**: the attacker asks the resolver for a fresh random name (r123.example.com), so the name is never
 *   in the cache. The resolver queries example.com's server. Until the real reply arrives (one RTT), the attacker
 *   floods the resolver with forged replies that carry guessed IDs (and guessed ports, if the resolver randomizes
 *   them). A forged reply carries a referral: "example.com NS ns1.example.com, ns1.example.com A <attacker>".
 *   If one matches, the resolver caches the attacker's server for the whole zone.
 * - Before 2008, a failed race on www.example.com had to wait for the real answer's TTL to run out. Random names
 *   remove the wait: the attacker can race again at once.
 * - Defences: a random source port per query (about 16 more bits, RFC 5452), and DNSSEC, which makes a forged
 *   referral fail validation.
 *
 * Model inputs: the attacker's bandwidth, the RTT from the resolver to example.com's server, and the port pool
 * (Linux's default ephemeral range 32768..60999 is 28,232 ports).
 */
import { PacketNet } from "../packet";
import { mulberry32 } from "../../rng";
import { messageSize, type DnsMessage } from "./dns-msg";
import { UDP_IP_BYTES } from "./dns-resolve";

export const ID_SPACE = 65536;
/** Linux net.ipv4.ip_local_port_range default: 32768..60999. */
export const LINUX_PORTS = 60999 - 32768 + 1;

/** The forged reply: a referral for example.com that points at the attacker's address. */
export function forgedReply(id: number, name = "r4711.example.com"): DnsMessage {
  return {
    id, flags: { qr: true, opcode: 0, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: 0 },
    question: [{ name, type: "A" }], answer: [],
    authority: [{ name: "example.com", ttl: 172800, data: { t: "NS", host: "ns1.example.com" } }],
    additional: [{ name: "ns1.example.com", ttl: 172800, data: { t: "A", addr: "203.0.113.66" } }],
  };
}

export const FORGED_BYTES = messageSize(forgedReply(0)) + UDP_IP_BYTES;

export interface PoisonOpts {
  /** Attacker bandwidth in Mbit/s. */
  attackerMbps: number;
  /** RTT between the resolver and example.com's server, in ms: the window of one race. */
  rttMs: number;
  randomPorts: boolean;
  dnssec?: boolean;
  /** Ports the resolver draws from when it randomizes. */
  ports?: number;
}

export interface PoisonOdds {
  /** Forged replies that fit in one race window. */
  forgedPerRace: number;
  guessSpace: number;
  /** Probability that one race succeeds. */
  pRace: number;
  expectedRaces: number;
  /** Expected time to success, in seconds (one race per RTT). */
  expectedSeconds: number;
  /** Before 2008: one race per TTL of the real answer (in seconds). */
  expectedSecondsOldStyle: (ttl: number) => number;
}

export function poisonOdds(o: PoisonOpts): PoisonOdds {
  const forgedPerRace = Math.floor((o.attackerMbps * 1e6 * (o.rttMs / 1000)) / (FORGED_BYTES * 8));
  const guessSpace = ID_SPACE * (o.randomPorts ? (o.ports ?? LINUX_PORTS) : 1);
  const pRace = o.dnssec ? 0 : Math.min(1, forgedPerRace / guessSpace);
  const expectedRaces = pRace > 0 ? 1 / pRace : Infinity;
  return {
    forgedPerRace, guessSpace, pRace, expectedRaces, expectedSeconds: (expectedRaces * o.rttMs) / 1000,
    expectedSecondsOldStyle: (ttl) => expectedRaces * ttl,
  };
}

/** Races until one succeeds, with seeded random IDs and ports. Gives up after `maxRaces`. */
export function campaign(o: PoisonOpts & { seed?: number; maxRaces?: number }): { races: number; success: boolean; seconds: number } {
  const odds = poisonOdds(o);
  const rng = mulberry32(o.seed ?? 7);
  const max = o.maxRaces ?? 1e6;
  if (odds.pRace === 0) return { races: max, success: false, seconds: (max * o.rttMs) / 1000 };
  for (let k = 1; k <= max; k++) {
    // The attacker sends F distinct guesses from a random start; the resolver's (port, ID) pair is uniform.
    const secret = Math.floor(rng() * odds.guessSpace);
    const start = Math.floor(rng() * odds.guessSpace);
    if ((secret - start + odds.guessSpace) % odds.guessSpace < odds.forgedPerRace) return { races: k, success: true, seconds: (k * o.rttMs) / 1000 };
  }
  return { races: max, success: false, seconds: (max * o.rttMs) / 1000 };
}

export type RacePayload = { kind: "trigger" | "query" | "real" | "forged"; id: number; port: number; match?: boolean };

export const RACE_NODES = ["attacker", "resolver", "server"];

export interface RaceRun {
  net: PacketNet<RacePayload>;
  /** Which reply the resolver accepted. */
  accepted?: RacePayload & { t: number };
  forgedSent: number;
  /** Shown forged packets (the run sends a sample, `show`, so the diagram stays readable). */
  secret: { id: number; port: number };
}

/**
 * One race on PacketNet. The attacker sends `show` forged replies, evenly over the window, from its pool of
 * `forgedPerRace` guesses; `hit` makes one of them carry the right ID and port (to show what success looks like).
 */
export function raceRun(o: PoisonOpts & { seed?: number; show?: number; hit?: boolean }): RaceRun {
  const odds = poisonOdds(o);
  const net = new PacketNet<RacePayload>(RACE_NODES, { seed: o.seed ?? 3, record: true });
  const A = 0, R = 1, S = 2;
  net.connect(A, R, { rate: o.attackerMbps * 1e6, delay: 5 });
  net.connect(R, S, { rate: 100e6, delay: o.rttMs / 2 });
  net.computeRoutes();
  const secret = { id: Math.floor(net.random() * ID_SPACE), port: o.randomPorts ? 32768 + Math.floor(net.random() * (o.ports ?? LINUX_PORTS)) : 53 };
  const show = Math.min(o.show ?? 12, odds.forgedPerRace);
  let accepted: RaceRun["accepted"];
  net.setHandlers({
    onDeliver(node, pkt) {
      const p = pkt.payload;
      if (node === R && p.kind === "trigger") {
        net.send(R, S, 60 + UDP_IP_BYTES, { kind: "query", id: secret.id, port: secret.port });
        // The attacker cannot see the query; it starts its flood when it expects the query to be out.
        for (let i = 0; i < show; i++) {
          const right = !!o.hit && i === Math.floor(show / 2);
          const id = right ? secret.id : (secret.id + 1 + Math.floor(net.random() * (ID_SPACE - 1))) % ID_SPACE;
          const port = right || !o.randomPorts ? secret.port : 32768 + Math.floor(net.random() * (o.ports ?? LINUX_PORTS));
          net.at(net.now + (i * (o.rttMs - 6)) / show, () => net.send(A, R, FORGED_BYTES, { kind: "forged", id, port }));
        }
      } else if (node === S && p.kind === "query") {
        net.send(S, R, 120 + UDP_IP_BYTES, { kind: "real", id: p.id, port: p.port });
      } else if (node === R && (p.kind === "real" || p.kind === "forged")) {
        p.match = p.id === secret.id && p.port === secret.port;
        if (!accepted && p.match && !(o.dnssec && p.kind === "forged")) accepted = { ...p, t: net.now };
      }
    },
  });
  net.send(A, R, 60 + UDP_IP_BYTES, { kind: "trigger", id: 0, port: 0 });
  net.runAll();
  return { net, accepted, forgedSent: odds.forgedPerRace, secret };
}
