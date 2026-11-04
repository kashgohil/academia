/** Demos for "pipes": the ring with one writer and one reader, two writers and PIPE_BUF, and the throughput model. */
import { useMemo, useState, type ReactNode } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes, range, select, toggle, useParams } from "../../kit";
import {
  PIPE_COST, PIPE_FACTS, Pipe, explorePipe, findSplit, pipeInterleaveModel, pipeThroughput, type InterleaveState, type Run, type WriteResult,
} from "../../sims/os/ipc";
import { replay } from "../../sims/os/sync/machine";
import { Banner, MONO } from "./SyncShared";

const WRITER_COLOR: Record<string, string> = { w: "var(--c1)", A: "var(--c1)", B: "var(--c2)", file: "var(--c5)" };

// ---------------------------------------------------------------- 1. the ring

const RING = {
  slots: select({ label: "Pipe capacity (F_SETPIPE_SZ)", options: [{ value: "16", label: "64 KiB: 16 slots" }, { value: "4", label: "16 KiB: 4 slots" }], default: "16", segmented: true }),
  write: select({ label: "Write size", options: ["100", "2048", "2049", "4096", "8192", "65536"].map((v) => ({ value: v, label: `${Number(v) >= 8192 ? bytes(Number(v)) : `${v} B`}` })), default: "2049", segmented: true }),
  read: select({ label: "Read size", options: ["1000", "4096", "65536"].map((v) => ({ value: v, label: Number(v) >= 4096 ? bytes(Number(v)) : `${v} B` })), default: "4096", segmented: true }),
  nonblock: toggle({ label: "O_NONBLOCK on both ends", default: false }),
};

interface RingState { pipe: Pipe; log: { text: string; tone?: "bad" | "good" }[]; killed: boolean }

const arc = (cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) => {
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
};

function RingView({ pipe, writerAsleep, readerAsleep }: { pipe: Pipe; writerAsleep: boolean; readerAsleep: boolean }) {
  const n = pipe.ringSize;
  const CX = 130, CY = 130, R0 = 68, R1 = 108;
  const gap = n > 8 ? 0.016 : 0.03;
  const bySlot = new Map(pipe.slots.map((s) => [s.index, s.buf]));
  const angle = (i: number) => (i / n) * 2 * Math.PI;
  const headIdx = pipe.head & (n - 1);
  const tailIdx = pipe.tail & (n - 1);
  const tick = (i: number, label: string, color: string, r: number) => {
    const a = angle(i) + Math.PI / n;
    const x = CX + r * Math.sin(a), y = CY - r * Math.cos(a);
    return (
      <g>
        <line x1={CX + (R1 + 2) * Math.sin(a)} y1={CY - (R1 + 2) * Math.cos(a)} x2={CX + (r - 7) * Math.sin(a)} y2={CY - (r - 7) * Math.cos(a)} stroke={color} strokeWidth={2} />
        <text x={x} y={y + 3.5} fontSize={10.5} fontWeight={600} textAnchor="middle" fill={color}>{label}</text>
      </g>
    );
  };
  return (
    <svg viewBox="0 0 260 260" role="img" aria-label="Pipe ring" style={{ width: "100%", maxWidth: 300, display: "block", margin: "0 auto" }}>
      {Array.from({ length: n }, (_, i) => {
        const a0 = angle(i) + gap, a1 = angle(i + 1) - gap;
        const b = bySlot.get(i);
        const page = pipe.pageSize;
        const span = a1 - a0;
        return (
          <g key={i}>
            <path d={arc(CX, CY, R0, R1, a0, a1)} fill="var(--subtle)" stroke="var(--border)" />
            {b && b.len > 0 && (
              <path d={arc(CX, CY, R0 + 1, R1 - 1, a0 + (b.offset / page) * span, a0 + ((b.offset + b.len) / page) * span)} fill={WRITER_COLOR[b.runs[0]?.src ?? "w"]} opacity={0.85} />
            )}
            {b && b.canMerge && b.offset + b.len < page && <title>{`Slot ${i}: ${b.len} bytes, ${page - b.offset - b.len} free at the end`}</title>}
          </g>
        );
      })}
      {headIdx === tailIdx
        ? tick(headIdx, "head = tail", "var(--fg)", 119)
        : <>{tick(headIdx, "head", "var(--c3)", 121)}{tick(tailIdx, "tail", "var(--c5)", 121)}</>}
      <text x={CX} y={CY - 12} textAnchor="middle" fontSize={20} fontWeight={600} fill="var(--fg)">{bytes(pipe.buffered)}</text>
      <text x={CX} y={CY + 6} textAnchor="middle" fontSize={11} fill="var(--muted)">{pipe.used} of {n} slots</text>
      <text x={CX} y={CY + 22} textAnchor="middle" fontSize={11} fill={writerAsleep || readerAsleep ? "var(--c4)" : "var(--muted)"}>{writerAsleep ? "writer sleeps" : readerAsleep ? "reader sleeps" : pipe.full ? "ring full" : pipe.empty ? "ring empty" : ""}</text>
    </svg>
  );
}

