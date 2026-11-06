/** Demos for "Gossip and SWIM": a rumor spreading on a circle of nodes, and SWIM membership with a faulty member. */
import { useMemo } from "react";
import {
  Banner, Demo, Dots, Legend, Line, Param, Plot, SmallLabel, StepButtons, StepSlider, Stats, fixed, int, pct, range, seg,
  toggle, useChunked, useParams, useStepper, useWidth,
} from "../../kit";
import { SpaceTime, type StMessage, type StMark } from "./SpaceTime";
import { runSpread, pushRounds, pushPullRounds, type SpreadMode } from "../../sims/dist/data-systems/gossip";
import { probeFailP, runSwim, swimSummary, viewSpans, type SwimFault, type SwimState } from "../../sims/dist/data-systems/swim";

// ============================================================================ 1. A rumor on n nodes

const GS = {
  n: range({ label: "Nodes n", min: 8, max: 256, step: 8, default: 64 }),
  fanout: range({ label: "Fanout (peers per round)", min: 1, max: 4, step: 1, default: 1 }),
  loss: range({ label: "Message loss", min: 0, max: 0.5, step: 0.05, default: 0, format: (v) => pct(v, 0) }),
  mode: seg<SpreadMode>("Exchange", [["push", "push"], ["pull", "pull"], ["push-pull", "push-pull"]], "push"),
  stop: seg<"0" | "1" | "2" | "3">("Rumor mongering: stop after", [["0", "never"], ["1", "1 useless contact"], ["2", "2"], ["3", "3"]], "0"),
};

const SIZES = [8, 16, 32, 64, 128, 256, 512, 1024];
const SEEDS = 20;

