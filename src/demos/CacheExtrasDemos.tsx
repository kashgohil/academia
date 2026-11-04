/** Explainer demos for the Caches lessons: steppers and direct-manipulation views. */
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Demo, Stats, Param, Canvas2D, cssVar, Legend, SimButtons, useSim, range, select, bytes, pct } from "../kit";
import {
  splitAddress, SetCache, matrixWalk, loopHitRate, amat, reuseSteps, REUSE_TRACES, hitsAt, strideTraffic,
  loopIndex, innerLines, runTwoLevel, HIER_TRACES, hotMissShare, prefetchTimeline, cyclesPerLine, strideSteps, twoStreams,
  runWritePolicy, WRITE_TRACES, W_LINE, type Policy, type Order3, type Inclusion,
} from "../sims/cacheextras";

// ---------------- shared helpers ----------------

/** Steps an index through 0..len-1 and wraps. */
function useStepper(len: number, perSec: number) {
  const [i, setI] = useState(0);
  const sim = useSim({ dt: 1 / perSec, autoplay: true, step: () => setI((x) => (x + 1) % len), reset: () => setI(0) });
  return { i: Math.min(i, len - 1), sim };
}

const seg = <T extends string>(label: string, options: [T, string][], def: T) =>
  select<T>({ label, options: options.map(([value, l]) => ({ value, label: l })), default: def, segmented: true });

const mono: CSSProperties = { fontVariantNumeric: "tabular-nums", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };

const Note = ({ children }: { children: ReactNode }) => <p className="muted" style={{ fontSize: 12.5, margin: "10px 0 0" }}>{children}</p>;

const Box = ({ children, bg, fg, outline, title, style }: { children?: ReactNode; bg?: string; fg?: string; outline?: string; title?: string; style?: CSSProperties }) => (
  <div title={title} style={{ height: 24, borderRadius: 4, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 600, background: bg ?? "var(--subtle)", color: fg ?? "var(--fg)", border: "1px solid var(--border)", outline: outline ? `2px solid ${outline}` : undefined, outlineOffset: 1, transition: "background 0.2s", minWidth: 0, ...style }}>
    {children}
  </div>
);

const Strip = ({ items }: { items: { label: string; color: string; sub?: string; current?: boolean }[] }) => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
    {items.map((x, k) => (
      <div key={k} style={{ width: 22, textAlign: "center" }}>
        <Box bg={x.color} fg="#fff" outline={x.current ? "var(--fg)" : undefined}>{x.label}</Box>
        {x.sub !== undefined && <div className="muted" style={{ fontSize: 9.5, marginTop: 1 }}>{x.sub}</div>}
      </div>
    ))}
  </div>
);

// ================= Cache organization =================

// ---------------- address split ----------------

export function AddressSplitDemo() {
  const [row, setRow] = useState(5);
  const [col, setCol] = useState(3);
  const [size, setSize] = useState("4096");
  const [line, setLine] = useState("64");
  const [ways, setWays] = useState("1");
  const g = { size: Number(size), line: Number(line), ways: Number(ways) };
  const addr = 4 * (64 * row + col);
  const s = splitAddress(addr, g);
  const same = Array.from({ length: 64 }, (_, r) => r).filter((r) => splitAddress(4 * (64 * r + col), g).index === s.index);
  const bits = Array.from({ length: 32 }, (_, b) => (addr >>> (31 - b)) & 1);
  const field = (b: number) => (b < s.tagBits ? 0 : b < s.tagBits + s.indexBits ? 1 : 2);
  const FC = ["var(--c2)", "var(--c1)", "var(--c3)"];
  const showSets = Math.min(s.sets, 256);
  const colSets = new Set(Array.from({ length: 64 }, (_, r) => splitAddress(4 * (64 * r + col), g).index));
  return (
    <Demo
      title="Where does m[i][j] go? Split the address"
      controls={
        <>
          <Param spec={range({ label: "Row i", min: 0, max: 63, step: 1, default: 5 })} value={row} onChange={(v) => setRow(v as number)} />
          <Param spec={range({ label: "Column j", min: 0, max: 63, step: 1, default: 3 })} value={col} onChange={(v) => setCol(v as number)} />
          <Param spec={seg("Cache size", [["1024", "1 KiB"], ["4096", "4 KiB"], ["16384", "16 KiB"]], "4096")} value={size} onChange={(v) => setSize(v as string)} />
          <Param spec={seg("Line size", [["16", "16 B"], ["32", "32 B"], ["64", "64 B"], ["128", "128 B"]], "64")} value={line} onChange={(v) => setLine(v as string)} />
          <Param spec={seg("Ways", [["1", "1"], ["2", "2"], ["4", "4"], ["8", "8"], ["0", "Full"]], "1")} value={ways} onChange={(v) => setWays(v as string)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        m is a 64×64 matrix of 4-byte ints, stored row by row. Address of m[{row}][{col}] = 4 × (64 × {row} + {col}) = <b style={{ color: "var(--fg)" }}>{addr}</b>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(32, 1fr)", gap: 1, ...mono }}>
        {bits.map((b, k) => (
          <div key={k} style={{ height: 22, display: "grid", placeItems: "center", fontSize: 10.5, borderRadius: 2, color: "#fff", background: FC[field(k)], opacity: b ? 1 : 0.55 }}>{b}</div>
        ))}
      </div>
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: `tag: ${s.tagBits} bits`, color: FC[0]! }, { label: `set index: ${s.indexBits} bits`, color: FC[1]! }, { label: `offset: ${s.offsetBits} bits`, color: FC[2]! }]} />
      </div>
      <Stats
        items={[
          { label: "geometry", value: `${s.sets} sets × ${s.ways} ways` },
          { label: "tag", value: s.tag },
          { label: "set index", value: s.indexBits ? s.index : "0 (one set)" },
          { label: "byte in the line", value: s.offset },
          { label: "rows of column j in this set", value: `${same.length} of 64` },
        ]}
      />
      <div className="muted" style={{ fontSize: 12.5, margin: "12px 0 4px" }}>The sets{s.sets > showSets ? ` (first ${showSets})` : ""}: orange marks the sets of every row of column j, blue the set of m[i][j]</div>
      <svg viewBox={`0 0 ${showSets} 10`} preserveAspectRatio="none" style={{ width: "100%", height: 22, display: "block" }}>
        {Array.from({ length: showSets }, (_, k) => {
          return <rect key={k} x={k + 0.08} y={0} width={0.84} height={10} fill={k === s.index ? "var(--c1)" : colSets.has(k) ? "var(--c2)" : "var(--border)"} />;
        })}
      </svg>
    </Demo>
  );
}

