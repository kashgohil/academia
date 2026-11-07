/** Demos for "Sockets": the API on a timeline, the accept queue under a burst, and bytes that ignore message boundaries. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleY, SmallLabel, Stats, int, mono, range, seg, toggle, useParams } from "../../kit";
import { SpaceTime, type StMark } from "../dist/SpaceTime";
import { StateStrip, tcpSpaceTime } from "./NetTcpUi";
import { ByteStrip, CallLog, Timeline, type Chunk, type TimelineRow } from "./NetProgUi";
import { acceptQueueRun, lifecycleRun, streamRun, type LifeScenario } from "../../sims/net/programming";

// ============================================================================ 1. The API on a timeline

const LC = {
  scenario: seg<LifeScenario>("Scenario", [["normal", "Request and reply"], ["lateAccept", "accept() is late"], ["peerClosed", "Write after the peer closed"], ["unreadClose", "close() with unread data"]], "normal"),
  delay: range({ label: "One-way delay", min: 2, max: 60, step: 1, default: 20, format: (v) => `${v} ms` }),
  acceptAt: range({ label: "The server calls accept() at", min: 0, max: 400, step: 10, default: 150, format: (v) => `${v} ms` }),
  linger: toggle({ label: "Lingering close: shutdown, read to EOF, then close", default: false }),
};

const LC_TEXT: Record<LifeScenario, string> = {
  normal: "connect() returns after one round trip. The server reads the request, writes the answer and closes. The client reads until read() returns 0 (EOF), then closes. The server closed first, so the server ends in TIME_WAIT, not the client.",
  lateAccept: "The handshake ends in the kernel. accept() only takes a finished connection from the accept queue. So connect() returns and the client's write succeeds while the server program has not run yet. The request waits in the server's receive buffer.",
  peerClosed: "The server closed. The client reads EOF, ignores it and writes again. The write succeeds: it only copies bytes into the send buffer. The server's stack answers with RST. The next write fails with EPIPE, and SIGPIPE ends the process.",
  unreadClose: "The server reads only the headers (1000 of 3000 bytes), writes a 20,000-byte answer and calls close(). Unread data makes Linux send RST instead of FIN (RFC 1122 says it SHOULD). The answer still in the send buffer is thrown away.",
};

export function NetProgLifecycleDemo() {
  const P = useParams("net-prog-life", LC);
  const { scenario, delay, acceptAt, linger } = P.values;
  const sc = scenario as LifeScenario;
  const r = useMemo(() => lifecycleRun({ scenario: sc, delay, acceptAt, linger }), [sc, delay, acceptAt, linger]);
  const st = tcpSpaceTime(r.world.net, { labels: "control" });
  const last = Math.max(...r.world.net.hops.map((h) => h.arriveAt ?? h.txEnd), ...r.calls.map((c) => c.t));
  const tEnd = last * 1.06 + 2;
  const marks: StMark[] = [...st.marks, ...r.calls.filter((c) => c.tone).map((c) => ({ node: c.node, t: c.t, color: c.tone === "good" ? "var(--c3)" : c.tone === "bad" ? "var(--c4)" : "var(--c5)" }))];
  const rows = [{ name: "client", states: r.client.states }, ...(r.server ? [{ name: "server", states: r.server.states }] : [])];
  return (
    <Demo
      title="Socket calls and the segments they cause"
      controls={<>
        <Param spec={LC.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={LC.scenario} value={scenario} onChange={(v) => P.set("scenario", v as LifeScenario)} />
        {sc === "lateAccept" && <Param spec={LC.acceptAt} value={acceptAt} onChange={(v) => P.set("acceptAt", v as number)} />}
        {sc === "unreadClose" && <Param spec={LC.linger} value={linger} onChange={(v) => P.set("linger", v as boolean)} />}
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={marks} rowHeight={54} />
      <StateStrip tEnd={tEnd} rows={rows} />
      <Legend items={[{ label: "SYN", color: "var(--c2)" }, { label: "data", color: "var(--c1)" }, { label: "ACK", color: "var(--muted)" }, { label: "FIN", color: "var(--c5)" }, { label: "RST", color: "var(--c4)" }]} />
      <Banner tone={r.clientEnd === "EPIPE" || r.clientEnd === "ECONNRESET" ? "bad" : "plain"}>
        {sc === "unreadClose" && linger
          ? `With a lingering close, the server sends FIN, reads and discards the rest of the request, and closes only at EOF. The client gets all ${int(r.respBytes)} bytes.`
          : LC_TEXT[sc]}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <CallLog rows={r.calls.map((c) => ({ t: c.t, who: c.node === 0 ? "client" : "server", call: c.call, result: c.result, tone: c.tone }))} />
      </div>
      <Note>Dots on the diagram mark calls that return a result worth noticing. Both initial sequence numbers are 0 so that the numbers stay short.</Note>
    </Demo>
  );
}

// ============================================================================ 2. The accept queue under a burst

const AQ = {
  backlog: range({ label: "listen() backlog", min: 1, max: 32, step: 1, default: 8 }),
  service: range({ label: "Server work per connection (model input)", min: 2, max: 50, step: 1, default: 20, format: (v) => `${v} ms` }),
  clients: range({ label: "Clients in the burst", min: 4, max: 40, step: 1, default: 24 }),
  workers: range({ label: "Threads that call accept()", min: 1, max: 4, step: 1, default: 1 }),
};

const PH = { hs: "var(--c2)", ignored: "var(--c4)", queue: "var(--c5)", served: "var(--c3)" };

export function NetProgAcceptQueueDemo() {
  const P = useParams("net-prog-aq", AQ);
  const { backlog, service, clients, workers } = P.values;
  const r = useMemo(() => acceptQueueRun({ backlog, serviceMs: service, clients, workers }), [backlog, service, clients, workers]);
  const done = r.clients.map((c) => c.done ?? r.opts.until);
  const tEnd = Math.max(...done) * 1.04;
  const rows: TimelineRow[] = r.clients.map((c) => {
    const spans = [];
    const conn = c.connected ?? tEnd;
    spans.push({ t0: c.start, t1: conn, color: PH.hs, title: c.synRetx ? `SYN sent ${c.synRetx + 1} times` : "handshake" });
    if (c.connected !== undefined && c.queued !== undefined && c.queued - c.connected > 1) spans.push({ t0: c.connected, t1: c.queued, color: PH.ignored, title: "connected for the client, but the server ignored its ACK" });
    if (c.queued !== undefined) spans.push({ t0: Math.max(c.queued, c.connected ?? 0), t1: c.accepted ?? tEnd, color: PH.queue, title: "in the accept queue" });
    if (c.accepted !== undefined) spans.push({ t0: c.accepted, t1: c.done ?? tEnd, color: PH.served, title: "accepted and served" });
    return { label: `${c.id + 1}`, spans };
  });
  const naive = (clients * service) / workers;
  const synDrops = r.ls.stats.synDrops;
  const last = r.lastDone ?? Math.max(...done);
  const maxQ = Math.max(...r.ls.qlog.map((q) => q[2]), backlog + 1);
  return (
    <Demo
      title="A burst of connects against one slow server"
      controls={<>
        <Param spec={AQ.backlog} value={backlog} onChange={(v) => P.set("backlog", v as number)} />
        <Param spec={AQ.service} value={service} onChange={(v) => P.set("service", v as number)} />
        <Param spec={AQ.clients} value={clients} onChange={(v) => P.set("clients", v as number)} />
        <Param spec={AQ.workers} value={workers} onChange={(v) => P.set("workers", v as number)} />
      </>}
    >
      <SmallLabel>One row per client (5 ms away, one connect each millisecond). Hover a bar for its phase.</SmallLabel>
      <Timeline rows={rows} tEnd={tEnd} rowH={clients > 28 ? 8 : 10} labelW={28} />
      <Legend items={[{ label: "handshake (SYN_SENT)", color: PH.hs }, { label: "client connected, server ignored the ACK", color: PH.ignored }, { label: "in the accept queue", color: PH.queue }, { label: "accepted and served", color: PH.served }]} />
      <Plot x={[0, tEnd]} y={[0, maxQ * 1.35]} height={130} xLabel="time (ms)" yLabel="accept queue">
        <RuleY at={backlog + 1} label={`full: ${backlog + 1}`} color="var(--c4)" />
        <Line points={r.ls.qlog.flatMap(([t, , a], i, all) => (i ? [[t, all[i - 1]![2]] as const, [t, a] as const] : [[t, a] as const]))} color="var(--c5)" />
      </Plot>
      <Banner tone={last > naive * 1.5 ? "bad" : "good"}>
        {last > naive * 1.5
          ? `The last answer arrives at ${int(last)} ms, not ${int(naive)} ms. A full queue drops SYNs (the client waits 1 s to send again) and ignores final ACKs (the client thinks it is connected, and its request waits for a retransmission).`
          : `The queue never overflows. The last answer arrives at ${int(last)} ms, close to ${int(naive)} ms of work.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "SYNs dropped (accept queue full)", value: int(synDrops) },
          { label: "final ACKs ignored", value: int(r.ls.stats.ackDrops) },
          { label: "SYN cookies sent (SYN queue full)", value: int(r.ls.listener.stats.cookiesSent) },
          { label: "clients with no error", value: `${r.clients.filter((c) => !c.failed && c.done !== undefined).length} of ${clients}` },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>What ss -lnt shows for this socket at its fullest. For a listener, Recv-Q is the accept queue and Send-Q is the backlog.</SmallLabel>
      <div style={{ ...mono, fontSize: 12, overflowX: "auto", whiteSpace: "pre", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px" }}>
        {`State   Recv-Q  Send-Q  Local Address:Port\nLISTEN  ${String(r.ls.stats.maxAcceptQueue).padEnd(6)}  ${String(backlog).padEnd(6)}  0.0.0.0:80`}
      </div>
    </Demo>
  );
}

// ============================================================================ 3. Bytes, not messages

const SR = {
  msg: range({ label: "Message size", min: 200, max: 3000, step: 100, default: 1000, format: (v) => `${v} B` }),
  sndbuf: range({ label: "Send buffer (model input)", min: 1000, max: 8000, step: 250, default: 2500, format: (v) => `${v} B` }),
  readbuf: range({ label: "read() buffer", min: 256, max: 8192, step: 256, default: 4096, format: (v) => `${v} B` }),
  every: range({ label: "The reader reads", min: 0, max: 20, step: 1, default: 0, format: (v) => (v ? `every ${v} ms` : "when data arrives") }),
  nagle: toggle({ label: "Nagle's algorithm (the default; off is TCP_NODELAY)", default: true }),
};

const MSG_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c4)"];

export function NetProgStreamDemo() {
  const P = useParams("net-prog-stream", SR);
  const { msg, sndbuf, readbuf, every, nagle } = P.values;
  const r = useMemo(() => streamRun({ msgBytes: msg, sndBuf: sndbuf, readBuf: readbuf, readEvery: every, nagle }), [msg, sndbuf, readbuf, every, nagle]);
  const total = r.messages.at(-1)![1];
  const msgChunks: Chunk[] = r.messages.map(([s, e], i) => ({ start: s, n: e - s, color: MSG_COLORS[i % 5]!, text: `M${i + 1}` }));
  let pos = 0;
  const writeChunks: Chunk[] = [];
  for (const w of r.writes) if (w.got > 0) {
    writeChunks.push({ start: pos, n: w.got, color: w.got < w.asked ? "var(--c4)" : "var(--c1)", text: `${w.got}` });
    pos += w.got;
  }
  pos = 0;
  const segChunks: Chunk[] = r.segments.map((n) => {
    const c = { start: pos, n, color: "var(--muted)", text: `${n}` };
    pos += n;
    return c;
  });
  const cuts = (start: number, n: number) => r.messages.some(([s, e]) => (s > start && s < start + n) || (e > start && e < start + n));
  const readChunks: Chunk[] = r.reads.map((x) => ({ start: x.start, n: x.n, color: cuts(x.start, x.n) ? "var(--c5)" : "var(--c3)", text: `${x.n}` }));
  const shortWrites = r.writes.filter((w) => w.got > 0 && w.got < w.asked).length;
  const eagain = r.writes.filter((w) => w.got < 0).length;
  const cutReads = r.reads.filter((x) => cuts(x.start, x.n)).length;
  return (
    <Demo
      title="Five messages into a stream"
      controls={<>
        <Param spec={SR.msg} value={msg} onChange={(v) => P.set("msg", v as number)} />
        <Param spec={SR.sndbuf} value={sndbuf} onChange={(v) => P.set("sndbuf", v as number)} />
        <Param spec={SR.readbuf} value={readbuf} onChange={(v) => P.set("readbuf", v as number)} />
        <Param spec={SR.every} value={every} onChange={(v) => P.set("every", v as number)} />
        <Param spec={SR.nagle} value={nagle} onChange={(v) => P.set("nagle", v as boolean)} />
      </>}
    >
      <SmallLabel>The same {int(total)} bytes, four times. A non-blocking sender writes five messages; the link is 10 Mbit/s with 5 ms of delay.</SmallLabel>
      <ByteStrip label="messages" chunks={msgChunks} total={total} />
      <ByteStrip label="write() returns" chunks={writeChunks} total={total} />
      <ByteStrip label="segments" chunks={segChunks} total={total} />
      <ByteStrip label="read() returns" chunks={readChunks} total={total} />
      <Legend items={[{ label: "short write", color: "var(--c4)" }, { label: "read that cuts a message", color: "var(--c5)" }, { label: "read on a boundary", color: "var(--c3)" }]} />
      <Banner tone={shortWrites || cutReads ? "warn" : "good"}>
        {`${shortWrites} short write${shortWrites === 1 ? "" : "s"} and ${eagain} EAGAIN${eagain === 1 ? "" : "s"}: the send buffer was full. ${cutReads} of ${r.reads.length} reads cut a message in two. TCP keeps the order of the bytes, not the boundaries of your writes.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["ms", "write() asked", "returned"]}
          rows={r.writes.slice(0, 14).map((w) => [w.t.toFixed(1), int(w.asked), w.got < 0 ? "-1, EAGAIN" : int(w.got)])}
          highlight={(i) => r.writes[i]!.got < r.writes[i]!.asked}
        />
      </div>
    </Demo>
  );
}
