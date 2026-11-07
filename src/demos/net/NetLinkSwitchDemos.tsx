/** Demos for "Switches and VLANs": a learning switch, a broadcast storm, spanning tree election and failover, VLANs. */
import { useMemo, useState } from "react";
import { Banner, Bars, Btn, ButtonRow, Demo, MiniTable, Param, Plot, SectionLabel, SmallLabel, Stats, StepCaption, Note, int, pct, range, seg, toggle, useParams, GOOD, BAD } from "../../kit";
import { HeaderDiagram } from "./PacketViews";
import { Timeline, Topo, type Band, type TopoLink, type TopoNode } from "./NetLinkUi";
import { formatMac } from "../../sims/net";
import {
  ETHERTYPE, LEARN_HOSTS, STORM_LINKS, STP_LINKS, STP_NAMES, VLAN_HOSTS, VLAN_OF, ethHeaderFields, learnRun, mac, parseMac, stormRun, stpRun, vlanRun,
  type LearnAction, type StormTopo,
} from "../../sims/net/link";

// ============================================================================ 1. A learning switch

const LS = {
  aging: range({ label: "Ageing time", min: 10, max: 600, step: 10, default: 300, format: (v) => `${v} s` }),
};

const HOST_POS: [number, number][] = [[0.05, 0.1], [0.95, 0.1], [0.05, 0.9], [0.95, 0.9]];

export function LearningSwitchDemo() {
  const P = useParams("net-sw-learn", LS);
  const { aging } = P.values;
  const [actions, setActions] = useState<LearnAction[]>([{ kind: "send", from: 0, to: 1 }]);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState<number | "all">(1);
  const steps = useMemo(() => learnRun(actions, aging * 1000), [actions, aging]);
  const step = steps[steps.length - 1]!;
  const a = step.action;
  const add = (x: LearnAction) => setActions([...actions.slice(-15), x]);
  const send = a.kind === "send" ? a : undefined;
  const nodes: TopoNode[] = [
    { id: 4, label: "switch", x: 0.5, y: 0.5, kind: "switch" },
    ...LEARN_HOSTS.map((h, i): TopoNode => ({ id: i, label: h, x: HOST_POS[i]![0], y: HOST_POS[i]![1], kind: "host", sub: `…${mac(0xa0 + i).slice(-5)}`, strong: send?.from === i, color: send?.from === i ? "var(--c1)" : undefined })),
  ];
  const links: TopoLink[] = LEARN_HOSTS.map((_, i) => {
    const isSrc = send?.from === i, got = step.reached.includes(i);
    const color = isSrc ? "var(--c1)" : !got ? "var(--border)" : send?.to === i || send?.to === "all" || !step.flooded ? GOOD : "var(--c2)";
    return { a: i, b: 4, color, width: isSrc || got ? 2.6 : 1.2 };
  });
  const floods = steps.filter((s) => s.action.kind === "send" && s.flooded).length;
  const sends = steps.filter((s) => s.action.kind === "send").length;
  let caption: string;
  if (!send) caption = `${(a as { ms: number }).ms / 1000} s pass with no traffic. Entries older than the ageing time are gone.`;
  else if (send.to === "all") caption = `A broadcast: the switch always floods it to every port except the one it came in on.`;
  else if (step.flooded) caption = `The switch does not know where ${LEARN_HOSTS[send.to]} is, so it floods the frame. ${step.reached.filter((r) => r !== send.to).map((r) => LEARN_HOSTS[r]).join(" and ")} drop it in their NICs. It learns that ${LEARN_HOSTS[send.from]} is on port ${LEARN_HOSTS[send.from]}.`;
  else caption = `The switch knows ${LEARN_HOSTS[send.to]}'s port, so the frame goes out on that port only.`;
  return (
    <Demo
      title="A switch learns from source addresses"
      actions={<Btn ghost onClick={() => setActions([{ kind: "send", from: 0, to: 1 }])}>Start over</Btn>}
      controls={<Param spec={LS.aging} value={aging} onChange={(v) => P.set("aging", v as number)} />}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <div className="seg">{LEARN_HOSTS.map((h, i) => <button key={h} className={from === i ? "on" : ""} onClick={() => setFrom(i)}>{h}</button>)}</div>
        <span className="muted" style={{ fontSize: 12 }}>sends to</span>
        <div className="seg">
          {LEARN_HOSTS.map((h, i) => <button key={h} className={to === i ? "on" : ""} onClick={() => setTo(i)}>{h}</button>)}
          <button className={to === "all" ? "on" : ""} onClick={() => setTo("all")}>all</button>
        </div>
        <Btn onClick={() => add({ kind: "send", from, to })} disabled={to === from}>Send</Btn>
        <Btn ghost onClick={() => add({ kind: "wait", ms: 120_000 })}>Wait 2 min</Btn>
      </ButtonRow>
      <Topo nodes={nodes} links={links} height={190} />
      <StepCaption label={`step ${steps.length}`} tone={send ? (step.flooded ? "warn" : "good") : "info"}>{caption}</StepCaption>
      <SectionLabel>MAC table</SectionLabel>
      {step.table.length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>empty</div> : (
        <MiniTable head={["MAC", "port", "age"]} rows={step.table.map((e) => [mac(0xa0 + e.host), LEARN_HOSTS[e.host], `${(e.ageMs / 1000).toFixed(e.ageMs < 1000 ? 3 : 0)} s`])} />
      )}
      <Note>{floods} of {sends} frames so far were flooded. A switch floods unknown unicast, broadcast and (without IGMP snooping) multicast.</Note>
    </Demo>
  );
}

