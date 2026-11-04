/** Demos for "DMA and the IOMMU": PIO against DMA, scatter-gather with translation, and the map and sync API. */
import { useMemo, useState } from "react";
import { Demo, Legend, Line, Param, Plot, RuleX, Stats, bytes as fmtBytes, pct, range, toggle, useParams, useWidth } from "../../kit";
import {
  DMA_DEVICES, DMA_MODEL, DmaLine, Iommu, dmaCrossoverBytes, dmaMapSg, pioVsDma,
  type DmaDeviceId, type DmaDir, type IommuResult,
} from "../../sims/os/io";
import { hexVa, PAGE_SIZE } from "../../sims/os/vm";
import { Banner } from "./SyncShared";
import { Note, Panel, mono, seg } from "./ProcessesUi";

const us = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} ms` : `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} µs`);

// ---------------------------------------------------------------- PIO against DMA

const PD = {
  size: range({ label: "Transfer size", min: 16, max: 16 * 1024 * 1024, log: true, default: 4096, format: (v) => fmtBytes(Math.round(v)) }),
  word: range({ label: "One MMIO word (model input)", min: 0.1, max: 2, step: 0.1, default: DMA_MODEL.mmioWordUs, format: (v) => `${v.toFixed(1)} µs` }),
  setup: range({ label: "DMA setup (model input)", min: 0.5, max: 20, step: 0.5, default: DMA_MODEL.setupUs, format: (v) => `${v} µs` }),
  device: seg<DmaDeviceId>("Device speed", [["hdd", `Disk ${DMA_DEVICES.hdd.mbps} MB/s`], ["sata", `SATA ${DMA_DEVICES.sata.mbps} MB/s`], ["nvme", `NVMe ${DMA_DEVICES.nvme.mbps} MB/s`]], "nvme"),
};

export function IoPioDmaDemo() {
  const p = useParams("io-pio", PD);
  const { size, word, setup, device } = p.values;
  const inp = { mbps: DMA_DEVICES[device].mbps, mmioWordUs: word, setupUs: setup };
  const xs = useMemo(() => Array.from({ length: 121 }, (_, i) => 2 ** (4 + (i / 120) * 20)), []);
  const share = useMemo(() => xs.map((b) => [b, pioVsDma(b, inp).dma.share] as [number, number]), [xs, word, setup, device]); // eslint-disable-line react-hooks/exhaustive-deps
  const cross = dmaCrossoverBytes(inp);
  const c = pioVsDma(Math.round(size), inp);
  return (
    <Demo
      title="CPU busy share while a transfer runs"
      controls={
        <>
          <Param spec={PD.size} value={size} onChange={(v) => p.set("size", v as number)} />
          <Param spec={PD.word} value={word} onChange={(v) => p.set("word", v as number)} />
          <Param spec={PD.setup} value={setup} onChange={(v) => p.set("setup", v as number)} />
          <Param spec={PD.device} value={device} onChange={(v) => p.set("device", v as never)} />
        </>
      }
    >
      <Plot x={[16, 2 ** 24]} y={[0, 1.04]} logX height={220} xTicks={[16, 256, 4096, 65536, 2 ** 20, 2 ** 24]} xFormat={(v) => fmtBytes(v)} yFormat={(v) => pct(v, 0)} xLabel="transfer size" yLabel="CPU busy, share of the transfer time">
        <Line points={xs.map((b) => [b, 1] as [number, number])} color="var(--c4)" />
        <Line points={share} color="var(--c1)" />
        <RuleX at={Math.round(size)} />
        <RuleX at={cross} color="var(--c3)" />
      </Plot>
      <Legend items={[{ label: "PIO", color: "var(--c4)" }, { label: "DMA", color: "var(--c1)" }, { label: `DMA uses less CPU above ${fmtBytes(cross)}`, color: "var(--c3)" }]} />
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "PIO CPU time", value: us(c.pio.cpuUs) },
          { label: "DMA CPU time", value: us(c.dma.cpuUs) },
          { label: "DMA total time", value: us(c.dma.elapsedUs) },
          { label: "CPU time saved", value: `${c.cpuRatio >= 100 ? c.cpuRatio.toFixed(0) : c.cpuRatio.toFixed(1)}×` },
          { label: "SG segments", value: c.segments },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- scatter-gather and IOMMU

const IOVA_BASE = 0x1000_0000;
/** The frames of a 4-page buffer. They are scattered, as real pages are. */
const BUF_FRAMES = [0x1a3, 0x07c, 0x2f1, 0x0d5];
const SECRET_FRAME = 0x0c0;
const FRAMES = [...new Set([...BUF_FRAMES, SECRET_FRAME, 0x050, 0x210])].sort((a, b) => a - b);

type Target = { id: string; label: string; addr: number; note: string };
const TARGETS: Target[] = [
  ...BUF_FRAMES.map((_, i): Target => ({ id: `p${i}`, label: `Buffer page ${i}`, addr: IOVA_BASE + i * PAGE_SIZE, note: i === 3 ? "This page is mapped read-only: DMA_TO_DEVICE." : "This page is mapped for this I/O." })),
  { id: "next", label: "Past the buffer", addr: IOVA_BASE + 4 * PAGE_SIZE, note: "A driver or firmware bug: one page past the end." },
  { id: "secret", label: `Physical 0x${(SECRET_FRAME * PAGE_SIZE).toString(16)}`, addr: SECRET_FRAME * PAGE_SIZE, note: "An attacker device names the kernel page directly." },
];

const IOM = {
  iommu: toggle({ label: "IOMMU on", default: true }),
  kind: seg<"r" | "w">("DMA direction", [["r", "Device reads memory"], ["w", "Device writes memory"]], "r"),
};

function buildIommu() {
  const u = new Iommu();
  u.attach("nic", 1);
  BUF_FRAMES.forEach((f, i) => u.map(1, IOVA_BASE + i * PAGE_SIZE, f, { write: i !== 3 }));
  return u;
}

interface Issue { target: Target; kind: "r" | "w" }

function MapView({ on, last, physical }: { on: boolean; last: Target | null; physical: number | null }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = 138;
  const iovas = 5; // 4 mapped pages and one past the end
  const pad = 4;
  const ix = (i: number) => pad + ((w - 2 * pad) * (i + 0.5)) / iovas;
  const fx = (i: number) => pad + ((w - 2 * pad) * (i + 0.5)) / FRAMES.length;
  const box = Math.min(54, (w - 2 * pad) / FRAMES.length - 6);
  const iw = Math.min(64, (w - 2 * pad) / iovas - 6);
  const lastIova = last && on && last.id.startsWith("p") ? Number(last.id.slice(1)) : -1;
  const hitFrame = physical === null ? -1 : FRAMES.indexOf(Math.floor(physical / PAGE_SIZE));
  return (
    <div ref={ref} style={{ width: "100%" }}>
      <svg width={w} height={H} style={{ display: "block" }} role="img" aria-label="IOVA pages and physical frames">
        <text x={pad} y={10} fontSize={11} fill="var(--muted)">{on ? "IOVA: what the device sees. It is contiguous." : "No IOMMU: the device sees physical addresses."}</text>
        {on && Array.from({ length: iovas }, (_, i) => (
          <g key={i} opacity={i === 4 ? 0.55 : 1}>
            <rect x={ix(i) - iw / 2} y={16} width={iw} height={24} rx={3} fill={i === lastIova ? "var(--c2)" : "var(--bg)"} stroke="var(--border)" strokeDasharray={i === 4 ? "3 3" : undefined} />
            <text x={ix(i)} y={32} fontSize={10.5} textAnchor="middle" fill={i === lastIova ? "var(--bg)" : "var(--fg)"}>{i === 4 ? "none" : `+${i * 4}K`}</text>
          </g>
        ))}
        {on && BUF_FRAMES.map((f, i) => (
          <line key={i} x1={ix(i)} y1={40} x2={fx(FRAMES.indexOf(f))} y2={92} stroke={i === lastIova ? "var(--c2)" : "var(--faint)"} strokeWidth={i === lastIova ? 2 : 1} />
        ))}
        <text x={pad} y={H - 2} fontSize={11} fill="var(--muted)">Physical frames</text>
        {FRAMES.map((f, i) => {
          const secret = f === SECRET_FRAME, buf = BUF_FRAMES.includes(f), hit = i === hitFrame;
          return (
            <g key={f}>
              <rect x={fx(i) - box / 2} y={92} width={box} height={26} rx={3} fill={hit ? (secret ? "var(--c4)" : "var(--c3)") : secret ? "color-mix(in srgb, var(--c4) 18%, var(--bg))" : buf ? "color-mix(in srgb, var(--c1) 16%, var(--bg))" : "var(--bg)"} stroke="var(--border)" />
              <text x={fx(i)} y={109} fontSize={w < 420 ? 9 : 10.5} textAnchor="middle" fill={hit ? "var(--bg)" : "var(--fg)"}>{secret ? "secret" : f.toString(16)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function IoIommuDemo() {
  const p = useParams("io-iommu", IOM);
  const on = p.values.iommu;
  const [issues, setIssues] = useState<Issue[]>([]);
  const state = useMemo(() => {
    const u = buildIommu();
    let last: IommuResult | null = null;
    let lastIssue: Issue | null = null;
    let physical: number | null = null;
    for (const i of issues) {
      lastIssue = i;
      if (on) {
        last = u.translate("nic", i.target.addr, i.kind);
        physical = last.ok ? last.pa! : null;
      } else {
        last = null;
        physical = i.target.addr >= IOVA_BASE ? null : i.target.addr;
      }
    }
    return { u, last, lastIssue, physical };
  }, [issues, on]);
  const { u, last, lastIssue, physical } = state;
  const sg = dmaMapSg(BUF_FRAMES, { iommu: on, maskBits: 32 });
  const issue = (target: Target) => setIssues((x) => [...x, { target, kind: p.values.kind }]);
  const reachedSecret = physical !== null && Math.floor(physical / PAGE_SIZE) === SECRET_FRAME;
  return (
    <Demo
      title="A device issues an address"
      actions={<button className="btn ghost" onClick={() => setIssues([])}>Reset</button>}
      controls={
        <>
          <Param spec={IOM.iommu} value={on} onChange={(v) => { p.set("iommu", v as boolean); setIssues([]); }} />
          <Param spec={IOM.kind} value={p.values.kind} onChange={(v) => p.set("kind", v as never)} />
        </>
      }
    >
      <MapView on={on} last={lastIssue?.target ?? null} physical={physical} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0" }}>
        {TARGETS.map((t) => (
          (on || !t.id.startsWith("next")) && <button key={t.id} className="btn" onClick={() => issue(t)}>{on || t.id === "secret" ? t.label : `Frame 0x${BUF_FRAMES[Number(t.id.slice(1))]!.toString(16)}`}</button>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Panel title="The walk for the last address" style={{ flex: "1 1 240px" }}>
          <div style={{ ...mono, fontSize: 12, minHeight: 74, lineHeight: 1.45 }}>
            {!lastIssue && <span className="muted">Press an address above.</span>}
            {lastIssue && !on && <span className="muted">No translation. The address goes straight to memory.</span>}
            {lastIssue && on && last && (last.iotlbHit
              ? <span>IOTLB hit: no table read.</span>
              : last.events.length === 0
                ? <span className="muted">No walk.</span>
                : last.events.map((e) => <div key={e.level}>{e.name}[{e.index}] {e.present ? (e.leaf ? `leaf, frame 0x${(Number(e.entry >> 12n) & 0xfffff).toString(16)}` : "next table") : "not present"}</div>))}
          </div>
        </Panel>
        <Panel title="The list the device gets" style={{ flex: "1 1 170px" }}>
          <div style={{ ...mono, fontSize: 12, lineHeight: 1.45 }}>
            {sg.segments.map((s) => <div key={s.addr}>{on ? hexVa(BigInt(IOVA_BASE)) : `0x${(s.addr * PAGE_SIZE).toString(16)}`}, {s.pages * 4} KiB</div>)}
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>{sg.segments.length} {sg.segments.length === 1 ? "segment" : "segments"} for 4 pages.</div>
        </Panel>
      </div>
      {lastIssue && (
        <Banner tone={!on ? (reachedSecret ? "bad" : "plain") : last?.ok ? "good" : "bad"}>
          {!on && reachedSecret && `Nothing stopped the device. It ${lastIssue.kind === "r" ? "read" : "wrote"} a kernel page.`}
          {!on && !reachedSecret && "The device reached this frame directly. Nothing checks it."}
          {on && last?.ok && `Allowed: IOVA ${hexVa(BigInt(lastIssue.target.addr))} is physical 0x${last.pa!.toString(16)}.`}
          {on && last && !last.ok && `Blocked: ${last.fault === "read-only" ? "a write to a read-only page" : "no mapping for this address"}. The IOMMU logs a fault. The access does not reach memory.`}
        </Banner>
      )}
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "translations", value: u.translations },
          { label: "IOTLB hits", value: u.iotlb.stats.hits },
          { label: "page walks", value: u.walks },
          { label: "faults logged", value: u.faults.length },
        ]} />
      </div>
      {lastIssue && <Note>{lastIssue.target.note} A table read in the model takes the same 4 steps as a CPU page walk.</Note>}
    </Demo>
  );
}

// ---------------------------------------------------------------- map and sync

type SyncStep = "write" | "map" | "dev-read" | "dev-write" | "unmap" | "read";

const SYNC = {
  coherent: seg<"no" | "yes">("System", [["no", "Non-coherent (many embedded arm64)"], ["yes", "Coherent (x86-64)"]], "no"),
  dir: seg<DmaDir>("Direction", [["to-device", "DMA_TO_DEVICE"], ["from-device", "DMA_FROM_DEVICE"]], "to-device"),
};

function replaySync(coherent: boolean, dir: DmaDir, steps: SyncStep[]) {
  const l = new DmaLine(coherent);
  let last = "";
  for (const s of steps) {
    if (s === "write") { l.cpuWrite("new"); last = "The CPU writes new to its cache."; }
    else if (s === "map") { l.mapForDevice(dir); last = dir === "to-device" ? "dma_map_single cleans the line, so memory has the data." : "dma_map_single drops the line, so no dirty data can overwrite the device's data later."; }
    else if (s === "dev-read") { const v = l.deviceRead(); last = `The device reads memory and gets ${v}.`; }
    else if (s === "dev-write") { l.deviceWrite("dev"); last = "The device writes dev to memory."; }
    else if (s === "unmap") { l.mapForCpu(dir); last = dir === "from-device" ? "dma_unmap_single drops the line again, because the CPU may have fetched it by speculation." : "dma_unmap_single gives the buffer back."; }
    else { const v = l.cpuRead(); last = `The CPU reads ${v}.`; }
  }
  return { l, last };
}

export function IoDmaSyncDemo() {
  const p = useParams("io-sync", SYNC);
  const coherent = p.values.coherent === "yes";
  const dir = p.values.dir;
  const [steps, setSteps] = useState<SyncStep[]>([]);
  const { l, last } = useMemo(() => replaySync(coherent, dir, steps), [coherent, dir, steps]);
  const add = (s: SyncStep) => setSteps((x) => [...x, s]);
  const cell = (name: string, v: string | null, dirty?: boolean) => (
    <Panel title={name} style={{ flex: "1 1 110px" }}>
      <div style={{ ...mono, fontSize: 17 }}>{v ?? "empty"}{dirty ? <span style={{ color: "var(--c2)", fontSize: 12 }}> dirty</span> : null}</div>
    </Panel>
  );
  return (
    <Demo
      title="One buffer, one cache line"
      actions={<button className="btn ghost" onClick={() => setSteps([])}>Reset</button>}
      controls={
        <>
          <Param spec={SYNC.coherent} value={p.values.coherent} onChange={(v) => { p.set("coherent", v as never); setSteps([]); }} />
          <Param spec={SYNC.dir} value={dir} onChange={(v) => { p.set("dir", v as never); setSteps([]); }} />
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {cell("CPU cache", l.cache, l.dirty)}
        {cell("Memory", l.memory)}
        <Panel title="Owner" style={{ flex: "1 1 80px" }}><div style={{ ...mono, fontSize: 17 }}>{l.owner}</div></Panel>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {dir === "to-device" ? (
          <>
            <button className="btn" onClick={() => add("write")}>CPU writes</button>
            <button className="btn" onClick={() => add("map")}>dma_map_single</button>
            <button className="btn" onClick={() => add("dev-read")}>Device reads</button>
            <button className="btn" onClick={() => add("unmap")}>dma_unmap_single</button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => add("read")}>CPU reads</button>
            <button className="btn" onClick={() => add("map")}>dma_map_single</button>
            <button className="btn" onClick={() => add("dev-write")}>Device writes</button>
            <button className="btn" onClick={() => add("unmap")}>dma_unmap_single</button>
            <button className="btn" onClick={() => add("read")}>CPU reads</button>
          </>
        )}
      </div>
      <Banner tone={l.staleReads > 0 ? "bad" : "plain"}>
        {l.staleReads > 0 ? `${last} That is stale: the newest value is elsewhere.` : last || (dir === "to-device" ? "Try: CPU writes, then Device reads, with no map." : "Try: CPU reads, Device writes, CPU reads, with no map or unmap.")}
      </Banner>
    </Demo>
  );
}
