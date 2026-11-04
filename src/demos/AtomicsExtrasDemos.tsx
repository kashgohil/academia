import { useMemo, useState, type ReactNode } from "react";
import { Demo, Param, Stats, select, useWidth } from "../kit";
import {
  completions, counterMachine, tearMachine, isTorn, replay, total, type Machine, type CounterMode,
  casInit, casStep, casDone, casAttempts, casAttemptRange, casApply, type CasFn, type CasState,
  abaInit, abaStep, abaDone, abaBroken, abaList, ABA_T0, ABA_T1, type AbaState,
  fenceRun, FENCE_OPS, FENCE_WEAK, FENCE_ASM, type FenceMode, type FenceOrd, type FenceSlots,
  HB_SCENARIOS, hbAnalyze, hbOrds, type HbOrd,
  TSO_PROGRAMS, tsoInit, tsoExec, tsoDrain, tsoOutcomes, scOutcomes, type TsoState,
} from "../sims/atomicsextras";

// ---------------- shared pieces ----------------

const TC = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)"];
const mono = "ui-monospace, Menlo, monospace";
const card: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", background: "var(--bg)", minWidth: 0 };

function Seg<T extends string>({ value, options, onChange, small }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)} style={small ? { padding: "2px 7px", fontSize: 11.5 } : undefined}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** One line of code. state: done (already run), now (runs next), todo. */
function Code({ text, state, color, note }: { text: ReactNode; state: "done" | "now" | "todo"; color: string; note?: ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontFamily: mono, fontSize: 12.5, lineHeight: 1.7, color: state === "done" ? "var(--muted)" : "var(--fg)" }}>
      <span style={{ width: 10, flex: "none", color, fontWeight: 700 }}>{state === "now" ? "▶" : state === "done" ? "✓" : ""}</span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere", background: state === "now" ? "var(--subtle)" : undefined, borderRadius: 4, padding: "0 4px" }}>
        {text}
        {note && <span style={{ display: "block", fontFamily: "inherit", fontSize: 11, color: "var(--muted)" }}>{note}</span>}
      </span>
    </div>
  );
}

function ThreadHead({ name, color, children }: { name: string; color: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
      <span style={{ fontWeight: 600, fontSize: 13, color }}>{name}</span>
      {children}
    </div>
  );
}

function MemBox({ name, value, hot, width }: { name: string; value: ReactNode; hot?: boolean; width?: number }) {
  return (
    <div style={{ border: `1.5px solid ${hot ? "var(--c1)" : "var(--border)"}`, borderRadius: 8, padding: "4px 12px", textAlign: "center", minWidth: width ?? 64, background: "var(--subtle)", transition: "border-color 0.2s" }}>
      <div className="muted" style={{ fontSize: 11 }}>{name}</div>
      <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const Verdict = ({ good, children }: { good: boolean; children: ReactNode }) => (
  <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, border: `1px solid ${good ? "var(--c3)" : "var(--c4)"}`, color: good ? "var(--c3)" : "var(--c4)", fontSize: 13.5 }}>{children}</div>
);

const grid = (min: number): React.CSSProperties => ({ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 10 });

// ---------------- generic interleaving stepper ----------------

