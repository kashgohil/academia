/** Demos for "Layers and encapsulation": wrap a request layer by layer, corrupt it on the way, and cut it to fit an MTU. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Demo, Dots, Line, MiniTable, Param, Plot, RuleX, SectionLabel, Stats, StepCaption, fixed, int, pct, range, seg,
  toggle, useParams, GOOD, BAD, MONO,
} from "../../kit";
import { HeaderDiagram } from "./PacketViews";
import { HexDump, LayerBar, LayerKey, LAYER_COLOR, LAYER_LABEL } from "./NetFoundUi";
import { formatIpv4, formatMac, type Field } from "../../sims/net";
import {
  ETH_IFG, ETH_PREAMBLE, TUNNELS, buildFrame, corruptionRun, crossPath, fieldAt, flagNames, flipBit, swapWords, tunnelMtu,
  type BuiltFrame, type CorruptWhere, type LayerName, type Span,
} from "../../sims/net/foundations";

// ============================================================================ helpers

const PATHS: Record<string, string> = { short: "/", page: "/index.html", query: "/search?q=packet+switching&lang=en" };

/** The text under a field's name in the header diagram. */
function fieldValues(fields: Field[], layer: LayerName): (string | undefined)[] {
  return fields.map((f) => {
    const v = f.value;
    if (v instanceof Uint8Array) return f.bits === 48 ? formatMac(v) : `${v.length} bytes`;
    const n = Number(v ?? 0);
    if (layer === "ip" && f.bits === 32) return formatIpv4(n);
    if (/Checksum/.test(f.name)) return `0x${n.toString(16).padStart(4, "0")}`;
    if (f.name === "EtherType") return `0x${n.toString(16).padStart(4, "0")}`;
    if (layer === "tcp" && f.name === "Flags") return flagNames(n);
    return String(n);
  });
}

const headerOf = (b: BuiltFrame, layer: LayerName) => (layer === "eth" ? b.eth : layer === "ip" ? b.ip : layer === "tcp" ? b.tcp : undefined);

const PREAMBLE = Uint8Array.from([0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0xd5]);

// ============================================================================ 1. Wrap a request

const STEPS = [
  { name: "message", who: "User space", text: "The program calls write() on a TCP socket. The kernel copies these bytes into the socket's send buffer. The application never sees a header." },
  { name: "segment", who: "Kernel, TCP", text: "TCP adds 20 bytes (more with options): ports, the sequence number of the first byte, the ACK, the window and a checksum. In Linux this is tcp_transmit_skb." },
  { name: "packet", who: "Kernel, IP", text: "IP adds 20 bytes: the addresses, the TTL, the protocol number and a header checksum. It picks the route and the next hop (ip_queue_xmit)." },
  { name: "frame", who: "Kernel, driver and NIC", text: "The neighbour layer (neigh_output) copies in an Ethernet header with the next hop's MAC from ARP, and dev_queue_xmit queues the frame. The NIC reads it by DMA and appends the CRC-32 FCS." },
  { name: "bits on the wire", who: "NIC and PHY", text: "The PHY sends 8 bytes of preamble and start delimiter first, and after the frame it keeps 12 byte times of silence. Those 20 bytes carry no data but use the wire." },
];

const ENC = {
  step: range({ label: "Layers added", min: 0, max: 4, step: 1, default: 0, format: (v) => `${v}: ${STEPS[v]!.name}` }),
  path: seg("Request path", [["short", "/"], ["page", "/index.html"], ["query", "/search?q=…"]], "page"),
  ts: toggle({ label: "TCP timestamps option (Linux default)", default: false }),
};

