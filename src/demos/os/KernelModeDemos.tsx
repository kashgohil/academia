/** Lesson: protected mode and long mode. A mode transition stepper, a GDT encoder and a higher-half table builder. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, toggle } from "../../kit";
import { hexVa, isCanonical, parseVa, splitVa } from "../../sims/os/vm/addr";
import {
  ACTION_INFO, CR0, CR4, DESC_FIELD_INFO, DFLAG, DIRECT_MAP, EFER, GOOD_ORDER, KERNEL_PHYS, KERNEL_VMA, MODE_LABEL,
  applyMode, buildBootTables, bytesLE, code32, code64, data32, decodeDesc, descFieldOfBit, describeDesc, encodeDesc, hex64, initialMode, testBit,
  type DescField, type ModeAction, type ModeState,
} from "../../sims/os/kernel";
import { BitGrid, Cap, FlagCell, Msg, Note, Panel, RegCell, RegGrid, Verdict, mono, seg } from "./KernelUi";

const CR0_SHOWN: (keyof typeof CR0)[] = ["PG", "CD", "NW", "WP", "ET", "PE"];
const CR4_SHOWN: (keyof typeof CR4)[] = ["SMAP", "SMEP", "PCIDE", "LA57", "PGE", "PAE", "PSE"];
const EFER_SHOWN: (keyof typeof EFER)[] = ["NXE", "LMA", "LME", "SCE"];
const hex32 = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;

function RegisterRow({ name, value, prev, bits, names }: { name: string; value: number; prev: number; bits: Record<string, number>; names: string[] }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, ...mono, fontSize: 11.5, marginBottom: 2 }}><b style={{ fontWeight: 600 }}>{name}</b><span>{hex32(value)}</span></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {names.map((n) => <FlagCell key={n} name={n} bit={bits[n]!} on={testBit(value, bits[n]!)} hot={testBit(value, bits[n]!) !== testBit(prev, bits[n]!)} />)}
      </div>
    </div>
  );
}

const MODES_ROW: ModeState["mode"][] = ["real", "protected", "compat", "long"];

export function ModeStepperDemo() {
  const [identity, setIdentity] = useState(true);
  const [hist, setHist] = useState<{ s: ModeState; a: ModeAction | null; text: string }[]>([{ s: initialMode(), a: null, text: "The CPU is in real mode, with the BIOS state. The boot code has run cli and loaded an IDT with limit 0. Pick the next instruction." }]);
  const cur = hist[hist.length - 1]!;
  const prev = hist.length > 1 ? hist[hist.length - 2]!.s : cur.s;
  const s = cur.s;
  const doAct = (a: ModeAction) => { const r = applyMode(s, a, { identity }); setHist([...hist, { s: r.next, a, text: r.text }]); };
  const reset = () => setHist([hist[0]!]);
  const runGood = () => {
    let st = initialMode();
    const h = [hist[0]!];
    for (const a of GOOD_ORDER) { const r = applyMode(st, a, { identity }); st = r.next; h.push({ s: st, a, text: r.text }); if (st.mode === "shutdown") break; }
    setHist(h);
  };
  const dead = s.mode === "shutdown";
  return (
    <Demo
      title="Real mode to 64-bit mode, one instruction at a time"
      actions={<>
        <button className="btn" onClick={() => setHist(hist.length > 1 ? hist.slice(0, -1) : hist)} disabled={hist.length <= 1}>Back</button>
        <button className="btn ghost" onClick={reset}>Reset</button>
      </>}
      controls={<Param spec={toggle({ label: "Page tables include an identity map", default: true })} value={identity} onChange={(v) => setIdentity(v as boolean)} />}
    >
      <div style={{ display: "flex", border: `1px solid ${dead ? "var(--c4)" : "var(--border)"}`, borderRadius: 6, overflow: "hidden", marginBottom: 8 }}>
        {dead ? <div style={{ flex: 1, textAlign: "center", padding: "3px 4px", fontSize: 12, background: "var(--c4)", color: "var(--bg)" }}>triple fault: shutdown, then reset</div>
          : MODES_ROW.map((m) => <div key={m} style={{ flex: 1, textAlign: "center", padding: "3px 2px", fontSize: 11.5, background: s.mode === m ? "var(--c5)" : "var(--bg)", color: s.mode === m ? "var(--bg)" : "var(--muted)", transition: "background .2s" }}>{MODE_LABEL[m]}</div>)}
      </div>
      <Msg warn={dead} min={58}>{cur.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <Cap>Next instruction. Try any order.</Cap>
          <div style={{ display: "grid", gap: 3 }}>
            {(Object.keys(ACTION_INFO) as ModeAction[]).map((a) => {
              const used = hist.slice(1).some((h) => h.a === a);
              return (
                <button key={a} className="btn" disabled={dead} onClick={() => doAct(a)} style={{ display: "flex", justifyContent: "space-between", gap: 8, textAlign: "left", padding: "2px 8px", opacity: used ? 0.55 : 1, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5 }}>{ACTION_INFO[a].label}</span>
                  <span className="muted" style={{ ...mono, fontSize: 10.5 }}>{ACTION_INFO[a].asm}</span>
                </button>
              );
            })}
          </div>
          <button className="btn primary" style={{ marginTop: 6 }} onClick={runGood}>Run the usual order</button>
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <Cap>Control registers. A red frame marks a bit that this step changed.</Cap>
          <RegisterRow name="CR0" value={s.cr0} prev={prev.cr0} bits={CR0} names={CR0_SHOWN} />
          <RegisterRow name="CR4" value={s.cr4} prev={prev.cr4} bits={CR4} names={CR4_SHOWN} />
          <RegisterRow name="EFER" value={s.efer} prev={prev.efer} bits={EFER} names={EFER_SHOWN} />
          <RegGrid min={90}>
            <RegCell name="CS" value={`${s.csBits}-bit`} hot={s.csBits !== prev.csBits} />
            <RegCell name="GDTR" value={s.gdt ? "loaded" : "firmware"} hot={s.gdt !== prev.gdt} />
            <RegCell name="CR3" value={s.cr3 === "none" ? "old value" : s.cr3 === "identity" ? "identity + high" : "high only"} hot={s.cr3 !== prev.cr3} />
          </RegGrid>
        </div>
      </div>
      {s.mode === "long" && <Verdict tone="good">64-bit mode. CR0 = {hex32(s.cr0)}, CR4 = {hex32(s.cr4)}, EFER = {hex32(s.efer)}. This took {hist.length - 1} instructions.</Verdict>}
    </Demo>
  );
}

// ---------------------------------------------------------------- GDT encoder

const FIELD_COLOR: Record<DescField, string> = {
  limit: "var(--c3)", base: "var(--c1)", P: "var(--c4)", DPL: "var(--c2)", S: "var(--c5)", E: "var(--c5)", DC: "var(--c5)", RW: "var(--c5)", A: "var(--c5)",
  G: "var(--fg)", DB: "var(--fg)", L: "var(--fg)", AVL: "var(--fg)",
};

const PRESETS: [string, bigint][] = [
  ["Kernel code 64", encodeDesc(code64(0))],
  ["User code 64", encodeDesc(code64(3))],
  ["Kernel code 32", encodeDesc(code32(0))],
  ["Kernel data", encodeDesc(data32(0))],
  ["User data", encodeDesc(data32(3))],
  ["Null", 0n],
];

export function GdtEncoderDemo() {
  const [v, setV] = useState(PRESETS[0]![1]);
  const [field, setField] = useState<DescField>("L");
  const [text, setText] = useState("");
  const d = decodeDesc(v);
  const c = describeDesc(d);
  const paste = (s: string) => {
    setText(s);
    const p = parseVa(s);
    if (p !== null) setV(p);
  };
  return (
    <Demo title="GDT descriptor: click bits, read the meaning">
      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
        {PRESETS.map(([n, val]) => <button key={n} className={`btn${val === v ? " primary" : ""}`} style={{ padding: "1px 8px", fontSize: 12 }} onClick={() => { setV(val); setText(""); }}>{n}</button>)}
      </div>
      <BitGrid value={v} bits={64} colorOf={(b) => FIELD_COLOR[descFieldOfBit(b)]} labelOf={(b) => descFieldOfBit(b)} selected={(b) => descFieldOfBit(b) === field} onHover={(b) => setField(descFieldOfBit(b))} onToggle={(b) => { setV(v ^ (1n << BigInt(b))); setText(""); setField(descFieldOfBit(b)); }} />
      <Note>The grid runs from bit 63 at the top left to bit 0 at the bottom right. Field: <b style={{ fontWeight: 600 }}>{field}</b>. {DESC_FIELD_INFO[field]}</Note>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 10 }}>
        <Panel title="Encoded" style={{ flex: "1 1 220px" }}>
          <div style={{ ...mono, fontSize: 14, fontWeight: 600 }}>{hex64(v)}</div>
          <div className="muted" style={{ ...mono, fontSize: 11, marginTop: 2 }}>bytes in memory: {bytesLE(v).map((x) => x.toString(16).padStart(2, "0")).join(" ")}</div>
          <label style={{ display: "block", fontSize: 11.5, marginTop: 6 }} className="muted">Paste a value to decode it
            <input value={text} onChange={(e) => paste(e.target.value)} placeholder="0x00AF9A000000FFFF" spellCheck={false} style={{ ...mono, display: "block", width: "100%", boxSizing: "border-box", fontSize: 12, padding: "2px 5px", marginTop: 2, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--fg)" }} />
          </label>
        </Panel>
        <Panel title="Decoded" style={{ flex: "1 1 220px" }}>
          <RegGrid min={88}>
            <RegCell name="base" value={`0x${d.base.toString(16)}`} />
            <RegCell name="limit" value={`0x${d.limit.toString(16)}`} />
            <RegCell name="access" value={`0x${d.access.toString(16).padStart(2, "0")}`} />
            <RegCell name="DPL" value={(d.access >> 5) & 3} />
            <RegCell name="L" value={(d.flags >> DFLAG.L) & 1} />
            <RegCell name="D" value={(d.flags >> DFLAG.DB) & 1} />
          </RegGrid>
        </Panel>
      </div>
      <Verdict tone={c.ok ? "good" : "bad"}><b style={{ fontWeight: 600 }}>{v === 0n ? "Null descriptor" : c.kind}.</b> {v === 0n ? "Index 0 must be null. A load of selector 0 into CS raises #GP." : c.problems.join(" ")}</Verdict>
    </Demo>
  );
}

// ---------------------------------------------------------------- higher-half builder

const ADDRS: [string, bigint][] = [
  ["rip before the jump", BigInt(KERNEL_PHYS) + 0x1234n],
  ["rip after the jump", KERNEL_VMA + 0x1234n],
  ["direct map of 16 MiB", DIRECT_MAP + 0x1000000n],
  ["non-canonical", 0x0000800000000000n],
];

export function HigherHalfDemo() {
  const [identity, setIdentity] = useState(true);
  const [high, setHigh] = useState(true);
  const [direct, setDirect] = useState(false);
  const [page, setPage] = useState<"2m" | "4k">("2m");
  const [addr, setAddr] = useState(ADDRS[1]![1]);
  const pt = useMemo(() => buildBootTables({ identity, higherHalf: high, kernelPage: page, directMap: direct }), [identity, high, direct, page]);
  const w = useMemo(() => pt.walk(addr, { user: false, kind: "r" }, { readOnly: true }), [pt, addr]);
  const nodes = useMemo(() => pt.nodes(), [pt]);
  const f = splitVa(addr);
  return (
    <Demo
      title="Build the boot page tables"
      controls={<>
        <Param spec={toggle({ label: "Identity map of the first 4 MiB", default: true })} value={identity} onChange={(v) => setIdentity(v as boolean)} />
        <Param spec={toggle({ label: "Kernel at 0xFFFFFFFF80000000", default: true })} value={high} onChange={(v) => setHigh(v as boolean)} />
        <Param spec={toggle({ label: "Direct map of the first 1 GiB", default: false })} value={direct} onChange={(v) => setDirect(v as boolean)} />
        <Param spec={seg<"2m" | "4k">("Kernel pages", [["2m", "one 2 MiB leaf"], ["4k", "512 of 4 KiB"]], "2m")} value={page} onChange={(v) => setPage(v as "2m" | "4k")} />
      </>}
    >
      <Cap>Walk this address, as the next fetch or load would.</Cap>
      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
        {ADDRS.map(([n, a]) => <button key={n} className={`btn${a === addr ? " primary" : ""}`} style={{ padding: "1px 8px", fontSize: 12 }} onClick={() => setAddr(a)}>{n}</button>)}
      </div>
      <div style={{ ...mono, fontSize: 13, fontWeight: 600 }}>{hexVa(addr)}</div>
      <div className="muted" style={{ ...mono, fontSize: 11, marginBottom: 8 }}>PML4[{f.indices[0]}] PDPT[{f.indices[1]}] PD[{f.indices[2]}] PT[{f.indices[3]}] offset 0x{f.offset.toString(16)}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <Panel title="The walk" style={{ flex: "1 1 240px" }}>
          <div style={{ ...mono, fontSize: 11, lineHeight: 1.5 }}>
            {w.events.map((e) => <div key={e.level} style={{ color: e.present ? undefined : "var(--c4)" }}>{e.name}[{e.index}] {e.present ? (e.leaf ? "leaf" : "table") : "not present"}</div>)}
            {w.events.length === 0 && <div style={{ color: "var(--c4)" }}>No walk: bits 63 to 47 differ.</div>}
          </div>
        </Panel>
        <Panel title="Tables in memory" style={{ flex: "1 1 240px" }}>
          <div style={{ ...mono, fontSize: 11, lineHeight: 1.5 }}>
            {nodes.map((n) => <div key={n.pfn}>{n.name} {n.path.length ? `via [${n.path.join("][")}]` : "(CR3)"}: <span className="muted">{n.used.length > 6 ? `${n.used.length} entries` : `[${n.used.join(", ")}]`}</span></div>)}
          </div>
        </Panel>
      </div>
      <Stats items={[
        { label: "table frames", value: pt.tablePages },
        { label: "table bytes", value: (pt.tableBytes).toLocaleString("en-US") },
        { label: "canonical", value: isCanonical(addr) ? "yes" : "no" },
      ]} />
      {w.ok
        ? <Verdict tone="good">Translated to physical 0x{w.pa!.toString(16)}{w.pageShift! > 12 ? `, in a ${w.pageShift === 21 ? "2 MiB" : "1 GiB"} leaf` : ""}.</Verdict>
        : w.fault!.reason === "non-canonical"
          ? <Verdict tone="bad">Not canonical, so the CPU raises #GP without a walk. Page tables cannot help.</Verdict>
          : <Verdict tone="bad">Not mapped: {w.fault!.level === 0 ? "the top table" : `the table at level ${w.fault!.level}`} has no entry. A fetch here raises #PF, and with no IDT that ends in a triple fault.</Verdict>}
    </Demo>
  );
}
