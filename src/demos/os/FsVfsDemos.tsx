/** Demos for "path lookup and the VFS": a path walk stepper and a cost plot for stat. */
import { useMemo, useRef, useState } from "react";
import { Demo, Dots, Legend, Line, Param, Plot, RuleX, Stats, pct, range, select, si, useParams } from "../../kit";
import { Dcache, ROOT_CRED, STAT_COST_INPUTS, USER_CRED, deviceReadNs, demoNamespace, statCost, statsPerSecond, walkPath, type Namespace, type StatDevice, type StepKind, type VNode, type WalkResult } from "../../sims/os/fs/vfs";
import { Banner, Heading, MONO, Note, smallBtn } from "./FsUi";

const PATHS = [
  { value: "/home/kash/notes.txt", label: "/home/kash/notes.txt" },
  { value: "/bin/ls", label: "/bin/ls (a symlink in the middle)" },
  { value: "/home/kash/latest", label: "/home/kash/latest (a symlink at the end)" },
  { value: "/mnt/data/logs/app.log", label: "/mnt/data/logs/app.log (crosses a mount)" },
  { value: "/home/kash/data/etc/passwd", label: "/home/kash/data/etc/passwd (links, a mount, ..)" },
  { value: "/home/kash/missing", label: "/home/kash/missing (no such file)" },
  { value: "/root/secret", label: "/root/secret (mode 0700 directory)" },
  { value: "/etc/passwd/x", label: "/etc/passwd/x (a file in the middle)" },
  { value: "/loop/a", label: "/loop/a (a symlink loop)" },
];

const W = {
  path: select({ label: "Path", options: PATHS, default: PATHS[0]!.value }),
  user: select({ label: "User", segmented: true, options: [{ value: "kash", label: "kash (uid 1000)" }, { value: "root", label: "root" }], default: "kash" }),
};

const STEP_COLOR: Record<StepKind, string> = {
  perm: "var(--muted)", hit: "var(--c3)", negative: "var(--c2)", miss: "var(--c2)", dirread: "var(--c2)", unlazy: "var(--c5)", mount: "var(--c1)", symlink: "var(--c1)", dotdot: "var(--c1)", done: "var(--c3)", error: "var(--c4)",
};
const STEP_NAME: Record<StepKind, string> = {
  perm: "check", hit: "hit", negative: "neg. hit", miss: "miss", dirread: "dir read", unlazy: "to ref-walk", mount: "mount", symlink: "symlink", dotdot: "..", done: "done", error: "error",
};

function mountLines(ns: Namespace) {
  const out: { depth: number; label: string; fs: string; path: string; hiddenBy?: string }[] = [];
  const go = (n: VNode, depth: number, prefix: string, m: Namespace["mounts"][number]) => {
    for (const k of [...(n.children?.values() ?? [])]) {
      const path = `${prefix}/${k.name}`;
      const over = ns.mountAt(m, k);
      if (over) {
        out.push({ depth, label: `${k.name}/`, fs: over.fs, path, hiddenBy: over.fs });
        go(over.root, depth + 1, path, over);
      } else {
        out.push({ depth, label: k.kind === "symlink" ? `${k.name} -> ${k.target}` : `${k.name}${k.kind === "dir" ? "/" : ""}`, fs: k.fs, path });
        if (k.kind === "dir") go(k, depth + 1, path, m);
      }
    }
  };
  go(ns.rootMount.root, 0, "", ns.rootMount);
  return out;
}

