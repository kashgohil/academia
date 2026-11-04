import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Controls, Param, Plot, Line, Dots, Bars, Legend, RuleX, RuleY, useParams, select, range, toggle, useSim, pct } from "../kit";
import { mulberry32 } from "../sims/rng";
import { histogram } from "../sims/stats";
import * as S from "../sims/perf/systems";

const expo = (r: () => number, mean: number) => -Math.log(1 - r()) * mean;

// ---------------- 1. animated queue ----------------

interface Job { id: number; arrive: number }
interface Server { job: Job | null; start: number; until: number }

export function QueueAnimationDemo() {
  const [rho, setRho] = useState(0.7);
  const [c, setC] = useState(1);
  const [fixed, setFixed] = useState(false);
  const st = useRef({ t: 0, next: 0, id: 0, queue: [] as Job[], servers: [] as Server[], done: 0, respSum: 0, area: 0, lastT: 0, busy: 0, r: mulberry32(1) });
  const reset = () => {
    st.current = { t: 0, next: 0, id: 0, queue: [], servers: Array.from({ length: c }, () => ({ job: null, start: 0, until: 0 })), done: 0, respSum: 0, area: 0, lastT: 0, busy: 0, r: mulberry32(1) };
  };
  if (st.current.servers.length !== c) reset();
  const lambda = (rho * c) / 1; // service mean = 1 time unit
  const sim = useSim({
    dt: 1 / 60,
    speed: 2,
    autoplay: true,
    reset,
    step: (dt) => {
      const s = st.current;
      const inSystem = s.queue.length + s.servers.filter((x) => x.job).length;
      s.area += inSystem * dt;
      s.busy += s.servers.filter((x) => x.job).length * dt;
      s.t += dt;
      while (s.next <= s.t) { s.queue.push({ id: s.id++, arrive: s.next }); s.next += expo(s.r, 1 / lambda); }
      for (const sv of s.servers) {
        if (sv.job && sv.until <= s.t) { s.done++; s.respSum += sv.until - sv.job.arrive; sv.job = null; }
        if (!sv.job && s.queue.length) {
          sv.job = s.queue.shift()!;
          sv.start = s.t;
          sv.until = s.t + (fixed ? 1 : expo(s.r, 1));
        }
      }
    },
  });
  const s = st.current;
  const L = s.t > 0 ? s.area / s.t : 0;
  const X = s.t > 0 ? s.done / s.t : 0;
  const W = s.done ? s.respSum / s.done : 0;
  const shown = s.queue.slice(0, 24);
  const color = (j: Job) => { const w = s.t - j.arrive; return w < 1 ? "var(--c3)" : w < 4 ? "var(--c2)" : "var(--c4)"; };
  return (
    <Demo
      title="A queue in front of servers"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={
        <>
          <Param spec={range({ label: "Load (utilization)", min: 0.1, max: 0.98, step: 0.01, default: 0.7, format: (v) => pct(v, 0) })} value={rho} onChange={(v) => { setRho(v as number); sim.reset(); }} />
          <Param spec={select({ label: "Servers", options: ["1", "2", "4"].map((v) => ({ value: v, label: v })), default: "1", segmented: true })} value={String(c)} onChange={(v) => { setC(Number(v)); }} />
          <Param spec={toggle({ label: "Every job takes exactly the same time", default: false })} value={fixed} onChange={(v) => { setFixed(v as boolean); sim.reset(); }} />
        </>
      }
    >
      <svg viewBox="0 0 640 150" style={{ width: "100%", display: "block" }}>
        <text x={8} y={20} fontSize={11} fill="var(--muted)">arrivals →</text>
        <text x={8} y={140} fontSize={11} fill="var(--muted)">{s.queue.length} waiting</text>
        {shown.map((j, i) => (
          <circle key={j.id} cx={430 - i * 16} cy={75} r={6.5} fill={color(j)} style={{ transition: "cx 0.12s" }} />
        ))}
        {s.queue.length > shown.length && <text x={430 - shown.length * 16} y={79} fontSize={11} textAnchor="end" fill="var(--muted)">+{s.queue.length - shown.length}</text>}
        {s.servers.map((sv, k) => {
          const y = 75 + (k - (c - 1) / 2) * 34 - 13;
          const prog = sv.job ? Math.min(1, (s.t - sv.start) / Math.max(1e-6, sv.until - sv.start)) : 0;
          return (
            <g key={k}>
              <rect x={470} y={y} width={110} height={26} rx={6} fill="var(--bg)" stroke="var(--fg)" />
              <rect x={472} y={y + 2} width={106 * prog} height={22} rx={5} fill="var(--c1)" opacity={0.25} />
              {sv.job && <circle cx={490} cy={y + 13} r={6.5} fill="var(--c1)" />}
              <text x={505} y={y + 17} fontSize={11} fill="var(--fg)">server {k + 1}</text>
            </g>
          );
        })}
        <text x={600} y={79} fontSize={11} fill="var(--muted)">→ {s.done}</text>
      </svg>
      <Stats
        items={[
          { label: "jobs in the system, L (average)", value: L.toFixed(2) },
          { label: "throughput, λ (jobs per unit)", value: X.toFixed(2) },
          { label: "time in system, W (average)", value: W.toFixed(2) },
          { label: "λ × W", value: (X * W).toFixed(2) },
          { label: "theory W (one server, random)", value: c === 1 && !fixed ? S.mm1Response(1, rho).toFixed(2) : "–" },
        ]}
      />
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Each job needs 1 unit of service on average. Green jobs have waited less than 1 unit, red jobs more than 4. Little's law says L = λ × W.</p>
    </Demo>
  );
}

