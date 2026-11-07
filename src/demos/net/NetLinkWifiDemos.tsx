/** Demos for "Wi-Fi": where the airtime goes, contention, the hidden terminal, the performance anomaly, rate adaptation. */
import { useMemo } from "react";
import { Banner, Demo, Dots, Legend, Line, Meter, MiniTable, Param, Plot, SectionLabel, SmallLabel, StackBar, Stats, Note, fixed, int, pct, range, seg, toggle, useChunked, useParams, useWidth, GOOD, BAD } from "../../kit";
import {
  OFDM, PHYS, SENSE_RANGE, airtime, bestRate, dcfRun, hiddenRun, maxAggregate, phyById, rateTable, shareAirtime, snrAt, type DcfTx, type Segment,
} from "../../sims/net/link";

const SEG_COLOR: Record<Segment["kind"], string> = {
  DIFS: "var(--faint)", backoff: "var(--border)", RTS: "var(--c2)", CTS: "var(--c2)", SIFS: "var(--subtle)", data: "var(--c1)", ACK: "var(--c3)", "Block Ack": "var(--c3)",
};

// ============================================================================ 1. Where the airtime goes

const AT = {
  payload: range({ label: "IP packet size", min: 64, max: 1500, step: 1, default: 1500, format: (v) => `${v} B` }),
  phy: seg("PHY", PHYS.map((p) => [p.id, p.label] as [string, string]), "a54"),
  agg: range({ label: "Frames per A-MPDU (802.11n/ac)", min: 1, max: 64, step: 1, default: 1 }),
  rts: toggle({ label: "RTS/CTS before each frame", default: false }),
};

export function AirtimeDemo() {
  const P = useParams("net-wifi-air", AT);
  const { payload, phy, agg, rts } = P.values;
  const ph = phyById(phy);
  const a = airtime({ payload, phy: ph, rts, aggregate: agg });
  const merged = a.segments.reduce<{ kind: Segment["kind"]; us: number }[]>((m, s) => {
    const last = m[m.length - 1];
    if (last && last.kind === s.kind) last.us += s.us;
    else m.push({ ...s });
    return m;
  }, []);
  const kinds = [...new Set(a.segments.map((s) => s.kind))];
  return (
    <Demo
      title="Where one frame's airtime goes"
      controls={<>
        <Param spec={AT.payload} value={payload} onChange={(v) => P.set("payload", v as number)} />
        <Param spec={AT.agg} value={agg} onChange={(v) => P.set("agg", v as number)} />
        <Param spec={AT.phy} value={phy} onChange={(v) => P.set("phy", v as string)} />
        <Param spec={AT.rts} value={rts} onChange={(v) => P.set("rts", v as boolean)} />
      </>}
    >
      <SmallLabel>One exchange: {fixed(a.totalUs, 1)} µs, {a.packets} packet{a.packets > 1 ? "s" : ""}</SmallLabel>
      <StackBar height={26} parts={merged.map((s) => ({ value: s.us, color: SEG_COLOR[s.kind], label: `${s.kind} ${fixed(s.us, 1)} µs` }))} />
      <Legend box items={kinds.map((k) => ({ label: `${k} ${fixed(a.segments.filter((s) => s.kind === k).reduce((x, s) => x + s.us, 0), 1)} µs`, color: SEG_COLOR[k] }))} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "PHY rate", value: `${ph.rate} Mb/s` },
          { label: "throughput, one station", value: `${fixed(a.throughput, 1)} Mb/s` },
          { label: "share of the PHY rate", value: pct(a.efficiency, 0) },
          { label: "payload bits on air", value: `${fixed(a.payloadUs, 1)} µs` },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 12 }}>Throughput in Mb/s for every PHY, with this packet size (frames per A-MPDU in brackets)</SmallLabel>
      <MiniTable head={["PHY (Mb/s)", "1 frame", `A-MPDU of ${agg}`]} rows={PHYS.map((p) => {
        const one = airtime({ payload, phy: p, rts, aggregate: 1 });
        const many = airtime({ payload, phy: p, rts, aggregate: agg });
        return [p.label.replace("802.", ""), fixed(one.throughput, 1), p.maxAmpdu ? `${fixed(many.throughput, 1)} (${maxAggregate(payload, p, agg)})` : "–"];
      })} highlight={(i) => PHYS[i]!.id === phy} />
      <Note>Fixed costs per exchange: DIFS {OFDM.difsUs} µs, an average backoff of {OFDM.cwMin / 2} slots of {OFDM.slotUs} µs, the preamble, SIFS {OFDM.sifsUs} µs and the ACK. Model input: the 40 µs preamble of the 802.11n/ac rows.</Note>
    </Demo>
  );
}