export function FsPathWalkDemo() {
  const P = useParams("os-fs-walk", W);
  const ns = useRef(demoNamespace()).current;
  const dc = useRef(new Dcache()).current;
  const [run, setRun] = useState<{ res: WalkResult; base: string[]; added: string[] } | null>(null);
  const [shown, setShown] = useState(0);
  const [, force] = useState(0);
  const lines = useMemo(() => mountLines(ns), [ns]);
  const cred = P.values.user === "root" ? ROOT_CRED : USER_CRED;
  const keyOf = (e: { parent: number; name: string; node: VNode | null }) => `${e.parent}/${e.name}`;
  const nodeName = useMemo(() => {
    const m = new Map<number, string>();
    const visit = (n: VNode) => { m.set(n.id, n.name); n.children?.forEach(visit); };
    ns.mounts.forEach((x) => visit(x.root));
    return m;
  }, [ns]);

  const start = () => {
    const base = dc.entries.map(keyOf);
    const res = walkPath(ns, P.values.path, { cred, dcache: dc });
    const baseSet = new Set(base);
    const added = dc.entries.map(keyOf).filter((k) => !baseSet.has(k));
    setRun({ res, base, added });
    setShown(1);
  };
  const steps = run?.res.steps ?? [];
  const cur = steps[Math.max(0, shown - 1)];
  const done = run ? shown >= steps.length : false;

  // The dcache as of the current step.
  const inserted = run ? steps.slice(0, shown).filter((s) => s.kind === "dirread").length : 0;
  const visibleKeys = new Set(run ? [...run.base, ...run.added.slice(0, inserted)] : dc.entries.map(keyOf));
  const entries = dc.entries.filter((e) => visibleKeys.has(keyOf(e)));
  const stat = steps.slice(0, shown).reduce((a, s) => {
    if (s.kind === "perm") a.checks++;
    if (s.kind === "hit") a.hits++;
    if (s.kind === "negative") a.neg++;
    if (s.kind === "dirread") a.reads++;
    return a;
  }, { checks: 0, hits: 0, neg: 0, reads: 0 });

  return (
    <Demo
      title="A path walk"
      actions={
        <>
          <button className="btn primary" onClick={() => (!run || done ? start() : setShown(steps.length))}>{!run || done ? "Walk" : "Finish"}</button>
          <button className="btn" onClick={() => setShown(Math.min(steps.length, shown + 1))} disabled={!run || done}>Step</button>
          <button className="btn ghost" onClick={() => { dc.clear(); setRun(null); setShown(0); force((x) => x + 1); }}>Drop dcache</button>
        </>
      }
      controls={<>
        <Param spec={W.path} value={P.values.path} onChange={(v) => { P.set("path", v as never); setRun(null); setShown(0); }} />
        <Param spec={W.user} value={P.values.user} onChange={(v) => { P.set("user", v as never); setRun(null); setShown(0); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <div>
          <Heading>Mount tree</Heading>
          <div style={{ fontFamily: MONO, fontSize: 11.5, lineHeight: 1.45, border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px", maxHeight: 280, overflowY: "auto" }}>
            <div style={{ fontWeight: cur?.at === "/" ? 700 : 400, color: cur?.at === "/" ? "var(--c2)" : undefined }}>/ <span className="muted">ext4</span></div>
            {lines.map((l) => {
              const on = cur?.at === l.path;
              return (
                <div key={l.path} style={{ paddingLeft: 10 + l.depth * 12, color: on ? "var(--c2)" : undefined, fontWeight: on ? 700 : 400 }}>
                  {l.label} {l.hiddenBy && <span style={{ color: "var(--c1)" }}>[mount: {l.hiddenBy}]</span>}
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <Heading>Dcache: {entries.length} entries</Heading>
          <div style={{ fontFamily: MONO, fontSize: 11.5, lineHeight: 1.45, border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px", minHeight: 60, maxHeight: 280, overflowY: "auto" }}>
            {entries.length === 0 && <div className="muted">Empty. The first walk fills it.</div>}
            {entries.map((e) => {
              const hot = !!cur && (cur.kind === "hit" || cur.kind === "negative" || cur.kind === "dirread") && cur.component === e.name;
              return (
                <div key={keyOf(e)} style={{ color: e.node ? (hot ? "var(--c3)" : undefined) : "var(--c2)", fontWeight: hot ? 700 : 400 }}>
                  ({nodeName.get(e.parent) ?? e.parent}, {e.name}) {e.node ? "" : "negative"}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <Heading>Steps{cur ? `: mode ${cur.mode === "rcu" ? "RCU-walk" : "ref-walk"}` : ""}</Heading>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minHeight: 22 }}>
          {steps.slice(0, shown).map((s, i) => (
            <button key={i} onClick={() => setShown(i + 1)} title={s.say} style={{ fontSize: 11, fontFamily: MONO, cursor: "pointer", border: `1px solid ${STEP_COLOR[s.kind]}`, color: i === shown - 1 ? "var(--bg)" : STEP_COLOR[s.kind], background: i === shown - 1 ? STEP_COLOR[s.kind] : "transparent", borderRadius: 3, padding: "0 4px" }}>
              {s.component.length > 8 ? `${s.component.slice(0, 7)}…` : s.component} {STEP_NAME[s.kind]}
            </button>
          ))}
        </div>
      </div>
      <Banner tone={cur?.kind === "error" ? "bad" : cur?.kind === "done" ? "good" : "plain"}>{cur ? cur.say : `Press Walk to look up ${P.values.path} as ${cred.name}.`}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "permission checks", value: stat.checks },
          { label: "dcache hits", value: stat.hits },
          { label: "negative hits", value: stat.neg },
          { label: "file system lookups", value: stat.reads },
          { label: "symlinks followed", value: run && done ? run.res.links : "…" },
          { label: "result", value: run && done ? (run.res.error ?? "found") : "…" },
        ]} />
      </div>
      <Note>Press Walk twice for the same path, and compare. The second walk stays in RCU-walk and asks no file system.</Note>
      {!done && run && <div className="row" style={{ marginTop: 6 }}><button className="btn" style={smallBtn} onClick={() => setShown(Math.max(1, shown - 1))}>Back one step</button></div>}
    </Demo>
  );
}

// ---------------------------------------------------------------- the cost plot

const C = {
  depth: range({ label: "Path depth", min: 1, max: 16, step: 1, default: 5, format: (v) => `${v} components` }),
  hit: range({ label: "Dcache hit rate", min: 0, max: 1, step: 0.01, default: 0.99, format: (v) => pct(v, 0) }),
  miss: range({ label: "Directory block miss rate (model input)", min: 0, max: 0.2, step: 0.005, default: STAT_COST_INPUTS.blockMissRate, format: (v) => pct(v, 1) }),
  device: select({ label: "Device", segmented: true, options: [{ value: "nvme", label: "NVMe SSD" }, { value: "hdd", label: "7,200 rpm disk" }], default: "nvme" }),
};

const DEPTHS = Array.from({ length: 16 }, (_, i) => i + 1);
const RATES = Array.from({ length: 51 }, (_, i) => i / 50);
const fmtNs = (ns: number) => si(ns * 1e-9, "s", 3);

export function FsStatCostDemo() {
  const P = useParams("os-fs-stat", C);
  const { depth, hit, miss } = P.values;
  const device = P.values.device as StatDevice;
  const opts = { blockMissRate: miss, device };
  const r = statCost({ depth, hitRate: hit, ...opts });
  const byDepth = DEPTHS.map((d) => ({ d, ...statCost({ depth: d, hitRate: hit, ...opts }) }));
  const byRate = RATES.map((h) => ({ h, ...statCost({ depth, hitRate: h, ...opts }) }));
  const maxD = Math.max(...byDepth.map((x) => x.without));
  const maxR = byRate[0]!.without;
  const yTicks = (top: number) => [100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8].filter((t) => t <= top * 1.3);
  return (
    <Demo title="The cost of stat, with and without the dcache" controls={<>
      <Param spec={C.depth} value={depth} onChange={(v) => P.set("depth", v as number)} />
      <Param spec={C.hit} value={hit} onChange={(v) => P.set("hit", v as number)} />
      <Param spec={C.miss} value={miss} onChange={(v) => P.set("miss", v as number)} />
      <Param spec={C.device} value={device} onChange={(v) => P.set("device", v as never)} />
    </>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <div>
          <Heading>Against depth, at this hit rate</Heading>
          <Plot x={[1, 16]} y={[100, maxD * 1.3]} logY height={210} xLabel="components" yLabel="ns per stat" yTicks={yTicks(maxD)} yFormat={(v) => si(v, "", 2).replace(" ", "")} xTicks={[1, 4, 8, 12, 16]}>
            <Line points={byDepth.map((x) => [x.d, x.without])} color="var(--c4)" />
            <Line points={byDepth.map((x) => [x.d, x.withDcache])} color="var(--c3)" />
            <RuleX at={depth} />
            <Dots points={[[depth, r.withDcache]]} color="var(--c3)" />
            <Dots points={[[depth, r.without]]} color="var(--c4)" />
          </Plot>
        </div>
        <div>
          <Heading>Against hit rate, at this depth</Heading>
          <Plot x={[0, 1]} y={[100, maxR * 1.3]} logY height={210} xLabel="hit rate" yLabel="ns per stat" yTicks={yTicks(maxR)} yFormat={(v) => si(v, "", 2).replace(" ", "")} xFormat={(v) => `${Math.round(v * 100)}%`} xTicks={[0, 0.25, 0.5, 0.75, 1]}>
            <Line points={byRate.map((x) => [x.h, x.without])} color="var(--c4)" />
            <Line points={byRate.map((x) => [x.h, x.withDcache])} color="var(--c3)" />
            <RuleX at={hit} />
          </Plot>
        </div>
      </div>
      <Legend items={[{ label: "with dcache", color: "var(--c3)" }, { label: "no dcache: every component searches the directory", color: "var(--c4)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "with dcache", value: fmtNs(r.withDcache) },
          { label: "without", value: fmtNs(r.without) },
          { label: "ratio", value: `${r.ratio.toFixed(1)} times` },
          { label: "stat calls per second, one core", value: si(statsPerSecond(r.withDcache), "", 3) },
        ]} />
      </div>
      <Note>Model inputs, not measurements: system call {STAT_COST_INPUTS.syscallNs} ns; dcache hit {STAT_COST_INPUTS.hitNs} ns per component; directory search in cached blocks {STAT_COST_INPUTS.searchNs} ns; device read {fmtNs(deviceReadNs(device))} from the disk models of the databases track.</Note>
    </Demo>
  );
}
