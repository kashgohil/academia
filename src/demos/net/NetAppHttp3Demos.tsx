/** Demos for "HTTP/3". Bytes from src/sims/net/apps/http3.ts and qpack.ts; the runs are PacketNet runs. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Legend, MiniTable, Param, SmallLabel, Stats, fixed, int, mono, range, seg, tint, toggle, useParams,
} from "../../kit";
import { SpaceTime, type StMark } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { HexSpans, type ByteSpan } from "./NetAppUi";
import { hex } from "../../sims/net";
import {
  DISCOVERY_NODES, RACE_PATHS, clientStreams, discoveryRun, headerRace, varint, type Discovery, type DiscoveryMsg, type HeaderScheme,
} from "../../sims/net/apps";

const PART_COLORS = ["var(--c5)", "var(--c1)", "var(--c3)", "var(--c2)", "var(--c4)"];

// ============================================================================ 1. Streams and frames

const ST = {
  cap: seg<"0" | "4096">("QPACK dynamic table", [["0", "off (capacity 0)"], ["4096", "4,096 bytes"]], "4096"),
  value: range({ label: "Encode a number as a QUIC varint", min: 1, max: 1e10, step: 1, default: 15293, log: true, format: (v) => int(Math.round(v)) }),
};

export function NetAppH3StreamsDemo() {
  const P = useParams("net-app-h3s", ST);
  const cap = Number(P.values.cap);
  const value = Math.round(P.values.value);
  const streams = useMemo(() => clientStreams(RACE_PATHS, { capacity: cap, blocked: cap ? 100 : 0, allowBlocking: true }), [cap]);
  const [sel, setSel] = useState(3);
  const s = streams[Math.min(sel, streams.length - 1)]!;
  const bytes = new Uint8Array(s.parts.reduce((a, p) => a + p.bytes.length, 0));
  const spans: ByteSpan[] = [];
  let at = 0;
  s.parts.forEach((p, i) => {
    bytes.set(p.bytes, at);
    spans.push({ start: at, end: at + p.bytes.length, color: PART_COLORS[i % PART_COLORS.length]!, label: p.label });
    at += p.bytes.length;
  });
  const v = varint(value);
  const total = streams.reduce((a, x) => a + x.parts.reduce((b, p) => b + p.bytes.length, 0), 0);
  const prefix = v[0]! >> 6;
  return (
    <Demo
      title="Three GET requests on QUIC streams"
      controls={<>
        <Param spec={ST.cap} value={P.values.cap} onChange={(x) => P.set("cap", x as "0" | "4096")} />
        <Param spec={ST.value} value={P.values.value} onChange={(x) => P.set("value", x as number)} />
      </>}
    >
      <SmallLabel>The client's streams. Click one to see its bytes.</SmallLabel>
      <ButtonRow style={{ marginBottom: 8 }}>
        {streams.map((x, i) => (
          <Chip key={x.id} color={x.id % 4 === 2 ? "var(--c5)" : "var(--c1)"} filled={i === sel} onClick={() => setSel(i)}>{`${x.id}: ${x.label}`}</Chip>
        ))}
      </ButtonRow>
      <div style={{ fontSize: 13, marginBottom: 4 }}>
        Stream <b>{s.id}</b>: {s.id % 4 === 2 ? "client-opened, unidirectional" : "client-opened, bidirectional"} (low bits {(s.id & 3).toString(2).padStart(2, "0")}), {bytes.length} bytes
      </div>
      <HexSpans bytes={bytes} spans={spans} maxRows={8} />
      <ol style={{ fontSize: 12.5, margin: "6px 0 0", paddingLeft: 20, lineHeight: 1.5 }}>
        {s.parts.map((p, i) => <li key={i}><span style={{ color: PART_COLORS[i % PART_COLORS.length] }}>■</span> {p.label} <span className="muted" style={mono}>({p.bytes.length} B)</span></li>)}
      </ol>
      <Stats items={[
        { label: "all client stream bytes", value: `${int(total)} B` },
        { label: "request streams' HEADERS", value: streams.slice(3).map((x) => `${x.parts[0]!.bytes.length} B`).join(", ") },
      ]} />
      <SmallLabel style={{ marginTop: 8 }}>A variable-length integer (RFC 9000 section 16): the top 2 bits give the length</SmallLabel>
      <div style={{ ...mono, fontSize: 13, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {[...v].map((b, i) => (
          <span key={i} style={{ padding: "2px 6px", borderRadius: 4, background: tint(i === 0 ? "var(--c2)" : "var(--c1)", 18) }}>
            {i === 0 ? <><b style={{ color: "var(--c2)" }}>{(b >> 6).toString(2).padStart(2, "0")}</b>{(b & 63).toString(2).padStart(6, "0")}</> : b.toString(2).padStart(8, "0")}
          </span>
        ))}
        <span className="muted">= {hex(v)}: prefix {prefix.toString(2).padStart(2, "0")}, {v.length} byte{v.length > 1 ? "s" : ""}, up to {["63", "16,383", "1,073,741,823", "2⁶² − 1"][prefix]}</span>
      </div>
    </Demo>
  );
}

// ============================================================================ 2. HPACK cannot work over QUIC

const QR = {
  scheme: seg<HeaderScheme>("Header compression", [["hpack", "HPACK"], ["qpack-blocking", "QPACK, may block"], ["qpack-safe", "QPACK, never blocks"]], "hpack"),
  rtt: range({ label: "RTT", min: 10, max: 200, step: 10, default: 40, format: (v) => `${v} ms` }),
};

export function NetAppQpackDemo() {
  const P = useParams("net-app-qpack", QR);
  const { scheme, rtt } = P.values;
  const [drop, setDrop] = useState<number[]>([0]);
  const run = useMemo(() => headerRace({ scheme, drop, rttMs: rtt }), [scheme, drop, rtt]);
  const toggleDrop = (pn: number) => setDrop(drop.includes(pn) ? drop.filter((x) => x !== pn) : [...drop, pn].sort((a, b) => a - b));
  const st = fromPackets(run.net, {
    label: (p) => (p.payload.kind === "enc" ? "enc" : `s${p.payload.stream}`),
    color: (p) => (p.payload.kind === "enc" ? "var(--c5)" : "var(--c1)"),
  });
  const marks: StMark[] = [
    ...st.marks,
    ...run.outcomes.map((o) => ({ node: 1, t: o.decodedAt, label: `s${o.stream}`, color: o.ok ? "var(--c3)" : "var(--c4)" })),
  ];
  const tEnd = Math.max(...run.outcomes.map((o) => o.decodedAt), rtt) * 1.08 + 4;
  const bad = run.outcomes.filter((o) => !o.ok).length;
  return (
    <Demo
      title="Header blocks on independent streams, one packet lost"
      actions={<Btn ghost onClick={() => setDrop([])}>No loss</Btn>}
      controls={<>
        <Param spec={QR.scheme} value={scheme} onChange={(v) => { P.set("scheme", v as HeaderScheme); setDrop([0]); }} />
        <Param spec={QR.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
      </>}
    >
      <SmallLabel>Packets in sending order. Click to lose one; it is sent again when the loss is detected.</SmallLabel>
      <ButtonRow style={{ gap: 4, marginBottom: 8 }}>
        {run.packets.map((p) => (
          <Chip key={p.pn} color={p.kind === "enc" ? "var(--c5)" : "var(--c1)"} filled={!drop.includes(p.pn)} strike={drop.includes(p.pn)} onClick={() => toggleDrop(p.pn)} title={p.label}>
            {`${p.pn}: ${p.kind === "enc" ? "encoder" : `stream ${p.stream}`}`}
          </Chip>
        ))}
      </ButtonRow>
      <SpaceTime nodes={["client", "server"]} tEnd={tEnd} messages={st.messages} marks={marks} rowHeight={48} />
      <Legend items={[{ label: "request HEADERS", color: "var(--c1)" }, { label: "QPACK encoder stream", color: "var(--c5)" }, { label: "decoded right", color: "var(--c3)" }, { label: "decode failed", color: "var(--c4)" }]} />
      <MiniTable head={["stream", "block", "arrived", "decoded"]} rows={run.outcomes.map((o) => [
        <span style={{ color: o.ok ? "var(--c3)" : "var(--c4)" }}>{`${o.stream} (${RACE_PATHS[o.req]})`}</span>, `${o.blockBytes} B`, `${fixed(o.arrivedAt, 0)} ms`, `${fixed(o.decodedAt, 0)} ms`,
      ])} />
      <ul style={{ fontSize: 12.5, margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
        {run.outcomes.map((o) => <li key={o.stream} style={{ color: o.ok ? "var(--c3)" : "var(--c4)", wordBreak: "break-word" }}>stream {o.stream}: {o.result}</li>)}
      </ul>
      <Stats items={[
        { label: "header bytes, all three requests", value: `${int(run.totalBytes)} B` },
        { label: "streams decoded wrongly", value: bad },
        { label: "last stream decoded at", value: `${fixed(Math.max(...run.outcomes.map((o) => o.decodedAt)), 0)} ms` },
      ]} />
      {scheme === "hpack" && bad > 0 && (
        <Banner tone="bad">HPACK's table changes with each block in order. A block that arrives before an earlier one points at entries the decoder does not have. In HTTP/2 this is a connection error.</Banner>
      )}
    </Demo>
  );
}

// ============================================================================ 3. Discovery and racing

const DI = {
  mode: seg<Discovery>("How the browser learns about HTTP/3", [["alt-svc", "Alt-Svc header"], ["https-rr", "HTTPS DNS record"]], "alt-svc"),
  blocked: toggle({ label: "The network blocks UDP", default: false }),
  race: toggle({ label: "Race QUIC against TCP", default: true }),
  rtt: range({ label: "RTT to the server", min: 10, max: 200, step: 10, default: 50, format: (v) => `${v} ms` }),
};

export function NetAppDiscoveryDemo() {
  const P = useParams("net-app-disc", DI);
  const { mode, blocked, race, rtt } = P.values;
  const visits = useMemo(() => discoveryRun({ mode, udpBlocked: blocked, race, rttMs: rtt, dnsRttMs: 20 }), [mode, blocked, race, rtt]);
  const [k, setK] = useState(0);
  const v = visits[k]!;
  const st = fromPackets(v.net, {
    label: (p) => (p.payload.proto === "dns" ? p.payload.label.split(" ")[0] : undefined),
    color: (p) => ({ dns: "var(--c5)", tcp: "var(--c2)", quic: "var(--c1)" } as Record<DiscoveryMsg["proto"], string>)[p.payload.proto],
  });
  const marks: StMark[] = [...st.marks, { node: 0, t: v.firstByteMs, label: "first byte", color: "var(--c3)" }];
  return (
    <Demo
      title="First visit and second visit: which protocol, and how fast"
      controls={<>
        <Param spec={DI.mode} value={mode} onChange={(x) => P.set("mode", x as Discovery)} />
        <Param spec={DI.blocked} value={blocked} onChange={(x) => P.set("blocked", x as boolean)} />
        <Param spec={DI.race} value={race} onChange={(x) => P.set("race", x as boolean)} />
        <Param spec={DI.rtt} value={rtt} onChange={(x) => P.set("rtt", x as number)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 6 }}>
        {visits.map((x, i) => <Btn key={i} on={i === k} onClick={() => setK(i)}>{`Visit ${x.visit}`}</Btn>)}
      </ButtonRow>
      <SpaceTime nodes={DISCOVERY_NODES} tEnd={Math.min(v.firstByteMs * 1.08, v.firstByteMs + 400)} messages={st.messages} marks={marks} rowHeight={42} />
      <Legend items={[{ label: "DNS", color: "var(--c5)" }, { label: "TCP + TLS", color: "var(--c2)" }, { label: "QUIC", color: "var(--c1)" }]} />
      <Banner tone={v.protocol.includes("3") ? "good" : blocked ? "warn" : "info"} label={`visit ${v.visit}`}>{v.note}</Banner>
      <MiniTable head={["visit", "protocol", "first byte"]} rows={visits.map((x) => [String(x.visit), x.protocol, `${int(x.firstByteMs)} ms`])} highlight={k} />
      <Stats items={[
        { label: "DNS done at", value: `${int(v.dnsMs)} ms` },
        { label: "first byte", value: `${int(v.firstByteMs)} ms` },
      ]} />
    </Demo>
  );
}
