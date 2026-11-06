/** Demos for "The eight fallacies": tail latency at fan-out, and the bandwidth-delay product. */
import { useMemo } from "react";
import { Banner, Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes, fixed, pct, range, si, useParams, useWidth, MONO } from "../../kit";
import { DEFAULT_BACKEND, backendQuantile, hitsSlow, requestQuantile, type Backend } from "../../sims/dist/foundations/fanout";
import { TCP_MAX_UNSCALED, bdpBytes, utilization, windowThroughput } from "../../sims/dist/foundations/bdp";

// ============================================================================ 1. Fan-out tail latency

const FO = {
  n: range({ label: "Fan-out n (backends per request)", min: 1, max: 200, log: true, default: 100, format: (v) => String(Math.round(v)) }),
  spare: range({ label: "Answers it can skip (waits for n − s)", min: 0, max: 10, step: 1, default: 0, format: (v) => `s = ${v}` }),
  stallP: range({ label: "Chance that one backend stalls", min: 0.0001, max: 0.05, log: true, default: DEFAULT_BACKEND.stallP, format: (v) => pct(v, v < 0.001 ? 2 : 1) }),
  stall: range({ label: "Stall length (model input)", min: 50, max: 2000, step: 50, default: DEFAULT_BACKEND.stall, format: (v) => `${v} ms` }),
};

const NS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 50, 70, 100, 140, 200];

