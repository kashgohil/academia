/** Demos for the lesson on page faults and demand paging. */
import { useMemo, useRef, useState } from "react";
import { Area, Canvas2D, Demo, Dots, Line, Param, Plot, RuleX, RuleY, SimButtons, Stats, cssVar, range, useParams, useSim } from "../../kit";
import {
  AddressSpace, DEVICE_NS, DRAM_NS, FAULT_COST_NS, GiB, MiB, OUTCOME_LABEL, PAGE_SIZE, VmKernel, effectiveAccessNs, faultRateForSlowdown, fmtBytes, hexVa, isMajor, isMinor, isSegv, overcommitCheck, vmaLabel, vmaPerms, type AccessKind, type AccessResult, type DecisionId, type FaultOutcome, type OvercommitMode, type PteState,
} from "../../sims/os/vm";
import { Meter, Note, mono, seg } from "../db/StorageUi";

// ---------------- fault path ----------------

const TEXT = 0x555555554000, DATA = 0x55555555a000, HEAP = 0x555555c00000, GUARD = 0x7f0000000000, ANON = 0x7f0000001000, LIB = 0x7f0000100000, STACK = 0x7ffffffde000;

function makeProcess() {
  const k = new VmKernel();
  k.warmFile("libc.so.6", 4); // another process already read these
  const as = new AddressSpace(k);
  as.mmap(TEXT, 4 * PAGE_SIZE, { read: true, exec: true, file: { name: "/usr/bin/app" }, name: "program code" });
  as.mmap(DATA, 2 * PAGE_SIZE, { read: true, write: true, file: { name: "/usr/bin/app", offset: 0x6000 }, name: "program data" });
  as.mmap(HEAP, 4 * PAGE_SIZE, { read: true, write: true, name: "[heap]" });
  as.mmap(GUARD, PAGE_SIZE, { read: false, write: false, name: "guard page" });
  as.mmap(ANON, 4 * PAGE_SIZE, { read: true, write: true, name: "malloc block" });
  as.mmap(LIB, 4 * PAGE_SIZE, { read: true, exec: true, file: { name: "libc.so.6" }, name: "libc code" });
  as.mmap(STACK, 2 * PAGE_SIZE, { read: true, write: true, growsDown: true, name: "[stack]" });
  return as;
}

const PTE_COLOR: Record<PteState, string> = { none: "transparent", swap: "var(--c5)", "present-ro": "var(--c1)", "present-rw": "var(--c3)", "zero-page": "var(--faint)" };
const PTE_NAME: Record<PteState, string> = { none: "empty", swap: "swap entry", "present-ro": "present, read-only", "present-rw": "present, writable", "zero-page": "zero page, read-only" };

const outcomeColor = (o: FaultOutcome) => (o === "hit" ? "var(--c3)" : isMinor(o) ? "var(--c1)" : isMajor(o) ? "var(--c2)" : "var(--c4)");

const GATES: { id: DecisionId[]; label: string }[] = [
  { id: ["walk"], label: "Walk" },
  { id: ["fault"], label: "#PF" },
  { id: ["vma", "stack"], label: "VMA?" },
  { id: ["rights"], label: "Rights?" },
  { id: ["pte", "swap"], label: "PTE?" },
  { id: ["anon", "file", "wp", "swap"], label: "Handler" },
  { id: ["done"], label: "Result" },
];

