import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, Legend, range, select, toggle, useSim, useWidth, pct } from "../kit";
import {
  alignUp, bumpRun, structLayout, fieldsOf, C_TYPES, type BumpReq, type CType, type StructLayout,
  frameLoop, chunkWaste, PoolSim, type Handle, protectPtr, revealPtr, passesAlignCheck, forgedPassRate,
  FreeListSim, presetHeap, blockNeed, FITS, FL_HEADER, type Fit, type SearchTrace, type Verdict,
  headerWord, headerSize, headerAllocated,
} from "../sims/allocextrasA";

const mono: CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 };
const HATCH = (c: string) => `repeating-linear-gradient(135deg, var(${c}) 0 2px, transparent 2px 5px)`;
const hex2 = (n: number) => "0x" + n.toString(16).padStart(2, "0");
const bin8 = (n: number) => (n & 0xff).toString(2).padStart(8, "0");
const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

// ================================================================ bump pointer stepper

const BUMP_CAP = 96;
const LIVE_COLORS = ["--c1", "--c3", "--c5"];

/** One cell per byte. Colors: block payload, alignment padding, bytes before the start of top. */
function ByteGrid({ cap, cols, cell }: { cap: number; cols: number; cell: (i: number) => { bg: string; text?: string; ring?: string; fg?: string; title?: string } }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `30px repeat(${cols}, minmax(0, 1fr))`, gap: 2 }}>
      {Array.from({ length: cap }, (_, i) => {
        const c = cell(i);
        return (
          <FragmentRow key={i} i={i} cols={cols}>
            <div title={c.title ?? `byte ${i}`} style={{ height: 22, borderRadius: 3, background: c.bg, outline: c.ring ? `2px solid var(${c.ring})` : undefined, outlineOffset: -1, display: "grid", placeItems: "center", fontSize: 10, fontWeight: 600, color: c.fg ?? "#fff", transition: "background 0.25s", overflow: "hidden" }}>{c.text}</div>
          </FragmentRow>
        );
      })}
    </div>
  );
}
function FragmentRow({ i, cols, children }: { i: number; cols: number; children: ReactNode }) {
  return (
    <>
      {i % cols === 0 && <div style={{ ...mono, fontSize: 9.5, color: "var(--muted)", alignSelf: "center" }}>{hex2(i)}</div>}
      {children}
    </>
  );
}

const SIZES = ["1", "2", "4", "8", "12", "16"];
const ALIGNS = ["1", "2", "4", "8", "16"];
const START: BumpReq[] = [
  { size: 1, align: 1, label: "a" }, { size: 8, align: 8, label: "b" }, { size: 1, align: 1, label: "c" }, { size: 8, align: 8, label: "d" },
];

