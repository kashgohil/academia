/** Lesson: threads. What clone flags share, a Go-style scheduler, and the memory of many tasks. */
import { useMemo, useRef, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, SimButtons, Stats, bytes, range, si, useParams, useSim, Note, Panel, mono, seg, tint } from "../../kit";
import {
  ALWAYS_PRIVATE, CLONE, Gmp, PTHREAD_FLAGS, RESOURCES, SCENARIO_LABEL, SIGCHLD, STACK, asyncMemory, chdir, cloneError, exitGroup, goroutineMemory, newPair, openFd, scenario, sigaction, threadMemory, threadsAtMapLimit, writeX,
  type GmpScenario, type TaskPair,
} from "../../sims/os/processes";
import { Msg, bigBytes } from "./ProcessesUi";

const FLAG_LIST = RESOURCES.map((r) => ({ flag: r.flag, name: r.flagName }));

export function CloneFlagsDemo() {
  const [flags, setFlags] = useState(CLONE.VM | CLONE.FILES);
  const [pair, setPair] = useState<TaskPair>(() => newPair(CLONE.VM | CLONE.FILES));
  const [counter, setCounter] = useState(42);
  const err = cloneError(flags);
  const change = (f: number) => { setFlags(f); setPair(newPair(f)); };
  const toggleFlag = (f: number) => change(flags ^ f);
  const hasMem = (flags & CLONE.VM) !== 0;
  const row = (id: string, name: string, shared: boolean, a: React.ReactNode, b: React.ReactNode, on = "shared", off = "private") => (
    <div key={id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 64px minmax(0, 1fr)", gap: 4, alignItems: "stretch", marginBottom: 3 }}>
      <div style={{ ...mono, fontSize: 12, padding: "3px 6px", borderRadius: 4, border: `1px solid ${shared ? "var(--c1)" : "var(--border)"}`, background: shared ? tint("var(--c1)", 12) : "var(--bg)", minWidth: 0, overflowWrap: "anywhere" }}>{a}</div>
      <div style={{ fontSize: 10.5, textAlign: "center", color: shared ? "var(--c1)" : "var(--muted)", lineHeight: 1.2, alignSelf: "center" }}>{name}<br /><b style={{ fontWeight: 600 }}>{shared ? on : off}</b></div>
      <div style={{ ...mono, fontSize: 12, padding: "3px 6px", borderRadius: 4, border: `1px solid ${shared ? "var(--c1)" : "var(--border)"}`, background: shared ? tint("var(--c1)", 12) : "var(--bg)", minWidth: 0, overflowWrap: "anywhere" }}>{b}</div>
    </div>
  );
  const dead = (i: 0 | 1) => !pair.alive[i];
  const act = (f: (p: TaskPair) => TaskPair) => setPair(f(pair));
  return (
    <Demo
      title="clone: choose what two tasks share"
      actions={<button className="btn ghost" onClick={() => setPair(newPair(flags))}>Reset</button>}
      controls={<>
        {FLAG_LIST.map((x) => (
          <label key={x.flag} className="param" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={(flags & x.flag) !== 0} onChange={() => toggleFlag(x.flag)} />
            <span style={mono}>{x.name}</span>
          </label>
        ))}
      </>}
    >
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>Same flags as:</span>
        <button className="btn" onClick={() => change(0)}>fork</button>
        <button className="btn" onClick={() => change(CLONE.VM)}>CLONE_VM alone</button>
        <button className="btn" onClick={() => change(CLONE.VM | CLONE.FS | CLONE.FILES | CLONE.SIGHAND | CLONE.THREAD)}>pthread_create</button>
      </div>
      {err ? (
        <div style={{ border: "1px solid var(--c4)", borderRadius: 6, padding: "10px 12px", background: tint("var(--c4)", 8) }}>
          <b style={{ color: "var(--c4)", fontWeight: 600 }}>clone returns -1, errno EINVAL. </b>
          <span style={{ fontSize: 13 }}>{err}</span>
        </div>
      ) : (
        <>
          <Msg min={38}>{pair.log}</Msg>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 64px minmax(0, 1fr)", gap: 4, fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
            <div>Task A {dead(0) && <span style={{ color: "var(--c4)" }}>(dead)</span>}</div><div />
            <div>Task B {dead(1) && <span style={{ color: "var(--c4)" }}>(dead)</span>}</div>
          </div>
          {row("mm", "memory", hasMem, `x = ${pair.x[0]}`, `x = ${pair.x[1]}`)}
          {row("files", "fd table", (flags & CLONE.FILES) !== 0, `0 1 2 ${pair.fds[0].join(" ")}`, `0 1 2 ${pair.fds[1].join(" ")}`)}
          {row("fs", "cwd", (flags & CLONE.FS) !== 0, pair.cwd[0], pair.cwd[1])}
          {row("sig", "handlers", (flags & CLONE.SIGHAND) !== 0, `SIGTERM: ${pair.handler[0]}`, `SIGTERM: ${pair.handler[1]}`)}
          {row("pid", "getpid", pair.pid[0] === pair.pid[1], pair.pid[0], pair.pid[1], "same", "differs")}
          {row("tid", "gettid", false, pair.tid[0], pair.tid[1], "same", "differs")}
          <div className="row" style={{ margin: "8px 0" }}>
            <span className="muted" style={{ fontSize: 12.5 }}>A does:</span>
            <button className="btn" disabled={dead(0)} onClick={() => { act((p) => writeX(p, 0, counter)); setCounter((c) => c + 1); }}>x = {counter}</button>
            <button className="btn" disabled={dead(0)} onClick={() => act((p) => openFd(p, 0))}>open</button>
            <button className="btn" disabled={dead(0)} onClick={() => act((p) => chdir(p, 0, "/tmp"))}>chdir</button>
            <button className="btn" disabled={dead(0)} onClick={() => act((p) => sigaction(p, 0, "handler"))}>sigaction</button>
            <button className="btn" disabled={dead(0)} onClick={() => act((p) => exitGroup(p, 0))}>exit_group</button>
          </div>
        </>
      )}
      <Stats items={[
        { label: "flags for clone", value: <span style={mono}>0x{(flags | (flags & CLONE.THREAD ? 0 : SIGCHLD)).toString(16)}</span> },
        { label: "wait needed for B", value: flags & CLONE.THREAD ? "no: join it" : "yes" },
      ]} />
      <Note>Always private: {ALWAYS_PRIVATE.join(", ")}. The real pthread_create flags are 0x{PTHREAD_FLAGS.toString(16)}, which adds CLONE_SYSVSEM, CLONE_SETTLS, CLONE_PARENT_SETTID and CLONE_CHILD_CLEARTID.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- GMP

const G_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c5)"];

function GChip({ id, state }: { id: number; state?: "running" | "syscall" }) {
  const c = G_COLORS[(id - 1) % G_COLORS.length]!;
  return (
    <span style={{ ...mono, display: "inline-block", minWidth: 25, textAlign: "center", fontSize: 11, padding: "1px 3px", borderRadius: 4, marginRight: 2, marginBottom: 2, background: state ? c : tint(c, 20), color: state ? "var(--bg)" : "var(--fg)", outline: state === "syscall" ? "2px dashed var(--c4)" : undefined, outlineOffset: 1 }}>G{id}</span>
  );
}

export function GmpDemo() {
  const p = useParams("gmp", {
    procs: range({ label: "GOMAXPROCS (number of Ps)", min: 1, max: 4, step: 1, default: 2 }),
    sc: seg<GmpScenario>("Program", (Object.keys(SCENARIO_LABEL) as GmpScenario[]).map((k) => [k, SCENARIO_LABEL[k]]), "handoff"),
  });
  const g = useRef<Gmp>(scenario(p.values.sc, p.values.procs));
  const seen = useRef(0);
  const [msgs, setMsgs] = useState<string[]>([]);
  const redo = (sc: GmpScenario, procs: number) => { g.current = scenario(sc, procs); seen.current = 0; setMsgs([]); };
  const sim = useSim({
    dt: 0.7,
    step: () => {
      if (g.current.done) return;
      g.current.step();
      const fresh = g.current.events.slice(seen.current).map((e) => e.text);
      seen.current = g.current.events.length;
      if (fresh.length) setMsgs(fresh.slice(-3));
    },
    reset: () => redo(p.values.sc, p.values.procs),
  });
  const s = g.current;
  const blocked = s.ms.filter((m) => m.state === "syscall" && m.p === null);
  const idleMs = s.ms.filter((m) => m.state === "idle");
  const doneCount = [...s.gs.values()].filter((x) => x.state === "done").length;
  return (
    <Demo
      title="G, M and P"
      actions={<SimButtons sim={sim} />}
      controls={<>
        <Param spec={p.schema.procs} value={p.values.procs} onChange={(v) => { p.set("procs", v as number); redo(p.values.sc, v as number); }} />
        <Param spec={p.schema.sc} value={p.values.sc} onChange={(v) => { p.set("sc", v as GmpScenario); redo(v as GmpScenario, p.values.procs); }} />
      </>}
    >
      <div style={{ fontSize: 13, minHeight: 58, marginBottom: 8 }}>
        {s.done && s.tick > 0 ? <b style={{ fontWeight: 600 }}>All goroutines finished at tick {s.tick}.</b> : msgs.length === 0 ? <span className="muted">Press Step or Play. Each step is one tick of time.</span> : msgs.map((m, i) => <div key={i}>{m}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(135px, 1fr))`, gap: 6 }}>
        {s.ps.map((pp) => {
          const m = pp.m === null ? null : s.ms[pp.m]!;
          return (
            <Panel key={pp.id} title={<span><b style={{ fontWeight: 600, color: "var(--fg)" }}>P{pp.id}</b> {m ? `on M${m.id}` : "idle, no M"}</span>} active={pp.cur !== null}>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>running</div>
              <div style={{ minHeight: 22 }}>{pp.cur !== null ? <GChip id={pp.cur} state={s.gs.get(pp.cur)!.state === "syscall" ? "syscall" : "running"} /> : <span className="muted" style={{ fontSize: 11.5 }}>–</span>}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>runnext</div>
              <div style={{ minHeight: 22 }}>{pp.runnext !== null ? <GChip id={pp.runnext} /> : <span className="muted" style={{ fontSize: 11.5 }}>–</span>}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>local queue</div>
              <div style={{ minHeight: 22 }}>{pp.q.length ? pp.q.map((x) => <GChip key={x} id={x} />) : <span className="muted" style={{ fontSize: 11.5 }}>empty</span>}</div>
            </Panel>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 6, marginTop: 6 }}>
        <Panel title="Global queue"><div style={{ minHeight: 22 }}>{s.globalQ.length ? s.globalQ.map((x) => <GChip key={x} id={x} />) : <span className="muted" style={{ fontSize: 11.5 }}>empty</span>}</div></Panel>
        <Panel title="In the kernel, with no P">
          <div style={{ minHeight: 22, fontSize: 11.5 }}>
            {blocked.length ? blocked.map((m) => <span key={m.id} style={{ marginRight: 6 }}><GChip id={m.g!} state="syscall" />on M{m.id}</span>) : <span className="muted">none</span>}
          </div>
        </Panel>
        <Panel title="Parked Ms"><div style={{ minHeight: 22, fontSize: 11.5, ...mono }}>{idleMs.length ? idleMs.map((m) => `M${m.id}`).join(" ") : <span className="muted">none</span>}</div></Panel>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "tick", value: s.tick },
          { label: "goroutines done", value: `${doneCount} of ${s.gs.size}` },
          { label: "OS threads made", value: s.stats.mCreated },
          { label: "hand-offs", value: s.stats.handoffs },
          { label: "steals", value: s.stats.steals },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- memory

export function TaskMemoryDemo() {
  const p = useParams("task-mem", {
    n: range({ label: "Number of tasks", min: 100, max: 10000000, default: 1000000, log: true, format: (v) => si(Math.round(v)) }),
  });
  const n = Math.round(p.values.n);
  const xs = useMemo(() => Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1e5, i / 39)), []);
  const line = (f: (x: number) => number) => xs.map((x) => [x, f(x)] as [number, number]);
  const th = threadMemory(n), go = goroutineMemory(n), as = asyncMemory(n);
  return (
    <Demo title="Memory for many tasks" controls={<Param spec={p.schema.n} value={p.values.n} onChange={(v) => p.set("n", v as number)} />}>
      <Plot x={[100, 1e7]} y={[1e4, 1e15]} logX logY height={240} xLabel="tasks" yLabel="bytes" xTicks={[100, 1e3, 1e4, 1e5, 1e6, 1e7]} yTicks={[2 ** 20, 2 ** 30, 2 ** 40, 2 ** 50]} xFormat={(t) => si(t)} yFormat={(t) => bigBytes(t)}>
        <Line points={line((x) => threadMemory(x).virtualBytes)} color="var(--c4)" dash="4 3" />
        <Line points={line((x) => threadMemory(x).residentBytes)} color="var(--c4)" />
        <Line points={line((x) => goroutineMemory(x).residentBytes)} color="var(--c1)" />
        <Line points={line((x) => asyncMemory(x).residentBytes)} color="var(--c3)" />
        <RuleX at={n} color="var(--fg)" />
        <RuleX at={threadsAtMapLimit()} color="var(--c2)" label="default map limit" />
      </Plot>
      <Legend items={[{ label: "threads, address space", color: "var(--c4)" }, { label: "threads, resident", color: "var(--c4)" }, { label: "goroutines", color: "var(--c1)" }, { label: "async tasks", color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "threads, address space", value: bigBytes(th.virtualBytes) },
          { label: "threads, resident", value: bigBytes(th.residentBytes) },
          { label: "goroutines", value: bigBytes(go.residentBytes) },
          { label: "async tasks", value: bigBytes(as.residentBytes) },
        ]} />
      </div>
      <Note>Stack sizes are real defaults: {bytes(STACK.glibcDefaultBytes)} of address space, {bytes(STACK.kernelStackBytes)} of kernel stack, a {bytes(STACK.goMinBytes)} first goroutine stack. Pages touched and the sizes of kernel and runtime structures are model inputs. The orange line is max_map_count / 2, about {si(threadsAtMapLimit())} threads.</Note>
    </Demo>
  );
}
