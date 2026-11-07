/** Demos for "ICMP": traceroute over a load-balanced path, path MTU discovery and black holes, and ICMP messages as bytes. */
import { useMemo } from "react";
import { Banner, Demo, MONO, Note, Param, SectionLabel, Stats, int, mono, range, seg, toggle, useParams } from "../../kit";
import { hex } from "../../sims/net";
import {
  ICMP_KINDS, PMTU_DEFAULTS, PM_NAMES, TR_LINKS, TR_NAMES, icmpBytes, icmpName, pmtuRun, traceroute, type IcmpKind,
} from "../../sims/net/ip";
import { SpaceTime } from "../dist/SpaceTime";
import { HeaderDiagram, fromPackets } from "./PacketViews";
import { TopoView, type TopoLink, type TopoNode } from "./NetIpUi";

// ============================================================================ 1. Traceroute

const TR = {
  probes: range({ label: "Probes per hop", min: 1, max: 3, step: 1, default: 3 }),
  mode: seg("Probes", [["classic", "classic: new port per probe"], ["paris", "Paris: same flow"]], "classic"),
  silent: toggle({ label: "B1 sends no ICMP errors", default: false }),
  limit: toggle({ label: "R3 rate-limits ICMP (one per 100 ms)", default: false }),
};

const TR_POS: [number, number][] = [[0.02, 0.5], [0.18, 0.5], [0.36, 0.12], [0.56, 0.12], [0.46, 0.88], [0.72, 0.5], [0.86, 0.5], [0.98, 0.5]];

