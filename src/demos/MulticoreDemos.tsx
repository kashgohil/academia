import { useMemo, useState } from "react";
import { Demo, Stats, Param, Controls, Plot, Line, Dots, Legend, RuleX, useParams, select, range, pct } from "../kit";
import { parse } from "../sims/memmodel";
import { PRESETS } from "../sims/memmodel/presets";
import { initial, exec, drain, drainable, blocked, finished, outcomeOf, allOutcomes, type Mode, type SBState } from "../sims/storebuffer";
import { avgHops, links, coherenceMessages, type Topology, type SharingPattern } from "../sims/interconnect";
import { simulateNuma, NUMA_DEFAULTS, type Placement } from "../sims/numa";

const TC = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

// ---------------- store buffers ----------------

const SB_PRESETS = ["sb-relaxed", "mp-relaxed", "mp-one-fence", "sb-fence-sc"];

export function StoreBufferDemo() {
  const [preset, setPreset] = useState(SB_PRESETS[0]!);
  const [mode, setMode] = useState<Mode>("tso");
  const p = useMemo(() => parse(PRESETS[preset]!.src), [preset]);
  const [history, setHistory] = useState<SBState[]>(() => [initial(p)]);
  const s = history[history.length - 1]!;
  const reset = (np = p) => setHistory([initial(np)]);
  const push = (n: SBState) => setHistory((h) => [...h, n]);
  const scOutcomes = useMemo(() => allOutcomes(p, "sc"), [p]);
  const done = finished(p, s);
  const outcome = done ? outcomeOf(p, s) : null;

  return (
    <Demo
      title="Store buffers, one action at a time"
      actions={
        <>
          <button className="btn" onClick={() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))} disabled={history.length < 2}>Undo</button>
          <button className="btn ghost" onClick={() => reset()}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={select({ label: "Program", options: SB_PRESETS.map((k) => ({ value: k, label: PRESETS[k]!.label })), default: SB_PRESETS[0]! })} value={preset} onChange={(v) => { setPreset(v as string); const np = parse(PRESETS[v as string]!.src); setHistory([initial(np)]); }} />
          <Param spec={select({ label: "Hardware", options: [{ value: "sc", label: "No buffer (SC)" }, { value: "tso", label: "FIFO buffer (TSO)" }, { value: "pso", label: "Unordered (PSO)" }], default: "tso", segmented: true })} value={mode} onChange={(v) => { setMode(v as Mode); reset(); }} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${p.threads.length}, minmax(0, 1fr)) minmax(120px, 160px)`, gap: 12, alignItems: "start" }}>
        {s.cores.map((c, i) => {
          const why = blocked(p, s, i);
          const drains = drainable(s, i, mode);
          return (
            <div key={i} style={{ border: "1px solid var(--border)", borderTop: `3px solid ${TC[i]}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5, minWidth: 0 }}>
              <b>Core {i}</b>
              <div style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11.5, margin: "6px 0" }}>
                {p.threads[i]!.map((ins, k) => {
                  const src = PRESETS[preset]!.src.split("\n")[ins.line - 1]!.trim();
                  return <div key={k} style={{ color: k < c.pc ? "var(--faint)" : k === c.pc ? "var(--fg)" : "var(--muted)", fontWeight: k === c.pc ? 600 : 400 }}>{k === c.pc ? "▸ " : "  "}{src}</div>;
                })}
              </div>
              <button className="btn" style={{ width: "100%", justifyContent: "center" }} disabled={!!why} onClick={() => push(exec(p, s, i, mode))}>
                {why === "finished" ? "Finished" : why ? "Blocked" : "Execute next"}
              </button>
              {why && why !== "finished" && <div className="muted" style={{ fontSize: 11 }}>{why}</div>}
              {mode !== "sc" && (
                <div style={{ marginTop: 8 }}>
                  <div className="muted" style={{ fontSize: 11.5 }}>store buffer (oldest first)</div>
                  {c.buf.length === 0 && <div className="muted" style={{ fontSize: 11.5 }}>empty</div>}
                  {c.buf.map((e, k) => (
                    <button key={k} className="btn" style={{ margin: "3px 4px 0 0", padding: "1px 8px", fontSize: 12 }} disabled={!drains.includes(k)} onClick={() => push(drain(s, i, k, mode))} title={drains.includes(k) ? "Write this store to memory" : "Must wait for an earlier store"}>
                      {e.loc}={e.val} →
                    </button>
                  ))}
                </div>
              )}
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>{Object.entries(c.regs).map(([r, v]) => `${r}=${v}`).join("  ") || " "}</div>
            </div>
          );
        })}
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", fontSize: 12.5 }}>
          <b>Memory</b>
          {Object.entries(s.mem).map(([k, v]) => <div key={k} style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>{k} = {v}</div>)}
        </div>
      </div>
      <div style={{ marginTop: 12, fontSize: 13 }}>
        {outcome ? (
          <span>
            Outcome: <code>{outcome.split(" · ")[0]}</code>{" "}
            {scOutcomes.has(outcome) ? <span className="muted">(also possible with no store buffers)</span> : <b style={{ color: "var(--c4)" }}>impossible under sequential consistency</b>}
          </span>
        ) : (
          <span className="muted">{PRESETS[preset]!.note} Execute instructions and drain buffered stores in any order you like.</span>
        )}
      </div>
    </Demo>
  );
}

// ---------------- interconnects ----------------

