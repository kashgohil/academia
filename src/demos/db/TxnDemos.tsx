/** Demos for the Transactions module: ACID, schedules, isolation anomalies, the anomaly matrix and SSI. */
import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Param, Legend, range, select, toggle, useParams, useWidth, BAD, Chip, GOOD, MONO, Panel, StepButtons, StepCaption, StepSlider, useStepper } from "../../kit";
import { mulberry32 } from "../../sims/rng";
import {
  TXN_SETS, serialSchedule, precedenceGraph, findCycle, topoOrder, moveLeft, runConcrete, matchingSerialOrders, txnName,
  bankSteps, bankCrash, BANK_INIT, totalMoney, type COp,
} from "../../sims/db/txn/schedule";
import {
  SCENARIOS, SSI_SCENARIOS, LEVELS, buildPath, runnable, verdict, isMvcc, opText, tname, dangerousStructures, exploreIter, cellKind,
  type Scenario, type Level, type EState, type Explored,
} from "../../sims/db/txn/engine";
import { tcol, Digraph, type DEdge } from "./TxnShared";

// ============================================================================ 1. Atomicity: crash during transfers

const BANK_SCHEMA = {
  k: range({ label: "Crash after step", min: 0, max: 9, step: 1, default: 4 }),
  atomic: toggle({ label: "Undo log (atomicity)", default: false }),
};

function Accounts({ vals, ref0, color }: { vals: Record<string, number>; ref0: Record<string, number>; color: string }) {
  const max = 200;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {Object.keys(ref0).map((a) => (
        <div key={a} style={{ display: "grid", gridTemplateColumns: "18px 1fr 42px", alignItems: "center", gap: 6, fontSize: 12.5 }}>
          <b>{a}</b>
          <div style={{ height: 12, background: "var(--subtle)", borderRadius: 3, overflow: "hidden", border: "1px solid var(--border)" }}>
            <div style={{ width: `${(100 * vals[a]!) / max}%`, height: "100%", background: color, transition: "width 0.3s" }} />
          </div>
          <span style={{ fontFamily: MONO, textAlign: "right" }}>{vals[a]}</span>
        </div>
      ))}
    </div>
  );
}

export function BankCrashDemo() {
  const P = useParams("txn-bank", BANK_SCHEMA);
  const k = Math.round(P.values.k);
  const atomic = P.values.atomic;
  const steps = bankSteps();
  const r = bankCrash(k, atomic);
  const want = totalMoney(BANK_INIT);
  const ok = r.total === want;
  const label = (s: (typeof steps)[number]) => (s.kind === "commit" ? "commit" : `${s.acct} ${s.kind === "debit" ? "−" : "+"}${s.amount}`);
  return (
    <Demo title="Three transfers, one crash" controls={<><Param spec={BANK_SCHEMA.k} value={P.values.k} onChange={(v) => P.set("k", v as number)} /><Param spec={BANK_SCHEMA.atomic} value={atomic} onChange={(v) => P.set("atomic", v as boolean)} /></>}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {steps.map((s, i) => (
          <span key={i} style={{ display: "contents" }}>
            {i === k && <span style={{ color: BAD, fontWeight: 700, fontSize: 12, padding: "0 2px" }}>✕ crash</span>}
            <Chip color={tcol(s.txn)} filled={i < k} dashed={i >= k}>{label(s)}</Chip>
          </span>
        ))}
        {k === steps.length && <span style={{ color: BAD, fontWeight: 700, fontSize: 12 }}>✕ crash</span>}
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "6px 0 12px" }}>T1 moves 30 from A to B. T2 moves 50 from B to C. T3 moves 20 from C to A. Filled steps reached the disk.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
        <Panel title="Disk at the moment of the crash"><Accounts vals={r.atCrash} ref0={BANK_INIT} color="var(--faint)" /><div style={{ fontSize: 12.5, marginTop: 6 }}>total <b style={{ fontFamily: MONO }}>{totalMoney(r.atCrash)}</b></div></Panel>
        <Panel title="After restart and recovery" accent={ok ? GOOD : BAD}><Accounts vals={r.recovered} ref0={BANK_INIT} color={ok ? GOOD : BAD} /><div style={{ fontSize: 12.5, marginTop: 6, color: ok ? GOOD : BAD }}>total <b style={{ fontFamily: MONO }}>{r.total}</b> {ok ? "= 300: the invariant holds" : `≠ 300: ${want - r.total} disappeared`}</div></Panel>
      </div>
      {atomic && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4 }}>Undo log on disk (the old value is logged before each write)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {r.log.length === 0 && <span className="muted" style={{ fontSize: 12 }}>empty</span>}
            {r.log.map((l, i) => (
              <Chip key={i} color={tcol(l.txn)} strike={r.undone.includes(l.txn) && l.kind === "update"}>{l.kind === "commit" ? `${txnName(l.txn)} commit` : `${txnName(l.txn)} ${l.acct}: ${l.before}→${l.after}`}</Chip>
            ))}
          </div>
        </div>
      )}
      <StepCaption tone={ok ? "good" : "bad"}>
        {atomic
          ? r.undone.length ? `Recovery reads the log. ${r.undone.map(txnName).join(", ")} has no commit record, so recovery writes back the old values. ${r.committed} transfer${r.committed === 1 ? "" : "s"} stay.` : `Every logged transfer has a commit record. Recovery has nothing to undo.`
          : ok ? `The crash fell between two transfers, so the disk holds only whole transfers. This time, nothing broke.` : `The crash fell inside a transfer: the debit reached the disk, but the credit did not. Without a log, restart cannot know this.`}
      </StepCaption>
    </Demo>
  );
}

