/** Demos for "QUIC". Every run is a PacketNet run of src/sims/net/cc (quic-*.ts). */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Chip, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleX, SmallLabel, Stats, fixed, mono, range, seg, select, sig,
  toggle, useChunked, useParams,
} from "../../kit";
import { SpaceTime, type StMark } from "../dist/SpaceTime";
import { HeaderDiagram, fromPackets } from "./PacketViews";
import { hex, unpackFields } from "../../sims/net";
import { mulberry32 } from "../../sims/rng";
import {
  MAX_ACK_DELAY_MS, MIGRATION_DEFAULT, protect, sampleOf, shortHeaderFields, toyMask, type ShortHeader, SETUP_LABEL, delivery, holSummary, isEarly, migrationRun, quicTransfer, setupRun, setupScript,
  type QPacket, type SetupKind,
} from "../../sims/net/cc";

const STREAM_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

// ============================================================================ 1. Head-of-line blocking

export const HOL = { chunks: 24, rttMs: 40, mbps: 10 } as const;

const HO = {
  streams: seg<"1" | "2" | "4" | "8">("Resources (streams)", [["1", "1"], ["2", "2"], ["4", "4"], ["8", "8"]], "4"),
};

function Lanes({ title, arrival, read, streams, tEnd }: { title: string; arrival: number[]; read: number[]; streams: number; tEnd: number }) {
  const t0 = Math.min(...arrival) - 3;
  return (
    <div style={{ minWidth: 0 }}>
      <SmallLabel>{title}</SmallLabel>
      <Plot x={[t0, tEnd]} y={[-0.6, streams - 0.4]} height={40 + 26 * streams} xLabel="ms" yTicks={Array.from({ length: streams }, (_, i) => i)}
        yFormat={(v) => `s${v + 1}`} grid={false}>
        {arrival.map((a, i) => {
          const s = i % streams, r = read[i]!;
          return r > a + 0.01 ? <Line key={i} points={[[a, s], [r, s]]} color="var(--c4)" width={2} /> : null;
        })}
        {arrival.map((a, i) => <Dots key={`a${i}`} points={[[a, i % streams]]} color={read[i]! > a + 0.01 ? "var(--c4)" : STREAM_COLORS[i % streams]} r={3.5} />)}
      </Plot>
    </div>
  );
}