function InterleaveStepper<S>({ title, machine, names, memory, regs, result, controls, note }: {
  title: string;
  machine: Machine<S>;
  names: string[];
  memory: (s: S) => ReactNode;
  regs: (s: S, t: number) => ReactNode;
  result: (k: string) => { label: string; bad: boolean };
  controls: ReactNode;
  note?: ReactNode;
}) {
  const [sched, setSched] = useState<number[]>([]);
  const { state, pcs } = replay(machine, sched);
  const all = useMemo(() => completions(machine), [machine]);
  const now = useMemo(() => completions(machine, sched), [machine, sched]);
  const keys = [...all.keys()].sort();
  const allN = total(all), nowN = total(now);
  const runnable = machine.threads.map((th, t) => pcs[t]! < th.length);
  const done = !runnable.some(Boolean);
  const finalKey = done ? machine.result(state) : null;
  const randomStep = () => {
    const ok = runnable.flatMap((r, t) => (r ? [t] : []));
    if (ok.length) setSched([...sched, ok[Math.floor(Math.random() * ok.length)]!]);
  };
  return (
    <Demo
      title={title}
      actions={<>
        <button className="btn" onClick={randomStep} disabled={done}>Random step</button>
        <button className="btn" onClick={() => setSched(sched.slice(0, -1))} disabled={!sched.length}>Undo</button>
        <button className="btn ghost" onClick={() => setSched([])}>Reset</button>
      </>}
      controls={controls}
    >
      <div style={{ display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>{memory(state)}</div>
      <div style={grid(150)}>
        {machine.threads.map((th, t) => (
          <div key={t} style={{ ...card, borderColor: runnable[t] ? "var(--border)" : "var(--faint)" }}>
            <ThreadHead name={names[t]!} color={TC[t]!}>
              <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} disabled={!runnable[t]} onClick={() => setSched([...sched, t])}>Run next step</button>
            </ThreadHead>
            {th.map((l, i) => <Code key={i} text={l.label} color={TC[t]!} state={i < pcs[t]! ? "done" : i === pcs[t] ? "now" : "todo"} />)}
            <div className="muted" style={{ fontSize: 12, marginTop: 4, fontFamily: mono, overflowWrap: "anywhere" }}>{regs(state, t)}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", margin: "10px 0", minHeight: 24 }}>
        <span className="muted" style={{ fontSize: 12, marginRight: 4 }}>Order so far:</span>
        {sched.length === 0 && <span className="muted" style={{ fontSize: 12 }}>(no steps yet)</span>}
        {sched.map((t, i) => <span key={i} style={{ fontSize: 11, fontWeight: 600, color: "#fff", background: TC[t], borderRadius: 4, padding: "1px 6px" }}>T{t}</span>)}
      </div>
      <div style={{ fontSize: 12.5 }}>
        <div className="muted" style={{ marginBottom: 4 }}>Final results over all {allN.toLocaleString()} orders of the steps (light bar), and the orders that are still possible from here (dark bar):</div>
        {keys.map((k) => {
          const r = result(k), a = all.get(k) ?? 0, n = now.get(k) ?? 0;
          const c = r.bad ? "var(--c4)" : "var(--c3)";
          return (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) 1fr auto", gap: 8, alignItems: "center", margin: "3px 0" }}>
              <span style={{ fontFamily: mono, fontSize: 12, overflowWrap: "anywhere", color: finalKey === k ? c : "var(--fg)", fontWeight: finalKey === k ? 700 : 400 }}>{r.label}</span>
              <div style={{ position: "relative", height: 16, background: "var(--subtle)", borderRadius: 3 }}>
                <div style={{ position: "absolute", inset: 0, width: `${(100 * a) / allN}%`, background: c, opacity: 0.25, borderRadius: 3 }} />
                <div style={{ position: "absolute", inset: 0, width: `${(100 * n) / allN}%`, background: c, borderRadius: 3, transition: "width 0.25s" }} />
              </div>
              <span style={{ fontSize: 11, color: "var(--muted)", fontVariantNumeric: "tabular-nums", minWidth: 44, textAlign: "right" }}>{n} / {a}</span>
            </div>
          );
        })}
        <div className="muted" style={{ marginTop: 4 }}>{done ? "All steps are done." : `${nowN.toLocaleString()} of ${allN.toLocaleString()} orders are still possible.`}</div>
      </div>
      {finalKey !== null && <Verdict good={!result(finalKey).bad}>Result: {result(finalKey).label}.</Verdict>}
      {note && <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>{note}</p>}
    </Demo>
  );
}

// ---------------- lost update ----------------

export function LostUpdateDemo() {
  const [mode, setMode] = useState<CounterMode>("split");
  const [n, setN] = useState(2);
  const machine = useMemo(() => counterMachine(n, mode), [n, mode]);
  return (
    <InterleaveStepper
      key={`${mode}-${n}`}
      title="Two increments: you choose the order of the steps"
      machine={machine}
      names={Array.from({ length: n }, (_, i) => `Thread ${i}`)}
      memory={(s) => <MemBox name="count (shared)" value={s.count} width={110} />}
      regs={(s, t) => (mode === "split" ? `r${t} = ${s.r[t] ?? "—"}` : `returned: ${s.r[t] ?? "—"}`)}
      result={(k) => {
        const lost = n - Number(k);
        return { label: `count = ${k}${lost ? ` (${lost} lost)` : ""}`, bad: lost > 0 };
      }}
      controls={<>
        <Param spec={select({ label: "Each thread does", options: [{ value: "split", label: "load, add, store" }, { value: "rmw", label: "one fetch_add" }], default: "split", segmented: true })} value={mode} onChange={(v) => setMode(v as CounterMode)} />
        <Param spec={select({ label: "Threads", options: [{ value: "2", label: "2" }, { value: "3", label: "3" }], default: "2", segmented: true })} value={String(n)} onChange={(v) => setN(Number(v))} />
      </>}
      note={mode === "split" ? "Each step is atomic. The increment as a whole is not: another thread can run between the load and the store." : "fetch_add reads and writes in one indivisible step, so no other thread can run in between."}
    />
  );
}

// ---------------- torn value ----------------

const HALF = ["00000000", "FFFFFFFF"];
const hex = (k: string) => `0x${HALF[Number(k[0])]}_${HALF[Number(k[1])]}`;

export function TornValueDemo() {
  const [atomic, setAtomic] = useState(false);
  const machine = useMemo(() => tearMachine(atomic), [atomic]);
  const half = (b: 0 | 1 | null) => (b === null ? "????????" : HALF[b]!);
  return (
    <InterleaveStepper
      key={String(atomic)}
      title="A 64-bit value, written in two halves"
      machine={machine}
      names={["Writer", "Reader"]}
      memory={(s) => <>
        <MemBox name="high half" value={HALF[s.hi]} hot={s.hi === 1} width={120} />
        <MemBox name="low half" value={HALF[s.lo]} hot={s.lo === 1} width={120} />
        <div className="muted" style={{ flexBasis: "100%", textAlign: "center", fontSize: 12 }}>The writer changes the value from all 0 bits to all 1 bits (hex F).</div>
      </>}
      regs={(s, t) => (t === 0 ? `wrote: ${s.hi + s.lo} of 2 halves` : `read: 0x${half(s.rhi)}_${half(s.rlo)}`)}
      result={(k) => ({ label: `${hex(k)}${isTorn(k) ? " (torn)" : k === "00" ? " (old)" : " (new)"}`, bad: isTorn(k) })}
      controls={<Param spec={select({ label: "Access", options: [{ value: "split", label: "two 32-bit halves" }, { value: "atomic", label: "one 64-bit atomic" }], default: "split", segmented: true })} value={atomic ? "atomic" : "split"} onChange={(v) => setAtomic(v === "atomic")} />}
      note="A torn value is half old and half new. No thread ever wrote it. This happens, for example, with a 64-bit value on a 32-bit CPU, or with a value that crosses two cache lines."
    />
  );
}

// ---------------- CAS retry loop ----------------

export function CasLoopDemo() {
  const [n, setN] = useState(3);
  const [fn, setFn] = useState<CasFn>("inc");
  const [hist, setHist] = useState<{ s: CasState; log: string[] }[]>([]);
  const start = useMemo(() => ({ s: casInit(n, 1), log: [] as string[] }), [n]);
  const cur = hist.at(-1) ?? start;
  const s = cur.s;
  const range = useMemo(() => casAttemptRange(n, fn), [n, fn]);
  const f = (v: string | number) => (fn === "inc" ? `${v} + 1` : `${v} * 2`);
  const run = (t: number) => {
    const th = s.th[t]!;
    const r = casStep(s, t, fn);
    const msg =
      r.event === "load" ? `T${t}: cur = x.load() → ${s.x}`
      : r.event === "ok" ? `T${t}: CAS(${th.cur} → ${casApply(fn, th.cur ?? 0)}) succeeds`
      : `T${t}: CAS(${th.cur} → ${casApply(fn, th.cur ?? 0)}) fails: x is ${s.x}, so cur = ${s.x}`;
    setHist([...hist, { s: r.state, log: [msg, ...cur.log].slice(0, 5) }]);
  };
  const live = s.th.flatMap((th, t) => (th.pc !== 2 ? [t] : []));
  const done = casDone(s);
  const fails = s.th.reduce((a, t) => a + t.fails, 0);
  return (
    <Demo
      title="A CAS retry loop: you choose which thread runs"
      actions={<>
        <button className="btn" disabled={done} onClick={() => run(live[Math.floor(Math.random() * live.length)]!)}>Random step</button>
        <button className="btn" disabled={!hist.length} onClick={() => setHist(hist.slice(0, -1))}>Undo</button>
        <button className="btn ghost" onClick={() => setHist([])}>Reset</button>
      </>}
      controls={<>
        <Param spec={select({ label: "Threads", options: ["2", "3", "4"].map((v) => ({ value: v, label: v })), default: "3", segmented: true })} value={String(n)} onChange={(v) => { setN(Number(v)); setHist([]); }} />
        <Param spec={select({ label: "Update f(x)", options: [{ value: "inc", label: "x + 1" }, { value: "double", label: "x * 2 (no fetch_ instruction for this)" }], default: "inc", segmented: true })} value={fn} onChange={(v) => { setFn(v as CasFn); setHist([]); }} />
      </>}
    >
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}><MemBox name="x (shared)" value={s.x} width={110} /></div>
      <div style={grid(150)}>
        {s.th.map((th, t) => (
          <div key={t} style={card}>
            <ThreadHead name={`Thread ${t}`} color={TC[t]!}>
              <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} disabled={th.pc === 2} onClick={() => run(t)}>Run</button>
            </ThreadHead>
            <Code text="cur = x.load()" color={TC[t]!} state={th.pc === 0 ? "now" : "done"} />
            <Code text={`CAS(x, cur, ${f("cur")})`} color={TC[t]!} state={th.pc === 1 ? "now" : th.pc === 2 ? "done" : "todo"} note="fails: cur = actual value, try again" />
            <div style={{ fontFamily: mono, fontSize: 12, marginTop: 4, color: "var(--muted)" }}>
              cur = {th.cur ?? "—"} · tries {th.attempts}
              {th.fails > 0 && <span style={{ color: "var(--c4)" }}> · fails {th.fails}</span>}
              {th.pc === 2 && <span style={{ color: "var(--c3)" }}> · done</span>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ margin: "10px 0", minHeight: 20, fontFamily: mono, fontSize: 12 }}>
        {cur.log.map((l, i) => <div key={hist.length - i} style={{ color: l.includes("fails") ? "var(--c4)" : l.includes("succeeds") ? "var(--c3)" : "var(--muted)", opacity: 1 - i * 0.17 }}>{l}</div>)}
      </div>
      <Stats items={[
        { label: "CAS attempts so far", value: casAttempts(s) },
        { label: "failed CAS so far", value: fails },
        { label: "fewest / most attempts over all orders", value: `${range.min} / ${range.max}` },
        { label: "final x over all orders", value: range.finals.join(", ") },
      ]} />
      {done && <Verdict good>x = {s.x}. No update is lost: {n} threads, {casAttempts(s)} CAS attempts, {fails} of them failed.</Verdict>}
    </Demo>
  );
}

// ---------------- ABA ----------------

function NodeBox({ n, freed, tag }: { n: string; freed: boolean; tag?: string }) {
  return (
    <div style={{ border: `1.5px ${freed ? "dashed" : "solid"} ${freed ? "var(--c4)" : "var(--fg)"}`, borderRadius: 6, padding: "3px 10px", fontFamily: mono, fontSize: 14, fontWeight: 600, color: freed ? "var(--c4)" : "var(--fg)", textAlign: "center" }}>
      {n}
      {tag && <div style={{ fontSize: 10, fontWeight: 400 }}>{tag}</div>}
    </div>
  );
}

export function AbaDemo() {
  const [tagged, setTagged] = useState(false);
  const [sched, setSched] = useState<(0 | 1)[]>([]);
  const s: AbaState = sched.reduce((a, t) => abaStep(a, t, tagged), abaInit());
  const list = abaList(s);
  const t0Done = s.t0.pc === 3, t1Done = s.t1.pc === 3;
  const done = abaDone(s);
  const broken = abaBroken(s);
  const arrow = <span className="muted" style={{ fontSize: 14 }}>→</span>;
  const t1Label = (i: number) => ABA_T1[i]! + (i === 0 && s.t1.held[0] ? `  → ${s.t1.held[0]}` : i === 1 && s.t1.held[1] ? `  → ${s.t1.held[1]}` : "");
  return (
    <Demo
      title="The ABA problem on a lock-free stack"
      actions={<>
        <button className="btn" onClick={() => setSched([0, 0, 1, 1, 1])}>Set up the bad order</button>
        <button className="btn" disabled={!sched.length} onClick={() => setSched(sched.slice(0, -1))}>Undo</button>
        <button className="btn ghost" onClick={() => setSched([])}>Reset</button>
      </>}
      controls={<Param spec={select({ label: "top holds", options: [{ value: "plain", label: "a pointer only" }, { value: "tagged", label: "a pointer and a tag" }], default: "plain", segmented: true })} value={tagged ? "tagged" : "plain"} onChange={(v) => { setTagged(v === "tagged"); setSched([]); }} />}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 6 }}>
        <span style={{ fontFamily: mono, fontSize: 13 }}>top{tagged ? ` (tag ${s.tag})` : ""}</span>
        {arrow}
        {list.map((n, i) => <span key={i} style={{ display: "contents" }}><NodeBox n={n} freed={s.freed.includes(n)} tag={s.freed.includes(n) ? "freed!" : undefined} />{arrow}</span>)}
        <span className="muted" style={{ fontFamily: mono, fontSize: 13 }}>null</span>
      </div>
      <div className="muted" style={{ textAlign: "center", fontSize: 12, marginBottom: 10 }}>
        Freed memory: {s.freed.length ? s.freed.join(", ") : "none"}
      </div>
      <div style={grid(160)}>
        <div style={card}>
          <ThreadHead name="Thread 0: pop()" color={TC[0]!}>
            <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} disabled={t0Done} onClick={() => setSched([...sched, 0])}>Run</button>
          </ThreadHead>
          {ABA_T0.map((l, i) => <Code key={i} text={l} color={TC[0]!} state={t0Done || i < s.t0.pc ? "done" : i === s.t0.pc ? "now" : "todo"} note={i === 2 ? "fails: go back to line 1" : undefined} />)}
          <div style={{ fontFamily: mono, fontSize: 12, marginTop: 4, color: "var(--muted)" }}>
            old = {s.t0.pc > 0 || t0Done || s.t0.fails ? `${s.t0.seenTop ?? "null"}${tagged ? ` (tag ${s.t0.seenTag})` : ""}` : "—"} · next = {s.t0.pc > 1 || t0Done ? s.t0.seenNext ?? "null" : "—"}
            {s.t0.fails > 0 && <span style={{ color: "var(--c4)" }}> · CAS failed {s.t0.fails}×</span>}
          </div>
        </div>
        <div style={card}>
          <ThreadHead name="Thread 1" color={TC[1]!}>
            <button className="btn" style={{ padding: "2px 10px", fontSize: 12 }} disabled={t1Done} onClick={() => setSched([...sched, 1])}>Run</button>
          </ThreadHead>
          {ABA_T1.map((_, i) => <Code key={i} text={t1Label(i)} color={TC[1]!} state={i < s.t1.pc ? "done" : i === s.t1.pc ? "now" : "todo"} />)}
          <div className="muted" style={{ fontFamily: mono, fontSize: 12, marginTop: 4 }}>each line is one whole stack operation</div>
        </div>
      </div>
      {done && (broken
        ? <Verdict good={false}>Broken. The CAS saw top = A again and succeeded. Now top points to {s.top}, which Thread 1 freed. The next pop reads freed memory.</Verdict>
        : <Verdict good>Correct. The stack is {list.length ? list.join(" → ") : "empty"}{s.t0.fails ? `, and the CAS failed ${s.t0.fails}× before it used fresh values` : ""}.</Verdict>)}
    </Demo>
  );
}

