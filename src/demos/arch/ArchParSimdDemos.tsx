/** Demos for the lesson on SIMD and vector units. */
import { useMemo } from "react";
import {
  Banner, Controls, Demo, Dots, Label, Legend, Line, MiniTable, Note, Plot, RuleX, SectionLabel, SmallLabel, Stats, fixed, mono, pct, range, seg, sig, tint, useParams,
} from "../../kit";
import { KERNELS, MODEL_CPU, intensity, peakGflops, regGroups, ridge, roofline, stripMine, vlmax, vsetvl, type LoopStyle, type VlPolicy } from "../../sims/arch/parallel";

// ---------------------------------------------------------------- strip mining

const LISTING: Record<LoopStyle, (w: number) => string> = {
  "scalar-tail": (w) => {
    const r = w === 128 ? "xmm" : w === 256 ? "ymm" : "zmm";
    const l = Math.min(w, 512) / 32;
    return `; c[i] = a[i] + b[i], ${l} floats per trip
.vec:  vmovups ${r}0, [rsi+rax*4]
       vaddps  ${r}0, ${r}0, [rdx+rax*4]
       vmovups [rdi+rax*4], ${r}0
       add     rax, ${l}
       cmp     rax, r8          ; r8 = n rounded down to ${l}
       jb      .vec
; scalar tail: 1 float per trip
.tail: vmovss  xmm0, [rsi+rax*4]
       vaddss  xmm0, xmm0, [rdx+rax*4]
       vmovss  [rdi+rax*4], xmm0
       inc     rax
       cmp     rax, rcx         ; rcx = n
       jb      .tail`;
  },
  "masked-tail": (w) => {
    const l = Math.min(w, 512) / 32;
    const r = w === 128 ? "xmm" : w === 256 ? "ymm" : "zmm";
    return `; main loop as before, ${l} floats per trip
.vec:  vmovups ${r}0, [rsi+rax*4]
       vaddps  ${r}0, ${r}0, [rdx+rax*4]
       vmovups [rdi+rax*4], ${r}0
       add     rax, ${l}
       cmp     rax, r8
       jb      .vec
; tail: one trip with a mask of (n mod ${l}) ones
       mov     r10d, -1
       bzhi    r10d, r10d, r9d  ; r9 = n mod ${l}
       kmovw   k1, r10d
       vmovups ${r}0{k1}{z}, [rsi+rax*4]
       vaddps  ${r}0{k1}{z}, ${r}0, [rdx+rax*4]
       vmovups [rdi+rax*4]{k1}, ${r}0`;
  },
  sve: () => `// x0 = c, x1 = a, x2 = b, x3 = n. The width is not in the code.
       mov     x4, 0
       whilelo p0.s, x4, x3       // p0 = lanes with x4 + lane < n
loop:  ld1w    {z0.s}, p0/z, [x1, x4, lsl 2]
       ld1w    {z1.s}, p0/z, [x2, x4, lsl 2]
       fadd    z0.s, p0/m, z0.s, z1.s
       st1w    {z0.s}, p0, [x0, x4, lsl 2]
       incw    x4                 // x4 += lanes of this CPU
       whilelo p0.s, x4, x3
       b.first loop               // loop while lane 0 is active`,
  rvv: () => `# a0 = n, a1 = c, a2 = a, a3 = b. The width is not in the code.
loop:  vsetvli  t0, a0, e32, m1, ta, ma   # t0 = vl for this trip
       vle32.v  v0, (a2)
       vle32.v  v1, (a3)
       vfadd.vv v2, v0, v1
       vse32.v  v2, (a1)
       sub      a0, a0, t0
       slli     t0, t0, 2                 # bytes = vl × 4
       add      a2, a2, t0
       add      a3, a3, t0
       add      a1, a1, t0
       bnez     a0, loop`,
};

const KIND_COLOR = { vector: "var(--c1)", masked: "var(--c2)", scalar: "var(--c4)" } as const;
const MAX_ROWS = 60;

