/** Lesson: eBPF. A real verifier and interpreter in the browser, and a latency histogram with bytes moved. */
import { useMemo, useState } from "react";
import { Bars, Demo, Legend, Line, Param, Plot, RuleX, Stats, range, select, si, useParams, IndexButtons, IndexSlider, Note, Panel, SmallLabel, mono, seg, tint } from "../../kit";
import {
  AGG_INPUTS, BPF_PRESETS, BpfVm, HIST_BYTES, EVENT_BYTES_DEFAULT, SIM_COMPLEXITY_LIMIT, aggregateInUser, assemble, bytesRatio, fmtReg, formatInsn, hexOf, latencySample, mapBytesPerSecond, mapCpuShare, presetById, runInKernel, shipBytesPerSecond, shipCpuShare, verify,
  type LogEntry, type LogKind, type PresetGroup, type Reg,
} from "../../sims/os/observability";
import { Msg } from "./ProcessesUi";

const GROUP_LABEL: Record<PresetGroup, string> = { safe: "Safe", unsafe: "Unsafe", correct: "Correct, but rejected" };

const KIND_COLOR: Partial<Record<LogKind, string>> = { fork: "var(--c2)", dead: "var(--c2)", prune: "var(--c5)", exit: "var(--c3)", error: "var(--c4)", accept: "var(--c3)", pop: "var(--c5)" };
const KIND_LABEL: Record<LogKind, string> = { insn: "", fork: "fork", dead: "one way", prune: "pruned", exit: "path ends", pop: "next path", error: "rejected", accept: "accepted" };

function RegCard({ name, reg, hot, maps }: { name: string; reg: Reg; hot: boolean; maps: { name: string }[] }) {
  const none = reg.k === "none";
  const isPtr = !none && reg.k !== "scalar";
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "baseline", padding: "1px 6px", borderRadius: 3, background: hot ? tint("var(--c2)", 18) : undefined, transition: "background 0.2s", minWidth: 0 }}>
      <b style={{ ...mono, fontSize: 11.5, fontWeight: 600, width: 24, flex: "none", color: none ? "var(--faint)" : "var(--fg)" }}>{name}</b>
      <span style={{ ...mono, fontSize: 11.5, minWidth: 0, overflowWrap: "anywhere", color: none ? "var(--faint)" : isPtr ? "var(--c1)" : "var(--fg)" }}>{fmtReg(reg, maps)}</span>
    </div>
  );
}

const INPUTS: { value: string; label: string; v: bigint }[] = [
  { value: "5", label: "5", v: 5n },
  { value: "63", label: "63", v: 63n },
  { value: "64", label: "64", v: 64n },
  { value: "m1", label: "-1", v: -1n },
  { value: "big", label: "$2^{40}$", v: 1n << 40n },
];

function runProgram(prog: NonNullable<ReturnType<typeof compile>["prog"]>, rdi: bigint, packetLen: number) {
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const vm = new BpfVm(prog, { regs: { rdi }, packet: new Uint8Array(packetLen), rng });
  return vm.run(50_000);
}

function compile(src: string) {
  const a = assemble(src);
  return a.ok ? { prog: a.prog, error: null as string | null, line: 0 } : { prog: null, error: a.error, line: a.line };
}