// ============================================================================ 2. Schedule builder and precedence graph

const SCHED_SCHEMA = {
  set: select({ label: "Transactions", options: TXN_SETS.map((s) => ({ value: s.id, label: s.name })), default: "transfer", segmented: true }),
};

export function ScheduleBuilderDemo() {
  const P = useParams("txn-sched", SCHED_SCHEMA);
  const set = TXN_SETS.find((s) => s.id === P.values.set)!;
  const [sched, setSched] = useState<COp[]>(() => serialSchedule(set));
  const [seed, setSeed] = useState(3);
  const [upTo, setUpTo] = useState(99);
  useEffect(() => { setSched(serialSchedule(set)); setUpTo(99); }, [set]);
  const n = sched.length;
  const k = Math.min(upTo, n);
  const g = precedenceGraph(sched, k);
  const cyc = findCycle(g.nodes, g.edges);
  const order = cyc ? null : topoOrder(g.nodes, g.edges);
  const cycEdges = new Set<string>();
  if (cyc) for (let i = 0; i + 1 < cyc.length; i++) cycEdges.add(`${cyc[i]}>${cyc[i + 1]}`);
  const full = k === n;
  const outcome = runConcrete(set, sched);
  const matches = full ? matchingSerialOrders(set, sched) : [];
  const shuffle = () => {
    const rng = mulberry32(seed);
    setSeed((s) => s + 1);
    const pos = set.txns.map(() => 0);
    const out: COp[] = [];
    while (out.length < n) {
      const ready = set.txns.map((t, i) => (pos[i]! < t.length ? i : -1)).filter((i) => i >= 0);
      const t = ready[Math.floor(rng() * ready.length)]!;
      out.push(set.txns[t]![pos[t]!++]!);
    }
    setSched(out);
    setUpTo(99);
  };
  const CW = 54, LW = 30, RH = 34;
  const W = LW + n * CW + 4, H = set.txns.length * RH + 22;
  const nodes = set.txns.map((_, t) => ({ id: t, label: txnName(t), color: tcol(t), ring: cyc?.includes(t) ? BAD : undefined }));
  const edges: DEdge[] = g.edges.flatMap((e) => e.reasons.map((r) => ({ from: e.from, to: e.to, label: r.item, color: cycEdges.has(`${e.from}>${e.to}`) ? BAD : "var(--muted)" })));
  const fmtState = (s: Record<string, number>) => Object.entries(s).map(([a, v]) => `${a}=${v}`).join(" ");
  return (
    <Demo
      title="Build a schedule, watch the precedence graph"
      actions={<><button className="btn" onClick={() => { setSched(serialSchedule(set)); setUpTo(99); }}>Serial</button><button className="btn" onClick={shuffle}>Shuffle</button></>}
      controls={<>
        <Param spec={SCHED_SCHEMA.set} value={P.values.set} onChange={(v) => P.set("set", v as string)} />
        <Param spec={range({ label: "Operations run", min: 0, max: n, step: 1, default: n })} value={k} onChange={(v) => setUpTo(v as number)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Tap an operation to move it one place earlier. The order inside each transaction stays fixed.</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: W * 1.25, display: "block" }}>
        {set.txns.map((_, t) => <text key={t} x={2} y={t * RH + 22} fontSize={12} fontWeight={700} fill={tcol(t)}>{txnName(t)}</text>)}
        {sched.map((o, i) => {
          const x = LW + i * CW, y = o.t * RH + 6;
          const done = i < k;
          return (
            <g key={`${o.t}-${o.kind}-${o.item}-${set.txns[o.t]!.indexOf(o)}`} style={{ transform: `translate(${x}px, ${y}px)`, transition: "transform 0.3s", cursor: "pointer" }} onClick={() => { setSched(moveLeft(sched, i)); setUpTo(99); }}>
              <rect width={CW - 6} height={24} rx={4} fill={done ? tcol(o.t) : "var(--bg)"} stroke={tcol(o.t)} strokeWidth={1.5} strokeDasharray={done ? undefined : "4 3"} />
              <text x={(CW - 6) / 2} y={16} fontSize={11.5} textAnchor="middle" fill={done ? "var(--bg)" : tcol(o.t)} fontFamily={MONO}>{o.kind}({o.item})</text>
            </g>
          );
        })}
        {sched.map((_, i) => <text key={i} x={LW + i * CW + (CW - 6) / 2} y={H - 2} fontSize={9.5} textAnchor="middle" fill="var(--faint)">{i + 1}</text>)}
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 8, alignItems: "start" }}>
        <div>
          <div className="muted" style={{ fontSize: 11.5 }}>Precedence graph (edge label = item of the conflict)</div>
          <Digraph id="txn-sched-g" nodes={nodes} edges={edges} size={200} />
        </div>
        <div style={{ fontSize: 13 }}>
          <div style={{ color: cyc ? BAD : GOOD, fontWeight: 600, marginBottom: 6 }}>
            {cyc ? `Cycle ${cyc.map(txnName).join(" → ")}: not conflict serializable.` : `No cycle: conflict serializable${order && order.length > 1 ? `, like the serial order ${order.map(txnName).join(" → ")}` : ""}.`}
          </div>
          {full && (
            <>
              <div><span className="muted">This schedule: </span><span style={{ fontFamily: MONO }}>{fmtState(outcome.state)}</span></div>
              {outcome.reads.map((r, t) => r.length > 0 && <div key={t}><span style={{ color: tcol(t) }}>{txnName(t)} read </span><span style={{ fontFamily: MONO }}>{r.join(", ")}</span></div>)}
              <div style={{ marginTop: 6 }}>
                {matches.length
                  ? <span style={{ color: GOOD }}>Same result as the serial order{matches.length > 1 ? "s" : ""} {matches.map((m) => m.map(txnName).join(" → ")).join(" and ")}.</span>
                  : <span style={{ color: BAD }}>No serial order gives these reads and this final state.</span>}
              </div>
            </>
          )}
          {!full && <div className="muted">Run all operations to compare the result with the serial orders.</div>}
        </div>
      </div>
    </Demo>
  );
}

