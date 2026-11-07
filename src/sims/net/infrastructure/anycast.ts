/**
 * IP anycast: one prefix announced from several sites, routed by BGP with Gao-Rexford policy.
 *
 * The world model is a made-up AS graph with real city positions: three global carriers (tier 1), regional transit
 * networks, access ISPs where users live, and five sites of one anycast operator. Each site is its own node here;
 * real sites usually share one AS number, and loop prevention then stops a site from learning the prefix from
 * another site, which changes nothing for the users.
 *
 * Propagation works as in the BGP lesson (../ip/bgp.ts): every AS keeps one best route, prefers customer routes, then
 * peer routes, then provider routes, then the shortest AS path, then the lowest neighbour AS number (a stand-in for
 * the router-ID tie-break). It exports by the Gao-Rexford rule. A site can prepend its own number to make its routes
 * longer, and can announce with NO_EXPORT (RFC 1997): its neighbours use the route but pass it on to nobody, which is
 * how RFC 4786 suggests building a local-scope node.
 *
 * Distance and latency: each AS sits in one city (a model input). As in measurement studies of anycast, the cost of a
 * choice is the distance from the user's city to the site's city, against the nearest site that announces. The RTT
 * is the great-circle fiber RTT to the site: a lower bound, since real paths are longer.
 *
 * In the model each AS is one router, so a tie between two equally good routes falls to the lowest neighbour number.
 * A real carrier with routers in many cities breaks such ties per router, by the nearest exit (hot-potato routing).
 * The rules before the tie-break (local preference, then path length) ignore distance in both.
 */
import { REL_PREF, mayExport, neighbours, relOf, type AsGraph, type AsLink, type Rel } from "../ip/bgp";
import { fiberMs, greatCircleKm } from "../foundations/latency";

export interface GeoAs {
  asn: number;
  name: string;
  kind: "tier1" | "transit" | "isp" | "site";
  lat: number;
  lon: number;
  /** Users in this network (ISPs only), in millions (model input). */
  users?: number;
}

const P = {
  nyc: [40.71, -74.01], sfo: [37.77, -122.42], mia: [25.76, -80.19], lon: [51.51, -0.13], fra: [50.11, 8.68],
  tyo: [35.68, 139.65], sgp: [1.35, 103.82], syd: [-33.87, 151.21], sao: [-23.55, -46.63], jnb: [-26.2, 28.05],
  bom: [19.08, 72.88], lax: [34.05, -118.24],
} as const;
const at = (c: keyof typeof P) => ({ lat: P[c][0], lon: P[c][1] });

export const SITES = [41, 42, 43, 44, 45] as const;

export const WORLD_NODES: GeoAs[] = [
  { asn: 1, name: "Carrier A", kind: "tier1", ...at("nyc") },
  { asn: 2, name: "Carrier B", kind: "tier1", ...at("fra") },
  { asn: 3, name: "Carrier C", kind: "tier1", ...at("tyo") },
  { asn: 11, name: "US West transit", kind: "transit", ...at("lax") },
  { asn: 12, name: "Europe transit", kind: "transit", ...at("lon") },
  { asn: 13, name: "Asia transit", kind: "transit", ...at("sgp") },
  { asn: 14, name: "Oceania transit", kind: "transit", ...at("syd") },
  { asn: 15, name: "LatAm transit", kind: "transit", ...at("mia") },
  { asn: 21, name: "ISP New York", kind: "isp", users: 20, ...at("nyc") },
  { asn: 22, name: "ISP San Francisco", kind: "isp", users: 10, ...at("sfo") },
  { asn: 23, name: "ISP London", kind: "isp", users: 15, ...at("lon") },
  { asn: 24, name: "ISP Frankfurt", kind: "isp", users: 15, ...at("fra") },
  { asn: 25, name: "ISP Tokyo", kind: "isp", users: 25, ...at("tyo") },
  { asn: 26, name: "ISP Singapore", kind: "isp", users: 5, ...at("sgp") },
  { asn: 27, name: "ISP Sydney", kind: "isp", users: 10, ...at("syd") },
  { asn: 28, name: "ISP São Paulo", kind: "isp", users: 20, ...at("sao") },
  { asn: 29, name: "ISP Johannesburg", kind: "isp", users: 8, ...at("jnb") },
  { asn: 30, name: "ISP Mumbai", kind: "isp", users: 30, ...at("bom") },
  { asn: 41, name: "site New York", kind: "site", ...at("nyc") },
  { asn: 42, name: "site London", kind: "site", ...at("lon") },
  { asn: 43, name: "site Singapore", kind: "site", ...at("sgp") },
  { asn: 44, name: "site Sydney", kind: "site", ...at("syd") },
  { asn: 45, name: "site São Paulo", kind: "site", ...at("sao") },
];

