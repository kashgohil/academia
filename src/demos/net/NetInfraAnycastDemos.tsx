/** Demos for "Anycast": catchments that follow BGP, a DDoS spread over sites, and a route change under TCP. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleX, SectionLabel, StackBar, Stats, int, ms, pct, range, seg, sig, toggle,
  useParams,
} from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { tcpSpaceTime } from "./NetTcpUi";
import { TopoView, type TopoLink, type TopoNode } from "./NetIpUi";
import {
  ATCP, ISPS, SITES, SYDNEY_PEERING, WORLD, anycastTcpRun, breakChance, catchments, ddosLoad, defaultSites, geoOf, inflation, type SiteConfig,
} from "../../sims/net/infrastructure";

const SITE_COLOR: Record<number, string> = { 41: "var(--c1)", 42: "var(--c2)", 43: "var(--c3)", 44: "var(--c5)", 45: "var(--c4)" };
const SHORT: Record<number, string> = {
  1: "A", 2: "B", 3: "C", 11: "T-US", 12: "T-EU", 13: "T-AS", 14: "T-OC", 15: "T-LA",
  21: "NYC", 22: "SFO", 23: "LON", 24: "FRA", 25: "TYO", 26: "SGP", 27: "SYD", 28: "SAO", 29: "JNB", 30: "BOM",
  41: "NYC", 42: "LON", 43: "SGP", 44: "SYD", 45: "SAO",
};
/** Map positions: roughly geographic, moved apart where cities crowd. */
const POS: Record<number, [number, number]> = {
  1: [0.25, 0.13], 21: [0.2, 0.31], 41: [0.15, 0.03], 11: [0.06, 0.36], 22: [0.03, 0.2], 15: [0.22, 0.52], 28: [0.31, 0.88], 45: [0.2, 0.8],
  12: [0.43, 0.24], 23: [0.35, 0.03], 42: [0.47, 0.03], 2: [0.56, 0.12], 24: [0.56, 0.3], 29: [0.55, 0.88], 30: [0.69, 0.42],
  13: [0.8, 0.56], 26: [0.73, 0.72], 43: [0.86, 0.7], 3: [0.87, 0.12], 25: [0.97, 0.3], 14: [0.91, 0.84], 27: [0.98, 0.98], 44: [0.83, 0.98],
};
const siteName = (s: number | null) => (s === null ? "none" : geoOf(s).name.replace("site ", ""));

function worldView(sites: SiteConfig[], peering: boolean, sel: number, color: (asn: number) => string | undefined, path: number[]) {
  const on = new Set(sites.filter((s) => s.on).map((s) => s.asn));
  const hot = new Set(path.slice(0, -1).map((a, i) => `${a}-${path[i + 1]}`));
  const nodes: TopoNode[] = WORLD.nodes.map((n) => {
    const kind = geoOf(n.asn).kind;
    const isSite = kind === "site";
    return {
      id: n.asn, label: SHORT[n.asn] ?? String(n.asn), x: POS[n.asn]![0], y: POS[n.asn]![1], square: isSite,
      fill: isSite ? (on.has(n.asn) ? SITE_COLOR[n.asn] : undefined) : kind === "isp" ? color(n.asn) : undefined,
      color: n.asn === sel ? "var(--fg)" : isSite ? (on.has(n.asn) ? SITE_COLOR[n.asn] : "var(--faint)") : kind === "isp" ? "var(--fg)" : "var(--muted)",
      bold: n.asn === sel || isSite,
    };
  });
  const links: TopoLink[] = [...WORLD.links, ...(peering ? [SYDNEY_PEERING] : [])].map((l) => {
    const h = hot.has(`${l.a}-${l.b}`) || hot.has(`${l.b}-${l.a}`);
    return { a: l.a, b: l.b, dashed: l.kind === "p2p", color: h ? "var(--fg)" : undefined, width: h ? 2.6 : 1, faint: !h };
  });
  return { nodes, links };
}

// ============================================================================ 1. Catchments

const CAT = {
  site: seg<string>("Site to change", SITES.map((s) => [String(s), SHORT[s]!] as [string, string]), "41"),
  peering: toggle({ label: "The Sydney site also peers with the Sydney ISP at a local exchange", default: false }),
};
const PREPEND = range({ label: "Prepend: extra copies of the site's AS in the path", min: 0, max: 3, step: 1, default: 0 });
const ANNOUNCE = toggle({ label: "Announce the prefix from this site", default: true });
const LOCAL = toggle({ label: "NO_EXPORT: neighbours use it but pass it on to nobody", default: false });

