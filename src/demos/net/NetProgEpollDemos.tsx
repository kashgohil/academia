/** Demos for "select, poll and epoll": who wakes up for a new connection, and an edge-triggered accept loop. */
import { useMemo } from "react";
import { Banner, Demo, Legend, MiniTable, Note, Param, SmallLabel, Stats, fixed, int, pct, range, seg, toggle, useParams } from "../../kit";
import { CallLog, Timeline, type TimelineRow } from "./NetProgUi";
import { HERD_MODEL, WAKE_LABEL, etAcceptRun, herdRun, type Trigger, type WakeMode } from "../../sims/net/programming";

// ============================================================================ 1. Who wakes up

const HD = {
  workers: range({ label: "Worker threads", min: 2, max: 16, step: 1, default: 8 }),
  mode: seg<WakeMode>("How the workers wait", [["accept", "Blocking accept()"], ["epoll", "epoll"], ["exclusive", "EPOLLEXCLUSIVE"], ["reuseport", "SO_REUSEPORT"]], "epoll"),
  rate: range({ label: "New connections per second", min: 100, max: 30000, log: true, default: 2000 }),
  service: range({ label: "Mean work per connection (model input)", min: 0.2, max: 4, step: 0.1, default: 1, format: (v) => `${v.toFixed(1)} ms` }),
};

const MODES: WakeMode[] = ["accept", "epoll", "exclusive", "reuseport"];
const N = 10_000;

const HD_TEXT: Record<WakeMode, string> = {
  accept: "All workers sleep in accept() on one socket. The wait is exclusive and first in, first out, so one worker wakes per connection and the work rotates.",
  epoll: "Each worker has its own epoll set that holds the same listening socket. A connection wakes every idle worker. One accept() succeeds; the others get EAGAIN and sleep again.",
  exclusive: "EPOLLEXCLUSIVE wakes one idle worker instead of all. The wakeups go, but the choice is last in, first out: the worker that went idle last gets the connection.",
  reuseport: "Each worker has its own listening socket and accept queue. The kernel hashes the 4-tuple to pick the queue, and it does not know which worker is busy.",
};

export function NetProgHerdDemo() {
  const P = useParams("net-prog-herd", HD);
  const { workers, mode, rate, service } = P.values;
  const m = mode as WakeMode;
  const all = useMemo(() => Object.fromEntries(MODES.map((k) => [k, herdRun({ mode: k, workers, rate, serviceMs: service, n: N })])) as Record<WakeMode, ReturnType<typeof herdRun>>, [workers, rate, service]);
  const r = all[m];
  const maxShare = Math.max(...r.share);
  return (
    <Demo
      title="One connection arrives: who wakes up?"
      controls={<>
        <Param spec={HD.workers} value={workers} onChange={(v) => P.set("workers", v as number)} />
        <Param spec={HD.mode} value={mode} onChange={(v) => P.set("mode", v as WakeMode)} />
        <Param spec={HD.rate} value={rate} onChange={(v) => P.set("rate", v as number)} />
        <Param spec={HD.service} value={service} onChange={(v) => P.set("service", v as number)} />
      </>}
    >
      <SmallLabel>Share of the {int(N)} connections that each worker served (offered load {pct(r.load, 0)} per worker)</SmallLabel>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 110, borderBottom: "1px solid var(--border)", padding: "0 2px" }}>
        {r.share.map((s, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%", minWidth: 0 }}>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>{Math.round(s * 100)}</div>
            <div style={{ width: "100%", height: `${(s / Math.max(maxShare, 1 / workers)) * 80}%`, background: "var(--c1)", borderRadius: "2px 2px 0 0", transition: "height 0.25s" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 3, padding: "2px 2px 0", fontSize: 10, color: "var(--muted)" }}>
        {r.share.map((_, i) => <div key={i} style={{ flex: 1, textAlign: "center" }}>w{i}</div>)}
      </div>
      <Banner tone={r.eagain > 0.5 || r.waitedWhileIdle > 0.05 ? "warn" : "plain"}>{HD_TEXT[m]}</Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "threads woken per connection", value: fixed(r.wakeups) },
          { label: "accept() calls that got EAGAIN", value: fixed(r.eagain) },
          { label: "CPU wasted per connection", value: `${int(r.wastedNs)} ns` },
          { label: "p99 wait in the accept queue", value: `${fixed(r.waitP99)} ms` },
        ]} />
      </div>
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["design", "woken", "EAGAIN", "busiest worker", "waited, a worker idle", "p99 wait"]}
          rows={MODES.map((k) => {
            const x = all[k];
            return [WAKE_LABEL[k], fixed(x.wakeups), fixed(x.eagain), pct(Math.max(...x.share), 0), pct(x.waitedWhileIdle, 1), `${fixed(x.waitP99)} ms`];
          })}
          highlight={MODES.indexOf(m)}
        />
      </div>
      <Note>Arrivals are random (Poisson) and work times are exponential, from a fixed seed. A wasted wakeup costs a thread switch ({int(HERD_MODEL.wakeNs)} ns) and two system calls ({int(HERD_MODEL.syscallNs)} ns each): model inputs from the OS track.</Note>
    </Demo>
  );
}

