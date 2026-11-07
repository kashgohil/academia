/** Demos for "VPNs": tunnel bytes and MTU, TCP over TCP, WireGuard's timers and roaming, and what a VPN hides. */
import { useMemo, useState } from "react";
import { Banner, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleY, SmallLabel, StackBar, Stats, int, mono, range, seg, select, tint, toggle, useChunked, useParams, useWidth } from "../../kit";
import {
  OBSERVER_LABEL, TUNNEL_LABEL, VPN_CONFIG_LABEL, VPN_PEERS, exposureMatrix, maxInner, meltdownRun, tunnelPath, wgAcceptFrom, wgRoute, wgSessionRun,
  type Observer, type Part, type TunnelKind, type VpnConfig, type WgEvent,
} from "../../sims/net/security";

// ============================================================================ 1. Tunnel bytes and MTU

const PART_COLOR: Record<Part, string> = { outer: "var(--c2)", tunnel: "var(--c5)", inner: "var(--c1)", pad: "var(--faint)", tag: "var(--c3)" };

const TN = {
  inner: range({ label: "Inner IP packet", min: 40, max: 1500, step: 4, default: 1500, format: (v) => `${v} B` }),
  kind: select<TunnelKind>({ label: "Tunnel", options: (Object.keys(TUNNEL_LABEL) as TunnelKind[]).map((k) => ({ value: k, label: TUNNEL_LABEL[k] })), default: "wg4" }),
  mtu: seg<"1500" | "1492" | "1280">("Path MTU", [["1500", "1500 Ethernet"], ["1492", "1492 PPPoE"], ["1280", "1280"]], "1500"),
  df: toggle({ label: "Outer packet has DF set", default: true }),
};

export function NetSecTunnelDemo() {
  const P = useParams("net-sec-tun", TN);
  const { inner, kind, mtu, df } = P.values;
  const pathMtu = Number(mtu);
  const r = tunnelPath(kind, inner, pathMtu, df);
  const tone = r.outcome === "fits" ? "good" : r.outcome === "fragmented" ? "warn" : "bad";
  const text = r.outcome === "fits"
    ? `The ${r.outer}-byte outer packet fits the ${pathMtu}-byte path.`
    : r.outcome === "fragmented"
      ? `${r.outer} bytes do not fit. A router cuts the outer packet into ${r.fragments.length} IPv4 fragments (${r.fragments.map((f) => f.packetLen).join(" + ")} bytes); the far gateway must reassemble them, and a lost fragment loses the whole packet.`
      : `${r.outer} bytes do not fit, and the outer packet ${kind === "wg6" ? "is IPv6, which routers never fragment" : "has DF set"}. The router drops it and sends its ICMP error to the tunnel gateway, not to the inner sender. The sender hears nothing: a black hole.`;
  const kinds = Object.keys(TUNNEL_LABEL) as TunnelKind[];
  return (
    <Demo
      title="What a tunnel adds to each packet"
      controls={<>
        <Param spec={TN.inner} value={inner} onChange={(v) => P.set("inner", v as number)} />
        <Param spec={TN.kind} value={kind} onChange={(v) => P.set("kind", v as TunnelKind)} />
        <Param spec={TN.mtu} value={mtu} onChange={(v) => P.set("mtu", v as "1500")} />
        <Param spec={TN.df} value={df} onChange={(v) => P.set("df", v as boolean)} />
      </>}
    >
      <SmallLabel>The outer packet, outermost header first ({r.outer} B; the path MTU is the dashed end)</SmallLabel>
      <div style={{ position: "relative" }}>
        <StackBar total={Math.max(r.outer, pathMtu)} height={26} parts={r.layers.map((l) => ({ value: l.bytes, color: PART_COLOR[l.part], label: `${l.name}: ${l.bytes} B` }))} />
        <div style={{ position: "absolute", top: -3, bottom: -3, left: `${(pathMtu / Math.max(r.outer, pathMtu)) * 100}%`, borderLeft: "2px dashed var(--c4)" }} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", marginTop: 6, fontSize: 12 }}>
        {r.layers.map((l, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: PART_COLOR[l.part] }} />
            {l.name} <b style={mono}>{l.bytes}</b>{l.enc ? <span style={{ color: "var(--muted)" }}>(encrypted)</span> : null}
          </span>
        ))}
      </div>
      <Banner tone={tone}>{text}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "bytes added", value: r.overhead },
          { label: "largest inner packet that fits", value: maxInner(kind, pathMtu) },
          { label: "inner TCP MSS to clamp to", value: r.clampMss },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>Every tunnel on this {pathMtu}-byte path</SmallLabel>
      <MiniTable head={["tunnel", "added to a 1400-B packet", "largest inner packet"]} highlight={kinds.indexOf(kind)} rows={kinds.map((k) => [TUNNEL_LABEL[k], tunnelPath(k, 1400, 9000, true).overhead, maxInner(k, pathMtu)])} />
      <Note>WireGuard pads the inner packet to a multiple of 16 bytes, so its cost moves with the size. Its default interface MTU is 1420: room for an IPv6 outer header on a 1500-byte path.</Note>
    </Demo>
  );
}