// ---------------- 2. latency vs utilization ----------------

const curveSchema = {
  servers: select({ label: "Servers sharing one queue", options: ["1", "4"].map((v) => ({ value: v, label: v })), default: "1", segmented: true }),
  variability: select({ label: "Service time", options: [{ value: "random", label: "random" }, { value: "fixed", label: "fixed" }], default: "random", segmented: true }),
};

const RHOS = [0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95];

export function LatencyCurveDemo() {
  const params = useParams("lq", curveSchema);
  const c = Number(params.values.servers);
  const pts = useMemo(() => RHOS.map((rho) => { const q = S.simulateQueue({ lambda: rho * c, service: 1, servers: c, variability: params.values.variability, jobs: 40000 }, 3); return { rho, mean: q.meanResponse, p99: q.p99 }; }), [c, params.values.variability]);
  return (
    <Demo title="Response time as load increases (service time = 1)" controls={<Controls params={params} />}>
      <Plot x={[0, 1]} y={[0, 60]} height={240} xFormat={(t) => pct(t, 0)} xLabel="utilization" yLabel="time in system">
        <Line points={RHOS.map((r) => [r, Math.min(60, S.mm1Response(1, r))])} color="var(--faint)" dash="4 3" />
        <Line points={pts.map((p) => [p.rho, p.mean])} color="var(--c1)" width={2} />
        <Dots points={pts.map((p) => [p.rho, p.mean])} color="var(--c1)" r={2.5} />
        <Line points={pts.map((p) => [p.rho, Math.min(60, p.p99)])} color="var(--c4)" width={2} />
        <Dots points={pts.map((p) => [p.rho, Math.min(60, p.p99)])} color="var(--c4)" r={2.5} />
      </Plot>
      <Legend items={[{ label: "mean (simulated)", color: "var(--c1)" }, { label: "99th percentile (simulated)", color: "var(--c4)" }, { label: "theory, 1 server, random: 1 / (1 − ρ)", color: "var(--faint)" }]} />
    </Demo>
  );
}

// ---------------- 3. Little's law calculator ----------------

export function LittleCalcDemo() {
  const [rate, setRate] = useState(2000);
  const [ms, setMs] = useState(25);
  const L = rate * (ms / 1000);
  return (
    <Demo
      title="How many requests are in progress?"
      controls={
        <>
          <Param spec={range({ label: "Requests per second (λ)", min: 10, max: 100000, default: 2000, log: true, format: (v) => Math.round(v).toLocaleString() })} value={rate} onChange={(v) => setRate(Math.round(v as number))} />
          <Param spec={range({ label: "Time per request (W)", min: 1, max: 1000, default: 25, log: true, format: (v) => `${Math.round(v)} ms` })} value={ms} onChange={(v) => setMs(Math.round(v as number))} />
        </>
      }
    >
      <Stats items={[{ label: "requests in progress, L = λ × W", value: L.toFixed(L < 10 ? 1 : 0) }, { label: "connections the pool needs (at least)", value: Math.ceil(L) }, { label: "threads, with one thread per request", value: Math.ceil(L) }]} />
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>Example: a service sends {rate.toLocaleString()} queries per second to a database. Each query takes {ms} ms. On average, {L.toFixed(0)} queries are open at the same time. A smaller connection pool makes requests wait.</p>
    </Demo>
  );
}

