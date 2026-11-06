/** Demos for the Percolator lesson: the Bob-and-Joe stepper with a crash and lock cleanup, and write skew under SI. */
import { useMemo, useState } from "react";
import { Arrow, Banner, Btn, ButtonRow, Chip, Demo, MiniTable, Param, SectionLabel, Stats, StepCaption, seg, toggle, useParams, mono } from "../../kit";
import { replayPercolator, writeSkew, WRITER_STEPS, type PercAction, type Percolator } from "../../sims/dist/transactions/percolator";
import { findCycle } from "../../sims/db/txn/schedule";

/** The table as the paper draws it: per key, the data, lock and write columns, newest timestamp first. */
function KvTable({ p, keys, hot }: { p: Percolator; keys: string[]; hot?: string[] }) {
  const col = (m: Map<number, unknown>, fmt: (ts: number, v: unknown) => string, color: string) => {
    const xs = [...m].sort((a, b) => b[0] - a[0]);
    if (!xs.length) return <span className="muted">–</span>;
    return <div style={{ display: "grid", gap: 2, justifyItems: "end" }}>{xs.map(([ts, v]) => <Chip key={ts} color={color}>{fmt(ts, v)}</Chip>)}</div>;
  };
  return (
    <MiniTable
      head={["key", "data", "lock", "write"]}
      highlight={(i) => !!hot?.includes(keys[i]!)}
      rows={keys.map((k) => {
        const r = p.row(k);
        return [
          <b key="k">{k}</b>,
          col(r.data, (ts, v) => `${ts}: ${v}`, "var(--fg)"),
          col(r.lock, (ts, v) => `${ts}: ${(v as { primary: string }).primary === k ? "primary" : `→ ${(v as { primary: string }).primary}`}`, "var(--c2)"),
          col(r.write, (ts, v) => `${ts}: data@${v}`, "var(--c3)"),
        ];
      })}
    />
  );
}

// ============================================================================ 1. The stepper: Bob pays Joe 7

export function DistTxnPercolatorStepperDemo() {
  const [acts, setActs] = useState<PercAction[]>([]);
  const f = useMemo(() => replayPercolator(acts), [acts]);
  const push = (a: PercAction) => setActs((s) => [...s, a]);
  const wDone = f.crashed || f.wStep >= WRITER_STEPS.length;
  const w = f.writer;
  const locks = ["Bob", "Joe"].filter((k) => f.p.row(k).lock.size > 0);
  return (
    <Demo title="Percolator: Bob pays Joe 7" actions={<><Btn onClick={() => setActs((s) => s.slice(0, -1))} disabled={!acts.length}>Back</Btn><Btn ghost onClick={() => setActs([])} disabled={!acts.length}>Reset</Btn></>}>
      <KvTable p={f.p} keys={["Bob", "Joe"]} hot={locks} />
      <SectionLabel>Writer (client 1)</SectionLabel>
      <ButtonRow>
        <Btn onClick={() => push("w")} disabled={wDone}>{wDone ? (f.crashed ? "crashed" : "done") : `Next: ${WRITER_STEPS[f.wStep]}`}</Btn>
        <Btn ghost onClick={() => push("crash")} disabled={!w || f.crashed || f.wStep >= WRITER_STEPS.length}>Crash the writer</Btn>
      </ButtonRow>
      <SectionLabel>Reader (client 2)</SectionLabel>
      <ButtonRow>
        <Btn onClick={() => push("rbegin")} disabled={!!f.reader}>Start (get a timestamp)</Btn>
        <Btn onClick={() => push("rBob")} disabled={!f.reader}>Read Bob</Btn>
        <Btn onClick={() => push("rJoe")} disabled={!f.reader}>Read Joe</Btn>
      </ButtonRow>
      <StepCaption tone={f.tone} label={`${acts.length} actions`}>{f.text}</StepCaption>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "oracle is at", value: f.p.peekTs() },
          { label: "writer", value: w ? `${w.status}${w.commitTs ? ` at ${w.commitTs}` : ""}` : "not started" },
          { label: "reader start ts", value: f.reader ? f.reader.startTs : "–" },
          { label: "reader saw Bob + Joe", value: f.readerSaw.Bob !== undefined && f.readerSaw.Joe !== undefined ? `${f.readerSaw.Bob} + ${f.readerSaw.Joe} = ${(f.readerSaw.Bob ?? 0) + (f.readerSaw.Joe ?? 0)}` : "–" },
        ]} />
      </div>
    </Demo>
  );
}