const describeWrite = (n: number, r: WriteResult, resumed: boolean): { text: string; tone?: "bad" | "good" } => {
  const call = resumed ? "The writer wakes: write" : `write(fd, buf, ${n})`;
  if (r.status === "blocked") return { text: `${call} has ${r.written} of ${r.total} bytes in. The ring is full, so it sleeps.`, tone: "bad" };
  if (r.status === "EAGAIN") return { text: `${call} = -1, EAGAIN. The ring is full, and the write did not wait.`, tone: "bad" };
  if (r.status === "EPIPE") return { text: `${call} = -1, EPIPE. No reader exists, so the kernel sends SIGPIPE. The default action kills the writer.`, tone: "bad" };
  if (r.sigpipe) return { text: `${call} = ${r.written}. The last reader closed. The kernel sends SIGPIPE, and the default action kills the writer.`, tone: "bad" };
  return { text: `${call} = ${r.written}${r.written < r.total ? ` (partial, of ${r.total})` : ""}` };
};

export function IpcPipeRingDemo() {
  const P = useParams("os-ipc-ring", RING);
  const slots = Number(P.values.slots);
  const fresh = (): RingState => ({ pipe: new Pipe({ slots }), log: [], killed: false });
  const [st, setSt] = useState<RingState>(fresh);
  const pipe = st.pipe.ringSize === slots ? st.pipe : new Pipe({ slots });
  const state = st.pipe === pipe ? st : { pipe, log: [], killed: false };
  const writeSize = Number(P.values.write), readSize = Number(P.values.read), nonblock = P.values.nonblock;

  const apply = (f: (p: Pipe, log: RingState["log"], s: { killed: boolean }) => void) => {
    const p = pipe.clone();
    const log = [...state.log];
    const s = { killed: state.killed };
    f(p, log, s);
    settle(p, log, s);
    setSt({ pipe: p, log: log.slice(-7), killed: s.killed });
  };
  const noteWrite = (p: Pipe, log: RingState["log"], s: { killed: boolean }, n: number, r: WriteResult, resumed: boolean) => {
    log.push(describeWrite(n, r, resumed));
    if (r.sigpipe) { s.killed = true; p.closeWrite(); }
  };
  const settle = (p: Pipe, log: RingState["log"], s: { killed: boolean }) => {
    // The kernel wakes a sleeping partner as soon as it can go on.
    for (let i = 0; i < 40; i++) {
      if (p.canResumeRead("r")) {
        const r = p.resumeRead("r");
        log.push({ text: r.status === "EOF" ? "The reader wakes: read = 0. That is EOF." : `The reader wakes: read = ${r.n}`, tone: r.status === "EOF" ? "good" : undefined });
      } else if (p.canResumeWrite("w")) {
        noteWrite(p, log, s, 0, p.resumeWrite("w"), true);
      } else return;
    }
  };

  const wAsleep = pipe.writeBlocked("w"), rAsleep = pipe.readBlocked("r");
  const canWrite = !wAsleep && !state.killed && pipe.writers > 0;
  const canRead = !rAsleep && pipe.readers > 0;

  const doWrite = () => apply((p, log, s) => noteWrite(p, log, s, writeSize, p.write("w", writeSize, { nonblock }), false));
  const fill = () => apply((p, log, s) => {
    let count = 0;
    for (let i = 0; i < 2000; i++) {
      const r = p.write("w", writeSize, { nonblock });
      count++;
      if (r.status !== "ok" || r.written < r.total) {
        log.push({ text: `${count - 1} writes of ${writeSize} bytes went in whole. Bytes in the pipe: ${p.buffered}.` });
        noteWrite(p, log, s, writeSize, r, false);
        return;
      }
    }
  });
  const doRead = () => apply((p, log) => {
    const r = p.read("r", readSize, { nonblock });
    log.push({
      text: r.status === "EOF" ? `read(fd, buf, ${readSize}) = 0. The pipe is empty, and no write end is open. That is EOF.`
        : r.status === "blocked" ? `read(fd, buf, ${readSize}): the ring is empty, so the reader sleeps.`
        : r.status === "EAGAIN" ? `read(fd, buf, ${readSize}) = -1, EAGAIN. The ring is empty, and the read did not wait.`
        : `read(fd, buf, ${readSize}) = ${r.n}`,
      tone: r.status === "EOF" ? "good" : r.status === "ok" ? undefined : "bad",
    });
  });
  const closeW = () => apply((p, log) => { p.closeWrite(); log.push({ text: "close(write end). No writer remains." }); });
  const closeR = () => apply((p, log) => { p.closeRead(); log.push({ text: "close(read end). No reader remains." }); });

  return (
    <Demo
      title="A pipe: a kernel ring of pages"
      actions={<button className="btn ghost" onClick={() => setSt(fresh())}>Reset</button>}
      controls={<>
        <Param spec={RING.slots} value={P.values.slots} onChange={(v) => { P.set("slots", v as never); setSt({ pipe: new Pipe({ slots: Number(v) }), log: [], killed: false }); }} />
        <Param spec={RING.write} value={P.values.write} onChange={(v) => P.set("write", v as never)} />
        <Param spec={RING.read} value={P.values.read} onChange={(v) => P.set("read", v as never)} />
        <Param spec={RING.nonblock} value={P.values.nonblock} onChange={(v) => P.set("nonblock", v as boolean)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, alignItems: "start" }}>
        <RingView pipe={pipe} writerAsleep={wAsleep} readerAsleep={rAsleep} />
        <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
          <Side title="Writer" status={state.killed ? "killed by SIGPIPE" : pipe.writers === 0 ? "write end closed" : wAsleep ? `asleep: ${pipe.pendingWrite("w")!.written} of ${pipe.pendingWrite("w")!.total} bytes in` : "running"} bad={state.killed || wAsleep}>
            <button className="btn primary" disabled={!canWrite} onClick={doWrite}>write {writeSize}</button>
            <button className="btn" disabled={!canWrite} onClick={fill}>Write until it stops</button>
            <button className="btn" disabled={!canWrite} onClick={closeW}>Close</button>
          </Side>
          <Side title="Reader" status={pipe.readers === 0 ? "read end closed" : rAsleep ? "asleep: the ring is empty" : "running"} bad={rAsleep}>
            <button className="btn primary" disabled={!canRead} onClick={doRead}>read {readSize}</button>
            <button className="btn" disabled={!canRead || rAsleep} onClick={closeR}>Close</button>
          </Side>
          <div style={{ display: "grid", gap: 2, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.4, minHeight: 96 }} aria-live="polite">
            {state.log.length === 0 && <span className="muted">The log of system calls appears here.</span>}
            {state.log.map((l, i) => (
              <div key={i} style={{ color: l.tone === "bad" ? "var(--c4)" : l.tone === "good" ? "var(--c3)" : i === state.log.length - 1 ? "var(--fg)" : "var(--muted)" }}>{l.text}</div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "bytes in the pipe", value: pipe.buffered.toLocaleString("en-US") },
          { label: "capacity", value: pipe.capacity.toLocaleString("en-US") },
          { label: "wasted at slot ends", value: (pipe.used * pipe.pageSize - pipe.slots.reduce((a, s) => a + s.buf.len + s.buf.offset, 0)).toLocaleString("en-US") },
          { label: "writes that merged", value: pipe.stats.merges },
        ]} />
      </div>
    </Demo>
  );
}

