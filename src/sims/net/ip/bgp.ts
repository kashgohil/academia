/**
 * BGP between autonomous systems (ASes): the decision process at one router (RFC 4271, section 9.1), and route
 * propagation through an AS graph with business policy (Gao and Rexford, 2001), hijacks, leaks and RPKI route
 * origin validation (RFC 6811).
 *
 * Propagation works at the level of ASes, one best route per AS and prefix. It runs in rounds: every AS reads its
 * neighbours' best routes from the last round, filters them, and picks its own best. This is a model without links
 * or queues, so it does not use PacketNet; timing (MRAI, path exploration) is out of its scope.
 */
import { inPrefix } from "../bytes";
import { contains, formatCidr, type Prefix } from "./cidr";

// ---------------------------------------------------------------- the decision process at one router

export type Origin = "IGP" | "EGP" | "INCOMPLETE";
const ORIGIN_RANK: Record<Origin, number> = { IGP: 0, EGP: 1, INCOMPLETE: 2 };

export interface Candidate {
  name: string;
  localPref: number;
  asPath: number[];
  origin: Origin;
  med: number;
  ebgp: boolean;
  /** IGP cost to the NEXT_HOP. */
  igpCost: number;
  /** The BGP Identifier of the peer, as a number (an IPv4 address). */
  routerId: number;
}

export interface DecisionStep {
  rule: string;
  /** The candidates still in the race after this rule. */
  left: number[];
  /** Candidates this rule removed. */
  removed: number[];
}

/**
 * The order of RFC 4271: highest LOCAL_PREF (9.1.1), then the tie-breakers of 9.1.2.2: shortest AS_PATH, lowest
 * ORIGIN, lowest MED among routes from the same neighbour AS, eBGP over iBGP, lowest IGP cost to the next hop,
 * lowest BGP Identifier. (Vendors add steps, such as Cisco's weight, before these.)
 */
export function bgpDecision(c: Candidate[]): { steps: DecisionStep[]; winner: number } {
  let left = c.map((_, i) => i);
  const steps: DecisionStep[] = [];
  const keepMin = (rule: string, key: (x: Candidate) => number) => {
    const m = Math.min(...left.map((i) => key(c[i]!)));
    const next = left.filter((i) => key(c[i]!) === m);
    steps.push({ rule, left: next, removed: left.filter((i) => !next.includes(i)) });
    left = next;
  };
  keepMin("highest LOCAL_PREF", (x) => -x.localPref);
  keepMin("shortest AS_PATH", (x) => x.asPath.length);
  keepMin("lowest ORIGIN (IGP < EGP < INCOMPLETE)", (x) => ORIGIN_RANK[x.origin]);
  {
    // MED compares only routes from the same neighbour AS (the first AS in the path).
    const nb = (x: Candidate) => x.asPath[0] ?? -1;
    const next = left.filter((i) => !left.some((j) => nb(c[j]!) === nb(c[i]!) && c[j]!.med < c[i]!.med));
    steps.push({ rule: "lowest MED, among routes from the same neighbour AS", left: next, removed: left.filter((i) => !next.includes(i)) });
    left = next;
  }
  keepMin("eBGP over iBGP", (x) => (x.ebgp ? 0 : 1));
  keepMin("lowest IGP cost to the next hop", (x) => x.igpCost);
  keepMin("lowest BGP Identifier", (x) => x.routerId);
  return { steps, winner: left[0]! };
}

// ---------------------------------------------------------------- an AS graph with policy

export interface AsNode {
  asn: number;
  name: string;
  tier: 1 | 2 | 3;
  x: number;
  y: number;
}

/** c2p: `a` is a customer of `b` (b sells transit to a). p2p: settlement-free peers. */
export interface AsLink {
  a: number;
  b: number;
  kind: "c2p" | "p2p";
}

export interface AsGraph {
  nodes: AsNode[];
  links: AsLink[];
}

export type Rel = "self" | "customer" | "peer" | "provider";
/** LOCAL_PREF as policy sets it: money in (customer) beats free (peer) beats money out (provider). */
export const REL_PREF: Record<Rel, number> = { self: 400, customer: 300, peer: 200, provider: 100 };