export function BumpStepperDemo() {
  const [base, setBase] = useState(0);
  const [size, setSize] = useState("8");
  const [align, setAlign] = useState("8");
  const [reqs, setReqs] = useState<BumpReq[]>(START);
  const [msg, setMsg] = useState<string | null>(null);
  const run = bumpRun(reqs, base);
  const last = run.blocks.at(-1);

  const owner = new Int16Array(BUMP_CAP).fill(-1); // -1 nothing, -2 padding, k block k
  run.blocks.forEach((b, k) => {
    for (let i = b.start; i < b.addr && i < BUMP_CAP; i++) owner[i] = -2;
    for (let i = b.addr; i < b.addr + b.size && i < BUMP_CAP; i++) owner[i] = k;
  });

  const allocate = () => {
    const s = Number(size), a = Number(align);
    const addr = alignUp(run.top, a);
    if (addr + s > BUMP_CAP) { setMsg(`alloc(${s}, align ${a}) returns null: the buffer ends at byte ${BUMP_CAP}.`); return; }
    setMsg(null);
    setReqs([...reqs, { size: s, align: a, label: String.fromCharCode(97 + (reqs.length % 26)) }]);
  };

  return (
    <Demo
      title={`Bump pointer, byte by byte · ${BUMP_CAP} B buffer`}
      actions={
        <>
          <button className="btn primary" onClick={allocate}>Allocate {size} B</button>
          <button className="btn" disabled={!reqs.length} onClick={() => { setMsg(null); setReqs(reqs.slice(0, -1)); }}>Free last</button>
          <button className="btn ghost" onClick={() => { setMsg(null); setReqs([]); }}>Reset</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Top starts at byte", min: 0, max: 15, step: 1, default: 0 })} value={base} onChange={(v) => setBase(v as number)} />
          <Param spec={select({ label: "Size", options: SIZES.map((v) => ({ value: v, label: `${v} B` })), default: "8", segmented: true })} value={size} onChange={(v) => setSize(v as string)} />
          <Param spec={select({ label: "Alignment", options: ALIGNS.map((v) => ({ value: v, label: v })), default: "8", segmented: true })} value={align} onChange={(v) => setAlign(v as string)} />
        </>
      }
    >
      <ByteGrid
        cap={BUMP_CAP}
        cols={16}
        cell={(i) => {
          const o = owner[i]!;
          const ring = i === run.top ? "--c4" : undefined;
          if (o >= 0) {
            const b = run.blocks[o]!;
            return { bg: `var(${LIVE_COLORS[o % 3]})`, text: i === b.addr ? b.label : undefined, ring, title: `block ${b.label}: ${b.size} B at byte ${b.addr}` };
          }
          if (o === -2) return { bg: HATCH("--c2"), ring, title: "alignment padding" };
          if (i < base) return { bg: "var(--border)", ring, title: "used before this demo started" };
          return { bg: "var(--subtle)", text: i === run.top ? "top" : undefined, fg: "var(--c4)", ring };
        }}
      />
      <Legend items={[{ label: "block", color: "var(--c1)" }, { label: "alignment padding", color: "var(--c2)" }, { label: "top (next free byte)", color: "var(--c4)" }]} />
      <div style={{ ...mono, marginTop: 10, lineHeight: 1.7, overflowX: "auto" }}>
        {last ? (
          <>
            <div>alloc({last.size}, align {last.align}) with top = {last.start}</div>
            <div>align_up({last.start}, {last.align}) = ({last.start} + {last.align - 1}) & ~{last.align - 1} = <b>{last.addr}</b></div>
            <div className="muted">binary: {bin8(last.start + last.align - 1)} & {bin8(~(last.align - 1))} = {bin8(last.addr)}</div>
            <div>padding {last.pad} B · new top = {last.addr} + {last.size} = <b>{run.top}</b></div>
          </>
        ) : <div className="muted">The buffer is empty. top = {base}.</div>}
        {msg && <div style={{ color: "var(--c4)" }}>{msg}</div>}
      </div>
      <Stats items={[
        { label: "top", value: run.top },
        { label: "bytes requested", value: run.data },
        { label: "padding bytes", value: run.pad },
        { label: "padding share", value: run.top - base ? pct(run.pad / (run.top - base), 0) : "–" },
      ]} />
    </Demo>
  );
}

// ================================================================ struct layout

const PRESETS: { label: string; types: CType[] }[] = [
  { label: "char, double, char, double", types: ["char", "double", "char", "double"] },
  { label: "double, char", types: ["double", "char"] },
  { label: "char, int, char, short, ptr", types: ["char", "int", "char", "short", "ptr"] },
];