export function NetInfraAnycastCatchmentDemo() {
  const P = useParams("net-infra-catch", CAT);
  const { site, peering } = P.values;
  const [sites, setSites] = useState<SiteConfig[]>(defaultSites);
  const [sel, setSel] = useState(27);
  const cur = sites.find((s) => s.asn === Number(site))!;
  const update = (patch: Partial<SiteConfig>) => setSites((all) => all.map((s) => (s.asn === cur.asn ? { ...s, ...patch } : s)));
  const extra = peering ? [SYDNEY_PEERING] : [];
  const cs = useMemo(() => catchments(sites, extra), [sites, peering]); // eslint-disable-line react-hooks/exhaustive-deps
  const inf = inflation(cs);
  const selC = cs.find((c) => c.asn === sel) ?? cs.find((c) => c.asn === 27)!;
  const view = worldView(sites, peering, selC.asn, (asn) => { const c = cs.find((x) => x.asn === asn); return c?.site ? SITE_COLOR[c.site] : undefined; }, selC.path);
  const idle = sites.filter((s) => s.on && !cs.some((c) => c.site === s.asn)).map((s) => siteName(s.asn));
  return (
    <Demo title="Five sites announce one prefix: who goes where"
      actions={<Btn ghost onClick={() => { setSites(defaultSites()); P.reset(); }}>Reset</Btn>}
      controls={<>
        <Param spec={PREPEND} value={cur.prepend} onChange={(v) => update({ prepend: v as number })} />
        <Param spec={CAT.site} value={site} onChange={(v) => P.set("site", v as string)} />
        <Param spec={ANNOUNCE} value={cur.on} onChange={(v) => update({ on: v as boolean })} />
        <Param spec={LOCAL} value={cur.local} onChange={(v) => update({ local: v as boolean })} />
        <Param spec={CAT.peering} value={peering} onChange={(v) => P.set("peering", v as boolean)} />
      </>}
    >
      <TopoView nodes={view.nodes} links={view.links} height={300} r={13} onNode={(id) => { if (ISPS.includes(id)) setSel(id); if ((SITES as readonly number[]).includes(id)) P.set("site", String(id)); }} />
      <Legend items={SITES.map((s) => ({ label: `site ${SHORT[s]}`, color: SITE_COLOR[s]! }))} />
      <Note>Squares are the operator's sites. A circle with a city code is an access ISP, filled with the color of the site its users reach. A to C are global carriers; T-xx are regional transit networks. Solid links: customer below, provider above; dashed: peers. Click an ISP to draw its path.</Note>
      <Banner tone={selC.site === selC.nearest ? "good" : "warn"} label={geoOf(selC.asn).name}>
        Packets go {selC.path.map((a) => SHORT[a]).join(" → ")} to the {siteName(selC.site)} site, {int(selC.km)} km away.
        {selC.site !== selC.nearest ? ` The nearest site is ${siteName(selC.nearest)}, ${int(selC.nearestKm)} km away: about ${ms(selC.rttMs - selC.nearestRttMs)} more round trip, even on straight fiber.` : " That is the nearest site."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "users not at their nearest site", value: pct(inf.usersOff / inf.usersAll) },
          { label: "their mean extra distance", value: `${sig(inf.meanExtraKm)} km` },
          { label: "sites with no users", value: idle.length ? idle.join(", ") : "none" },
        ]} />
      </div>
      <SectionLabel>Every access ISP</SectionLabel>
      <MiniTable head={["ISP", "site", "km", "nearest", "km"]}
        rows={cs.map((c) => [geoOf(c.asn).name.replace("ISP ", ""), siteName(c.site), int(c.km), siteName(c.nearest), int(c.nearestKm)])}
        highlight={(i) => cs[i]!.site !== cs[i]!.nearest} />
      <Note>Model inputs: the graph, the cities and the user counts are made up. Each network is one router here, so a tie between equal routes goes to the lowest neighbour number.</Note>
    </Demo>
  );
}

// ============================================================================ 2. DDoS

const DD = {
  attack: range({ label: "Attack traffic (model input)", min: 0, max: 800, step: 10, default: 300, format: (v) => `${v} Gbit/s` }),
  capacity: range({ label: "Capacity of each site (model input)", min: 50, max: 300, step: 10, default: 100, format: (v) => `${v} Gbit/s` }),
};

