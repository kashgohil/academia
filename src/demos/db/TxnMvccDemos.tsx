/** Demos for MVCC and its garbage collection: version chains, storage layouts, bloat and XID wraparound. */
import { useMemo, useState } from "react";
import { Demo, Stats, Param, Plot, Line, Area, RuleX, Legend, range, select, toggle, useParams, si, Arrow, BAD, Chip, GOOD, MONO, Panel, StepButtons, StepCaption, StepSlider, useStepper } from "../../kit";
import { runMvScript, MV_SCRIPT, mvText, pgVisible, LAYOUTS, chainCost, type Layout, type XidState } from "../../sims/db/txn/mvcc";
import {
  bloatSim, DEFAULT_BLOAT, autovacuumTrigger, XID_SPACE, XID_HALF, FREEZE_MAX_AGE, WARN_REMAINING, rowLooksPast, daysToWraparound, daysToForcedVacuum,
} from "../../sims/db/txn/gc";

const XC: Record<XidState, string> = { committed: GOOD, aborted: BAD, "in progress": "var(--c2)" };
const xidColor = (x: number, clog: Record<number, XidState>) => (x === 0 ? "var(--faint)" : XC[clog[x] ?? "in progress"]);

// ============================================================================ 1. Version chain and snapshots

export function VersionChainDemo() {
  const frames = useMemo(() => runMvScript(), []);
  const s = useStepper(frames.length, 1);
  const f = frames[s.i]!;
  const [sel, setSel] = useState("R1");
  const reader = f.readers.find((r) => r.name === sel) ?? f.readers[f.readers.length - 1];
  return (
    <Demo title="Tuples, snapshots and the visibility rule" actions={<StepButtons s={s} />} controls={<StepSlider s={s} label="Event" />}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
        {MV_SCRIPT.map((e, i) => <Chip key={i} color={e.k === "snap" ? "var(--c5)" : "var(--fg)"} filled={i <= s.i} dashed={i > s.i} bold={i === s.i}>{mvText(e)}</Chip>)}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12.5, fontFamily: MONO, minWidth: 300 }}>
          <thead><tr style={{ color: "var(--muted)" }}>{["ctid", "a", "xmin", "xmax", "t_ctid", reader ? `${reader.name} sees?` : ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "3px 10px 3px 0", fontWeight: 500 }}>{h}</th>)}</tr></thead>
          <tbody>
            {f.tuples.map((t) => {
              const vis = reader ? pgVisible(t, reader.snap, f.clog).visible : false;
              return (
                <tr key={t.lp} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "3px 10px 3px 0" }}>(0,{t.lp})</td>
                  <td style={{ padding: "3px 10px 3px 0", fontWeight: 700 }}>{t.value}</td>
                  <td style={{ padding: "3px 10px 3px 0", color: xidColor(t.xmin, f.clog) }}>{t.xmin}</td>
                  <td style={{ padding: "3px 10px 3px 0", color: xidColor(t.xmax, f.clog) }}>{t.xmax || "0"}</td>
                  <td style={{ padding: "3px 10px 3px 0" }}>{t.ctid === t.lp ? `(0,${t.ctid})` : `→ (0,${t.ctid})`}</td>
                  <td style={{ padding: "3px 0", color: vis ? GOOD : "var(--faint)", fontFamily: "inherit" }}>{reader ? (vis ? "visible" : "no") : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6 }}><Legend items={[{ label: "committed", color: GOOD }, { label: "in progress", color: "var(--c2)" }, { label: "aborted", color: BAD }]} /></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", margin: "10px 0 6px", fontSize: 12.5 }}>
        <span className="muted">Readers:</span>
        {f.readers.length === 0 && <span className="muted">none yet</span>}
        {f.readers.map((r) => (
          <button key={r.name} className="btn" onClick={() => setSel(r.name)} style={{ borderColor: reader?.name === r.name ? "var(--c5)" : undefined, fontWeight: reader?.name === r.name ? 700 : 400 }}>
            {r.name}: {r.sees === null ? "no row" : `a = ${f.tuples.find((t) => t.lp === r.sees)!.value}`}
          </button>
        ))}
      </div>
      {reader && (
        <Panel accent="var(--c5)" title={<>Snapshot of {reader.name}: <span style={{ fontFamily: MONO }}>xmin = {reader.snap.xmin}, xmax = {reader.snap.xmax}, xip = [{reader.snap.xip.join(", ")}]</span></>}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            {f.tuples.map((t) => {
              const v = pgVisible(t, reader.snap, f.clog);
              return (
                <div key={t.lp} style={{ fontSize: 12, borderLeft: `3px solid ${v.visible ? GOOD : "var(--border)"}`, paddingLeft: 8 }}>
                  <b style={{ fontFamily: MONO }}>(0,{t.lp}) a = {t.value}</b>
                  {v.steps.map((st, k) => (
                    <div key={k}><span className="muted">{st.q}</span> <span style={{ color: st.pass === false ? BAD : "var(--fg)" }}>{st.a}</span></div>
                  ))}
                </div>
              );
            })}
          </div>
        </Panel>
      )}
      <StepCaption label={`${s.i + 1}/${frames.length}`}>{f.text}</StepCaption>
    </Demo>
  );
}

