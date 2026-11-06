/** Demos for "Multi-leader": two datacenters write during a partition and reconcile; topologies with four leaders. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Legend, range, seg, toggle, useParams, Banner, Btn, ButtonRow, Chip, MiniTable, Panel, SectionLabel, MONO } from "../../kit";
import {
  DEFAULT_OPS, FIELDS, RESOLVERS, runMultiLeader, fieldText, runTopology, TOPO_DEFAULTS, LEADERS,
  type MlOp, type Resolver, type Field, type Topology, type MlResult,
} from "../../sims/dist/replication";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";

const SIDE = ["DC A", "DC B"];
const SIDE_COLOR = ["var(--c1)", "var(--c2)"];
const RES_NAME: Record<Resolver, string> = { arrival: "arrival order", lww: "last write wins", merge: "merge", siblings: "keep both" };
const TAGS = ["red", "blue", "green", "gold", "grey", "pink"];
const LATENCY = { min: 5, max: 15 };

const CONFLICT = {
  skew: range({ label: "Clock of DC B", min: -100, max: 100, step: 5, default: 0, format: (v) => (v === 0 ? "exact" : `${v > 0 ? "+" : ""}${v} ms`) }),
  resolver: seg<Resolver>("On a conflict", RESOLVERS.map((r) => [r, RES_NAME[r]]), "lww"),
};

const opText = (o: MlOp) => (o.field === "title" ? `title=${o.value}` : o.field === "tags" ? `tag +${o.value}` : "like +1");

function DocView({ r, side }: { r: MlResult; side: 0 | 1 }) {
  return (
    <Panel title={`${SIDE[side]} after the heal`} accent={SIDE_COLOR[side]}>
      {FIELDS.map((f: Field) => (
        <div key={f} style={{ display: "grid", gridTemplateColumns: "44px 1fr", gap: 6, fontSize: 12.5, lineHeight: 1.6 }}>
          <span className="muted">{f}</span>
          <span style={{ fontFamily: MONO, color: r.docs[side][f].length > 1 ? "var(--c5)" : "var(--fg)", overflowWrap: "anywhere" }}>{fieldText(r.docs[side][f])}</span>
        </div>
      ))}
    </Panel>
  );
}

export function ReplicationConflictDemo() {
  const P = useParams("repl-conflict", CONFLICT);
  const { skew, resolver } = P.values;
  const [ops, setOps] = useState<MlOp[]>(DEFAULT_OPS);
  const all = useMemo(() => RESOLVERS.map((res) => runMultiLeader(ops, { seed: 1, resolver: res, skewMs: skew, latency: LATENCY })), [ops, skew]);
  const r = all[RESOLVERS.indexOf(resolver)]!;
  const add = (side: 0 | 1, field: Field) => {
    if (ops.length >= 12) return;
    const at = (ops.length ? Math.max(...ops.map((o) => o.at)) : 0) + 10;
    const mine = ops.filter((o) => o.side === side && o.field === field).length;
    const value = field === "title" ? `Plan ${"AB"[side]}${mine ? mine + 1 : ""}` : field === "tags" ? TAGS[(ops.filter((o) => o.field === "tags").length) % TAGS.length] : undefined;
    setOps([...ops, { side, field, value, at }]);
  };
  const st = fromTrace(r.net, (m) => (m.payload.k === "state" ? "sync" : undefined));
  const marks: StMark[] = [
    { node: 0, t: 0, until: r.healAt, shape: "bar", color: "var(--c4)", label: "partition" },
    { node: 1, t: 0, until: r.healAt, shape: "bar", color: "var(--c4)" },
    ...ops.map((o) => ({ node: o.side, t: o.at, color: SIDE_COLOR[o.side] })),
  ];
  const lostA = r.lost.filter((l) => l.side === 0).length;
  const tEnd = r.healAt + 40;
  return (
    <Demo
      title="Two leaders, one partition, then a heal"
      actions={<><Btn ghost onClick={() => setOps(DEFAULT_OPS)}>Reset</Btn><Btn ghost onClick={() => setOps([])}>Clear</Btn></>}
      controls={<>
        <Param spec={CONFLICT.skew} value={skew} onChange={(v) => P.set("skew", v as number)} />
        <Param spec={CONFLICT.resolver} value={resolver} onChange={(v) => P.set("resolver", v as Resolver)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 6 }}>
        {([0, 1] as const).map((side) => (
          <ButtonRow key={side}>
            <span style={{ fontSize: 12, fontWeight: 600, color: SIDE_COLOR[side], width: 40 }}>{`${SIDE[side]}:`}</span>
            <Btn onClick={() => add(side, "title")}>set title</Btn>
            <Btn onClick={() => add(side, "tags")}>add tag</Btn>
            <Btn onClick={() => add(side, "likes")}>like +1</Btn>
          </ButtonRow>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "8px 0 2px", minHeight: 20 }}>
        {ops.length === 0 && <span className="muted" style={{ fontSize: 12 }}>No writes. Add some on each side.</span>}
        {[...ops].sort((a, b) => a.at - b.at).map((o, i) => (
          <Chip key={i} color={SIDE_COLOR[o.side]} title="click to remove" onClick={() => setOps(ops.filter((x) => x !== o))}>{`${"AB"[o.side]}@${o.at}: ${opText(o)}`}</Chip>
        ))}
      </div>
      <SpaceTime nodes={SIDE} tEnd={tEnd} messages={st.messages} marks={marks} rowHeight={44} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 8, marginTop: 6 }}>
        <DocView r={r} side={0} />
        <DocView r={r} side={1} />
      </div>
      <SectionLabel>Every resolver on these writes</SectionLabel>
      <MiniTable
        head={["resolver", "replicas agree", "writes lost", "left to the app"]}
        rows={all.map((x, i) => [RES_NAME[RESOLVERS[i]!], x.converged ? "yes" : <span style={{ color: "var(--c4)" }}>no</span>, x.converged ? x.lost.filter((l) => l.side === 0).length : `${x.lost.filter((l) => l.side === 0).length} at A, ${x.lost.filter((l) => l.side === 1).length} at B`, RESOLVERS[i] === "siblings" ? FIELDS.filter((f) => x.docs[0][f].length > 1).length : 0])}
        highlight={RESOLVERS.indexOf(resolver)}
      />
      <Banner ok={r.converged && lostA === 0 ? true : !r.converged ? false : null}>
        {!r.converged
          ? "The replicas disagree. Each side applied the other side's change on top of its own, so A ends with B's values and B with A's. Nothing will ever fix this."
          : resolver === "siblings"
            ? `Nothing is lost, but ${FIELDS.filter((f) => r.docs[0][f].length > 1).length} field(s) now hold two versions. The next reader must merge them and write the result back.`
            : `Both replicas agree, but ${lostA} write${lostA === 1 ? " is" : "s are"} gone.${r.laterLost ? " The kept title is the one written first in real time: the clock of the other side was ahead." : ""}`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ topologies

const TOPO_NAME: Record<Topology, string> = { all: "all-to-all", ring: "circular", star: "star (hub A)" };
const TOPO = {
  slowMs: range({ label: "Extra delay on link A→C (model input)", min: 0, max: 40, step: 1, default: TOPO_DEFAULTS.slowMs, format: (v) => `${v} ms` }),
  topology: seg<Topology>("Topology", (["all", "ring", "star"] as Topology[]).map((t) => [t, TOPO_NAME[t]]), "all"),
  crash: seg("Crash at 14 ms", [["-1", "nobody"], ["3", "D"], ["0", "A"]], "-1"),
  causal: toggle({ label: "Hold an update until its insert has arrived (causal order)", default: false }),
};

/** Where the four leaders sit in the small topology picture. */
const POS: [number, number][] = [[40, 30], [160, 30], [160, 110], [40, 110]];