// ---------------- 4. fan-out ----------------

export function FanoutDemo() {
  const [n, setN] = useState(10);
  const curve = useMemo(() => [1, 2, 5, 10, 20, 50, 100, 200].map((k) => { const f = S.fanout(k, 2000); return [k, f.p50, f.p99] as const; }), []);
  const cur = useMemo(() => S.fanout(n, 3000), [n]);
  const bins = useMemo(() => { const h = histogram(cur.samples.map((x) => Math.log10(x)), 0.5, 3, 40); return h.map((b) => ({ x0: b.x0, x1: b.x1, y: b.count / cur.samples.length })); }, [cur]);
  return (
    <Demo title="One request waits for all of its backends" controls={<Param spec={range({ label: "Backends per request", min: 1, max: 200, default: 10, log: true, format: (v) => String(Math.round(v)) })} value={n} onChange={(v) => setN(Math.round(v as number))} />}>
      <Stats items={[{ label: "requests slower than 50 ms", value: pct(cur.slowShare, 1) }, { label: "1 − 0.99ⁿ", value: pct(1 - 0.99 ** n, 1) }, { label: "request median", value: `${cur.p50.toFixed(0)} ms` }, { label: "request p99", value: `${cur.p99.toFixed(0)} ms` }]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 12 }}>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Request latency distribution (log scale)</div>
          <Plot x={[0.5, 3]} y={[0, Math.max(...bins.map((b) => b.y)) * 1.1]} height={180} xTicks={[1, 1.699, 2, 2.699, 3]} xFormat={(t) => `${Math.round(10 ** t)} ms`} yFormat={(t) => pct(t, 0)}>
            <Bars bins={bins} />
            <RuleX at={Math.log10(cur.p99)} label="p99" color="var(--c4)" />
          </Plot>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Request latency vs backends</div>
          <Plot x={[1, 200]} y={[0, 400]} logX height={180} xTicks={[1, 10, 100]} xFormat={String} yLabel="ms">
            <Line points={curve.map((p) => [p[0], p[1]])} color="var(--c1)" width={1.75} />
            <Line points={curve.map((p) => [p[0], p[2]])} color="var(--c4)" width={1.75} />
            <RuleX at={n} />
          </Plot>
          <Legend items={[{ label: "median", color: "var(--c1)" }, { label: "p99", color: "var(--c4)" }]} />
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Each backend usually answers in about 10 ms. 1% of its answers are slow (about 150 ms).</p>
    </Demo>
  );
}

// ---------------- 5. hedging ----------------

export function HedgingDemo() {
  const [after, setAfter] = useState(30);
  const [on, setOn] = useState(true);
  const base = useMemo(() => S.hedged(null), []);
  const h = useMemo(() => S.hedged(on ? after : null), [after, on]);
  const curve = useMemo(() => [12, 15, 20, 30, 50, 80, 120].map((a) => { const x = S.hedged(a, 20000); return [a, x.p999, x.extraLoad * 100] as const; }), []);
  return (
    <Demo
      title="Hedged requests: send a second copy if the first is slow"
      controls={
        <>
          <Param spec={toggle({ label: "Use hedged requests", default: true })} value={on} onChange={(v) => setOn(v as boolean)} />
          <Param spec={range({ label: "Send the copy after", min: 12, max: 120, step: 1, default: 30, format: (v) => `${v} ms` })} value={after} onChange={(v) => setAfter(v as number)} />
        </>
      }
    >
      <Stats items={[{ label: "p99", value: `${h.p99.toFixed(0)} ms` }, { label: "p99.9", value: `${h.p999.toFixed(0)} ms` }, { label: "p99.9 without hedging", value: `${base.p999.toFixed(0)} ms` }, { label: "extra requests sent", value: pct(h.extraLoad, 1) }]} />
      <div className="muted" style={{ fontSize: 12.5, margin: "12px 0 4px" }}>p99.9 latency (blue) and extra load (orange) vs when the copy is sent</div>
      <Plot x={[12, 120]} y={[0, 120]} height={190} xLabel="send the copy after (ms)">
        <Line points={curve.map((p) => [p[0], p[1]])} color="var(--c1)" width={2} />
        <Dots points={curve.map((p) => [p[0], p[1]])} color="var(--c1)" r={2.5} />
        <Line points={curve.map((p) => [p[0], p[2] * 10])} color="var(--c2)" width={2} />
        <RuleX at={after} />
        <RuleY at={10} label="1% extra load" color="var(--c2)" />
      </Plot>
    </Demo>
  );
}