export function VmFaultPathDemo() {
  const asRef = useRef<AddressSpace>(makeProcess());
  const [addr, setAddr] = useState(ANON);
  const [res, setRes] = useState<AccessResult | null>(null);
  const [shown, setShown] = useState(99);
  const [log, setLog] = useState({ segv: 0 });
  const [, force] = useState(0);
  const as = asRef.current;
  const run = (kind: AccessKind) => {
    const r = as.access(addr, kind);
    setRes(r);
    setShown(2);
    if (isSegv(r.outcome)) setLog((l) => ({ segv: l.segv + 1 }));
  };
  const reset = () => { asRef.current = makeProcess(); setRes(null); setLog({ segv: 0 }); force((x) => x + 1); };
  const vmas = as.vmas.all;
  const page = addr - (addr % PAGE_SIZE);
  const selVma = as.vmas.find(addr);
  const state = as.pteState(addr);
  const canSwap = state === "present-rw" && !selVma?.file;
  const gaps: { name: string; va: number; note: string }[] = [
    { name: "Unmapped gap", va: 0x600000000000, note: "no VMA" },
    { name: "Just below the stack", va: as.vmas.all.at(-1)!.start - PAGE_SIZE, note: "growth" },
    { name: "Far below the stack", va: STACK - 64 * MiB, note: "outside the limit" },
    { name: "NULL", va: 0, note: "no VMA" },
  ];
  const steps = res?.steps ?? [];
  const visible = steps.slice(0, shown);
  const allShown = shown >= steps.length;
  const reached = new Set(visible.map((s) => s.id));
  return (
    <Demo
      title="A process, its VMAs, and the fault path"
      actions={<button className="btn ghost" onClick={reset}>Reset</button>}
    >
      <div style={{ fontSize: 12, marginBottom: 8 }} className="muted">Pick a page. Each square is one page: its color is the PTE state.</div>
      <div style={{ display: "grid", gap: 4, marginBottom: 10 }}>
        {[...vmas].reverse().map((v) => (
          <div key={v.start} style={{ display: "grid", gridTemplateColumns: "minmax(0, 118px) 40px minmax(0, 1fr)", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{vmaLabel(v)}</span>
            <span className="muted" style={mono}>{vmaPerms(v)}</span>
            <span style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              {Array.from({ length: Math.min(12, (v.end - v.start) / PAGE_SIZE) }, (_, i) => {
                const va = v.start + i * PAGE_SIZE;
                const st = as.pteState(va);
                const on = va === page;
                return <button key={i} aria-label={`${vmaLabel(v)} page ${i}: ${PTE_NAME[st]}`} title={`${hexVa(va)}: ${PTE_NAME[st]}`} onClick={() => setAddr(va)} style={{ width: 20, height: 20, padding: 0, cursor: "pointer", borderRadius: 2, background: PTE_COLOR[st], border: `${on ? 2 : 1}px solid ${on ? "var(--fg)" : "var(--faint)"}` }} />;
              })}
            </span>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
        {gaps.map((g) => <button key={g.name} className="btn" style={{ fontSize: 12 }} onClick={() => setAddr(g.va)}>{g.name}</button>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 11, marginBottom: 10 }} className="muted">
        {(Object.keys(PTE_NAME) as PteState[]).map((k) => <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><i style={{ width: 10, height: 10, display: "inline-block", background: PTE_COLOR[k], border: "1px solid var(--faint)" }} />{PTE_NAME[k]}</span>)}
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          <b style={mono}>{hexVa(addr)}</b>
          <span className="muted"> · {selVma ? `${vmaLabel(selVma)} ${vmaPerms(selVma)}` : "no VMA"} · PTE: {PTE_NAME[state]}</span>
        </div>
        <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={() => run("r")}>Read</button>
          <button className="btn primary" onClick={() => run("w")}>Write</button>
          <button className="btn primary" onClick={() => run("x")}>Execute</button>
          <button className="btn" disabled={!canSwap} onClick={() => { as.swapOut(addr); setRes(null); force((x) => x + 1); }}>Swap this page out</button>
        </div>
      </div>
      {/* gates */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(62px, 1fr))", gap: 3, marginBottom: 8 }}>
        {GATES.map((g) => {
          const hit = g.id.some((x) => reached.has(x));
          const isEnd = g.label === "Result" && hit && res;
          return <div key={g.label} style={{ textAlign: "center", fontSize: 11.5, padding: "3px 2px", borderRadius: 3, border: "1px solid var(--border)", background: isEnd ? outcomeColor(res!.outcome) : hit ? "var(--fg)" : "transparent", color: hit ? "var(--bg)" : "var(--faint)" }}>{g.label}</div>;
        })}
      </div>
      {res && (
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12.5 }}>
          {visible.map((s, i) => <li key={i} style={{ marginBottom: 3 }}><b>{s.title}.</b> <span className="muted" style={{ overflowWrap: "anywhere" }}>{s.detail}</span></li>)}
        </ol>
      )}
      {res && (
        <div className="row" style={{ gap: 6, margin: "6px 0 8px" }}>
          <button className="btn" disabled={allShown} onClick={() => setShown((n) => n + 1)}>Next decision</button>
          <button className="btn ghost" disabled={allShown} onClick={() => setShown(99)}>All</button>
        </div>
      )}
      {res && allShown && (
        <p style={{ margin: "0 0 8px", fontSize: 13, color: outcomeColor(res.outcome) }}>
          <b>{OUTCOME_LABEL[res.outcome]}.</b> PTE: {PTE_NAME[res.pteStateBefore]} → {PTE_NAME[res.pteStateAfter]}. Model cost: {res.costNs >= 1000 ? `${res.costNs / 1000} µs` : `${res.costNs} ns`}.
          {res.tableBytesAdded > 0 ? ` The fault also allocated ${fmtBytes(res.tableBytesAdded)} of page tables.` : ""}
        </p>
      )}
      <Stats items={[
        { label: "minor faults (ru_minflt)", value: as.minorFaults },
        { label: "major faults (ru_majflt)", value: as.majorFaults },
        { label: "resident pages", value: as.rssPages },
        { label: "page tables", value: fmtBytes(as.pt.tableBytes) },
        { label: "signals", value: log.segv },
      ]} />
    </Demo>
  );
}

// ---------------- demand paging ----------------

type TouchMode = "write" | "read" | "readwrite";
interface Run { as: AddressSpace; i: number; phase: number; pts: [number, number][]; time: number; zero: Uint8Array; base: number }

const SIZES = { "16": 16 * MiB, "64": 64 * MiB } as const;

function newRun(bytes: number): Run {
  const as = new AddressSpace();
  const base = 0x7f0000000000;
  as.mmap(base, bytes, { read: true, write: true, name: "malloc block" });
  return { as, i: 0, phase: 0, pts: [[0, 0]], time: 0, zero: new Uint8Array(bytes / PAGE_SIZE), base };
}

export function VmDemandPagingDemo() {
  const p = useParams("vmdemand", {
    size: seg<"16" | "64">("malloc size", [["16", "16 MiB"], ["64", "64 MiB"]], "16"),
    mode: seg<TouchMode>("Then the program", [["write", "Writes each page"], ["read", "Only reads each page"], ["readwrite", "Reads, then writes"]], "write"),
  });
  const bytes = SIZES[p.values.size];
  const pages = bytes / PAGE_SIZE;
  const mode = p.values.mode;
  const run = useRef<Run>(newRun(bytes));
  const reset = () => { run.current = newRun(bytes); };
  const key = `${bytes}:${mode}`;
  const lastKey = useRef(key);
  if (lastKey.current !== key) { lastKey.current = key; reset(); }
  const phases: AccessKind[] = mode === "write" ? ["w"] : mode === "read" ? ["r"] : ["r", "w"];
  const totalSteps = pages * phases.length;
  const perTick = Math.max(1, Math.round(pages / 240));
  const step = () => {
    const r = run.current;
    for (let k = 0; k < perTick; k++) {
      if (r.phase >= phases.length) { sim.pause(); return; }
      const res = r.as.access(r.base + r.i * PAGE_SIZE, phases[r.phase]!);
      r.time += res.costNs;
      r.zero[r.i] = res.outcome === "minor-zero" ? 1 : res.outcome === "minor-anon" || res.outcome === "minor-cow" ? 2 : r.zero[r.i]!;
      r.i++;
      if (r.i >= pages) { r.i = 0; r.phase++; }
    }
    const done = r.phase * pages + r.i;
    r.pts.push([done, (r.as.rssPages * PAGE_SIZE) / MiB]);
  };
  const sim = useSim({ step, reset, dt: 1 / 60 });
  const r = run.current;
  const as = r.as;
  const done = r.phase * pages + r.i;
  const grid = useMemo(() => ({ cols: 128 }), []);
  const rows = Math.ceil(pages / grid.cols);
  return (
    <Demo
      title="malloc, then touch: resident memory grows one fault at a time"
      actions={<SimButtons sim={sim} />}
      controls={<>
        <Param spec={p.schema.size} value={p.values.size} onChange={(x) => p.set("size", x as "16")} />
        <Param spec={p.schema.mode} value={mode} onChange={(x) => p.set("mode", x as TouchMode)} />
      </>}
    >
      <Canvas2D
        height={Math.max(48, Math.min(96, rows * 2))}
        deps={[done, key]}
        draw={(ctx, w, h) => {
          const cw = w / grid.cols, ch = h / rows;
          ctx.fillStyle = cssVar("--subtle");
          ctx.fillRect(0, 0, w, h);
          const zero = cssVar("--faint"), own = cssVar("--c3");
          for (let i = 0; i < pages; i++) {
            const z = r.zero[i]!;
            if (!z) continue;
            ctx.fillStyle = z === 1 ? zero : own;
            ctx.fillRect((i % grid.cols) * cw, Math.floor(i / grid.cols) * ch, Math.ceil(cw), Math.ceil(ch));
          }
        }}
      />
      <div className="muted" style={{ fontSize: 11.5, margin: "4px 0 10px" }}>Each cell is one page of the block. Pale: empty. Grey: zero page. Green: its own frame.</div>
      <Plot x={[0, totalSteps]} y={[0, bytes / MiB]} height={190} xLabel="page touches" yLabel="resident MiB" xFormat={(x) => `${(x / 1024).toFixed(x % 1024 ? 1 : 0)}k`} xTicks={[0, totalSteps / 4, totalSteps / 2, (3 * totalSteps) / 4, totalSteps]}>
        <Area points={r.pts} color="var(--c3)" opacity={0.18} />
        <Line points={r.pts} color="var(--c3)" />
        <RuleY at={(bytes / MiB) * 0.995} color="var(--c5)" label="virtual size" />
        {mode === "readwrite" && <RuleX at={pages} label="writes start" />}
      </Plot>
      <Stats items={[
        { label: "virtual size", value: fmtBytes(bytes) },
        { label: "resident size", value: fmtBytes(as.rssPages * PAGE_SIZE) },
        { label: "page tables", value: fmtBytes(as.pt.tableBytes) },
        { label: "minor faults", value: as.minorFaults.toLocaleString("en-US") },
        { label: "time in faults, model", value: `${(r.time / 1e6).toFixed(1)} ms` },
      ]} />
    </Demo>
  );
}

// ---------------- cost ----------------

const DEVICES = { nvme: "NVMe SSD", sata: "SATA SSD", hdd: "Hard disk" } as const;

export function VmFaultCostDemo() {
  const p = useParams("vmcostfault", {
    rate: range({ label: "Major faults per access", min: 1e-8, max: 1e-2, default: 1e-5, log: true, format: (x) => x.toExponential(1) }),
    device: seg<keyof typeof DEVICES>("Device", [["nvme", DEVICES.nvme], ["sata", DEVICES.sata], ["hdd", DEVICES.hdd]], "nvme"),
  });
  const dev = DEVICE_NS[p.values.device];
  const rate = p.values.rate;
  const curve = useMemo(() => Array.from({ length: 61 }, (_, i) => { const x = 1e-8 * 10 ** (i / 10); return [x, effectiveAccessNs(x, dev)] as const; }), [dev]);
  const eff = effectiveAccessNs(rate, dev);
  return (
    <Demo
      title="How rare must a major fault be?"
      controls={<>
        <Param spec={p.schema.rate} value={rate} onChange={(x) => p.set("rate", x as number)} />
        <Param spec={p.schema.device} value={p.values.device} onChange={(x) => p.set("device", x as keyof typeof DEVICES)} />
      </>}
    >
      <Plot x={[1e-8, 1e-2]} y={[DRAM_NS * 0.8, 1e5]} logX logY height={240} xLabel="major faults per access" yLabel="average access, ns" xFormat={(x) => x.toExponential(0)} yFormat={(y) => (y >= 1000 ? `${y / 1000} µs` : `${y} ns`)} xTicks={[1e-8, 1e-6, 1e-4, 1e-2]} yTicks={[100, 1000, 10000, 100000]}>
        <Line points={curve} color="var(--c2)" />
        <Line points={[[1e-8, DRAM_NS], [1e-2, DRAM_NS]]} color="var(--faint)" dash="4 3" />
        <Dots points={[[rate, eff]]} color="var(--fg)" />
      </Plot>
      <Stats items={[
        { label: "average access", value: eff >= 1000 ? `${(eff / 1000).toFixed(2)} µs` : `${eff.toFixed(0)} ns` },
        { label: "slowdown", value: `${(eff / DRAM_NS).toFixed(2)} ×` },
        { label: "rate for a 10% slowdown", value: faultRateForSlowdown(1.1, dev).toExponential(1) },
        { label: "one minor fault, model", value: `${FAULT_COST_NS["minor-anon"] / 1000} µs` },
        { label: "one major fault, model", value: `${dev >= 1e6 ? `${dev / 1e6} ms` : `${dev / 1000} µs`}` },
      ]} />
      <Note>Model inputs: DRAM {DRAM_NS} ns, NVMe {DEVICE_NS.nvme / 1000} µs, SATA {DEVICE_NS.sata / 1000} µs, hard disk {DEVICE_NS.hdd / 1e6} ms.</Note>
    </Demo>
  );
}

// ---------------- overcommit ----------------

export function VmOvercommitDemo() {
  const p = useParams("vmovercommit", {
    request: range({ label: "This mmap asks for", min: 1, max: 128, step: 1, default: 24, format: (x) => `${x} GiB` }),
    committed: range({ label: "Already committed by all processes", min: 0, max: 64, step: 1, default: 12, format: (x) => `${x} GiB` }),
    ram: range({ label: "RAM", min: 4, max: 64, step: 4, default: 16, format: (x) => `${x} GiB` }),
    swap: range({ label: "Swap", min: 0, max: 32, step: 2, default: 4, format: (x) => `${x} GiB` }),
    mode: seg<"0" | "1" | "2">("vm.overcommit_memory", [["0", "0: heuristic"], ["1", "1: always"], ["2", "2: never"]], "0"),
    ratio: range({ label: "vm.overcommit_ratio (mode 2)", min: 0, max: 100, step: 5, default: 50, format: (x) => `${x}%` }),
  });
  const v = p.values;
  const r = overcommitCheck({ mode: Number(v.mode) as OvercommitMode, ramBytes: v.ram * GiB, swapBytes: v.swap * GiB, ratioPct: v.ratio, committedBytes: v.committed * GiB, requestBytes: v.request * GiB });
  const counted = v.mode === "2" ? v.request + v.committed : v.request;
  const limit = r.limitBytes === null ? null : r.limitBytes / GiB;
  const max = Math.max(counted, limit ?? 0, 1);
  return (
    <Demo
      title="Does this mmap succeed?"
      controls={<>
        {(["request", "committed", "ram", "swap", "mode"] as const).map((k) => <Param key={k} spec={p.schema[k]} value={v[k]} onChange={(x) => p.set(k, x as never)} />)}
        {v.mode === "2" && <Param spec={p.schema.ratio} value={v.ratio} onChange={(x) => p.set("ratio", x as number)} />}
      </>}
    >
      <p style={{ fontSize: 15, margin: "0 0 8px", fontWeight: 600, color: r.ok ? "var(--c3)" : "var(--c4)" }}>{r.ok ? "mmap succeeds" : "mmap returns ENOMEM"}</p>
      <Meter label={v.mode === "2" ? "committed + this request" : "this request"} value={counted} max={max} color={r.ok ? "var(--c3)" : "var(--c4)"} text={`${counted} GiB`} />
      {limit !== null ? <Meter label={v.mode === "2" ? "CommitLimit = swap + RAM × ratio" : "RAM + swap"} value={limit} max={max} color="var(--c1)" text={`${limit} GiB`} /> : <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>Mode 1 has no limit.</p>}
      <p style={{ fontSize: 13, margin: "6px 0 0" }}>{r.reason}</p>
      <Note>A successful mmap reserves no frames. If the program later touches more than the machine can hold, the OOM killer decides who dies.</Note>
    </Demo>
  );
}
