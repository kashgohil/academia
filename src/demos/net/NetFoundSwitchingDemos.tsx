/** Demos for "Packets and switching": circuits vs shared links, pipelining through store-and-forward hops, a router queue, and head-of-line blocking. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, ButtonRow, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleX, RuleY, SectionLabel, Stats, fixed, int, ms, pct, range,
  toggle, useChunked, useParams, MONO, tint,
} from "../../kit";
import { SpaceTime, type StMessage } from "../dist/SpaceTime";
import { fromPackets } from "./PacketViews";
import { Lanes, userColor } from "./NetFoundUi";
import { mulberry32 } from "../../sims/rng";
import {
  HOL_LIMIT, chainHops, holBlocked, holInit, holStep, holThroughput, md1WaitMs, mm1WaitMs, oneBigPacketMs, packetCount, pipelineRun,
  queueRun, shareRun, storeForwardMs, type HolState, type PipeOpts,
} from "../../sims/net/foundations";

// ============================================================================ 1. Circuits or packets

/** Model inputs: a 10 Mbit/s link and 15 kB files (ten 1500-byte packets). */
const SHARE_RATE = 10e6, SHARE_FILE = 15_000, SHARE_RUN = 2000, SHARE_VIEW = 400;

const SH = {
  users: range({ label: "Users", min: 2, max: 16, step: 1, default: 10 }),
  load: range({ label: "Offered load (all users together)", min: 0.05, max: 0.95, step: 0.05, default: 0.3, format: (v) => pct(v, 0) }),
};

