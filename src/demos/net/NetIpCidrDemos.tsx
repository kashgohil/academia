/** Demos for "Subnetting and CIDR": a subnet calculator on the bits, a longest-prefix-match trie, and aggregation. */
import { useMemo, useState, type CSSProperties } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, MONO, MiniTable, Note, Param, SectionLabel, Stats, int, range, toggle, useParams } from "../../kit";
import { formatIpv4, parseIpv4, prefixMask } from "../../sims/net";
import { PrefixTrie, addressClass, aggregate, formatCidr, linearLpm, parseCidr, specialRange, subnetInfo, type Prefix } from "../../sims/net/ip";
import { AddressBits } from "./NetIpUi";

const inputStyle: CSSProperties = { font: "inherit", fontFamily: MONO, fontSize: 13, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--fg)", minWidth: 0 };

const tryIp = (s: string) => {
  try {
    return parseIpv4(s.trim());
  } catch {
    return null;
  }
};

// ============================================================================ 1. Subnet calculator

const SUB = { len: range({ label: "Prefix length", min: 0, max: 32, step: 1, default: 24, format: (v) => `/${v}` }) };
const ADDR_PRESETS = ["192.168.1.130", "10.20.30.40", "100.72.5.9", "172.31.255.1", "8.8.8.8", "169.254.10.20"];

export function NetIpSubnetDemo() {
  const P = useParams("net-ip-subnet", SUB);
  const { len } = P.values;
  const [text, setText] = useState(ADDR_PRESETS[0]!);
  const addr = tryIp(text);
  const info = addr === null ? null : subnetInfo(addr, len);
  const special = addr === null ? undefined : specialRange(addr);
  const cls = addr === null ? null : addressClass(addr);
  return (
    <Demo title="Network bits and host bits" controls={<Param spec={SUB.len} value={len} onChange={(v) => P.set("len", v as number)} />}>
      <ButtonRow style={{ marginBottom: 8 }}>
        {ADDR_PRESETS.map((a) => <Btn key={a} ghost={a !== text} onClick={() => setText(a)}>{a}</Btn>)}
      </ButtonRow>
      <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="IPv4 address" style={{ ...inputStyle, width: "100%", maxWidth: 260, boxSizing: "border-box" }} />
      {addr === null || !info ? <Banner tone="bad">Not an IPv4 address.</Banner> : (
        <>
          <SectionLabel>{text.trim()}/{len}: {len} network bits, {32 - len} host bits</SectionLabel>
          <AddressBits addr={addr} len={len} />
          <SectionLabel>Mask</SectionLabel>
          <AddressBits addr={info.mask} len={len} />
          <div style={{ marginTop: 10 }}>
            <Stats items={[
              { label: "network", value: `${formatIpv4(info.network)}/${len}` },
              { label: "mask", value: formatIpv4(info.mask) },
              { label: "broadcast", value: len >= 31 ? "none" : formatIpv4(info.broadcast) },
              { label: "usable hosts", value: int(info.hosts) },
              { label: "first host", value: formatIpv4(info.firstHost) },
              { label: "last host", value: formatIpv4(info.lastHost) },
              { label: "addresses", value: int(info.addresses) },
              { label: "wildcard (inverse mask)", value: formatIpv4(info.wildcard) },
            ]} />
          </div>
          <MiniTable head={["relative", "prefix", "addresses"]} rows={[
            ...(len > 0 ? [["parent", `${formatIpv4((info.network & prefixMask(len - 1)) >>> 0)}/${len - 1}`, int(info.addresses * 2)]] : []),
            ["this subnet", `${formatIpv4(info.network)}/${len}`, int(info.addresses)],
            ...(len < 32 ? [["lower half", `${formatIpv4(info.network)}/${len + 1}`, int(info.addresses / 2)], ["upper half", `${formatIpv4((info.network + info.addresses / 2) >>> 0)}/${len + 1}`, int(info.addresses / 2)]] : []),
          ]} highlight={len > 0 ? 1 : 0} />
          <Banner tone={special ? "warn" : "plain"}>
            {special ? `Special range: ${special.cidr} is ${special.name} (${special.rfc}).` : "An ordinary public address."}{" "}
            {cls && (cls.len ? `Before CIDR, it was class ${cls.cls}, with a fixed /${cls.len}.` : `Before CIDR, it was class ${cls.cls}.`)}
            {len === 31 ? " A /31 has no network or broadcast address: both addresses are hosts, for point-to-point links (RFC 3021)." : ""}
          </Banner>
        </>
      )}
    </Demo>
  );
}

// ============================================================================ 2. Longest-prefix match in a trie

