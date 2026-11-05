/** Demos for "semaphores": bounded buffer stepper, readers-writers simulator, dining philosophers. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, range, select, useParams, Banner, MONO, MiniTable } from "../../kit";
import { allDone, canRun, clone, exec, initial, type MState } from "../../sims/os/sync/machine";
import {
  RW_DEFAULTS, RW_LABEL, boundedBufferProg, checkBuffer, checkDining, diningProg, simulateRw,
  type BufferVariant, type DiningVariant, type RwPolicy, type RwResult,
} from "../../sims/os/sync/semaphores";
import { Cell, CellRow, SyncStepper, TC } from "./SyncShared";

const BUF = {
  variant: select({
    label: "Producer code",
    options: [
      { value: "correct", label: "P(empty), then P(mutex)" },
      { value: "mutex-first", label: "P(mutex), then P(empty)" },
      { value: "no-mutex", label: "No mutex" },
    ],
    default: "correct",
  }),
};

export function SyncBoundedBufferDemo() {
  const P = useParams("os-sync-buffer", BUF);
  const variant = P.values.variant as BufferVariant;
  const prog = useMemo(() => boundedBufferProg({ variant }), [variant]);
  const res = useMemo(() => checkBuffer({ variant }), [variant]);
  const scripts = [];
  if (res.stuck) scripts.push({ label: "Show the deadlock", schedule: res.stuck.schedule });
  if (res.violation) scripts.push({ label: "Show the overwrite", schedule: res.violation.schedule });
  const slots = Object.keys(prog.mem).filter((k) => k.startsWith("buf")).length;
  return (
    <SyncStepper
      title="Bounded buffer: 2 slots, 2 producers, 2 consumers"
      prog={prog}
      scripts={scripts}
      hideRegs={["k"]}
      controls={<Param spec={BUF.variant} value={variant} onChange={(v) => P.set("variant", v as never)} />}
      panel={({ s }) => (
        <div>
          <CellRow>
            {Array.from({ length: slots }, (_, i) => (
              <Cell key={i} name={`slot ${i}`} value={s.mem[`buf${i}`] ? s.mem[`buf${i}`] : "·"} hot={!!s.mem[`buf${i}`]} />
            ))}
            <Cell name="empty" value={s.mem.empty} note="free slots" />
            <Cell name="full" value={s.mem.full} note="items" />
            {variant !== "no-mutex" && <Cell name="mutex" value={s.mem.mutex} note="1 = free" />}
          </CellRow>
        </div>
      )}
      verdict={({ finished, s }) => (finished ? { tone: "good", text: `All items passed through: produced ${s.mem.produced}, consumed ${s.mem.consumed}.` } : null)}
      footer={
        <div style={{ marginTop: 10 }}>
          <Stats items={[
            { label: "states searched", value: res.states },
            { label: "reachable deadlock", value: res.stuck ? `yes: ${res.stuck.schedule.length} steps` : "none" },
            { label: "reachable data error", value: res.violation ? `yes: ${res.violation.schedule.length} steps` : "none" },
          ]} />
        </div>
      }
    />
  );
}

// ---------------------------------------------------------------- readers and writers

const RW = {
  policy: select({ label: "Policy shown", options: (Object.keys(RW_LABEL) as RwPolicy[]).map((p) => ({ value: p, label: RW_LABEL[p] })), default: "reader", segmented: true }),
  readerRate: range({ label: "Reader arrivals", min: 0.5, max: 12, step: 0.5, default: RW_DEFAULTS.readerRate, format: (v) => `${v} per ms` }),
  writerRate: range({ label: "Writer arrivals", min: 0.05, max: 1.5, step: 0.05, default: RW_DEFAULTS.writerRate, format: (v) => `${v.toFixed(2)} per ms` }),
};

function Timeline({ res, span }: { res: RwResult; span: number }) {
  const W = 400, H = 136, top = 16, laneH = 76;
  const x = (t: number) => (t / span) * W;
  const reqs = res.requests.filter((r) => r.arrive < span);
  const readers = reqs.filter((r) => r.kind === "R" && r.start >= 0 && r.start < span);
  const writers = reqs.filter((r) => r.kind === "W");
  // Count concurrent readers on a time grid, and draw one column per grid cell.
  const cells = 155;
  const cols = new Array<number>(cells).fill(0);
  for (const r of readers) {
    const a = Math.floor((r.start / span) * cells);
    const b = Math.min(cells - 1, Math.floor((r.end / span) * cells));
    for (let i = a; i <= b; i++) cols[i]!++;
  }
  const maxR = Math.max(1, ...cols);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 620, display: "block" }} role="img" aria-label="timeline of readers and writers">
      {cols.map((c, i) => c > 0 && <rect key={i} x={(i / cells) * W} y={top + laneH - (c / maxR) * laneH} width={W / cells + 0.4} height={(c / maxR) * laneH} fill="var(--c1)" opacity={0.55} />)}
      {writers.map((w) => w.start >= 0 && w.start < span && <rect key={w.id} x={x(w.start)} y={top} width={Math.max(1.5, x(Math.min(w.end, span)) - x(w.start))} height={laneH} fill="var(--c2)" />)}
      <line x1={0} y1={top + laneH} x2={W} y2={top + laneH} stroke="var(--border)" />
      {writers.map((w) => {
        const end = w.start >= 0 ? w.start : span;
        return <line key={`q${w.id}`} x1={x(w.arrive)} x2={x(Math.min(end, span))} y1={top + laneH + 10 + (w.id % 5) * 7} y2={top + laneH + 10 + (w.id % 5) * 7} stroke={w.start >= 0 ? "var(--c2)" : "var(--c4)"} strokeWidth={2} />;
      })}
      <text x={0} y={10} fontSize={10} fill="var(--muted)">Blue height: active readers, {maxR} at most. Solid orange: a writer.</text>
    </svg>
  );
}

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const SHORT: Record<RwPolicy, string> = { reader: "Reader pref.", writer: "Writer pref.", fair: "Fair" };

export function SyncReadersWritersDemo() {
  const P = useParams("os-sync-rw", RW);
  const { readerRate, writerRate } = P.values;
  const policy = P.values.policy as RwPolicy;
  const all = useMemo(() => {
    const out = {} as Record<RwPolicy, RwResult>;
    for (const p of Object.keys(RW_LABEL) as RwPolicy[]) out[p] = simulateRw({ policy: p, readerRate, writerRate, readMs: RW_DEFAULTS.readMs, writeMs: RW_DEFAULTS.writeMs });
    return out;
  }, [readerRate, writerRate]);
  const r = all[policy];
  const span = 60;
  return (
    <Demo
      title="Readers and writers: who starves?"
      controls={
        <>
          <Param spec={RW.readerRate} value={readerRate} onChange={(v) => P.set("readerRate", v as number)} />
          <Param spec={RW.writerRate} value={writerRate} onChange={(v) => P.set("writerRate", v as number)} />
          <Param spec={RW.policy} value={policy} onChange={(v) => P.set("policy", v as never)} />
        </>
      }
    >
      <div style={{ fontSize: 12.5, marginBottom: 2 }}>{RW_LABEL[policy]}: first {span} ms</div>
      <Timeline res={r} span={span} />
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>Lines under the axis show writers that wait. A red line is a writer that had not run at the end of this window.</div>
      <MiniTable
        head={[`${r.horizon} ms run`, "reader wait, mean / worst (ms)", "writer wait, mean / worst (ms)", "writers that ran"]}
        highlight={(i) => (Object.keys(RW_LABEL) as RwPolicy[])[i] === policy}
        rows={(Object.keys(RW_LABEL) as RwPolicy[]).map((p) => {
          const x = all[p];
          return [SHORT[p], `${ms(x.readers.meanWait)} / ${ms(x.readers.maxWait)}`, `${x.writers.served ? ms(x.writers.meanWait) : "none"} / ${ms(x.writers.maxWait)}`, `${x.writers.served} of ${x.writers.arrived}`];
        })}
      />
    </Demo>
  );
}

// ---------------------------------------------------------------- dining philosophers

const DINE = {
  variant: select({
    label: "Rule",
    options: [
      { value: "naive", label: "Left fork, then right" },
      { value: "ordered", label: "Lowest fork first" },
      { value: "room", label: "Room semaphore: 4 seats" },
    ],
    default: "naive",
    segmented: true,
  }),
};

export function SyncDiningDemo() {
  const P = useParams("os-sync-dining", DINE);
  const variant = P.values.variant as DiningVariant;
  const N = 5;
  const prog = useMemo(() => diningProg(N, variant), [variant]);
  const res = useMemo(() => checkDining(N, variant), [variant]);
  const [hist, setHist] = useState<{ v: string; list: MState[] }>({ v: variant, list: [initial(prog)] });
  const list = hist.v === variant ? hist.list : [initial(prog)];
  const s = list[list.length - 1]!;
  const can = prog.threads.map((_, t) => canRun(prog, s, t));
  const stuck = !can.some(Boolean) && !allDone(prog, s);
  const step = (t: number) => {
    const next = clone(s);
    if (exec(prog, next, t)) setHist({ v: variant, list: [...list, next] });
  };
  const R = 92, C = 130;
  const pos = (i: number, r: number, offset = 0) => {
    const a = ((i + offset) / N) * Math.PI * 2 - Math.PI / 2;
    return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
  };
  const owner = (f: number) => {
    // A fork is held by a philosopher who has passed its P(fork f) line and not yet passed V(fork f).
    if (s.mem[`fork${f}`]) return -1;
    for (let t = 0; t < N; t++) {
      const code = prog.threads[t]!;
      const pi = code.findIndex((c) => c.text === `P(fork ${f})`);
      const vi = code.findIndex((c) => c.text === `V(fork ${f})`);
      if (pi >= 0 && s.th[t]!.pc > pi && s.th[t]!.pc <= vi) return t;
    }
    return -1;
  };
  return (
    <Demo
      title="Dining philosophers"
      actions={
        <>
          <button className="btn" onClick={() => setHist({ v: variant, list: [initial(prog)] })}>Reset</button>
          {res.stuck && <button className="btn" onClick={() => {
            const out = [initial(prog)];
            for (const id of res.stuck!.schedule) {
              const n = clone(out[out.length - 1]!);
              exec(prog, n, Number(id.slice(1)));
              out.push(n);
            }
            setHist({ v: variant, list: out });
          }}>Jump to the deadlock</button>}
        </>
      }
      controls={<Param spec={DINE.variant} value={variant} onChange={(v) => P.set("variant", v as never)} />}
    >
      <svg viewBox="0 0 260 260" style={{ width: "100%", maxWidth: 320, display: "block", margin: "0 auto" }} role="img" aria-label="five philosophers around a table">
        <circle cx={C} cy={C} r={48} fill="var(--subtle)" stroke="var(--border)" />
        {Array.from({ length: N }, (_, f) => {
          const [x, y] = pos(f, 54, -0.5);
          const o = owner(f);
          const [ox, oy] = o >= 0 ? pos(o, 72) : [x, y];
          return <circle key={f} cx={ox + (o >= 0 ? (x - ox) * 0.25 : 0)} cy={oy + (o >= 0 ? (y - oy) * 0.25 : 0)} r={6} fill={o >= 0 ? TC[o % 4] : "var(--muted)"} style={{ transition: "cx .3s, cy .3s" }} />;
        })}
        {Array.from({ length: N }, (_, t) => {
          const [x, y] = pos(t, R);
          const pc = s.th[t]!.pc;
          const ins = prog.threads[t]![pc];
          const eating = ins?.kind === "cs";
          return (
            <g key={t} onClick={() => step(t)} style={{ cursor: can[t] ? "pointer" : "default" }} role="button" aria-label={`run philosopher ${t}`}>
              <circle cx={x} cy={y} r={25} fill={eating ? TC[t % 4] : "var(--bg)"} stroke={can[t] ? TC[t % 4] : "var(--c4)"} strokeWidth={can[t] ? 2 : 1.5} strokeDasharray={can[t] || !ins ? undefined : "3 2"} />
              <text x={x} y={y - 3} fontSize={11} fontWeight={700} textAnchor="middle" fill={eating ? "var(--bg)" : "var(--fg)"}>{t}</text>
              <text x={x} y={y + 10} fontSize={8.5} fontFamily={MONO} textAnchor="middle" fill={eating ? "var(--bg)" : "var(--muted)"}>{ins ? ins.text.replace("fork ", "f") : "done"}</text>
            </g>
          );
        })}
      </svg>
      <Banner tone={stuck ? "bad" : allDone(prog, s) ? "good" : "plain"}>
        {stuck ? "Deadlock. Every philosopher holds one fork and waits for the next one." : allDone(prog, s) ? "Everyone ate." : "Click a philosopher to run its next line. A dashed red circle cannot run now."}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "states searched", value: res.states },
          { label: "shortest deadlock", value: res.stuck ? `${res.stuck.schedule.length} steps` : "none exists" },
        ]} />
      </div>
    </Demo>
  );
}
