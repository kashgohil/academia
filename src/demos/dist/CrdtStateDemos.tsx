/** Demos for the lesson on state-based CRDTs: three replicas that gossip counters on Net, and the lattice view of a merge. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Panel, Param, SectionLabel, SmallLabel, Stats, mono, pct, range, seg, tint, useParams, useWidth } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import {
  PRESET_ACTIONS, agree, chainLattice, gCounterLattice, hasseEdges, lwwCounter, pnCounter, powersetLattice, runStateCluster, upperBounds,
  type ClusterAction, type FiniteLattice, type Lww, type PNCounter,
} from "../../sims/dist/crdts";

const R = ["R1", "R2", "R3"];

// ============================================================================ 1. Three replicas gossip a counter

const GOSSIP = {
  dup: range({ label: "Duplicated messages", min: 0, max: 0.5, step: 0.05, default: 0.2, format: (v) => pct(v, 0) }),
  kind: seg<"pn" | "lww">("Counter", [["pn", "PN-Counter"], ["lww", "naive: last value wins"]], "pn"),
};

export function CrdtGossipDemo() {
  const P = useParams("crdt-gossip", GOSSIP);
  const { dup, kind } = P.values;
  const [actions, setActions] = useState<ClusterAction[]>(PRESET_ACTIONS);
  const run = useMemo(
    () => (kind === "pn" ? runStateCluster(pnCounter, actions, { dupRate: dup }) : runStateCluster(lwwCounter, actions, { dupRate: dup })),
    [actions, kind, dup],
  );
  const push = (...a: ClusterAction[]) => setActions((x) => [...x, ...a]);
  const now = run.net.now;
  const tEnd = Math.max(200, now), tStart = Math.max(0, tEnd - 500);
  // Messages still in flight are left out until they arrive or are lost.
  const messages: StMessage[] = run.net.messages
    .filter((m) => m.sentAt >= tStart && (m.deliveredAt !== undefined || m.lost))
    .map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost && m.lost !== "dropped" ? m.lostAt : undefined, color: m.dupOf ? "var(--c2)" : m.lost ? "var(--c4)" : "var(--faint)" }));
  const marks: StMark[] = run.net.trace.flatMap((e) => (e.kind === "note" && e.t >= tStart ? [{ node: e.node, t: e.t, label: e.text, color: e.text.startsWith("-") ? "var(--c4)" : "var(--c3)" }] : []));
  for (const c of run.cut) marks.push({ node: c, t: Math.max(tStart, now - 1), shape: "bar", until: now, label: "cut off", color: "var(--c4)" });
  const same = agree(run);
  const right = same && run.values[0] === run.truth;
  const dups = run.net.messages.filter((m) => m.dupOf).length;
  const state = (i: number) => {
    if (kind === "pn") {
      const s = run.states[i] as PNCounter;
      return <>P [{s.p.join(",")}]<br />N [{s.n.join(",")}]</>;
    }
    const s = run.states[i] as Lww<number>;
    return s.r < 0 ? <>never written</> : <>v = {s.v}, written<br />at {Math.round(s.t)} ms by {R[s.r]}</>;
  };
  return (
    <Demo
      title="Three replicas gossip a counter"
      actions={<>
        <Btn onClick={() => setActions((a) => (a.length ? a.slice(0, -1 - (a.at(-1)?.k === "run" && a.at(-2)?.k === "op" ? 1 : 0)) : a))} disabled={!actions.length}>Undo</Btn>
        <Btn ghost onClick={() => setActions([])}>Clear</Btn>
        <Btn ghost onClick={() => setActions(PRESET_ACTIONS)}>Preset</Btn>
      </>}
      controls={<>{(["dup", "kind"] as const).map((k) => <Param key={k} spec={GOSSIP[k]} value={P.values[k]} onChange={(v) => P.set(k, v as never)} />)}</>}
    >
      <SmallLabel>Each replica sends its whole state to a random peer every 40 ms. Latency is 4 to 40 ms, so messages overtake each other. Orange arrows are duplicates.</SmallLabel>
      <SpaceTime nodes={R} tStart={tStart} tEnd={tEnd} messages={messages} marks={marks} rowHeight={42} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
        {R.map((name, i) => (
          <Panel key={i} title={`${name}${run.cut.includes(i) ? " (cut off)" : ""}`} accent={run.cut.includes(i) ? "var(--c4)" : undefined}>
            <div style={{ fontSize: 22, fontWeight: 650, ...mono }}>{run.values[i]}</div>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.35, minHeight: 30, ...mono }}>{state(i)}</div>
            <ButtonRow style={{ marginTop: 4 }}>
              <Btn onClick={() => push({ k: "op", r: i, d: 1 }, { k: "run", ms: 5 })}>+1</Btn>
              <Btn onClick={() => push({ k: "op", r: i, d: -1 }, { k: "run", ms: 5 })}>−1</Btn>
            </ButtonRow>
          </Panel>
        ))}
      </div>
      <ButtonRow style={{ marginTop: 8 }}>
        <Btn onClick={() => push({ k: "run", ms: 100 })}>Let gossip run 100 ms</Btn>
        {run.cut.length ? <Btn onClick={() => push({ k: "heal" })}>Heal the partition</Btn> : <Btn onClick={() => push({ k: "cut", r: 2 })}>Cut R3 off</Btn>}
      </ButtonRow>
      <Banner tone={right ? "good" : same ? "bad" : "warn"}>
        {right
          ? `All replicas show ${run.truth}, the sum of every update. The order of delivery and the ${dups} duplicates made no difference.`
          : same
            ? `All replicas agree on ${run.values[0]}, but the updates sum to ${run.truth}. Concurrent writes of "old value + d" overwrote each other. The merge converges, but it loses updates.`
            : run.cut.length
              ? `The replicas differ: ${run.values.join(", ")}. ${R[run.cut[0]!]} is cut off. Heal the partition and let gossip run.`
              : `The replicas differ: ${run.values.join(", ")}. Some states are still on their way. Let gossip run.`}
      </Banner>
      <Stats items={[
        { label: "updates", value: run.ops.length },
        { label: "sum of updates", value: run.truth },
        { label: "messages", value: run.net.messages.length },
        { label: "duplicates", value: dups },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. The lattice view of a merge

type LKind = "gc" | "set" | "max";
const LAT = { lat: seg<LKind>("States of", [["gc", "G-Counter, 2 replicas"], ["set", "G-Set over x, y, z"], ["max", "max-register"]], "gc") };
const DEFAULT_PICK: Record<LKind, [string, string]> = { gc: ["2,0", "1,2"], set: ["x", "y,z"], max: ["2", "4"] };

function LatticeView<S>({ L, pick, onPick }: { L: FiniteLattice<S>; pick: string[]; onPick: (k: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(280, width);
  const maxRank = Math.max(...L.nodes.map((s) => L.rank(s)));
  const rowH = maxRank > 4 ? 44 : 62, H = 30 + maxRank * rowH + 24;
  const nodeW = 46;
  const px = (s: S) => W / 2 + L.across(s) * (W / 2 - nodeW / 2 - 4);
  const py = (s: S) => H - 22 - L.rank(s) * rowH;
  const byKey = new Map(L.nodes.map((s) => [L.key(s), s]));
  const a = byKey.get(pick[0]!), b = byKey.get(pick[1]!);
  const ub = a && b ? upperBounds(L, a, b) : null;
  const isUb = (s: S) => !!ub && ub.bounds.some((x) => L.key(x) === L.key(s));
  const edges = hasseEdges(L);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Hasse diagram of the lattice" style={{ display: "block" }}>
        {edges.map(([lo, hi], i) => {
          const on = isUb(lo) && isUb(hi);
          return <line key={i} x1={px(lo)} y1={py(lo)} x2={px(hi)} y2={py(hi)} stroke={on ? "var(--c3)" : "var(--border)"} strokeWidth={on ? 1.8 : 1.2} />;
        })}
        {L.nodes.map((s) => {
          const k = L.key(s);
          const isA = k === pick[0], isB = k === pick[1], isJ = !!ub && L.key(ub.least) === k;
          const color = isJ ? "var(--c3)" : isA ? "var(--c2)" : isB ? "var(--c5)" : isUb(s) ? "var(--c3)" : "var(--muted)";
          return (
            <g key={k} onClick={() => onPick(k)} style={{ cursor: "pointer" }}>
              <rect x={px(s) - nodeW / 2} y={py(s) - 11} width={nodeW} height={22} rx={5} fill={isJ ? "var(--c3)" : isUb(s) ? tint("var(--c3)", 14) : "var(--bg)"} stroke={color} strokeWidth={isA || isB || isJ ? 2.2 : 1.2} />
              <text x={px(s)} y={py(s) + 4} textAnchor="middle" fontSize="11.5" fontFamily="ui-monospace, monospace" fill={isJ ? "var(--bg)" : isA || isB ? color : "var(--fg)"}>{L.label(s)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function CrdtLatticeDemo() {
  const P = useParams("crdt-lattice", LAT);
  const lat = P.values.lat;
  const [picks, setPicks] = useState<Record<LKind, string[]>>(DEFAULT_PICK);
  const pick = picks[lat];
  const onPick = (k: string) => setPicks((p) => ({ ...p, [lat]: p[lat].includes(k) ? p[lat].filter((x) => x !== k) : [...p[lat], k].slice(-2) }));
  const L = (lat === "gc" ? gCounterLattice(3) : lat === "set" ? powersetLattice() : chainLattice(5)) as FiniteLattice<unknown>;
  const byKey = new Map(L.nodes.map((s) => [L.key(s), s]));
  const a = byKey.get(pick[0] ?? ""), b = byKey.get(pick[1] ?? "");
  const ub = a !== undefined && b !== undefined ? upperBounds(L, a, b) : null;
  const order = a !== undefined && b !== undefined ? (L.leq(a, b) && L.leq(b, a) ? "equal" : L.leq(a, b) ? "a ≤ b" : L.leq(b, a) ? "b ≤ a" : "concurrent") : null;
  return (
    <Demo title="A merge is the join in a partial order" controls={<Param spec={LAT.lat} value={lat} onChange={(v) => P.set("lat", v as LKind)} />}>
      <SmallLabel>Each box is a state. A line goes up from a state to a state just above it. Click two states.</SmallLabel>
      <LatticeView L={L} pick={pick} onPick={onPick} />
      <Banner tone={ub ? "good" : "plain"} label={ub ? "join" : undefined}>
        {ub && a !== undefined && b !== undefined
          ? `${L.label(a)} ⊔ ${L.label(b)} = ${L.label(ub.least)}. The two states are ${order === "concurrent" ? "concurrent: neither is below the other" : order === "equal" ? "equal, and a ⊔ a = a" : `ordered (${order}), so the join is the larger one`}. ${ub.bounds.length} states are above both (green). The join is the lowest of them: it adds nothing that neither replica had.`
          : "Pick two states: one for each replica. The demo draws their merge."}
      </Banner>
      <SectionLabel>Why the laws hold</SectionLabel>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        The least upper bound does not depend on which state you name first (commutative), on how you group three merges (associative), or on how
        many times a state arrives (idempotent). An update only moves a state up. So any order of gossip ends at the same top: the join of every update.
      </div>
    </Demo>
  );
}
