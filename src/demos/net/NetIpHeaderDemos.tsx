/** Demos for "IPv4 and IPv6": an editable IPv4 header, fragmentation, IPv6 address text, and IPv6 header chains. */
import { useMemo, useState, type CSSProperties } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Legend, Line, MONO, MiniTable, Note, Param, Plot, RuleX, SectionLabel, Stats, int, mono, pct, range, seg, toggle, useParams,
} from "../../kit";
import { formatIpv4, hex } from "../../sims/net";
import {
  EXT_HEADERS, EXT_ORDER, IPV4_HEADER_BYTES, PROTOCOLS, UPPER, datagramSurvival, decrementTtl, defaultIpv4, expandIpv6, extensionChain, formatIpv6,
  forwardIpv4, ipv4Bytes, ipv4Checksum, ipv4Fields, ipv6Fields, ipv6Kind, parseIpv4Header, parseIpv6, type ExtKind, type Ipv4Header,
} from "../../sims/net/ip";
import { HeaderDiagram } from "./PacketViews";

const inputStyle: CSSProperties = { font: "inherit", fontFamily: MONO, fontSize: 13, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--fg)", minWidth: 0 };
const hex4 = (v: number) => `0x${v.toString(16).padStart(4, "0")}`;

// ============================================================================ 1. An IPv4 header you can edit

const V4 = {
  ttl: range({ label: "TTL", min: 0, max: 255, step: 1, default: 64 }),
  fix: toggle({ label: "Sender computes the checksum after each edit", default: true }),
};

/** Fields the learner can edit by clicking them, with their bounds. */
const EDITABLE: Record<number, { key: keyof Ipv4Header; max: number }> = {
  0: { key: "version", max: 15 }, 1: { key: "ihl", max: 15 }, 2: { key: "dscp", max: 63 }, 3: { key: "ecn", max: 3 }, 4: { key: "totalLength", max: 65535 },
  5: { key: "id", max: 65535 }, 9: { key: "fragOffset", max: 8191 }, 11: { key: "protocol", max: 255 }, 12: { key: "checksum", max: 65535 },
};