// ============================================================================ 3. Engine stepper (anomaly explorer, SSI)

function LaneView({ sc, st, prev }: { sc: Scenario; st: EState; prev: EState | null }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {sc.txns.map((p, t) => {
        const x = st.txns[t]!;
        const status = x.status === "blocked" ? "waits" : x.status === "aborted" ? (x.abortReason === "scripted" ? "rolled back" : "aborted") : x.status === "committed" ? "committed" : x.pc === 0 ? "not started" : "running";
        const sCol = x.status === "aborted" ? BAD : x.status === "committed" ? GOOD : x.status === "blocked" ? "var(--c2)" : "var(--muted)";
        const justMoved = prev && (prev.txns[t]!.pc !== x.pc || prev.txns[t]!.status !== x.status);
        return (
          <div key={t} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, padding: "4px 6px", borderRadius: 6, border: `1px solid ${justMoved ? tcol(t) : "var(--border)"}`, background: justMoved ? "var(--subtle)" : "transparent" }}>
            <b style={{ color: tcol(t), width: 24, fontSize: 12.5 }}>{tname(t)}</b>
            {p.ops.map((op, i) => {
              const done = i < x.pc;
              const cur = i === x.pc && x.status !== "committed" && x.status !== "aborted";
              return <Chip key={i} color={x.status === "aborted" && done ? BAD : cur && x.status === "blocked" ? "var(--c2)" : tcol(t)} filled={done} dashed={!done && !cur} strike={x.status === "aborted" && i >= x.pc} bold={cur}>{opText(op)}</Chip>;
            })}
            <span style={{ fontSize: 11.5, color: sCol, marginLeft: "auto", fontWeight: 600 }}>{status}</span>
          </div>
        );
      })}
    </div>
  );
}

