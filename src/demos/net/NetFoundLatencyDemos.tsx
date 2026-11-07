/** Demos for "Latency, bandwidth and the BDP": where one packet's time goes, bandwidth against latency, and filling the pipe. */
import { useMemo } from "react";
import {
  Banner, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleX, SectionLabel, Stats, StackBar, fixed, int, ms, pct, range, select, seg,
  si, useChunked, useParams, useWidth, tint,
} from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { bdpBytes } from "../../sims/net";
import {
  city, crossoverBytes, examplePath, greatCircleKm, pathBreakdown, pathRun, slowStartRounds, totalMs, transferMs, vacuumRttMs, windowRun,
} from "../../sims/net/foundations";

const bps = (v: number) => si(v, "bit/s");

// ============================================================================ 1. Where one packet's time goes

const ROUTES: [string, string][] = [["fra-lon", "Frankfurt → London"], ["nyc-lon", "New York → London"], ["nyc-tyo", "New York → Tokyo"], ["sfo-syd", "San Francisco → Sydney"]];

const PA = {
  pkt: range({ label: "Packet size", min: 64, max: 9000, step: 1, default: 1500, format: (v) => `${int(v)} B` }),
  access: range({ label: "Access link rate", min: 1e6, max: 1e10, log: true, default: 100e6, format: bps }),
  load: range({ label: "Other traffic on the access link", min: 0, max: 0.95, step: 0.05, default: 0.5, format: (v) => pct(v, 0) }),
  route: select({ label: "Route", options: ROUTES.map(([value, label]) => ({ value, label })), default: "nyc-lon" }),
};

const PART_COLOR = { prop: "var(--c1)", ser: "var(--c2)", proc: "var(--c5)", queue: "var(--c4)" };

