/** Demos for "CSP and channels": what capacity buys on a timeline, and the happens-before edges of one channel. */
import { useMemo, useState } from "react";
import {
  Arrow, Banner, Bars, Btn, ButtonRow, Chip, Demo, Legend, Line, Note, Param, Plot, RuleX, SmallLabel, Stats, int, range, seg, useParams, useWidth,
} from "../../kit";
import { DEFAULT_COSTS } from "../../sims/conc";
import { ChanHb, runProducerConsumer, type HbOp, type Side } from "../../sims/conc/message-passing";
import { ThreadTimeline } from "./ConcViews";

const us = (ns: number) => `${int(ns / 1_000)} µs`;

// ---------------------------------------------------------------- capacity on a timeline

const CAP = {
  capacity: range({ label: "Channel capacity", min: 0, max: 8, step: 1, default: 0, format: (v) => (v === 0 ? "0 (rendezvous)" : `${v}`) }),
  produce: range({ label: "Producer work per item", min: 5, max: 60, step: 5, default: 20, format: (v) => `${v} µs` }),
  consume: range({ label: "Consumer work per item", min: 5, max: 60, step: 5, default: 30, format: (v) => `${v} µs` }),
  jitter: range({ label: "Jitter of each work time", min: 0, max: 100, step: 10, default: 0, format: (v) => `±${v}%` }),
};