// ---------------- fence placement ----------------

const FENCE_OPTS: { value: FenceOrd; label: string }[] = [
  { value: "none", label: "—" },
  { value: "acquire", label: "acq" },
  { value: "release", label: "rel" },
  { value: "seq_cst", label: "sc" },
];
const NO_FENCES: FenceSlots = ["none", "none", "none", "none", "none", "none"];
const FIX: Record<FenceMode, FenceSlots> = {
  mp: ["none", "release", "none", "none", "acquire", "none"],
  sb: ["none", "seq_cst", "none", "none", "seq_cst", "none"],
};
const WEAK_TEXT: Record<FenceMode, string> = {
  mp: "r0=1 r1=0: the reader sees the flag, but old data",
  sb: "r0=0 r1=0: each thread misses the other's store",
};

export function FencePlacementDemo() {
  const [mode, setMode] = useState<FenceMode>("mp");
  const [slots, setSlots] = useState<FenceSlots>(NO_FENCES);
  const res = useMemo(() => fenceRun(mode, slots), [mode, slots]);
  const set = (i: number, v: FenceOrd) => setSlots(slots.map((x, j) => (j === i ? v : x)) as FenceSlots);
  const w = FENCE_WEAK[mode];
  const slot = (i: number) => {
    const f = slots[i]!;
    return (
      <div style={{ margin: "3px 0 3px 16px" }}>
        <Seg small value={f} options={FENCE_OPTS} onChange={(v) => set(i, v)} />
        {f !== "none" && (
          <div style={{ fontFamily: mono, fontSize: 12, color: "var(--c5)", marginTop: 2 }}>
            fence({f}) <span className="muted" style={{ fontSize: 11 }}>x86: {FENCE_ASM[f].x86} · ARM: {FENCE_ASM[f].arm}</span>
          </div>
        )}
      </div>
    );
  };
  return (
    <Demo
      title="Put fences where they do their job"
      actions={<>
        <button className="btn" onClick={() => setSlots(FIX[mode])}>Show a fix</button>
        <button className="btn ghost" onClick={() => setSlots(NO_FENCES)}>Clear</button>
      </>}
      controls={<Param spec={select({ label: "Program", options: [{ value: "mp", label: "Message passing" }, { value: "sb", label: "Store buffering" }], default: "mp", segmented: true })} value={mode} onChange={(v) => { setMode(v as FenceMode); setSlots(NO_FENCES); }} />}
    >
      <div style={grid(200)}>
        {FENCE_OPS[mode].map((ops, t) => (
          <div key={t} style={card}>
            <ThreadHead name={mode === "mp" ? (t === 0 ? "Thread 0 (writer)" : "Thread 1 (reader)") : `Thread ${t}`} color={TC[t]!} />
            {slot(t * 3)}
            <Code text={ops[0]} state="todo" color={TC[t]!} />
            {slot(t * 3 + 1)}
            <Code text={ops[1]} state="todo" color={TC[t]!} />
            {slot(t * 3 + 2)}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 13 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>The outcome to forbid: <span style={{ fontFamily: mono, color: "var(--fg)" }}>{WEAK_TEXT[mode]}</span></div>
        <div style={grid(150)}>
          {[{ name: "C++ memory model", weak: res.weakCxx }, { name: "x86 (TSO)", weak: res.weakTso }].map((m) => (
            <Verdict key={m.name} good={!m.weak}><b>{m.name}:</b> {m.weak ? "possible" : "forbidden"}</Verdict>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>All outcomes the C++ model allows:</span>
          {res.cxx.map((k) => <span key={k} className="tag" style={k === w ? { borderColor: "var(--c4)", color: "var(--c4)" } : undefined}>{k}</span>)}
        </div>
      </div>
    </Demo>
  );
}

// ---------------- happens-before graph ----------------

const ORD_SHORT: Record<HbOrd, string> = { relaxed: "relaxed", release: "release", acquire: "acquire", seq_cst: "seq_cst" };

export function HappensBeforeDemo() {
  const [sid, setSid] = useState(HB_SCENARIOS[0]!.id);
  const sc = HB_SCENARIOS.find((s) => s.id === sid)!;
  const [chosen, setChosen] = useState<Record<string, HbOrd>>({});
  const [sel, setSel] = useState<string>("r");
  const ords = hbOrds(sc, chosen);
  const a = useMemo(() => hbAnalyze(sc, chosen), [sc, chosen]);
  const [ref, w] = useWidth<HTMLDivElement>();

  // Layout: one column per thread; a read sits below the write it reads from.
  const row = new Map<string, number>();
  for (const e of sc.events) {
    const prev = sc.events.filter((x) => x.t === e.t && row.has(x.id)).map((x) => row.get(x.id)! + 1);
    const src = e.atomic && e.rf ? [row.get(e.rf)! + 1] : [];
    row.set(e.id, Math.max(0, ...prev, ...src));
  }
  const rows = Math.max(...row.values()) + 1;
  const colW = w / sc.threads, nodeW = Math.min(150, colW - 6), nodeH = 54, rowH = 82, top = 26;
  const H = top + (rows - 1) * rowH + nodeH + 8;
  const pos = (id: string) => { const e = sc.events.find((x) => x.id === id)!; return { x: colW * (e.t + 0.5), y: top + nodeH / 2 + row.get(id)! * rowH }; };
  const maxLen = Math.max(...sc.events.map((e) => e.label.length));
  const fs = Math.max(9, Math.min(12.5, (nodeW - 8) / (maxLen * 0.61)));
  const swSet = new Set(a.sw.map(([x, y]) => `${x}>${y}`));
  const race = a.races.length > 0;
  const selEv = sc.events.find((e) => e.id === sel) ?? sc.events.at(-1)!;
  const before = sc.events.filter((e) => a.hb(e.id, selEv.id)).map((e) => e.id);

  const edge = (from: string, to: string, kind: "sb" | "sw" | "rf", k: number) => {
    const p = pos(from), q = pos(to);
    const same = p.x === q.x;
    const y1 = p.y + nodeH / 2, y2 = q.y - nodeH / 2;
    const x1 = same ? p.x : p.x + (q.x > p.x ? nodeW / 4 : -nodeW / 4), x2 = same ? q.x : q.x + (q.x > p.x ? -nodeW / 4 : nodeW / 4);
    const color = kind === "sw" ? "var(--c3)" : kind === "rf" ? "var(--muted)" : "var(--faint)";
    // Label point on the curve: the middle, or near the target when the edge skips a thread column.
    const ym = (y1 + y2) / 2, u = Math.abs(q.x - p.x) > colW * 1.5 ? 0.78 : 0.5, v = 1 - u;
    const lx = v * v * v * x1 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x2;
    const ly = v * v * v * y1 + 3 * v * v * u * ym + 3 * v * u * u * ym + u * u * u * y2;
    return (
      <g key={`${kind}${k}`}>
        <path d={`M${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2 - 2}`} fill="none" stroke={color} strokeWidth={kind === "sw" ? 2.25 : 1.5} strokeDasharray={kind === "rf" ? "4 3" : undefined} markerEnd={`url(#hb-${kind})`} />
        {kind !== "sb" && <text x={lx} y={ly - 3} textAnchor="middle" fontSize={10.5} fill={color} style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>{kind === "sw" ? "synchronizes-with" : "reads value only"}</text>}
      </g>
    );
  };

  return (
    <Demo
      title="Happens-before: build the chain of edges"
      controls={<Param spec={select({ label: "Program", options: HB_SCENARIOS.map((s) => ({ value: s.id, label: s.label })), default: HB_SCENARIOS[0]!.id, segmented: true })} value={sid} onChange={(v) => { setSid(v as string); setChosen({}); setSel("r"); }} />}
    >
      <div ref={ref}>
        <svg width={w} height={H} style={{ display: "block" }}>
          <defs>
            {(["sb", "sw", "rf"] as const).map((k) => (
              <marker key={k} id={`hb-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={k === "sw" ? 4.5 : 7} markerHeight={k === "sw" ? 4.5 : 7} orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill={k === "sw" ? "var(--c3)" : k === "rf" ? "var(--muted)" : "var(--faint)"} />
              </marker>
            ))}
          </defs>
          {Array.from({ length: sc.threads }, (_, t) => (
            <text key={t} x={colW * (t + 0.5)} y={12} textAnchor="middle" fontSize={12} fontWeight={600} fill={TC[t]}>Thread {t}</text>
          ))}
          {a.sb.map(([x, y], k) => edge(x, y, "sb", k))}
          {a.rf.filter(([x, y]) => !swSet.has(`${x}>${y}`)).map(([x, y], k) => edge(x, y, "rf", k))}
          {a.sw.map(([x, y], k) => edge(x, y, "sw", k))}
          {a.races.map(([x, y], k) => {
            const p = pos(x), q = pos(y);
            return (
              <g key={`race${k}`}>
                <line x1={p.x + nodeW / 2} y1={p.y} x2={q.x - nodeW / 2} y2={q.y} stroke="var(--c4)" strokeWidth={1.75} strokeDasharray="5 4" />
                <text x={p.x + nodeW / 2 + 0.3 * (q.x - nodeW - p.x)} y={p.y + 0.3 * (q.y - p.y) - 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--c4)" style={{ paintOrder: "stroke", stroke: "var(--bg)", strokeWidth: 3 }}>data race</text>
              </g>
            );
          })}
          {sc.events.map((e) => {
            const p = pos(e.id);
            const isSel = e.id === selEv.id, isBefore = before.includes(e.id);
            const o = ords[e.id]!;
            const strong = e.atomic && o !== "relaxed";
            return (
              <g key={e.id} transform={`translate(${p.x - nodeW / 2},${p.y - nodeH / 2})`} onClick={() => setSel(e.id)} style={{ cursor: "pointer" }}>
                <rect width={nodeW} height={nodeH} rx={7} fill={isBefore ? "var(--c1)" : "var(--bg)"} fillOpacity={isBefore ? 0.16 : 1} stroke={isSel ? "var(--fg)" : TC[e.t]} strokeWidth={isSel ? 2.5 : 1.5} />
                <text x={nodeW / 2} y={17} textAnchor="middle" fontSize={fs} fontFamily={mono} fill="var(--fg)">{e.label}</text>
                <text x={nodeW / 2} y={31} textAnchor="middle" fontSize={10.5} fill={strong ? "var(--c3)" : "var(--muted)"} fontWeight={strong ? 600 : 400}>{e.atomic ? ORD_SHORT[o] : "plain"}</text>
                <text x={nodeW / 2} y={46} textAnchor="middle" fontSize={10} fontFamily={mono} fill="var(--muted)">clock [{a.vc[e.id]!.join(",")}]</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", marginTop: 4 }}>
        {sc.events.filter((e) => e.choices.length).map((e) => (
          <div key={e.id} style={{ fontSize: 12 }}>
            <div style={{ color: TC[e.t], fontFamily: mono, marginBottom: 2 }}>T{e.t}: {e.label}</div>
            <Seg small value={ords[e.id]!} options={e.choices.map((c) => ({ value: c, label: c }))} onChange={(v) => setChosen({ ...chosen, [e.id]: v })} />
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
        Click an event: the blue events happen-before it. Grey arrows: program order. clock: the vector clock, one counter per thread.
      </p>
      {race
        ? <Verdict good={false}>No chain of edges leads from <code>data = 42</code> to <code>r0 = data</code>. The plain accesses race: undefined behavior.</Verdict>
        : <Verdict good>A chain of edges leads from <code>data = 42</code> to <code>r0 = data</code>. No data race, and r0 is always 42.</Verdict>}
    </Demo>
  );
}

// ---------------- store buffers (x86-TSO) ----------------

export function StoreBufferDemo() {
  const [pid, setPid] = useState(TSO_PROGRAMS[0]!.id);
  const p = TSO_PROGRAMS.find((x) => x.id === pid)!;
  const [hist, setHist] = useState<TsoState[]>([]);
  const s = hist.at(-1) ?? tsoInit(p);
  const push = (n: TsoState) => setHist([...hist, n]);
  const reach = useMemo(() => tsoOutcomes(p, s), [p, s]);
  const all = useMemo(() => tsoOutcomes(p), [p]);
  const sc = useMemo(() => scOutcomes(p), [p]);
  const locs = Object.keys(s.mem);
  const finished = reach.length === 1 && s.pc.every((x, t) => x >= p.threads[t]!.length);
  return (
    <Demo
      title="Store buffers on x86: run and drain by hand"
      actions={<>
        <button className="btn" disabled={!hist.length} onClick={() => setHist(hist.slice(0, -1))}>Undo</button>
        <button className="btn ghost" onClick={() => setHist([])}>Reset</button>
      </>}
      controls={<Param spec={select({ label: "Program", options: TSO_PROGRAMS.map((x) => ({ value: x.id, label: x.label })), default: TSO_PROGRAMS[0]!.id, segmented: true })} value={pid} onChange={(v) => { setPid(v as string); setHist([]); }} />}
    >
      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Shared memory:</span>
        {locs.map((l) => <MemBox key={l} name={l} value={s.mem[l]} hot={s.mem[l] !== 0} />)}
      </div>
      <div style={grid(170)}>
        {p.threads.map((ops, t) => (
          <div key={t} style={card}>
            <ThreadHead name={`Core ${t}`} color={TC[t]!}>
              <span className="row" style={{ gap: 4 }}>
                <button className="btn" style={{ padding: "2px 8px", fontSize: 12 }} disabled={s.pc[t]! >= ops.length} onClick={() => push(tsoExec(p, s, t))}>Run</button>
                <button className="btn" style={{ padding: "2px 8px", fontSize: 12 }} disabled={!s.buf[t]!.length} onClick={() => push(tsoDrain(s, t))}>Drain</button>
              </span>
            </ThreadHead>
            {ops.map((op, i) => (
              <Code key={i} text={op.cxx} note={`x86: ${op.asm}${op.k === "st" && op.locked ? " (drains the buffer first)" : ""}`} color={TC[t]!} state={i < s.pc[t]! ? "done" : i === s.pc[t] ? "now" : "todo"} />
            ))}
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <span className="muted">Store buffer (oldest first): </span>
              <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", verticalAlign: "middle" }}>
                {s.buf[t]!.length === 0 && <span className="muted">empty</span>}
                {s.buf[t]!.map(([l, v], i) => <span key={i} style={{ fontFamily: mono, border: `1.5px solid ${TC[t]}`, borderRadius: 4, padding: "0 6px" }}>{l} = {v}</span>)}
              </span>
            </div>
            <div style={{ fontFamily: mono, fontSize: 12, marginTop: 4, color: "var(--muted)" }}>
              {ops.flatMap((op) => (op.k === "ld" ? [`${op.reg} = ${s.regs[op.reg] ?? "—"}`] : [])).join(" · ")}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>Outcomes still possible:</span>
        {all.map((k) => {
          const weak = !sc.includes(k), on = reach.includes(k);
          return <span key={k} className="tag" style={{ opacity: on ? 1 : 0.35, borderColor: weak ? "var(--c4)" : undefined, color: weak ? "var(--c4)" : undefined, textDecoration: on ? undefined : "line-through" }}>{k}{weak ? " (not SC)" : ""}</span>;
        })}
      </div>
      {finished && (sc.includes(reach[0]!)
        ? <Verdict good>Result {reach[0]}. Some interleaving gives this result, so it is sequentially consistent.</Verdict>
        : <Verdict good={false}>Result {reach[0]}. No interleaving gives this result. The stores waited in the buffers while the loads read memory.</Verdict>)}
    </Demo>
  );
}