function DataView({ st }: { st: EState }) {
  const mv = isMvcc(st.level);
  if (!mv) {
    const keys = [...new Set([...Object.keys(st.store), ...Object.keys(st.locks).filter((k) => !k.startsWith("g:"))])].sort();
    const groups = Object.keys(st.locks).filter((k) => k.startsWith("g:"));
    const lockChips = (res: string) => Object.entries(st.locks[res] ?? {}).flatMap(([t, ms]) => ms.map((m) => <Chip key={`${t}${m}`} color={tcol(Number(t))}>{tname(Number(t))}:{m}</Chip>));
    return (
      <div style={{ display: "grid", gap: 3, fontSize: 12.5 }}>
        {keys.map((k) => (
          <div key={k} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, minWidth: 64 }}>{k}</span>
            <b style={{ fontFamily: MONO, minWidth: 24 }}>{k in st.store ? st.store[k] : "–"}</b>
            {lockChips(k)}
          </div>
        ))}
        {groups.map((g) => (
          <div key={g} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, minWidth: 64 }} className="muted">all {g.slice(2)}</span>
            <span style={{ minWidth: 24 }} />
            {lockChips(g)}
          </div>
        ))}
        {keys.length === 0 && <span className="muted">no rows</span>}
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 3, fontSize: 12.5 }}>
      {Object.keys(st.versions).sort().map((k) => (
        <div key={k} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontFamily: MONO, minWidth: 64 }}>{k}</span>
          {st.versions[k]!.map((v, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span className="muted">→</span>}
              <Chip color={v.txn < 0 ? "var(--fg)" : tcol(v.txn)} dashed={v.commitTs === null} title={v.commitTs === null ? "uncommitted" : `committed at ${v.commitTs}`}>{v.value} <span style={{ fontSize: 10 }}>{v.txn < 0 ? "" : tname(v.txn)}{v.commitTs === null ? "?" : ""}</span></Chip>
            </span>
          ))}
        </div>
      ))}
      {Object.keys(st.versions).length === 0 && <span className="muted">no rows</span>}
      <span className="muted" style={{ fontSize: 11 }}>Dashed with "?": not committed yet. A chain goes from old to new.</span>
    </div>
  );
}

