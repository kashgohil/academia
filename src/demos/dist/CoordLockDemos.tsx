/** Demos for "Distributed locks": Redlock with an adversary, and lock only versus lock + fencing over many seeds. */
import { useMemo } from "react";
import { Banner, Btn, ButtonRow, Demo, Legend, Line, MiniTable, Param, Plot, RuleX, SmallLabel, Stats, BAD, GOOD, int, pct, range, seg, toggle, useChunked, useParams } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { C1, C2, REDIS_NODES, redlockDrift, redlockRun, type RedlockCfg } from "../../sims/dist/coordination/redlock";
import { fencingSweepPoint } from "../../sims/dist/coordination/fencing";
import type { FenceMode } from "../../sims/dist/coordination/lease";

// ============================================================================ 1. Redlock

const RL = {
  jump: range({ label: "C's clock jump at 100 ms", min: 0, max: 1500, step: 100, default: 0, format: (v) => `${v} ms` }),
  pause: range({ label: "Client 1 pause after a check", min: 0, max: 2000, step: 100, default: 0, format: (v) => `${v} ms` }),
  cut1: toggle({ label: "Client 1 cannot reach D and E (0–120 ms)", default: true }),
  cut2: toggle({ label: "Client 2 cannot reach A and B (from 120 ms)", default: true }),
  crash: seg("Node C at 130 ms", [["none", "keeps running"], ["restart", "restarts, no data"], ["delayed", "restarts after one TTL"]], "none"),
};
const RL_NAMES = ["A", "B", "C", "D", "E", "client 1", "client 2"];
const CC = { [C1]: "var(--c1)", [C2]: "var(--c2)" } as Record<number, string>;
const TTL = 1000;

