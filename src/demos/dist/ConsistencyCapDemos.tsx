/** Demos for the lesson on CAP and PACELC: the two-node proof as a stepper, and latency against staleness. */
import { useMemo } from "react";
import { BAD, Banner, Demo, Dots, GOOD, Legend, Line, Param, Plot, SmallLabel, StepButtons, StepCaption, StepSlider, fixed, pct, range, seg, useParams, useStepper, useWidth } from "../../kit";
import { CAP_NODES, pbsCurve, quorumLatency, runCap, type CapChoice } from "../../sims/dist/consistency";
import { SpaceTime, type StMark } from "./SpaceTime";

const CAP_SCHEMA = {
  write: seg<CapChoice>("A gets the write", [["answer", "answer at once"], ["wait", "wait for B"]], "answer"),
  read: seg<CapChoice>("B gets the read", [["answer", "answer from B"], ["wait", "wait for A"]], "answer"),
  heal: seg("Partition heals", [["never", "never"], ["120", "at 120 ms"]], "never"),
};

const CAPTIONS = [
  "A and B both hold x = 0. Clients c1 and c2 can reach both replicas.",
  "The link between A and B fails. Every message between them is lost from now on.",
  "c1 writes x = 1 at A. A cannot tell B. It must answer now, or wait for B.",
  "c2 reads x at B. B has not seen the write. It must answer with what it has, or wait for A.",
];

