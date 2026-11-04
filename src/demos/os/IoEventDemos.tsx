/** Demos for "blocking, non-blocking and async I/O": server cost as N grows, level and edge triggering, and starvation. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes as fmtBytes, range, si, useParams } from "../../kit";
import {
  EVENT_FACTS, EpollSocket, STARVE_MODEL, drainNeverEndsMBps, maxConnections, runReader, serverCost, starvationRun, threadsLimit,
  type ServerModel, type TriggerMode,
} from "../../sims/os/io";
import { Banner, MiniTable } from "./SyncShared";
import { Cap, Panel, mono, seg } from "./ProcessesUi";

// ---------------------------------------------------------------- server cost

const MODELS: ServerModel[] = ["threads", "select", "epoll"];
const COLOR: Record<ServerModel, string> = { threads: "var(--c4)", select: "var(--c2)", poll: "var(--c2)", epoll: "var(--c3)" };
const LABEL: Record<ServerModel, string> = { threads: "Thread per connection", select: "select, then poll past 1,024", poll: "poll", epoll: "epoll" };

const SRV = {
  n: range({ label: "Connections", min: 10, max: 1_000_000, log: true, default: 10000, format: (v) => Math.round(v).toLocaleString("en-US") }),
  r: range({ label: "Events per connection per second", min: 0.1, max: 100, log: true, default: 10, format: (v) => `${v}` }),
};

export function IoServerCostDemo() {
  const p = useParams("io-srv", SRV);
  const n = Math.round(p.values.n), r = p.values.r;
  const xs = useMemo(() => Array.from({ length: 81 }, (_, i) => Math.round(10 ** (1 + (i / 80) * 5))), []);
  const costs = useMemo(() => MODELS.map((m) => xs.map((x) => {
    const mm: ServerModel = m === "select" && x > EVENT_FACTS.fdSetSize ? "poll" : m;
    return serverCost(mm, x, r);
  })), [xs, r]);
  const series = (i: number, y: (c: ReturnType<typeof serverCost>) => number) => xs.map((x, k) => [x, y(costs[i]![k]!)] as [number, number]);
  const now = MODELS.map((m) => serverCost(m === "select" && n > EVENT_FACTS.fdSetSize ? "poll" : m, n, r));
  const limit = threadsLimit();
  return (
    <Demo
      title="One server, N connections"
      controls={
        <>
          <Param spec={SRV.n} value={p.values.n} onChange={(v) => p.set("n", v as number)} />
          <Param spec={SRV.r} value={r} onChange={(v) => p.set("r", v as number)} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        <div>
          <Cap>Memory that grows with N</Cap>
          <Plot x={[10, 1e6]} y={[2 ** 13, 2 ** 37]} logX logY height={190} xTicks={[10, 1e3, 1e5]} yTicks={[2 ** 14, 2 ** 20, 2 ** 26, 2 ** 32]} xFormat={(v) => si(v)} yFormat={(v) => fmtBytes(v)} xLabel="connections">
            {MODELS.map((m, i) => <Line key={m} points={series(i, (c) => Math.max(2 ** 13, c.memBytes))} color={COLOR[m]} />)}
            <RuleX at={n} />
            <RuleX at={limit} color="var(--c4)" />
          </Plot>
        </div>
        <div>
          <Cap>CPU cores in use. An event loop has one core.</Cap>
          <Plot x={[10, 1e6]} y={[1e-4, 100]} logX logY height={190} xTicks={[10, 1e3, 1e5]} yTicks={[1e-3, 1e-1, 1, 10]} xFormat={(v) => si(v)} yFormat={(v) => (v >= 1 ? String(v) : v.toString())} xLabel="connections">
            {MODELS.map((m, i) => <Line key={m} points={series(i, (c) => Math.max(1e-4, c.cores))} color={COLOR[m]} />)}
            <RuleX at={n} />
          </Plot>
        </div>
      </div>
      <Legend items={MODELS.map((m) => ({ label: LABEL[m], color: COLOR[m] }))} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={[`${n.toLocaleString("en-US")} connections`, "memory", "cores", "ns per event", "events per wait"]}
          rows={MODELS.map((m, i) => {
            const c = now[i]!;
            const name = m === "select" && n > EVENT_FACTS.fdSetSize ? "poll" : m === "threads" ? "Threads" : m;
            return [
              name, fmtBytes(c.memBytes), c.cores.toFixed(3), c.nsPerEvent.toFixed(0),
              m === "threads" ? "1" : Number.isFinite(c.batch) ? c.batch.toFixed(1) : "-",
            ];
          })}
        />
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", minHeight: 18 }}>
        {MODELS.map((m, i) => {
          const c = now[i]!;
          const name = m === "select" && n > EVENT_FACTS.fdSetSize ? "poll" : m === "threads" ? "Threads" : m;
          if (!c.feasible) return `${name}: over ${c.limit}. `;
          if (c.saturated) return `${name}: out of CPU on one core. `;
          if (c.batch > 1) return `${name}: the loop never sleeps. `;
          return "";
        }).join("") || "All designs keep up."}
      </p>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "epoll on one core: connections at this rate", value: maxConnections("epoll", r).toLocaleString("en-US") },
          { label: "thread limit at default vm.max_map_count", value: limit.toLocaleString("en-US") },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- level and edge

const TR = {
  mode: seg<TriggerMode>("Trigger", [["level", "Level (default)"], ["edge", "Edge (EPOLLET)"]], "edge"),
};
type TrAction = "send" | "wait" | "read" | "drain";
const SEND = 4096, CHUNK = 1024;

function replayTr(mode: TriggerMode, actions: TrAction[]) {
  const s = new EpollSocket(mode);
  const log: { text: string; bad?: boolean; good?: boolean }[] = [];
  for (const a of actions) {
    if (a === "send") { s.arrive(SEND); log.push({ text: `Peer sends ${SEND} bytes. The socket goes on the ready list.` }); }
    else if (a === "wait") {
      const w = s.wait();
      if (w.event) log.push({ text: `epoll_wait returns EPOLLIN. ${s.onReadyList ? "The socket stays on the ready list." : "The socket leaves the ready list."}`, good: true });
      else if (s.buffered > 0) log.push({ text: `epoll_wait sleeps, but ${s.buffered} bytes wait in the socket.`, bad: true });
      else log.push({ text: "epoll_wait sleeps. The buffer is empty, so this is correct." });
    } else if (a === "read") {
      const n = s.read(CHUNK);
      log.push({ text: n < 0 ? "read returns -1 with EAGAIN." : `read returns ${n} bytes. ${s.buffered} remain.` });
    } else {
      let k = 0, n: number;
      while ((n = s.read(CHUNK)) >= 0) k += n;
      log.push({ text: `Read until EAGAIN: ${k} bytes. The buffer is empty.`, good: true });
    }
  }
  return { s, log };
}

export function IoTriggerDemo() {
  const p = useParams("io-tr", TR);
  const mode = p.values.mode;
  const [actions, setActions] = useState<TrAction[]>([]);
  const { s, log } = useMemo(() => replayTr(mode, actions), [mode, actions]);
  const add = (a: TrAction) => setActions((x) => [...x, a]);
  const stalled = s.stalled;
  const total = Math.max(SEND, s.buffered);
  return (
    <Demo
      title="One socket, one epoll instance"
      actions={<button className="btn ghost" onClick={() => setActions([])}>Reset</button>}
      controls={<Param spec={TR.mode} value={mode} onChange={(v) => { p.set("mode", v as never); setActions([]); }} />}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <Panel title={`Socket buffer: ${s.buffered} bytes`} style={{ flex: "2 1 200px" }}>
          <div style={{ height: 22, border: "1px solid var(--border)", borderRadius: 3, background: "var(--subtle)", overflow: "hidden" }}>
            <div style={{ width: `${(s.buffered / total) * 100}%`, height: "100%", background: stalled ? "var(--c4)" : "var(--c1)", transition: "width .2s" }} />
          </div>
        </Panel>
        <Panel title="Ready list" style={{ flex: "1 1 90px" }}><div style={{ ...mono, fontSize: 14, color: s.onReadyList ? "var(--c3)" : "var(--muted)" }}>{s.onReadyList ? "socket" : "empty"}</div></Panel>
        <Panel title="The program read" style={{ flex: "1 1 90px" }}><div style={{ ...mono, fontSize: 14 }}>{s.consumed} bytes</div></Panel>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <button className="btn" onClick={() => add("send")}>Peer sends {SEND}</button>
        <button className="btn" onClick={() => add("wait")}>epoll_wait</button>
        <button className="btn" onClick={() => add("read")}>read {CHUNK}</button>
        <button className="btn" onClick={() => add("drain")}>Read until EAGAIN</button>
      </div>
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.5, minHeight: 92, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--subtle)" }}>
        {log.length === 0 && <span className="muted">Nothing yet. Start with the peer.</span>}
        {log.slice(-5).map((e, i) => <div key={i} style={{ color: e.bad ? "var(--c4)" : "var(--fg)" }}>{e.text}</div>)}
      </div>
      {stalled && (
        <Banner tone="bad">Stall. Data waits, and no new event will come unless the peer sends again. If the peer waits for your reply, this connection hangs.</Banner>
      )}
      <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", fontSize: 12.5, alignItems: "center" }}>
        <span className="muted">Scripts:</span>
        <button className="btn" onClick={() => setActions(["send", "wait", "read", "wait"])}>Read part, wait again</button>
        <button className="btn" onClick={() => setActions(["send", "wait", "drain", "wait"])}>Drain, wait again</button>
      </div>
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "bytes after a partial reader", value: `${runReader([SEND], { mode, chunk: CHUNK, drain: false }).left} left` },
          { label: "bytes after a draining reader", value: `${runReader([SEND], { mode, chunk: CHUNK, drain: true }).left} left` },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- starvation

const STV = {
  fast: range({ label: "Fast peer", min: 100, max: 3000, step: 20, default: 1000, format: (v) => `${v} MB/s` }),
};

export function IoStarvationDemo() {
  const p = useParams("io-stv", STV);
  const fast = p.values.fast;
  const limit = drainNeverEndsMBps();
  const pts = useMemo(() => {
    const d: [number, number][] = [], b: [number, number][] = [];
    for (let f = 100; f <= 3000; f += 20) {
      const dr = starvationRun({ policy: "drain", fastMBps: f });
      d.push([f, dr.slowWaitUs ?? NaN]);
      b.push([f, starvationRun({ policy: "budget", fastMBps: f }).slowWaitUs!]);
    }
    return { d, b };
  }, []);
  const drain = starvationRun({ policy: "drain", fastMBps: fast });
  const budget = starvationRun({ policy: "budget", fastMBps: fast });
  return (
    <Demo title="Two sockets, one thread: when is the slow socket served?" controls={<Param spec={STV.fast} value={fast} onChange={(v) => p.set("fast", v as number)} />}>
      <Plot x={[100, 3000]} y={[0, 200]} height={180} xLabel="fast peer, MB/s" yLabel="wait of the slow socket, µs">
        <Line points={pts.d} color="var(--c4)" />
        <Line points={pts.b} color="var(--c3)" />
        <RuleX at={fast} />
        <RuleX at={limit} color="var(--c4)" label="no end" />
      </Plot>
      <Legend items={[{ label: "Read until EAGAIN", color: "var(--c4)" }, { label: `At most ${STARVE_MODEL.budget} reads, then next socket`, color: "var(--c3)" }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "drain: slow socket waits", value: drain.slowServed ? `${drain.slowWaitUs!.toFixed(0)} µs` : `over ${STARVE_MODEL.spanUs / 1000} ms: never` },
          { label: "budget: slow socket waits", value: `${budget.slowWaitUs!.toFixed(0)} µs` },
        ]} />
      </div>
    </Demo>
  );
}