export function NetCcHolDemo() {
  const P = useParams("net-cc-hol", HO);
  const streams = Number(P.values.streams);
  const [drop, setDrop] = useState<number[]>([2]);
  const run = useMemo(() => quicTransfer({ chunks: HOL.chunks, rttMs: HOL.rttMs, mbps: HOL.mbps, drop }), [drop]);
  const tcp = holSummary(run.arrival, streams, true), quic = holSummary(run.arrival, streams, false);
  const readTcp = delivery(run.arrival, streams, true), readQuic = delivery(run.arrival, streams, false);
  const tEnd = Math.ceil((Math.max(...readTcp) + 8) / 10) * 10;
  const st = fromPackets(run.net, {
    filter: (p) => p.payload.k === "data",
    color: (p) => (p.payload.k === "data" ? STREAM_COLORS[p.payload.chunk % streams] : undefined),
    label: (p) => (p.payload.k === "data" && p.payload.pn >= HOL.chunks ? `chunk ${p.payload.chunk} again` : undefined),
  });
  const toggleDrop = (pn: number) => setDrop(drop.includes(pn) ? drop.filter((x) => x !== pn) : [...drop, pn].sort((a, b) => a - b));
  const fmt = (xs: number[]) => xs.map((x) => `${fixed(x, 0)}`).join(", ");
  return (
    <Demo
      title="One lost packet: one byte stream against independent streams"
      actions={<Btn ghost onClick={() => setDrop([])}>No loss</Btn>}
      controls={<Param spec={HO.streams} value={P.values.streams} onChange={(v) => P.set("streams", v as "1" | "2" | "4" | "8")} />}
    >
      <SmallLabel>Click packets to drop them. Packet i carries chunk i of resource (stream) i mod {streams}.</SmallLabel>
      <ButtonRow style={{ gap: 4, marginBottom: 8 }}>
        {Array.from({ length: HOL.chunks }, (_, i) => (
          <Chip key={i} color={STREAM_COLORS[i % streams]} filled={!drop.includes(i)} strike={drop.includes(i)} onClick={() => toggleDrop(i)} title={`packet ${i}, stream ${(i % streams) + 1}`}>{i}</Chip>
        ))}
      </ButtonRow>
      <SpaceTime nodes={st.names} tEnd={tEnd} messages={st.messages} marks={st.marks} rowHeight={42} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginTop: 8 }}>
        <Lanes title="TCP: one ordered byte stream" arrival={run.arrival} read={readTcp} streams={streams} tEnd={tEnd} />
        <Lanes title={`QUIC: ${streams} independent stream${streams > 1 ? "s" : ""}`} arrival={run.arrival} read={readQuic} streams={streams} tEnd={tEnd} />
      </div>
      <Legend items={[{ label: "arrived and read at once", color: "var(--c1)" }, { label: "arrived, then waited (red line) for a gap", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "chunks that wait, TCP", value: `${tcp.blocked} of ${HOL.chunks}` },
        { label: "chunks that wait, QUIC", value: `${quic.blocked} of ${HOL.chunks}` },
        { label: "mean wait, TCP", value: `${fixed(tcp.meanWaitMs, 1)} ms` },
        { label: "mean wait, QUIC", value: `${fixed(quic.meanWaitMs, 1)} ms` },
      ]} />
      <Banner tone={drop.length ? "info" : "plain"}>
        Each resource is complete at (ms): TCP {fmt(tcp.streamDone)}; QUIC {fmt(quic.streamDone)}. Both see the same packets and the same retransmission; only the rule for handing data to the application differs.
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Connection setup and 0-RTT replay

const KINDS = Object.keys(SETUP_LABEL) as SetupKind[];
const HS = {
  kind: select<SetupKind>({ label: "Setup", options: KINDS.map((k) => ({ value: k, label: SETUP_LABEL[k] })), default: "quic" }),
  rtt: range({ label: "RTT", min: 10, max: 300, step: 5, default: 50, format: (v) => `${v} ms` }),
  cert: seg<"3000" | "6000">("Server's certificate flight", [["3000", "3 KB"], ["6000", "6 KB"]], "3000"),
  replay: toggle({ label: "An attacker on the path replays the client's first packet", default: false }),
  anti: toggle({ label: "The server has anti-replay protection", default: false }),
};

