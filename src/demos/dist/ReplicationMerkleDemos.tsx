/** Demos for "Anti-entropy and Merkle trees": step through a tree comparison; bytes sent against divergence. */
import { useMemo, useState } from "react";
import { Demo, Param, Plot, Line, Legend, Stats, range, seg, useParams, Btn, Chip, StepButtons, StepCaption, useStepper, useChunked, MONO, si, int, ButtonRow } from "../../kit";
import { buildTree, diffTrees, makePair, sweepPoint, SWEEP_DS, WIRE_DEFAULT, type SweepPoint } from "../../sims/dist/replication";

const KEYS = 48, DEPTH = 4;
const STEP = { d: range({ label: "Keys that differ", min: 0, max: 8, step: 1, default: 3 }) };

const rangeText = (level: number, i: number) => {
  const size = 2 ** (32 - level);
  const hex = (x: number) => `0x${x.toString(16).padStart(8, "0")}`;
  return `${hex(i * size)} to ${hex(Math.min(2 ** 32, (i + 1) * size) - 1)}`;
};

export function ReplicationMerkleStepDemo() {
  const P = useParams("repl-merkle", STEP);
  const { d } = P.values;
  const [seed, setSeed] = useState(5);
  const { a, b, changed } = useMemo(() => makePair(KEYS, d, seed), [d, seed]);
  const ta = useMemo(() => buildTree(a, DEPTH), [a]);
  const tb = useMemo(() => buildTree(b, DEPTH), [b]);
  const diff = useMemo(() => diffTrees(ta, tb), [ta, tb]);
  const s = useStepper(diff.visits.length + 1, 3);
  const k = s.i; // visits shown
  const shown = diff.visits.slice(0, k);
  const state = new Map(shown.map((v) => [`${v.level}:${v.index}`, v.equal]));
  const cur = k > 0 ? diff.visits[k - 1]! : null;
  const finished = k === diff.visits.length;
  const leavesOpen = shown.filter((v) => v.level === DEPTH && !v.equal).map((v) => v.index);
  const listBytes = leavesOpen.reduce((acc, i) => acc + tb.leaves[i]!.length * (WIRE_DEFAULT.key + WIRE_DEFAULT.hash), 0);
  const sent = k * WIRE_DEFAULT.hash + listBytes + (finished ? diff.keys.length * WIRE_DEFAULT.value : 0);
  const changedSet = new Set(changed);
  const W = 400, H = 4 + (DEPTH + 1) * 40;
  const nx = (lv: number, i: number) => ((i + 0.5) / 2 ** lv) * W;
  const ny = (lv: number) => 16 + lv * 40;
  const nodes: { lv: number; i: number }[] = [];
  for (let lv = 0; lv <= DEPTH; lv++) for (let i = 0; i < 2 ** lv; i++) nodes.push({ lv, i });
  return (
    <Demo
      title="Compare two Merkle trees, top down"
      actions={<Btn ghost onClick={() => { setSeed(seed + 1); s.reset(); }}>New data</Btn>}
      controls={<Param spec={STEP.d} value={d} onChange={(v) => { P.set("d", v as number); s.reset(); }} />}
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        {`Two replicas hold ${KEYS} keys. ${d} key${d === 1 ? " has" : "s have"} a different value on replica B. Each tree has ${2 ** DEPTH} leaf ranges of the 32-bit key hash.`}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 640 }} role="img" aria-label="Merkle tree">
        {nodes.filter((n) => n.lv > 0).map(({ lv, i }) => (
          <line key={`e${lv}:${i}`} x1={nx(lv - 1, i >> 1)} y1={ny(lv - 1) + 9} x2={nx(lv, i)} y2={ny(lv) - 9} stroke="var(--border)" />
        ))}
        {nodes.map(({ lv, i }) => {
          const st = state.get(`${lv}:${i}`);
          const isCur = cur && cur.level === lv && cur.index === i;
          const c = st === undefined ? "var(--faint)" : st ? "var(--c3)" : "var(--c4)";
          const w = Math.min(64, W / 2 ** lv - 4);
          const text = lv === DEPTH ? `${ta.leaves[i]!.length}` : ta.hashes[lv]![i]!.slice(0, lv < 3 ? 6 : 4);
          return (
            <g key={`n${lv}:${i}`}>
              <rect x={nx(lv, i) - w / 2} y={ny(lv) - 9} width={w} height={18} rx={3} fill={st === undefined ? "var(--bg)" : `color-mix(in srgb, ${c} 18%, var(--bg))`} stroke={isCur ? "var(--fg)" : c} strokeWidth={isCur ? 2.2 : 1.2} />
              <text x={nx(lv, i)} y={ny(lv) + 4} textAnchor="middle" fontSize={lv === DEPTH ? 10 : 9.5} fontFamily={MONO} fill={st === undefined ? "var(--muted)" : "var(--fg)"}>{text}</text>
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 11, textAlign: "right" }}>leaf boxes show how many keys fall in the range</div>
      <ButtonRow style={{ marginTop: 6 }}><StepButtons s={s} /></ButtonRow>
      <StepCaption tone={cur ? (cur.equal ? "good" : "bad") : "plain"} label={cur ? `level ${cur.level}` : undefined}>
        {!cur
          ? "Replica B sends its root hash. Press Step."
          : finished && diff.keys.length === 0 && cur.equal && cur.level === 0
            ? "The roots match, so the replicas hold the same data. One hash crossed the network."
            : <>
              <span style={{ fontFamily: MONO, fontSize: 12 }}>{rangeText(cur.level, cur.index)}</span>{" "}
              A {ta.hashes[cur.level]![cur.index]!.slice(0, 8)}…, B {tb.hashes[cur.level]![cur.index]!.slice(0, 8)}…{" "}
              {cur.equal ? "match: skip this whole range." : cur.level < DEPTH ? "differ: ask for the two child hashes." : "differ: B sends its keys and value hashes for this range."}
            </>}
      </StepCaption>
      {leavesOpen.length > 0 && (
        <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
          {leavesOpen.map((i) => (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 11.5, width: 52 }}>leaf {i}</span>
              {tb.leaves[i]!.map((key) => <Chip key={key} color={changedSet.has(key) ? "var(--c4)" : "var(--muted)"} bold={changedSet.has(key)}>{key.replace("user:", "")}</Chip>)}
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "hashes compared", value: `${k} of ${2 ** (DEPTH + 1) - 1}` },
          { label: "bytes sent so far", value: int(sent) },
          { label: "send every key and value", value: int(KEYS * (WIRE_DEFAULT.key + WIRE_DEFAULT.value)) },
          { label: "keys found", value: finished ? diff.keys.length : "…" },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ sweep

const SWEEP = {
  depth: range({ label: "Tree depth", min: 4, max: 14, step: 1, default: 10, format: (v) => `${v} (${int(2 ** v)} leaves)` }),
  value: range({ label: "Value size (model input)", min: 50, max: 2000, step: 50, default: WIRE_DEFAULT.value, format: (v) => `${v} B` }),
  n: seg("Keys", [["1000", "1,000"], ["10000", "10,000"]], "10000"),
};

export function ReplicationMerkleSweepDemo() {
  const P = useParams("repl-msweep", SWEEP);
  const { depth, value } = P.values;
  const n = Number(P.values.n);
  const wire = useMemo(() => ({ ...WIRE_DEFAULT, value }), [value]);
  const ds = SWEEP_DS.filter((x) => x >= 1 && x <= n);
  const jobs = useMemo(() => ds.map((x) => () => sweepPoint(n, depth, x, 3, wire)), [n, depth, wire]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked<SweepPoint>(`${n}/${depth}/${value}`, jobs, { keep: true });
  const got = res.filter((x): x is SweepPoint => !!x);
  const line = (k: "merkle" | "allHashes" | "allValues") => got.map((p) => [p.d, p[k]] as [number, number]);
  const ymin = 100, ymax = n * (wire.key + wire.value) * 2;
  const first = got[0];
  const cross = got.find((p) => p.merkle > p.allHashes);
  return (
    <Demo
      title="Bytes to repair, against the number of differing keys"
      controls={<>
        <Param spec={SWEEP.depth} value={depth} onChange={(v) => P.set("depth", v as number)} />
        <Param spec={SWEEP.value} value={value} onChange={(v) => P.set("value", v as number)} />
        <Param spec={SWEEP.n} value={P.values.n} onChange={(v) => P.set("n", v as never)} />
      </>}
    >
      <Plot x={[1, n]} y={[ymin, ymax]} logX logY height={250} xLabel="keys that differ" yLabel="bytes sent" xTicks={[1, 10, 100, 1000, 10000].filter((t) => t <= n)} yTicks={[100, 1e3, 1e4, 1e5, 1e6, 1e7].filter((t) => t <= ymax)} yFormat={(v) => si(v, "B")} xFormat={(v) => (v >= 1000 ? `${v / 1000}k` : `${v}`)}>
        <Line points={line("allValues")} color="var(--c4)" />
        <Line points={line("allHashes")} color="var(--c2)" />
        <Line points={line("merkle")} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "Merkle walk", color: "var(--c1)" }, { label: "every key + hash", color: "var(--c2)" }, { label: "every key + value", color: "var(--c4)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "1 key differs: Merkle walk", value: first ? si(first.merkle, "B") : "…" },
          { label: "1 key differs: hashes compared", value: first ? int(first.hashesCompared) : "…" },
          { label: "send every key + value", value: si(n * (wire.key + wire.value), "B") },
          { label: "Merkle costs more than the hash list from", value: cross ? `${int(cross.d)} keys` : got.length === ds.length ? "never here" : "…" },
        ]} />
      </div>
    </Demo>
  );
}
