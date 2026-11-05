/** Demos for "deadlock": resource allocation graph, lockdep-style checker, banker's algorithm. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, select, useParams, Banner, MONO, MiniTable } from "../../kit";
import {
  BANK_EXAMPLE, LOCKDEP_TRACES, Lockdep, bankerRequest, bankerSafety, need, ragCycle, ragDeadlocked, ragFree, ragInit, ragRelease, ragRequest, realDeadlock,
  type Bank, type Rag,
} from "../../sims/os/sync/deadlock";
import { TC } from "./SyncShared";

// ---------------------------------------------------------------- resource allocation graph

const THREADS = ["T1", "T2", "T3"];
const RAG_SCHEMA = {
  units: select({ label: "Resources", options: [{ value: "one", label: "Each has 1 unit" }, { value: "two", label: "R2 has 2 units" }], default: "one", segmented: true }),
};
const mkRag = (units: string) => ragInit(THREADS, [{ id: "R1", units: 1 }, { id: "R2", units: units === "two" ? 2 : 1 }, { id: "R3", units: 1 }]);

const TX = [60, 180, 300], RX = [60, 180, 300], TY = 38, RY = 168;

export function SyncRagDemo() {
  const P = useParams("os-sync-rag", RAG_SCHEMA);
  const units = P.values.units as string;
  const [hist, setHist] = useState<{ u: string; list: Rag[] }>({ u: units, list: [mkRag(units)] });
  const list = hist.u === units ? hist.list : [mkRag(units)];
  const g = list[list.length - 1]!;
  const push = (n: Rag) => setHist({ u: units, list: [...list, n] });
  const cycle = ragCycle(g);
  const dead = ragDeadlocked(g);
  const onCycle = (a: string, b: string) => {
    if (!cycle) return false;
    const i = cycle.indexOf(a);
    return i >= 0 && cycle[(i + 1) % cycle.length] === b;
  };
  const pos = (id: string): [number, number] => {
    const t = THREADS.indexOf(id);
    if (t >= 0) return [TX[t]!, TY];
    return [RX[g.resources.findIndex((r) => r.id === id)]!, RY];
  };
  const edges: { from: string; to: string; kind: "wait" | "hold"; n: number }[] = [];
  for (const t of THREADS) {
    if (g.waiting[t]) edges.push({ from: t, to: g.waiting[t]!, kind: "wait", n: 1 });
    for (const [r, n] of Object.entries(g.held[t]!)) edges.push({ from: r, to: t, kind: "hold", n });
  }
  const arrow = (id: string, color: string) => (
    <marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill={color} /></marker>
  );
  return (
    <Demo
      title="Resource allocation graph"
      actions={
        <>
          <button className="btn" disabled={list.length <= 1} onClick={() => setHist({ u: units, list: list.slice(0, -1) })}>Back</button>
          <button className="btn ghost" onClick={() => setHist({ u: units, list: [mkRag(units)] })}>Reset</button>
        </>
      }
      controls={<Param spec={RAG_SCHEMA.units} value={units} onChange={(v) => P.set("units", v as never)} />}
    >
      <svg viewBox="0 0 360 206" style={{ width: "100%", maxWidth: 520, display: "block", margin: "0 auto" }} role="img" aria-label="threads, resources and their edges">
        <defs>{arrow("rag-hold", "var(--muted)")}{arrow("rag-wait", "var(--c2)")}{arrow("rag-bad", "var(--c4)")}</defs>
        {edges.map((e, i) => {
          const [x1, y1] = pos(e.from);
          const [x2, y2] = pos(e.to);
          const bad = onCycle(e.from, e.to);
          const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
          const off = e.kind === "wait" ? 7 : -7;
          const nx = (-dy / L) * off, ny = (dx / L) * off;
          const startR = e.from.startsWith("T") ? 21 : 22, endR = e.to.startsWith("T") ? 22 : 23;
          return (
            <line key={i} x1={x1 + (dx / L) * startR + nx} y1={y1 + (dy / L) * startR + ny} x2={x2 - (dx / L) * endR + nx} y2={y2 - (dy / L) * endR + ny}
              stroke={bad ? "var(--c4)" : e.kind === "wait" ? "var(--c2)" : "var(--muted)"} strokeWidth={bad ? 2.6 : 1.7} strokeDasharray={e.kind === "wait" ? "5 3" : undefined}
              markerEnd={`url(#${bad ? "rag-bad" : e.kind === "wait" ? "rag-wait" : "rag-hold"})`} />
          );
        })}
        {THREADS.map((t, i) => (
          <g key={t}>
            <circle cx={TX[i]} cy={TY} r={20} fill="var(--bg)" stroke={dead.includes(t) ? "var(--c4)" : cycle?.includes(t) ? "var(--c2)" : "var(--fg)"} strokeWidth={dead.includes(t) ? 2.6 : 1.5} />
            <text x={TX[i]} y={TY + 4.5} fontSize={13} fontWeight={600} textAnchor="middle" fill="var(--fg)">{t}</text>
          </g>
        ))}
        {g.resources.map((r, i) => (
          <g key={r.id}>
            <rect x={RX[i]! - 27} y={RY - 18} width={54} height={36} rx={4} fill="var(--bg)" stroke={cycle?.includes(r.id) ? "var(--c4)" : "var(--fg)"} strokeWidth={cycle?.includes(r.id) ? 2.4 : 1.5} />
            <text x={RX[i]} y={RY - 2} fontSize={13} fontWeight={600} textAnchor="middle" fill="var(--fg)">{r.id}</text>
            <text x={RX[i]} y={RY + 12} fontSize={9.5} textAnchor="middle" fill="var(--muted)">{ragFree(g, r.id)} of {r.units} free</text>
          </g>
        ))}
      </svg>
      <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
        {THREADS.map((t, i) => (
          <div key={t} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 12.5, width: 24, color: TC[i] }}>{t}</span>
            {g.resources.map((r) => {
              const holds = !!g.held[t]![r.id];
              return (
                <span key={r.id} style={{ display: "inline-flex", gap: 2 }}>
                  <button className="btn" style={{ padding: "2px 6px", fontSize: 11.5 }} disabled={!!g.waiting[t]} onClick={() => push(ragRequest(g, t, r.id))}>Req {r.id}</button>
                  <button className="btn" style={{ padding: "2px 6px", fontSize: 11.5 }} disabled={!holds || !!g.waiting[t]} onClick={() => push(ragRelease(g, t, r.id))}>Rel</button>
                </span>
              );
            })}
            {g.waiting[t] && <span style={{ fontSize: 11, color: "var(--c2)" }}>blocked</span>}
          </div>
        ))}
      </div>
      <Banner tone={dead.length ? "bad" : cycle ? "plain" : "good"}>
        {dead.length ? `Deadlock: ${dead.join(", ")} can never run. The cycle is ${cycle?.join(" → ")} → ${cycle?.[0]}.` : cycle ? `A cycle exists (${cycle.join(" → ")}), but there is no deadlock: another unit of a resource can still free the waiters.` : "No cycle. Dashed edges wait, and solid edges hold. Make each thread hold one resource and want the next."}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- lockdep

const LD_SCHEMA = {
  trace: select({ label: "Trace", options: Object.entries(LOCKDEP_TRACES).map(([k, v]) => ({ value: k, label: v.label })), default: "abba" }),
};

function OrderGraph({ d, flagged }: { d: Lockdep; flagged: string[] | null }) {
  const nodes = [...new Set(d.edges.flatMap((e) => [e.from, e.to]))].sort();
  const W = 260, H = 170, C = [W / 2, H / 2], R = 60;
  const p = (n: string): [number, number] => {
    const a = (nodes.indexOf(n) / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
    return [C[0]! + R * 1.35 * Math.cos(a), C[1]! + R * Math.sin(a)];
  };
  const on = (a: string, b: string) => {
    if (!flagged) return false;
    for (let i = 0; i < flagged.length - 1; i++) if (flagged[i] === a && flagged[i + 1] === b) return true;
    return false;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 320, display: "block" }} role="img" aria-label="lock order graph">
      <defs>
        <marker id="ld-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--muted)" /></marker>
        <marker id="ld-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--c4)" /></marker>
      </defs>
      {nodes.length === 0 && <text x={W / 2} y={H / 2} fontSize={12} textAnchor="middle" fill="var(--muted)">No lock order yet</text>}
      {d.edges.map((e, i) => {
        const [x1, y1] = p(e.from), [x2, y2] = p(e.to);
        const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
        const nx = (-dy / L) * 6, ny = (dx / L) * 6;
        const bad = on(e.from, e.to);
        return <line key={i} x1={x1 + (dx / L) * 18 + nx} y1={y1 + (dy / L) * 18 + ny} x2={x2 - (dx / L) * 18 + nx} y2={y2 - (dy / L) * 18 + ny} stroke={bad ? "var(--c4)" : "var(--muted)"} strokeWidth={bad ? 2.4 : 1.5} markerEnd={`url(#${bad ? "ld-b" : "ld-a"})`} />;
      })}
      {nodes.map((n) => {
        const [x, y] = p(n);
        return <g key={n}><circle cx={x} cy={y} r={16} fill="var(--bg)" stroke={flagged?.includes(n) ? "var(--c4)" : "var(--fg)"} strokeWidth={1.5} /><text x={x} y={y + 4.5} fontSize={13} fontWeight={600} textAnchor="middle" fill="var(--fg)">{n}</text></g>;
      })}
    </svg>
  );
}

export function SyncLockdepDemo() {
  const P = useParams("os-sync-lockdep", LD_SCHEMA);
  const key = P.values.trace as string;
  const preset = LOCKDEP_TRACES[key]!;
  const [state, setState] = useState({ key, at: 0 });
  const at = state.key === key ? state.at : 0;
  const d = useMemo(() => {
    const x = new Lockdep();
    for (let i = 0; i < at; i++) x.feed(preset.trace[i]!);
    return x;
  }, [preset, at]);
  const truth = useMemo(() => realDeadlock(preset.trace.filter((e) => e.ctx !== "irq")), [preset]);
  const report = d.reports[0] ?? null;
  const flagged = report?.kind === "circular" ? report.cycle.length ? report.cycle : null : null;
  const isIrq = key === "irq";
  return (
    <Demo
      title="Lock-order checker"
      actions={
        <>
          <button className="btn primary" disabled={at >= preset.trace.length} onClick={() => setState({ key, at: at + 1 })}>Next event</button>
          <button className="btn" disabled={at >= preset.trace.length} onClick={() => setState({ key, at: preset.trace.length })}>Run all</button>
          <button className="btn ghost" onClick={() => setState({ key, at: 0 })}>Reset</button>
        </>
      }
      controls={<Param spec={LD_SCHEMA.trace} value={key} onChange={(v) => P.set("trace", v as never)} />}
    >
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{preset.note}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, alignItems: "start" }}>
        <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.5 }}>
          {preset.trace.map((e, i) => {
            const flag = d.reports.some((r) => r.at === i);
            return (
              <div key={i} style={{ padding: "0 6px", borderRadius: 3, color: i < at ? "var(--fg)" : "var(--faint)", background: flag ? "var(--subtle)" : i === at ? "var(--subtle)" : "transparent", outline: flag ? "1.5px solid var(--c4)" : "none", outlineOffset: -1 }}>
                {e.t}: {e.op}({e.l})
              </div>
            );
          })}
        </div>
        <div>
          <OrderGraph d={d} flagged={flagged} />
          <div className="muted" style={{ fontSize: 11.5 }}>An arrow A → B means: B was taken while A was held.</div>
        </div>
      </div>
      <Banner tone={report ? "bad" : at >= preset.trace.length ? "good" : "plain"}>
        {report ? report.message : at >= preset.trace.length ? "No report. The order graph has no cycle." : "No report so far."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "this run blocked forever", value: "no" },
          { label: "some schedule can deadlock", value: isIrq ? "yes, with an interrupt" : truth.stuck ? `yes: ${truth.stuck.schedule.length} steps` : "no" },
          { label: "lockdep reports", value: d.reports.length },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- banker's algorithm

const REQS: { p: number; req: number[] }[] = [
  { p: 1, req: [1, 0, 2] },
  { p: 4, req: [3, 3, 0] },
  { p: 0, req: [0, 2, 0] },
  { p: 3, req: [0, 1, 0] },
  { p: 0, req: [8, 0, 0] },
];

const vec = (v: number[]) => v.join(" ");

export function SyncBankerDemo() {
  const [bank, setBank] = useState<Bank>(BANK_EXAMPLE);
  const [frame, setFrame] = useState(0);
  const [msg, setMsg] = useState<{ tone: "good" | "bad" | "plain"; text: string }>({ tone: "plain", text: "Step through the safety check. Then try a request." });
  const [probe, setProbe] = useState<Bank | null>(null);
  const shown = probe ?? bank;
  const check = useMemo(() => bankerSafety(shown), [shown]);
  const f = check.frames[Math.min(frame, check.frames.length - 1)]!;
  const nd = need(shown);
  const atEnd = frame >= check.frames.length - 1;

  const tryReq = (p: number, req: number[]) => {
    const res = bankerRequest(bank, p, req);
    setFrame(0);
    if (res.granted) {
      setBank(res.bank);
      setProbe(null);
      setMsg({ tone: "good", text: `P${p} asks for (${vec(req)}). The new state is safe, with order ${res.check.sequence.map((x) => `P${x}`).join(", ")}. Granted.` });
    } else if (res.reason === "unsafe") {
      setProbe({ available: bank.available.map((x, j) => x - req[j]!), max: bank.max, alloc: bank.alloc.map((a, i) => (i === p ? a.map((x, j) => x + req[j]!) : a)) });
      setMsg({ tone: "bad", text: `P${p} asks for (${vec(req)}). The units are free, but the new state is unsafe. The table shows that state. P${p} must wait.` });
    } else {
      setProbe(null);
      setMsg({ tone: "bad", text: res.reason === "must-wait" ? `P${p} asks for (${vec(req)}). Not enough units are free, so it must wait.` : `P${p} asks for (${vec(req)}). This is more than its declared maximum, so it is an error.` });
    }
  };

  return (
    <Demo
      title="Banker's algorithm: is this state safe?"
      actions={
        <>
          <button className="btn" disabled={frame === 0} onClick={() => setFrame(frame - 1)}>Back</button>
          <button className="btn primary" disabled={atEnd} onClick={() => setFrame(frame + 1)}>Step</button>
          <button className="btn ghost" onClick={() => { setBank(BANK_EXAMPLE); setProbe(null); setFrame(0); setMsg({ tone: "plain", text: "Step through the safety check. Then try a request." }); }}>Reset</button>
        </>
      }
    >
      <MiniTable
        head={["", "alloc", "max", "need", "state"]}
        highlight={(i) => i === f.p}
        rows={shown.max.map((_, i) => [
          <b key="n">P{i}</b>,
          <span key="a" style={{ fontFamily: MONO }}>{vec(shown.alloc[i]!)}</span>,
          <span key="m" style={{ fontFamily: MONO }}>{vec(shown.max[i]!)}</span>,
          <span key="d" style={{ fontFamily: MONO }}>{vec(nd[i]!)}</span>,
          f.finish[i] ? <span key="s" style={{ color: "var(--c3)" }}>can finish</span> : i === f.p ? <span key="s" style={{ color: "var(--c4)" }}>must wait</span> : <span key="s" className="muted">not yet</span>,
        ])}
      />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "work (units free in this test)", value: <span style={{ fontFamily: MONO }}>{vec(f.work)}</span> },
          { label: "safe order so far", value: f.sequence.length ? f.sequence.map((x) => `P${x}`).join(" ") : "none" },
          { label: "comparisons so far", value: f.comparisons },
          { label: "result", value: atEnd ? (check.safe ? "safe" : "unsafe") : "…" },
        ]} />
      </div>
      <Banner tone={msg.tone}>{msg.text}</Banner>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {REQS.map((r, i) => <button key={i} className="btn" onClick={() => tryReq(r.p, r.req)}>P{r.p} asks ({vec(r.req)})</button>)}
      </div>
    </Demo>
  );
}
