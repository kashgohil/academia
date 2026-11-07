/** Demos for "HTTP/1.1". Page loads run the reference TCP on PacketNet (src/sims/net/apps/pageload.ts); framing and caching use http1.ts. */
import { useMemo } from "react";
import {
  Banner, Demo, Dots, Legend, MiniTable, Param, Plot, RuleX, SmallLabel, Stats, fixed, int, mono, range, seg, sig, tint, toggle, useParams,
} from "../../kit";
import { Waterfall, visible } from "./NetAppUi";
import {
  CACHE_BODY_DEFAULT, CACHE_CHANGES, CACHE_VISITS, DEMO_PAGE, cacheRun, chunked, h1PageLoad, parseStream, request, serialize, type CacheOutcome, type CachePolicy, type Parsed,
} from "../../sims/net/apps";

const CONN_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)", "var(--muted)"];

// ============================================================================ 1. Page load waterfall

type Mode = "close" | "keepalive" | "pipeline";
const WF = {
  mode: seg<Mode>("Connections", [["close", "new one per request"], ["keepalive", "keep-alive"], ["pipeline", "keep-alive + pipelining"]], "keepalive"),
  conns: range({ label: "Connections per host (at most)", min: 1, max: 8, step: 1, default: 1 }),
  rtt: range({ label: "RTT", min: 10, max: 300, step: 10, default: 80, format: (v) => `${v} ms` }),
  mbps: range({ label: "Bandwidth", min: 1, max: 100, step: 1, default: 10, log: true, format: (v) => `${v} Mbit/s` }),
  slow: toggle({ label: "The server needs 300 ms more for style.css", default: false }),
  tls: toggle({ label: "TLS 1.3 on every connection", default: true }),
};

const modeOpts = (m: Mode, conns: number) => ({ conns, persistent: m !== "close", pipelining: m === "pipeline" });