export function NetIpV4HeaderDemo() {
  const P = useParams("net-ip-v4", V4);
  const { ttl, fix } = P.values;
  const [edits, setEdits] = useState<Partial<Ipv4Header>>({});
  const [sel, setSel] = useState(10);
  const [hops, setHops] = useState<{ ttl: number; inc: number; full: number }[]>([]);
  const base: Ipv4Header = { ...defaultIpv4(), ...edits, ttl };
  const header: Ipv4Header = fix ? { ...base, checksum: ipv4Checksum(base) } : { ...base, checksum: edits.checksum ?? ipv4Checksum(defaultIpv4({ ttl: 64 })) };
  const bytes = ipv4Bytes(header, false);
  const parsed = parseIpv4Header(bytes);
  const fields = ipv4Fields(header);
  const values = fields.map((f, i) => {
    const v = Number(f.value as number);
    if (i === 13 || i === 14) return formatIpv4(v);
    if (i === 12) return hex4(v);
    if (i === 11) return PROTOCOLS[v] ? `${v} ${PROTOCOLS[v]}` : String(v);
    return String(v);
  });
  const ed = EDITABLE[sel];
  const forward = () => {
    let h = { ...header };
    const out: typeof hops = [];
    if (h.ttl <= 1) return;
    const d = decrementTtl(h);
    out.push({ ttl: d.header.ttl, inc: d.incremental, full: d.full });
    h = d.header;
    setHops([...hops, ...out]);
    P.set("ttl", h.ttl);
    if (!fix) setEdits({ ...edits, checksum: d.incremental });
  };
  const verdict = parsed.problems.length ? `Dropped: ${parsed.problems.join("; ")}` : header.ttl === 0 ? "The header is valid, but TTL is 0: a router must drop it" : "A receiver accepts this header";
  return (
    <Demo
      title="An IPv4 header you can edit"
      actions={<>
        <Btn onClick={forward} disabled={header.ttl <= 1}>Forward through a router</Btn>
        <Btn ghost onClick={() => { setEdits({}); setHops([]); P.reset(); }}>Reset</Btn>
      </>}
      controls={<>
        <Param spec={V4.ttl} value={ttl} onChange={(v) => P.set("ttl", v as number)} />
        <Param spec={V4.fix} value={fix} onChange={(v) => P.set("fix", v as boolean)} />
      </>}
    >
      <HeaderDiagram fields={fields} selected={sel} onSelect={setSel} values={values} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 8, fontSize: 13 }}>
        <span className="muted">Selected: <b style={{ color: "var(--fg)" }}>{fields[sel]!.name}</b> ({fields[sel]!.bits} bits). {fields[sel]!.note ?? ""}</span>
        {ed && (ed.key !== "checksum" || !fix) && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="muted">value</span>
            <input type="number" min={0} max={ed.max} value={Number(header[ed.key] ?? 0)} style={{ ...inputStyle, width: 90 }}
              onChange={(e) => setEdits({ ...edits, [ed.key]: Math.max(0, Math.min(ed.max, Math.floor(Number(e.target.value) || 0))) })} />
          </label>
        )}
        {sel === 10 && <span className="muted">Use the TTL slider below.</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 10 }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>The 20 bytes on the wire</SectionLabel>
          <pre style={{ ...mono, fontSize: 13, margin: 0, lineHeight: 1.5 }}>{hex(bytes, 4)}</pre>
        </div>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Checksum</SectionLabel>
          <Stats items={[
            { label: "in the header", value: hex4(header.checksum!) },
            { label: "correct value", value: hex4(ipv4Checksum(header)) },
            { label: "receiver's check", value: parsed.checksumOk ? "sum = 0xffff" : "mismatch" },
          ]} />
        </div>
      </div>
      <Banner tone={parsed.problems.length || header.ttl === 0 ? "bad" : "good"}>{verdict}.</Banner>
      {hops.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <MiniTable head={["router", "TTL after", "checksum (RFC 1624 update)", "checksum (full recompute)"]}
            rows={hops.map((h, i) => [`R${i + 1}`, h.ttl, hex4(h.inc), hex4(h.full)])} />
        </div>
      )}
    </Demo>
  );
}

// ============================================================================ 2. Fragmentation

const FR = {
  payload: range({ label: "Data in the datagram", min: 100, max: 9000, step: 20, default: 4000, format: (v) => `${int(v)} bytes` }),
  mtu: seg("Next link's MTU", [["1500", "1500"], ["1400", "1400"], ["1280", "1280"], ["576", "576"]], "1500"),
  df: toggle({ label: "DF (Do not Fragment) set", default: false }),
  loss: range({ label: "Loss per packet", min: 0, max: 0.1, step: 0.005, default: 0.01, format: (v) => pct(v, 1) }),
};

const FRAG_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