export function CircuitPacketDemo() {
  const P = useParams("net-found-share", SH);
  const { users, load } = P.values;
  const [seed, setSeed] = useState(1);
  const base = { users, rate: SHARE_RATE, fileBytes: SHARE_FILE, load, durationMs: SHARE_RUN, seed };
  const circ = useMemo(() => shareRun({ ...base, mode: "circuit" }), [users, load, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const pkt = useMemo(() => shareRun({ ...base, mode: "packet" }), [users, load, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = Array.from({ length: users }, (_, i) => `U${i + 1}`);
  const ratio = circ.meanMs / pkt.meanMs;
  return (
    <Demo
      title="One link: reserved slices or shared packets"
      actions={<Btn onClick={() => setSeed(seed + 1)}>New random run</Btn>}
      controls={<>
        <Param spec={SH.users} value={users} onChange={(v) => P.set("users", v as number)} />
        <Param spec={SH.load} value={load} onChange={(v) => P.set("load", v as number)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        {users} users send 15 kB files at random times over one 10 Mbit/s link (model inputs). Colored blocks are packets on the wire, first {SHARE_VIEW} ms.
      </div>
      <Lanes title={`Circuit switching: each user owns 1/${users} of the link (${fixed(SHARE_RATE / users / 1e6, 2)} Mbit/s), busy or not`} lanes={users} labels={labels} busy={circ.busy} tEnd={SHARE_VIEW} rowH={users > 10 ? 7 : 10} />
      <div style={{ height: 8 }} />
      <Lanes title="Packet switching: all users share the whole 10 Mbit/s through one queue" lanes={1} labels={["link"]} busy={pkt.busy} tEnd={SHARE_VIEW} rowH={22} />
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["", "circuit", "packet"]}
          rows={[
            ["mean time per file", ms(circ.meanMs), ms(pkt.meanMs)],
            ["95th percentile", ms(circ.p95Ms), ms(pkt.p95Ms)],
            ["best case (link to yourself)", ms(SHARE_FILE * 8 * 1000 / (SHARE_RATE / users)), ms(pkt.aloneMs)],
            ["link capacity used", pct(circ.utilization, 0), pct(pkt.utilization, 0)],
            ["files sent", int(circ.transfers.length), int(pkt.transfers.length)],
          ]}
        />
      </div>
      <Banner tone={ratio > 1 ? "good" : "warn"}>
        The same files over the same capacity: shared packets finish {fixed(ratio, 1)}× faster on average. A reserved slice sits idle while its owner thinks, and a busy owner cannot borrow the idle slices.
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Store-and-forward pipelining

/** Model inputs: every link 10 Mbit/s with 0.5 ms of propagation, 40 bytes of headers per packet. */
const PIPE = { rate: 10e6, delay: 0.5, header: 40 };

const PI = {
  pkt: range({ label: "Data bytes per packet", min: 100, max: 15000, log: true, default: 1460, format: (v) => `${int(v)} B` }),
  hops: range({ label: "Links on the path", min: 1, max: 6, step: 1, default: 3 }),
  msg: range({ label: "Message size", min: 1500, max: 30000, step: 500, default: 15000, format: (v) => `${fixed(v / 1000, 1)} kB` }),
  cut: toggle({ label: "Cut-through switches", default: false }),
};

export function PipelineDemo() {
  const P = useParams("net-found-pipe", PI);
  const { pkt, hops, msg, cut } = P.values;
  const o: PipeOpts = { ...PIPE, hops, msgBytes: msg, pktData: Math.round(pkt) };
  const n = packetCount(o);
  const run = useMemo(() => pipelineRun(o), [hops, msg, pkt]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctHops = useMemo(() => chainHops(o, true), [hops, msg, pkt]); // eslint-disable-line react-hooks/exhaustive-deps
  const sfMs = run.doneMs;
  const ctMs = Math.max(...ctHops.map((h) => h.arriveAt!));
  const bigMs = oneBigPacketMs(o);
  const names = Array.from({ length: hops + 1 }, (_, i) => (i === 0 ? "src" : i === hops ? "dst" : `R${i}`));
  const label = (k: number) => (n <= 12 ? `${k}` : undefined);
  const st = fromPackets(run.net, { label: (p) => label(p.payload) });
  const messages: StMessage[] = cut ? ctHops.map((h) => ({ from: h.from, to: h.to, sentAt: h.txStart, deliveredAt: h.arriveAt, label: label(h.pkt), color: "var(--c3)" })) : st.messages;
  const sweep = useMemo(() => {
    const pts: { s: number; sf: number; ct: number }[] = [];
    for (let k = 0; k <= 48; k++) {
      const s = Math.round(100 * Math.pow(150, k / 48));
      const q = { ...o, pktData: s };
      const sh = chainHops(q, false), ch = chainHops(q, true);
      pts.push({ s, sf: Math.max(...sh.map((h) => h.arriveAt!)), ct: Math.max(...ch.map((h) => h.arriveAt!)) });
    }
    return pts;
  }, [hops, msg]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => {
    // Refine the grid's best size with a search over whole bytes near it.
    const g = sweep.reduce((a, b) => (b.sf < a.sf ? b : a));
    let b = g;
    for (let s = Math.max(1, Math.floor(g.s / 1.15)); s <= Math.min(msg, Math.ceil(g.s * 1.15)); s++) {
      const t = storeForwardMs({ ...o, pktData: s });
      if (t < b.sf - 1e-12) b = { s, sf: t, ct: b.ct };
    }
    return b;
  }, [sweep]); // eslint-disable-line react-hooks/exhaustive-deps
  const yMax = Math.max(...sweep.map((p) => p.sf)) * 1.05;
  const tEnd = Math.max(sfMs, ctMs, 1) * 1.04;
  return (
    <Demo
      title="A message cut into packets crosses the routers"
      controls={<>
        <Param spec={PI.pkt} value={pkt} onChange={(v) => P.set("pkt", v as number)} />
        <Param spec={PI.hops} value={hops} onChange={(v) => P.set("hops", v as number)} />
        <Param spec={PI.msg} value={msg} onChange={(v) => P.set("msg", v as number)} />
        <Param spec={PI.cut} value={cut} onChange={(v) => P.set("cut", v as boolean)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Each arrow is one packet on one link: it leaves with its first bit and lands with its last. Links: 10 Mbit/s, 0.5 ms, 40 header bytes per packet (model inputs).
      </div>
      <SpaceTime nodes={names} tEnd={tEnd} messages={messages} rowHeight={hops > 4 ? 36 : 44} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "packets", value: int(n) },
          { label: "store-and-forward", value: ms(sfMs) },
          { label: "cut-through", value: ms(ctMs) },
          { label: "as one big packet", value: ms(bigMs) },
          { label: "header share", value: pct((n * PIPE.header) / (msg + n * PIPE.header)) },
        ]} />
      </div>
      <SectionLabel>Time for the whole message, by packet size</SectionLabel>
      <Plot x={[100, 15000]} y={[0, yMax]} logX height={200} xLabel="data bytes per packet" yLabel="ms" xTicks={[100, 300, 1000, 3000, 10000]} xFormat={(v) => int(v)}>
        <Line points={sweep.map((p) => [p.s, p.sf])} color="var(--c1)" />
        <Line points={sweep.map((p) => [p.s, p.ct])} color="var(--c3)" dash="5 3" />
        <RuleX at={pkt} color="var(--muted)" />
        <Dots points={[[best.s, best.sf]]} color="var(--c1)" r={4} />
      </Plot>
      <Legend items={[{ label: "store-and-forward", color: "var(--c1)" }, { label: "cut-through", color: "var(--c3)" }]} />
      <Banner tone="info">
        Best store-and-forward size here: about {int(best.s)} data bytes ({ms(best.sf)}). Smaller packets pay more headers; larger packets make each router wait longer before it can send.
      </Banner>
    </Demo>
  );
}

// ============================================================================ 3. A queue at a router

/** Model inputs: a 10 Mbit/s output link, 1500-byte packets, four input ports. */
const QR = { rate: 10e6, pktBytes: 1500, inputs: 4 };
const Q_RUN = 500;
const SWEEP_LOADS = Array.from({ length: 19 }, (_, i) => 0.05 * (i + 1));

const QU = {
  load: range({ label: "Random (Poisson) load", min: 0, max: 1.3, step: 0.05, default: 0.7, format: (v) => pct(v, 0) }),
  buf: range({ label: "Buffer", min: 4, max: 120, step: 1, default: 40, format: (v) => `${v} packets` }),
};

export function RouterQueueDemo() {
  const P = useParams("net-found-queue", QU);
  const { load, buf } = P.values;
  const [bursts, setBursts] = useState<number[]>([]);
  const [seed, setSeed] = useState(1);
  const r = useMemo(() => queueRun({ ...QR, load, bufferPkts: buf, durationMs: Q_RUN, seed, bursts: bursts.map((t) => ({ t, n: 10 })) }), [load, buf, seed, bursts]);
  const qpts = useMemo(() => {
    const pts: [number, number][] = [[0, 0]];
    for (const [t, q] of r.qlog) { pts.push([t, pts[pts.length - 1]![1]]); pts.push([t, q]); }
    pts.push([Q_RUN + 20, pts[pts.length - 1]![1]]);
    return pts;
  }, [r]);
  const sweep = useChunked("net-found-queue-sweep", SWEEP_LOADS.map((l) => () => queueRun({ ...QR, load: l, bufferPkts: 100000, durationMs: 30000, seed: 3, record: false }).meanWaitMs));
  const sv = r.serviceMs;
  const nextBurst = bursts.length ? Math.min(450, bursts[bursts.length - 1]! + 100) : 100;
  const yMax = Math.max(buf + 4, 10);
  return (
    <Demo
      title="Fill the output queue of a router"
      actions={<Btn onClick={() => setSeed(seed + 1)}>New random run</Btn>}
      controls={<>
        <Param spec={QU.load} value={load} onChange={(v) => P.set("load", v as number)} />
        <Param spec={QU.buf} value={buf} onChange={(v) => P.set("buf", v as number)} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <Btn disabled={bursts.length >= 4} onClick={() => setBursts([...bursts, nextBurst])}>Add a burst: 4 inputs × 10 packets at {nextBurst} ms</Btn>
        <Btn ghost disabled={!bursts.length} onClick={() => setBursts([])}>No bursts</Btn>
      </ButtonRow>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
        Four inputs feed one 10 Mbit/s output. One 1500-byte packet takes {ms(sv)} to send (model inputs). Red dots: drops at a full buffer.
      </div>
      <Plot x={[0, Q_RUN + 20]} y={[0, yMax]} height={200} xLabel="time (ms)" yLabel="packets waiting">
        <Line points={qpts} color="var(--c2)" width={1.5} />
        <RuleY at={buf} color="var(--c4)" label="buffer full" />
        {bursts.map((t) => <RuleX key={t} at={t} color="var(--c1)" />)}
        <Dots points={r.drops.map((t) => [t, buf])} color="var(--c4)" r={2.5} />
      </Plot>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "mean wait in the queue", value: ms(r.meanWaitMs) },
          { label: "99th percentile wait", value: ms(r.p99WaitMs) },
          { label: "packets dropped", value: `${int(r.drops.length)} of ${int(r.sent)}` },
          { label: "longest wait the buffer allows", value: ms(buf * sv) },
        ]} />
      </div>
      <SectionLabel>Mean wait by load (long runs, no bursts, large buffer)</SectionLabel>
      <Plot x={[0, 1]} y={[0, 12]} height={190} xLabel="load ρ" yLabel="mean wait (ms)">
        <Line points={SWEEP_LOADS.map((l) => [l, md1WaitMs(l, sv)])} color="var(--c1)" />
        <Line points={SWEEP_LOADS.map((l) => [l, mm1WaitMs(l, sv)])} color="var(--faint)" dash="4 3" />
        <Dots points={SWEEP_LOADS.flatMap((l, i) => (sweep[i] !== undefined ? [[l, sweep[i]!] as [number, number]] : []))} color="var(--c2)" r={3} />
        {load <= 1 && <RuleX at={load} color="var(--muted)" />}
      </Plot>
      <Legend items={[{ label: "PacketNet runs", color: "var(--c2)" }, { label: "M/D/1 formula", color: "var(--c1)" }, { label: "M/M/1 (sizes vary)", color: "var(--faint)" }]} />
    </Demo>
  );
}

// ============================================================================ 4. Head-of-line blocking

const HO = {
  n: range({ label: "Ports (N × N switch)", min: 2, max: 12, step: 1, default: 4 }),
};
const SWEEP_N = Array.from({ length: 16 }, (_, i) => i + 1);

export function HolDemo() {
  const P = useParams("net-found-hol", HO);
  const { n } = P.values;
  const [run, setRun] = useState<{ n: number; seed: number; s: HolState; rng: () => number; last?: number[]; blocked: number[] } | null>(null);
  const cur = run && run.n === n ? run : (() => { const rng = mulberry32(11 + n); return { n, seed: 11 + n, s: holInit(n, rng, 3), rng, blocked: [] as number[], last: undefined }; })();
  const step = (k: number) => {
    const c = { ...cur, s: { ...cur.s, queues: cur.s.queues.map((q) => [...q]) } };
    let last: number[] = [], blocked: number[] = [];
    for (let i = 0; i < k; i++) {
      const before = c.s.queues.map((q) => [...q]);
      last = holStep(c.s, c.rng);
      blocked = holBlocked(before, last);
    }
    setRun({ ...c, last, blocked });
  };
  const sweep = useChunked("net-found-hol-sweep", SWEEP_N.map((m) => () => holThroughput(m, 20000, 5)));
  const winnerOf = new Map<number, number>();
  cur.last?.forEach((w, out) => { if (w >= 0) winnerOf.set(w, out); });
  const thr = cur.s.slots ? cur.s.sent / (cur.s.n * cur.s.slots) : NaN;
  return (
    <Demo
      title="Head-of-line blocking in an input-queued switch"
      actions={<>
        <Btn onClick={() => step(1)}>Step one slot</Btn>
        <Btn onClick={() => step(500)}>Run 500 slots</Btn>
        <Btn ghost onClick={() => setRun(null)}>Reset</Btn>
      </>}
      controls={<Param spec={HO.n} value={n} onChange={(v) => { P.set("n", v as number); setRun(null); }} />}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Each input has a FIFO queue, head on the right. A number is the output a packet wants. Each output takes one packet per slot. Every input always has packets.
      </div>
      <div style={{ display: "grid", gap: 3 }}>
        {cur.s.queues.map((q, i) => {
          const won = winnerOf.get(i);
          const blocked = cur.blocked.includes(i);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 12 }}>
              <span style={{ width: 28, color: "var(--muted)" }}>in{i + 1}</span>
              <span style={{ display: "flex", flexDirection: "row-reverse", gap: 3 }}>
                {q.map((d, k) => (
                  <span key={k} style={{ width: 26, textAlign: "center", borderRadius: 4, padding: "1px 0", border: `1.5px solid ${userColor(d)}`, background: k === 0 ? tint(userColor(d), 35) : "var(--bg)", opacity: k === 0 ? 1 : 0.75 }}>{d + 1}</span>
                ))}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: won !== undefined ? "var(--c3)" : blocked ? "var(--c4)" : "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {cur.last ? (won !== undefined ? `sent to out${won + 1}` : blocked ? "HOL-blocked: a later packet's output is idle" : "lost the contention") : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "slots", value: int(cur.s.slots) },
          { label: "throughput per port", value: cur.s.slots ? pct(thr) : "–" },
          { label: "idle outputs last slot", value: cur.last ? cur.last.filter((w) => w < 0).length : "–" },
          { label: "large-N limit 2 − √2", value: pct(HOL_LIMIT) },
        ]} />
      </div>
      <SectionLabel>Saturation throughput by switch size (20,000 slots each)</SectionLabel>
      <Plot x={[1, 16]} y={[0.5, 1]} height={170} xLabel="ports N" yFormat={(y) => `${Math.round(y * 100)}%`}>
        <RuleY at={HOL_LIMIT} color="var(--c4)" />
        <Line points={SWEEP_N.flatMap((m, i) => (sweep[i] !== undefined ? [[m, sweep[i]!] as [number, number]] : []))} color="var(--c2)" />
        <Dots points={SWEEP_N.flatMap((m, i) => (sweep[i] !== undefined ? [[m, sweep[i]!] as [number, number]] : []))} color="var(--c2)" r={2.5} />
        <RuleX at={n} color="var(--muted)" />
      </Plot>
      <Legend items={[{ label: "measured, FIFO inputs", color: "var(--c2)" }, { label: "limit 2 − √2 ≈ 58.6%", color: "var(--c4)" }]} />
    </Demo>
  );
}