export function NetAppWaterfallDemo() {
  const P = useParams("net-app-wf", WF);
  const { mode, conns, rtt, mbps, slow, tls } = P.values;
  const base = { rttMs: rtt, mbps, loss: 0, tls, slow: slow ? { index: 0, ms: 300 } : undefined, record: false };
  const run = useMemo(() => h1PageLoad({ ...base, ...modeOpts(mode, conns) }), [mode, conns, rtt, mbps, slow, tls]); // eslint-disable-line react-hooks/exhaustive-deps
  const table = useMemo(() => ([
    ["new connection per request, 6 at most", "close", 6],
    ["keep-alive, 1 connection", "keepalive", 1],
    ["keep-alive + pipelining, 1 connection", "pipeline", 1],
    ["keep-alive, 6 connections", "keepalive", 6],
  ] as [string, Mode, number][]).map(([label, m, c]) => ({ label, m, c, plt: h1PageLoad({ ...base, ...modeOpts(m, c) }).plt })), [rtt, mbps, slow, tls]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = run.resources.map((r) => ({
    label: r.name, start: r.requestAt, firstByte: r.firstByteAt, end: r.doneAt, color: CONN_COLORS[r.conn % CONN_COLORS.length]!, tag: `c${r.conn + 1}`,
  }));
  const tEnd = Math.ceil((Math.max(...table.map((t) => t.plt), run.plt) * 1.04) / 50) * 50;
  const linkMs = ((DEMO_PAGE.html.bytes + DEMO_PAGE.resources.reduce((a, r) => a + r.bytes, 0)) * 8) / (mbps * 1000);
  return (
    <Demo
      title="Loading one page over HTTP/1.1"
      controls={<>
        <Param spec={WF.mode} value={mode} onChange={(v) => P.set("mode", v as Mode)} />
        <Param spec={WF.conns} value={conns} onChange={(v) => P.set("conns", v as number)} />
        <Param spec={WF.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={WF.mbps} value={mbps} onChange={(v) => P.set("mbps", v as number)} />
        <Param spec={WF.slow} value={slow} onChange={(v) => P.set("slow", v as boolean)} />
        <Param spec={WF.tls} value={tls} onChange={(v) => P.set("tls", v as boolean)} />
      </>}
    >
      <SmallLabel>One row per request. Light: waiting for the first byte (handshakes, queueing, server time). Solid: bytes arriving. Colour and tag: the connection.</SmallLabel>
      <Waterfall rows={rows} tEnd={tEnd} marks={[{ t: run.plt, label: "loaded", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "page load time", value: `${int(run.plt)} ms` },
        { label: "connections opened", value: run.conns.length },
        { label: "in RTTs", value: fixed(run.plt / rtt, 1) },
        { label: "time the bytes need on the link alone", value: `${int(linkMs)} ms` },
      ]} />
      <MiniTable head={["at this RTT and bandwidth", "load time"]} rows={table.map((t) => [t.label, `${int(t.plt)} ms`])} highlight={(i) => table[i]!.m === mode && table[i]!.c === conns} />
    </Demo>
  );
}

// ============================================================================ 2. Framing and smuggling

type Framing = "length" | "chunked" | "close" | "wrong" | "smuggle";
const FR = {
  kind: seg<Framing>("Framing", [["length", "Content-Length"], ["chunked", "chunked"], ["close", "close"], ["wrong", "wrong length"], ["smuggle", "CL + TE"]], "length"),
  chunk: range({ label: "Chunk size (chunked)", min: 4, max: 40, step: 1, default: 12, format: (v) => `${v} B` }),
  err: range({ label: "Content-Length error (wrong length)", min: -10, max: 10, step: 1, default: -6, format: (v) => `${v > 0 ? "+" : ""}${v} B` }),
};

const BODY = '{"item":42,"qty":1}';
const SMUGGLED = "GET /admin HTTP/1.1\r\nHost: shop.example\r\n\r\n";

function streamFor(kind: Framing, chunk: number, err: number): { text: string; role: "request" | "response"; closed: boolean; note: string } {
  const next = serialize(request("GET", "/cart", "shop.example"));
  switch (kind) {
    case "length":
      return { role: "request", closed: false, text: serialize(request("POST", "/cart", "shop.example", [["Content-Type", "application/json"], ["Content-Length", String(BODY.length)]], BODY)) + next, note: "Two requests on one connection. Content-Length says where the first body ends." };
    case "chunked":
      return { role: "request", closed: false, text: serialize(request("POST", "/cart", "shop.example", [["Transfer-Encoding", "chunked"]], chunked(BODY.repeat(2), chunk))) + next, note: "The sender did not know the length in advance. Each chunk carries its size in hex; a 0-size chunk ends the body." };
    case "close":
      return { role: "response", closed: true, text: `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${BODY}${BODY}`, note: "A response with neither header ends when the server closes the connection. The client cannot tell a complete body from a cut one." };
    case "wrong":
      return { role: "request", closed: false, text: serialize(request("POST", "/cart", "shop.example", [["Content-Type", "application/json"], ["Content-Length", String(BODY.length + err)]], BODY)) + next, note: "The length header is wrong. The parser trusts it, so the boundary lands in the wrong place and the next request is garbage or never complete." };
    case "smuggle": {
      const body = `0\r\n\r\n${SMUGGLED}`;
      return { role: "request", closed: false, text: serialize(request("POST", "/search", "shop.example", [["Content-Length", String(body.length)], ["Transfer-Encoding", "chunked"]], body)), note: "One request with both headers. The front end reads Content-Length; the back end follows RFC 9112: Transfer-Encoding wins." };
    }
  }
}

const MSG_COLORS = ["var(--c1)", "var(--c3)", "var(--c2)", "var(--c5)"];

function ParsedStream({ title, text, msgs, restFrom }: { title: string; text: string; msgs: Parsed[]; restFrom: number }) {
  const pieces: { s: string; color?: string }[] = [];
  msgs.forEach((m, i) => pieces.push({ s: text.slice(m.from, m.to), color: m.error ? "var(--c4)" : MSG_COLORS[i % MSG_COLORS.length] }));
  if (restFrom < text.length) pieces.push({ s: text.slice(restFrom) });
  return (
    <div style={{ minWidth: 0 }}>
      <SmallLabel>{title}</SmallLabel>
      <pre style={{ ...mono, fontSize: 11.5, lineHeight: 1.5, margin: 0, padding: 8, border: "1px solid var(--border)", borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--bg)" }}>
        {pieces.map((p, i) => <span key={i} style={{ background: p.color ? tint(p.color, 22) : undefined, color: p.color ? "var(--fg)" : "var(--faint)" }}>{visible(p.s)}</span>)}
      </pre>
      <ol style={{ fontSize: 12.5, margin: "6px 0 0", paddingLeft: 20 }}>
        {msgs.map((m, i) => (
          <li key={i} style={{ color: m.error ? "var(--c4)" : undefined }}>
            <span style={mono}>{visible(m.start).slice(0, 40)}</span> <span className="muted">({m.framing}{m.body ? `, body ${m.body.length} B` : ""}{m.error ? `; ${m.error}` : ""})</span>
          </li>
        ))}
        {restFrom < text.length && <li className="muted" style={{ listStyle: "none", marginLeft: -20 }}>{text.length - restFrom} bytes wait for more data (grey)</li>}
      </ol>
    </div>
  );
}

export function NetAppFramingDemo() {
  const P = useParams("net-app-frame", FR);
  const { kind, chunk, err } = P.values;
  const s = streamFor(kind, chunk, err);
  const back = parseStream(s.text, s.role, { closed: s.closed });
  const front = kind === "smuggle" ? parseStream(s.text, s.role, { ignoreTE: true }) : undefined;
  return (
    <Demo
      title="Where does a message end?"
      controls={<>
        <Param spec={FR.kind} value={kind} onChange={(v) => P.set("kind", v as Framing)} />
        {kind === "chunked" && <Param spec={FR.chunk} value={chunk} onChange={(v) => P.set("chunk", v as number)} />}
        {kind === "wrong" && <Param spec={FR.err} value={err} onChange={(v) => P.set("err", v as number)} />}
      </>}
    >
      <Banner tone="info">{s.note}</Banner>
      <div style={{ display: "grid", gridTemplateColumns: front ? "repeat(auto-fit, minmax(260px, 1fr))" : "1fr", gap: 12, marginTop: 8 }}>
        {front && <ParsedStream title="Front-end proxy: reads only Content-Length" text={s.text} msgs={front.messages} restFrom={front.restFrom} />}
        <ParsedStream title={front ? "Back-end server: Transfer-Encoding wins" : "Parser (RFC 9112 rules)"} text={s.text} msgs={back.messages} restFrom={back.restFrom} />
      </div>
      {front && (
        <Banner tone="bad" label="result">
          The proxy saw {front.messages.length} request and checked it. The server saw {back.messages.length}: the second, <span style={mono}>GET /admin</span>, never passed the proxy's checks.
        </Banner>
      )}
      <Stats items={[
        { label: "bytes in the stream", value: int(s.text.length) },
        { label: "complete messages", value: back.messages.length },
        { label: "bytes waiting", value: int(s.text.length - back.restFrom) },
      ]} />
    </Demo>
  );
}

// ============================================================================ 3. Caching


const CA = {
  policy: seg<CachePolicy>("Cache-Control", [["max-age", "max-age"], ["no-cache", "no-cache"], ["no-store", "no-store"], ["heuristic", "none"], ["immutable", "versioned URL"]], "max-age"),
  maxAge: range({ label: "max-age", min: 0, max: 3600, step: 60, default: 600, format: (v) => `${v} s` }),
  etag: toggle({ label: "Response has an ETag", default: true }),
};

const OUT_ROW: Record<CacheOutcome, number> = { "hit": 4, "stale hit": 3, "304": 2, "200": 1, "200 new URL": 1 };
const OUT_COLOR: Record<CacheOutcome, string> = { "hit": "var(--c3)", "stale hit": "var(--c4)", "304": "var(--c1)", "200": "var(--c2)", "200 new URL": "var(--c5)" };

export function NetAppCacheDemo() {
  const P = useParams("net-app-cache", CA);
  const { policy, maxAge, etag } = P.values;
  const run = cacheRun({ policy, maxAge, etag, visits: CACHE_VISITS, changes: CACHE_CHANGES, bodyBytes: CACHE_BODY_DEFAULT });
  const rowName = ["", "200", "304", "stale", "fresh"];
  return (
    <Demo
      title="A browser cache over two hours"
      controls={<>
        <Param spec={CA.policy} value={policy} onChange={(v) => P.set("policy", v as CachePolicy)} />
        {policy === "max-age" && <Param spec={CA.maxAge} value={maxAge} onChange={(v) => P.set("maxAge", v as number)} />}
        <Param spec={CA.etag} value={etag} onChange={(v) => P.set("etag", v as boolean)} />
      </>}
    >
      <SmallLabel>Each dot is one visit to the page that loads app.js. Red lines: the site deploys a new app.js.</SmallLabel>
      <Plot x={[-200, 7400]} y={[0.4, 4.6]} height={190} xLabel="time (s)" yTicks={[1, 2, 3, 4]} yFormat={(v) => rowName[v] ?? ""} grid={false}>
        {CACHE_CHANGES.map((c) => <RuleX key={c} at={c} color="var(--c4)" label="deploy" />)}
        {run.events.map((e, i) => <Dots key={i} points={[[e.t, OUT_ROW[e.outcome]]]} color={OUT_COLOR[e.outcome]} r={5} />)}
      </Plot>
      <Legend items={[{ label: "fresh hit: 0 RTT", color: "var(--c3)" }, { label: "stale hit: old code", color: "var(--c4)" }, { label: "304: 1 RTT, headers only", color: "var(--c1)" }, { label: "200: 1 RTT + 50 KB", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "bytes over 11 visits", value: `${sig(run.bytes / 1000, 3)} KB` },
        { label: "round trips to the server", value: run.rtts },
        { label: "visits that ran an old app.js", value: run.staleViews },
      ]} />
      <MiniTable head={["t (s)", "result", "bytes"]} rows={run.events.map((e) => [int(e.t), e.outcome + (e.freshLeft !== undefined && Number.isFinite(e.freshLeft) ? ` (${int(e.freshLeft)} s fresh left)` : ""), int(e.bytes)])} highlight={(i) => run.events[i]!.outcome === "stale hit"} />
    </Demo>
  );
}
