/** Demos for "Latch crabbing and B-link trees": a two-thread stepper and root latch counts. */
import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Param, range, select, Legend } from "../../kit";
import {
  initLatchState, stepLatch, blockedBy, nextLabel, raceStates, rootContention, ROOT_PROTOCOLS, READ_KEY, WRITE_KEY,
  type LatchState, type Protocol, type Who, type LNode, type RootProtocol,
} from "../../sims/db/btree-latch";
import { mono } from "./BtreeView";

const TC: Record<Who, string> = { reader: "var(--c1)", writer: "var(--c2)" };
const PROTOCOLS: { value: Protocol; label: string }[] = [
  { value: "none", label: "no latches" },
  { value: "crabbing", label: "latch crabbing" },
  { value: "blink", label: "B-link" },
  { value: "olc", label: "optimistic (versions)" },
];

const CELL = 20;
const nodeW = (n: LNode) => Math.max(1, n.keys.length) * CELL + 8;

function LatchTree({ s }: { s: LatchState }) {
  const leaves = ["A", "B", "B2", "C"].filter((id) => s.nodes[id]);
  const W = 420, H = 150;
  const pos: Record<string, { x: number; y: number }> = { R: { x: W / 2, y: 34 } };
  leaves.forEach((id, i) => (pos[id] = { x: ((i + 0.5) * W) / leaves.length, y: 112 }));
  const r = s.nodes.R!;
  const showLinks = s.protocol === "blink";
  const showVer = s.protocol === "olc";
  const holders = (id: string) =>
    (["reader", "writer"] as const).flatMap((w) => (s[w].held[id] ? [{ w, m: s[w].held[id]! }] : []));
  const box = (n: LNode) => {
    const p = pos[n.id]!;
    const w = nodeW(n);
    const touched = (["reader", "writer"] as const).filter((who) => s.touched[who] === n.id);
    const hs = holders(n.id);
    const locked = showVer && n.version % 2 === 1;
    const orphan = n.id !== "R" && !r.kids!.includes(n.id);
    return (
      <g key={n.id}>
        <rect x={p.x - w / 2} y={p.y - 12} width={w} height={24} rx={4} fill="var(--bg)" stroke={touched.length ? TC[touched[touched.length - 1]!] : locked ? "var(--c4)" : "var(--muted)"} strokeWidth={touched.length || locked ? 2.2 : 1} strokeDasharray={orphan ? "4 3" : undefined} />
        {n.keys.map((k, i) => (
          <g key={i}>
            {i > 0 && <line x1={p.x - w / 2 + 4 + i * CELL} x2={p.x - w / 2 + 4 + i * CELL} y1={p.y - 8} y2={p.y + 8} stroke="var(--border)" />}
            <text x={p.x - w / 2 + 4 + i * CELL + CELL / 2} y={p.y} dy="0.34em" textAnchor="middle" fontSize={11} style={{ fill: k === READ_KEY ? "var(--c1)" : k === WRITE_KEY ? "var(--c2)" : "var(--fg)" }} fontWeight={k === READ_KEY || k === WRITE_KEY ? 650 : 400}>{k}</text>
          </g>
        ))}
        <text x={p.x - w / 2 - 4} y={p.y} dy="0.34em" textAnchor="end" fontSize={10.5} style={{ fill: "var(--muted)" }}>{n.id}</text>
        {hs.map((h, i) => (
          <g key={h.w}>
            <rect x={p.x + w / 2 + 3 + i * 24} y={p.y - 9} width={21} height={18} rx={3} fill={TC[h.w]} opacity={0.18} />
            <text x={p.x + w / 2 + 13.5 + i * 24} y={p.y} dy="0.34em" textAnchor="middle" fontSize={10.5} fontWeight={650} style={{ fill: TC[h.w] }}>{h.m}</text>
          </g>
        ))}
        {showLinks && n.id !== "R" && <text x={p.x} y={p.y + 25} textAnchor="middle" fontSize={9.5} style={{ fill: "var(--muted)" }}>high {Number.isFinite(n.high) ? n.high : "∞"}</text>}
        {showVer && <text x={p.x} y={p.y + (n.id === "R" ? -17 : 25)} textAnchor="middle" fontSize={9.5} style={{ fill: locked ? "var(--c4)" : "var(--muted)" }}>v{n.version}{locked ? " locked" : ""}</text>}
      </g>
    );
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 560, margin: "0 auto" }}>
      <defs>
        <marker id="lt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0L10 5L0 10z" fill="var(--c3)" />
        </marker>
      </defs>
      {r.kids!.map((id, i) => {
        const p = pos[id];
        if (!p) return null;
        const x1 = pos.R!.x - nodeW(r) / 2 + 4 + i * CELL;
        return <line key={id} x1={x1} y1={pos.R!.y + 12} x2={p.x} y2={p.y - 12} stroke="var(--faint)" />;
      })}
      {showLinks &&
        leaves.map((id) => {
          const n = s.nodes[id]!;
          if (!n.right || !pos[n.right]) return null;
          const a = pos[id]!, b = pos[n.right]!;
          return <line key={`r${id}`} x1={a.x + nodeW(n) / 2 + 1} y1={a.y + 4} x2={b.x - nodeW(s.nodes[n.right]!) / 2 - 2} y2={b.y + 4} stroke="var(--c3)" strokeWidth={1.4} markerEnd="url(#lt-arrow)" />;
        })}
      {Object.values(s.nodes).map(box)}
    </svg>
  );
}