// ============================================================================ a strip chart of transmissions

function AirStrip({ log, rows, tEnd, names }: { log: DcfTx[]; rows: number; tEnd: number; names: string[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(260, width), left = 34, rowH = 16, top = 2;
  const h = top + (rows + 1) * rowH + 18;
  const x = (t: number) => left + (t / tEnd) * (w - left - 4);
  const rowOf = (from: number) => (from === 0 ? rows : from - 1);
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="transmissions over time" style={{ display: "block" }}>
        {names.map((n, i) => <text key={n} x={left - 6} y={top + i * rowH + 11} textAnchor="end" fontSize="10" fill="var(--muted)">{n}</text>)}
        <text x={left - 6} y={top + rows * rowH + 11} textAnchor="end" fontSize="10" fill="var(--muted)">AP</text>
        {log.filter((t) => t.start < tEnd && (t.from === 0 || t.from <= rows)).map((t, i) => {
          const r = rowOf(t.from);
          const c = t.from === 0 ? "var(--c3)" : t.collided ? BAD : t.kind === "RTS" ? "var(--c2)" : "var(--c1)";
          return <rect key={i} x={x(t.start)} y={top + r * rowH + 2} width={Math.max(1.5, x(Math.min(t.end, tEnd)) - x(t.start))} height={rowH - 4} fill={c} opacity={0.85} rx={1.5} />;
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <text key={f} x={x(f * tEnd)} y={h - 4} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} fontSize="10" fill="var(--muted)">{`${fixed((f * tEnd) / 1000, 1)} ms`}</text>)}
      </svg>
    </div>
  );
}

const STRIP_LEGEND = [{ label: "data", color: "var(--c1)" }, { label: "collided at the AP", color: BAD }, { label: "RTS", color: "var(--c2)" }, { label: "ACK / CTS from the AP", color: "var(--c3)" }];

// ============================================================================ 2. Contention

const CT = {
  n: range({ label: "Stations with traffic", min: 1, max: 50, step: 1, default: 5 }),
  cw: seg("CWmin", [["7", "7"], ["15", "15 (802.11a)"], ["31", "31"], ["63", "63"]], "15"),
  rts: toggle({ label: "RTS/CTS", default: false }),
};

const SWEEP_N = [1, 2, 3, 5, 8, 12, 20, 30, 50];

export function ContentionDemo() {
  const P = useParams("net-wifi-dcf", CT);
  const { n, cw, rts } = P.values;
  const cwMin = Number(cw);
  const r = useMemo(() => dcfRun({ n, payload: 1500, rate: 54, cwMin, rts, durationUs: 1e6, logUs: 6000 }), [n, cwMin, rts]);
  const sweep = useChunked(`${cwMin}|${rts}`, SWEEP_N.map((k) => () => dcfRun({ n: k, payload: 1500, rate: 54, cwMin, rts, durationUs: 1e6 })), { keep: true });
  const pts = SWEEP_N.flatMap((k, i) => (sweep[i] ? [[k, sweep[i]!.total] as [number, number]] : []));
  const fail = SWEEP_N.flatMap((k, i) => (sweep[i] ? [[k, sweep[i]!.failRate * 30] as [number, number]] : []));
  const rows = Math.min(n, 8);
  return (
    <Demo
      title="Stations take turns by random backoff"
      controls={<>
        <Param spec={CT.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={CT.cw} value={cw} onChange={(v) => P.set("cw", v as typeof cw)} />
        <Param spec={CT.rts} value={rts} onChange={(v) => P.set("rts", v as boolean)} />
      </>}
    >
      <SmallLabel>The first 6 ms{n > rows ? ` (stations 1–${rows} of ${n})` : ""}</SmallLabel>
      <AirStrip log={r.log} rows={rows} tEnd={6000} names={Array.from({ length: rows }, (_, i) => `S${i + 1}`)} />
      <Legend items={STRIP_LEGEND} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "total throughput", value: `${fixed(r.total, 1)} Mb/s` },
          { label: "attempts that fail", value: pct(r.failRate, 0) },
          { label: "per station", value: `${fixed(Math.min(...r.throughput), 2)}–${fixed(Math.max(...r.throughput), 2)} Mb/s` },
          { label: "dropped after 7 attempts", value: int(r.drops) },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 12 }}>Every station count: 54 Mb/s, 1500-byte packets, 1 s of simulated time each</SmallLabel>
      <Plot x={[1, 50]} y={[0, 32]} logX height={190} xLabel="stations" yLabel="Mb/s" xTicks={[1, 2, 5, 10, 20, 50]}>
        <Line points={pts} color="var(--c1)" />
        <Line points={fail} color={BAD} dash="4 3" />
        <Dots points={pts.filter(([k]) => k === n)} color="var(--c1)" r={5} />
      </Plot>
      <Legend items={[{ label: "total throughput (Mb/s)", color: "var(--c1)" }, { label: "failed attempts (30 = 100%)", color: BAD }]} />
    </Demo>
  );
}