// ============================================================================ 2. TCP over TCP

const MD = {
  loss: range({ label: "Loss on the WAN link", min: 0, max: 0.05, step: 0.005, default: 0.02, format: (v) => `${(v * 100).toFixed(1)}%` }),
  bulk: toggle({ label: "A bulk download shares the tunnel", default: true }),
};

export function NetSecMeltdownDemo() {
  const P = useParams("net-sec-melt", MD);
  const { loss, bulk } = P.values;
  const [udp, tcp] = useChunked(`melt-${loss}-${bulk}`, [() => meltdownRun({ tunnel: "udp", loss, voice: true, bulk }), () => meltdownRun({ tunnel: "tcp", loss, voice: true, bulk })], { keep: true });
  const maxD = Math.max(200, ...(tcp?.voiceDelay.map((d) => d[1]) ?? [0]), ...(udp?.voiceDelay.map((d) => d[1]) ?? [0]));
  const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(1) : "0.0"}%`;
  return (
    <Demo
      title="A voice call through a UDP tunnel and a TCP tunnel"
      controls={<>
        <Param spec={MD.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
        <Param spec={MD.bulk} value={bulk} onChange={(v) => P.set("bulk", v as boolean)} />
      </>}
    >
      <Plot x={[0, 20]} y={[0, Math.ceil(maxD / 100) * 100]} height={220} xLabel="time (s)" yLabel="voice packet delay (ms)">
        <RuleY at={150} label="150 ms" color="var(--c4)" />
        {udp && <Line points={udp.voiceDelay} color="var(--c3)" width={1.5} />}
        {tcp && <Line points={tcp.voiceDelay} color="var(--c2)" width={1.5} />}
      </Plot>
      <Legend items={[{ label: "UDP tunnel (WireGuard style)", color: "var(--c3)" }, { label: "TCP tunnel (OpenVPN over TCP style)", color: "var(--c2)" }]} />
      <MiniTable head={["", "UDP tunnel", "TCP tunnel"]} rows={[
        ["voice packets lost", udp ? pct(udp.voice.lost, udp.voice.sent) : "…", tcp ? pct(tcp.voice.lost, tcp.voice.sent) : "…"],
        ["voice packets later than 150 ms", udp ? pct(udp.voice.late, udp.voice.sent) : "…", tcp ? pct(tcp.voice.late, tcp.voice.sent) : "…"],
        ...(bulk ? [
          ["bulk goodput", udp ? `${udp.goodputMbps.toFixed(2)} Mbit/s` : "…", tcp ? `${tcp.goodputMbps.toFixed(2)} Mbit/s` : "…"],
          ["inner retransmissions of data that was not lost", udp ? int(udp.inner.spurious) : "…", tcp ? int(tcp.inner.spurious) : "…"],
          ["inner timeouts / outer timeouts", udp ? `${udp.inner.timeouts} / –` : "…", tcp ? `${tcp.inner.timeouts} / ${tcp.outer.timeouts}` : "…"],
        ] : []),
      ]} />
      <Banner tone={!tcp || !udp ? "plain" : tcp.voice.late > udp.voice.lost + udp.voice.late ? "bad" : "plain"}>
        {loss === 0
          ? "No loss: both tunnels behave the same, apart from the queue each builds."
          : "The UDP tunnel loses a voice packet now and then, and the next one is on time. The TCP tunnel loses almost nothing, but every WAN loss holds back every packet behind it until the outer TCP repairs it."}
      </Banner>
      <Note>Model inputs: a 10 Mbit/s WAN with a 20 ms one-way delay, random loss, a tunnel queue of 64 KB, 20 s runs. Voice: 200-byte packets every 20 ms. Both TCPs are the reference TCP with Reno. A voice packet later than 150 ms counts as late (a model input for the player's delay budget).</Note>
    </Demo>
  );
}

// ============================================================================ 3. WireGuard sessions, keepalives and roaming

const WG = {
  roam: range({ label: "Laptop leaves Wi-Fi for LTE at", min: 0, max: 280, step: 5, default: 155, format: (v) => (v === 0 ? "never" : `${v} s`) }),
  pk: seg<"0" | "25">("PersistentKeepalive", [["0", "off"], ["25", "25 s"]], "0"),
  push: range({ label: "Server pushes a message every (model input)", min: 5, max: 60, step: 5, default: 20, format: (v) => `${v} s` }),
  nat: range({ label: "NAT forgets an idle mapping after (model input)", min: 10, max: 120, step: 5, default: 30, format: (v) => `${v} s` }),
};

const KIND_COLOR: Record<WgEvent["kind"], string> = { init: "var(--c5)", resp: "var(--c5)", data: "var(--c1)", keepalive: "var(--c3)" };

export function NetSecWireGuardDemo() {
  const P = useParams("net-sec-wg", WG);
  const { roam, pk, push, nat } = P.values;
  const r = useMemo(() => wgSessionRun({ roamAt: roam, persistentKeepalive: Number(pk), serverEvery: push, natTimeoutS: nat }), [roam, pk, push, nat]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(300, width), L = 62, R = 8, T = 300;
  const x = (t: number) => L + (t / T) * (W - L - R);
  const lanes = [{ name: "laptop →", y: 26, from: "laptop" }, { name: "← server", y: 62, from: "server" }];
  const ok = r.pushes.filter((p) => p.ok).length;
  return (
    <Demo
      title="One WireGuard peer over five minutes"
      controls={<>
        <Param spec={WG.roam} value={roam} onChange={(v) => P.set("roam", v as number)} />
        <Param spec={WG.pk} value={pk} onChange={(v) => P.set("pk", v as "0")} />
        <Param spec={WG.push} value={push} onChange={(v) => P.set("push", v as number)} />
        <Param spec={WG.nat} value={nat} onChange={(v) => P.set("nat", v as number)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${W} 104`} width="100%" height={104} role="img" aria-label="WireGuard packets over time" style={{ display: "block" }}>
          {roam > 0 && <rect x={x(0)} y={8} width={x(roam) - x(0)} height={72} fill={tint("var(--c1)", 6)} />}
          {roam > 0 && <line x1={x(roam)} x2={x(roam)} y1={6} y2={84} stroke="var(--c4)" strokeDasharray="4 3" />}
          {lanes.map((l) => (
            <g key={l.name}>
              <text x={L - 6} y={l.y + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{l.name}</text>
              <line x1={L} x2={W - R} y1={l.y} y2={l.y} stroke="var(--border)" />
            </g>
          ))}
          {r.events.map((e, i) => {
            const lane = lanes.find((l) => l.from === e.from)!;
            const c = e.ok ? KIND_COLOR[e.kind] : "var(--c4)";
            const cx = x(e.t), cy = lane.y + (e.kind === "init" || e.kind === "resp" ? -8 : e.kind === "keepalive" ? 8 : 0);
            return e.ok
              ? <circle key={i} cx={cx} cy={cy} r={e.kind === "data" ? 3.5 : 3} fill={c}><title>{`${e.t.toFixed(1)} s: ${e.from} ${e.kind} via ${e.via}`}</title></circle>
              : <g key={i} stroke={c} strokeWidth={1.6}><title>{`${e.t.toFixed(1)} s: ${e.from} ${e.kind} lost: ${e.why}`}</title><line x1={cx - 3} x2={cx + 3} y1={cy - 3} y2={cy + 3} /><line x1={cx - 3} x2={cx + 3} y1={cy + 3} y2={cy - 3} /></g>;
          })}
          {[0, 60, 120, 180, 240, 300].map((t) => <text key={t} x={x(t)} y={98} textAnchor="middle" fontSize="10" fill="var(--faint)">{t} s</text>)}
        </svg>
      </div>
      <Legend items={[{ label: "data", color: "var(--c1)" }, { label: "keepalive (below)", color: "var(--c3)" }, { label: "handshake (above)", color: "var(--c5)" }, { label: "lost", color: "var(--c4)" }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "server pushes delivered", value: `${ok} of ${r.pushes.length}` },
          { label: "handshakes", value: r.handshakes.length },
          { label: "server learned a new endpoint", value: r.endpointChanges.length > 1 ? `at ${r.endpointChanges[1]!.t.toFixed(1)} s` : "never" },
        ]} />
      </div>
      <Banner tone={ok === r.pushes.length ? "good" : "bad"}>
        {ok === r.pushes.length
          ? "Every push arrives. Something from the laptop reached the server often enough to keep the NAT mapping open and the endpoint current."
          : roam > 0 && r.events.some((e) => !e.ok && e.t >= roam)
            ? "After the move, the server keeps sending to the old Wi-Fi address. It learns the new address only from the laptop's next authenticated packet, and an idle laptop sends none."
            : "Pushes die at a NAT whose mapping expired: the laptop was silent for longer than the NAT keeps a mapping. The server cannot reach a peer that does not send."}
      </Banner>
      <Note>The laptop sends a message every 7 s for the first minute, then only answers. Constants from the WireGuard paper: rekey after 120 s, reject keys after 180 s, keepalive after 10 s, handshake retry every 5 s.</Note>
    </Demo>
  );
}