// ============================================================================ 2. Where old versions live

const LAYOUT_SCHEMA = {
  n: range({ label: "Updates of the row", min: 0, max: 8, step: 1, default: 5 }),
  j: range({ label: "Reader's snapshot sees version", min: 0, max: 8, step: 1, default: 1 }),
  layout: select({ label: "Storage", options: LAYOUTS.map((l) => ({ value: l.id, label: l.label })), default: "pg-hot", segmented: true }),
};

export function VersionLayoutDemo() {
  const P = useParams("txn-layout", LAYOUT_SCHEMA);
  const n = Math.round(P.values.n);
  const j = Math.min(n, Math.round(P.values.j));
  const layout = P.values.layout as Layout;
  const cost = chainCost(layout, n, j);
  const newest = chainCost(layout, n, n);
  const BW = 34, GAP = 8, X0 = 8;
  const W = Math.max(320, X0 + (n + 1) * (BW + GAP) + 10);
  const inno = layout === "innodb";
  // display order: PostgreSQL oldest → newest; InnoDB newest (record) then undo older → oldest
  const order = inno ? Array.from({ length: n + 1 }, (_, i) => n - i) : Array.from({ length: n + 1 }, (_, i) => i);
  const xOf = (v: number) => X0 + order.indexOf(v) * (BW + GAP);
  const visitIdx = new Map(cost.order.map((v, k) => [v, k + 1]));
  const Y = 74;
  return (
    <Demo title="Where the old versions live" controls={<><Param spec={LAYOUT_SCHEMA.n} value={P.values.n} onChange={(v) => P.set("n", v as number)} /><Param spec={{ ...LAYOUT_SCHEMA.j, max: Math.max(1, n) }} value={j} onChange={(v) => P.set("j", v as number)} /><Param spec={LAYOUT_SCHEMA.layout} value={layout} onChange={(v) => P.set("layout", v as Layout)} /></>}>
      <svg viewBox={`0 0 ${W} 124`} style={{ width: "100%", maxWidth: W * 1.5, display: "block" }}>
        <defs><Arrow id="txn-lay-a" /><Arrow id="txn-lay-i" color="var(--c1)" /></defs>
        {(layout === "pg" ? order : [order[0]!]).map((v) => (
          <g key={`ix${v}`}>
            <rect x={xOf(v)} y={6} width={BW} height={18} rx={3} fill="var(--bg)" stroke="var(--c1)" />
            <text x={xOf(v) + BW / 2} y={19} fontSize={9.5} textAnchor="middle" fill="var(--c1)">index</text>
            <line x1={xOf(v) + BW / 2} y1={24} x2={xOf(v) + BW / 2} y2={Y - 3} stroke="var(--c1)" markerEnd="url(#txn-lay-i)" />
          </g>
        ))}
        {order.map((v, k) => {
          const vis = visitIdx.get(v);
          const target = v === j;
          const isRecord = inno && k === 0;
          return (
            <g key={v}>
              {k > 0 && <line x1={xOf(order[k - 1]!) + BW} y1={Y + 14} x2={xOf(v) - 1} y2={Y + 14} stroke="var(--muted)" markerEnd="url(#txn-lay-a)" />}
              <rect x={xOf(v)} y={Y} width={BW} height={28} rx={4} fill={vis ? (target ? GOOD : "var(--subtle)") : "var(--bg)"} stroke={target ? GOOD : vis ? "var(--fg)" : "var(--faint)"} strokeWidth={target ? 2 : 1.2} strokeDasharray={inno && !isRecord ? "4 3" : undefined} />
              <text x={xOf(v) + BW / 2} y={Y + 18} fontSize={11.5} textAnchor="middle" fontWeight={600} fill={target ? "var(--bg)" : "var(--fg)"}>v{v}</text>
              {vis && <text x={xOf(v) + BW / 2} y={Y + 44} fontSize={10.5} textAnchor="middle" fill={target ? GOOD : "var(--muted)"}>{vis}</text>}
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12, margin: "2px 0 8px" }}>{inno ? "Clustered record (newest version), then undo records linked by roll pointers (dashed). Numbers: the order in which the reader visits versions." : "Heap tuples, oldest to newest, linked by t_ctid. Numbers: the order in which the reader visits versions."}</div>
      <Stats items={[
        { label: "index entries for this row", value: cost.indexEntries },
        { label: `versions this reader checks to find v${j}`, value: cost.visits },
        { label: `versions a reader of the newest v${n} checks`, value: newest.visits },
      ]} />
      <StepCaption>
        {layout === "pg-hot" && `The index points to the oldest tuple. Each reader walks the chain forward, so a new snapshot pays for every old version until pruning removes them.`}
        {layout === "pg" && `An indexed column changed, so every version got its own index entry. The index scan finds all ${n + 1} entries and checks each tuple.`}
        {layout === "innodb" && `The record in the clustered index is always the newest version. Only an old snapshot walks the undo chain, ${n - j} step${n - j === 1 ? "" : "s"} back here.`}
      </StepCaption>
    </Demo>
  );
}

// ============================================================================ 3. Bloat timeline

const BLOAT_SCHEMA = {
  len: range({ label: "Long transaction duration (ticks)", min: 0, max: 400, step: 10, default: 300 }),
  upd: range({ label: "Updates per tick", min: 5, max: 50, step: 5, default: 20 }),
};

export function BloatTimelineDemo() {
  const P = useParams("txn-bloat", BLOAT_SCHEMA);
  const len = Math.round(P.values.len);
  const upd = Math.round(P.values.upd);
  const r = useMemo(() => bloatSim({ readerLength: len, updatesPerTick: upd }), [len, upd]);
  const c = DEFAULT_BLOAT;
  const pts = r.points;
  const ymax = Math.max(...pts.map((p) => p.size)) * 1.08;
  const live = pts.map((p) => [p.t, p.live] as const);
  const held = pts.map((p) => [p.t, p.live + p.held] as const);
  const all = pts.map((p) => [p.t, p.live + p.held + p.removable] as const);
  const vacs = pts.filter((p) => p.vacuum !== null);
  const W = 360;
  const tx = (t: number) => 8 + (t / c.ticks) * (W - 16);
  return (
    <Demo title="One long transaction, the whole table bloats" controls={<><Param spec={BLOAT_SCHEMA.len} value={P.values.len} onChange={(v) => P.set("len", v as number)} /><Param spec={BLOAT_SCHEMA.upd} value={P.values.upd} onChange={(v) => P.set("upd", v as number)} /></>}>
      <svg viewBox={`0 0 ${W} 50`} style={{ width: "100%", display: "block" }}>
        <line x1={8} y1={12} x2={W - 8} y2={12} stroke="var(--border)" />
        {len > 0 && <rect x={tx(c.readerStart)} y={5} width={tx(Math.min(c.ticks, c.readerStart + len)) - tx(c.readerStart)} height={14} rx={3} fill="var(--c5)" opacity={0.85} />}
        {len > 0 && <text x={tx(c.readerStart) + 4} y={15.5} fontSize={9.5} fill="var(--bg)">long transaction: snapshot held</text>}
        {vacs.map((p) => <line key={p.t} x1={tx(p.t)} y1={26} x2={tx(p.t)} y2={38} stroke={p.vacuum ? GOOD : BAD} strokeWidth={1.6} />)}
        <text x={8} y={48} fontSize={9} fill="var(--muted)">vacuum runs: green removed versions, red removed nothing</text>
      </svg>
      <Plot x={[0, c.ticks]} y={[0, ymax]} height={220} xLabel="time (ticks)" yLabel="tuples in the table" yFormat={(v) => si(v)}>
        <Area points={all} color={GOOD} opacity={0.35} base={0} />
        <Area points={held} color={BAD} opacity={0.45} base={0} />
        <Area points={live} color="var(--c1)" opacity={0.5} base={0} />
        <Line points={pts.map((p) => [p.t, p.size])} color="var(--fg)" width={1.5} dash="5 3" />
        {len > 0 && <RuleX at={c.readerStart} color="var(--c5)" />}
      </Plot>
      <Legend box items={[{ label: "live rows", color: "var(--c1)" }, { label: "dead, held by a snapshot", color: BAD }, { label: "dead, removable", color: GOOD }, { label: "file size (high-water mark)", color: "var(--fg)" }]} />
      <div style={{ marginTop: 8 }}>
        <Stats items={[
          { label: "peak dead versions", value: r.peakDead.toLocaleString("en-US") },
          { label: "vacuum runs (useless)", value: `${r.vacuums} (${r.uselessVacuums})` },
          { label: "file size at the end", value: `${r.pages} pages` },
          { label: "autovacuum trigger", value: `${autovacuumTrigger(c.rows)} dead` },
        ]} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{c.rows.toLocaleString("en-US")} rows, {c.tuplesPerPage} tuples per page. Autovacuum wakes every {c.naptime} ticks and runs when dead tuples exceed 50 + 0.2 × rows.</div>
    </Demo>
  );
}

// ============================================================================ 4. XID wraparound ring

const XID_SCHEMA = {
  consumed: range({ label: "Transaction ids used since the row was written", min: 1e6, max: 4.2e9, log: true, default: 1e9, format: (v) => si(v) }),
  frozen: toggle({ label: "VACUUM froze the row", default: false }),
  rate: range({ label: "Write transactions per second", min: 10, max: 100000, log: true, default: 1000, format: (v) => si(v) }),
};

export function XidRingDemo() {
  const P = useParams("txn-xid", XID_SCHEMA);
  const consumed = P.values.consumed;
  const frozen = P.values.frozen;
  const rate = P.values.rate;
  const past = rowLooksPast(consumed, frozen);
  const C = 120, R = 92;
  const pt = (frac: number, r: number) => [C + r * Math.sin(frac * 2 * Math.PI), C - r * Math.cos(frac * 2 * Math.PI)] as const;
  // current id at the top; older ids counter-clockwise (to the left)
  const rowFrac = -((consumed % XID_SPACE) / XID_SPACE);
  const arc = (f0: number, f1: number, r: number) => {
    const [x0, y0] = pt(f0, r), [x1, y1] = pt(f1, r);
    return `M${x0} ${y0} A${r} ${r} 0 ${Math.abs(f1 - f0) > 0.5 ? 1 : 0} ${f1 > f0 ? 1 : 0} ${x1} ${y1}`;
  };
  const [rx, ry] = pt(rowFrac, R);
  const [mx, my] = pt(-FREEZE_MAX_AGE / XID_SPACE, R + 12);
  const [wx, wy] = pt(-(XID_HALF - WARN_REMAINING) / XID_SPACE, R + 12);
  return (
    <Demo title="2^32 transaction ids on a ring" controls={<><Param spec={XID_SCHEMA.consumed} value={consumed} onChange={(v) => P.set("consumed", v as number)} /><Param spec={XID_SCHEMA.frozen} value={frozen} onChange={(v) => P.set("frozen", v as boolean)} /><Param spec={XID_SCHEMA.rate} value={rate} onChange={(v) => P.set("rate", v as number)} /></>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12, alignItems: "center" }}>
        <svg viewBox="0 0 240 240" style={{ width: "100%", maxWidth: 300, display: "block", margin: "0 auto" }}>
          <path d={arc(-0.5, 0, R)} fill="none" stroke={GOOD} strokeWidth={14} opacity={0.35} />
          <path d={arc(0, 0.5, R)} fill="none" stroke={BAD} strokeWidth={14} opacity={0.25} />
          <path d={arc(-FREEZE_MAX_AGE / XID_SPACE, 0, R - 12)} fill="none" stroke="var(--c1)" strokeWidth={3} />
          <path d={arc(-0.5, -(XID_HALF - WARN_REMAINING) / XID_SPACE, R - 12)} fill="none" stroke="var(--c2)" strokeWidth={3} />
          <line x1={C} y1={C - R - 12} x2={C} y2={C - R + 12} stroke="var(--fg)" strokeWidth={2.5} />
          <text x={C} y={C - R - 16} fontSize={10.5} textAnchor="middle" fill="var(--fg)" fontWeight={700}>next id</text>
          <text x={C - 62} y={C + 4} fontSize={10.5} textAnchor="middle" fill={GOOD}>past</text>
          <text x={C + 62} y={C + 4} fontSize={10.5} textAnchor="middle" fill={BAD}>future</text>
          <text x={mx - 4} y={my} fontSize={9} textAnchor="end" fill="var(--c1)">200M</text>
          <text x={wx - 4} y={wy + 8} fontSize={9} textAnchor="end" fill="var(--c2)">warn</text>
          {frozen ? (
            <g>
              <circle cx={C} cy={C} r={22} fill="var(--bg)" stroke={GOOD} strokeWidth={2} />
              <text x={C} y={C - 2} fontSize={9.5} textAnchor="middle" fill={GOOD} fontWeight={700}>frozen</text>
              <text x={C} y={C + 10} fontSize={9} textAnchor="middle" fill="var(--muted)">always past</text>
            </g>
          ) : (
            <g style={{ transition: "transform 0.3s" }}>
              <line x1={C} y1={C} x2={rx} y2={ry} stroke={past ? GOOD : BAD} strokeWidth={1.5} strokeDasharray="3 3" />
              <circle cx={rx} cy={ry} r={7} fill={past ? GOOD : BAD} stroke="var(--bg)" strokeWidth={2} />
              <text x={rx} y={ry + (ry > C ? 20 : -12)} fontSize={10} textAnchor="middle" fill={past ? GOOD : BAD} fontWeight={700}>row xmin</text>
            </g>
          )}
        </svg>
        <div style={{ fontSize: 13 }}>
          <div style={{ fontFamily: MONO, fontSize: 12.5 }}>age = {frozen ? "frozen" : si(consumed % XID_SPACE)}</div>
          <div style={{ color: past ? GOOD : BAD, fontWeight: 600, margin: "6px 0" }}>
            {frozen ? "The row is frozen: it is visible to every snapshot, at any age." : past ? "xmin looks older than the next id: the row is visible." : "xmin now looks newer than the next id: the committed row seems to be in the future, so it disappears."}
          </div>
          <div className="muted" style={{ fontSize: 12.5 }}>
            Only {si(XID_HALF)} ids fit in the past half. Anti-wraparound autovacuum starts when a table's oldest unfrozen id is {si(FREEZE_MAX_AGE)} old (blue arc). The orange arc is the last {si(WARN_REMAINING)} ids, where PostgreSQL warns.
          </div>
        </div>
      </div>
      <Stats items={[
        { label: "days until 2^31 ids at this rate", value: daysToWraparound(rate).toFixed(1) },
        { label: "days between forced freeze vacuums", value: daysToForcedVacuum(rate).toFixed(1) },
      ]} />
    </Demo>
  );
}