// ---------------- 6. batching ----------------

const batchSchema = {
  fixed: select({ label: "Fixed cost per batch", options: [{ value: "0.1", label: "0.1 ms" }, { value: "1", label: "1 ms" }, { value: "5", label: "5 ms" }], default: "1", segmented: true }),
  rate: select({ label: "Arrivals per ms", options: ["0.5", "2", "8"].map((v) => ({ value: v, label: v })), default: "2", segmented: true }),
  batch: range({ label: "Batch size", min: 1, max: 256, default: 8, log: true, format: (v) => String(Math.round(v)) }),
};

export function BatchingDemo() {
  const params = useParams("bat", batchSchema);
  const fixed = Number(params.values.fixed), rate = Number(params.values.rate), batch = Math.round(params.values.batch);
  const BS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  const cur = S.batching(batch, fixed, 0.05, rate);
  const over = cur.capacity < rate;
  return (
    <Demo title="Each batch has a fixed cost, plus 0.05 ms per item" controls={<Controls params={params} />}>
      <Stats items={[{ label: "capacity (items per ms)", value: cur.capacity.toFixed(1) }, { label: "arrivals per ms", value: rate }, { label: "latency per item", value: over ? "grows without limit" : `${cur.latency.toFixed(1)} ms` }]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 10 }}>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Capacity vs batch size</div>
          <Plot x={[1, 256]} y={[0, 21]} logX height={170} xTicks={[1, 4, 16, 64, 256]} xFormat={String}>
            <Line points={BS.map((b) => [b, S.batching(b, fixed, 0.05, rate).capacity])} width={1.75} />
            <RuleY at={rate} label="arrivals" color="var(--c4)" />
            <RuleX at={batch} />
          </Plot>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Latency vs batch size (where capacity is enough)</div>
          <Plot x={[1, 256]} y={[0, 80]} logX height={170} xTicks={[1, 4, 16, 64, 256]} xFormat={String} yLabel="ms">
            <Line points={BS.filter((b) => S.batching(b, fixed, 0.05, rate).capacity >= rate).map((b) => [b, Math.min(80, S.batching(b, fixed, 0.05, rate).latency)])} color="var(--c2)" width={1.75} />
            <RuleX at={batch} />
          </Plot>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Small batches waste time on the fixed cost. Large batches make items wait for the batch to fill.</p>
    </Demo>
  );
}

// ---------------- 7. closed loop ----------------

export function ClosedLoopDemo() {
  const [users, setUsers] = useState(8);
  const D = 10, Z = 100;
  const US = Array.from({ length: 30 }, (_, i) => i + 1);
  const cur = S.closedLoop(users, D, Z);
  return (
    <Demo title="A load test: each user sends a request, waits for it, then thinks for 100 ms" controls={<Param spec={range({ label: "Users", min: 1, max: 30, step: 1, default: 8 })} value={users} onChange={(v) => setUsers(v as number)} />}>
      <Stats items={[{ label: "throughput (requests/s)", value: (cur.throughput * 1000).toFixed(0) }, { label: "response time", value: `${cur.response} ms` }, { label: "knee: (D + Z) / D", value: `${cur.knee} users` }]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, marginTop: 10 }}>
        <Plot x={[1, 30]} y={[0, 110]} height={170} xLabel="users" yLabel="requests/s">
          <Line points={US.map((u) => [u, S.closedLoop(u, D, Z).throughput * 1000])} width={1.75} />
          <RuleX at={users} />
        </Plot>
        <Plot x={[1, 30]} y={[0, 220]} height={170} xLabel="users" yLabel="response (ms)">
          <Line points={US.map((u) => [u, S.closedLoop(u, D, Z).response])} color="var(--c4)" width={1.75} />
          <RuleX at={users} />
        </Plot>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>The server needs D = 10 ms per request. Before the knee, more users give more throughput. After it, more users only give more waiting.</p>
    </Demo>
  );
}

// ---------------- 8. buffer size ----------------

