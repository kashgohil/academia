/** Demos for "log-structured and copy-on-write file systems": an LFS with a cleaner, and a COW snapshot stepper. */
import { useMemo, useRef, useState } from "react";
import { Canvas2D, Demo, Dots, Legend, Line, Param, Plot, RuleX, SimButtons, Stats, cssVar, pct, range, select, useParams, useSim } from "../../kit";
import { FFS_WRITE_COST, HOT_COLD, LFS_GEOMETRY, LFS_UTILS, Lfs, POLICY_NAME, lfsStream, runLfs, writeCostFormula, type CleanPolicy, type LfsWorkload } from "../../sims/os/fs/lfs";
import { CowTree, type UpdateResult } from "../../sims/os/fs/cowtree";
import { Banner, Heading, MONO, Note, smallBtn, useChunked } from "./FsUi";

const L = {
  util: range({ label: "Disk utilization", min: 0.2, max: 0.8, step: 0.05, default: 0.7, format: (v) => pct(v, 0) }),
  workload: select({ label: "Workload", segmented: true, options: [{ value: "uniform", label: "Uniform" }, { value: "hotcold", label: "Hot and cold" }], default: "hotcold" }),
  policy: select({ label: "Cleaner", segmented: true, options: [{ value: "greedy", label: "Greedy" }, { value: "cost-benefit", label: "Cost-benefit" }], default: "greedy" }),
};

const SEGS = 24, BPS = 32;
const SERIES: { w: LfsWorkload; p: CleanPolicy; color: string; label: string }[] = [
  { w: "uniform", p: "greedy", color: "var(--c1)", label: "uniform, greedy" },
  { w: "hotcold", p: "greedy", color: "var(--c2)", label: "hot and cold, greedy" },
  { w: "hotcold", p: "cost-benefit", color: "var(--c3)", label: "hot and cold, cost-benefit" },
];

function makeLive(util: number, workload: LfsWorkload, policy: CleanPolicy) {
  const logical = Math.floor(util * SEGS * BPS);
  const fs = new Lfs({ segments: SEGS, blocksPerSegment: BPS, logical, policy, lowWater: 2, highWater: 3, ageSort: true });
  for (let l = 0; l < logical; l++) fs.write(l);
  const next = lfsStream({ logical, workload, seed: 5 });
  for (let i = 0; i < logical * 2; i++) fs.write(next());
  fs.resetStats();
  return { fs, next, hot: Math.floor(logical * HOT_COLD.hotFraction) };
}

