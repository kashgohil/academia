/** Demos for "Why distribute": availability and throughput of N replicas, and partial failure on Net. */
import { useMemo, useState } from "react";
import { Banner, Chip, Demo, Legend, Line, MiniTable, Panel, Param, Plot, RuleX, Stats, fixed, int, pct, range, sig, useParams, GOOD, BAD, MONO } from "../../kit";
import { SpaceTime, fromTrace, type StMark } from "./SpaceTime";
import { RULES, amdahl, availability, downtimeMinutesPerYear, needed, nines, type Rule } from "../../sims/dist/foundations/availability";
import { FATES, FATE_TEXT, PARTIAL, partialFailureRun, type Fate } from "../../sims/dist/foundations/partial";

// ============================================================================ 1. Availability and throughput of N nodes

const AV = {
  n: range({ label: "Nodes N", min: 1, max: 15, step: 1, default: 3 }),
  p: range({ label: "Chance that one node is down", min: 0.001, max: 0.2, log: true, default: 0.01, format: (v) => pct(v, v < 0.01 ? 2 : 1) }),
  s: range({ label: "Serial share of the work (Amdahl)", min: 0, max: 0.5, step: 0.01, default: 0.05, format: (v) => pct(v, 0) }),
};

const RULE_COLOR: Record<Rule, string> = { any: "var(--c3)", majority: "var(--c1)", all: "var(--c4)" };
const RULE_TEXT: Record<Rule, string> = { any: "any 1 of N", majority: "a majority of N", all: "all N" };
const MAX_NINES = 10;

function downtime(a: number) {
  const m = downtimeMinutesPerYear(a);
  if (m >= 60 * 24) return `${fixed(m / 60 / 24, 1)} days`;
  if (m >= 60) return `${fixed(m / 60, 1)} h`;
  if (m >= 1) return `${fixed(m, 1)} min`;
  return `${sig(m * 60, 2)} s`;
}

