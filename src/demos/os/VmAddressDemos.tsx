/** Demos for the lesson on address spaces. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, toggle, useParams, useWidth, Note, mono, seg } from "../../kit";
import { addressMap, bandBytes, bandLog, fmtBytes, hexShort, hexVa, mapsText, procMaps, twoProcesses, type Band, type MapsLine, type ProcPage } from "../../sims/os/vm";

// ---------------- the address map ----------------

type Scale = "log" | "linear48" | "linear64";
const BAND_COLOR: Record<Band["kind"], string> = { user: "var(--c1)", kernel: "var(--c5)", gap: "var(--subtle)", hole: "var(--faint)" };
const PX_PER_BIT = 0.8;
const LINEAR_HEIGHT = 360;

function bandHeight(b: Band, scale: Scale): number {
  if (scale === "log") return bandLog(b) * PX_PER_BIT;
  if (scale === "linear64") return (bandBytes(b) / 2 ** 64) * LINEAR_HEIGHT;
  return b.kind === "hole" ? 0 : (bandBytes(b) / 2 ** 48) * LINEAR_HEIGHT;
}

const pxText = (h: number) => (h >= 0.1 ? `${h.toFixed(1)} px` : h === 0 ? "0 px" : `${h.toExponential(0)} px`);

export function VmAddressMapDemo() {
  const p = useParams("vmmap", {
    scale: seg<Scale>("Height of each band", [["log", "log2 of its size"], ["linear48", "Linear, 48 bits"], ["linear64", "Linear, 64 bits"]], "log"),
    aslr: toggle({ label: "ASLR on", default: true }),
  });
  const [seed, setSeed] = useState(3);
  const [sel, setSel] = useState(2);
  const bands = useMemo(() => [...addressMap(seed, p.values.aslr)].reverse(), [seed, p.values.aslr]);
  const scale = p.values.scale;
  const picked = bands[Math.min(sel, bands.length - 1)]!;
  const image = bands.find((b) => b.name === "Program image")!;
  const stack = bands.find((b) => b.name === "Stack")!;
  return (
    <Demo
      title="The whole address space of one Linux x86-64 process"
      actions={<button className="btn" onClick={() => setSeed((s) => s + 1)} disabled={!p.values.aslr}>Run the program again</button>}
      controls={<>
        <Param spec={p.schema.scale} value={scale} onChange={(x) => p.set("scale", x as Scale)} />
        <Param spec={p.schema.aslr} value={p.values.aslr} onChange={(x) => p.set("aslr", x as boolean)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 4, ...mono }}>0xffff_ffff_ffff_ffff</div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
            {bands.map((b, i) => {
              const h = bandHeight(b, scale);
              const on = i === sel;
              const showText = h >= 11;
              return (
                <button
                  key={`${b.name}-${i}`}
                  onPointerEnter={() => setSel(i)}
                  onFocus={() => setSel(i)}
                  onClick={() => setSel(i)}
                  aria-label={`${b.name}, ${fmtBytes(bandBytes(b))}`}
                  style={{
                    display: "flex", width: "100%", height: h, padding: 0, border: 0, borderTop: i && h >= 1 ? "1px solid var(--bg)" : 0, cursor: "pointer", alignItems: "center", overflow: "hidden",
                    background: "transparent", color: "var(--fg)", textAlign: "left", fontSize: 11.5, lineHeight: 1,
                    outline: on && showText ? "2px solid var(--c2)" : "none", outlineOffset: -2, transition: "height 0.25s",
                  }}
                >
                  <span style={{ flex: "0 0 40px", height: "100%", background: BAND_COLOR[b.kind], opacity: b.kind === "hole" ? 0.55 : 1 }} />
                  {showText && <span style={{ flex: 1, padding: "0 8px", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: b.kind === "gap" ? "var(--muted)" : "var(--fg)", fontWeight: b.kind === "gap" ? 400 : 550 }}>{b.name}</span>}
                  {showText && <span style={{ padding: "0 8px", color: "var(--muted)", ...mono }}>{fmtBytes(bandBytes(b))}</span>}
                </button>
              );
            })}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4, ...mono }}>0x0000_0000_0000_0000</div>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13 }}>
          <b>{picked.name}</b>
          <div style={{ fontSize: 12, margin: "4px 0", overflowWrap: "anywhere", ...mono }}>{hexVa(picked.start)}<br />to {hexVa(picked.end - 1n)}</div>
          <div style={{ ...mono, fontSize: 12.5 }}>{fmtBytes(bandBytes(picked))}</div>
          <p style={{ margin: "6px 0 10px" }}>{picked.note}</p>
          <Stats items={[
            { label: "program image, at this scale", value: pxText(bandHeight(image, scale)) },
            { label: "stack, at this scale", value: pxText(bandHeight(stack, scale)) },
          ]} />
        </div>
      </div>
      <Note>Blue is user memory, purple is kernel memory, and pale bands hold no mapping. Hover or tap a band. In the log view, height is proportional to log2 of the size, so every band stays visible.</Note>
    </Demo>
  );
}

// ---------------- /proc/self/maps ----------------

const GROUP_COLOR: Record<MapsLine["group"], string> = { program: "var(--c1)", heap: "var(--c3)", library: "var(--c5)", anon: "var(--faint)", stack: "var(--c2)", "kernel-provided": "var(--c4)" };

export function VmProcMapsDemo() {
  const p = useParams("vmprocmaps", { aslr: toggle({ label: "ASLR on (randomize_va_space = 2)", default: true }) });
  const [seed, setSeed] = useState(1);
  const [sel, setSel] = useState(1);
  const [wrap, w] = useWidth<HTMLDivElement>();
  const lines = useMemo(() => procMaps(seed, p.values.aslr), [seed, p.values.aslr]);
  const l = lines[Math.min(sel, lines.length - 1)]!;
  const narrow = w < 620;
  const row = (x: MapsLine) => {
    if (!narrow) return mapsText(x);
    return `${hexShort(x.start)} ${x.perms} ${x.path.split("/").pop() || "(anon)"}`;
  };
  return (
    <Demo
      title="$ cat /proc/self/maps (a model of a typical glibc system)"
      actions={<button className="btn" onClick={() => setSeed((s) => s + 1)}>Run it again</button>}
      controls={<Param spec={p.schema.aslr} value={p.values.aslr} onChange={(x) => p.set("aslr", x as boolean)} />}
    >
      <div ref={wrap} style={{ fontSize: narrow ? 11 : 11.5, lineHeight: 1.55, overflowX: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 0", ...mono }}>
        {lines.map((x, i) => (
          <button key={i} onClick={() => setSel(i)} onPointerEnter={() => setSel(i)} style={{ display: "block", width: "100%", minWidth: "max-content", textAlign: "left", border: 0, padding: "0 8px", cursor: "pointer", font: "inherit", background: i === sel ? "var(--subtle)" : "transparent", color: "var(--fg)", borderLeft: `3px solid ${GROUP_COLOR[x.group]}`, whiteSpace: "pre" }}>
            {row(x)}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "2px 10px", fontSize: 12.5 }}>
        <span className="muted">range</span><span style={{ overflowWrap: "anywhere", ...mono }}>{hexShort(l.start)}-{hexShort(l.end)} ({fmtBytes(Number(l.end - l.start))})</span>
        <span className="muted">rights</span><span style={mono}>{l.perms} ({l.perms[3] === "p" ? "private" : "shared"})</span>
        <span className="muted">file offset</span><span style={mono}>0x{l.offset.toString(16)}</span>
        <span className="muted">device, inode</span><span style={mono}>{l.dev}, {l.inode}</span>
        <span className="muted">name</span><span style={{ overflowWrap: "anywhere", ...mono }}>{l.path || "(no name: anonymous)"}</span>
      </div>
      <p style={{ fontSize: 13, margin: "8px 0 0", minHeight: 38 }}>{l.explain}</p>
    </Demo>
  );
}

// ---------------- two processes ----------------

const REGION_COLOR: Record<string, string> = { "program code": "var(--c3)", "libc code": "var(--c3)", "global data": "var(--c1)", heap: "var(--c5)", stack: "var(--c2)" };
const short = (va: bigint) => { const h = hexShort(va); return h.length > 8 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h; };

export function VmTwoProcessesDemo() {
  const p = useParams("vmtwo", { aslr: toggle({ label: "ASLR on: each process gets different bases", default: false }) });
  const [sel, setSel] = useState<{ who: "A" | "B"; i: number }>({ who: "A", i: 7 });
  const [wrap, w] = useWidth<HTMLDivElement>();
  const m = useMemo(() => twoProcesses({ aslr: p.values.aslr }), [p.values.aslr]);
  const narrow = w < 480;
  const rowH = narrow ? 26 : 27;
  const rows = Math.max(m.a.length, m.frames.length);
  const H = rows * rowH + 26;
  const colW = narrow ? w * 0.31 : Math.min(190, w * 0.3);
  const midW = narrow ? w * 0.24 : Math.min(150, w * 0.22);
  const midX = (w - midW) / 2;
  const rightX = w - colW;
  const fontSize = narrow ? 10 : 11.5;
  const yFor = (i: number, n: number) => 24 + i * ((rows * rowH) / n);
  const frameIndex = (pfn: number) => m.frames.findIndex((f) => f.pfn === pfn);
  const selPage = sel.who === "A" ? m.a[sel.i]! : m.b[sel.i]!;
  const mate = (sel.who === "A" ? m.b : m.a)[sel.i]!;
  const onPage = (who: "A" | "B", i: number) => sel.who === who && sel.i === i;
  const frameOn = (pfn: number) => selPage.pfn === pfn;
  const sameVa = selPage.va === mate.va;
  const walkA = m.tablesA.walk(m.a[sel.i]!.va, {}, { readOnly: true });
  const walkB = m.tablesB.walk(m.b[sel.i]!.va, {}, { readOnly: true });
  const pageBox = (pg: ProcPage, i: number, who: "A" | "B") => {
    const x = who === "A" ? 0 : rightX;
    const y = yFor(i, m.a.length);
    const hh = (rows * rowH) / m.a.length - 3;
    const on = onPage(who, i);
    return (
      <g key={`${who}${i}`} onClick={() => setSel({ who, i })} onPointerEnter={() => setSel({ who, i })} style={{ cursor: "pointer" }}>
        <rect x={x + 0.5} y={y} width={colW - 1} height={hh} rx={3} fill={on ? REGION_COLOR[pg.region] : "var(--subtle)"} stroke={REGION_COLOR[pg.region]} strokeWidth={on ? 2 : 1} />
        <text x={x + 6} y={y + hh / 2 - 2} fontSize={fontSize} style={{ fill: on ? "var(--bg)" : "var(--fg)", fontWeight: 550 }}>{pg.region}</text>
        <text x={x + 6} y={y + hh / 2 + fontSize} fontSize={fontSize} style={{ fill: on ? "var(--bg)" : "var(--muted)", ...mono }}>{short(pg.va)}</text>
      </g>
    );
  };
  const link = (pg: ProcPage, i: number, who: "A" | "B") => {
    const hh = (rows * rowH) / m.a.length - 3;
    const y1 = yFor(i, m.a.length) + hh / 2;
    const fi = frameIndex(pg.pfn);
    const y2 = yFor(fi, m.frames.length) + (rows * rowH) / m.frames.length / 2 - 1;
    const x1 = who === "A" ? colW : rightX;
    const x2 = who === "A" ? midX : midX + midW;
    const on = onPage(who, i) || (frameOn(pg.pfn) && pg.shared);
    const mx = (x1 + x2) / 2;
    return <path key={`l${who}${i}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={on ? REGION_COLOR[pg.region] : "var(--border)"} strokeWidth={on ? 2.2 : 1} />;
  };
  return (
    <Demo title="Two processes run the same program" controls={<Param spec={p.schema.aslr} value={p.values.aslr} onChange={(x) => p.set("aslr", x as boolean)} />}>
      <div ref={wrap} style={{ width: "100%" }}>
        <svg width={w} height={H} style={{ display: "block" }}>
          <text x={0} y={13} fontSize={12} style={{ fill: "var(--muted)" }}>Process A (virtual)</text>
          <text x={w / 2} y={13} fontSize={12} textAnchor="middle" style={{ fill: "var(--muted)" }}>{narrow ? "Frames" : "Physical frames"}</text>
          <text x={w} y={13} fontSize={12} textAnchor="end" style={{ fill: "var(--muted)" }}>Process B (virtual)</text>
          {m.a.map((pg, i) => link(pg, i, "A"))}
          {m.b.map((pg, i) => link(pg, i, "B"))}
          {m.frames.map((f, i) => {
            const hh = (rows * rowH) / m.frames.length - 3;
            const y = yFor(i, m.frames.length);
            const on = frameOn(f.pfn);
            return (
              <g key={f.pfn}>
                <rect x={midX} y={y} width={midW} height={hh} rx={2} fill={on ? "var(--fg)" : "var(--bg)"} stroke="var(--faint)" />
                <text x={midX + midW / 2} y={y + hh / 2} dy="0.34em" textAnchor="middle" fontSize={fontSize} style={{ fill: on ? "var(--bg)" : "var(--fg)", ...mono }}>{f.pfn.toString(16)}{f.users.length === 2 ? " ×2" : ""}</text>
              </g>
            );
          })}
          {m.a.map((pg, i) => pageBox(pg, i, "A"))}
          {m.b.map((pg, i) => pageBox(pg, i, "B"))}
        </svg>
      </div>
      <p style={{ fontSize: 13, margin: "10px 0", minHeight: 54 }}>
        <b>{selPage.region}.</b>{" "}
        {sameVa ? "Both processes use the same virtual address" : "The two virtual addresses differ"}: A has {hexVa(m.a[sel.i]!.va)} and B has {hexVa(m.b[sel.i]!.va)}.{" "}
        {selPage.shared ? `Both walks end at frame ${walkA.pfn!.toString(16)}, so one physical copy serves both.` : `The walks end at frames ${walkA.pfn!.toString(16)} and ${walkB.pfn!.toString(16)}. A write by A cannot reach B.`}
      </p>
      <Stats items={[
        { label: "virtual pages mapped", value: m.virtualPages },
        { label: "frames used", value: m.framesUsed },
        { label: "frames saved by sharing", value: m.framesUnshared - m.framesUsed },
        { label: "page tables, both processes", value: `${m.tablesA.tablePages + m.tablesB.tablePages} pages` },
      ]} />
    </Demo>
  );
}