export function NetIpTracerouteDemo() {
  const P = useParams("net-ip-trace", TR);
  const { probes, mode, silent, limit } = P.values;
  const r = useMemo(() => traceroute({ paris: mode === "paris", probesPerHop: probes, silent: silent ? [4] : [], rateLimit: limit ? [{ node: 5, gapMs: 100 }] : [] }), [mode, probes, silent, limit]);
  const answered = new Set(r.probes.flatMap((p) => (p.from === null ? [] : [p.from])));
  const nodes: TopoNode[] = TR_NAMES.map((n, i) => ({ id: i, label: n, x: TR_POS[i]![0], y: TR_POS[i]![1], square: i === 0 || i === 7, fill: answered.has(i) ? "var(--c1)" : undefined, color: answered.has(i) ? "var(--c1)" : "var(--muted)" }));
  const links: TopoLink[] = [
    ...TR_LINKS.map((l) => ({ a: l.a, b: l.b, label: l.cost !== 1 ? `cost ${l.cost}` : undefined })),
    ...r.falseLinks.filter(([a, b]) => a !== b).map(([a, b]) => ({ a, b, color: "var(--c4)", dashed: true, width: 2 })),
  ];
  const st = fromPackets(r.ip.net, {
    color: (p) => (p.payload.proto === "udp" ? "var(--c1)" : p.payload.icmp?.type === 3 ? "var(--c3)" : "var(--c2)"),
  });
  const tEnd = Math.ceil(Math.max(...r.probes.map((p) => p.sentAt)) / 50) * 50 + 50;
  const loops = r.falseLinks.filter(([a, b]) => a === b).length;
  return (
    <Demo title="Traceroute through a load balancer"
      controls={<>
        <Param spec={TR.probes} value={probes} onChange={(v) => P.set("probes", v as number)} />
        <Param spec={TR.mode} value={mode} onChange={(v) => P.set("mode", v as "classic")} />
        <Param spec={TR.silent} value={silent} onChange={(v) => P.set("silent", v as boolean)} />
        <Param spec={TR.limit} value={limit} onChange={(v) => P.set("limit", v as boolean)} />
      </>}
    >
      <TopoView nodes={nodes} links={links} height={170} r={15} />
      <Note>Every link costs 1 except R1–B1, so both branches from R1 to R3 cost 3. R1 spreads flows over them by a hash of the flow. Blue: routers that answered. Red dashed: links that the output implies but that do not exist.</Note>
      <SectionLabel>Output</SectionLabel>
      <pre style={{ ...mono, fontSize: 12.5, lineHeight: 1.55, margin: 0, overflowX: "auto" }}>
        {r.hops.map((h) => `${String(h.ttl).padStart(2)}  ${h.probes.map((p) => (p.from === null ? "*" : `${TR_NAMES[p.from]!.padEnd(3)} ${p.rtt!.toFixed(1)} ms`)).join("   ")}`).join("\n")}
      </pre>
      <SectionLabel>Probes (blue) and the ICMP answers: time exceeded (orange), port unreachable (green)</SectionLabel>
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={26} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "probes sent", value: r.probes.length },
          { label: "stars (no answer)", value: r.probes.filter((p) => p.from === null).length },
          { label: "false links in the output", value: r.falseLinks.length - loops },
          { label: "false loops (same router twice)", value: loops },
        ]} />
      </div>
      <Banner tone={r.falseLinks.length ? "bad" : "good"}>
        {r.falseLinks.length
          ? "Probes of one hop took different branches, so the output mixes two paths. Some consecutive routers in it are not neighbours at all."
          : "Every probe followed one path, so the output is a real path."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Path MTU discovery

const PM = {
  mtu: range({ label: "Tunnel MTU (R1–R2)", min: 1280, max: 1500, step: 20, default: 1400 }),
  block: toggle({ label: "Firewall in front of S drops all ICMP", default: false }),
  probing: toggle({ label: "S falls back to MSS 1024 after a timeout (MTU probing)", default: false }),
  clamp: toggle({ label: "Tunnel router clamps the MSS in the handshake", default: false }),
  nodf: toggle({ label: "DF off: routers fragment instead", default: false }),
};

export function NetIpPmtuDemo() {
  const P = useParams("net-ip-pmtu", PM);
  const { mtu, block, probing, clamp, nodf } = P.values;
  const r = useMemo(() => pmtuRun({ tunnelMtu: mtu, blockIcmp: block, probing, clamp, noDf: nodf }), [mtu, block, probing, clamp, nodf]);
  const view = r.done ? Math.max(200, Math.ceil((r.endAt + 20) / 50) * 50) : 1700;
  const firstOfSize = new Set<number>();
  const seen = new Set<number>();
  let icmpLabelled = false;
  for (const e of r.ip.net.trace) {
    if (e.kind !== "send") continue;
    if (e.node === 5 && e.pkt.payload.app?.len && !seen.has(e.pkt.size)) { seen.add(e.pkt.size); firstOfSize.add(e.pkt.id); }
    if (e.pkt.payload.icmp && !icmpLabelled) { icmpLabelled = true; firstOfSize.add(e.pkt.id); }
  }
  const st = fromPackets(r.ip.net, {
    label: (p) => (!firstOfSize.has(p.id) ? undefined : p.payload.icmp ? `MTU ${p.payload.icmp.mtu}` : `${p.size} B`),
    color: (p) => (p.payload.icmp ? "var(--c2)" : p.payload.app?.ack !== undefined ? "var(--faint)" : "var(--c1)"),
    filter: (p) => p.createdAt <= view,
  });
  const tone = r.done ? (r.timeouts ? "warn" : "good") : "bad";
  return (
    <Demo title="Path MTU discovery, and its black hole"
      controls={<>
        <Param spec={PM.mtu} value={mtu} onChange={(v) => P.set("mtu", v as number)} />
        <Param spec={PM.block} value={block} onChange={(v) => P.set("block", v as boolean)} />
        <Param spec={PM.probing} value={probing} onChange={(v) => P.set("probing", v as boolean)} />
        <Param spec={PM.clamp} value={clamp} onChange={(v) => P.set("clamp", v as boolean)} />
        <Param spec={PM.nodf} value={nodf} onChange={(v) => P.set("nodf", v as boolean)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Server S sends {int(PMTU_DEFAULTS.bytes)} bytes to client C over TCP, starting with MSS 1460 (1500-byte packets) and DF set. The link R1–R2 is a tunnel with a smaller MTU.</div>
      <SpaceTime nodes={PM_NAMES} tEnd={view} messages={st.messages} marks={st.marks} rowHeight={30} />
      <Note>Blue: data, labelled with its size the first time a size appears. Orange: ICMP "fragmentation needed" from R2; the first one is labelled with the MTU it reports. Grey: ACKs. The view shows the first {int(view)} ms.</Note>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "result", value: r.done ? `done at ${int(r.endAt)} ms` : `gave up at ${(r.endAt / 1000).toFixed(1)} s` },
          { label: "ICMP messages that reached S", value: r.icmpSeen },
          { label: "timeouts", value: r.timeouts },
          { label: "segments sent again", value: r.retransmits },
          { label: "final MSS", value: r.finalMss },
        ]} />
      </div>
      <Banner tone={tone}>
        {!r.done
          ? `Black hole. Small packets (the handshake, the ACKs) pass, but every 1500-byte packet dies at R2, and the ICMP that says why never reaches S. The connection hangs, then times out after ${r.timeouts - 1} retransmissions.`
          : nodf ? "R2 splits each big packet into two fragments, and C reassembles them. It works, at the cost of extra headers and the fragility of fragments."
          : clamp ? `No big packet is ever sent: the tunnel router rewrote the MSS to ${r.finalMss} in the handshake.`
          : r.icmpSeen ? `R2 dropped the big packets and told S the MTU. S lowered its MSS to ${r.finalMss} and sent the data again.`
          : r.timeouts ? `No ICMP arrived, but after a timeout S probed with smaller packets and recovered, ${int(r.endAt)} ms late.`
          : "Every packet fits."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. ICMP messages as bytes

const MSG = { kind: seg("Message", Object.entries(ICMP_KINDS).map(([k, v]) => [k as IcmpKind, v.name.replace("Destination unreachable: ", "Unreachable: ")]), "timeExceeded" as IcmpKind) };

export function NetIpIcmpMessageDemo() {
  const P = useParams("net-ip-icmpmsg", MSG);
  const kind = P.values.kind as IcmpKind;
  const { fields, bytes, checksum } = icmpBytes(kind);
  const k = ICMP_KINDS[kind];
  return (
    <Demo title="ICMP messages, byte by byte" controls={<Param spec={MSG.kind} value={kind} onChange={(v) => P.set("kind", v as IcmpKind)} />}>
      <HeaderDiagram fields={fields} colors={fields.map((f) => (f.name.startsWith("Original") ? "var(--c5)" : f.name === "Type" || f.name === "Code" ? "var(--c1)" : "var(--c2)"))}
        values={fields.map((f) => (f.name.includes("Address") ? undefined : f.name === "Checksum" ? `0x${checksum.toString(16).padStart(4, "0")}` : typeof f.value === "bigint" ? undefined : String(f.value)))} />
      <SectionLabel>{bytes.length} bytes after the IP header</SectionLabel>
      <pre style={{ fontFamily: MONO, fontSize: 12.5, margin: 0, lineHeight: 1.5, overflowX: "auto" }}>{hex(bytes, 8)}</pre>
      <Banner tone="plain">
        Type {k.type}, code {k.code}: {icmpName({ type: k.type, code: k.code })}.{" "}
        {k.error
          ? "An error message quotes the IP header and the first 8 bytes of the packet that caused it. For UDP or TCP, those 8 bytes hold both ports, so the sender can tell which socket the error is for."
          : "Echo messages carry an identifier and a sequence number, and the reply copies the data back, so ping can match replies and measure the round trip."}
      </Banner>
    </Demo>
  );
}
