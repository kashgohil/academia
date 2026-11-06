/** Demos for "Failure models": one quorum write under each failure model, and the quorum-size calculator. */
import { useMemo } from "react";
import { Banner, Demo, Panel, Param, Stats, range, select, toggle, useParams, useWidth, GOOD, BAD, MONO, tint } from "../../kit";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";
import { FAULT_TEXT, FIX_TEXT, FM, MODELS, MODEL_TEXT, replicatedWrite, type Model } from "../../sims/dist/foundations/failmodels";
import { QMODELS, QMODEL_TEXT, checkQuorum, nodesNeeded, quorumSize, type QModel } from "../../sims/dist/foundations/quorum";

// ============================================================================ 1. One write, every failure model

const FMS = {
  model: select({ label: "Failure model of replica R1", options: MODELS.map((m) => ({ value: m, label: MODEL_TEXT[m] })), default: "crash-recovery" as Model, segmented: true }),
  t: range({ label: "Time", min: 0, max: FM.end, step: 5, default: FM.end, format: (v) => `${v} ms` }),
  fix: toggle({ label: "Apply the fix for this model", default: false }),
};

export function FailureModelDemo() {
  const P = useParams("dist-fail-fm", FMS);
  const { model, t, fix } = P.values;
  const r = useMemo(() => replicatedWrite(model, fix), [model, fix]);
  const st = fromTrace(r.net, (m) => {
    const p = m.payload;
    if (p.k === "value") return `x=${p.val.x}`;
    return undefined;
  });
  const marks: StMark[] = [...st.marks];
  for (const e of r.net.trace) {
    if (e.kind === "recover") marks.push({ node: e.node, t: e.t, label: "restart", color: "var(--c2)" });
    if (e.kind === "note" && e.node === 0) marks.push({ node: 0, t: e.t, label: e.text, color: e.text === "committed" || e.text.startsWith("read") ? "var(--c1)" : "var(--c2)" });
    if (e.kind === "crash") marks.push({ node: e.node, t: e.t, until: e.t + (model === "crash-recovery" ? FM.recoverAt - FM.crashAt : FM.end - e.t), shape: "bar", label: "down", color: "var(--c4)" });
  }
  const names = ["client", ...Array.from({ length: r.n }, (_, i) => `R${i}`)];
  const done = t >= FM.end;
  return (
    <Demo
      title="One quorum write, six failure models"
      controls={<>
        <Param spec={FMS.t} value={t} onChange={(v) => P.set("t", v as number)} />
        <Param spec={FMS.fix} value={fix} onChange={(v) => P.set("fix", v as boolean)} />
        <Param spec={FMS.model} value={model} onChange={(v) => P.set("model", v as Model)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        The client writes x = 1 to every replica and reports "committed" after {model === "byzantine" && fix ? 3 : 2} acks. At {FM.readAt} ms it reads from R1 and R2. The network loses the write to R2 in every run.
      </div>
      <SpaceTime nodes={names} tEnd={FM.end} messages={st.messages} marks={marks} cursor={done ? undefined : t} rowHeight={44} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginTop: 8 }}>
        <Panel title="What R1 does"><div style={{ fontSize: 13.5 }}>{FAULT_TEXT[model]}</div></Panel>
        <Panel title={fix ? "Fix (on)" : "Fix (off)"} accent={fix ? GOOD : undefined}><div style={{ fontSize: 13.5 }}>{FIX_TEXT[model]}</div></Panel>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "client was told", value: t >= r.claimAt ? `${r.claim} at ${r.claimAt} ms` : "…" },
          { label: "the read returned", value: r.readAt !== undefined && t >= r.readAt ? `x = ${r.readValue}` : "…" },
          { label: "replica values at the end", value: <span style={{ fontFamily: MONO, fontSize: 13 }}>{r.stores.map((v, i) => `R${i}:${v?.x ?? "?"}`).join(" ")}</span> },
        ]} />
      </div>
      <Banner tone={!done ? "plain" : r.ok ? "good" : "bad"}>{done ? r.why : "Move the time slider to the end to see the outcome."}</Banner>
    </Demo>
  );
}

// ============================================================================ 2. How many nodes, how large a quorum

const QS = {
  model: select({ label: "Failure model", options: QMODELS.map((m) => ({ value: m, label: QMODEL_TEXT[m] })), default: "crash" as QModel, segmented: true }),
  f: range({ label: "Faulty nodes to tolerate, f", min: 1, max: 4, step: 1, default: 1 }),
  n: range({ label: "Nodes n (0 = the minimum)", min: 0, max: 13, step: 1, default: 0, format: (v) => (v === 0 ? "minimum" : String(v)) }),
  q: range({ label: "Quorum size q (0 = the minimum)", min: 0, max: 13, step: 1, default: 0, format: (v) => (v === 0 ? "minimum" : String(v)) }),
};