export function ArchParStripMineDemo() {
  const p = useParams("parstrip", {
    n: range({ label: "Elements n", min: 1, max: 200, step: 1, default: 100 }),
    style: seg<LoopStyle>("Loop", [["scalar-tail", "Fixed + scalar tail"], ["masked-tail", "Fixed + masked tail"], ["sve", "SVE"], ["rvv", "RVV"]], "sve"),
    width: seg<"128" | "256" | "512" | "1024" | "2048">("Vector width (bits)", [["128", "128"], ["256", "256"], ["512", "512"], ["1024", "1024"], ["2048", "2048"]], "128"),
  });
  const { n, style } = p.values;
  const fixedIsa = style === "scalar-tail" || style === "masked-tail";
  const wanted = Number(p.values.width);
  const width = fixedIsa ? Math.min(512, wanted) : wanted;
  const lanes = width / 32;
  const run = useMemo(() => stripMine(n, lanes, style), [n, lanes, style]);
  const shown = run.trips.slice(0, MAX_ROWS);
  return (
    <Demo title="One loop, many vector widths" controls={<Controls params={p} />}>
      <SmallLabel style={{ marginBottom: 6 }}>Each row is one trip through the loop body. Each cell is one 32-bit lane of the vector unit.</SmallLabel>
      <div style={{ display: "grid", gap: 2, maxHeight: 330, overflowY: "auto", paddingRight: 2 }}>
        {shown.map((t, k) => (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "58px minmax(0, 1fr)", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 10.5, color: "var(--muted)", ...mono }}>{t.kind === "scalar" ? `i=${t.start}` : `vl=${t.active}`}</span>
            <div style={{ display: "flex", gap: lanes > 32 ? 0 : 1, height: 10 }}>
              {Array.from({ length: lanes }, (_, l) => (
                <div key={l} style={{ flex: 1, minWidth: 0, borderRadius: 1, background: l < t.active ? KIND_COLOR[t.kind] : "var(--subtle)", border: l < t.active ? "none" : "1px solid var(--border)" }} />
              ))}
            </div>
          </div>
        ))}
        {run.trips.length > MAX_ROWS && <span className="muted" style={{ fontSize: 11.5 }}>… {run.trips.length - MAX_ROWS} more trips</span>}
      </div>
      <Legend items={[{ label: "full vector trip", color: KIND_COLOR.vector }, { label: "partial trip (mask or vl)", color: KIND_COLOR.masked }, { label: "scalar trip (1 lane)", color: KIND_COLOR.scalar }]} />
      {fixedIsa && wanted > 512 && <Banner tone="warn">x86 registers stop at 512 bits (AVX-512). This loop uses 512.</Banner>}
      <Stats items={[
        { label: "loop trips", value: run.trips.length },
        { label: "vector / scalar trips", value: `${run.vectorTrips} / ${run.scalarTrips}` },
        { label: "instructions (listing below)", value: run.instructions },
        { label: "lane slots used", value: pct(run.utilization, 0) },
      ]} />
      <SectionLabel>The loop body</SectionLabel>
      <pre style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, overflowX: "auto", background: "var(--subtle)", padding: "8px 10px", borderRadius: 6, ...mono }}>{LISTING[style](width)}</pre>
    </Demo>
  );
}

// ---------------------------------------------------------------- RVV register file

const LMUL_OPTS: [string, string][] = [["0.125", "1/8"], ["0.25", "1/4"], ["0.5", "1/2"], ["1", "1"], ["2", "2"], ["4", "4"], ["8", "8"]];
const lmulName = (l: number) => (l < 1 ? `mf${1 / l}` : `m${l}`);

