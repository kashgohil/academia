/** Demos for "sharding": load per shard under range and hash partitioning, and the shards a range scan visits. */
import { useMemo } from "react";
import { Demo, Param, Stats, range, seg, useParams, Banner, SectionLabel, fixed, int, mono, pct, tint } from "../../kit";
import { expectedHashScanShards, maxOverMean, partitioner, rangePartitioner, scanCost, shardLoads, workload, zipfShare, type Scheme, type WorkloadKind } from "../../sims/dist/partitioning";
import { LoadBars, nodeColor } from "./PartitioningUi";

const K = 1_000_000;
const REQUESTS = 20_000;
const BINS = 50;

const LOAD = {
  shards: range({ label: "Shards", min: 2, max: 32, step: 1, default: 8 }),
  scheme: seg<Scheme>("Partitioning", [["range", "key range"], ["hash", "hash of key"]], "range"),
  work: seg<WorkloadKind>("Workload", [["uniform", "uniform keys"], ["sequential", "timestamps"], ["zipf", "Zipf (θ = 0.99)"]], "sequential"),
};

export function PartitioningLoadDemo() {
  const P = useParams("dist-part-load", LOAD);
  const { shards, scheme, work } = P.values;
  const keys = useMemo(() => workload({ kind: work, K, n: REQUESTS, theta: 0.99 }), [work]);
  const p = useMemo(() => partitioner(scheme, K, shards), [scheme, shards]);
  const load = useMemo(() => shardLoads(p, keys), [p, keys]);
  const heat = useMemo(() => {
    const h = new Array<number>(BINS).fill(0);
    for (const k of keys) h[Math.min(BINS - 1, Math.floor((k * BINS) / K))]!++;
    return h;
  }, [keys]);
  const ratio = maxOverMean(load);
  const busiest = load.indexOf(Math.max(...load));
  const hmax = Math.max(...heat);
  const bounds = scheme === "range" ? rangePartitioner(K, shards).bounds.slice(1, -1) : [];
  return (
    <Demo title="Load per shard" controls={<>
      <Param spec={LOAD.shards} value={shards} onChange={(v) => P.set("shards", v as number)} />
      <Param spec={LOAD.scheme} value={scheme} onChange={(v) => P.set("scheme", v as Scheme)} />
      <Param spec={LOAD.work} value={work} onChange={(v) => P.set("work", v as WorkloadKind)} />
    </>}>
      <SectionLabel style={{ marginTop: 0 }}>Where the {int(REQUESTS)} writes land in key order</SectionLabel>
      <div style={{ position: "relative", display: "flex", height: 26, border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {heat.map((v, i) => <div key={i} style={{ flex: 1, background: v ? tint("var(--c4)", 12 + 88 * Math.sqrt(v / hmax)) : "var(--bg)" }} />)}
        {bounds.map((b) => <div key={b} style={{ position: "absolute", top: 0, bottom: 0, left: `${(b / K) * 100}%`, borderLeft: "1.5px solid var(--fg)", opacity: 0.55 }} />)}
      </div>
      <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, margin: "2px 0 12px" }}>
        <span>key 0</span>
        <span>{scheme === "range" ? "lines: range boundaries" : "hashing ignores key order"}</span>
        <span>key {int(K - 1)}</span>
      </div>
      <SectionLabel>Writes per shard</SectionLabel>
      <LoadBars values={load} labels={load.map((_, i) => `s${i}`)} colors={load.map((_, i) => nodeColor(i % 5))} height={130} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))} caption="Dashed line: the mean. Outlined bar: the busiest shard." />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "busiest / mean", value: fixed(ratio) },
          { label: "busiest shard's share", value: pct(load[busiest]! / REQUESTS) },
          { label: "fair share", value: pct(1 / shards) },
          ...(work === "zipf" ? [{ label: "hottest key's share", value: pct(zipfShare(1, K, 0.99)) }] : []),
        ]} />
      </div>
      <Banner tone={ratio > 1.5 ? "bad" : "good"}>
        {work === "sequential" && scheme === "range" && `Every new timestamp is larger than the last, so all writes go to the last range. One shard does all the work: ${fixed(ratio)} times the mean.`}
        {work === "sequential" && scheme === "hash" && "The hash scatters neighbouring timestamps over all shards. The write load is even, but a scan of one minute of data must now ask every shard."}
        {work === "uniform" && `Uniform keys spread well under both schemes. The rest of the gap from 1.00 is sampling noise.`}
        {work === "zipf" && `The hottest key alone gets ${pct(zipfShare(1, K, 0.99))} of the requests, and one key lives on one shard. Neither scheme can split it.`}
      </Banner>
    </Demo>
  );
}

const SCAN = {
  len: range({ label: "Scan length (keys)", min: 1, max: 100000, default: 1000, log: true, format: (v) => int(v) }),
  shards: range({ label: "Shards", min: 2, max: 64, step: 1, default: 16 }),
  from: range({ label: "Scan start", min: 0, max: 900000, step: 1000, default: 412000, format: (v) => int(v) }),
};

function ShardRow({ title, per, total }: { title: string; per: number[]; total: number }) {
  const touched = per.filter((x) => x > 0).length;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
        <span className="muted">{title}</span>
        <b style={mono}>{touched} of {per.length} shards</b>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(per.length, 16)}, 1fr)`, gap: 2 }}>
        {per.map((x, i) => (
          <div key={i} title={`shard ${i}: ${x} keys`} style={{ height: 18, borderRadius: 3, border: "1px solid var(--border)", background: x > 0 ? tint("var(--c1)", 25 + 75 * Math.min(1, (x * per.length) / Math.max(1, total))) : "var(--bg)" }} />
        ))}
      </div>
    </div>
  );
}

export function PartitioningScanDemo() {
  const P = useParams("dist-part-scan", SCAN);
  const len = Math.round(P.values.len), shards = P.values.shards, from = P.values.from;
  const r = useMemo(() => scanCost(partitioner("range", K, shards), from, len), [shards, from, len]);
  const h = useMemo(() => scanCost(partitioner("hash", K, shards), from, len), [shards, from, len]);
  return (
    <Demo title="Shards touched by one range scan" controls={<>
      <Param spec={SCAN.len} value={P.values.len} onChange={(v) => P.set("len", v as number)} />
      <Param spec={SCAN.shards} value={shards} onChange={(v) => P.set("shards", v as number)} />
      <Param spec={SCAN.from} value={from} onChange={(v) => P.set("from", v as number)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>The scan reads keys {int(from)} to {int(from + len - 1)} of {int(K)}. A filled box is a shard that must answer.</div>
      <ShardRow title="Key-range partitioning" per={r.perShard} total={len} />
      <ShardRow title="Hash partitioning" per={h.perShard} total={len} />
      <Stats items={[
        { label: "range: shards asked", value: r.shards },
        { label: "hash: shards asked", value: h.shards },
        { label: "hash, expected: $N(1-(1-1/N)^{L})$", value: fixed(expectedHashScanShards(shards, len), 1) },
      ]} />
      <Banner tone={h.shards > r.shards ? "warn" : "plain"}>
        {h.shards >= shards ? `Under hashing, ${int(len)} neighbouring keys are spread over all ${shards} shards. Every shard does a little work, and the query waits for the slowest.` : `A short scan touches few shards under both schemes, but hashing already needs ${h.shards} of them.`}
      </Banner>
    </Demo>
  );
}
