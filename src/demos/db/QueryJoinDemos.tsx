/** Demos for the join algorithms lesson: a join stepper, an I/O cost plot, and Grace / hybrid hash partitioning. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, Plot, Line, RuleX, Legend, range, select, toggle, si, BAD, GOOD, MONO, Note, StepButtons, StepCaption, StepSlider, int, useStepper } from "../../kit";
import {
  paged, nestedLoopJoin, blockNlj, indexNlj, sortMergeJoin, hashJoin, graceHashJoin, hybridHashJoin, hash32, joinCost, hybridPlan,
  uniformKeys, zipfKeys, type JoinEvent, type JoinResult, type JTuple, type JoinAlgo, type PagedRel,
} from "../../sims/db/query/joins";
import { ACC, ALT, WARM } from "./QueryUi";

// ============================================================================ 1. stepper

const R_KEYS = [3, 7, 1, 5, 7, 2];
const S_KEYS = [5, 1, 7, 4, 3, 7, 6, 1];
const BUCKETS = 4;

type StepAlgo = "nlj" | "bnlj" | "inlj" | "smj" | "hash";
const STEP_ALGOS: { value: StepAlgo; label: string }[] = [
  { value: "nlj", label: "nested loop" },
  { value: "bnlj", label: "block NL" },
  { value: "inlj", label: "index NL" },
  { value: "smj", label: "sort-merge" },
  { value: "hash", label: "hash" },
];

function TupleBox({ t, state }: { t: JTuple; state: "cur" | "match" | "mem" | "none" | "faint" }) {
  const col = state === "cur" ? ACC : state === "match" ? GOOD : "var(--border)";
  return (
    <span style={{
      display: "inline-flex", flexDirection: "column", alignItems: "center", minWidth: 30, padding: "1px 3px", borderRadius: 4, fontFamily: MONO, fontSize: 11,
      border: `1.5px solid ${col}`, background: state === "cur" || state === "match" ? col : "var(--bg)", color: state === "cur" || state === "match" ? "var(--bg)" : "var(--fg)",
      opacity: state === "faint" ? 0.4 : 1, transition: "background 0.15s",
    }}>
      <b style={{ fontSize: 12 }}>{t.k}</b><span style={{ fontSize: 9.5, opacity: 0.8 }}>{t.id}</span>
    </span>
  );
}

function PageRow({ rel, order, curIds, matchIds, memPages, readPages, label }: { rel: PagedRel; order?: string[]; curIds: Set<string>; matchIds: Set<string>; memPages: Set<number>; readPages: Set<number>; label: string }) {
  const byId = new Map(rel.pages.flat().map((t) => [t.id, t]));
  const pages = order ? (() => { const ts = order.map((id) => byId.get(id)!); const out: JTuple[][] = []; for (let i = 0; i < ts.length; i += rel.tpp) out.push(ts.slice(i, i + rel.tpp)); return out; })() : rel.pages;
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {pages.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 3, padding: 3, borderRadius: 5, border: `1.5px ${memPages.has(i) ? "solid" : "dashed"} ${memPages.has(i) ? WARM : "var(--border)"}`, background: memPages.has(i) ? "var(--subtle)" : undefined, position: "relative" }}>
            {p.map((t) => <TupleBox key={t.id} t={t} state={curIds.has(t.id) ? "cur" : matchIds.has(t.id) ? "match" : "none"} />)}
            {readPages.has(i) && <span style={{ position: "absolute", top: -7, right: -5, fontSize: 9, background: WARM, color: "var(--bg)", borderRadius: 6, padding: "0 4px" }}>read</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function runStepAlgo(a: StepAlgo, R: PagedRel, S: PagedRel, B: number): JoinResult {
  switch (a) {
    case "nlj": return nestedLoopJoin(R, S, true);
    case "bnlj": return blockNlj(R, S, B, true);
    case "inlj": return indexNlj(R, S, { probeIO: 1 }, true);
    case "smj": return sortMergeJoin(R, S, B, true);
    case "hash": return hashJoin(R, S, 100, true, BUCKETS);
  }
}

export function JoinStepperDemo() {
  const [algo, setAlgo] = useState<StepAlgo>("nlj");
  const [B, setB] = useState(4);
  const R = useMemo(() => paged("R", R_KEYS, 2), []);
  const S = useMemo(() => paged("S", S_KEYS, 2), []);
  const key = useMemo(() => new Map([...R.pages.flat(), ...S.pages.flat()].map((t) => [t.id, t.k])), [R, S]);
  const res = useMemo(() => runStepAlgo(algo, R, S, B), [algo, R, S, B]);
  const frames = useMemo(() => res.events.filter((e) => e.t !== "emit" && e.t !== "write"), [res]);
  const s = useStepper(frames.length + 1, 4);
  const st = useMemo(() => {
    let io = 0, cmps = 0, probes = 0;
    const out: string[] = [];
    let memR = new Set<number>(), memS = new Set<number>(), readR = new Set<number>(), readS = new Set<number>();
    let cur = new Set<string>(), match = new Set<string>();
    let order: Record<string, string[]> = {};
    const buckets: string[][] = Array.from({ length: BUCKETS }, () => []);
    let hotBucket = -1;
    let text = "Press Play or Step to run the join.";
    let k = 0;
    const evs = res.events;
    for (let fi = 0; fi < s.i; fi++) {
      const target = frames[fi]!;
      // Advance through raw events up to and including this frame's event; collect emits.
      while (k < evs.length) {
        const e = evs[k++]!;
        if (e.t === "emit") { out.push(`(${e.r}, ${e.s})`); continue; }
        if (e.t === "write") { io++; continue; }
        if (e === target) break;
      }
      const e: JoinEvent = target;
      readR = new Set(); readS = new Set(); cur = new Set(); match = new Set(); hotBucket = -1;
      switch (e.t) {
        case "phase": text = e.text; if (algo === "smj" && e.text.startsWith("Merge")) io += R.pages.length + S.pages.length; break;
        case "read":
          io++;
          if (e.rel === "R") { readR.add(e.page); if (e.why !== "block") memR = new Set([e.page]); else memR.add(e.page); }
          else { readS.add(e.page); memS = new Set([e.page]); }
          text = e.why === "block" ? `Read page ${e.page + 1} of R into the block (B − 2 = ${B - 2} frames).` : `Read page ${e.page + 1} of ${e.rel}.`;
          break;
        case "block": memR = new Set(e.pages); text = `The block holds R pages ${e.pages.map((p) => p + 1).join(", ")}. Now scan S once for the whole block.`; break;
        case "cmp": {
          cmps++;
          cur = new Set([e.r, e.s]);
          if (e.match) match = new Set([e.r, e.s]);
          text = `Compare ${e.r} (key ${key.get(e.r)}) with ${e.s} (key ${key.get(e.s)}): ${e.match ? `equal, so output (${e.r}, ${e.s}).` : "no match."}`;
          break;
        }
        case "index": {
          probes++;
          io += e.ios;
          cur = new Set([e.r]);
          match = new Set(e.hits);
          text = `Look up key ${e.key} of ${e.r} in the index on S: ${e.hits.length ? e.hits.join(", ") : "no entry"}. Cost: ${e.ios} I/O${e.ios === 1 ? "" : "s"} (1 probe + 1 page per match).`;
          break;
        }
        case "sorted": {
          order = { ...order, [e.rel]: e.ids };
          if (e.rel === "R") io += res.reads + res.writes - (R.pages.length + S.pages.length) - 0;
          text = `${e.rel} is sorted on the join key (external merge sort, with B = ${B}).`;
          break;
        }
        case "build": buckets[e.bucket]!.push(e.r); cur = new Set([e.r]); hotBucket = e.bucket; text = `Insert ${e.r} (key ${key.get(e.r)}) into bucket h(${key.get(e.r)}) = ${e.bucket}.`; break;
        case "probe": probes++; cur = new Set([e.s]); match = new Set(e.hits); hotBucket = e.bucket; text = `Probe bucket ${e.bucket} with ${e.s} (key ${key.get(e.s)}): ${e.hits.length ? `match ${e.hits.join(", ")}` : "no match"}.`; break;
        default: break;
      }
      if (e.t === "cmp" || e.t === "probe" || e.t === "index") {
        // emits follow the event
        while (k < evs.length && evs[k]!.t === "emit") { const x = evs[k++]! as Extract<JoinEvent, { t: "emit" }>; out.push(`(${x.r}, ${x.s})`); }
      }
    }
    if (s.i === 0) { memR = new Set(); memS = new Set(); }
    return { io, cmps, probes, out, memR, memS, readR, readS, cur, match, order, buckets, hotBucket, text };
  }, [s.i, frames, res, algo, key, R, S, B]);
  const total = res.reads + res.writes;
  return (
    <Demo
      title="Five ways to join R and S on key"
      actions={<StepButtons s={s} />}
      controls={
        <>
          <StepSlider s={s} label="Event" />
          <Param spec={select({ label: "Algorithm", options: STEP_ALGOS, default: "nlj", segmented: true })} value={algo} onChange={(v) => { setAlgo(v as StepAlgo); s.reset(); }} />
          {(algo === "bnlj" || algo === "smj") && <Param spec={range({ label: "Buffer frames B", min: 3, max: 5, step: 1, default: 4 })} value={B} onChange={(v) => { setB(v as number); s.reset(); }} />}
        </>
      }
    >
      <PageRow rel={R} label={`R: ${R.pages.length} pages, 2 tuples per page${st.order.R ? " (sorted)" : ""}`} order={st.order.R} curIds={st.cur} matchIds={st.match} memPages={st.memR} readPages={st.readR} />
      <PageRow rel={S} label={`S: ${S.pages.length} pages${algo === "inlj" ? ", with an index on key" : ""}${st.order.S ? " (sorted)" : ""}`} order={st.order.S} curIds={st.cur} matchIds={st.match} memPages={st.memS} readPages={st.readS} />
      {algo === "hash" && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${BUCKETS}, 1fr)`, gap: 6, margin: "4px 0 8px" }}>
          {st.buckets.map((b, i) => (
            <div key={i} style={{ border: `1.5px solid ${st.hotBucket === i ? ACC : "var(--border)"}`, borderRadius: 5, padding: 4, minHeight: 44 }}>
              <div className="muted" style={{ fontSize: 10.5 }}>bucket {i}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>{b.map((id) => <span key={id} style={{ fontFamily: MONO, fontSize: 11, color: st.match.has(id) ? GOOD : undefined, fontWeight: st.match.has(id) ? 700 : 400 }}>{key.get(id)}:{id}</span>)}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12.5 }}><span className="muted">Output: </span><span style={{ fontFamily: MONO, fontSize: 12 }}>{st.out.length ? st.out.join(" ") : "none yet"}</span></div>
      <StepCaption label={`${s.i}/${frames.length}`}>{st.text}</StepCaption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "page I/Os so far", value: st.io },
        { label: "key comparisons so far", value: st.cmps },
        { label: "hash or index probes so far", value: st.probes },
        { label: "page I/Os for the whole join", value: total },
        { label: "output pairs", value: res.pairs.length },
      ]} />
    </Demo>
  );
}

// ============================================================================ 2. cost plot

const COST_ALGOS: { id: JoinAlgo; label: string; color: string; dash?: string }[] = [
  { id: "pnlj", label: "page nested loop", color: "var(--muted)", dash: "4 3" },
  { id: "bnlj", label: "block nested loop", color: BAD },
  { id: "inlj", label: "index nested loop (C = 2)", color: ALT, dash: "6 3" },
  { id: "smj", label: "sort-merge", color: WARM },
  { id: "ghj", label: "Grace hash", color: ACC },
  { id: "hhj", label: "hybrid hash", color: GOOD },
];

const COST_SCHEMA = {
  M: range({ label: "Pages of R (outer, build)", min: 10, max: 100000, log: true, default: 1000, format: (v) => int(v) }),
  N: range({ label: "Pages of S (inner, probe)", min: 10, max: 100000, log: true, default: 500, format: (v) => int(v) }),
  B: range({ label: "Buffer frames B", min: 3, max: 10000, log: true, default: 100, format: (v) => int(v) }),
};

export function JoinCostDemo() {
  const [v, setV] = useState({ M: 1000, N: 500, B: 100 });
  const M = Math.round(v.M), N = Math.round(v.N), B = Math.round(v.B);
  const c = (b: number) => ({ M, N, B: b, m: 100 * M, n: 80 * N, indexCost: 2 });
  const xs = useMemo(() => Array.from({ length: 161 }, (_, i) => Math.round(3 * Math.pow(10000 / 3, i / 160))), []);
  const lines = COST_ALGOS.map((a) => ({ ...a, pts: xs.map((b) => [b, joinCost(a.id, c(b))] as const) }));
  const at = COST_ALGOS.map((a) => ({ ...a, io: joinCost(a.id, c(B)) })).sort((x, y) => x.io - y.io);
  const ymin = Math.max(1, Math.min(M + N, ...lines.flatMap((l) => l.pts.map((p) => p[1])))) / 2;
  const ymax = Math.max(...lines.flatMap((l) => l.pts.map((p) => p[1]))) * 2;
  const hp = hybridPlan(M, B);
  return (
    <Demo
      title="Page I/Os of each join, as memory grows"
      controls={<>{(["M", "N", "B"] as const).map((k) => <Param key={k} spec={COST_SCHEMA[k]} value={v[k]} onChange={(x) => setV({ ...v, [k]: x as number })} />)}</>}
    >
      <Plot x={[3, 10000]} y={[ymin, ymax]} logX logY height={260} xLabel="buffer frames B" yLabel="page I/Os (log)" xTicks={[3, 10, 100, 1000, 10000]} xFormat={(x) => si(x)} yTicks={[1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10].filter((t) => t >= ymin && t <= ymax)} yFormat={(y) => si(y)}>
        {lines.map((l) => <Line key={l.id} points={l.pts} color={l.color} dash={l.dash} width={l.id === at[0]!.id ? 2.8 : 1.8} />)}
        <RuleX at={B} label={`B = ${int(B)}`} />
        <RuleX at={Math.sqrt(M)} color={ACC} label="√M" />
      </Plot>
      <Legend items={COST_ALGOS.map((a) => ({ label: a.label, color: a.color }))} />
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <table style={{ fontSize: 12.5, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", width: "100%" }}>
          <thead><tr className="muted" style={{ textAlign: "right" }}><th style={{ textAlign: "left", fontWeight: 500 }}>at B = {int(B)}</th><th style={{ fontWeight: 500 }}>page I/Os</th><th style={{ fontWeight: 500 }}>time at 0.1 ms per I/O</th></tr></thead>
          <tbody>
            {[{ id: "nlj", label: "tuple nested loop", color: "var(--muted)", io: joinCost("nlj", c(B)) }, ...at].map((a, i) => (
              <tr key={a.id} style={{ borderTop: "1px solid var(--border)", textAlign: "right", color: a.id === at[0]!.id ? GOOD : undefined, fontWeight: a.id === at[0]!.id ? 650 : 400 }}>
                <td style={{ textAlign: "left" }}>{i === 0 ? <span className="muted">{a.label}</span> : a.label}</td>
                <td>{int(a.io)}</td>
                <td>{fmtTime(a.io * 0.1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>
        Model: R has 100 tuples per page, so m = {int(100 * M)}. Index nested loop pays C = 2 I/Os per outer tuple (one probe, one fetch). Hybrid hash keeps {hp && hp.k > 0 ? `${int(hp.memPages)} pages of R in memory and spills ${hp.k} partitions` : hp ? "all of R in memory" : "nothing in memory (it becomes Grace)"}. Output writes are not counted.
      </Note>
    </Demo>
  );
}

function fmtTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  const s = ms / 1000;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

// ============================================================================ 3. Grace / hybrid partitioning

const PART_COLORS = [ACC, WARM, GOOD, ALT, BAD, "var(--muted)", "var(--c1)"];

export function GracePartitionDemo() {
  const [B, setB] = useState(6);
  const [skew, setSkew] = useState(false);
  const [hybrid, setHybrid] = useState(false);
  const data = useMemo(() => {
    const rk = skew ? zipfKeys(48, 40, 1.4, 11) : uniformKeys(48, 40, 11);
    const sk = skew ? zipfKeys(64, 40, 1.4, 12) : uniformKeys(64, 40, 12);
    const R = paged("R", rk, 4), S = paged("S", sk, 4);
    const res = hybrid ? hybridHashJoin(R, S, B, true) : graceHashJoin(R, S, B, true);
    const ref = nestedLoopJoin(R, S).pairs.length;
    return { R, S, res, ref };
  }, [B, skew, hybrid]);
  const { R, S, res } = data;
  const M = R.pages.length, N = S.pages.length;
  const hp = hybrid ? hybridPlan(M, B) : null;
  const hyb = !!hp && hp.k > 0; // hybrid really runs (else it falls back to Grace)
  const k = hyb ? hp!.k + 1 : B - 1; // displayed partitions (hybrid: P0 is the memory partition)
  const topPart = (e: JoinEvent) => (e.t === "part" ? e.part : -1);
  // Frames: the top-level partition events (R then S), then one frame per partition join.
  const firstLevel = useMemo(() => {
    const out: JoinEvent[] = [];
    let seenR = 0, seenS = 0;
    for (const e of res.events) {
      if (e.t !== "part") continue;
      if (e.rel === "R" && seenR < R.pages.flat().length) { out.push(e); seenR++; }
      else if (e.rel === "S" && seenS < S.pages.flat().length) { out.push(e); seenS++; }
      if (seenR >= 48 && seenS >= 64) break;
    }
    return out;
  }, [res, R, S]);
  const s = useStepper(firstLevel.length + 2, 12);
  const shown = firstLevel.slice(0, s.i);
  const parts = Array.from({ length: Math.max(k, 1) }, () => ({ r: [] as number[], s: [] as number[] }));
  const kOf = new Map([...R.pages.flat(), ...S.pages.flat()].map((t) => [t.id, t.k]));
  for (const e of shown) if (e.t === "part") {
    const p = topPart(e);
    if (!parts[p]) continue;
    (e.rel === "R" ? parts[p]!.r : parts[p]!.s).push(kOf.get(e.id)!);
  }
  const last = shown[shown.length - 1];
  const phase2 = s.i > firstLevel.length;
  const cap = B - 2;
  const fitsInfo = res.partitions ?? [];
  const textNow = s.i === 0
    ? `R has ${M} pages and S has ${N}, with B = ${B} frames. Press Play to hash every tuple into a partition.`
    : phase2
      ? `Phase 2: join each pair R_i, S_i. A partition of R with at most B − 2 = ${cap} pages fits in memory. ${res.fallbacks ? `${res.fallbacks} partition${res.fallbacks === 1 ? "" : "s"} had one hot key and could not be split, so ${res.fallbacks === 1 ? "it uses" : "they use"} a nested-loop join.` : ""}`
      : last && last.t === "part"
        ? `${last.id} has key ${kOf.get(last.id)}: h1(${kOf.get(last.id)}) sends it to partition ${last.part}${last.mem ? ", which stays in memory" : ""}.`
        : "";
  return (
    <Demo
      title={hyb ? "Hybrid hash join: partition 0 stays in memory" : "Grace hash join: partition, then join each pair"}
      actions={<StepButtons s={s} />}
      controls={
        <>
          <StepSlider s={s} label="Tuple" />
          <Param spec={range({ label: "Buffer frames B", min: 4, max: 8, step: 1, default: 6 })} value={B} onChange={(v) => { setB(v as number); s.reset(); }} />
          <Param spec={toggle({ label: "Skewed keys (Zipf)", default: false })} value={skew} onChange={(v) => { setSkew(v as boolean); s.reset(); }} />
          <Param spec={toggle({ label: "Hybrid: keep partition 0 in memory", default: false })} value={hybrid} onChange={(v) => { setHybrid(v as boolean); s.reset(); }} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${parts.length}, minmax(0, 1fr))`, gap: 6 }}>
        {parts.map((p, i) => {
          const rp = Math.ceil(p.r.length / 4), sp = Math.ceil(p.s.length / 4);
          const mem = hyb && i === 0;
          const over = !mem && rp > cap;
          const col = PART_COLORS[i % PART_COLORS.length]!;
          return (
            <div key={i} style={{ border: `1.5px ${mem ? "solid" : "dashed"} ${over ? BAD : col}`, borderRadius: 6, padding: 4, minWidth: 0, background: mem ? "var(--subtle)" : undefined }}>
              <div style={{ fontSize: 11.5, fontWeight: 650, color: col }}>P{i}{mem ? " memory" : ""}</div>
              <div className="muted" style={{ fontSize: 10.5 }}>R {p.r.length} · {mem ? "held" : `${rp} pg`}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 1, margin: "2px 0 4px" }}>
                {p.r.map((x, j) => <span key={j} style={{ fontFamily: MONO, fontSize: 9.5, padding: "0 2px", borderRadius: 2, background: col, color: "var(--bg)" }}>{x}</span>)}
              </div>
              <div className="muted" style={{ fontSize: 10.5 }}>S {p.s.length} · {mem ? "probed" : `${sp} pg`}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 1, marginTop: 2 }}>
                {p.s.map((x, j) => <span key={j} style={{ fontFamily: MONO, fontSize: 9.5, padding: "0 2px", borderRadius: 2, border: `1px solid ${col}`, color: col }}>{x}</span>)}
              </div>
              {phase2 && !mem && <div style={{ fontSize: 10.5, marginTop: 4, color: over ? BAD : GOOD, fontWeight: 600 }}>{over ? `${rp} > ${cap}: split again` : `${rp} ≤ ${cap}: fits`}</div>}
            </div>
          );
        })}
      </div>
      <StepCaption label={`${s.i}/${firstLevel.length + 1}`} tone={phase2 && res.fallbacks ? "bad" : null}>{textNow}</StepCaption>
      <div style={{ height: 10 }} />
      <Stats items={[
        { label: "page reads", value: res.reads },
        { label: "page writes", value: res.writes },
        { label: "total I/O", value: res.reads + res.writes },
        { label: "3(M + N)", value: 3 * (M + N) },
        { label: "partition joins (incl. recursive)", value: fitsInfo.length },
        { label: "output pairs (checked against nested loop)", value: `${res.pairs.length} = ${data.ref}` },
      ]} />
      <Note>Keys are {skew ? "Zipf-distributed (key 0 is very common)" : "uniform over 0–39"}. 48 R tuples and 64 S tuples, 4 tuples per page. h1 is a 32-bit hash; {hyb ? `hybrid hash join puts the first ${hp!.memPages} / ${M} of the hash range in partition 0.` : `the partition is h1(key) mod ${B - 1}.`}{hybrid && !hyb ? ` With B = ${B}, no split keeps every spilled partition within B − 2 pages, so hybrid falls back to Grace.` : ""} Example: h1(7) mod {B - 1} = {hash32(7, 0) % (B - 1)}.</Note>
    </Demo>
  );
}
