/** Demos for "UDP": the checksum with its pseudo-header, datagrams with no order, and head-of-line blocking. */
import { useMemo, useState } from "react";
import { Banner, Btn, Chip, Demo, Dots, Legend, MiniTable, Param, Plot, SmallLabel, Stats, Note, mono, range, toggle, useParams, int, pct } from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { HeaderDiagram, fromPackets } from "./PacketViews";
import { formatIpv4, packFields, parseIpv4, utf8 } from "../../sims/net";
import { checksumForNewAddress, holTcp, holUdp, sprayRun, udpChecksumSteps, udpFields, udpVerify, type UdpDatagram } from "../../sims/net/transport";

const h16 = (v: number) => `0x${v.toString(16).padStart(4, "0")}`;

// ============================================================================ 1. The checksum

const CS = {
  flip: range({ label: "Flip one bit in transit (bit number)", min: 0, max: 160, step: 1, default: 0, format: (v) => (v ? `bit ${v}` : "none") }),
  sport: range({ label: "Source port", min: 1024, max: 65535, step: 1, default: 51000 }),
  nat: toggle({ label: "A NAT rewrites the source address", default: false }),
  fix: toggle({ label: "The NAT also fixes the checksum", default: false }),
  none: toggle({ label: "The sender sends checksum 0 (none)", default: false }),
};

