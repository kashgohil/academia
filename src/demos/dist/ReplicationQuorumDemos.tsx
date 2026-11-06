/** Demos for "Leaderless and quorums": a quorum playground, the latency of waiting for k of n, and a non-linearizable read. */
import { useMemo, useState } from "react";
import { Demo, Param, Plot, Line, Dots, Legend, Stats, range, seg, toggle, useParams, Banner, Btn, Meter, SectionLabel, useChunked, pct, fixed, int } from "../../kit";
import {
  QUORUM_DEFAULTS, FAILS, runScenario, mergeStats, statsChunk, STATS_CHUNKS, quorumLatency, runLinScenario, SERVICE_DEFAULT,
  type Fail, type QuorumStats, type LatencyStats, type QMsg,
} from "../../sims/dist/replication";
import type { Message } from "../../sims/dist/net";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { downBars } from "./ReplicationUi";

const FAIL_TEXT: Record<Fail, string> = { up: "up", write: "down at write", read: "down at read", both: "down at both" };
const FAIL_COLOR: Record<Fail, string> = { up: "var(--c3)", write: "var(--c2)", read: "var(--c5)", both: "var(--c4)" };

const msgColor = (m: Message<QMsg>) => (m.payload.k === "put" ? (m.payload.op < 0 ? "var(--c2)" : "var(--c1)") : m.payload.k === "putOk" ? "var(--c1)" : "var(--c5)");
const toSt = (ms: Message<QMsg>[], label?: (m: Message<QMsg>) => string | undefined): StMessage[] =>
  ms.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt, color: msgColor(m), dashed: m.payload.k === "putOk" || m.payload.k === "getOk", label: label?.(m) }));

const PLAY = {
  n: range({ label: "N (replicas)", min: 3, max: 7, step: 1, default: 3 }),
  w: range({ label: "W (write acks)", min: 1, max: 7, step: 1, default: 2 }),
  r: range({ label: "R (read answers)", min: 1, max: 7, step: 1, default: 2 }),
  gap: range({ label: "Read starts after the write by", min: 0, max: 80, step: 5, default: 0, format: (v) => `${v} ms` }),
  p: range({ label: "Many runs: chance a replica is down", min: 0, max: 0.5, step: 0.05, default: 0.2, format: (v) => pct(v, 0) }),
  sloppy: toggle({ label: "Sloppy quorum with hinted handoff (2 stand-in nodes)", default: false }),
};