export function AvailabilityCalcDemo() {
  const P = useParams("dist-why-av", AV);
  const { n, p, s } = P.values;
  const lines = RULES.map((r) => ({ r, pts: Array.from({ length: 15 }, (_, i) => [i + 1, Math.min(MAX_NINES, nines(availability(r, i + 1, p)))] as [number, number]) }));
  const speed = amdahl(s, n);
  return (
    <Demo
      title="N replicas: availability and speedup"
      controls={<>
        <Param spec={AV.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={AV.p} value={p} onChange={(v) => P.set("p", v as number)} />
        <Param spec={AV.s} value={s} onChange={(v) => P.set("s", v as number)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, alignItems: "center" }}>
        {Array.from({ length: n }, (_, i) => <Chip key={i} color="var(--fg)">N{i + 1}</Chip>)}
        <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>each one down {pct(p, p < 0.01 ? 2 : 1)} of the time, independently</span>
      </div>
      <Plot x={[1, 15]} y={[0, MAX_NINES]} height={220} xLabel="nodes N" yLabel="availability in nines (clipped at 10)" xTicks={[1, 3, 5, 7, 9, 11, 13, 15]}>
        {lines.map(({ r, pts }) => <Line key={r} points={pts} color={RULE_COLOR[r]} />)}
        <RuleX at={n} color="var(--muted)" />
      </Plot>
      <Legend items={RULES.map((r) => ({ label: `needs ${RULE_TEXT[r]}`, color: RULE_COLOR[r] }))} />
      <MiniTable
        head={["needs", "up", "availability", "nines", "down / year"]}
        rows={RULES.map((r) => {
          const a = availability(r, n, p);
          return [<span style={{ color: RULE_COLOR[r] }}>{RULE_TEXT[r]}</span>, `${needed(r, n)} of ${n}`, a > 0.9999999 ? "> 99.99999%" : pct(a, 4), nines(a) > MAX_NINES ? "> 10" : fixed(nines(a), 1), downtime(a)];
        })}
      />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: `speedup with ${n} nodes`, value: `${fixed(speed, 2)}×` },
          { label: "speedup limit, 1 / serial share", value: s > 0 ? `${fixed(1 / s, 1)}×` : "none" },
          { label: "efficiency per node", value: pct(speed / n, 0) },
        ]} />
      </div>
      <Banner tone={availability("all", n, p) < 1 - p ? "bad" : "info"}>
        {n === 1
          ? "One node: every rule gives the same availability. Add nodes to see the rules split."
          : `A rule that needs all ${n} nodes is less available than one node (${pct(availability("all", n, p), 2)} against ${pct(1 - p, 2)}). Replication only helps when the system can continue without some nodes.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. Partial failure

const SVC = ["A", "B", "C"];

export function PartialFailureDemo() {
  const [fates, setFates] = useState<Fate[]>(["request-lost", "reply-lost", "slow"]);
  const { net, out } = useMemo(() => partialFailureRun(fates), [fates]);
  const st = fromTrace(net);
  const marks: StMark[] = [
    ...st.marks,
    { node: 0, t: PARTIAL.timeout, label: "timeout", color: "var(--c2)" },
    ...out.flatMap((o, i) => (o.appliedAt !== undefined ? [{ node: i + 1, t: o.appliedAt, label: "did it", color: GOOD }] : [])),
  ];
  const failing = out.filter((o) => o.clientSees === "no reply");
  const kinds = new Set(failing.map((o) => o.applied));
  return (
    <Demo title="Three calls, three failures, one view" actions={<button className="btn ghost" onClick={() => setFates(["request-lost", "reply-lost", "slow"])}>Reset</button>}>
      <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
        {SVC.map((name, i) => (
          <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <b style={{ width: 70, fontSize: 12.5 }}>service {name}</b>
            <div className="seg">
              {FATES.map((f) => (
                <button key={f} className={fates[i] === f ? "on" : ""} onClick={() => setFates(fates.map((x, j) => (j === i ? f : x)))}>{FATE_TEXT[f]}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <SpaceTime nodes={["client", "A", "B", "C"]} tEnd={PARTIAL.end} messages={st.messages} marks={marks} rowHeight={50} />
      <div className="muted" style={{ fontSize: 12 }}>Each arrow is a request (down) or a reply (up). A cross is a lost message or a message that reached a crashed service.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 8 }}>
        <Panel title={`What the client knows at ${PARTIAL.timeout} ms`}>
          {out.map((o, i) => (
            <div key={i} style={{ fontSize: 13, fontFamily: MONO }}>
              {SVC[i]}: <span style={{ color: o.clientSees === "reply" ? GOOD : "var(--c2)" }}>{o.clientSees}</span>
            </div>
          ))}
        </Panel>
        <Panel title="What really happened">
          {out.map((o, i) => (
            <div key={i} style={{ fontSize: 13 }}>
              <span style={{ fontFamily: MONO }}>{SVC[i]}:</span> {FATE_TEXT[o.fate]}.{" "}
              <span style={{ color: o.applied ? GOOD : BAD }}>{o.applied ? `Work done at ${int(o.appliedAt!)} ms` : "Work not done"}</span>
              {o.replyAt !== undefined && o.replyAt > PARTIAL.timeout && <span className="muted">, reply at {int(o.replyAt)} ms (too late)</span>}
            </div>
          ))}
        </Panel>
      </div>
      <Banner tone={kinds.size > 1 ? "bad" : failing.length ? "warn" : "good"}>
        {failing.length === 0
          ? "Every call worked. Choose a failure for one of the services."
          : kinds.size > 1
            ? `${failing.length} services show the same thing to the client: no reply. Some did the work and some did not. The client cannot tell which, so it cannot know if a retry is safe.`
            : `The client sees no reply from ${failing.length} service${failing.length > 1 ? "s" : ""}. Choose a different failure for another service and compare.`}
      </Banner>
    </Demo>
  );
}