export function NetCcHandshakeDemo() {
  const P = useParams("net-cc-hs", HS);
  const { kind, rtt, replay, anti } = P.values;
  const cert = Number(P.values.cert);
  const run = useMemo(() => setupRun({ kind, rttMs: rtt, certBytes: cert, replay, antiReplay: anti }), [kind, rtt, cert, replay, anti]);
  const steps = setupScript(kind, cert);
  const order = new Map(steps.map((s, i) => [s.id, i + 1]));
  const st = fromPackets(run.net, {
    nodes: replay ? [0, 1, 2] : [0, 1],
    label: (p) => (p.payload.replayed ? "copy" : String(order.get(p.payload.id) ?? "")),
    color: (p) => (p.payload.replayed ? "var(--c4)" : p.payload.response ? "var(--c3)" : p.payload.request ? "var(--c1)" : undefined),
  });
  const marks: StMark[] = [...st.marks, { node: 0, t: run.firstByteMs, label: "first byte", color: "var(--c3)" }];
  const all = KINDS.map((k) => ({ k, r: setupRun({ kind: k, rttMs: rtt, certBytes: cert }) }));
  return (
    <Demo
      title="Time to the first byte of a response"
      controls={<>
        <Param spec={HS.kind} value={kind} onChange={(v) => P.set("kind", v as SetupKind)} />
        <Param spec={HS.rtt} value={rtt} onChange={(v) => P.set("rtt", v as number)} />
        <Param spec={HS.cert} value={P.values.cert} onChange={(v) => P.set("cert", v as "3000" | "6000")} />
        <Param spec={HS.replay} value={replay} onChange={(v) => P.set("replay", v as boolean)} />
        <Param spec={HS.anti} value={anti} onChange={(v) => P.set("anti", v as boolean)} />
      </>}
    >
      <SpaceTime nodes={st.names} tEnd={Math.max(run.tEnd, run.firstByteMs) * 1.05} messages={st.messages} marks={marks} rowHeight={44} />
      <ol style={{ fontSize: 12.5, margin: "6px 0 0", paddingLeft: 22, lineHeight: 1.5 }}>
        {steps.map((s) => (
          <li key={s.id} style={{ color: s.response ? "var(--c3)" : s.request ? "var(--c1)" : undefined }}>
            <span className="muted">{s.from === "c" ? "client → server" : "server → client"}:</span> {s.label} <span className="muted" style={mono}>({s.bytes} B)</span>
          </li>
        ))}
      </ol>
      <Stats items={[
        { label: "first byte of the response", value: `${fixed(run.firstByteMs, 1)} ms` },
        { label: "in RTTs", value: fixed(run.rtts, 2) },
        { label: "the server ran the request", value: `${run.executions} time${run.executions === 1 ? "" : "s"}` },
      ]} />
      {replay && (
        <Banner tone={run.executions > 1 ? "bad" : "good"} label="server">
          {run.serverLog.map((l) => `${fixed(l.t, 0)} ms: ${l.text}.`).join(" ")}
          {!isEarly(kind) && " This setup sends no request in its first packet, so a copy of that packet runs nothing."}
        </Banner>
      )}
      <MiniTable head={["setup", "first byte", "RTTs"]} rows={all.map(({ k, r }) => [SETUP_LABEL[k], `${fixed(r.firstByteMs, 0)} ms`, fixed(r.rtts, 1)])} highlight={KINDS.indexOf(kind)} />
    </Demo>
  );
}

// ============================================================================ 3. Packet numbers and loss detection

export const LD = { chunks: 12, rttMs: 40, mbps: 10, gapMs: 1 } as const;

function fate(p: QPacket) {
  if (p.ackedAt !== undefined) return `acked at ${fixed(p.ackedAt, 1)} ms`;
  if (p.lostAt !== undefined) return `lost at ${fixed(p.lostAt, 1)} ms (${p.lostBy})`;
  return "never acked";
}