function TopoPicture({ topology, crash }: { topology: Topology; crash: number }) {
  const edges: [number, number, boolean][] =
    topology === "all" ? [[0, 1, false], [0, 2, false], [0, 3, false], [1, 2, false], [1, 3, false], [2, 3, false]]
      : topology === "ring" ? [[0, 1, true], [1, 2, true], [2, 3, true], [3, 0, true]]
        : [[0, 1, false], [0, 2, false], [0, 3, false]];
  const shrink = (a: [number, number], b: [number, number], d: number): [number, number] => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    return [b[0] - (dx / L) * d, b[1] - (dy / L) * d];
  };
  return (
    <svg viewBox="0 0 200 140" style={{ width: 170, maxWidth: "45%", flex: "none" }} role="img" aria-label="topology">
      <defs>
        <marker id="repl-topo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
        </marker>
      </defs>
      {edges.map(([a, b, dir], i) => {
        const [x2, y2] = shrink(POS[a]!, POS[b]!, 17);
        const [x1, y1] = shrink(POS[b]!, POS[a]!, 17);
        const slow = (a === 0 && b === 2);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={slow ? "var(--c2)" : "var(--muted)"} strokeWidth={slow ? 2 : 1.3} strokeDasharray={slow ? "5 3" : undefined} markerEnd={dir ? "url(#repl-topo-arrow)" : undefined} />;
      })}
      {POS.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={14} fill="var(--bg)" stroke={i === crash ? "var(--c4)" : "var(--fg)"} strokeWidth={1.5} strokeDasharray={i === crash ? "3 2" : undefined} />
          <text x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="600" fill={i === crash ? "var(--c4)" : "var(--fg)"}>{LEADERS[i]}</text>
        </g>
      ))}
    </svg>
  );
}