export function FsLfsDemo() {
  const P = useParams("os-fs-lfs", L);
  const util = P.values.util;
  const workload = P.values.workload as LfsWorkload;
  const policy = P.values.policy as CleanPolicy;
  const key = `${util}/${workload}/${policy}`;
  const ref = useRef<{ key: string; live: ReturnType<typeof makeLive> } | null>(null);
  if (!ref.current || ref.current.key !== key) ref.current = { key, live: makeLive(util, workload, policy) };
  const [tick, setTick] = useState(0);
  const sim = useSim({
    step: () => {
      const { fs, next } = ref.current!.live;
      for (let i = 0; i < 12; i++) fs.write(next());
      setTick((t) => t + 1);
    },
    reset: () => { ref.current = { key, live: makeLive(util, workload, policy) }; setTick(0); },
    dt: 1 / 20,
    speed: 1,
  });
  const { fs, hot } = ref.current.live;

  const tasks = useMemo(() => SERIES.flatMap((s) => LFS_UTILS.map((u) => () => runLfs({ util: u, workload: s.w, policy: s.p }))), []);
  const { results } = useChunked(tasks, "lfs-sweep");
  const line = (i: number) => LFS_UTILS.flatMap((u, j) => { const r = results[i * LFS_UTILS.length + j]; return r ? [[u, r.writeCost] as [number, number]] : []; });

  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const cols = SEGS, cw = w / cols, ch = h / BPS;
    const hotC = cssVar("--c2"), coldC = cssVar("--c1"), dead = cssVar("--border"), head = cssVar("--fg"), clean = cssVar("--c4");
    for (let s = 0; s < SEGS; s++) {
      for (let b = 0; b < BPS; b++) {
        const l = fs.slots[s * BPS + b]!;
        const written = !fs.isFree[s] && (s !== fs.head || b < fs.headSlot);
        if (l >= 0) ctx.fillStyle = workload === "hotcold" && l < hot ? hotC : coldC;
        else ctx.fillStyle = written ? dead : "transparent";
        ctx.globalAlpha = l >= 0 ? 0.85 : 1;
        ctx.fillRect(s * cw + 1, b * ch + 0.5, cw - 2, ch - 1);
      }
      ctx.globalAlpha = 1;
      if (s === fs.head) { ctx.strokeStyle = head; ctx.lineWidth = 1.5; ctx.strokeRect(s * cw + 0.75, 0.75, cw - 1.5, h - 1.5); }
      else if (fs.lastCleaned.includes(s)) { ctx.strokeStyle = clean; ctx.lineWidth = 1; ctx.strokeRect(s * cw + 0.75, 0.75, cw - 1.5, h - 1.5); }
    }
  };

  const liveSum = Array.from(fs.live).reduce((a, b) => a + b, 0);
  const s = fs.stats;
  return (
    <Demo title="A log with a cleaner" actions={<SimButtons sim={sim} />} controls={<>
      <Param spec={L.util} value={util} onChange={(v) => P.set("util", v as number)} />
      <Param spec={L.workload} value={workload} onChange={(v) => P.set("workload", v as never)} />
      <Param spec={L.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
    </>}>
      <Heading>Each column is a segment. A bold outline is the log head. A red outline is a segment that the cleaner just freed.</Heading>
      <Canvas2D height={170} draw={draw} deps={[tick, key]} />
      <div className="legend" style={{ marginTop: 4 }}>
        <span style={{ ["--swatch" as string]: "var(--c1)" }}>live{workload === "hotcold" ? ", cold" : ""}</span>
        {workload === "hotcold" && <span style={{ ["--swatch" as string]: "var(--c2)" }}>live, hot</span>}
        <span style={{ ["--swatch" as string]: "var(--border)" }}>dead</span>
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "user writes", value: s.newBlocks },
          { label: "cleaner copies", value: s.copied },
          { label: "write cost now", value: fs.writeCost().toFixed(2) },
          { label: "mean u of cleaned segments", value: s.cleaned ? (s.cleanedUtilSum / s.cleaned).toFixed(2) : "…" },
          { label: "free segments", value: fs.freeCount },
          { label: "live share of the disk", value: pct(liveSum / (SEGS * BPS), 0) },
        ]} />
      </div>
      <div style={{ marginTop: 12 }}>
        <Heading>Write cost against disk utilization: steady state on {LFS_GEOMETRY.segments} segments of {LFS_GEOMETRY.blocksPerSegment} blocks</Heading>
        <Plot x={[0.2, 0.9]} y={[0, 22]} height={230} xLabel="disk utilization" yLabel="write cost" xFormat={(v) => `${Math.round(v * 100)}%`} xTicks={[0.2, 0.4, 0.6, 0.8]} yTicks={[0, 4, 10, 20]}>
          <Line points={LFS_UTILS.map((u) => [u, writeCostFormula(u)])} color="var(--faint)" dash="4 3" />
          {SERIES.map((x, i) => <Line key={x.label} points={line(i)} color={x.color} />)}
          {SERIES.map((x, i) => <Dots key={x.label} points={line(i)} color={x.color} r={2.5} />)}
          <RuleX at={util} />
          <Line points={[[0.2, FFS_WRITE_COST.improved], [0.9, FFS_WRITE_COST.improved]]} color="var(--muted)" width={1} dash="2 3" />
        </Plot>
        <Legend items={[...SERIES.map((x) => ({ label: x.label, color: x.color })), { label: "2/(1-u) at the disk's u", color: "var(--faint)" }, { label: "FFS estimate of the paper: 4", color: "var(--muted)" }]} />
      </div>
      <Note>The hot and cold workload sends {pct(HOT_COLD.hotWrites, 0)} of writes to {pct(HOT_COLD.hotFraction, 0)} of the blocks. The live grid uses a smaller disk than the plot, so that you can see each block. Policy now: {POLICY_NAME[policy]}.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- COW stepper

