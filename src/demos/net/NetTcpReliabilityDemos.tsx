/** Demos for "Reliability and retransmission": be the network for four protocols, the RTO estimator, and a loss sweep. */
import { useMemo, useState } from "react";
import { Banner, Chip, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleY, SmallLabel, Stats, int, pct, range, seg, useChunked, useParams } from "../../kit";
import { SpaceTime } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { arqRun, arqSweepPoint, backoffSchedule, jitterySamples, rtoSeries, type ArqProto, type ArqPayload } from "../../sims/net/transport";
import { mulberry32 } from "../../sims/rng";
import type { Packet } from "../../sims/net";

const PROTO_NAME: Record<ArqProto, string> = { gbn: "Go-back-N", sr: "Selective repeat", tcp: "TCP (no SACK)", sack: "TCP with SACK" };
const PROTO_COLOR: Record<ArqProto, string> = { gbn: "var(--c2)", sr: "var(--c5)", tcp: "var(--c1)", sack: "var(--c3)" };

// ============================================================================ 1. Be the network

const AQ = {
  window: range({ label: "Window", min: 1, max: 8, step: 1, default: 5, format: (v) => `${v} segment${v > 1 ? "s" : ""}` }),
  proto: seg<ArqProto>("Protocol", [["gbn", "Go-back-N"], ["sr", "Selective repeat"], ["tcp", "TCP"], ["sack", "TCP + SACK"]], "tcp"),
};
const N = 12;

export function NetTcpArqDemo() {
  const P = useParams("net-rel-arq", AQ);
  const { window, proto } = P.values;
  const [dropData, setDropData] = useState<number[]>([3]);
  const [dropAcks, setDropAcks] = useState<number[]>([]);
  const flip = (xs: number[], set: (v: number[]) => void, i: number) => set(xs.includes(i) ? xs.filter((x) => x !== i) : [...xs, i]);
  const base = { n: N, window, dropData, dropAcks };
  const r = useMemo(() => arqRun({ ...base, proto: proto as ArqProto }), [proto, window, dropData, dropAcks]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => (["gbn", "sr", "tcp", "sack"] as ArqProto[]).map((p) => ({ p, r: arqRun({ ...base, proto: p, record: false }) })), [window, dropData, dropAcks]); // eslint-disable-line react-hooks/exhaustive-deps
  const isHs = (p: Packet<ArqPayload>) => "flags" in p.payload && (p.payload.flags & 0x02) !== 0;
  const st = fromPackets(r.net, {
    filter: (p) => !isHs(p),
    label: (p) => (r.isData(p) ? r.label(p) : undefined),
    color: (p) => (r.isRetx(p) ? "var(--c4)" : r.isData(p) ? "var(--c1)" : "var(--muted)"),
  });
  const tStart = Math.max(0, r.t0 - 2);
  // The ACK stream as the receiver sent it, in order; lost ones struck through. Duplicates of the previous ACK in color.
  const lostIds = new Set(r.net.hops.filter((h) => h.lost).map((h) => h.pkt));
  const ackPkts = r.net.trace.flatMap((e) => (e.kind === "send" && e.node === 1 && !isHs(e.pkt) ? [e.pkt] : []));
  const ackLabels = ackPkts.map((p) => r.label(p).replace("+S", ""));
  const lastT = Math.max(...r.net.hops.map((h) => h.arriveAt ?? h.txEnd));
  return (
    <Demo
      title="You are the network: drop segments and ACKs"
      controls={<>
        <Param spec={AQ.window} value={window} onChange={(v) => P.set("window", v as number)} />
        <Param spec={AQ.proto} value={proto} onChange={(v) => P.set("proto", v as ArqProto)} />
      </>}
    >
      <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12, minWidth: 92 }}>Lose segment:</span>
          {Array.from({ length: N }, (_, k) => k + 1).map((i) => <Chip key={i} filled={dropData.includes(i)} color={dropData.includes(i) ? "var(--c4)" : "var(--c1)"} onClick={() => flip(dropData, setDropData, i)}>{i}</Chip>)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12, minWidth: 92 }}>Lose ACK sent for:</span>
          {Array.from({ length: N }, (_, k) => k + 1).map((i) => <Chip key={i} filled={dropAcks.includes(i)} color={dropAcks.includes(i) ? "var(--c4)" : "var(--muted)"} onClick={() => flip(dropAcks, setDropAcks, i)}>{i}</Chip>)}
        </div>
      </div>
      <SpaceTime nodes={st.names} tStart={tStart} tEnd={lastT + 10} messages={st.messages} marks={st.marks} rowHeight={70} />
      <Legend items={[{ label: "data (number = segment)", color: "var(--c1)" }, { label: "ACK", color: "var(--muted)" }, { label: "retransmission", color: "var(--c4)" }]} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center", marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>{proto === "sr" ? "ACKs (✓n: segment n arrived):" : `ACKs (An: next segment wanted${proto === "sack" ? "; +S: with SACK blocks" : ""}):`}</span>
        {ackPkts.map((p, i) => {
          const dup = i > 0 && ackLabels[i] === ackLabels[i - 1] && proto !== "sr";
          return <Chip key={p.id} strike={lostIds.has(p.id)} faint={lostIds.has(p.id)} color={dup ? "var(--c2)" : "var(--muted)"}>{r.label(p)}</Chip>;
        })}
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "all acknowledged after", value: Number.isFinite(r.doneAt) ? `${int(r.doneAt)} ms` : "not yet" },
          { label: "segments sent", value: r.sends },
          { label: "retransmissions", value: r.retx },
          { label: "timeouts", value: r.timeouts },
          { label: "fast retransmits", value: r.fastRetx },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 8 }}>The same losses, all four protocols:</SmallLabel>
      <MiniTable
        head={["protocol", "done", "sent", "resent", "timeouts"]}
        rows={all.map(({ p, r: x }) => [PROTO_NAME[p], `${int(x.doneAt)} ms`, x.sends, x.retx, x.timeouts])}
        highlight={(i) => all[i]!.p === proto}
      />
    </Demo>
  );
}