export interface Announcement {
  /** The AS that sends it. */
  by: number;
  prefix: Prefix;
  /** The path the sender claims behind itself. A forged-origin hijack claims [victim]. */
  claim?: number[];
}

export interface Roa {
  prefix: Prefix;
  maxLength: number;
  asn: number;
}

export type RovState = "valid" | "invalid" | "notfound";

/** Route origin validation (RFC 6811): NotFound without a covering ROA; Valid if one ROA matches origin and length. */
export function rov(roas: Roa[], prefix: Prefix, originAs: number): RovState {
  const covering = roas.filter((r) => contains(r.prefix, prefix));
  if (!covering.length) return "notfound";
  return covering.some((r) => r.asn === originAs && prefix.len <= r.maxLength) ? "valid" : "invalid";
}

export interface BgpRoute {
  prefix: Prefix;
  /** The AS_PATH as this AS received it: the neighbour first, the origin last. Empty for its own prefix. */
  path: number[];
  /** The neighbour it came from (null: originated here). */
  from: number | null;
  rel: Rel;
}

export interface BgpOptions {
  /** ASes that drop RPKI-invalid routes. */
  rovAses?: Set<number>;
  roas?: Roa[];
  /** ASes that break the export rule and send every route to every neighbour. */
  leakers?: Set<number>;
  /** Drop IPv4 prefixes longer than /24, as most networks do (RFC 7454, section 6.1.3). */
  maxLen24?: boolean;
}

export interface BgpState {
  graph: AsGraph;
  /** best[asn] maps a prefix key to the best route. */
  best: Map<number, Map<string, BgpRoute>>;
  rounds: number;
  /** Changes of a best route, summed over ASes: each one is an UPDATE sent to the neighbours. */
  changes: number;
  /** Routes that ROV dropped, per AS. */
  rovDropped: Map<number, number>;
}

const key = (p: Prefix) => formatCidr(p);

/** The relationship of neighbour `nb` from the point of view of `me`. */
export function relOf(g: AsGraph, me: number, nb: number): Rel | null {
  for (const l of g.links) {
    if (l.kind === "p2p" && ((l.a === me && l.b === nb) || (l.a === nb && l.b === me))) return "peer";
    if (l.kind === "c2p" && l.a === me && l.b === nb) return "provider";
    if (l.kind === "c2p" && l.a === nb && l.b === me) return "customer";
  }
  return null;
}

export const neighbours = (g: AsGraph, me: number) =>
  g.links.flatMap((l) => (l.a === me ? [l.b] : l.b === me ? [l.a] : [])).sort((a, b) => a - b);

/** The Gao-Rexford export rule: routes from customers (and your own) go to everyone; others only to customers. */
export const mayExport = (r: BgpRoute, toRel: Rel) => r.rel === "self" || r.rel === "customer" || toRel === "customer";

const better = (a: BgpRoute, b: BgpRoute) =>
  REL_PREF[a.rel] !== REL_PREF[b.rel] ? REL_PREF[a.rel] > REL_PREF[b.rel] : a.path.length !== b.path.length ? a.path.length < b.path.length : (a.from ?? -1) < (b.from ?? -1);

