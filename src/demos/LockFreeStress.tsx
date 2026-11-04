import { useEffect, useState } from "react";
import { Demo, Plot, Line, Legend, pct } from "../kit";
import { stress, stallExperiment, type Scenario, type StressResult } from "../sims/lockfree/scenario";
import type { Scheme } from "../sims/lockfree/machine";

export interface StressConfig { label: string; scenario: Scenario; scheme: Scheme; tags: boolean }

const KINDS = ["use-after-free", "lost-or-duplicated", "corruption", "double-free"] as const;
const KC: Record<string, string> = { "use-after-free": "var(--c4)", "lost-or-duplicated": "var(--c2)", corruption: "var(--c5)", "double-free": "var(--fg)" };

/** Runs each configuration under many random schedules and reports how often each check fails. */
export function StressDemo({ configs, runs = 400, title = "Stress test: random schedules" }: { configs: StressConfig[]; runs?: number; title?: string }) {
  const [res, setRes] = useState<(StressResult | null)[]>(configs.map(() => null));
  const [seed, setSeed] = useState(1);
  useEffect(() => {
    // Run one configuration per tick so the page stays responsive.
    let alive = true;
    setRes(configs.map(() => null));
    configs.forEach((c, i) =>
      setTimeout(() => {
        if (!alive) return;
        const r = stress(c.scenario, { scheme: c.scheme, tags: c.tags, threshold: 2, pool: 16 }, runs, seed);
        setRes((prev) => prev.map((x, j) => (j === i ? r : x)));
      }, 30 * i),
    );
    return () => { alive = false; };
  }, [configs, runs, seed]);

  return (
    <Demo title={`${title} (${runs} per row)`} actions={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Rerun with new seeds</button>}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(170px, 240px) 1fr 70px", gap: "10px 12px", alignItems: "center", fontSize: 13 }}>
        {configs.map((c, i) => {
          const r = res[i];
          return (
            <div key={c.label} style={{ display: "contents" }}>
              <div>{c.label}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {r ? (
                  KINDS.map((k) => (r.byKind[k] ? (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ height: 8, width: `${Math.max(1, (100 * r.byKind[k]!) / runs)}%`, background: KC[k], borderRadius: 2 }} />
                      <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{k}</span>
                    </div>
                  ) : null))
                ) : (
                  <span className="muted">running…</span>
                )}
                {r && r.anyViolation === 0 && <span style={{ color: "var(--c3)", fontSize: 12 }}>no violations</span>}
              </div>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r ? pct(r.anyViolation / runs, 0) : ""}</span>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Bars: share of runs in which each check failed at least once. Right column: runs with any violation.</p>
    </Demo>
  );
}

export function StallDemo() {
  const schemes: { s: Scheme; label: string; color: string }[] = [
    { s: "leak", label: "Never free", color: "var(--faint)" },
    { s: "epoch", label: "Epoch-based", color: "var(--c2)" },
    { s: "hazard", label: "Hazard pointers", color: "var(--c1)" },
  ];
  const [data] = useState(() => schemes.map((x) => ({ ...x, pts: stallExperiment({ scheme: x.s, tags: true, threshold: 4, pool: 600 }) })));
  const maxX = Math.max(...data.flatMap((d) => d.pts.map((p) => p[0])));
  const maxY = Math.max(...data.flatMap((d) => d.pts.map((p) => p[1])));
  return (
    <Demo title="One thread stalls mid-operation; two others keep pushing and popping">
      <Plot x={[0, maxX]} y={[0, maxY * 1.1]} height={230} xLabel="steps" yLabel="nodes retired but not yet freed">
        {data.map((d) => <Line key={d.s} points={d.pts} color={d.color} width={d.s === "leak" ? 1.5 : 2} dash={d.s === "leak" ? "4 3" : undefined} />)}
      </Plot>
      <Legend items={data.map((d) => ({ label: d.label, color: d.color }))} />
    </Demo>
  );
}