// ============================================================================ 2. Write skew under snapshot isolation

const SKEW = {
  order: seg<"concurrent" | "serial">("Order", [["concurrent", "both read, then both commit"], ["serial", "T1, then T2"]], "concurrent"),
  mat: toggle({ label: "Materialize the conflict (both also write the row shift)", default: false }),
};

export function DistTxnWriteSkewDemo() {
  const P = useParams("dist-txn-skew", SKEW);
  const v = P.values;
  const r = useMemo(() => writeSkew(v.order, v.mat), [v.order, v.mat]);
  const cyc = findCycle([0, 1], r.edges);
  const txt = (t: typeof r.t1) => `${t.name} start ${t.startTs}: reads x = ${t.reads.find((x) => x.key === "x")?.value}, y = ${t.reads.find((x) => x.key === "y")?.value}; ${t.writes.length ? `writes ${t.writes.map(([k, x]) => `${k} = ${x}`).join(", ")}` : "writes nothing"} → ${t.status}${t.commitTs && t.writes.length ? ` at ${t.commitTs}` : ""}`;
  const W = 260, H = 96;
  const pos = [{ x: 60, y: 48 }, { x: 200, y: 48 }];
  return (
    <Demo title="Two doctors, one rule, snapshot isolation" controls={<><Param spec={SKEW.order} value={v.order} onChange={(y) => P.set("order", y as "concurrent" | "serial")} /><Param spec={SKEW.mat} value={v.mat} onChange={(y) => P.set("mat", y as boolean)} /></>}>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>Rule: at least one of x and y is on call (1). Each transaction checks x + y ≥ 2, then takes its own doctor off call.</p>
      <div style={{ ...mono, fontSize: 12.5, display: "grid", gap: 4 }}>
        <div>{txt(r.t1)}</div>
        <div>{txt(r.t2)}</div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginTop: 8 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ maxWidth: "100%" }} role="img" aria-label="dependency graph">
          <defs><Arrow id="skew-arr" color="var(--fg)" /></defs>
          {r.edges.map((e, i) => {
            const a = pos[e.from]!, b = pos[e.to]!, up = e.from === 0 ? -1 : 1;
            const midY = a.y + up * 30;
            return (
              <g key={i}>
                <path d={`M${a.x + (e.from === 0 ? 20 : -20)} ${a.y + up * 8} Q ${(a.x + b.x) / 2} ${midY} ${b.x + (e.from === 0 ? -20 : 20)} ${b.y + up * 8}`} fill="none" stroke={cyc ? "var(--c4)" : "var(--fg)"} strokeWidth={1.5} markerEnd="url(#skew-arr)" />
                <text x={(a.x + b.x) / 2} y={midY + (up < 0 ? 10 : -2)} textAnchor="middle" fontSize="11" fill="var(--muted)">{e.kind} on {e.key}</text>
              </g>
            );
          })}
          {pos.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={17} fill="var(--bg)" stroke={[r.t1, r.t2][i]!.status === "aborted" ? "var(--c4)" : "var(--fg)"} strokeWidth={1.5} strokeDasharray={[r.t1, r.t2][i]!.status === "aborted" ? "3 2" : undefined} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="12" fill="var(--fg)">T{i + 1}</text>
            </g>
          ))}
        </svg>
        <div style={{ fontSize: 12.5, maxWidth: 320 }} className="muted">An rw edge Ti → Tj: Ti read a version that Tj then replaced, so Ti must come first in any serial order. A cycle means no serial order exists.</div>
      </div>
      <Banner ok={r.onCall >= 1}>
        {r.onCall === 0
          ? `Both committed. Neither wrote a row the other wrote, so the write-write check saw nothing. Now nobody is on call, which no serial order allows: a cycle T1 → T2 → T1.`
          : v.mat && v.order === "concurrent"
            ? `Both wrote the row shift, so T2's prewrite found T1's newer write record and aborted. ${r.onCall} doctor stays on call.`
            : `In a serial order T2 sees x = 0 and keeps its doctor on call. ${r.onCall} doctor stays on call.`}
      </Banner>
    </Demo>
  );
}
