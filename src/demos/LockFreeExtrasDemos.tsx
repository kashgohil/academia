/** New demos for the lock-free lessons: CAS race, ABA order, tag bits, hazard scan, epoch ring, M&S tail. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Demo, Stats, Param, Plot, Line, Bars, RuleX, Legend, range, select, toggle, useParams, useSim, pct, Arrow, MONO } from "../kit";
import { nodeName, type Ptr } from "../sims/lockfree/machine";
import {
  casRace, abaOrder, ABA_T1_OPS, tagWrap, tagLooksSame, hpBound, hpSim, ebrSim, msqFrames, msqLagStats, MSQ_SCENARIOS,
  type Reuse, type MsqScenario,
} from "../sims/lockfreeextras";

const TC = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)", "var(--fg)", "var(--muted)"];
const EASE = "transform 0.45s cubic-bezier(.4,.1,.2,1)";

// ---------------------------------------------------------------- shared frame player

function usePlayer(n: number, fps: number, autoplay = false) {
  const idx = useRef(0);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / fps, autoplay, step: () => { if (idx.current < n - 1) idx.current++; }, reset: () => { idx.current = 0; } });
  const i = Math.min(idx.current, Math.max(0, n - 1));
  const atEnd = i >= n - 1;
  const { running, pause } = sim;
  useEffect(() => { if (atEnd && running) pause(); }, [atEnd, running, pause]);
  const go = (j: number) => { idx.current = Math.max(0, Math.min(n - 1, j)); force((x) => x + 1); };
  return {
    i, atEnd, running,
    toggle: () => { if (atEnd && !running) idx.current = 0; sim.toggle(); },
    play: sim.play,
    pause,
    step: () => go(i + 1),
    back: () => go(i - 1),
    go,
  };
}
type Player = ReturnType<typeof usePlayer>;

function PlayerButtons({ p, extra }: { p: Player; extra?: ReactNode }) {
  return (
    <>
      <button className="btn" onClick={p.toggle}>{p.running ? "Pause" : p.atEnd ? "Replay" : "Play"}</button>
      <button className="btn" onClick={() => { p.pause(); p.back(); }} disabled={p.i === 0}>Back</button>
      <button className="btn" onClick={() => { p.pause(); p.step(); }} disabled={p.atEnd}>Step</button>
      {extra}
    </>
  );
}

function Caption({ i, n, children, tone }: { i: number; n: number; children: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.45, minHeight: 44, padding: "8px 10px", marginTop: 10, background: "var(--subtle)", borderRadius: 6, border: "1px solid var(--border)", boxShadow: `inset 3px 0 0 ${tone === "bad" ? "var(--c4)" : tone === "good" ? "var(--c3)" : "var(--border)"}`, paddingLeft: 13 }}>
      <span className="muted" style={{ fontSize: 11.5, marginRight: 8, fontVariantNumeric: "tabular-nums" }}>{i + 1}/{n}</span>
      {children}
    </div>
  );
}


// ---------------------------------------------------------------- 1. CAS race on the stack head

const RACE_SCHEMA = {
  threads: range({ label: "Threads that push", min: 1, max: 6, step: 1, default: 4 }),
  order: select({ label: "Order of steps", options: [{ value: "lockstep", label: "Lock step (worst case)" }, { value: "random", label: "Random" }], default: "lockstep", segmented: true }),
};

export function CasRaceDemo() {
  const P = useParams("lfx-race", RACE_SCHEMA);
  const n = Math.round(P.values.threads);
  const order = P.values.order as "lockstep" | "random";
  const [seed, setSeed] = useState(1);
  const res = useMemo(() => casRace(n, order, seed), [n, order, seed]);
  const pl = usePlayer(res.frames.length, 2.2, true);
  useEffect(() => { pl.go(0); pl.play(); }, [res]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = res.frames[pl.i]!;
  const top = f.stack[0]?.p ?? 0;

  const NW = 70, NH = 26, SX = 8, SY = 40, GY = 40, LX = 112, LY = 22, LH = 52, W = 360;
  const H = Math.max(SY + (n + 2) * GY, LY + n * LH) + 4;
  const stackIdx = new Map(f.stack.map((s, k) => [s.p, k]));
  const owner = new Map<Ptr, number>();
  f.threads.forEach((t, i) => t.node && owner.set(t.node, i));
  const nodes: { p: Ptr; value: number; x: number; y: number }[] = [];
  f.stack.forEach((s, k) => nodes.push({ p: s.p, value: s.value, x: SX, y: SY + k * GY }));
  f.threads.forEach((t, i) => { if (t.node && !stackIdx.has(t.node)) nodes.push({ p: t.node, value: t.value, x: LX + 30, y: LY + i * LH + 17 }); });
  nodes.sort((a, b) => a.p - b.p);

  const a = f.actor;
  const at = a === null ? null : f.threads[a]!;
  const X = at ? nodeName(at.node) : "";
  const caption =
    f.kind === "start" ? `${n} thread${n > 1 ? "s" : ""} each push one value. The stack holds A(1) → B(2).`
    : f.kind === "alloc" ? `T${a} makes node ${X} for ${at!.value}. Only T${a} can see it.`
    : f.kind === "load" ? `T${a} loads head = ${nodeName(at!.seen ?? 0)} and sets ${X}.next = ${nodeName(at!.seen ?? 0)}.`
    : f.kind === "cas-ok" ? `T${a} runs CAS(head, ${nodeName(at!.seen ?? 0)} → ${X}). Head is still ${nodeName(at!.seen ?? 0)}, so the CAS succeeds. ${X} is on the stack.`
    : `T${a} runs CAS(head, ${nodeName(at!.seen ?? 0)} → ${X}). Head is ${nodeName(top)} now, so the CAS fails. T${a} must load head again.`;
  const attempts = f.threads.reduce((s, t) => s + t.attempts, 0);
  const fails = f.threads.reduce((s, t) => s + t.fails, 0);

  return (
    <Demo
      title="Many threads, one head pointer"
      actions={<PlayerButtons p={pl} extra={order === "random" ? <button className="btn ghost" onClick={() => setSeed((s) => s + 1)}>New order</button> : undefined} />}
      controls={<><Param spec={RACE_SCHEMA.threads} value={P.values.threads} onChange={(v) => P.set("threads", v as number)} /><Param spec={RACE_SCHEMA.order} value={order} onChange={(v) => P.set("order", v as "lockstep" | "random")} /></>}
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 560, display: "block", margin: "0 auto", fontFamily: "inherit" }}>
        <defs><Arrow id="lfx-race-a" /><Arrow id="lfx-race-ok" color="var(--c3)" /><Arrow id="lfx-race-bad" color="var(--c4)" /></defs>
        <text x={SX + NW / 2} y={12} fontSize={11} fontWeight={600} textAnchor="middle" fill="var(--fg)">head</text>
        <line x1={SX + NW / 2} y1={16} x2={SX + NW / 2} y2={SY - 2} stroke="var(--fg)" markerEnd="url(#lfx-race-a)" />
        {f.stack.slice(0, -1).map((s, k) => <line key={`e${s.p}`} x1={SX + NW / 2} y1={SY + k * GY + NH} x2={SX + NW / 2} y2={SY + (k + 1) * GY - 1} stroke="var(--muted)" markerEnd="url(#lfx-race-a)" />)}
        {f.threads.map((t, i) => {
          const y = LY + i * LH;
          const active = a === i;
          const status = t.done ? `pushed: ${t.attempts} CAS${t.fails ? `, ${t.fails} failed` : ""}` : t.fails ? `${t.fails} failed CAS` : t.seen !== null ? "ready to CAS" : t.node ? "node ready" : "";
          const stale = !t.done && t.seen !== null && t.seen !== top;
          const sy = t.seen !== null && stackIdx.has(t.seen) ? SY + stackIdx.get(t.seen)! * GY + NH / 2 : null;
          return (
            <g key={`lane${i}`}>
              <rect x={LX - 6} y={y} width={W - LX + 4} height={LH - 6} rx={6} fill={active ? "var(--subtle)" : "transparent"} stroke={active ? TC[i] : "var(--border)"} strokeWidth={active ? 1.5 : 1} />
              <text x={LX + 2} y={y + 13} fontSize={11.5} fontWeight={700} fill={TC[i]}>T{i}</text>
              {!t.node && <text x={LX + 30} y={y + 34} fontSize={11} fill="var(--muted)">will push {t.value}</text>}
              <text x={LX + 30 + NW + 8} y={y + 27} fontSize={10.5} fill={t.done ? "var(--c3)" : active && f.kind === "cas-fail" ? "var(--c4)" : "var(--muted)"} fontWeight={active ? 600 : 400}>{status}</text>
              {!t.done && t.seen !== null && <text x={LX + 30 + NW + 8} y={y + 41} fontSize={10.5} fill={stale ? "var(--c4)" : "var(--c3)"}>{stale ? `saw ${nodeName(t.seen)}: stale` : `saw ${nodeName(t.seen)}: current`}</text>}
              {!t.done && t.node !== 0 && sy !== null && (
                <path d={`M${LX + 30} ${y + 17 + NH / 2} C ${LX} ${y + 17 + NH / 2}, ${SX + NW + 30} ${sy}, ${SX + NW + 2} ${sy}`} fill="none" stroke={stale ? "var(--c4)" : "var(--c3)"} strokeDasharray={stale ? "4 3" : undefined} strokeWidth={1.4} markerEnd={`url(#${stale ? "lfx-race-bad" : "lfx-race-ok"})`} />
              )}
            </g>
          );
        })}
        {nodes.map((nd) => {
          const o = owner.get(nd.p);
          const inStack = stackIdx.has(nd.p);
          const fresh = f.kind === "cas-ok" && nd.p === top;
          return (
            <g key={nd.p} style={{ transform: `translate(${nd.x}px, ${nd.y}px)`, transition: EASE }}>
              <rect width={NW} height={NH} rx={4} fill={fresh ? "var(--c3)" : "var(--bg)"} stroke={o === undefined ? "var(--fg)" : TC[o]} strokeWidth={1.6} strokeDasharray={inStack ? undefined : "4 3"} style={{ transition: "fill 0.3s" }} />
              <text x={8} y={17} fontSize={11.5} fontWeight={600} fill={fresh ? "var(--bg)" : o === undefined ? "var(--fg)" : TC[o]}>{nodeName(nd.p)}</text>
              <text x={NW - 8} y={17} fontSize={11.5} textAnchor="end" fill={fresh ? "var(--bg)" : "var(--fg)"}>{nd.value}</text>
            </g>
          );
        })}
      </svg>
      <Caption i={pl.i} n={res.frames.length} tone={f.kind === "cas-fail" ? "bad" : f.kind === "cas-ok" ? "good" : undefined}>{caption}</Caption>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "CAS attempts so far", value: attempts },
          { label: "failed CAS so far", value: fails },
          { label: "values pushed", value: `${f.threads.filter((t) => t.done).length} of ${n}` },
          { label: "CAS attempts for all pushes", value: res.attempts },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 2. ABA: where T0's CAS lands

const ABA_SCHEMA = {
  k: range({ label: "T1 operations before T0's CAS", min: 0, max: 4, step: 1, default: 0 }),
  tags: toggle({ label: "Tagged pointers (version counter in head)", default: false }),
  reuse: select({ label: "Allocator", options: [{ value: "lifo", label: "Reuse the newest free node" }, { value: "fresh", label: "Reuse the oldest free node" }], default: "lifo", segmented: true }),
};

export function AbaOrderDemo() {
  const P = useParams("lfx-aba", ABA_SCHEMA);
  const k = Math.round(P.values.k);
  const reuse = P.values.reuse as Reuse;
  const res = useMemo(() => abaOrder(k, P.values.tags, reuse), [k, P.values.tags, reuse]);
  const pl = usePlayer(res.frames.length, 0.9);
  useEffect(() => { pl.pause(); pl.go(res.casFrame); }, [res]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = res.frames[pl.i]!;
  const tags = P.values.tags;
  const chip = (j: number) => (j === 0 ? "Start" : j === 1 ? "T0 reads" : j === res.casFrame ? "T0 CAS" : j === res.frames.length - 1 ? "Rest, end" : `T1 ${ABA_T1_OPS[j - 2]}`);
  const actorColor = (j: number) => (j === 1 || j === res.casFrame ? TC[0] : j > 1 && j < res.casFrame ? TC[1] : "var(--muted)");
  const NW = 60, GX = 76, X0 = 52;
  const bad = res.problems.length > 0;
  const isCas = pl.i === res.casFrame;
  return (
    <Demo
      title="Move T0's CAS along T1's operations"
      actions={<PlayerButtons p={pl} />}
      controls={<><Param spec={ABA_SCHEMA.k} value={P.values.k} onChange={(v) => P.set("k", v as number)} /><Param spec={ABA_SCHEMA.tags} value={tags} onChange={(v) => P.set("tags", v as boolean)} /><Param spec={ABA_SCHEMA.reuse} value={reuse} onChange={(v) => P.set("reuse", v as Reuse)} /></>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
        {res.frames.map((_, j) => (
          <button key={j} onClick={() => { pl.pause(); pl.go(j); }} style={{ cursor: "pointer", fontSize: 12, padding: "3px 9px", borderRadius: 999, border: `1.5px solid ${actorColor(j)}`, background: j === pl.i ? actorColor(j) : "var(--bg)", color: j === pl.i ? "var(--bg)" : "var(--fg)", fontWeight: j === res.casFrame ? 700 : 400 }}>{chip(j)}</button>
        ))}
      </div>
      <svg viewBox="0 0 360 60" style={{ width: "100%", maxWidth: 520, display: "block", margin: "0 auto" }}>
        <defs><Arrow id="lfx-aba-a" /></defs>
        <text x={0} y={30} fontSize={11.5} fontWeight={600} fill="var(--fg)">head</text>
        {tags && <text x={0} y={44} fontSize={10.5} fill="var(--c5)">v{f.head.tag}</text>}
        {f.stack.length > 0 && <line x1={32} y1={26} x2={X0 - 2} y2={26} stroke="var(--fg)" markerEnd="url(#lfx-aba-a)" />}
        {f.stack.length === 0 && <text x={X0} y={30} fontSize={12} fill="var(--muted)">empty</text>}
        {f.stack.map((s, j) => {
          const reused = s.p <= 3 && s.value !== s.p;
          return (
            <g key={s.p} style={{ transform: `translate(${X0 + j * GX}px, 10px)`, transition: EASE }}>
              <rect width={NW} height={32} rx={4} fill="var(--bg)" stroke={reused ? "var(--c2)" : "var(--fg)"} strokeWidth={reused ? 2 : 1.3} />
              <text x={8} y={20} fontSize={12} fontWeight={600} fill={reused ? "var(--c2)" : "var(--fg)"}>{nodeName(s.p)}</text>
              <text x={NW - 8} y={20} fontSize={12} textAnchor="end" fill="var(--fg)">{s.value}</text>
              {reused && <text x={NW / 2} y={46} fontSize={9.5} textAnchor="middle" fill="var(--c2)">reused</text>}
              {j < f.stack.length - 1 && <line x1={NW} y1={16} x2={GX - 2} y2={16} stroke="var(--muted)" markerEnd="url(#lfx-aba-a)" />}
            </g>
          );
        })}
      </svg>
      <div style={{ fontSize: 12.5, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
        <span><span className="muted">freed nodes: </span><b style={{ color: f.freed.length ? "var(--c4)" : "var(--muted)" }}>{f.freed.map(nodeName).join(", ") || "none"}</b></span>
        <span><span className="muted">next allocations: </span><b>{f.freeTop.map(nodeName).join(", ")}</b></span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 10, fontSize: 13 }}>
        <div style={{ border: "1px solid var(--border)", boxShadow: `inset 0 3px 0 ${TC[0]}`, borderRadius: 6, padding: "8px 10px 6px" }}>
          <div className="muted" style={{ fontSize: 11.5 }}>T0 saw, before it paused</div>
          <div style={{ fontFamily: MONO, fontSize: 12.5 }}>head = {nodeName(res.seen.h)}{tags ? `·v${res.seen.tag}` : ""}, next = {nodeName(res.seen.next)}, value = {res.seen.value}</div>
        </div>
        <div style={{ border: "1px solid var(--border)", boxShadow: `inset 0 3px 0 ${bad ? "var(--c4)" : "var(--c3)"}`, borderRadius: 6, padding: "8px 10px 6px" }}>
          <div className="muted" style={{ fontSize: 11.5 }}>Result of the whole run</div>
          <div style={{ color: bad ? "var(--c4)" : "var(--c3)" }}>
            {bad ? `Broken. T0 returned ${res.t0Result}, a value that T1 popped already. The final stack is ${res.final.join(" → ") || "empty"}: 8 is lost.` : `Correct. T0's first CAS ${res.casOk ? "succeeded" : "failed"}. T0 returned ${res.t0Result}. No value is lost or returned twice.`}
          </div>
        </div>
      </div>
      <Caption i={pl.i} n={res.frames.length} tone={isCas ? (res.casOk && bad ? "bad" : "good") : undefined}>{f.label}</Caption>
    </Demo>
  );
}

// ---------------------------------------------------------------- 3. Where a tag can live

const TAG_SCHEMA = {
  changes: range({ label: "Successful CAS operations on head while T0 sleeps", min: 1, max: 1e6, log: true, default: 10 }),
  where: select({ label: "Where the tag lives", options: [{ value: "4", label: "4 low bits" }, { value: "16", label: "16 high bits" }, { value: "64", label: "Second word" }], default: "4", segmented: true }),
};

export function TagBitsDemo() {
  const P = useParams("lfx-tag", TAG_SCHEMA);
  const bits = Number(P.values.where);
  const changes = Math.max(1, Math.round(P.values.changes));
  const wrap = tagWrap(bits);
  const now = bits >= 53 ? changes : changes % wrap;
  const same = bits < 53 && tagLooksSame(bits, changes);
  const segs: { label: string; bits: number; color: string }[] =
    bits === 4 ? [{ label: "address (60 bits)", bits: 60, color: "var(--c1)" }, { label: "tag", bits: 4, color: "var(--c5)" }]
    : bits === 16 ? [{ label: "tag (16 bits)", bits: 16, color: "var(--c5)" }, { label: "address (48 bits)", bits: 48, color: "var(--c1)" }]
    : [{ label: "address (64 bits)", bits: 64, color: "var(--c1)" }, { label: "tag (64 bits)", bits: 64, color: "var(--c5)" }];
  const total = segs.reduce((s, x) => s + x.bits, 0);
  const why =
    bits === 4 ? "Nodes are aligned to 16 bytes, so the 4 lowest address bits are always 0. Mask them off before you use the pointer."
    : bits === 16 ? "x86-64 and ARM64 use 48-bit virtual addresses (without 5-level paging), so the 16 highest bits are free. Mask them off before you use the pointer."
    : "cmpxchg16b on x86-64 (or CASP on ARM64) compares and swaps 128 bits: the full pointer and a 64-bit counter.";
  return (
    <Demo
      title="How many changes until the tag repeats?"
      actions={bits < 53 ? <button className="btn" onClick={() => P.set("changes", wrap)}>Set to {wrap.toLocaleString("en-US")}</button> : undefined}
      controls={<><Param spec={TAG_SCHEMA.changes} value={P.values.changes} onChange={(v) => P.set("changes", v as number)} /><Param spec={TAG_SCHEMA.where} value={P.values.where} onChange={(v) => P.set("where", v as "4" | "16" | "64")} /></>}
    >
      <div style={{ display: "flex", height: 30, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
        {segs.map((s, i) => (
          <div key={i} style={{ width: `${(100 * s.bits) / total}%`, minWidth: 34, background: s.color, color: "var(--bg)", fontSize: 11.5, display: "grid", placeItems: "center", whiteSpace: "nowrap", overflow: "hidden", borderLeft: i ? "2px solid var(--bg)" : undefined }}>{s.label}</div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{total === 128 ? "Two 64-bit words, compared together" : "One 64-bit word"}. {why}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, margin: "14px 0 4px", fontSize: 13 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px" }}><div className="muted" style={{ fontSize: 11.5 }}>T0 saw</div><b style={{ fontFamily: MONO }}>A·v0</b></div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px" }}><div className="muted" style={{ fontSize: 11.5 }}>head is now (worst case: same address)</div><b style={{ fontFamily: MONO }}>A·v{now.toLocaleString("en-US")}</b></div>
      </div>
      <p style={{ fontSize: 13.5, margin: "10px 0", color: same ? "var(--c4)" : "var(--c3)" }}>
        {same ? `The tag wrapped back to 0 after ${changes.toLocaleString("en-US")} changes. If the address is A again, T0's CAS succeeds: ABA is back.` : `The tags differ, so T0's CAS fails and T0 tries again. This is correct.`}
      </p>
      <Stats items={[
        { label: "tag values before it repeats", value: bits < 53 ? `$2^{${bits}} = ${wrap.toLocaleString("en-US").replaceAll(",", "{,}")}$` : "$2^{64} \\approx 1.8 \\times 10^{19}$" },
        { label: "changes while T0 sleeps", value: changes.toLocaleString("en-US") },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- 4. Hazard-pointer scan

const HP_SCHEMA = {
  R: range({ label: "Scan threshold R (retired nodes)", min: 2, max: 24, step: 1, default: 12 }),
  threads: range({ label: "Threads (T0 and the readers)", min: 2, max: 6, step: 1, default: 4 }),
  mode: select({ label: "Readers", options: [{ value: "working", label: "Keep working" }, { value: "stalled", label: "Stall forever" }], default: "working", segmented: true }),
};

export function HazardScanDemo() {
  const P = useParams("lfx-hp", HP_SCHEMA);
  const R = Math.round(P.values.R), T = Math.round(P.values.threads);
  const mode = P.values.mode as "working" | "stalled";
  const frames = useMemo(() => hpSim({ threads: T, R, mode, ticks: 48 }), [T, R, mode]);
  const pl = usePlayer(frames.length, 3, true);
  useEffect(() => { pl.go(0); pl.play(); }, [frames]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = frames[pl.i]!;
  const b = hpBound(T, 2, R);
  const cells = Math.max(R, f.retired.length);
  return (
    <Demo
      title="A scan keeps only what a hazard slot names"
      actions={<PlayerButtons p={pl} />}
      controls={<><Param spec={HP_SCHEMA.R} value={P.values.R} onChange={(v) => P.set("R", v as number)} /><Param spec={HP_SCHEMA.threads} value={P.values.threads} onChange={(v) => P.set("threads", v as number)} /><Param spec={HP_SCHEMA.mode} value={mode} onChange={(v) => P.set("mode", v as "working" | "stalled")} /></>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(98px, 1fr))", gap: 8 }}>
        {f.hazards.map((slots, t) => {
          const reading = f.scanning === t;
          return (
            <div key={t} style={{ border: "1px solid var(--border)", boxShadow: `inset 0 3px 0 ${TC[t]}${reading ? ", 0 0 0 2px var(--c1)" : ""}`, borderRadius: 6, padding: "8px 8px 6px", fontSize: 12, transition: "box-shadow 0.2s" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><b>T{t}</b><span className="muted" style={{ fontSize: 10.5 }}>{t === 0 ? "reclaimer" : reading ? "being read" : mode === "stalled" ? "stalled" : "reader"}</span></div>
              <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
                {slots.map((h, s) => (
                  <div key={s} style={{ flex: 1, textAlign: "center", fontFamily: MONO, fontSize: 12, padding: "3px 0", borderRadius: 4, border: `1px ${h ? "solid" : "dashed"} ${h ? TC[t] : "var(--faint)"}`, color: h ? "var(--fg)" : "var(--faint)", background: reading && h ? "var(--subtle)" : "var(--bg)" }}>{h || "–"}</div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "12px 0 5px" }}>T0's retired list: a scan starts when it holds R = {R} nodes</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {Array.from({ length: cells }, (_, j) => {
          const x = f.retired[j];
          if (!x) return <div key={`e${j}`} style={{ width: 30, height: 26, borderRadius: 4, border: "1px dashed var(--border)" }} />;
          const st = x.mark === "kept" ? { background: "var(--c2)", color: "var(--bg)", border: "1px solid var(--c2)" } : x.mark === "freed" ? { background: "var(--bg)", color: "var(--c4)", border: "1px solid var(--c4)", textDecoration: "line-through", opacity: 0.7 } : { background: "var(--bg)", color: "var(--fg)", border: "1px solid var(--fg)" };
          return <div key={x.id} style={{ width: 30, height: 26, borderRadius: 4, display: "grid", placeItems: "center", fontSize: 11.5, fontFamily: MONO, transition: "background 0.2s", ...st }}>{x.id}</div>;
        })}
      </div>
      <Legend items={[{ label: "waiting", color: "var(--fg)" }, { label: "kept: a slot names it", color: "var(--c2)" }, { label: "freed", color: "var(--c4)" }]} />
      <Caption i={pl.i} n={frames.length} tone={f.phase === "free" ? "good" : undefined}>{f.label}</Caption>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "longest retired list", value: `${f.maxRetired} (limit ${b.maxRetired})` },
          { label: "nodes freed", value: f.freedTotal },
          { label: "slot reads per freed node", value: f.freedTotal ? (f.slotReads / f.freedTotal).toFixed(2) : "–" },
          { label: "worst scan: reads, frees at least", value: `${b.readsPerScan}, ${b.freedMin}` },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 5. Epoch ring

const EBR_SCHEMA = {
  threads: range({ label: "Threads", min: 2, max: 6, step: 1, default: 4 }),
  stalled: toggle({ label: "T0 stalls while pinned", default: false }),
};
const SECTOR = ["var(--c1)", "var(--c2)", "var(--c3)"];

export function EpochRingDemo() {
  const P = useParams("lfx-ebr", EBR_SCHEMA);
  const T = Math.round(P.values.threads);
  const stalled = P.values.stalled;
  const frames = useMemo(() => ebrSim({ threads: T, stalled, steps: 300 }), [T, stalled]);
  const other = useMemo(() => ebrSim({ threads: T, stalled: !stalled, steps: 300 }), [T, stalled]);
  const pl = usePlayer(frames.length, 6, true);
  useEffect(() => { pl.go(0); pl.play(); }, [frames]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = frames[pl.i]!;
  const G = f.global;
  const C = 150, deg = Math.PI / 180;
  const pt = (a: number, r: number) => [C + r * Math.cos(a * deg), C + r * Math.sin(a * deg)] as const;
  const start = (i: number) => -150 + i * 120;
  const wedge = (i: number, r0: number, r1: number) => {
    const a0 = start(i) + 1.5, a1 = start(i) + 118.5;
    const [x0, y0] = pt(a0, r1), [x1, y1] = pt(a1, r1), [x2, y2] = pt(a1, r0), [x3, y3] = pt(a0, r0);
    return `M${x0} ${y0} A${r1} ${r1} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 0 0 ${x3} ${y3}Z`;
  };
  const epochOf = (i: number) => [G - 1, G, G + 1].find((e) => ((e % 3) + 3) % 3 === i)!;
  const ptsA = frames.map((x) => [x.step, x.waiting] as const);
  const ptsB = other.map((x) => [x.step, x.waiting] as const);
  const maxY = Math.max(4, ...ptsA.map((p) => p[1]), ...ptsB.map((p) => p[1]));
  const idle = f.local.flatMap((e, t) => (e === null ? [t] : []));
  return (
    <Demo
      title="The epoch ring"
      actions={<PlayerButtons p={pl} extra={<button className="btn ghost" onClick={() => { pl.pause(); pl.go(frames.length - 1); }}>End</button>} />}
      controls={<><Param spec={EBR_SCHEMA.threads} value={P.values.threads} onChange={(v) => P.set("threads", v as number)} /><Param spec={EBR_SCHEMA.stalled} value={stalled} onChange={(v) => P.set("stalled", v as boolean)} /></>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 14, alignItems: "center" }}>
        <div>
          <svg viewBox="0 0 300 300" style={{ width: "100%", maxWidth: 320, display: "block", margin: "0 auto" }}>
            <defs><Arrow id="lfx-ebr-a" color="var(--fg)" /></defs>
            {[0, 1, 2].map((i) => {
              const e = epochOf(i);
              const l = f.limbo[i]!;
              const count = l.epoch === e ? l.count : 0;
              const [lx, ly] = pt(start(i) + 60, 118);
              const isNext = e === G + 1;
              return (
                <g key={i}>
                  <path d={wedge(i, 40, 140)} fill={SECTOR[i]} opacity={isNext ? 0.06 : 0.1 + Math.min(0.45, count / 40)} style={{ transition: "opacity 0.3s" }} />
                  <path d={wedge(i, 96, 140)} fill="none" stroke={SECTOR[i]} strokeWidth={e === G ? 2.5 : 1} />
                  <text x={lx} y={ly - 6} fontSize={11} textAnchor="middle" fill="var(--fg)" fontWeight={e === G ? 700 : 400}>{e < 0 ? "not used yet" : `epoch ${e}${isNext ? " (next)" : ""}`}</text>
                  <text x={lx} y={ly + 10} fontSize={12.5} textAnchor="middle" fill={SECTOR[i]} fontWeight={700}>{isNext || e < 0 ? "empty" : `${count} waiting`}</text>
                </g>
              );
            })}
            {(() => { const [x, y] = pt(start(G % 3) + 60, 90); return <line x1={C} y1={C} x2={x} y2={y} stroke="var(--fg)" strokeWidth={2.5} markerEnd="url(#lfx-ebr-a)" />; })()}
            <circle cx={C} cy={C} r={30} fill="var(--bg)" stroke="var(--fg)" strokeWidth={1.5} />
            <text x={C} y={C - 5} fontSize={9.5} textAnchor="middle" fill="var(--muted)">global</text>
            <text x={C} y={C + 13} fontSize={17} fontWeight={700} textAnchor="middle" fill="var(--fg)">{G}</text>
            {f.local.map((e, t) => {
              if (e === null) return null;
              const i = e % 3;
              const [x, y] = pt(start(i) + (120 * (t + 1)) / (T + 1), 68);
              const st = stalled && t === 0;
              return (
                <g key={t} style={{ transform: `translate(${x}px, ${y}px)`, transition: EASE }}>
                  {st && <circle r={15} fill="none" stroke="var(--c4)" strokeWidth={1.5} strokeDasharray="3 2" />}
                  <circle r={11} fill={TC[t]} stroke={f.actor === t ? "var(--fg)" : "none"} strokeWidth={2} />
                  <text y={3.5} fontSize={9.5} fontWeight={700} textAnchor="middle" fill="var(--bg)">T{t}</text>
                </g>
              );
            })}
          </svg>
          <div className="muted" style={{ fontSize: 12, textAlign: "center" }}>
            Inner ring: pinned threads, in the sector of the epoch they announced. Not pinned: {idle.length ? idle.map((t) => `T${t}`).join(", ") : "none"}.
          </div>
        </div>
        <div>
          <Plot x={[0, 300]} y={[0, maxY * 1.1]} height={190} xLabel="steps" yLabel="nodes that wait to be freed">
            <Line points={ptsB} color="var(--faint)" width={1.5} dash="4 3" />
            <Line points={ptsA.slice(0, pl.i + 1)} color={stalled ? "var(--c4)" : "var(--c1)"} width={2.2} />
            <RuleX at={f.step} />
          </Plot>
          <Legend items={[{ label: stalled ? "T0 stalled" : "no stall", color: stalled ? "var(--c4)" : "var(--c1)" }, { label: stalled ? "no stall (compare)" : "T0 stalled (compare)", color: "var(--faint)" }]} />
        </div>
      </div>
      <Caption i={pl.i} n={frames.length} tone={/freed/.test(f.label) ? "good" : /cannot/.test(f.label) ? "bad" : undefined}>{f.label}</Caption>
      <div style={{ marginTop: 10 }}>
        <Stats items={[{ label: "global epoch", value: G }, { label: "nodes waiting", value: f.waiting }, { label: "nodes freed", value: f.freed }, { label: "most waiting in this run", value: Math.max(...frames.map((x) => x.waiting)) }]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 6. Michael-Scott queue: the lagging tail

const MSQ_SCHEMA = {
  which: select({ label: "Schedule", options: [{ value: "plain", label: "No stall" }, { value: "stall", label: "Enqueuer stalls" }, { value: "deqhelp", label: "Dequeuer helps" }], default: "stall", segmented: true }),
};
const opText = (o: { kind: string; v?: number }) => (o.kind === "enq" ? `enqueue ${o.v}` : "dequeue");

export function MsqTailDemo() {
  const P = useParams("lfx-msq", MSQ_SCHEMA);
  const which = P.values.which as MsqScenario;
  const frames = useMemo(() => msqFrames(which), [which]);
  const pl = usePlayer(frames.length, 0.7, true);
  useEffect(() => { pl.go(0); pl.play(); }, [frames]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = frames[pl.i]!;
  const sc = MSQ_SCENARIOS[which].sc;
  const maxP = Math.max(...frames.flatMap((x) => [...x.chain.map((c) => c.p), ...x.pending.map((q) => q.p)]));
  const NW = 58, GX = 82, X0 = 14, Y = 40, PY = 128;
  const W = X0 + maxP * GX;
  const px = (p: Ptr) => X0 + (p - 1) * GX;
  const inChain = new Map(f.chain.map((c, j) => [c.p, j]));
  const last = f.chain.at(-1)?.p ?? 0;
  // Old dummies that left the queue stay drawn, faded, where they were.
  const gone = Array.from({ length: maxP }, (_, j) => j + 1).filter((p) => !inChain.has(p) && !f.pending.some((q) => q.p === p) && frames.slice(0, pl.i + 1).some((x) => x.chain.some((c) => c.p === p)));
  const valueOf = (p: Ptr) => frames.flatMap((x) => x.chain).find((c) => c.p === p)?.value ?? 0;
  return (
    <Demo
      title="Head, tail and the helping step"
      actions={<PlayerButtons p={pl} />}
      controls={<Param spec={MSQ_SCHEMA.which} value={which} onChange={(v) => P.set("which", v as MsqScenario)} />}
    >
      <svg viewBox={`0 0 ${W} 172`} style={{ width: "100%", maxWidth: 560, display: "block", margin: "0 auto" }}>
        <defs><Arrow id="lfx-msq-a" /><Arrow id="lfx-msq-h" color="var(--fg)" /><Arrow id="lfx-msq-t" color={f.lag ? "var(--c4)" : "var(--fg)"} /></defs>
        {gone.map((p) => (
          <g key={`g${p}`} opacity={0.35} transform={`translate(${px(p)}, ${Y})`}>
            <rect width={NW} height={34} rx={4} fill="var(--bg)" stroke="var(--faint)" strokeDasharray="3 3" />
            <text x={NW / 2} y={21} fontSize={11} textAnchor="middle" fill="var(--muted)">{nodeName(p)} · retired</text>
          </g>
        ))}
        {f.chain.slice(0, -1).map((c) => <line key={`e${c.p}`} x1={px(c.p) + NW} y1={Y + 17} x2={px(f.chain[inChain.get(c.p)! + 1]!.p) - 2} y2={Y + 17} stroke="var(--muted)" markerEnd="url(#lfx-msq-a)" />)}
        {[...f.chain.map((c) => ({ p: c.p, value: c.value, pend: null as number | null })), ...f.pending.map((q) => ({ p: q.p, value: q.value, pend: q.t }))].map((nd) => {
          const dummy = nd.p === f.head;
          const isLast = nd.p === last && f.lag > 0;
          const y = nd.pend === null ? Y : PY;
          const stroke = nd.pend !== null ? TC[nd.pend] : isLast ? "var(--c4)" : dummy ? "var(--faint)" : "var(--fg)";
          return (
            <g key={nd.p} style={{ transform: `translate(${px(nd.p)}px, ${y}px)`, transition: EASE }}>
              <rect width={NW} height={34} rx={4} fill="var(--bg)" stroke={stroke} strokeWidth={isLast ? 2 : 1.4} strokeDasharray={nd.pend !== null ? "4 3" : undefined} />
              <text x={7} y={14} fontSize={11} fontWeight={600} fill={stroke}>{nodeName(nd.p)}</text>
              <text x={NW - 7} y={27} fontSize={11.5} textAnchor="end" fill={dummy ? "var(--muted)" : "var(--fg)"}>{dummy ? "dummy" : nd.value || valueOf(nd.p)}</text>
              {nd.pend !== null && <text x={NW / 2} y={48} fontSize={10} textAnchor="middle" fill={TC[nd.pend]}>only T{nd.pend} sees it</text>}
            </g>
          );
        })}
        <g style={{ transform: `translate(${px(f.head) + NW / 2}px, 0px)`, transition: EASE }}>
          <text y={11} fontSize={11.5} fontWeight={700} textAnchor="middle" fill="var(--fg)">head</text>
          <line y1={15} y2={Y - 2} stroke="var(--fg)" markerEnd="url(#lfx-msq-h)" />
        </g>
        <g style={{ transform: `translate(${px(f.tail) + NW / 2}px, 0px)`, transition: EASE }}>
          <line y1={Y + 60} y2={Y + 36} stroke={f.lag ? "var(--c4)" : "var(--fg)"} markerEnd="url(#lfx-msq-t)" />
          <text y={Y + 73} fontSize={11.5} fontWeight={700} textAnchor="middle" fill={f.lag ? "var(--c4)" : "var(--fg)"}>tail{f.lag ? " (1 behind)" : ""}</text>
        </g>
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {sc.threads.map((ops, t) => (
          <div key={t} style={{ fontSize: 12, padding: "3px 9px", borderRadius: 999, border: `1.5px solid ${TC[t]}`, background: f.actor === t ? TC[t] : "var(--bg)", color: f.actor === t ? "var(--bg)" : "var(--fg)", transition: "background 0.2s" }}>
            T{t}: {ops.map(opText).join(", ")}{f.results[t]!.length ? ` → ${f.results[t]!.map((x) => x ?? "empty").join(", ")}` : ""}
          </div>
        ))}
      </div>
      <Caption i={pl.i} n={frames.length} tone={f.kind === "help" ? "good" : f.kind === "fail" ? "bad" : undefined}>{f.caption}</Caption>
    </Demo>
  );
}

// ---------------------------------------------------------------- 7. How often threads help

const LAG_SCHEMA = { threads: range({ label: "Threads", min: 1, max: 6, step: 1, default: 4 }) };
const LAG_RUNS = 300;
type LagStats = ReturnType<typeof msqLagStats>;

export function MsqLagDemo() {
  const P = useParams("lfx-lag", LAG_SCHEMA);
  const n = Math.round(P.values.threads);
  const [stats, setStats] = useState<(LagStats | null)[]>(() => Array(6).fill(null));
  useEffect(() => {
    // One thread count per tick, so that the page stays responsive.
    let alive = true;
    const timers = [1, 2, 3, 4, 5, 6].map((k, j) => setTimeout(() => {
      if (!alive) return;
      const s = msqLagStats(k, LAG_RUNS, 1);
      setStats((prev) => prev.map((x, i) => (i === k - 1 ? s : x)));
    }, 20 + 30 * j));
    return () => { alive = false; timers.forEach(clearTimeout); };
  }, []);
  const s = stats[n - 1];
  const bins = stats.map((x, i) => ({ x0: i + 0.6, x1: i + 1.4, y: x ? (100 * x.runsWithHelp) / x.runs : 0 }));
  return (
    <Demo title={`Random schedules: ${LAG_RUNS} runs per thread count`} controls={<Param spec={LAG_SCHEMA.threads} value={P.values.threads} onChange={(v) => P.set("threads", v as number)} />}>
      <Plot x={[0.4, 6.6]} y={[0, 100]} height={180} xTicks={[1, 2, 3, 4, 5, 6]} xLabel="threads (each: enqueue, dequeue, enqueue)" yLabel="% of runs with at least one help" yFormat={(v) => `${v}%`}>
        <Bars bins={bins} color="var(--faint)" opacity={0.6} />
        <Bars bins={[bins[n - 1]!]} color="var(--c1)" opacity={0.9} />
      </Plot>
      <div style={{ marginTop: 8 }}>
        <Stats items={s ? [
          { label: "threads", value: n },
          { label: "runs with a help", value: pct(s.runsWithHelp / s.runs, 0) },
          { label: "helping steps per run", value: (s.helps / s.runs).toFixed(2) },
          { label: "largest tail lag seen", value: `${s.maxLag} node${s.maxLag === 1 ? "" : "s"}` },
          { label: "runs with a violation", value: s.bad },
        ] : [{ label: "threads", value: n }, { label: "status", value: "running…" }]} />
      </div>
    </Demo>
  );
}