export function ArchParVregDemo() {
  const p = useParams("parvreg", {
    avl: range({ label: "Elements left (AVL)", min: 1, max: 300, step: 1, default: 20 }),
    vlen: seg<"128" | "256" | "512">("VLEN (bits per register)", [["128", "128"], ["256", "256"], ["512", "512"]], "128"),
    sew: seg<"8" | "16" | "32" | "64">("SEW (bits per element)", [["8", "e8"], ["16", "e16"], ["32", "e32"], ["64", "e64"]], "32"),
    lmul: seg<string>("LMUL (registers per group)", LMUL_OPTS, "1"),
    policy: seg<VlPolicy>("vl choice", [["max", "min(AVL, VLMAX)"], ["even", "split the last two trips"]], "max"),
  });
  const vlen = Number(p.values.vlen), sew = Number(p.values.sew), lmul = Number(p.values.lmul), avl = p.values.avl;
  const perReg = vlen / sew;
  const vm = vlmax(vlen, sew, lmul);
  const valid = vm >= 1 && sew <= 64 && (lmul >= 1 || sew <= lmul * 64);
  const vl = valid ? vsetvl(avl, vm, p.values.policy) : 0;
  const groups = regGroups(lmul);
  const base = 8;
  const span = Math.max(1, lmul);
  const trips = useMemo(() => { if (!valid) return [] as number[]; const out: number[] = []; let left = avl; while (left > 0) { const v = vsetvl(left, vm, p.values.policy); out.push(v); left -= v; } return out; }, [avl, vm, valid, p.values.policy]);
  const cellsInGroup = (reg: number) => (reg >= base && reg < base + span ? reg - base : -1);
  return (
    <Demo title="The RVV register file: SEW, LMUL and vl" controls={<Controls params={p} />}>
      <div style={{ fontSize: 13, marginBottom: 8, overflowWrap: "anywhere", ...mono }}>vsetvli t0, a0, e{sew}, {lmulName(lmul)}, ta, ma <span className="muted"># a0 = {avl} → t0 = vl = {vl}</span></div>
      <div style={{ display: "grid", gap: 1 }}>
        {Array.from({ length: 32 }, (_, r) => {
          const g = cellsInGroup(r);
          const groupStart = groups.some((x) => x.base === r);
          const fracCells = lmul < 1 ? Math.round(perReg * lmul) : perReg;
          return (
            <div key={r} style={{ display: "grid", gridTemplateColumns: "34px minmax(0, 1fr)", gap: 6, alignItems: "center", borderTop: groupStart && span > 1 && r > 0 ? "1px solid var(--muted)" : "1px solid transparent", paddingTop: 1 }}>
              <span style={{ fontSize: 10.5, color: g >= 0 ? "var(--fg)" : r === 0 ? "var(--c2)" : "var(--muted)", fontWeight: g >= 0 ? 600 : 400, ...mono }}>v{r}</span>
              <div style={{ display: "flex", gap: perReg > 32 ? 0 : 1, height: 9 }}>
                {Array.from({ length: perReg }, (_, s) => {
                  let bg = "var(--subtle)";
                  if (g >= 0 && valid) {
                    const e = g * perReg + s;
                    if (lmul < 1 && s >= fracCells) bg = "var(--subtle)";
                    else if (e < vl) bg = "var(--c1)";
                    else if (e < vm) bg = tint("var(--c1)", 30);
                  }
                  if (r === 0) bg = s < Math.ceil(vl / sew) ? tint("var(--c2)", 55) : "var(--subtle)";
                  return <div key={s} style={{ flex: 1, minWidth: 0, background: bg, border: "1px solid var(--border)", borderWidth: perReg > 32 ? 0 : 1 }} />;
                })}
              </div>
            </div>
          );
        })}
      </div>
      <Legend items={[{ label: "body: elements 0 … vl−1", color: "var(--c1)" }, { label: "tail: vl … VLMAX−1 (ta: may be overwritten)", color: tint("var(--c1)", 30) }, { label: "v0: the mask, 1 bit per element", color: tint("var(--c2)", 55) }]} />
      {!valid && <Banner tone="bad">Not supported: with a fractional LMUL, SEW must be at most LMUL × ELEN (64 bits here), so that a group holds at least one element.</Banner>}
      <Stats items={[
        { label: "VLMAX = LMUL × VLEN / SEW", value: valid ? vm : "–" },
        { label: "vl of the first trip", value: vl },
        { label: "register groups you can name", value: `${groups.length} (v${groups[0]!.base}${groups.length > 1 ? `, v${groups[1]!.base}` : ""}${groups.length > 2 ? ", …" : ""})` },
        { label: "trips for this AVL", value: valid ? `${trips.length}: ${trips.slice(0, 6).join(", ")}${trips.length > 6 ? ", …" : ""}` : "–" },
      ]} />
      <Note>The group in use starts at v8. A larger LMUL gives longer vectors and fewer trips, but fewer groups for the compiler to allocate.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- roofline

const AI_RANGE: [number, number] = [1 / 16, 256];
const AI_PTS = Array.from({ length: 97 }, (_, i) => AI_RANGE[0] * (AI_RANGE[1] / AI_RANGE[0]) ** (i / 96));
const WIDTHS = [["4", "SSE / NEON (4 lanes)"], ["8", "AVX2 (8 lanes)"], ["16", "AVX-512 (16 lanes)"]] as [string, string][];
const fmtAi = (v: number) => (v >= 1 ? String(Math.round(v)) : `1/${Math.round(1 / v)}`);

export function ArchParRooflineDemo() {
  const p = useParams("parroof", {
    ai: range({ label: "Your kernel: FLOP per byte", min: 1 / 16, max: 256, default: 1 / 12, log: true, format: (v) => fixed(v, v < 1 ? 3 : 1) }),
    lanes: seg<"4" | "8" | "16">("fp32 lanes per FMA unit", WIDTHS as [("4" | "8" | "16"), string][], "8"),
    bw: range({ label: "DRAM bandwidth (GB/s, model input)", min: 10, max: 400, default: 50, log: true, format: (v) => `${Math.round(v)} GB/s` }),
  });
  const m = { ...MODEL_CPU, lanes: Number(p.values.lanes), bandwidth: p.values.bw };
  const peak = peakGflops(m), r = ridge(m), att = roofline(m, p.values.ai);
  const others = [4, 8, 16].filter((l) => l !== m.lanes).map((l) => ({ ...m, lanes: l }));
  return (
    <Demo title="The roofline: when do wider lanes help?" controls={<Controls params={p} />}>
      <Plot x={AI_RANGE} y={[1, 3000]} logX logY height={280} xLabel="FLOP per byte of DRAM traffic" yLabel="GFLOP/s" xTicks={[1 / 16, 1 / 4, 1, 4, 16, 64, 256]} yTicks={[1, 10, 100, 1000]} xFormat={fmtAi} yFormat={(v) => sig(v, 2)}>
        {others.map((o) => <Line key={o.lanes} points={AI_PTS.map((x) => [x, roofline(o, x)] as const)} color="var(--faint)" width={1.2} dash="4 3" />)}
        <Line points={AI_PTS.map((x) => [x, roofline(m, x)] as const)} color="var(--c1)" width={2.5} />
        <RuleX at={r} label={`ridge ${fixed(r, 1)}`} />
        <Dots points={KERNELS.map((k) => [intensity(k), roofline(m, intensity(k))] as const)} color="var(--c3)" r={4} />
        {KERNELS.map((k) => <Label key={k.id} at={[intensity(k) * 1.12, roofline(m, intensity(k)) * 0.62]}>{k.id}</Label>)}
        <Dots points={[[p.values.ai, att]]} color="var(--c4)" r={6} />
      </Plot>
      <Legend items={[{ label: `roof with ${m.lanes} lanes`, color: "var(--c1)" }, { label: "the other widths", color: "var(--faint)" }, { label: "kernels", color: "var(--c3)" }, { label: "your kernel", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "peak: 8 cores × 3 GHz × 2 FMA × lanes × 2", value: `${sig(peak, 4)} GFLOP/s` },
        { label: "ridge point", value: `${fixed(r, 1)} FLOP/B` },
        { label: "your kernel", value: `${sig(att, 3)} GFLOP/s` },
        { label: "share of peak", value: pct(att / peak, att / peak < 0.1 ? 1 : 0) },
      ]} />
      <Banner tone={p.values.ai < r ? "warn" : "good"}>{p.values.ai < r ? `Memory bound: this kernel waits for DRAM. More lanes do not change ${sig(att, 3)} GFLOP/s.` : "Compute bound: the lanes are the limit. Wider vectors raise this kernel's speed."}</Banner>
      <SectionLabel>Kernels (fp32, ideal caching)</SectionLabel>
      <MiniTable
        head={["kernel", "FLOP/B", "GFLOP/s", "of peak"]}
        rows={KERNELS.map((k) => { const a = roofline(m, intensity(k)); return [k.label, intensity(k) < 1 ? fixed(intensity(k), 3) : fixed(intensity(k), 0), sig(a, 3), pct(a / peak, a / peak < 0.1 ? 1 : 0)]; })}
      />
    </Demo>
  );
}
