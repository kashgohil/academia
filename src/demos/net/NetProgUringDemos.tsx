/** Demos for "io_uring for networking": a provided buffer ring under a burst, and system calls and CPU per request. */
import { useMemo } from "react";
import { Banner, Chip, Demo, Legend, Line, MiniTable, Note, Param, Plot, RuleY, SmallLabel, StackBar, Stats, bytes, fixed, int, mono, range, toggle, useParams } from "../../kit";
import { ENOBUFS, NET_URING_MODEL, REQ_DESIGNS, REQ_LABEL, bufRingRun, recvBufferMemory, requestCost } from "../../sims/net/programming";

// ============================================================================ 1. A provided buffer ring

const BR = {
  buffers: range({ label: "Buffers in the ring", min: 2, max: 48, step: 1, default: 8 }),
  conns: range({ label: "Connections", min: 2, max: 32, step: 1, default: 16 }),
  msgs: range({ label: "Messages per connection", min: 1, max: 4, step: 1, default: 2 }),
  proc: range({ label: "Program time per CQE (model input)", min: 1, max: 20, step: 1, default: 5, format: (v) => `${v} µs` }),
};

export function NetProgBufRingDemo() {
  const P = useParams("net-prog-bufring", BR);
  const { buffers, conns, msgs, proc } = P.values;
  const r = useMemo(() => bufRingRun({ buffers, conns, msgsPerConn: msgs, procUs: proc }), [buffers, conns, msgs, proc]);
  const tEnd = r.doneAt * 1.04 + 1;
  const steps = r.inUse.flatMap(([t, n], i, all) => (i ? [[t, all[i - 1]![1]] as const, [t, n] as const] : [[t, n] as const]));
  const mem = recvBufferMemory(10_000, 16384, { ringBuffers: 256 });
  return (
    <Demo
      title="Multishot recv with a provided buffer ring"
      controls={<>
        <Param spec={BR.buffers} value={buffers} onChange={(v) => P.set("buffers", v as number)} />
        <Param spec={BR.conns} value={conns} onChange={(v) => P.set("conns", v as number)} />
        <Param spec={BR.msgs} value={msgs} onChange={(v) => P.set("msgs", v as number)} />
        <Param spec={BR.proc} value={proc} onChange={(v) => P.set("proc", v as number)} />
      </>}
    >
      <SmallLabel>Every connection sends its messages (1000 bytes each) at once over a 10 Gbit/s link. One thread handles the CQEs in order and gives each buffer back when it is done.</SmallLabel>
      <Plot x={[0, tEnd]} y={[0, buffers * 1.3]} height={150} xLabel="time (µs)" yLabel="buffers in use">
        <RuleY at={buffers} label={`ring: ${buffers}`} color="var(--c4)" />
        <Line points={steps} color="var(--c1)" />
      </Plot>
      <SmallLabel style={{ marginTop: 6 }}>The completion queue, in order (first 48). A data CQE shows the connection, the bytes and the buffer id; F_MORE means the recv stays armed.</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {r.cqes.slice(0, 48).map((c, i) => (
          <Chip key={i} color={c.res < 0 ? "var(--c4)" : "var(--c3)"} title={`${fixed(c.t)} µs`}>
            {c.res < 0 ? `c${c.conn} -ENOBUFS` : `c${c.conn} ${c.res} b${c.bid}${c.more ? " M" : ""}`}
          </Chip>
        ))}
      </div>
      <Legend items={[{ label: "data, buffer id, F_MORE", color: "var(--c3)" }, { label: `res = -ENOBUFS (−${ENOBUFS}), no F_MORE: re-arm`, color: "var(--c4)" }]} />
      <Banner tone={r.enobufs ? "warn" : "good"}>
        {r.enobufs
          ? `${r.enobufs} receives ended with -ENOBUFS. Their data stayed in the socket, and the program armed a new multishot recv ${r.rearms} times after it returned buffers. Nothing was lost, but each re-arm is an extra SQE and a delay.`
          : `The ring never ran dry: at most ${r.maxInUse} of ${buffers} buffers were in use at once. A ring sized for the burst, not for the number of connections, is enough.`}
      </Banner>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "messages handled", value: int(r.delivered) },
          { label: "most buffers in use", value: `${r.maxInUse} of ${buffers}` },
          { label: "longest wait, arrival to handled", value: `${int(r.maxLatency)} µs` },
          { label: "-ENOBUFS / re-arms", value: `${r.enobufs} / ${r.rearms}` },
        ]} />
      </div>
      <SmallLabel style={{ marginTop: 10 }}>Receive buffers for 10,000 mostly idle connections with 16 KiB buffers</SmallLabel>
      <MiniTable
        head={["design", "buffers held", "memory"]}
        rows={[
          ["epoll: read into one buffer when ready", "1 per thread", bytes(mem.epoll)],
          ["io_uring: one recv with its own buffer", "1 per connection", bytes(mem.perRequest)],
          ["io_uring: provided ring of 256", "256 in total", bytes(mem.ring)],
        ]}
      />
    </Demo>
  );
}

