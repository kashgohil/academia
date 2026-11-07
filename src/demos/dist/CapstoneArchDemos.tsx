/** Demos for "Architecture of a replicated store": one request through the layers, and the design explorer. */
import { useMemo } from "react";
import { Demo, Stats, Controls, useParams, toggle, seg, Banner, Note, SmallLabel, mono, tint, useStepper, StepButtons, Chip, MiniTable, fixed } from "../../kit";
import { traceOp, RANGES, META, rangeOf, consequences, DESIGN_INPUTS, type ArchOp, type Grouping, type ReadPath, type Splits } from "../../sims/dist/capstone";

const KEYS: [string, string][] = [["cat", "cat (r1)"], ["mouse", "mouse (r2)"], ["zebra", "zebra (r3)"]];
const NODES = ["n1", "n2", "n3", "n4", "n5"];

const ARCH_SCHEMA = {
  op: seg<ArchOp>("Operation", [["put", "put"], ["get", "get"], ["cas", "cas"], ["txn", "txn (2 ranges)"]], "put"),
  key: seg("Key", KEYS, "cat"),
  reads: seg<"readindex" | "lease" | "log">("Read path", [["readindex", "ReadIndex"], ["lease", "lease"], ["log", "log"]], "readindex"),
  cached: toggle({ label: "Range location cached at the gateway", default: true }),
};

export function ArchitectureDemo() {
  const params = useParams("arch", ARCH_SCHEMA);
  const p = params.values;
  const key2 = p.key === "mouse" ? "zebra" : "mouse";
  const tr = useMemo(() => traceOp({ op: p.op, key: p.key, key2, readMode: p.reads, cached: p.cached, seed: 3 }), [p.op, p.key, key2, p.reads, p.cached]);
  const order = tr.layers;
  const s = useStepper(order.length + 1, 1.4);
  const upTo = s.i; // layers 0..upTo-1 are done
  const shown = order.slice(0, upTo);
  const msgs = shown.reduce((a, l) => a + l.msgs, 0);
  const ms = shown.reduce((a, l) => a + l.ms, 0);
  const touched = new Set([rangeOf(p.key).id, ...(p.op === "txn" ? [rangeOf(key2).id] : [])]);
  return (
    <Demo
      title="One request through the layers"
      actions={<StepButtons s={s} />}
      controls={<Controls params={{ ...params, set: (k, v) => { params.set(k, v); s.reset(); } }} />}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 300px", minWidth: 0, display: "grid", gap: 4 }}>
          {order.map((l, i) => {
            const done = i < upTo, cur = i === upTo - 1;
            const col = !l.active ? "var(--faint)" : cur ? "var(--c1)" : done ? "var(--c3)" : "var(--border)";
            return (
              <div key={l.id} style={{ border: `1.5px solid ${col}`, borderRadius: 6, padding: "5px 8px", background: cur ? tint("var(--c1)", 10) : "var(--bg)", opacity: done || cur ? 1 : 0.55, transition: "all 0.25s" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
                  <b style={{ color: l.active ? "var(--fg)" : "var(--muted)" }}>{l.name}</b>
                  <span style={{ ...mono, fontSize: 12, color: "var(--muted)" }}>{done ? `${l.msgs} msg · ${fixed(l.ms, 1)} ms` : ""}</span>
                </div>
                {done && <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.4 }}>{l.did.map((d, k) => <div key={k}>{d}</div>)}</div>}
              </div>
            );
          })}
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <SmallLabel>Ranges and their replicas (leader first)</SmallLabel>
          <MiniTable head={["range", "keys", ...NODES]} rows={[...RANGES, { id: META.id, lo: "", hi: "", replicas: META.replicas }].map((r) => [
            <Chip key="r" color={touched.has(r.id) ? "var(--c1)" : "var(--muted)"} filled={touched.has(r.id) && upTo >= 4}>{r.id}</Chip>,
            r.id === "meta" ? "locations" : `${r.lo}–${r.hi === "~" ? "z" : r.hi}`,
            ...NODES.map((n) => (r.replicas[0] === n ? "L" : r.replicas.includes(n) ? "•" : "")),
          ])} highlight={(i) => touched.has([...RANGES.map((r) => r.id), "meta"][i]!) || (!p.cached && i === 3 && upTo >= 2)} />
          <Stats items={[
            { label: "messages so far", value: msgs },
            { label: "time so far", value: `${fixed(ms, 1)} ms` },
            { label: "in the background", value: upTo >= order.length && tr.background ? `${tr.background} msg` : "–" },
          ]} />
        </div>
      </div>
      {upTo >= order.length
        ? <Banner ok>Done: <b>{tr.result}</b> after {tr.msgs} messages and {fixed(tr.ms, 1)} ms.{tr.background ? ` Resolving the two intents costs ${tr.background} more messages after the answer.` : ""}</Banner>
        : <Banner tone="plain">{upTo === 0 ? "Press Play or Step to send the request." : `${order[upTo - 1]!.name}: ${order[upTo - 1]!.did[0]}`}</Banner>}
      <Note>Each range is a real three-server Raft group in the sim, so the message counts are measured. The app-to-gateway hop is a model: 10 ms each way, the mean of the 5–15 ms delay model.</Note>
    </Demo>
  );
}

