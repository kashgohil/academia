/** Demos for the lesson on sequential and causal consistency: a litmus matrix, and a reply seen before its question. */
import { useMemo, useState } from "react";
import { BAD, Banner, Chip, Demo, GOOD, MONO, Param, SmallLabel, Stats, fixed, range, toggle, useParams } from "../../kit";
import { DC_NAMES, LITMUS, MODEL_NAMES, checkModel, opLabel, runCausal, type ModelName } from "../../sims/dist/consistency";
import { SpaceTime, type StMark } from "./SpaceTime";
import { HistoryView } from "./ConsistencyUi";

const SHORT: Record<ModelName, string> = { linearizable: "Lin.", sequential: "Seq.", causal: "Causal", eventual: "Event." };

export function LitmusMatrixDemo() {
  const [pick, setPick] = useState(2);
  const verdicts = useMemo(() => LITMUS.map((l) => MODEL_NAMES.map((m) => checkModel(m, l.history))), []);
  const l = LITMUS[pick]!;
  const v = verdicts[pick]!;
  const byId = new Map(l.history.map((o) => [o.id, o]));
  const keys = new Set(l.history.map((o) => o.key)).size > 1;
  const tEnd = Math.max(...l.history.map((o) => o.ret)) + 5;
  const cell = { padding: "4px 4px", borderBottom: "1px solid var(--border)", textAlign: "center" as const };
  return (
    <Demo title="One history, four models: allowed or forbidden?">
      <SmallLabel>Tap a row to see its history. A check mark means the model allows the history.</SmallLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: "left", color: "var(--muted)", fontWeight: 600 }}>history</th>
              {MODEL_NAMES.map((m) => <th key={m} style={{ ...cell, color: "var(--muted)", fontWeight: 600 }}>{SHORT[m]}</th>)}
            </tr>
          </thead>
          <tbody>
            {LITMUS.map((x, i) => (
              <tr key={x.id} onClick={() => setPick(i)} style={{ cursor: "pointer", background: i === pick ? "var(--subtle)" : undefined, fontWeight: i === pick ? 600 : 400 }}>
                <td style={{ ...cell, textAlign: "left" }}>{x.name}</td>
                {verdicts[i]!.map((r, j) => (
                  <td key={j} style={cell}><span style={{ color: r.ok ? GOOD : BAD, fontFamily: MONO, fontWeight: 700 }}>{r.ok ? "✓" : "✗"}</span></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 13.5, marginBottom: 4 }}><b>{l.name}.</b> {l.story} Registers start at 0.</div>
        <HistoryView ops={l.history} tEnd={tEnd} keys={keys} rowHeight={36} timeLabel="real time" />
      </div>
      <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
        {MODEL_NAMES.map((m, j) => (
          <div key={m} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13 }}>
            <span style={{ minWidth: 92 }}><Chip color={v[j]!.ok ? GOOD : BAD} filled={!v[j]!.ok}>{m}</Chip></span>
            <span>
              {v[j]!.ok
                ? v[j]!.order ? <>allowed, for example in the order <span style={{ fontFamily: MONO }}>{v[j]!.order!.map((id) => opLabel(byId.get(id)!, true)).join(" ")}</span></> : m === "causal" ? "allowed: each client has a legal view that keeps the causal order." : "allowed: every value read was written by someone."
                : v[j]!.why}
            </span>
          </div>
        ))}
      </div>
    </Demo>
  );
}

// ============================================================================ reply before question

const CAUSAL_SCHEMA = {
  delay: range({ label: "Extra delay on the link DC1 → DC3", min: 0, max: 120, step: 5, default: 60, format: (v) => `${v} ms` }),
  causal: toggle({ label: "Send dependencies with each write", default: false }),
};

export function CausalReplyDemo() {
  const P = useParams("cons-causal", CAUSAL_SCHEMA);
  const { delay, causal } = P.values;
  const run = useMemo(() => runCausal({ qDelay: delay, causal }), [delay, causal]);
  const tEnd = Math.ceil((Math.max(run.qAt3, run.rAt3) + 20) / 10) * 10;
  const messages = run.net.messages.map((m) => ({ from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, label: m.payload.item + (m.payload.deps.length ? " (after Q)" : ""), color: m.payload.item === "Q" ? "var(--c1)" : "var(--c2)" }));
  const marks: StMark[] = [
    { node: 0, t: run.visible[0]![1]![0], color: "var(--c1)" },
    { node: 1, t: run.visible[1]!.find(([, xs]) => xs.includes("R"))![0], color: "var(--c2)" },
  ];
  if (run.held && Number.isFinite(run.held.until)) marks.push({ node: 2, t: run.held.from, until: run.held.until, shape: "bar", label: "R held", color: "var(--c3)" });
  if (run.anomaly) marks.push({ node: 2, t: run.anomaly.from, until: run.anomaly.until, shape: "bar", label: "R without Q", color: BAD });
  const view = run.visible[2]!;
  return (
    <Demo title="Carol sees the reply before the question" controls={<><Param spec={CAUSAL_SCHEMA.delay} value={delay} onChange={(x) => P.set("delay", x as number)} /><Param spec={CAUSAL_SCHEMA.causal} value={causal} onChange={(x) => P.set("causal", x as boolean)} /></>}>
      <SpaceTime nodes={DC_NAMES.map((n) => n.split(" ")[0]!)} tEnd={tEnd} messages={messages} marks={marks} rowHeight={50} />
      <SmallLabel style={{ marginTop: 6 }}>What Carol sees at DC3, in time order</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12.5 }}>
        {view.map(([t, xs], i) => {
          const bad = xs.includes("R") && !xs.includes("Q");
          return (
            <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <span className="muted" style={{ fontFamily: MONO }}>{fixed(t, 0)} ms</span>
              <Chip color={bad ? BAD : xs.length === 2 ? GOOD : "var(--muted)"} filled={bad}>{xs.length ? xs.map((x) => (x === "Q" ? "Q: party at 8?" : "R: yes!")).join(" + ") : "nothing"}</Chip>
              {i < view.length - 1 && <span className="muted">→</span>}
            </span>
          );
        })}
      </div>
      <Banner tone={run.anomaly ? "bad" : "good"}>
        {run.anomaly
          ? `For ${fixed(run.anomaly.until - run.anomaly.from, 1)} ms, DC3 shows the reply but not the question. No order of the writes explains this view, so it breaks causal consistency.`
          : causal && run.held
            ? `R reached DC3 first, but it carries the dependency Q. DC3 held it for ${fixed(run.held.until - run.held.from, 1)} ms, until Q arrived.`
            : "Q reached DC3 before R, so Carol saw them in causal order. Make the slow link slower."}
      </Banner>
      <Stats items={[
        { label: "Q visible at DC3", value: `${fixed(run.qAt3, 1)} ms` },
        { label: "R visible at DC3", value: `${fixed(run.rAt3, 1)} ms` },
        { label: "time in a bad state", value: `${fixed(run.anomaly ? run.anomaly.until - run.anomaly.from : 0, 1)} ms` },
      ]} />
    </Demo>
  );
}
