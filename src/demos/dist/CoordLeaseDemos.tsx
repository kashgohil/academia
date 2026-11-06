/** Demos for "Leases and fencing tokens": a lease timeline with a pause, and the safety margin a lease needs. */
import { useMemo, useState } from "react";
import { Banner, Btn, Demo, Dots, Legend, Line, MiniTable, Param, Plot, RuleY, Stats, BAD, GOOD, fixed, int, pct, range, seg, sig, toggle, useParams } from "../../kit";
import { SpaceTime, type StMark, type StMessage } from "./SpaceTime";
import { LT, leaseTimeline, marginNeeded, type LeaseMsg } from "../../sims/dist/coordination/lease";

// ============================================================================ 1. Lease timeline

const TL = {
  pause: range({ label: "Pause length", min: 0, max: 1500, step: 50, default: 900, format: (v) => `${v} ms` }),
  where: seg("The pause starts", [["afterCheck", "after A checks its lease"], ["beforeCheck", "before A checks"]], "afterCheck"),
  clockStops: toggle({ label: "A's clock stops while A is paused", default: false }),
  fence: toggle({ label: "Storage checks fencing tokens", default: false }),
};

const COL = { [LT.A]: "var(--c1)", [LT.B]: "var(--c2)" } as Record<number, string>;
const NAMES = ["lock", "client A", "client B", "storage"];

export function CoordLeaseTimelineDemo() {
  const P = useParams("coord-lease", TL);
  const { where, clockStops, fence } = P.values;
  const [pauseOn, setPauseOn] = useState(true);
  const pause = pauseOn ? P.values.pause : 0;
  const r = useMemo(() => leaseTimeline({ pause, pauseWhere: where, clockStops, fence: fence ? "all" : "none" }), [pause, where, clockStops, fence]);

  const messages: StMessage[] = r.net.messages.map((m) => {
    const p = m.payload as LeaseMsg;
    const base = { from: m.from, to: m.to, sentAt: m.sentAt, deliveredAt: m.deliveredAt };
    if (p.k === "grant") return { ...base, label: `token ${p.token}`, color: COL[m.to] };
    if (p.k === "write") {
      const op = r.store.ops.find((o) => o.kind === "write" && o.from === m.from && Math.abs(o.t - (m.deliveredAt ?? -1)) < 1e-6);
      return { ...base, label: String(p.value), color: op?.stale ? BAD : COL[m.from] };
    }
    return { ...base, color: "var(--faint)" };
  });
  const marks: StMark[] = [
    ...r.svc.leases.map((l) => ({ node: LT.svc, t: l.from, until: l.until, shape: "bar" as const, label: `lease ${l.token}`, color: COL[l.client] })),
    ...r.beliefs.map((b) => ({ node: b.client, t: b.from, until: b.to, shape: "bar" as const, label: "holds", color: COL[b.client] })),
    ...(r.pauseA ? [{ node: LT.A, t: r.pauseA.from, until: r.pauseA.to, shape: "bar" as const, label: "paused", color: BAD }] : []),
    ...r.store.ops.filter((o) => o.kind === "write").map((o) => o.ok
      ? { node: LT.store, t: o.t, color: o.stale ? BAD : COL[o.from] }
      : { node: LT.store, t: o.t, shape: "cross" as const, label: "rejected", color: BAD }),
  ];
  const stale = r.staleAccepted[0];
  const rej = r.rejected[0];
  const writes = r.store.ops.filter((o) => o.kind === "write");
  return (
    <Demo
      title="A lease, a pause and a stale write"
      actions={<Btn on={pauseOn} onClick={() => setPauseOn(!pauseOn)}>{pauseOn ? "A pauses (click to stop)" : "Pause client A"}</Btn>}
      controls={<>
        <Param spec={TL.pause} value={P.values.pause} onChange={(v) => P.set("pause", v as number)} />
        <Param spec={TL.where} value={where} onChange={(v) => P.set("where", v as "afterCheck" | "beforeCheck")} />
        <Param spec={TL.clockStops} value={clockStops} onChange={(v) => P.set("clockStops", v as boolean)} />
        <Param spec={TL.fence} value={fence} onChange={(v) => P.set("fence", v as boolean)} />
      </>}
    >
      <SpaceTime nodes={NAMES} tEnd={r.tEnd} messages={messages} marks={marks} rowHeight={50} />
      <Legend items={[{ label: "client A (token 1)", color: "var(--c1)" }, { label: "client B (token 2)", color: "var(--c2)" }, { label: "stale write or pause", color: BAD }, { label: "acquire, renew, replies", color: "var(--faint)" }]} />
      <Stats items={[
        { label: "both believe they hold it", value: r.overlap ? `${int(r.overlap.to - r.overlap.from)} ms` : "never" },
        { label: "stale writes accepted", value: <span style={{ color: r.staleAccepted.length ? BAD : undefined }}>{r.staleAccepted.length}</span> },
        { label: "writes rejected", value: r.rejected.length },
        { label: "final value in storage", value: r.final },
      ]} />
      <MiniTable
        head={["at (ms)", "from", "token", "value", "result"]}
        rows={writes.map((o) => [int(o.t), o.from === LT.A ? "A" : "B", o.token, o.value,
          <span style={{ color: !o.ok ? BAD : o.stale ? BAD : GOOD }}>{!o.ok ? "rejected: saw token 2" : o.stale ? "accepted, but stale" : "accepted"}</span>])}
        highlight={(i) => writes[i]!.stale || !writes[i]!.ok}
      />
      <Banner tone={stale ? "bad" : rej ? "good" : r.overlap ? "warn" : "good"}>
        {stale
          ? `A's write ${stale.value} arrived at ${int(stale.t)} ms with token ${stale.token}, after B had the lease with token ${r.svc.latestTokenAt(stale.t)}. The storage accepted it, so B's data is gone.`
          : rej
            ? `The storage rejected A's write with token ${rej.token}, because it had already seen token ${r.svc.latestTokenAt(rej.t)}. The lease still failed, but the data is safe.`
            : r.overlap
              ? "Both clients believed they held the lease for a while, but A noticed before it wrote. Nothing reached the storage out of order."
              : "The lease worked: B got it only after A was done or knew it had lost it."}
      </Banner>
    </Demo>
  );
}

