/** Lesson: booting. A timeline from power on to the first character, and a linker script explorer. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, toggle, select, bytes, Banner, IndexButtons, IndexSlider, Note, Panel, SmallLabel, mono, seg, tint } from "../../kit";
import { BASE_OPTIONS, DEFAULT_ORDER, SECTIONS, bootStages, layout, type BootPath, type RegionKind, type SectionName, type StageOwner } from "../../sims/os/kernel";
import { Msg, RegCell, RegGrid } from "./KernelUi";

const OWNER_COLOR: Record<StageOwner, string> = { firmware: "var(--c5)", loader: "var(--c2)", kernel: "var(--c1)" };
const KIND_COLOR: Record<RegionKind, string> = { rom: "var(--muted)", firmware: "var(--c5)", loader: "var(--c2)", kernel: "var(--c1)", free: "var(--c3)", unknown: "var(--faint)", device: "var(--muted)" };
const MODES = [["real", "real mode, 16-bit"], ["protected", "protected mode, 32-bit"], ["long", "long mode, 64-bit"]] as const;

export function BootTimelineDemo() {
  const [path, setPath] = useState<BootPath>("uefi");
  const [k, setK] = useState(0);
  const stages = useMemo(() => bootStages(path), [path]);
  const kk = Math.min(k, stages.length - 1);
  const s = stages[kk]!;
  return (
    <Demo
      title="From power on to the first character"
      actions={<IndexButtons k={kk} n={stages.length} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={stages.length} set={setK} label="Stage" />
        <Param spec={seg<BootPath>("Path", [["uefi", "UEFI + Limine"], ["bios", "BIOS + Multiboot2"]], "uefi")} value={path} onChange={(v) => { setPath(v as BootPath); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))`, gap: 2, marginBottom: 4 }}>
        {stages.map((x, i) => (
          <button key={x.id} type="button" aria-label={x.title} title={x.title} onClick={() => setK(i)} style={{ height: 10, padding: 0, border: 0, borderRadius: 2, cursor: "pointer", background: i <= kk ? OWNER_COLOR[x.owner] : tint(OWNER_COLOR[x.owner], 18), outline: i === kk ? "1.5px solid var(--fg)" : "none", outlineOffset: 1 }} />
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginBottom: 8 }}>Who runs now: <b style={{ color: OWNER_COLOR[s.owner], fontWeight: 600 }}>{s.owner}</b></div>
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{s.title}</div>
      <Msg min={76}>{s.text}</Msg>
      <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", marginBottom: 8 }}>
        {MODES.map(([m, label]) => <div key={m} style={{ flex: 1, textAlign: "center", padding: "3px 2px", fontSize: 11.5, background: s.mode === m ? "var(--c5)" : "var(--bg)", color: s.mode === m ? "var(--bg)" : "var(--muted)", transition: "background .2s" }}>{label}</div>)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <SmallLabel>CPU</SmallLabel>
          <RegGrid min={130}>
            <RegCell name="rip" value={s.rip} />
            <RegCell name="paging" value={s.paging} />
            <RegCell name="interrupts" value={s.interrupts} />
            <RegCell name="stack" value={s.stack} />
          </RegGrid>
          <SmallLabel><span style={{ display: "block", marginTop: 8 }}>Serial console (COM1)</span></SmallLabel>
          <div style={{ ...mono, fontSize: 15, border: "1px solid var(--border)", borderRadius: 4, padding: "4px 8px", minHeight: 30, background: "var(--subtle)" }}>{s.console || <span className="muted" style={{ fontSize: 12 }}>nothing yet</span>}</div>
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <SmallLabel>What memory holds</SmallLabel>
          <div style={{ display: "grid", gap: 3 }}>
            {s.regions.map((r) => (
              <div key={r.label} style={{ display: "flex", gap: 7, alignItems: "stretch", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
                <span style={{ width: 6, flex: "none", background: KIND_COLOR[r.kind] }} />
                <div style={{ padding: "1px 4px", minWidth: 0 }}>
                  <div style={{ fontSize: 12 }}>{r.label}</div>
                  <div className="muted" style={{ ...mono, fontSize: 10.5 }}>{r.range}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- linker explorer

const SEC_COLOR: Record<SectionName, string> = { ".text": "var(--c1)", ".rodata": "var(--c3)", ".data": "var(--c2)", ".bss": "var(--c5)" };
const hx = (v: bigint) => `0x${v.toString(16)}`;
const hxShort = (v: bigint, base: bigint) => `+0x${(v - base).toString(16)}`;

export function LinkerExplorerDemo() {
  const [order, setOrder] = useState<SectionName[]>(DEFAULT_ORDER);
  const [base, setBase] = useState("0");
  const [paged, setPaged] = useState(true);
  const b = BASE_OPTIONS[Number(base)]!.base;
  const r = useMemo(() => layout(order, b, paged), [order, b, paged]);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const o = [...order];
    [o[i], o[j]] = [o[j]!, o[i]!];
    setOrder(o);
  };
  const span = Math.max(1, r.memBytes);
  const pages = Math.ceil(span / 4096);
  return (
    <Demo
      title="Linker script explorer"
      actions={<button className="btn ghost" onClick={() => { setOrder(DEFAULT_ORDER); setBase("0"); setPaged(true); }}>Reset</button>}
      controls={<>
        <Param spec={select({ label: "Base address", options: BASE_OPTIONS.map((o, i) => ({ value: String(i), label: o.label })), default: "0" })} value={base} onChange={(v) => setBase(v as string)} />
        <Param spec={toggle({ label: "ALIGN(4K) between different rights", default: true })} value={paged} onChange={(v) => setPaged(v as boolean)} />
      </>}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <SmallLabel>Section order in the script</SmallLabel>
          <div style={{ display: "grid", gap: 3 }}>
            {order.map((n, i) => {
              const s = SECTIONS.find((x) => x.name === n)!;
              return (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, border: `1px solid ${SEC_COLOR[n]}`, borderRadius: 4, padding: "2px 5px", background: tint(SEC_COLOR[n], 8) }}>
                  <b style={{ ...mono, fontSize: 12.5, fontWeight: 600, flex: "1 1 auto" }}>{n}</b>
                  <span className="muted" style={{ ...mono, fontSize: 11 }}>{s.perms} {bytes(s.size)}</span>
                  <button className="btn" style={{ padding: "0 8px" }} aria-label={`move ${n} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="btn" style={{ padding: "0 8px" }} aria-label={`move ${n} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>↓</button>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <SmallLabel>Generated script</SmallLabel>
          <pre style={{ ...mono, fontSize: 10.5, lineHeight: 1.35, margin: 0, padding: "4px 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--subtle)", overflowX: "auto" }}>{r.script}</pre>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <SmallLabel>Memory image. Each tick is one 4 KiB page. The rights of a page cover all sections in it.</SmallLabel>
        <svg viewBox={`0 0 ${pages * 4096} 1`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 32, border: "1px solid var(--border)", borderRadius: 3 }} role="img" aria-label="Sections in memory">
          {r.placed.map((p) => <rect key={p.name} x={Number(p.vma - b)} y={0} width={p.size} height={1} fill={SEC_COLOR[p.name]} opacity={p.nobits ? 0.45 : 0.9} />)}
          {Array.from({ length: pages }, (_, i) => <rect key={i} x={i * 4096 - 12} y={0} width={24} height={1} fill="var(--bg)" />)}
        </svg>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 11.5, marginTop: 4 }}>
          {r.placed.map((p) => <span key={p.name}><span style={{ display: "inline-block", width: 9, height: 9, background: SEC_COLOR[p.name], opacity: p.nobits ? 0.45 : 0.9, marginRight: 4 }} />{p.name} at <span style={mono}>{hxShort(p.vma, b)}</span></span>)}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
        <Panel title="Program headers (PT_LOAD)" style={{ flex: "1 1 240px" }}>
          <div style={{ ...mono, fontSize: 11, lineHeight: 1.5, overflowX: "auto" }}>
            {r.segments.map((s, i) => (
              <div key={i} style={{ color: s.perms === "rwx" ? "var(--c4)" : undefined, whiteSpace: "nowrap" }}>{s.perms} {hxShort(s.vaddr, b)} file {s.filesz} mem {s.memsz} <span className="muted">{s.sections.join(" ")}</span></div>
            ))}
          </div>
        </Panel>
        <Panel title="Symbols" style={{ flex: "1 1 240px" }}>
          <div style={{ ...mono, fontSize: 11, lineHeight: 1.5 }}>
            {r.symbols.map((s) => <div key={s.name} style={{ display: "flex", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}><span className="muted">{s.name}</span><span>{hx(s.addr)}</span></div>)}
          </div>
        </Panel>
      </div>
      <Stats items={[
        { label: "bytes in the file", value: r.fileBytes.toLocaleString("en-US") },
        { label: "bytes in memory", value: r.memBytes.toLocaleString("en-US") },
        { label: "pages with W and X", value: r.wxPages },
      ]} />
      {r.problems.length === 0
        ? <Banner tone="good">This link is clean: each page has one set of rights, and the file stores no zeros for .bss.</Banner>
        : r.problems.map((p) => <Banner key={p.text} tone={p.level === "error" ? "bad" : "plain"}>{p.text}</Banner>)}
      <Note>Section sizes are model inputs. The model places sections and merges segments the way a simple script with GNU ld or LLD does.</Note>
    </Demo>
  );
}