// ============================================================================ 2. A broadcast storm

const ST = {
  topo: seg("Topology", [["line", "line (no loop)"], ["triangle", "triangle"], ["mesh", "4 switches, full mesh"]], "triangle"),
  stp: toggle({ label: "Run spanning tree (STP)", default: false }),
};

const SW_POS: Record<StormTopo, [number, number][]> = {
  line: [[0.1, 0.3], [0.5, 0.3], [0.9, 0.3]],
  triangle: [[0.5, 0.05], [0.15, 0.6], [0.85, 0.6]],
  mesh: [[0.25, 0.05], [0.75, 0.05], [0.25, 0.65], [0.75, 0.65]],
};

const HOST_OFF: Record<StormTopo, [number, number][]> = {
  line: [[0, 0.45], [0, 0.45], [0, 0.45]],
  triangle: [[0.22, 0], [-0.1, 0.35], [0.1, 0.35]],
  mesh: [[-0.2, 0], [0.2, 0], [-0.2, 0.3], [0.2, 0.3]],
};

export function StormDemo() {
  const P = useParams("net-sw-storm", ST);
  const { topo, stp } = P.values;
  const r = useMemo(() => stormRun({ topo, stp, watchMs: 0.5 }), [topo, stp]);
  const k = r.switches;
  const pos = SW_POS[topo];
  const nodes: TopoNode[] = [
    ...pos.map(([x, y], i): TopoNode => ({ id: i, label: `S${i + 1}`, x, y, kind: "switch" })),
    ...pos.map(([x, y], i): TopoNode => ({ id: k + i, label: `H${i + 1}`, x: x + HOST_OFF[topo][i]![0], y: y + HOST_OFF[topo][i]![1], kind: "host", strong: i === 0, color: i === 0 ? "var(--c1)" : undefined })),
  ];
  const isBlocked = (a: number, b: number) => r.blockedLinks.some(([x, y]) => x === Math.min(a, b) && y === Math.max(a, b));
  const storm = r.copiesAtH2 > 1;
  const links: TopoLink[] = [
    ...STORM_LINKS[topo].map(([a, b]): TopoLink => ({ a, b, dashed: isBlocked(a, b), color: isBlocked(a, b) ? "var(--faint)" : storm ? BAD : "var(--fg)", width: storm ? 2.4 : 1.6, label: isBlocked(a, b) ? "blocked" : undefined })),
    ...pos.map((_, i): TopoLink => ({ a: i, b: k + i })),
  ];
  const usPerBucket = r.bucketMs * 1000;
  return (
    <Demo
      title="One broadcast, a loop, no TTL"
      controls={<>
        <Param spec={ST.topo} value={topo} onChange={(v) => P.set("topo", v as StormTopo)} />
        <Param spec={ST.stp} value={stp} onChange={(v) => P.set("stp", v as boolean)} />
      </>}
    >
      <Topo nodes={nodes} links={links} height={200} />
      <SmallLabel style={{ marginTop: 10 }}>Frames arriving at switches after H1's single broadcast, on 1 Gb/s links</SmallLabel>
      <Plot x={[0, 500]} y={[0, Math.max(5, ...r.buckets.map((b) => b.frames)) * 1.1]} height={160} xLabel="µs after the broadcast" yLabel={`frames per ${usPerBucket} µs`}>
        <Bars bins={r.buckets.map((b) => ({ x0: b.t * 1000, x1: b.t * 1000 + usPerBucket * 0.9, y: b.frames }))} color={storm ? BAD : GOOD} />
      </Plot>
      <Banner tone={storm ? "bad" : "good"}>
        {storm
          ? `In 0.5 ms H2 received ${int(r.copiesAtH2)} copies of one broadcast. The copies never die: Ethernet has no TTL. Switches also see H1's address move between ports ${int(r.moves)} times, so their MAC tables thrash.`
          : stp ? `STP blocked ${r.blockedLinks.length} link end(s). The broadcast reaches each host once and then stops.` : "With no loop, the broadcast reaches each host once and then stops."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "copies at H2", value: int(r.copiesAtH2) },
          { label: "MAC moves", value: int(r.moves) },
          { label: "busiest link busy", value: pct(r.utilization, 0) },
          { label: "dropped at full queues", value: int(r.queueDrops) },
        ]} />
      </div>
      {stp && <Note>STP needed {r.startMs / 1000 - 2} s (listening + learning) before any switch port forwarded. The broadcast went out after that.</Note>}
    </Demo>
  );
}

