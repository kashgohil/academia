import { useEffect, useMemo, useState } from "react";
import { Demo, Param, select } from "../kit";
import { parse, runTso, runCxx, ParseError, type Result } from "../sims/memmodel";
import { PRESETS } from "../sims/memmodel/presets";

interface Run { sc: Result; tso: Result; cxx: Result; ms: number }

const MODELS = [
  { id: "sc", label: "Seq. consistent", title: "Every instruction takes effect at once, in some interleaving" },
  { id: "tso", label: "x86-TSO", title: "Per-core store buffers; how x86 runs these atomics" },
  { id: "cxx", label: "C++ model", title: "What the C++ (and Rust, Zig, Go-atomics) memory model permits" },
] as const;

export function LitmusDemo({ presets }: { presets: readonly string[] }) {
  const [preset, setPreset] = useState<string>(presets[0]!);
  const [src, setSrc] = useState(PRESETS[preset]!.src);
  const [debounced, setDebounced] = useState(src);
  useEffect(() => setSrc(PRESETS[preset]!.src), [preset]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(src), 250);
    return () => clearTimeout(t);
  }, [src]);

  const res = useMemo((): { run: Run } | { error: string } => {
    try {
      const p = parse(debounced);
      const t0 = performance.now();
      const run = { sc: runTso(p, false), tso: runTso(p, true), cxx: runCxx(p), ms: 0 };
      run.ms = performance.now() - t0;
      return { run };
    } catch (e) {
      return { error: e instanceof ParseError ? e.message : String(e) };
    }
  }, [debounced]);

  const edited = src !== PRESETS[preset]!.src;
  const spec = select({ label: "Litmus test", options: presets.map((k) => ({ value: k, label: PRESETS[k]!.label })), default: presets[0]! });

  return (
    <Demo
      title="Litmus explorer: every outcome, three memory models"
      actions={edited ? <button className="btn ghost" onClick={() => setSrc(PRESETS[preset]!.src)}>Revert edits</button> : undefined}
      controls={<Param spec={spec} value={preset} onChange={(v) => setPreset(v as string)} />}
    >
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>{PRESETS[preset]!.note}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16, alignItems: "start" }}>
        <div>
          <textarea
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            spellCheck={false}
            rows={Math.max(8, src.split("\n").length + 1)}
            style={{ width: "100%", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, lineHeight: 1.55, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--subtle)", color: "var(--fg)", resize: "vertical" }}
          />
          <div className="muted" style={{ fontSize: 11.5 }}>
            Editable. Orders: relaxed, acquire, release, acq_rel, seq_cst (the default). Plain <code>x = 1</code> / <code>r0 = x</code> are non-atomic.
          </div>
        </div>
        <div>{"error" in res ? <div className="empty" style={{ padding: 12, fontSize: 13 }}>{res.error}</div> : <Table run={res.run} />}</div>
      </div>
    </Demo>
  );
}

function Table({ run }: { run: Run }) {
  const keys = [...new Set([run.sc, run.tso, run.cxx].flatMap((r) => r.outcomes.map((o) => o.key)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const find = (r: Result, k: string) => r.outcomes.find((o) => o.key === k);
  const racy = run.cxx.outcomes.some((o) => o.racy);
  const truncated = run.sc.truncated || run.tso.truncated || run.cxx.truncated;
  return (
    <div style={{ fontSize: 12.5 }}>
      {racy && (
        <div className="callout warn" style={{ margin: "0 0 10px" }}>
          <div className="callout-title">Data race</div>
          Some executions access plain data concurrently without happens-before. In C++ that is undefined behavior: the whole program has no defined meaning, not just those outcomes.
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontWeight: 500, padding: "4px 6px", borderBottom: "1px solid var(--border)" }}>Outcome</th>
              {MODELS.map((m) => (
                <th key={m.id} title={m.title} style={{ fontWeight: 500, padding: "4px 6px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{m.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const weak = !find(run.sc, k);
              const c = find(run.cxx, k);
              return (
                <tr key={k} style={{ background: weak ? "var(--accent-soft)" : undefined }}>
                  <td style={{ padding: "4px 6px", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
                    {k.split(" · ")[0]}
                    {k.includes(" · ") && <div style={{ color: "var(--muted)", fontSize: 11 }}>{k.split(" · ").slice(1).join(" · ")}</div>}
                    {c?.racy && !c.clean && <span className="tag" style={{ marginLeft: 6, borderColor: "var(--c4)", color: "var(--c4)" }}>race</span>}
                  </td>
                  {MODELS.map((m) => (
                    <td key={m.id} style={{ textAlign: "center", padding: "4px 6px", color: find(run[m.id], k) ? "var(--fg)" : "var(--faint)" }}>
                      {find(run[m.id], k) ? "✓" : "·"}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        Highlighted rows are impossible under sequential consistency. {run.cxx.states.toLocaleString()} C++ states explored in {run.ms.toFixed(0)} ms{truncated ? " (search truncated: simplify the program)" : ""}.
      </div>
    </div>
  );
}
