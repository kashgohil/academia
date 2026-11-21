/** Demos for "Addressing modes": one C access on three ISAs, and one x86 address lowered to RISC-V and AArch64. */
import { useMemo, useState } from "react";
import { Banner, Demo, Legend, Param, SectionLabel, Stats, mono, range, select, seg, toggle } from "../../kit";
import { BASE, CALLS, DISPS, INDEX, MODE_IDS, effAddr, listingById, lowerArm, lowerRv, lowerX86, runListing, runLowered, type Addr, type MInst } from "../../sims/arch/isa";
import { IsaHead, MachineListing, PART_COLOR, PART_LABEL, rvListing } from "./ArchIsaUi";

const isRet = (m: MInst) => /(^|:\s*)ret$/.test(m.text);
const noRet = (l: MInst[]) => l.filter((m) => !isRet(m));
const sumBytes = (l: MInst[]) => l.reduce((s, m) => s + m.bytes.length, 0);

export function IsaPatternDemo() {
  const [id, setId] = useState("sidx");
  const l = listingById(id);
  const run = useMemo(() => runListing(id), [id]);
  const rvInsts = useMemo(() => rvListing(run.program), [run]);
  const cols = [
    { isa: "x86" as const, insts: l.x86 },
    { isa: "arm" as const, insts: l.arm },
    { isa: "rv" as const, insts: rvInsts },
  ];
  return (
    <Demo
      title="One C access, three ISAs"
      controls={<Param spec={select({ label: "C code", options: MODE_IDS.map((x) => ({ value: x, label: listingById(x).title })), default: "sidx" })} value={id} onChange={(v) => setId(v as string)} />}
    >
      <pre style={{ margin: "0 0 10px", padding: "6px 10px", fontSize: 12.5, background: "var(--subtle)", borderRadius: 6, overflowX: "auto", ...mono }}>{l.c}</pre>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        {cols.map((c) => (
          <div key={c.isa} style={{ minWidth: 0 }}>
            <IsaHead isa={c.isa}>{noRet(c.insts).length} instr, {sumBytes(noRet(c.insts))} B</IsaHead>
            <MachineListing isa={c.isa} insts={c.insts} />
          </div>
        ))}
      </div>
      {l.rvZba && (
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          <span className="muted">RISC-V with Zba (hand-written; the hart has no Zba): </span>
          <span style={mono}>{l.rvZba.filter((t) => t !== "ret").join("; ")}</span>
          <span className="muted"> — {l.rvZba.filter((t) => t !== "ret").length} instructions</span>
        </div>
      )}
      {l.perIter && (
        <Stats items={[
          { label: "Loop body, x86-64", value: `${l.perIter.x86} instructions` },
          { label: "Loop body, AArch64", value: `${l.perIter.arm} instructions` },
          { label: "Loop body, RISC-V", value: `${l.perIter.rv} instructions` },
        ]} />
      )}
      <Banner tone={run.ok ? "good" : "bad"} style={{ marginTop: 8 }} label="hart">
        The RISC-V code ran on the hart: {CALLS[id]!.about} = {run.result}, and C says {run.expect}. It retired {run.dynamic} instructions in the function, ret included.
      </Banner>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        x86-64 and AArch64: clang -O2 output, bytes from the object files. RISC-V: hand-written RV32, assembled by the track's assembler.
      </div>
      <Legend items={(["rex", "opcode", "modrm", "disp"] as const).map((k) => ({ label: `x86 ${PART_LABEL[k]}${k === "modrm" ? " and SIB" : k === "disp" ? " and immediate" : ""}`, color: PART_COLOR[k] }))} />
    </Demo>
  );
}

const SCALE = seg("Scale", [["1", "×1"], ["2", "×2"], ["4", "×4"], ["8", "×8"]], "4");

export function IsaLowerDemo() {
  const [di, setDi] = useState(DISPS.indexOf(8));
  const [scale, setScale] = useState("4");
  const [index, setIndex] = useState(true);
  const m: Addr = { scale: Number(scale) as Addr["scale"], index, disp: DISPS[di]! };
  const rv = lowerRv(m), arm = lowerArm(m), x = lowerX86(m);
  const hart = useMemo(() => runLowered(m), [m.scale, m.index, m.disp]);
  const ea = effAddr(m);
  const hx = (v: number) => `0x${(v >>> 0).toString(16)}`;
  const pane = (isa: "x86" | "arm" | "rv", lines: string[], extra: string) => (
    <div style={{ minWidth: 0 }}>
      <IsaHead isa={isa}>{lines.length} instr{extra}</IsaHead>
      <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", fontSize: 12, ...mono }}>
        {lines.map((t, i) => <div key={i} style={{ whiteSpace: "pre" }}>{t}</div>)}
      </div>
    </div>
  );
  return (
    <Demo
      title="Build one address on three ISAs"
      controls={<>
        <Param spec={range({ label: "Displacement", min: 0, max: DISPS.length - 1, step: 1, default: DISPS.indexOf(8), format: (k) => String(DISPS[k]) })} value={di} onChange={(v) => setDi(v as number)} />
        <Param spec={SCALE} value={scale} onChange={(v) => setScale(v as string)} />
        <Param spec={toggle({ label: "Use an index register", default: true })} value={index} onChange={(v) => setIndex(v as boolean)} />
      </>}
    >
      <div style={{ fontSize: 13, marginBottom: 8, ...mono, overflowWrap: "anywhere" }}>
        load 4 bytes from base{index ? ` + index × ${scale}` : ""} {m.disp < 0 ? "−" : "+"} {Math.abs(m.disp)} = {hx(BASE)}{index ? ` + ${INDEX} × ${scale}` : ""} {m.disp < 0 ? "−" : "+"} {Math.abs(m.disp)} = {hx(ea)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {pane("x86", [x.text], `, ${x.bytes.length} B`)}
        {pane("arm", arm.map((t) => t.replace(/\s+/, " ")), `, ${4 * arm.length} B`)}
        {pane("rv", rv.map((t) => t.replace(/\s+/, " ")), `, ${4 * rv.length} B`)}
      </div>
      <SectionLabel>Registers: x86 rdi = base, rsi = index · AArch64 x0, x1 · RISC-V a0, a1</SectionLabel>
      <Banner tone={hart.addr === ea ? "good" : "bad"} label="hart">
        The RISC-V sequence ran on the hart with a0 = {hx(BASE)} and a1 = {INDEX}. Its lw read address {hx(hart.addr)}{hart.addr === ea ? ", the same address." : ", which is wrong."}
        {m.disp < -2048 || m.disp > 2047 ? ` The offset does not fit in 12 signed bits, so lui builds the upper part with a rounding of +0x800.` : ""}
      </Banner>
    </Demo>
  );
}