export function EncapsulationDemo() {
  const P = useParams("net-found-enc", ENC);
  const { step, path, ts } = P.values;
  const b = useMemo(() => buildFrame({ path: PATHS[path], timestamps: ts }), [path, ts]);
  const [sel, setSel] = useState<number | undefined>(undefined);

  // The PDU at this step and where it starts inside the frame.
  const tcpStart = b.spans.find((s) => s.layer === "tcp")!.start, ipStart = b.spans.find((s) => s.layer === "ip")!.start;
  const appStart = b.spans.find((s) => s.layer === "app")!.start;
  const view = useMemo(() => {
    const keep = (from: number, to: number) => b.spans.filter((s) => s.start >= from && s.start < to).map((s) => ({ ...s, start: s.start - from }));
    if (step === 0) return { bytes: b.app, spans: keep(appStart, appStart + b.app.length), base: appStart };
    if (step === 1) return { bytes: b.segment, spans: keep(tcpStart, appStart + b.app.length), base: tcpStart };
    if (step === 2) return { bytes: b.packet, spans: keep(ipStart, appStart + b.app.length), base: ipStart };
    if (step === 3) return { bytes: b.frame, spans: b.spans, base: 0 };
    const bytes = new Uint8Array(PREAMBLE.length + b.frame.length);
    bytes.set(PREAMBLE);
    bytes.set(b.frame, PREAMBLE.length);
    const spans: Span[] = [{ layer: "preamble", start: 0, len: PREAMBLE.length }, ...b.spans.map((s) => ({ ...s, start: s.start + PREAMBLE.length }))];
    return { bytes, spans, base: -PREAMBLE.length };
  }, [b, step, appStart, tcpStart, ipStart]);

  const selFrame = sel !== undefined && sel < view.bytes.length ? sel + view.base : undefined;
  const at = selFrame !== undefined && selFrame >= 0 ? fieldAt(b, selFrame) : undefined;
  const newest: LayerName = step === 0 ? "app" : step === 1 ? "tcp" : step === 2 ? "ip" : "eth";
  const showLayer: LayerName = at && headerOf(b, at.layer) ? at.layer : newest;
  const fields = headerOf(b, showLayer);
  const field = at && at.layer === showLayer ? at.field : undefined;

  const parts = view.spans.map((s) => ({ layer: s.layer, bytes: s.len }));
  if (step === 4) parts.push({ layer: "ifg", bytes: ETH_IFG });
  const onWire = view.bytes.length + (step === 4 ? ETH_IFG : 0);
  const hdr = onWire - b.app.length;

  return (
    <Demo
      title="Wrap a request, one layer at a time"
      controls={<>
        <Param spec={ENC.step} value={step} onChange={(v) => { P.set("step", v as number); setSel(undefined); }} />
        <Param spec={ENC.ts} value={ts} onChange={(v) => P.set("ts", v as boolean)} />
        <Param spec={ENC.path} value={path} onChange={(v) => { P.set("path", v as never); setSel(undefined); }} />
      </>}
    >
      <LayerBar parts={parts} />
      <LayerKey layers={(["eth", "ip", "tcp", "app", ...(b.padding ? ["pad"] : []), ...(step === 4 ? ["preamble"] : [])] as LayerName[])} />
      <StepCaption label={`${STEPS[step]!.who}: the ${STEPS[step]!.name}`}>{STEPS[step]!.text}</StepCaption>
      <SectionLabel>Bytes of the {STEPS[step]!.name} (click a byte)</SectionLabel>
      <HexDump bytes={view.bytes} spans={view.spans} selected={sel} onSelect={(i) => setSel(i === sel ? undefined : i)} />
      {fields ? (
        <>
          <SectionLabel>{LAYER_LABEL[showLayer]}{field !== undefined ? `: ${fields[field]!.name}` : ""}</SectionLabel>
          <HeaderDiagram fields={fields} rowBits={showLayer === "eth" ? 48 : undefined} values={fieldValues(fields, showLayer)} selected={field} colors={fields.map(() => LAYER_COLOR[showLayer])}
            onSelect={(k) => {
              let bit = 0;
              for (let j = 0; j < k; j++) bit += fields[j]!.bits;
              const span = b.spans.find((s) => s.layer === showLayer)!;
              const frameIdx = span.start + Math.floor(bit / 8);
              const viewIdx = frameIdx - view.base;
              if (viewIdx >= 0 && viewIdx < view.bytes.length) setSel(viewIdx);
            }} />
          <div className="muted" style={{ fontSize: 12.5, minHeight: 18, marginTop: 4 }}>
            {field !== undefined ? `${fields[field]!.name}, ${fields[field]!.bits} bits${fields[field]!.note ? `: ${fields[field]!.note}` : ""}.` : "Click a field or a byte to see what it is for."}
          </div>
        </>
      ) : (
        <div style={{ fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", background: "var(--subtle)", padding: "6px 8px", borderRadius: 6, marginTop: 8 }}>
          {new TextDecoder().decode(b.app).split("\r\n").map((line, i, all) => i < all.length - 1 ? <div key={i}>{line}<span style={{ color: "var(--faint)" }}> \r\n</span></div> : null)}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: step === 4 ? "byte times on the wire" : `bytes in the ${STEPS[step]!.name}`, value: int(onWire) },
          { label: "of which HTTP", value: int(b.app.length) },
          { label: "headers and framing", value: int(hdr) },
          { label: "useful share", value: pct(b.app.length / onWire) },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Corrupt a byte

type Edit = { kind: "flip" | "swap"; i: number };

const COR = {
  where: seg<CorruptWhere>("Where the error happens", [["wire", "on the wire, router → server"], ["router", "in the router's memory"]], "router"),
};

const CHECK_LABEL: Record<string, string> = {
  fcs: "Ethernet FCS (CRC-32)", ethertype: "EtherType", version: "IP version", ihl: "IP header length", ipChecksum: "IPv4 header checksum",
  length: "IP total length", protocol: "IP protocol", tcpChecksum: "TCP checksum", port: "TCP port",
};

export function CorruptionDemo() {
  const P = useParams("net-found-cor", COR);
  const where = P.values.where;
  const b = useMemo(() => buildFrame({ path: "/index.html" }), []);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [sel, setSel] = useState<number | undefined>(undefined);
  const res = useMemo(() => corruptionRun(b, (buf) => { for (const e of edits) (e.kind === "flip" ? flipBit(e.i) : swapWords(e.i))(buf); }, where), [b, edits, where]);
  const marked = new Set<number>();
  for (const e of edits) {
    if (e.kind === "flip") marked.add(e.i);
    else for (let k = 0; k < 4; k++) marked.add((e.i & ~1) + k);
  }
  const appStart = b.spans.find((s) => s.layer === "app")!.start;
  const toggleFlip = (i: number) => {
    setSel(i);
    setEdits((es) => (es.some((e) => e.kind === "flip" && e.i === i) ? es.filter((e) => !(e.kind === "flip" && e.i === i)) : [...es, { kind: "flip", i }]));
  };
  const preset = (e: Edit[]) => { setEdits(e); setSel(e[0]?.i); };
  const lastOk = res.rx.checks.length > 0 && !res.rx.droppedAt;
  const failed = res.rx.checks.find((c) => !c.ok);
  const verdict = edits.length === 0
    ? { tone: "good" as const, text: "No errors yet. Every check passes and the server's socket gets the exact request." }
    : failed
      ? { tone: "good" as const, text: `Caught by the ${CHECK_LABEL[failed.check]} in the ${failed.where}. The frame is dropped silently; TCP on the client resends the data when no ACK comes back.` }
      : res.silent
        ? { tone: "bad" as const, text: "Every check passed, but the application got different bytes. Only an end-to-end check above TCP (a hash, or TLS) can catch this." }
        : { tone: "good" as const, text: res.overwritten ? "The router rewrote the bytes you changed (MAC addresses or FCS) before it sent the frame, so the error vanished." : "The change did not alter what the server received." };
  return (
    <Demo
      title="Corrupt a byte on its way"
      actions={<Btn ghost onClick={() => preset([])}>Clear</Btn>}
      controls={<Param spec={COR.where} value={where} onChange={(v) => P.set("where", v as CorruptWhere)} />}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Try:</span>
        <Btn onClick={() => preset([{ kind: "flip", i: appStart + 5 }])}>flip a bit in the HTTP text</Btn>
        <Btn onClick={() => preset([{ kind: "flip", i: 22 }])}>flip a bit of the TTL</Btn>
        <Btn onClick={() => preset([{ kind: "swap", i: appStart + 4 }])}>swap two 16-bit words</Btn>
        <Btn disabled={sel === undefined} onClick={() => sel !== undefined && setEdits((es) => [...es, { kind: "swap", i: sel }])}>swap at the selected byte</Btn>
      </ButtonRow>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>The client's frame. Click a byte to flip its lowest bit; click again to undo. Red bytes are changed.</div>
      <HexDump bytes={b.frame} spans={b.spans} marked={marked} selected={sel} onSelect={toggleFlip} />
      <LayerKey layers={["eth", "ip", "tcp", "app", "fcs"]} />
      <SectionLabel>What the server checks, in order</SectionLabel>
      {res.routerDropped ? (
        <Banner tone="good">The router itself dropped the frame.</Banner>
      ) : (
        <MiniTable
          head={["check", "who", "result"]}
          rows={[
            ...res.rx.checks.map((c) => [CHECK_LABEL[c.check], c.where, <span style={{ color: c.ok ? GOOD : BAD }}>{c.ok ? "pass" : "FAIL: drop"}</span>]),
            ...(lastOk ? [["application gets the bytes sent?", "the program", <span style={{ color: res.silent ? BAD : GOOD }}>{res.silent ? "NO: wrong bytes" : "yes"}</span>]] : []),
          ]}
          highlight={(i) => res.rx.checks[i] !== undefined && !res.rx.checks[i]!.ok}
        />
      )}
      <Banner tone={verdict.tone}>{verdict.text}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "bytes changed", value: marked.size },
          { label: "TTL at the server", value: res.rx.ttl ?? "–" },
          { label: "checks run", value: res.rx.checks.length },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. MTU and fragments

const MTU = {
  data: range({ label: "UDP payload", min: 100, max: 9000, step: 10, default: 4000, format: (v) => `${int(v)} bytes` }),
  link: seg("Narrow link on the path", TUNNELS.map((t) => [t.id, `${t.name}: ${tunnelMtu(t)}`] as [string, string]), "vxlan"),
  ip: seg("IP version", [["4", "IPv4"], ["6", "IPv6"]], "4"),
  df: toggle({ label: "Set DF (don't fragment), as path MTU discovery does", default: false }),
};

export function MtuDemo() {
  const P = useParams("net-found-mtu", MTU);
  const { data, link, ip, df } = P.values;
  const t = TUNNELS.find((x) => x.id === link)!;
  const mtu = tunnelMtu(t);
  const v = ip === "4" ? 4 : 6;
  const r = crossPath(data, mtu, { ip: v, df });
  const sweep = useMemo(() => {
    const pts: [number, number][] = [];
    for (let d = 100; d <= 9000; d += 20) pts.push([d, crossPath(d, mtu, { ip: v, df: false }).efficiency]);
    return pts;
  }, [mtu, v]);
  const maxLen = Math.max(1, ...r.fragments.map((f) => f.packetLen));
  const outcome = {
    fits: { tone: "good" as const, text: `One packet of ${int(r.fragments[0]?.packetLen ?? 0)} bytes fits the ${mtu}-byte link.` },
    fragmented: { tone: "warn" as const, text: `${r.fragments.length} fragments. The receiver must hold them all until the last one arrives. If any one is lost, the whole datagram is lost.` },
    "dropped-df": { tone: "bad" as const, text: r.reportMtu === 1500 ? "DF is set and the datagram is larger than the sender's own 1500-byte link: the sender's stack refuses it (EMSGSIZE)." : `DF is set, so the router drops the packet and sends ICMP type 3, code 4 ("fragmentation needed") with next-hop MTU ${r.reportMtu}. The sender must send smaller packets.` },
    "too-big-v6": { tone: "bad" as const, text: `IPv6 routers never fragment. The router drops the packet and sends ICMPv6 Packet Too Big (type 2) with MTU ${r.reportMtu}. The source must fragment or send less.` },
  }[r.outcome];
  return (
    <Demo
      title="Fit a datagram through a narrow link"
      controls={<>
        <Param spec={MTU.data} value={data} onChange={(x) => P.set("data", x as number)} />
        <Param spec={MTU.df} value={df} onChange={(x) => P.set("df", x as boolean)} />
        <Param spec={MTU.link} value={link} onChange={(x) => P.set("link", x as never)} />
        <Param spec={MTU.ip} value={ip} onChange={(x) => P.set("ip", x as never)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        sender (MTU 1500) → router → {t.name} (MTU {mtu}{t.overhead ? `: 1500 − ${t.overhead} for ${t.parts}` : ""}) → receiver
      </div>
      <SectionLabel>Packets after the narrow link</SectionLabel>
      {r.fragments.length === 0 ? <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>Nothing gets through.</div> : (
        <div style={{ display: "grid", gap: 3 }}>
          {r.fragments.map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--muted)", width: 46, flex: "none" }}>@{f.offset}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <LayerBar height={18} total={maxLen} parts={[{ layer: "ip", bytes: f.packetLen - f.len, label: "IP" }, { layer: "app", bytes: f.len, label: i === 0 ? "UDP + data" : "data" }]} />
              </div>
            </div>
          ))}
        </div>
      )}
      {r.fragments.length > 1 && (
        <div style={{ marginTop: 8 }}>
          <MiniTable
            head={["#", v === 4 ? "Total Length" : "Payload + headers", "data bytes", v === 4 ? "Offset field (×8)" : "Offset (×8)", "MF"]}
            rows={r.fragments.map((f, i) => [i + 1, int(f.packetLen), int(f.len), `${f.offsetField} (${f.offset})`, f.mf ? "1" : "0"])}
          />
        </div>
      )}
      <Banner tone={outcome.tone}>{outcome.text}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "packets", value: r.fragments.length },
          { label: "bytes on the wire (with Ethernet)", value: int(r.wireBytes) },
          { label: "payload share", value: r.fragments.length ? pct(r.efficiency) : "–" },
          { label: "wire per packet: preamble + gap", value: `${ETH_PREAMBLE + ETH_IFG} B` },
        ]} />
      </div>
      <SectionLabel>Payload share of the wire bytes, by payload size (no DF)</SectionLabel>
      <Plot x={[100, 9000]} y={[0.6, 1]} height={190} xLabel="UDP payload (bytes)" yFormat={(y) => `${Math.round(y * 100)}%`}>
        <Line points={sweep} color="var(--c2)" />
        <RuleX at={data} color="var(--muted)" />
        {r.fragments.length > 0 && <Dots points={[[data, r.efficiency]]} color="var(--c4)" r={4} />}
      </Plot>
      <div className="muted" style={{ fontSize: 12 }}>Each drop in the curve is one more fragment, with its own IP and Ethernet headers. Share at the current size: {r.fragments.length ? fixed(r.efficiency * 100, 1) : "–"}%.</div>
    </Demo>
  );
}