export const WORLD: AsGraph = {
  nodes: WORLD_NODES.map((n) => ({ asn: n.asn, name: n.name, tier: n.kind === "tier1" ? 1 : n.kind === "transit" ? 2 : 3, x: (n.lon + 180) / 360, y: (90 - n.lat) / 180 })),
  links: [
    // The global carriers peer with each other.
    { a: 1, b: 2, kind: "p2p" }, { a: 1, b: 3, kind: "p2p" }, { a: 2, b: 3, kind: "p2p" },
    // Regional transit buys from the carriers.
    { a: 11, b: 1, kind: "c2p" }, { a: 12, b: 2, kind: "c2p" }, { a: 12, b: 1, kind: "c2p" }, { a: 13, b: 3, kind: "c2p" },
    { a: 14, b: 3, kind: "c2p" }, { a: 14, b: 1, kind: "c2p" }, { a: 15, b: 1, kind: "c2p" },
    // Access ISPs.
    { a: 21, b: 1, kind: "c2p" }, { a: 22, b: 11, kind: "c2p" }, { a: 23, b: 12, kind: "c2p" }, { a: 24, b: 12, kind: "c2p" },
    { a: 24, b: 2, kind: "c2p" }, { a: 25, b: 3, kind: "c2p" }, { a: 26, b: 13, kind: "c2p" }, { a: 27, b: 14, kind: "c2p" },
    { a: 28, b: 15, kind: "c2p" }, { a: 29, b: 2, kind: "c2p" }, { a: 30, b: 2, kind: "c2p" }, { a: 30, b: 13, kind: "c2p" },
    // The anycast sites: each buys transit locally, and some peer with local ISPs at an exchange.
    { a: 41, b: 1, kind: "c2p" }, { a: 41, b: 21, kind: "p2p" },
    { a: 42, b: 12, kind: "c2p" }, { a: 42, b: 23, kind: "p2p" },
    { a: 43, b: 13, kind: "c2p" }, { a: 43, b: 26, kind: "p2p" },
    { a: 44, b: 1, kind: "c2p" },
    { a: 45, b: 15, kind: "c2p" }, { a: 45, b: 28, kind: "p2p" },
  ],
};

export const geoOf = (asn: number) => WORLD_NODES.find((n) => n.asn === asn)!;
export const ISPS = WORLD_NODES.filter((n) => n.kind === "isp").map((n) => n.asn);

export interface SiteConfig {
  asn: number;
  on: boolean;
  /** Extra copies of the site's number in the AS_PATH. */
  prepend: number;
  /** Announce with NO_EXPORT: only direct neighbours use the route. */
  local: boolean;
}

export const defaultSites = (): SiteConfig[] => SITES.map((asn) => ({ asn, on: true, prepend: 0, local: false }));

interface Route {
  path: number[];
  from: number | null;
  rel: Rel;
  noExport: boolean;
}

const better = (a: Route, b: Route) =>
  REL_PREF[a.rel] !== REL_PREF[b.rel] ? REL_PREF[a.rel] > REL_PREF[b.rel] : a.path.length !== b.path.length ? a.path.length < b.path.length : (a.from ?? -1) < (b.from ?? -1);

/** Optional links the learner can add: the Sydney site peers with the Sydney ISP at a local exchange. */
export const SYDNEY_PEERING: AsLink = { a: 44, b: 27, kind: "p2p" };

export const worldWith = (extra: AsLink[]): AsGraph => (extra.length ? { nodes: WORLD.nodes, links: [...WORLD.links, ...extra] } : WORLD);

/** Best route per AS to the anycast prefix, after convergence. */
export function anycastRoutes(sites: SiteConfig[], g: AsGraph = WORLD): Map<number, Route> {
  let best = new Map<number, Route>();
  const own = new Map<number, Route>();
  for (const s of sites) if (s.on) own.set(s.asn, { path: Array(s.prepend).fill(s.asn), from: null, rel: "self", noExport: s.local });
  for (let round = 0; round < 60; round++) {
    const next = new Map<number, Route>();
    let changed = false;
    for (const n of g.nodes) {
      const me = n.asn;
      let pick = own.get(me);
      for (const nb of neighbours(g, me)) {
        const r = best.get(nb);
        if (!r) continue;
        if (r.from !== null && r.noExport) continue; // a NO_EXPORT route is not passed on
        if (!mayExport({ prefix: { net: 0, len: 0 }, path: r.path, from: r.from, rel: r.rel }, relOf(g, nb, me)!)) continue;
        const path = [nb, ...r.path];
        if (path.includes(me)) continue;
        const cand: Route = { path, from: nb, rel: relOf(g, me, nb)!, noExport: r.noExport };
        if (!pick || better(cand, pick)) pick = cand;
      }
      if (pick) next.set(me, pick);
      const cur = best.get(me);
      if ((cur?.from ?? -2) !== (pick?.from ?? -2) || cur?.path.join() !== pick?.path.join()) changed = true;
    }
    best = next;
    if (!changed) break;
  }
  return best;
}

