/** Demos for the hybrid logical clock lesson: an HLC stepper, HLC against a naive hybrid, and the uncertainty interval. */
import { useMemo } from "react";
import { Area, Banner, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleX, RuleY, Stats, StepButtons, StepCaption, StepSlider, fixed, range, toggle, useParams, useStepper } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { eventOrder, evName } from "../../sims/dist/time/events";
import { hlcRun, hlcText, uncertainRead, type HlcRule } from "../../sims/dist/time/hlc";
import { PROC_NAMES } from "./TimeUi";

const sgn = (v: number, d = 0) => `${v >= 0 ? "+" : "−"}${fixed(Math.abs(v), d)}`;

// ============================================================================ 1. HLC, event by event

const STEP = {
  o1: range({ label: "P2 clock offset", min: -60, max: 60, step: 1, default: 40, format: (v) => `${sgn(v)} ms` }),
  o2: range({ label: "P3 clock offset", min: -60, max: 60, step: 1, default: -20, format: (v) => `${sgn(v)} ms` }),
  d2: range({ label: "P3 drift (exaggerated)", min: -10, max: 10, step: 1, default: 5, format: (v) => `${sgn(v)}%` }),
};

const RULE_TEXT: Record<HlcRule, string> = {
  pt: "Its physical clock is ahead of everything it has heard, so l = pt and c = 0.",
  "own-l": "Its own l is still the largest, so l stays and c counts up.",
  "msg-l": "The message's l is the largest, so l = m.l and c = m.c + 1.",
  "all-equal": "Its own l and the message's l are equal and largest, so c = max(c, m.c) + 1.",
};