export function propagate(g: AsGraph, anns: Announcement[], o: BgpOptions = {}): BgpState {
  const best = new Map<number, Map<string, BgpRoute>>(g.nodes.map((n) => [n.asn, new Map()]));
  const prefixes = new Map<string, Prefix>();
  for (const a of anns) prefixes.set(key(a.prefix), a.prefix);
  const own = new Map<number, Map<string, BgpRoute>>();
  for (const a of anns) {
    if (!own.has(a.by)) own.set(a.by, new Map());
    own.get(a.by)!.set(key(a.prefix), { prefix: a.prefix, path: a.claim ?? [], from: null, rel: "self" });
  }
  const rovDropped = new Map<number, number>();
  let rounds = 0, changes = 0;
  for (; rounds < 60; rounds++) {
    const prev = new Map([...best].map(([k, v]) => [k, new Map(v)]));
    let changed = false;
    for (const n of g.nodes) {
      const me = n.asn;
      const mine = prev.get(me)!;
      for (const [pk, prefix] of prefixes) {
        let pick: BgpRoute | undefined = own.get(me)?.get(pk);
        for (const nb of neighbours(g, me)) {
          const r = prev.get(nb)!.get(pk);
          if (!r) continue;
          const nbSeesMe = relOf(g, nb, me)!;
          if (!mayExport(r, nbSeesMe) && !o.leakers?.has(nb)) continue;
          const path = [nb, ...r.path];
          if (path.includes(me)) continue; // loop prevention
          if (o.maxLen24 && prefix.len > 24) continue;
          if (o.rovAses?.has(me) && rov(o.roas ?? [], prefix, path[path.length - 1]!) === "invalid") continue;
          const cand: BgpRoute = { prefix, path, from: nb, rel: relOf(g, me, nb)! };
          if (!pick || better(cand, pick)) pick = cand;
        }
        const cur = mine.get(pk);
        const same = cur && pick && cur.from === pick.from && cur.path.join() === pick.path.join();
        if (!same && (cur || pick)) {
          changed = true;
          changes++;
          if (pick) best.get(me)!.set(pk, pick);
          else best.get(me)!.delete(pk);
        }
      }
    }
    if (!changed) break;
  }
  // Count, per ROV AS, the invalid routes it refuses in the final state.
  if (o.rovAses) {
    for (const me of o.rovAses) {
      let k = 0;
      for (const [pk, prefix] of prefixes) {
        for (const nb of neighbours(g, me)) {
          const r = best.get(nb)!.get(pk);
          if (!r || (!mayExport(r, relOf(g, nb, me)!) && !o.leakers?.has(nb))) continue;
          const path = [nb, ...r.path];
          if (!path.includes(me) && rov(o.roas ?? [], prefix, path[path.length - 1]!) === "invalid") k++;
        }
      }
      rovDropped.set(me, k);
    }
  }
  return { graph: g, best, rounds, changes, rovDropped };
}

export interface Walk {
  path: number[];
  /** The AS where the packet ends: the AS that originated the route it followed. */
  end: number | null;
  fate: "arrived" | "no route" | "loop";
}

/** Follows packets for `addr` from `from`: every AS uses its own longest matching prefix (data plane). */
export function walk(s: BgpState, from: number, addr: number): Walk {
  const path = [from];
  let at = from;
  for (let k = 0; k < 32; k++) {
    let r: BgpRoute | undefined;
    for (const x of s.best.get(at)!.values()) if (inPrefix(addr, x.prefix.net, x.prefix.len) && (!r || x.prefix.len > r.prefix.len)) r = x;
    if (!r) return { path, end: null, fate: "no route" };
    if (r.from === null) return { path, end: at, fate: "arrived" };
    at = r.from;
    if (path.includes(at)) return { path: [...path, at], end: null, fate: "loop" };
    path.push(at);
  }
  return { path, end: null, fate: "loop" };
}

/** A path is valley-free if it climbs customer→provider links, crosses at most one peer link, then only descends. */
export function valleyFree(g: AsGraph, path: number[]): boolean {
  let phase = 0; // 0 climbing, 1 after the peak
  for (let i = 0; i + 1 < path.length; i++) {
    const r = relOf(g, path[i]!, path[i + 1]!);
    if (r === "provider") { if (phase > 0) return false; }
    else if (r === "peer") { if (phase > 0) return false; phase = 1; }
    else phase = 1;
  }
  return true;
}

// ---------------------------------------------------------------- the scenario graph of the lesson

export const VICTIM = 6;
export const ATTACKER = 10;
export const LEAKER = 12;