/** Two overlapping sets: quorum A is the first q nodes, quorum B the last q. That is the smallest overlap. */
function QuorumSets({ n, q, f, model }: { n: number; q: number; f: number; model: QModel }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(260, width);
  const step = Math.min(44, (W - 24) / n);
  const r = Math.min(13, step * 0.36);
  const x0 = (W - step * (n - 1)) / 2;
  const cx = (i: number) => x0 + i * step;
  const y = 62;
  const aEnd = q - 1, bStart = n - q;
  const overlap = Math.max(0, aEnd - bStart + 1);
  // The adversary puts the faulty nodes where they hurt most: inside the overlap for Byzantine, outside A otherwise.
  const faulty = new Set<number>();
  if (model === "byzantine") for (let i = bStart; i <= aEnd && faulty.size < f; i++) faulty.add(i);
  for (let i = n - 1; i >= 0 && faulty.size < f; i--) if (!faulty.has(i)) faulty.add(i);
  const box = (from: number, to: number, dy: number, color: string, label: string) =>
    from <= to && (
      <g>
        <rect x={cx(from) - r - 6} y={y - r - 8 + dy} width={cx(to) - cx(from) + 2 * r + 12} height={2 * r + 16} rx={10} fill={tint(color, 14)} stroke={color} strokeWidth={1.5} />
        <text x={cx(from) - r - 4} y={dy < 0 ? y - r - 14 + dy : y + r + 22 + dy} fontSize={11} fill={color}>{label}</text>
      </g>
    );
  return (
    <div ref={ref}>
      <svg width="100%" height={124} viewBox={`0 0 ${W} 124`} style={{ display: "block" }}>
        {q > 0 && box(0, aEnd, -4, "var(--c1)", `quorum A (${q})`)}
        {q > 0 && box(bStart, n - 1, 4, "var(--c5)", `quorum B (${q})`)}
        {Array.from({ length: n }, (_, i) => {
          const inBoth = i >= bStart && i <= aEnd;
          const bad = faulty.has(i);
          return (
            <g key={i}>
              <circle cx={cx(i)} cy={y} r={r} fill={inBoth ? "var(--fg)" : "var(--bg)"} stroke={bad ? "var(--c4)" : "var(--fg)"} strokeWidth={bad ? 2.5 : 1.5} />
              {bad && <path d={`M${cx(i) - r * 0.55} ${y - r * 0.55}l${r * 1.1} ${r * 1.1}m0 ${-r * 1.1}l${-r * 1.1} ${r * 1.1}`} stroke="var(--c4)" strokeWidth={2} />}
            </g>
          );
        })}
      </svg>
      <div className="muted" style={{ fontSize: 12 }}>
        Filled nodes are in both quorums ({overlap}). Red crosses are the f faulty nodes, placed by the adversary {model === "byzantine" ? "inside the overlap" : "where they block the most"}.
      </div>
    </div>
  );
}

export function QuorumCalcDemo() {
  const P = useParams("dist-fail-q", QS);
  const { model, f } = P.values;
  const minN = nodesNeeded(model, f);
  const n = P.values.n === 0 ? minN : P.values.n;
  const q = Math.min(n, P.values.q === 0 ? quorumSize(model, n, f) : P.values.q);
  const c = checkQuorum(model, n, q, f);
  const ok = c.live && c.safe && n >= minN;
  return (
    <Demo
      title="How many nodes do I need?"
      actions={<button className="btn ghost" onClick={() => { P.set("n", 0); P.set("q", 0); }}>Minimum</button>}
      controls={<>
        <Param spec={QS.f} value={f} onChange={(v) => P.set("f", v as number)} />
        <Param spec={QS.n} value={P.values.n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={QS.q} value={P.values.q} onChange={(v) => P.set("q", v as number)} />
        <Param spec={QS.model} value={model} onChange={(v) => P.set("model", v as QModel)} />
      </>}
    >
      {model === "sync-crash" ? (
        <div style={{ fontSize: 13.5, lineHeight: 1.5, margin: "4px 0 8px" }}>
          With a perfect failure detector, every node learns exactly which nodes crashed. A write goes to every live node, so no quorum is needed. {f + 1} copies leave one copy after {f} crashes.
        </div>
      ) : (
        <QuorumSets n={n} q={q} f={f} model={model} />
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "minimum nodes for this model", value: model === "sync-crash" ? `f + 1 = ${minN}` : model === "crash" ? `2f + 1 = ${minN}` : `3f + 1 = ${minN}` },
          { label: "nodes, quorum", value: `n = ${n}, q = ${q}` },
          { label: "a quorum forms with f down", value: <span style={{ color: c.live ? GOOD : BAD }}>{c.live ? `yes: ${q} ≤ ${n} − ${f}` : `no: ${q} > ${n} − ${f}`}</span> },
          { label: "smallest overlap of two quorums", value: <span style={{ color: c.safe ? GOOD : BAD }}>{`${c.overlap} (needs ${c.overlapNeeded})`}</span> },
        ]} />
      </div>
      <Banner tone={ok ? "good" : "bad"}>
        {model === "sync-crash"
          ? `${n} nodes tolerate ${f} crash${f > 1 ? "es" : ""}, but only because the detector never lies. In an asynchronous network, a slow node looks crashed.`
          : !c.live
            ? `With ${f} node${f > 1 ? "s" : ""} silent, only ${n - f} can answer, fewer than q = ${q}. The system stops.`
            : !c.safe
              ? model === "byzantine"
                ? `Two quorums can share only ${c.overlap} node${c.overlap === 1 ? "" : "s"}, and all of them can be liars. A read cannot trust what it sees.`
                : "Two quorums can be disjoint. A read can miss the last write completely."
              : `Safe and live: any two quorums share ${c.overlap} node${c.overlap === 1 ? "" : "s"}${model === "byzantine" ? `, so at least ${c.overlap - f} of them is correct` : ""}, and a quorum forms with ${f} node${f > 1 ? "s" : ""} down.`}
      </Banner>
    </Demo>
  );
}