export function BpfVerifierDemo() {
  const p = useParams("bpf-v", {
    preset: select<string>({ label: "Program", options: BPF_PRESETS.map((x) => ({ value: x.id, label: `${GROUP_LABEL[x.group]}: ${x.label}` })), default: "mask" }),
    loops: seg("Back-edges", [["allow", "Linux 5.3 and later"], ["deny", "Older: no loops"]], "allow"),
    input: seg("Run input: the first argument (rdi)", INPUTS.map((i) => [i.value, i.label] as [string, string]), "5"),
    pkt: range({ label: "Run input: packet length", min: 0, max: 64, step: 1, default: 60, format: (v) => `${v} bytes` }),
  });
  const preset = presetById(p.values.preset);
  const [edit, setEdit] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [k, setK] = useState(0);
  const src = edit ?? preset.source;
  const compiled = useMemo(() => compile(src), [src]);
  const result = useMemo(() => (compiled.prog ? verify(compiled.prog, { noLoops: p.values.loops === "deny" }) : null), [compiled, p.values.loops]);
  const log: LogEntry[] = result?.log ?? [];
  const kk = Math.min(k, Math.max(0, log.length - 1));
  const e = log[kk];
  const prog = compiled.prog;
  const rdi = INPUTS.find((i) => i.value === p.values.input)!.v;
  const run = useMemo(() => (prog ? runProgram(prog, rdi, p.values.pkt) : null), [prog, rdi, p.values.pkt]);
  const choose = (id: string) => {
    p.set("preset", id);
    setEdit(null);
    setK(0);
  };
  const maps = prog?.maps ?? [];
  const usedStack = e ? e.stack.map((s, i) => ({ s, off: -(i + 1) * 8 })).filter((x) => x.s) : [];
  const runText = !run ? "" : run.status === "exit" ? `It exits with r0 = ${run.r0}, after ${run.steps} instructions.` : run.status === "violation" ? `It stops at instruction ${run.violation!.pc}: ${run.violation!.what}.` : `It still runs after ${si(run.steps)} instructions, so the interpreter stops it.`;
  return (
    <Demo
      title="A real verifier: walk each path"
      actions={<IndexButtons k={kk} n={Math.max(1, log.length)} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={Math.max(1, log.length)} set={setK} />
        <Param spec={p.schema.loops} value={p.values.loops} onChange={(v) => { p.set("loops", v as "allow"); setK(0); }} />
        <Param spec={p.schema.input} value={p.values.input} onChange={(v) => p.set("input", v as string)} />
        <Param spec={p.schema.pkt} value={p.values.pkt} onChange={(v) => p.set("pkt", v as number)} />
      </>}
    >
      <div style={{ marginBottom: 8 }}>
        <Param spec={p.schema.preset} value={p.values.preset} onChange={(v) => choose(v as string)} />
      </div>
      <div style={{ padding: "6px 10px", borderRadius: 6, marginBottom: 8, fontSize: 13, border: `1px solid ${result?.ok ? "var(--c3)" : "var(--c4)"}`, background: tint(result?.ok ? "var(--c3)" : "var(--c4)", 10), overflowWrap: "anywhere" }}>
        {compiled.error ? <><b style={{ fontWeight: 600 }}>Line {compiled.line}:</b> {compiled.error}</> : result?.ok
          ? <><b style={{ fontWeight: 600 }}>Accepted.</b> {result.processed} instructions processed, {result.forks} {result.forks === 1 ? "fork" : "forks"}, {result.pruned} {result.pruned === 1 ? "path" : "paths"} pruned.</>
          : <><b style={{ fontWeight: 600 }}>Rejected at instruction {result?.errorPc}.</b> <span style={mono}>{result?.error}</span></>}
      </div>
      <Msg min={54}>{preset.why && edit === null ? preset.why : "This is your program. Step through the walk, and read the verdict above."}</Msg>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button className="btn" onClick={() => { if (!editing && edit === null) setEdit(preset.source); setEditing(!editing); }}>{editing ? "Hide the source" : "Edit the source"}</button>
        {edit !== null && <button className="btn ghost" onClick={() => { setEdit(null); setK(0); }}>Restore the preset</button>}
      </div>
      {editing && (
        <textarea
          aria-label="Program source"
          spellCheck={false}
          value={src}
          onChange={(ev) => { setEdit(ev.target.value); setK(0); }}
          style={{ ...mono, width: "100%", boxSizing: "border-box", height: 210, fontSize: 12, padding: 6, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--fg)", marginBottom: 8, resize: "vertical" }}
        />
      )}
      {prog && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 8, alignItems: "start" }}>
          <Panel title={`Program (${prog.type})`}>
            <div style={{ maxHeight: 330, overflowY: "auto" }}>
              {prog.insns.map((ins, pc) => {
                if (ins.filler) return null;
                const cur = e?.pc === pc && e.kind !== "accept";
                const bad = !result?.ok && result?.errorPc === pc;
                return (
                  <div key={pc} style={{ ...mono, display: "flex", gap: 6, fontSize: 11.5, padding: "1px 4px", borderRadius: 3, background: cur ? tint(bad && e?.kind === "error" ? "var(--c4)" : "var(--c1)", 20) : undefined }}>
                    <span style={{ width: 20, textAlign: "right", flex: "none", color: "var(--muted)" }}>{pc}</span>
                    <span style={{ minWidth: 0, overflowWrap: "anywhere", color: bad && kk === log.length - 1 ? "var(--c4)" : "var(--fg)" }}>{formatInsn(ins, maps)}</span>
                  </div>
                );
              })}
            </div>
            <div className="muted" style={{ ...mono, fontSize: 10.5, marginTop: 6, minHeight: 15, overflowWrap: "anywhere" }}>{e && prog.insns[e.pc] && !prog.insns[e.pc]!.filler ? `bytes: ${hexOf(prog.insns[e.pc]!)}` : ""}</div>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2, minHeight: 17, overflowWrap: "anywhere" }}>{e && prog.comments[e.pc] ? `Comment: ${prog.comments[e.pc]}` : ""}</div>
          </Panel>
          <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
            <Panel title="What the verifier knows here">
              {e && e.regs.map((reg, r) => <RegCard key={r} name={`r${r}`} reg={reg} hot={e.changed.includes(r)} maps={maps} />)}
            </Panel>
            <Panel title="Stack">
              <div style={{ ...mono, fontSize: 11.5, minHeight: 18 }}>
                {usedStack.length ? usedStack.slice(0, 8).map(({ s, off }) => (
                  <div key={off} style={{ overflowWrap: "anywhere" }}><span className="muted">fp{off}:</span> {s!.spill ? `saved ${fmtReg(s!.spill, maps)}` : `${countBits(s!.mask)} of 8 bytes have a value`}</div>
                )) : <span className="muted">no bytes have a value</span>}
              </div>
            </Panel>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 12.5, minHeight: 56 }}>
        {e && <>
          <span style={{ color: "var(--muted)" }}>Step {kk + 1} of {log.length}{result && result.logDropped > 0 ? ` (the log keeps the first ${log.length})` : ""}. </span>
          {KIND_LABEL[e.kind] && <b style={{ fontWeight: 600, color: KIND_COLOR[e.kind] }}>{KIND_LABEL[e.kind]}: </b>}
          <span style={{ overflowWrap: "anywhere" }}>{e.note}</span>
          {e.pending > 0 && <span style={{ color: "var(--muted)" }}> Saved paths: {e.pending}.</span>}
        </>}
      </div>
      {prog && (
        <div style={{ marginTop: 6, padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12.5 }}>
          <b style={{ fontWeight: 600 }}>Run it in the interpreter{result?.ok ? "" : " anyway"}.</b>{" "}
          <span style={{ color: run?.status === "exit" ? "var(--fg)" : "var(--c4)", overflowWrap: "anywhere" }}>{runText}</span>
        </div>
      )}
      <Note>The walk limit here is {si(SIM_COMPLEXITY_LIMIT)} instructions. Linux uses 1 million. Most messages follow the text of the Linux verifier, which changes a little between versions.</Note>
    </Demo>
  );
}