// ============================================================================ 3. Spanning tree: election and failover

const SP = {
  root: seg("Priority 4096 (others 32768)", [["none", "nobody"], ["0", "S1"], ["1", "S2"], ["2", "S3"], ["3", "S4"]], "none"),
  cut: seg("At 40 s, cut", [["-1", "nothing"], ["0", "S1–S2"], ["1", "S1–S3"], ["2", "S2–S4"], ["3", "S3–S4"], ["4", "S2–S3"]], "0"),
  rapid: toggle({ label: "Rapid mode (no listening and learning wait, RSTP-like)", default: false }),
  view: seg("Show the tree", [["before", "before the cut"], ["after", "at the end"]], "before"),
};

const STP_POS: [number, number][] = [[0.2, 0.08], [0.8, 0.08], [0.2, 0.72], [0.8, 0.72]];
const ROLE_TAG: Record<string, string> = { root: "R", designated: "D", alternate: "B", edge: "" };

export function StpDemo() {
  const P = useParams("net-sw-stp", SP);
  const { root, cut, rapid, view } = P.values;
  const cutN = Number(cut);
  const priorities = STP_NAMES.map((_, i) => (String(i) === root ? 4096 : 32768));
  const r = useMemo(() => stpRun({ priorities, cut: cutN, rapid }), [root, cutN, rapid]); // eslint-disable-line react-hooks/exhaustive-deps
  const ports = view === "before" ? r.before : r.ports;
  const roleAt = (sw: number, peer: number) => ports.find((p) => p.sw === sw && p.peer === peer);
  const nodes: TopoNode[] = [
    ...STP_NAMES.map((n, i): TopoNode => ({ id: i, label: n, x: STP_POS[i]![0], y: STP_POS[i]![1], kind: "switch", strong: r.root === i, color: r.root === i ? "var(--c3)" : undefined, sub: r.root === i ? `root · prio ${priorities[i]}` : `prio ${priorities[i]}` })),
    { id: 4, label: "A", x: 0.98, y: 1, kind: "host" },
    { id: 5, label: "B", x: 0.02, y: -0.08, kind: "host" },
  ];
  const links: TopoLink[] = [
    ...STP_LINKS.map(([a, b], i): TopoLink => {
      const ra = roleAt(a, b), rb = roleAt(b, a);
      const isCut = view === "after" && i === cutN;
      const blocked = ra?.role === "alternate" || rb?.role === "alternate";
      return {
        a, b, cut: isCut, dashed: blocked || isCut, color: isCut ? "var(--faint)" : blocked ? "var(--faint)" : "var(--c3)", width: blocked || isCut ? 1.4 : 2.6,
        aEnd: isCut ? undefined : ROLE_TAG[ra?.role ?? ""], bEnd: isCut ? undefined : ROLE_TAG[rb?.role ?? ""],
      };
    }),
    { a: 3, b: 4 },
    { a: 0, b: 5 },
  ];
  const until = 110_000;
  const bands: Band[] = [];
  for (const p of r.pings) {
    const last = bands[bands.length - 1];
    if (last && (last.color === GOOD) === p.ok) last.to = p.t + 500;
    else bands.push({ from: p.t, to: p.t + 500, color: p.ok ? GOOD : BAD, label: p.ok ? "pings answered" : "no answer" });
  }
  return (
    <Demo
      title="Elect a root, block the loops, survive a cut"
      controls={<>
        <Param spec={SP.root} value={root} onChange={(v) => P.set("root", v as typeof root)} />
        <Param spec={SP.cut} value={cut} onChange={(v) => P.set("cut", v as typeof cut)} />
        <Param spec={SP.view} value={view} onChange={(v) => P.set("view", v as typeof view)} />
        <Param spec={SP.rapid} value={rapid} onChange={(v) => P.set("rapid", v as boolean)} />
      </>}
    >
      <Topo nodes={nodes} links={links} height={230} />
      <Note>R: root port (best path to the root). D: designated port (the one port that serves a link). B: blocked (an alternate port). Dashed links carry no data.</Note>
      <SmallLabel style={{ marginTop: 10 }}>A pings B every 500 ms</SmallLabel>
      <Timeline bands={bands} tEnd={until} rows={0} marks={cutN >= 0 ? [{ t: 40_000, label: "cut" }] : []} />
      <Banner tone={cutN < 0 || r.outageMs === 0 ? "good" : r.outageMs > 35_000 ? "bad" : "warn"}>
        {cutN < 0 ? `Before any port forwards, STP waits ${(r.firstForwardMs / 1000).toFixed(0)} s: no traffic flows at all at the start.`
          : r.outageMs === 0 ? "The cut link was a blocked one: nothing changes for traffic."
          : `The cut stops traffic for ${(r.outageMs / 1000).toFixed(1)} s. ${rapid ? "Rapid mode moves a port to forwarding at once." : r.outageMs > 35_000 ? "A switch that did not see the failure waits for the stored information to reach max age (20 s), then 2 × 15 s." : "The switch next to the failure uses its blocked port at once, but the port still needs 2 × 15 s of listening and learning."}`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "root bridge", value: STP_NAMES[r.root]! },
          { label: "first port forwards at", value: `${(r.firstForwardMs / 1000).toFixed(0)} s` },
          { label: "outage after the cut", value: `${(r.outageMs / 1000).toFixed(1)} s` },
          { label: "root path cost S1..S4", value: r.rootCost.join(" · ") },
        ]} />
      </div>
      <SectionLabel>What the switches did after the cut</SectionLabel>
      <MiniTable head={["time", "event"]} rows={r.events.filter((e) => e.t >= 40_000 && !e.text.startsWith("no answer")).slice(0, 8).map((e) => [`${(e.t / 1000).toFixed(1)} s`, e.text])} />
    </Demo>
  );
}