export function ReplicationQuorumPlaygroundDemo() {
  const P = useParams("repl-quorum", PLAY);
  const { n, gap, p, sloppy } = P.values;
  const w = Math.min(P.values.w, n), r = Math.min(P.values.r, n);
  const [fails, setFails] = useState<Fail[]>(["write", "up", "up", "up", "up", "up", "up"]);
  const [seed, setSeed] = useState(1);
  const cfg = useMemo(() => ({ ...QUORUM_DEFAULTS, seed, n, w, r, sloppy, spares: sloppy ? 2 : 0 }), [seed, n, w, r, sloppy]);
  const f = fails.slice(0, n);
  const sc = useMemo(() => runScenario(cfg, f, gap), [cfg, f.join(), gap]); // eslint-disable-line react-hooks/exhaustive-deps
  const jobs = useMemo(() => Array.from({ length: STATS_CHUNKS }, (_, k) => () => statsChunk(cfg, p, gap, k)), [cfg, p, gap]);
  const parts = useChunked<QuorumStats>(`${n}/${w}/${r}/${sloppy}/${p}/${gap}`, jobs, { keep: true });
  const agg = mergeStats(parts.filter((x): x is QuorumStats => !!x));
  const M = n + cfg.spares;
  const names = [...Array.from({ length: n }, (_, i) => `r${i}`), ...Array.from({ length: cfg.spares }, (_, i) => `s${i}`), "client"];
  const lastMsg = Math.max(...sc.sim.net.messages.map((m) => m.deliveredAt ?? m.lostAt ?? m.sentAt));
  const tEnd = Math.max(40, sc.read.end ?? 0, sc.write.end ?? 0, Math.min(lastMsg, sc.readAt + 60)) + 6;
  const marks: StMark[] = [
    ...downBars(sc.sim.net, tEnd),
    { node: M, t: sc.write.start, until: sc.write.end, shape: "bar", color: sc.write.ok ? "var(--c1)" : "var(--c4)", label: sc.write.ok ? "write" : "write fails" },
    { node: M, t: sc.read.start, until: sc.read.end, shape: "bar", color: sc.read.ok && sc.fresh ? "var(--c3)" : "var(--c4)", label: sc.read.ok ? `read: ${sc.read.value}` : "read fails" },
  ];
  const cycle = (i: number) => setFails(fails.map((x, j) => (j === i ? FAILS[(FAILS.indexOf(x) + 1) % FAILS.length]! : x)));
  const overlap = w + r > n;
  return (
    <Demo
      title="A quorum playground"
      actions={<Btn ghost onClick={() => setSeed(seed + 1)}>New latencies</Btn>}
      controls={<>
        <Param spec={PLAY.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={{ ...PLAY.w, max: n }} value={w} onChange={(v) => P.set("w", v as number)} />
        <Param spec={{ ...PLAY.r, max: n }} value={r} onChange={(v) => P.set("r", v as number)} />
        <Param spec={PLAY.gap} value={gap} onChange={(v) => P.set("gap", v as number)} />
        <Param spec={PLAY.p} value={p} onChange={(v) => P.set("p", v as number)} />
        <Param spec={PLAY.sloppy} value={sloppy} onChange={(v) => P.set("sloppy", v as boolean)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Click a replica to choose when it is down</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
        {f.map((x, i) => (
          <button key={i} className="btn" onClick={() => cycle(i)} style={{ boxShadow: `inset 0 -3px 0 ${FAIL_COLOR[x]}`, fontSize: 12 }}>
            r{i}: {FAIL_TEXT[x]}
          </button>
        ))}
      </div>
      <SpaceTime nodes={names} tEnd={tEnd} messages={toSt(sc.sim.net.messages, (m) => (m.payload.k === "put" && m.payload.hint !== undefined ? `hint r${m.payload.hint}` : m.payload.k === "put" && m.payload.op < 0 ? "handoff" : undefined))} marks={marks} rowHeight={M + 1 > 6 ? 30 : 38} />
      <Legend items={[{ label: "write", color: "var(--c1)" }, { label: "read", color: "var(--c5)" }, { label: "handoff", color: "var(--c2)" }, { label: "down", color: "var(--c4)" }]} />
      <Banner ok={sc.fresh === undefined ? null : sc.fresh}>
        {!sc.write.ok
          ? `The write failed: fewer than W = ${w} replicas answered in time. A failed write can still sit on some replicas.`
          : !sc.read.ok
            ? `The read failed: fewer than R = ${r} replicas answered.`
            : sc.fresh
              ? `The read returned the new value. ${overlap ? `W + R = ${w + r} > ${n}, so the read set and the write set share at least one replica.` : "This time the R answers happened to include a replica with the write."}`
              : `The read returned the old value. ${overlap ? "The write landed on stand-in nodes, and the read asked the home replicas: a sloppy quorum does not overlap." : `W + R = ${w + r} ≤ ${n}, so the R answers can all come from replicas without the write.`}`}
      </Banner>
      <SectionLabel>{`${int(agg.runs)} runs, each replica down with chance ${pct(p, 0)} at the write and at the read`}</SectionLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0 14px" }}>
        <Meter label="read sees the write" value={agg.both ? agg.freshRate : 0} max={1} color="var(--c3)" text={agg.both ? pct(agg.freshRate) : "…"} />
        <Meter label="write fails" value={agg.runs ? agg.writeFail : 0} max={1} color="var(--c2)" text={agg.runs ? pct(agg.writeFail) : "…"} />
        <Meter label="read fails" value={agg.runs ? agg.readFail : 0} max={1} color="var(--c5)" text={agg.runs ? pct(agg.readFail) : "…"} />
      </div>
    </Demo>
  );
}

// ============================================================================ latency

const LAT = {
  slowProb: range({ label: "Chance that a replica answers slowly (model input)", min: 0, max: 0.2, step: 0.01, default: SERVICE_DEFAULT.slowProb, format: (v) => pct(v, 0) }),
  n: seg("N", [["3", "3"], ["5", "5"], ["7", "7"]], "3"),
};

export function ReplicationQuorumLatencyDemo() {
  const P = useParams("repl-qlat", LAT);
  const { slowProb } = P.values;
  const n = Number(P.values.n);
  const jobs = useMemo(() => Array.from({ length: n }, (_, i) => () => quorumLatency(n, i + 1, 2000, 1, { ...SERVICE_DEFAULT, slowProb })), [n, slowProb]);
  const res = useChunked<LatencyStats>(`${n}/${slowProb}`, jobs, { keep: true });
  const pts = (key: "p50" | "p99") => res.flatMap((x) => (x ? [[x.k, x[key]] as [number, number]] : []));
  const at = (k: number) => res[k - 1];
  const maj = Math.floor(n / 2) + 1;
  return (
    <Demo
      title="Waiting for k of N answers"
      controls={<>
        <Param spec={LAT.slowProb} value={slowProb} onChange={(v) => P.set("slowProb", v as number)} />
        <Param spec={LAT.n} value={P.values.n} onChange={(v) => P.set("n", v as never)} />
      </>}
    >
      <Plot x={[1, n]} y={[0, Math.max(110, ...pts("p99").map((q) => q[1] * 1.1))]} height={220} xFormat={(v) => `${v}`} xLabel="k: answers the coordinator waits for (W or R)" yLabel="latency (ms)" xTicks={Array.from({ length: n }, (_, i) => i + 1)}>
        <Line points={pts("p50")} color="var(--c1)" />
        <Dots points={pts("p50")} color="var(--c1)" />
        <Line points={pts("p99")} color="var(--c4)" />
        <Dots points={pts("p99")} color="var(--c4)" />
      </Plot>
      <Legend items={[{ label: "median", color: "var(--c1)" }, { label: "p99", color: "var(--c4)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "p99, k = 1", value: at(1) ? `${fixed(at(1)!.p99, 1)} ms` : "…" },
          { label: `p99, k = ${maj} (majority)`, value: at(maj) ? `${fixed(at(maj)!.p99, 1)} ms` : "…" },
          { label: `p99, k = ${n} (all)`, value: at(n) ? `${fixed(at(n)!.p99, 1)} ms` : "…" },
        ]} />
      </div>
      <Banner>
        A replica answers in 0.5 to 3 ms, but sometimes it takes 20 to 100 ms (a pause or a busy disk). The coordinator waits for the k-th fastest answer. With k = N it waits for the slowest replica every time.
      </Banner>
    </Demo>
  );
}

// ============================================================================ not linearizable

const LIN = { blocking: toggle({ label: "Blocking read repair: fix stale replicas before the read returns", default: false }) };

export function ReplicationNotLinearizableDemo() {
  const P = useParams("repl-lin", LIN);
  const { blocking } = P.values;
  const s = useMemo(() => runLinScenario(blocking), [blocking]);
  const tEnd = Math.max(90, s.readB.end ?? 0, s.write.end ?? 0) + 8;
  const marks: StMark[] = [
    { node: 3, t: s.write.start, until: s.write.end, shape: "bar", color: "var(--c1)", label: "write x = 1" },
    { node: 4, t: s.readA.start, until: s.readA.end, shape: "bar", color: "var(--c5)", label: `A: x = ${s.readA.value}` },
    { node: 5, t: s.readB.start, until: s.readB.end, shape: "bar", color: s.violation ? "var(--c4)" : "var(--c5)", label: `B: x = ${s.readB.value}` },
  ];
  return (
    <Demo title="W + R > N, and still a read goes back in time" controls={<Param spec={LIN.blocking} value={blocking} onChange={(v) => P.set("blocking", v as boolean)} />}>
      <SpaceTime
        nodes={["r0", "r1", "r2", "writer", "reader A", "reader B"]}
        tEnd={tEnd}
        rowHeight={40}
        messages={toSt(s.sim.net.messages, (m) => (m.payload.k === "put" && m.from === 4 ? "repair" : undefined))}
        marks={marks}
      />
      <Banner ok={!s.violation}>
        {s.violation
          ? `A finished at ${Math.round(s.readA.end!)} ms with x = 1. B started later, at ${Math.round(s.readB.start)} ms, and got x = 0. Each read had R = 2 of N = 3, but they asked different replicas while the write was still in flight.`
          : `A saw that r1 was stale and wrote x = 1 to it before it returned. B then found x = 1 on r1. Reads that repair before they return give a linearizable register (the ABD algorithm), at the cost of a slower read.`}
      </Banner>
    </Demo>
  );
}