const FANOUT = 2, DEPTH = 3;
const SCRIPT: { label: string; run: (t: CowTree) => string }[] = [
  { label: "Update leaf 2", run: (t) => upd(t, 2, "A") },
  { label: "Snapshot s1", run: (t) => { t.snapshot("live", "s1"); return "A snapshot stores one root pointer and adds one count. It writes no tree block."; } },
  { label: "Update leaf 2", run: (t) => upd(t, 2, "B") },
  { label: "Update leaf 2 again", run: (t) => upd(t, 2, "C") },
  { label: "Update leaf 5", run: (t) => upd(t, 5, "D") },
  { label: "Clone s1 to c1", run: (t) => { t.clone("s1", "c1"); return "A clone is a second writable root at the snapshot's tree. It copies nothing."; } },
  { label: "Delete clone c1", run: (t) => { const f = t.deleteDataset("c1"); return `The clone goes away. Blocks freed: ${f.length}, because s1 still points at the same tree.`; } },
  { label: "Delete snapshot s1", run: (t) => { const f = t.deleteSnapshot("s1"); return `Deleting s1 drops the counts. Blocks that only s1 pinned go back to the free pool: ${f.length}.`; } },
];

function upd(t: CowTree, leaf: number, v: string): string {
  const u: UpdateResult = t.update("live", leaf, v);
  return `The update wrote ${u.copied.length} new blocks, one for each level. It then swung the root pointer. Old blocks freed: ${u.freed.length}.`;
}

interface Placed { id: number; level: number; pos: number; x: number; y: number }

function layout(t: CowTree) {
  // Each block has one logical place: its level and its slot. Versions at that place stack downward.
  const place = new Map<number, { level: number; pos: number }>();
  const roots = [...t.datasets.values(), ...[...t.snapshots.values()].map((s) => s.root)];
  const go = (id: number, level: number, pos: number) => {
    if (place.has(id)) return;
    place.set(id, { level, pos });
    t.blocks.get(id)!.children?.forEach((c, i) => go(c, level + 1, pos * FANOUT + i));
  };
  roots.forEach((r) => go(r, 0, 0));
  const groups = new Map<string, number[]>();
  for (const [id, p] of place) {
    const k = `${p.level}/${p.pos}`;
    groups.set(k, [...(groups.get(k) ?? []), id]);
  }
  const W = 320;
  const heights: number[] = [];
  for (let l = 0; l <= DEPTH; l++) {
    let m = 1;
    for (const [k, ids] of groups) if (k.startsWith(`${l}/`)) m = Math.max(m, ids.length);
    heights.push(m);
  }
  const rowH = 25;
  const levelY: number[] = [];
  let y = 26;
  for (let l = 0; l <= DEPTH; l++) { levelY.push(y); y += heights[l]! * rowH + 14; }
  const out = new Map<number, Placed>();
  for (const [k, ids] of groups) {
    const [lv, ps] = k.split("/").map(Number) as [number, number];
    const span = W / Math.pow(FANOUT, lv);
    ids.sort((a, b) => b - a).forEach((id, i) => {
      out.set(id, { id, level: lv, pos: ps, x: span * (ps + 0.5), y: levelY[lv]! + i * rowH });
    });
  }
  return { nodes: out, H: y, W };
}

