import { useMemo, useState } from "react";
import { Demo, Stats, Param, select } from "../kit";
import { Coherence, WORKLOADS, runWorkload, lineName, type Protocol, type St } from "../sims/coherence";

const ST_COLOR: Record<St, string> = { M: "var(--c4)", O: "var(--c5)", E: "var(--c3)", S: "var(--c1)", I: "var(--faint)" };
const ST_NAME: Record<St, string> = { M: "Modified", O: "Owned", E: "Exclusive", S: "Shared", I: "Invalid" };
const LINES = [0, 1, 2, 3];

type Act = { core: number; op: "R" | "W"; addr: number };

const SCRIPTS: { label: string; acts: Act[] }[] = [
  { label: "Read, then write (one core)", acts: [{ core: 0, op: "R", addr: 0 }, { core: 0, op: "W", addr: 0 }] },
  { label: "Producer → consumer ×2", acts: [{ core: 0, op: "W", addr: 0 }, { core: 1, op: "R", addr: 0 }, { core: 0, op: "W", addr: 0 }, { core: 1, op: "R", addr: 0 }] },
  { label: "Everyone reads, one writes", acts: [{ core: 0, op: "R", addr: 1 }, { core: 1, op: "R", addr: 1 }, { core: 2, op: "R", addr: 1 }, { core: 2, op: "W", addr: 1 }] },
  { label: "Ping-pong writes", acts: [0, 1, 0, 1, 0, 1].map((core) => ({ core, op: "W" as const, addr: 2 })) },
];

export function CoherenceDemo() {
  const [protocol, setProtocol] = useState<Protocol>("MESI");
  const [cores, setCores] = useState(3);
  const [acts, setActs] = useState<Act[]>([]);
  const [line, setLine] = useState(0);

  const sim = useMemo(() => {
    const c = new Coherence(cores, 4, protocol);
    let v = 0;
    for (const a of acts) if (a.op === "R") c.read(a.core, a.addr); else c.write(a.core, a.addr, ++v);
    return c;
  }, [protocol, cores, acts]);

  const add = (a: Act) => setActs((x) => [...x, a]);
  const lastLog = sim.log.slice(-6);

  return (
    <Demo
      title={`${protocol} coherence · ${cores} cores, snooping bus`}
      actions={
        <>
          <button className="btn" onClick={() => setActs((x) => x.slice(0, -1))} disabled={!acts.length}>Undo</button>
          <button className="btn ghost" onClick={() => setActs([])}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={select({ label: "Protocol", options: (["MSI", "MESI", "MOESI"] as const).map((p) => ({ value: p, label: p })), default: "MESI", segmented: true })} value={protocol} onChange={(v) => setProtocol(v as Protocol)} />
          <Param spec={select({ label: "Cores", options: ["2", "3", "4"].map((v) => ({ value: v, label: v })), default: "3", segmented: true })} value={String(cores)} onChange={(v) => { setCores(Number(v)); setActs([]); }} />
        </>
      }
    >
      <div className="row" style={{ marginBottom: 12 }}>
        {SCRIPTS.map((s) => <button key={s.label} className="btn" onClick={() => setActs(s.acts.filter((a) => a.core < cores))}>{s.label}</button>)}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: 460 }}>
          <thead>
            <tr>
              <th />
              {LINES.map((l) => (
                <th key={l} style={{ padding: "4px 10px", fontWeight: 500, cursor: "pointer", color: l === line ? "var(--fg)" : "var(--muted)", borderBottom: l === line ? "2px solid var(--fg)" : "2px solid transparent" }} onClick={() => setLine(l)}>
                  line {lineName(l)}
                </th>
              ))}
              <th style={{ padding: "4px 10px", fontWeight: 500, color: "var(--muted)" }}>actions on line {lineName(line)}</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: cores }, (_, k) => (
              <tr key={k}>
                <td style={{ padding: "6px 10px 6px 0", fontWeight: 550 }}>Core {k}</td>
                {LINES.map((l) => {
                  const st = sim.state(k, l);
                  const v = sim.value(k, l);
                  return (
                    <td key={l} style={{ padding: 4, textAlign: "center" }} title={ST_NAME[st]}>
                      <div style={{ border: `1.5px solid ${ST_COLOR[st]}`, color: ST_COLOR[st], borderRadius: 4, padding: "3px 0", minWidth: 54, fontWeight: 600, opacity: st === "I" ? 0.6 : 1 }}>
                        {st}{v !== null && st !== "I" ? <span style={{ color: "var(--muted)", fontWeight: 400 }}> {v}</span> : null}
                      </div>
                    </td>
                  );
                })}
                <td style={{ padding: "4px 10px" }}>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn" style={{ padding: "2px 10px" }} onClick={() => add({ core: k, op: "R", addr: line })}>Read</button>
                    <button className="btn" style={{ padding: "2px 10px" }} onClick={() => add({ core: k, op: "W", addr: line })}>Write</button>
                  </div>
                </td>
              </tr>
            ))}
            <tr>
              <td style={{ padding: "6px 10px 6px 0", color: "var(--muted)" }}>Memory</td>
              {LINES.map((l) => {
                const dirty = Array.from({ length: cores }, (_, k) => sim.state(k, l)).some((s) => s === "M" || s === "O");
                return (
                  <td key={l} style={{ padding: 4, textAlign: "center", color: dirty ? "var(--c4)" : "var(--muted)", fontSize: 12.5 }}>
                    {sim.memValue(l)}{dirty ? " (stale)" : ""}
                  </td>
                );
              })}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, margin: "10px 0" }}>
        {(Object.keys(ST_NAME) as St[]).filter((s) => protocol === "MOESI" || s !== "O").filter((s) => protocol !== "MSI" || s !== "E").map((s) => (
          <span key={s}><b style={{ color: ST_COLOR[s] }}>{s}</b> <span className="muted">{ST_NAME[s]}</span></span>
        ))}
      </div>
      <Stats
        items={[
          { label: "bus transactions", value: sim.busTransactions },
          { label: "memory reads", value: sim.c.memReads },
          { label: "memory writes", value: sim.c.memWrites },
          { label: "cache-to-cache", value: sim.c.c2c },
          { label: "invalidations", value: sim.c.invalidations },
        ]}
      />
      <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5, marginTop: 10, minHeight: 60 }}>
        {lastLog.length ? lastLog.map((e, i) => <div key={i}><b>C{e.core}</b> {e.text}</div>) : <span className="muted">Pick a line (column header), then Read or Write on any core, or run a script.</span>}
      </div>
    </Demo>
  );
}