export function BufferSizeDemo() {
  const [log2, setLog2] = useState(2);
  const buf = 2 ** log2;
  const cur = S.bufferedRead(buf);
  const pts = Array.from({ length: 21 }, (_, i) => [2 ** i, S.bufferedRead(2 ** i).gbps] as [number, number]);
  return (
    <Demo title="Read 64 MiB with read() calls of a fixed size" controls={<Param spec={range({ label: "Bytes per read() call", min: 0, max: 20, step: 1, default: 2, format: (v) => (2 ** v >= 1024 ? `${2 ** v / 1024} KiB` : `${2 ** v} B`) })} value={log2} onChange={(v) => setLog2(v as number)} />}>
      <Stats items={[{ label: "system calls", value: cur.calls.toLocaleString() }, { label: "throughput", value: `${cur.gbps.toFixed(cur.gbps < 1 ? 3 : 1)} GB/s` }, { label: "time in system calls", value: pct((cur.calls * S.SYSCALL_NS) / (cur.nsPerByte * (64 << 20)), 0) }]} />
      <div style={{ height: 8 }} />
      <Plot x={[1, 2 ** 20]} y={[0, 10.5]} logX height={200} xTicks={[1, 64, 4096, 262144]} xFormat={(t) => (t >= 1024 ? `${t / 1024} KiB` : `${t} B`)} xLabel="bytes per call" yLabel="GB/s">
        <Line points={pts} width={2} />
        <RuleX at={buf} />
      </Plot>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Model: each system call costs {S.SYSCALL_NS} ns; copying runs at 10 GB/s.</p>
    </Demo>
  );
}

// ---------------- 9. queue depth ----------------

export function QueueDepthDemo() {
  const [qd, setQd] = useState(1);
  const QD = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  const colors = ["var(--c4)", "var(--c2)", "var(--c1)"];
  return (
    <Demo title="Random 4 KiB reads: operations per second vs requests in flight" controls={<Param spec={range({ label: "Queue depth (requests in flight)", min: 1, max: 256, default: 1, log: true, format: (v) => String(Math.round(v)) })} value={qd} onChange={(v) => setQd(Math.round(v as number))} />}>
      <Stats items={S.DEVICES.map((d) => { const x = S.deviceIops(d, qd); return { label: `${d.label}: IOPS · latency`, value: <span>{Math.round(x.iops).toLocaleString()} <span className="muted" style={{ fontSize: 13 }}>· {x.latencyUs >= 1000 ? `${(x.latencyUs / 1000).toFixed(0)} ms` : `${Math.round(x.latencyUs)} µs`}</span></span> }; })} />
      <div style={{ height: 8 }} />
      <Plot x={[1, 256]} y={[100, 1e6]} logX logY height={220} xTicks={QD} xFormat={String} yTicks={[100, 1000, 10000, 100000, 1000000]} yFormat={(t) => (t >= 1e6 ? "1M" : t >= 1000 ? `${t / 1000}k` : String(t))} xLabel="queue depth" yLabel="IOPS">
        {S.DEVICES.map((d, i) => <Line key={d.id} points={QD.map((q) => [q, S.deviceIops(d, q).iops])} color={colors[i]} width={1.75} />)}
        <RuleX at={qd} />
      </Plot>
      <Legend items={S.DEVICES.map((d, i) => ({ label: d.label, color: colors[i]! }))} />
    </Demo>
  );
}

// ---------------- 10. I/O models ----------------

export function IoModelsDemo() {
  const max = Math.max(...S.IO_MODELS.map((m) => S.ioCostPerOp(m)));
  return (
    <Demo title="CPU time per request, by I/O model">
      <div style={{ display: "grid", gap: 12 }}>
        {S.IO_MODELS.map((m) => {
          const ns = S.ioCostPerOp(m);
          return (
            <div key={m.id} style={{ fontSize: 13 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <b>{m.label}</b>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{(ns / 1000).toFixed(2)} µs · {Math.round(1e9 / ns).toLocaleString()} requests/s per core</span>
              </div>
              <div style={{ height: 10, background: "var(--subtle)", borderRadius: 2, margin: "4px 0" }}><div style={{ height: "100%", width: `${(100 * ns) / max}%`, background: "var(--c1)", borderRadius: 2 }} /></div>
              <div className="muted" style={{ fontSize: 12 }}>{m.note}</div>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Model: system call {S.SYSCALL_NS} ns, context switch {S.CONTEXT_SWITCH_NS / 1000} µs, plus 0.5 µs of real work per request.</p>
    </Demo>
  );
}
