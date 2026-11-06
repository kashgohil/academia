/** Demos for "rendezvous-and-jump-hashing": keys moved and balance under five schemes, and a speed and memory test. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, range, seg, useParams, Banner, Btn, MiniTable, StackBar, bytes, fixed, int, pct, useChunked, Note } from "../../kit";
import { buildLookup, benchKeys, jumpExpectedIters, moveKeys, type BenchScheme, type Change, type MoveResult, type SchemeName } from "../../sims/dist/partitioning";

const K = 10000;
const SCHEMES: [SchemeName, string][] = [["modulo", "hash mod N"], ["ring", "ring"], ["rendezvous", "rendezvous"], ["jump", "jump"], ["maglev", "Maglev"]];

const MOVE = {
  servers: range({ label: "Servers before the change", min: 2, max: 40, step: 1, default: 10 }),
  change: seg<Change>("Change", [["add", "add one"], ["removeLast", "remove the last"], ["removeMiddle", "remove one in the middle"]], "add"),
  vnodes: seg<"1" | "10" | "100">("Ring: virtual nodes", [["1", "1"], ["10", "10"], ["100", "100"]], "100"),
};

export function PartitioningSchemeCompareDemo() {
  const P = useParams("dist-part-cmp", MOVE);
  const { servers: N, change, vnodes } = P.values;
  const jobs = useMemo(() => SCHEMES.map(([s]) => () => moveKeys(s, N, change, K, { vnodes: Number(vnodes) })), [N, change, vnodes]);
  const res = useChunked<MoveResult>(`${N}/${change}/${vnodes}`, jobs, { keep: true });
  const ideal = Math.round(K / (change === "add" ? N + 1 : N));
  return (
    <Demo title="One change, five schemes" controls={<>
      <Param spec={MOVE.servers} value={N} onChange={(v) => P.set("servers", v as number)} />
      <Param spec={MOVE.change} value={change} onChange={(v) => P.set("change", v as Change)} />
      <Param spec={MOVE.vnodes} value={vnodes} onChange={(v) => P.set("vnodes", v as "1" | "10" | "100")} />
    </>}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>{int(K)} keys. Blue: keys that had to move, because they belong to the server that came or went. Red: keys that moved between two servers that stayed.</div>
      <div style={{ display: "grid", gap: 6 }}>
        {SCHEMES.map(([s, label], i) => {
          const r = res[i];
          return (
            <div key={s} style={{ display: "grid", gridTemplateColumns: "88px 1fr 64px", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <span>{label}</span>
              <StackBar total={K} height={14} parts={r ? [{ value: r.moved - r.needless, color: "var(--c1)", label: "necessary" }, { value: r.needless, color: "var(--c4)", label: "needless" }] : []} />
              <b style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r ? pct(r.moved / K) : "…"}</b>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12 }}>
        <MiniTable
          head={["scheme", "keys moved", "needless", "busiest / mean after"]}
          rows={SCHEMES.map(([, label], i) => { const r = res[i]; return [label, r ? int(r.moved) : "…", r ? int(r.needless) : "…", r ? fixed(r.maxOverMeanAfter) : "…"]; })}
          highlight={(i) => (res[i]?.needless ?? 1) === 0}
        />
      </div>
      <Banner tone="info">
        {change === "removeMiddle"
          ? "Jump hash numbers its buckets 0 to N − 1 and can only drop the last one. To remove a server in the middle, the last server takes its number, so the last server's keys move too."
          : `About ${int(ideal)} keys must move: the share of the server that ${change === "add" ? "joins" : "leaves"}, K/${change === "add" ? "(N + 1)" : "N"}. Ring, rendezvous and jump hashing move exactly those. Maglev moves a few more; modulo moves almost all.`}
      </Banner>
    </Demo>
  );
}

const BENCH_SCHEMES: [BenchScheme, string][] = [["ring", "ring (100 vnodes)"], ["rendezvous", "rendezvous"], ["jump", "jump"], ["maglev", "Maglev"]];

const SPEED = {
  servers: range({ label: "Servers", min: 2, max: 1000, default: 50, log: true, format: (v) => int(v) }),
};

interface BenchResult { ns: number; bytes: number; work: string; lookups: number }

export function PartitioningSpeedDemo() {
  const P = useParams("dist-part-speed", SPEED);
  const N = Math.round(P.values.servers);
  const [run, setRun] = useState(0);
  const jobs = useMemo(() => BENCH_SCHEMES.map(([s]) => () => {
    const L = buildLookup(s, N, 100, N > 600 ? 655373 : 65537);
    const lookups = Math.max(20000, Math.min(400000, Math.round(4e7 / (s === "rendezvous" ? N * 4 : 40))));
    const keys = benchKeys(lookups);
    let sink = 0;
    for (let i = 0; i < 2000; i++) sink += L.find(keys[i]!); // warm up the JIT
    const t0 = performance.now();
    for (let i = 0; i < lookups; i++) sink += L.find(keys[i]!);
    const dt = performance.now() - t0;
    return { ns: ((dt * 1e6) / lookups) + sink * 0, bytes: L.bytes, work: L.work, lookups };
  }), [N, run]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked<BenchResult>(`${N}/${run}`, jobs, { keep: true });
  const maxNs = Math.max(1, ...res.map((r) => r?.ns ?? 0));
  return (
    <Demo title="Lookup speed and memory" actions={<Btn ghost onClick={() => setRun((r) => r + 1)}>Run again</Btn>} controls={<Param spec={SPEED.servers} value={P.values.servers} onChange={(v) => P.set("servers", v as number)} />}>
      <div style={{ display: "grid", gap: 6 }}>
        {BENCH_SCHEMES.map(([s, label], i) => {
          const r = res[i];
          return (
            <div key={s} style={{ display: "grid", gridTemplateColumns: "110px 1fr 70px", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <span>{label}</span>
              <StackBar total={maxNs} height={14} parts={r ? [{ value: r.ns, color: "var(--c1)" }] : []} />
              <b style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r ? `${fixed(r.ns, 0)} ns` : "…"}</b>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 12 }}>
        <MiniTable
          head={["scheme", "state (model)", "work per lookup (model)"]}
          rows={BENCH_SCHEMES.map(([, label], i) => { const r = res[i]; return [label, r ? bytes(r.bytes) : "…", r ? r.work : "…"]; })}
        />
      </div>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "jump: expected loop turns $H(N)$", value: fixed(jumpExpectedIters(N), 1) },
        { label: "ring: points", value: int(N * 100) },
        { label: "Maglev: table entries", value: int(N > 600 ? 655373 : 65537) },
      ]} />
      <Note>Measured in your browser on 32-bit key hashes, so string hashing is left out. The JIT, the timer resolution and the cache size of your machine all change the result. Compare the ratios and the trend as N grows, not the absolute times. The memory column is a model: 8 bytes per ring point, 4 per rendezvous seed, 4 per Maglev entry.</Note>
    </Demo>
  );
}