function DepGraph({ sc, st, id }: { sc: Scenario; st: EState; id: string }) {
  const dang = st.level === "SI" || st.level === "SSI" || st.level === "SSI-BASIC" ? dangerousStructures(st, sc, st.level !== "SSI-BASIC") : [];
  const pivots = new Set(dang.map((d) => d.pivot));
  const nodes = sc.txns.map((_, t) => ({ id: t, label: tname(t), color: tcol(t), ring: pivots.has(t) ? BAD : undefined, faded: st.txns[t]!.status === "aborted", sub: st.txns[t]!.status === "committed" ? "committed" : st.txns[t]!.status === "aborted" ? "aborted" : undefined }));
  const edges: DEdge[] = st.edges.filter((e) => st.txns[e.from]!.status !== "aborted" && st.txns[e.to]!.status !== "aborted").map((e) => ({ from: e.from, to: e.to, label: `${e.kind} ${e.key.includes(":") ? e.key.split(":")[1] : e.key}`, color: e.kind === "rw" ? BAD : "var(--muted)", dash: e.kind === "rw" ? "5 3" : undefined }));
  return (
    <div>
      <Digraph id={id} nodes={nodes} edges={edges} size={210} />
      <div style={{ fontSize: 12, textAlign: "center", color: dang.length ? BAD : "var(--muted)" }}>
        {dang.length ? `Dangerous: ${dang.slice(0, 2).map((d) => `${tname(d.tin)} → ${tname(d.pivot)} → ${tname(d.tout)}`).join("; ")}` : st.edges.some((e) => e.kind === "rw") ? "rw edges, but no dangerous structure yet" : "no rw edges"}
      </div>
    </div>
  );
}

