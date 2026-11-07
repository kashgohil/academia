/** Demos for "HTTP/2". HPACK is the real encoder of src/sims/net/apps/hpack.ts; page loads run the reference TCP on PacketNet (pageload.ts). */
import { useMemo, useState } from "react";
import {
  Banner, ButtonRow, Demo, IndexButtons, Legend, Line, MiniTable, Meter, Param, Plot, RuleX, SmallLabel, Stats, fixed, int, mono, pct, range, seg, sig, tint, toggle, useChunked, useParams, useWidth,
} from "../../kit";
import { HeaderDiagram } from "./PacketViews";
import { Waterfall } from "./NetAppUi";
import { hex } from "../../sims/net";
import {
  ERROR_CANCEL, FLAG, HPACK_STATIC, HpackEncoder, PRIO_PAGE, browserRequest, byteLength, entrySize, frameBytes, frameHeaderFields, h1PageLoad, h2PageLoad, h2RequestHeaders,
  rapidReset, schedule, serialize, type Mitigation, type PageRun, type Rep, type Scheme,
} from "../../sims/net/apps";

// ============================================================================ 1. Frames and HPACK

export const HPACK_PATHS = ["/", "/style.css", "/app.js"];
const HP = {
  huffman: toggle({ label: "Huffman-code the string literals", default: true }),
  dynamic: toggle({ label: "Dynamic table (off: every literal is sent again)", default: true }),
};

const REP_TEXT = (r: Rep) => {
  if (r.kind === "indexed") return r.index <= HPACK_STATIC.length ? `indexed, static ${r.index}` : `indexed, dynamic ${r.index}`;
  const name = r.index ? `name ${r.index <= HPACK_STATIC.length ? "static" : "dynamic"} ${r.index}` : "new name";
  return `${r.kind === "incremental" ? "literal + add to table" : "literal, not added"} (${name})`;
};
const REP_COLOR = (r: Rep) => (r.kind === "indexed" ? "var(--c3)" : r.index ? "var(--c1)" : "var(--c2)");

export function hpackRuns(huffman: boolean, dynamic: boolean) {
  const e = new HpackEncoder(4096, { huffman: huffman ? "auto" : false, noIndexing: !dynamic });
  return HPACK_PATHS.map((p) => {
    const out = e.encode(h2RequestHeaders(p));
    return { path: p, out, table: [...e.table.entries], size: e.table.size, h1: byteLength(serialize(browserRequest(p))) };
  });
}