// ============================================================================ 2. The RTO estimator

const RT = {
  base: range({ label: "Base RTT", min: 5, max: 300, step: 5, default: 50, format: (v) => `${v} ms` }),
  jitter: range({ label: "Jitter (±)", min: 0, max: 100, step: 1, default: 10, format: (v) => `${v} ms` }),
  spike: range({ label: "Delay spike every", min: 0, max: 60, step: 5, default: 40, format: (v) => (v ? `${v} samples` : "never") }),
  size: range({ label: "Spike size", min: 0, max: 600, step: 10, default: 250, format: (v) => `+${v} ms` }),
  min: seg<string>("Minimum RTO", [["200", "200 ms floor"], ["1000", "1 s (RFC 6298)"]], "200"),
};

export function NetTcpRtoDemo() {
  const P = useParams("net-rel-rto", RT);
  const { base, jitter, spike, size, min } = P.values;
  const minRto = Number(min);
  const series = useMemo(() => {
    const samples = jitterySamples(120, base, jitter, spike, size, mulberry32(7));
    return rtoSeries(samples, { initialRto: 1000, minRto, maxRto: 120_000, granularity: 1 });
  }, [base, jitter, spike, size, minRto]);
  const spurious = series.filter((s) => s.spurious && s.i > 0);
  const last = series[series.length - 1]!;
  const yMax = Math.max(...series.map((s) => Math.max(s.r, s.rto))) * 1.08;
  const giveUp = backoffSchedule(last.rto, 15, 120_000);
  return (
    <Demo
      title="RFC 6298: the timeout follows the RTT and its spread"
      controls={<>
        <Param spec={RT.base} value={base} onChange={(v) => P.set("base", v as number)} />
        <Param spec={RT.jitter} value={jitter} onChange={(v) => P.set("jitter", v as number)} />
        <Param spec={RT.spike} value={spike} onChange={(v) => P.set("spike", v as number)} />
        <Param spec={RT.size} value={size} onChange={(v) => P.set("size", v as number)} />
        <Param spec={RT.min} value={min} onChange={(v) => P.set("min", v as string)} />
      </>}
    >
      <Plot x={[0, 120]} y={[0, yMax]} height={240} xLabel="sample number" yLabel="ms">
        <RuleY at={minRto} label="minimum RTO" />
        <Line points={series.map((s) => [s.i, s.rto] as const)} color="var(--c4)" />
        <Line points={series.map((s) => [s.i, s.srtt] as const)} color="var(--c3)" />
        <Dots points={series.map((s) => [s.i, s.r] as const)} color="var(--c1)" r={2} />
        <Dots points={spurious.map((s) => [s.i, s.r] as const)} color="var(--c4)" r={4.5} />
      </Plot>
      <Legend items={[{ label: "RTT sample", color: "var(--c1)" }, { label: "SRTT", color: "var(--c3)" }, { label: "RTO = SRTT + 4·RTTVAR", color: "var(--c4)" }]} />
      <Banner tone={spurious.length ? "bad" : "good"}>
        {spurious.length
          ? `${spurious.length} sample${spurious.length > 1 ? "s" : ""} took longer than the RTO in force (big red dots). The segment was not lost, but the timer fired: a spurious retransmission.`
          : "No sample exceeded the RTO in force: the 4·RTTVAR margin covers the jitter."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "SRTT", value: `${int(last.srtt)} ms` },
          { label: "RTTVAR", value: `${int(last.rttvar)} ms` },
          { label: "RTO", value: `${int(last.rto)} ms` },
          { label: "if every copy is lost, give up after (15 retries)", value: `${(giveUp.giveUpAt / 1000).toFixed(1)} s` },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. Random loss sweep

const SW = {
  metric: seg<string>("Show", [["ms", "time to deliver 60 segments"], ["copies", "copies sent per segment"]], "ms"),
};
const LOSSES = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15];
const PROTOS: ArqProto[] = ["gbn", "sr", "tcp", "sack"];

export function NetTcpLossSweepDemo() {
  const P = useParams("net-rel-sweep", SW);
  const { metric } = P.values;
  const jobs = useMemo(() => PROTOS.flatMap((p) => LOSSES.map((l) => () => ({ p, l, ...arqSweepPoint(p, l, 6, 60, 8) }))), []);
  const res = useChunked("net-rel-sweep", jobs);
  const pts = (p: ArqProto) => res.filter((x) => x && x.p === p).map((x) => [x!.l * 100, metric === "ms" ? x!.ms : x!.sendsPerSeg] as const);
  const done = res.filter(Boolean).length;
  const yMax = metric === "ms" ? Math.max(1000, ...res.map((x) => x?.ms ?? 0)) * 1.05 : Math.max(1.5, ...res.map((x) => x?.sendsPerSeg ?? 0)) * 1.05;
  const at10 = (p: ArqProto) => res.find((x) => x && x.p === p && x.l === 0.1);
  return (
    <Demo title="Random loss: how each protocol pays" controls={<Param spec={SW.metric} value={metric} onChange={(v) => P.set("metric", v as string)} />}>
      <Plot x={[0, 15]} y={[0, yMax]} height={240} xLabel="loss rate (%), both directions" yLabel={metric === "ms" ? "ms (mean of 6 runs)" : "copies per segment"}>
        {PROTOS.map((p) => <Line key={p} points={pts(p)} color={PROTO_COLOR[p]} />)}
        {PROTOS.map((p) => <Dots key={`d${p}`} points={pts(p)} color={PROTO_COLOR[p]} r={2.5} />)}
      </Plot>
      <Legend items={PROTOS.map((p) => ({ label: PROTO_NAME[p], color: PROTO_COLOR[p] }))} />
      <Banner tone="plain" label={done < jobs.length ? `${done}/${jobs.length}` : undefined}>
        Window 8 segments, one-way delay 20 ms, timeout 200 ms.{" "}
        {at10("gbn") && at10("sack") ? `At ${pct(0.1, 0)} loss, go-back-N sends ${at10("gbn")!.sendsPerSeg.toFixed(2)} copies per segment and TCP with SACK sends ${at10("sack")!.sendsPerSeg.toFixed(2)}.` : "Running…"}
      </Banner>
    </Demo>
  );
}