// ============================================================================ 2. An edge-triggered accept loop

const ET = {
  burst: range({ label: "Clients that connect at once", min: 1, max: 8, step: 1, default: 4 }),
  trigger: seg<Trigger>("Trigger", [["level", "Level"], ["edge", "Edge (EPOLLET)"]], "edge"),
  drain: seg<"once" | "drain">("Loop", [["once", "accept() once per event"], ["drain", "accept() until EAGAIN"]], "once"),
  late: toggle({ label: "One more client connects at 300 ms", default: true }),
};

export function NetProgEtAcceptDemo() {
  const P = useParams("net-prog-et", ET);
  const { burst, trigger, drain, late } = P.values;
  const r = useMemo(() => etAcceptRun({ burst, trigger: trigger as Trigger, drain: drain === "drain", lateAt: late ? 300 : 0 }), [burst, trigger, drain, late]);
  const tEnd = r.tEnd;
  const rows: TimelineRow[] = [
    { label: "loop", spans: r.busy.map(([a, b]) => ({ t0: a, t1: Math.max(b, a + 0.8), color: "var(--c1)", title: "the loop works" })) },
    ...r.conns.map((c) => ({
      label: c.late ? `c${c.id}*` : `c${c.id}`,
      spans: [{ t0: c.queued, t1: c.accepted ?? tEnd, color: c.accepted === undefined ? "var(--c4)" : c.accepted - c.queued > 20 ? "var(--c5)" : "var(--c3)", title: c.accepted === undefined ? "never accepted" : `waited ${(c.accepted - c.queued).toFixed(1)} ms` }],
      marks: c.accepted !== undefined ? [{ t: c.accepted, color: "var(--fg)" }] : [],
    })),
  ];
  const slow = r.conns.filter((c) => c.accepted !== undefined && c.accepted - c.queued > 20).length;
  return (
    <Demo
      title="A listening socket in an event loop"
      controls={<>
        <Param spec={ET.burst} value={burst} onChange={(v) => P.set("burst", v as number)} />
        <Param spec={ET.trigger} value={trigger} onChange={(v) => P.set("trigger", v as Trigger)} />
        <Param spec={ET.drain} value={drain} onChange={(v) => P.set("drain", v as "once" | "drain")} />
        <Param spec={ET.late} value={late} onChange={(v) => P.set("late", v as boolean)} />
      </>}
    >
      <SmallLabel>Each connection row: from the end of its handshake (it joins the accept queue) until accept() returns it. The loop takes 2 ms per accepted connection (a model input).</SmallLabel>
      <Timeline rows={rows} tEnd={tEnd} rowH={15} labelW={40} />
      <Legend items={[{ label: "accepted at once", color: "var(--c3)" }, { label: "accepted late", color: "var(--c5)" }, { label: "still in the queue at the end", color: "var(--c4)" }, { label: "loop busy", color: "var(--c1)" }]} />
      <Banner tone={r.stuck ? "bad" : slow ? "warn" : "good"}>
        {r.stuck
          ? `${r.stuck} connection${r.stuck > 1 ? "s" : ""} never leave the accept queue. They arrived while the item was already on the ready list, so they made no new edge. Each later connection makes one edge and releases only one.`
          : slow
            ? `${slow} connection${slow > 1 ? "s" : ""} waited for a later edge.`
            : `Every connection is accepted within a few ms. ${trigger === "level" ? "Level mode reports the socket again while the queue is not empty." : "Draining to EAGAIN leaves nothing behind, so no edge is needed."} epoll_wait returned ${r.wakeups} times; ${r.eagains} accept() call${r.eagains === 1 ? "" : "s"} got EAGAIN.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <CallLog rows={r.log.map((e) => ({ t: e.t, who: e.call.startsWith("(kernel)") ? "kernel" : "loop", call: e.call.replace("(kernel) ", ""), result: e.result, tone: e.tone }))} maxHeight={200} />
      </div>
    </Demo>
  );
}