const TOPS: { id: Topology; label: string; color: string }[] = [
  { id: "bus", label: "Bus", color: "var(--faint)" },
  { id: "ring", label: "Ring", color: "var(--c2)" },
  { id: "mesh", label: "2D mesh", color: "var(--c1)" },
  { id: "torus", label: "2D torus", color: "var(--c3)" },
];
const NS = [4, 8, 16, 32, 64, 128];

const icSchema = {
  pattern: select<SharingPattern>({ label: "Sharing pattern", options: [{ value: "private", label: "Mostly private data" }, { value: "shared-counter", label: "Shared counter" }, { value: "broadcast", label: "One writer, everyone reads" }], default: "private" }),
};

export function InterconnectDemo() {
  const params = useParams("ic", icSchema);
  const hops = useMemo(() => TOPS.map((t) => ({ ...t, pts: NS.map((n) => [n, avgHops(t.id, n)] as [number, number]) })), []);
  const msgs = useMemo(() => NS.map((n) => ({ n, ...coherenceMessages(params.values.pattern, n) })), [params.values.pattern]);
  return (
    <Demo title="Scaling the connection between cores" controls={<Controls params={params} />}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Average hops between two cores</div>
          <Plot x={[4, 128]} y={[0, 33]} logX height={210} xTicks={NS} xFormat={String} xLabel="cores">
            {hops.map((h) => <g key={h.id}><Line points={h.pts} color={h.color} width={1.75} /><Dots points={h.pts} color={h.color} r={2} /></g>)}
          </Plot>
          <Legend items={hops.map((h) => ({ label: `${h.label} (${links(h.id, 64)} links at 64)`, color: h.color }))} />
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12.5 }}>Messages per coherence transaction</div>
          <Plot x={[4, 128]} y={[0, 130]} logX height={210} xTicks={NS} xFormat={String} xLabel="cores">
            <Line points={msgs.map((m) => [m.n, m.snoopLookups])} color="var(--c4)" width={1.75} />
            <Dots points={msgs.map((m) => [m.n, m.snoopLookups])} color="var(--c4)" r={2} />
            <Line points={msgs.map((m) => [m.n, m.directory])} color="var(--c1)" width={1.75} />
            <Dots points={msgs.map((m) => [m.n, m.directory])} color="var(--c1)" r={2} />
          </Plot>
          <Legend items={[{ label: "Snooping: every other cache looks up the line", color: "var(--c4)" }, { label: "Directory: only the sharers involved", color: "var(--c1)" }]} />
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>A bus has one hop, but every transaction occupies it for all cores: it saturates long before 64 cores. The bus line is shown for reference.</p>
    </Demo>
  );
}

// ---------------- NUMA ----------------

const numaSchema = {
  sockets: select({ label: "Sockets", options: ["2", "4"].map((v) => ({ value: v, label: v })), default: "2", segmented: true }),
  threads: range({ label: "Threads", min: 1, max: 32, step: 1, default: 16 }),
};

const PLACEMENTS: { id: Placement; label: string; color: string }[] = [
  { id: "serial-first-touch", label: "Initialized by one thread", color: "var(--c4)" },
  { id: "parallel-first-touch", label: "Initialized in parallel", color: "var(--c3)" },
  { id: "interleave", label: "Interleaved pages", color: "var(--c1)" },
];

export function NumaDemo() {
  const params = useParams("numa", numaSchema);
  const sockets = Number(params.values.sockets);
  const threads = params.values.threads;
  const curves = useMemo(
    () => PLACEMENTS.map((pl) => ({ ...pl, pts: Array.from({ length: 32 }, (_, i) => [i + 1, simulateNuma({ ...NUMA_DEFAULTS, sockets, threads: i + 1, placement: pl.id }).gbps] as [number, number]) })),
    [sockets],
  );
  const now = PLACEMENTS.map((pl) => ({ ...pl, r: simulateNuma({ ...NUMA_DEFAULTS, sockets, threads, placement: pl.id }) }));
  return (
    <Demo title={`Streaming bandwidth on a ${sockets}-socket machine`} controls={<Controls params={params} />}>
      <Plot x={[1, 32]} y={[0, sockets * NUMA_DEFAULTS.memBW * 1.1]} height={230} xLabel="threads (spread across sockets)" yLabel="GB/s">
        <RuleX at={threads} />
        {curves.map((c) => <Line key={c.id} points={c.pts} color={c.color} width={1.75} />)}
      </Plot>
      <Legend items={curves.map((c) => ({ label: c.label, color: c.color }))} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 14 }}>
        {now.map((x) => (
          <div key={x.id} style={{ border: "1px solid var(--border)", borderTop: `3px solid ${x.color}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5 }}>
            <b>{x.label}</b>
            <Stats items={[{ label: "GB/s", value: Math.round(x.r.gbps) }, { label: "avg latency (ns)", value: Math.round(x.r.latency) }]} />
            <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>{pct(x.r.remoteFraction, 0)} remote · limited by {x.r.bottleneck}</div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
        Model: each core streams up to {NUMA_DEFAULTS.coreBW} GB/s; each socket's memory gives {NUMA_DEFAULTS.memBW} GB/s; each socket-to-socket link carries {NUMA_DEFAULTS.linkBW} GB/s; local {NUMA_DEFAULTS.latLocal} ns, remote {NUMA_DEFAULTS.latRemote} ns.
      </p>
    </Demo>
  );
}