// ============================================================================ 2. The safety margin

const MG = {
  ttl: range({ label: "Lease length", min: 100, max: 60000, default: 10000, log: true, format: (v) => (v >= 1000 ? `${sig(v / 1000, 3)} s` : `${v} ms`) }),
  rho: range({ label: "Clock drift bound ρ", min: 1, max: 100000, default: 100, log: true, format: (v) => `${sig(v, 3)} ppm` }),
  delay: range({ label: "Max network delay", min: 0, max: 200, step: 1, default: 10, format: (v) => `${v} ms` }),
  pause: range({ label: "Max process pause", min: 0, max: 5000, step: 50, default: 0, format: (v) => `${v} ms` }),
};
const RHOS = Array.from({ length: 61 }, (_, i) => 10 ** (i / 12)); // 1 ppm to 100,000 ppm

export function CoordLeaseMarginDemo() {
  const P = useParams("coord-margin", MG);
  const { ttl, rho, delay, pause } = P.values;
  const withAll = RHOS.map((x) => [x, marginNeeded(ttl, x * 1e-6, delay, pause)] as [number, number]);
  const driftOnly = RHOS.map((x) => [x, Math.max(1e-3, marginNeeded(ttl, x * 1e-6, 0, 0))] as [number, number]);
  const m = marginNeeded(ttl, rho * 1e-6, delay, pause);
  const fromDrift = marginNeeded(ttl, rho * 1e-6, 0, 0);
  const usable = Math.max(0, (ttl - m) / ttl);
  const yMax = Math.max(ttl * 3, 10);
  return (
    <Demo
      title="How much of the lease a holder must give up"
      controls={<>
        <Param spec={MG.ttl} value={ttl} onChange={(v) => P.set("ttl", v as number)} />
        <Param spec={MG.rho} value={rho} onChange={(v) => P.set("rho", v as number)} />
        <Param spec={MG.delay} value={delay} onChange={(v) => P.set("delay", v as number)} />
        <Param spec={MG.pause} value={pause} onChange={(v) => P.set("pause", v as number)} />
      </>}
    >
      <Plot x={[1, 100000]} y={[0.001, yMax]} logX logY height={240} xLabel="clock drift bound (ppm)" yLabel="margin needed (ms)"
        xTicks={[1, 10, 100, 1000, 10000, 100000]} yTicks={[0.01, 1, 100, 10000].filter((t) => t < yMax)}
        xFormat={(v) => sig(v, 1)} yFormat={(v) => (v < 1 ? String(v) : sig(v, 1))}>
        <RuleY at={ttl} color={BAD} label="the whole lease" />
        <Line points={driftOnly} color="var(--c3)" dash="5 4" />
        <Line points={withAll} color="var(--c1)" />
        <Dots points={[[rho, m]]} color="var(--c1)" r={4} />
      </Plot>
      <Legend items={[{ label: "drift only", color: "var(--c3)" }, { label: "drift + delay + pause", color: "var(--c1)" }]} />
      <Stats items={[
        { label: "margin needed", value: `${sig(m, 3)} ms` },
        { label: "from clock drift", value: `${sig(fromDrift, 3)} ms` },
        { label: "from delay and pause", value: `${sig(m - fromDrift, 3)} ms` },
        { label: "usable part of the lease", value: <span style={{ color: usable === 0 ? BAD : undefined }}>{usable === 0 ? "none" : pct(usable, 2)}</span> },
      ]} />
      <Banner tone={usable === 0 ? "bad" : m - fromDrift > fromDrift ? "warn" : "good"}>
        {usable === 0
          ? "The margin is longer than the lease. No safe use is left: only a fencing token can protect the data."
          : `The holder must stop using a ${ttl >= 1000 ? `${fixed(ttl / 1000, ttl < 10000 ? 1 : 0)} s` : `${ttl} ms`} lease ${sig(m, 3)} ms early. ${m - fromDrift > fromDrift ? "Delay and pause cost more than drift." : "Drift is the larger part."}`}
      </Banner>
    </Demo>
  );
}
