/** Demos for "async/await desugared": step the state machine, see why Pin exists, and the memory of waiting tasks. */
import { useMemo, useState } from "react";
import {
  Banner, Btn, Demo, Legend, si, Line, MONO, MiniTable, Param, Plot, RuleX, SmallLabel, Stats, StepCaption, bytes, int, range, tint, toggle, useParams,
  IndexButtons, IndexSlider,
} from "../../kit";
import { HANDLER_CODE, HANDLER_CODE_VEC, handlerStates, pinTrace, pollTrace, stateLayout, taskMemory } from "../../sims/conc/async";

// ---------------------------------------------------------------- the state machine

const SM = {
  heap: toggle({ label: "Put buf on the heap (vec!)", default: false }),
  r0: toggle({ label: "Read data already there", default: false }),
  r1: toggle({ label: "Row already cached", default: false }),
};

export function ConcAsyncStateMachineDemo() {
  const P = useParams("conc-async-sm", SM);
  const { heap, r0, r1 } = P.values;
  const steps = useMemo(() => pollTrace([r0, r1, false]), [r0, r1]);
  const layout = useMemo(() => stateLayout(handlerStates(heap)), [heap]);
  const states = handlerStates(heap);
  const [k0, setK] = useState(0);
  const n = steps.length + 1;
  const k = Math.min(k0, n - 1);
  const step = k > 0 ? steps[k - 1]! : null;
  const cur = step ? step.to : "Unresumed";
  const curState = states.find((v) => v.name === cur)!;
  const code = heap ? HANDLER_CODE_VEC : HANDLER_CODE;
  const ran = new Set(step?.lines ?? []);
  const maxV = Math.max(...layout.variants.map((v) => v.bytes));
  return (
    <Demo
      title="Step the state machine of an async fn"
      controls={<>
        <IndexSlider k={k} n={n} set={setK} label="Poll" />
        <Param spec={SM.heap} value={heap} onChange={(v) => P.set("heap", v as boolean)} />
        <Param spec={SM.r0} value={r0} onChange={(v) => { P.set("r0", v as boolean); setK(0); }} />
        <Param spec={SM.r1} value={r1} onChange={(v) => { P.set("r1", v as boolean); setK(0); }} />
      </>}
      actions={<IndexButtons k={k} n={n} set={setK} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>Source. Lines that ran in this poll are marked; the arrow is where the future waits.</SmallLabel>
          <pre style={{ fontFamily: MONO, fontSize: 11.5, lineHeight: 1.55, margin: 0, padding: 6, background: "var(--subtle)", border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto" }}>
            {code.map((l, i) => (
              <div key={i} style={{ background: ran.has(i) ? tint("var(--c1)", 28) : undefined, whiteSpace: "pre" }}>
                <span style={{ color: "var(--c4)", display: "inline-block", width: 14 }}>{curState.line === i && cur.startsWith("Suspend") ? "▶" : ""}</span>{l}
              </div>
            ))}
          </pre>
        </div>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>The generated enum. Each variant stores what is live across its await.</SmallLabel>
          <MiniTable
            head={["variant", "fields", "bytes"]}
            rows={layout.variants.map((v) => [
              <span style={{ fontFamily: MONO }}>{v.name}</span>,
              <span style={{ fontFamily: MONO, fontSize: 11.5 }}>{v.fields.map((f) => f.name).join(", ") || "–"}</span>,
              <span style={{ fontWeight: v.bytes === maxV ? 700 : 400 }}>{int(v.bytes)}</span>,
            ])}
            highlight={layout.variants.findIndex((v) => v.name === cur)}
          />
          <div style={{ marginTop: 8 }}>
            <Stats items={[{ label: "size_of the future (model)", value: `${int(layout.bytes)} B` }, { label: "polls to finish", value: steps.length }]} />
          </div>
        </div>
      </div>
      <StepCaption tone={step?.result === "Ready" ? "good" : step ? "info" : "plain"} label={step ? step.result : "created"}>
        {step ? step.text : "handle(&mut sock, &db) only builds the value Unresumed. No line of the body has run."} {curState.note}
      </StepCaption>
    </Demo>
  );
}

// ---------------------------------------------------------------- why Pin

export function ConcAsyncPinDemo() {
  const [acts, setActs] = useState<("poll" | "move")[]>([]);
  const [pinned, setPinned] = useState(false);
  const frames = useMemo(() => pinTrace(acts, pinned), [acts, pinned]);
  const f = frames[frames.length - 1]!;
  const dangling = f.ptr !== null && f.ptr !== f.bufAt;
  const hex = (v: number) => `0x${v.toString(16)}`;
  const rows: [string, string, string][] = [
    [hex(f.base), "tag, sock, db", "16 B"],
    [hex(f.bufAt), "buf: [u8; 1024]", "1024 B"],
    [hex(f.bufAt + 1024), "read_fut.buf", f.ptr === null ? "not set" : `→ ${hex(f.ptr)}`],
  ];
  return (
    <Demo
      title="Why a polled future must not move"
      actions={<><Btn onClick={() => setActs((a) => [...a, "poll"])}>poll</Btn><Btn onClick={() => setActs((a) => [...a, "move"])}>move it</Btn><Btn ghost onClick={() => setActs([])}>Reset</Btn></>}
      controls={<Param spec={toggle({ label: "Pin it first (Box::pin)", default: false })} value={pinned} onChange={(v) => { setPinned(v as boolean); setActs([]); }} />}
    >
      <MiniTable head={["address", "field", "value"]} rows={rows.map((r, i) => [<span style={{ fontFamily: MONO }}>{r[0]}</span>, <span style={{ fontFamily: MONO }}>{r[1]}</span>, <span style={{ fontFamily: MONO, color: i === 2 && dangling ? "var(--c4)" : undefined, fontWeight: i === 2 && dangling ? 700 : 400 }}>{r[2]}</span>])} />
      <SmallLabel style={{ marginTop: 8 }}>Actions: {["create", ...acts].join(" → ")}</SmallLabel>
      <Banner tone={!f.ok ? "bad" : dangling ? "warn" : "good"}>{f.text}</Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- memory of waiting tasks

const MEM = {
  tasks: range({ label: "Waiting tasks", min: 2, max: 6, step: 0.25, default: 5, format: (v) => int(10 ** v) }),
  state: range({ label: "Future size", min: 6, max: 14, step: 0.5, default: 8, format: (v) => bytes(Math.round(2 ** v)) }),
  stack: range({ label: "Deepest stack of the code", min: 10, max: 16, step: 0.5, default: 12, format: (v) => bytes(Math.round(2 ** v)) }),
};

export function ConcAsyncMemoryDemo() {
  const P = useParams("conc-async-mem", MEM);
  const N = Math.round(10 ** P.values.tasks);
  const state = Math.round(2 ** P.values.state), stack = Math.round(2 ** P.values.stack);
  const m = taskMemory(state, stack);
  const xs = [100, 1e3, 1e4, 1e5, 1e6];
  const line = (b: number) => xs.map((x) => [x, x * b] as [number, number]);
  return (
    <Demo title="Memory of waiting tasks" controls={<><Param spec={MEM.tasks} value={P.values.tasks} onChange={(v) => P.set("tasks", v as number)} /><Param spec={MEM.state} value={P.values.state} onChange={(v) => P.set("state", v as number)} /><Param spec={MEM.stack} value={P.values.stack} onChange={(v) => P.set("stack", v as number)} /></>}>
      <Plot x={[100, 1e6]} y={[1e4, 1e12]} logX logY height={220} xLabel="waiting tasks" yLabel="resident memory (bytes, log)" xTicks={xs} yTicks={[1e4, 1e6, 1e8, 1e10, 1e12]} xFormat={(v) => int(v)} yFormat={(v) => si(v, "B", 2)}>
        <Line points={line(m.thread)} color="var(--c4)" />
        <Line points={line(m.goroutine)} color="var(--c2)" />
        <Line points={line(m.future)} color="var(--c3)" />
        <RuleX at={N} label={int(N)} />
      </Plot>
      <Legend items={[{ label: "OS threads", color: "var(--c4)" }, { label: "goroutines (stackful)", color: "var(--c2)" }, { label: "Rust tasks (stackless)", color: "var(--c3)" }]} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={["model", "per task", `${int(N)} tasks`]}
          rows={[
            ["Rust task", bytes(m.future), bytes(N * m.future)],
            ["goroutine", bytes(m.goroutine), bytes(N * m.goroutine)],
            ["thread, resident", bytes(m.thread), bytes(N * m.thread)],
            ["thread, reserved", bytes(m.threadVirtual), bytes(N * m.threadVirtual)],
          ]}
        />
      </div>
      <SmallLabel style={{ marginTop: 6 }}>Model inputs: a 64 B task header, a 400 B g struct, 4 KiB pages, a 16 KiB kernel stack and about 10 KiB of kernel structures per thread.</SmallLabel>
    </Demo>
  );
}