// ---------------- set map stepper ----------------

const SPEEDS: Record<string, number> = { slow: 1, fast: 16, faster: 128 };

export function SetMapDemo() {
  const [order, setOrder] = useState<"row" | "col">("col");
  const [ways, setWays] = useState("1");
  const [speed, setSpeed] = useState("slow");
  const fresh = (o: "row" | "col", w: string) => ({ trace: matrixWalk(64, o), cache: new SetCache(64, Number(w)), pos: 0, out: new Uint8Array(4096), last: { hit: false, set: 0, way: 0, victim: -1 }, hits: 0, sets: new Set<number>() });
  const st = useRef<ReturnType<typeof fresh> | null>(null);
  if (!st.current) st.current = fresh(order, ways);
  const restart = (o = order, w = ways) => { st.current = fresh(o, w); };
  const advance = () => {
    if (st.current!.pos >= st.current!.trace.length) restart(); // Play after the end starts again
    const s = st.current!;
    const trace = s.trace;
    for (let k = 0; k < SPEEDS[speed]! && s.pos < trace.length; k++) {
      const a = trace[s.pos]!;
      const r = s.cache.access(a >> 6);
      s.out[a >> 2] = r.hit ? 1 : 2;
      if (r.hit) s.hits++;
      s.sets.add(r.set);
      s.last = r;
      s.pos++;
    }
    if (s.pos >= trace.length) sim.pause();
  };
  const sim = useSim({ dt: 1 / 6, autoplay: true, step: advance, reset: () => restart() });
  const s = st.current;
  const cache = s.cache, trace = s.trace;
  const W = cache.ways, setsPerRow = W >= 8 ? 1 : 8 / W;
  const cur = s.pos > 0 ? trace[s.pos - 1]! : 0;
  const ci = cur >> 2;
  const i = Math.floor(ci / 64), j = ci % 64;
  const rowOf = (lineNo: number) => `r${lineNo >> 2}${"abcd"[lineNo & 3]}`;
  const sim2 = { ...sim, reset: () => { sim.reset(); sim.play(); } };
  return (
    <Demo
      title="64×64 ints through a 4 KiB cache, one access at a time"
      actions={<SimButtons sim={sim2} />}
      controls={
        <>
          <Param spec={seg("Walk", [["row", "Row by row"], ["col", "Column by column"]], "col")} value={order} onChange={(v) => { setOrder(v as "row" | "col"); restart(v as "row" | "col"); sim.play(); }} />
          <Param spec={seg("Ways", [["1", "1"], ["2", "2"], ["4", "4"], ["0", "Full"]], "1")} value={ways} onChange={(v) => { setWays(v as string); restart(order, v as string); sim.play(); }} />
          <Param spec={seg("Speed", [["slow", "1 per step"], ["fast", "16"], ["faster", "128"]], "slow")} value={speed} onChange={(v) => setSpeed(v as string)} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start" }}>
        <div style={{ width: "min(100%, 210px)" }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>The matrix: each cell is one int</div>
          <Canvas2D
            height={(w) => w}
            deps={[s.pos, order, ways]}
            draw={(ctx, w) => {
              const c = w / 64;
              const col = [cssVar("--subtle"), cssVar("--c3"), cssVar("--c4")];
              for (let e = 0; e < 4096; e++) { ctx.fillStyle = col[s.out[e]!]!; ctx.fillRect((e % 64) * c, Math.floor(e / 64) * c, c, c); }
              if (s.pos > 0) { ctx.strokeStyle = cssVar("--fg"); ctx.lineWidth = 1.5; ctx.strokeRect(j * c - 1, i * c - 1, c + 2, c + 2); }
            }}
          />
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>The cache: {cache.sets} sets × {W} ways = 64 lines. A label rNx is quarter x of matrix row N.</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${setsPerRow}, 1fr)`, gap: 3 }}>
            {Array.from({ length: cache.sets }, (_, set) => (
              <div key={set} title={`set ${set}`} style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(W, 8)}, 1fr)`, gap: 1, padding: 1, borderRadius: 4, outline: s.pos > 0 && set === s.last.set ? "2px solid var(--c1)" : "1px solid var(--border)" }}>
                {Array.from({ length: W }, (_, w) => {
                  const ln = cache.slots[set * W + w]!;
                  const now = s.pos > 0 && set === s.last.set && w === s.last.way;
                  return <Box key={w} bg={now ? (s.last.hit ? "var(--c3)" : "var(--c4)") : ln < 0 ? "transparent" : "var(--subtle)"} fg={now ? "#fff" : "var(--muted)"} style={{ height: 20, fontSize: 9, fontWeight: 500, border: "none" }}>{ln < 0 ? "" : rowOf(ln)}</Box>;
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p style={{ fontSize: 13, margin: "12px 0 0", minHeight: 36 }}>
        {s.pos === 0 ? "Press Play or Step." : (
          <>Access {s.pos}: m[{i}][{j}] is in line {cur >> 6}, so it goes to set {s.last.set}. <b style={{ color: s.last.hit ? "var(--c3)" : "var(--c4)" }}>{s.last.hit ? "Hit." : "Miss."}</b>{s.last.victim >= 0 && <> It removes line {rowOf(s.last.victim)}.</>}</>
        )}
      </p>
      <Stats items={[{ label: "accesses", value: `${s.pos} of 4096` }, { label: "hit rate", value: s.pos ? pct(s.hits / s.pos) : "–" }, { label: "sets used so far", value: `${s.sets.size} of ${cache.sets}` }]} />
      <div style={{ marginTop: 8 }}><Legend box items={[{ label: "hit", color: "var(--c3)" }, { label: "miss", color: "var(--c4)" }, { label: "not read yet", color: "var(--subtle)" }]} /></div>
    </Demo>
  );
}

// ---------------- LRU and a loop ----------------

const LOOP_LETTERS = "ABCDEFGH";

export function LoopPolicyDemo() {
  const [n, setN] = useState(5);
  const [policy, setPolicy] = useState<Policy>("lru");
  const C = 4, PASSES = 6;
  const steps = useMemo(() => {
    const c = new SetCache(C, 0, policy, 7);
    return Array.from({ length: PASSES * n }, (_, t) => { const r = c.access(t % n); return { line: t % n, ...r, slots: Array.from(c.slots) }; });
  }, [n, policy]);
  const { i, sim } = useStepper(steps.length, 2.5);
  const cur = steps[i]!;
  const shown = steps.slice(0, i + 1);
  const hits = shown.filter((x) => x.hit).length;
  const longRun = useMemo(() => (["lru", "fifo", "random"] as const).map((p) => ({ p, r: loopHitRate(n, C, p) })), [n]);
  return (
    <Demo
      title="A loop over N lines, a cache of 4 lines"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={range({ label: "Lines in the loop (N)", min: 3, max: 8, step: 1, default: 5 })} value={n} onChange={(v) => { setN(v as number); sim.reset(); }} />
          <Param spec={seg<Policy>("Replacement", [["lru", "LRU"], ["fifo", "FIFO"], ["random", "Random"]], "lru")} value={policy} onChange={(v) => { setPolicy(v as Policy); sim.reset(); }} />
        </>
      }
    >
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Cache</span>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 44px)", gap: 6 }}>
          {cur.slots.map((ln, w) => (
            <Box key={w} bg={w === cur.way ? (cur.hit ? "var(--c3)" : "var(--c4)") : "var(--subtle)"} fg={w === cur.way ? "#fff" : "var(--fg)"} style={{ height: 36, fontSize: 15 }}>{ln < 0 ? "" : LOOP_LETTERS[ln]}</Box>
          ))}
        </div>
        <span style={{ fontSize: 13 }}>
          Access {LOOP_LETTERS[cur.line]}: <b style={{ color: cur.hit ? "var(--c3)" : "var(--c4)" }}>{cur.hit ? "hit" : "miss"}</b>
          {cur.victim >= 0 && <span className="muted">, removes {LOOP_LETTERS[cur.victim]}</span>}
        </span>
      </div>
      <div style={{ margin: "12px 0" }}>
        <Strip items={shown.slice(-40).map((x, k, a) => ({ label: LOOP_LETTERS[x.line]!, color: x.hit ? "var(--c3)" : "var(--c4)", current: k === a.length - 1 }))} />
      </div>
      <Stats items={[{ label: "hits so far", value: `${hits} of ${shown.length}` }, ...longRun.map(({ p, r }) => ({ label: `${p.toUpperCase()}, long run`, value: pct(r, 0) }))]} />
      <Note>LRU removes the line that was used longest ago. In a loop over more lines than the cache holds, that is always the line that the loop needs next.</Note>
    </Demo>
  );
}