// ============================================================================
// The design explorer
// ============================================================================

const DESIGN_SCHEMA = {
  grouping: seg<Grouping>("Raft groups", [["single", "one group"], ["multi", "one per range"]], "single"),
  reads: seg<ReadPath>("Reads", [["log", "through the log"], ["readindex", "ReadIndex"], ["lease", "leader lease"]], "readindex"),
  splits: seg<Splits>("Ranges", [["fixed", "fixed"], ["auto", "split at a size"]], "auto"),
  replicas: seg<"3" | "5">("Replicas", [["3", "3"], ["5", "5"]], "3"),
};

export function DesignExplorerDemo() {
  const params = useParams("design", DESIGN_SCHEMA);
  const p = params.values;
  const c = useMemo(() => consequences({ grouping: p.grouping, reads: p.reads, splits: p.splits, replicas: Number(p.replicas) as 3 | 5 }), [p.grouping, p.reads, p.splits, p.replicas]);
  const n = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "no limit");
  return (
    <Demo title="Design explorer" controls={<Controls params={params} />}>
      <Stats items={[
        { label: "read latency (sim)", value: `${fixed(c.readMs, 1)} ms` },
        { label: "messages per read", value: fixed(c.msgsPerRead, 0) },
        { label: "write latency (sim)", value: `${fixed(c.writeMs, 1)} ms` },
        { label: "write ceiling", value: `${n(c.writeCeiling)}/s` },
        { label: "largest store", value: `${n(c.maxGiB)} GiB` },
        { label: "keys stalled by one crash", value: `${Math.round(c.blast * 100)}%` },
      ]} />
      <MiniTable head={["", "value"]} rows={[
        ["Raft groups", n(c.ranges)],
        ["heartbeats per second, one per group", n(c.heartbeats)],
        ["heartbeats per second, one per pair of nodes", n(c.heartbeatsCoalesced)],
        ["needs a bound on clock drift", c.needsClockBound ? "yes" : "no"],
        ["needs transactions across groups", c.needsCrossRangeTxn ? "yes" : "no"],
      ]} />
      <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>{c.notes.map((t, i) => <div key={i}>• {t}</div>)}</div>
      <Banner tone={c.matches.length ? "info" : "plain"} label="Real systems">{c.matches.length ? c.matches.join("; ") : "None of the three systems in this module uses this exact combination."}</Banner>
      <Note>Latencies come from the store sim with 5–15 ms one-way delays and a client one hop from the leader. The model inputs: {DESIGN_INPUTS.nodes} nodes, {DESIGN_INPUTS.nodeOpsPerSec.toLocaleString("en-US")} units of replica work per node per second, {DESIGN_INPUTS.diskGiB.toLocaleString("en-US")} GiB of disk per node, {DESIGN_INPUTS.dataGiB.toLocaleString("en-US")} GiB of data.</Note>
    </Demo>
  );
}