export function ConcMsgCapacityDemo() {
  const P = useParams("conc-msg-cap", CAP);
  const { capacity, produce, consume, jitter } = P.values;
  const cfg = { produceNs: produce * 1_000, consumeNs: consume * 1_000, jitter: jitter / 100 };
  const run = useMemo(() => runProducerConsumer({ ...cfg, capacity }), [capacity, produce, consume, jitter]); // eslint-disable-line react-hooks/exhaustive-deps
  const sweep = useMemo(() => Array.from({ length: 9 }, (_, k) => runProducerConsumer({ ...cfg, capacity: k, record: false }).makespan), [produce, consume, jitter]); // eslint-disable-line react-hooks/exhaustive-deps
  const lens = run.result.channels[0]!.lens;
  const end = run.makespan;
  const steps: [number, number][] = [[0, 0]];
  for (const [t, n] of lens) steps.push([t / 1_000, steps[steps.length - 1]![1]], [t / 1_000, n]);
  steps.push([end / 1_000, steps[steps.length - 1]![1]]);
  const maxSweep = Math.max(...sweep);
  return (
    <Demo
      title="A producer, a consumer and one channel"
      controls={<>{(Object.keys(CAP) as (keyof typeof CAP)[]).map((k) => <Param key={k} spec={CAP[k]} value={P.values[k]} onChange={(v) => P.set(k, v as number)} />)}</>}
    >
      <ThreadTimeline result={run.result} by="thread" labels={false} />
      <SmallLabel style={{ marginTop: 8 }}>Values in the buffer</SmallLabel>
      {capacity === 0 ? (
        <Banner>No buffer. Each value passes from hand to hand, so a send waits for a receive and a receive waits for a send.</Banner>
      ) : (
        <Plot x={[0, end / 1_000]} y={[0, capacity]} height={92} xLabel="µs" yTicks={[0, capacity]}>
          <Line points={steps} color="var(--c2)" />
        </Plot>
      )}
      <Stats items={[
        { label: "24 items take", value: us(run.makespan) },
        { label: "producer blocked", value: `${run.producerBlocks}× · ${us(run.producerBlockedNs)}` },
        { label: "consumer blocked", value: `${run.consumerBlocks}× · ${us(run.consumerBlockedNs)}` },
        { label: "most values buffered", value: run.maxLen },
      ]} />
      <SmallLabel style={{ marginTop: 10 }}>Time for 24 items at each capacity (this work, this jitter)</SmallLabel>
      <Plot x={[-0.5, 8.5]} y={[0, maxSweep * 1.08 / 1_000]} height={130} xLabel="capacity" yLabel="µs" xTicks={[0, 1, 2, 3, 4, 5, 6, 7, 8]} yFormat={(v) => `${v}`}>
        <Bars bins={sweep.map((m, k) => ({ x0: k - 0.4, x1: k + 0.4, y: m / 1_000 }))} color="var(--c1)" opacity={0.35} />
        <Bars bins={[{ x0: capacity - 0.4, x1: capacity + 0.4, y: sweep[capacity]! / 1_000 }]} color="var(--c1)" opacity={0.9} />
        <RuleX at={capacity} />
      </Plot>
      <Note>
        Each thread has its own core. A thread that blocks pays a wake-up of {us(DEFAULT_COSTS.wakeNs)} and a switch of{" "}
        {us(DEFAULT_COSTS.switchNs)}: model inputs for OS threads, not measurements. Every capacity sees the same work times.
      </Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- happens-before, step by step

const ITEMS = 6;
const HB = { cap: seg("Capacity C", [["0", "0"], ["1", "1"], ["2", "2"], ["3", "3"]], "1") };

const describe = (m: ChanHb, op: HbOp | undefined): string => {
  if (!op) return "Pick which side acts next. Each click starts that side's next operation.";
  const name = op.side === "producer" ? `send ${op.k}` : `receive ${op.k}`;
  if (op.end === undefined) {
    return op.side === "producer"
      ? `${name} blocks: the buffer is full (${m.buf.length} of ${m.capacity}) and no receiver waits.`
      : `${name} blocks: the buffer is empty and no sender waits.`;
  }
  const woke = m.ops.find((o) => o !== op && o.end === op.end && o.start < op.start);
  if (woke) return `${name} completes, and it completes the blocked ${woke.side === "producer" ? `send ${woke.k}` : `receive ${woke.k}`} in the same step.`;
  return `${name} completes through the buffer, with no wait.`;
};

export function ConcMsgHbDemo() {
  const P = useParams("conc-msg-hb", HB);
  const C = Number(P.values.cap);
  const [sched, setSched] = useState<Side[]>([]);
  const m = useMemo(() => {
    const x = new ChanHb(C, ITEMS);
    for (const s of sched) x.act(s);
    return x;
  }, [C, sched]);
  const [ref, w] = useWidth<HTMLDivElement>();
  const act = (s: Side) => setSched([...sched, s]);
  // A script lets one side run whenever it can; the other side acts only when the first is blocked or finished.
  const script = (first: Side) => {
    const x = new ChanHb(C, ITEMS), out: Side[] = [];
    const other: Side = first === "producer" ? "consumer" : "producer";
    while (!x.done && out.length < 4 * ITEMS) {
      const s = x.canAct(first) ? first : other;
      if (!x.act(s)) break;
      out.push(s);
    }
    setSched(out);
  };
  const edges = m.edges();
  const last = m.ops[m.ops.length - 1];
  const maxLead = useMemo(() => {
    const x = new ChanHb(C, ITEMS);
    let best = 0;
    for (const s of sched) {
      x.act(s);
      best = Math.max(best, x.lead);
    }
    return best;
  }, [C, sched]);

  const L = 74, steps = 2 * ITEMS, dx = Math.max(14, (w - L - 10) / steps);
  const yP = 22, yC = 104, bh = 22;
  const x0 = (s: number) => L + (s - 1) * dx + 2, x1 = (s: number) => L + s * dx - 2;
  const id = "conc-msg-hb-arrow";
  const box = (o: HbOp) => {
    const y = o.side === "producer" ? yP : yC;
    const endS = o.end ?? m.step;
    const color = o.side === "producer" ? "var(--c1)" : "var(--c3)";
    return (
      <g key={`${o.side}${o.k}`}>
        <rect x={x0(o.start)} y={y} width={Math.max(6, x1(endS) - x0(o.start))} height={bh} rx={3} fill={o.end === undefined ? "var(--bg)" : color} stroke={color} strokeDasharray={o.end === undefined ? "3 2" : undefined} />
        <text x={x0(o.start) + 4} y={y + bh / 2} dy="0.32em" style={{ fontSize: 11, fill: o.end === undefined ? color : "var(--bg)" }}>{o.side === "producer" ? `s${o.k}` : `r${o.k}`}</text>
      </g>
    );
  };
  return (
    <Demo
      title="What one channel orders"
      actions={<>
        <Btn ghost onClick={() => setSched(sched.slice(0, -1))} disabled={!sched.length}>Back</Btn>
        <Btn ghost onClick={() => setSched([])}>Reset</Btn>
      </>}
      controls={<Param spec={HB.cap} value={P.values.cap} onChange={(v) => { P.set("cap", v as never); setSched([]); }} />}
    >
      <ButtonRow>
        <Btn onClick={() => act("producer")} disabled={!m.canAct("producer")}>Producer: send next</Btn>
        <Btn onClick={() => act("consumer")} disabled={!m.canAct("consumer")}>Consumer: receive next</Btn>
        <Btn ghost onClick={() => script("producer")}>Script: eager producer</Btn>
        <Btn ghost onClick={() => script("consumer")}>Script: eager consumer</Btn>
      </ButtonRow>
      <div ref={ref} style={{ width: "100%", marginTop: 10 }}>
        <svg width={w} height={yC + bh + 22} style={{ display: "block" }} role="img" aria-label="send and receive operations with happens-before edges">
          <defs>
            <Arrow id={`${id}1`} color="var(--c1)" />
            <Arrow id={`${id}2`} color="var(--c4)" />
          </defs>
          <text x={L - 8} y={yP + bh / 2} dy="0.32em" textAnchor="end" style={{ fontSize: 11.5, fill: "var(--muted)" }}>producer</text>
          <text x={L - 8} y={yC + bh / 2} dy="0.32em" textAnchor="end" style={{ fontSize: 11.5, fill: "var(--muted)" }}>consumer</text>
          {Array.from({ length: steps + 1 }, (_, s) => <line key={s} x1={L + s * dx} x2={L + s * dx} y1={yP - 6} y2={yC + bh + 6} stroke="var(--border)" />)}
          {m.ops.map(box)}
          {edges.map((e, i) => {
            // send→recv: from the start of send k to the end of receive k. recv→send: from the end of receive k to the end of send k + C.
            const a = e.rule === "send→recv" ? { x: x0(e.from.start) + 6, y: yP + bh } : { x: x1(e.from.end!) - 4, y: yC };
            const b = e.rule === "send→recv" ? { x: x1(e.to.end!) - 4, y: yC - 1 } : { x: x1(e.to.end!) - 6, y: yP + bh + 1 };
            const color = e.rule === "send→recv" ? "var(--c1)" : "var(--c4)";
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={1.5} markerEnd={`url(#${id}${e.rule === "send→recv" ? 1 : 2})`} opacity={0.85} />;
          })}
          <text x={L} y={yC + bh + 16} style={{ fontSize: 10.5, fill: "var(--muted)" }}>step →</text>
        </svg>
      </div>
      <Legend items={[
        { label: "send k → completion of receive k", color: "var(--c1)" },
        { label: C === 0 ? "receive k → completion of send k" : `receive k → completion of send k+${C}`, color: "var(--c4)" },
      ]} />
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>buffer:</span>
        {C === 0 && <span className="muted" style={{ fontSize: 12 }}>none (rendezvous)</span>}
        {Array.from({ length: C }, (_, i) => <Chip key={i} color="var(--c1)" filled={i < m.buf.length} faint={i >= m.buf.length}>{i < m.buf.length ? m.buf[i] : "·"}</Chip>)}
      </div>
      <Banner tone={last?.end === undefined && last ? "warn" : "plain"}>{m.done ? `All ${ITEMS} values arrived in ${m.step} steps.` : describe(m, last)}</Banner>
      <Stats items={[
        { label: "sends completed − receives completed, now", value: m.lead },
        { label: "largest so far (never above C)", value: maxLead },
        { label: "edges shown", value: edges.length },
      ]} />
    </Demo>
  );
}
