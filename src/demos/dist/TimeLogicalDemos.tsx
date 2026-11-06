/** Demos for the Lamport clock and vector clock lessons: a run builder, the failing converse, Lamport's mutex, and a cart with version vectors. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Legend, Line, Panel, Param, Plot, RuleX, SectionLabel, Stats, StepCaption, pct, range, seg, toggle, useChunked, useParams, useWidth } from "../../kit";
import { SpaceTime, fromTrace, type StMark, type StMessage } from "./SpaceTime";
import { ClickSpaceTime, BuilderButtons, PROC_NAMES, StampChips, runToSpaceTime } from "./TimeUi";
import { LESSON_RUN, evName, happensBefore, randomRun, relation, scriptRun, type Run } from "../../sims/dist/time/events";
import { concurrentShare, converseStats, lamportMutex, lamportStamps, worstConcurrentPair, type MutexMsg } from "../../sims/dist/time/lamport";
import { vcCompare, vcText, vectorStamps } from "../../sims/dist/time/vector";
import { CLIENTS, KV_CONCURRENT, REPLICAS, kvReplay, lostItems, type KvAction, type KvMode } from "../../sims/dist/time/kv";

// ============================================================================ 1. Build a run (Lamport or vector)

const PRESET = LESSON_RUN;

function pairText(run: Run, a: number, b: number, mode: "lamport" | "vector") {
  const hb = happensBefore(run);
  const L = lamportStamps(run);
  const V = vectorStamps(run);
  const A = evName(a), B = evName(b);
  const r = relation(hb, a, b);
  const lam = L[a]! < L[b]! ? `${L[a]} < ${L[b]}` : L[a]! > L[b]! ? `${L[a]} > ${L[b]}` : `${L[a]} = ${L[b]}`;
  if (mode === "lamport") {
    if (r === "before") return { tone: "good" as const, text: `${A} → ${B}: a chain of events and messages leads from ${A} to ${B}. The clock condition holds: C(${A}) = ${L[a]} < C(${B}) = ${L[b]}.` };
    if (r === "after") return { tone: "good" as const, text: `${B} → ${A}: a chain leads from ${B} to ${A}. So C(${B}) = ${L[b]} < C(${A}) = ${L[a]}, as the clock condition demands.` };
    return { tone: L[a] === L[b] ? "info" as const : "bad" as const, text: `${A} and ${B} are concurrent: no chain links them. The clocks still say ${lam}. ${L[a] === L[b] ? "The total order breaks the tie by process id." : "A reader of the timestamps would think one came first."}` };
  }
  const vc = vcCompare(V[a]!, V[b]!);
  const vtext = `V(${A}) = ${vcText(V[a]!)}, V(${B}) = ${vcText(V[b]!)}`;
  if (vc === "before") return { tone: "good" as const, text: `${vtext}. Every entry of V(${A}) is ≤, so ${A} → ${B}. Lamport agrees: ${lam}.` };
  if (vc === "after") return { tone: "good" as const, text: `${vtext}. Every entry of V(${B}) is ≤, so ${B} → ${A}. Lamport agrees: ${lam}.` };
  return { tone: "bad" as const, text: `${vtext}. Each is larger in some entry, so they are concurrent. Lamport alone says ${lam} and cannot tell.` };
}

function ClockBuilder({ mode }: { mode: "lamport" | "vector" }) {
  const [hist, setHist] = useState<Run[]>(() => [scriptRun(3, PRESET)]);
  const [sel, setSel] = useState<number[]>(mode === "lamport" ? [9, 7] : [9, 7]);
  const [ref, width] = useWidth<HTMLDivElement>();
  const run = hist[hist.length - 1]!;
  const L = useMemo(() => lamportStamps(run), [run]);
  const V = useMemo(() => vectorStamps(run), [run]);
  const hb = useMemo(() => happensBefore(run), [run]);
  const tEnd = Math.max(6, run.events.length + 1);
  const room = (Math.max(240, width) - 68) / tEnd;
  const label = (id: number) => (mode === "lamport" ? String(L[id]) : room >= 40 ? V[id]!.join(",") : evName(id));
  const color = (id: number) => (sel[0] === id ? "var(--c2)" : sel[1] === id ? "var(--c5)" : undefined);
  const st = runToSpaceTime(run, label, color);
  const pick = (id: number) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));
  const setRun = (r: Run) => setHist((h) => [...h, r]);
  let lying = 0, concurrent = 0;
  for (let a = 0; a < run.events.length; a++)
    for (let b = a + 1; b < run.events.length; b++)
      if (relation(hb, a, b) === "concurrent") { concurrent++; if (L[a] !== L[b]) lying++; }
  const pair = sel.length === 2 ? pairText(run, sel[0]!, sel[1]!, mode) : null;
  return (
    <Demo
      title={mode === "lamport" ? "Build a run, read the Lamport clocks" : "The same run with vector clocks"}
      actions={<>
        <Btn onClick={() => { setHist((h) => (h.length > 1 ? h.slice(0, -1) : h)); setSel([]); }} disabled={hist.length <= 1 && run.events.length === 0}>Undo</Btn>
        <Btn ghost onClick={() => { setHist([scriptRun(3, [])]); setSel([]); }}>Clear</Btn>
        <Btn ghost onClick={() => { setHist([scriptRun(3, PRESET)]); setSel([9, 7]); }}>Preset</Btn>
      </>}
    >
      <div ref={ref}>
        <ClickSpaceTime nodes={PROC_NAMES.slice(0, 3)} {...st} selected={sel} onPick={pick} timeLabel="order of events" />
      </div>
      <StampChips run={run} text={(id) => (mode === "lamport" ? String(L[id]) : vcText(V[id]!))} selected={sel} onPick={pick} />
      <StepCaption tone={pair?.tone ?? "plain"}>{pair ? pair.text : "Click two events on the diagram (or two chips) to compare them."}</StepCaption>
      <BuilderButtons run={run} setRun={setRun} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "events", value: run.events.length },
          { label: "concurrent pairs", value: concurrent },
          { label: mode === "lamport" ? "concurrent pairs with different C" : "of those, Lamport would order", value: lying },
        ]} />
      </div>
    </Demo>
  );
}

export const TimeLamportBuilderDemo = () => <ClockBuilder mode="lamport" />;
export const TimeVectorBuilderDemo = () => <ClockBuilder mode="vector" />;

// ============================================================================ 2. The converse fails, on random runs

const CONV = {
  sendProb: range({ label: "Chance to send", min: 0.05, max: 1, step: 0.05, default: 0.3, format: (v) => pct(v, 0) }),
};
const SWEEP = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

export function TimeLamportConverseDemo() {
  const P = useParams("dist-time-conv", CONV);
  const [seed, setSeed] = useState(2);
  const [sel, setSel] = useState<number[] | null>(null);
  const sp = P.values.sendProb;
  const { run } = useMemo(() => randomRun({ sendProb: sp, seed }), [sp, seed]);
  const L = useMemo(() => lamportStamps(run), [run]);
  const stats = useMemo(() => converseStats(run), [run]);
  const worst = useMemo(() => worstConcurrentPair(run), [run]);
  const pair = sel && sel.length === 2 && sel.every((i) => i < run.events.length) ? sel : worst ?? [];
  const sweep = useChunked("sweep", SWEEP.map((p) => () => concurrentShare(p)));
  const st = {
    messages: run.msgs.map((m): StMessage => ({ from: m.from, to: m.to, sentAt: run.events[m.send]!.t, deliveredAt: run.events[m.recv!]!.t, color: "var(--faint)" })),
    marks: run.events.map((e): StMark => ({ node: e.proc, t: e.t, color: pair[0] === e.id ? "var(--c2)" : pair[1] === e.id ? "var(--c5)" : "var(--muted)", label: pair.includes(e.id) ? `C=${L[e.id]}` : undefined })),
  };
  const tEnd = Math.max(...run.events.map((e) => e.t), 200) + 5;
  const hb = happensBefore(run);
  const r = pair.length === 2 ? relation(hb, pair[0]!, pair[1]!) : null;
  const pick = (id: number) => setSel((s) => { const cur = s ?? []; return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-2); });
  return (
    <Demo title="How often does C(a) < C(b) mean a → b?" actions={<Btn onClick={() => { setSeed((s) => s + 1); setSel(null); }}>New run</Btn>} controls={<Param spec={CONV.sendProb} value={sp} onChange={(v) => { P.set("sendProb", v as number); setSel(null); }} />}>
      <ClickSpaceTime nodes={PROC_NAMES.slice(0, 3)} tEnd={tEnd} {...st} events={run.events.map((e) => ({ id: e.id, node: e.proc, t: e.t }))} selected={pair} onPick={pick} timeLabel="true time (ms)" />
      <StepCaption tone={r === "concurrent" ? "bad" : r ? "good" : "plain"}>
        {pair.length === 2
          ? r === "concurrent"
            ? `The two marked events are concurrent, but their clocks are ${L[pair[0]!]} and ${L[pair[1]!]}. Nothing in the timestamps shows that no order exists.`
            : `The two marked events are causally ordered, and the clocks agree: ${L[pair[0]!]} and ${L[pair[1]!]}.`
          : "Click two events to compare them."}
      </StepCaption>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "events", value: run.events.length },
          { label: "pairs with C(a) < C(b)", value: stats.ordered },
          { label: "of those, really a → b", value: pct(stats.causal / stats.ordered, 0) },
          { label: "of those, concurrent", value: pct(stats.concurrent / stats.ordered, 0) },
          { label: "a → b with C(a) ≥ C(b)", value: stats.violations },
        ]} />
      </div>
      <SectionLabel>Concurrent share of ordered pairs, 8 runs per point</SectionLabel>
      <Plot x={[0, 1]} y={[0, 0.6]} height={170} xLabel="chance to send" yFormat={(v) => pct(v, 0)} xFormat={(v) => pct(v, 0)}>
        <Line points={SWEEP.flatMap((p, i) => (sweep[i] === undefined ? [] : [[p, sweep[i]!] as [number, number]]))} color="var(--c4)" />
        <RuleX at={sp} color="var(--c1)" />
      </Plot>
    </Demo>
  );
}

// ============================================================================ 3. Lamport's mutual exclusion, with the adversary

const MUTEX = {
  delay: range({ label: "Delay P1's request to P2", min: 0, max: 40, step: 1, default: 0, format: (v) => `${v} ms` }),
  fifo: toggle({ label: "FIFO links (as TCP gives)", default: true }),
};

const MUTEX_COLOR: Record<MutexMsg["k"], string> = { request: "var(--c1)", ack: "var(--faint)", release: "var(--c3)" };

export function TimeLamportMutexDemo() {
  const P = useParams("dist-time-mutex", MUTEX);
  const res = useMemo(() => lamportMutex({ fifo: P.values.fifo, slow: { from: 0, to: 1, delay: P.values.delay } }), [P.values.fifo, P.values.delay]);
  const st = fromTrace(res.net);
  const messages = res.net.messages.map((m, i) => ({ ...st.messages[i]!, color: MUTEX_COLOR[m.payload.k] }));
  const holdColor = ["var(--c1)", "var(--c2)", "var(--c5)"];
  const marks: StMark[] = res.holds.map((h) => ({ node: h.node, t: h.enter, until: h.exit, shape: "bar", label: `CS (C=${h.ts})`, color: holdColor[h.node] }));
  const tEnd = Math.max(110, ...res.holds.map((h) => h.exit + 5));
  return (
    <Demo title="Lamport's mutual exclusion: you delay one message" controls={<><Param spec={MUTEX.delay} value={P.values.delay} onChange={(v) => P.set("delay", v as number)} /><Param spec={MUTEX.fifo} value={P.values.fifo} onChange={(v) => P.set("fifo", v as boolean)} /></>}>
      <SpaceTime nodes={PROC_NAMES.slice(0, 3)} tEnd={tEnd} messages={messages} marks={marks} />
      <Legend items={[{ label: "request", color: "var(--c1)" }, { label: "ack", color: "var(--faint)" }, { label: "release", color: "var(--c3)" }, { label: "lock held (bar)", color: "var(--c2)" }]} />
      <Banner ok={!res.violation}>
        {res.violation
          ? "Two processes hold the lock at once. P2's queue does not hold P1's request yet, but an ack from P1 with a later timestamp already arrived. So P2 thinks its own request is first."
          : P.values.fifo && P.values.delay > 0
            ? "Safe. FIFO holds P1's ack behind P1's slow request, so P2 learns of the earlier request before it can enter."
            : "Safe. Each process enters only when its request heads its queue and every other process has sent it something later."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "messages", value: res.messages },
          { label: "lock grants", value: res.holds.length },
          { label: "messages per grant", value: res.holds.length ? (res.messages / res.holds.length).toFixed(0) : "–" },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 4. A cart with version vectors

const ITEMS = ["milk", "eggs", "bread", "tea", "rice", "jam", "salt", "oil"];
const KV = {
  mode: seg<KvMode>("Versions", [["lww", "last write wins"], ["vv", "vector per replica"], ["dvv", "dotted vectors"]], "dvv"),
};

export function TimeVersionVectorKvDemo() {
  const P = useParams("dist-time-kv", KV);
  const [actions, setActions] = useState<KvAction[]>(KV_CONCURRENT);
  const [c, setC] = useState(0);
  const [r, setR] = useState(0);
  const mode = P.values.mode;
  const s = useMemo(() => kvReplay(mode, actions), [mode, actions]);
  const lost = lostItems(s);
  const writes = actions.filter((a) => a.k === "write").length;
  const add = (a: KvAction) => setActions((x) => (x.length >= 14 ? x : [...x, a]));
  const st = fromTrace(s.net, (m) => (m.payload.k === "got" || m.payload.k === "ok" ? undefined : m.payload.k));
  const nodes = [...Array.from({ length: REPLICAS }, (_, i) => `R${i + 1}`), ...Array.from({ length: CLIENTS }, (_, i) => `C${i + 1}`)];
  const sibs = Math.max(...s.replicas.map((x) => x.values.length));
  return (
    <Demo
      title="A replicated cart: siblings or lost items"
      actions={<><Btn onClick={() => setActions((x) => x.slice(0, -1))} disabled={actions.length === 0}>Undo</Btn><Btn ghost onClick={() => setActions(KV_CONCURRENT)}>Preset</Btn><Btn ghost onClick={() => setActions([])}>Clear</Btn></>}
      controls={<Param spec={KV.mode} value={mode} onChange={(v) => P.set("mode", v as KvMode)} />}
    >
      <SpaceTime nodes={nodes} tEnd={Math.max(60, s.net.now)} {...st} rowHeight={38} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
        {s.replicas.map((rep, i) => (
          <Panel key={i} title={`R${i + 1}${mode === "lww" ? "" : `: vector ${vcText(rep.vv)}`}`} accent={rep.values.length > 1 ? "var(--c2)" : undefined}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {rep.values.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>empty</span>}
              {rep.values.map((v, k) => {
                const d = rep.dots[k];
                return <Chip key={k} color="var(--c1)">{`{${v.join(", ")}}${d && mode === "dvv" ? ` dot R${d[0] + 1}:${d[1]}` : ""}`}</Chip>;
              })}
            </div>
          </Panel>
        ))}
        {s.clients.map((cl, i) => (
          <Panel key={`c${i}`} title={`C${i + 1}: last read`}>
            <span style={{ fontSize: 12.5 }}>{cl.read ? `${cl.read.values.length} value${cl.read.values.length === 1 ? "" : "s"}${mode === "lww" ? "" : `, context ${vcText(cl.read.ctx)}`}` : "has not read"}</span>
          </Panel>
        ))}
      </div>
      <Banner ok={lost.length ? false : sibs > 1 ? null : true}>
        {lost.length
          ? `Lost: ${lost.join(", ")}. A write replaced a value that it never saw, and no replica keeps the item now.`
          : sibs > 1
            ? `No item is lost. A replica keeps ${sibs} siblings: concurrent values that a client must merge. Read them, then add an item: the write carries the context, so it replaces exactly those siblings.`
            : `Every added item is in the cart.`}
      </Banner>
      <SectionLabel>Next action</SectionLabel>
      <ButtonRow>
        <Param spec={seg("Client", [["0", "C1"], ["1", "C2"]], "0")} value={String(c)} onChange={(v) => setC(Number(v))} />
        <Param spec={seg("Replica", [["0", "R1"], ["1", "R2"]], "0")} value={String(r)} onChange={(v) => setR(Number(v))} />
      </ButtonRow>
      <ButtonRow style={{ marginTop: 6 }}>
        <Btn onClick={() => add({ k: "read", c, r })}>{`C${c + 1} reads R${r + 1}`}</Btn>
        <Btn onClick={() => add({ k: "write", c, r, item: ITEMS[writes % ITEMS.length]! })}>{`C${c + 1} adds ${ITEMS[writes % ITEMS.length]} via R${r + 1}`}</Btn>
        <Btn onClick={() => add({ k: "sync", from: r, to: 1 - r })}>{`R${r + 1} syncs to R${2 - r}`}</Btn>
      </ButtonRow>
      <ol style={{ fontSize: 12.5, margin: "10px 0 0", paddingLeft: 22, lineHeight: 1.5 }}>
        {s.log.map((l, i) => <li key={i} style={{ fontWeight: i === s.log.length - 1 ? 600 : 400 }}>{l}</li>)}
      </ol>
    </Demo>
  );
}
