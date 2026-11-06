/** Demos for "consistent-hashing": an interactive ring with virtual nodes, and imbalance against virtual nodes. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Dots, Param, Plot, RuleX, Stats, range, toggle, useParams, Banner, Btn, ButtonRow, SectionLabel, fixed, int, pct, useChunked, useWidth } from "../../kit";
import { HashRing, SPACE, cvFormula, harmonicN, keyName, keyPos, ringStatsAvg } from "../../sims/dist/partitioning";
import { LoadBars, nodeColor } from "./PartitioningUi";

const KEYS = 300;
const ALL = ["A", "B", "C", "D", "E", "F", "G", "H"];

const RING = {
  vnodes: range({ label: "Virtual nodes per server", min: 1, max: 64, step: 1, default: 1 }),
  heavy: toggle({ label: "Give server A weight 2", default: false }),
};

export function PartitioningRingDemo() {
  const P = useParams("dist-part-ring", RING);
  const { vnodes, heavy } = P.values;
  const [nodes, setNodes] = useState<string[]>(["A", "B", "C"]);
  const [prev, setPrev] = useState<{ nodes: string[]; label: string } | null>(null);
  const [ref, w] = useWidth<HTMLDivElement>();
  const weights: Record<string, number> = heavy ? { A: 2 } : {};
  const ring = useMemo(() => new HashRing(nodes, vnodes, weights), [nodes, vnodes, heavy]); // eslint-disable-line react-hooks/exhaustive-deps
  const before = useMemo(() => (prev ? new HashRing(prev.nodes, vnodes, weights) : null), [prev, vnodes, heavy]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = useMemo(() => Array.from({ length: KEYS }, (_, k) => keyPos(keyName(k))), []);
  const owner = keys.map((p) => ring.lookupPos(p));
  const oldOwner = before ? keys.map((p) => before.lookupPos(p)) : null;
  const moved = oldOwner ? owner.filter((o, i) => o !== oldOwner[i]).length : 0;
  const counts = nodes.map((n) => owner.filter((o) => o === n).length);
  const own = ring.ownership();
  const colorOf = (n: string) => nodeColor(ALL.indexOf(n));

  const change = (next: string[], label: string) => { setPrev({ nodes, label }); setNodes(next); };
  const add = () => { const n = ALL.find((x) => !nodes.includes(x)); if (n) change([...nodes, n], `added ${n}`); };
  const remove = (n: string) => change(nodes.filter((x) => x !== n), `removed ${n}`);

  const size = Math.min(320, Math.max(220, w));
  const c = size / 2, R = size / 2 - 22;
  const at = (pos: number, r: number) => {
    const a = (pos / SPACE) * 2 * Math.PI - Math.PI / 2;
    return [c + r * Math.cos(a), c + r * Math.sin(a)] as const;
  };
  return (
    <Demo
      title="A consistent hash ring"
      actions={<Btn ghost onClick={() => { setNodes(["A", "B", "C"]); setPrev(null); }}>Reset</Btn>}
      controls={<>
        <Param spec={RING.vnodes} value={vnodes} onChange={(v) => P.set("vnodes", v as number)} />
        <Param spec={RING.heavy} value={heavy} onChange={(v) => P.set("heavy", v as boolean)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <Btn onClick={add} disabled={nodes.length >= ALL.length}>Add a server</Btn>
        {nodes.map((n) => <Btn key={n} ghost onClick={() => remove(n)} disabled={nodes.length <= 1}>Remove {n}</Btn>)}
      </ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, alignItems: "start" }}>
        <div ref={ref} style={{ minWidth: 0 }}>
          <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ display: "block", maxWidth: size, margin: "0 auto" }} role="img" aria-label="hash ring">
            <circle cx={c} cy={c} r={R} fill="none" stroke="var(--border)" strokeWidth={10} />
            {ring.points.map((p, i) => {
              const prevPos = i === 0 ? ring.points[ring.points.length - 1]!.pos - SPACE : ring.points[i - 1]!.pos;
              const a0 = (prevPos / SPACE) * 2 * Math.PI - Math.PI / 2, a1 = (p.pos / SPACE) * 2 * Math.PI - Math.PI / 2;
              const large = a1 - a0 > Math.PI ? 1 : 0;
              const d = ring.points.length === 1
                ? `M ${c} ${c - R} A ${R} ${R} 0 1 1 ${c - 0.01} ${c - R}`
                : `M ${c + R * Math.cos(a0)} ${c + R * Math.sin(a0)} A ${R} ${R} 0 ${large} 1 ${c + R * Math.cos(a1)} ${c + R * Math.sin(a1)}`;
              return <path key={i} d={d} fill="none" stroke={colorOf(p.node)} strokeWidth={10} opacity={0.55} />;
            })}
            {keys.map((p, i) => {
              const [x, y] = at(p, R - 16 - (i % 3) * 5);
              const mv = oldOwner && oldOwner[i] !== owner[i];
              return <circle key={i} cx={x} cy={y} r={mv ? 3.6 : 2} fill={colorOf(owner[i]!)} stroke={mv ? "var(--fg)" : "none"} strokeWidth={1.2} />;
            })}
            {ring.points.map((p, i) => {
              const [x1, y1] = at(p.pos, R - 7), [x2, y2] = at(p.pos, R + 9);
              return <line key={`t${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={colorOf(p.node)} strokeWidth={vnodes > 16 ? 1.2 : 2.5} />;
            })}
            {vnodes <= 2 && ring.points.map((p, i) => {
              const [x, y] = at(p.pos, R + 16);
              return <text key={`l${i}`} x={x} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={colorOf(p.node)}>{p.node}</text>;
            })}
            <text x={c} y={c - 4} textAnchor="middle" fontSize={12} fill="var(--muted)">{KEYS} keys</text>
            <text x={c} y={c + 12} textAnchor="middle" fontSize={11} fill="var(--muted)">{ring.points.length} points</text>
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Keys per server</SectionLabel>
          <LoadBars values={counts} labels={nodes} colors={nodes.map(colorOf)} height={120} />
          <SectionLabel>Share of the ring</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(60px, 1fr))", gap: 4, fontSize: 12 }}>
            {nodes.map((n) => <span key={n}><b style={{ color: colorOf(n) }}>{n}</b> {pct(own.get(n)!, 0)}</span>)}
          </div>
        </div>
      </div>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "busiest / mean (keys)", value: fixed(Math.max(...counts) / (KEYS / nodes.length)) },
        { label: prev ? `keys moved when ${prev.label}` : "keys moved", value: prev ? `${moved} of ${KEYS}` : "–" },
        { label: "ideal: $K/N$ of the larger cluster", value: prev ? int(KEYS / Math.max(nodes.length, prev.nodes.length)) : "–" },
      ]} />
      <Banner tone={prev ? "info" : "plain"}>
        {prev ? `Outlined dots moved. Each one moved to or from ${prev.label.split(" ")[1]}; no key moved between two servers that stayed.` : "Add or remove a server. Then raise the virtual nodes and watch the bars even out."}
      </Banner>
    </Demo>
  );
}

const VN = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1000];

const SWEEP = {
  servers: range({ label: "Servers $N$", min: 2, max: 50, step: 1, default: 10 }),
};

export function PartitioningVnodePlotDemo() {
  const P = useParams("dist-part-vn", SWEEP);
  const N = P.values.servers;
  const jobs = useMemo(() => VN.map((v) => () => ringStatsAvg(N, v, Math.max(8, Math.min(60, Math.round(30000 / (N * v)))))), [N]);
  const res = useChunked(`${N}`, jobs, { keep: true });
  const done = res.flatMap((r, i) => (r ? [[VN[i]!, r] as const] : []));
  const maxPts = done.map(([v, r]) => [v, r.maxOverMean - 1] as [number, number]);
  const cvPts = done.map(([v, r]) => [v, r.cv] as [number, number]);
  const formula = VN.map((v) => [v, cvFormula(N, v)] as [number, number]);
  const at100 = res[VN.indexOf(128)];
  return (
    <Demo title="Imbalance against virtual nodes" controls={<Param spec={SWEEP.servers} value={N} onChange={(v) => P.set("servers", v as number)} />}>
      <Plot x={[1, 1000]} y={[0.01, 5]} logX logY height={250} xLabel="virtual nodes per server (v)" yLabel="excess over the fair share" xTicks={[1, 10, 100, 1000]} yTicks={[0.01, 0.03, 0.1, 0.3, 1, 3]} yFormat={(v) => `${v}`}>
        <Line points={formula} color="var(--c2)" dash="5 4" />
        <Line points={maxPts} color="var(--c4)" />
        <Dots points={maxPts} color="var(--c4)" />
        <Dots points={cvPts} color="var(--c1)" r={3.5} />
        <RuleX at={128} />
      </Plot>
      <Legend items={[
        { label: "busiest / mean − 1 (simulated)", color: "var(--c4)" },
        { label: "std / mean (simulated)", color: "var(--c1)" },
        { label: "std / mean, formula √((N−1)/(Nv+1))", color: "var(--c2)" },
      ]} />
      <Stats items={[
        { label: "v = 1: busiest / mean", value: res[0] ? fixed(res[0].maxOverMean) : "…" },
        { label: "expected for v = 1: $H_N$", value: fixed(harmonicN(N)) },
        { label: "v = 128: busiest / mean", value: at100 ? fixed(at100.maxOverMean) : "…" },
        { label: "v = 128: std / mean, formula", value: pct(cvFormula(N, 128)) },
      ]} />
    </Demo>
  );
}
