/** Demos for "secondary-indexes-across-partitions": a query router, the stale read of an async index, and scatter/gather tails. */
import { useMemo } from "react";
import { Demo, Dots, Legend, Line, Param, Plot, RuleX, Stats, range, seg, toggle, useParams, Banner, Chip, ms, pct, tint, useChunked } from "../../kit";
import {
  COLORS, SERVICE_DEFAULTS, basePartition, gatherQuantile, indexRace, makeCars, pAnySlow, quantile, route, scatterGather, termPartition,
  type Design, type IndexMode, type Op,
} from "../../sims/dist/partitioning";
import { SpaceTime, fromTrace } from "./SpaceTime";

const CARS = makeCars(48);

const ROUTER = {
  parts: range({ label: "Partitions", min: 2, max: 12, step: 1, default: 6 }),
  design: seg<Design>("Index", [["local", "local (by document)"], ["global", "global (by term)"]], "local"),
  op: seg<"query" | "insert" | "update">("Operation", [["query", "find red cars"], ["insert", "insert a red car"], ["update", "repaint car 7 blue"]], "query"),
  covering: toggle({ label: "Global index stores the row (covering)", default: false }),
};

const ROLE_COLOR = { "index read": "var(--c1)", "row read": "var(--c3)", "row write": "var(--c4)", "index write": "var(--c2)" } as const;