// ============================================================================ 4. VLANs

const VL = {
  from: seg("Broadcast from", [["0", "A (VLAN 10)"], ["1", "B (VLAN 20)"], ["2", "C (VLAN 10)"], ["3", "D (VLAN 20)"]], "0"),
  uplink: seg("S1–S2 link", [["trunk", "trunk: 10 and 20"], ["only10", "trunk: 10 only"], ["access", "access port, VLAN 10"]], "trunk"),
  mismatch: toggle({ label: "Native VLAN mismatch: S1 uses 10, S2 uses 20", default: false }),
};

const VLAN_COLOR: Record<number, string> = { 10: "var(--c1)", 20: "var(--c5)" };

export function VlanDemo() {
  const P = useParams("net-sw-vlan", VL);
  const { from, uplink, mismatch } = P.values;
  const f = Number(from);
  const r = useMemo(() => vlanRun({ from: f, uplink, nativeMismatch: mismatch }), [f, uplink, mismatch]);
  const pos: [number, number][] = [[0.03, 0.95], [0.4, 0.95], [0.6, 0.95], [0.97, 0.95]];
  const nodes: TopoNode[] = [
    { id: 10, label: "S1", x: 0.22, y: 0.15, kind: "switch" },
    { id: 11, label: "S2", x: 0.78, y: 0.15, kind: "switch" },
    ...VLAN_HOSTS.map((h, i): TopoNode => ({ id: i, label: h, x: pos[i]![0], y: pos[i]![1], kind: "host", sub: `VLAN ${VLAN_OF[i]}`, color: VLAN_COLOR[VLAN_OF[i]!], strong: i === f || r.heard.includes(i), faint: i !== f && !r.heard.includes(i) })),
  ];
  const leak = r.heard.some((h) => VLAN_OF[h] !== VLAN_OF[f]);
  const links: TopoLink[] = [
    { a: 10, b: 11, width: 3, color: r.uplink ? "var(--fg)" : "var(--faint)", label: r.uplink ? (r.uplink.vid !== undefined ? `tagged, VID ${r.uplink.vid}` : "untagged") : "nothing crosses" },
    { a: 0, b: 10, color: VLAN_COLOR[10] }, { a: 1, b: 10, color: VLAN_COLOR[20] }, { a: 2, b: 11, color: VLAN_COLOR[10] }, { a: 3, b: 11, color: VLAN_COLOR[20] },
  ];
  const fields = ethHeaderFields({ dst: parseMac("ff:ff:ff:ff:ff:ff"), src: parseMac(mac(0xa0 + f)), vlan: r.uplink?.vid !== undefined ? { pcp: 0, dei: 0, vid: r.uplink.vid } : undefined, etherType: ETHERTYPE.ipv4, payload: new Uint8Array(46) });
  const values = fields.map((x) => (x.value instanceof Uint8Array ? formatMac(x.value) : x.name === "EtherType" || x.name === "TPID" ? `0x${Number(x.value).toString(16).padStart(4, "0")}` : String(x.value)));
  return (
    <Demo
      title="Two VLANs on two switches"
      controls={<>
        <Param spec={VL.from} value={from} onChange={(v) => P.set("from", v as typeof from)} />
        <Param spec={VL.uplink} value={uplink} onChange={(v) => P.set("uplink", v as typeof uplink)} />
        <Param spec={VL.mismatch} value={mismatch} onChange={(v) => P.set("mismatch", v as boolean)} />
      </>}
    >
      <Topo nodes={nodes} links={links} height={190} />
      <Banner tone={leak ? "bad" : r.heard.length ? "good" : "warn"}>
        {r.heard.length === 0 ? `Nobody else hears ${VLAN_HOSTS[f]}: the S1–S2 link does not carry VLAN ${VLAN_OF[f]}${r.dropped ? " (a switch dropped the frame)" : ""}.`
          : leak ? `${r.heard.map((h) => VLAN_HOSTS[h]).join(", ")} heard it, but the sender is in VLAN ${VLAN_OF[f]}. The frame crossed untagged, and S2 put it in its own native VLAN: a leak between VLANs.`
          : `Only ${r.heard.map((h) => VLAN_HOSTS[h]).join(", ")} heard the broadcast: the same VLAN on the other switch. The other VLAN never sees it.`}
      </Banner>
      {r.uplink && (
        <>
          <SectionLabel>Header of the frame on the S1–S2 link ({r.uplink.dir}, {r.uplink.bytes} bytes)</SectionLabel>
          <HeaderDiagram fields={fields} values={values} rowBits={48} />
        </>
      )}
      <Note>An access port belongs to one VLAN and sends untagged frames. A trunk carries many VLANs and tags each frame, except frames of its native VLAN, which cross untagged. Both ends must agree on the native VLAN.</Note>
    </Demo>
  );
}
