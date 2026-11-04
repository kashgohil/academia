/** Demos for "journaling": a crash explorer and a cost comparison of the three modes. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, bytes, range, select, useParams } from "../../kit";
import {
  COMMIT_LABEL, COST_DEVICES, COST_INPUTS, COST_MODES, MODE_LABEL, OUTCOME_LABEL, OUTCOME_ORDER, WORKLOAD_LABEL, atomic, classify, dataOk, diskOrder, exploreCrashes, journalCost, metadataOk, orderMask, recover, writePlan,
  type BlockValue, type CommitPolicy, type CostDevice, type JWorkload, type JournalMode, type Outcome,
} from "../../sims/os/fs/journal";
import { Banner, HBar, Heading, MONO, MiniTable, Note } from "./FsUi";

const MODES: JournalMode[] = ["none", "writeback", "ordered", "data"];

const J = {
  crash: range({ label: "Crash after this many writes reach the disk", min: 0, max: 14, step: 1, default: 3 }),
  mode: select({ label: "Mode", segmented: true, options: MODES.map((m) => ({ value: m, label: MODE_LABEL[m] })), default: "ordered" }),
  workload: select({ label: "Operation", segmented: true, options: (["append", "overwrite"] as JWorkload[]).map((w) => ({ value: w, label: WORKLOAD_LABEL[w] })), default: "append" }),
  commit: select({ label: "Before the commit block", segmented: true, options: (["barrier", "nobarrier", "checksum"] as CommitPolicy[]).map((c) => ({ value: c, label: COMMIT_LABEL[c] })), default: "barrier" }),
};

const OUT_COLOR: Record<Outcome, string> = { old: "var(--c1)", new: "var(--c3)", torn: "var(--c2)", garbage: "var(--c2)", leak: "var(--c4)", dangling: "var(--c4)", corrupt: "var(--c4)" };

const valColor = (v: BlockValue) => (v === "new" ? "var(--c3)" : v === "junk" ? "var(--c4)" : "var(--faint)");

function Block({ name, on, color, sub }: { name: string; on: boolean; color?: string; sub?: string }) {
  return (
    <div style={{ minWidth: 40, textAlign: "center" }}>
      <div style={{ fontFamily: MONO, fontSize: 12, padding: "3px 5px", borderRadius: 4, border: `1.5px solid ${on ? (color ?? "var(--c3)") : "var(--border)"}`, background: on ? (color ?? "var(--c3)") : "transparent", color: on ? "var(--bg)" : "var(--muted)", fontWeight: on ? 600 : 400 }}>{name}</div>
      {sub && <div className="muted" style={{ fontSize: 10, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

export function FsCrashExplorerDemo() {
  const P = useParams("os-fs-crash", J);
  const mode = P.values.mode as JournalMode;
  const workload = P.values.workload as JWorkload;
  const commit = (mode === "none" ? "barrier" : P.values.commit) as CommitPolicy;
  const plan = useMemo(() => writePlan(mode, workload, commit), [mode, workload, commit]);
  const [seed, setSeed] = useState(1);
  const [picked, setPicked] = useState<number | null>(null);
  const order = useMemo(() => diskOrder(plan, seed), [plan, seed]);
  const k = Math.min(plan.writes.length, P.values.crash);
  const mask = picked ?? orderMask(order, k);
  const cases = useMemo(() => exploreCrashes(plan), [plan]);
  const counts = OUTCOME_ORDER.map((o) => ({ o, n: cases.filter((c) => c.outcome === o).length })).filter((x) => x.n > 0);
  const rec = recover(plan, mask);
  const outcome = classify(plan, rec);
  const durable = (i: number) => (mask & (1 << i)) !== 0;
  const journal = plan.writes.map((w, i) => ({ w, i })).filter((x) => x.w.area === "journal");
  const home = [...plan.metaIds, ...plan.dataIds];
  const homeBefore = (id: string): BlockValue => { const i = plan.writes.findIndex((w) => w.id === id); return i >= 0 && durable(i) ? "new" : "old"; };
  const [filter, setFilter] = useState<Outcome | null>(null);
  const shownCases = filter ? cases.filter((c) => c.outcome === filter) : cases;
  const reset = () => { setPicked(null); setFilter(null); };

  const barrierAfter = (pos: number) => {
    const a = plan.writes[order[pos]!]!, b = plan.writes[order[pos + 1]!];
    return !!b && a.level !== null && b.level !== null && a.level !== b.level;
  };

  return (
    <Demo
      title="A crash explorer"
      actions={<button className="btn" onClick={() => { setSeed(seed + 1); setPicked(null); }}>Another disk order</button>}
      controls={<>
        <Param spec={{ ...J.crash, max: plan.writes.length }} value={k} onChange={(v) => { P.set("crash", v as number); setPicked(null); }} />
        <Param spec={J.mode} value={mode} onChange={(v) => { P.set("mode", v as never); reset(); }} />
        <Param spec={J.workload} value={workload} onChange={(v) => { P.set("workload", v as never); reset(); }} />
        {mode !== "none" && <Param spec={J.commit} value={commit} onChange={(v) => { P.set("commit", v as never); reset(); }} />}
      </>}
    >
      <Heading>The order in which this disk completes the writes. A bar is a flush.</Heading>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" }}>
        {order.map((idx, pos) => {
          const w = plan.writes[idx]!;
          return (
            <span key={w.id} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              <span title={w.note} style={{ fontFamily: MONO, fontSize: 11.5, padding: "1px 5px", borderRadius: 3, border: `1px solid ${durable(idx) ? "var(--c3)" : "var(--border)"}`, color: durable(idx) ? "var(--c3)" : "var(--muted)" }}>{w.id}</span>
              {barrierAfter(pos) && <span style={{ width: 2, height: 18, background: "var(--fg)" }} aria-label="flush" />}
            </span>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 10 }}>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
          <Heading>On disk at the crash</Heading>
          {journal.length > 0 && <>
            <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>journal</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {journal.map(({ w, i }) => <Block key={w.id} name={w.id} on={durable(i)} />)}
            </div>
          </>}
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>home locations</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {home.map((id) => <Block key={id} name={id} on={homeBefore(id) === "new"} sub={homeBefore(id)} />)}
          </div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
          <Heading>After recovery</Heading>
          <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>home locations</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {home.map((id) => <Block key={id} name={id} on={rec.home[id] !== "old"} color={valColor(rec.home[id]!)} sub={rec.home[id]} />)}
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.4 }}>{rec.action}</div>
        </div>
      </div>
      <Banner tone={atomic(outcome) ? "good" : dataOk(outcome) ? "plain" : "bad"}>
        <b>{OUTCOME_LABEL[outcome]}.</b> {metadataOk(outcome) ? "The file system is consistent." : "The file system is damaged."} {atomic(outcome) ? "The operation is all or nothing." : "The operation is not all or nothing."}
      </Banner>

      <div style={{ marginTop: 12 }}>
        <Heading>Every crash state of this configuration: {cases.length}</Heading>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {counts.map(({ o, n }) => (
            <button key={o} className="btn" title={OUTCOME_LABEL[o]} onClick={() => setFilter(filter === o ? null : o)} style={{ padding: "1px 7px", fontSize: 12, borderColor: OUT_COLOR[o], outline: filter === o ? `1.5px solid ${OUT_COLOR[o]}` : "none" }}>
              <b style={{ color: OUT_COLOR[o] }}>{n}</b> {o}
            </button>
          ))}
        </div>
        <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
          {shownCases.map((c) => (
            <button key={c.mask} onClick={() => setPicked(c.mask)} style={{ display: "flex", justifyContent: "space-between", gap: 8, width: "100%", font: "inherit", fontSize: 11.5, border: 0, borderBottom: "1px solid var(--border)", padding: "2px 6px", cursor: "pointer", textAlign: "left", background: c.mask === mask ? "var(--subtle)" : "transparent", color: "var(--fg)" }}>
              <span style={{ fontFamily: MONO, minWidth: 0, overflowWrap: "anywhere" }}>{c.durable.join(" ") || "nothing"}</span>
              <span style={{ color: OUT_COLOR[c.outcome], whiteSpace: "nowrap" }}>{c.outcome}</span>
            </button>
          ))}
        </div>
      </div>
      <Note>TxB is the descriptor block, J:x is the journal copy of block x, TxE is the commit block, and JSB is the journal superblock. I is the inode, B is the bitmap, and D0 and D1 are data blocks. Click a row to load that state.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- cost

const C = {
  blocks: range({ label: "Data per fsync", min: 1, max: 25600, log: true, default: 1, format: (v) => bytes(Math.round(v) * COST_INPUTS.blockBytes) }),
  absorb: range({ label: "Commits between checkpoints", min: 1, max: 64, step: 1, default: 8 }),
  entangled: range({ label: "Dirty data of other files in the transaction", min: 0, max: 25600, step: 256, default: 0, format: (v) => bytes(v * COST_INPUTS.blockBytes) }),
  device: select({ label: "Device", segmented: true, options: (Object.keys(COST_DEVICES) as CostDevice[]).map((d) => ({ value: d, label: COST_DEVICES[d].label })), default: "hdd" }),
};

const MODE_COLOR = { writeback: "var(--c1)", ordered: "var(--c3)", data: "var(--c5)" } as const;

export function FsJournalCostDemo() {
  const P = useParams("os-fs-jcost", C);
  const blocks = Math.max(1, Math.round(P.values.blocks));
  const { absorb, entangled } = P.values;
  const device = P.values.device as CostDevice;
  const res = COST_MODES.map((m) => journalCost(m, { blocks, absorb, entangled, device }));
  const maxTotal = Math.max(...res.map((r) => r.total));
  const maxLat = Math.max(...res.map((r) => r.fsyncMs));
  const d = COST_DEVICES[device];
  return (
    <Demo title="What each mode costs for one fsync" controls={<>
      <Param spec={C.blocks} value={P.values.blocks} onChange={(v) => P.set("blocks", v as number)} />
      <Param spec={C.absorb} value={absorb} onChange={(v) => P.set("absorb", v as number)} />
      <Param spec={C.entangled} value={entangled} onChange={(v) => P.set("entangled", v as number)} />
      <Param spec={C.device} value={device} onChange={(v) => P.set("device", v as never)} />
    </>}>
      <Heading>Blocks written to the device: data in place, journal, checkpoint</Heading>
      {res.map((r) => (
        <HBar key={r.mode} label={MODE_LABEL[r.mode]} value={`${r.writeAmp.toFixed(r.writeAmp < 10 ? 2 : 1)} times the data`} parts={[
          { frac: r.dataInPlace / maxTotal, color: "var(--c1)", title: "data in place" },
          { frac: r.journal / maxTotal, color: "var(--c2)", title: "journal" },
          { frac: r.checkpoint / maxTotal, color: "var(--c5)", title: "checkpoint" },
        ]} />
      ))}
      <div className="legend" style={{ marginBottom: 10 }}>
        <span style={{ ["--swatch" as string]: "var(--c1)" }}>data in place</span>
        <span style={{ ["--swatch" as string]: "var(--c2)" }}>journal</span>
        <span style={{ ["--swatch" as string]: "var(--c5)" }}>checkpoint</span>
      </div>
      <Heading>Time for fsync to return</Heading>
      {res.map((r) => <HBar key={r.mode} label={MODE_LABEL[r.mode]} value={`${r.fsyncMs.toFixed(r.fsyncMs < 10 ? 3 : 1)} ms`} frac={r.fsyncMs / maxLat} color={MODE_COLOR[r.mode]} />)}
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["Mode", "In place", "Journal", "Checkpoint", "Seeks"]}
          rows={res.map((r) => [MODE_LABEL[r.mode], r.dataInPlace, r.journal, r.checkpoint.toFixed(2), r.seeks])}
        />
      </div>
      <Stats items={[
        { label: "positioning (model input)", value: `${d.positionMs.toFixed(2)} ms` },
        { label: "transfer (model input)", value: `${d.mbps} MB/s` },
        { label: "flush (model input)", value: `${d.flushMs} ms` },
      ]} />
      <Note>A transaction logs {COST_INPUTS.metaPerCommit} metadata blocks, one descriptor block per {COST_INPUTS.tagsPerDescriptor} logged blocks, and a commit block. This is a model of the write path, and not a benchmark of ext4.</Note>
    </Demo>
  );
}