const countBits = (m: number) => { let n = 0; for (let x = m; x; x &= x - 1) n++; return n; };

// ---------------------------------------------------------------------------- histogram

const SAMPLE_EVENTS = 400;

export function LatencyHistogramDemo() {
  const p = useParams("bpf-hist", {
    rate: range({ label: "Events per second", min: 100, max: 1e7, default: 1e5, log: true, format: (v) => si(v) }),
    bytes: range({ label: "Bytes per event (model input)", min: 16, max: 256, step: 8, default: EVENT_BYTES_DEFAULT }),
    reads: range({ label: "Map reads per second", min: 0.1, max: 10, default: 1, log: true, format: (v) => `${v}` }),
    tail: range({ label: "Share of slow calls", min: 0, max: 50, step: 1, default: 8, format: (v) => `${v}%` }),
  });
  const v = p.values;
  const lat = useMemo(() => latencySample(SAMPLE_EVENTS, 7, v.tail / 100), [v.tail]);
  const run = useMemo(() => runInKernel(lat), [lat]);
  const user = useMemo(() => aggregateInUser(lat), [lat]);
  const same = run.hist.every((c, i) => c === user[i]);
  const input = { eventsPerSecond: v.rate, eventBytes: v.bytes, readsPerSecond: v.reads };
  const ship = shipBytesPerSecond(input), mapB = mapBytesPerSecond(input);
  const bins = run.hist.map((y, i) => ({ x0: i, x1: i + 1, y })).filter((b) => b.x0 >= 8 && b.x0 < 28);
  const maxY = Math.max(10, ...run.hist);
  const xs = useMemo(() => Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1e5, i / 39)), []);
  return (
    <Demo title="Same histogram, very different bytes" controls={<>
      <Param spec={p.schema.rate} value={v.rate} onChange={(x) => p.set("rate", x as number)} />
      <Param spec={p.schema.bytes} value={v.bytes} onChange={(x) => p.set("bytes", x as number)} />
      <Param spec={p.schema.reads} value={v.reads} onChange={(x) => p.set("reads", x as number)} />
      <Param spec={p.schema.tail} value={v.tail} onChange={(x) => p.set("tail", x as number)} />
    </>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>The map after {SAMPLE_EVENTS} events: the real program ran once for each event.</SmallLabel>
          <Plot x={[8, 28]} y={[0, maxY * 1.05]} height={200} xLabel="latency (log₂ of ns)" yLabel="events" xTicks={[10, 14, 18, 22, 26]} xFormat={(t) => (t < 20 ? `${si(2 ** t * 1e-9, "s", 2)}` : si(2 ** t * 1e-9, "s", 2))}>
            <Bars bins={bins} color="var(--c1)" />
          </Plot>
          <div style={{ fontSize: 12.5, marginTop: 4, color: same ? "var(--c3)" : "var(--c4)" }}>{same ? "All 64 buckets match the histogram from every shipped event." : "The histograms differ."}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>Bytes per second across the kernel boundary.</SmallLabel>
          <Plot x={[100, 1e7]} y={[10, 1e10]} logX logY height={200} xLabel="events per second" yLabel="bytes/s" xTicks={[1e2, 1e4, 1e6]} yTicks={[1e2, 1e4, 1e6, 1e8, 1e10]} xFormat={(t) => si(t)} yFormat={(t) => si(t)}>
            <Line points={xs.map((x) => [x, shipBytesPerSecond({ ...input, eventsPerSecond: x })] as [number, number])} color="var(--c4)" />
            <Line points={xs.map((x) => [x, mapBytesPerSecond({ ...input, eventsPerSecond: x })] as [number, number])} color="var(--c3)" />
            <RuleX at={v.rate} color="var(--fg)" />
          </Plot>
          <Legend items={[{ label: "ship each event", color: "var(--c4)" }, { label: "read the map", color: "var(--c3)" }]} />
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "ship each event", value: si(ship, "B/s") },
          { label: "read the map", value: si(mapB, "B/s") },
          { label: "ratio", value: `${Math.round(bytesRatio(input)).toLocaleString("en-US")}×` },
          { label: "CPU, ship", value: `${(shipCpuShare(v.rate) * 100).toFixed(2)}%` },
          { label: "CPU, map", value: `${(mapCpuShare(v.rate) * 100).toFixed(2)}%` },
          { label: "instructions per event", value: run.insnPerEvent.toFixed(1) },
        ]} />
      </div>
      <Note>One read of the map moves {HIST_BYTES} bytes: 64 buckets of 8 bytes. Model inputs per event: map update {AGG_INPUTS.mapUpdateNs} ns; ring buffer record {AGG_INPUTS.ringEventNs} ns and user-space handling {AGG_INPUTS.userEventNs} ns.</Note>
    </Demo>
  );
}
