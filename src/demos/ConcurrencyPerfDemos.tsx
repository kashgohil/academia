import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Controls, Param, Plot, Line, Dots, Legend, RuleY, useParams, select, range, toggle, useSim, useWidth } from "../kit";
import { falseSharing, simulateLock, LOCK_DEFAULTS, LOCK_LABEL, type LockKind, type Span } from "../sims/perf/contention";

const TC = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

// ---------------- 1. ping-pong animation ----------------

export function PingPongDemo() {
  const [padded, setPadded] = useState(false);
  const [cores, setCores] = useState(4);
  const step = useRef(0);
  const [, force] = useState(0);
  const counts = useRef<number[]>([0, 0, 0, 0]);
  const owner = useRef(0);
  const transfers = useRef(0);
  const time = useRef(0);
  const sim = useSim({
    dt: 1 / 6,
    autoplay: true,
    step: () => {
      const c = step.current % cores;
      step.current++;
      counts.current[c]!++;
      if (!padded && owner.current !== c) { transfers.current++; time.current += 40; owner.current = c; }
      else time.current += padded ? 1 / cores : 1; // padded cores work in parallel
      force((x) => x + 1);
    },
    reset: () => { step.current = 0; counts.current = [0, 0, 0, 0]; transfers.current = 0; time.current = 0; owner.current = 0; },
  });
  const R = 92, cx = 170, cy = 120;
  const pos = (i: number) => [cx + R * Math.cos((i / cores) * 2 * Math.PI - Math.PI / 2), cy + R * Math.sin((i / cores) * 2 * Math.PI - Math.PI / 2)] as const;
  const [ox, oy] = pos(owner.current);
  return (
    <Demo
      title="Who owns the cache line?"
      actions={<><button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button><button className="btn ghost" onClick={sim.reset}>Reset</button></>}
      controls={
        <>
          <Param spec={toggle({ label: "Put each counter on its own cache line", default: false })} value={padded} onChange={(v) => { setPadded(v as boolean); sim.reset(); }} />
          <Param spec={select({ label: "Cores", options: ["2", "3", "4"].map((v) => ({ value: v, label: v })), default: "4", segmented: true })} value={String(cores)} onChange={(v) => { setCores(Number(v)); sim.reset(); }} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 340px) 1fr", gap: 16, alignItems: "center" }}>
        <svg viewBox="0 0 340 262" style={{ width: "100%", maxWidth: 340 }}>
          {Array.from({ length: cores }, (_, i) => {
            const [x, y] = pos(i);
            return (
              <g key={i}>
                <rect x={x - 34} y={y - 22} width={68} height={44} rx={8} fill="var(--bg)" stroke={TC[i]} strokeWidth={2} />
                <text x={x} y={y - 4} textAnchor="middle" fontSize={12} fontWeight={600} fill={TC[i]}>core {i}</text>
                <text x={x} y={y + 12} textAnchor="middle" fontSize={11} fill="var(--muted)">count {counts.current[i]}</text>
                {padded && <rect x={x - 26} y={y + 26} width={52} height={10} rx={3} fill={TC[i]} opacity={0.8} />}
              </g>
            );
          })}
          {!padded && (
            <g style={{ transform: `translate(${(ox + cx) / 2 - 40}px, ${(oy + cy) / 2 - 10}px)`, transition: "transform 0.14s ease-out" }}>
              <rect width={80} height={20} rx={4} fill="var(--fg)" />
              {Array.from({ length: cores }, (_, i) => <rect key={i} x={4 + i * (72 / cores)} y={4} width={72 / cores - 2} height={12} rx={2} fill={TC[i]} />)}
            </g>
          )}
          <text x={cx} y={256} textAnchor="middle" fontSize={11} fill="var(--muted)">{padded ? "each core keeps its own line: no transfers" : "one 64-byte line holds every counter"}</text>
        </svg>
        <Stats
          items={[
            { label: "increments", value: step.current },
            { label: "line transfers", value: transfers.current },
            { label: "time per increment", value: step.current ? `${(time.current / step.current).toFixed(1)} ns` : "–" },
          ]}
        />
      </div>
    </Demo>
  );
}