export function NetCcLossDetectDemo() {
  const [drop, setDrop] = useState<number[]>([3, 11]);
  const run = useMemo(() => quicTransfer({ ...LD, drop }), [drop]);
  const toggleDrop = (pn: number) => setDrop(drop.includes(pn) ? drop.filter((x) => x !== pn) : [...drop, pn].sort((a, b) => a - b));
  const st = fromPackets(run.net, {
    label: (p) => (p.payload.k === "data" && p.payload.pn >= LD.chunks ? `pn ${p.payload.pn}` : undefined),
    color: (p) => (p.payload.k === "data" ? (p.payload.pn >= LD.chunks ? "var(--c2)" : "var(--c1)") : "var(--faint)"),
    filter: (p) => p.payload.k === "data",
  });
  const marks: StMark[] = [
    ...st.marks,
    ...run.events.filter((e) => e.kind !== "rtt").map((e) => ({ node: 0, t: e.t, label: e.kind === "pto" ? "PTO" : `${e.pn} lost`, color: e.kind === "pto" ? "var(--c5)" : "var(--c4)" })),
  ];
  const rows = run.packets.map((p) => [
    <span style={mono}>{p.pn}</span>,
    <span style={mono}>{p.chunk}</span>,
    fixed(p.sentAt, 1),
    fate(p),
    p.pn >= LD.chunks ? `seq ${p.chunk} again (ACK ambiguous)` : `seq ${p.chunk}`,
  ]);
  const rttSamples = run.events.filter((e) => e.kind === "rtt").length;
  return (
    <Demo title="Packet numbers that never repeat" actions={<Btn ghost onClick={() => setDrop([])}>No loss</Btn>}>
      <SmallLabel>Click packet numbers to drop them on the way. A chunk that is sent again goes in a new packet with a new number.</SmallLabel>
      <ButtonRow style={{ gap: 4, marginBottom: 8 }}>
        {Array.from({ length: LD.chunks }, (_, i) => (
          <Chip key={i} color="var(--c1)" filled={!drop.includes(i)} strike={drop.includes(i)} onClick={() => toggleDrop(i)}>{`pn ${i}`}</Chip>
        ))}
      </ButtonRow>
      <SpaceTime nodes={st.names} tEnd={Math.max(120, run.doneAt + 10)} messages={st.messages} marks={marks} rowHeight={48} />
      <MiniTable head={["pn", "chunk", "sent (ms)", "fate", "TCP would send"]} rows={rows} highlight={(i) => run.packets[i]!.lostAt !== undefined} />
      <Stats items={[
        { label: "all data acked at", value: `${fixed(run.doneAt, 1)} ms` },
        { label: "RTT samples", value: `${rttSamples}, none ambiguous` },
        { label: "probe timeouts", value: run.events.filter((e) => e.kind === "pto").length },
        { label: "max_ack_delay (RFC 9000 default)", value: `${MAX_ACK_DELAY_MS} ms` },
      ]} />
    </Demo>
  );
}

// ============================================================================ 4. Connection migration

const MG = {
  sw: range({ label: "Wi-Fi drops at", min: 200, max: 1200, step: 50, default: MIGRATION_DEFAULT.switchMs, format: (v) => `${v} ms` }),
  cell: range({ label: "Cellular RTT", min: 20, max: 200, step: 10, default: MIGRATION_DEFAULT.cellRttMs, format: (v) => `${v} ms` }),
};

