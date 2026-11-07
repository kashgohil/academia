/** Demos for "Ethernet": a frame you can break, the CSMA/CD collision window, and the cost of a frame on the wire. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Dots, Legend, Line, Param, Plot, RuleX, SectionLabel, SmallLabel, StackBar, Stats, Note, MONO, fixed, int, pct, range, seg, si, sig, toggle, useParams, useWidth, GOOD, BAD } from "../../kit";
import { HeaderDiagram } from "./PacketViews";
import { HexDump } from "./NetLinkUi";
import { formatMac, internetChecksum, utf8 } from "../../sims/net";
import {
  CRC32_RESIDUE, ETH, ETHERTYPE, checkFcs, collisionWindow, encodeFrame, ethHeaderFields, framesPerSecond, goodput, macInfo, parseMac, wireCost,
} from "../../sims/net/link";

// ============================================================================ 1. A frame you can break

const DSTS: Record<string, string> = {
  unicast: "00:1b:21:3a:4f:10",
  broadcast: "ff:ff:ff:ff:ff:ff",
  ipv4m: "01:00:5e:00:00:fb",
  ipv6m: "33:33:00:00:00:01",
  local: "02:42:ac:11:00:02",
};

const FL = {
  dst: seg("Destination", [["unicast", "unicast"], ["broadcast", "broadcast"], ["ipv4m", "IPv4 multicast"], ["ipv6m", "IPv6 multicast"], ["local", "locally administered"]], "unicast"),
  len: range({ label: "Payload length", min: 0, max: 96, step: 1, default: 20, format: (v) => `${v} B` }),
  type: seg("EtherType", [["ipv4", "IPv4"], ["arp", "ARP"], ["ipv6", "IPv6"]], "ipv4"),
  tag: toggle({ label: "Add an 802.1Q VLAN tag (VLAN 10)", default: false }),
};

const TEXT = "GET / HTTP/1.1 Host: example.com ";
const payloadOf = (n: number) => utf8(TEXT.repeat(4).slice(0, n));

export function FrameLabDemo() {
  const P = useParams("net-eth-frame", FL);
  const { dst, len, type, tag } = P.values;
  const frame = useMemo(() => ({
    dst: parseMac(DSTS[dst]!), src: parseMac("3c:22:fb:12:34:56"),
    vlan: tag ? { pcp: 0, dei: 0, vid: 10 } : undefined,
    etherType: ETHERTYPE[type], payload: payloadOf(len),
  }), [dst, len, type, tag]);
  const enc = useMemo(() => encodeFrame(frame), [frame]);
  const [flips, setFlips] = useState<{ key: string; bits: number[]; swap?: [number, number] }>({ key: "", bits: [] });
  const key = `${dst}|${len}|${type}|${tag}`;
  const cur = flips.key === key ? flips : { key, bits: [] as number[], swap: undefined };
  const rx = useMemo(() => {
    const b = enc.bytes.slice();
    if (cur.swap) {
      const [i, j] = cur.swap;
      [b[i], b[i + 1], b[j], b[j + 1]] = [b[j]!, b[j + 1]!, b[i]!, b[i + 1]!];
    }
    for (const bit of cur.bits) b[bit >> 3]! ^= 0x80 >> (bit & 7);
    return b;
  }, [enc, cur.bits, cur.swap]);
  const check = checkFcs(rx);
  const changed = rx.some((v, i) => v !== enc.bytes[i]);
  const body = enc.bytes.length - 4;
  const sumSent = internetChecksum(enc.bytes.subarray(0, body)), sumRx = internetChecksum(rx.subarray(0, body));
  const hdr = enc.headerLen;
  const colors = Array.from(enc.bytes, (_, i) => (i < hdr ? "var(--c1)" : i < hdr + enc.payloadLen ? "var(--c3)" : i < body ? "var(--c2)" : "var(--c5)"));
  const marked = new Set<number>();
  enc.bytes.forEach((v, i) => { if (rx[i] !== v) marked.add(i); });
  const toggleBit = (byte: number) => {
    const bit = byte * 8 + 7;
    const bits = cur.bits.includes(bit) ? cur.bits.filter((b) => b !== bit) : [...cur.bits, bit];
    setFlips({ key, bits, swap: cur.swap });
  };
  const info = macInfo(frame.dst);
  const fields = ethHeaderFields(frame);
  const values = fields.map((f) => (f.value instanceof Uint8Array ? formatMac(f.value) : f.name === "EtherType" || f.name === "TPID" ? `0x${Number(f.value).toString(16).padStart(4, "0")}` : String(f.value)));
  const b0 = frame.dst[0]!;
  return (
    <Demo
      title="Build a frame, then break it"
      actions={<ButtonRow>
        <Btn onClick={() => setFlips({ key, bits: [...cur.bits, 8 * hdr + 3] })}>Flip one bit</Btn>
        <Btn onClick={() => setFlips({ key, bits: cur.bits, swap: [hdr, hdr + 2] })}>Swap two 16-bit words</Btn>
        <Btn ghost onClick={() => setFlips({ key, bits: [] })}>Repair</Btn>
      </ButtonRow>}
      controls={<>
        <Param spec={FL.dst} value={dst} onChange={(v) => P.set("dst", v as typeof dst)} />
        <Param spec={FL.type} value={type} onChange={(v) => P.set("type", v as typeof type)} />
        <Param spec={FL.len} value={len} onChange={(v) => P.set("len", v as number)} />
        <Param spec={FL.tag} value={tag} onChange={(v) => P.set("tag", v as boolean)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Header ({hdr} bytes)</SectionLabel>
      <HeaderDiagram fields={fields} values={values} rowBits={48} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: "8px 0 4px", fontSize: 12.5 }}>
        <span className="muted">First byte of the destination:</span>
        <span style={{ fontFamily: MONO }}>
          {Array.from({ length: 8 }, (_, k) => 7 - k).map((bit) => (
            <span key={bit} style={{ padding: "0 2px", color: bit === 0 ? "var(--c4)" : bit === 1 ? "var(--c2)" : "var(--muted)", fontWeight: bit < 2 ? 700 : 400 }}>{(b0 >> bit) & 1}</span>
          ))}
        </span>
        <Chip color={info.group ? "var(--c4)" : "var(--muted)"}>I/G = {info.group ? "1 group" : "0 individual"}</Chip>
        <Chip color={info.local ? "var(--c2)" : "var(--muted)"}>U/L = {info.local ? "1 local" : "0 universal"}</Chip>
        <Chip>{info.kind}</Chip>
      </div>
      <SectionLabel>The frame on the wire, after the preamble. Click a byte to flip its last bit.</SectionLabel>
      <HexDump bytes={rx} colors={colors} marked={marked} onByte={toggleBit} />
      <Legend box items={[{ label: "header", color: "var(--c1)" }, { label: `payload (${enc.payloadLen} B)`, color: "var(--c3)" }, { label: `pad (${enc.pad} B)`, color: "var(--c2)" }, { label: "FCS (4 B)", color: "var(--c5)" }]} />
      <Banner tone={!changed ? "good" : check.ok ? "warn" : "bad"} label="receiver">
        {!changed ? <>CRC-32 over the frame is <b style={{ fontFamily: MONO }}>{hex32(check.computed)}</b>, the FCS field says <b style={{ fontFamily: MONO }}>{hex32(check.received)}</b>. The NIC passes the frame up.</>
          : check.ok ? <>The CRC matches although bytes changed. This does not happen for these error patterns.</>
          : <>CRC-32 is <b style={{ fontFamily: MONO }}>{hex32(check.computed)}</b>, the FCS field says <b style={{ fontFamily: MONO }}>{hex32(check.received)}</b>. The NIC drops the frame and counts one CRC error. Nobody tells the sender.</>}
      </Banner>
      <Banner tone={!changed ? "plain" : sumRx === sumSent ? "bad" : "good"} label="for contrast">
        The 16-bit Internet checksum of the same bytes was <span style={{ fontFamily: MONO }}>{hex16(sumSent)}</span> and is now <span style={{ fontFamily: MONO }}>{hex16(sumRx)}</span>
        {changed ? (sumRx === sumSent ? ": it misses this error." : ": it catches this one.") : "."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "frame (dst to FCS)", value: `${enc.bytes.length} B` },
          { label: "padding added", value: `${enc.pad} B` },
          { label: "CRC over frame + FCS", value: hex32(check.residue) },
          { label: "good-frame constant", value: hex32(CRC32_RESIDUE) },
        ]} />
      </div>
    </Demo>
  );
}

const hex32 = (v: number) => `0x${v.toString(16).padStart(8, "0")}`;
const hex16 = (v: number) => `0x${v.toString(16).padStart(4, "0")}`;

// ============================================================================ 2. The collision window

const CW = {
  rate: seg("Rate", [["10", "10 Mb/s"], ["100", "100 Mb/s"], ["1000", "1 Gb/s"]], "10"),
  len: range({ label: "Cable length", min: 10, max: 5000, log: true, default: 2500, format: (v) => `${int(v)} m` }),
  frame: range({ label: "Frame size", min: 64, max: 1518, log: true, default: 64, format: (v) => `${int(v)} B` }),
};

export function CollisionWindowDemo() {
  const P = useParams("net-eth-csma", CW);
  const { rate, len, frame } = P.values;
  const r = Number(rate) * 1e6;
  const w = collisionWindow(r, len, Math.round(frame));
  const frameUs = (w.frameBits / r) * 1e6;
  const prop = w.propUs;
  const back = 2 * prop;
  const tMax = Math.max(frameUs, back) * 1.12;
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(280, width), H = 230, L = Math.min(150, W * 0.36), R = 16, T = 24, B = 10;
  const X = (f: number) => L + f * (W - L - R);
  const Y = (t: number) => T + (t / tMax) * (H - T - B);
  const bStart = prop * 0.98;
  const bEnd = Math.max(prop + (32 / r) * 1e6, bStart + (3 * tMax) / (H - T - B));
  const aEnd = Math.min(frameUs, back);
  // Two labels on the left time axis; keep them apart.
  let yBack = Y(back), yEnd = Y(frameUs);
  if (Math.abs(yBack - yEnd) < 26) { if (yBack < yEnd) yEnd = yBack + 26; else yBack = yEnd + 26; }
  return (
    <Demo
      title="Will A hear the collision?"
      controls={<>
        <Param spec={CW.rate} value={rate} onChange={(v) => P.set("rate", v as typeof rate)} />
        <Param spec={CW.len} value={len} onChange={(v) => P.set("len", v as number)} />
        <Param spec={CW.frame} value={frame} onChange={(v) => P.set("frame", v as number)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%" }}>
        <svg viewBox={`0 0 ${W} ${H + 16}`} width="100%" height={H + 16} role="img" aria-label="distance-time diagram of a collision" style={{ display: "block" }}>
          <text x={X(0)} y={14} textAnchor="middle" fontSize="12" fontWeight={600} fill="var(--fg)">A</text>
          <text x={X(1)} y={14} textAnchor="middle" fontSize="12" fontWeight={600} fill="var(--fg)">B</text>
          <text x={(X(0) + X(1)) / 2} y={14} textAnchor="middle" fontSize="10.5" fill="var(--muted)">{int(len)} m of cable →</text>
          <line x1={X(0)} x2={X(0)} y1={T} y2={H} stroke="var(--border)" strokeWidth={2} />
          <line x1={X(1)} x2={X(1)} y1={T} y2={H} stroke="var(--border)" strokeWidth={2} />
          <polygon points={`${X(0)},${Y(0)} ${X(1)},${Y(prop)} ${X(1)},${Y(prop + aEnd)} ${X(0)},${Y(aEnd)}`} fill="color-mix(in srgb, var(--c1) 24%, var(--bg))" stroke="var(--c1)" />
          <polygon points={`${X(1)},${Y(bStart)} ${X(0)},${Y(bStart + prop)} ${X(0)},${Y(bEnd + prop)} ${X(1)},${Y(bEnd)}`} fill="color-mix(in srgb, var(--c4) 40%, var(--bg))" stroke="var(--c4)" />
          <line x1={X(0) - 6} x2={X(0) + 6} y1={Y(frameUs)} y2={Y(frameUs)} stroke="var(--c1)" strokeWidth={2.5} />
          <circle cx={X(0)} cy={Y(back)} r={5} fill={w.detected ? GOOD : BAD} />
          <text x={X(0) - 10} y={yEnd + 4} textAnchor="end" fontSize="11" fill="var(--c1)">A sends its last bit</text>
          <text x={X(0) - 10} y={yEnd + 17} textAnchor="end" fontSize="11" fill="var(--c1)">{fixed(frameUs, 2)} µs</text>
          <text x={X(0) - 10} y={yBack + 4} textAnchor="end" fontSize="11" fill={w.detected ? GOOD : BAD}>collision reaches A</text>
          <text x={X(0) - 10} y={yBack + 17} textAnchor="end" fontSize="11" fill={w.detected ? GOOD : BAD}>{fixed(back, 2)} µs</text>
          <text x={X(1) - 6} y={Y(bStart) - 5} textAnchor="end" fontSize="11" fill="var(--c4)">B starts</text>
          <text x={W - R} y={H + 13} textAnchor="end" fontSize="10.5" fill="var(--muted)">time runs down</text>
        </svg>
      </div>
      <Banner tone={w.detected ? "good" : "bad"}>
        {w.detected
          ? <>A frame of {int(w.frameBits)} bits is longer than the {int(w.roundTripBits)}-bit round trip, so A detects the collision, sends a jam signal and retries.</>
          : <>The frame lasts {int(w.frameBits)} bit times, but the collision needs {int(w.roundTripBits)} to come back. A cannot know that the frame died.</>}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "one-way delay", value: `${fixed(prop, 2)} µs` },
          { label: "round trip", value: `${int(w.roundTripBits)} bit times` },
          { label: "frame", value: `${int(w.frameBits)} bits` },
          { label: "longest cable for this frame", value: `${int(w.maxLengthM)} m` },
          { label: "smallest frame for this cable", value: `${int(w.minFrameBytes)} B` },
        ]} />
      </div>
      <Note>Model input: signal speed 0.77 c (coax). The cable-only figures here are about half of the real 802.3 budget, which also counts repeaters and transceivers.</Note>
    </Demo>
  );
}

// ============================================================================ 3. What a frame costs on the wire

const WC = {
  payload: range({ label: "Payload", min: 1, max: 9000, log: true, default: 1500, format: (v) => `${int(v)} B` }),
  rate: seg("Link rate", [["1e9", "1 Gb/s"], ["1e10", "10 Gb/s"], ["1e11", "100 Gb/s"]], "1e10"),
  tag: toggle({ label: "802.1Q tag (+4 bytes)", default: false }),
};

export function WireCostDemo() {
  const P = useParams("net-eth-wire", WC);
  const { payload, rate, tag } = P.values;
  const p = Math.round(payload);
  const r = Number(rate);
  const c = wireCost(p, tag);
  const fps = framesPerSecond(r, p, tag);
  const curve = useMemo(() => {
    const pts: [number, number][] = [];
    for (let x = 1; x <= 9000; x = Math.ceil(x * 1.08)) pts.push([x, wireCost(x, tag).efficiency * 100]);
    return pts;
  }, [tag]);
  return (
    <Demo
      title="Bytes on the wire per frame"
      controls={<>
        <Param spec={WC.payload} value={payload} onChange={(v) => P.set("payload", v as number)} />
        <Param spec={WC.rate} value={rate} onChange={(v) => P.set("rate", v as typeof rate)} />
        <Param spec={WC.tag} value={tag} onChange={(v) => P.set("tag", v as boolean)} />
      </>}
    >
      <SmallLabel>One frame and the gap after it: {c.total} bytes</SmallLabel>
      <StackBar height={24} parts={[
        { value: c.preamble, color: "var(--faint)", label: `preamble + SFD ${c.preamble} B` },
        { value: c.header, color: "var(--c1)", label: `header ${c.header} B` },
        { value: c.payload, color: "var(--c3)", label: `payload ${c.payload} B` },
        { value: c.pad, color: "var(--c2)", label: `pad ${c.pad} B` },
        { value: c.fcs, color: "var(--c5)", label: `FCS ${c.fcs} B` },
        { value: c.ifg, color: "var(--border)", label: `gap ${c.ifg} B` },
      ]} />
      <Legend box items={[
        { label: `preamble+SFD ${c.preamble}`, color: "var(--faint)" }, { label: `header ${c.header}`, color: "var(--c1)" }, { label: `payload ${c.payload}`, color: "var(--c3)" },
        { label: `pad ${c.pad}`, color: "var(--c2)" }, { label: `FCS ${c.fcs}`, color: "var(--c5)" }, { label: `gap ${c.ifg}`, color: "var(--border)" },
      ]} />
      <div style={{ marginTop: 10 }}>
        <Plot x={[1, 9000]} y={[0, 100]} logX height={200} xLabel="payload (bytes)" yLabel="payload share of the wire (%)" xTicks={[1, 10, 46, 100, 1500, 9000]} xFormat={(v) => int(v)}>
          <RuleX at={1500} />
          <RuleX at={9000} />
          <Line points={curve} color="var(--c3)" />
          <Dots points={[[p, c.efficiency * 100]]} color="var(--c4)" r={5} />
        </Plot>
      </div>
      <Stats items={[
        { label: "efficiency", value: pct(c.efficiency, 1) },
        { label: "frames per second", value: si(fps, "") },
        { label: "time per frame", value: `${sig((c.total * 8 * 1e9) / r, 3)} ns` },
        { label: "payload rate", value: `${si(goodput(r, p, tag), "b/s")}` },
      ]} />
      <Note>A payload under {ETH.minPayload - (tag ? 4 : 0)} bytes is padded, so a tiny frame still costs {wireCost(0, tag).total} bytes of wire time. The time per frame is the budget a router or a NIC driver has for each frame at line rate.</Note>
    </Demo>
  );
}