export function PartitioningRouterDemo() {
  const P = useParams("dist-part-router", ROUTER);
  const { parts, design, op: opKind, covering } = P.values;
  const op: Op = opKind === "query" ? { kind: "query", color: "red" } : opKind === "insert" ? { kind: "insert", color: "red" } : { kind: "update", id: 7, to: "blue" };
  const r = route(design, op, CARS, parts, covering);
  const byPart = Array.from({ length: parts }, (_, p) => ({
    cars: CARS.filter((c) => basePartition(c.id, parts) === p),
    terms: design === "global" ? COLORS.filter((c) => termPartition(c, parts) === p) : [],
    roles: [...new Set(r.touches.filter((t) => t.partition === p).map((t) => t.role))],
  }));
  return (
    <Demo title="Which partitions does it touch?" controls={<>
      <Param spec={ROUTER.parts} value={parts} onChange={(v) => P.set("parts", v as number)} />
      <Param spec={ROUTER.design} value={design} onChange={(v) => P.set("design", v as Design)} />
      <Param spec={ROUTER.op} value={opKind} onChange={(v) => P.set("op", v as typeof opKind)} />
      <Param spec={ROUTER.covering} value={covering} onChange={(v) => P.set("covering", v as boolean)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{CARS.length} cars, partitioned by a hash of the car id. {design === "local" ? "Each partition indexes the colors of its own cars." : "The color index is partitioned by a hash of the color: one partition holds all the entries for one color."}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
        {byPart.map((b, p) => (
          <div key={p} style={{ border: `1.5px solid ${b.roles.length ? "var(--fg)" : "var(--border)"}`, borderRadius: 6, padding: "5px 7px", background: b.roles.length ? tint(ROLE_COLOR[b.roles[0]!], 14) : undefined, opacity: b.roles.length ? 1 : 0.6, transition: "background 0.2s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}><b>p{p}</b><span className="muted">{b.cars.length} cars</span></div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 2, margin: "4px 0" }}>
              {b.cars.map((c) => <span key={c.id} title={`car ${c.id}: ${c.color}`} style={{ width: 9, height: 9, borderRadius: 2, background: c.color === "red" ? "var(--c4)" : c.color === "blue" ? "var(--c1)" : "var(--faint)", outline: c.id === 7 && opKind === "update" ? "1.5px solid var(--fg)" : undefined }} />)}
            </div>
            <div style={{ fontSize: 10.5, minHeight: 14 }} className="muted">
              index: {design === "local" ? "own cars" : b.terms.length ? b.terms.join(", ") : "none"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3, minHeight: 19 }}>
              {b.roles.map((role) => <Chip key={role} color={ROLE_COLOR[role]}>{role}</Chip>)}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "partitions read", value: r.readFanOut },
          { label: "partitions written", value: r.writeFanOut },
          ...(opKind === "query" ? [{ label: "red cars found", value: r.matches.length }] : []),
        ]} />
      </div>
      <Banner tone={r.readFanOut + r.writeFanOut > 2 ? "warn" : "good"}>
        {opKind === "query" && design === "local" && `No partition knows where the other red cars are, so the router asks all ${parts} and merges the answers.`}
        {opKind === "query" && design === "global" && (covering ? "One index partition holds every red car, with its columns. One read answers the query." : `One index partition lists the red cars. Then the router fetches them from ${r.readFanOut - 1} row partitions.`)}
        {opKind === "insert" && (design === "local" ? "The row and its index entry live in one partition: one local write." : r.writeFanOut === 1 ? "By chance, the row and the index entry for red live in the same partition." : "The row goes to its partition; the index entry goes to the partition for red. Two partitions must change together.")}
        {opKind === "update" && (design === "local" ? "The old and new index entries are in the car's own partition." : `The row, the entry under ${CARS[7]!.color} and the entry under blue can be in ${r.writeFanOut} partitions. Keeping them in step needs a distributed transaction, or the index lags.`)}
      </Banner>
    </Demo>
  );
}

const RACE = {
  readAt: range({ label: "Client reads the index at", min: 0, max: 90, step: 1, default: 30, format: (v) => `${v} ms` }),
  mode: seg<IndexMode>("Index update", [["async", "asynchronous"], ["sync", "in the write path"]], "async"),
  lag: range({ label: "Index queue delay", min: 0, max: 60, step: 5, default: 40, format: (v) => `${v} ms` }),
};

export function PartitioningStaleIndexDemo() {
  const P = useParams("dist-part-race", RACE);
  const { readAt, mode, lag } = P.values;
  const r = useMemo(() => indexRace(mode, readAt, lag), [mode, readAt, lag]);
  const st = fromTrace(r.net, (m) => (m.payload.k === "result" ? (m.payload.ids.includes(7) ? "car 7" : "none") : m.payload.k === "index-put" ? "entry" : m.payload.k === "index-ok" ? "ok" : m.payload.k === "query" ? "read" : m.payload.k === "write" ? "write" : undefined));
  const tEnd = Math.max(80, r.net.now + 5);
  return (
    <Demo title="Read your write through a global index" controls={<>
      <Param spec={RACE.readAt} value={readAt} onChange={(v) => P.set("readAt", v as number)} />
      <Param spec={RACE.mode} value={mode} onChange={(v) => P.set("mode", v as IndexMode)} />
      <Param spec={RACE.lag} value={lag} onChange={(v) => P.set("lag", v as number)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>At 0 ms the client repaints car 7 red. Then it asks the index for red cars. Every message takes 10 ms; the queue delay is a model input.</div>
      <SpaceTime nodes={["client", "rows", "index"]} tEnd={tEnd} {...st} marks={[...st.marks, ...(Number.isFinite(r.ackAt) ? [{ node: 0, t: r.ackAt, color: "var(--c3)" }] : []), { node: 2, t: r.indexAt, label: "indexed", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "write acknowledged at", value: ms(r.ackAt) },
        { label: "index updated at", value: ms(r.indexAt) },
        { label: "read served at", value: ms(r.readServedAt) },
      ]} />
      <Banner tone={r.stale ? "bad" : r.sawWrite ? "good" : "warn"}>
        {r.stale && "Stale read. The client already had the acknowledgement, but the index entry was still in the queue. The client does not see its own write."}
        {!r.stale && r.sawWrite && "The read came after the index entry, so it sees car 7."}
        {!r.stale && !r.sawWrite && "The read started before the write was acknowledged. The two overlap, so either answer is correct."}
      </Banner>
    </Demo>
  );
}

const PS = [1, 2, 5, 10, 20, 50, 100, 200];

const TAIL = {
  slow: range({ label: "Slow answer chance", min: 0.001, max: 0.1, default: 0.01, log: true, format: (v) => pct(v, 1) }),
  parts: range({ label: "Partitions asked", min: 1, max: 200, default: 100, log: true, format: (v) => String(Math.round(v)) }),
};

export function PartitioningTailDemo() {
  const P = useParams("dist-part-tail", TAIL);
  const q = P.values.slow, n = Math.round(P.values.parts);
  const m = { ...SERVICE_DEFAULTS, slowProb: q };
  const curve = (p: number) => PS.flatMap((x) => [x, x * 1.25, x * 1.6]).filter((x) => x <= 200).map((x) => [x, gatherQuantile(x, p, m)] as [number, number]);
  const jobs = useMemo(() => PS.map((x) => () => scatterGather(x, Math.max(150, Math.round(6000 / x)), { ...SERVICE_DEFAULTS, slowProb: q }, 7)), [q]);
  const res = useChunked(`${q}`, jobs, { keep: true });
  const dots = (p: number) => res.flatMap((r, i) => (r ? [[PS[i]!, quantile(r, p)] as [number, number]] : []));
  return (
    <Demo title="Scatter/gather waits for the slowest partition" controls={<>
      <Param spec={TAIL.slow} value={q} onChange={(v) => P.set("slow", v as number)} />
      <Param spec={TAIL.parts} value={P.values.parts} onChange={(v) => P.set("parts", v as number)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Model inputs: each partition answers in 5 ms on average, or in {SERVICE_DEFAULTS.slowMs} ms when it is slow (a GC pause, a compaction), with the chance below. Lines: closed form. Dots: runs on the simulated network.</div>
      <Plot x={[1, 200]} y={[1, 2000]} logX logY height={240} xLabel="partitions asked" yLabel="query latency (ms)" xTicks={[1, 2, 5, 10, 20, 50, 100, 200]} xFormat={(v) => String(v)} yTicks={[1, 10, 100, 1000]} yFormat={(v) => `${v}`}>
        <Line points={curve(0.5)} color="var(--c1)" />
        <Line points={curve(0.99)} color="var(--c4)" />
        <Dots points={dots(0.5)} color="var(--c1)" />
        <Dots points={dots(0.99)} color="var(--c4)" />
        <RuleX at={n} />
      </Plot>
      <Legend items={[{ label: "median", color: "var(--c1)" }, { label: "99th percentile", color: "var(--c4)" }]} />
      <Stats items={[
        { label: `queries that wait for a slow partition, ${n} asked`, value: pct(pAnySlow(n, q)) },
        { label: "median query", value: ms(gatherQuantile(n, 0.5, m)) },
        { label: "99th percentile query", value: ms(gatherQuantile(n, 0.99, m)) },
        { label: "one partition, median", value: ms(gatherQuantile(1, 0.5, m)) },
      ]} />
    </Demo>
  );
}