export function PathLatencyDemo() {
  const P = useParams("net-found-path", PA);
  const { pkt, access, load, route } = P.values;
  const [a, b] = route.split("-") as [string, string];
  const km = greatCircleKm(city(a), city(b));
  const path = useMemo(() => examplePath(access, km), [access, km]);
  // Probes 40 serializations apart add at most 2.5% of load to the access link.
  const xSer = (Math.max(1500, pkt) * 8 * 1000) / access;
  const run = useMemo(() => pathRun(path, pkt, load, { probes: 150, spacingMs: Math.max(0.05, 40 * xSer), seed: 2 }), [path, pkt, load, xSer]);
  const hops = pathBreakdown(path, pkt, run.meanQueueMs);
  const sum = (k: "propMs" | "serMs" | "procMs" | "queueMs") => hops.reduce((s, h) => s + h[k], 0);
  const parts = { prop: sum("propMs"), ser: sum("serMs"), proc: sum("procMs"), queue: sum("queueMs") };
  const total = totalMs(hops);
  const names = [...path.map((h) => h.name), "server"];
  const biggest = (Object.entries(parts) as [keyof typeof parts, number][]).reduce((x, y) => (y[1] > x[1] ? y : x));
  const NAME = { prop: "propagation", ser: "serialization", proc: "processing", queue: "queueing" };
  const [tref, tw] = useWidth<HTMLDivElement>();
  const wide = tw >= 520;
  return (
    <Demo
      title="Where one packet's time goes"
      controls={<>
        <Param spec={PA.pkt} value={pkt} onChange={(v) => P.set("pkt", v as number)} />
        <Param spec={PA.access} value={access} onChange={(v) => P.set("access", v as number)} />
        <Param spec={PA.load} value={load} onChange={(v) => P.set("load", v as number)} />
        <Param spec={PA.route} value={route} onChange={(v) => P.set("route", v as string)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Six links from a laptop to a server, {int(km)} km of great circle on the long one. Rates, lengths and router times are model inputs; queueing is measured in PacketNet with random traffic on the access link.
      </div>
      <StackBar height={22} parts={(Object.keys(parts) as (keyof typeof parts)[]).map((k) => ({ value: parts[k], color: PART_COLOR[k], label: `${NAME[k]}: ${ms(parts[k])}` }))} />
      <Legend items={(Object.keys(parts) as (keyof typeof parts)[]).map((k) => ({ label: `${NAME[k]} ${ms(parts[k])}`, color: PART_COLOR[k] }))} />
      <div ref={tref} style={{ marginTop: 8 }}>
        <MiniTable
          head={wide ? ["link", "rate", "km", "prop.", "serial.", "proc.", "queue"] : ["link", "prop.", "serial.", "proc.", "queue"]}
          rows={hops.map((h, i) => [
            wide ? `${names[i]} → ${names[i + 1]}` : path[i]!.link,
            ...(wide ? [bps(path[i]!.rate), fixed(path[i]!.km, path[i]!.km < 1 ? 2 : 0)] : []),
            ms(h.propMs), ms(h.serMs), ms(h.procMs), ms(h.queueMs),
          ])}
          highlight={1}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "one way, this path", value: ms(total) },
          { label: "light in vacuum, one way", value: ms(vacuumRttMs(a, b) / 2) },
          { label: `${NAME[biggest[0]]} share`, value: pct(biggest[1] / total, 0) },
          { label: "99th pct. queue, access link", value: ms(run.p99QueueMs[1] ?? 0) },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Bandwidth or latency

const BL = {
  size: range({ label: "Transfer size", min: 1e3, max: 1e9, log: true, default: 1e5, format: (v) => si(v, "B") }),
  aRate: range({ label: "Link A rate", min: 1e6, max: 1e10, log: true, default: 1e9, format: bps }),
  aRtt: range({ label: "Link A round trip", min: 1, max: 300, step: 1, default: 150, format: (v) => `${v} ms` }),
  bRate: range({ label: "Link B rate", min: 1e6, max: 1e10, log: true, default: 50e6, format: bps }),
  bRtt: range({ label: "Link B round trip", min: 1, max: 300, step: 1, default: 10, format: (v) => `${v} ms` }),
  setup: seg("Before the first data byte", [["1", "TCP handshake: 1 RTT"], ["2", "TCP + TLS 1.3: 2 RTT"]], "1"),
};

const SIZES = Array.from({ length: 61 }, (_, i) => 1e3 * Math.pow(10, i / 10));

export function BandwidthLatencyDemo() {
  const P = useParams("net-found-bwlat", BL);
  const { size, aRate, aRtt, bRate, bRtt, setup } = P.values;
  const o = { setupRtts: Number(setup) };
  const tA = transferMs(size, aRate, aRtt, o), tB = transferMs(size, bRate, bRtt, o);
  const ptsA = SIZES.map((s) => [s, transferMs(s, aRate, aRtt, o)] as [number, number]);
  const ptsB = SIZES.map((s) => [s, transferMs(s, bRate, bRtt, o)] as [number, number]);
  const crossAt = crossoverBytes({ rate: aRate, rttMs: aRtt }, { rate: bRate, rttMs: bRtt }, o);
  const cross = Number.isFinite(crossAt) && crossAt <= 1e9 ? crossAt : undefined;
  const nearWins = aRtt < bRtt ? "A" : "B", farWins = nearWins === "A" ? "B" : "A";
  const yMin = 1, yMax = Math.max(...ptsA.map((p) => p[1]), ...ptsB.map((p) => p[1])) * 1.5;
  const fasterA = transferMs(size, aRate * 10, aRtt, o), nearerA = transferMs(size, aRate, aRtt / 2, o);
  const lineTime = (r: number) => (size * 8 * 1000) / r;
  return (
    <Demo
      title="More bandwidth, or less latency?"
      controls={<>
        <Param spec={BL.size} value={size} onChange={(v) => P.set("size", v as number)} />
        <Param spec={BL.aRate} value={aRate} onChange={(v) => P.set("aRate", v as number)} />
        <Param spec={BL.aRtt} value={aRtt} onChange={(v) => P.set("aRtt", v as number)} />
        <Param spec={BL.bRate} value={bRate} onChange={(v) => P.set("bRate", v as number)} />
        <Param spec={BL.bRtt} value={bRtt} onChange={(v) => P.set("bRtt", v as number)} />
        <Param spec={BL.setup} value={setup} onChange={(v) => P.set("setup", v as never)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Time from connect() to the last byte. TCP starts with 10 segments and doubles its window each round trip until the window covers the path (slow start, no loss).
      </div>
      <Plot x={[1e3, 1e9]} y={[yMin, yMax]} logX logY height={240} xLabel="transfer size" yLabel="time"
        xTicks={[1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9]} xFormat={(v) => si(v, "B")} yTicks={[1, 10, 100, 1e3, 1e4, 1e5, 1e6].filter((t) => t <= yMax)} yFormat={(v) => (v >= 1000 ? `${v / 1000} s` : `${v} ms`)}>
        <Line points={ptsA} color="var(--c1)" />
        <Line points={ptsB} color="var(--c2)" />
        <RuleX at={size} color="var(--muted)" />
        <Dots points={[[size, tA]]} color="var(--c1)" r={4} />
        <Dots points={[[size, tB]]} color="var(--c2)" r={4} />
      </Plot>
      <Legend items={[{ label: `A: ${bps(aRate)}, ${aRtt} ms`, color: "var(--c1)" }, { label: `B: ${bps(bRate)}, ${bRtt} ms`, color: "var(--c2)" }]} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={["", "A", "B"]}
          rows={[
            ["total time", ms(tA), ms(tB)],
            ["of which the bytes on the wire", ms(lineTime(aRate)), ms(lineTime(bRate))],
            ["round trips spent growing the window", slowStartRounds(size, aRate, aRtt), slowStartRounds(size, bRate, bRtt)],
            ["share of time that is waiting", pct(1 - lineTime(aRate) / tA), pct(1 - lineTime(bRate) / tB)],
          ]}
        />
      </div>
      <Banner tone="info">
        For this size on A: 10× the bandwidth gives {ms(fasterA)}; half the round trip gives {ms(nearerA)}.
        {cross ? ` ${nearWins} wins below about ${si(cross, "B", 2)}; ${farWins} wins above.` : ""}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. Fill the pipe

const FP = {
  w: range({ label: "Window", min: 1, max: 100, step: 1, default: 8, format: (v) => `${v} packets` }),
  rate: range({ label: "Bottleneck rate", min: 1e6, max: 1e8, log: true, default: 10e6, format: bps }),
  owd: range({ label: "One-way delay", min: 1, max: 50, step: 1, default: 10, format: (v) => `${v} ms` }),
  at: range({ label: "Snapshot time (share of the run)", min: 0, max: 1, step: 0.01, default: 0.6, format: (v) => pct(v, 0) }),
};

const SWEEP_W = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 80, 100];

export function FillPipeDemo() {
  const P = useParams("net-found-pipe-fill", FP);
  const { w, rate, owd, at } = P.values;
  const packets = Math.min(400, Math.max(60, 5 * w));
  const run = useMemo(() => windowRun({ rate, owdMs: owd, window: w, packets, record: true }), [rate, owd, w, packets]);
  const pktBytes = 1500;
  const bdp = bdpBytes(rate, run.baseRttMs);
  const bdpPk = bdp / pktBytes;
  const steadyRtt = run.rttMs.slice(Math.floor(packets / 2)).reduce((s, x) => s + x, 0) / Math.max(1, packets - Math.floor(packets / 2));
  const t = at * run.doneMs;
  const sweep = useChunked(`net-found-fill-${rate}-${owd}`, SWEEP_W.map((x) => () => {
    const r = windowRun({ rate, owdMs: owd, window: x, packets: Math.max(200, 4 * x) });
    const half = Math.floor(r.rttMs.length / 2);
    return { thr: r.throughputBps, rtt: r.rttMs.slice(half).reduce((s, v) => s + v, 0) / (r.rttMs.length - half) };
  }), { keep: true });
  const st = fromPackets(run.net, { color: (p) => (p.payload.ack ? "var(--c3)" : "var(--c1)"), filter: (p) => p.payload.seq < Math.max(12, Math.min(3 * w, 40)) });
  const tEndSt = Math.min(run.doneMs, 3.2 * run.baseRttMs + w * (pktBytes * 8000) / rate);
  return (
    <Demo
      title="Fill the pipe"
      controls={<>
        <Param spec={FP.w} value={w} onChange={(v) => P.set("w", v as number)} />
        <Param spec={FP.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={FP.owd} value={owd} onChange={(v) => P.set("owd", v as number)} />
        <Param spec={FP.at} value={at} onChange={(v) => P.set("at", v as number)} />
      </>}
    >
      <PipeView run={run} t={t} owd={owd} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "bandwidth-delay product", value: `${si(bdp, "B")} = ${fixed(bdpPk, 1)} pkts` },
          { label: "throughput (data)", value: bps(run.throughputBps) },
          { label: "link busy", value: pct(Math.min(1, run.throughputBps / (rate * 1460 / pktBytes)), 0) },
          { label: "RTT now (base)", value: `${ms(steadyRtt)} (${ms(run.baseRttMs)})` },
        ]} />
      </div>
      <Banner tone={w < bdpPk * 0.97 ? "warn" : w > bdpPk * 1.1 ? "bad" : "good"}>
        {w < bdpPk * 0.97
          ? `The window is smaller than the BDP. The sender waits for ACKs while the link is idle: throughput is about window / RTT.`
          : w > bdpPk * 1.1
            ? `The window is larger than the BDP. The link is full, and the extra ${fixed(w - bdpPk, 0)} packets wait in the router's queue: they add delay, not throughput.`
            : "The window matches the BDP: the link is always busy and nothing waits in the queue."}
      </Banner>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 6 }}>
        <div>
          <SectionLabel>Throughput by window</SectionLabel>
          <Plot x={[0, 100]} y={[0, rate * 1.05]} height={170} xLabel="window (packets)" yFormat={(v) => si(v, "")}>
            <Line points={SWEEP_W.flatMap((x, i) => (sweep[i] ? [[x, sweep[i]!.thr] as [number, number]] : []))} color="var(--c1)" />
            <RuleX at={bdpPk} color="var(--c4)" label="BDP" />
            <Dots points={[[w, run.throughputBps]]} color="var(--c1)" r={4} />
          </Plot>
        </div>
        <div>
          <SectionLabel>RTT by window</SectionLabel>
          <Plot x={[0, 100]} y={[0, Math.max(...SWEEP_W.map((_, i) => sweep[i]?.rtt ?? 0), run.baseRttMs * 2) * 1.05]} height={170} xLabel="window (packets)" yLabel="ms">
            <Line points={SWEEP_W.flatMap((x, i) => (sweep[i] ? [[x, sweep[i]!.rtt] as [number, number]] : []))} color="var(--c2)" />
            <RuleX at={bdpPk} color="var(--c4)" label="BDP" />
            <Dots points={[[w, steadyRtt]]} color="var(--c2)" r={4} />
          </Plot>
        </div>
      </div>
      <SectionLabel>The first packets: data (blue) and ACKs (green)</SectionLabel>
      <SpaceTime nodes={st.names} tEnd={tEndSt} messages={st.messages} rowHeight={40} />
    </Demo>
  );
}

/**
 * The bottleneck as a pipe at time t: data packets as blocks on the top lane (each as long as its serialization
 * time, scaled to the one-way delay), ACKs on the bottom lane, and the router's queue as a stack.
 */
function PipeView({ run, t, owd }: { run: ReturnType<typeof windowRun>; t: number; owd: number }) {
  const [ref, w0] = useWidth<HTMLDivElement>();
  const w = Math.max(280, w0);
  const qx = 70, x0 = 112, x1 = w - 58, laneH = 22, top = 18;
  const net = run.net;
  const fwd = net.portTo(1, 2).id, back = net.portTo(2, 1).id;
  const len = x1 - x0;
  const pos = (age: number) => x0 + (Math.max(0, Math.min(owd, age)) / owd) * len;
  const blocks: { x: number; wpx: number; y: number; ack: boolean }[] = [];
  for (const h of net.hops) {
    if (h.port !== fwd && h.port !== back) continue;
    if (h.arriveAt === undefined || t < h.txStart || t > h.arriveAt) continue;
    const ack = h.port === back;
    // Bits that left at τ are (t − τ)/owd of the way along. The block spans the bits sent so far.
    const front = t - h.txStart, rear = t - Math.min(t, h.txEnd);
    const a = pos(rear), b = pos(front);
    blocks.push(ack ? { x: x0 + x1 - b, wpx: Math.max(1.5, b - a), y: top + laneH + 12, ack } : { x: a, wpx: Math.max(1.5, b - a), y: top, ack });
  }
  const q = net.ports[fwd]!.qlog.filter(([tt]) => tt <= t).pop()?.[1] ?? 0;
  const qPk = Math.round(q / 1500);
  const inflight = blocks.filter((b) => !b.ack).length;
  const h = top + 2 * laneH + 30;
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="packets in flight on the bottleneck" style={{ display: "block" }}>
        <text x={4} y={top + laneH + 6} fontSize="11" fill="var(--muted)">sender</text>
        <rect x={qx - 22} y={top} width={36} height={2 * laneH + 12} rx={4} fill="none" stroke="var(--border)" />
        {Array.from({ length: Math.min(qPk, 20) }, (_, i) => (
          <rect key={i} x={qx - 19} y={top + 2 * laneH + 9 - (i + 1) * ((2 * laneH + 6) / 20)} width={30} height={(2 * laneH + 6) / 20 - 0.8} fill="var(--c4)" opacity={0.75} />
        ))}
        <text x={qx - 4} y={top - 5} fontSize="10.5" textAnchor="middle" fill="var(--muted)">queue {qPk}{qPk > 20 ? "+" : ""}</text>
        <rect x={x0} y={top} width={len} height={laneH} fill={tint("var(--c1)", 8)} stroke="var(--border)" />
        <rect x={x0} y={top + laneH + 12} width={len} height={laneH} fill={tint("var(--c3)", 8)} stroke="var(--border)" />
        {blocks.map((b, i) => (
          <rect key={i} x={b.x} y={b.y + 3} width={b.wpx} height={laneH - 6} rx={2} fill={b.ack ? "var(--c3)" : "var(--c1)"} opacity={0.85} />
        ))}
        <text x={x1 + 6} y={top + laneH + 6} fontSize="11" fill="var(--muted)">receiver</text>
        <text x={x0} y={h - 3} fontSize="10.5" fill="var(--faint)">{`router: ${inflight} data packets on the wire at ${Math.round(t)} ms`}</text>
      </svg>
    </div>
  );
}