function Side({ title, status, bad, children }: { title: string; status: string; bad?: boolean; children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5, marginBottom: 6, flexWrap: "wrap" }}>
        <b style={{ fontWeight: 600 }}>{title}</b>
        <span style={{ color: bad ? "var(--c4)" : "var(--muted)" }}>{status}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- 2. two writers

const MIX = {
  size: select({ label: "Size of each write", options: ["512", "4096", "4097", "8192", "12288"].map((v) => ({ value: v, label: `${v} B` })), default: "4096", segmented: true }),
};
const MIX_SLOTS = 2;
const MIX_READ = 4096;

function StreamBar({ stream, total, size }: { stream: Run[]; total: number; size: number }) {
  const split = findSplit(stream);
  const label = (r: Run) => `${r.src}${r.write + 1}`;
  return (
    <div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>What the reader has read, in order</div>
      <div style={{ display: "flex", height: 32, border: "1px solid var(--border)", borderRadius: 5, overflow: "hidden", background: "var(--subtle)" }}>
        {stream.map((r, i) => {
          const bad = split && r.src === split.src && r.write === split.write;
          return (
            <div key={i} title={`${label(r)}: bytes ${r.at} to ${r.at + r.len - 1}`} style={{ width: `${(r.len / total) * 100}%`, minWidth: 6, flexShrink: 1, background: WRITER_COLOR[r.src], color: "var(--bg)", fontFamily: MONO, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderRight: "1px solid var(--bg)", boxShadow: bad ? "inset 0 -5px 0 var(--c4)" : undefined, opacity: r.write % 2 ? 0.78 : 1 }}>
              {r.len / total > 0.05 ? label(r) : ""}
            </div>
          );
        })}
      </div>
      {stream.length > 0 && <div style={{ fontFamily: MONO, fontSize: 11, marginTop: 3, overflowWrap: "anywhere" }}>{stream.map((r) => `${label(r)}: ${r.len}`).join("  ")}</div>}
      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>A1 and A2 are the writes of A. Each write has {size} bytes. A red edge marks a write that is split.</div>
    </div>
  );
}

