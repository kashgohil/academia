/** Demos for "shared memory": one frame in two address spaces, the SPSC ring, the cache lines of its indices, and the cost model. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes, range, select, si, toggle, useParams } from "../../kit";
import {
  CONSUMER_LINES, CORRECT_ORDERS, IPC_COST, IPC_KINDS, IPC_LABEL, LIST_NODES, PRODUCER_LINES, RELAXED_ORDERS, ShmWorld, buildList, exploreSpsc, ipcCost, messageValue, slotKey,
  spscDone, spscInitial, spscLineTraffic, spscLitmus, spscSteps, walkList, type IpcKind, type Msg, type RefMode, type SpscSpec, type SpscState,
} from "../../sims/os/ipc";
import { parse, runCxx, runTso } from "../../sims/memmodel";
import { Banner, MONO } from "./SyncShared";

// ---------------------------------------------------------------- 1. two mappings

const BASE_A = 0x7f0000000000;
const BASE_B = 0x7f5500000000;
const hex = (n: number) => `0x${n.toString(16)}`;

const MAP = {
  mode: select({ label: "What the list stores", options: [{ value: "pointer", label: "Pointers" }, { value: "offset", label: "Offsets" }], default: "pointer", segmented: true }),
  place: select({ label: "Where B maps the region", options: [{ value: "other", label: "Another address" }, { value: "heap", label: "Another address, with B's heap at A's base" }, { value: "same", label: "The same address as A" }], default: "other" }),
};

export function IpcShmMapDemo() {
  const P = useParams("os-ipc-map", MAP);
  const mode = P.values.mode as RefMode;
  const place = P.values.place as "other" | "heap" | "same";
  const [walked, setWalked] = useState(false);
  const { world, walk, frames } = useMemo(() => {
    const w = new ShmWorld(2);
    w.addProcess("A", BASE_A);
    w.addProcess("B", place === "same" ? BASE_A : BASE_B, { heapAt: place === "heap" ? BASE_A : undefined });
    buildList(w, "A", mode);
    const r = walkList(w, "B", mode);
    return { world: w, walk: r, frames: [w.frameOf("A", 0)!, w.frameOf("A", 0x1000)!] };
  }, [mode, place]);
  const baseB = world.procs.B!.base;
  const W = 360, H = 138, COL = 100, FX = 130, FW = 100;
  const row = (i: number) => 38 + i * 56;
  const refs = LIST_NODES.map((n, i) => {
    const next = LIST_NODES[i + 1];
    const stored = next ? (mode === "pointer" ? hex(BASE_A + next.offset) : hex(next.offset)) : "end";
    return { off: n.offset, value: n.value, stored };
  });
  const banner = !walked ? "A built the list. Click the button to make B walk it." :
    walk.verdict === "ok" ? `B reads ${walk.values.join(", ")}: the whole list.` :
    walk.verdict === "segv" ? `B follows ${hex(walk.hops[0]!.stored)}. That is A's address. B has no mapping there, so the CPU faults and the kernel sends SIGSEGV.` :
    `B follows ${hex(walk.hops[0]!.stored)}. B's heap is at that address, so B reads ${walk.hops[0]!.value} with no fault. This is the worse failure: the data is wrong, and nothing reports it.`;
  return (
    <Demo
      title="Two address spaces, one frame"
      controls={<>
        <Param spec={MAP.mode} value={mode} onChange={(v) => { P.set("mode", v as never); setWalked(false); }} />
        <Param spec={MAP.place} value={place} onChange={(v) => { P.set("place", v as never); setWalked(false); }} />
      </>}
    >
      <div className="row" style={{ marginBottom: 8 }}><button className="btn primary" onClick={() => setWalked(true)}>B walks the list</button></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Two mappings of the same frames" style={{ width: "100%", maxWidth: 560, display: "block", margin: "0 auto" }}>
        <text x={COL / 2} y={14} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--c1)">Process A</text>
        <text x={W - COL / 2} y={14} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--c2)">Process B</text>
        <text x={W / 2} y={14} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--fg)">Frames</text>
        {[0, 1].map((i) => (
          <g key={i}>
            <rect x={0} y={row(i) - 16} width={COL} height={42} rx={4} fill="var(--bg)" stroke="var(--c1)" />
            <text x={COL / 2} y={row(i) + 3} textAnchor="middle" fontSize={10.5} fontFamily={MONO} fill="var(--fg)">{hex(BASE_A + i * 0x1000)}</text>
            <text x={COL / 2} y={row(i) + 17} textAnchor="middle" fontSize={10} fill="var(--muted)">PTE of A</text>
            <rect x={W - COL} y={row(i) - 16} width={COL} height={42} rx={4} fill="var(--bg)" stroke="var(--c2)" />
            <text x={W - COL / 2} y={row(i) + 3} textAnchor="middle" fontSize={10.5} fontFamily={MONO} fill="var(--fg)">{hex(baseB + i * 0x1000)}</text>
            <text x={W - COL / 2} y={row(i) + 17} textAnchor="middle" fontSize={10} fill="var(--muted)">PTE of B</text>
            <rect x={FX} y={row(i) - 16} width={FW} height={42} rx={4} fill="var(--subtle)" stroke="var(--border)" />
            <text x={W / 2} y={row(i) + 3} textAnchor="middle" fontSize={11} fontFamily={MONO} fill="var(--fg)">pfn {hex(frames[i]!)}</text>
            <text x={W / 2} y={row(i) + 17} textAnchor="middle" fontSize={10} fill="var(--muted)">page {i} of the file</text>
            <line x1={COL} y1={row(i) + 5} x2={FX} y2={row(i) + 5} stroke="var(--c1)" strokeWidth={1.5} />
            <line x1={W - COL} y1={row(i) + 5} x2={FX + FW} y2={row(i) + 5} stroke="var(--c2)" strokeWidth={1.5} />
          </g>
        ))}
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>The list, as A stored it in the region</div>
          <div style={{ display: "grid", gridTemplateColumns: "auto auto 1fr", gap: "1px 8px", fontFamily: MONO, fontSize: 11 }}>
            <span className="muted">offset</span><span className="muted">value</span><span className="muted">next</span>
            {refs.map((r) => [
              <span key={`o${r.off}`}>{hex(r.off)}</span>,
              <span key={`v${r.off}`}>{r.value}</span>,
              <span key={`s${r.off}`} style={{ overflowWrap: "anywhere" }}>{r.stored}</span>,
            ])}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>The walk in B</div>
          <div style={{ display: "grid", gap: 1, fontFamily: MONO, fontSize: 11 }}>
            {!walked && <span className="muted">not yet</span>}
            {walked && walk.hops.map((h, i) => (
              <div key={i} style={{ overflowWrap: "anywhere", color: h.ok && h.inShared ? "var(--fg)" : "var(--c4)" }}>
                {hex(h.va)}: {!h.ok ? "SIGSEGV" : h.inShared ? `node, value ${h.value}` : `wrong data, value ${h.value}`}
              </div>
            ))}
          </div>
        </div>
      </div>
      <Banner tone={!walked ? "plain" : walk.verdict === "ok" ? "good" : "bad"}>{banner}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "frames used", value: world.kernel.usedFrames },
          { label: "references to page 0", value: world.kernel.frames.get(frames[0]!)!.refs },
          { label: "base of A", value: <span style={{ fontSize: 12.5 }}>{hex(BASE_A)}</span> },
          { label: "base of B", value: <span style={{ fontSize: 12.5 }}>{hex(baseB)}</span> },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 2. the ring

const SPSC = {
  relaxed: toggle({ label: "Drop release and acquire (all relaxed)", default: false }),
};
const CAP = 2, MSGS = 3;

function MsgChips({ name, list, from, hot }: { name: string; list: Msg[]; from: number; hot?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 11, fontFamily: MONO, marginBottom: 2 }}>{name}</div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", minHeight: 26, padding: 3, border: `1px solid ${hot ? "var(--c5)" : "var(--border)"}`, borderRadius: 5 }}>
        {list.map((m, i) => {
          const visible = i >= from;
          return <span key={i} title={visible ? "the consumer may read this write" : "the consumer can no longer read this write"} style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, padding: "1px 7px", borderRadius: 3, border: `1.5px solid ${visible ? "var(--c5)" : "var(--border)"}`, color: visible ? "var(--fg)" : "var(--faint)", textDecoration: visible ? "none" : "line-through" }}>{m.v}</span>;
        })}
      </div>
    </div>
  );
}

function SideCode({ title, lines, pc, done, color, steps, onStep }: { title: string; lines: string[]; pc: number; done: boolean; color: string; steps: { id: string; text: string }[]; onStep: (id: string) => void }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6, minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 3 }}>{title}{done ? ": done" : ""}</div>
      {lines.map((l, i) => (
        <div key={i} style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.45, padding: "0 4px", borderRadius: 3, outline: !done && pc === i ? `1.5px solid ${color}` : "none", outlineOffset: -1, color: !done && pc === i ? "var(--fg)" : "var(--muted)", overflowWrap: "anywhere" }}>{l}</div>
      ))}
      <div className="row" style={{ gap: 4, marginTop: 5 }}>
        {steps.map((s) => <button key={s.id} className="btn" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => onStep(s.id)}>{s.text}</button>)}
      </div>
    </div>
  );
}

export function IpcSpscRingDemo() {
  const P = useParams("os-ipc-spsc", SPSC);
  const relaxed = P.values.relaxed;
  const orders = relaxed ? RELAXED_ORDERS : CORRECT_ORDERS;
  const spec: SpscSpec = useMemo(() => ({ capacity: CAP, messages: MSGS, orders }), [orders]);
  const res = useMemo(() => exploreSpsc(spec), [spec]);
  const check = useMemo(() => {
    // The memmodel check uses a smaller ring, which stays inside the litmus limit of 8 instructions per thread.
    const p = parse(spscLitmus({ capacity: 2, messages: 2, orders }));
    const key = (o: { regs: Record<string, number> }) => `${o.regs.r0},${o.regs.r1}`;
    return {
      cxx: runCxx(p).outcomes.filter((o) => !o.hang).map((o) => ({ k: key(o), racy: o.racy })),
      tso: [...new Set(runTso(p, true).outcomes.filter((o) => !o.hang).map(key))],
    };
  }, [orders]);
  const [path, setPath] = useState<{ relaxed: boolean; ids: string[] }>({ relaxed, ids: [] });
  const ids = path.relaxed === relaxed ? path.ids : [];
  const trail = useMemo(() => {
    const out: SpscState[] = [spscInitial(spec)];
    for (const id of ids) {
      const st = spscSteps(spec, out[out.length - 1]!).find((x) => x.id === id);
      if (st) out.push(st.next);
    }
    return out;
  }, [spec, ids]);
  const s = trail[trail.length - 1]!;
  const steps = spscSteps(spec, s);
  const go = (id: string) => setPath({ relaxed, ids: [...ids, id] });
  const nextSlot = s.c.i < MSGS ? s.c.i % CAP : -1;
  const finished = spscDone(spec, s);
  return (
    <Demo
      title="An SPSC ring"
      actions={<>
        <button className="btn" disabled={ids.length === 0} onClick={() => setPath({ relaxed, ids: ids.slice(0, -1) })}>Back</button>
        <button className="btn ghost" onClick={() => setPath({ relaxed, ids: [] })}>Reset</button>
      </>}
      controls={<Param spec={SPSC.relaxed} value={relaxed} onChange={(v) => P.set("relaxed", v as boolean)} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
        <SideCode title="Producer" lines={PRODUCER_LINES(orders)} pc={s.p.pc} done={s.p.i >= MSGS} color="var(--c1)" steps={steps.filter((x) => x.actor === 0)} onStep={go} />
        <SideCode title="Consumer" lines={CONSUMER_LINES(orders)} pc={s.c.pc} done={s.c.i >= MSGS} color="var(--c2)" steps={steps.filter((x) => x.actor === 1)} onStep={go} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginTop: 10 }}>
        {s.slots.map((l, i) => <MsgChips key={i} name={`slot[${i}]`} list={l} from={s.c.view[slotKey(i)] ?? 0} hot={i === nextSlot && s.c.pc === 1} />)}
        <MsgChips name="tail" list={s.tail} from={s.c.view.tail ?? 0} />
        <MsgChips name="head" list={s.head} from={s.p.view.head ?? 0} />
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: "5px 0 0" }}>Each box keeps all writes to one location, oldest first. A crossed value is one that the reader of that location can no longer see. The consumer may read any value that is not crossed.</p>
      <div style={{ fontFamily: MONO, fontSize: 12.5, marginTop: 6 }}>
        consumer got: {s.got.length === 0 ? <span className="muted">nothing yet</span> : s.got.map((v, i) => <span key={i} style={{ marginRight: 6, color: v === messageValue(i) ? "var(--c3)" : "var(--c4)", fontWeight: 600 }}>{v}</span>)}
      </div>
      <Banner tone={s.stale ? "bad" : finished ? "good" : "plain"}>{s.stale ?? (s.say || "Click a step. When a load has several values that it may read, you choose. In real hardware, timing chooses.")}</Banner>
      {res.violation && <div className="row" style={{ marginTop: 8 }}><button className="btn" onClick={() => setPath({ relaxed, ids: res.violation!.schedule })}>Show the stale read</button></div>}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "states searched", value: res.states },
          { label: "stale read", value: res.violation ? `yes: ${res.violation.schedule.length} steps` : "none" },
          { label: "memmodel, C++ outcomes", value: <span style={{ fontSize: 12.5, fontFamily: MONO }}>{check.cxx.map((o) => o.k).join("  ")}</span> },
          { label: "memmodel, x86-TSO outcomes", value: <span style={{ fontSize: 12.5, fontFamily: MONO }}>{check.tso.join("  ")}</span> },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 3. cache lines

const LINES = {
  backlog: range({ label: "Messages between head and tail", min: 1, max: 32, step: 1, default: 8 }),
};

export function IpcSpscLinesDemo() {
  const P = useParams("os-ipc-lines", LINES);
  const backlog = P.values.backlog;
  const [padded, setPadded] = useState(false);
  const [cached, setCached] = useState(false);
  const grid = useMemo(() => [[false, false], [true, false], [false, true], [true, true]].map(([pad, c]) => ({ pad: pad!, c: c!, r: spscLineTraffic({ padded: pad!, cached: c!, backlog }) })), [backlog]);
  const cur = grid.find((g) => g.pad === padded && g.c === cached)!.r;
  const max = Math.max(...grid.map((g) => g.r.perMessage));
  return (
    <Demo title="The cache lines of head and tail" controls={<Param spec={LINES.backlog} value={backlog} onChange={(v) => P.set("backlog", v as number)} />}>
      <div className="row" style={{ gap: 14, marginBottom: 10, fontSize: 13 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={padded} onChange={(e) => setPadded(e.target.checked)} /> alignas(64) on head and on tail</label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={cached} onChange={(e) => setCached(e.target.checked)} /> Each side keeps a cached copy of the other index</label>
      </div>
      <div style={{ display: "flex", gap: 6, fontFamily: MONO, fontSize: 12, marginBottom: 10, flexWrap: "wrap" }}>
        {(padded ? [["head"], ["tail"]] : [["head", "tail"]]).map((line, i) => (
          <div key={i} style={{ border: "1.5px solid var(--border)", borderRadius: 5, padding: "4px 8px", display: "flex", gap: 6, alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 10.5 }}>line {i + 1}</span>
            {line.map((x) => <span key={x} style={{ padding: "1px 6px", borderRadius: 3, color: "var(--bg)", background: x === "head" ? "var(--c2)" : "var(--c1)" }}>{x}</span>)}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {grid.map((g) => {
          const on = g.pad === padded && g.c === cached;
          return (
            <div key={`${g.pad}/${g.c}`} style={{ display: "grid", gridTemplateColumns: "minmax(112px, 150px) 1fr auto", gap: 8, alignItems: "center", fontSize: 12, fontWeight: on ? 600 : 400 }}>
              <span style={{ color: on ? "var(--fg)" : "var(--muted)" }}>{g.pad ? "separate lines" : "one line"}, {g.c ? "cached" : "no cache"}</span>
              <div style={{ background: "var(--subtle)", borderRadius: 3, height: 14 }}><div style={{ width: `${(g.r.perMessage / max) * 100}%`, height: "100%", borderRadius: 3, background: on ? "var(--c1)" : "var(--faint)" }} /></div>
              <span style={{ fontFamily: MONO }}>{g.r.perMessage.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "line transfers per message", value: cur.perMessage.toFixed(2) },
          { label: "index reads per message", value: cur.indexReadsPerMessage.toFixed(2) },
          { label: `model time per message, at ${IPC_COST.lineNs} ns per transfer`, value: `${Math.round(cur.perMessage * IPC_COST.lineNs)} ns` },
        ]} />
      </div>
      <p className="muted" style={{ fontSize: 11.5, margin: "6px 0 0" }}>The ring's accesses run through the MESI simulator, with the steps of the two sides in turn. Other schedules give other counts.</p>
    </Demo>
  );
}

// ---------------------------------------------------------------- 4. the comparison

const CMP = {
  metric: select({ label: "Show", options: [{ value: "latency", label: "Latency" }, { value: "rate", label: "Messages per second" }, { value: "bytes", label: "Bytes per second" }], default: "latency", segmented: true }),
  spin: toggle({ label: "The reader spins and never sleeps", default: true }),
  size: range({ label: "Message size", min: 64, max: 1 << 20, log: true, default: 64, format: (v) => bytes(Math.round(v)) }),
  wake: range({ label: "Wake a sleeper (model input)", min: 1000, max: 50000, step: 500, default: IPC_COST.wakeNs, format: (v) => `${(v / 1000).toFixed(1)} µs` }),
};
const KIND_COLOR: Record<IpcKind, string> = { shm: "var(--c3)", pipe: "var(--c1)", unix: "var(--c2)" };
const SIZES = Array.from({ length: 15 }, (_, i) => 64 * 2 ** i);

export function IpcCompareDemo() {
  const P = useParams("os-ipc-cmp", CMP);
  const { metric, spin, size, wake } = P.values;
  const n = Math.round(size);
  const cost = useMemo(() => ({ ...IPC_COST, wakeNs: wake }), [wake]);
  const value = (k: IpcKind, b: number) => {
    const r = ipcCost(k, b, spin, cost);
    return metric === "latency" ? r.latencyNs : metric === "rate" ? r.msgsPerSec : r.bytesPerSec;
  };
  const lines = IPC_KINDS.map((k) => ({ k, pts: SIZES.map((b) => [b, value(k, b)] as [number, number]) }));
  const all = lines.flatMap((l) => l.pts.map((p) => p[1]));
  const lo = Math.min(...all) * 0.7, hi = Math.max(...all) * 1.4;
  const decades: number[] = [];
  for (let e = Math.ceil(Math.log10(lo)); e <= Math.floor(Math.log10(hi)); e++) decades.push(10 ** e);
  const unit = "msg/s";
  const show = (v: number) => (metric === "latency" ? si(v * 1e-9, "s") : metric === "bytes" ? `${(v / 2 ** 30).toFixed(2)} GiB/s` : si(v, unit));
  const shm = ipcCost("shm", n, spin, cost);
  return (
    <Demo title="Shared memory, pipes and Unix sockets: a model" controls={<>
      <Param spec={CMP.metric} value={metric} onChange={(v) => P.set("metric", v as never)} />
      <Param spec={CMP.size} value={size} onChange={(v) => P.set("size", v as number)} />
      <Param spec={CMP.wake} value={wake} onChange={(v) => P.set("wake", v as number)} />
      <Param spec={CMP.spin} value={spin} onChange={(v) => P.set("spin", v as boolean)} />
    </>}>
      <Plot x={[64, 1 << 20]} y={[lo, hi]} logX logY height={250} xLabel="message size" yLabel={metric === "latency" ? "one-way latency" : metric === "rate" ? "messages per second" : "bytes per second"} xTicks={[64, 1024, 16384, 262144]} xFormat={(v) => bytes(v)} yTicks={decades} yFormat={(v) => (metric === "latency" ? si(v * 1e-9, "s", 2) : si(v, "", 2))}>
        <RuleX at={n} />
        {lines.map((l) => <Line key={l.k} color={KIND_COLOR[l.k]} points={l.pts} />)}
      </Plot>
      <Legend items={IPC_KINDS.map((k) => ({ label: IPC_LABEL[k], color: KIND_COLOR[k] }))} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          ...IPC_KINDS.map((k) => ({ label: `${IPC_LABEL[k]}, ${bytes(n)}`, value: show(value(k, n)) })),
          { label: "kernel entries for shared memory", value: shm.kernelEntries },
        ]} />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Model inputs: a syscall is {IPC_COST.syscallNs} ns, a 4 KiB copy is {IPC_COST.copy4kNs} ns, or {IPC_COST.coldCopy4kNs} ns if another core wrote the data, a line transfer is {IPC_COST.lineNs} ns, and an skb is {IPC_COST.skbNs} ns. Throughput assumes two cores, so the slower side sets the rate.
      </p>
    </Demo>
  );
}
