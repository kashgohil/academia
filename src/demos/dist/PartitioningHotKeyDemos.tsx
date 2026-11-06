/** Demos for "hot-keys": a Zipf workload with a count-min sketch that finds the top keys, and a mitigation picker. */
import { useMemo } from "react";
import { Demo, Param, Stats, range, seg, useParams, Banner, MiniTable, SectionLabel, bytes, fixed, int, pct } from "../../kit";
import { HOT_DEFAULTS, hotLoad, zipfShardSample, zipfShare, type Mitigation } from "../../sims/dist/partitioning";
import { LoadBars, nodeColor } from "./PartitioningUi";

const K = 10000, SHARDS = 8, REQ = 40000;

const ZIPF = {
  theta: range({ label: "Zipf exponent θ", min: 0, max: 1.5, step: 0.05, default: 0.99, format: (v) => v.toFixed(2) }),
  width: seg<"32" | "128" | "512" | "2048">("Sketch width w", [["32", "32"], ["128", "128"], ["512", "512"], ["2048", "2048"]], "128"),
  depth: seg<"1" | "2" | "4">("Sketch depth d", [["1", "1"], ["2", "2"], ["4", "4"]], "4"),
};

export function PartitioningZipfDemo() {
  const P = useParams("dist-part-zipf", ZIPF);
  const { theta, width, depth } = P.values;
  const sim = useMemo(() => zipfShardSample(K, theta, SHARDS, REQ, Number(width), Number(depth)), [theta, width, depth]);
  const trueTop = [...sim.truth].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const found = sim.top.map(([r]) => r);
  const hits = trueTop.filter(([r]) => found.includes(r)).length;
  const maxOver = Math.max(...sim.top.map(([r, est]) => est - (sim.truth.get(r) ?? 0)));
  const ratio = Math.max(...sim.load) / (REQ / SHARDS);
  return (
    <Demo title="A Zipf workload and a count-min sketch" controls={<>
      <Param spec={ZIPF.theta} value={theta} onChange={(v) => P.set("theta", v as number)} />
      <Param spec={ZIPF.width} value={width} onChange={(v) => P.set("width", v as typeof width)} />
      <Param spec={ZIPF.depth} value={depth} onChange={(v) => P.set("depth", v as typeof depth)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{int(REQ)} requests over {int(K)} keys, hash-partitioned over {SHARDS} shards.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Requests per shard</SectionLabel>
          <LoadBars values={sim.load} labels={sim.load.map((_, i) => `s${i}`)} colors={sim.load.map((_, i) => nodeColor(i % 5))} height={120} format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))} />
        </div>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Top 5: true count and sketch estimate</SectionLabel>
          <MiniTable
            head={["true top key", "count", "sketch top key", "estimate"]}
            rows={trueTop.map(([r, n], i) => {
              const s = sim.top[i];
              return [`key ${r}`, int(n), s ? `key ${s[0]}` : "–", s ? int(s[1]) : "–"];
            })}
          />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "hottest key's share", value: pct(zipfShare(1, K, theta)) },
          { label: "busiest shard / mean", value: fixed(ratio) },
          { label: "true top 5 found", value: `${hits} of 5` },
          { label: "largest overcount in the list", value: int(Math.max(0, maxOver)) },
          { label: "sketch size", value: bytes(sim.sketchBytes) },
        ]} />
      </div>
      <Banner tone={hits === 5 ? "good" : "warn"}>
        {theta < 0.3 ? "With a small θ every key is about as popular as the next. There is no hot key to find, and the shards are even." : hits === 5 ? `The sketch found the five hottest keys with ${bytes(sim.sketchBytes)} of counters. Estimates are never below the true counts.` : "Collisions push cold keys above the true top keys. Make the sketch wider, or deeper, and the list becomes correct."}
      </Banner>
    </Demo>
  );
}

const MIT = {
  read: range({ label: "Reads", min: 0, max: 1, step: 0.05, default: 0.9, format: (v) => pct(v, 0) }),
  mitigation: seg<Mitigation>("Mitigation", [["none", "none"], ["split", "split the key"], ["cache", "cache"], ["coalesce", "coalesce reads"], ["replicate", "replicate the shard"]], "split"),
  param: range({ label: "Sub-keys / cached keys / replicas", min: 2, max: 16, step: 1, default: 8 }),
};

export function PartitioningMitigationDemo() {
  const P = useParams("dist-part-mit", MIT);
  const { read, mitigation, param } = P.values;
  const before = useMemo(() => hotLoad({ readFrac: read, mitigation: "none" }), [read]);
  const after = useMemo(() => hotLoad({ readFrac: read, mitigation, splits: param, hotKeys: mitigation === "cache" ? param : 1, replicas: param }), [read, mitigation, param]);
  const scale = Math.max(...before.perShard, ...after.perShard);
  const mean = HOT_DEFAULTS.rate / HOT_DEFAULTS.shards;
  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : int(v));
  const hb = Math.max(...before.perShard), ha = Math.max(...after.perShard);
  return (
    <Demo title="Mitigations for one hot key" controls={<>
      <Param spec={MIT.read} value={read} onChange={(v) => P.set("read", v as number)} />
      <Param spec={MIT.mitigation} value={mitigation} onChange={(v) => P.set("mitigation", v as Mitigation)} />
      <Param spec={MIT.param} value={param} onChange={(v) => P.set("param", v as number)} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{int(HOT_DEFAULTS.rate)} requests per second (model input), Zipf θ = 0.99 over {int(HOT_DEFAULTS.K)} keys, {HOT_DEFAULTS.shards} shards. The hottest key takes {pct(zipfShare(1, HOT_DEFAULTS.K, 0.99))} of all requests.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Before: requests/s per shard</SectionLabel>
          <LoadBars values={before.perShard} labels={before.perShard.map((_, i) => `s${i}`)} colors={before.perShard.map((_, i) => nodeColor(i % 5))} max={scale} height={120} format={fmt} />
        </div>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>After: {mitigation === "none" ? "no change" : mitigation === "replicate" ? "busiest replica" : "requests/s per shard"}</SectionLabel>
          <LoadBars values={after.perShard} labels={after.perShard.map((_, i) => `s${i}`)} colors={after.perShard.map((_, i) => nodeColor(i % 5))} max={scale} height={120} format={fmt} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "busiest shard, before", value: `${fixed(hb / mean)}× mean` },
          { label: "busiest shard, after", value: `${fixed(ha / mean)}× mean` },
          { label: "backend requests per client request", value: fixed(after.amplification) },
          { label: "requests one read of the hot key makes", value: after.readCost },
        ]} />
      </div>
      <Banner tone={ha < hb * 0.9 ? "good" : ha > hb * 1.05 ? "bad" : "warn"}>
        {mitigation === "none" && "One key on one shard. That shard runs at its limit while the others idle."}
        {mitigation === "split" && (ha < hb ? `Writes to the hot key now spread over ${param} sub-keys. But every read must fetch all ${param} and merge them.` : `With ${pct(read, 0)} reads, splitting makes it worse: each read of the hot key now asks ${param} shards. Split keys help write-hot keys.`)}
        {mitigation === "cache" && `Reads of the ${param} hottest keys hit the cache. Writes still reach the shard, and the cache must be invalidated or expire.`}
        {mitigation === "coalesce" && `Reads of one key that arrive while a read is in flight (${HOT_DEFAULTS.flightMs} ms, model input) share its answer. A hot key gains the most.`}
        {mitigation === "replicate" && `The hot shard has ${param} copies that serve reads. Every write must go to all ${param}.`}
      </Banner>
    </Demo>
  );
}
