/** Demos for /os/memory/copy-on-write. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Plot, Line, RuleX, Dots, Legend, range, useParams, bytes, pct } from "../../kit";
import { CowMemory, snapshotExtra, firstWriteNs, forkPteBytes, COW_COSTS, SNAPSHOT_DEFAULTS, type CowProc, type WriteResult } from "../../sims/os/memory";
import { seg, Note, fx } from "../db/StorageUi";

const PAGES = ["A", "B", "C", "D"];

type Ev = { text: string; frame?: number; warn?: boolean };

export function CowStepperDemo() {
  const mem = useRef<{ m: CowMemory; parent: CowProc; child: CowProc | null; ver: number } | null>(null);
  const [ev, setEv] = useState<Ev>({ text: "The parent owns four private pages. Press fork()." });
  const [, force] = useState(0);
  const [same, setSame] = useState(false);
  const make = () => {
    const m = new CowMemory();
    mem.current = { m, parent: m.spawn("parent", PAGES), child: null, ver: 1 };
  };
  if (!mem.current) make();
  const s = mem.current!;
  const { m, parent, child } = s;
  const fork = () => {
    if (s.child?.alive) return;
    const before = m.stats.ptesCopied;
    s.child = m.fork(parent);
    setEv({ text: `fork() copied ${m.stats.ptesCopied - before} page table entries and no data pages. Every entry is now read-only, and each frame has one more reference.` });
    force((x) => x + 1);
  };
  const describe = (who: string, vpn: number, r: WriteResult): Ev => {
    switch (r.kind) {
      case "in-place": return { text: `${who} writes page ${vpn}. The entry is writable, so there is no fault.`, frame: r.to };
      case "reuse": return { text: `${who} writes page ${vpn}. Write fault. The frame's count is 1, so the kernel only sets the write bit. No copy.`, frame: r.to };
      case "copy": return { text: `${who} writes page ${vpn}. Write fault. The frame is shared, so the kernel copies it to frame ${r.to}, maps the copy writable, and drops one reference on frame ${r.from}.`, frame: r.to };
      default: return { text: "Not mapped." };
    }
  };
  const write = (p: CowProc, who: string, vpn: number) => {
    const val = same ? "x" : `${PAGES[vpn]!.toLowerCase()}${s.ver++}`;
    setEv(describe(who, vpn, m.write(p, vpn, val)));
    force((x) => x + 1);
  };
  const frames = [...m.frames.values()].sort((a, b) => a.id - b.id);
  const W = 360, rowH = 32, top = 22;
  const H = top + Math.max(4, frames.length) * rowH + 6;
  const yFrame = (id: number) => top + frames.findIndex((f) => f.id === id) * rowH + 13;
  const yPte = (vpn: number) => top + vpn * rowH * (Math.max(4, frames.length) / 4) + 13;
  const pteBox = (p: CowProc, x: number, label: string) => (
    <g>
      <text x={x + 31} y={13} textAnchor="middle" style={{ fontSize: 12, fill: "var(--muted)" }}>{label}</text>
      {[0, 1, 2, 3].map((vpn) => {
        const pte = p.ptes.get(vpn);
        return (
          <g key={vpn} transform={`translate(${x},${yPte(vpn) - 13})`}>
            <rect width={62} height={26} rx={4} fill="var(--subtle)" stroke="var(--border)" />
            <text x={5} y={17} style={{ fontSize: 11.5, fill: "var(--fg)", fontFamily: "ui-monospace, Menlo, monospace" }}>pg {vpn}</text>
            <text x={57} y={17} textAnchor="end" style={{ fontSize: 11, fontWeight: 700, fill: pte?.writable ? "var(--c3)" : "var(--c4)", fontFamily: "ui-monospace, Menlo, monospace" }}>{pte ? (pte.writable ? "W" : "R") : ""}</text>
          </g>
        );
      })}
    </g>
  );
  const links = (p: CowProc, side: "l" | "r", color: string) => [...p.ptes].map(([vpn, pte]) => {
    const x1 = side === "l" ? 62 : W - 62, x2 = side === "l" ? 128 : W - 128;
    const y1 = yPte(vpn), y2 = yFrame(pte.frame);
    return <path key={`${side}${vpn}`} d={`M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`} fill="none" stroke={color} strokeWidth={1.6} strokeDasharray={pte.writable ? undefined : "4 3"} />;
  });
  const alive = !!child?.alive;
  const total = frames.length;
  const rss = parent.ptes.size + (alive ? child!.ptes.size : 0);
  return (
    <Demo
      title="fork(), then write: pages split one at a time"
      actions={<>
        <button className="btn" disabled={alive} onClick={fork}>fork()</button>
        <button className="btn ghost" onClick={() => { const n = m.ksmMerge(); setEv({ text: n ? `ksmd found equal pages and merged them: ${n} frame${n === 1 ? "" : "s"} freed. Merged pages are read-only and COW.` : "ksmd found no equal frames." }); force((x) => x + 1); }}>Run KSM</button>
        <button className="btn ghost" disabled={!alive} onClick={() => { m.exit(child!); setEv({ text: "The child exits. Every frame it mapped loses one reference. A count that reaches 0 frees the frame." }); force((x) => x + 1); }}>Child exits</button>
        <button className="btn ghost" onClick={() => { make(); setEv({ text: "Reset. The parent owns four private pages." }); force((x) => x + 1); }}>Reset</button>
      </>}
    >
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} role="img" aria-label="Page tables of parent and child, mapped to physical frames with reference counts">
        {links(parent, "l", "var(--c1)")}
        {alive && links(child!, "r", "var(--c2)")}
        {pteBox(parent, 0, "parent")}
        {alive && pteBox(child!, W - 62, "child")}
        <text x={W / 2} y={13} textAnchor="middle" style={{ fontSize: 12, fill: "var(--muted)" }}>physical frames</text>
        {frames.map((f) => {
          const y = yFrame(f.id) - 13;
          const hi = ev.frame === f.id;
          return (
            <g key={f.id} transform={`translate(128,${y})`}>
              <rect width={104} height={26} rx={4} fill={hi ? "var(--c3)" : "var(--bg)"} stroke={f.refs > 1 ? "var(--fg)" : "var(--border)"} />
              <text x={6} y={17} style={{ fontSize: 11.5, fill: hi ? "#fff" : "var(--fg)", fontFamily: "ui-monospace, Menlo, monospace" }}>#{f.id} {f.value}</text>
              <text x={98} y={17} textAnchor="end" style={{ fontSize: 11, fontWeight: 700, fill: hi ? "#fff" : f.refs > 1 ? "var(--c4)" : "var(--muted)", fontFamily: "ui-monospace, Menlo, monospace" }}>ref {f.refs}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Parent writes</div>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>{[0, 1, 2, 3].map((i) => <button key={i} className="btn" onClick={() => write(parent, "The parent", i)}>page {i}</button>)}</div>
        </div>
        <div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 3 }}>Child writes</div>
          <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>{[0, 1, 2, 3].map((i) => <button key={i} className="btn" disabled={!alive} onClick={() => write(child!, "The child", i)}>page {i}</button>)}</div>
        </div>
      </div>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, marginTop: 8 }}>
        <input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} /> Write equal bytes (for KSM)
      </label>
      <p style={{ fontSize: 13, margin: "8px 0 0", minHeight: 38 }}>{ev.text}</p>
      <Stats items={[
        { label: "frames in use", value: total },
        { label: "sum of the two RSS values", value: rss },
        { label: "write faults", value: m.stats.faults },
        { label: "copies", value: m.stats.copies },
        { label: "reuses (no copy)", value: m.stats.reuses },
      ]} />
      <Note>Dashed line and R: read-only mapping. Solid line and W: writable mapping.</Note>
    </Demo>
  );
}

// ---------------- snapshot memory ----------------

const RATES = Array.from({ length: 41 }, (_, i) => 10 ** (1 + (i * 5) / 40));

export function SnapshotDemo() {
  const p = useParams("snap", {
    rate: range({ label: "Writes per second", min: 10, max: 1e6, log: true, default: 1e4, format: (x) => fx(x, 3) }),
    gib: range({ label: "Dataset", min: 1, max: 64, step: 1, default: 16, format: (x) => `${x} GiB` }),
    disk: seg("Snapshot write speed (model input)", [["50", "50 MiB/s"], ["200", "200 MiB/s"], ["1000", "1 GiB/s"]], "200"),
    page: seg("Page size", [["4096", "4 KiB"], ["2097152", "2 MiB (THP)"]], "4096"),
  });
  const v = p.values;
  const base = { ...SNAPSHOT_DEFAULTS, datasetBytes: v.gib * 2 ** 30, diskBytesPerSec: Number(v.disk) * 2 ** 20 };
  const cur = snapshotExtra({ ...base, writesPerSec: v.rate, pageBytes: Number(v.page) });
  const curves = useMemo(() => ({
    uni: RATES.map((r) => [r, snapshotExtra({ ...base, writesPerSec: r }).extraShare] as const),
    skew: RATES.map((r) => [r, snapshotExtra({ ...base, writesPerSec: r, hotWrites: 0.9, hotPages: 0.1 }).extraShare] as const),
    thp: RATES.map((r) => [r, snapshotExtra({ ...base, writesPerSec: r, pageBytes: 2 ** 21 }).extraShare] as const),
  }), [v.gib, v.disk]); // eslint-disable-line react-hooks/exhaustive-deps
  const fault = firstWriteNs(Number(v.page));
  return (
    <Demo title="Extra memory while a child process writes a snapshot" controls={<>
      <Param spec={p.schema.rate} value={v.rate} onChange={(x) => p.set("rate", x as number)} />
      <Param spec={p.schema.gib} value={v.gib} onChange={(x) => p.set("gib", x as number)} />
      <Param spec={p.schema.disk} value={v.disk} onChange={(x) => p.set("disk", x as string)} />
      <Param spec={p.schema.page} value={v.page} onChange={(x) => p.set("page", x as string)} />
    </>}>
      <Plot x={[10, 1e6]} y={[0, 1]} logX height={230} xLabel="writes per second" yLabel="memory copied, share of the dataset" yFormat={(y) => `${Math.round(y * 100)}%`} xTicks={[10, 100, 1e3, 1e4, 1e5, 1e6]} xFormat={(x) => fx(x, 1)}>
        <Line points={curves.thp} color="var(--c4)" />
        <Line points={curves.uni} color="var(--c1)" />
        <Line points={curves.skew} color="var(--c3)" dash="5 4" />
        <RuleX at={v.rate} color="var(--fg)" />
        <Dots points={[[v.rate, cur.extraShare]]} color="var(--fg)" r={4} />
      </Plot>
      <Legend items={[{ label: "4 KiB pages, uniform writes", color: "var(--c1)" }, { label: "4 KiB pages, 90% of writes on 10% of pages", color: "var(--c3)" }, { label: "2 MiB pages, uniform writes", color: "var(--c4)" }]} />
      <Stats items={[
        { label: "snapshot time", value: `${fx(cur.seconds, 3)} s` },
        { label: "writes in that time", value: fx(cur.writes, 3) },
        { label: "pages copied", value: fx(cur.copiedPages, 3) },
        { label: "extra memory", value: bytes(Math.round(cur.extraBytes)) },
        { label: "share of dataset", value: pct(cur.extraShare, 1) },
        { label: "one COW fault (model)", value: fault >= 1e4 ? `${fx(fault / 1000, 3)} µs` : `${fx(fault, 3)} ns` },
        { label: "PTEs copied by fork", value: bytes(forkPteBytes(v.gib * 2 ** 30)) },
      ]} />
      <Note>Model inputs: a fault costs {COW_COSTS.faultNs} ns and memcpy runs at {COW_COSTS.copyGiBps} GiB/s. Each write dirties one page.</Note>
    </Demo>
  );
}