function ThreadPanel({ s, who, onStep, disabled }: { s: LatchState; who: Who; onStep: () => void; disabled: boolean }) {
  const t = s[who];
  const block = blockedBy(s, who);
  const label = nextLabel(s, who);
  const held = Object.entries(t.held).map(([id, m]) => `${m} on ${id}`).join(", ");
  const wrong = who === "reader" && t.result === "not found";
  return (
    <div style={{ flex: "1 1 220px", minWidth: 0, border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", borderTop: `3px solid ${TC[who]}` }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b style={{ color: TC[who], fontSize: 13 }}>{who === "reader" ? `Reader: find ${READ_KEY}` : `Writer: insert ${WRITE_KEY}`}</b>
        <button className="btn" disabled={disabled || t.done} onClick={onStep}>Step</button>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 6, minHeight: 34 }}>
        {t.done ? (
          <span style={{ color: wrong ? "var(--c4)" : "var(--c3)", fontWeight: 600 }}>
            {who === "reader" ? (wrong ? `Done: "${READ_KEY} is not in the tree". Wrong.` : `Done: found ${READ_KEY}.`) : "Done: 22 is in the tree."}
          </span>
        ) : (
          <>
            <span className="muted">Next: </span>{label}
            {block && <div style={{ color: "var(--c4)", marginTop: 2 }}>Must wait: {block}.</div>}
          </>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
        Holds: {held || "nothing"}{t.restarts ? ` · restarts: ${t.restarts}` : ""}
      </div>
    </div>
  );
}

export function LatchStepperDemo() {
  const [protocol, setProtocol] = useState<Protocol>("none");
  const [hist, setHist] = useState<LatchState[]>(() => [initLatchState("none")]);
  const [playing, setPlaying] = useState<LatchState[] | null>(null);
  const s = hist[hist.length - 1]!;
  useEffect(() => { setHist([initLatchState(protocol)]); setPlaying(null); }, [protocol]);
  useEffect(() => {
    if (!playing) return;
    if (hist.length >= playing.length) { setPlaying(null); return; }
    const id = window.setTimeout(() => setHist(playing.slice(0, hist.length + 1)), 750);
    return () => window.clearTimeout(id);
  }, [playing, hist.length]);
  const step = (who: Who) => setHist([...hist, stepLatch(s, who)]);
  const race = () => {
    const states = raceStates(protocol);
    setHist([states[0]!]);
    setPlaying(states);
  };
  const log = s.log.slice(-7);
  return (
    <Demo
      title="A reader and a splitting writer, one step at a time"
      actions={
        <>
          <button className="btn primary" onClick={race} disabled={!!playing}>Play the race</button>
          <button className="btn" onClick={() => setHist(hist.length > 1 ? hist.slice(0, -1) : hist)} disabled={hist.length <= 1 || !!playing}>Undo</button>
          <button className="btn ghost" onClick={() => { setPlaying(null); setHist([initLatchState(protocol)]); }}>Reset</button>
        </>
      }
      controls={<Param spec={select({ label: "Protocol", options: PROTOCOLS, default: "none", segmented: true })} value={protocol} onChange={(v) => setProtocol(v as Protocol)} />}
    >
      <LatchTree s={s} />
      <div className="row" style={{ alignItems: "stretch", gap: 10, marginTop: 8 }}>
        <ThreadPanel s={s} who="reader" onStep={() => step("reader")} disabled={!!playing} />
        <ThreadPanel s={s} who="writer" onStep={() => step("writer")} disabled={!!playing} />
      </div>
      <div style={{ ...mono, marginTop: 10, minHeight: 7 * 18, lineHeight: "18px" }}>
        {log.length === 0 && <div className="muted">Step the threads in any order, or press Play the race.</div>}
        {log.map((l, i) => (
          <div key={s.log.length - log.length + i} style={{ color: l.kind === "bad" ? "var(--c4)" : l.kind === "wait" ? "var(--muted)" : l.kind === "info" ? "var(--c3)" : "var(--fg)" }}>
            <span style={{ color: TC[l.who] }}>{l.who === "reader" ? "R" : "W"}</span> {l.text}
          </div>
        ))}
      </div>
      <Legend items={[{ label: "reader", color: TC.reader }, { label: "writer", color: TC.writer }, ...(protocol === "blink" ? [{ label: "right link", color: "var(--c3)" }] : []), { label: "dashed: no parent points here yet", color: "var(--muted)" }]} />
    </Demo>
  );
}

// ============================================================================
// Root latch counts
// ============================================================================

const RP_LABEL: Record<RootProtocol, string> = {
  crabbing: "latch crabbing",
  optimistic: "optimistic descent",
  blink: "B-link",
  olc: "optimistic lock coupling",
};

export function RootContentionDemo() {
  const [w, setW] = useState(50);
  const [order, setOrder] = useState("64");
  const r = useMemo(() => rootContention({ order: Number(order), n: 20_000, ops: 10_000, writeFrac: w / 100 }), [w, order]);
  const maxWrites = Math.max(1, ...ROOT_PROTOCOLS.map((p) => r.byProtocol[p].rootLineWrites));
  return (
    <Demo
      title="What 10,000 operations do to the root"
      controls={
        <>
          <Param spec={range({ label: "Writes (inserts)", min: 0, max: 100, step: 5, default: 50, format: (v) => `${v}%` })} value={w} onChange={(v) => setW(v as number)} />
          <Param spec={select({ label: "Order (max children)", options: ["16", "64", "256"].map((v) => ({ value: v, label: v })), default: "64", segmented: true })} value={order} onChange={(v) => setOrder(v as string)} />
        </>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        {ROOT_PROTOCOLS.map((p) => {
          const c = r.byProtocol[p];
          return (
            <div key={p}>
              <div className="row" style={{ justifyContent: "space-between", fontSize: 12.5 }}>
                <b style={{ fontWeight: 550 }}>{RP_LABEL[p]}</b>
                <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                  S {c.rootS.toLocaleString("en-US")} · <span style={{ color: c.rootX > r.writes / 10 ? "var(--c4)" : undefined }}>X {c.rootX.toLocaleString("en-US")}</span> · restarts {c.restarts} · max held {c.maxHeld}
                </span>
              </div>
              <div style={{ height: 12, borderRadius: 3, background: "var(--subtle)", border: "1px solid var(--border)", overflow: "hidden", marginTop: 3 }}>
                <div style={{ width: `${(100 * c.rootLineWrites) / maxWrites}%`, minWidth: c.rootLineWrites ? 2 : 0, height: "100%", background: p === "olc" ? "var(--c3)" : "var(--c1)", transition: "width 0.25s" }} />
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{c.rootLineWrites.toLocaleString("en-US")} writes to the root latch word</div>
            </div>
          );
        })}
      </div>
      <div style={{ height: 12 }} />
      <Stats
        items={[
          { label: "inserts", value: r.writes.toLocaleString("en-US") },
          { label: "tree height", value: r.height },
          { label: "inserts that split a leaf", value: r.leafSplits },
          { label: "inserts that changed the root", value: r.rootChanges },
        ]}
      />
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        A tree of 20,000 random keys. S and X count latch acquisitions on the root. Each acquire and each release writes the latch word, so every core that uses the root loses its cached copy.
      </p>
    </Demo>
  );
}
