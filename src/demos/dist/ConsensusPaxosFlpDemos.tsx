/** Demos for "FLP impossibility": play the adversary against a tiny protocol, and watch Ben-Or's coin end the game. */
import { useMemo, useState } from "react";
import { Banner, Bars, Btn, ButtonRow, Chip, Demo, MiniTable, Panel, Param, Plot, SmallLabel, Stats, BAD, GOOD, MONO, fixed, range, useChunked, useParams } from "../../kit";
import { Explorer, decidedMask, deliver, enabled, initial, valenceName, type Bit, type VConfig, type Valence } from "../../sims/dist/consensus/paxos/valence";
import { runBenOr } from "../../sims/dist/consensus/paxos/benor";
import { crashTolerance } from "../../sims/dist/consensus/paxos/quorum";
import { SpaceTime } from "./SpaceTime";

// ============================================================================ 1. The bivalence explorer

const VCOL: Record<Valence, string> = { 0: "var(--faint)", 1: "var(--c1)", 2: "var(--c5)", 3: "var(--c2)" };
const ex = new Explorer(3);

interface Run {
  inputs: Bit[];
  steps: number[];
  crashed: number;
}

function replay(run: Run) {
  let c = initial(run.inputs);
  const log: { from: number; to: number; sentAt: number; deliveredAt: number; label: string }[] = [];
  const sentAt = new Map<number, number>();
  c.m.forEach((m) => sentAt.set(m.id, 0));
  run.steps.forEach((id, k) => {
    const m = c.m.find((x) => x.id === id)!;
    c = deliver(c, id, ex.horizonOf(c));
    log.push({ from: m.from, to: m.to, sentAt: sentAt.get(id) ?? k, deliveredAt: k + 1, label: m.v === null ? "⊥" : String(m.v) });
    c.m.forEach((x) => { if (!sentAt.has(x.id)) sentAt.set(x.id, k + 1); });
  });
  return { c, log };
}

const vtext = (v: Valence) => (v === 3 ? "bi" : v === 1 ? "0" : v === 2 ? "1" : "–");

function ProcCard({ c, i, crashed, onCrash, canCrash }: { c: VConfig; i: number; crashed: boolean; onCrash: () => void; canCrash: boolean }) {
  const p = c.p[i]!;
  return (
    <Panel title={`P${i + 1}${crashed ? " (crashed)" : ""}`} accent={p.dec !== null ? VCOL[(1 << p.dec) as Valence] : undefined} style={{ opacity: crashed ? 0.5 : 1 }}>
      <div style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6 }}>
        <div>round {p.r}, phase {p.ph}</div>
        <div>x = {p.x}, sent {p.mine === null ? "⊥" : p.mine}</div>
        <div style={{ color: p.dec !== null ? "var(--fg)" : "var(--muted)" }}>{p.dec !== null ? `decided ${p.dec}` : "undecided"}</div>
      </div>
      <div style={{ marginTop: 4 }}><Btn ghost onClick={onCrash} disabled={!canCrash && !crashed}>{crashed ? "Recover" : "Crash"}</Btn></div>
    </Panel>
  );
}