export function NetCcMigrationDemo() {
  const P = useParams("net-cc-mig", MG);
  const { sw, cell } = P.values;
  const o = { ...MIGRATION_DEFAULT, switchMs: sw, cellRttMs: cell };
  const res = useChunked(`net-cc-mig-${sw}-${cell}`, [() => migrationRun("tcp", o), () => migrationRun("quic", o)], { keep: true });
  const [tcp, quic] = res;
  const total = (o.packets * 1500) / 1e6;
  const xEnd = Math.min(o.durationMs, Math.ceil((Math.max(tcp?.doneMs ?? o.durationMs, quic?.doneMs ?? 0) + 200) / 100) * 100);
  return (
    <Demo
      title="Wi-Fi goes away in the middle of a download"
      controls={<>
        <Param spec={MG.sw} value={sw} onChange={(v) => P.set("sw", v as number)} />
        <Param spec={MG.cell} value={cell} onChange={(v) => P.set("cell", v as number)} />
      </>}
    >
      <Plot x={[0, xEnd]} y={[0, total * 1.05]} height={240} xLabel="time (ms)" yLabel="MB the application has read">
        <RuleX at={sw} color="var(--c4)" label="Wi-Fi down" />
        {tcp && <Line points={tcp.progress} color="var(--c2)" />}
        {quic && <Line points={quic.progress} color="var(--c1)" />}
      </Plot>
      <Legend items={[{ label: "TCP: open a new connection", color: "var(--c2)" }, { label: "QUIC: migrate the connection", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "TCP: no new data for", value: tcp ? `${sig(tcp.stallMs)} ms` : "…" },
        { label: "QUIC: no new data for", value: quic ? `${sig(quic.stallMs)} ms` : "…" },
        { label: "TCP: file done at", value: tcp ? `${sig(tcp.doneMs)} ms` : "…" },
        { label: "QUIC: file done at", value: quic ? `${sig(quic.doneMs)} ms` : "…" },
      ]} />
      <Banner>
        {`Model inputs: a ${fixed(total, 2)} MB file; Wi-Fi ${o.wifiMbps} Mbit/s with a ${o.wifiRttMs} ms RTT; cellular ${o.cellMbps} Mbit/s. TCP needs a handshake, TLS and a new request (2.5 RTTs). QUIC needs half an RTT and one RTT of path validation. Both restart in slow start.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 5. Header protection

const HP = {
  pn: range({ label: "Packet number", min: 0, max: 255, step: 1, default: 7 }),
  spin: toggle({ label: "Spin bit", default: false }),
  key: toggle({ label: "Key phase", default: false }),
};
const HP_KEY = 0x5eed;
const DCID = Uint8Array.from([0x8a, 0x3f, 0x10, 0xc2]);
const PROTECTED = new Set(["Reserved Bits", "Key Phase", "Packet Number Length", "Packet Number"]);

export function NetCcHeaderDemo() {
  const P = useParams("net-cc-hp", HP);
  const { pn, spin, key } = P.values;
  const [payloadSeed, setPayloadSeed] = useState(1);
  const h: ShortHeader = { spin: spin ? 1 : 0, keyPhase: key ? 1 : 0, pnLen: 1, dcid: DCID, pn };
  const fields = shortHeaderFields(h);
  const r = mulberry32(payloadSeed * 7919 + pn);
  const payload = Uint8Array.from({ length: 24 }, () => Math.floor(r() * 256));
  const mask = toyMask(HP_KEY, sampleOf(payload));
  const wire = protect(h, mask);
  const wireVals = unpackFields(fields, wire);
  const colors = fields.map((f) => (PROTECTED.has(f.name) ? "var(--c4)" : "var(--c3)"));
  const show = (vals: bigint[], wireView: boolean) =>
    vals.map((v, i) => (fields[i]!.short === "DCID" ? hex(DCID).replace(/ /g, "") : PROTECTED.has(fields[i]!.name) && wireView ? `${v}?` : String(v)));
  const endVals = unpackFields(fields, protect(h, new Uint8Array(5)));
  return (
    <Demo
      title="What a middlebox can read in a QUIC packet"
      actions={<Btn onClick={() => setPayloadSeed(payloadSeed + 1)}>Next packet, same number</Btn>}
      controls={<>
        <Param spec={HP.pn} value={pn} onChange={(v) => P.set("pn", v as number)} />
        <Param spec={HP.spin} value={spin} onChange={(v) => P.set("spin", v as boolean)} />
        <Param spec={HP.key} value={key} onChange={(v) => P.set("key", v as boolean)} />
      </>}
    >
      <SmallLabel>The endpoints see (a 1-byte packet number, a 4-byte connection ID):</SmallLabel>
      <HeaderDiagram fields={fields} colors={colors} rowBits={16} values={show(endVals, false)} />
      <SmallLabel style={{ marginTop: 10 }}>The network sees, after header protection (this demo makes the mask with a toy function in place of AES or ChaCha20):</SmallLabel>
      <HeaderDiagram fields={fields} colors={colors} rowBits={16} values={show(wireVals, true)} />
      <div style={{ ...mono, fontSize: 12.5, marginTop: 8, lineHeight: 1.6, overflowWrap: "anywhere" }}>
        <div><span className="muted">sample of the encrypted payload </span>{hex(sampleOf(payload))}</div>
        <div><span className="muted">mask </span>{hex(mask)}</div>
        <div><span className="muted">header, endpoint view </span>{hex(protect(h, new Uint8Array(5)))}</div>
        <div><span className="muted">header, on the wire </span>{hex(wire)}</div>
      </div>
      <Legend items={[{ label: "readable by anyone on the path", color: "var(--c3)" }, { label: "masked by header protection", color: "var(--c4)" }]} />
      <Banner>
        A middlebox can read the header form, the fixed bit, the spin bit and the connection ID. The packet number, key phase and its length change with every packet, even for the same number, because the mask comes from the encrypted payload. In TCP, the sequence number, ACK number, window and flags are all in clear text.
      </Banner>
    </Demo>
  );
}
