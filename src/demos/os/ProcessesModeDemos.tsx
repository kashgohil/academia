/** Lesson: kernel mode and user mode. An instruction runner, and a timeline of one CPU's mode. */
import { useMemo, useState } from "react";
import { Demo, Legend, Param, Stats, pct, range, select, useWidth, Note, SmallLabel, mono, seg, tint } from "../../kit";
import { ENTRY_INFO, ENTRY_US, initialBits, instructionsFor, timeline, type Arch, type CpuBits, type EntryKind, type Instruction, type Mode, type Outcome } from "../../sims/os/processes";

const MODE_NAME: Record<Arch, Record<Mode, string>> = { x86: { user: "ring 3", kernel: "ring 0" }, arm: { user: "EL0", kernel: "EL1" } };

interface Run { id: string; asm: string; mode: Mode; o: Outcome; key: number }

export function InstructionRunnerDemo() {
  const [arch, setArch] = useState<Arch>("x86");
  const [bits, setBits] = useState<CpuBits>(initialBits("user"));
  const [runs, setRuns] = useState<Run[]>([]);
  const list = instructionsFor(arch);
  const last = new Map<string, Outcome>();
  for (const r of [...runs].reverse()) if (r.mode === bits.mode && !last.has(r.id)) last.set(r.id, r.o);
  const run = (i: Instruction) => {
    const o = i.run(bits);
    setRuns((x) => [{ id: i.id, asm: i.asm, mode: bits.mode, o, key: (x[0]?.key ?? 0) + 1 }, ...x].slice(0, 6));
    setBits(o.next);
  };
  const latest = runs[0];
  const accessName = arch === "x86" ? "EFLAGS.AC" : "PAN clear";
  return (
    <Demo
      title="Run an instruction in each mode"
      actions={<button className="btn ghost" onClick={() => { setRuns([]); setBits(initialBits(bits.mode)); }}>Clear</button>}
      controls={<>
        <Param spec={seg<Arch>("CPU", [["x86", "x86-64"], ["arm", "arm64"]], "x86")} value={arch} onChange={(v) => { setArch(v as Arch); setRuns([]); setBits(initialBits(bits.mode)); }} />
        <Param spec={select<Mode>({ label: "Current mode", segmented: true, default: "user", options: [{ value: "user", label: `${MODE_NAME[arch].user} (user)` }, { value: "kernel", label: `${MODE_NAME[arch].kernel} (kernel)` }] })} value={bits.mode} onChange={(v) => setBits({ ...bits, mode: v as Mode })} />
      </>}
    >
      <SmallLabel>Click an instruction. Green ran, and red faulted, in the current mode.</SmallLabel>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 5 }}>
        {list.map((i) => {
          const o = last.get(i.id);
          return (
            <button key={i.id} className="btn" onClick={() => run(i)} style={{ ...mono, fontSize: 12, textAlign: "left", justifyContent: "flex-start", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", borderColor: o ? (o.fault ? "var(--c4)" : "var(--c3)") : undefined, background: o ? tint(o.fault ? "var(--c4)" : "var(--c3)", 10) : undefined }}>{i.asm}</button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", minHeight: 92 }}>
        {latest ? (
          <>
            <div style={{ ...mono, fontSize: 12.5 }}>
              <span className="muted">{MODE_NAME[arch][latest.mode]}: </span>{latest.asm}
              {latest.o.fault
                ? <b style={{ color: "var(--c4)", fontWeight: 600 }}> → {latest.o.exception} → {latest.o.signal}</b>
                : <b style={{ color: "var(--c3)", fontWeight: 600 }}> → runs</b>}
            </div>
            <p style={{ fontSize: 13, margin: "4px 0 0" }}>{latest.o.text}</p>
          </>
        ) : <p className="muted" style={{ fontSize: 13, margin: 0 }}>The CPU is in {MODE_NAME[arch][bits.mode]}. Try a privileged instruction such as {arch === "x86" ? "cli" : "msr daifset, #2"}.</p>}
      </div>
      <div style={{ margin: "10px 0 0" }}>
        <Stats items={[
          { label: "mode", value: MODE_NAME[arch][bits.mode] },
          { label: "interrupts", value: bits.interrupts ? "on" : "off" },
          { label: accessName, value: bits.userAccess ? "yes" : "no" },
          { label: "last 6 runs that faulted", value: runs.filter((r) => r.o.fault).length },
        ]} />
      </div>
      <Note>A fault in user mode kills only that program, or runs its signal handler. The kernel keeps running. A kernel fault with no fix-up is an oops.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- the timeline

const KIND_COLOR: Record<EntryKind | "timer", string> = { getpid: "var(--c1)", read: "var(--c1)", fault: "var(--c2)", disk: "var(--c3)", timer: "var(--c5)" };
const MAX_EVENTS = 12;

export function ModeTimelineDemo() {
  const [events, setEvents] = useState<EntryKind[]>(["getpid", "fault", "read", "disk", "getpid"]);
  const [hz, setHz] = useState("250");
  const [gap, setGap] = useState(700);
  const t = useMemo(() => timeline(events, Number(hz), Math.round(gap)), [events, hz, gap]);
  const [ref, w] = useWidth<HTMLDivElement>();
  const add = (e: EntryKind) => setEvents((x) => [...x, e].slice(-MAX_EVENTS));
  // Square-root widths keep a 0.2 µs slice next to a 2 ms slice visible.
  const scale = (d: number) => Math.sqrt(d);
  const total = t.segments.reduce((a, s) => a + scale(s.durUs), 0) || 1;
  const minW = 3;
  const usable = Math.max(10, w - t.segments.length * minW);
  let x = 0;
  const H = 92, yUser = 78, yKernel = 34, yNested = 12;
  const rects = t.segments.map((s, i) => {
    const sw = minW + (scale(s.durUs) / total) * usable;
    const r = { s, i, x, w: sw };
    x += sw;
    return r;
  });
  let path = "";
  for (const r of rects) {
    const y = r.s.mode === "user" ? yUser : r.s.nested ? yNested : yKernel;
    path += `${path ? "L" : "M"}${r.x},${y} L${r.x + r.w},${y} `;
  }
  return (
    <Demo
      title="One CPU over time: user mode and kernel mode"
      actions={<button className="btn ghost" onClick={() => setEvents([])}>Clear</button>}
      controls={<>
        <Param spec={seg("Timer rate (CONFIG_HZ)", [["100", "100 Hz"], ["250", "250 Hz"], ["1000", "1000 Hz"]], "250")} value={hz} onChange={(v) => setHz(v as string)} />
        <Param spec={range({ label: "User work before each event", min: 50, max: 3000, default: 700, log: true, format: (v) => `${Math.round(v)} µs` })} value={gap} onChange={(v) => setGap(v as number)} />
      </>}
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Add:</span>
        <button className="btn" onClick={() => add("getpid")}>Short syscall</button>
        <button className="btn" onClick={() => add("read")}>Long syscall</button>
        <button className="btn" onClick={() => add("fault")}>Page fault</button>
        <button className="btn" onClick={() => add("disk")}>Disk interrupt</button>
      </div>
      <div ref={ref}>
        <svg width={w} height={H} style={{ display: "block" }}>
          <line x1={0} x2={w} y1={yUser + 7} y2={yUser + 7} stroke="var(--border)" />
          {rects.filter((r) => r.s.mode === "kernel").map((r) => (
            <rect key={r.i} x={r.x} y={r.s.nested ? yNested : yKernel} width={r.w} height={yUser + 7 - (r.s.nested ? yNested : yKernel)} fill={tint(KIND_COLOR[r.s.kind!], r.s.nested ? 50 : 30)}>
              <title>{`${ENTRY_INFO[r.s.kind!].label}: ${r.s.durUs} µs`}</title>
            </rect>
          ))}
          <path d={path} fill="none" stroke="var(--fg)" strokeWidth={1.5} />
        </svg>
      </div>
      <SmallLabel>The low line is user mode, and the high line is kernel mode. Widths use a square-root scale, so that short slices stay visible.</SmallLabel>
      <Legend box items={[
        { label: `syscall (short ${ENTRY_US.getpid} µs, long ${ENTRY_US.read} µs)`, color: "var(--c1)" },
        { label: `page fault (${ENTRY_US.fault} µs)`, color: "var(--c2)" },
        { label: `disk interrupt (${ENTRY_US.disk} µs)`, color: "var(--c3)" },
        { label: `timer (${ENTRY_US.timer} µs)`, color: "var(--c5)" },
      ]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "time in the kernel", value: pct(t.kernelUs / Math.max(1, t.kernelUs + t.userUs), 1) },
          { label: "user to kernel entries", value: t.entries },
          { label: "timer ticks", value: t.ticks },
          { label: "ticks already in the kernel", value: t.nestedTicks },
        ]} />
      </div>
      <Note>The kernel times in the key are model inputs. They are round figures, not measurements. A tick above the kernel level interrupted the kernel itself, so the mode did not change.</Note>
    </Demo>
  );
}