const TABLE0: [string, string][] = [
  ["0.0.0.0/0", "ISP"], ["10.0.0.0/8", "core"], ["10.1.0.0/16", "dc1"], ["10.1.2.0/24", "rack7"], ["10.1.3.0/24", "rack8"],
  ["10.128.0.0/9", "dc2"], ["192.168.0.0/16", "lab"], ["192.168.10.0/24", "printers"],
];
const QUERIES = ["10.1.2.77", "10.1.9.1", "10.200.0.5", "10.2.0.1", "192.168.10.4", "8.8.8.8"];

export function NetIpLpmDemo() {
  const [routes, setRoutes] = useState<[string, string][]>(TABLE0);
  const [q, setQ] = useState(QUERIES[0]!);
  const [add, setAdd] = useState("10.1.2.128/25 rack7b");
  const addr = tryIp(q);
  const { trie, list } = useMemo(() => {
    const trie = new PrefixTrie<string>();
    const list: { prefix: Prefix; value: string }[] = [];
    for (const [c, v] of routes) {
      const p = parseCidr(c);
      trie.insert(p, v);
      list.push({ prefix: p, value: v });
    }
    return { trie, list };
  }, [routes]);
  const res = addr === null ? null : trie.lookup(addr);
  const lin = addr === null ? undefined : linearLpm(list, addr);
  const nodes = trie.compressed();
  const depth = (i: number): number => (nodes[i]!.parent < 0 ? 0 : depth(nodes[i]!.parent) + 1);
  const onPath = new Set(res ? res.candidates.map((c) => formatCidr(c.prefix)) : []);
  const containsAddr = (p: Prefix) => addr !== null && ((addr & prefixMask(p.len)) >>> 0) === p.net;
  const valueOf = new Map(routes.map(([c, v]) => [formatCidr(parseCidr(c)), v]));
  const tryAdd = () => {
    const [c, v] = add.trim().split(/\s+/);
    try {
      const p = parseCidr(c!);
      const k = formatCidr(p);
      setRoutes([...routes.filter(([x]) => formatCidr(parseCidr(x)) !== k), [k, v ?? "new"]]);
    } catch { /* ignore bad text */ }
  };
  // Depth-first order for the indented view.
  const order: number[] = [];
  const kids = (i: number) => nodes.map((n, j) => [n, j] as const).filter(([n]) => n.parent === i).map(([, j]) => j);
  const visit = (i: number) => { order.push(i); for (const k of kids(i)) visit(k); };
  if (nodes.length) visit(0);
  return (
    <Demo title="Longest-prefix match in a trie">
      <ButtonRow style={{ marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Look up:</span>
        {QUERIES.map((a) => <Btn key={a} ghost={a !== q} onClick={() => setQ(a)}>{a}</Btn>)}
      </ButtonRow>
      <input value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} aria-label="destination address" style={{ ...inputStyle, width: 170 }} />
      {addr !== null && res && (
        <>
          <SectionLabel>Destination bits; the match covers the first {res.match?.prefix.len ?? 0}</SectionLabel>
          <AddressBits addr={addr} len={res.match?.prefix.len ?? 0} />
        </>
      )}
      <SectionLabel>The table as a trie (branch points without a route are grey)</SectionLabel>
      <div style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: "22px", overflowX: "auto" }}>
        {order.map((i) => {
          const n = nodes[i]!;
          const k = formatCidr(n.prefix);
          const match = res?.match && formatCidr(res.match.prefix) === k;
          const passed = onPath.has(k);
          const walked = containsAddr(n.prefix);
          return (
            <div key={k} style={{ paddingLeft: depth(i) * 14, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: walked ? "var(--fg)" : "var(--faint)" }}>{depth(i) ? "└" : ""}</span>
              <span style={{
                padding: "0 5px", borderRadius: 4,
                background: match ? "color-mix(in srgb, var(--c3) 30%, var(--bg))" : passed ? "color-mix(in srgb, var(--c1) 16%, var(--bg))" : undefined,
                border: match ? "1.5px solid var(--c3)" : "1.5px solid transparent",
                color: n.route ? "var(--fg)" : "var(--muted)",
              }}>{k}{n.route ? ` → ${valueOf.get(k)}` : ""}</span>
              {n.route && <button className="btn ghost" style={{ padding: "0 5px", fontSize: 11, lineHeight: "16px" }} onClick={() => setRoutes(routes.filter(([c]) => formatCidr(parseCidr(c)) !== k))} aria-label={`remove ${k}`}>×</button>}
            </div>
          );
        })}
      </div>
      <ButtonRow style={{ marginTop: 8 }}>
        <input value={add} onChange={(e) => setAdd(e.target.value)} spellCheck={false} aria-label="route to add" style={{ ...inputStyle, width: 200 }} />
        <Btn onClick={tryAdd}>Add route</Btn>
        <Btn ghost onClick={() => setRoutes(TABLE0)}>Reset table</Btn>
      </ButtonRow>
      {addr === null ? <Banner tone="bad">Not an IPv4 address.</Banner> : res && (
        <>
          <Banner tone={res.match ? "good" : "bad"}>
            {res.match ? <>Next hop <b>{res.match.value}</b> via {formatCidr(res.match.prefix)}. Routes that also match: {res.candidates.slice(0, -1).map((c) => formatCidr(c.prefix)).join(", ") || "none"}.</> : "No route matches: the router drops the packet and sends ICMP destination unreachable."}
          </Banner>
          <div style={{ marginTop: 10 }}>
            <Stats items={[
              { label: "trie: bits examined", value: res.steps },
              { label: "linear scan: routes compared", value: list.length },
              { label: "both agree", value: (lin && res.match && formatCidr(lin.prefix) === formatCidr(res.match.prefix)) || (!lin && !res.match) ? "yes" : "no" },
            ]} />
          </div>
        </>
      )}
      <Note>A real table holds about a million IPv4 prefixes. The trie still walks at most 32 bits; a linear scan would compare a million routes per packet.</Note>
    </Demo>
  );
}