export function NetTcpUdpChecksumDemo() {
  const P = useParams("net-udp-cs", CS);
  const { flip, sport, nat, fix, none } = P.values;
  const [text, setText] = useState("hello, dns");
  const sent: UdpDatagram = { srcIp: parseIpv4("192.168.1.10"), dstIp: parseIpv4("9.9.9.9"), sport, dport: 53, data: utf8(text.slice(0, 24)) };
  const steps = udpChecksumSteps(sent);
  const csum = none ? 0 : steps.checksum;
  // What arrives: the 8-byte header and the data, with one bit flipped; the source address as the receiver sees it.
  const wire = new Uint8Array([...packFields(udpFields(sent, csum)), ...sent.data]);
  const nbits = wire.length * 8;
  const bit = flip > 0 && flip <= nbits ? flip - 1 : -1;
  if (bit >= 0) wire[bit >> 3]! ^= 0x80 >> (bit & 7);
  const rx: UdpDatagram = {
    srcIp: nat ? parseIpv4("203.0.113.7") : sent.srcIp, dstIp: sent.dstIp,
    sport: (wire[0]! << 8) | wire[1]!, dport: (wire[2]! << 8) | wire[3]!, data: wire.slice(8),
  };
  let rxCsum = (wire[6]! << 8) | wire[7]!;
  // A NAT that fixes the checksum updates it for the changed address words only (RFC 1624).
  if (nat && fix && rxCsum !== 0) rxCsum = checksumForNewAddress(rxCsum, sent.srcIp, rx.srcIp);
  const verdict = udpVerify(rx, rxCsum);
  const where = bit < 0 ? "" : bit < 64 ? `header bit ${bit} (${["source port", "destination port", "length", "checksum"][bit >> 4]})` : `data byte ${(bit - 64) >> 3}`;
  return (
    <Demo
      title="The UDP checksum, word by word"
      controls={<>
        <Param spec={CS.flip} value={flip} onChange={(v) => P.set("flip", v as number)} />
        <Param spec={CS.sport} value={sport} onChange={(v) => P.set("sport", v as number)} />
        <label className="param">
          <span className="param-label"><span>Payload (up to 24 bytes)</span></span>
          <input value={text} maxLength={24} onChange={(e) => setText(e.target.value)} style={{ font: "inherit", ...mono, padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)" }} />
        </label>
        <Param spec={CS.nat} value={nat} onChange={(v) => P.set("nat", v as boolean)} />
        <Param spec={CS.fix} value={fix} onChange={(v) => P.set("fix", v as boolean)} />
        <Param spec={CS.none} value={none} onChange={(v) => P.set("none", v as boolean)} />
      </>}
    >
      <SmallLabel>The UDP header as sent: 8 bytes, four 16-bit fields.</SmallLabel>
      <HeaderDiagram fields={udpFields(sent, csum)} values={[String(sport), "53", String(8 + sent.data.length), h16(csum)]} />
      <SmallLabel style={{ marginTop: 10 }}>The checksum adds 16-bit words. A carry out of bit 15 wraps around and adds 1 (ones' complement). The first six words come from the IP header (the pseudo-header); they are not part of the UDP datagram.</SmallLabel>
      <div style={{ maxHeight: 230, overflow: "auto" }}>
        <MiniTable
          head={["word", "from", "value", "running sum"]}
          rows={steps.steps.map((s) => [s.label, s.part, <span style={mono}>{h16(s.word)}</span>, <span style={{ ...mono, color: s.carry ? "var(--c2)" : undefined }}>{h16(s.sum)}{s.carry ? " +1" : ""}</span>])}
        />
      </div>
      <div style={{ ...mono, fontSize: 12.5, marginTop: 6 }}>sum {h16(steps.sum)} → invert → checksum {h16(steps.checksum)}{none ? " (but the sender sends 0x0000)" : ""}</div>
      <Banner tone={verdict === "ok" ? "good" : verdict === "none" ? "warn" : "bad"} label="receiver">
        {verdict === "ok" && (nat ? "Accepted: the NAT changed the address and updated the checksum to match." : "Accepted: the sum over pseudo-header, header and data, checksum included, is 0xffff.")}
        {verdict === "bad" && `Dropped: the sum is not 0xffff. ${bit >= 0 ? `A flip in ${where} changes one word by a power of two, so a single flipped bit is always caught.` : "The source address in the pseudo-header changed, but the checksum did not."}`}
        {verdict === "none" && `Accepted without a check: checksum 0 means "none" over IPv4. ${bit >= 0 ? `The flip in ${where} goes to the application unnoticed. ` : ""}IPv6 forbids this.`}
      </Banner>
      <Note>Receiver sees source {formatIpv4(rx.srcIp)}:{rx.sport}, {rx.data.length} data bytes.</Note>
    </Demo>
  );
}

// ============================================================================ 2. No order

const SP = {
  delayB: range({ label: "Extra delay of path B", min: 0, max: 40, step: 1, default: 12, format: (v) => `${v} ms` }),
  gap: range({ label: "Time between datagrams", min: 1, max: 20, step: 1, default: 4, format: (v) => `${v} ms` }),
  loss: range({ label: "Loss on each path", min: 0, max: 0.3, step: 0.01, default: 0.05, format: (v) => pct(v, 0) }),
};

export function NetTcpUdpOrderDemo() {
  const P = useParams("net-udp-order", SP);
  const { delayB, gap, loss } = P.values;
  const [seed, setSeed] = useState(2);
  const COUNT = 12;
  const r = useMemo(() => sprayRun({ count: COUNT, gap, delayA: 5, delayB: 5 + delayB, loss, seed }), [delayB, gap, loss, seed]);
  const st = fromPackets(r.net, { label: (p) => String(p.payload.n + 1), color: (p) => (p.payload.n % 2 ? "var(--c2)" : "var(--c1)") });
  const tEnd = Math.max(...r.net.hops.map((h) => h.arriveAt ?? h.txEnd)) + 4;
  const got = new Set(r.arrivals.map((a) => a.n));
  return (
    <Demo
      title="Datagrams over two paths"
      actions={<Btn onClick={() => setSeed(seed + 1)}>New random losses</Btn>}
      controls={<>
        <Param spec={SP.delayB} value={delayB} onChange={(v) => P.set("delayB", v as number)} />
        <Param spec={SP.gap} value={gap} onChange={(v) => P.set("gap", v as number)} />
        <Param spec={SP.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={50} />
      <Legend items={[{ label: "odd datagrams: path A (5 ms)", color: "var(--c1)" }, { label: `even datagrams: path B (${5 + delayB} ms)`, color: "var(--c2)" }]} />
      <SmallLabel style={{ marginTop: 8 }}>What the application reads, in order of arrival (red: an earlier number after a later one):</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {r.arrivals.map((a, i) => <Chip key={i} color={a.late ? "var(--c4)" : "var(--c3)"}>{a.n + 1}</Chip>)}
        {Array.from({ length: COUNT }, (_, n) => n).filter((n) => !got.has(n)).map((n) => <Chip key={`l${n}`} color="var(--faint)" strike>{n + 1}</Chip>)}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "sent", value: COUNT },
          { label: "arrived in order", value: r.inOrder },
          { label: "arrived late", value: r.late },
          { label: "lost, never resent", value: r.lost },
        ]} />
      </div>
      <Banner tone={r.late || r.lost ? "warn" : "good"}>
        UDP hands each datagram up as it comes. It does not number them, wait for gaps, or resend. If order or completeness matters, the application must add sequence numbers, as RTP and QUIC do.
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. Head-of-line blocking

const HL = {
  loss: range({ label: "Loss rate", min: 0, max: 0.1, step: 0.005, default: 0.02, format: (v) => pct(v, 1) }),
  hz: range({ label: "Updates per second", min: 10, max: 60, step: 5, default: 30 }),
  delay: range({ label: "One-way delay", min: 5, max: 100, step: 5, default: 30, format: (v) => `${v} ms` }),
};

export function NetTcpHolDemo() {
  const P = useParams("net-udp-hol", HL);
  const { loss, hz, delay } = P.values;
  const [seed, setSeed] = useState(1);
  const o = { hz, size: 200, duration: 6000, delay, loss, seed };
  const u = useMemo(() => holUdp(o), [hz, delay, loss, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = useMemo(() => holTcp(o), [hz, delay, loss, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const yMax = Math.max(100, ...t.latencies, ...u.latencies) * 1.1;
  const pts = (r: { updates: typeof u.updates }) => r.updates.filter((x) => x.at !== undefined).map((x) => [x.gen / 1000, x.at! - x.gen] as const);
  return (
    <Demo
      title="Game updates over UDP and over TCP"
      actions={<Btn onClick={() => setSeed(seed + 1)}>New random losses</Btn>}
      controls={<>
        <Param spec={HL.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
        <Param spec={HL.hz} value={hz} onChange={(v) => P.set("hz", v as number)} />
        <Param spec={HL.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
      </>}
    >
      <Plot x={[0, 6]} y={[0, yMax]} height={230} xLabel="update sent at (s)" yLabel="delay until usable (ms)">
        <Dots points={pts(t)} color="var(--c4)" r={2.2} />
        <Dots points={pts(u)} color="var(--c1)" r={2.2} />
      </Plot>
      <Legend items={[{ label: "TCP (TCP_NODELAY)", color: "var(--c4)" }, { label: "UDP", color: "var(--c1)" }]} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={["", "median", "p99", "worst", "lost", "oldest shown"]}
          rows={[
            ["UDP", `${int(u.p50)} ms`, `${int(u.p99)} ms`, `${int(u.max)} ms`, u.lost, `${int(u.maxStale)} ms`],
            ["TCP", `${int(t.p50)} ms`, `${int(t.p99)} ms`, `${int(t.max)} ms`, t.lost, `${int(t.maxStale)} ms`],
          ]}
        />
      </div>
      <Banner tone={loss > 0 ? "warn" : "plain"}>
        {loss > 0
          ? `Each TCP loss holds back every later update until the retransmission arrives: a column of red dots. UDP loses ${u.lost} updates, but the next update replaces each one ${int(1000 / hz)} ms later.`
          : "With no loss, both deliver every update after one one-way delay."}
      </Banner>
      <Stats items={[{ label: "TCP retransmissions", value: t.conn.stats.retxSegs }, { label: "TCP timeouts", value: t.conn.stats.timeouts }]} />
    </Demo>
  );
}