export function CapStepperDemo() {
  const P = useParams("cons-cap", CAP_SCHEMA);
  const [wref, wpx] = useWidth<HTMLDivElement>();
  const wide = wpx >= 560; // the label of the first sync message only where it fits
  const { write, read, heal } = P.values;
  const healAt = heal === "never" ? null : 120;
  const run = useMemo(() => runCap({ write, read, healAt }), [write, read, healAt]);
  const grid = useMemo(() => (["answer", "wait"] as CapChoice[]).map((w) => (["answer", "wait"] as CapChoice[]).map((r) => runCap({ write: w, read: r, healAt }))), [healAt]);
  const s = useStepper(5, 1);
  const cursors = [2, 10, 50, 100, run.cfg.tEnd];
  const cursor = cursors[s.i]!;
  const messages = run.net.messages.map((m) => ({
    from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt,
    // Only the write request and the read answer carry labels; the others would overlap them.
    label: m.payload.k === "w" ? "w 1" : m.payload.k === "ok" && m.payload.v !== undefined ? `x = ${m.payload.v}` : wide && m.payload.k === "sync" && m.sentAt < 30 ? "sync" : undefined,
    color: m.payload.k === "ok" && m.payload.v === 0 && run.history[0]!.ret < m.sentAt ? BAD : m.from >= 2 ? "var(--c1)" : undefined,
  }));
  const end = healAt ?? run.cfg.tEnd;
  const marks: StMark[] = [0, 1].map((n) => ({ node: n, t: run.cfg.partitionAt, until: end, shape: "bar" as const, color: "var(--c4)" }));
  for (const w of run.waits) marks.push({ node: w.node, t: w.from, until: Math.min(w.until, run.cfg.tEnd), shape: "bar", color: "var(--c2)" });
  const w = run.history[0]!, r = run.history[1]!;
  const final = (
    <>
      {Number.isFinite(w.ret) ? `The write returned at ${fixed(w.ret, 0)} ms. ` : "The write never returned. "}
      {Number.isFinite(r.ret) ? `The read returned x = ${r.value} at ${fixed(r.ret, 0)} ms. ` : "The read never returned. "}
      {run.linearizable ? "Consistent: no read saw an old value after a write returned." : "Not consistent: the read returned 0 after the write of 1 had returned."}
      {" "}{run.available ? "Available: every request got an answer during the partition." : "Not available: a live replica left a request without an answer."}
    </>
  );
  return (
    <Demo title="The CAP proof on two replicas" actions={<StepButtons s={s} />} controls={<><StepSlider s={s} />{(["write", "read", "heal"] as const).map((k) => <Param key={k} spec={CAP_SCHEMA[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <div ref={wref}><SpaceTime nodes={CAP_NODES} tEnd={run.cfg.tEnd} messages={messages} marks={marks} cursor={cursor} rowHeight={42} /></div>
      <StepCaption tone={s.i < 4 ? "plain" : run.linearizable && run.available ? "good" : run.linearizable || run.available ? "warn" : "bad"} label={`${s.i + 1}/5`}>
        {s.i < 4 ? CAPTIONS[s.i] : final}
      </StepCaption>
      <SmallLabel style={{ marginTop: 10 }}>All four choices{healAt === null ? ", with a partition that never heals" : ", with a heal at 120 ms"}</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 4, fontSize: 12.5, alignItems: "stretch" }}>
        <span />
        <span className="muted" style={{ textAlign: "center" }}>B answers</span>
        <span className="muted" style={{ textAlign: "center" }}>B waits</span>
        {grid.map((row, i) => (
          <div key={i} style={{ display: "contents" }}>
            <span className="muted" style={{ alignSelf: "center" }}>{i === 0 ? "A answers" : "A waits"}</span>
            {row.map((c, j) => {
              const cur = c.cfg.write === write && c.cfg.read === read;
              return (
                <div key={j} style={{ border: `1px solid ${cur ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: "4px 6px", textAlign: "center", fontWeight: cur ? 600 : 400 }}>
                  <span style={{ color: c.linearizable ? GOOD : BAD }}>{c.linearizable ? "C ✓" : "C ✗"}</span>{"  "}
                  <span style={{ color: c.available ? GOOD : BAD }}>{c.available ? "A ✓" : "A ✗"}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Demo>
  );
}

// ============================================================================ PACELC: else, latency or consistency

const PACELC_SCHEMA = {
  remote: range({ label: "One-way delay to a remote replica (model input)", min: 2, max: 80, step: 1, default: 30, format: (v) => `${v} ms` }),
  n: seg("Replicas N", [["3", "3"], ["5", "5"]], "3"),
  w: range({ label: "Write quorum W", min: 1, max: 5, step: 1, default: 1 }),
};

export function PacelcDemo() {
  const P = useParams("cons-pacelc", PACELC_SCHEMA);
  const n = Number(P.values.n), w = Math.min(n, P.values.w), remote = P.values.remote;
  // The reader sits next to replica 1, the writer next to replica 2.
  const base = [0.25, ...new Array<number>(n - 1).fill(remote)];
  const writeBase = base.map((_, i) => (i === 1 ? 0.25 : remote));
  const rows = useMemo(() => Array.from({ length: n }, (_, k) => {
    const r = k + 1;
    const lat = quorumLatency(n, r, 1, base, 4000, 7);
    const fresh = pbsCurve({ n, r, w, mean: 1, base, writeBase, trials: 4000, seed: 3 }, [0])[0]!;
    return { r, ...lat, stale: 1 - fresh };
  }), [n, w, remote]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxLat = Math.max(...rows.map((x) => x.p99)) * 1.1;
  const strictR = n - w + 1;
  return (
    <Demo title="Else: latency or consistency" controls={<>{(["remote", "n", "w"] as const).map((k) => <Param key={k} spec={k === "w" ? { ...PACELC_SCHEMA.w, max: n } : PACELC_SCHEMA[k]} value={k === "w" ? w : P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}>
      <SmallLabel>No partition. The reader shares a data center with replica 1 and the writer with replica 2; the rest are remote. A read waits for R replicas.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <div>
          <Plot x={[0.8, n + 0.2]} y={[0, maxLat]} height={200} xTicks={rows.map((x) => x.r)} xFormat={(v) => `R=${v}`} yLabel="read latency (ms)">
            <Line points={rows.map((x) => [x.r, x.p50] as const)} color="var(--c1)" />
            <Dots points={rows.map((x) => [x.r, x.p50] as const)} color="var(--c1)" />
            <Line points={rows.map((x) => [x.r, x.p99] as const)} color="var(--c1)" dash="4 3" />
          </Plot>
          <Legend items={[{ label: "median", color: "var(--c1)" }, { label: "99th percentile (dashed)", color: "var(--c1)" }]} />
        </div>
        <div>
          <Plot x={[0.8, n + 0.2]} y={[0, 1]} height={200} xTicks={rows.map((x) => x.r)} xFormat={(v) => `R=${v}`} yLabel="P(stale read right after a write)" yFormat={(v) => pct(v, 0)}>
            <Line points={rows.map((x) => [x.r, x.stale] as const)} color={BAD} />
            <Dots points={rows.map((x) => [x.r, x.stale] as const)} color={BAD} />
          </Plot>
        </div>
      </div>
      <Banner tone="info">
        With W = {w}, a read must wait for R = {strictR} replicas before R + W &gt; N. That read takes {fixed(rows[strictR - 1]!.p50, 1)} ms at the median, against {fixed(rows[0]!.p50, 1)} ms for R = 1, which is stale {pct(rows[0]!.stale, 0)} of the time.
      </Banner>
    </Demo>
  );
}