// ============================================================================ 3. Aggregation

const AGG_BASE = parseIpv4("10.20.0.0");
const AGG = { overclaim: toggle({ label: "Announce one /21 even if some /24s are missing", default: false }) };

export function NetIpAggregateDemo() {
  const P = useParams("net-ip-agg", AGG);
  const { overclaim } = P.values;
  const [have, setHave] = useState<boolean[]>([true, true, true, true, true, true, false, true]);
  const prefixes = have.flatMap((h, i) => (h ? [{ net: (AGG_BASE + i * 256) >>> 0, len: 24 }] : []));
  const agg = aggregate(prefixes);
  const announced = overclaim && prefixes.length ? [{ net: AGG_BASE, len: 21 }] : agg;
  const holes = have.filter((h) => !h).length;
  const blackholed = overclaim && prefixes.length ? holes * 256 : 0;
  const coverOf = (i: number) => announced.findIndex((p) => ((AGG_BASE + i * 256) & prefixMask(p.len)) >>> 0 === p.net && p.len <= 24);
  const COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];
  return (
    <Demo title="Summarize routes" controls={<Param spec={AGG.overclaim} value={overclaim} onChange={(v) => P.set("overclaim", v as boolean)} />}>
      <SmallBlocksHelp />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {have.map((h, i) => {
          const c = coverOf(i);
          const col = c >= 0 ? COLORS[c % 4]! : "var(--border)";
          return (
            <button key={i} onClick={() => setHave(have.map((x, j) => (j === i ? !x : x)))}
              style={{ font: "inherit", fontFamily: MONO, fontSize: 11.5, padding: "6px 2px", borderRadius: 4, cursor: "pointer", color: "var(--fg)",
                border: `1.5px ${h ? "solid" : "dashed"} ${h ? col : c >= 0 ? "var(--c4)" : "var(--border)"}`,
                background: h ? `color-mix(in srgb, ${col} 22%, var(--bg))` : c >= 0 ? "color-mix(in srgb, var(--c4) 10%, var(--bg))" : "var(--bg)" }}>
              10.20.{i}.0/24
              <div className="muted" style={{ fontSize: 10.5 }}>{h ? "in use" : c >= 0 ? "black hole" : "not ours"}</div>
            </button>
          );
        })}
      </div>
      <SectionLabel>Announced</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {announced.map((p, i) => <Chip key={formatCidr(p)} color={COLORS[i % 4]}>{formatCidr(p)}</Chip>)}
        {!announced.length && <span className="muted" style={{ fontSize: 12.5 }}>nothing</span>}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "/24 routes", value: prefixes.length },
          { label: "routes announced", value: announced.length },
          { label: "addresses that attract traffic but go nowhere", value: int(blackholed) },
        ]} />
      </div>
      <Banner tone={blackholed ? "bad" : announced.length === 1 && prefixes.length === 8 ? "good" : "plain"}>
        {blackholed
          ? `The /21 also covers ${holes} /24${holes > 1 ? "s" : ""} that the network does not have. Traffic for them arrives and is dropped, unless a more specific route elsewhere wins.`
          : prefixes.length === 8 ? "All eight /24s are present, so one /21 says the same as eight routes."
          : "Two prefixes merge only when they are the two halves of the same parent, so one hole splits the summary into several routes."}
      </Banner>
    </Demo>
  );
}

const SmallBlocksHelp = () => <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Eight /24s that form 10.20.0.0/21. Click a block to add or remove it.</div>;

