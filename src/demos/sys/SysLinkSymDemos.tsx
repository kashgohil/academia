/** Lesson: symbols and relocation. Two files that declare x in different ways, and relocations applied by hand. */
import { useMemo, useState } from "react";
import { Banner, Demo, IndexButtons, IndexSlider, MiniTable, Note, Param, SectionLabel, SmallLabel, Stats, mono, range, seg, select, tint, toggle } from "../../kit";
import { DECLS, DISASM, declSource, golden, link, resolveTwo, type Decl, type LinkResult } from "../../sims/sys/linking";
import { CodeBox, HexView, hx } from "./SysLinkUi";

const DECL_LABEL: Record<Decl, string> = {
  none: "no x at all", extern: "extern int x;", tentative: "int x;", init: "int x = N;", weak: "weak int x = N;", static: "static int x = N;",
};
const SHORT: Record<Decl, string> = { none: "none", extern: "extern", tentative: "int x", init: "= N", weak: "weak", static: "static" };

export function ResolveDemo() {
  const [a, setA] = useState<Decl>("tentative");
  const [b, setB] = useState<Decl>("init");
  const [common, setCommon] = useState(false);
  const r = resolveTwo(a, b, common);
  const grid = useMemo(() => DECLS.map((x) => DECLS.map((y) => resolveTwo(x, y, common))), [common]);
  const src = (f: "a" | "b", d: Decl) => `${declSource(d, f === "a" ? 1 : 2) || "/* no x */"}\nint get_${f}(void) { return ${d === "none" ? "0" : "x"}; }`;
  const cellColor = (o: ReturnType<typeof resolveTwo>) => (o.error ? "var(--c4)" : o.a.reads === o.b.reads && o.a.reads !== "nothing" && o.a.reads !== "own static" ? "var(--c3)" : "var(--c1)");
  return (
    <Demo
      title="Two files, one name"
      controls={<>
        <Param spec={select<Decl>({ label: "a.c declares", options: DECLS.map((d) => ({ value: d, label: DECL_LABEL[d] })), default: "tentative" })} value={a} onChange={(v) => setA(v as Decl)} />
        <Param spec={select<Decl>({ label: "b.c declares", options: DECLS.map((d) => ({ value: d, label: DECL_LABEL[d] })), default: "init" })} value={b} onChange={(v) => setB(v as Decl)} />
        <Param spec={toggle({ label: "-fcommon (the default before GCC 10 and Clang 11)", default: false })} value={common} onChange={(v) => setCommon(v as boolean)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
        {(["a", "b"] as const).map((f) => (
          <div key={f} style={{ minWidth: 0 }}>
            <SmallLabel>{f}.c → {f}.o: <span style={mono}>{f === "a" ? r.symA : r.symB}</span></SmallLabel>
            <CodeBox>{src(f, f === "a" ? a : b)}</CodeBox>
          </div>
        ))}
      </div>
      <SmallLabel style={{ marginTop: 6 }}>main.c: <span style={mono}>return get_a() * 10 + get_b();</span></SmallLabel>
      {r.error ? (
        <Banner tone="bad" label="ld.lld">
          <span style={mono}>error: {r.error.text}</span>
          <div className="muted" style={{ fontSize: 12 }}>{r.error.detail.join("; ")}</div>
        </Banner>
      ) : (
        <Banner tone="good" label="links">
          main returns <b>{r.ret}</b>. get_a reads {r.a.reads === "nothing" ? "nothing (it returns 0)" : <span style={mono}>{r.a.reads}</span>}; get_b reads {r.b.reads === "nothing" ? "nothing (it returns 0)" : <span style={mono}>{r.b.reads}</span>}.
          {r.a.reads === r.b.reads && r.a.reads !== "nothing" && r.a.reads !== "own static" ? " Both files share one x." : r.a.reads !== "nothing" && r.b.reads !== "nothing" ? " Each file has its own x." : ""}
        </Banner>
      )}
      <SectionLabel>All 36 pairs{common ? " with -fcommon" : ""} (rows: a.c, columns: b.c). Click a cell.</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11, ...mono }}>
          <thead><tr><th />{DECLS.map((d) => <th key={d} style={{ padding: "2px 3px", whiteSpace: "nowrap", fontWeight: 500, color: "var(--muted)" }}>{SHORT[d]}</th>)}</tr></thead>
          <tbody>
            {grid.map((row, i) => (
              <tr key={i}>
                <th style={{ padding: "2px 4px", fontWeight: 500, color: "var(--muted)", textAlign: "right" }}>{SHORT[DECLS[i]!]}</th>
                {row.map((o, j) => {
                  const on = DECLS[i] === a && DECLS[j] === b;
                  const c = cellColor(o);
                  return (
                    <td key={j} onClick={() => { setA(DECLS[i]!); setB(DECLS[j]!); }} style={{ width: 40, height: 24, textAlign: "center", cursor: "pointer", background: tint(c, on ? 60 : 18), border: on ? "2px solid var(--fg)" : "1px solid var(--bg)", color: "var(--fg)" }}>
                      {o.error ? (o.error.text.startsWith("dup") ? "dup" : "undef") : o.ret}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>A number is main's return value. Green: both files share one x. Blue: separate storage, or a file without x. Red: ld.lld stops. All 72 cells match real links with clang 22 and ld.lld 22.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- relocation by hand

const DEFAULT_TEXT = 0x201160;
const fmtGap = (e: number) => (e <= 12 ? "ld.lld's choice" : (() => { const g = 2 ** e; return g >= 2 ** 30 ? `${(g / 2 ** 30).toFixed(g % 2 ** 30 ? 2 : 0)} GiB` : g >= 2 ** 20 ? `${(g / 2 ** 20).toFixed(0)} MiB` : `${(g / 1024).toFixed(0)} KiB`; })());

export function RelocateDemo() {
  const [pie, setPie] = useState(false);
  const [relax, setRelax] = useState(true);
  const [e, setE] = useState(12);
  const [k, setK] = useState(0);
  const objs = useMemo(() => (pie ? [golden("main-pie.o"), golden("lib-pie.o")] : [golden("main.o"), golden("lib.o")]), [pie]);
  const res: LinkResult = useMemo(() => {
    if (e <= 12) return link(objs, { relax });
    return link(objs, { relax, sectionStart: { ".text": DEFAULT_TEXT, ".data": DEFAULT_TEXT + 2 ** e } });
  }, [objs, relax, e]);
  const n = res.relocs.length;
  const i = Math.min(k, n - 1);
  const st = res.relocs[i]!;
  const text = res.sections.find((s) => s.name === ".text")!;
  const dis = DISASM[st.file] ?? [];
  const ins = st.section === ".text" ? dis.find(([o, sz]) => st.offset >= o && st.offset < o + sz) : undefined;
  const insAddr = ins ? text.addr + ins[0] : 0;
  const nextAddr = ins ? insAddr + ins[1] : 0;
  const holeOff = st.section === ".text" ? st.P - text.addr : -1;
  const symRows = [...res.symbols.entries()].sort((x, y) => x[1] - y[1]);
  const signed = (v: number) => (v < 0 ? `-${hx(-v).slice(1)}` : hx(v));
  return (
    <Demo
      title="Apply the relocations of main.o"
      actions={<IndexButtons k={i} n={n} set={setK} />}
      controls={<>
        <IndexSlider k={i} n={n} set={setK} label="Relocation" />
        <Param spec={range({ label: "Distance from .text to .data", min: 12, max: 33, step: 0.5, default: 12, format: fmtGap })} value={e} onChange={(v) => setE(v as number)} />
        <Param spec={seg("Objects compiled with", [["nopic", "-fno-pic"], ["pie", "-fPIE"]], "nopic")} value={pie ? "pie" : "nopic"} onChange={(v) => { setPie(v === "pie"); setK(0); }} />
        {pie && <Param spec={toggle({ label: "Relax GOT loads (off: --no-relax)", default: true })} value={relax} onChange={(v) => setRelax(v as boolean)} />}
      </>}
    >
      <Stats items={[
        { label: ".text at", value: hx(text.addr) },
        { label: ".data at", value: hx(res.sections.find((s) => s.name === ".data")!.addr) },
        { label: "Relocations", value: n },
        { label: "Errors", value: res.errors.length },
      ]} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, marginTop: 6 }}>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>Relocation {i + 1}: {st.section}+{hx(st.offset)} in {st.file}</SmallLabel>
          <CodeBox>{`${st.type}  ${st.symbol}${st.A < 0 ? ` - ${-st.A}` : st.A ? ` + ${st.A}` : ""}\n${ins ? `${ins[2]}` : `.quad ${st.symbol}`}`}</CodeBox>
          <MiniTable head={["term", "meaning", "value"]} rows={[
            ["S", <span key="s">address of <span style={mono}>{st.symbol}</span></span>, <span key="v" style={mono}>{hx(st.S)}</span>],
            ["A", "addend in the entry", <span key="v" style={mono}>{st.A}</span>],
            ...(st.formula.includes("P") ? [["P", "address of the hole", <span key="v" style={mono}>{hx(st.P)}</span>]] : []),
            ...(st.G !== undefined ? [["GOT slot", `holds ${st.symbol}`, <span key="v" style={mono}>{hx(st.G)}</span>]] : []),
          ]} />
          <div style={{ ...mono, fontSize: 12.5, marginTop: 6 }}>{st.formula}</div>
          <div style={{ ...mono, fontSize: 13, fontWeight: 600 }}>= {signed(st.value)} ({st.value})</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <SmallLabel>Bytes of the hole</SmallLabel>
          <div style={{ ...mono, fontSize: 12.5, display: "grid", gridTemplateColumns: "56px 1fr", gap: 2 }}>
            <span className="muted">before</span><span>{st.before.map((x) => x.toString(16).padStart(2, "0")).join(" ") || "(no file bytes)"}</span>
            <span className="muted">after</span><span style={{ color: st.error ? "var(--c4)" : "var(--c3)", fontWeight: 600 }}>{st.error ? "not written" : st.after.map((x) => x.toString(16).padStart(2, "0")).join(" ")}</span>
          </div>
          <Note>Little-endian: the lowest byte comes first. A 4-byte hole holds a signed 32-bit value; an 8-byte hole holds a full address.</Note>
          {ins && /PC32|PLT32|GOTPCREL/.test(st.type) ? (
            <Note>The CPU adds the hole to the address of the next instruction, {hx(nextAddr)}. {hx(nextAddr)} + ({signed(st.value)}) = {hx(nextAddr + st.value)}, which is {st.G !== undefined ? "the GOT slot" : <span style={mono}>{st.symbol}</span>}. The addend {st.A} corrects for the {nextAddr - st.P} bytes between the hole and the next instruction.</Note>
          ) : null}
          {st.relaxed && <Banner tone="info" label="relaxed">{st.relaxed}. The opcode byte changes from 8b to 8d, and no GOT slot is needed.</Banner>}
        </div>
      </div>
      {st.error ? <Banner tone="bad" label="ld.lld"><span style={{ ...mono, fontSize: 12, overflowWrap: "anywhere" }}>error: {st.error}</span></Banner>
        : <Banner tone="good" label="ok">{st.width === 8 ? "An absolute address: S + A. It needs all 8 bytes." : `The value fits in 32 bits (from −2³¹ to 2³¹ − 1).`}</Banner>}
      <SectionLabel>Output .text after all relocations (current hole dark)</SectionLabel>
      <HexView bytes={text.bytes} base={text.addr} color={(o) => (o >= 0x30 ? "var(--c1)" : "var(--c4)")} strong={(o) => holeOff >= 0 && o >= holeOff && o < holeOff + st.width} height={74} />
      <SectionLabel>Symbols after layout</SectionLabel>
      <div style={{ ...mono, fontSize: 11.5, display: "flex", flexWrap: "wrap", gap: "2px 12px" }}>
        {symRows.map(([name, addr]) => <span key={name}><span className="muted">{name.replace(/^.*:/, "")}</span> {hx(addr)}</span>)}
      </div>
    </Demo>
  );
}
