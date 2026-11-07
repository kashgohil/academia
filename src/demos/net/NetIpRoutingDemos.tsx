/** Demos for "Routing: distance vector and link state": count to infinity, Dijkstra, and convergence on packets. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleX, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, seg, range, toggle, useParams, useStepper,
} from "../../kit";
import { fromPackets } from "./PacketViews";
import { SpaceTime } from "../dist/SpaceTime";
import {
  CONV_DEFAULTS, CONV_TOPO, DV_LINE, DV_LINE_SCHEDULE, DV_TRIANGLE, DV_TRIANGLE_SCHEDULE, RIP_INFINITY, convergenceRun, dijkstraSteps, dvRun, type Topo,
} from "../../sims/net/ip";
import { TopoView, type TopoLink, type TopoNode } from "./NetIpUi";

const LINE_COLORS = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)"];
const distText = (d: number) => (d >= RIP_INFINITY ? "∞" : String(d));

// ============================================================================ 1. Count to infinity

const DV = {
  topo: seg("Topology", [["line", "A–B–C, cut B–C"], ["triangle", "triangle + D, cut C–D"]], "line"),
  mode: seg("Advertise to the next hop", [["plain", "everything"], ["split", "split horizon"], ["poison", "poison reverse"]], "plain"),
};

export function NetIpDvDemo() {
  const P = useParams("net-ip-dv", DV);
  const { topo, mode } = P.values;
  const t: Topo = topo === "line" ? DV_LINE : DV_TRIANGLE;
  const dest = t.names.length - 1;
  const cut = t.links.length - 1;
  const run = useMemo(
    () => dvRun(t, dest, { splitHorizon: mode !== "plain", poisonReverse: mode === "poison" }, cut, topo === "line" ? DV_LINE_SCHEDULE : DV_TRIANGLE_SCHEDULE),
    [t, dest, cut, mode, topo],
  );
  const s = useStepper(run.frames.length, 4);
  const f = run.frames[s.i]!;
  const nodes: TopoNode[] = t.names.map((n, i) => ({
    id: i, label: n, x: t.pos[i]![0], y: t.pos[i]![1], bold: f.changed.includes(i),
    color: i === dest ? "var(--c3)" : f.changed.includes(i) ? "var(--c2)" : undefined,
    sub: i === dest ? "destination" : `${distText(f.dist[i]!)}${f.via[i] !== null ? ` via ${t.names[f.via[i]!]}` : ""}`,
  }));
  const links: TopoLink[] = t.links.map((l, i) => {
    const isMsg = f.msg && ((f.msg.from === l.a && f.msg.to === l.b) || (f.msg.from === l.b && f.msg.to === l.a));
    const down = i === cut && s.i > 0;
    return { a: l.a, b: l.b, dashed: down, faint: down, color: isMsg ? "var(--c2)" : down ? "var(--c4)" : undefined, width: isMsg ? 3 : 1.6, label: down ? "cut" : undefined };
  });
  // Next-hop arrows.
  const arrows: TopoLink[] = f.via.flatMap((v, i) => (v === null ? [] : [{ a: i, b: v, arrow: true, color: "var(--c1)", width: 1.4 }]));
  const caption = s.i === 0
    ? `Converged: every router knows its distance to ${t.names[dest]}. Press Step to cut the link.`
    : s.i === 1 ? `The link fails. ${t.names[t.links[cut]!.a]} and ${t.names[t.links[cut]!.b]} forget what they heard over it.`
    : `${t.names[f.msg!.from]} tells ${t.names[f.msg!.to]}: "${t.names[dest]} is ${f.msg!.said === null ? "(not mentioned)" : distText(f.msg!.said)}". ${f.changed.length ? `${t.names[f.msg!.to]} now says ${distText(f.dist[f.msg!.to]!)}.` : "No change."}`;
  const series = t.names.map((_, v) => run.frames.map((fr, k) => [k, Math.min(RIP_INFINITY, fr.dist[v]!)] as [number, number]));
  return (
    <Demo title="Count to infinity, one advertisement at a time"
      actions={<StepButtons s={s} />}
      controls={<>
        <StepSlider s={s} />
        <Param spec={DV.topo} value={topo} onChange={(v) => { P.set("topo", v as "line"); s.reset(); }} />
        <Param spec={DV.mode} value={mode} onChange={(v) => { P.set("mode", v as "plain"); s.reset(); }} />
      </>}
    >
      <TopoView nodes={nodes} links={[...links, ...arrows]} height={topo === "line" ? 120 : 190} />
      <StepCaption label={`step ${s.i}`} tone={s.i > 1 && f.changed.length ? "warn" : "plain"}>{caption}</StepCaption>
      <SectionLabel>Distance to {t.names[dest]} at each router (16 = unreachable)</SectionLabel>
      <Plot x={[0, Math.max(1, run.frames.length - 1)]} y={[0, RIP_INFINITY]} height={170} xLabel="advertisements delivered" yTicks={[0, 4, 8, 12, 16]}>
        {series.map((pts, v) => (v === dest ? null : <Line key={v} points={pts} color={LINE_COLORS[v % 4]!} />))}
        <RuleX at={s.i} />
      </Plot>
      <Legend items={t.names.flatMap((n, v) => (v === dest ? [] : [{ label: n, color: LINE_COLORS[v % 4]! }]))} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "advertisements until stable", value: run.messages },
          { label: "a routing loop formed", value: run.loopSeen ? "yes" : "no" },
          { label: "final distances", value: t.names.map((n, i) => (i === dest ? null : `${n} ${distText(run.frames.at(-1)!.dist[i]!)}`)).filter(Boolean).join(", ") },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Dijkstra

const COST_CYCLE = [1, 2, 5, 10];

export function NetIpDijkstraDemo() {
  const t = CONV_TOPO;
  const [costs, setCosts] = useState(t.links.map((l) => l.cost));
  const [src, setSrc] = useState(0);
  const frames = useMemo(() => dijkstraSteps(t, src, (i) => costs[i]!), [t, src, costs]);
  const s = useStepper(frames.length, 1.5);
  const f = frames[s.i]!;
  const nodes: TopoNode[] = t.names.map((n, i) => ({
    id: i, label: n, x: t.pos[i]![0], y: t.pos[i]![1],
    fill: f.done[i] ? "var(--c3)" : undefined, color: i === f.settled ? "var(--c2)" : f.done[i] ? "var(--c3)" : undefined, bold: i === f.settled,
    sub: f.dist[i] === Infinity ? "∞" : `${f.dist[i]}`,
  }));
  const tree = new Set(f.prev.flatMap((p, v) => (p === null ? [] : [`${Math.min(p, v)}-${Math.max(p, v)}`])));
  const links: TopoLink[] = t.links.map((l, i) => {
    const rel = f.relaxed.find((r) => r.link === i);
    const inTree = tree.has(`${Math.min(l.a, l.b)}-${Math.max(l.a, l.b)}`);
    return { a: l.a, b: l.b, label: `${costs[i]}`, color: rel ? (rel.improved ? "var(--c2)" : "var(--muted)") : inTree ? "var(--c3)" : undefined, width: inTree ? 3 : rel ? 2.2 : 1.4 };
  });
  const caption = f.settled < 0
    ? `Start: ${t.names[src]} is at distance 0; every other router is at ∞.`
    : `Settle ${t.names[f.settled]} at ${f.dist[f.settled]}: no other path can be shorter, because all costs are positive. ${f.relaxed.filter((r) => r.improved).length} neighbour distance${f.relaxed.filter((r) => r.improved).length === 1 ? "" : "s"} improved.`;
  return (
    <Demo title="Dijkstra on a link-state database"
      actions={<><StepButtons s={s} /><Btn ghost onClick={() => { setCosts(t.links.map((l) => l.cost)); s.reset(); }}>Reset costs</Btn></>}
      controls={<StepSlider s={s} />}
    >
      <TopoView nodes={nodes} links={links} height={210} onLink={(i) => { setCosts(costs.map((c, j) => (j === i ? COST_CYCLE[(COST_CYCLE.indexOf(c) + 1) % COST_CYCLE.length]! : c))); s.reset(); }} onNode={(i) => { setSrc(i); s.reset(); }} />
      <Note>Click a link to change its cost (1, 2, 5, 10). Click a router to run Dijkstra from it.</Note>
      <StepCaption label={`step ${s.i}`}>{caption}</StepCaption>
      <div style={{ marginTop: 8 }}>
        <MiniTable head={["router", "distance", "previous hop", "first hop from " + t.names[src]]}
          rows={t.names.map((n, v) => {
            let fh = v as number | null;
            while (fh !== null && f.prev[fh] !== null && f.prev[fh] !== src) fh = f.prev[fh]!;
            return [n, f.dist[v] === Infinity ? "∞" : f.dist[v], f.prev[v] === null ? "–" : t.names[f.prev[v]!], v === src || f.prev[v] === null ? "–" : t.names[fh!]];
          })}
          highlight={(r) => r === f.settled} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. Convergence on packets

const CV = {
  detect: range({ label: "Failure detection time (model input)", min: 0, max: 50, step: 1, default: CONV_DEFAULTS.detectMs, format: (v) => `${v} ms` }),
  proto: seg("Protocol", [["ls", "link state"], ["dv", "distance vector"]], "ls"),
  cut: seg("Failure", [["one", "cut C–F"], ["both", "cut C–F and E–F"]], "one"),
  mode: seg("Distance vector advertises", [["plain", "everything"], ["split", "split horizon"], ["poison", "poison reverse"]], "poison"),
  triggered: toggle({ label: "Triggered updates (otherwise periodic only, every 30 ms)", default: true }),
};

const FATE_COLOR: Record<string, string> = { delivered: "var(--c3)", ttl: "var(--c4)", noroute: "var(--c2)", down: "var(--muted)", queue: "var(--c5)", "in flight": "var(--faint)" };
const FATE_LABEL: Record<string, string> = { delivered: "delivered", ttl: "looped until TTL 0", noroute: "no route", down: "lost on the dead link" };

export function NetIpConvergenceDemo() {
  const P = useParams("net-ip-conv", CV);
  const { detect, proto, cut, mode, triggered } = P.values;
  const cutLinks = cut === "one" ? [2] : [2, 5];
  const r = useMemo(() => convergenceRun({ ...CONV_DEFAULTS, proto, cut: cut === "one" ? [2] : [2, 5], detectMs: detect, dvMode: mode, triggered }), [proto, cut, detect, mode, triggered]);
  const t = CONV_TOPO;
  const nodes: TopoNode[] = t.names.map((n, i) => ({ id: i, label: n, x: t.pos[i]![0], y: t.pos[i]![1], color: i === 0 || i === 5 ? "var(--c1)" : undefined, sub: i === 0 ? "sender" : i === 5 ? "receiver" : undefined }));
  const links: TopoLink[] = t.links.map((l, i) => ({ a: l.a, b: l.b, label: `${l.cost}`, dashed: cutLinks.includes(i), color: cutLinks.includes(i) ? "var(--c4)" : undefined }));
  const W = CONV_DEFAULTS.until;
  const counts = new Map<string, number>();
  for (const d of r.data.filter((d) => d.t >= CONV_DEFAULTS.cutAt)) counts.set(d.fate, (counts.get(d.fate) ?? 0) + 1);
  const firstData = r.data[0]!;
  const sendAt = r.ip.net.trace.find((e) => e.kind === "send" && e.pkt.id === firstData.id)?.t ?? 0;
  const dataIds = new Set(r.data.map((d) => d.id));
  const st = fromPackets(r.ip.net, {
    filter: (p) => p.payload.proto !== "ctl" && dataIds.has(p.id) && p.createdAt - sendAt >= CONV_DEFAULTS.cutAt - 2 && p.createdAt - sendAt <= CONV_DEFAULTS.cutAt + 40,
    color: (p) => FATE_COLOR[r.ip.fate.get(p.id) ?? "in flight"],
  });
  const shift = (x: number) => x - sendAt;
  return (
    <Demo title="A link fails under traffic"
      controls={<>
        <Param spec={CV.detect} value={detect} onChange={(v) => P.set("detect", v as number)} />
        <Param spec={CV.proto} value={proto} onChange={(v) => P.set("proto", v as "ls")} />
        <Param spec={CV.cut} value={cut} onChange={(v) => P.set("cut", v as "one")} />
        {proto === "dv" && <Param spec={CV.mode} value={mode} onChange={(v) => P.set("mode", v as "plain")} />}
        {proto === "dv" && <Param spec={CV.triggered} value={triggered} onChange={(v) => P.set("triggered", v as boolean)} />}
      </>}
    >
      <TopoView nodes={nodes} links={links} height={170} />
      <SectionLabel>Each data packet from A to F, one per ms; the cut is at {CONV_DEFAULTS.cutAt} ms</SectionLabel>
      <svg viewBox={`0 0 ${W} 14`} width="100%" height={26} preserveAspectRatio="none" style={{ display: "block" }} role="img" aria-label="data packet fates">
        {r.data.map((d) => <rect key={d.id} x={d.t} y={0} width={0.8} height={14} fill={FATE_COLOR[d.fate] ?? "var(--faint)"} />)}
        <line x1={CONV_DEFAULTS.cutAt} x2={CONV_DEFAULTS.cutAt} y1={0} y2={14} stroke="var(--fg)" strokeWidth={0.4} />
      </svg>
      <Legend items={Object.entries(FATE_LABEL).map(([k, label]) => ({ label, color: FATE_COLOR[k]! }))} />
      <SectionLabel>Data packets around the cut (time from the first packet)</SectionLabel>
      <SpaceTime nodes={st.names} tStart={CONV_DEFAULTS.cutAt - 2} tEnd={CONV_DEFAULTS.cutAt + 60} rowHeight={30}
        messages={st.messages.map((m) => ({ ...m, sentAt: shift(m.sentAt), deliveredAt: m.deliveredAt === undefined ? undefined : shift(m.deliveredAt) }))}
        marks={st.marks.map((m) => ({ ...m, t: shift(m.t) }))} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "tables stable after the cut", value: `${(r.convergedAt - CONV_DEFAULTS.cutAt).toFixed(1)} ms` },
          { label: "data packets lost after the cut", value: r.lost },
          { label: "of them, caught in a loop", value: r.looped },
          { label: "routing packets after the cut", value: r.controlPackets },
        ]} />
      </div>
      <Banner tone={r.looped ? "bad" : r.lost > 20 ? "warn" : "good"}>
        {cut === "both"
          ? r.looped ? "F is cut off, but the routers keep pointing at each other while they count up to 16. Packets circle until their TTL runs out." : "F is cut off. Every packet after the cut is lost, but the routers learn it fast and drop packets at the first router."
          : `Packets die from the cut until the new tables are in place: detection takes ${detect} ms, then ${proto === "ls" ? "the LSAs flood and every router runs SPF" : "the distance vectors spread hop by hop"}.`}
      </Banner>
      {counts.size > 0 && <Note>After the cut: {[...counts].map(([k, v]) => `${v} ${FATE_LABEL[k] ?? k}`).join(", ")}.</Note>}
    </Demo>
  );
}