// ============================================================================ 4. Cryptokey routing and what a VPN hides

const RT = {
  cfg: select<VpnConfig>({ label: "Configuration", options: (Object.keys(VPN_CONFIG_LABEL) as VpnConfig[]).map((k) => ({ value: k, label: VPN_CONFIG_LABEL[k] })), default: "full" }),
};

const LEVEL_COLOR = ["var(--c3)", "var(--c3)", "var(--c2)", "var(--c4)"];

export function NetSecRoutingDemo() {
  const P = useParams("net-sec-route", RT);
  const { cfg } = P.values;
  const [dst, setDst] = useState("10.1.2.3");
  const [src, setSrc] = useState("10.9.0.7");
  const peers = VPN_PEERS[cfg];
  const rows = exposureMatrix(cfg);
  const obs: Observer[] = ["wifi", "isp", "vpn", "site"];
  let route = "";
  try {
    const rr = wgRoute(peers, dst);
    route = rr.peer ? `into the tunnel to peer "${rr.peer}" (matches ${rr.prefix})` : "outside the tunnel (no AllowedIPs entry matches)";
  } catch {
    route = "not an IPv4 address";
  }
  let accept = "";
  try {
    accept = peers.length ? (wgAcceptFrom(peers[0]!, src) ? "accepted: the source is in the peer's AllowedIPs" : "dropped: this peer may not send from that source") : "no peer";
  } catch {
    accept = "not an IPv4 address";
  }
  const input = (v: string, set: (s: string) => void) => (
    <input value={v} onChange={(e) => set(e.target.value)} style={{ ...mono, fontSize: 13, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)", width: 140 }} />
  );
  return (
    <Demo title="Which packets enter the tunnel, and who sees what" controls={<Param spec={RT.cfg} value={cfg} onChange={(v) => P.set("cfg", v as VpnConfig)} />}>
      <div style={{ ...mono, fontSize: 12.5, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", overflowX: "auto" }}>
        {peers.length ? <>[Peer] # vpn<br />AllowedIPs = {peers[0]!.allowed.join(", ")}<br />DNS = {cfg === "split-leak" ? "(the café's resolver)" : "10.0.0.53"}</> : "# no VPN"}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "center", margin: "10px 0", fontSize: 13 }}>
        <span>Send to {input(dst, setDst)}: <b>{route}</b></span>
        {peers.length > 0 && <span>Packet from the peer with inner source {input(src, setSrc)}: <b>{accept}</b></span>}
      </div>
      <MiniTable head={["flow", ...obs.map((o) => OBSERVER_LABEL[o])]} rows={rows.map((r) => [
        <span key="f"><b style={{ fontWeight: 550 }}>{r.flow.label}</b><br /><span style={{ color: "var(--muted)", ...mono, fontSize: 11.5 }}>{r.dst} · {r.route.peer ? "tunnel" : "direct"}</span></span>,
        ...obs.map((o) => <span key={o} style={{ display: "block", textAlign: "left", whiteSpace: "normal", minWidth: 110, padding: "2px 4px", borderRadius: 3, background: tint(LEVEL_COLOR[r.sights[o].level]!, r.sights[o].level >= 2 ? 22 : 10) }}>{r.sights[o].text}</span>),
      ])} />
      <Legend items={[{ label: "nothing or tunnel metadata", color: "var(--c3)" }, { label: "destination and name", color: "var(--c2)" }, { label: "content, or your identity", color: "var(--c4)" }]} />
      <Note>A VPN moves trust; it does not remove it. The VPN server sees what the café and the ISP saw before, and the site still sees everything you send it.</Note>
    </Demo>
  );
}