export function GossipSpreadDemo() {
  const P = useParams("dist-ds-gossip", GS);
  const { n, fanout, loss, mode, stop } = P.values;
  const stopAfter = Number(stop);
  const run = useMemo(() => runSpread({ n, mode, fanout, dropRate: loss, stopAfter, seed: 7 }), [n, mode, fanout, loss, stopAfter]);
  const s = useStepper(run.rounds + 1, 2.5);
  const r = s.i;
  const [ref, width] = useWidth<HTMLDivElement>();
  const size = Math.min(320, Math.max(220, width));
  const c = size / 2, R = size / 2 - 14;
  const pos = (i: number) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    return [c + R * Math.cos(a), c + R * Math.sin(a)] as const;
  };
  const dot = Math.max(2.2, Math.min(6, 90 / Math.sqrt(n) / 1.6));
  const informed = run.counts[r] ?? run.counts[run.counts.length - 1]!;

  const key = `${mode}|${fanout}|${loss}|${stopAfter}`;
  const jobs = useMemo(() => SIZES.map((size) => () => {
    const rs: number[] = [];
    for (let sd = 1; sd <= SEEDS; sd++) {
      const x = runSpread({ n: size, mode, fanout, dropRate: loss, stopAfter, seed: sd });
      if (x.roundsToAll !== null) rs.push(x.roundsToAll);
    }
    return { n: size, mean: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN, max: rs.length ? Math.max(...rs) : NaN, done: rs.length / SEEDS };
  }), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const sweep = useChunked(key, jobs, { keep: true }).filter((x): x is NonNullable<typeof x> => !!x);
  const pts = sweep.filter((x) => Number.isFinite(x.mean));
  const yMax = Math.max(22, ...pts.map((p) => p.max + 2));

  return (
    <Demo
      title="Epidemic spread of one rumor"
      controls={<>
        <Param spec={GS.n} value={n} onChange={(v) => P.set("n", v as number)} />
        <Param spec={GS.fanout} value={fanout} onChange={(v) => P.set("fanout", v as number)} />
        <Param spec={GS.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
        <Param spec={GS.mode} value={mode} onChange={(v) => P.set("mode", v as SpreadMode)} />
        <Param spec={GS.stop} value={stop} onChange={(v) => P.set("stop", v as typeof stop)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <div ref={ref} style={{ flex: "1 1 220px", minWidth: 0, maxWidth: 340 }}>
          <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ display: "block", maxWidth: size }} role="img" aria-label="nodes on a circle">
            {run.from.map((f, i) => {
              const at = run.informedAt[i];
              if (f < 0 || at === null || at !== r) return null;
              const [x1, y1] = pos(f), [x2, y2] = pos(i);
              return <line key={`e${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--c2)" strokeWidth={1} opacity={0.7} />;
            })}
            {Array.from({ length: n }, (_, i) => {
              const [x, y] = pos(i);
              const at = run.informedAt[i];
              const on = at != null && at <= r;
              const fresh = on && at === r && r > 0;
              return <circle key={i} cx={x} cy={y} r={i === 0 ? dot + 1.5 : dot} fill={fresh ? "var(--c2)" : on ? "var(--c1)" : "var(--bg)"} stroke={on ? "none" : "var(--faint)"} strokeWidth={1} />;
            })}
            <text x={c} y={c - 4} textAnchor="middle" fontSize="22" fill="var(--fg)" style={{ fontVariantNumeric: "tabular-nums" }}>{informed} / {n}</text>
            <text x={c} y={c + 16} textAnchor="middle" fontSize="12" fill="var(--muted)">after round {r}</text>
          </svg>
          <Legend items={[{ label: "knows the rumor", color: "var(--c1)" }, { label: "learned it this round", color: "var(--c2)" }, { label: "does not know", color: "var(--faint)" }]} />
        </div>
        <div style={{ flex: "2 1 300px", minWidth: 0 }}>
          <SmallLabel>Rounds until every node knows, over {SEEDS} seeds per n (dots: mean; faint: worst)</SmallLabel>
          <Plot x={[8, 1024]} y={[0, yMax]} logX height={220} xTicks={SIZES} xFormat={(v) => String(v)} xLabel="nodes n (log scale)" yLabel="rounds to reach all">
            <Line points={SIZES.map((m) => [m, pushRounds(m)] as [number, number])} color="var(--faint)" dash="4 3" width={1.4} />
            <Line points={SIZES.map((m) => [m, pushPullRounds(m)] as [number, number])} color="var(--c3)" dash="4 3" width={1.4} />
            <Line points={pts.map((p) => [p.n, p.mean] as [number, number])} color="var(--c1)" />
            <Dots points={pts.map((p) => [p.n, p.mean] as [number, number])} color="var(--c1)" r={3} />
            <Dots points={pts.map((p) => [p.n, p.max] as [number, number])} color="var(--muted)" r={2} />
          </Plot>
          <Legend items={[{ label: "this setting", color: "var(--c1)" }, { label: "log₂ n + ln n (push)", color: "var(--faint)" }, { label: "log₃ n (push-pull)", color: "var(--c3)" }]} />
        </div>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}><StepButtons s={s} /></div>
      <StepSlider s={s} label="Round" />
      <Stats items={[
        { label: "rounds to reach all (this run)", value: run.roundsToAll === null ? "never" : run.roundsToAll },
        { label: "messages per node", value: fixed(run.messages / n, 1) },
        { label: "nodes that never learn it", value: int(n - run.counts[run.counts.length - 1]!) },
        { label: "runs that reached all, at n = 1024", value: pts.length === SIZES.length ? pct(sweep[sweep.length - 1]!.done, 0) : "…" },
      ]} />
      <Banner tone={run.roundsToAll === null ? "bad" : "good"}>
        {run.roundsToAll === null
          ? `The rumor died out after ${run.rounds} rounds and ${int(n - run.counts[run.counts.length - 1]!)} nodes never learned it. Rumor mongering trades this residue for fewer messages; anti-entropy repairs it later.`
          : `Every node knew after ${run.roundsToAll} rounds. Each doubling of n adds only one or two rounds: the time grows with log n, not with n.`}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. SWIM with a faulty member

const SW = {
  k: range({ label: "Indirect probes k (0 = direct ping only)", min: 0, max: 4, step: 1, default: 3 }),
  loss: range({ label: "Message loss", min: 0, max: 0.2, step: 0.01, default: 0, format: (v) => pct(v, 0) }),
  fault: seg<SwimFault>("Member 3 is", [["slow", "slow"], ["isolate", "cut off for 3 s"], ["crash", "crashed"], ["none", "healthy"]], "slow"),
  suspicion: toggle({ label: "Suspicion before death", default: true }),
  ep: range({ label: "Probe shown in the diagram", min: 1, max: 12, step: 1, default: 1 }),
};

const N = 8, FAULTY = 3, HORIZON = 20_000, LONG = 300_000;
const STATE_COLOR: Record<SwimState, string> = { alive: "var(--subtle)", suspect: "var(--c2)", dead: "var(--c4)" };

export function SwimDemo() {
  const P = useParams("dist-ds-swim", SW);
  const { k, loss, fault, suspicion, ep } = P.values;
  const f = { node: FAULTY, kind: fault, at: 2000, until: fault === "isolate" ? 5000 : Infinity, slowMean: 300 };
  const run = useMemo(() => runSwim({ k, dropRate: loss, suspicion, fault: f, horizon: HORIZON }), [k, loss, suspicion, fault]); // eslint-disable-line react-hooks/exhaustive-deps
  const long = useMemo(() => runSwim({ k, dropRate: loss, suspicion, fault: { ...f, until: fault === "isolate" ? 5000 : Infinity }, horizon: LONG }), [k, loss, suspicion, fault]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = swimSummary(run), ls = swimSummary(long);
  // Episodes: probes that needed ping-req (of member 3 first), else plain probes of member 3.
  const reqs = run.net.messages.filter((m) => m.payload.k === "ping-req");
  const about3 = reqs.filter((m) => m.payload.k === "ping-req" && m.payload.target === FAULTY);
  const starts = (about3.length ? about3 : reqs).map((m) => m.sentAt - 500);
  const pings3 = run.net.messages.filter((m) => m.to === FAULTY && m.payload.k === "ping" && m.sentAt > 2000).map((m) => m.sentAt);
  const eps = [...new Set((starts.length ? starts : pings3).map((t) => Math.round(t)))].filter((t, i, a) => i === 0 || t - a[i - 1]! > 50);
  const epi = Math.min(ep, Math.max(1, eps.length)) - 1;
  const w0 = Math.max(0, (eps[epi] ?? 2000) - 60), w1 = w0 + 1100;
  // The members in this probe: the prober, the target and the helpers it asked.
  const epReqs = reqs.filter((m) => m.sentAt >= w0 && m.sentAt <= w0 + 600 && (!about3.length || (m.payload.k === "ping-req" && m.payload.target === FAULTY)));
  const cast = new Set<number>(epReqs.length ? [epReqs[0]!.from, ...epReqs.filter((m) => m.from === epReqs[0]!.from).flatMap((m) => [m.to, m.payload.k === "ping-req" ? m.payload.target : FAULTY])] : [FAULTY, ...run.net.messages.filter((m) => m.to === FAULTY && m.sentAt >= w0 && m.sentAt <= w1).map((m) => m.from)]);
  const msgs: StMessage[] = run.net.messages
    .filter((m) => m.sentAt >= w0 && (m.deliveredAt ?? m.lostAt ?? m.sentAt) <= w1 && cast.has(m.from) && cast.has(m.to) && (m.from === FAULTY || m.to === FAULTY || m.payload.k === "ping-req" || (m.payload.k === "ack" && m.to === epReqs[0]?.from)))
    .map((m) => ({
      from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt,
      color: m.payload.k === "ping-req" ? "var(--c1)" : m.payload.k === "sync" || m.payload.k === "sync-reply" ? "var(--faint)" : undefined,
      label: m.payload.k === "ping-req" ? "req" : undefined,
    }));
  const marks: StMark[] = [
    ...run.origins.filter((o) => o.t >= w0 && o.t <= w1).map((o) => ({ node: o.by, t: o.t, color: o.real ? "var(--c1)" : "var(--c4)", label: `${o.kind} ${o.target}` })),
    ...run.refutes.filter((x) => x.t >= w0 && x.t <= w1).map((x) => ({ node: x.node, t: x.t, color: "var(--c3)", label: "refute" })),
    ...(fault === "crash" && f.at >= w0 && f.at <= w1 ? [{ node: FAULTY, t: f.at, shape: "cross" as const }] : []),
  ];
  const others = Array.from({ length: N }, (_, i) => i).filter((i) => i !== FAULTY);
  const expectFail = loss > 0 && fault === "none" ? probeFailP(loss, k) : null;
  const probes = long.probes.direct + long.probes.indirect + long.probes.failed;

  return (
    <Demo
      title="SWIM: probes, ping-req and suspicion"
      controls={<>
        <Param spec={SW.k} value={k} onChange={(v) => P.set("k", v as number)} />
        <Param spec={SW.loss} value={loss} onChange={(v) => P.set("loss", v as number)} />
        <Param spec={SW.fault} value={fault} onChange={(v) => P.set("fault", v as SwimFault)} />
        <Param spec={SW.suspicion} value={suspicion} onChange={(v) => P.set("suspicion", v as boolean)} />
        <Param spec={{ ...SW.ep, format: (v: number) => `${Math.min(v, Math.max(1, eps.length))} of ${eps.length}` }} value={ep} onChange={(v) => P.set("ep", v as number)} />
      </>}
    >
      <SmallLabel>What each member thinks of member 3 over 20 s (period 1 s, ack timeout 500 ms; the fault starts at 2 s)</SmallLabel>
      <TimelineRows rows={others.map((i) => ({ label: `m${i}`, spans: viewSpans(run, i, FAULTY) }))} faultRow={{ label: "m3", kind: fault, at: f.at, until: Math.min(f.until, HORIZON) }} />
      <Legend items={[{ label: "suspect", color: "var(--c2)" }, { label: "dead", color: "var(--c4)" }, { label: "member 3 slow, cut off or crashed", color: "var(--c1)" }]} />
      <SmallLabel style={{ marginTop: 10 }}>{starts.length ? `A probe that needed ping-req (blue), ${fixed(w0 / 1000, 2)} s to ${fixed(w1 / 1000, 2)} s.` : `A probe of member 3, ${fixed(w0 / 1000, 2)} s to ${fixed(w1 / 1000, 2)} s.`} Only messages among the members in this probe. Red dot: a failed probe of a member that could be reached.</SmallLabel>
      <SpaceTime nodes={Array.from({ length: N }, (_, i) => `m${i}`)} tStart={w0} tEnd={w1} messages={msgs} marks={marks} rowHeight={30} />
      <Stats items={[
        { label: "false suspicions in 20 s", value: sum.falseSusp },
        { label: "false suspicions in 300 s", value: ls.falseSusp },
        { label: "times a live member was declared dead (300 s)", value: ls.deadAboutLive },
        { label: "messages per member per period", value: fixed(ls.msgsPerMemberPerPeriod, 2) },
        ...(fault === "crash" ? [{ label: "crash at 2 s: first suspicion, all say dead", value: `${fixed((sum.firstSuspectAt ?? NaN) / 1000, 1)} s, ${sum.allDeadAt ? fixed(sum.allDeadAt / 1000, 1) + " s" : "not yet"}` }] : []),
        ...(expectFail !== null ? [{ label: "failed probes (300 s): measured, formula", value: `${long.probes.failed}, ${fixed(expectFail * probes, 1)}` }] : []),
      ]} />
      <Banner tone={ls.deadAboutLive > 0 ? "bad" : ls.falseSusp > 0 ? "warn" : "good"}>
        {fault === "crash"
          ? `The crash is found by the first member that probes member 3. ${suspicion ? `Suspicion adds ${fixed(run.suspicionTimeout / 1000, 1)} s before it is declared dead.` : "Without suspicion it is declared dead at once."}`
          : ls.deadAboutLive > 0
            ? `Live members were declared dead ${ls.deadAboutLive} times in 300 s. ${k === 0 ? "Add indirect probes: each one is another independent path to the target." : suspicion ? "The suspicion timeout was too short to refute them all." : "Turn on suspicion so that a member can refute a wrong verdict."}`
            : ls.falseSusp > 0
              ? `${ls.falseSusp} failed probes of live members in 300 s, but every suspicion was refuted in time: no live member was declared dead.`
              : `No false suspicions in 300 s. ${k > 0 && fault === "slow" ? `Ping-req rescued ${long.probes.indirect} probes that the direct ping alone would have failed.` : ""}`}
      </Banner>
    </Demo>
  );
}

/** Rows of colored spans on a shared time axis (0 to 20 s). */
function TimelineRows({ rows, faultRow }: { rows: { label: string; spans: [number, number, SwimState][] }[]; faultRow: { label: string; kind: SwimFault; at: number; until: number } }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const left = 34, right = 8, rh = 14, w = Math.max(240, width);
  const x = (t: number) => left + (t / HORIZON) * (w - left - right);
  const h = (rows.length + 1) * rh + 18;
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }} role="img" aria-label="views of member 3 over time">
        <text x={left - 6} y={rh - 3} textAnchor="end" fontSize="10.5" fill="var(--muted)">{faultRow.label}</text>
        <rect x={x(0)} y={2} width={x(HORIZON) - x(0)} height={rh - 4} fill="var(--subtle)" />
        {faultRow.kind !== "none" && <rect x={x(faultRow.at)} y={2} width={Math.max(1, x(faultRow.until) - x(faultRow.at))} height={rh - 4} fill="var(--c1)" opacity={0.55} />}
        {rows.map((r, i) => (
          <g key={r.label}>
            <text x={left - 6} y={(i + 2) * rh - 3} textAnchor="end" fontSize="10.5" fill="var(--muted)">{r.label}</text>
            {r.spans.map(([a, b, s], j) => <rect key={j} x={x(a)} y={(i + 1) * rh + 2} width={Math.max(0.8, x(b) - x(a))} height={rh - 4} fill={STATE_COLOR[s]} />)}
          </g>
        ))}
        {[0, 5, 10, 15, 20].map((s) => <text key={s} x={x(s * 1000)} y={h - 3} textAnchor="middle" fontSize="10" fill="var(--faint)">{s} s</text>)}
      </svg>
    </div>
  );
}
