/** Demos for "the block layer and I/O schedulers": the elevator and merge stepper, and a latency against throughput plot. */
import { useMemo, useState } from "react";
import { Demo, Dots, Legend, Line, Param, Plot, Stats, range, si, toggle, useParams, useWidth, IndexButtons, IndexSlider, MiniTable, mono, seg, useChunked } from "../../kit";
import {
  BLOCK_SCRIPTS, ELEVATOR_LABEL, SCHED_DEPTHS, SCHED_LABEL, SCHED_MODEL, runElevator, schedRun,
  type BlkRequest, type BlockSnap, type ElevatorPolicy, type SchedDevice, type SchedId, type SchedRun,
} from "../../sims/os/io";
import { Msg } from "./ProcessesUi";

// ---------------------------------------------------------------- the elevator

const EL = {
  script: seg<keyof typeof BLOCK_SCRIPTS>("Workload", (Object.keys(BLOCK_SCRIPTS) as (keyof typeof BLOCK_SCRIPTS)[]).map((k) => [k, BLOCK_SCRIPTS[k].label] as [keyof typeof BLOCK_SCRIPTS, string]), "mixed"),
  policy: seg<ElevatorPolicy>("Order", [["fifo", ELEVATOR_LABEL.fifo], ["look", ELEVATOR_LABEL.look], ["deadline", ELEVATOR_LABEL.deadline]], "look"),
  merge: toggle({ label: "Merge adjacent bios", default: true }),
};

function Track({ s }: { s: BlockSnap }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = 118, pad = 8;
  const x = (sector: number) => pad + (sector / SCHED_MODEL.diskSectors) * (w - 2 * pad);
  const reqW = (r: BlkRequest) => Math.max(7, (r.sectors / 8) * 4);
  const done = s.done;
  const justDone = done[done.length - 1];
  const dispatched = s.title.startsWith("Dispatch");
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={w} height={H} role="img" aria-label="requests on the disk" style={{ display: "block" }}>
        <text x={pad} y={11} fontSize={11} fill="var(--muted)">Queue, by position on the disk</text>
        <line x1={pad} x2={w - pad} y1={62} y2={62} stroke="var(--border)" strokeWidth={1.5} />
        {[0, 0.5, 1].map((f) => <text key={f} x={x(f * SCHED_MODEL.diskSectors)} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>{(f * SCHED_MODEL.diskSectors).toLocaleString("en-US")}</text>)}
        {done.map((r) => <rect key={`d${r.id}`} x={x(r.sector) - reqW(r) / 2} y={66} width={reqW(r)} height={8} rx={1.5} fill="var(--faint)" />)}
        {s.queue.map((r) => {
          const hot = r.id === s.active;
          return (
            <g key={r.id}>
              <rect x={x(r.sector) - reqW(r) / 2} y={34} width={reqW(r)} height={24} rx={2} fill={r.op === "R" ? "var(--c1)" : "var(--c5)"} stroke={hot ? "var(--fg)" : "none"} strokeWidth={1.5} />
              {r.bios.length > 1 && <text x={x(r.sector)} y={30} fontSize={10.5} textAnchor="middle" fill="var(--fg)" style={mono}>{r.bios.length}</text>}
            </g>
          );
        })}
        {dispatched && justDone && (
          <line x1={x(s.fromSector)} x2={x(s.headSector)} y1={84} y2={84} stroke="var(--c2)" strokeWidth={2} />
        )}
        <g transform={`translate(${x(s.headSector)},76)`} style={{ transition: "transform .25s" }}>
          <path d="M0 0L6 12H-6Z" fill="var(--c2)" />
          <text y={22} fontSize={10.5} textAnchor={s.headSector < 40_000 ? "start" : s.headSector > 960_000 ? "end" : "middle"} x={s.headSector < 40_000 ? -6 : s.headSector > 960_000 ? 6 : 0} fill="var(--c2)">head</text>
        </g>
      </svg>
    </div>
  );
}

