/** Demos for "Flow control": a slow reader, window scaling and autotuning, silly window syndrome, and Nagle with delayed ACKs. */
import { useMemo } from "react";
import { Area, Banner, Bars, Chip, Demo, Legend, Line, Param, Plot, RuleX, RuleY, SmallLabel, StackBar, Stats, bytes, int, mono, pct, range, seg, si, toggle, useChunked, useParams } from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { bdpBytes } from "../../sims/net";
import { headerOverhead, nagleRun, slowReaderRun, throughputRun, windowLimitedRate } from "../../sims/net/transport";

// ============================================================================ 1. A slow reader

const SR = {
  buf: range({ label: "Receive buffer", min: 4096, max: 65536, step: 1024, default: 16384, format: (v) => bytes(v) }),
  rate: range({ label: "Application reads", min: 50, max: 1000, step: 10, default: 200, format: (v) => `${v} KB/s` }),
  pause: range({ label: "Application pauses for", min: 0, max: 2000, step: 50, default: 1100, format: (v) => `${v} ms` }),
  lose: toggle({ label: "Lose every window update", default: false }),
  at: range({ label: "Look at time", min: 0, max: 3000, step: 10, default: 800, format: (v) => `${v} ms` }),
};

export function NetTcpSlowReaderDemo() {
  const P = useParams("net-flow-slow", SR);
  const { buf, rate, pause, lose, at } = P.values;
  const r = useMemo(() => slowReaderRun({ rcvBuf: buf, readRate: rate, pauseFrom: 100, pauseTo: 100 + pause, loseUpdate: lose, duration: 3000 }), [buf, rate, pause, lose]);
  const s = r.samples.reduce((b, x) => (Math.abs(x.t - at) < Math.abs(b.t - at) ? x : b), r.samples[0]!);
  const yMax = buf * 1.1;
  const acked = s.una - 1, inflight = s.nxt - s.una, usable = Math.max(0, s.una + s.sndWnd - s.nxt);
  const waiting = Math.max(0, 1 + s.written - s.nxt - usable);
  return (
    <Demo
      title="A fast sender, a slow reader"
      controls={<>
        <Param spec={SR.buf} value={buf} onChange={(v) => P.set("buf", v as number)} />
        <Param spec={SR.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={SR.pause} value={pause} onChange={(v) => P.set("pause", v as number)} />
        <Param spec={SR.lose} value={lose} onChange={(v) => P.set("lose", v as boolean)} />
        <Param spec={SR.at} value={at} onChange={(v) => P.set("at", v as number)} />
      </>}
    >
      <Plot x={[0, 3000]} y={[0, yMax]} height={210} xLabel="time (ms)" yLabel="bytes" yFormat={(v) => `${Math.round(v / 1024)}K`}>
        <Area points={r.samples.map((x) => [x.t, x.buffered] as const)} color="var(--c2)" opacity={0.25} />
        <Line points={r.samples.map((x) => [x.t, x.buffered] as const)} color="var(--c2)" width={1.5} />
        <Line points={r.samples.map((x) => [x.t, x.wnd] as const)} color="var(--c3)" />
        <Line points={r.samples.map((x) => [x.t, x.inflight] as const)} color="var(--c1)" width={1.5} />
        {r.probeTimes.map((t, i) => <RuleX key={`p${i}`} at={t} color="var(--c4)" label={i === 0 ? "probe" : undefined} />)}
        <RuleX at={at} color="var(--fg)" dash="2 2" />
        <RuleY at={buf} color="var(--faint)" />
      </Plot>
      <Legend items={[{ label: "unread in receive buffer", color: "var(--c2)" }, { label: "advertised window", color: "var(--c3)" }, { label: "in flight", color: "var(--c1)" }, { label: "zero-window probe", color: "var(--c4)" }]} />
      <SmallLabel style={{ marginTop: 10 }}>At {s.t} ms. Sender's byte stream (scale: 4 × the buffer):</SmallLabel>
      <StackBar total={Math.max(4 * buf, acked + inflight + usable + 1)} parts={[
        { value: Math.min(acked, 2 * buf), color: "var(--faint)", label: "acknowledged" },
        { value: inflight, color: "var(--c1)", label: "in flight" },
        { value: usable, color: "var(--c3)", label: "usable window" },
        { value: Math.min(waiting, buf), color: "var(--border)", label: "waiting: outside the window" },
      ]} />
      <SmallLabel style={{ marginTop: 6 }}>Receive buffer ({bytes(buf)}): unread data, then the free part, which is the window.</SmallLabel>
      <StackBar total={buf} parts={[{ value: s.buffered, color: "var(--c2)", label: "unread" }, { value: s.wnd, color: "var(--c3)", label: "window" }]} />
      <div style={{ ...mono, fontSize: 12, marginTop: 6, color: "var(--muted)" }}>in flight {int(inflight)} B · usable {int(usable)} B · peer window {int(s.sndWnd)} B · unread {int(s.buffered)} B</div>
      <Banner tone={r.zeroMs > 0 ? (lose ? "bad" : "warn") : "good"}>
        {r.zeroMs > 0
          ? `The window was zero for ${int(r.zeroMs)} ms. The sender probed ${r.probes} time${r.probes === 1 ? "" : "s"}, each wait twice the last. ${lose ? "Every window update was lost, so only a probe's answer could restart the sender." : "A window update restarted it as soon as the application read again."}`
          : "The reader keeps up: the window never closes."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "zero-window time", value: `${int(r.zeroMs)} ms` },
          { label: "probes", value: r.probes },
          { label: "window updates", value: r.updates },
          { label: "all 120 KB read at", value: Number.isFinite(r.doneAt) ? `${int(r.doneAt)} ms` : "> 3 s" },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Window scaling and autotuning

const WS = {
  rtt: range({ label: "Round-trip time", min: 10, max: 300, step: 10, default: 100, format: (v) => `${v} ms` }),
  rate: range({ label: "Link rate", min: 10, max: 100, step: 10, default: 100, format: (v) => `${v} Mbit/s` }),
  mode: seg<string>("Receive window", [["64k", "64 KiB, no scaling"], ["4m", "4 MiB, scaling"], ["auto", "Autotuning from 64 KiB"]], "64k"),
};

export function NetTcpWindowScaleDemo() {
  const P = useParams("net-flow-ws", WS);
  const { rtt, rate, mode } = P.values;
  const bps = rate * 1e6;
  const opts = mode === "64k" ? { rcvBuf: 65535, windowScaling: false } : mode === "4m" ? { rcvBuf: 4 << 20, rcvBufMax: 4 << 20, windowScaling: true } : { rcvBuf: 65536, rcvBufMax: 6 << 20, windowScaling: true, autotune: true };
  const dur = Math.min(2500, Math.max(1000, 15 * rtt));
  const key = `${rtt}-${rate}-${mode}`;
  const [run] = useChunked(key, [() => throughputRun({ ...opts, rate: bps, rtt, duration: dur })], { keep: true });
  const curve = (w: number) => Array.from({ length: 60 }, (_, i) => { const t = 5 + i * 5; return [t, windowLimitedRate(w, t, bps) / 1e6] as const; });
  const bdp = bdpBytes(bps, rtt);
  return (
    <Demo
      title="A 64 KiB window on a long path"
      controls={<>
        <Param spec={WS.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={WS.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={WS.mode} value={mode} onChange={(v) => P.set("mode", v as string)} />
      </>}
    >
      <Plot x={[0, 300]} y={[0, rate * 1.1]} height={200} xLabel="round-trip time (ms)" yLabel="Mbit/s">
        <Line points={curve(65535)} color="var(--c4)" />
        <Line points={curve(4 << 20)} color="var(--c3)" dash="5 3" />
        <RuleX at={rtt} color="var(--fg)" dash="2 2" />
      </Plot>
      <Legend items={[{ label: "limit with a 64 KiB window: window ÷ RTT", color: "var(--c4)" }, { label: "limit with a 4 MiB window", color: "var(--c3)" }]} />
      <SmallLabel style={{ marginTop: 10 }}>The simulated transfer at {rtt} ms ({(dur / 1000).toFixed(1)} s): rate per interval, and the receive buffer.</SmallLabel>
      {run ? (
        <>
          <Plot x={[0, dur]} y={[0, rate * 1.1]} height={150} xLabel="time (ms)" yLabel="Mbit/s">
            <Line points={run.rateSeries} color="var(--c1)" />
          </Plot>
          {mode === "auto" && (
            <Plot x={[0, dur]} y={[0, 6.3]} height={110} xLabel="time (ms)" yLabel="buffer (MiB)">
              <Line points={run.bufSeries.map(([t, b]) => [t, b / 1048576] as const)} color="var(--c5)" />
              <RuleY at={(2 * bdp) / 1048576} label="2 × BDP" />
            </Plot>
          )}
          <Stats items={[
            { label: "goodput, last quarter", value: si(run.steady, "bit/s") },
            { label: "bandwidth-delay product", value: bytes(bdp) },
            { label: "largest window advertised", value: bytes(run.maxWindow) },
            { label: "window scale shift", value: run.wscale },
          ]} />
        </>
      ) : <SmallLabel>Running…</SmallLabel>}
      <Banner tone={mode === "64k" && 65535 < bdp ? "bad" : "good"}>
        {65535 >= bdp
          ? `This path holds only ${bytes(bdp)}: a 64 KiB window is enough.`
          : mode === "64k"
            ? `This path holds ${bytes(bdp)} in flight. A 64 KiB window fills ${pct(65535 / bdp, 0)} of it, so the sender waits for ACKs most of the time.`
            : `This path holds ${bytes(bdp)} in flight. With window scaling the advertised window can exceed 64 KiB, so the sender can fill the path.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. Silly window syndrome

const SW = {
  chunk: range({ label: "Bytes per read() call", min: 10, max: 1460, step: 10, default: 50, format: (v) => `${v} B` }),
  sws: toggle({ label: "SWS avoidance (both sides)", default: false }),
};

export function NetTcpSwsDemo() {
  const P = useParams("net-flow-sws", SW);
  const { chunk, sws } = P.values;
  const r = useMemo(() => slowReaderRun({ rcvBuf: 8192, readRate: 100, chunk, total: 30_000, pauseTo: 0, swsAvoid: sws, nagle: false, duration: 600 }), [chunk, sws]);
  const sizes = r.segSizes.slice(0, 150);
  const avg = r.segSizes.reduce((a, b) => a + b, 0) / Math.max(1, r.segSizes.length);
  return (
    <Demo
      title="Silly window syndrome: tiny reads, tiny segments"
      controls={<>
        <Param spec={SW.chunk} value={chunk} onChange={(v) => P.set("chunk", v as number)} />
        <Param spec={SW.sws} value={sws} onChange={(v) => P.set("sws", v as boolean)} />
      </>}
    >
      <Plot x={[0, 150]} y={[0, 1750]} height={170} xLabel="data segment number" yLabel="payload bytes">
        <Bars bins={sizes.map((y, i) => ({ x0: i, x1: i + 1, y }))} color={sws ? "var(--c3)" : "var(--c4)"} />
        <RuleY at={1460} label="MSS" />
      </Plot>
      <Stats items={[
        { label: "data segments in 600 ms", value: int(r.segSizes.length) },
        { label: "mean payload", value: `${int(avg)} B` },
        { label: "header share of bytes sent", value: pct(headerOverhead(r.segSizes), 1) },
        { label: "window updates sent", value: int(r.updates) },
      ]} />
      <Banner tone={sws ? "good" : "bad"}>
        {sws
          ? "The receiver keeps its window closed until it can offer a full MSS or half its buffer. The sender sends only full segments: the header cost stays near 40 / 1500."
          : `Each read() frees ${chunk} bytes, the receiver advertises them at once, and the sender fills them at once. Most segments carry ${chunk} bytes behind 40 bytes of headers.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 4. Nagle and delayed ACK

const NG = {
  delay: range({ label: "One-way delay", min: 1, max: 40, step: 1, default: 5, format: (v) => `${v} ms` }),
  nagle: toggle({ label: "Nagle's algorithm (off = TCP_NODELAY)", default: true }),
  delack: seg<string>("Delayed ACK timeout at the server", [["0", "off"], ["40", "40 ms"], ["200", "200 ms"]], "40"),
};

export function NetTcpNagleDemo() {
  const P = useParams("net-flow-nagle", NG);
  const { delay, nagle, delack } = P.values;
  const r = useMemo(() => nagleRun({ nagle, delayedAck: Number(delack), delay }), [nagle, delack, delay]);
  const st = fromPackets(r.net, {
    filter: (p) => !(p.payload.flags & 0x03),
    label: (p) => (p.src === 0 && p.payload.len === 200 ? "H" : p.src === 0 && p.payload.len === 300 ? "B" : undefined),
    color: (p) => (p.payload.len > 0 ? (p.src === 0 ? "var(--c1)" : "var(--c3)") : p.payload.info.why === "delack" ? "var(--c4)" : "var(--muted)"),
  });
  const t0 = r.spans[0]?.[0] ?? 0;
  const tEnd = (r.spans[r.spans.length - 1]?.[1] ?? 100) + 2;
  const rtt = 2 * delay;
  const slow = r.latencies[1]! > 1.5 * rtt;
  return (
    <Demo
      title="Write, write, read: Nagle meets delayed ACK"
      controls={<>
        <Param spec={NG.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={NG.nagle} value={nagle} onChange={(v) => P.set("nagle", v as boolean)} />
        <Param spec={NG.delack} value={delack} onChange={(v) => P.set("delack", v as string)} />
      </>}
    >
      <SmallLabel>Each request is two writes (a 200-byte header, then a 300-byte body). The server answers after the whole request.</SmallLabel>
      <SpaceTime nodes={st.names} tStart={t0 - 1} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={64} />
      <Legend items={[{ label: "request: H header, B body", color: "var(--c1)" }, { label: "reply", color: "var(--c3)" }, { label: "ACK", color: "var(--muted)" }, { label: "ACK sent by the delayed-ACK timer", color: "var(--c4)" }]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Request latency:</span>
        {r.latencies.map((l, i) => <Chip key={i} color={l > 1.5 * rtt ? "var(--c4)" : "var(--c3)"}>{`#${i + 1}: ${l.toFixed(1)} ms`}</Chip>)}
        <span className="muted" style={{ fontSize: 12 }}>(one round trip is {rtt} ms)</span>
      </div>
      <Banner tone={slow ? "bad" : "good"}>
        {slow
          ? nagle && Number(delack) > 0
            ? `Nagle holds the body until the header is acknowledged. The server delays that ACK, hoping for more data, for up to ${delack} ms. Each request waits for the timer.`
            : "Nagle holds the body until the header is acknowledged: one extra round trip per request."
          : "The body leaves at once, so the server gets the whole request after one one-way delay."}
      </Banner>
    </Demo>
  );
}