/** The fiber RTT lower bound between two ASes' cities, ms. */
export const hopRttMs = (a: number, b: number) => 2 * fiberMs(greatCircleKm(geoOf(a), geoOf(b)));
export const distKm = (a: number, b: number) => greatCircleKm(geoOf(a), geoOf(b));

export interface Catchment {
  asn: number;
  /** The site its packets reach, or null (no route). */
  site: number | null;
  /** The ASes the packets cross, this AS first, the site last. */
  path: number[];
  /** Distance to the site reached, km. */
  km: number;
  /** Fiber RTT to the site reached (lower bound), ms. */
  rttMs: number;
  /** The nearest site among the sites that announce. */
  nearest: number | null;
  nearestKm: number;
  nearestRttMs: number;
}

function follow(routes: Map<number, Route>, from: number): { site: number | null; path: number[] } {
  const path = [from];
  let at = from;
  for (let k = 0; k < 32; k++) {
    const r = routes.get(at);
    if (!r) return { site: null, path };
    if (r.from === null) return { site: at, path };
    at = r.from;
    path.push(at);
  }
  return { site: null, path };
}

/** Where each ISP's packets go, against the nearest site. */
export function catchments(sites: SiteConfig[], extra: AsLink[] = []): Catchment[] {
  const routes = anycastRoutes(sites, worldWith(extra));
  const on = sites.filter((s) => s.on);
  return ISPS.map((asn) => {
    const { site, path } = follow(routes, asn);
    let nearest: number | null = null, nd = Infinity;
    for (const s of on) {
      const d = distKm(asn, s.asn);
      if (d < nd) { nd = d; nearest = s.asn; }
    }
    return {
      asn, site, path,
      km: site === null ? Infinity : distKm(asn, site), rttMs: site === null ? Infinity : hopRttMs(asn, site),
      nearest, nearestKm: nd, nearestRttMs: nearest === null ? Infinity : hopRttMs(asn, nearest),
    };
  });
}

/** Users (millions) whose packets reach a site other than the nearest, and their mean extra distance (km). */
export function inflation(cs: Catchment[]): { usersOff: number; usersAll: number; meanExtraKm: number } {
  let off = 0, all = 0, extra = 0;
  for (const c of cs) {
    const u = geoOf(c.asn).users ?? 0;
    all += u;
    if (c.site !== null && c.site !== c.nearest) { off += u; extra += u * (c.km - c.nearestKm); }
  }
  return { usersOff: off, usersAll: all, meanExtraKm: off ? extra / off : 0 };
}

// ---------------------------------------------------------------- DDoS across sites

export interface DdosOpts {
  sites: SiteConfig[];
  extra?: AsLink[];
  /** Total attack traffic, Gbit/s (model input). */
  attackGbps: number;
  /** Attack share per ISP (the botnet's spread), as weights (model input). */
  botnet?: Record<number, number>;
  /** Capacity of each site, Gbit/s (model input). */
  capacityGbps: number;
  /** Legitimate traffic per million users, Gbit/s (model input). */
  legitPerMillion?: number;
}

export interface SiteLoad {
  site: number;
  attack: number;
  legit: number;
  /** Share of the arriving traffic that the site can serve: min(1, capacity / load). */
  served: number;
}

/** Model input: where the bots are. Weighted to a few large access networks. */
export const BOTNET: Record<number, number> = { 21: 1, 22: 1, 23: 1, 24: 1, 25: 2, 26: 1, 27: 1, 28: 3, 29: 1, 30: 4 };

export function ddosLoad(o: DdosOpts): { sites: SiteLoad[]; usersServed: number; usersCut: number } {
  const bot = o.botnet ?? BOTNET, per = o.legitPerMillion ?? 0.5;
  const totalW = ISPS.reduce((s, a) => s + (bot[a] ?? 0), 0);
  const cs = catchments(o.sites, o.extra ?? []);
  const load = new Map<number, SiteLoad>(o.sites.filter((s) => s.on).map((s) => [s.asn, { site: s.asn, attack: 0, legit: 0, served: 1 }]));
  for (const c of cs) {
    if (c.site === null) continue;
    const l = load.get(c.site)!;
    l.attack += (o.attackGbps * (bot[c.asn] ?? 0)) / totalW;
    l.legit += (geoOf(c.asn).users ?? 0) * per;
  }
  for (const l of load.values()) l.served = Math.min(1, o.capacityGbps / Math.max(1e-9, l.attack + l.legit));
  let served = 0, all = 0;
  for (const c of cs) {
    const u = geoOf(c.asn).users ?? 0;
    all += u;
    if (c.site !== null) served += u * load.get(c.site)!.served;
  }
  return { sites: [...load.values()], usersServed: served / all, usersCut: 1 - served / all };
}