export function EngineStepper({ id, title, scenarios, levels, defScenario, defLevel, graph }: { id: string; title: string; scenarios: Scenario[]; levels: Level[]; defScenario: string; defLevel: Level; graph?: boolean }) {
  const schema = useMemo(() => ({
    scenario: select({ label: "Scenario", options: scenarios.map((s) => ({ value: s.id, label: `${s.name}` })), default: defScenario }),
    level: select({ label: "Isolation", options: LEVELS.filter((l) => levels.includes(l.id)).map((l) => ({ value: l.id, label: l.name })).concat(levels.includes("SSI-BASIC") ? [{ value: "SSI-BASIC", label: "SSI without the commit-order rule" }] : []), default: defLevel, segmented: levels.length <= 3 }),
  }), [scenarios, levels, defScenario, defLevel]);
  const P = useParams(id, schema);
  const sc = scenarios.find((s) => s.id === P.values.scenario) ?? scenarios[0]!;
  const level = P.values.level as Level;
  const [choices, setChoices] = useState<number[]>(sc.classic);
  useEffect(() => setChoices(sc.classic), [sc]);
  const path = useMemo(() => buildPath(sc, level, choices), [sc, level, choices]);
  const s = useStepper(path.states.length, 1.4);
  useEffect(() => { s.go(0); }, [sc, level]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = path.states[s.i]!;
  const prev = s.i > 0 ? path.states[s.i - 1]! : null;
  const newEvents = st.events.slice(prev ? prev.events.length : 0);
  const done = s.i === path.states.length - 1;
  const v = done ? verdict(st, sc) : null;
  const run = runnable(st, sc);
  const choose = (t: number) => {
    setChoices([...path.used.slice(0, s.i), t]);
    s.go(s.i + 1);
  };
  const tone = newEvents.some((e) => e.kind === "abort" && !e.text.includes("rolls back")) ? "bad" : newEvents.some((e) => e.kind === "commit") ? "good" : null;
  return (
    <Demo
      title={title}
      actions={<StepButtons s={s} />}
      controls={<>
        <StepSlider s={s} />
        <Param spec={schema.scenario} value={P.values.scenario} onChange={(x) => P.set("scenario", x as string)} />
        <Param spec={schema.level} value={level} onChange={(x) => P.set("level", x as Level)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 8, fontSize: 12.5 }}>
        <span className="muted">Next step:</span>
        {sc.txns.map((_, t) => (
          <button key={t} className="btn" style={{ borderColor: run.includes(t) ? tcol(t) : undefined, color: run.includes(t) ? tcol(t) : undefined }} disabled={!run.includes(t)} onClick={() => choose(t)}>{tname(t)}</button>
        ))}
        <button className="btn ghost" onClick={() => { setChoices(sc.classic); s.go(0); }}>Classic order</button>
      </div>
      <LaneView sc={sc} st={st} prev={prev} />
      <div style={{ display: "grid", gridTemplateColumns: graph ? "repeat(auto-fit, minmax(230px, 1fr))" : "1fr", gap: 10, marginTop: 10 }}>
        <Panel title={isMvcc(level) ? "Versions of each row" : "Rows and locks"}><DataView st={st} /></Panel>
        {graph && <Panel title="Dependency graph (red dashed = rw)"><DepGraph sc={sc} st={st} id={`${id}-g`} /></Panel>}
      </div>
      <StepCaption tone={done && v ? (v.anomaly ? "bad" : "good") : tone} label={`${s.i}/${path.states.length - 1}`}>
        {s.i === 0 ? `Start. What can go wrong: ${sc.bad} Step through, or pick which transaction runs next.` : newEvents.map((e) => e.text).join(" ")}
        {done && v && (
          <div style={{ marginTop: 4, fontWeight: 600, color: v.anomaly ? BAD : GOOD }}>
            {v.anomaly
              ? `Anomaly: ${sc.bad}`
              : v.committed.length === 0 ? "Nothing committed." : `Serializable: same result as ${v.matches.map((m) => m.map(tname).join(" → ")).join(" or ")}${v.engineAborts.length ? `, after the engine aborted ${v.engineAborts.map(tname).join(", ")}` : ""}.`}
          </div>
        )}
      </StepCaption>
    </Demo>
  );
}

export function AnomalyExplorerDemo() {
  return <EngineStepper id="txn-anom" title="Two transactions, one isolation level" scenarios={SCENARIOS} levels={LEVELS.map((l) => l.id)} defScenario="lost-update" defLevel="RC" />;
}

export function SsiStepperDemo() {
  return <EngineStepper id="txn-ssi" title="Snapshot isolation vs SSI" scenarios={SSI_SCENARIOS} levels={["SI", "SSI"]} defScenario="write-skew" defLevel="SI" graph />;
}

// ============================================================================ 4. Anomaly matrix (exhaustive)

/** Drives explore generators in time slices; returns the results so far. */
function useExplore(jobs: { sc: Scenario; level: Level }[], key: string): (Explored | undefined)[] {
  const [out, setOut] = useState<(Explored | undefined)[]>([]);
  useEffect(() => {
    let cancelled = false;
    const acc: (Explored | undefined)[] = jobs.map(() => undefined);
    setOut([...acc]);
    let j = 0;
    let it = jobs.length ? exploreIter(jobs[0]!.sc, jobs[0]!.level) : null;
    const tick = () => {
      if (cancelled || !it) return;
      const t0 = performance.now();
      while (it && performance.now() - t0 < 25) {
        const n = it.next();
        if (n.done) {
          acc[j] = { ...n.value };
          j++;
          it = j < jobs.length ? exploreIter(jobs[j]!.sc, jobs[j]!.level) : null;
        }
      }
      setOut([...acc]);
      if (it) window.setTimeout(tick, 0);
    };
    const id = window.setTimeout(tick, 0);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return out;
}

const KIND_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  allowed: { bg: BAD, text: "var(--bg)", label: "anomaly gets through" },
  aborts: { bg: "var(--c5)", text: "var(--bg)", label: "prevented by aborts" },
  blocks: { bg: "var(--c2)", text: "var(--bg)", label: "prevented by waiting" },
  clean: { bg: GOOD, text: "var(--bg)", label: "prevented, no wait, no abort" },
};

export function AnomalyMatrixDemo() {
  const jobs = useMemo(() => SCENARIOS.flatMap((sc) => LEVELS.map((l) => ({ sc, level: l.id }))), []);
  const res = useExplore(jobs, "matrix");
  const [sel, setSel] = useState(4 * LEVELS.length + 3);
  const [ref, w] = useWidth<HTMLDivElement>();
  const narrow = w < 520;
  const done = res.filter(Boolean).length;
  const cur = res[sel];
  const job = jobs[sel]!;
  return (
    <Demo title="Every interleaving, every level">
      <div ref={ref}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 2, tableLayout: "fixed", fontSize: narrow ? 10.5 : 12 }}>
          <thead>
            <tr>
              <th style={{ width: narrow ? 46 : 150 }} />
              {LEVELS.map((l) => <th key={l.id} title={l.name} style={{ fontWeight: 600, color: "var(--muted)", padding: "2px 0" }}>{l.short}</th>)}
            </tr>
          </thead>
          <tbody>
            {SCENARIOS.map((sc, si) => (
              <tr key={sc.id}>
                <td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={sc.name}>{narrow ? sc.code : <><span className="muted" style={{ fontFamily: MONO, fontSize: 11 }}>{sc.code}</span> {sc.name}</>}</td>
                {LEVELS.map((l, li) => {
                  const i = si * LEVELS.length + li;
                  const e = res[i];
                  const ks = e ? KIND_STYLE[cellKind(e)]! : null;
                  return (
                    <td key={l.id} onClick={() => setSel(i)} style={{ cursor: "pointer", textAlign: "center", padding: "5px 0", borderRadius: 4, background: ks ? ks.bg : "var(--subtle)", color: ks ? ks.text : "var(--muted)", fontFamily: MONO, outline: i === sel ? "2px solid var(--fg)" : undefined, outlineOffset: 1, opacity: ks ? 1 : 0.6 }}>
                      {e ? (e.anomalies ? e.anomalies : cellKind(e) === "aborts" ? "A" : cellKind(e) === "blocks" ? "W" : "✓") : "…"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8 }}>
        <Legend box items={Object.values(KIND_STYLE).map((k) => ({ label: k.label, color: k.bg }))} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>A number is the count of interleavings with the anomaly. A = aborts, W = waits, ✓ = neither. {done < jobs.length ? `Exploring: ${done} of ${jobs.length} cells.` : `All ${jobs.length} cells explored.`}</div>
      <StepCaption tone={cur ? (cur.anomalies ? "bad" : "good") : null}>
        <b>{job.sc.name}</b> under <b>{LEVELS.find((l) => l.id === job.level)!.name}</b>:{" "}
        {cur
          ? `${cur.runs} interleavings. ${cur.anomalies ? `${cur.anomalies} show the anomaly (${job.sc.bad})` : "None shows the anomaly."} A transaction waited in ${cur.blocked}, and the engine aborted one in ${cur.aborted}.${cur.example ? ` One bad order: ${cur.example.map(tname).join(" ")}.` : ""}`
          : "exploring…"}
      </StepCaption>
    </Demo>
  );
}

// ============================================================================ 5. SSI counts: anomalies vs false positives

const SSI_LEVELS: { id: Level; label: string; color: string }[] = [
  { id: "SI", label: "SI", color: "var(--c2)" },
  { id: "SSI-BASIC", label: "SSI, no commit-order rule", color: "var(--c5)" },
  { id: "SSI", label: "SSI (PostgreSQL rules)", color: "var(--c1)" },
];

export function SsiCountsDemo() {
  const jobs = useMemo(() => SSI_SCENARIOS.flatMap((sc) => SSI_LEVELS.map((l) => ({ sc, level: l.id }))), []);
  const res = useExplore(jobs, "ssi");
  return (
    <Demo title="Anomalies and aborts over all interleavings">
      <div style={{ display: "grid", gap: 14 }}>
        {SSI_SCENARIOS.map((sc, si) => (
          <div key={sc.id}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{sc.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({sc.txns.length} transactions)</span></div>
            {SSI_LEVELS.map((l, li) => {
              const e = res[si * SSI_LEVELS.length + li];
              const an = e ? e.anomalies / e.runs : 0, ab = e ? e.aborted / e.runs : 0;
              return (
                <div key={l.id} style={{ fontSize: 12, margin: "4px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: l.color }}>{l.label}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{e ? `${e.anomalies} bad, ${e.aborted} aborted, of ${e.runs}` : "…"}</span>
                  </div>
                  <div style={{ height: 12, display: "flex", background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 3, overflow: "hidden", marginTop: 2 }}>
                    <div style={{ width: `${an * 100}%`, background: BAD, transition: "width 0.3s" }} />
                    <div style={{ width: `${ab * 100}%`, background: "var(--c5)", opacity: 0.7, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}><Legend box items={[{ label: "runs with an anomaly", color: BAD }, { label: "runs where the engine aborted a transaction", color: "var(--c5)" }]} /></div>
      <Stats items={[{ label: "interleavings explored", value: res.reduce((a, e) => a + (e?.runs ?? 0), 0).toLocaleString("en-US") }]} />
    </Demo>
  );
}