export function NetIpFragmentDemo() {
  const P = useParams("net-ip-frag", FR);
  const { payload, df, loss } = P.values;
  const mtu = Number(P.values.mtu);
  const r = forwardIpv4(payload, mtu, df);
  const frags = r.kind === "dropped" ? [] : r.fragments;
  const k = frags.length;
  const wire = frags.reduce((s, f) => s + f.totalLength, 0);
  const curve = (n: number) => Array.from({ length: 41 }, (_, i) => [(i / 40) * 0.1, datagramSurvival(n, (i / 40) * 0.1)] as [number, number]);
  return (
    <Demo
      title="A router splits a datagram"
      controls={<>
        <Param spec={FR.payload} value={payload} onChange={(v) => P.set("payload", v as number)} />
        <Param spec={FR.mtu} value={P.values.mtu} onChange={(v) => P.set("mtu", v as "1500")} />
        <Param spec={FR.df} value={df} onChange={(v) => P.set("df", v as boolean)} />
        <Param spec={FR.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>The datagram: {int(payload + IPV4_HEADER_BYTES)} bytes</SectionLabel>
      <div style={{ display: "flex", height: 26, border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${(IPV4_HEADER_BYTES / (payload + IPV4_HEADER_BYTES)) * 100}%`, minWidth: 3, background: "var(--faint)" }} title="header" />
        {r.kind === "dropped"
          ? <div style={{ flex: 1, background: "color-mix(in srgb, var(--c4) 25%, var(--bg))" }} />
          : frags.map((f, i) => <div key={i} style={{ width: `${(f.dataBytes / (payload + IPV4_HEADER_BYTES)) * 100}%`, background: `color-mix(in srgb, ${FRAG_COLORS[i % 4]} 40%, var(--bg))`, borderLeft: i ? "1px solid var(--bg)" : undefined }} />)}
      </div>
      {r.kind === "dropped" ? (
        <Banner tone="bad">DF is set and {int(payload + IPV4_HEADER_BYTES)} bytes do not fit in {mtu}. The router drops the datagram and sends ICMP type 3, code 4 (fragmentation needed), with next-hop MTU {mtu}.</Banner>
      ) : (
        <>
          <SectionLabel>On the next link: {k} packet{k > 1 ? "s" : ""}</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {frags.slice(0, 12).map((f, i) => (
              <div key={i} style={{ border: `1.5px solid ${FRAG_COLORS[i % 4]}`, borderRadius: 5, padding: "3px 7px", fontSize: 12, ...mono }}>
                <div>#{i + 1}: {int(f.totalLength)} B</div>
                <div className="muted">offset {f.offsetField} · MF {f.mf ? 1 : 0}</div>
              </div>
            ))}
            {k > 12 && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>and {k - 12} more</span>}
          </div>
        </>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 10 }}>
        <Stats items={[
          { label: "fragments", value: r.kind === "dropped" ? "0 (dropped)" : k },
          { label: "bytes on the wire", value: int(wire) },
          { label: "extra header bytes", value: int(Math.max(0, wire - payload - IPV4_HEADER_BYTES)) },
          { label: "datagram arrives", value: r.kind === "dropped" ? "never" : pct(datagramSurvival(k, loss), 1) },
        ]} />
        <div>
          <Plot x={[0, 0.1]} y={[0, 1]} height={170} xLabel="loss per packet" yLabel="datagram arrives" xFormat={(v) => pct(v, 0)} yFormat={(v) => pct(v, 0)}>
            <Line points={curve(1)} color="var(--c3)" />
            {k > 1 && <Line points={curve(k)} color="var(--c4)" />}
            <RuleX at={loss} />
          </Plot>
          <Legend items={[{ label: "1 packet", color: "var(--c3)" }, ...(k > 1 ? [{ label: `${k} fragments`, color: "var(--c4)" }] : [])]} />
        </div>
      </div>
      <Note>Every fragment but the last carries a multiple of 8 data bytes, because the offset field counts 8-byte units. The receiver must get every fragment; it cannot ask for one again.</Note>
    </Demo>
  );
}

// ============================================================================ 3. IPv6 address text

const V6_PRESETS = ["2001:0db8:0000:0000:0000:ff00:0042:8329", "2001:db8:0:1:0:0:0:1", "2001:db8:0:0:1:0:0:1", "fe80::1ff:fe23:4567:890a", "::1", "ff02::1", "::ffff:192.0.2.1", "fd12:3456:789a:1::1"];

export function NetIpV6AddressDemo() {
  const [text, setText] = useState(V6_PRESETS[0]!);
  let parsed: Uint8Array | null = null, err = "";
  try {
    parsed = parseIpv6(text);
  } catch (e) {
    err = (e as Error).message;
  }
  const groups = parsed ? expandIpv6(parsed).split(":") : [];
  return (
    <Demo title="IPv6 address text">
      <ButtonRow style={{ marginBottom: 8 }}>
        {V6_PRESETS.map((p) => <Btn key={p} ghost={p !== text} onClick={() => setText(p)}>{p.length > 22 ? `${p.slice(0, 20)}…` : p}</Btn>)}
      </ButtonRow>
      <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="IPv6 address" style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} />
      {parsed ? (
        <>
          <SectionLabel>128 bits as eight 16-bit groups</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(62px, 1fr))", gap: 4 }}>
            {groups.map((g, i) => (
              <div key={i} style={{ textAlign: "center", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 0", fontFamily: MONO, fontSize: 13, background: g === "0000" ? "var(--subtle)" : `color-mix(in srgb, var(--c1) 12%, var(--bg))`, color: g === "0000" ? "var(--muted)" : "var(--fg)" }}>{g}</div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <Stats items={[
              { label: "canonical text (RFC 5952)", value: formatIpv6(parsed) },
              { label: "kind", value: ipv6Kind(parsed) },
              { label: "same as typed?", value: formatIpv6(parsed) === text.trim() ? "yes" : "no" },
            ]} />
          </div>
        </>
      ) : (
        <Banner tone="bad">{err}</Banner>
      )}
      <Note>"::" stands for one run of zero groups, so it may appear only once. The canonical form uses it for the longest run (the first one if two tie), never for a single zero group, and writes hex in lower case.</Note>
    </Demo>
  );
}

// ============================================================================ 4. IPv6 header and extension headers

const CH = {
  upper: seg("Upper layer", [["6", "TCP"], ["17", "UDP"], ["58", "ICMPv6"]], "6"),
};

export function NetIpV6ChainDemo() {
  const P = useParams("net-ip-v6chain", CH);
  const upper = Number(P.values.upper);
  const [exts, setExts] = useState<ExtKind[]>(["fragment"]);
  const { chain, firstNextHeader, headerBytes } = useMemo(() => extensionChain(exts, upper), [exts, upper]);
  const fields = ipv6Fields({ trafficClass: 0, flowLabel: 0x5f1e2, payloadLength: headerBytes - 40 + 512, nextHeader: firstNextHeader, hopLimit: 64, src: parseIpv6("2001:db8::10"), dst: parseIpv6("2001:db8:1::20") });
  const nhName = (nh: number) => UPPER[nh] ?? EXT_HEADERS[EXT_ORDER.find((k) => EXT_HEADERS[k].nh === nh) ?? "hbh"].name.split(" ")[0];
  const values = fields.map((f, i) => (i === 6 ? "2001:db8::10" : i === 7 ? "2001:db8:1::20" : i === 4 ? `${Number(f.value)} ${nhName(Number(f.value))}` : i === 2 ? `0x${Number(f.value).toString(16)}` : String(f.value)));
  const flip = (k: ExtKind) => setExts(exts.includes(k) ? exts.filter((x) => x !== k) : [...exts, k]);
  return (
    <Demo title="The IPv6 header and its chain"
      controls={<Param spec={CH.upper} value={P.values.upper} onChange={(v) => P.set("upper", v as "6")} />}
    >
      <HeaderDiagram fields={fields} values={values} />
      <SectionLabel>Extension headers (click to add or remove)</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {EXT_ORDER.map((k) => <Chip key={k} color={exts.includes(k) ? "var(--c1)" : "var(--muted)"} filled={exts.includes(k)} onClick={() => flip(k)}>{EXT_HEADERS[k].name.replace(" (for the routing header)", " (1st)")}</Chip>)}
      </div>
      <SectionLabel>The chain a receiver walks</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", fontSize: 12.5 }}>
        {chain.map((c, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            {i > 0 && <span className="muted" style={mono}>→ {c.nh} →</span>}
            <span style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px", background: i === 0 ? "var(--subtle)" : undefined }}>{c.name} <span className="muted" style={mono}>{c.bytes} B</span></span>
          </span>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "IP headers before the payload", value: `${headerBytes} B` },
          { label: "IPv4 equivalent", value: "20 B" },
          { label: "Next Header in the fixed header", value: firstNextHeader },
        ]} />
      </div>
      <Note>Each header names the type of the next one, so a router that wants the TCP ports must walk the whole chain. Only Hop-by-Hop Options is meant for routers on the path; the others are for the destination or the nodes a routing header lists.</Note>
    </Demo>
  );
}

