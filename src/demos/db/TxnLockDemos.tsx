/** Demos for two-phase locking and optimistic concurrency control. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, Dots, Legend, range, select, toggle, useParams, pct } from "../../kit";
import {
  LOCK_SCRIPTS, runLockScript, lineText, LockManager, MODES, COMPAT, HIER, HIER_ACTIONS, hierLocks, tn, sup,
  type Policy, type LMode, type HierAction,
} from "../../sims/db/txn/locks";
import { simulate, MPL_SWEEP, THETA_SWEEP, hottestShare, type Protocol } from "../../sims/db/txn/contention";
import { OCC_SCRIPTS, runOcc, occLineText, type OccMode } from "../../sims/db/txn/occ";
import { tcol, GOOD, BAD, MONO, useStepper, StepButtons, StepSlider, Caption, Chip, Panel, Digraph, useChunked, type DEdge } from "./TxnShared";

// ============================================================================ 1. Lock manager stepper

const POLICIES: { value: Policy; label: string }[] = [
  { value: "detect", label: "Detect cycles" },
  { value: "wait-die", label: "Wait-die" },
  { value: "wound-wait", label: "Wound-wait" },
  { value: "no-wait", label: "No-wait" },
];

const LOCK_SCHEMA = {
  script: select({ label: "Script", options: LOCK_SCRIPTS.map((s) => ({ value: s.id, label: s.name })), default: "two", segmented: true }),
  policy: select({ label: "Deadlock policy", options: POLICIES, default: "detect", segmented: true }),
};

export function LockStepperDemo() {
  const P = useParams("txn-lock", LOCK_SCHEMA);
  const script = LOCK_SCRIPTS.find((s) => s.id === P.values.script)!;
  const policy = P.values.policy as Policy;
  const frames = useMemo(() => runLockScript(script, policy), [script, policy]);
  const s = useStepper(frames.length, 1.2);
  const f = frames[s.i]!;
  const ran = new Set(frames.slice(1, s.i + 1).map((x) => x.line));
  const skipped = new Set(frames.slice(1, s.i + 1).filter((x) => x.text.startsWith("Skip")).map((x) => x.line));
  const txns = Array.from({ length: script.txns }, (_, t) => t);
  const cyc = new Set<string>();
  if (f.cycle) for (let i = 0; i + 1 < f.cycle.length; i++) cyc.add(`${f.cycle[i]}>${f.cycle[i + 1]}`);
  const waiting = new Set(f.waits.map((w) => w.from));
  const nodes = txns.map((t) => ({
    id: t, label: tn(t), color: tcol(t),
    ring: f.aborted.includes(t) && frames[s.i - 1] && !frames[s.i - 1]!.aborted.includes(t) ? BAD : undefined,
    faded: f.aborted.includes(t) || f.committed.includes(t),
    sub: f.aborted.includes(t) ? "aborted" : f.committed.includes(t) ? "committed" : waiting.has(t) ? "waits" : undefined,
  }));
  const prevWaits = s.i > 0 ? frames[s.i - 1]!.waits : [];
  const showWaits = f.cycle ? [...f.waits, ...prevWaits.filter((w) => cyc.has(`${w.from}>${w.to}`))] : f.waits;
  const edges: DEdge[] = showWaits.map((w) => ({ from: w.from, to: w.to, label: w.res, color: cyc.has(`${w.from}>${w.to}`) ? BAD : "var(--muted)" }));
  if (f.cycle) {
    // the cycle closed by the last request: draw its edge too
    const c = f.cycle;
    const ln = script.lines[f.line];
    const lres = ln && "res" in ln ? ln.res : undefined;
    for (let i = 0; i + 1 < c.length; i++) if (!edges.some((e) => e.from === c[i] && e.to === c[i + 1])) edges.push({ from: c[i]!, to: c[i + 1]!, color: BAD, label: ln && ln.txn === c[i] ? lres : undefined });
  }
  return (
    <Demo
      title="Lock table and waits-for graph"
      actions={<StepButtons s={s} />}
      controls={<><StepSlider s={s} /><Param spec={LOCK_SCHEMA.script} value={P.values.script} onChange={(v) => { P.set("script", v as string); s.go(0); }} /><Param spec={LOCK_SCHEMA.policy} value={policy} onChange={(v) => { P.set("policy", v as Policy); s.go(0); }} /></>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
        {script.lines.map((l, i) => <Chip key={i} color={tcol(l.txn)} filled={ran.has(i) && !skipped.has(i)} strike={skipped.has(i)} dashed={!ran.has(i)} bold={i === f.line}>{lineText(l)}</Chip>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        <Panel title="Lock table: granted | waiting (FIFO)">
          {f.table.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>empty</span>}
          {f.table.map((e) => (
            <div key={e.res} style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 6, alignItems: "start", margin: "4px 0", fontSize: 12.5 }}>
              <b style={{ fontFamily: MONO }}>{e.res}</b>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                {e.granted.map((h) => <Chip key={h.txn} color={tcol(h.txn)} filled>{tn(h.txn)} {h.mode}</Chip>)}
                {e.queue.length > 0 && <span className="muted">|</span>}
                {e.queue.map((w) => <Chip key={w.txn} color={tcol(w.txn)} dashed>{tn(w.txn)} {w.mode}{w.upgrade ? " ↑" : ""}</Chip>)}
              </div>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Age: T1 is the oldest. ↑ marks a conversion (upgrade).</div>
        </Panel>
        <Panel title="Waits-for graph (A → B: A waits for B)">
          <Digraph id="txn-lock-g" nodes={nodes} edges={edges} size={190} r={18} />
        </Panel>
      </div>
      <Caption tone={f.tone} label={`${s.i}/${frames.length - 1}`}>{f.text}</Caption>
    </Demo>
  );
}

// ============================================================================ 2. Lock hierarchy with intention locks

const HIER_SCHEMA = {
  txn: select({ label: "Transaction", options: [{ value: "0", label: "T1" }, { value: "1", label: "T2" }, { value: "2", label: "T3" }], default: "1", segmented: true }),
  action: select({ label: "Action", options: HIER_ACTIONS.map((a) => ({ value: a.id, label: a.label })), default: "write-row" }),
  row: select({ label: "Row", options: ["r1", "r2", "r3", "r4"].map((r) => ({ value: r, label: r })), default: "r3", segmented: true }),
};

function freshHier() {
  const m = new LockManager("no-wait");
  for (const [res, mode] of hierLocks("read-row", "r1")) m.request(0, res, mode);
  return m;
}

export function LockHierarchyDemo() {
  const P = useParams("txn-hier", HIER_SCHEMA);
  const lm = useRef<LockManager | null>(null);
  if (!lm.current) lm.current = freshHier();
  const [, force] = useState(0);
  const [msg, setMsg] = useState<{ text: string; tone: "good" | "bad" | null }>({ text: "T1 holds IS on T, IS on P1 and S on r1: it reads row r1.", tone: null });
  const t = Number(P.values.txn);
  const action = P.values.action as HierAction;
  const needsRow = HIER_ACTIONS.find((a) => a.id === action)!.needsRow;
  const req = hierLocks(action, P.values.row);
  const m = lm.current;
  const conflicts = m.check(t, req);
  const want = new Map(req.map(([r, md]) => { const h = m.holds(t, r); return [r, h ? sup(h, md) : md] as const; }));
  const doReq = () => {
    if (conflicts.length) {
      setMsg({ text: conflicts.map((c) => `${c.want} on ${c.res} conflicts with ${c.blockers.map((b) => `${tn(b)}'s ${m.holds(b, c.res)}`).join(", ")}`).join(". ") + `. ${tn(t)} would wait.`, tone: "bad" });
      return;
    }
    for (const [res, md] of req) m.request(t, res, md);
    setMsg({ text: `${tn(t)} gets ${req.map(([r]) => `${want.get(r)} on ${r}`).join(", ")}.`, tone: "good" });
    force((x) => x + 1);
  };
  const commit = (x: number) => { m.commit(x); m.committed.delete(x); setMsg({ text: `${tn(x)} commits and releases all its locks.`, tone: null }); force((y) => y + 1); };
  const reset = () => { lm.current = freshHier(); setMsg({ text: "Reset. T1 reads row r1.", tone: null }); force((x) => x + 1); };
  // tree layout
  const W = 360, nodes: { id: string; x: number; y: number }[] = [{ id: HIER.table, x: W / 2, y: 22 }];
  HIER.pages.forEach((p, i) => nodes.push({ id: p, x: W * (0.25 + 0.5 * i), y: 92 }));
  HIER.pages.forEach((p, i) => HIER.rows[p]!.forEach((r, j) => nodes.push({ id: r, x: W * (0.25 + 0.5 * i) + (j ? 44 : -44), y: 162 })));
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const conflictRes = new Set(conflicts.map((c) => c.res));
  const holdersOf = (res: string) => m.table.get(res)?.granted ?? [];
  const cellState = (held: LMode, reqd: LMode) => {
    let s: "bad" | "good" | null = null;
    for (const [res] of req) for (const h of holdersOf(res)) if (h.txn !== t && h.mode === held && want.get(res) === reqd) s = COMPAT[held][reqd] ? (s ?? "good") : "bad";
    return s;
  };
  return (
    <Demo
      title="Table → page → row, with intention locks"
      actions={<><button className="btn primary" onClick={doReq}>Request</button><button className="btn ghost" onClick={reset}>Reset</button></>}
      controls={<>
        <Param spec={HIER_SCHEMA.txn} value={P.values.txn} onChange={(v) => P.set("txn", v as "0" | "1" | "2")} />
        <Param spec={HIER_SCHEMA.action} value={action} onChange={(v) => P.set("action", v as HierAction)} />
        {needsRow && <Param spec={HIER_SCHEMA.row} value={P.values.row} onChange={(v) => P.set("row", v as string)} />}
      </>}
    >
      <svg viewBox={`0 0 ${W} 200`} style={{ width: "100%", maxWidth: 520, display: "block", margin: "0 auto" }}>
        {nodes.slice(1).map((n) => {
          const parent = HIER.pages.includes(n.id) ? pos.get(HIER.table)! : pos.get(Object.entries(HIER.rows).find(([, rs]) => rs.includes(n.id))![0])!;
          return <line key={`l${n.id}`} x1={parent.x} y1={parent.y + 14} x2={n.x} y2={n.y - 14} stroke="var(--border)" strokeWidth={1.5} />;
        })}
        {nodes.map((n) => {
          const hs = holdersOf(n.id);
          const pend = want.get(n.id);
          const bad = conflictRes.has(n.id);
          return (
            <g key={n.id}>
              <rect x={n.x - 22} y={n.y - 14} width={44} height={28} rx={5} fill="var(--bg)" stroke={bad ? BAD : pend ? tcol(t) : "var(--fg)"} strokeWidth={pend ? 2 : 1.2} strokeDasharray={pend && !bad ? "4 3" : undefined} />
              <text x={n.x} y={n.y + 4} fontSize={12} textAnchor="middle" fontWeight={600} fill="var(--fg)">{n.id}</text>
              {hs.map((h, k) => (
                <g key={h.txn}>
                  <rect x={n.x - 30 + k * 30} y={n.y + 16} width={28} height={15} rx={3} fill={tcol(h.txn)} />
                  <text x={n.x - 16 + k * 30} y={n.y + 27} fontSize={9.5} textAnchor="middle" fill="var(--bg)" fontWeight={700}>{h.mode}</text>
                </g>
              ))}
              {pend && <text x={n.x + 26} y={n.y - 4} fontSize={10} fill={bad ? BAD : tcol(t)} fontWeight={700}>{pend}?</text>}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12.5, margin: "4px 0 10px" }}>
        <span className="muted">Holders:</span>
        {[0, 1, 2].map((x) => <Chip key={x} color={tcol(x)} filled>{tn(x)}</Chip>)}
        <span className="muted" style={{ marginLeft: 8 }}>Release:</span>
        {[0, 1, 2].map((x) => <button key={x} className="btn" style={{ padding: "2px 8px" }} onClick={() => commit(x)}>Commit {tn(x)}</button>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, alignItems: "start" }}>
        <Panel title={`${tn(t)} needs, from the root down`}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {req.map(([r]) => <Chip key={r} color={conflictRes.has(r) ? BAD : tcol(t)} dashed>{want.get(r)} {r}</Chip>)}
          </div>
          <div style={{ fontSize: 12.5, marginTop: 6, color: conflicts.length ? BAD : GOOD }}>{conflicts.length ? `Conflict on ${[...conflictRes].join(", ")}: it would wait.` : "Compatible with every holder: it would be granted."}</div>
        </Panel>
        <Panel title="Compatibility (row: held, column: requested)">
          <table style={{ borderCollapse: "collapse", fontSize: 11.5, fontFamily: MONO, width: "100%" }}>
            <thead><tr><th />{MODES.map((c) => <th key={c} style={{ padding: 2, color: "var(--muted)" }}>{c}</th>)}</tr></thead>
            <tbody>
              {MODES.map((r) => (
                <tr key={r}>
                  <th style={{ textAlign: "left", padding: 2, color: "var(--muted)" }}>{r}</th>
                  {MODES.map((c) => {
                    const st = cellState(r, c);
                    return <td key={c} style={{ textAlign: "center", padding: "2px 0", borderRadius: 3, background: st === "bad" ? BAD : st === "good" ? GOOD : "transparent", color: st ? "var(--bg)" : COMPAT[r][c] ? "var(--fg)" : "var(--faint)" }}>{COMPAT[r][c] ? "✓" : "✕"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Caption tone={msg.tone}>{msg.text}</Caption>
    </Demo>
  );
}

// ============================================================================ 3. Deadlock policies under load

const SWEEP_POL: { id: Protocol; label: string; color: string }[] = [
  { id: "detect", label: "detection", color: "var(--c1)" },
  { id: "wait-die", label: "wait-die", color: "var(--c2)" },
  { id: "wound-wait", label: "wound-wait", color: "var(--c5)" },
  { id: "no-wait", label: "no-wait", color: "var(--muted)" },
];

const DL_SCHEMA = {
  items: range({ label: "Items in the database", min: 20, max: 5000, log: true, default: 100, format: (v) => String(Math.round(v)) }),
  writeFrac: range({ label: "Share of accesses that write", min: 0.1, max: 1, step: 0.05, default: 0.5, format: (v) => pct(v, 0) }),
  cpu: toggle({ label: "CPU limit: 4 cores", default: false }),
};

export function DeadlockSweepDemo() {
  const P = useParams("txn-dl", DL_SCHEMA);
  const items = Math.round(P.values.items);
  const wf = P.values.writeFrac;
  const cores = P.values.cpu ? 4 : Infinity;
  const jobs = SWEEP_POL.flatMap((p) => MPL_SWEEP.map((mpl) => ({ p: p.id, mpl })));
  const res = useChunked(jobs.length, (i) => simulate({ protocol: jobs[i]!.p, mpl: jobs[i]!.mpl, items, writeFrac: wf, cores, ops: 8 }), [items, wf, cores]);
  const series = SWEEP_POL.map((_, pi) => MPL_SWEEP.map((mpl, mi) => [mpl, res[pi * MPL_SWEEP.length + mi]] as const).filter((x) => x[1]).map(([mpl, r]) => ({ mpl, r: r! })));
  const maxT = Math.max(0.2, ...series.flat().map((x) => x.r.throughput)) * 1.1;
  const best = series.map((s) => s.reduce((a, x) => (x.r.throughput > a.r.throughput ? x : a), s[0] ?? { mpl: 0, r: { throughput: 0 } as never }));
  return (
    <Demo title="Throughput and aborts as concurrency grows" controls={<><Param spec={DL_SCHEMA.items} value={P.values.items} onChange={(v) => P.set("items", v as number)} /><Param spec={DL_SCHEMA.writeFrac} value={wf} onChange={(v) => P.set("writeFrac", v as number)} /><Param spec={DL_SCHEMA.cpu} value={P.values.cpu} onChange={(v) => P.set("cpu", v as boolean)} /></>}>
      <Legend items={SWEEP_POL.map((p) => ({ label: p.label, color: p.color }))} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8, marginTop: 6 }}>
        <Plot x={[1, 32]} y={[0, maxT]} logX xTicks={[1, 2, 4, 8, 16, 32]} height={220} xLabel="concurrent transactions" yLabel="commits per tick">
          {series.map((s, i) => <Line key={i} points={s.map((x) => [x.mpl, x.r.throughput])} color={SWEEP_POL[i]!.color} />)}
          {series.map((s, i) => <Dots key={`d${i}`} points={s.map((x) => [x.mpl, x.r.throughput])} color={SWEEP_POL[i]!.color} r={2.5} />)}
        </Plot>
        <Plot x={[1, 32]} y={[0, 1]} logX xTicks={[1, 2, 4, 8, 16, 32]} height={220} xLabel="concurrent transactions" yLabel="abort rate" yFormat={(v) => pct(v, 0)}>
          {series.map((s, i) => <Line key={i} points={s.map((x) => [x.mpl, x.r.abortRate])} color={SWEEP_POL[i]!.color} />)}
        </Plot>
      </div>
      <Stats items={SWEEP_POL.map((p, i) => ({ label: `${p.label}: best throughput`, value: best[i]?.r ? `${best[i]!.r.throughput.toFixed(2)} at ${best[i]!.mpl}` : "…" }))} />
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Each transaction locks 8 items. One access takes one tick. An aborted transaction backs off, then retries with its old timestamp.</div>
    </Demo>
  );
}

// ============================================================================ 4. OCC stepper

const OCC_SCHEMA = {
  script: select({ label: "Script", options: OCC_SCRIPTS.map((s) => ({ value: s.id, label: s.name })), default: "stale", segmented: true }),
  mode: select({ label: "Validation", options: [{ value: "backward", label: "Backward" }, { value: "forward", label: "Forward" }], default: "backward", segmented: true }),
};

export function OccStepperDemo() {
  const P = useParams("txn-occ", OCC_SCHEMA);
  const script = OCC_SCRIPTS.find((s) => s.id === P.values.script)!;
  const mode = P.values.mode as OccMode;
  const frames = useMemo(() => runOcc(script, mode), [script, mode]);
  const s = useStepper(frames.length, 1.2);
  const f = frames[s.i]!;
  const ran = new Set(frames.slice(1, s.i + 1).map((x) => x.line));
  const skipped = new Set(frames.slice(1, s.i + 1).filter((x) => x.text.startsWith("Skip")).map((x) => x.line));
  const overlap = new Set((f.check?.rows ?? []).flatMap((r) => r.overlap));
  const involved = new Set((f.check?.rows ?? []).filter((r) => r.overlap.length).map((r) => r.against));
  return (
    <Demo
      title="Read, validate, write"
      actions={<StepButtons s={s} />}
      controls={<><StepSlider s={s} /><Param spec={OCC_SCHEMA.script} value={P.values.script} onChange={(v) => { P.set("script", v as string); s.go(0); }} /><Param spec={OCC_SCHEMA.mode} value={mode} onChange={(v) => { P.set("mode", v as OccMode); s.go(0); }} /></>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
        {script.lines.map((l, i) => <Chip key={i} color={tcol(l.t)} filled={ran.has(i) && !skipped.has(i)} strike={skipped.has(i)} dashed={!ran.has(i)} bold={i === f.line}>{occLineText(l)}</Chip>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        {f.txns.map((x) => {
          const hot = f.check && (f.check.t === x.t || involved.has(x.t));
          const ph = x.phase === "idle" ? "not started" : x.phase === "read" ? "read phase" : x.phase;
          return (
            <Panel key={x.t} accent={tcol(x.t)} title={<span style={{ display: "flex", justifyContent: "space-between" }}><b style={{ color: tcol(x.t) }}>{tn(x.t)}</b><span style={{ color: x.phase === "aborted" ? BAD : x.phase === "committed" ? GOOD : "var(--muted)" }}>{ph}{x.tn !== null ? `, tn ${x.tn}` : ""}</span></span>}>
              <div style={{ fontSize: 12, display: "grid", gap: 4, opacity: x.phase === "aborted" ? 0.6 : 1 }}>
                <div><span className="muted">start tn </span><b style={{ fontFamily: MONO }}>{x.phase === "idle" ? "–" : x.start}</b></div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}><span className="muted">read set</span>{x.rs.map((it) => <Chip key={it} color={hot && overlap.has(it) && (mode === "forward" ? involved.has(x.t) : f.check!.t === x.t) ? BAD : "var(--fg)"}>{it}</Chip>)}{!x.rs.length && <span className="muted">∅</span>}</div>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "center" }}><span className="muted">write set</span>{x.ws.map((it) => <Chip key={it} color={hot && overlap.has(it) && (mode === "forward" ? f.check!.t === x.t : false) ? BAD : "var(--fg)"} dashed={x.phase !== "committed"}>{it}</Chip>)}{!x.ws.length && <span className="muted">∅</span>}</div>
              </div>
            </Panel>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 8 }}>
        <Panel title="Committed (tn: write set)">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {f.committed.map((c) => <Chip key={c.tn} color={tcol(c.t)} filled>{c.tn}: {tn(c.t)} {"{"}{c.ws.join(", ")}{"}"}</Chip>)}
            {!f.committed.length && <span className="muted" style={{ fontSize: 12 }}>none yet</span>}
          </div>
        </Panel>
        <Panel title={f.check ? `Validation of ${tn(f.check.t)} (${mode})` : "Validation"}>
          {!f.check && <span className="muted" style={{ fontSize: 12 }}>No validation in this step.</span>}
          {f.check && f.check.rows.length === 0 && <span style={{ fontSize: 12 }}>Nothing to compare against.</span>}
          {f.check?.rows.map((r) => (
            <div key={r.against} style={{ fontFamily: MONO, fontSize: 12, color: r.overlap.length ? BAD : GOOD }}>
              {mode === "backward" ? `RS(${tn(f.check!.t)})` : `WS(${tn(f.check!.t)})`} ∩ {mode === "backward" ? `WS(${tn(r.against)})` : `RS(${tn(r.against)})`} = {"{"}{r.overlap.join(", ")}{"}"}
            </div>
          ))}
        </Panel>
      </div>
      <Caption tone={f.tone} label={`${s.i}/${frames.length - 1}`}>{f.text}</Caption>
      <div style={{ marginTop: 8 }}><Stats items={[{ label: "operations thrown away by aborts", value: f.wasted }]} /></div>
    </Demo>
  );
}

// ============================================================================ 5. OCC vs 2PL under skew

const SKEW_SCHEMA = {
  mpl: range({ label: "Concurrent transactions", min: 2, max: 32, step: 1, default: 16 }),
  writeFrac: range({ label: "Share of accesses that write", min: 0.05, max: 1, step: 0.05, default: 0.25, format: (v) => pct(v, 0) }),
  cpu: toggle({ label: "CPU limit: 4 cores", default: true }),
};
const SKEW_PROTOS: { id: Protocol; label: string; color: string }[] = [
  { id: "detect", label: "2PL (deadlock detection)", color: "var(--c1)" },
  { id: "occ", label: "OCC (backward validation)", color: "var(--c2)" },
];

export function OccSkewDemo() {
  const P = useParams("txn-skew", SKEW_SCHEMA);
  const mpl = Math.round(P.values.mpl);
  const wf = P.values.writeFrac;
  const cores = P.values.cpu ? 4 : Infinity;
  const jobs = SKEW_PROTOS.flatMap((p) => THETA_SWEEP.map((theta) => ({ p: p.id, theta })));
  const res = useChunked(jobs.length, (i) => simulate({ protocol: jobs[i]!.p, theta: jobs[i]!.theta, mpl, writeFrac: wf, cores, items: 1000, ops: 8 }), [mpl, wf, cores]);
  const series = SKEW_PROTOS.map((_, pi) => THETA_SWEEP.map((th, k) => [th, res[pi * THETA_SWEEP.length + k]] as const).filter((x) => x[1]).map(([th, r]) => ({ th, r: r! })));
  const maxT = Math.max(0.1, ...series.flat().map((x) => x.r.throughput)) * 1.1;
  return (
    <Demo title="OCC and 2PL as access gets skewed" controls={<><Param spec={SKEW_SCHEMA.mpl} value={P.values.mpl} onChange={(v) => P.set("mpl", v as number)} /><Param spec={SKEW_SCHEMA.writeFrac} value={wf} onChange={(v) => P.set("writeFrac", v as number)} /><Param spec={SKEW_SCHEMA.cpu} value={P.values.cpu} onChange={(v) => P.set("cpu", v as boolean)} /></>}>
      <Legend items={SKEW_PROTOS.map((p) => ({ label: p.label, color: p.color }))} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8, marginTop: 6 }}>
        <Plot x={[0, 1.4]} y={[0, maxT]} height={220} xLabel="Zipf skew θ" yLabel="commits per tick">
          {series.map((s, i) => <Line key={i} points={s.map((x) => [x.th, x.r.throughput])} color={SKEW_PROTOS[i]!.color} />)}
          {series.map((s, i) => <Dots key={`d${i}`} points={s.map((x) => [x.th, x.r.throughput])} color={SKEW_PROTOS[i]!.color} r={2.5} />)}
        </Plot>
        <Plot x={[0, 1.4]} y={[0, 1]} height={220} xLabel="Zipf skew θ" yLabel="work thrown away" yFormat={(v) => pct(v, 0)}>
          {series.map((s, i) => <Line key={i} points={s.map((x) => [x.th, x.r.wasted])} color={SKEW_PROTOS[i]!.color} />)}
          {series.map((s, i) => <Line key={`a${i}`} points={s.map((x) => [x.th, x.r.abortRate])} color={SKEW_PROTOS[i]!.color} dash="4 3" width={1.5} />)}
        </Plot>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Right plot: solid line = share of work thrown away, dashed line = abort rate. 1,000 items, 8 accesses per transaction.</div>
      <Stats items={[0, 0.8, 1.2].map((th) => ({ label: `θ = ${th}: hottest item gets`, value: pct(hottestShare(1000, th), 1) }))} />
    </Demo>
  );
}
