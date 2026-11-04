/** Demos for "read-copy-update": a stepper with a grace period timeline, and read scaling. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, Stats, range, si, toggle, useParams } from "../../kit";
import { RCU_SETUP_SCRIPT, READ_CORES, READ_DEFAULTS, READ_LABEL, canFree, rcuActions, rcuApply, rcuInit, readScale, type RcuAction, type RcuOpts, type RcuState, type ReadLock, type ReadScaleResult } from "../../sims/os/sync/rcu";
import { Banner, MONO, useChunked } from "./SyncShared";

const CPUS = 3;
const OPTS: RcuOpts = { cpus: CPUS, maxVersions: 6, maxSections: 99 };

const VC = ["var(--c1)", "var(--c2)", "var(--c5)", "var(--c3)", "var(--c4)", "var(--fg)"];
const vColor = (id: number) => VC[(id - 1) % VC.length]!;

const RCU = { broken: toggle({ label: "Free at once, with no grace period", default: false }) };

export function SyncRcuDemo() {
  const P = useParams("os-sync-rcu", RCU);
  const broken = P.values.broken;
  const opts = useMemo<RcuOpts>(() => ({ ...OPTS, broken }), [broken]);
  const [hist, setHist] = useState<RcuState[]>([rcuInit(CPUS)]);
  const s = hist[hist.length - 1]!;
  const acts = rcuActions(s, opts);
  const has = (a: RcuAction) => acts.some((x) => JSON.stringify(x) === JSON.stringify(a));
  const apply = (a: RcuAction) => { if (has(a)) setHist([...hist, rcuApply(s, a)]); };
  const gpActive = s.started > s.completed;
  const W = 400, LH = 20, LX = 46, cols = Math.max(hist.length, 16);
  const cw = (W - LX) / cols;
  const rows = CPUS + 1;
  const H = rows * LH + 6;

  return (
    <Demo
      title="An RCU list: readers, a writer and a grace period"
      actions={
        <>
          <button className="btn" onClick={() => hist.length > 1 && setHist(hist.slice(0, -1))} disabled={hist.length <= 1}>Back</button>
          <button className="btn ghost" onClick={() => setHist([rcuInit(CPUS)])}>Reset</button>
        </>
      }
      controls={<Param spec={RCU.broken} value={broken} onChange={(v) => { P.set("broken", v as boolean); setHist([rcuInit(CPUS)]); }} />}
    >
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontFamily: MONO, fontSize: 12 }}>cur → version {s.ptr}</span>
        {s.versions.map((v) => {
          const holders = s.cpus.flatMap((c, i) => (c.holds === v.id ? [i] : []));
          const free = canFree(s, v, broken);
          return (
            <div key={v.id} style={{ border: `1.5px ${v.state === "live" ? "solid" : "dashed"} ${v.state === "freed" ? "var(--border)" : vColor(v.id)}`, borderRadius: 6, padding: "4px 8px", minWidth: 76, opacity: v.state === "freed" ? 0.5 : 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: v.state === "freed" ? "var(--muted)" : vColor(v.id) }}>version {v.id}</div>
              <div className="muted" style={{ fontSize: 11 }}>{v.state}{holders.length ? `, read by CPU ${holders.join(", ")}` : ""}</div>
              {free && <button className="btn" style={{ padding: "1px 6px", fontSize: 11, marginTop: 3 }} onClick={() => apply({ kind: "free", id: v.id })}>kfree</button>}
            </div>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 6, marginTop: 10 }}>
        {s.cpus.map((c, i) => (
          <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>CPU {i}{c.inCs ? `: reads version ${c.holds}` : ": no read section"}</div>
            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              {c.inCs
                ? <button className="btn" style={{ padding: "2px 7px", fontSize: 12 }} onClick={() => apply({ kind: "exit", cpu: i })}>rcu_read_unlock</button>
                : <button className="btn" style={{ padding: "2px 7px", fontSize: 12 }} onClick={() => apply({ kind: "enter", cpu: i })}>rcu_read_lock</button>}
              <button className="btn" style={{ padding: "2px 7px", fontSize: 12 }} disabled={!has({ kind: "qs", cpu: i })} onClick={() => apply({ kind: "qs", cpu: i })}>Context switch</button>
            </div>
          </div>
        ))}
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Writer</div>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
            <button className="btn" style={{ padding: "2px 7px", fontSize: 12 }} disabled={!has({ kind: "publish" })} onClick={() => apply({ kind: "publish" })}>Publish a copy</button>
            <button className="btn" style={{ padding: "2px 7px", fontSize: 12 }} disabled={!has({ kind: "startGp" })} onClick={() => apply({ kind: "startGp" })}>Start grace period</button>
          </div>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", maxWidth: 620, display: "block", marginTop: 10 }} role="img" aria-label="timeline of read sections and the grace period">
        {s.cpus.map((_, i) => <text key={i} x={0} y={LH * i + 14} fontSize={11} fill="var(--muted)">CPU {i}</text>)}
        <text x={0} y={LH * CPUS + 14} fontSize={11} fill="var(--muted)">grace</text>
        {hist.map((h, t) => (
          <g key={t}>
            {h.cpus.map((c, i) => c.holds !== null && <rect key={i} x={LX + t * cw} y={LH * i + 3} width={cw + 0.4} height={LH - 6} fill={vColor(c.holds)} opacity={0.7} />)}
            {h.cpus.map((_, i) => h.pending.includes(i) && h.started > h.completed && <rect key={`p${i}`} x={LX + t * cw} y={LH * i + LH - 5} width={cw + 0.4} height={2.5} fill="var(--fg)" />)}
            {h.started > h.completed && <rect x={LX + t * cw} y={LH * CPUS + 5} width={cw + 0.4} height={LH - 10} fill="var(--fg)" opacity={0.55} />}
          </g>
        ))}
      </svg>
      <div className="muted" style={{ fontSize: 11.5 }}>Each column is one step. A colored bar is a reader that uses that version. A thin line means that the CPU still owes a quiescent state.</div>

      <Banner tone={s.err ? "bad" : "plain"}>{s.err ?? (s.say || "Start a read on CPU 0. Then publish a copy, and start a grace period.")}</Banner>
      <div className="row" style={{ marginTop: 8, gap: 6, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => {
          let st = rcuInit(CPUS);
          const out = [st];
          for (const a of RCU_SETUP_SCRIPT) { st = rcuApply(st, a); out.push(st); }
          setHist(out);
        }}>Set up: CPU 0 blocks the grace period</button>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "grace period", value: gpActive ? `active, waits for ${s.pending.length === 0 ? "none" : `CPU ${s.pending.join(", ")}`}` : "idle" },
          { label: "grace periods done", value: s.completed },
          { label: "versions waiting to be freed", value: s.versions.filter((v) => v.state === "retired").length },
        ]} />
      </div>
    </Demo>
  );
}

const COLOR: Record<ReadLock, string> = { mutex: "var(--c4)", rwlock: "var(--c2)", rcu: "var(--c3)" };
const SC = {
  readCycles: range({ label: "Read section", min: 10, max: 2000, default: READ_DEFAULTS.readCycles, log: true, format: (v) => `${Math.round(v)} cycles` }),
};

export function SyncReadScaleDemo() {
  const P = useParams("os-sync-scale", SC);
  const readCycles = Math.round(P.values.readCycles);
  const locks: ReadLock[] = ["mutex", "rwlock", "rcu"];
  const tasks = useMemo(() => locks.flatMap((l) => READ_CORES.map((c) => () => readScale(l, c, { readCycles }))), [readCycles]); // eslint-disable-line react-hooks/exhaustive-deps
  const { results } = useChunked<ReadScaleResult>(tasks, String(readCycles));
  const at = (l: ReadLock, c: number) => results[locks.indexOf(l) * READ_CORES.length + READ_CORES.indexOf(c)];
  const line = (l: ReadLock) => READ_CORES.flatMap((c) => { const r = at(l, c); return r ? [[c, r.mReadsPerSec] as [number, number]] : []; });
  const top = Math.max(100, ...results.map((r) => r?.mReadsPerSec ?? 0));
  const low = Math.min(10, ...results.map((r) => (r ? r.mReadsPerSec : Infinity)));
  const r64 = at("rcu", 64);
  const w64 = at("rwlock", 64);
  return (
    <Demo title="Read throughput against core count" controls={<Param spec={SC.readCycles} value={P.values.readCycles} onChange={(v) => P.set("readCycles", v as number)} />}>
      <Plot x={[1, 64]} y={[Math.max(0.1, low * 0.8), top * 1.2]} logX logY height={250} xLabel="cores" yLabel="million reads per second" xTicks={READ_CORES} xFormat={(v) => String(v)} yTicks={[0.1, 1, 10, 100, 1000, 10000].filter((t) => t >= Math.max(0.1, low * 0.8) && t <= top * 1.2)} yFormat={(v) => String(v)}>
        {locks.map((l) => <Line key={l} points={line(l)} color={COLOR[l]} />)}
      </Plot>
      <Legend items={locks.map((l) => ({ label: READ_LABEL[l], color: COLOR[l] }))} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "RCU at 64 cores", value: r64 ? si(r64.mReadsPerSec * 1e6, "reads/s", 3) : "…" },
          { label: "rwlock at 64 cores", value: w64 ? si(w64.mReadsPerSec * 1e6, "reads/s", 3) : "…" },
          { label: "RCU / rwlock at 64 cores", value: r64 && w64 ? `${(r64.mReadsPerSec / w64.mReadsPerSec).toFixed(1)} times` : "…" },
          { label: "bus transactions per rwlock read", value: w64 ? w64.busPerRead.toFixed(2) : "…" },
          { label: "bus transactions per RCU read", value: r64 ? r64.busPerRead.toFixed(2) : "…" },
        ]} />
      </div>
    </Demo>
  );
}