function LayoutStrip({ title, l }: { title: string; l: StructLayout }) {
  const rows = Math.max(1, l.size / 8);
  const cells: { bg: string; text?: string; fg?: string }[] = [];
  l.blocks.forEach((b, k) => {
    for (let i = 0; i < b.pad; i++) cells.push({ bg: HATCH("--c2") });
    for (let i = 0; i < b.size; i++) cells.push({ bg: `var(${LIVE_COLORS[k % 3]})`, text: i === 0 ? b.label?.split(":")[0] : undefined });
  });
  for (let i = 0; i < l.tail; i++) cells.push({ bg: HATCH("--c4") });
  return (
    <div style={{ flex: "1 1 220px", minWidth: 0 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 2 }}>
        {cells.slice(0, rows * 8).map((c, i) => (
          <div key={i} style={{ height: 22, borderRadius: 3, background: c.bg, color: c.fg ?? "#fff", fontSize: 10.5, fontWeight: 600, display: "grid", placeItems: "center" }}>{c.text}</div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        order: {l.blocks.map((b) => b.label?.split(":")[0]).join(", ")}
        <br />sizeof = <b style={{ color: "var(--fg)" }}>{l.size} B</b> · {l.pad} B inside · {l.tail} B at the end
      </div>
    </div>
  );
}

export function StructLayoutDemo() {
  const [types, setTypes] = useState<CType[]>(PRESETS[0]!.types);
  const fields = fieldsOf(types);
  const c = structLayout(fields, false);
  const r = structLayout(fields, true);
  return (
    <Demo title="Struct layout is a bump allocator over the fields">
      <div className="row" style={{ marginBottom: 8 }}>
        {PRESETS.map((p) => <button key={p.label} className="btn" onClick={() => setTypes(p.types)}>{p.label}</button>)}
      </div>
      <div className="row" style={{ marginBottom: 12, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Add a field:</span>
        {(Object.keys(C_TYPES) as CType[]).map((t) => (
          <button key={t} className="btn" disabled={types.length >= 8} onClick={() => setTypes([...types, t])}>{t}</button>
        ))}
        <button className="btn ghost" disabled={!types.length} onClick={() => setTypes(types.slice(0, -1))}>Remove last</button>
      </div>
      <div style={{ ...mono, marginBottom: 12, overflowWrap: "anywhere" }}>struct {"{"} {fields.map((f) => f.label!.split(": ").reverse().join(" ")).join("; ")}{fields.length ? ";" : ""} {"}"}</div>
      {types.length ? (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <LayoutStrip title="Declaration order (C, C++, Odin, Zig extern struct)" l={c} />
          <LayoutStrip title="Sorted by alignment (Rust and Zig may do this)" l={r} />
        </div>
      ) : <div className="muted">Add a field.</div>}
      <Legend items={[{ label: "field", color: "var(--c1)" }, { label: "padding between fields", color: "var(--c2)" }, { label: "tail padding", color: "var(--c4)" }]} />
      <Note>Each row is 8 bytes. A field with alignment 8 must start at the left edge of a row.</Note>
      {types.length > 0 && <Stats items={[
        { label: "data bytes", value: c.data },
        { label: "array of 4, declaration order", value: `${4 * c.size} B` },
        { label: "array of 4, sorted", value: `${4 * r.size} B` },
      ]} />}
    </Demo>
  );
}

// ================================================================ arena lifetimes

const FRAMES = 16;
const FRAME_CHUNK = 1024;
const lifeSchema = {
  reset: select({ label: "Reset the arena", options: [{ value: "1", label: "Every frame" }, { value: "4", label: "Every 4 frames" }, { value: "0", label: "Never" }], default: "1", segmented: true }),
};

export function ArenaLifetimesDemo() {
  const [perFrame, setPerFrame] = useState(20);
  const [reset, setReset] = useState("1");
  const [keep, setKeep] = useState(true);
  const steps = useMemo(() => frameLoop({ frames: FRAMES, perFrame: Math.round(perFrame), chunk: FRAME_CHUNK, resetEvery: Number(reset), keepChunks: keep }), [perFrame, reset, keep]);
  const frame = useRef(1);
  const [, force] = useState(0);
  const sim = useSim({ dt: 1 / 2.5, autoplay: false, step: () => { frame.current = frame.current >= FRAMES ? 1 : frame.current + 1; force((x) => x + 1); }, reset: () => { frame.current = 1; } });
  const f = Math.min(frame.current, FRAMES);
  const cur = steps[f - 1]!;
  const yMax = Math.max(...steps.map((s) => s.reserved)) * 1.08;
  const shown = steps.slice(0, f);
  const resetsNow = Number(reset) > 0 && f % Number(reset) === 0;
  const box = cur.chunks.length > 24 ? 20 : 30;

  return (
    <Demo
      title={`A game loop with a frame arena · ${FRAME_CHUNK} B chunks`}
      actions={
        <>
          <button className="btn" onClick={sim.toggle}>{sim.running ? "Pause" : "Play"}</button>
          <button className="btn" disabled={sim.running} onClick={() => { frame.current = frame.current >= FRAMES ? 1 : frame.current + 1; force((x) => x + 1); }}>Next frame</button>
          <button className="btn ghost" onClick={sim.reset}>Restart</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Temporary objects per frame", min: 4, max: 60, step: 1, default: 20 })} value={perFrame} onChange={(v) => setPerFrame(v as number)} />
          <Param spec={lifeSchema.reset} value={reset} onChange={(v) => setReset(v as string)} />
          <Param spec={toggle({ label: "Keep the chunks after a reset", default: true })} value={keep} onChange={(v) => setKeep(v as boolean)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        Frame {f}: chunks at the end of the frame (fill = bytes in use){resetsNow ? " · then one reset frees all of it" : ""}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, minHeight: 34, marginBottom: 12 }}>
        {cur.chunks.map((c, i) => (
          <div key={i} title={`chunk ${i + 1}: ${c.used} of ${c.len} B used`} style={{ width: box * (c.len / FRAME_CHUNK), height: box, borderRadius: 4, border: "1px solid var(--border)", background: "var(--subtle)", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: `${(100 * c.used) / c.len}%`, background: "var(--c1)", opacity: 0.85, transition: "height 0.3s" }} />
          </div>
        ))}
        {!cur.chunks.length && <span className="muted" style={{ fontSize: 12 }}>no chunks</span>}
      </div>
      <Plot x={[1, FRAMES]} y={[0, yMax]} height={200} xLabel="frame" yLabel="bytes" xTicks={[1, 4, 8, 12, 16]}>
        <Line points={shown.map((s) => [s.frame, s.reserved] as const)} color="var(--c2)" />
        <Line points={shown.map((s) => [s.frame, s.live] as const)} color="var(--c1)" />
        <RuleX at={f} />
      </Plot>
      <Legend items={[{ label: "held from the backing allocator", color: "var(--c2)" }, { label: "in use at the end of the frame", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "held now", value: `${cur.reserved} B` },
        { label: "backing calls so far", value: cur.backingCalls },
        { label: "free() calls with malloc", value: cur.mallocFrees },
        { label: "arena resets", value: cur.resets + (resetsNow ? 1 : 0) },
      ]} />
    </Demo>
  );
}

// ================================================================ chunk size vs waste

const CHUNKS = [128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384];

export function ChunkWasteDemo() {
  const [s, setS] = useState(64);
  const mean = Math.round(s);
  const pts = useMemo(() => CHUNKS.map((c) => chunkWaste(c, mean)), [mean]);
  const at4k = pts.find((p) => p.chunk === 4096)!;
  return (
    <Demo
      title="How chunk size decides the waste"
      controls={<Param spec={range({ label: "Average allocation size s", min: 8, max: 512, log: true, default: 64, format: (v) => `${Math.round(v)} B` })} value={s} onChange={(v) => setS(v as number)} />}
    >
      <Plot x={[128, 16384]} y={[0, 0.5]} logX height={230} xLabel="chunk size C (bytes)" yLabel="share of the chunk wasted" yFormat={(v) => `${Math.round(v * 100)}%`} xTicks={[128, 512, 2048, 8192]}>
        <Line points={pts.map((p) => [p.chunk, Math.min(0.5, p.estimate)] as const)} color="var(--c2)" dash="5 4" />
        <Line points={pts.map((p) => [p.chunk, p.wasteFrac] as const)} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: "measured: headers + abandoned tails", color: "var(--c1)" }, { label: "estimate (16 + s/2) / C", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "measured, C = 4 KiB", value: pct(at4k.wasteFrac) },
        { label: "estimate, C = 4 KiB", value: pct(at4k.estimate) },
        { label: "sizes drawn from", value: `1 to ${2 * mean - 1} B` },
      ]} />
    </Demo>
  );
}

// ================================================================ pool free list

export function PoolFreeListDemo() {
  const [n, setN] = useState(8);
  const pool = useRef(new PoolSim(8));
  const [handles, setHandles] = useState<Handle[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [, force] = useState(0);
  const say = (s: string) => setLog((l) => [...l, s].slice(-3));
  const [ref, w] = useWidth<HTMLDivElement>();
  useEffect(() => { pool.current = new PoolSim(n); setHandles([]); setLog([]); force((x) => x + 1); }, [n]);
  const p = pool.current;
  const order = p.freeOrder();
  const rank = new Map(order.map((i, k) => [i, k]));

  const alloc = () => {
    const before = p.head;
    const h = p.alloc();
    if (!h) { say("alloc() returns null: the free list is empty."); return; }
    say(`alloc(): p = head (slot ${before}); head = *p (${p.head < 0 ? "null" : `slot ${p.head}`}) → ${h.name}`);
    setHandles((hs) => [...hs, h].slice(-8));
    force((x) => x + 1);
  };
  const free = (i: number) => {
    const name = p.owner[i];
    const before = p.head;
    if (!p.free(i)) return;
    say(`free(${name}): *p = head (${before < 0 ? "null" : `slot ${before}`}); head = p (slot ${i})`);
    force((x) => x + 1);
  };
  const freeRandom = () => {
    const live = p.owner.map((o, i) => (o ? i : -1)).filter((i) => i >= 0);
    if (live.length) free(live[(live.length * 7 + log.length * 3) % live.length]!);
  };

  const pad = 8, sw = (w - 2 * pad) / p.n, top = 64, sh = 54;
  const cx = (i: number) => pad + (i + 0.5) * sw;
  return (
    <Demo
      title="Pool allocator: the free list lives inside the free slots"
      actions={
        <>
          <button className="btn primary" onClick={alloc}>Allocate</button>
          <button className="btn" onClick={freeRandom}>Free one</button>
          <button className="btn ghost" onClick={() => { pool.current = new PoolSim(n); setHandles([]); setLog([]); force((x) => x + 1); }}>Reset</button>
        </>
      }
      controls={<Param spec={range({ label: "Slots", min: 4, max: 12, step: 1, default: 8 })} value={n} onChange={(v) => setN(v as number)} />}
    >
      <div ref={ref}>
        <svg width={w} height={top + sh + 20} style={{ display: "block" }}>
          <defs>
            <marker id="poolArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--c4)" />
            </marker>
          </defs>
          {order.map((i, k) => {
            const j = order[k + 1];
            if (j === undefined) return null;
            const x1 = cx(i), x2 = cx(j), d = Math.abs(j - i);
            const ty = Math.max(6, top - 10 - d * 7);
            return <path key={`${i}-${j}`} d={`M${x1} ${top - 2} Q ${(x1 + x2) / 2} ${ty} ${x2 + (x2 > x1 ? -3 : 3)} ${top - 2}`} fill="none" stroke="var(--c4)" strokeWidth={1.4} opacity={0.85} markerEnd="url(#poolArrow)" />;
          })}
          {Array.from({ length: p.n }, (_, i) => {
            const owner = p.owner[i];
            const isHead = i === p.head;
            const nx = p.next[i]!;
            return (
              <g key={i} style={{ cursor: owner ? "pointer" : "default" }} onClick={() => owner && free(i)}>
                <rect x={pad + i * sw + 2} y={top} width={sw - 4} height={sh} rx={5} fill={owner ? "var(--c1)" : "var(--subtle)"} stroke={isHead ? "var(--c4)" : "var(--border)"} strokeWidth={isHead ? 2 : 1} />
                {owner ? (
                  <>
                    <text x={cx(i)} y={top + 24} textAnchor="middle" fontSize={15} fontWeight={700} fill="#fff">{owner}</text>
                    <text x={cx(i)} y={top + 41} textAnchor="middle" fontSize={9.5} fill="#fff" opacity={0.85}>gen {p.gen[i]}</text>
                  </>
                ) : (
                  <>
                    <text x={cx(i)} y={top + 20} textAnchor="middle" fontSize={9} fill="var(--muted)">next</text>
                    <text x={cx(i)} y={top + 36} textAnchor="middle" fontSize={sw < 34 ? 10 : 12} fontWeight={600} fill="var(--c4)">{nx < 0 ? "null" : nx}</text>
                    <text x={cx(i)} y={top + 49} textAnchor="middle" fontSize={8.5} fill="var(--muted)">#{(rank.get(i) ?? 0) + 1}</text>
                  </>
                )}
                <text x={cx(i)} y={top + sh + 14} textAnchor="middle" fontSize={10} fill={isHead ? "var(--c4)" : "var(--muted)"} fontWeight={isHead ? 700 : 400}>{isHead ? "head" : `slot ${i}`}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ ...mono, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", margin: "6px 0 10px" }}>
        <span style={{ color: "var(--c4)", fontWeight: 600 }}>head</span>
        {order.map((i) => <span key={i}>→ <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--subtle)", border: "1px solid var(--border)" }}>{i}</span></span>)}
        <span>→ null</span>
      </div>
      {handles.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Handles you hold (index, generation). Click one to use it:</div>
          <div className="row">
            {handles.map((h, k) => {
              const ok = p.valid(h);
              return (
                <button key={k} className="btn" style={{ ...mono, borderColor: ok ? "var(--c3)" : "var(--c4)", color: ok ? "var(--c3)" : "var(--c4)" }}
                  onClick={() => say(ok
                    ? `${h.name} = (${h.index}, ${h.gen}): generation matches, access allowed`
                    : `${h.name} = (${h.index}, ${h.gen}): slot ${h.index} has generation ${p.gen[h.index]} now → rejected. A raw pointer would read ${p.owner[h.index] ?? "a free slot"}.`)}>
                  {h.name} ({h.index}, {h.gen})
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ ...mono, color: "var(--muted)", minHeight: 18 * 3 }}>
        {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>Allocate, or click a live slot to free it.</div>}
      </div>
      <Stats items={[{ label: "free slots", value: order.length }, { label: "live slots", value: p.n - order.length }, { label: "head", value: p.head < 0 ? "null" : `slot ${p.head}` }]} />
    </Demo>
  );
}

// ================================================================ safe-linking

const POS = 0x55555555a2c0n, NEXT = 0x55555555a300n, TARGET = 0x7ffff7dd1b20n;
const hx = (v: bigint) => "0x" + v.toString(16).padStart(12, "0");
const attackSchema = select({ label: "Attacker overwrites the stored pointer with", options: [{ value: "none", label: "Nothing" }, { value: "raw", label: "Target address" }, { value: "leak", label: "Target, encoded with a leak" }], default: "none", segmented: true });

export function SafeLinkingDemo() {
  const [attack, setAttack] = useState("none");
  const stored = attack === "none" ? protectPtr(POS, NEXT) : attack === "raw" ? TARGET : protectPtr(POS, TARGET);
  const decoded = revealPtr(POS, stored);
  const aligned = passesAlignCheck(decoded);
  const rate = useMemo(() => forgedPassRate(TARGET), []);
  const row = (k: string, v: ReactNode, color?: string) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0 12px", padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
      <span className="muted" style={{ minWidth: 170 }}>{k}</span>
      <span style={{ color: color ?? "var(--fg)" }}>{v}</span>
    </div>
  );
  return (
    <Demo title="Safe-linking: glibc hides the next pointer" controls={<Param spec={attackSchema} value={attack} onChange={(v) => setAttack(v as string)} />}>
      <div style={{ ...mono }}>
        {row("slot address (pos)", hx(POS))}
        {row("real next pointer", hx(NEXT))}
        {row("key = pos >> 12", hx(POS >> 12n))}
        {row("stored in the slot", hx(stored), attack === "none" ? undefined : "var(--c4)")}
        {row("decoded = stored ^ key", hx(decoded), attack === "none" ? "var(--c3)" : "var(--c4)")}
        {row("16-byte aligned?", aligned ? "yes" : "no", aligned ? "var(--c3)" : "var(--c4)")}
      </div>
      <p style={{ fontSize: 13.5, margin: "10px 0 0", color: attack === "none" ? "var(--c3)" : aligned ? "var(--c4)" : "var(--c3)" }}>
        {attack === "none" && "Normal use: the decoded value is the real next slot."}
        {attack === "raw" && "The forged value decodes to garbage. It is not 16-byte aligned, so malloc stops the program (\"unaligned tcache chunk detected\")."}
        {attack === "leak" && "With a leaked heap address, the attacker can encode the target correctly. Safe-linking only raises the cost of the attack."}
      </p>
      <Stats items={[{ label: "raw forged pointers that pass, over random heap addresses", value: pct(rate, 1) }]} />
    </Demo>
  );
}

// ================================================================ fit search

const VERDICT: Record<Verdict, { label: string; color: string }> = {
  used: { label: "in use", color: "--faint" },
  small: { label: "too small", color: "--c4" },
  fits: { label: "fits", color: "--c2" },
  best: { label: "best so far", color: "--c3" },
  chosen: { label: "chosen", color: "--c3" },
};
const FIT_LABEL: Record<Fit, string> = { first: "First fit", next: "Next fit", best: "Best fit", worst: "Worst fit" };

export function FitSearchDemo() {
  const [size, setSize] = useState(40);
  const [fit, setFit] = useState<Fit>("first");
  const [coalesce, setCoalesce] = useState(true);
  const heap = useRef<FreeListSim>(presetHeap("first", true));
  const [anim, setAnim] = useState<{ trace: SearchTrace; k: number; size: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [, force] = useState(0);
  const say = (s: string) => setLog((l) => [...l, s].slice(-3));
  const h = heap.current;
  h.fit = fit;
  h.coalesce = coalesce;
  const req = Math.round(size / 8) * 8;

  useEffect(() => {
    if (!anim) return;
    if (anim.k < anim.trace.steps.length) {
      const t = window.setTimeout(() => setAnim({ ...anim, k: anim.k + 1 }), anim.k === 0 ? 150 : 420);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      if (anim.trace.chosen < 0) say(`alloc(${anim.size}) fails: no free block holds ${blockNeed(anim.size)} B.`);
      else {
        const before = h.blocks[anim.trace.chosen]!.size;
        const r = h.place(anim.trace.chosen, anim.size)!;
        say(`alloc(${anim.size}) → block of ${blockNeed(anim.size)} B taken from a ${before} B block${r.split ? `; split leaves ${r.split} B free` : "; too little left to split"} (${anim.trace.examined} blocks examined)`);
      }
      setAnim(null);
    }, 500);
    return () => window.clearTimeout(t);
  }, [anim]); // eslint-disable-line react-hooks/exhaustive-deps

  const visited = new Map<number, Verdict>();
  if (anim) anim.trace.steps.slice(0, anim.k).forEach((s) => visited.set(s.block, s.verdict));
  const cursor = anim && anim.k > 0 ? anim.trace.steps[anim.k - 1]?.block : undefined;
  const roverIdx = fit === "next" ? Math.max(0, h.blocks.findIndex((b) => b.off >= h.rover)) : -1;
  const st = h.stats();
  const compare = FITS.map((f) => ({ f, t: h.search(req, f) }));

  const freeBlock = (i: number) => {
    if (anim) return;
    const b = h.blocks[i]!;
    if (b.free) return;
    const name = b.name;
    const merged = h.freeAt(i);
    const nb = h.blocks.find((x) => x.free && x.off <= b.off && b.off < x.off + x.size)!;
    say(merged > 1 ? `free(${name}): coalesced ${merged} blocks into one free block of ${nb.size} B` : `free(${name}): block of ${nb.size} B is free${coalesce ? "; no free neighbor" : "; coalescing is off"}`);
    force((x) => x + 1);
  };

  return (
    <Demo
      title="Searching a free list · 1 KiB heap · 8 B headers"
      actions={
        <>
          <button className="btn primary" disabled={!!anim} onClick={() => setAnim({ trace: h.search(req, fit), k: 0, size: req })}>Search for {req} B</button>
          <button className="btn ghost" disabled={!!anim} onClick={() => { heap.current = presetHeap(fit, coalesce); setLog([]); force((x) => x + 1); }}>Reset heap</button>
        </>
      }
      controls={
        <>
          <Param spec={range({ label: "Request size", min: 8, max: 320, step: 8, default: 40, format: (v) => `${Math.round(v / 8) * 8} B` })} value={size} onChange={(v) => setSize(v as number)} />
          <Param spec={select({ label: "Placement", options: FITS.map((f) => ({ value: f, label: FIT_LABEL[f] })), default: "first", segmented: true })} value={fit} onChange={(v) => !anim && setFit(v as Fit)} />
          <Param spec={toggle({ label: "Coalesce on free", default: true })} value={coalesce} onChange={(v) => setCoalesce(v as boolean)} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {h.blocks.map((b, i) => {
          const v = visited.get(i);
          const vs = v ? VERDICT[v] : null;
          const isCur = cursor === i;
          return (
            <div key={`${b.off}-${b.size}-${b.free}`} onClick={() => freeBlock(i)} title={b.free ? `free block, ${b.size} B (${b.size - FL_HEADER} B payload)` : `${b.name}: ${b.req} B in a ${b.size} B block. Click to free.`}
              style={{
                flex: `${b.size} 1 0`, minWidth: 46, height: 58, borderRadius: 6, padding: "4px 5px", boxSizing: "border-box", cursor: b.free ? "default" : "pointer",
                background: b.free ? "var(--subtle)" : "var(--c1)", color: b.free ? "var(--fg)" : "#fff",
                border: b.free ? "1.5px dashed var(--border)" : "1.5px solid transparent",
                outline: vs ? `${isCur || v === "chosen" ? 3 : 2}px solid var(${vs.color})` : undefined, outlineOffset: 1,
                transform: isCur ? "translateY(-3px)" : undefined, transition: "transform 0.2s, outline-color 0.2s",
                display: "flex", flexDirection: "column", justifyContent: "space-between", fontSize: 11, lineHeight: 1.2, overflow: "hidden",
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 4 }}>
                <b>{b.free ? "free" : b.name}</b>
                {i === roverIdx && <span style={{ color: "var(--c4)", fontWeight: 600 }}>rover</span>}
              </div>
              <div style={{ opacity: 0.85 }}>{b.size} B</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: !vs ? "transparent" : b.free ? `var(${vs.color})` : "#fff", opacity: vs && !b.free ? 0.8 : 1 }}>{vs?.label ?? "."}</div>
            </div>
          );
        })}
      </div>
      <div style={{ ...mono, color: "var(--muted)", minHeight: 18 * 2, marginTop: 10 }}>
        {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>Press Search. Click a blue block to free it.</div>}
      </div>
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
          <thead>
            <tr className="muted" style={{ textAlign: "left" }}>
              <th style={{ padding: "3px 6px 3px 0", fontWeight: 500 }}>policy</th>
              <th style={{ padding: "3px 6px", fontWeight: 500 }}>chooses</th>
              <th style={{ padding: "3px 6px", fontWeight: 500 }}>blocks walked</th>
              <th style={{ padding: "3px 0 3px 6px", fontWeight: 500 }}>free blocks walked</th>
            </tr>
          </thead>
          <tbody>
            {compare.map(({ f, t }) => (
              <tr key={f} style={{ borderTop: "1px solid var(--border)", fontWeight: f === fit ? 600 : 400 }}>
                <td style={{ padding: "3px 6px 3px 0" }}>{FIT_LABEL[f]}</td>
                <td style={{ padding: "3px 6px" }}>{t.chosen < 0 ? "fails" : `${h.blocks[t.chosen]!.size} B block`}</td>
                <td style={{ padding: "3px 6px" }}>{t.examined}</td>
                <td style={{ padding: "3px 0 3px 6px" }}>{t.freeExamined}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Stats items={[
        { label: "free bytes", value: `${st.freeBytes} B` },
        { label: "largest free block", value: `${st.largest} B` },
        { label: "external fragmentation", value: pct(st.extFrag, 0) },
      ]} />
    </Demo>
  );
}

// ================================================================ block header bits

export function BlockHeaderDemo() {
  const [size, setSize] = useState(48);
  const [alloc, setAlloc] = useState(true);
  const sz = Math.max(16, Math.round(size / 8) * 8);
  const w = headerWord(sz, alloc);
  const bits = w.toString(2).padStart(12, "0").split("");
  const base = 0x100;
  return (
    <Demo
      title="One block: header, payload, and footer"
      controls={
        <>
          <Param spec={range({ label: "Block size", min: 16, max: 512, step: 8, default: 48, format: (v) => `${Math.max(16, Math.round(v / 8) * 8)} B` })} value={size} onChange={(v) => setSize(v as number)} />
          <Param spec={toggle({ label: "Allocated", default: true })} value={alloc} onChange={(v) => setAlloc(v as boolean)} />
        </>
      }
    >
      <div style={{ display: "flex", height: 34, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)", fontSize: 11, fontWeight: 600 }}>
        <div style={{ flex: `${FL_HEADER} 0 0`, minWidth: 54, background: "var(--c5)", color: "#fff", display: "grid", placeItems: "center" }}>header</div>
        <div style={{ flex: `${sz - FL_HEADER - (alloc ? 0 : 8)} 0 0`, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", background: alloc ? "var(--c1)" : "var(--subtle)", color: alloc ? "#fff" : "var(--muted)", display: "grid", placeItems: "center" }}>{alloc ? `payload ${sz - FL_HEADER} B` : "free space"}</div>
        {!alloc && <div style={{ flex: "8 0 0", minWidth: 50, background: "var(--c5)", opacity: 0.7, color: "#fff", display: "grid", placeItems: "center" }}>footer</div>}
      </div>
      <div className="muted" style={{ ...mono, fontSize: 11, display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span>0x{base.toString(16)}</span><span>next header at 0x{(base + sz).toString(16)}</span>
      </div>
      <div style={{ ...mono, marginTop: 12 }}>
        <div className="muted" style={{ marginBottom: 4 }}>header word (low 12 bits):</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 2, maxWidth: 420 }}>
          {bits.map((b, i) => {
            const bit = 11 - i;
            const low = bit < 3;
            return (
              <div key={i} style={{ textAlign: "center" }}>
                <div style={{ height: 26, borderRadius: 3, display: "grid", placeItems: "center", fontWeight: 700, background: bit === 0 ? (alloc ? "var(--c3)" : "var(--c4)") : low ? "var(--subtle)" : "var(--c1)", color: bit === 0 || !low ? "#fff" : "var(--muted)", opacity: !low && b === "0" ? 0.35 : 1 }}>{b}</div>
                <div className="muted" style={{ fontSize: 9 }}>{bit}</div>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 10, lineHeight: 1.7 }}>
          <div>word = {sz} | {alloc ? 1 : 0} = <b>{w}</b> (0x{w.toString(16)})</div>
          <div>size = word & ~7 = {headerSize(w)} · allocated = word & 1 = {headerAllocated(w) ? 1 : 0}</div>
        </div>
      </div>
      <Note>Bits 0 to 2 of a multiple of 8 are always 0. The allocator uses bit 0 for the flag. A free block copies the header into a footer, so the next block can find this block&apos;s start.</Note>
    </Demo>
  );
}
