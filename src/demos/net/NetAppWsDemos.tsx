/** Demos for "WebSockets". SHA-1, frames and masking from src/sims/net/apps/ws.ts; backpressure on the reference TCP; push methods on PacketNet. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Demo, Legend, Line, Meter, MiniTable, Param, Plot, SmallLabel, Stats, fixed, int, mono, range, seg, sig, tint, toggle, useParams,
} from "../../kit";
import { HeaderDiagram } from "./PacketViews";
import { HexSpans, inputStyle, visible, type ByteSpan } from "./NetAppUi";
import { hex, utf8 } from "../../sims/net";
import {
  POISON_PAYLOAD, SETTINGS_ENABLE_CONNECT_PROTOCOL, WS_GUID, backpressureRun, base64, encodeFrame, frameFields, fromBase64, h2ConnectHeaders, proxyView, pushCompare, serialize, sha1,
  upgradeRequest, upgradeResponse, wsHeaderBytes, type PushMethod,
} from "../../sims/net/apps";

const preStyle = { ...mono, fontSize: 12, lineHeight: 1.5, margin: 0, padding: 8, border: "1px solid var(--border)", borderRadius: 6, whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const, background: "var(--bg)" };

const randomBytes = (n: number) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};

// ============================================================================ 1. The opening handshake

export const RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const HS = { h2: toggle({ label: "Over HTTP/2 (RFC 8441 extended CONNECT)", default: false }) };

export function NetAppWsHandshakeDemo() {
  const P = useParams("net-app-wshs", HS);
  const [key, setKey] = useState(RFC_KEY);
  let keyOk = true;
  try {
    keyOk = fromBase64(key).length === 16 && /^[A-Za-z0-9+/]{22}==$/.test(key);
  } catch {
    keyOk = false;
  }
  const digest = sha1(utf8(key + WS_GUID));
  const accept = base64(digest);
  return (
    <Demo
      title="Upgrade: from an HTTP request to a WebSocket"
      actions={<ButtonRow><Btn onClick={() => setKey(base64(randomBytes(16)))}>New random key</Btn><Btn ghost onClick={() => setKey(RFC_KEY)}>RFC 6455 example</Btn></ButtonRow>}
      controls={<Param spec={HS.h2} value={P.values.h2} onChange={(v) => P.set("h2", v as boolean)} />}
    >
      {!P.values.h2 ? (
        <>
          <label style={{ display: "block", fontSize: 12.5, marginBottom: 8 }}>
            <span className="muted">Sec-WebSocket-Key (16 random bytes, base64): </span>
            <input value={key} onChange={(e) => setKey(e.target.value.trim())} spellCheck={false} aria-label="Sec-WebSocket-Key" style={{ ...inputStyle, width: 260 }} />
            {!keyOk && <span style={{ color: "var(--c4)", marginLeft: 6 }}>not 16 bytes of base64: a server rejects it</span>}
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            <div style={{ minWidth: 0 }}><SmallLabel>client → server</SmallLabel><pre style={preStyle}>{visible(serialize(upgradeRequest(key)))}</pre></div>
            <div style={{ minWidth: 0 }}><SmallLabel>server → client</SmallLabel><pre style={preStyle}>{visible(serialize(upgradeResponse(key)))}</pre></div>
          </div>
          <SmallLabel style={{ marginTop: 10 }}>How the server computes Sec-WebSocket-Accept</SmallLabel>
          <ol style={{ fontSize: 12.5, margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
            <li>Append the fixed GUID: <span style={{ ...mono, wordBreak: "break-all" }}>{key}<b style={{ color: "var(--c2)" }}>{WS_GUID}</b></span></li>
            <li>SHA-1 of those {key.length + WS_GUID.length} bytes: <span style={{ ...mono, wordBreak: "break-all" }}>{hex(digest)}</span></li>
            <li>Base64 of the 20-byte digest: <b style={{ ...mono, color: "var(--c3)" }}>{accept}</b></li>
          </ol>
          <Banner tone={key === RFC_KEY ? "good" : "info"}>
            {key === RFC_KEY ? "This is the example of RFC 6455 section 1.3, and the result matches it: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=." : "The client checks that the value matches its own computation. A server that does not speak WebSocket cannot produce it by accident."}
          </Banner>
        </>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <SmallLabel>server → client, first: SETTINGS frame</SmallLabel>
              <pre style={preStyle}>{`SETTINGS_ENABLE_CONNECT_PROTOCOL (0x${SETTINGS_ENABLE_CONNECT_PROTOCOL.toString(16)}) = 1`}</pre>
              <SmallLabel style={{ marginTop: 8 }}>client → server: HEADERS on a new stream</SmallLabel>
              <pre style={preStyle}>{h2ConnectHeaders().map(([n, v]) => `${n} = ${v}`).join("\n")}</pre>
            </div>
            <div style={{ minWidth: 0 }}>
              <SmallLabel>server → client: HEADERS</SmallLabel>
              <pre style={preStyle}>{":status = 200"}</pre>
              <SmallLabel style={{ marginTop: 8 }}>then, both ways</SmallLabel>
              <pre style={preStyle}>{"DATA frames that carry WebSocket frames,\non this one stream"}</pre>
            </div>
          </div>
          <Banner tone="info">No key and no accept value: the :protocol pseudo-header replaces them. The WebSocket shares the HTTP/2 connection with other requests.</Banner>
        </>
      )}
    </Demo>
  );
}

// ============================================================================ 2. Frames and masking

type Dir = "client" | "server";
type Size = "text" | "300" | "70000";
const FR = {
  dir: seg<Dir>("Sender", [["client", "client (masked)"], ["server", "server (not masked)"]], "client"),
  size: seg<Size>("Payload", [["text", "the text below"], ["300", "300 bytes"], ["70000", "70,000 bytes"]], "text"),
};

export function NetAppWsFrameDemo() {
  const P = useParams("net-app-wsframe", FR);
  const { dir, size } = P.values;
  const [text, setText] = useState("Hello");
  const [key, setKey] = useState(() => new Uint8Array([0x37, 0xfa, 0x21, 0x3d]));
  const payload = size === "text" ? utf8(text) : new Uint8Array(Number(size)).fill(0x61);
  const mask = dir === "client" ? key : undefined;
  const frame = encodeFrame({ fin: true, opcode: "text", mask, payload });
  const hb = wsHeaderBytes(payload.length, !!mask);
  const spans: ByteSpan[] = [
    { start: 0, end: 2, color: "var(--c5)", label: "FIN, RSV, opcode, MASK, 7-bit length" },
    ...(hb - (mask ? 4 : 0) > 2 ? [{ start: 2, end: hb - (mask ? 4 : 0), color: "var(--c2)", label: "extended length" }] : []),
    ...(mask ? [{ start: hb - 4, end: hb, color: "var(--c4)", label: "masking key" }] : []),
    { start: hb, end: frame.length, color: "var(--c1)", label: mask ? "payload, masked" : "payload" },
  ];
  const attack = text === POISON_PAYLOAD;
  const proxy = proxyView(text, mask);
  const req = proxy.parsed.messages.find((m) => !m.error);
  return (
    <Demo
      title="A WebSocket frame on the wire"
      actions={<ButtonRow><Btn onClick={() => setKey(randomBytes(4))}>New masking key</Btn></ButtonRow>}
      controls={<>
        <Param spec={FR.dir} value={dir} onChange={(v) => P.set("dir", v as Dir)} />
        <Param spec={FR.size} value={size} onChange={(v) => P.set("size", v as Size)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <input value={attack ? visible(text).replace(/\n/g, "") : text} readOnly={attack} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="message text" style={{ ...inputStyle, flex: "1 1 200px" }} />
        <Btn on={attack} onClick={() => setText(attack ? "Hello" : POISON_PAYLOAD)}>{attack ? "Plain text" : "Attacker's payload"}</Btn>
      </ButtonRow>
      <HeaderDiagram fields={frameFields({ fin: true, opcode: "text", mask, payload })} rowBits={32} />
      <SmallLabel style={{ marginTop: 6 }}>{int(frame.length)} bytes: {hb} of header, {int(payload.length)} of payload</SmallLabel>
      <HexSpans bytes={frame} spans={spans} maxRows={5} />
      <Legend items={[{ label: "header", color: "var(--c5)" }, { label: "extended length", color: "var(--c2)" }, { label: "masking key", color: "var(--c4)" }, { label: "payload", color: "var(--c1)" }]} />
      {size === "text" && (
        <>
          <SmallLabel style={{ marginTop: 10 }}>A transparent proxy that ignored the Upgrade reads these bytes as HTTP:</SmallLabel>
          <pre style={{ ...preStyle, background: tint(req ? "var(--c4)" : "var(--c3)", 8) }}>{visible(proxy.asText).slice(0, 220)}</pre>
          <Banner tone={req ? "bad" : "good"} label="proxy">
            {req
              ? `It parses a request: ${req.start}, Host: ${req.headers.find((h) => h[0] === "Host")?.[1]}. If the attacker's server answers it, the proxy may cache that answer for every user of cdn.example.net.`
              : mask
                ? "Masked bytes are noise to the proxy: the script that chose the text cannot choose the bytes on the wire."
                : "No complete HTTP request here. Try the attacker's payload."}
          </Banner>
        </>
      )}
    </Demo>
  );
}

// ============================================================================ 3. Backpressure

const BP = {
  rate: range({ label: "Server sends", min: 50, max: 2000, step: 10, default: 500, log: true, format: (v) => `${int(v)} msg/s` }),
  read: range({ label: "Client reads", min: 10, max: 500, step: 5, default: 50, log: true, format: (v) => `${v} KB/s` }),
  bp: toggle({ label: "Backpressure: pause above the high-water mark, keep only the newest message", default: false }),
  hw: range({ label: "High-water mark", min: 4, max: 256, step: 4, default: 16, log: true, format: (v) => `${v} KB` }),
  rcv: range({ label: "Client receive buffer", min: 16, max: 1024, step: 16, default: 64, log: true, format: (v) => `${v} KB` }),
};
export const BP_MSG = 200;
export const BP_SECONDS = 5;

export function NetAppBackpressureDemo() {
  const P = useParams("net-app-bp", BP);
  const { rate, read, bp, hw, rcv } = P.values;
  const run = useMemo(() => backpressureRun({ rate, msgBytes: BP_MSG, readBps: read * 1000, rttMs: 40, mbps: 10, rcvBuf: rcv * 1024, backpressure: bp, highWater: hw * 1024, durationMs: BP_SECONDS * 1000 }), [rate, read, bp, hw, rcv]);
  const s = run.samples.filter((_, i) => i % 2 === 0);
  const last = run.samples[run.samples.length - 1] ?? [0, 0, 0, 0];
  const yMax = Math.max(16, ...run.samples.map((x) => Math.max(x[1], x[2]) / 1024)) * 1.08;
  const produceBps = (rate * (BP_MSG + wsHeaderBytes(BP_MSG, false))) / 1000;
  return (
    <Demo
      title="A fast sender, a slow reader"
      controls={<>
        <Param spec={BP.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={BP.read} value={read} onChange={(v) => P.set("read", v as number)} />
        <Param spec={BP.bp} value={bp} onChange={(v) => P.set("bp", v as boolean)} />
        {bp && <Param spec={BP.hw} value={hw} onChange={(v) => P.set("hw", v as number)} />}
        <Param spec={BP.rcv} value={rcv} onChange={(v) => P.set("rcv", v as number)} />
      </>}
    >
      <SmallLabel>{BP_MSG}-byte messages for {BP_SECONDS} s on the reference TCP (RTT 40 ms, 10 Mbit/s). The server produces {fixed(produceBps, 0)} KB/s; the client reads {read} KB/s.</SmallLabel>
      <Plot x={[0, BP_SECONDS * 1000]} y={[0, yMax]} height={200} xLabel="time (ms)" yLabel="KB">
        <Line points={s.map((x) => [x[0], x[1] / 1024] as [number, number])} color="var(--c4)" />
        <Line points={s.map((x) => [x[0], x[2] / 1024] as [number, number])} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "server send buffer (bufferedAmount)", color: "var(--c4)" }, { label: "client receive buffer, unread", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "send buffer at the end", value: `${sig(last[1] / 1024, 3)} KB` },
        { label: "age of the message the client reads", value: `${int(last[3])} ms` },
        { label: "messages produced / sent", value: `${int(run.produced)} / ${int(run.sent)}` },
        { label: "replaced by a newer one", value: int(run.coalesced) },
      ]} />
      <Banner tone={bp ? "good" : produceBps > read ? "bad" : "good"}>
        {bp
          ? "The sender checks its buffer before it writes. Memory stays bounded and old messages are dropped, but the receive buffer still holds stale data."
          : produceBps > read
            ? "TCP's window closes when the client's buffer is full, so the server's buffer absorbs the difference. It grows without limit, and every message is older than the last."
            : "The client keeps up: nothing builds up."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 4. Long polling, SSE, WebSockets

const PU = {
  rate: range({ label: "Events per second", min: 0.2, max: 200, step: 0.1, default: 20, log: true, format: (v) => sig(v, 2) }),
  rtt: range({ label: "RTT", min: 10, max: 300, step: 10, default: 80, format: (v) => `${v} ms` }),
};
export const PUSH_SECONDS = 30;
const METHODS: [PushMethod, string, string][] = [["long-polling", "Long polling", "var(--c2)"], ["sse", "Server-Sent Events", "var(--c1)"], ["websocket", "WebSocket", "var(--c3)"]];

export function NetAppPushDemo() {
  const P = useParams("net-app-push", PU);
  const { rate, rtt } = P.values;
  const res = useMemo(() => METHODS.map(([m]) => pushCompare(m, { rate, seconds: PUSH_SECONDS, rttMs: rtt })), [rate, rtt]);
  const maxDelay = Math.max(...res.map((r) => r.p99Ms)) * 1.05;
  const maxBytes = Math.max(...res.map((r) => r.bytesPerEvent)) * 1.05;
  return (
    <Demo
      title="The same events, three ways to push them"
      controls={<>
        <Param spec={PU.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={PU.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
      </>}
    >
      <SmallLabel>Random events for {PUSH_SECONDS} s. Delay: from the event at the server to its arrival at the browser. One-way delay is {rtt / 2} ms.</SmallLabel>
      {res.map((r, i) => (
        <div key={r.method} style={{ marginBottom: 6 }}>
          <Meter label={`${METHODS[i]![1]}: 99th percentile delay`} value={r.p99Ms} max={maxDelay} color={METHODS[i]![2]} text={`${int(r.p99Ms)} ms`} />
          <Meter label="bytes on the wire per event" value={r.bytesPerEvent} max={maxBytes} color={METHODS[i]![2]} text={`${int(r.bytesPerEvent)} B`} />
        </div>
      ))}
      <MiniTable head={["method", "mean", "p99", "B/event", "sends"]} rows={res.map((r, i) => [METHODS[i]![1], `${fixed(r.meanMs, 0)} ms`, `${fixed(r.p99Ms, 0)} ms`, int(r.bytesPerEvent), int(r.deliveries)])} />
    </Demo>
  );
}