export function NetInfraAnycastDdosDemo() {
  const P = useParams("net-infra-ddos", DD);
  const { attack, capacity } = P.values;
  const [on, setOn] = useState<number[]>([...SITES]);
  const sites = defaultSites().map((s) => ({ ...s, on: on.includes(s.asn) }));
  const r = ddosLoad({ sites, attackGbps: attack, capacityGbps: capacity });
  const max = Math.max(capacity * 1.2, ...r.sites.map((s) => s.attack + s.legit));
  const toggleSite = (s: number) => setOn((o) => (o.includes(s) ? (o.length > 1 ? o.filter((x) => x !== s) : o) : [...o, s].sort()));
  return (
    <Demo title="A botnet against five sites"
      controls={<>
        <Param spec={DD.attack} value={attack} onChange={(v) => P.set("attack", v as number)} />
        <Param spec={DD.capacity} value={capacity} onChange={(v) => P.set("capacity", v as number)} />
      </>}
    >
      <ButtonRow>
        <span className="muted" style={{ fontSize: 12 }}>Sites that announce:</span>
        {SITES.map((s) => <Btn key={s} ghost={!on.includes(s)} onClick={() => toggleSite(s)}>{SHORT[s]}</Btn>)}
        <Btn ghost onClick={() => setOn([41])}>only NYC (unicast)</Btn>
        <Btn ghost onClick={() => setOn([...SITES])}>all</Btn>
      </ButtonRow>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {r.sites.map((s) => (
          <div key={s.site}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, gap: 8 }}>
              <span style={{ color: SITE_COLOR[s.site] }}>■ <span style={{ color: "var(--fg)" }}>{geoOf(s.site).name}</span></span>
              <span className="muted">{int(s.attack + s.legit)} of {capacity} Gbit/s · serves {pct(s.served, 0)}</span>
            </div>
            <div style={{ position: "relative" }}>
              <StackBar total={max} parts={[{ value: s.legit, color: "var(--c3)", label: "users" }, { value: s.attack, color: "var(--c4)", label: "attack" }]} />
              <div style={{ position: "absolute", top: -2, bottom: -2, left: `${(capacity / max) * 100}%`, borderLeft: "2px solid var(--fg)" }} />
            </div>
          </div>
        ))}
      </div>
      <Legend items={[{ label: "real users", color: "var(--c3)" }, { label: "attack", color: "var(--c4)" }, { label: "site capacity", color: "var(--fg)" }]} />
      <Banner tone={r.usersCut < 0.01 ? "good" : r.usersCut < 0.2 ? "warn" : "bad"}>
        {pct(r.usersServed)} of real users get through. An overloaded site drops the same share of good and bad traffic, so only the users in its catchment suffer.
      </Banner>
      <Note>Model inputs: the bots sit in the access ISPs with weights (Mumbai 4, São Paulo 3, Tokyo 2, the others 1), and real traffic is 0.5 Gbit/s per million users. A site that stops announcing does not remove the attack: its catchment, bots and users, moves to other sites.</Note>
    </Demo>
  );
}

// ============================================================================ 3. TCP and a route change

const TC = {
  flip: range({ label: "The route moves to site B at", min: 10, max: 400, step: 5, default: 100, format: (v) => `${v} ms` }),
  size: seg<string>("Response", [["2000", "2 KB (a DNS answer)"], ["100000", "100 KB (a page)"]], "100000"),
  back: toggle({ label: "The route moves back to site A 30 ms later (a flap)", default: false }),
  never: toggle({ label: "No route change", default: false }),
};

