/** Lesson: loading a program. ELF bytes with a loader, the initial stack, and lazy binding from the real bytes. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Demo, Param, Stats, range, toggle, useWidth, IndexButtons, IndexSlider, Note, Panel, SmallLabel, mono, tint } from "../../kit";
import { PIE_BASE, buildElf, hexAddr, initialStack, loaderSteps, randomBase, runPlt, stepsToPuts, EXIT, PUTS, RESOLVER, type ElfField, type ElfGroup, type PltRegion, type Vma } from "../../sims/os/processes";
import { Msg } from "./ProcessesUi";

const IMG = buildElf();

const GROUP_COLOR: Record<ElfGroup, string> = {
  ehdr: "var(--c1)", phdr: "var(--c2)", interp: "var(--c3)", hash: "var(--c5)", dynsym: "var(--c5)", dynstr: "var(--c5)", rela: "var(--c5)",
  rodata: "var(--c3)", plt: "var(--c4)", text: "var(--c4)", dynamic: "var(--c2)", got: "var(--c1)", data: "var(--c3)", shstrtab: "var(--faint)", shdr: "var(--faint)",
};
const GROUP_LABEL: [ElfGroup, string][] = [["ehdr", "ELF header"], ["phdr", "program headers"], ["interp", ".interp"], ["dynsym", "dynamic linking data"], ["rodata", ".rodata, .data"], ["text", ".plt, .text"], ["dynamic", ".dynamic"], ["got", ".got.plt"], ["shdr", "section data for tools"]];

const VMA_COLOR = (v: Vma) => v.group === "text" ? "var(--c4)" : v.group === "data" || v.group === "anon" ? "var(--c3)" : v.group === "rodata" ? "var(--c5)" : v.group === "stack" ? "var(--c2)" : "var(--c1)";

const HexByte = ({ o, b, style }: { o: number; b: number; style: CSSProperties }) => <span data-o={o} style={style}>{b.toString(16).padStart(2, "0")}</span>;

export function ElfLoaderDemo() {
  const [k, setK] = useState(0);
  const [aslr, setAslr] = useState(false);
  const [seed, setSeed] = useState(0.37);
  const base = aslr ? randomBase(seed) : PIE_BASE;
  const steps = useMemo(() => loaderSteps(IMG, base), [base]);
  const s = steps[Math.min(k, steps.length - 1)]!;
  const stepField = useMemo(() => (s.field ? IMG.fields.find((f) => f.name === s.field) ?? null : null), [s.field]);
  const [picked, setPicked] = useState<ElfField | null>(null);
  const field = picked ?? stepField;
  const [wrapRef, w] = useWidth<HTMLDivElement>();
  const perRow = w >= 520 ? 16 : 8;
  const box = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const out: number[] = [];
    for (let o = 0; o < IMG.bytes.length; o += perRow) out.push(o);
    return out;
  }, [perRow]);
  const hi = new Set(s.highlight);
  useEffect(() => {
    if (!stepField || picked || !box.current) return;
    const row = Math.floor(stepField.offset / perRow);
    box.current.scrollTop = Math.max(0, row * 17 - 40);
  }, [stepField, picked, perRow]);
  const onClick = (e: React.MouseEvent) => {
    const o = (e.target as HTMLElement).dataset.o;
    if (o === undefined) return;
    setPicked(IMG.fieldAt(Number(o)) ?? null);
  };
  const byteStyle = (o: number): CSSProperties => {
    const f = IMG.fieldAt(o);
    const selected = field && f === field;
    const c = f ? GROUP_COLOR[f.group] : "var(--bg)";
    const strong = f && hi.has(f.group);
    return {
      display: "inline-block", width: Math.max(19, Math.floor((w - 52) / perRow)), textAlign: "center", cursor: f ? "pointer" : "default",
      background: selected ? c : f ? tint(c, strong ? 40 : hi.size ? 9 : 16) : "transparent",
      color: selected ? "var(--bg)" : f ? "var(--fg)" : "var(--faint)",
    };
  };
  const maps = [...s.maps].reverse();
  return (
    <Demo
      title={`A ${IMG.bytes.length}-byte ELF file`}
      actions={<IndexButtons k={k} n={steps.length} set={(v) => { setK(v); setPicked(null); }} />}
      controls={<>
        <IndexSlider k={k} n={steps.length} set={(v) => { setK(v); setPicked(null); }} label="Loader step" />
        <Param spec={toggle({ label: "ASLR on (random load base)", default: false })} value={aslr} onChange={(v) => setAslr(v as boolean)} />
      </>}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2 }}>{k + 1}. {s.title} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({s.mode})</span></div>
      <Msg min={56}>{s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div ref={wrapRef} style={{ flex: "1 1 340px", minWidth: 0 }}>
          <SmallLabel>The file. Click any byte.</SmallLabel>
          <div ref={box} onClick={onClick} style={{ ...mono, fontSize: 11, lineHeight: "17px", height: 238, overflowY: "auto", overflowX: "hidden", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 4px", whiteSpace: "nowrap" }}>
            {rows.map((o) => (
              <div key={o}>
                <span style={{ color: "var(--faint)", marginRight: 6 }}>{o.toString(16).padStart(4, "0")}</span>
                {Array.from({ length: perRow }, (_, i) => o + i).filter((x) => x < IMG.bytes.length).map((x) => <HexByte key={x} o={x} b={IMG.bytes[x]!} style={byteStyle(x)} />)}
              </div>
            ))}
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "6px 8px", marginTop: 6, minHeight: 92 }}>
            {field ? (
              <>
                <div style={{ fontSize: 12.5 }}><b style={{ ...mono, fontWeight: 600 }}>{field.name}</b></div>
                <div style={{ ...mono, fontSize: 11.5 }} className="muted">offset 0x{field.offset.toString(16)}, {field.size} byte{field.size === 1 ? "" : "s"}, value {field.value}</div>
                <p style={{ fontSize: 12.5, margin: "3px 0 0" }}>{field.explain}</p>
              </>
            ) : <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Click a byte to see which field it belongs to.</p>}
          </div>
        </div>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
            <SmallLabel>The address space, high addresses first</SmallLabel>
            {aslr && <button className="btn ghost" style={{ fontSize: 12, padding: "1px 6px" }} onClick={() => setSeed((x) => (x * 9301 + 0.49297) % 1)}>Run again</button>}
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 4, minHeight: 238 }}>
            {maps.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>Nothing is mapped yet.</div>}
            {maps.map((v) => (
              <div key={`${v.start}`} style={{ ...mono, fontSize: 10.5, lineHeight: 1.35, padding: "2px 5px", marginBottom: 2, borderLeft: `3px solid ${VMA_COLOR(v)}`, background: tint(VMA_COLOR(v), 8) }}>
                <div>{hexAddr(v.start)}-{hexAddr(v.end)}</div>
                <div><b style={{ fontWeight: 600 }}>{v.perms}</b> {v.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="legend box" style={{ marginTop: 8 }}>
        {GROUP_LABEL.map(([g, l]) => <span key={g} style={{ ["--swatch" as string]: GROUP_COLOR[g] }}>{l}</span>)}
      </div>
      <Note>This file runs on x86-64 Linux with glibc. It prints its message twice. Offsets of each field follow the ELF64 specification.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- the initial stack

const KIND_COLOR: Record<string, string> = { argc: "var(--c1)", argv: "var(--c2)", envp: "var(--c3)", auxv: "var(--c5)", null: "var(--faint)", data: "var(--faint)" };

export function InitialStackDemo() {
  const [argc, setArgc] = useState(2);
  const [envc, setEnvc] = useState(2);
  const argv = ["./hello", "-v", "input.txt", "out.txt"].slice(0, argc);
  const envp = ["HOME=/root", "PATH=/usr/bin", "LANG=C"].slice(0, envc);
  const { rsp, rows } = useMemo(() => initialStack(argv, envp, IMG), [argc, envc]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Demo title="The stack at the first instruction" controls={<>
      <Param spec={range({ label: "Arguments (argc)", min: 1, max: 4, step: 1, default: 2 })} value={argc} onChange={(v) => setArgc(v as number)} />
      <Param spec={range({ label: "Environment variables", min: 0, max: 3, step: 1, default: 2 })} value={envc} onChange={(v) => setEnvc(v as number)} />
    </>}>
      <SmallLabel>rsp points at the top row. Addresses grow downward on this page. The model has ASLR off.</SmallLabel>
      <div style={{ ...mono, fontSize: 11, lineHeight: 1.45, border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden" }}>
        {rows.map((r) => (
          <div key={r.addr} style={{ display: "flex", gap: 8, padding: "1px 6px", borderLeft: `3px solid ${KIND_COLOR[r.kind]}`, background: r.addr === rsp ? tint("var(--c1)", 14) : undefined, flexWrap: "wrap" }}>
            <span style={{ color: "var(--faint)" }}>{r.addr.toString(16)}</span>
            <b style={{ fontWeight: 600, minWidth: 110 }}>{r.label}</b>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.value}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "rsp at entry", value: <span style={{ fontSize: 13 }}>0x{rsp.toString(16)}</span> },
          { label: "rsp modulo 16", value: rsp % 16 },
          { label: "auxv entries", value: rows.filter((r) => r.kind === "auxv").length },
        ]} />
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- PLT and GOT

const REGION_COLOR: Record<PltRegion, string> = { text: "var(--c1)", plt: "var(--c2)", resolver: "var(--c5)", libc: "var(--c3)" };

interface ListingRow { addr: number; asm: string; head?: string }

function listing(base: number): ListingRow[] {
  const rows: ListingRow[] = [];
  const code = IMG.fields.filter((f) => (f.group === "plt" || f.group === "text") && !f.name.endsWith(": nop")).sort((a, b) => a.offset - b.offset);
  for (const f of code) {
    const addr = base + f.offset + 0x1000;
    const name = f.name.replace(/^(PLT0|puts@plt|exit@plt|_start): /, "");
    const head = addr - base === IMG.sym.plt0 ? "PLT0" : addr - base === IMG.sym.pltPuts ? "puts@plt" : addr - base === IMG.sym.pltExit ? "exit@plt" : addr - base === IMG.sym.start ? "_start" : undefined;
    rows.push({ addr, asm: name, head });
  }
  // .text first, because the program starts there.
  const text = rows.filter((r) => r.addr - base >= IMG.sym.start);
  const plt = rows.filter((r) => r.addr - base < IMG.sym.start);
  return [...text, ...plt, { addr: RESOLVER, asm: "_dl_runtime_resolve", head: "ld.so" }, { addr: PUTS, asm: "puts", head: "libc" }, { addr: EXIT, asm: "exit" }];
}

export function PltStepperDemo() {
  const [k, setK] = useState(0);
  const [bindNow, setBindNow] = useState(false);
  const run = useMemo(() => runPlt(bindNow), [bindNow]);
  const kk = Math.min(k, run.steps.length - 1);
  const s = run.steps[kk]!;
  const rows = useMemo(() => listing(run.base), [run.base]);
  const counts = stepsToPuts(run);
  const label = (v: number) => {
    if (v === PUTS) return "puts (libc)";
    if (v === EXIT) return "exit (libc)";
    if (v === RESOLVER) return "_dl_runtime_resolve";
    const rel = v - run.base;
    if (rel === IMG.sym.pltPuts + 6) return "puts@plt+6";
    if (rel === IMG.sym.pltExit + 6) return "exit@plt+6";
    return `0x${v.toString(16)}`;
  };
  const slots: [string, number, boolean][] = [
    ["GOT[1] link map", s.gotLinkMap, false],
    ["GOT[2] resolver", s.gotResolver, false],
    ["GOT[3] puts", s.gotPuts, s.gotPuts === PUTS],
    ["GOT[4] exit", s.gotExit, s.gotExit === EXIT],
  ];
  return (
    <Demo
      title="Two calls through the PLT"
      actions={<IndexButtons k={kk} n={run.steps.length} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={run.steps.length} set={setK} label="Instruction" />
        <Param spec={toggle({ label: "Bind at load time (LD_BIND_NOW, -z now)", default: false })} value={bindNow} onChange={(v) => { setBindNow(v as boolean); setK(0); }} />
      </>}
    >
      <Msg min={56}><b style={{ ...mono, fontWeight: 600 }}>{s.asm}</b>: {s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <SmallLabel>Code. The bytes come from the ELF file.</SmallLabel>
          <div style={{ ...mono, fontSize: 11.5, lineHeight: 1.5, border: "1px solid var(--border)", borderRadius: 4, padding: 4 }}>
            {rows.map((r) => {
              const on = r.addr === s.rip;
              const reg = r.addr === RESOLVER ? "resolver" : r.addr === PUTS || r.addr === EXIT ? "libc" : r.addr - run.base >= IMG.sym.start ? "text" : "plt";
              return (
                <div key={r.addr}>
                  {r.head && <div style={{ color: "var(--muted)", marginTop: 3 }}>{r.head}:</div>}
                  <div style={{ paddingLeft: 10, borderRadius: 3, background: on ? REGION_COLOR[reg] : undefined, color: on ? "var(--bg)" : undefined, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.asm}</div>
                </div>
              );
            })}
          </div>
        </div>
        <div style={{ flex: "1 1 230px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <Panel title=".got.plt (writable data)">
            <div style={{ ...mono, fontSize: 11.5 }}>
              {slots.map(([n, v, bound]) => (
                <div key={n} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "1px 4px", borderRadius: 3, background: bound ? tint("var(--c3)", 22) : undefined }}>
                  <span className="muted">{n}</span><span style={{ whiteSpace: "nowrap" }}>{label(v)}</span>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="Stack (top last)">
            <div style={{ ...mono, fontSize: 11.5, minHeight: 56 }}>
              {s.stack.length === 0 && <span className="muted">(as at _start)</span>}
              {s.stack.map((x, i) => {
                const n = Number(x);
                return <div key={i}>{Number.isNaN(n) ? x : `return to _start+0x${(n - run.base - IMG.sym.start).toString(16)}`}</div>;
              })}
            </div>
          </Panel>
          <Panel title="Output">
            <div style={{ ...mono, fontSize: 11.5, minHeight: 34 }}>{s.output.map((x, i) => <div key={i}>{x}</div>)}</div>
          </Panel>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Stats items={[
          { label: "resolver runs so far", value: s.resolverRuns },
          { label: "instructions to reach puts, first call", value: counts[0] ?? 0 },
          { label: "instructions to reach puts, second call", value: counts[1] ?? 0 },
        ]} />
      </div>
    </Demo>
  );
}
