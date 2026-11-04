import { useEffect, useRef, useState, type ReactNode } from "react";
import { Demo, Stats, Param, useSim, range, select, pct } from "../../kit";
import { Heap, loadHeapSim, overhead, extFrag, REGION, type HeapConfig, type HeapSim, type HeapStats } from "../../wasm/heapsim";
import { mulberry32, type Rng } from "../../sims/rng";
import { HeapView, KIND_STYLE } from "./HeapView";

export interface Scenario {
  label: string;
  /** Runs against a freshly reset heap. Return log lines. */
  run: (heap: Heap) => string[];
}

export interface HeapPlaygroundProps {
  title: string;
  config: HeapConfig;
  controls?: ReactNode;
  maxSize?: number;
  defaultSize?: number;
  aligns?: number[];
  /** Show Begin/End scope buttons (mark/restore). */
  scope?: boolean;
  scenarios?: Scenario[];
  /** Size distribution for the churn workload. */
  randomSize?: (rng: Rng) => number;
  bytesPerRow?: number;
  links?: boolean;
  /** Extra readouts computed from the heap. */
  extraStats?: (h: Heap, s: HeapStats) => { label: string; value: ReactNode }[];
  children?: ReactNode;
}

export function HeapPlayground(p: HeapPlaygroundProps) {
  const [w, setW] = useState<HeapSim | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { loadHeapSim().then(setW, (e) => setErr(String(e))); }, []);

  const key = JSON.stringify(p.config);
  const [heap, setHeap] = useState<Heap | null>(null);
  useEffect(() => {
    if (!w) return;
    const h = new Heap(w, p.config);
    setHeap(h);
    return () => h.dispose();
  }, [w, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [log, setLog] = useState<string[]>([]);
  const say = (...lines: string[]) => setLog((l) => [...lines.reverse(), ...l].slice(0, 6));
  const [size, setSize] = useState(p.defaultSize ?? 32);
  const [align, setAlign] = useState("8");
  const marks = useRef<number[]>([]);
  const rng = useRef(mulberry32(7));

  useEffect(() => { setLog([]); marks.current = []; rng.current = mulberry32(7); }, [heap]);

  const doAlloc = (sz: number, al: number) => {
    if (!heap) return;
    const a = heap.alloc(sz, al);
    if (a !== null) say(`alloc(${sz}, align ${al}) → 0x${a.toString(16).padStart(4, "0")}`);
    else {
      const s = heap.stats();
      say(s.free >= sz
        ? `alloc(${sz}) failed: ${s.free} B free, but the largest free block is ${s.largestFree} B`
        : `alloc(${sz}) failed: only ${s.free} B free`);
    }
    bump();
    return a;
  };
  const doFree = (addr: number) => {
    if (!heap) return;
    const ok = heap.free(addr);
    say(ok ? `free(0x${addr.toString(16).padStart(4, "0")})` : `free(0x${addr.toString(16)}) rejected`);
    bump();
  };
  const liveRegions = () => heap?.regions().filter((r) => r.kind === REGION.live) ?? [];
  const freeRandom = () => {
    const live = liveRegions();
    if (live.length) doFree(live[Math.floor(rng.current() * live.length)]!.off);
  };

  const sim = useSim({
    dt: 1 / 10,
    step: () => {
      const live = liveRegions();
      if (!live.length || rng.current() < 0.55) {
        const sz = p.randomSize ? p.randomSize(rng.current) : 1 + Math.floor(rng.current() * (p.maxSize ?? 256));
        doAlloc(sz, 8);
      } else freeRandom();
    },
  });

  if (err) return <div className="empty">Couldn't load the allocator simulator: {err}</div>;
  if (!heap) return <div className="demo" style={{ height: 200 }} />;

  const regions = heap.regions();
  const s = heap.stats();
  const cap = regions.reduce((n, r) => n + r.len, 0);

  return (
    <Demo
      title={p.title}
      actions={
        <>
          <button className="btn primary" onClick={() => doAlloc(size, Number(align))}>Allocate {size} B</button>
          <button className="btn" onClick={freeRandom} disabled={s.liveCount === 0}>Free random</button>
          <button className="btn" onClick={sim.toggle}>{sim.running ? "Stop churn" : "Churn"}</button>
          <button className="btn ghost" onClick={() => { heap.reset(); marks.current = []; say("reset()"); bump(); }}>Reset</button>
        </>
      }
      controls={
        <>
          {p.controls}
          <Param spec={range({ label: "Request size", min: 1, max: p.maxSize ?? 256, step: 1, default: 32, format: (v) => `${v} B` })} value={size} onChange={(v) => setSize(v as number)} />
          <Param
            spec={select({ label: "Alignment", options: (p.aligns ?? [1, 2, 4, 8, 16]).map((a) => ({ value: String(a), label: String(a) })), default: "8", segmented: true })}
            value={align}
            onChange={(v) => setAlign(v as string)}
          />
        </>
      }
    >
      {(p.scope || p.scenarios?.length) && (
        <div className="row" style={{ marginBottom: 12 }}>
          {p.scope && (
            <>
              <button className="btn" onClick={() => { marks.current.push(heap.mark()); say(`begin scope (depth ${marks.current.length})`); bump(); }}>Begin scope</button>
              <button className="btn" disabled={!marks.current.length} onClick={() => { heap.restore(marks.current.pop()!); say(`end scope (depth ${marks.current.length})`); bump(); }}>End scope</button>
            </>
          )}
          {p.scenarios?.map((sc) => (
            <button key={sc.label} className="btn" onClick={() => { heap.reset(); marks.current = []; setLog([]); say(...sc.run(heap)); bump(); }}>
              {sc.label}
            </button>
          ))}
        </div>
      )}
      <HeapView
        regions={regions}
        cap={cap}
        bytesPerRow={p.bytesPerRow}
        links={p.links ? heap.links() : undefined}
        onPick={(r) => r.kind === REGION.live && doFree(r.off)}
      />
      <div style={{ height: 14 }} />
      <Composition s={s} cap={cap} />
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "live", value: `${s.live} B` },
          { label: "overhead", value: `${overhead(s)} B` },
          { label: "free", value: `${s.free} B` },
          { label: "largest free block", value: `${s.largestFree} B` },
          { label: "external fragmentation", value: pct(extFrag(s), 0) },
          ...(p.extraStats?.(heap, s) ?? []),
        ]}
      />
      <div style={{ marginTop: 12, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, color: "var(--muted)", minHeight: 18 * 3 }}>
        {log.length ? log.map((l, i) => <div key={i} style={{ opacity: 1 - i * 0.13 }}>{l}</div>) : <div>Allocate, or click a live block to free it.</div>}
      </div>
      {p.children}
    </Demo>
  );
}

/** One horizontal bar showing where every byte went. */
export function Composition({ s, cap }: { s: HeapStats; cap: number }) {
  const parts = [
    { k: REGION.live, v: s.live },
    { k: REGION.meta, v: s.meta },
    { k: REGION.pad, v: s.pad },
    { k: REGION.slack, v: s.slack },
    { k: REGION.dead, v: s.dead },
    { k: REGION.free, v: s.free },
  ];
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--subtle)", border: "1px solid var(--border)" }}>
      {parts.map((x) => (
        <div
          key={x.k}
          title={`${KIND_STYLE[x.k]!.label}: ${x.v} B`}
          style={{ width: `${(100 * x.v) / cap}%`, background: x.k === REGION.free ? "transparent" : `var(${KIND_STYLE[x.k]!.color})`, opacity: x.k === REGION.slack ? 0.55 : 1 }}
        />
      ))}
    </div>
  );
}