export function TimeHlcStepperDemo() {
  const P = useParams("dist-time-hlcstep", STEP);
  const v = P.values;
  const drift = [0, 0, v.d2 / 100], offset = [0, v.o1, v.o2];
  const h = useMemo(() => hlcRun({ duration: 160, meanGap: 22, seed: 3, sendProb: 0.6, drift, offset, latency: { min: 4, max: 14 } }), [v.o1, v.o2, v.d2]); // eslint-disable-line react-hooks/exhaustive-deps
  const order = useMemo(() => eventOrder(h.run), [h]);
  const st = useStepper(order.length + 1, 1.5);
  const cur = st.i > 0 ? order[st.i - 1]! : -1;
  const shown = new Set(order.slice(0, st.i));
  const tEnd = Math.max(...h.run.events.map((e) => e.t)) + 6;
  const cursor = cur >= 0 ? h.run.events[cur]!.t : -1;
  const messages: StMessage[] = h.run.msgs.map((m) => ({ from: m.from, to: m.to, sentAt: h.run.events[m.send]!.t, deliveredAt: h.run.events[m.recv!]!.t, label: shown.has(m.send) && m.send === cur ? hlcText(h.hlc[m.send]!) : undefined }));
  const marks: StMark[] = h.run.events.map((e) => ({ node: e.proc, t: e.t, color: e.id === cur ? "var(--c2)" : "var(--c1)", label: e.id === cur ? hlcText(h.hlc[e.id]!) : undefined }));
  // The latest stamp of each node at the cursor.
  const last = [0, 1, 2].map((p) => { const ids = order.slice(0, st.i).filter((id) => h.run.events[id]!.proc === p); return ids.length ? ids[ids.length - 1]! : -1; });
  const ptAt = (p: number) => Math.floor(Math.max(0, cursor) * (1 + drift[p]!) + offset[p]!);
  let caption = "Press Step to run the events in time order. Each node reads its own physical clock pt.";
  if (cur >= 0) {
    const e = h.run.events[cur]!;
    const hc = h.hlc[cur]!;
    const what = e.kind === "recv" ? `receives a message stamped ${hlcText(h.hlc[h.run.msgs[e.msg!]!.send]!)}` : e.kind === "send" ? "sends a message" : "has a local event";
    caption = `${PROC_NAMES[e.proc]} ${what} (event ${evName(cur)}). Its pt is ${e.pt}. ${RULE_TEXT[h.rule[cur]!]} New stamp: (${hc.l}, ${hc.c}).`;
  }
  return (
    <Demo title="A hybrid logical clock, event by event" actions={<StepButtons s={st} />} controls={<><Param spec={STEP.o1} value={v.o1} onChange={(x) => P.set("o1", x as number)} /><Param spec={STEP.o2} value={v.o2} onChange={(x) => P.set("o2", x as number)} /><Param spec={STEP.d2} value={v.d2} onChange={(x) => P.set("d2", x as number)} /></>}>
      <SpaceTime nodes={PROC_NAMES.slice(0, 3)} tEnd={tEnd} messages={messages} marks={marks} cursor={cursor} timeLabel="true time (ms)" />
      <StepCaption tone={cur >= 0 && h.rule[cur] !== "pt" ? "info" : "plain"} label={`${st.i}/${order.length}`}>{caption}</StepCaption>
      <StepSlider s={st} label="Event" />
      <MiniTable
        head={["node", "pt now", "last (l, c)", "l − pt"]}
        rows={[0, 1, 2].map((p) => {
          const id = last[p]!;
          return [PROC_NAMES[p]!, cursor >= 0 ? ptAt(p) : "–", id >= 0 ? `(${hlcText(h.hlc[id]!)})` : "–", id >= 0 ? `${h.hlc[id]!.l - h.run.events[id]!.pt!} ms` : "–"];
        })}
      />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "largest clock gap ε in this run", value: `${h.eps} ms` },
          { label: "largest l − pt", value: `${h.maxAhead} ms` },
          { label: "smallest l − pt", value: `${h.minAhead} ms` },
          { label: "largest c", value: h.maxC },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. HLC against a naive hybrid and physical time

const CMP = {
  gap: range({ label: "Mean gap between events", min: 0.3, max: 40, log: true, default: 10, format: (v) => `${v} ms` }),
  spread: range({ label: "Clock spread (P2 +s, P3 −s/2)", min: 0, max: 100, step: 5, default: 40, format: (v) => `${v} ms` }),
};

const thin = <T,>(xs: T[], max = 500) => (xs.length <= max ? xs : xs.filter((_, i) => i % Math.ceil(xs.length / max) === 0));

export function TimeHlcCompareDemo() {
  const P = useParams("dist-time-hlccmp", CMP);
  const v = P.values;
  const offset = [0, v.spread, -v.spread / 2];
  const h = useMemo(() => hlcRun({ duration: 300, meanGap: v.gap, seed: 4, sendProb: 0.6, drift: [0, 0, 0], offset, latency: { min: 3, max: 12 } }), [v.gap, v.spread]); // eslint-disable-line react-hooks/exhaustive-deps
  const ev = h.run.events;
  const hl = thin(ev.map((e) => [e.t, h.hlc[e.id]!.l - e.t] as [number, number]));
  const nv = thin(ev.map((e) => [e.t, h.naive[e.id]! - e.t] as [number, number]));
  const top = Math.max(v.spread + 10, ...nv.map((p) => p[1])) * 1.08;
  const bottom = Math.min(-v.spread / 2 - 10, 0) * 1.1;
  const maxLamport = Math.max(...h.lamport);
  return (
    <Demo title="Physical, naive hybrid and HLC stamps over one run" controls={<><Param spec={CMP.gap} value={v.gap} onChange={(x) => P.set("gap", x as number)} /><Param spec={CMP.spread} value={v.spread} onChange={(x) => P.set("spread", x as number)} /></>}>
      <Plot x={[0, 320]} y={[bottom, top]} height={250} xLabel="true time (ms)" yLabel="stamp − true time (ms)">
        <RuleY at={0} />
        {offset.map((o, i) => <Line key={i} points={[[0, o], [320, o]]} color="var(--muted)" width={1} dash="3 3" />)}
        <Dots points={nv} color="var(--c4)" r={2} />
        <Dots points={hl} color="var(--c1)" r={2.4} />
      </Plot>
      <Legend items={[{ label: "physical clock of each node", color: "var(--muted)" }, { label: "HLC l", color: "var(--c1)" }, { label: "naive: max(l + 1, m.l + 1, pt)", color: "var(--c4)" }]} />
      <Banner ok={h.maxNaiveAhead <= h.eps}>
        {h.maxNaiveAhead > h.eps
          ? `Events come faster than 1 per ms on some node, so the naive clock adds 1 ms per event and runs ${h.maxNaiveAhead} ms ahead of physical time. HLC puts the extra order into c instead, and l stays within ${h.maxAhead} ms of pt.`
          : `At this rate both hybrids stay close to physical time. Make events faster to see the naive clock run away.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "events", value: ev.length },
          { label: "largest clock gap ε", value: `${h.eps} ms` },
          { label: "HLC: largest l − pt", value: `${h.maxAhead} ms` },
          { label: "HLC: largest c", value: h.maxC },
          { label: "naive: largest stamp − pt", value: `${h.maxNaiveAhead} ms` },
          { label: "pure Lamport counter at the end", value: maxLamport },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 3. The uncertainty interval

const UNC = {
  writer: range({ label: "Writer clock offset", min: -300, max: 600, step: 10, default: 120, format: (v) => `${sgn(v)} ms` }),
  reader: range({ label: "Reader clock offset", min: -300, max: 300, step: 10, default: 0, format: (v) => `${sgn(v)} ms` }),
  gap: range({ label: "Read starts after commit by", min: 0, max: 200, step: 10, default: 50, format: (v) => `${v} ms` }),
  maxOffset: range({ label: "Configured max offset", min: 50, max: 500, step: 10, default: 250, format: (v) => `${v} ms` }),
  check: toggle({ label: "Use the uncertainty interval", default: true }),
};

export function TimeUncertaintyDemo() {
  const P = useParams("dist-time-unc", UNC);
  const v = P.values;
  const r = uncertainRead({ writerOffset: v.writer, readerOffset: v.reader, maxOffset: v.maxOffset, gap: v.gap, check: v.check });
  const lo = Math.min(r.w, r.r) - 80, hi = Math.max(r.w, r.upper, r.r) + 80;
  const real = Math.abs(v.writer - v.reader);
  return (
    <Demo
      title="A read after a write, on two clocks"
      controls={<>
        <Param spec={UNC.writer} value={v.writer} onChange={(x) => P.set("writer", x as number)} />
        <Param spec={UNC.reader} value={v.reader} onChange={(x) => P.set("reader", x as number)} />
        <Param spec={UNC.gap} value={v.gap} onChange={(x) => P.set("gap", x as number)} />
        <Param spec={UNC.maxOffset} value={v.maxOffset} onChange={(x) => P.set("maxOffset", x as number)} />
        <Param spec={UNC.check} value={v.check} onChange={(x) => P.set("check", x as boolean)} />
      </>}
    >
      <Plot x={[lo, hi]} y={[0, 1]} height={120} xLabel="timestamp (ms)" yTicks={[]} grid={false}>
        {v.check && <Area points={[[r.r, 0.85], [r.upper, 0.85]]} base={0.15} color="var(--c2)" opacity={0.22} />}
        <RuleX at={r.r} color="var(--c1)" label="read ts" dash="0" />
        <RuleX at={r.w} color={r.outcome === "stale" ? "var(--c4)" : "var(--c3)"} label="write ts" dash="0" />
      </Plot>
      <Legend items={[{ label: "uncertainty interval (read ts, read ts + max offset]", color: "var(--c2)" }]} />
      <Banner ok={r.outcome === "stale" ? false : r.outcome === "restart" ? null : true}>
        {r.outcome === "visible"
          ? `The write's timestamp (${r.w}) is not above the read's (${r.r}), so the read sees it.`
          : r.outcome === "restart"
            ? `The write's timestamp (${r.w}) is above the read's (${r.r}) but inside the interval. The reader cannot know which came first, so it restarts at a timestamp above ${r.w} and sees the write.`
            : `The write's timestamp (${r.w}) is above ${v.check ? "the whole interval" : "the read's"}, so the read ignores it. But the write committed ${v.gap} ms before the read began: this is a stale read.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "real clock gap", value: `${real} ms` },
          { label: "configured max offset", value: `${v.maxOffset} ms` },
          { label: "assumption", value: real <= v.maxOffset ? "holds" : "broken" },
        ]} />
      </div>
    </Demo>
  );
}