// ============================================================================ 2. System calls and CPU per request

const RC = {
  batch: range({ label: "Requests per loop iteration", min: 1, max: 64, log: true, default: 16, format: (v) => `${Math.round(v)}` }),
  mitigations: toggle({ label: "CPU mitigations on (system call 200 ns, else 60 ns)", default: true }),
};

const PARTS = [
  { key: "syscall", label: "system calls", color: "var(--c4)" },
  { key: "work", label: "recv and send work in the kernel", color: "var(--c1)" },
  { key: "ring", label: "epoll or ring entries", color: "var(--c2)" },
  { key: "file", label: "file references", color: "var(--c5)" },
  { key: "poll", label: "poll arming", color: "var(--c3)" },
] as const;

export function NetProgRequestCostDemo() {
  const P = useParams("net-prog-reqcost", RC);
  const { batch, mitigations } = P.values;
  const b = Math.round(batch);
  const rows = REQ_DESIGNS.map((d) => requestCost(d, b, { mitigations }));
  const max = Math.max(...rows.map((r) => r.ns));
  const ep = rows[0]!, best = rows[3]!;
  return (
    <Demo
      title="One request: a recv and a send"
      controls={<>
        <Param spec={RC.batch} value={batch} onChange={(v) => P.set("batch", v as number)} />
        <Param spec={RC.mitigations} value={mitigations} onChange={(v) => P.set("mitigations", v as boolean)} />
      </>}
    >
      {rows.map((r) => (
        <div key={r.design} style={{ margin: "6px 0 10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: "0 10px", fontSize: 12.5 }}>
            <span>{REQ_LABEL[r.design]}</span>
            <span style={{ ...mono, color: "var(--muted)" }}>{fixed(r.syscalls, r.syscalls < 1 && r.syscalls > 0 ? 3 : 2)} calls · {int(r.ns)} ns · {int(r.perCore / 1000)}k/s per core{r.extraCores ? " + 1 spinning core" : ""}</span>
          </div>
          <StackBar total={max} height={14} parts={PARTS.map((p) => ({ value: r.parts[p.key], color: p.color, label: `${p.label}: ${int(r.parts[p.key])} ns` }))} />
        </div>
      ))}
      <Legend items={PARTS.map((p) => ({ label: p.label, color: p.color }))} />
      <Banner tone="plain">
        {`At ${b} request${b > 1 ? "s" : ""} per iteration, registered files and a multishot recv make ${fixed(ep.syscalls / Math.max(best.syscalls, 1e-9), 0)} times fewer system calls than epoll, but only ${fixed(ep.ns / best.ns)} times less CPU. The recv and send work (${int(2 * NET_URING_MODEL.opWorkNs)} ns) stays.`}
      </Banner>
      <Note>All costs are model inputs. Most come from the io_uring lesson of the OS track: {int(NET_URING_MODEL.opWorkNs)} ns of kernel work per socket operation, {NET_URING_MODEL.ringOpNs} ns per SQE and CQE, {NET_URING_MODEL.fileRefNs} ns per file reference. A recv submitted before data arrives must arm an internal poll first: {NET_URING_MODEL.pollArmNs} ns here.</Note>
    </Demo>
  );
}
