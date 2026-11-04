/** Demos for "Hash indexes": extendible hashing stepper, linear hashing stepper, cost vs load factor. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, range, Plot, Line, Dots, RuleX, RuleY, Legend, pct, useWidth } from "../../kit";
import {
  ExtendibleHash, LinearHash, hashKey, lowBits, staticCost, linearCost, extendibleStats, openAddressingCost,
  linearProbingHit, linearProbingMiss, chainingHit, cuckooMaxLoad, EXT_START, EXT_SEQUENCE, LIN_START, LIN_SEQUENCE, type ExtSnapshot, type ExtEvent, type LinSnapshot, type LinEvent,
} from "../../sims/db/indexes/hash";
import { seg, mono, Note, fx, StepText, StepButtons, useFrames, useChunked } from "./IndexesUi";

const C = { path: "var(--c1)", changed: "var(--c3)", added: "var(--c2)", bad: "var(--c4)", ptr: "var(--c5)" };

// ============================================================================
// Extendible hashing
// ============================================================================

const EXT_MAX_DEPTH = 5;

interface ExtFrame { snap: ExtSnapshot; caption: string; slot?: number; bucket?: number; added?: number; bad?: number; key?: number }

function buildExt(cap: number, keys: number[]) {
  const t = new ExtendibleHash(cap, 1, EXT_MAX_DEPTH);
  for (const k of keys) t.insert(k);
  return t;
}

function extCaption(e: ExtEvent, t: ExtendibleHash, cap: number): string {
  switch (e.t) {
    case "hash": return `hash(${e.key}) ends in …${lowBits(e.h, 8)}. The low ${t.global} bit${t.global === 1 ? "" : "s"} (${lowBits(e.h, t.global)}) select a directory slot.`;
    case "slot": {
      const b = t.dir.find((x) => x.id === e.bucket)!;
      return `Slot ${lowBits(e.slot, t.global)} points to bucket B${e.bucket}, local depth ${b.depth}.`;
    }
    case "put": return `B${e.bucket} has room: store the key. One bucket page read, one written.`;
    case "dup": return "The key is already in the bucket.";
    case "full": return e.local === e.global
      ? `B${e.bucket} is full (${cap} keys). Its local depth ${e.local} equals the global depth, so the directory must double first.`
      : `B${e.bucket} is full. Its local depth ${e.local} is less than the global depth ${e.global}: ${2 ** (e.global - e.local)} slots share it, so only the bucket splits.`;
    case "double": return `The directory doubles to ${2 ** e.global} slots (global depth ${e.global}). Each new slot copies the pointer of the slot that has the same low ${e.global - 1} bits.`;
    case "split": return `Split B${e.bucket} on hash bit ${e.depth - 1}: keys with a 1 in that bit move to the new bucket B${e.into}. Both have local depth ${e.depth}. Try the insert again.`;
    case "overflow": return `The bucket is full at the maximum depth ${EXT_MAX_DEPTH} of this demo, so the key goes on an overflow page.`;
  }
}

export function ExtendibleDemo() {
  const [cap, setCap] = useState(2);
  const [key, setKey] = useState(45);
  const keys = useRef<number[]>([...EXT_START]);
  const tree = useRef<ExtendibleHash | null>(null);
  const nextIdx = useRef(0);
  if (!tree.current || tree.current.cap !== cap) tree.current = buildExt(cap, keys.current);
  const t = tree.current;
  const st = useFrames<ExtFrame>(900);

  const insert = (k: number) => {
    const out: ExtFrame[] = [];
    let f: Omit<ExtFrame, "snap" | "caption"> = { key: k };
    t.listener = (e) => {
      if (e.t === "slot") f = { ...f, slot: e.slot, bucket: e.bucket, added: undefined, bad: undefined };
      if (e.t === "full") f = { ...f, bad: e.bucket };
      if (e.t === "split") f = { ...f, bucket: e.bucket, added: e.into, bad: undefined, slot: undefined };
      if (e.t === "double") f = { ...f, slot: undefined };
      if (e.t === "put") f = { ...f, bad: undefined };
      out.push({ snap: t.snapshot(), caption: extCaption(e, t, cap), ...f });
    };
    const isNew = t.insert(k);
    t.listener = null;
    if (isNew) keys.current.push(k);
    st.start(out);
  };
  const insertNext = () => {
    let i = nextIdx.current, k = EXT_SEQUENCE[i % EXT_SEQUENCE.length]! + 100 * Math.floor(i / EXT_SEQUENCE.length);
    while (t.get(k)) { i++; k = EXT_SEQUENCE[i % EXT_SEQUENCE.length]! + 100 * Math.floor(i / EXT_SEQUENCE.length); }
    nextIdx.current = i + 1;
    insert(k);
  };
  const reset = () => { keys.current = [...EXT_START]; nextIdx.current = 0; tree.current = buildExt(cap, keys.current); st.start([], false); };

  const f = st.cur;
  const snap = f?.snap ?? t.snapshot();
  return (
    <Demo
      title={`Extendible hashing: ${cap} keys per bucket`}
      actions={
        <>
          <button className="btn primary" onClick={() => insert(key)}>Insert {key}</button>
          <button className="btn" onClick={insertNext}>Insert next key</button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Keys per bucket page", min: 1, max: 4, step: 1, default: 2 })} value={cap} onChange={(v) => { setCap(v as number); st.start([], false); }} />
          <Param spec={range({ label: "Key", min: 0, max: 99, step: 1, default: 45 })} value={key} onChange={(v) => setKey(v as number)} />
        </>
      }
    >
      <ExtView snap={snap} f={f} cap={cap} />
      <StepText>{f ? f.caption : "Press Insert or Insert next key. Watch which hash bits pick the slot, and when a bucket splits or the directory doubles."}</StepText>
      <StepButtons st={st} />
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "keys", value: t.size },
          { label: "global depth", value: snap.global },
          { label: "directory slots", value: snap.dir.length },
          { label: "buckets", value: snap.buckets.length },
          { label: "bucket fill", value: pct(snap.buckets.reduce((s, b) => s + b.keys.length, 0) / (snap.buckets.length * cap), 0) },
        ]}
      />
      <div style={{ marginTop: 6 }}><Legend items={[{ label: "slot and bucket on the path", color: C.path }, { label: "full bucket", color: C.bad }, { label: "new bucket", color: C.added }, { label: "bits that decide (local depth)", color: C.changed }]} /></div>
    </Demo>
  );
}

function ExtView({ snap, f, cap }: { snap: ExtSnapshot; f?: ExtFrame; cap: number }) {
  const slots = snap.dir.length, nb = snap.buckets.length;
  const sh = 18, bh = 34;
  const H = Math.max(slots * sh, nb * bh) + 4;
  const slotY = (i: number) => 2 + (i + 0.5) * (H - 4) / slots;
  const bY = (i: number) => 2 + (i + 0.5) * (H - 4) / nb;
  const order = new Map(snap.buckets.map((b, i) => [b.id, i]));
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const W = Math.max(280, Math.min(760, width)), narrow = W < 520;
  const dx = 2, dw = narrow ? 54 : 92, bx = narrow ? dw + 34 : 240, lab = narrow ? 40 : 62;
  const cellW = Math.min(84, (W - bx - lab - 4) / cap);
  return (
    <div ref={ref} style={{ width: "100%" }}>
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: "block", maxWidth: "100%", ...mono }}>
      {snap.dir.map((bid, i) => {
        const on = f?.slot === i;
        return (
          <g key={`l${i}`}>
            <line x1={dx + dw} y1={slotY(i)} x2={bx} y2={bY(order.get(bid)!)} stroke={on ? C.path : "var(--border)"} strokeWidth={on ? 2 : 1} />
          </g>
        );
      })}
      {snap.dir.map((_, i) => {
        const on = f?.slot === i;
        return (
          <g key={`s${i}`}>
            <rect x={dx} y={slotY(i) - sh / 2 + 1.5} width={dw} height={sh - 3} rx={3} fill={on ? C.path : "var(--subtle)"} stroke="var(--border)" />
            <text x={dx + dw / 2} y={slotY(i)} dy="0.35em" textAnchor="middle" fontSize={11} fill={on ? "#fff" : "var(--fg)"}>{lowBits(i, snap.global) || "·"}</text>
          </g>
        );
      })}
      {snap.buckets.map((b, i) => {
        const y = bY(i);
        const stroke = f?.bad === b.id ? C.bad : f?.added === b.id ? C.added : f?.bucket === b.id ? C.path : "var(--border)";
        return (
          <g key={b.id}>
            <rect x={bx} y={y - bh / 2 + 2} width={W - bx - 2} height={bh - 4} rx={4} fill="var(--bg)" stroke={stroke} strokeWidth={stroke === "var(--border)" ? 1 : 2} />
            <text x={bx + 8} y={y - 3} fontSize={11} fill="var(--fg)" fontWeight={600}>B{b.id}</text>
            <text x={bx + 8} y={y + 10} fontSize={10} fill="var(--muted)">d={b.depth}</text>
            {Array.from({ length: Math.max(cap, b.keys.length) }, (_, j) => {
              const k = b.keys[j];
              const x = bx + lab + j * cellW;
              if (x + cellW > W) return null;
              const bits = k === undefined ? "" : lowBits(hashKey(k), snap.global);
              const lo = bits.slice(bits.length - b.depth), hi = bits.slice(0, bits.length - b.depth);
              return (
                <g key={j}>
                  <rect x={x} y={y - bh / 2 + 5} width={cellW - 4} height={bh - 10} rx={3} fill={k === f?.key && k !== undefined ? "var(--subtle)" : "none"} stroke={j >= cap ? C.bad : "var(--border)"} strokeDasharray={k === undefined ? "3 3" : undefined} />
                  {k !== undefined && (
                    <>
                      <text x={x + 5} y={y - 1} fontSize={11} fill="var(--fg)">{k}</text>
                      <text x={x + cellW - 8} y={y + 10} fontSize={9.5} textAnchor="end">
                        <tspan fill="var(--faint)">{hi}</tspan><tspan fill={C.changed} fontWeight={700}>{lo}</tspan>
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
    </div>
  );
}

// ============================================================================
// Linear hashing
// ============================================================================


interface LinFrame { snap: LinSnapshot; caption: string; hl?: number; added?: number; key?: number; split?: number }

function buildLin(cap: number, maxLoad: number, keys: number[]) {
  const t = new LinearHash(cap, maxLoad, 2);
  for (const k of keys) t.insert(k);
  return t;
}

export function LinearHashDemo() {
  const [cap, setCap] = useState(2);
  const [maxLoad, setMaxLoad] = useState(0.75);
  const keys = useRef<number[]>([...LIN_START]);
  const tree = useRef<LinearHash | null>(null);
  const nextIdx = useRef(0);
  if (!tree.current || tree.current.cap !== cap || tree.current.maxLoad !== maxLoad) tree.current = buildLin(cap, maxLoad, keys.current);
  const t = tree.current;
  const st = useFrames<LinFrame>(950);

  const insert = (k: number) => {
    const out: LinFrame[] = [];
    t.listener = (e: LinEvent) => {
      const snap = t.snapshot();
      const M = t.n0 * 2 ** t.level;
      switch (e.t) {
        case "hash": {
          const a = e.h % M;
          out.push({ snap, key: k, hl: e.addr, caption: e.usedNext
            ? `hash(${k}) mod ${M} = ${a}. Bucket ${a} is before the split pointer (${t.next}), so it has split this round: use mod ${2 * M} = ${e.addr}.`
            : `hash(${k}) mod ${M} = ${a}. Bucket ${a} is at or after the split pointer (${t.next}), so use it.` });
          break;
        }
        case "put": out.push({ snap, key: k, hl: e.bucket, caption: e.overflow ? `Bucket ${e.bucket} is full, so the key goes on a new overflow page in its chain.` : `Store ${k} in bucket ${e.bucket}.` }); break;
        case "dup": out.push({ snap, key: k, hl: e.bucket, caption: "The key is already there." }); break;
        case "trigger": out.push({ snap, key: k, split: t.next, caption: `Load factor ${pct(e.load, 0)} > ${pct(maxLoad, 0)}. Split the bucket at the split pointer (bucket ${t.next}), not the bucket that just grew.` }); break;
        case "split": out.push({ snap, key: k, hl: e.bucket, added: e.into, caption: `Rehash bucket ${e.bucket} with mod ${2 * M}: ${e.moved.length ? `${e.moved.join(", ")} move${e.moved.length === 1 ? "s" : ""}` : "no key moves"} to new bucket ${e.into}. The split pointer moves on.` }); break;
        case "round": out.push({ snap, key: k, caption: `All ${M / 2} buckets of the round have split. Start round ${e.level}: ${M} buckets, split pointer back to 0.` }); break;
      }
    };
    const isNew = t.insert(k);
    t.listener = null;
    if (isNew) keys.current.push(k);
    st.start(out);
  };
  const insertNext = () => {
    let i = nextIdx.current, k = LIN_SEQUENCE[i % LIN_SEQUENCE.length]! + 100 * Math.floor(i / LIN_SEQUENCE.length);
    while (t.get(k)) { i++; k = LIN_SEQUENCE[i % LIN_SEQUENCE.length]! + 100 * Math.floor(i / LIN_SEQUENCE.length); }
    nextIdx.current = i + 1;
    insert(k);
  };
  const reset = () => { keys.current = [...LIN_START]; nextIdx.current = 0; tree.current = buildLin(cap, maxLoad, keys.current); st.start([], false); };

  const f = st.cur;
  const snap = f?.snap ?? t.snapshot();
  const M = snap.n0 * 2 ** snap.level;
  const size = snap.buckets.reduce((s, b) => s + b.length, 0);
  const overflow = snap.buckets.reduce((s, b) => s + Math.max(0, Math.ceil(b.length / snap.cap) - 1), 0);
  return (
    <Demo
      title="Linear hashing: one bucket splits at a time"
      actions={
        <>
          <button className="btn primary" onClick={insertNext}>Insert next key</button>
          <button className="btn ghost" onClick={reset}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Keys per bucket page", min: 1, max: 4, step: 1, default: 2 })} value={cap} onChange={(v) => { setCap(v as number); st.start([], false); }} />
          <Param spec={range({ label: "Split when load factor passes", min: 0.5, max: 1.5, step: 0.05, default: 0.75, format: (v) => pct(v, 0) })} value={maxLoad} onChange={(v) => { setMaxLoad(v as number); st.start([], false); }} />
        </>
      }
    >
      <div style={{ ...mono, fontSize: 12, marginBottom: 8 }} className="muted">
        round {snap.level}: h₀ = hash mod {M}, h₁ = hash mod {2 * M}. {snap.next === 0 ? "No bucket has split in this round, so all use h₀." : `Buckets 0…${snap.next - 1} have split and use h₁; the rest use h₀.`}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-start" }}>
        {snap.buckets.map((b, i) => {
          const pages = Math.max(1, Math.ceil(b.length / snap.cap));
          const isNext = i === snap.next;
          const stroke = f?.added === i ? C.added : f?.hl === i ? C.path : f?.split === i ? C.bad : "var(--border)";
          return (
            <div key={i} style={{ width: 22 + 22 * snap.cap, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 3 }}>
              <div style={{ ...mono, fontSize: 10.5, textAlign: "center", color: i >= M ? "var(--c2)" : i < snap.next ? "var(--muted)" : "var(--fg)" }}>b{i}</div>
              {Array.from({ length: pages }, (_, p) => (
                <div key={p} style={{ display: "flex", gap: 2, padding: 2, borderRadius: 4, border: `${stroke === "var(--border)" ? 1 : 2}px solid ${stroke}`, borderStyle: p > 0 ? "dashed" : "solid", background: p > 0 ? "var(--subtle)" : "var(--bg)" }}>
                  {Array.from({ length: snap.cap }, (_, j) => {
                    const k = b[p * snap.cap + j];
                    return <span key={j} style={{ ...mono, flex: 1, fontSize: 10.5, textAlign: "center", minHeight: 16, borderRadius: 2, background: k !== undefined && k === f?.key ? "var(--c1)" : "transparent", color: k !== undefined && k === f?.key ? "#fff" : "var(--fg)" }}>{k ?? "·"}</span>;
                  })}
                </div>
              ))}
              <div style={{ ...mono, fontSize: 10, textAlign: "center", color: "var(--c5)", minHeight: 14 }}>{isNext ? "▲ next" : ""}</div>
            </div>
          );
        })}
      </div>
      <StepText>{f ? f.caption : "Press Insert next key. A full bucket gets an overflow page. A split happens only when the load factor passes the limit, and always at the split pointer."}</StepText>
      <StepButtons st={st} />
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "keys", value: size },
          { label: "buckets", value: snap.buckets.length },
          { label: "split pointer", value: snap.next },
          { label: "load factor", value: pct(size / (snap.buckets.length * snap.cap), 0) },
          { label: "overflow pages", value: overflow },
        ]}
      />
      <Note>Dashed boxes are overflow pages. Grey bucket numbers have split in this round; orange ones were made in this round. No directory exists: the address comes from two hash functions and the split pointer.</Note>
    </Demo>
  );
}

// ============================================================================
// Cost against load factor
// ============================================================================

const DISK_ALPHAS = Array.from({ length: 19 }, (_, i) => 0.2 + i * 0.1);
const MEM_ALPHAS = Array.from({ length: 19 }, (_, i) => 0.05 + i * 0.05);

export function HashCostDemo() {
  const [mode, setMode] = useState<"disk" | "memory">("disk");
  const [cap, setCap] = useState<"1" | "4" | "16">("4");
  const [kind, setKind] = useState<"hit" | "miss">("hit");
  const [alpha, setAlpha] = useState(0.8);
  const b = Number(cap);
  const staticPts = useChunked(`s${b}`, DISK_ALPHAS.map((a) => () => staticCost(a, b, 256)));
  const linPts = useChunked(`l${b}`, DISK_ALPHAS.map((a) => () => linearCost(a, b, 6000)));
  const ext = useChunked(`e${b}`, [() => extendibleStats(6000, b, 7, 18)])[0];
  const lp = useChunked("lp", MEM_ALPHAS.map((a) => () => openAddressingCost("linear", a, 1 << 12)));
  const rh = useChunked("rh", MEM_ALPHAS.map((a) => () => openAddressingCost("robinhood", a, 1 << 12)));
  const cuckoo = useMemo(() => cuckooMaxLoad(1 << 12), []);
  const pick = (p: { hit: number; miss: number } | undefined) => (p ? (kind === "hit" ? p.hit : p.miss) : NaN);
  const near = <T extends { alpha: number }>(xs: (T | undefined)[], grid: number[]) => {
    let bi = 0;
    grid.forEach((g, i) => { if (Math.abs(g - alpha) < Math.abs(grid[bi]! - alpha)) bi = i; });
    return xs[bi];
  };
  const disk = mode === "disk";
  const yMax = disk ? 3 : kind === "hit" ? 8 : 30;
  const aMin = disk ? 0.2 : 0.05, aMax = disk ? 2 : 0.95;
  const a = Math.min(aMax, Math.max(aMin, alpha));
  return (
    <Demo
      title={disk ? "Bucket pages read per lookup" : "Slots probed per lookup in memory"}
      controls={
        <>
          <Param spec={range({ label: "Load factor (marker)", min: 0.05, max: 2, step: 0.05, default: 0.8, format: (v) => pct(v, 0) })} value={alpha} onChange={(v) => setAlpha(v as number)} />
          <Param spec={seg<"disk" | "memory">("Where", [["disk", "on disk: pages"], ["memory", "in memory: slots"]], "disk")} value={mode} onChange={(v) => setMode(v as "disk" | "memory")} />
          <Param spec={seg<"hit" | "miss">("Lookups", [["hit", "key present"], ["miss", "key absent"]], "hit")} value={kind} onChange={(v) => setKind(v as "hit" | "miss")} />
          {disk && <Param spec={seg<"1" | "4" | "16">("Keys per bucket page", [["1", "1"], ["4", "4"], ["16", "16"]], "4")} value={cap} onChange={(v) => setCap(v as "1" | "4" | "16")} />}
        </>
      }
    >
      <Plot x={[aMin, aMax]} y={[disk ? 0.95 : 0, yMax]} height={260} xLabel="load factor α (keys / slots)" yLabel={disk ? "pages per lookup" : "probes per lookup"} xFormat={(v) => pct(v, 0)}>
        <RuleX at={a} />
        {disk ? (
          <>
            <RuleY at={1} color="var(--c3)" />
            <Line points={staticPts.flatMap((p) => (p ? [[p.alpha, pick(p)] as const] : []))} color="var(--c4)" />
            <Dots points={staticPts.flatMap((p) => (p ? [[p.alpha, pick(p)] as const] : []))} color="var(--c4)" r={2.5} />
            <Line points={linPts.flatMap((p) => (p ? [[p.alpha, pick(p)] as const] : []))} color="var(--c1)" />
            <Dots points={linPts.flatMap((p) => (p ? [[p.alpha, pick(p)] as const] : []))} color="var(--c1)" r={2.5} />
            {ext && <Dots points={[[ext.utilization, 1]]} color="var(--c3)" r={5} />}
          </>
        ) : (
          <>
            <Line points={MEM_ALPHAS.map((x) => [x, kind === "hit" ? linearProbingHit(x) : linearProbingMiss(x)] as const)} color="var(--c4)" dash="5 4" width={1.4} />
            <Line points={lp.flatMap((p) => (p ? [[p.alpha, pick(p)] as const] : []))} color="var(--c4)" />
            <Line points={rh.flatMap((p) => (p ? [[p.alpha, pick(p)] as const] : []))} color="var(--c1)" />
            <Line points={MEM_ALPHAS.map((x) => [x, kind === "hit" ? chainingHit(x) : x] as const)} color="var(--c3)" width={1.4} />
            <Line points={[[0.05, 2], [cuckoo, 2]]} color="var(--c5)" width={2.5} />
            <RuleX at={cuckoo} color="var(--c5)" label="cuckoo fails" />
          </>
        )}
      </Plot>
      <Legend
        items={disk
          ? [{ label: "static hashing, overflow chains", color: "var(--c4)" }, { label: "linear hashing, split at α", color: "var(--c1)" }, { label: `extendible: 1 page with the directory in memory; buckets ${ext ? pct(ext.utilization, 0) : "…"} full (dot)`, color: "var(--c3)" }]
          : [{ label: "linear probing: measured, Knuth (dashed)", color: "var(--c4)" }, { label: "Robin Hood", color: "var(--c1)" }, { label: kind === "hit" ? "chaining: 1 + α/2" : "chaining: α", color: "var(--c3)" }, { label: "cuckoo: at most 2", color: "var(--c5)" }]}
      />
      <div style={{ height: 8 }} />
      {disk ? (
        <Stats
          items={[
            { label: `static at α ≈ ${pct(a, 0)}`, value: fx(pick(near(staticPts, DISK_ALPHAS)), 2) },
            { label: `linear hashing at α ≈ ${pct(Math.min(a, 2), 0)}`, value: fx(pick(near(linPts, DISK_ALPHAS)), 2) },
            { label: "extendible: directory slots / buckets", value: ext ? `${ext.capped ? "≥ " : ""}${ext.dirSlots.toLocaleString("en-US")} / ${ext.buckets.toLocaleString("en-US")}` : "…" },
          ]}
        />
      ) : (
        <Stats
          items={[
            { label: `linear probing at α ≈ ${pct(a, 0)}`, value: fx(pick(near(lp, MEM_ALPHAS)), 2) },
            { label: "Robin Hood", value: fx(pick(near(rh, MEM_ALPHAS)), 2) },
            { label: "longest probe: linear / Robin Hood", value: `${near(lp, MEM_ALPHAS)?.maxHit ?? "…"} / ${near(rh, MEM_ALPHAS)?.maxHit ?? "…"}` },
            { label: "cuckoo: first failed insert at α", value: pct(cuckoo, 1) },
          ]}
        />
      )}
      <Note>{disk
        ? "Measured with random keys: static hashing with 256 buckets, linear hashing with 6,000 keys, extendible hashing with 6,000 keys. A miss must read the whole chain."
        : "Measured with 4,096 slots. Cuckoo here uses two tables with one key per slot. Real cuckoo tables use buckets of 4 or 8 slots and fill much more."}</Note>
    </Demo>
  );
}
