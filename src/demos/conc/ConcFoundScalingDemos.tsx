/** Demos for "Amdahl's and Gustafson's laws": speedup measured on the Runtime, and a USL fit with Karp-Flatt. */
import { useMemo } from "react";
import { Demo, Dots, Legend, Line, Note, Param, Plot, RuleX, Stats, fixed, range, seg, toggle, useChunked, useParams } from "../../kit";
import {
  SCALE_CORES, USL_DEFAULTS, USL_THREADS, amdahl, fitUsl, gustafson, karpFlatt, measuredSpeedup, runScale, runUsl, usl, uslPeak,
  type SerialKind,
} from "../../sims/conc/foundations";
import { ThreadTimeline } from "./ConcViews";

const SC = {
  serial: range({ label: "Serial part of the one-core time", min: 0, max: 0.5, step: 0.01, default: 0.1, format: (v) => `${Math.round(v * 100)}%` }),
  kind: seg("The serial part is", [["lock", "a locked update"], ["phase", "a phase alone"]], "lock"),
  scaling: seg("Problem size", [["strong", "fixed (strong)"], ["weak", "grows with cores (weak)"]], "strong"),
  costs: toggle({ label: "Runtime costs on (switch, wake-up, lock)", default: false }),
  tl: range({ label: "Cores in the timeline", min: 1, max: 16, step: 1, default: 8 }),
};

export function ConcFoundAmdahlDemo() {
  const P = useParams("conc-found-amdahl", SC);
  const { serial, scaling, costs, tl } = P.values;
  const kind = P.values.kind as SerialKind;
  const strong = scaling === "strong";
  const jobs = useMemo(
    () => SCALE_CORES.map((c) => () => measuredSpeedup({ cores: c, serial, kind, scaling, costs })),
    [serial, kind, scaling, costs],
  );
  const res = useChunked(`${serial}/${kind}/${scaling}/${costs}`, jobs, { keep: true });
  const pts = SCALE_CORES.flatMap((c, i) => (res[i] !== undefined ? [[c, res[i]!] as [number, number]] : []));
  const xs = Array.from({ length: 64 }, (_, i) => i + 1);
  const law = xs.map((p) => [p, strong ? amdahl(serial, p) : gustafson(serial, p)] as [number, number]);
  const timeline = useMemo(() => runScale({ cores: tl, serial, kind, scaling, costs, record: true }), [tl, serial, kind, scaling, costs]);
  const yMax = strong ? Math.min(70, Math.max(4, ...pts.map((q) => q[1]), serial > 0 ? Math.min(64, 1 / serial) : 64) * 1.1) : 70;
  const at8 = res[SCALE_CORES.indexOf(8)];
  const at64 = res[SCALE_CORES.indexOf(64)];
  return (
    <Demo
      title="Speedup measured on the simulated machine"
      controls={<>
        <Param spec={SC.serial} value={serial} onChange={(v) => P.set("serial", v as number)} />
        <Param spec={SC.kind} value={kind} onChange={(v) => P.set("kind", v as never)} />
        <Param spec={SC.scaling} value={scaling} onChange={(v) => P.set("scaling", v as never)} />
        <Param spec={SC.costs} value={costs} onChange={(v) => P.set("costs", v as boolean)} />
        <Param spec={SC.tl} value={tl} onChange={(v) => P.set("tl", v as number)} />
      </>}
    >
      <Plot x={[1, 64]} y={[0, yMax]} height={240} xLabel="cores" yLabel={strong ? "speedup" : "scaled speedup"} xTicks={[1, 8, 16, 24, 32, 40, 48, 56, 64]}>
        <Line points={[[1, 1], [64, 64]]} color="var(--faint)" dash="3 3" width={1.5} />
        {strong && serial > 0 && <Line points={[[1, 1 / serial], [64, 1 / serial]]} color="var(--c2)" dash="2 4" width={1.5} />}
        <Line points={law} color="var(--c1)" dash="6 4" />
        <RuleX at={tl} color="var(--c5)" />
        <Dots points={pts} color="var(--c4)" r={3.5} />
      </Plot>
      <Legend items={[
        { label: strong ? "Amdahl's law" : "Gustafson's law", color: "var(--c1)" },
        ...(strong && serial > 0 ? [{ label: `limit 1/s = ${fixed(1 / serial, 1)}`, color: "var(--c2)" }] : []),
        { label: "measured (Runtime)", color: "var(--c4)" },
        { label: "ideal", color: "var(--faint)" },
      ]} />
      <Stats items={[
        { label: "measured, 8 cores", value: at8 !== undefined ? `${fixed(at8, 2)}×` : "…" },
        { label: strong ? "Amdahl, 8 cores" : "Gustafson, 8 cores", value: `${fixed(strong ? amdahl(serial, 8) : gustafson(serial, 8), 2)}×` },
        { label: "measured, 64 cores", value: at64 !== undefined ? `${fixed(at64, 2)}×` : "…" },
        { label: "Karp-Flatt e, 64 cores", value: at64 !== undefined ? fixed(karpFlatt(at64, 64), 3) : "…" },
      ]} />
      <div style={{ marginTop: 8 }}>
        <ThreadTimeline result={timeline} by={kind === "phase" ? "core" : "thread"} labels={false} />
      </div>
      <Note>
        The one-core job is 3.84 ms of work in 192 iterations. {kind === "lock"
          ? "Each thread takes its share of iterations: parallel work, then the serial part inside one mutex."
          : "The main thread runs the serial part alone, then forks one worker per core for the parallel part, 4 times."}
        {" "}The timeline shows the run on {tl} core{tl > 1 ? "s" : ""}, {kind === "phase" ? "by core: while the serial phase runs, the other cores are idle" : "by thread: a thin line is a thread that waits for the mutex"}.
      </Note>
    </Demo>
  );
}

