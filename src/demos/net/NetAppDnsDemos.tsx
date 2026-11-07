/** Demos for "DNS". The bytes come from src/sims/net/apps/dns-msg.ts; the runs are PacketNet runs of dns-resolve.ts and dns-poison.ts. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Demo, IndexButtons, Legend, MiniTable, Param, SmallLabel, Stats, fixed, int, mono, range, select, sig, toggle, useParams,
} from "../../kit";
import { SpaceTime, type StMark } from "../dist/SpaceTime";
import { HeaderDiagram, fromPackets } from "./PacketViews";
import { HexSpans, type ByteSpan } from "./NetAppUi";
import {
  AUTH, DNS_NODES, LINUX_PORTS, RACE_NODES, TLD, UDP_LIMIT, campaign, dnsHeaderFields, dnsRun, encodeMessage, lookupMs, poisonOdds, query, raceRun, rrText, serve, zones,
  type DnsMessage, type DnsPayload, type RRType, type RacePayload,
} from "../../sims/net/apps";
import { isTcp, segLabel } from "../../sims/net/transport";

const SECTION_COLOR: Record<string, string> = { header: "var(--c5)", question: "var(--c1)", answer: "var(--c3)", authority: "var(--c2)", additional: "var(--c5)" };

// ============================================================================ 1. The message format

type MsgKind = "query" | "referral" | "cname" | "nxdomain" | "https" | "big";
const MSG_LABEL: Record<MsgKind, string> = {
  query: "Query: www.example.com A",
  referral: "Referral from the com server",
  cname: "Answer with a CNAME chain",
  nxdomain: "NXDOMAIN with the zone's SOA",
  https: "HTTPS record (RFC 9460)",
  big: "40 A records (big.example.com)",
};

function buildMsg(kind: MsgKind, edns: boolean): DnsMessage {
  const z = zones({ glue: true });
  let m: DnsMessage;
  switch (kind) {
    case "query": m = query(0x1a2b, "www.example.com", "A"); break;
    case "referral": m = serve(z[TLD]!, { name: "www.example.com", type: "A" }, 0x1a2b); break;
    case "cname": m = serve(z[AUTH]!, { name: "api.example.com", type: "A" }, 0x1a2b); break;
    case "nxdomain": m = serve(z[AUTH]!, { name: "nope.example.com", type: "A" }, 0x1a2b); break;
    case "https": m = serve(z[AUTH]!, { name: "www.example.com", type: "HTTPS" }, 0x1a2b); break;
    case "big": m = serve(z[AUTH]!, { name: "big.example.com", type: "A" }, 0x1a2b); break;
  }
  if (edns) m = { ...m, additional: [...m.additional, { name: "", ttl: 0, data: { t: "OPT", udpSize: 1232 } }] };
  return m;
}

const MSG = {
  kind: select<MsgKind>({ label: "Message", options: (Object.keys(MSG_LABEL) as MsgKind[]).map((k) => ({ value: k, label: MSG_LABEL[k] })), default: "referral" }),
  compress: toggle({ label: "Name compression", default: true }),
  edns: toggle({ label: "EDNS(0) OPT record (buffer 1232 bytes)", default: false }),
};

const FLAG_KEYS = ["qr", "aa", "tc", "rd", "ra", "ad", "cd"] as const;

export function NetAppDnsMessageDemo() {
  const P = useParams("net-app-dnsmsg", MSG);
  const { kind, compress, edns } = P.values;
  const [flips, setFlips] = useState<Record<string, boolean>>({});
  const [field, setField] = useState<number | undefined>(4);
  const [span, setSpan] = useState<number | undefined>();
  const base = useMemo(() => buildMsg(kind, edns), [kind, edns]);
  const msg: DnsMessage = { ...base, flags: { ...base.flags } };
  for (const k of FLAG_KEYS) if (flips[k]) msg.flags[k] = !msg.flags[k];
  const enc = encodeMessage(msg, compress);
  const fields = dnsHeaderFields(msg);
  const spans: ByteSpan[] = [
    ...enc.pointers.map((p) => ({ start: p.at, end: p.at + 2, color: "var(--c4)", label: `pointer to offset ${p.to}: "${p.suffix}"` })),
    ...enc.spans.map((s) => ({ start: s.start, end: s.end, color: SECTION_COLOR[s.kind]!, label: `${s.kind}: ${s.label}` })),
  ];
  const f = field !== undefined ? fields[field] : undefined;
  const flagKey = f && f.bits === 1 ? (f.name.toLowerCase() as (typeof FLAG_KEYS)[number]) : undefined;
  const sel = span !== undefined ? spans[span] : undefined;
  return (
    <Demo
      title="A DNS message, byte by byte"
      actions={<Btn ghost onClick={() => setFlips({})}>Reset flags</Btn>}
      controls={<>
        <Param spec={MSG.kind} value={kind} onChange={(v) => { P.set("kind", v as MsgKind); setFlips({}); setSpan(undefined); }} />
        <Param spec={MSG.compress} value={compress} onChange={(v) => P.set("compress", v as boolean)} />
        <Param spec={MSG.edns} value={edns} onChange={(v) => P.set("edns", v as boolean)} />
      </>}
    >
      <SmallLabel>The 12-byte header. Click a field; flags can be flipped.</SmallLabel>
      <HeaderDiagram fields={fields} selected={field} onSelect={setField} rowBits={16} />
      {f && (
        <ButtonRow style={{ margin: "6px 0 10px" }}>
          <span style={{ fontSize: 13 }}><b>{f.name}</b> ({f.bits} bit{f.bits > 1 ? "s" : ""}) = <span style={mono}>{String(f.value ?? 0)}</span>: {f.note}</span>
          {flagKey && FLAG_KEYS.includes(flagKey) && <Btn onClick={() => setFlips({ ...flips, [flagKey]: !flips[flagKey] })}>Flip {f.name}</Btn>}
        </ButtonRow>
      )}
      <SmallLabel>The whole message on the wire. Click a byte to see what it belongs to.</SmallLabel>
      <HexSpans bytes={enc.bytes} spans={spans} selected={span} onSelect={setSpan} maxRows={kind === "big" ? 14 : undefined} />
      <Legend items={[
        { label: "header", color: "var(--c5)" }, { label: "question", color: "var(--c1)" }, { label: "answer", color: "var(--c3)" },
        { label: "authority", color: "var(--c2)" }, { label: "compression pointer", color: "var(--c4)" },
      ]} />
      <div style={{ fontSize: 12.5, minHeight: 20, margin: "4px 0 8px" }}>{sel ? <span style={mono}>{sel.label}</span> : <span className="muted">No byte selected.</span>}</div>
      <MiniTable head={["section", "record"]} rows={[
        ...msg.question.map((q) => ["question", <span style={mono}>{`${q.name}. IN ${q.type}`}</span>]),
        ...(["answer", "authority", "additional"] as const).flatMap((s) => msg[s].slice(0, 6).map((r) => [s, <span style={{ ...mono, wordBreak: "break-all" }}>{rrText(r)}</span>])),
        ...(msg.answer.length > 6 ? [["answer", `… ${msg.answer.length - 6} more A records`]] : []),
      ]} />
      <Stats items={[
        { label: "bytes on the wire", value: int(enc.bytes.length) },
        { label: "saved by compression", value: compress ? `${int(enc.saved)} B` : "off" },
        { label: "pointers", value: enc.pointers.length },
        { label: "fits in 512 B (no EDNS)", value: enc.bytes.length <= UDP_LIMIT ? "yes" : "no: TC" },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. Resolution with a cache

const NAMES: { value: string; label: string }[] = [
  { value: "www.example.com|A", label: "www.example.com A" },
  { value: "api.example.com|A", label: "api.example.com A (CNAME in zone)" },
  { value: "shop.example.com|A", label: "shop.example.com A (CNAME to a CDN)" },
  { value: "nope.example.com|A", label: "nope.example.com A (does not exist)" },
  { value: "big.example.com|A", label: "big.example.com A (40 records)" },
  { value: "www.example.com|HTTPS", label: "www.example.com HTTPS" },
];

const RS = {
  name: select({ label: "Name to look up", options: NAMES, default: "www.example.com|A" }),
  gap: range({ label: "Wait before the lookup", min: 0, max: 900, step: 5, default: 10, format: (v) => `${v} s` }),
  glue: toggle({ label: "Glue for ns1.example.com (off: its name server is ns1.dnshost.net)", default: true }),
  edns: toggle({ label: "Resolver offers EDNS(0), 1232 bytes", default: false }),
  drop: toggle({ label: "Lose the first query to the com server", default: false }),
};

export function NetAppDnsResolveDemo() {
  const P = useParams("net-app-dnsres", RS);
  const { glue, edns, drop } = P.values;
  const [list, setList] = useState<{ at: number; name: string; type: RRType }[]>([{ at: 0, name: "www.example.com", type: "A" }]);
  const [sel, setSel] = useState<number | undefined>();
  const run = useMemo(() => dnsRun({ lookups: list, glue, edns: edns ? 1232 : 0, dropFirstTo: drop ? TLD : undefined }), [list, glue, edns, drop]);
  const k = Math.min(sel ?? list.length - 1, list.length - 1);
  const lk = run.lookups[k]!;
  const add = () => {
    const [name, type] = P.values.name.split("|") as [string, RRType];
    setList([...list, { at: list[list.length - 1]!.at + P.values.gap, name, type }]);
    setSel(undefined);
  };
  const t0 = lk.start, t1 = lk.end ?? t0 + 100;
  const st = fromPackets(run.net, {
    filter: (p) => p.createdAt >= t0 - 0.01 && p.createdAt <= t1 + 0.01,
    label: (p) => {
      if (isTcp(p.payload)) return p.payload.len > 0 || p.payload.flags & 2 ? `TCP ${segLabel(p.payload)}` : undefined;
      const d = p.payload as DnsPayload;
      if (!d.msg.flags.qr) return `${d.msg.question[0]!.name.split(".")[0]} ${d.msg.question[0]!.type}?`;
      if (d.msg.flags.tc) return "TC=1";
      return d.msg.answer.length ? `${d.msg.answer.length} rec` : d.msg.flags.rcode === 3 ? "NXDOMAIN" : d.msg.authority.some((r) => r.data.t === "NS") ? "referral" : "";
    },
    color: (p) => (isTcp(p.payload) ? "var(--c5)" : (p.payload as DnsPayload).msg.flags.qr ? "var(--c3)" : "var(--c1)"),
  });
  const shift = (ms: number) => ms - t0;
  const messages = st.messages.map((m) => ({ ...m, sentAt: shift(m.sentAt), deliveredAt: m.deliveredAt === undefined ? undefined : shift(m.deliveredAt) }));
  const marks: StMark[] = st.marks.map((m) => ({ ...m, t: shift(m.t) }));
  const total = lookupMs(lk);
  const ups = lk.upstream.map((i) => run.upstream[i]!);
  return (
    <Demo
      title="A lookup through a caching resolver"
      actions={<Btn ghost onClick={() => { setList([{ at: 0, name: "www.example.com", type: "A" }]); setSel(undefined); }}>Restart with an empty cache</Btn>}
      controls={<>
        <Param spec={RS.name} value={P.values.name} onChange={(v) => P.set("name", v as string)} />
        <Param spec={RS.gap} value={P.values.gap} onChange={(v) => P.set("gap", v as number)} />
        <ButtonRow><Btn onClick={add} on>Look it up</Btn></ButtonRow>
        <Param spec={RS.glue} value={glue} onChange={(v) => P.set("glue", v as boolean)} />
        <Param spec={RS.edns} value={edns} onChange={(v) => P.set("edns", v as boolean)} />
        <Param spec={RS.drop} value={drop} onChange={(v) => P.set("drop", v as boolean)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 6 }}>
        <IndexButtons k={k} n={list.length} set={setSel} />
        <span style={{ fontSize: 13 }}>Lookup {k + 1} of {list.length}: <b style={mono}>{lk.name} {lk.type}</b> at {sig(lk.start / 1000, 4)} s</span>
      </ButtonRow>
      <SpaceTime nodes={DNS_NODES} tEnd={Math.max(20, total * 1.06)} messages={messages} marks={marks} rowHeight={36} timeLabel="ms since the stub asked" />
      <Legend items={[{ label: "query", color: "var(--c1)" }, { label: "reply", color: "var(--c3)" }, { label: "TCP", color: "var(--c5)" }]} />
      <Stats items={[
        { label: "lookup time", value: `${fixed(total, 1)} ms` },
        { label: "queries the resolver sent", value: ups.length },
        { label: "answer", value: `${lk.rcode}, ${lk.answer.length} record${lk.answer.length === 1 ? "" : "s"}` },
        { label: "found in the cache", value: lk.hits.length ? lk.hits.join(", ") : "nothing" },
      ]} />
      {ups.length > 0 && (
        <MiniTable head={["server", "question", "via", "outcome"]} rows={ups.map((u) => [DNS_NODES[u.server], <span style={mono}>{`${u.qname} ${u.qtype}`}</span>, u.tcp ? "TCP" : u.retries ? `UDP, ${u.retries + 1} tries` : "UDP", u.outcome ?? "–"])} />
      )}
      <SmallLabel style={{ marginTop: 10 }}>The resolver's cache after this lookup (seconds left)</SmallLabel>
      <div style={{ maxHeight: 150, overflowY: "auto" }}>
        <MiniTable head={["entry", "TTL left"]} rows={lk.cacheAfter.map((c) => [<span style={{ ...mono, wordBreak: "break-all" }}>{c.text}</span>, `${int(c.left)} s`])} highlight={(i) => !!lk.cacheAfter[i]!.neg} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. Cache poisoning

const PO = {
  mbps: range({ label: "Attacker bandwidth", min: 1, max: 1000, step: 1, default: 100, log: true, format: (v) => `${v} Mbit/s` }),
  rtt: range({ label: "RTT resolver ↔ example.com", min: 10, max: 200, step: 5, default: 40, format: (v) => `${v} ms` }),
  ports: toggle({ label: "Resolver randomizes its source port", default: false }),
  dnssec: toggle({ label: "example.com is signed and the resolver validates (DNSSEC)", default: false }),
  hit: toggle({ label: "Show a race the attacker wins", default: true }),
};

function duration(s: number) {
  if (!Number.isFinite(s)) return "never";
  if (s < 120) return `${sig(s, 3)} s`;
  if (s < 7200) return `${sig(s / 60, 3)} min`;
  if (s < 172800) return `${sig(s / 3600, 3)} h`;
  if (s < 3.15e7 * 2) return `${sig(s / 86400, 3)} days`;
  return `${sig(s / 3.15e7, 3)} years`;
}

export function NetAppDnsPoisonDemo() {
  const P = useParams("net-app-poison", PO);
  const { mbps, rtt, ports, dnssec, hit } = P.values;
  const o = { attackerMbps: mbps, rttMs: rtt, randomPorts: ports, dnssec };
  const odds = poisonOdds(o);
  const race = useMemo(() => raceRun({ ...o, hit, show: 14 }), [mbps, rtt, ports, dnssec, hit]); // eslint-disable-line react-hooks/exhaustive-deps
  const camp = useMemo(() => (odds.expectedRaces < 2e5 ? campaign(o) : undefined), [mbps, rtt, ports, dnssec]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = fromPackets(race.net, {
    color: (p) => ({ trigger: "var(--c1)", query: "var(--c1)", real: "var(--c3)", forged: p.payload.match ? "var(--c4)" : "var(--c2)" } as Record<RacePayload["kind"], string>)[p.payload.kind],
    label: (p) => (p.payload.kind === "trigger" ? "r4711?" : p.payload.kind === "query" ? `ID ${p.payload.id}` : p.payload.kind === "real" ? "real" : p.payload.match ? "match!" : undefined),
  });
  const acc = race.accepted;
  return (
    <Demo
      title="Kaminsky's race: forged replies against the real one"
      controls={<>
        <Param spec={PO.mbps} value={mbps} onChange={(v) => P.set("mbps", v as number)} />
        <Param spec={PO.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={PO.ports} value={ports} onChange={(v) => P.set("ports", v as boolean)} />
        <Param spec={PO.dnssec} value={dnssec} onChange={(v) => P.set("dnssec", v as boolean)} />
        <Param spec={PO.hit} value={hit} onChange={(v) => P.set("hit", v as boolean)} />
      </>}
    >
      <SmallLabel>One race. The diagram shows 14 of the {int(odds.forgedPerRace)} forged replies that fit in the window.</SmallLabel>
      <SpaceTime nodes={RACE_NODES} tEnd={rtt + 12} messages={st.messages} marks={st.marks} rowHeight={44} />
      <Banner tone={acc?.kind === "forged" ? "bad" : "good"} label="resolver">
        {acc?.kind === "forged"
          ? `Accepted a forged reply at ${fixed(acc.t, 1)} ms (ID ${acc.id}${ports ? `, port ${acc.port}` : ""}). It now sends every example.com question to 203.0.113.66, for the TTL of 2 days.`
          : dnssec && hit
            ? "A forged reply matched the ID, but its records carry no valid signature: the resolver drops it and keeps waiting."
            : `No forged reply matched. The real reply arrived at ${fixed(acc?.t ?? NaN, 1)} ms. The attacker asks for a new random name and races again.`}
      </Banner>
      <Stats items={[
        { label: "forged replies per race", value: int(odds.forgedPerRace) },
        { label: "values to guess", value: ports ? `65,536 × ${int(LINUX_PORTS)}` : "65,536 (ID only)" },
        { label: "chance per race", value: dnssec ? "0" : odds.pRace < 1e-3 ? odds.pRace.toExponential(2) : `${fixed(odds.pRace * 100, 2)}%` },
        { label: "expected races", value: Number.isFinite(odds.expectedRaces) ? sig(odds.expectedRaces, 3) : "–" },
        { label: "expected time (one race per RTT)", value: duration(odds.expectedSeconds) },
        { label: "before 2008: one race per day (TTL 86,400 s)", value: duration(odds.expectedSecondsOldStyle(86400)) },
      ]} />
      {camp && !dnssec && <SmallLabel>A seeded run of races: the attacker won race {int(camp.races)}, after {duration(camp.seconds)}.</SmallLabel>}
    </Demo>
  );
}