// ============================================================================ 3. The hidden terminal

const HT = {
  d: range({ label: "Distance A to C", min: 10, max: 58, step: 1, default: 46, format: (v) => `${v} m` }),
  rate: seg("Data rate", [["6", "6 Mb/s"], ["12", "12 Mb/s"], ["24", "24 Mb/s"], ["54", "54 Mb/s"]], "12"),
  rts: toggle({ label: "RTS/CTS", default: false }),
};

export function HiddenTerminalDemo() {
  const P = useParams("net-wifi-hidden", HT);
  const { d, rate, rts } = P.values;
  const r = useMemo(() => hiddenRun({ distance: d, rts, payload: 1500, rate: Number(rate), durationUs: 2e6, logUs: 10_000 }), [d, rate, rts]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const w = Math.max(260, width), h = 150;
  const span = 58 / 2 + SENSE_RANGE + 2;
  const k = Math.min((w / 2 - 4) / span, (h / 2 - 4) / SENSE_RANGE);
  const sx = (m: number) => w / 2 + m * k;
  const rad = SENSE_RANGE * k;
  const cy = h / 2;
  const alone = useMemo(() => hiddenRun({ distance: 10, rts: false, payload: 1500, rate: Number(rate), durationUs: 2e6 }).total, [rate]);
  return (
    <Demo
      title="A and C cannot hear each other"
      controls={<>
        <Param spec={HT.d} value={d} onChange={(v) => P.set("d", v as number)} />
        <Param spec={HT.rate} value={rate} onChange={(v) => P.set("rate", v as typeof rate)} />
        <Param spec={HT.rts} value={rts} onChange={(v) => P.set("rts", v as boolean)} />
      </>}
    >
      <div ref={ref} style={{ width: "100%", overflow: "hidden" }}>
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="station layout" style={{ display: "block" }}>
          <circle cx={sx(-d / 2)} cy={cy} r={rad} fill="color-mix(in srgb, var(--c1) 8%, transparent)" stroke="var(--c1)" strokeDasharray="4 3" />
          <circle cx={sx(d / 2)} cy={cy} r={rad} fill="color-mix(in srgb, var(--c5) 8%, transparent)" stroke="var(--c5)" strokeDasharray="4 3" />
          {[[-d / 2, "A", "var(--c1)"], [d / 2, "C", "var(--c5)"]].map(([m, n, c]) => (
            <g key={n as string}>
              <circle cx={sx(m as number)} cy={cy} r={11} fill="var(--bg)" stroke={c as string} strokeWidth={2} />
              <text x={sx(m as number)} y={cy + 4} textAnchor="middle" fontSize="11" fontWeight={600} fill="var(--fg)">{n as string}</text>
            </g>
          ))}
          <path d={`M${sx(0) - 11} ${cy + 9}L${sx(0)} ${cy - 11}L${sx(0) + 11} ${cy + 9}Z`} fill="var(--bg)" stroke="var(--c3)" strokeWidth={2} />
          <text x={sx(0)} y={cy + 24} textAnchor="middle" fontSize="10.5" fill="var(--muted)">AP</text>
        </svg>
      </div>
      <Note>Dashed circles: how far each station can sense another, {SENSE_RANGE} m (a model input). Both reach the AP.</Note>
      <Banner tone={!r.hidden ? "good" : rts ? "warn" : "bad"}>
        {!r.hidden ? "A and C hear each other, so carrier sense works: each waits while the other sends."
          : rts ? "A and C are hidden, but each hears the AP's CTS and stays quiet for the time it announces. Collisions now hit only the short RTS frames."
          : "A and C are hidden from each other. Each senses an idle medium while the other is sending, so their frames overlap at the AP."}
      </Banner>
      <SmallLabel style={{ marginTop: 10 }}>The first 10 ms</SmallLabel>
      <AirStrip log={r.log} rows={2} tEnd={10_000} names={["A", "C"]} />
      <Legend items={STRIP_LEGEND} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "A + C throughput", value: `${fixed(r.total, 2)} Mb/s` },
          { label: "when they hear each other", value: `${fixed(alone, 2)} Mb/s` },
          { label: "attempts that fail", value: pct(r.failRate, 0) },
          { label: "frames dropped after retries", value: int(r.drops) },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 4. The performance anomaly

const AN = {
  slow: seg("Rate of station 3", [["54", "54 Mb/s"], ["24", "24 Mb/s"], ["12", "12 Mb/s"], ["6", "6 Mb/s"]], "6"),
  mode: seg("Scheduler", [["frames", "equal frames (DCF)"], ["airtime", "equal airtime (ATF)"]], "frames"),
};

export function AnomalyDemo() {
  const P = useParams("net-wifi-anomaly", AN);
  const { slow, mode } = P.values;
  const rates = [54, 54, Number(slow)];
  const r = shareAirtime(rates, 1500, mode);
  const allFast = shareAirtime([54, 54, 54], 1500, "frames");
  const colors = ["var(--c1)", "var(--c5)", "var(--c2)"];
  return (
    <Demo
      title="One slow station"
      controls={<>
        <Param spec={AN.slow} value={slow} onChange={(v) => P.set("slow", v as typeof slow)} />
        <Param spec={AN.mode} value={mode} onChange={(v) => P.set("mode", v as typeof mode)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Share of airtime</SectionLabel>
      <StackBar height={22} parts={r.airtime.map((a, i) => ({ value: a, color: colors[i]!, label: `station ${i + 1}: ${pct(a, 0)}` }))} />
      <Legend box items={r.airtime.map((a, i) => ({ label: `station ${i + 1} (${rates[i]} Mb/s): ${pct(a, 0)}`, color: colors[i]! }))} />
      <SectionLabel>Throughput</SectionLabel>
      {r.throughput.map((t, i) => <Meter key={i} label={`station ${i + 1} at ${rates[i]} Mb/s`} value={t} max={12} color={colors[i]!} text={`${fixed(t, 2)} Mb/s`} />)}
      <Banner tone={mode === "airtime" ? "good" : Number(slow) < 54 ? "bad" : "plain"}>
        {mode === "frames"
          ? Number(slow) < 54 ? `Each station sends the same number of frames, so the slow one takes ${pct(r.airtime[2]!, 0)} of the air. The fast stations drop from ${fixed(allFast.throughput[0]!, 2)} to ${fixed(r.throughput[0]!, 2)} Mb/s.` : "All stations are equally fast; equal frames are also equal airtime."
          : `Each station gets a third of the air. The fast ones keep ${fixed(r.throughput[0]!, 2)} Mb/s; the slow one gets what its own rate allows.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[{ label: "total", value: `${fixed(r.total, 2)} Mb/s` }, { label: "total if all ran at 54", value: `${fixed(allFast.total, 2)} Mb/s` }]} />
      </div>
      <Note>The AP sends full 1500-byte packets to three stations; no collisions. Each frame costs the airtime of one exchange at that station's rate.</Note>
    </Demo>
  );
}

// ============================================================================ 5. Rate adaptation

const RA = {
  d: range({ label: "Distance to the AP", min: 1, max: 120, step: 1, default: 45, format: (v) => `${v} m` }),
};

export function RateDemo() {
  const P = useParams("net-wifi-rate", RA);
  const { d } = P.values;
  const snr = snrAt(d);
  const t = rateTable(snr);
  const best = bestRate(snr);
  const greedy = [...t].reverse().find((p) => p.fer < 0.9);
  return (
    <Demo title="Pick the rate that delivers the most" controls={<Param spec={RA.d} value={d} onChange={(v) => P.set("d", v as number)} />}>
      <SmallLabel>SNR {fixed(snr, 1)} dB: goodput at each 802.11a rate</SmallLabel>
      {t.map((p) => (
        <Meter key={p.rate} label={`${p.rate} Mb/s · ${pct(p.fer, 0)} of frames lost`} value={p.goodput} max={31} color={p.rate === best.rate ? GOOD : "var(--c1)"} text={`${fixed(p.goodput, 1)} Mb/s`} />
      ))}
      <Banner tone="good">
        Best: <b>{best.rate} Mb/s</b>, {fixed(best.goodput, 1)} Mb/s of goodput.
        {greedy && greedy.rate > best.rate ? ` The fastest rate that still gets some frames through, ${greedy.rate} Mb/s, delivers only ${fixed(greedy.goodput, 1)} Mb/s.` : ""}
      </Banner>
      <Note>Model inputs: SNR = 75 − 35 log₁₀(distance) dB (indoor path loss), and each rate loses half its frames at a fixed SNR. Lost frames still cost their airtime. Real rate control (Minstrel in Linux) must find this peak by sampling, because it cannot see the SNR curve.</Note>
    </Demo>
  );
}
