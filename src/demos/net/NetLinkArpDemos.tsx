/** Demos for "ARP": one exchange on a switch, the neighbour cache over time, ARP spoofing, and IPv6's solicited-node trick. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Legend, MiniTable, Panel, Param, SmallLabel, Stats, StepCaption, Note, MONO, int, range, seg, toggle, useParams, GOOD, BAD } from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { Timeline, Topo, type Band, type Tick } from "./NetLinkUi";
import { formatIpv4, formatMac, type Packet } from "../../sims/net";
import {
  ARP_HOSTS, ARP_LAN, arpHostIp, arpRun, frameLabel, formatIpv6, lanReach, nudRun, parseIpv6, solicitedNode, solicitedNodeMac, spoofRun,
  type ArpAction, type Frame, type NeighState,
} from "../../sims/net/link";

// ============================================================================ 1. One ARP exchange

const colorOf = (f: Frame) => {
  const b = f.body;
  if (b.kind === "arp") return b.arp.op === 1 ? (b.arp.spa === b.arp.tpa ? "var(--c5)" : "var(--c2)") : "var(--c3)";
  return "var(--c1)";
};

const short = (mac?: string) => (mac ? `…${mac.slice(-5)}` : "?");

export function ArpExchangeDemo() {
  const [actions, setActions] = useState<ArpAction[]>([{ kind: "ping", from: 0, to: 2 }]);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(2);
  const lan = useMemo(() => arpRun(actions), [actions]);
  const k = actions.length - 1;
  const t0 = k * ARP_LAN.gapMs;
  const last = actions[k]!;
  const order = [0, 1, 4, 2, 3];
  const raw = fromPackets(lan.net, { nodes: order, label: (p: Packet<Frame>) => (p.src === 4 ? undefined : frameLabel(p.payload)), color: (p: Packet<Frame>) => colorOf(p.payload), filter: (p: Packet<Frame>) => p.createdAt >= t0 - 1e-9 });
  // Times relative to the step, in µs.
  const us = (t: number) => (t - t0) * 1000;
  const st = { ...raw, messages: raw.messages.map((m) => ({ ...m, sentAt: us(m.sentAt), deliveredAt: m.deliveredAt === undefined ? undefined : us(m.deliveredAt) })), marks: raw.marks.map((m) => ({ ...m, t: us(m.t) })) };
  const add = (a: ArpAction) => setActions([...actions.slice(-11), a]);
  // What happened in the last action.
  const inWin = lan.net.trace.filter((e) => e.kind === "tx" && e.t >= t0 - 1e-9);
  const arpReqs = inWin.filter((e) => e.kind === "tx" && lan.net.ports[e.port]!.node < 4 && e.pkt.payload.body.kind === "arp" && e.pkt.payload.body.arp.op === 1).length;
  const pong = last.kind === "ping" && lan.host(last.from).inbox.some((m) => m.t >= t0 && m.ip.data.startsWith("pong"));
  let caption: string;
  if (last.kind === "ping") {
    const A = ARP_HOSTS[last.from], C = ARP_HOSTS[last.to];
    if (last.from === last.to) caption = `${A} pings itself: no frame leaves the host.`;
    else if (!pong) caption = `${A} sent to a MAC that ${C} no longer has. The switch delivered the frame, but ${C}'s new NIC ignored it. ${A} will not ask again until its entry goes stale.`;
    else if (arpReqs) caption = `${A} had no usable entry for ${formatIpv4(arpHostIp(last.to))}. It broadcast one request, which every other host received. ${C} answered by unicast; the ping and pong then needed no ARP.`;
    else caption = `${A} already had ${C}'s MAC in its cache: no ARP at all. ${C} also knows ${A}, because it learned ${A} from the request.`;
  } else if (last.kind === "newnic") caption = `${ARP_HOSTS[last.host]} has a new MAC. Every cache that holds the old one now sends into the void.`;
  else if (last.kind === "garp") caption = `${ARP_HOSTS[last.host]} broadcast an announcement. Hosts that already had an entry for its IP updated it; the others ignored it.`;
  else caption = `${ARP_HOSTS[last.host]} forgot every dynamic entry (ip neigh flush).`;
  const sw = lan.sw(4);
  return (
    <Demo title="Who has 10.0.0.3?" actions={<Btn ghost onClick={() => setActions([{ kind: "ping", from: 0, to: 2 }])}>Start over</Btn>}>
      <ButtonRow style={{ marginBottom: 8 }}>
        <div className="seg">{ARP_HOSTS.map((h, i) => <button key={h} className={from === i ? "on" : ""} onClick={() => setFrom(i)}>{h}</button>)}</div>
        <span className="muted" style={{ fontSize: 12 }}>pings</span>
        <div className="seg">{ARP_HOSTS.map((h, i) => <button key={h} className={to === i ? "on" : ""} onClick={() => setTo(i)}>{h}</button>)}</div>
        <Btn onClick={() => add({ kind: "ping", from, to })}>Send</Btn>
      </ButtonRow>
      <ButtonRow style={{ marginBottom: 8 }}>
        <Btn onClick={() => add({ kind: "newnic", host: 2 })}>C gets a new NIC</Btn>
        <Btn onClick={() => add({ kind: "garp", host: 2 })}>C sends a gratuitous ARP</Btn>
        <Btn onClick={() => add({ kind: "flush", host: 0 })}>Flush A's cache</Btn>
      </ButtonRow>
      <SpaceTime nodes={st.names} tEnd={1200} messages={st.messages} marks={st.marks} rowHeight={38} timeLabel="µs since the step" />
      <Legend items={[{ label: "ARP request", color: "var(--c2)" }, { label: "ARP reply", color: "var(--c3)" }, { label: "gratuitous ARP", color: "var(--c5)" }, { label: "IP (ping, pong)", color: "var(--c1)" }]} />
      <StepCaption label={`step ${k + 1}`} tone={last.kind === "ping" && !pong && last.from !== last.to ? "bad" : "info"}>{caption}</StepCaption>
      <SmallLabel style={{ marginTop: 10 }}>ARP caches after this step (ip neigh)</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
        {ARP_HOSTS.map((h, i) => {
          const es = [...lan.host(i).neigh.values()];
          return (
            <Panel key={h} title={`${h} · ${formatIpv4(arpHostIp(i))} · ${short(lan.host(i).mac)}`}>
              {es.length === 0 ? <span className="muted" style={{ fontSize: 12 }}>empty</span> : es.map((e) => (
                <div key={e.ip} style={{ fontFamily: MONO, fontSize: 11.5, whiteSpace: "nowrap" }}>
                  .{e.ip & 0xff} {short(e.mac)} <span style={{ color: e.mac !== undefined && [0, 1, 2, 3].some((j) => lan.host(j).ip === e.ip && lan.host(j).mac !== e.mac) ? BAD : "var(--muted)" }}>{e.state}</span>
                </div>
              ))}
            </Panel>
          );
        })}
      </div>
      <Note>
        The switch's MAC table: {sw.entries(lan.now).map((e) => `${short(e.mac)} → port ${ARP_HOSTS[lan.net.ports[e.port]!.peer] ?? "?"}`).join(", ") || "empty"}.
 A red state marks an entry that points to a MAC its owner no longer has.
      </Note>
    </Demo>
  );
}

// ============================================================================ 2. The neighbour cache over time

const NC = {
  every: range({ label: "A sends a packet to B every", min: 0.5, max: 60, log: true, default: 2, format: (v) => `${v} s` }),
  base: range({ label: "base_reachable_time", min: 5, max: 60, step: 1, default: 30, format: (v) => `${v} s` }),
  confirm: toggle({ label: "TCP confirms that B answers (upper-layer hints)", default: false }),
  die: toggle({ label: "B's cable is cut at 100 s", default: false }),
};

export const STATE_COLOR: Record<NeighState, string> = {
  INCOMPLETE: "var(--c1)", REACHABLE: "var(--c3)", STALE: "var(--faint)", DELAY: "var(--c5)", PROBE: "var(--c2)", FAILED: "var(--c4)", PERMANENT: "var(--fg)",
};

export function NeighCacheDemo() {
  const P = useParams("net-arp-nud", NC);
  const { every, base, confirm, die } = P.values;
  const until = 180_000;
  const r = useMemo(() => nudRun({ intervalMs: every * 1000, untilMs: until, baseReachableMs: base * 1000, confirm, dieAtMs: die ? 100_000 : undefined }), [every, base, confirm, die]);
  const bands: Band[] = r.history.map((h, i) => ({ from: h.t, to: r.history[i + 1]?.t ?? until, color: STATE_COLOR[h.state], label: h.state }));
  const ticks: Tick[] = r.arp.map((a) => ({ t: a.t, color: a.broadcast ? "var(--c1)" : "var(--c2)", row: 0, shape: "dot", title: a.broadcast ? "broadcast request" : "unicast probe" }));
  return (
    <Demo
      title="A's entry for B, over three minutes"
      controls={<>
        <Param spec={NC.every} value={every} onChange={(v) => P.set("every", v as number)} />
        <Param spec={NC.base} value={base} onChange={(v) => P.set("base", v as number)} />
        <Param spec={NC.confirm} value={confirm} onChange={(v) => P.set("confirm", v as boolean)} />
        <Param spec={NC.die} value={die} onChange={(v) => P.set("die", v as boolean)} />
      </>}
    >
      <Timeline bands={bands} ticks={ticks} tEnd={until} rows={1} marks={die ? [{ t: 100_000, label: "cable cut" }] : []} />
      <Legend items={[{ label: "broadcast request", color: "var(--c1)" }, { label: "unicast probe", color: "var(--c2)" }]} />
      <Legend box items={(["REACHABLE", "STALE", "DELAY", "PROBE", "FAILED"] as NeighState[]).map((s) => ({ label: s, color: STATE_COLOR[s] }))} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "reachable time drawn", value: `${(r.reachableMs / 1000).toFixed(1)} s` },
          { label: "ARP requests sent", value: r.arp.length },
          { label: "probes (unicast)", value: r.arp.filter((a) => !a.broadcast).length },
          { label: "pongs / pings", value: `${r.pongs} / ${r.pings}` },
          { label: "dropped while unresolved", value: r.unresolved },
        ]} />
      </div>
      <Note>Linux picks the reachable time at random in [0.5, 1.5) × base_reachable_time, so the first green band changes length with the base. Other timers are the Linux defaults: delay_first_probe_time 5 s, retrans_time 1 s, 3 unicast probes.</Note>
    </Demo>
  );
}

// ============================================================================ 3. ARP spoofing

const SP = {
  attack: toggle({ label: "Attacker sends forged replies from 2 s", default: true }),
  forward: toggle({ label: "Attacker forwards the traffic (man in the middle)", default: true }),
  staticArp: toggle({ label: "Victim has a static entry for the gateway", default: false }),
  inspect: toggle({ label: "Switch runs dynamic ARP inspection", default: false }),
};

const PATH_COLOR = { direct: "var(--c3)", "via attacker": "var(--c4)", lost: "var(--faint)" } as const;

export function ArpSpoofDemo() {
  const P = useParams("net-arp-spoof", SP);
  const { attack, forward, staticArp, inspect } = P.values;
  const r = useMemo(() => spoofRun({ attack, forward, staticArp, inspect }), [attack, forward, staticArp, inspect]);
  const until = 8000;
  const bands: Band[] = r.entry.filter((e) => e.state !== "INCOMPLETE").map((e, i, a) => ({ from: e.t, to: a[i + 1]?.t ?? until, color: e.poisoned ? "var(--c4)" : "var(--c3)", label: e.poisoned ? "gateway → attacker's MAC" : "gateway → real MAC" }));
  const ticks: Tick[] = r.path.map((p) => ({ t: p.t, color: PATH_COLOR[p.path], row: 0, shape: p.path === "lost" ? "cross" : "dot", title: p.path }));
  const poisoned = r.entry.some((e) => e.poisoned);
  const via = r.count("via attacker"), lost = r.count("lost"), direct = r.count("direct");
  const hot = poisoned && forward;
  const nodes = [
    { id: 0, label: "victim", x: 0, y: 0.25, kind: "host" as const, sub: ".10" },
    { id: 3, label: "switch", x: 0.5, y: 0.25, kind: "switch" as const },
    { id: 1, label: "gateway", x: 1, y: 0.25, kind: "host" as const, sub: ".1" },
    { id: 2, label: "attacker", x: 0.5, y: 0.95, kind: "host" as const, sub: ".66", color: poisoned ? BAD : undefined, strong: poisoned },
  ];
  return (
    <Demo
      title="Poison the victim's cache"
      controls={<>
        <Param spec={SP.attack} value={attack} onChange={(v) => P.set("attack", v as boolean)} />
        <Param spec={SP.forward} value={forward} onChange={(v) => P.set("forward", v as boolean)} />
        <Param spec={SP.staticArp} value={staticArp} onChange={(v) => P.set("staticArp", v as boolean)} />
        <Param spec={SP.inspect} value={inspect} onChange={(v) => P.set("inspect", v as boolean)} />
      </>}
    >
      <Topo height={150} nodes={nodes} links={[
        { a: 0, b: 3, color: poisoned ? BAD : GOOD, width: 2.4 },
        { a: 3, b: 1, color: !poisoned || hot ? GOOD : "var(--faint)", width: !poisoned || hot ? 2.4 : 1.4 },
        { a: 3, b: 2, color: poisoned ? BAD : "var(--faint)", width: poisoned ? 2.4 : 1.4, dashed: !poisoned },
      ]} />
      <SmallLabel style={{ marginTop: 10 }}>Victim's entry for 10.0.0.1, and its packets to 8.8.8.8 (one every 250 ms)</SmallLabel>
      <Timeline bands={bands} ticks={ticks} tEnd={until} rows={1} marks={attack ? [{ t: 2000, label: "attack" }] : []} />
      <Legend items={[{ label: "reached the gateway directly", color: PATH_COLOR.direct }, { label: "went through the attacker", color: PATH_COLOR["via attacker"] }, { label: "lost", color: PATH_COLOR.lost }]} />
      <Banner tone={!poisoned ? "good" : forward ? "warn" : "bad"}>
        {!attack ? "No attack: every packet goes straight to the gateway."
          : staticArp ? "The static entry never changes, so the forged replies do nothing. The cost: someone must update it by hand when the gateway changes."
          : inspect ? "The switch checks each ARP packet against its DHCP snooping table. The forged replies never reach the victim."
          : forward ? `After one forged reply the victim's packets flow through the attacker, who passes them on. The victim sees no outage: ${via} packets were readable by the attacker.`
          : `The attacker takes the packets and drops them: ${lost} packets lost. This is a denial of service.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[{ label: "direct", value: direct }, { label: "through the attacker", value: via }, { label: "lost", value: lost }]} />
      </div>
      <Note>Nothing in ARP proves who sent a reply. The victim takes the newest answer, because a host must accept a changed MAC: a new NIC or a failover is legitimate.</Note>
    </Demo>
  );
}

// ============================================================================ 4. IPv6: the solicited-node multicast address

const SN = {
  addr: seg("Target address", [["2001:db8::1:2:3", "2001:db8::1:2:3"], ["fe80::3c22:fbff:fe12:3456", "fe80::…fe12:3456"], ["2001:db8:0:1::abcd:ef01", "2001:db8:0:1::abcd:ef01"]], "fe80::3c22:fbff:fe12:3456"),
  hosts: range({ label: "Hosts on the LAN", min: 10, max: 5000, log: true, default: 500, format: (v) => int(v) }),
};

export function SolicitedNodeDemo() {
  const P = useParams("net-arp-ndp", SN);
  const { addr, hosts } = P.values;
  const a = parseIpv6(addr);
  const low = [...a.slice(13)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sn = solicitedNode(a);
  const reach = lanReach(Math.round(hosts), 7);
  return (
    <Demo
      title="Where a Neighbor Solicitation goes"
      controls={<>
        <Param spec={SN.addr} value={addr} onChange={(v) => P.set("addr", v as typeof addr)} />
        <Param spec={SN.hosts} value={hosts} onChange={(v) => P.set("hosts", v as number)} />
      </>}
    >
      <MiniTable head={["step", "value"]} rows={[
        ["target address", <span style={{ fontFamily: MONO }}>{formatIpv6(a)}</span>],
        ["its low 24 bits", <span style={{ fontFamily: MONO, color: "var(--c4)" }}>{low}</span>],
        ["solicited-node group (ff02::1:ff00:0/104 + low 24)", <span style={{ fontFamily: MONO }}>{formatIpv6(sn)}</span>],
        ["Ethernet destination (33:33 + low 32 bits)", <span style={{ fontFamily: MONO }}>{formatMac(solicitedNodeMac(a))}</span>],
      ]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "hosts that must process an ARP request", value: int(reach.arp) },
          { label: "other hosts that must process this NS", value: int(reach.ndp) },
        ]} />
      </div>
      <Note>A NIC filters multicast MACs in hardware. Only hosts that joined this group (their address ends in the same 24 bits) pass the NS to the CPU. The host counts use random interface identifiers.</Note>
    </Demo>
  );
}