export function IoElevatorDemo() {
  const p = useParams("io-el", EL);
  const { script, policy, merge } = p.values;
  const snaps = useMemo(() => runElevator(BLOCK_SCRIPTS[script], { policy, merge }), [script, policy, merge]);
  const [k0, setK] = useState(0);
  const k = Math.min(k0, snaps.length - 1);
  const s = snaps[k]!;
  const end = snaps[snaps.length - 1]!;
  return (
    <Demo
      title="Bios become requests, and the head moves"
      actions={<IndexButtons k={k} n={snaps.length} set={setK} />}
      controls={
        <>
          <IndexSlider k={k} n={snaps.length} set={setK} />
          <Param spec={EL.merge} value={merge} onChange={(v) => { p.set("merge", v as boolean); }} />
          <Param spec={EL.script} value={script} onChange={(v) => { p.set("script", v as never); setK(0); }} />
          <Param spec={EL.policy} value={policy} onChange={(v) => { p.set("policy", v as never); }} />
        </>
      }
    >
      <div style={{ fontWeight: 550, fontSize: 13.5, marginBottom: 2 }}>{s.title}</div>
      <Msg min={38}>{s.text}</Msg>
      <Track s={s} />
      <Legend items={[{ label: "read request", color: "var(--c1)" }, { label: "write request", color: "var(--c5)" }, { label: "done", color: "var(--faint)" }]} />
      <div style={{ marginTop: 6 }}>
        <Stats items={[
          { label: "bios so far", value: s.bios },
          { label: "merges", value: s.merges },
          { label: "requests to the disk", value: s.done.length },
          { label: "disk time so far", value: `${s.nowMs.toFixed(1)} ms` },
          { label: "whole run", value: `${end.nowMs.toFixed(1)} ms` },
          script === "starve"
            ? { label: "far read finishes at", value: `${end.finishMs[1]!.toFixed(1)} ms` }
            : { label: "longest wait, whole run", value: `${end.maxWaitMs.toFixed(0)} ms` },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- latency against throughput

const SCHEDS: SchedId[] = ["none", "mq-deadline", "bfq"];
const COLOR: Record<SchedId, string> = { none: "var(--c1)", "mq-deadline": "var(--c2)", bfq: "var(--c5)" };

const LT = {
  depth: range({ label: "Queue depth shown in the table", min: 0, max: 6, step: 1, default: 4, format: (v) => String(2 ** (v + 1)) }),
  device: seg<SchedDevice>("Device", [["hdd", "7,200 rpm disk"], ["nvme", "NVMe SSD"]], "hdd"),
  read: seg<"0.9" | "0.7" | "0.3">("Queue depth for the reader job", [["0.9", "90%"], ["0.7", "70%"], ["0.3", "30%"]], "0.7"),
};

const lat = (ms: number) => (ms >= 10 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(0)} µs`);

export function IoSchedPlotDemo() {
  const p = useParams("io-lt", LT);
  const device = p.values.device;
  const readShare = Number(p.values.read);
  const depths = SCHED_DEPTHS[device];
  const tasks = useMemo(() => SCHEDS.flatMap((sched) => depths.map((qd) => () => schedRun({ device, sched, qd, readShare }))), [device, readShare, depths]);
  const key = `${device}:${readShare}`;
  const results = useChunked<SchedRun>(key, tasks);
  const get = (si_: number, di: number) => results[si_ * depths.length + di];
  const all = results.filter(Boolean) as SchedRun[];
  const maxX = all.length ? Math.max(...all.map((r) => r.iops)) * 1.08 : 1;
  const ys = all.flatMap((r) => [r.readP99Ms]);
  const minY = ys.length ? Math.min(...ys) * 0.7 : 0.1, maxY = ys.length ? Math.max(...ys) * 1.4 : 1;
  const unit = device === "hdd" ? 1 : 1000;
  const di = Math.min(p.values.depth, depths.length - 1);
  const yTicks = useMemo(() => { const out: number[] = []; for (let e = -4; e <= 5; e++) { for (const m of [1, 3]) { const v = m * 10 ** e; if (v >= minY && v <= maxY) out.push(v); } } return out; }, [minY, maxY]);
  return (
    <Demo
      title="Read latency against throughput"
      controls={
        <>
          <Param spec={LT.depth} value={p.values.depth} onChange={(v) => p.set("depth", v as number)} />
          <Param spec={LT.device} value={device} onChange={(v) => p.set("device", v as never)} />
          <Param spec={LT.read} value={p.values.read} onChange={(v) => p.set("read", v as never)} />
        </>
      }
    >
      <div style={{ minHeight: 250 }}>
        {all.length > 0 && (
          <Plot x={[0, maxX / unit]} y={[minY, maxY]} logY height={250} yTicks={yTicks} yFormat={lat} xLabel={device === "hdd" ? "total requests per second" : "total, thousand requests per second"} yLabel="read latency, 99th percentile">
            {SCHEDS.map((sc, i) => {
              const pts = depths.map((_, d) => get(i, d)).filter(Boolean).map((r) => [r!.iops / unit, r!.readP99Ms] as [number, number]);
              return <g key={sc}><Line points={pts} color={COLOR[sc]} /><Dots points={pts} color={COLOR[sc]} r={2.5} /></g>;
            })}
            {SCHEDS.map((sc, i) => { const r = get(i, di); return r ? <Dots key={sc} points={[[r.iops / unit, r.readP99Ms]]} color="var(--fg)" r={4} /> : null; })}
          </Plot>
        )}
      </div>
      <Legend items={SCHEDS.map((s) => ({ label: SCHED_LABEL[s], color: COLOR[s] }))} />
      <div style={{ marginTop: 8 }}>
        <MiniTable
          head={[`Depth ${depths[di]}`, "total per second", "reads per second", "read p99", "write p99"]}
          rows={SCHEDS.map((s, i) => {
            const r = get(i, di);
            return [SCHED_LABEL[s], r ? si(Math.round(r.iops)) : "…", r ? si(Math.round(r.readIops)) : "…", r ? lat(r.readP99Ms) : "…", r ? lat(r.writeP99Ms) : "…"];
          })}
        />
      </div>
    </Demo>
  );
}