/** Twelve made-up ASes: two tier-1 networks, three regional transit networks, and seven customer networks. */
export const LESSON_GRAPH: AsGraph = {
  nodes: [
    { asn: 1, name: "AS1", tier: 1, x: 0.33, y: 0.08 },
    { asn: 2, name: "AS2", tier: 1, x: 0.67, y: 0.08 },
    { asn: 3, name: "AS3", tier: 2, x: 0.15, y: 0.45 },
    { asn: 4, name: "AS4", tier: 2, x: 0.5, y: 0.45 },
    { asn: 5, name: "AS5", tier: 2, x: 0.85, y: 0.45 },
    { asn: 6, name: "AS6", tier: 3, x: 0.04, y: 0.9 },
    { asn: 7, name: "AS7", tier: 3, x: 0.2, y: 0.9 },
    { asn: 8, name: "AS8", tier: 3, x: 0.5, y: 0.9 },
    { asn: 9, name: "AS9", tier: 3, x: 0.66, y: 0.9 },
    { asn: 10, name: "AS10", tier: 3, x: 0.96, y: 0.9 },
    { asn: 11, name: "AS11", tier: 3, x: 0.81, y: 0.9 },
    { asn: 12, name: "AS12", tier: 3, x: 0.35, y: 0.9 },
  ],
  links: [
    { a: 1, b: 2, kind: "p2p" },
    { a: 3, b: 1, kind: "c2p" }, { a: 4, b: 1, kind: "c2p" }, { a: 4, b: 2, kind: "c2p" }, { a: 5, b: 2, kind: "c2p" },
    { a: 3, b: 4, kind: "p2p" },
    { a: 6, b: 3, kind: "c2p" }, { a: 7, b: 3, kind: "c2p" }, { a: 8, b: 4, kind: "c2p" }, { a: 9, b: 5, kind: "c2p" },
    { a: 10, b: 5, kind: "c2p" }, { a: 11, b: 5, kind: "c2p" },
    { a: 12, b: 3, kind: "c2p" }, { a: 12, b: 4, kind: "c2p" },
  ],
};

export type Scenario = "normal" | "hijack" | "subprefix" | "forged" | "leak";

export const VICTIM_PREFIX: Prefix = { net: 0xc6336400, len: 22 }; // 198.51.100.0/22 (made up for the model)
export const SUB_PREFIX: Prefix = { net: 0xc6336400, len: 24 }; // 198.51.100.0/24
export const TARGET_ADDR = 0xc633640a; // 198.51.100.10

export function scenarioAnnouncements(s: Scenario): Announcement[] {
  const base: Announcement[] = [{ by: VICTIM, prefix: VICTIM_PREFIX }];
  if (s === "hijack") base.push({ by: ATTACKER, prefix: VICTIM_PREFIX });
  if (s === "subprefix") base.push({ by: ATTACKER, prefix: SUB_PREFIX });
  if (s === "forged") base.push({ by: ATTACKER, prefix: SUB_PREFIX, claim: [VICTIM] });
  return base;
}

export interface ScenarioResult {
  state: BgpState;
  walks: Map<number, Walk>;
  /** ASes (other than the two ends) whose traffic for the target address reaches the attacker. */
  captured: number;
  /** ASes whose traffic for the target goes through the leaker. */
  viaLeaker: number;
  reachVictim: number;
}

export function runScenario(s: Scenario, rovAses: Set<number>, maxLength = 22, maxLen24 = true): ScenarioResult {
  const roas: Roa[] = [{ prefix: VICTIM_PREFIX, maxLength, asn: VICTIM }];
  const state = propagate(LESSON_GRAPH, scenarioAnnouncements(s), { rovAses, roas, leakers: s === "leak" ? new Set([LEAKER]) : undefined, maxLen24 });
  const walks = new Map<number, Walk>();
  let captured = 0, viaLeaker = 0, reachVictim = 0;
  for (const n of LESSON_GRAPH.nodes) {
    const w = walk(state, n.asn, TARGET_ADDR);
    walks.set(n.asn, w);
    if (n.asn === VICTIM || n.asn === ATTACKER || n.asn === LEAKER) continue;
    if (w.end === ATTACKER) captured++;
    if (w.end === VICTIM) reachVictim++;
    if (w.path.includes(LEAKER)) viaLeaker++;
  }
  return { state, walks, captured, viaLeaker, reachVictim };
}