export function NetAppHpackDemo() {
  const P = useParams("net-app-hpack", HP);
  const { huffman, dynamic } = P.values;
  const [k, setK] = useState(1);
  const runs = useMemo(() => hpackRuns(huffman, dynamic), [huffman, dynamic]);
  const run = runs[k]!;
  const block = run.out.bytes.length;
  const frame = { length: block, type: "HEADERS" as const, flags: FLAG.END_STREAM | FLAG.END_HEADERS, stream: 1 + 2 * k };
  return (
    <Demo
      title="One request as an HTTP/2 HEADERS frame"
      controls={<>
        <Param spec={HP.huffman} value={huffman} onChange={(v) => P.set("huffman", v as boolean)} />
        <Param spec={HP.dynamic} value={dynamic} onChange={(v) => P.set("dynamic", v as boolean)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 6 }}>
        <IndexButtons k={k} n={HPACK_PATHS.length} set={setK} />
        <span style={{ fontSize: 13 }}>Request {k + 1} of 3 on one connection: <b style={mono}>GET {run.path}</b>, stream {1 + 2 * k}</span>
      </ButtonRow>
      <SmallLabel>The 9-byte frame header</SmallLabel>
      <HeaderDiagram fields={frameHeaderFields(frame)} values={[String(block), "1 (HEADERS)", "0x05", "0", String(1 + 2 * k)]} />
      <SmallLabel style={{ marginTop: 8 }}>The HPACK block: one representation per header field</SmallLabel>
      <MiniTable head={["field", "how", "bytes"]} rows={run.out.reps.map((r) => [
        <span style={{ ...mono, wordBreak: "break-all" }}>{`${r.header[0]}: ${r.header[1].length > 28 ? `${r.header[1].slice(0, 27)}…` : r.header[1]}`}</span>,
        <span style={{ color: REP_COLOR(r) }}>{REP_TEXT(r)}</span>,
        <span style={mono} title={hex(r.bytes)}>{r.bytes.length}</span>,
      ])} />
      <Legend items={[{ label: "indexed: the whole field is a number", color: "var(--c3)" }, { label: "literal value, indexed name", color: "var(--c1)" }, { label: "literal name and value", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "HPACK block", value: `${block} B` },
        { label: "the same request as HTTP/1.1 text", value: `${run.h1} B` },
        { label: "frame on the wire (9 + block)", value: `${9 + block} B` },
        { label: "all 3 requests, HTTP/2 vs HTTP/1.1", value: `${runs.reduce((a, r) => a + 9 + r.out.bytes.length, 0)} vs ${runs.reduce((a, r) => a + r.h1, 0)} B` },
      ]} />
      <SmallLabel>Dynamic table after this request: {int(run.size)} of 4,096 bytes (each entry costs name + value + 32)</SmallLabel>
      <div style={{ maxHeight: 160, overflowY: "auto" }}>
        <MiniTable head={["index", "entry", "size"]} rows={run.table.map((e, i) => [String(62 + i), <span style={{ ...mono, wordBreak: "break-all" }}>{`${e[0]}: ${e[1].length > 34 ? `${e[1].slice(0, 33)}…` : e[1]}`}</span>, String(entrySize(e))])} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. One connection or six, under loss

const LS = {
  loss: range({ label: "Packet loss", min: 0, max: 4, step: 0.25, default: 0, format: (v) => `${v}%` }),
  rtt: range({ label: "RTT", min: 20, max: 200, step: 10, default: 80, format: (v) => `${v} ms` }),
  seed: range({ label: "Run (random seed)", min: 1, max: 10, step: 1, default: 1 }),
};
export const LOSS_SWEEP = [0, 0.5, 1, 2, 3, 4];
export const SWEEP_SEEDS = 10;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
export function lossPair(loss: number, rtt: number, seed: number, record = false): [PageRun, PageRun] {
  const base = { rttMs: rtt, mbps: 10, loss: loss / 100, seed, record };
  return [h1PageLoad({ ...base, conns: 6, persistent: true, pipelining: false }), h2PageLoad(base)];
}

const toRows = (r: PageRun, h2: boolean) => r.resources.map((x) => ({
  label: x.name, start: x.requestAt, firstByte: x.firstByteAt, end: x.doneAt, color: h2 ? "var(--c1)" : ["var(--c2)", "var(--c3)", "var(--c5)", "var(--c1)", "var(--c4)", "var(--muted)"][x.conn % 6]!,
}));

export function NetAppH2LossDemo() {
  const P = useParams("net-app-h2loss", LS);
  const { loss, rtt, seed } = P.values;
  const [h1, h2] = useMemo(() => lossPair(loss, rtt, seed), [loss, rtt, seed]);
  const jobs = useMemo(() => LOSS_SWEEP.flatMap((l) => Array.from({ length: SWEEP_SEEDS }, (_, s) => () => lossPair(l, rtt, s + 1).map((r) => r.plt))), [rtt]);
  const res = useChunked(`sweep-${rtt}`, jobs, { keep: true });
  const done = res.every((r) => r);
  const med = (which: 0 | 1) => LOSS_SWEEP.map((l, i) => [l, median(res.slice(i * SWEEP_SEEDS, (i + 1) * SWEEP_SEEDS).filter((r): r is number[] => !!r).map((r) => r[which]!))] as [number, number]);
  const tEnd = Math.ceil(Math.max(h1.plt, h2.plt) / 100) * 100 + 100;
  const yMax = done ? Math.max(...med(0).map((p) => p[1]), ...med(1).map((p) => p[1])) * 1.1 : 1000;
  return (
    <Demo
      title="Six HTTP/1.1 connections against one HTTP/2 connection"
      controls={<>
        <Param spec={LS.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
        <Param spec={LS.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={LS.seed} value={seed} onChange={(v) => P.set("seed", v as number)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>HTTP/1.1, 6 connections: {int(h1.plt)} ms, {h1.retx} retransmissions</SmallLabel>
          <Waterfall rows={toRows(h1, false)} tEnd={tEnd} marks={[{ t: h1.plt, label: "loaded" }]} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>HTTP/2, 1 connection: {int(h2.plt)} ms, {h2.retx} retransmissions</SmallLabel>
          <Waterfall rows={toRows(h2, true)} tEnd={tEnd} marks={[{ t: h2.plt, label: "loaded" }]} />
        </div>
      </div>
      <SmallLabel style={{ marginTop: 8 }}>Median load time over {SWEEP_SEEDS} runs per loss rate{done ? "" : " (computing…)"}</SmallLabel>
      <Plot x={[0, 4]} y={[0, yMax]} height={200} xLabel="packet loss (%)" yLabel="load time (ms)">
        <Line points={med(0)} color="var(--c2)" />
        <Line points={med(1)} color="var(--c1)" />
        <RuleX at={loss} color="var(--faint)" />
      </Plot>
      <Legend items={[{ label: "HTTP/1.1, 6 connections", color: "var(--c2)" }, { label: "HTTP/2, 1 connection", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "this run, HTTP/1.1 × 6", value: `${int(h1.plt)} ms` },
        { label: "this run, HTTP/2", value: `${int(h2.plt)} ms` },
        { label: "timeouts (RTO), HTTP/1.1 / HTTP/2", value: `${h1.timeouts} / ${h2.timeouts}` },
      ]} />
    </Demo>
  );
}

// ============================================================================ 3. Priorities

const PR = {
  scheme: seg<Scheme>("Scheduler", [["none", "round-robin"], ["rfc7540", "RFC 7540 weights"], ["rfc9218", "RFC 9218 urgency"]], "none"),
  mbps: range({ label: "Bandwidth", min: 2, max: 50, step: 1, default: 10, format: (v) => `${v} Mbit/s` }),
};
const PRIO_COLORS = ["var(--c4)", "var(--c2)", "var(--c5)", "var(--c1)", "var(--c3)", "var(--c3)", "var(--muted)"];

function FrameLanes({ frames, total, render }: { frames: [number, number, number][]; total: number; render: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(280, width), left = w < 480 ? 84 : 104, rowH = 18, top = 14, h = top + PRIO_PAGE.length * rowH + 18;
  const x = (t: number) => left + (t / total) * (w - left - 6);
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="frames per stream" style={{ display: "block" }}>
        {PRIO_PAGE.map((r, i) => (
          <g key={i}>
            <text x={left - 6} y={top + i * rowH + 12} fontSize="10.5" textAnchor="end" fill={r.blocking ? "var(--fg)" : "var(--muted)"}>{r.name}</text>
            <line x1={left} x2={w - 6} y1={top + i * rowH + 9} y2={top + i * rowH + 9} stroke="var(--border)" />
          </g>
        ))}
        {frames.map(([a, b, i], k) => <rect key={k} x={x(a)} y={top + i * rowH + 3} width={Math.max(1, x(b) - x(a) - 0.6)} height={12} fill={PRIO_COLORS[i]} />)}
        <line x1={x(render)} x2={x(render)} y1={top - 6} y2={h - 16} stroke="var(--c4)" strokeWidth={1.5} />
        <text x={Math.min(x(render) + 4, w - 70)} y={top - 4} fontSize="10" fill="var(--c4)">first paint</text>
        <text x={left} y={h - 3} fontSize="10" fill="var(--faint)">0 ms</text>
        <text x={w - 6} y={h - 3} fontSize="10" fill="var(--faint)" textAnchor="end">{int(total)} ms</text>
      </svg>
    </div>
  );
}

export function NetAppPriorityDemo() {
  const P = useParams("net-app-prio", PR);
  const { scheme, mbps } = P.values;
  const run = schedule(PRIO_PAGE, scheme, mbps);
  const all = (["none", "rfc7540", "rfc9218"] as Scheme[]).map((s) => schedule(PRIO_PAGE, s, mbps));
  return (
    <Demo
      title="Which stream gets the next frame?"
      controls={<>
        <Param spec={PR.scheme} value={scheme} onChange={(v) => P.set("scheme", v as Scheme)} />
        <Param spec={PR.mbps} value={mbps} onChange={(v) => P.set("mbps", v as number)} />
      </>}
    >
      <SmallLabel>Each block is one 16 KB DATA frame. Names in black block the first paint.</SmallLabel>
      <FrameLanes frames={run.frames} total={run.total} render={run.renderAt} />
      <MiniTable head={["resource", "urgency, incremental", "7540 weight", "done (ms)"]} rows={PRIO_PAGE.map((r, i) => [r.name, `u=${r.urgency}${r.incremental ? ", i" : ""}`, String(r.weight), int(run.done[i]!)])} />
      <Stats items={[
        { label: "first paint (CSS and app.js complete)", value: `${int(run.renderAt)} ms` },
        { label: "round-robin / 7540 / 9218", value: all.map((r) => int(r.renderAt)).join(" / ") + " ms" },
        { label: "all bytes sent", value: `${int(run.total)} ms` },
      ]} />
    </Demo>
  );
}

// ============================================================================ 4. Rapid Reset

const RR = {
  uplink: range({ label: "Attacker uplink", min: 1, max: 1000, step: 1, default: 100, log: true, format: (v) => `${v} Mbit/s` }),
  rtt: range({ label: "RTT", min: 5, max: 200, step: 5, default: 50, format: (v) => `${v} ms` }),
  work: range({ label: "Server work per request", min: 1, max: 200, step: 1, default: 20, log: true, format: (v) => `${v} ms` }),
  mit: seg<Mitigation>("Server", [["none", "unpatched"], ["count-until-done", "counts streams until work ends"], ["goaway", "GOAWAY after 1,000 resets"]], "none"),
};

export function NetAppRapidResetDemo() {
  const P = useParams("net-app-rapid", RR);
  const { uplink, rtt, work, mit } = P.values;
  const r = rapidReset({ rttMs: rtt, uplinkMbps: uplink, workMs: work, mitigation: mit });
  const rst = frameBytes("RST_STREAM", 0, 1, new Uint8Array([0, 0, 0, ERROR_CANCEL]));
  const max = Math.max(r.attackRps, r.normalRps) * 1.05;
  return (
    <Demo
      title="Rapid Reset: requests a server starts per second, from one connection"
      controls={<>
        <Param spec={RR.uplink} value={uplink} onChange={(v) => P.set("uplink", v as number)} />
        <Param spec={RR.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={RR.work} value={work} onChange={(v) => P.set("work", v as number)} />
        <Param spec={RR.mit} value={mit} onChange={(v) => P.set("mit", v as Mitigation)} />
      </>}
    >
      <SmallLabel>The attacker sends HEADERS and then RST_STREAM (CANCEL) at once, over and over. The RST_STREAM frame on the wire:</SmallLabel>
      <div style={{ ...mono, fontSize: 12.5, marginBottom: 8, padding: "4px 8px", background: tint("var(--c4)", 10), borderRadius: 6, overflowX: "auto" }}>{hex(rst)}</div>
      <Meter label="well-behaved client (100 streams, each open RTT + work)" value={r.normalRps} max={max} color="var(--c3)" text={`${sig(r.normalRps, 3)} req/s`} log />
      <Meter label={`attacker, ${r.bytesPerRequest} bytes per request (HEADERS ${r.bytesPerRequest - 13} + RST_STREAM 13)`} value={r.attackRps} max={max} color="var(--c4)" text={`${sig(r.attackRps, 3)} req/s`} log />
      <Stats items={[
        { label: "attack / normal", value: `${sig(r.attackRps / r.normalRps, 3)} ×` },
        { label: "requests in progress at the server", value: sig(r.attackBusy, 3) },
        { label: "what limits the attacker", value: r.limit === "uplink" ? "its uplink" : r.limit === "streams" ? "the stream limit" : "reconnecting" },
      ]} />
      <Banner tone={mit === "none" ? "bad" : "warn"}>
        {mit === "none"
          ? "Cancelled streams stop counting against SETTINGS_MAX_CONCURRENT_STREAMS at once, so the limit of 100 never binds. Only the attacker's uplink does."
          : mit === "count-until-done"
            ? "The server counts a cancelled stream until its work stops. At most 100 requests are in progress, as with a normal client."
            : "Each 1,000 resets cost the attacker a new connection: a TCP and a TLS handshake. That bounds the rate, but the rate is still high."}
      </Banner>
      <SmallLabel>Request rate share of the uplink: {pct(Math.min(1, (r.attackRps * r.bytesPerRequest * 8) / (uplink * 1e6)), 0)}. Model: {fixed(work, 0)} ms of work per request starts when HEADERS arrives.</SmallLabel>
    </Demo>
  );
}
