/** Demos for the lesson on GPU architecture. */
import { useMemo } from "react";
import {
  Banner, Canvas2D, Controls, Demo, Dots, Legend, Line, Meter, MiniTable, Note, Plot, RuleX, SmallLabel, Stats, cssVar, fixed, int, mono, pct, range, seg, tint, useParams,
} from "../../kit";
import {
  A100, H100, bankConflicts, bankWords, coalesce, issueSim, issueUtilization, occupancy, warpAddresses, warpsNeeded, type AccessPattern, type Limiter,
} from "../../sims/arch/parallel";

// ---------------------------------------------------------------- occupancy

const BLOCK_COLORS = ["var(--c1)", "var(--c3)", "var(--c5)", "var(--c2)"];

export function ArchParOccupancyDemo() {
  const p = useParams("parocc", {
    threads: range({ label: "Threads per block", min: 32, max: 1024, step: 32, default: 256 }),
    regs: range({ label: "Registers per thread", min: 16, max: 255, step: 1, default: 64 }),
    smem: range({ label: "Shared memory per block (KB)", min: 0, max: 163, step: 1, default: 0 }),
    gpu: seg<"a100" | "h100">("GPU", [["a100", "A100 (CC 8.0)"], ["h100", "H100 (CC 9.0)"]], "a100"),
  });
  const L = p.values.gpu === "a100" ? A100 : H100;
  const o = occupancy(L, p.values.threads, p.values.regs, p.values.smem * 1024);
  const rows: [Limiter, string][] = [["warps", `64 warp slots ÷ ${o.warpsPerBlock} warps`], ["blocks", "32 blocks per SM"], ["registers", `65,536 ÷ (${int(o.regsPerWarp)} per warp × ${o.warpsPerBlock})`], ["shared memory", `${L.smemPerSm / 1024} KB ÷ ${fixed(o.smemPerBlockAlloc / 1024, 1)} KB`]];
  return (
    <Demo title="Occupancy: how many warps fit on one SM" controls={<Controls params={p} />}>
      <SmallLabel>The 64 warp slots of one SM. Each color is one resident block.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(16, minmax(0, 1fr))", gap: 3, maxWidth: 520 }}>
        {Array.from({ length: L.maxWarps }, (_, w) => {
          const used = w < o.warps;
          const b = Math.floor(w / Math.max(1, o.warpsPerBlock));
          return <div key={w} title={used ? `block ${b}` : "empty"} style={{ height: 18, borderRadius: 3, background: used ? BLOCK_COLORS[b % 4] : "var(--subtle)", border: "1px solid var(--border)", opacity: used ? 0.85 : 1 }} />;
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0 16px", marginTop: 12 }}>
        <Meter label="register file (256 KB)" value={o.regsUsed} max={L.regsPerSm} color="var(--c1)" text={pct(o.regsUsed / L.regsPerSm, 0)} />
        <Meter label={`shared memory (${L.smemPerSm / 1024} KB)`} value={o.smemUsed} max={L.smemPerSm} color="var(--c2)" text={pct(o.smemUsed / L.smemPerSm, 0)} />
      </div>
      {o.ok ? (
        <MiniTable head={["limit", "how", "blocks"]} rows={rows.map(([k, how]) => [k, how, o.limits[k]])} highlight={(i) => rows[i]![0] === o.limiter} />
      ) : <Banner tone="bad">This launch fails: {o.error}.</Banner>}
      <Stats items={[
        { label: "resident blocks", value: o.blocks },
        { label: "resident warps", value: `${o.warps} of ${L.maxWarps}` },
        { label: "occupancy", value: pct(o.occupancy, 0) },
        { label: "limited by", value: o.ok ? o.limiter : "–" },
      ]} />
      <Note>Registers go to each warp in units of 256 and shared memory to each block in units of 128 bytes, plus 1 KB that the driver reserves per block. These rounding rules come from NVIDIA's occupancy calculator.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- latency hiding

const KEEP = 480;
const W_PTS = Array.from({ length: 16 }, (_, i) => i + 1);

export function ArchParLatencyDemo() {
  const p = useParams("parlat", {
    warps: range({ label: "Warps on this scheduler", min: 1, max: 16, step: 1, default: 4 }),
    compute: range({ label: "Instructions per load", min: 1, max: 40, step: 1, default: 4 }),
    loads: range({ label: "Independent loads per warp", min: 1, max: 8, step: 1, default: 1 }),
    latency: range({ label: "Memory latency (cycles, model input)", min: 20, max: 800, step: 10, default: 200 }),
  });
  const { warps, compute, loads, latency } = p.values;
  const run = useMemo(() => issueSim(warps, compute, latency, loads, 6000, KEEP), [warps, compute, latency, loads]);
  const curve = W_PTS.map((w) => [w, issueUtilization(w, compute, latency, loads)] as const);
  const need = warpsNeeded(compute, latency, loads);
  const rowH = Math.max(6, Math.min(14, Math.floor(180 / warps)));
  return (
    <Demo title="Latency hiding: one scheduler, many warps" controls={<Controls params={p} />}>
      <SmallLabel>The first {KEEP} cycles. One row per warp.</SmallLabel>
      <Canvas2D
        height={warps * rowH + 18}
        deps={[run, rowH]}
        draw={(ctx, w) => {
          const cw = w / KEEP;
          const col = { issue: cssVar("--c3"), memory: cssVar("--border"), ready: cssVar("--c2"), done: cssVar("--subtle") };
          run.grid.forEach((row, k) => row.forEach((s, t) => {
            ctx.fillStyle = col[s];
            ctx.fillRect(t * cw, k * rowH, Math.max(1, cw), rowH - 1);
          }));
          ctx.fillStyle = cssVar("--muted");
          ctx.font = "10px ui-monospace, monospace";
          for (let t = 0; t <= KEEP; t += 100) { ctx.fillRect(t * cw, warps * rowH + 1, 1, 4); ctx.fillText(String(t), Math.min(w - 22, t * cw + 2), warps * rowH + 14); }
        }}
      />
      <Legend items={[{ label: "issues an instruction", color: "var(--c3)" }, { label: "ready, but another warp issues", color: "var(--c2)" }, { label: "grey: waits for memory", color: "var(--border)" }]} />
      <Plot x={[1, 16]} y={[0, 1.05]} height={170} xLabel="warps on the scheduler" yLabel="issue slots used" yFormat={(v) => pct(v, 0)} xTicks={[1, 4, 8, 12, 16]}>
        <Line points={curve} color="var(--c1)" />
        {need <= 16 && <RuleX at={need} label={`${need} warps`} />}
        <Dots points={[[warps, run.utilization]]} color="var(--c4)" r={5} />
      </Plot>
      <Stats items={[
        { label: "issue slots used (simulated)", value: pct(run.utilization, 0) },
        { label: "warps needed (Little's law)", value: need },
        { label: "loads in flight per warp", value: loads },
      ]} />
      <Banner tone={run.utilization > 0.97 ? "good" : "warn"}>{run.utilization > 0.97 ? "Enough warps: some warp is always ready, so the scheduler never idles." : need > 16 ? `This needs ${need} warps, but an A100 scheduler holds at most 16. Add independent loads per warp, or do more work per load.` : `Add warps: the scheduler idles while every warp waits for memory.`}</Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- coalescing

const PATTERNS: [AccessPattern, string][] = [["stride", "a[i × s]"], ["offset", "a[i + k]"], ["aos", "struct field"], ["random", "a[idx[i]]"], ["same", "a[0]"]];

export function ArchParCoalesceDemo() {
  const p = useParams("parcoal", {
    param: range({ label: "Stride s, offset k + 1, or struct words", min: 1, max: 32, step: 1, default: 1 }),
    pattern: seg<AccessPattern>("Each thread i reads", PATTERNS, "stride"),
    size: seg<"4" | "8" | "16">("Bytes per thread", [["4", "4 (float)"], ["8", "8 (float2)"], ["16", "16 (float4)"]], "4"),
  });
  const size = Number(p.values.size);
  const pat = p.values.pattern;
  const param = pat === "offset" ? p.values.param * 4 - 4 : pat === "aos" ? Math.max(size, p.values.param * 4) : p.values.param;
  const addrs = warpAddresses(pat, param, size);
  const c = coalesce(addrs, size);
  const secIndex = new Map(c.sectors.map((s, i) => [s, i]));
  const used = c.sectors.map((s) => { const b = new Set<number>(); addrs.forEach((a) => { for (let x = a; x < a + size; x++) if (Math.floor(x / 32) === s) b.add(x); }); return b.size; });
  const W = 640, top = 14, bot = 120, n = c.sectors.length;
  const boxW = Math.min(36, (W - 10) / Math.max(n, 1) - 3);
  const sx = (k: number) => 5 + k * (boxW + 3) + (W - 10 - n * (boxW + 3)) / 2;
  const tx = (i: number) => 10 + (i * (W - 20)) / 31;
  const desc = pat === "offset" ? `a[i + ${param / 4}]: start ${param} bytes into a sector` : pat === "stride" ? `a[i × ${param}]` : pat === "aos" ? `one ${size}-byte field of a ${param}-byte struct` : PATTERNS.find((x) => x[0] === pat)![1];
  return (
    <Demo title="Coalescing: 32 threads, how many 32-byte sectors?" controls={<Controls params={p} />}>
      <div style={{ fontSize: 12.5, marginBottom: 4, ...mono }}>{desc}</div>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} 170`} style={{ width: "100%", minWidth: 340, display: "block" }}>
          <text x={4} y={10} style={{ fill: "var(--muted)", fontSize: 11 }}>threads 0 … 31</text>
          {addrs.map((a, i) => {
            const k = secIndex.get(Math.floor(a / 32))!;
            return <line key={i} x1={tx(i)} y1={top + 8} x2={sx(k) + boxW / 2} y2={bot} stroke="var(--faint)" strokeWidth={0.8} />;
          })}
          {addrs.map((_, i) => <circle key={i} cx={tx(i)} cy={top + 8} r={4} fill="var(--c1)" />)}
          {c.sectors.map((s, k) => (
            <g key={s}>
              <rect x={sx(k)} y={bot} width={boxW} height={28} rx={3} fill="var(--subtle)" stroke="var(--border)" />
              <rect x={sx(k)} y={bot + 28 - (28 * used[k]!) / 32} width={boxW} height={(28 * used[k]!) / 32} rx={2} fill={tint("var(--c3)", 70)} />
              {k > 0 && s !== c.sectors[k - 1]! + 1 && <line x1={sx(k) - 1.5} x2={sx(k) - 1.5} y1={bot - 4} y2={bot + 32} stroke="var(--c4)" strokeDasharray="2 2" />}
            </g>
          ))}
          <text x={4} y={164} style={{ fill: "var(--muted)", fontSize: 11 }}>sectors the memory system moves (green: bytes a thread asked for; red line: a gap in the addresses)</text>
        </svg>
      </div>
      <Stats items={[
        { label: "32-byte sectors", value: n },
        { label: "128-byte lines", value: c.lines.length },
        { label: "bytes moved", value: c.moved },
        { label: "bytes used", value: pct(c.efficiency, 0) },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- shared memory banks

export function ArchParBankDemo() {
  const p = useParams("parbank", {
    stride: range({ label: "Stride s in 32-bit words", min: 1, max: 64, step: 1, default: 1 }),
    mode: seg<"stride" | "same">("Thread i reads", [["stride", "word i × s"], ["same", "word 0 (all threads)"]], "stride"),
  });
  const words = bankWords(p.values.mode, p.values.stride);
  const r = bankConflicts(words);
  const passes = r.perBank.map((ws) => [...new Set(ws)]);
  const cell = 15;
  return (
    <Demo title="Shared memory: 32 banks, one word each per cycle" controls={<Controls params={p} />}>
      <SmallLabel>Columns are the 32 banks. Each row is one cycle the bank needs. A number is the thread that gets the word.</SmallLabel>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(32, ${cell}px)`, gap: 1, width: "max-content" }}>
          {Array.from({ length: 32 }, (_, b) => <div key={b} style={{ fontSize: 9, textAlign: "center", color: "var(--muted)", ...mono }}>{b}</div>)}
          {Array.from({ length: Math.min(r.degree, 32) }, (_, row) =>
            Array.from({ length: 32 }, (_, b) => {
              const w = passes[b]![row];
              const threads = w === undefined ? [] : words.map((x, i) => (x === w ? i : -1)).filter((i) => i >= 0);
              return (
                <div key={`${row}-${b}`} title={w === undefined ? "" : `word ${w}: threads ${threads.join(", ")}`} style={{ height: cell, borderRadius: 2, fontSize: 8.5, lineHeight: `${cell}px`, textAlign: "center", color: "var(--bg)", background: w === undefined ? "var(--subtle)" : row === 0 ? "var(--c3)" : "var(--c4)", ...mono }}>
                  {threads.length === 1 ? threads[0] : threads.length > 1 ? "all" : ""}
                </div>
              );
            }),
          )}
        </div>
      </div>
      <Stats items={[
        { label: "cycles for this access", value: r.degree },
        { label: "conflict degree gcd(s, 32)", value: `${r.degree}-way` },
        { label: "bandwidth used", value: pct(1 / r.degree, 0) },
      ]} />
      <Banner tone={r.degree === 1 ? "good" : "bad"}>{r.degree === 1 ? (p.values.mode === "same" ? "One word for all threads is a broadcast: one cycle." : "Every thread hits a different bank: one cycle.") : `${r.degree} threads need different words from the same bank, so the access takes ${r.degree} cycles.`}</Banner>
      <Note>A column read of <code>float tile[32][32]</code> is stride 32: a 32-way conflict. Declare <code>tile[32][33]</code> and the stride becomes 33, which hits all 32 banks.</Note>
    </Demo>
  );
}