// ---------------- 2. scaling ----------------

export function FalseSharingScalingDemo() {
  const data = useMemo(() => [1, 2, 3, 4, 5, 6, 7, 8].map((t) => ({ t, packed: falseSharing(t, false).opsPerUs, padded: falseSharing(t, true).opsPerUs })), []);
  const [t, setT] = useState(8);
  const cur = data[t - 1]!;
  return (
    <Demo title="Throughput as you add threads" controls={<Param spec={range({ label: "Threads", min: 1, max: 8, step: 1, default: 8 })} value={t} onChange={(v) => setT(v as number)} />}>
      <Stats items={[{ label: "packed: million increments/s", value: Math.round(cur.packed) }, { label: "padded: million increments/s", value: Math.round(cur.padded) }, { label: "padded is faster by", value: `${(cur.padded / cur.packed).toFixed(0)}×` }]} />
      <div style={{ height: 8 }} />
      <Plot x={[1, 8]} y={[0, 3000]} height={210} xLabel="threads" yLabel="million increments/s">
        <Line points={data.map((d) => [d.t, d.padded])} color="var(--c3)" width={2} />
        <Dots points={data.map((d) => [d.t, d.padded])} color="var(--c3)" r={3} />
        <Line points={data.map((d) => [d.t, d.packed])} color="var(--c4)" width={2} />
        <Dots points={data.map((d) => [d.t, d.packed])} color="var(--c4)" r={3} />
      </Plot>
      <Legend items={[{ label: "counters on separate cache lines", color: "var(--c3)" }, { label: "counters in one cache line", color: "var(--c4)" }]} />
    </Demo>
  );
}

// ---------------- 3. struct layout ----------------

interface Field { name: string; size: number; writer: number | null }
const LAYOUTS: Record<string, { label: string; fields: Field[] }> = {
  counters: { label: "Array of per-thread counters", fields: [0, 1, 2, 3].map((t) => ({ name: `count[${t}]`, size: 8, writer: t })) },
  queue: {
    label: "Single-producer, single-consumer queue",
    fields: [
      { name: "head", size: 8, writer: 1 },
      { name: "tail", size: 8, writer: 0 },
      { name: "capacity", size: 8, writer: null },
      { name: "buffer ptr", size: 8, writer: null },
    ],
  },
  stats: {
    label: "Server stats struct",
    fields: [
      { name: "requests", size: 8, writer: 0 },
      { name: "errors", size: 8, writer: 1 },
      { name: "config", size: 32, writer: null },
      { name: "bytes_in", size: 8, writer: 2 },
      { name: "bytes_out", size: 8, writer: 3 },
    ],
  },
};