export function FsCowDemo() {
  const [t, setT] = useState(() => new CowTree(FANOUT, DEPTH));
  const [step, setStep] = useState(0);
  const [say, setSay] = useState("Press Next step, or click a leaf of the live tree to update it.");
  const [fresh, setFresh] = useState<number[]>([]);
  const [, force] = useState(0);
  const counter = useRef(0);
  const { nodes, H, W } = layout(t);
  const liveRoot = t.datasets.get("live")!;
  const liveSet = t.reachable(liveRoot);
  const otherLive = new Set<number>();
  for (const [n, r] of t.datasets) if (n !== "live") for (const b of t.reachable(r)) otherLive.add(b);
  const sp = t.space();
  const ran = (f: () => string) => {
    const before = new Set(t.blocks.keys());
    setSay(f());
    setFresh([...t.blocks.keys()].filter((k) => !before.has(k)));
    force((x) => x + 1);
  };
  const scrubRes = useRef<string | null>(null);
  const colorOf = (id: number) => (liveSet.has(id) ? "var(--c1)" : otherLive.has(id) ? "var(--c5)" : "var(--c2)");
  const roots = [...t.datasets.entries(), ...[...t.snapshots.entries()].map(([k, s]) => [k, s.root] as [string, number])];

  return (
    <Demo
      title="Copy-on-write: updates, snapshots and space"
      actions={
        <>
          <button className="btn primary" disabled={step >= SCRIPT.length} onClick={() => { ran(() => SCRIPT[step]!.run(t)); setStep(step + 1); }}>{step < SCRIPT.length ? `Next: ${SCRIPT[step]!.label.toLowerCase()}` : "End of tour"}</button>
          <button className="btn ghost" onClick={() => { setT(new CowTree(FANOUT, DEPTH)); setStep(0); setFresh([]); setSay("Reset."); scrubRes.current = null; }}>Reset</button>
        </>
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 560, display: "block" }} role="img" aria-label="a tree of blocks with shared subtrees">
        {[...nodes.values()].flatMap((n) => (t.blocks.get(n.id)!.children ?? []).map((c) => {
          const m = nodes.get(c)!;
          return <line key={`${n.id}-${c}`} x1={n.x} y1={n.y + 8} x2={m.x} y2={m.y - 8} stroke={colorOf(n.id)} strokeWidth={1} opacity={liveSet.has(n.id) ? 0.9 : 0.5} />;
        }))}
        {roots.map(([name, r], i) => {
          const n = nodes.get(r)!;
          const dx = (i - (roots.length - 1) / 2) * 38;
          return (
            <g key={name}>
              <text x={n.x + dx + 52} y={10} fontSize={10.5} textAnchor="middle" fontFamily={MONO} fill={name === "live" ? "var(--c1)" : "var(--c2)"}>{name}</text>
              <line x1={n.x + dx + 52} y1={12} x2={n.x + 14} y2={n.y - 2} stroke={name === "live" ? "var(--c1)" : "var(--c2)"} strokeWidth={1} strokeDasharray={name === "live" ? undefined : "2 2"} />
            </g>
          );
        })}
        {[...nodes.values()].map((n) => {
          const b = t.blocks.get(n.id)!;
          const c = colorOf(n.id);
          const isNew = fresh.includes(n.id);
          const leaf = b.kind === "leaf";
          const w = leaf ? W / 8 - 3 : 34;
          const canClick = leaf && liveSet.has(n.id);
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: canClick ? "pointer" : undefined }} onClick={canClick ? () => {
              const idx = n.pos;
              const v = String.fromCharCode(97 + counter.current++ % 26);
              ran(() => upd(t, idx, v));
            } : undefined}>
              <rect x={-w / 2} y={-8} width={w} height={16} rx={3} fill={isNew ? c : "var(--bg)"} stroke={c} strokeWidth={b.flipped ? 2 : 1.2} strokeDasharray={b.flipped ? "2 1" : undefined} />
              <text textAnchor="middle" y={3.5} fontSize={10} fontFamily={MONO} fill={isNew ? "var(--bg)" : "var(--fg)"}>{leaf ? b.value!.replace("v0.", "") : `#${b.id}`}</text>
              <text x={w / 2} y={-10} textAnchor="end" fontSize={8} fill="var(--muted)">{b.refs > 1 ? `x${b.refs}` : ""}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend" style={{ marginTop: 4 }}>
        <span style={{ ["--swatch" as string]: "var(--c1)" }}>reachable from live</span>
        <span style={{ ["--swatch" as string]: "var(--c5)" }}>reachable from a clone</span>
        <span style={{ ["--swatch" as string]: "var(--c2)" }}>pinned only by a snapshot</span>
      </div>
      <Banner>{say}</Banner>
      <div className="row" style={{ flexWrap: "wrap", gap: 5, marginTop: 8 }}>
        <button className="btn" style={smallBtn} onClick={() => {
          const ids = [...t.blocks.keys()];
          const id = ids[(counter.current * 7 + 3) % ids.length]!;
          counter.current++;
          t.corrupt(id);
          setSay(`A bit flipped in block #${id} on disk. Nothing notices until something reads the block.`);
          force((x) => x + 1);
        }}>Flip a bit</button>
        <button className="btn" style={smallBtn} onClick={() => {
          const r = t.scrub();
          setSay(`Scrub read ${r.checked} blocks and compared each with the checksum in its parent. It found ${r.bad.length} bad. Without a second copy, it can report the damage but cannot repair it.`);
          force((x) => x + 1);
        }}>Scrub</button>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "blocks in use", value: sp.total },
          { label: "reachable from live data", value: sp.live },
          { label: "pinned only by snapshots", value: sp.pinned },
          { label: "blocks written so far", value: t.totalCopied },
          { label: "blocks freed so far", value: t.totalFreed },
        ]} />
      </div>
      <Note>The small xN is the reference count. A filled block is new in the last step. A dashed block has a flipped bit.</Note>
    </Demo>
  );
}