const USL = {
  locked: range({ label: "Work inside the lock", min: 0, max: 400, step: 10, default: USL_DEFAULTS.lockedNs, format: (v) => `${v} ns` }),
  peer: range({ label: "Extra lock time per other thread", min: 0, max: 20, step: 1, default: USL_DEFAULTS.perPeerNs, format: (v) => `${v} ns` }),
};

export function ConcFoundUslDemo() {
  const P = useParams("conc-found-usl", USL);
  const { locked, peer } = P.values;
  const jobs = useMemo(() => USL_THREADS.map((n) => () => runUsl({ ...USL_DEFAULTS, lockedNs: locked, perPeerNs: peer, threads: n })), [locked, peer]);
  const res = useChunked(`${locked}/${peer}`, jobs, { keep: true });
  const ready = res.every((r) => r !== undefined);
  const base = res[0];
  const pts = base ? USL_THREADS.flatMap((n, i) => (res[i] !== undefined ? [[n, res[i]! / base] as [number, number]] : [])) : [];
  const fit = useMemo(() => (ready ? fitUsl(pts) : null), [ready, locked, peer]); // eslint-disable-line react-hooks/exhaustive-deps
  const xs = Array.from({ length: 64 }, (_, i) => i + 1);
  const curve = fit ? xs.map((n) => [n, usl(fit.sigma, fit.kappa, n)] as [number, number]) : [];
  const amd = fit ? xs.map((n) => [n, usl(fit.sigma, 0, n)] as [number, number]) : [];
  const kf = pts.filter(([n]) => n > 1).map(([n, c]) => [n, karpFlatt(c, n)] as [number, number]);
  const peakPt = pts.reduce((a, b) => (b[1] > a[1] ? b : a), [1, 1] as [number, number]);
  const yMax = Math.max(4, ...pts.map((q) => q[1])) * 1.25;
  const nStar = fit ? uslPeak(fit.sigma, fit.kappa) : NaN;
  return (
    <Demo
      title="Fit the Universal Scalability Law to a benchmark"
      controls={<>
        <Param spec={USL.locked} value={locked} onChange={(v) => P.set("locked", v as number)} />
        <Param spec={USL.peer} value={peer} onChange={(v) => P.set("peer", v as number)} />
      </>}
    >
      <Plot x={[1, 64]} y={[0, yMax]} height={220} xLabel="threads (one per core)" yLabel="throughput relative to 1 thread" xTicks={[1, 8, 16, 24, 32, 40, 48, 56, 64]}>
        {fit && <Line points={amd} color="var(--c2)" dash="2 4" width={1.5} />}
        {fit && <Line points={curve} color="var(--c1)" />}
        {fit && Number.isFinite(nStar) && nStar <= 64 && <RuleX at={nStar} color="var(--c1)" />}
        <Dots points={pts} color="var(--c4)" r={3.5} />
      </Plot>
      <Legend items={[{ label: "measured (Runtime)", color: "var(--c4)" }, { label: "USL fit", color: "var(--c1)" }, { label: "same σ, κ = 0 (Amdahl)", color: "var(--c2)" }]} />
      <Stats items={[
        { label: "contention $\\sigma$", value: fit ? fixed(fit.sigma, 4) : "…" },
        { label: "coherency $\\kappa$", value: fit ? fit.kappa.toExponential(1) : "…" },
        { label: "fitted peak $N^*$", value: fit ? (Number.isFinite(nStar) ? fixed(nStar, 1) : "none") : "…" },
        { label: "measured peak", value: ready ? `${fixed(peakPt[1], 2)} at ${peakPt[0]}` : "…" },
      ]} />
      <div style={{ height: 10 }} />
      <Plot x={[1, 64]} y={[0, Math.max(0.05, ...kf.map((q) => q[1])) * 1.15]} height={150} xLabel="threads" yLabel="Karp-Flatt e" xTicks={[2, 8, 16, 24, 32, 40, 48, 56, 64]} yFormat={(v) => fixed(v, 2)}>
        <Line points={kf} color="var(--c3)" />
        <Dots points={kf} color="var(--c3)" r={3} />
      </Plot>
      <Note>
        Each thread loops: random parallel work (mean 2 µs), then a spin lock around an update. The update takes the work inside the lock, plus the extra
        time for each other thread, because the line must be taken from every other core (a model of coherency traffic). A flat e means a fixed serial part. A rising e means overhead that grows with the thread count.
      </Note>
    </Demo>
  );
}