function SlotsRow({ s }: { s: InterleaveState }) {
  const p = s.pipe;
  const bySlot = new Map(p.slots.map((x) => [x.index, x.buf]));
  return (
    <div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 3 }}>The ring: {MIX_SLOTS} slots of 4096 bytes</div>
      <div style={{ display: "flex", gap: 4 }}>
        {Array.from({ length: p.ringSize }, (_, i) => {
          const b = bySlot.get(i);
          return (
            <div key={i} style={{ flex: 1, height: 26, border: "1px solid var(--border)", borderRadius: 4, display: "flex", overflow: "hidden", background: "var(--subtle)" }}>
              {b && <div style={{ width: `${(b.offset / p.pageSize) * 100}%` }} />}
              {b?.runs.map((r, k) => <div key={k} style={{ width: `${(r.len / p.pageSize) * 100}%`, background: WRITER_COLOR[r.src], color: "var(--bg)", fontSize: 10.5, fontFamily: MONO, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderRight: "1px solid var(--bg)" }}>{r.len > 700 ? `${r.src}${r.write + 1}` : ""}</div>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function IpcPipeInterleaveDemo() {
  const P = useParams("os-ipc-mix", MIX);
  const size = Number(P.values.size);
  const spec = useMemo(() => ({ slots: MIX_SLOTS, writers: { A: [size, size], B: [size, size] }, readSize: MIX_READ }), [size]);
  const model = useMemo(() => pipeInterleaveModel(spec), [spec]);
  const res = useMemo(() => explorePipe(spec), [spec]);
  const [path, setPath] = useState<{ size: number; ids: string[] }>({ size, ids: [] });
  const ids = path.size === size ? path.ids : [];
  const trail = useMemo(() => replay(model, ids), [model, ids]);
  const s = trail[trail.length - 1]!;
  const steps = model.steps(s);
  const by = (id: string) => steps.find((x) => x.id === id);
  const go = (id: string) => setPath({ size, ids: [...ids, id] });
  const total = 4 * size;
  const split = findSplit(s.stream);
  const label = (id: string, name: string, color: string) => {
    const st = by(id);
    return (
      <button key={id} className="btn primary" disabled={!st} onClick={() => go(id)} style={{ background: st ? color : undefined, borderColor: st ? color : undefined, color: st ? "var(--bg)" : undefined }}>
        {name}{id !== "reader" && s.pipe.writeBlocked(id) ? ": wake" : ""}
      </button>
    );
  };
  return (
    <Demo
      title="Two writers on one pipe"
      actions={<>
        <button className="btn" disabled={ids.length === 0} onClick={() => setPath({ size, ids: ids.slice(0, -1) })}>Back</button>
        <button className="btn ghost" onClick={() => setPath({ size, ids: [] })}>Reset</button>
      </>}
      controls={<Param spec={MIX.size} value={P.values.size} onChange={(v) => P.set("size", v as never)} />}
    >
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        {label("A", "Run writer A", "var(--c1)")}
        {label("B", "Run writer B", "var(--c2)")}
        {label("reader", `Run reader (${MIX_READ})`, "var(--c5)")}
        {res.violation && <button className="btn" onClick={() => setPath({ size, ids: res.violation!.schedule })}>Show a split</button>}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        <SlotsRow s={s} />
        <StreamBar stream={s.stream} total={total} size={size} />
      </div>
      <Banner tone={split ? "bad" : s.eof ? "good" : "plain"}>
        {split ? `Split: bytes of ${split.src}${split.write + 1} have bytes of another write between them.` : s.last || "You are the scheduler. Each click runs one system call, up to the point where it returns or sleeps."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "states searched", value: res.states },
          { label: size <= PIPE_FACTS.pipeBuf ? "schedules that split a write" : "a split exists", value: res.violation ? `yes: ${res.violation.schedule.length} steps` : "none" },
          { label: "PIPE_BUF", value: PIPE_FACTS.pipeBuf },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- 3. throughput

const TP = {
  sw: range({ label: "Wake and switch (model input)", min: 200, max: 10000, step: 100, default: PIPE_COST.switchNs, format: (v) => `${(v / 1000).toFixed(1)} µs` }),
  splice: toggle({ label: "Move pages with splice, no copies", default: false }),
};
const CAP_SLOTS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const WRITE_SIZES = [{ size: 512, color: "var(--c4)" }, { size: 4096, color: "var(--c1)" }, { size: 65536, color: "var(--c2)" }, { size: 1 << 20, color: "var(--c3)" }];
const TOTAL = 1 << 22;
const READ = 65536;

export function IpcPipeThroughputDemo() {
  const P = useParams("os-ipc-tp", TP);
  const { sw, splice } = P.values;
  const lines = useMemo(() => WRITE_SIZES.map((w) => ({
    ...w,
    rows: CAP_SLOTS.map((slots) => ({ slots, r: pipeThroughput({ slots, writeSize: w.size, readSize: READ, totalBytes: TOTAL }, { splice, cost: { switchNs: sw } }) })),
  })), [sw, splice]);
  const maxY = Math.max(...lines.flatMap((l) => l.rows.map((x) => x.r.bytesPerSec))) / 2 ** 30;
  const at = (size: number, slots: number) => lines.find((l) => l.size === size)!.rows.find((x) => x.slots === slots)!.r;
  const def = at(4096, 16);
  const share = (x: number) => `${Math.round((x / def.totalNs) * 100)}%`;
  return (
    <Demo title="Pipe throughput: a model" controls={<><Param spec={TP.sw} value={sw} onChange={(v) => P.set("sw", v as number)} /><Param spec={TP.splice} value={splice} onChange={(v) => P.set("splice", v as boolean)} /></>}>
      <Plot x={[4096, 1 << 20]} y={[0, maxY * 1.08]} logX height={250} xLabel="pipe capacity" yLabel="GiB per second" xTicks={[4096, 16384, 65536, 262144, 1 << 20]} xFormat={(v) => bytes(v)}>
        <RuleX at={65536} label="default" />
        {lines.map((l) => <Line key={l.size} color={l.color} points={l.rows.map((x) => [x.slots * 4096, x.r.bytesPerSec / 2 ** 30] as [number, number])} />)}
      </Plot>
      <Legend items={WRITE_SIZES.map((w) => ({ label: `write size ${bytes(w.size)}`, color: w.color }))} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "4 KiB writes, 64 KiB pipe", value: `${(def.bytesPerSec / 2 ** 30).toFixed(2)} GiB/s` },
          { label: "system calls", value: share(def.parts.syscalls) },
          { label: "copies", value: share(def.parts.copies) },
          { label: "pages", value: share(def.parts.pages) },
          { label: "wake and switch", value: share(def.parts.switches) },
        ]} />
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Each point runs the real ring for {bytes(TOTAL)} on one core, with reads of {bytes(READ)}. Model inputs: a syscall is {PIPE_COST.syscallNs} ns, a 4 KiB copy is {PIPE_COST.copy4kNs} ns, a slot page is {PIPE_COST.pageNs} ns. The model has no cache effects.
      </p>
    </Demo>
  );
}