export function NetInfraAnycastTcpDemo() {
  const P = useParams("net-infra-atcp", TC);
  const { flip, size, back, never } = P.values;
  const respBytes = Number(size);
  const run = useMemo(() => anycastTcpRun({ respBytes, flipAt: never ? null : flip, flipBack: never || !back ? null : flip + 30 }), [respBytes, flip, back, never]);
  const raw = tcpSpaceTime(run.net, { nodes: [ATCP.client, ATCP.router, ATCP.siteA, ATCP.siteB], labels: "control" });
  // Label only the first RST on each link; the colors tell SYN, data and ACK apart, and short hops have no room for text.
  const seen = new Set<string>();
  const st = { ...raw, messages: raw.messages.map((m) => { const k = `${m.label}|${m.from}|${m.to}`; if (m.label !== "RST" || seen.has(k)) return { ...m, label: undefined }; seen.add(k); return m; }) };
  const ok = run.received >= respBytes && run.clientEnd === undefined;
  const tEnd = Math.min(Number.isNaN(run.resetAt) ? (Number.isNaN(run.doneMs) ? 400 : run.doneMs + 40) : run.resetAt + 60, 600);
  const marks = never ? st.marks : [...st.marks, { node: 1, t: flip, label: "route → B", color: "var(--c4)" }, ...(back ? [{ node: 1, t: flip + 30, label: "→ A", color: "var(--c3)" }] : [])];
  return (
    <Demo title="A TCP download from an anycast address"
      controls={<>
        <Param spec={TC.flip} value={flip} onChange={(v) => P.set("flip", v as number)} />
        <Param spec={TC.size} value={size} onChange={(v) => P.set("size", v as string)} />
        <Param spec={TC.back} value={back} onChange={(v) => P.set("back", v as boolean)} />
        <Param spec={TC.never} value={never} onChange={(v) => P.set("never", v as boolean)} />
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages.filter((m) => m.sentAt <= tEnd)} marks={marks} rowHeight={50} />
      <Legend items={[{ label: "SYN", color: "var(--c2)" }, { label: "data", color: "var(--c1)" }, { label: "ACK", color: "var(--muted)" }, { label: "RST", color: "var(--c4)" }]} />
      <Banner tone={ok ? "good" : "bad"}>
        {ok
          ? run.rstFromB ? `Site B sent ${run.rstFromB} RSTs, but their sequence numbers lay behind data that the client had already received. They fell outside the window, and the client dropped them. The download finished at ${ms(run.doneMs)}.` : `The download finished at ${ms(run.doneMs)}. Every packet reached site A.`
          : `Site B has no socket for this connection, so it answered with RST and the client's connection died at ${ms(run.resetAt)} with ${int(run.received)} of ${int(respBytes)} bytes.${run.orphanSegs ? ` Site A went on to send ${run.orphanSegs} segments, retransmissions included, into a connection that no longer exists.` : ""}`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "bytes received", value: int(run.received) },
          { label: "RSTs from site B", value: run.rstFromB },
          { label: "client connection", value: run.clientEnd ?? "open" },
        ]} />
      </div>
      <Note>Model inputs: 5 ms from the client to its router, then 10 ms to site A or 20 ms to site B; 50 Mbit/s access; the reference TCP with a 16 KB receive window. The connection stays open after the response, as HTTP keep-alive does.</Note>
    </Demo>
  );
}

// ============================================================================ 4. How often a change hits a connection

const DUR = Array.from({ length: 61 }, (_, i) => Math.pow(10, -1 + (i / 60) * 6)); // 0.1 s to 100,000 s

export function NetInfraAnycastBreakDemo() {
  const P = useParams("net-infra-abreak", { mtbf: range({ label: "Mean time between route changes for this client", min: 60, max: 86400 * 7, step: 60, default: 600, log: true, format: (v) => (v < 3600 ? `${Math.round(v / 60)} min` : v < 86400 ? `${sig(v / 3600, 2)} h` : `${sig(v / 86400, 2)} days`) }) });
  const { mtbf } = P.values;
  const marks = [{ d: 0.1, label: "a DNS query over TCP" }, { d: 10, label: "a page load" }, { d: 600, label: "a 10-minute video" }, { d: 3600, label: "a 1-hour WebSocket" }];
  return (
    <Demo title="The chance that a route change hits a connection" controls={<Param spec={P.schema.mtbf} value={mtbf} onChange={(v) => P.set("mtbf", v as number)} />}>
      <Plot x={[0.1, 1e5]} y={[0, 1]} logX height={200} xLabel="connection length (s)" yLabel="chance of a reset" xTicks={[0.1, 1, 10, 100, 1000, 1e4, 1e5]} xFormat={(v) => sig(v, 1)} yFormat={(v) => pct(v, 0)}>
        <Line points={DUR.map((d) => [d, breakChance(d, mtbf)] as const)} color="var(--c4)" />
        {marks.map((m) => <RuleX key={m.d} at={m.d} />)}
      </Plot>
      <MiniTable head={["connection", "length", "chance of a reset"]} rows={marks.map((m) => [m.label, m.d < 1 ? `${m.d * 1000} ms` : m.d < 60 ? `${m.d} s` : `${m.d / 60} min`, pct(breakChance(m.d, mtbf), 2)])} />
      <Note>Route changes are modelled as random events with the mean time between them that you set. 10 minutes is the threshold below which Wei and Heidemann call a client "anycast unstable"; most clients see far fewer changes.</Note>
    </Demo>
  );
}
