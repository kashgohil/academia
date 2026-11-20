/** Demos for "TLA+ basics": be the Next relation, watch TLC search the DieHard graph, and find a deadlock. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Tex, MiniTable, Note, Param, SectionLabel, Stats, int, range, seg, toggle, useParams, useWidth, MONO, tint } from "../../kit";
import {
  blockingQueue, bqThreads, dieHard, dieHardActions, dieHardExplain, dieHardSolvable, tlc, waitNames,
  type BQOptions, type Jugs,
} from "../../sims/conc/verification";

// ---------------------------------------------------------------- 1. you are Next

const ACTIONS = ["FillSmallJug", "FillBigJug", "EmptySmallJug", "EmptyBigJug", "SmallToBig", "BigToSmall"];

function Jug({ cap, value, label, scale }: { cap: number; value: number; label: string; scale: number }) {
  const h = cap * scale, w = 54;
  return (
    <svg width={w + 34} height={h + 34} style={{ display: "block" }}>
      <rect x={4} y={10 + h - value * scale} width={w} height={value * scale} fill={tint("var(--c1)", 55)} style={{ transition: "y .3s, height .3s" }} />
      <path d={`M4 6 V${10 + h} H${4 + w} V6`} fill="none" stroke="var(--fg)" strokeWidth={2} />
      {Array.from({ length: cap }, (_, i) => <line key={i} x1={4 + w - 8} x2={4 + w} y1={10 + h - (i + 1) * scale} y2={10 + h - (i + 1) * scale} stroke="var(--muted)" />)}
      {Array.from({ length: cap }, (_, i) => <text key={`t${i}`} x={w + 9} y={10 + h - (i + 1) * scale + 4} fontSize={10} fill="var(--muted)">{i + 1}</text>)}
      <text x={4 + w / 2} y={h + 28} fontSize={11.5} textAnchor="middle" fill="var(--fg)" fontFamily={MONO}>{label} = {value}</text>
    </svg>
  );
}

export function ConcVerJugsDemo() {
  const [steps, setSteps] = useState<{ action: string; state: Jugs; formula: string[] }[]>([{ action: "Init", state: { small: 0, big: 0 }, formula: ["big = 0", "small = 0"] }]);
  const s = steps.at(-1)!.state;
  const acts = dieHardActions();
  const take = (name: string) => {
    const next = acts.find((a) => a.name === name)!.succ(s)[0]!;
    setSteps([...steps, { action: name, state: next, formula: dieHardExplain(name, s) }]);
  };
  const stutter = () => setSteps([...steps, { action: "stutter", state: s, formula: ["UNCHANGED <<big, small>>"] }]);
  const solvedAt = steps.findIndex((x) => x.state.big === 4);
  const last = steps.at(-1)!;
  return (
    <Demo
      title="You are the Next action"
      actions={
        <ButtonRow>
          <Btn onClick={() => steps.length > 1 && setSteps(steps.slice(0, -1))} disabled={steps.length <= 1}>Back</Btn>
          <Btn ghost onClick={() => setSteps(steps.slice(0, 1))}>Reset</Btn>
        </ButtonRow>
      }
    >
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Jug cap={3} value={s.small} label="small" scale={18} />
        <Jug cap={5} value={s.big} label="big" scale={18} />
        <div style={{ flex: "1 1 170px", minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Last step: {last.action}</SectionLabel>
          {last.formula.map((f) => <div key={f} style={{ fontFamily: MONO, fontSize: 12.5 }}>{f}</div>)}
        </div>
      </div>
      <SectionLabel>Take a step (each button is one disjunct of Next)</SectionLabel>
      <ButtonRow>
        {ACTIONS.map((a) => <Btn key={a} onClick={() => take(a)}>{a}</Btn>)}
        <Btn ghost onClick={stutter}>Stutter</Btn>
      </ButtonRow>
      <SectionLabel>The behavior so far</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {steps.map((x, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            {i > 0 && <span className="muted" style={{ fontSize: 10.5 }} title={x.action}>→</span>}
            <Chip color={x.state.big === 4 ? "var(--c4)" : x.action === "stutter" ? "var(--muted)" : "var(--fg)"} dashed={x.action === "stutter"}>{x.state.small},{x.state.big}</Chip>
          </span>
        ))}
      </div>
      <Banner tone={solvedAt >= 0 ? "bad" : "good"}>
        {solvedAt >= 0
          ? <>Invariant <code>NotSolved</code> is violated in state {solvedAt} (big = 4). For TLC this is an error, and the behavior is its counterexample: the puzzle solution.</>
          : <>Invariants hold in every state so far: <code>TypeOK</code> and <code>NotSolved</code> (big ≠ 4). States are written as small,big.</>}
      </Banner>
      <Note>A stutter step changes no variable. The formula <Tex>{"[\\mathit{Next}]_{\\mathit{vars}}"}</Tex> always allows it, so a spec never forces a system to move.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- 2. TLC on the state graph

const GRAPH = {
  small: range({ label: "Small jug", min: 2, max: 5, step: 1, default: 3 }),
  big: range({ label: "Big jug", min: 3, max: 9, step: 1, default: 5 }),
  goal: range({ label: "Goal for the big jug", min: 1, max: 9, step: 1, default: 4 }),
  level: range({ label: "BFS level shown", min: 0, max: 20, step: 1, default: 20, format: (v) => (v >= 20 ? "all" : String(v)) }),
  bug: toggle({ label: "Bug: SmallToBig ignores the capacity", default: false }),
};

export function ConcVerTlcGraphDemo() {
  const P = useParams("conc-ver-tlc", GRAPH);
  const { small, level, bug } = P.values;
  const big = Math.max(P.values.big, small + 1);
  const goal = Math.min(P.values.goal, big);
  const o = { smallCap: small, bigCap: big, goal, bug };
  const full = useMemo(() => tlc(dieHard(o), { stopOnError: false, maxStates: 5000 }), [small, big, goal, bug]); // eslint-disable-line react-hooks/exhaustive-deps
  const first = useMemo(() => tlc(dieHard(o)), [small, big, goal, bug]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxBig = Math.max(big, ...full.nodes.map((n) => n.state.big));
  const shownDepth = level >= 20 ? Infinity : level;
  const [ref, width] = useWidth<HTMLDivElement>();
  const L = 30, T = 18;
  const cell = Math.max(22, Math.min(40, (Math.min(width, 420) - L - 10) / (small + 1)));
  const rowH = Math.min(cell, 30);
  const W = L + (small + 1) * cell + 10, H = T + (maxBig + 1) * rowH + 22;
  const cx = (x: number) => L + x * cell + cell / 2;
  const cy = (y: number) => T + (maxBig - y) * rowH + rowH / 2;
  const vio = first.violation;
  const path = vio && vio.trace.length - 1 <= shownDepth ? vio.trace : null;
  return (
    <Demo
      title="TLC's breadth-first search over the state graph"
      controls={
        <>
          <Param spec={GRAPH.small} value={small} onChange={(v) => P.set("small", v as number)} />
          <Param spec={GRAPH.big} value={big} onChange={(v) => P.set("big", v as number)} />
          <Param spec={GRAPH.goal} value={goal} onChange={(v) => P.set("goal", v as number)} />
          <Param spec={GRAPH.level} value={level} onChange={(v) => P.set("level", v as number)} />
          <Param spec={GRAPH.bug} value={bug} onChange={(v) => P.set("bug", v as boolean)} />
        </>
      }
    >
      <div ref={ref} style={{ width: "100%", overflowX: "auto" }}>
        <svg width={W} height={H} style={{ display: "block" }}>
          {Array.from({ length: maxBig + 1 }, (_, y) => (
            <g key={y}>
              <text x={L - 6} y={cy(y) + 4} fontSize={10} textAnchor="end" fill={y === goal ? "var(--c4)" : "var(--muted)"}>{y}</text>
              {y > big && <rect x={L} y={cy(y) - rowH / 2} width={(small + 1) * cell} height={rowH} fill={tint("var(--c4)", 14)} />}
              {y === goal && <rect x={L} y={cy(y) - rowH / 2} width={(small + 1) * cell} height={rowH} fill="none" stroke="var(--c4)" strokeDasharray="3 3" />}
            </g>
          ))}
          {Array.from({ length: small + 1 }, (_, x) => <text key={x} x={cx(x)} y={H - 6} fontSize={10} textAnchor="middle" fill="var(--muted)">{x}</text>)}
          <text x={L} y={11} fontSize={10.5} fill="var(--muted)">big ↑   small →</text>
          {Array.from({ length: small + 1 }, (_, x) => Array.from({ length: Math.min(big, maxBig) + 1 }, (_, y) => <circle key={`${x},${y}`} cx={cx(x)} cy={cy(y)} r={2} fill="var(--faint)" />))}
          {path && path.slice(1).map((st, i) => {
            const a = path[i]!.state, b = st.state;
            return <line key={i} x1={cx(a.small)} y1={cy(a.big)} x2={cx(b.small)} y2={cy(b.big)} stroke="var(--c4)" strokeWidth={2.5} opacity={0.8} />;
          })}
          {full.nodes.filter((n) => n.depth <= shownDepth).map((n) => {
            const bad = n.state.big === goal || n.state.big > big;
            return (
              <g key={`${n.state.small},${n.state.big}`}>
                <circle cx={cx(n.state.small)} cy={cy(n.state.big)} r={Math.min(10, rowH / 2 - 2)} fill={bad ? "var(--c4)" : tint("var(--c1)", 30 + Math.min(60, n.depth * 7))} stroke="var(--bg)" />
                <text x={cx(n.state.small)} y={cy(n.state.big) + 3.5} fontSize={9.5} textAnchor="middle" fill={bad ? "var(--bg)" : "var(--fg)"}>{n.depth}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <Note>Each dot is a reachable state; its number is the BFS level where TLC first found it. Red marks a state that breaks an invariant.</Note>
      <Stats items={[
        { label: "distinct states", value: int(full.distinct) },
        { label: "states generated", value: int(full.generated) },
        { label: "BFS depth (diameter)", value: full.depth },
        { label: "goal reachable (gcd rule)", value: dieHardSolvable(small, big, goal) ? "yes" : "no" },
      ]} />
      <Banner tone={vio ? "bad" : "good"}>
        {vio
          ? <>Invariant <code>{vio.invariant}</code> is violated. Shortest trace, {vio.trace.length - 1} steps: {vio.trace.slice(1).map((t) => `${t.action} → (${t.state.small},${t.state.big})`).join(", ")}.</>
          : <>No error: TLC visits all {full.distinct} reachable states, and no state has big = {goal}.</>}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- 3. the blocking queue

const BQ = {
  p: range({ label: "Producers", min: 1, max: 3, step: 1, default: 1 }),
  c: range({ label: "Consumers", min: 1, max: 3, step: 1, default: 2 }),
  k: range({ label: "Buffer capacity", min: 1, max: 3, step: 1, default: 1 }),
  notify: seg<"one" | "all">("After Put or Get", [["one", "notify()"], ["all", "notifyAll()"]], "one"),
};

export function ConcVerBlockingQueueDemo() {
  const P = useParams("conc-ver-bq", BQ);
  const o: BQOptions = { producers: P.values.p, consumers: P.values.c, capacity: P.values.k, notify: P.values.notify };
  const full = useMemo(() => tlc(blockingQueue(o), { stopOnError: false }), [o.producers, o.consumers, o.capacity, o.notify]); // eslint-disable-line react-hooks/exhaustive-deps
  const map = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (let k = 1; k <= 3; k++) for (let p = 1; p <= 3; p++) for (let c = 1; c <= 3; c++) {
      out[`${p}${c}${k}`] = !!tlc(blockingQueue({ producers: p, consumers: c, capacity: k, notify: o.notify })).deadlock;
    }
    return out;
  }, [o.notify]);
  const dl = full.deadlock;
  const names = bqThreads(o);
  const isProd = (n: string) => n.startsWith("p");
  return (
    <Demo
      title="Find the deadlock in a blocking queue"
      controls={
        <>
          <Param spec={BQ.p} value={P.values.p} onChange={(v) => P.set("p", v as number)} />
          <Param spec={BQ.c} value={P.values.c} onChange={(v) => P.set("c", v as number)} />
          <Param spec={BQ.k} value={P.values.k} onChange={(v) => P.set("k", v as number)} />
          <Param spec={BQ.notify} value={P.values.notify} onChange={(v) => P.set("notify", v as "one" | "all")} />
        </>
      }
    >
      <Banner tone={dl ? "bad" : "good"}>
        {dl
          ? <>Deadlock after {dl.trace.length - 1} steps: every thread waits, and nobody is left to call notify. TLC searched {full.distinct} distinct states.</>
          : <>No deadlock. TLC visits all {full.distinct} reachable states, and in each some thread can still run.</>}
      </Banner>
      {dl && (
        <MiniTable
          head={["#", "Action", "Buffer", "Waiting"]}
          rows={dl.trace.map((t, i) => [
            i,
            <span key="a" style={{ fontFamily: MONO, fontSize: 11.5 }}>{t.action}</span>,
            <span key="b" style={{ fontFamily: MONO }}>{"■".repeat(t.state.len)}{"□".repeat(o.capacity - t.state.len)}</span>,
            <span key="w" style={{ display: "inline-flex", gap: 3, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {waitNames(o, t.state.wait).map((n) => <Chip key={n} color={isProd(n) ? "var(--c2)" : "var(--c1)"}>{n}</Chip>)}
            </span>,
          ])}
          highlight={dl.trace.length - 1}
        />
      )}
      <SectionLabel>All 27 configurations with {o.notify === "one" ? "notify()" : "notifyAll()"} (red: deadlock)</SectionLabel>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        {[1, 2, 3].map((k) => (
          <div key={k}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>capacity {k}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 26px)", gap: 3 }}>
              {[1, 2, 3].map((p) => [1, 2, 3].map((c) => {
                const on = p === o.producers && c === o.consumers && k === o.capacity;
                return (
                  <button
                    key={`${p}${c}`}
                    title={`${p} producers, ${c} consumers`}
                    onClick={() => { P.set("p", p); P.set("c", c); P.set("k", k); }}
                    style={{ height: 22, borderRadius: 3, border: on ? "2px solid var(--fg)" : "1px solid var(--border)", background: map[`${p}${c}${k}`] ? tint("var(--c4)", 60) : "var(--subtle)", fontSize: 9.5, fontFamily: MONO, color: "var(--fg)", cursor: "pointer", padding: 0 }}
                  >
                    {p}·{c}
                  </button>
                );
              }))}
            </div>
          </div>
        ))}
      </div>
      <Note>Each cell is producers·consumers. Threads: {names.join(", ")}.</Note>
    </Demo>
  );
}