// ================= Locality =================

// ---------------- reuse distance stepper ----------------

export function ReuseStackDemo() {
  const [cap, setCap] = useState(3);
  const [which, setWhich] = useState("loop3");
  const t = REUSE_TRACES.find((x) => x.id === which)!;
  const steps = useMemo(() => reuseSteps(t.trace), [t]);
  const { i, sim } = useStepper(steps.length, 1.5);
  const cur = steps[i]!;
  const prev = i > 0 ? steps[i - 1]!.stack : [];
  const shown = steps.slice(0, i + 1);
  const maxDepth = 7;
  return (
    <Demo
      title="Reuse distance: depth in the LRU stack"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={range({ label: "Cache size (lines)", min: 1, max: 6, step: 1, default: 3 })} value={cap} onChange={(v) => setCap(v as number)} />
          <Param spec={select({ label: "Trace", options: REUSE_TRACES.map((x) => ({ value: x.id, label: x.label })), default: "loop3" })} value={which} onChange={(v) => { setWhich(v as string); sim.reset(); }} />
        </>
      }
    >
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ width: 150 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Stack before this access</div>
          {Array.from({ length: maxDepth }, (_, d) => (
            <div key={d}>
              <div style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 6, alignItems: "center", marginBottom: 3 }}>
                <span className="muted" style={{ fontSize: 11, textAlign: "right" }}>{d}</span>
                <Box bg={prev[d] === cur.item ? "var(--c1)" : prev[d] ? "var(--subtle)" : "transparent"} fg={prev[d] === cur.item ? "#fff" : "var(--fg)"} style={{ border: prev[d] ? undefined : "1px dashed var(--border)" }}>{prev[d] ?? ""}</Box>
              </div>
              {d === cap - 1 && <div style={{ borderTop: "2px solid var(--c2)", margin: "4px 0 6px", fontSize: 10.5, color: "var(--c2)", textAlign: "right" }}>cache of {cap} holds the lines above</div>}
            </div>
          ))}
        </div>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <p style={{ fontSize: 13.5, marginTop: 0 }}>
            Access <b>{cur.item}</b>:{" "}
            {cur.distance === Infinity ? <>first touch, distance ∞. <b style={{ color: "var(--c4)" }}>Miss.</b></> : (
              <>it is at depth {cur.distance}, so its reuse distance is {cur.distance}. {cur.distance} &lt; {cap}? <b style={{ color: cur.distance < cap ? "var(--c3)" : "var(--c4)" }}>{cur.distance < cap ? "Hit." : "Miss."}</b></>
            )}{" "}
            Then {cur.item} moves to the top.
          </p>
          <Strip items={shown.map((s, k) => ({ label: s.item, color: s.distance < cap ? "var(--c3)" : "var(--c4)", sub: s.distance === Infinity ? "∞" : String(s.distance), current: k === i }))} />
          <div className="muted" style={{ fontSize: 12, margin: "14px 0 4px" }}>Hits for the whole trace, for each cache size, from this one pass</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4, alignItems: "end", height: 70 }}>
            {[1, 2, 3, 4, 5, 6].map((c) => {
              const h = hitsAt(steps, c);
              return (
                <div key={c} style={{ textAlign: "center", fontSize: 10.5 }}>
                  <div style={{ fontSize: 10.5 }}>{h}</div>
                  <div style={{ height: (40 * h) / steps.length + 2, background: c === cap ? "var(--c2)" : "var(--c1)", opacity: c === cap ? 1 : 0.55, borderRadius: 2 }} />
                  <div className="muted">{c}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Stats items={[{ label: `hits so far with ${cap} lines`, value: `${shown.filter((s) => s.distance < cap).length} of ${shown.length}` }, { label: "first touches so far", value: shown.filter((s) => s.distance === Infinity).length }]} />
    </Demo>
  );
}

// ---------------- stride and lines ----------------

export function StrideLinesDemo() {
  const [stride, setStride] = useState(1);
  const [line, setLine] = useState("64");
  const L = Number(line), N = 128, per = L / 4, cols = 32;
  const big = strideTraffic(4096, stride, 4, L);
  const used = new Set(Array.from({ length: Math.ceil(N / stride) }, (_, k) => k * stride));
  const fetched = new Set([...used].map((e) => Math.floor(e / per)));
  const rows = N / cols, cw = 10, rh = 16;
  return (
    <Demo
      title="Read every s-th int: what the cache moves"
      controls={
        <>
          <Param spec={range({ label: "Stride s (ints)", min: 1, max: 32, step: 1, default: 1 })} value={stride} onChange={(v) => setStride(v as number)} />
          <Param spec={seg("Line size", [["16", "16 B"], ["32", "32 B"], ["64", "64 B"], ["128", "128 B"]], "64")} value={line} onChange={(v) => setLine(v as string)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>128 ints (512 bytes). Each box is one {L}-byte line of {per} ints.</div>
      <svg viewBox={`0 0 ${cols * cw} ${rows * rh}`} style={{ width: "100%", display: "block" }}>
        {Array.from({ length: N / per }, (_, l) => {
          const x = ((l * per) % cols) * cw, y = Math.floor((l * per) / cols) * rh;
          return <rect key={`l${l}`} x={x + 0.5} y={y + 0.5} width={Math.min(per, cols) * cw - 1} height={rh - 1} rx={2} fill={fetched.has(l) ? "var(--c1)" : "none"} fillOpacity={0.18} stroke={fetched.has(l) ? "var(--c1)" : "var(--border)"} />;
        })}
        {Array.from({ length: N }, (_, e) => (
          <rect key={e} x={(e % cols) * cw + 2} y={Math.floor(e / cols) * rh + 3} width={cw - 4} height={rh - 6} rx={1} fill={used.has(e) ? "var(--c2)" : "var(--faint)"} opacity={used.has(e) ? 1 : 0.35} />
        ))}
      </svg>
      <div style={{ marginTop: 6 }}><Legend box items={[{ label: "int that the loop reads", color: "var(--c2)" }, { label: "line that the cache fetches", color: "var(--c1)" }]} /></div>
      <Stats
        items={[
          { label: "stride in bytes", value: `${stride * 4} B` },
          { label: "misses per access", value: big.missPerAccess.toFixed(3) },
          { label: "useful bytes of each fetched line", value: pct(big.used / big.fetched, 1) },
          { label: "bytes moved per 4 KiB read", value: bytes(Math.round((big.fetched / big.used) * 4096)) },
        ]}
      />
    </Demo>
  );
}

// ---------------- matrix multiply footprint ----------------

const MM_N = 8;

export function LoopOrderDemo() {
  const [order, setOrder] = useState<Order3>("ijk");
  const { i: t, sim } = useStepper(MM_N ** 3, 4);
  const { i, j, k } = loopIndex(order, MM_N, t);
  const start = t - (t % MM_N);
  const pass = Array.from({ length: MM_N }, (_, q) => loopIndex(order, MM_N, start + q));
  const lines = innerLines(order, MM_N, MM_N);
  const grid = (name: "A" | "B" | "C", rc: (x: { i: number; j: number; k: number }) => readonly [number, number]) => {
    const now = rc({ i, j, k });
    const inPass = new Set(pass.map((p) => rc(p).join(",")));
    const rowsTouched = new Set(pass.map((p) => rc(p)[0]));
    const c = 12;
    return (
      <div style={{ textAlign: "center", flex: "1 1 90px", maxWidth: 140, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>{name} <span className="muted" style={{ fontWeight: 400 }}>{lines[name] ? `${lines[name]} line / iter` : "in a register"}</span></div>
        <svg viewBox={`0 0 ${MM_N * c + 2} ${MM_N * c + 2}`} style={{ width: "100%", display: "block" }}>
          {Array.from({ length: MM_N }, (_, r) => (
            <rect key={`r${r}`} x={0.5} y={r * c + 0.5} width={MM_N * c + 1} height={c} rx={2} fill="none" stroke={rowsTouched.has(r) && lines[name] ? "var(--c2)" : "var(--border)"} strokeWidth={rowsTouched.has(r) && lines[name] ? 1.4 : 0.6} />
          ))}
          {Array.from({ length: MM_N * MM_N }, (_, e) => {
            const r = Math.floor(e / MM_N), cc = e % MM_N;
            const isNow = r === now[0] && cc === now[1];
            return <rect key={e} x={cc * c + 2.5} y={r * c + 2.5} width={c - 3} height={c - 3} rx={1} fill={isNow ? "var(--c4)" : inPass.has(`${r},${cc}`) ? "var(--c1)" : "var(--faint)"} opacity={isNow ? 1 : inPass.has(`${r},${cc}`) ? 0.75 : 0.25} />;
          })}
        </svg>
      </div>
    );
  };
  return (
    <Demo
      title="C += A × B: what the inner loop touches"
      actions={<SimButtons sim={sim} />}
      controls={<Param spec={seg<Order3>("Loop order (last letter = inner loop)", [["ijk", "ijk"], ["jki", "jki"], ["ikj", "ikj"]], "ijk")} value={order} onChange={(v) => { setOrder(v as Order3); sim.reset(); }} />}
    >
      <div style={{ display: "flex", gap: 10, justifyContent: "space-between" }}>
        {grid("C", (x) => [x.i, x.j])}
        {grid("A", (x) => [x.i, x.k])}
        {grid("B", (x) => [x.k, x.j])}
      </div>
      <p style={{ fontSize: 13, margin: "10px 0 0", ...mono }}>i = {i}, j = {j}, k = {k}</p>
      <Stats items={[{ label: "new lines per inner iteration", value: (lines.A + lines.B + lines.C).toFixed(3) }, { label: "A + B + C", value: `${lines.A} + ${lines.B} + ${lines.C}` }]} />
      <div style={{ marginTop: 8 }}><Legend box items={[{ label: "element now", color: "var(--c4)" }, { label: "elements of this inner loop", color: "var(--c1)" }, { label: "line (one row of 8 doubles = 64 B) that the inner loop needs", color: "var(--c2)" }]} /></div>
    </Demo>
  );
}

// ================= Multi-level caches =================

// ---------------- AMAT funnel ----------------

const LAT4 = [4, 12, 40, 200];
const LEVEL_NAMES = ["L1", "L2", "L3", "memory"];
const LEVEL_COLORS = ["var(--c3)", "var(--c1)", "var(--c5)", "var(--c4)"];

export function AmatFunnelDemo() {
  const [m1, setM1] = useState(0.05);
  const [m2, setM2] = useState(0.4);
  const [m3, setM3] = useState(0.3);
  const r = amat(LAT4, [m1, m2, m3]);
  const served = r.reach.map((x, k) => x - (r.reach[k + 1] ?? 0));
  return (
    <Demo
      title="Where 1,000 accesses end, and what each level costs"
      controls={
        <>
          <Param spec={range({ label: "L1 miss rate", min: 0, max: 0.3, step: 0.01, default: 0.05, format: (v) => pct(v, 0) })} value={m1} onChange={(v) => setM1(v as number)} />
          <Param spec={range({ label: "L2 local miss rate", min: 0, max: 1, step: 0.05, default: 0.4, format: (v) => pct(v, 0) })} value={m2} onChange={(v) => setM2(v as number)} />
          <Param spec={range({ label: "L3 local miss rate", min: 0, max: 1, step: 0.05, default: 0.3, format: (v) => pct(v, 0) })} value={m3} onChange={(v) => setM3(v as number)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "58px minmax(0, 1fr) 76px", gap: "6px 10px", alignItems: "center", fontSize: 12.5 }}>
        <span /><span className="muted" style={{ fontSize: 11.5 }}>light: accesses that reach the level · dark: accesses that it serves</span><span className="muted" style={{ fontSize: 11.5, textAlign: "right" }}>reach / serve</span>
        {LEVEL_NAMES.map((name, k) => (
          <div key={name} style={{ display: "contents" }}>
            <span>{name}<div className="muted" style={{ fontSize: 11 }}>{LAT4[k]} cycles</div></span>
            <div style={{ height: 18, background: "var(--subtle)", borderRadius: 3, position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", inset: 0, width: `${100 * r.reach[k]!}%`, background: LEVEL_COLORS[k], opacity: 0.25, transition: "width 0.2s" }} />
              <div style={{ position: "absolute", inset: 0, width: `${Math.max(100 * served[k]!, served[k]! > 0 ? 0.6 : 0)}%`, background: LEVEL_COLORS[k], transition: "width 0.2s" }} />
            </div>
            <span style={{ ...mono, textAlign: "right" }}>{Math.round(1000 * r.reach[k]!)} / {Math.round(1000 * served[k]!)}</span>
          </div>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 12.5, margin: "16px 0 4px" }}>Average access time = sum of (share that reaches a level × its latency): {r.parts.map((p) => p.toFixed(2)).join(" + ")}</div>
      <div style={{ display: "flex", height: 26, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
        {r.parts.map((p, k) => (
          <div key={k} title={`${LEVEL_NAMES[k]}: ${p.toFixed(2)} cycles`} style={{ width: `${(100 * p) / r.total}%`, background: LEVEL_COLORS[k], color: "#fff", fontSize: 10.5, display: "grid", placeItems: "center", overflow: "hidden", whiteSpace: "nowrap", transition: "width 0.2s" }}>{p / r.total > 0.1 ? LEVEL_NAMES[k] : ""}</div>
        ))}
      </div>
      <Stats
        items={[
          { label: "average access time", value: `${r.total.toFixed(2)} cycles` },
          { label: "L2 global miss rate (m1·m2)", value: pct(r.reach[2]!, 2) },
          { label: "L3 global miss rate", value: pct(r.reach[3]!, 2) },
          { label: "share of time spent on memory", value: pct(r.parts[3]! / r.total, 0) },
        ]}
      />
      <div style={{ marginTop: 8 }}><Legend box items={LEVEL_NAMES.map((n, k) => ({ label: n, color: LEVEL_COLORS[k]! }))} /></div>
    </Demo>
  );
}

// ---------------- inclusion stepper ----------------

const SERVED = ["var(--c3)", "var(--c1)", "var(--c4)"];

export function InclusionStepperDemo() {
  const [mode, setMode] = useState<Inclusion>("inclusive");
  const [which, setWhich] = useState("hot");
  const t = HIER_TRACES.find((x) => x.id === which)!;
  const steps = useMemo(() => runTwoLevel(t.trace, 2, 4, mode), [t, mode]);
  const { i, sim } = useStepper(steps.length, 1.6);
  const cur = steps[i]!;
  const shown = steps.slice(0, i + 1);
  const slots = (items: string[], cap: number) => (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cap}, 40px)`, gap: 6 }}>
      {Array.from({ length: cap }, (_, k) => {
        const x = items[k];
        return <Box key={k} bg={x === cur.item ? SERVED[cur.level] : x ? "var(--subtle)" : "transparent"} fg={x === cur.item ? "#fff" : "var(--fg)"} style={{ height: 32, fontSize: 14, border: x === "H" ? "2px solid var(--c2)" : x ? undefined : "1px dashed var(--border)" }}>{x ?? ""}</Box>;
      })}
    </div>
  );
  const memAfterFirst = steps.slice(6).filter((s) => s.level === 2).length / Math.max(1, steps.length - 6);
  return (
    <Demo
      title="L1 of 2 lines, L2 of 4 lines, one access at a time"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={seg<Inclusion>("Policy", [["inclusive", "Inclusive"], ["nine", "Non-inclusive"], ["exclusive", "Exclusive"]], "inclusive")} value={mode} onChange={(v) => { setMode(v as Inclusion); sim.reset(); }} />
          <Param spec={seg("Trace", HIER_TRACES.map((x) => [x.id, x.label] as [string, string]), "hot")} value={which} onChange={(v) => { setWhich(v as string); sim.reset(); }} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "10px 12px", alignItems: "center" }}>
        <span style={{ fontSize: 12.5 }}>L1</span>{slots(cur.l1, 2)}
        <span style={{ fontSize: 12.5 }}>L2</span>{slots(cur.l2, 4)}
      </div>
      <p style={{ fontSize: 13.5, margin: "12px 0", minHeight: 40 }}>
        Access <b>{cur.item}</b>: found in <b style={{ color: SERVED[cur.level] }}>{["L1", "L2", "memory"][cur.level]}</b>.
        {cur.backInvalidated && <span style={{ color: "var(--c4)" }}> L2 removed {cur.backInvalidated}, so inclusion also removes {cur.backInvalidated} from L1.</span>}
        {cur.level === 0 && mode !== "exclusive" && <span className="muted"> L2 does not see this hit, so its order stays the same.</span>}
      </p>
      <Strip items={shown.map((s, k) => ({ label: s.item, color: SERVED[s.level]!, current: k === i }))} />
      <div style={{ marginTop: 10 }}><Legend box items={[{ label: "served by L1", color: SERVED[0]! }, { label: "by L2", color: SERVED[1]! }, { label: "by memory", color: SERVED[2]! }]} /></div>
      <Stats
        items={which === "hot"
          ? [{ label: "H misses L1 (after its first access)", value: pct(hotMissShare(steps), 0) }, { label: "policy", value: mode }]
          : [{ label: "accesses that go to memory after the first pass", value: pct(memAfterFirst, 0) }, { label: "distinct lines held", value: new Set([...steps.at(-1)!.l1, ...steps.at(-1)!.l2]).size }]}
      />
    </Demo>
  );
}

// ================= Prefetching =================

// ---------------- timeliness ----------------

export function PrefetchTimelineDemo() {
  const [dist, setDist] = useState(2);
  const [work, setWork] = useState(20);
  const LAT = 200, N = 24;
  const rows = useMemo(() => prefetchTimeline(N, work, LAT, dist), [work, dist]);
  const long = useMemo(() => cyclesPerLine(prefetchTimeline(200, work, LAT, dist)), [work, dist]);
  const none = work + LAT;
  const tMax = rows[N - 1]!.end;
  const W = 600, rh = 9, left = 34, H = N * rh + 22;
  const x = (t: number) => left + ((W - left - 6) * t) / tMax;
  return (
    <Demo
      title="Prefetch distance: does the line arrive in time?"
      controls={
        <>
          <Param spec={range({ label: "Prefetch distance (lines ahead)", min: 0, max: 16, step: 1, default: 2 })} value={dist} onChange={(v) => setDist(v as number)} />
          <Param spec={range({ label: "Work per line (cycles)", min: 10, max: 100, step: 5, default: 20 })} value={work} onChange={(v) => setWork(v as number)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>One row per loop iteration. A miss takes {LAT} cycles.</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
        {rows.map((r, k) => {
          const y = k * rh + 2;
          return (
            <g key={k}>
              <text x={left - 5} y={y + rh - 2} fontSize={8} textAnchor="end" fill="var(--muted)">{k}</text>
              <rect x={x(r.issue)} y={y + 3} width={Math.max(0.5, x(r.ready) - x(r.issue))} height={2} fill="var(--c1)" opacity={0.6} />
              {r.stall > 0 && <rect x={x(r.start - r.stall)} y={y} width={x(r.start) - x(r.start - r.stall)} height={rh - 1.5} fill="var(--c4)" opacity={0.8} />}
              <rect x={x(r.start)} y={y} width={Math.max(0.8, x(r.end) - x(r.start))} height={rh - 1.5} fill="var(--c3)" />
            </g>
          );
        })}
        <line x1={left} x2={W - 6} y1={N * rh + 4} y2={N * rh + 4} stroke="var(--border)" />
        <text x={left} y={N * rh + 16} fontSize={9} fill="var(--muted)">0</text>
        <text x={W - 6} y={N * rh + 16} fontSize={9} fill="var(--muted)" textAnchor="end">{Math.round(tMax)} cycles</text>
      </svg>
      <div style={{ marginTop: 6 }}><Legend box items={[{ label: "line in flight from memory", color: "var(--c1)" }, { label: "core waits (stall)", color: "var(--c4)" }, { label: "core works", color: "var(--c3)" }]} /></div>
      <Stats
        items={[
          { label: "cycles per line, steady state", value: long.toFixed(1) },
          { label: "without prefetch", value: none },
          { label: "speedup", value: `${(none / long).toFixed(1)}×` },
          { label: "distance needed (latency ÷ work)", value: Math.ceil(LAT / work) },
        ]}
      />
    </Demo>
  );
}

// ---------------- stride detector stepper ----------------

export function StrideTableDemo() {
  const [perPc, setPerPc] = useState("pc");
  const trace = useMemo(() => twoStreams(10), []);
  const steps = useMemo(() => strideSteps(trace, perPc === "pc"), [trace, perPc]);
  const { i, sim } = useStepper(steps.length, 1.4);
  const cur = steps[i]!;
  const shown = steps.slice(0, i + 1);
  const table = new Map<number, { last: number; delta: number; confident: boolean }>();
  for (const s of shown) table.set(perPc === "pc" ? s.pc : 0, { last: s.addr, delta: s.delta, confident: s.confident });
  const sign = (d: number) => (d >= 0 ? `+${d}` : String(d));
  return (
    <Demo
      title="A stride detector watches two loads"
      actions={<SimButtons sim={sim} />}
      controls={<Param spec={seg("Detector", [["global", "One for all loads"], ["pc", "One per load instruction (PC)"]], "pc")} value={perPc} onChange={(v) => { setPerPc(v as string); sim.reset(); }} />}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Load 1 reads a[i]: lines 0, 3, 6, … Load 2 reads b[i]: lines 1000, 1005, 1010, …</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, auto)", gap: "4px 12px", fontSize: 12, justifyContent: "start", fontVariantNumeric: "tabular-nums" }}>
        <span className="muted">entry</span><span className="muted">last line</span><span className="muted">last delta</span><span className="muted">state</span>
        {[...table.entries()].map(([k, e]) => (
          <div key={k} style={{ display: "contents", color: k === (perPc === "pc" ? cur.pc : 0) ? "var(--fg)" : "var(--muted)" }}>
            <span>{perPc === "pc" ? `load ${k}` : "all loads"}</span><span>{e.last}</span><span>{sign(e.delta)}</span>
            <span style={{ color: e.confident ? "var(--c3)" : "var(--c4)" }}>{e.confident ? "confident" : "learning"}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 13.5, margin: "12px 0", minHeight: 40 }}>
        Load {cur.pc} reads line {cur.addr}: {cur.covered ? <b style={{ color: "var(--c3)" }}>prefetched already, no miss.</b> : <b style={{ color: "var(--c4)" }}>miss.</b>}{" "}
        Delta {sign(cur.delta)}. {cur.target !== null ? <>Same delta twice: prefetch line {cur.target}.</> : <>The delta is not the same as the last one: no prefetch.</>}
      </p>
      <Strip items={shown.map((s, k) => ({ label: String(s.pc), color: s.covered ? "var(--c3)" : "var(--c4)", current: k === i }))} />
      <div style={{ marginTop: 10 }}><Legend box items={[{ label: "load covered by a prefetch", color: "var(--c3)" }, { label: "miss", color: "var(--c4)" }]} /></div>
      <Stats items={[{ label: "covered so far", value: `${shown.filter((s) => s.covered).length} of ${shown.length}` }]} />
    </Demo>
  );
}

// ================= Write policies =================

export function WriteStepperDemo() {
  const [wb, setWb] = useState("wb");
  const [wa, setWa] = useState("wa");
  const [which, setWhich] = useState("memset");
  const t = WRITE_TRACES.find((x) => x.id === which)!;
  const steps = useMemo(() => runWritePolicy(t.ops, 4, wb === "wb", wa === "wa"), [t, wb, wa]);
  const { i, sim } = useStepper(steps.length, 3);
  const cur = steps[i]!;
  const s = cur.state;
  const curLine = Math.floor(cur.op.addr / W_LINE), curWord = Math.floor((cur.op.addr % W_LINE) / 8);
  const log = steps.slice(Math.max(0, i - 5), i + 1).flatMap((x, k, a) => x.bus.map((b) => ({ ...b, now: k === a.length - 1 })));
  const owed = s.lines.filter((l) => l.dirty).length * W_LINE;
  return (
    <Demo
      title="Stores through a 4-line cache, one at a time"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={seg("On a hit", [["wb", "Write-back"], ["wt", "Write-through"]], "wb")} value={wb} onChange={(v) => { setWb(v as string); sim.reset(); }} />
          <Param spec={seg("On a store miss", [["wa", "Write-allocate"], ["na", "No-allocate"]], "wa")} value={wa} onChange={(v) => { setWa(v as string); sim.reset(); }} />
          <Param spec={seg("Program", WRITE_TRACES.map((x) => [x.id, x.label] as [string, string]), "memset")} value={which} onChange={(v) => { setWhich(v as string); sim.reset(); }} />
        </>
      }
    >
      <p style={{ fontSize: 13.5, marginTop: 0, minHeight: 20 }}>
        {cur.op.write ? "Store" : "Load"} to line {curLine}, word {curWord}: <b style={{ color: cur.hit ? "var(--c3)" : "var(--c4)" }}>{cur.hit ? "hit" : "miss"}</b>
        {!cur.hit && cur.op.write && <span className="muted">{wa === "wa" ? " · fetch the line first (read for ownership)" : " · send the store to memory, skip the cache"}</span>}
      </p>
      <div style={{ display: "grid", gap: 5 }}>
        {Array.from({ length: 4 }, (_, k) => {
          const l = s.lines[k];
          return (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "58px repeat(8, 1fr) 26px", gap: 2, alignItems: "center" }}>
              <span style={{ fontSize: 12 }}>{l ? `line ${l.line}` : <span className="muted">empty</span>}</span>
              {Array.from({ length: 8 }, (_, w) => (
                <Box key={w} bg={l && l.line === curLine && w === curWord ? (cur.hit ? "var(--c3)" : "var(--c4)") : l?.words.includes(w) ? "var(--c2)" : l ? "var(--subtle)" : "transparent"} style={{ height: 20, border: l ? undefined : "1px dashed var(--border)" }} />
              ))}
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c4)", textAlign: "center" }}>{l?.dirty ? "D" : ""}</span>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, margin: "12px 0 4px" }}>Memory bus, most recent last</div>
      <div style={{ display: "grid", gap: 2, fontSize: 12, minHeight: 6 * 18, ...mono }}>
        {log.slice(-6).map((b, k) => (
          <div key={k} style={{ color: b.kind === "read line" ? "var(--c1)" : "var(--c2)", fontWeight: b.now ? 700 : 400, opacity: b.now ? 1 : 0.7 }}>
            {b.kind === "read line" ? "← read" : "→ write"} {b.kind === "write word" ? `8 B of line ${b.line}` : `line ${b.line} (64 B)`}
          </div>
        ))}
      </div>
      <Stats
        items={[
          { label: "read from memory", value: `${s.read} B` },
          { label: "written to memory", value: `${s.written} B` },
          { label: "dirty lines still owed", value: `${owed} B` },
          { label: "bus transactions", value: s.ops },
        ]}
      />
      <div style={{ marginTop: 8 }}><Legend box items={[{ label: "word written while the line was cached", color: "var(--c2)" }, { label: "D: dirty, memory is out of date", color: "var(--c4)" }]} /></div>
    </Demo>
  );
}