export function CoherenceWorkloadsDemo() {
  const [cores, setCores] = useState(4);
  const rows = useMemo(
    () => WORKLOADS.map((w) => ({ w, r: (["MSI", "MESI", "MOESI"] as const).map((p) => runWorkload(w.gen(cores), cores, p)) })),
    [cores],
  );
  const cell = { padding: "6px 8px", borderBottom: "1px solid var(--border)", fontVariantNumeric: "tabular-nums" as const };
  return (
    <Demo
      title="Same workload, three protocols"
      controls={<Param spec={select({ label: "Cores", options: ["2", "4", "8"].map((v) => ({ value: v, label: v })), default: "4", segmented: true })} value={String(cores)} onChange={(v) => setCores(Number(v))} />}
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: "left", fontWeight: 500 }}>Workload</th>
              {["MSI", "MESI", "MOESI"].map((p) => <th key={p} style={{ ...cell, fontWeight: 500 }}>{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ w, r }) => (
              <tr key={w.id}>
                <td style={{ ...cell }}>
                  {w.label}
                  <div className="muted" style={{ fontSize: 11.5 }}>{w.note}</div>
                </td>
                {r.map((c, i) => (
                  <td key={i} style={{ ...cell, textAlign: "center" }}>
                    <div>{c.busTransactions} bus</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{c.c.memWrites} mem wr · {c.c.cycles.toLocaleString()} cyc</div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Cycles use hit 4, cache-to-cache 40, upgrade 30, memory 100.</p>
    </Demo>
  );
}