export function CoordRedlockDemo() {
  const P = useParams("coord-redlock", RL);
  const { jump, pause, cut1, cut2, crash } = P.values;
  const cfg: Partial<RedlockCfg> = { ttl: TTL, jumpC: jump, pause1: pause, cut1, cut2, crashC: crash };
  const r = useMemo(() => redlockRun(cfg), [jump, pause, cut1, cut2, crash]); // eslint-disable-line react-hooks/exhaustive-deps
  const preset = (p: Partial<typeof P.values>) => {
    const all = { jump: 0, pause: 0, cut1: false, cut2: false, crash: "none" as const, ...p };
    (Object.keys(all) as (keyof typeof all)[]).forEach((k) => P.set(k, all[k] as never));
  };
  const messages: StMessage[] = r.net.messages.map((m) => {
    const p = m.payload;
    const base = { from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt, lostAt: m.lost === "dropped" ? undefined : m.lostAt };
    if (p.k === "set") return { ...base, color: CC[m.from] };
    if (p.k === "res") return { ...base, color: p.ok ? CC[m.to] : "var(--faint)", dashed: !p.ok };
    return { ...base, color: "var(--faint)", dashed: true };
  });
  const marks: StMark[] = [
    ...r.keys.map((k) => ({ node: k.node, t: k.from, until: k.to, shape: "bar" as const, color: CC[k.client] })),
    ...r.acting.map((a) => ({ node: a.client, t: a.from, until: a.to, shape: "bar" as const, label: "holds", color: CC[a.client] })),
    ...(r.pause ? [{ node: C1, t: r.pause.from, until: r.pause.to, shape: "bar" as const, label: "paused", color: BAD }] : []),
    ...r.attempts.filter((a) => a.ok || a.client === C1).map((a) => ({ node: a.client, t: a.end, label: `${a.got}/5`, color: a.ok ? GOOD : "var(--muted)" })),
    ...r.net.trace.flatMap((e) => (e.kind === "crash" ? [{ node: e.node, t: e.t, shape: "cross" as const }] : [])),
    ...(jump ? [{ node: 2, t: 100, label: `+${jump} ms`, color: BAD }] : []),
  ];
  const a2 = r.attempts.filter((a) => a.client === C2);
  const won2 = a2.find((a) => a.ok);
  return (
    <Demo
      title="Redlock with five nodes: you are the adversary"
      controls={<>
        <Param spec={RL.jump} value={jump} onChange={(v) => P.set("jump", v as number)} />
        <Param spec={RL.pause} value={pause} onChange={(v) => P.set("pause", v as number)} />
        <Param spec={RL.cut1} value={cut1} onChange={(v) => P.set("cut1", v as boolean)} />
        <Param spec={RL.cut2} value={cut2} onChange={(v) => P.set("cut2", v as boolean)} />
        <Param spec={RL.crash} value={crash} onChange={(v) => P.set("crash", v as "none" | "restart" | "delayed")} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>Scenarios:</span>
        <Btn onClick={() => preset({ cut1: true, cut2: true, jump: 1000 })}>Clock jump on C</Btn>
        <Btn onClick={() => preset({ cut1: true, cut2: true, crash: "restart" })}>C restarts empty</Btn>
        <Btn onClick={() => preset({ pause: 1500 })}>GC pause</Btn>
        <Btn ghost onClick={() => preset({})}>No faults</Btn>
      </ButtonRow>
      <SpaceTime nodes={RL_NAMES} tEnd={r.tEnd} messages={messages} marks={marks} rowHeight={38} />
      <Legend items={[{ label: "client 1: SET and its key", color: "var(--c1)" }, { label: "client 2", color: "var(--c2)" }, { label: "failed SET, DEL", color: "var(--faint)" }, { label: "pause, clock jump", color: BAD }]} />
      <Stats items={[
        { label: "client 1 got", value: `${r.attempts.find((a) => a.client === C1)?.got ?? 0} of ${REDIS_NODES}` },
        { label: "client 2 tries", value: a2.length },
        { label: "client 2 won at", value: won2 ? `${int(won2.end)} ms` : "never" },
        { label: "validity (TTL − elapsed − drift)", value: `${int(r.attempts[0]?.validity ?? 0)} ms` },
      ]} />
      <Banner tone={r.overlap ? "bad" : "good"}>
        {r.overlap
          ? `Both clients act as the lock holder from ${int(r.overlap.from)} to ${int(r.overlap.to)} ms. Mutual exclusion is broken, and no token tells the storage which one is current.`
          : won2
            ? "Client 2 got the lock only after client 1 stopped. Mutual exclusion held in this run."
            : "Client 2 never reached a majority while client 1 held the lock. Mutual exclusion held in this run."}
      </Banner>
      <SmallLabel style={{ marginTop: 8 }}>TTL {TTL} ms, drift allowance {redlockDrift(TTL)} ms, per-node SET timeout 50 ms. A bar on a node is a key with its owner's color. A label such as 3/5 is the result of one attempt.</SmallLabel>
    </Demo>
  );
}

// ============================================================================ 2. Lock only versus lock + fencing

const FC = {
  maxPause: range({ label: "Max pause (marker)", min: 0, max: 1200, step: 100, default: 600, format: (v) => `${v} ms` }),
  prob: range({ label: "Chance of a pause before a write", min: 0.05, max: 0.6, step: 0.05, default: 0.3, format: (v) => pct(v, 0) }),
  ttl: range({ label: "Lease TTL", min: 100, max: 600, step: 50, default: 300, format: (v) => `${v} ms` }),
};
const XS = Array.from({ length: 13 }, (_, i) => i * 100);
const MODES: [FenceMode, string, string, string][] = [
  ["none", "lock only", "var(--c4)", "lock only"],
  ["writes", "token checked on writes only", "var(--c2)", "writes only"],
  ["all", "token checked on every access", "var(--c3)", "every access"],
];
export const FENCE_SEEDS = 40;

export function CoordFencingCompareDemo() {
  const P = useParams("coord-fence", FC);
  const { maxPause, prob, ttl } = P.values;
  const jobs = useMemo(() => MODES.flatMap(([mode]) => XS.map((x) => () => fencingSweepPoint({ mode, maxPause: x, pauseProb: prob, ttl }, FENCE_SEEDS))), [prob, ttl]);
  const res = useChunked(`${prob}/${ttl}`, jobs, { keep: true });
  const series = MODES.map((_, k) => XS.flatMap((x, i) => {
    const r = res[k * XS.length + i];
    return r ? [[x, (100 * r.lost) / Math.max(1, r.acked)] as [number, number]] : [];
  }));
  const at = MODES.map((_, k) => res[k * XS.length + XS.indexOf(maxPause)]);
  const yMax = Math.max(5, ...series.flat().map((p) => p[1])) * 1.1;
  return (
    <Demo
      title="Lost updates: lock only versus lock + fencing"
      controls={<>
        <Param spec={FC.maxPause} value={maxPause} onChange={(v) => P.set("maxPause", v as number)} />
        <Param spec={FC.prob} value={prob} onChange={(v) => P.set("prob", v as number)} />
        <Param spec={FC.ttl} value={ttl} onChange={(v) => P.set("ttl", v as number)} />
      </>}
    >
      <SmallLabel>3 clients, 12 increments each, {FENCE_SEEDS} seeds per point. Each increment: lease, read, check the lease, maybe pause, write.</SmallLabel>
      <Plot x={[0, 1200]} y={[0, yMax]} height={220} xLabel="max pause (ms)" yLabel="lost updates per 100 acknowledged">
        <RuleX at={ttl} label="TTL" />
        <RuleX at={maxPause} color="var(--c1)" dash="2 3" />
        {series.map((s, k) => <Line key={k} points={s} color={MODES[k]![2]} />)}
      </Plot>
      <Legend items={MODES.map(([, label, color]) => ({ label, color }))} />
      <MiniTable
        head={[`at ${maxPause} ms`, "acked", "lost", "rejected", "bad runs"]}
        rows={MODES.map(([, , color, label], k) => {
          const r = at[k];
          return [<span style={{ color }}>{label}</span>, r ? r.acked : "…", r ? <span style={{ color: r.lost ? BAD : GOOD }}>{r.lost}</span> : "…", r ? r.rejected : "…", r ? `${r.badRuns}/${r.seeds}` : "…"];
        })}
      />
      <Banner tone={at[0]?.lost ? "bad" : "plain"}>
        {at[0] && at[2]
          ? at[0].lost
            ? `With pauses up to ${maxPause} ms, the lock alone lost ${at[0].lost} of ${at[0].acked} acknowledged increments. Tokens on every access lost ${at[2].lost}: the storage rejected ${at[2].rejected} late requests instead.`
            : `With pauses up to ${maxPause} ms, no pause outlives the lease by enough, so even the lock alone lost nothing. Move the marker past the TTL.`
          : "Running the seeds…"}
      </Banner>
    </Demo>
  );
}