export function ConsensusPaxosBivalenceDemo() {
  const [run, setRun] = useState<Run>({ inputs: [0, 0, 1], steps: [], crashed: -1 });
  const { c, log } = useMemo(() => replay(run), [run]);
  const now = ex.valence(c, run.crashed);
  const inits = useMemo(() => Array.from({ length: 8 }, (_, k) => {
    const inputs = [(k >> 2) & 1, (k >> 1) & 1, k & 1] as Bit[];
    return { inputs, v: ex.valence(initial(inputs)) };
  }), []);
  const pend = [...c.m].sort((a, b) => a.id - b.id);
  const options = pend.map((m) => {
    const ok = enabled(c, m, run.crashed);
    return { m, ok, v: ok ? ex.valence(deliver(c, m.id, ex.horizonOf(c)), run.crashed) : null };
  });
  const decided = decidedMask(c);
  const rounds = Math.min(...c.p.filter((_, i) => i !== run.crashed).map((p) => p.r)) - 1;
  const adversary = () => {
    const path = ex.adversary(c, run.crashed);
    if (path?.length) setRun({ ...run, steps: [...run.steps, ...path] });
  };
  const steps = run.steps.length;
  return (
    <Demo
      title="Keep the protocol undecided"
      actions={<ButtonRow><Btn onClick={adversary} disabled={decided !== 0}>Adversary move</Btn><Btn onClick={() => setRun({ ...run, steps: run.steps.slice(0, -1) })} disabled={!steps}>Back</Btn><Btn ghost onClick={() => setRun({ ...run, steps: [], crashed: -1 })}>Reset</Btn></ButtonRow>}
    >
      <SmallLabel>Initial configurations. The digits are the inputs of P1, P2 and P3. Click one to start from it.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
        {inits.map(({ inputs, v }) => {
          const on = inputs.join("") === run.inputs.join("");
          return (
            <button key={inputs.join("")} className="btn" onClick={() => setRun({ inputs, steps: [], crashed: -1 })} style={{ fontFamily: MONO, fontSize: 12, padding: "2px 7px", borderColor: VCOL[v], background: on ? VCOL[v] : undefined, color: on ? "var(--bg)" : VCOL[v] }}>
              {inputs.join("")} {valenceName(v)}
            </button>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        {[0, 1, 2].map((i) => (
          <ProcCard key={i} c={c} i={i} crashed={run.crashed === i} canCrash={run.crashed === -1} onCrash={() => setRun({ ...run, crashed: run.crashed === i ? -1 : i })} />
        ))}
      </div>
      <SmallLabel style={{ marginTop: 10 }}>Messages in flight. Click one to deliver it. The color is the valence after that delivery.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 24 }}>
        {options.length === 0 && <span className="muted" style={{ fontSize: 12 }}>none</span>}
        {options.map(({ m, ok, v }) => (
          <Chip key={m.id} color={ok ? VCOL[v!] : "var(--faint)"} dashed={!ok} faint={!ok} onClick={ok ? () => setRun({ ...run, steps: [...run.steps, m.id] }) : undefined}
            title={ok ? `after delivery: ${valenceName(v!)}` : `P${m.to + 1} is not in round ${m.r}, phase ${m.ph} yet`}>
            P{m.from + 1}→P{m.to + 1} r{m.r}.{m.ph} {m.v === null ? "⊥" : m.v}{ok ? ` · ${vtext(v!)}` : ""}
          </Chip>
        ))}
      </div>
      <Banner tone={decided ? "bad" : now === 3 ? "warn" : "info"}>
        {decided
          ? `P${c.p.findIndex((p) => p.dec !== null) + 1} decided ${decided === 1 ? 0 : 1}. The adversary lost this game.`
          : now === 3
            ? `Bivalent: both 0 and 1 can still be decided. ${rounds} full round${rounds === 1 ? "" : "s"} with no decision so far.`
            : now === 0 ? "No decision is reachable from here within the search horizon." : `${valenceName(now)}: nobody has decided yet, but every schedule from here decides ${now === 1 ? 0 : 1}.`}
      </Banner>
      {log.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <SpaceTime nodes={["P1", "P2", "P3"]} tEnd={Math.max(8, log.length + 1)} rowHeight={34} timeLabel="delivery number" messages={log.map((l) => ({ ...l, color: "var(--muted)" }))} marks={c.p.flatMap((p, i) => (p.dec !== null ? [{ node: i, t: log.length, label: `decide ${p.dec}`, color: VCOL[(1 << p.dec) as Valence] }] : []))} />
        </div>
      )}
      <Stats items={[
        { label: "deliveries", value: steps },
        { label: "configurations searched", value: ex.states.toLocaleString("en-US") },
        { label: "search horizon", value: `${ex.lookahead} rounds ahead` },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. Ben-Or

const B_SCHEMA = {
  n: range({ label: "Processes n", min: 3, max: 11, step: 1, default: 5 }),
  ones: range({ label: "Inputs that are 1", min: 0, max: 11, step: 1, default: 2 }),
  crashes: range({ label: "Processes that crash", min: 0, max: 5, step: 1, default: 0 }),
  seed: range({ label: "Run shown below", min: 1, max: 50, step: 1, default: 1 }),
};
const SEEDS = 400;

export function ConsensusPaxosBenOrDemo() {
  const P = useParams("cp-benor", B_SCHEMA);
  const n = P.values.n;
  const f = crashTolerance(n);
  const ones = Math.min(P.values.ones, n);
  const crashes = Math.min(P.values.crashes, f);
  const cfg = { n, f, ones, crashes };
  const jobs = useMemo(() => Array.from({ length: SEEDS }, (_, s) => () => runBenOr({ ...cfg, seed: s + 1 })), [n, ones, crashes]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked(`${n}/${ones}/${crashes}`, jobs, { keep: true });
  const done = res.filter((r): r is NonNullable<typeof r> => !!r);
  const rounds = done.map((r) => r.rounds);
  const maxR = Math.max(4, ...rounds);
  const bins = Array.from({ length: maxR }, (_, k) => ({ x0: k + 0.55, x1: k + 1.45, y: rounds.filter((r) => r === k + 1).length / Math.max(1, rounds.length) }));
  const mean = rounds.reduce((a, b) => a + b, 0) / Math.max(1, rounds.length);
  const bad = done.filter((r) => !r.agreement).length;
  const one = useMemo(() => runBenOr({ ...cfg, seed: P.values.seed }), [n, ones, crashes, P.values.seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols = Math.max(...one.history.map((h) => h.length));
  return (
    <Demo
      title="Ben-Or: a coin breaks the tie"
      controls={<>
        <Param spec={B_SCHEMA.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={{ ...B_SCHEMA.ones, max: n }} value={ones} onChange={(v) => P.set("ones", v as number)} />
        <Param spec={{ ...B_SCHEMA.crashes, max: f, format: (v) => `${v} of at most ${f}` }} value={crashes} onChange={(v) => P.set("crashes", v as number)} />
        <Param spec={B_SCHEMA.seed} value={P.values.seed} onChange={(v) => P.set("seed", v as number)} />
      </>}
    >
      <Plot x={[0.5, maxR + 0.5]} y={[0, 1]} height={190} xLabel="rounds until every live process decided" yLabel={`share of ${SEEDS} seeded runs`} xTicks={Array.from({ length: maxR }, (_, k) => k + 1).filter((k) => maxR <= 12 || k % 2 === 1)}>
        <Bars bins={bins} color="var(--c1)" />
      </Plot>
      <Stats items={[
        { label: "runs so far", value: `${done.length} of ${SEEDS}` },
        { label: "mean rounds", value: fixed(mean) },
        { label: "longest run", value: `${Math.max(0, ...rounds)} rounds` },
        { label: "runs where two values were decided", value: <span style={{ color: bad ? BAD : GOOD }}>{bad}</span> },
      ]} />
      <SmallLabel style={{ marginTop: 12 }}>Run {P.values.seed}: the estimate x of each process at the start of each round. A ring marks a value that a coin set. D marks the round in which the process decided.</SmallLabel>
      <MiniTable
        head={["", ...Array.from({ length: cols }, (_, k) => `r${k + 1}`)]}
        rows={one.history.map((h, i) => [
          `P${i + 1}`,
          ...Array.from({ length: cols }, (_, k) => {
            const e = h[k];
            if (!e) return <span key={k} className="muted">{one.decidedIn[i] === null ? "✕" : ""}</span>;
            const dec = one.decidedIn[i] === k + 1;
            return <span key={k} style={{ fontFamily: MONO, color: e.x ? "var(--c5)" : "var(--c1)", border: e.coin ? "1.5px solid currentColor" : undefined, borderRadius: 9, padding: "0 4px", fontWeight: dec ? 700 : 400, whiteSpace: "nowrap" }}>{e.x}{dec ? " D" : ""}</span>;
          }),
        ])}
      />
      <Banner tone="info">With n = {n}, a process waits for n − f = {n - f} messages per phase and decides on f + 1 = {f + 1} matching proposals. The coin only decides when the protocol is stuck between values.</Banner>
    </Demo>
  );
}