export function ReplicationTopologyDemo() {
  const P = useParams("repl-topo", TOPO);
  const { slowMs, topology, crash, causal } = P.values;
  const crashNode = Number(crash);
  const r = useMemo(() => runTopology({ ...TOPO_DEFAULTS, slowMs, topology, crash: crashNode, causal }), [slowMs, topology, crashNode, causal]);
  const st = fromTrace(r.net);
  const messages = st.messages.map((m, i) => ({ ...m, color: r.net.messages[i]!.payload.op === "update" ? "var(--c2)" : "var(--c1)" }));
  const tEnd = Math.max(60, ...r.net.messages.map((m) => m.deliveredAt ?? m.lostAt ?? m.sentAt)) + 5;
  const marks: StMark[] = [...st.marks, ...r.overtaken.map((n) => ({ node: n, t: r.net.messages.find((m) => m.to === n && m.payload.op === "update" && m.deliveredAt !== undefined)!.deliveredAt!, color: "var(--c4)", label: "update, no row" }))];
  const rowColor = { new: "var(--c3)", old: "var(--c4)", none: "var(--muted)" } as const;
  const rowText = { new: "row updated", old: "old row", none: "no row" } as const;
  return (
    <Demo
      title="Four leaders: does the update overtake the insert?"
      controls={<>
        <Param spec={TOPO.slowMs} value={slowMs} onChange={(v) => P.set("slowMs", v as number)} />
        <Param spec={TOPO.topology} value={topology} onChange={(v) => P.set("topology", v as Topology)} />
        <Param spec={TOPO.crash} value={crash} onChange={(v) => P.set("crash", v as never)} />
        <Param spec={TOPO.causal} value={causal} onChange={(v) => P.set("causal", v as boolean)} />
      </>}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <TopoPicture topology={topology} crash={crashNode} />
        <div style={{ fontSize: 12.5, flex: "1 1 160px", lineHeight: 1.5 }}>
          A inserts a row. B applies the insert and updates the row at once. The dashed link from A to C is slow.
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {r.rows.map((row, i) => <Chip key={i} color={i === crashNode ? "var(--muted)" : rowColor[row]} faint={i === crashNode}>{`${LEADERS[i]}: ${i === crashNode ? "crashed" : rowText[row]}`}</Chip>)}
          </div>
        </div>
      </div>
      <SpaceTime nodes={LEADERS} tEnd={tEnd} messages={messages} marks={marks} rowHeight={40} />
      <Legend items={[{ label: "insert", color: "var(--c1)" }, { label: "update", color: "var(--c2)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "leaders that got the update first", value: r.overtaken.length },
          { label: "updates held back", value: r.buffered },
          { label: "changes a live leader never got", value: r.missed.length },
        ]} />
      </div>
      <Banner ok={r.overtaken.length === 0 && r.missed.length === 0}>
        {r.overtaken.length > 0
          ? `The update reached ${r.overtaken.map((n) => LEADERS[n]).join(", ")} before the insert. There was no row to update, so the update failed, and the insert then created the old row. The replicas now disagree for good.`
          : r.missed.length > 0
            ? `${r.missed.map(([n, op]) => `${LEADERS[n]} never got the ${op}`).join("; ")}. In a ${TOPO_NAME[topology]} topology, other leaders forward changes, so one crashed node cuts the path.`
            : causal && r.buffered > 0
              ? "C held the update until the insert arrived. Version vectors tell a replica which changes a change depends on."
              : "Every leader applied the insert, then the update."}
      </Banner>
    </Demo>
  );
}