export function FanoutTailDemo() {
  const P = useParams("dist-fal-fan", FO);
  const n = Math.round(P.values.n);
  const { spare, stallP, stall } = P.values;
  const b: Backend = { ...DEFAULT_BACKEND, stallP, stall };
  const k = Math.max(1, n - spare);
  const curves = useMemo(() => {
    const all = NS.map((m) => [m, requestQuantile(0.99, m, m, b)] as [number, number]);
    const skip = NS.map((m) => [m, requestQuantile(0.99, m, Math.max(1, m - spare), b)] as [number, number]);
    const med = NS.map((m) => [m, requestQuantile(0.5, m, m, b)] as [number, number]);
    return { all, skip, med };
  }, [spare, stallP, stall]); // eslint-disable-line react-hooks/exhaustive-deps
  const b50 = backendQuantile(0.5, b), b999 = backendQuantile(0.999, b);
  const rAll = requestQuantile(0.99, n, n, b), rK = requestQuantile(0.99, n, k, b), rMed = requestQuantile(0.5, n, n, b);
  const yMax = Math.max(stall * 1.4, 100);
  return (
    <Demo
      title="Fan-out turns a rare stall into the common case"
      controls={<>
        <Param spec={FO.n} value={P.values.n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={FO.spare} value={spare} onChange={(v) => P.set("spare", v as number)} />
        <Param spec={FO.stallP} value={stallP} onChange={(v) => P.set("stallP", v as number)} />
        <Param spec={FO.stall} value={stall} onChange={(v) => P.set("stall", v as number)} />
      </>}
    >
      <Plot x={[1, 200]} y={[5, yMax]} logX logY height={240} xLabel="fan-out n" yLabel="request latency (ms)" xTicks={[1, 3, 10, 30, 100, 200]} yTicks={[10, 30, 100, 300, 1000, 3000].filter((v) => v <= yMax)} xFormat={(v) => String(v)} yFormat={(v) => String(v)}>
        <Line points={curves.all} color="var(--c4)" />
        <Line points={curves.med} color="var(--c2)" dash="5 4" />
        {spare > 0 && <Line points={curves.skip} color="var(--c3)" />}
        <RuleX at={n} color="var(--muted)" />
      </Plot>
      <Legend items={[
        { label: "p99, waits for all n", color: "var(--c4)" },
        { label: "median, waits for all n", color: "var(--c2)" },
        ...(spare > 0 ? [{ label: `p99, waits for n − ${spare}`, color: "var(--c3)" }] : []),
      ]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "one backend: median, p99.9", value: `${fixed(b50, 0)} ms, ${fixed(b999, 0)} ms` },
          { label: `request p99, waits for all ${n}`, value: `${fixed(rAll, 0)} ms` },
          ...(spare > 0 ? [{ label: `request p99, waits for ${k} of ${n}`, value: `${fixed(rK, 0)} ms` }] : []),
          { label: `request median, waits for all ${n}`, value: `${fixed(rMed, 0)} ms` },
          { label: "requests that wait for a stall", value: pct(hitsSlow(n, stallP), 1) },
        ]} />
      </div>
      <Banner tone={hitsSlow(n, stallP) > 0.5 ? "bad" : hitsSlow(n, stallP) > 0.05 ? "warn" : "good"}>
        Each backend stalls on {pct(stallP, stallP < 0.001 ? 2 : 1)} of requests. A request that waits for all {n} hits at least one stall {pct(hitsSlow(n, stallP), 1)} of the time.
        {spare > 0 ? ` Skipping the slowest ${spare} answer${spare > 1 ? "s" : ""} brings its p99 to ${fixed(rK, 0)} ms.` : " Let it skip a few answers and watch the green line."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Bandwidth-delay product

const BD = {
  bw: range({ label: "Link bandwidth", min: 1e6, max: 1e11, log: true, default: 1e10, format: (v) => `${si(v, "bit/s", 3)}` }),
  rtt: range({ label: "Round-trip time", min: 0.1, max: 300, log: true, default: 100, format: (v) => (v < 1 ? `${fixed(v * 1000, 0)} µs` : `${fixed(v, v < 10 ? 1 : 0)} ms`) }),
  win: range({ label: "Window (unacknowledged bytes)", min: 16384, max: 2 ** 30, log: true, default: TCP_MAX_UNSCALED, format: (v) => bytes(Math.round(v)) }),
};

/** A pipe one RTT long. The window fills a share of it with packets; the rest is idle capacity. */
function Pipe({ fill, cells }: { fill: number; cells: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(260, width);
  const h = 34, pad = 8;
  const cw = (W - 2 * pad) / cells;
  const used = Math.round(fill * cells);
  return (
    <div ref={ref}>
      <svg width="100%" height={h + 30} viewBox={`0 0 ${W} ${h + 30}`} style={{ display: "block" }}>
        <rect x={pad} y={6} width={W - 2 * pad} height={h} rx={6} fill="var(--subtle)" stroke="var(--border)" />
        {Array.from({ length: cells }, (_, i) => (
          <rect key={i} x={pad + i * cw + 1} y={10} width={Math.max(0.5, cw - 2)} height={h - 8} rx={2} fill={i < used ? "var(--c1)" : "none"} stroke={i < used ? "none" : "var(--border)"} strokeDasharray="2 2" />
        ))}
        <text x={pad} y={h + 24} fontSize={11} fill="var(--muted)">sender</text>
        <text x={W - pad} y={h + 24} fontSize={11} fill="var(--muted)" textAnchor="end">one round trip later, the first ack returns</text>
      </svg>
    </div>
  );
}

export function BdpDemo() {
  const P = useParams("dist-fal-bdp", BD);
  const { bw, rtt, win } = P.values;
  const bdp = bdpBytes(bw, rtt);
  const u = utilization(win, rtt, bw);
  const thr = windowThroughput(win, rtt, bw);
  const gb = 1e9;
  const tx = (gb * 8) / thr;
  return (
    <Demo
      title="How much data fits in the pipe"
      actions={<>
        <button className="btn ghost" onClick={() => P.set("win", TCP_MAX_UNSCALED)}>64 KiB window</button>
        <button className="btn ghost" onClick={() => P.set("win", Math.min(2 ** 30, Math.max(16384, bdp)))}>Window = BDP</button>
      </>}
      controls={<>
        <Param spec={BD.bw} value={bw} onChange={(v) => P.set("bw", v as number)} />
        <Param spec={BD.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={BD.win} value={win} onChange={(v) => P.set("win", v as number)} />
      </>}
    >
      <Pipe fill={u} cells={40} />
      <div className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>Each cell is 1/40 of the bandwidth-delay product. Blue cells hold data in flight; empty cells are capacity that the sender cannot use, because it must wait for acks.</div>
      <Stats items={[
        { label: "bandwidth-delay product", value: bytes(Math.round(bdp)) },
        { label: "in flight", value: bytes(Math.round(Math.min(win, bdp))) },
        { label: "throughput", value: si(thr, "bit/s", 3) },
        { label: "link used", value: pct(u, u < 0.01 ? 2 : 1) },
        { label: "time to send 1 GB", value: tx >= 60 ? `${fixed(tx / 60, 1)} min` : `${fixed(tx, tx < 1 ? 3 : 1)} s` },
      ]} />
      <Banner tone={u >= 0.99 ? "good" : u > 0.2 ? "warn" : "bad"}>
        {u >= 0.99
          ? `The window covers the bandwidth-delay product (${bytes(Math.round(bdp))}), so the link runs full.`
          : <>The window is {fixed(win / bdp * 100, win / bdp < 0.01 ? 2 : 1)}% of the <span style={{ fontFamily: MONO }}>bandwidth × RTT</span>. The sender sends one window, then waits for acks: throughput is window / RTT = {si(thr, "bit/s", 3)}, whatever the link speed.</>}
      </Banner>
    </Demo>
  );
}