export function StructLayoutDemo() {
  const [which, setWhich] = useState("queue");
  const [pad, setPad] = useState(false);
  const [ref, w] = useWidth<HTMLDivElement>();
  const fields = LAYOUTS[which]!.fields;
  // Place fields; with padding, each written field starts on its own 64-byte line.
  let off = 0;
  const placed = fields.map((f) => {
    if (pad && f.writer !== null && off % 64 !== 0) off = Math.ceil(off / 64) * 64;
    const p = { ...f, off };
    off += f.size;
    if (pad && f.writer !== null) off = Math.ceil(off / 64) * 64;
    return p;
  });
  const total = Math.max(64, Math.ceil(off / 64) * 64);
  const lines = total / 64;
  const writersOf = (l: number) => new Set(placed.filter((f) => f.writer !== null && Math.floor(f.off / 64) === l).map((f) => f.writer));
  const bad = Array.from({ length: lines }, (_, l) => writersOf(l).size > 1);
  const px = (w - 70) / 64;
  return (
    <Demo
      title="Which fields share a cache line?"
      controls={
        <>
          <Param spec={select({ label: "Struct", options: Object.entries(LAYOUTS).map(([k, v]) => ({ value: k, label: v.label })), default: "queue" })} value={which} onChange={(v) => setWhich(v as string)} />
          <Param spec={toggle({ label: "Align written fields to 64 bytes", default: false })} value={pad} onChange={(v) => setPad(v as boolean)} />
        </>
      }
    >
      <div ref={ref}>
        <svg width={w} height={lines * 46 + 10} style={{ display: "block" }}>
          {Array.from({ length: lines }, (_, l) => (
            <g key={l} transform={`translate(0, ${l * 46})`}>
              <text x={0} y={22} fontSize={11} fill={bad[l] ? "var(--c4)" : "var(--muted)"}>line {l}</text>
              <rect x={60} y={6} width={64 * px} height={28} rx={4} fill="none" stroke={bad[l] ? "var(--c4)" : "var(--border)"} strokeWidth={bad[l] ? 2 : 1} />
              {placed.filter((f) => Math.floor(f.off / 64) === l).map((f) => (
                <g key={f.name}>
                  <rect x={60 + (f.off % 64) * px + 1} y={9} width={f.size * px - 2} height={22} rx={3} fill={f.writer === null ? "var(--subtle)" : TC[f.writer]} opacity={f.writer === null ? 1 : 0.85} />
                  {f.size * px > 40 && <text x={60 + (f.off % 64) * px + 5} y={24} fontSize={10.5} fill={f.writer === null ? "var(--muted)" : "#fff"}>{f.name}</text>}
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <Legend box items={[...[0, 1, 2, 3].filter((t) => fields.some((f) => f.writer === t)).map((t) => ({ label: `written by thread ${t}`, color: TC[t]! })), { label: "read only", color: "var(--border)" }]} />
      <p style={{ fontSize: 13, marginBottom: 0, color: bad.some(Boolean) ? "var(--c4)" : "var(--c3)" }}>
        {bad.some(Boolean) ? `False sharing: ${bad.filter(Boolean).length} line(s) are written by more than one thread.` : `No false sharing. Size: ${total} bytes.`}
      </p>
    </Demo>
  );
}

// ---------------- 4. lock scaling ----------------

const lockSchema = {
  critical: select({ label: "Time inside the lock (ns)", options: [20, 50, 200, 1000].map((v) => ({ value: String(v), label: String(v) })), default: "50", segmented: true }),
  work: select({ label: "Time outside the lock (ns)", options: [100, 200, 1000].map((v) => ({ value: String(v), label: String(v) })), default: "200", segmented: true }),
};
const LOCKS: { k: LockKind; color: string }[] = [
  { k: "tas", color: "var(--c4)" },
  { k: "ttas", color: "var(--c2)" },
  { k: "mutex", color: "var(--c5)" },
  { k: "atomic", color: "var(--c1)" },
  { k: "sharded", color: "var(--c3)" },
];

export function LockScalingDemo() {
  const params = useParams("lk", lockSchema);
  const critical = Number(params.values.critical), work = Number(params.values.work);
  const data = useMemo(() => LOCKS.map((l) => ({ ...l, pts: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, simulateLock({ ...LOCK_DEFAULTS, kind: l.k, threads: n, critical, work })] as [number, number]) })), [critical, work]);
  const ymax = Math.max(...data.flatMap((d) => d.pts.map((p) => p[1]))) * 1.1;
  return (
    <Demo title="Updates per microsecond, by synchronization method" controls={<Controls params={params} />}>
      <Plot x={[1, 8]} y={[0, ymax]} height={240} xLabel="threads (one per core)" yLabel="updates / µs">
        <RuleY at={1000 / (critical + 40)} label="limit of any lock: 1 / (inside time + handoff)" />
        {data.map((d) => <g key={d.k}><Line points={d.pts} color={d.color} width={1.75} /><Dots points={d.pts} color={d.color} r={2.5} /></g>)}
      </Plot>
      <Legend items={data.map((d) => ({ label: LOCK_LABEL[d.k], color: d.color }))} />
    </Demo>
  );
}

// ---------------- 5. Amdahl ----------------

export function AmdahlDemo() {
  const [serial, setSerial] = useState(0.05);
  const [gus, setGus] = useState(false);
  const N = [1, 2, 4, 8, 16, 32, 64, 128];
  const amdahl = (n: number) => 1 / (serial + (1 - serial) / n);
  const gustafson = (n: number) => n - serial * (n - 1);
  return (
    <Demo
      title={gus ? "Gustafson: the problem grows with the machine" : "Amdahl: the same problem on more cores"}
      controls={
        <>
          <Param spec={range({ label: "Serial part of the work", min: 0, max: 0.5, step: 0.01, default: 0.05, format: (v) => `${Math.round(v * 100)}%` })} value={serial} onChange={(v) => setSerial(v as number)} />
          <Param spec={toggle({ label: "Grow the problem with the core count", default: false })} value={gus} onChange={(v) => setGus(v as boolean)} />
        </>
      }
    >
      <Stats items={[{ label: "speedup on 8 cores", value: `${(gus ? gustafson(8) : amdahl(8)).toFixed(1)}×` }, { label: "speedup on 64 cores", value: `${(gus ? gustafson(64) : amdahl(64)).toFixed(1)}×` }, { label: gus ? "no upper limit" : "upper limit", value: gus ? "–" : serial > 0 ? `${(1 / serial).toFixed(0)}×` : "∞" }]} />
      <div style={{ height: 8 }} />
      <Plot x={[1, 128]} y={[0, gus ? 130 : Math.min(130, (serial > 0 ? 1 / serial : 128) * 1.15)]} logX height={220} xTicks={N} xFormat={String} xLabel="cores" yLabel="speedup">
        <Line points={N.map((n) => [n, n])} color="var(--faint)" dash="4 3" />
        <Line points={N.map((n) => [n, gus ? gustafson(n) : amdahl(n)])} width={2} />
        <Dots points={N.map((n) => [n, gus ? gustafson(n) : amdahl(n)])} r={3} />
        {!gus && serial > 0 && <RuleY at={1 / serial} label="1 / serial part" />}
      </Plot>
      <Legend items={[{ label: "perfect scaling", color: "var(--faint)" }, { label: "actual", color: "var(--c1)" }]} />
    </Demo>
  );
}

// ---------------- 6. timeline ----------------

function lockFreeTrace(threads: number, ops: number, preemptAt: number | null, quantum: number): Span[] {
  const out: Span[] = [];
  for (let t = 0; t < threads; t++) {
    let now = t * 15;
    for (let i = 0; i < ops; i++) {
      out.push({ thread: t, from: now, to: now + 200, kind: "work" });
      now += 200;
      if (preemptAt !== null && t === 0 && i === 2) {
        out.push({ thread: t, from: now, to: now + quantum, kind: "preempted" });
        now += quantum;
      }
      out.push({ thread: t, from: now, to: now + 60, kind: "hold" });
      now += 60;
    }
  }
  return out;
}

const SPAN_COLOR = { work: "var(--border)", wait: "var(--c4)", hold: "var(--c1)", preempted: "var(--c2)" } as const;

function Timeline({ spans, threads, until }: { spans: Span[]; threads: number; until: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const px = (w - 50) / until;
  return (
    <div ref={ref}>
      <svg width={w} height={threads * 22 + 18} style={{ display: "block" }}>
        {Array.from({ length: threads }, (_, t) => <text key={t} x={0} y={t * 22 + 15} fontSize={11} fill="var(--muted)">T{t}</text>)}
        {spans.filter((s) => s.from < until).map((s, i) => (
          <rect key={i} x={50 + s.from * px} y={s.thread * 22 + 3} width={Math.max(0.5, (Math.min(s.to, until) - s.from) * px)} height={16} rx={2} fill={SPAN_COLOR[s.kind]} />
        ))}
        <text x={w} y={threads * 22 + 14} fontSize={10} textAnchor="end" fill="var(--muted)">{(until / 1000).toFixed(0)} µs</text>
      </svg>
    </div>
  );
}

export function PreemptTimelineDemo() {
  const [preempt, setPreempt] = useState(true);
  const quantum = 8_000;
  const lockSpans = useMemo(() => {
    const tr: Span[] = [];
    simulateLock({ ...LOCK_DEFAULTS, kind: "mutex", threads: 4, opsPerThread: 60, critical: 60, work: 200, quantum, forcePreemptAt: preempt ? 10 : undefined }, 1, tr);
    return tr;
  }, [preempt]);
  const lfSpans = useMemo(() => lockFreeTrace(4, 60, preempt ? 2 : null, quantum), [preempt]);
  const until = 16_000;
  return (
    <Demo title="One thread is paused by the OS" controls={<Param spec={toggle({ label: "Pause thread holding operation 10 for 8 µs", default: true })} value={preempt} onChange={(v) => setPreempt(v as boolean)} />}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>With a mutex: the paused thread holds the lock</div>
      <Timeline spans={lockSpans} threads={4} until={until} />
      <div className="muted" style={{ fontSize: 12.5, margin: "12px 0 4px" }}>Lock-free: the paused thread holds nothing</div>
      <Timeline spans={lfSpans} threads={4} until={until} />
      <div style={{ marginTop: 8 }}>
        <Legend box items={[{ label: "own work", color: "var(--border)" }, { label: "shared update", color: "var(--c1)" }, { label: "waiting", color: "var(--c4)" }, { label: "paused by the OS", color: "var(--c2)" }]} />
      </div>
    </Demo>
  );
}

// ---------------- 7. preemption throughput ----------------

export function PreemptionDemo() {
  const [p, setP] = useState(0.005);
  const kinds: { k: LockKind; color: string }[] = [
    { k: "mutex", color: "var(--c5)" },
    { k: "ttas", color: "var(--c2)" },
    { k: "lockfree-queue", color: "var(--c3)" },
  ];
  const ps = [0, 0.001, 0.002, 0.005, 0.01, 0.02];
  const curves = useMemo(() => kinds.map((x) => ({ ...x, pts: ps.map((q) => [q * 100, simulateLock({ ...LOCK_DEFAULTS, kind: x.k, threads: 8, preempt: q })] as [number, number]) })), []); // eslint-disable-line react-hooks/exhaustive-deps
  const now = kinds.map((x) => ({ ...x, v: simulateLock({ ...LOCK_DEFAULTS, kind: x.k, threads: 8, preempt: p }) }));
  return (
    <Demo title="8 threads; the OS sometimes pauses one for 50 µs" controls={<Param spec={range({ label: "Chance that an operation's thread is paused", min: 0, max: 0.02, step: 0.001, default: 0.005, format: (v) => `${(v * 100).toFixed(1)}%` })} value={p} onChange={(v) => setP(v as number)} />}>
      <Stats items={now.map((x) => ({ label: `${LOCK_LABEL[x.k]}: updates/µs`, value: x.v.toFixed(1) }))} />
      <div style={{ height: 8 }} />
      <Plot x={[0, 2]} y={[0, 14]} height={200} xLabel="chance of a pause (%)" yLabel="updates / µs">
        {curves.map((c) => <g key={c.k}><Line points={c.pts} color={c.color} width={1.75} /><Dots points={c.pts} color={c.color} r={2.5} /></g>)}
      </Plot>
      <Legend items={kinds.map((x) => ({ label: LOCK_LABEL[x.k], color: x.color }))} />
    </Demo>
  );
}
