/** Demos for "x86-64 and Arm compared": one function on three ISAs, flags against compare-and-branch, and length decoding. */
import { useMemo, useState } from "react";
import { Banner, Demo, Legend, MiniTable, Param, SectionLabel, Stats, mono, range, select, seg, tint } from "../../kit";
import { COMPARE_IDS, CONDS, cmp8, decodeStream, listingById, resyncAt, runListing, s8, u8, type MInst, type PartKind } from "../../sims/arch/isa";
import { ByteBox, ISA_COLOR, IsaHead, MachineListing, PART_COLOR, PART_LABEL, rvListing } from "./ArchIsaUi";

const bytesOf = (l: MInst[]) => l.reduce((s, m) => s + m.bytes.length, 0);

export function IsaCompareDemo() {
  const [id, setId] = useState("sum");
  const l = listingById(id);
  const run = useMemo(() => runListing(id), [id]);
  const rv = useMemo(() => rvListing(run.program), [run]);
  const cols = [{ isa: "x86" as const, insts: l.x86 }, { isa: "arm" as const, insts: l.arm }, { isa: "rv" as const, insts: rv }];
  const parts: PartKind[] = ["prefix", "rex", "opcode", "modrm", "disp", "imm"];
  return (
    <Demo title="One function, three machine codes" controls={<Param spec={select({ label: "Function", options: COMPARE_IDS.map((x) => ({ value: x, label: listingById(x).title })), default: "sum" })} value={id} onChange={(v) => setId(v as string)} />}>
      <pre style={{ margin: "0 0 10px", padding: "6px 10px", fontSize: 12.5, background: "var(--subtle)", borderRadius: 6, overflowX: "auto", ...mono }}>{l.c}</pre>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))", gap: 12 }}>
        {cols.map((c) => (
          <div key={c.isa} style={{ minWidth: 0 }}>
            <IsaHead isa={c.isa}>{c.insts.length} instr, {bytesOf(c.insts)} B</IsaHead>
            <MachineListing isa={c.isa} insts={c.insts} dimRet={false} />
          </div>
        ))}
      </div>
      <Legend items={parts.map((p) => ({ label: `x86 ${PART_LABEL[p]}`, color: PART_COLOR[p] }))} />
      <Stats items={[
        { label: "x86-64 bytes per instruction", value: (bytesOf(l.x86) / l.x86.length).toFixed(2) },
        { label: "x86-64 lengths seen", value: [...new Set(l.x86.map((m) => m.bytes.length))].sort((a, b) => a - b).join(", ") + " B" },
        { label: "AArch64 and RV32", value: "4 B each" },
        ...(l.perIter ? [{ label: "Loop body (x86 / Arm / RV)", value: `${l.perIter.x86} / ${l.perIter.arm} / ${l.perIter.rv}` }] : []),
      ]} />
      <Banner tone={run.ok ? "good" : "bad"} label="hart" style={{ marginTop: 6 }}>
        RISC-V: {run.ok ? "the hand-written code ran on the hart and gave the C result" : "wrong result"} ({run.result}). x86-64 and AArch64: clang -O2. The ret rows count here.
      </Banner>
    </Demo>
  );
}

const bits8 = (v: number) => u8(v).toString(2).padStart(8, "0");

export function IsaFlagsDemo() {
  const [a, setA] = useState(100);
  const [b, setB] = useState(-100);
  const f = cmp8(a, b);
  const flag = (name: string, on: boolean, note: string) => (
    <span title={note} style={{ display: "inline-flex", gap: 4, alignItems: "center", padding: "2px 7px", borderRadius: 4, fontSize: 12.5, ...mono, background: on ? tint("var(--c1)", 30) : "var(--subtle)", boxShadow: on ? "inset 0 0 0 1px var(--c1)" : undefined }}>
      {name}<b>{on ? 1 : 0}</b>
    </span>
  );
  return (
    <Demo
      title="Compare two bytes: flags or a compare inside the branch"
      controls={<>
        <Param spec={range({ label: "a (8-bit, signed)", min: -128, max: 127, step: 1, default: 100 })} value={a} onChange={(v) => setA(v as number)} />
        <Param spec={range({ label: "b (8-bit, signed)", min: -128, max: 127, step: 1, default: -100 })} value={b} onChange={(v) => setB(v as number)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "max-content max-content max-content max-content", gap: "2px 12px", fontSize: 12.5, ...mono, overflowX: "auto" }}>
        <span className="muted"></span><span className="muted">bits</span><span className="muted">signed</span><span className="muted">unsigned</span>
        <span>a</span><span>{bits8(a)}</span><span>{s8(a)}</span><span>{u8(a)}</span>
        <span>b</span><span>{bits8(b)}</span><span>{s8(b)}</span><span>{u8(b)}</span>
        <span>a − b</span><span>{bits8(f.diff)}</span><span>{s8(f.diff)}</span><span>{f.diff}</span>
      </div>
      <SectionLabel>After cmp a, b</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>x86</span>
        {flag("ZF", f.zf, "zero")}{flag("SF", f.sf, "sign")}{flag("CF", f.cf, "borrow")}{flag("OF", f.of, "signed overflow")}
        <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>AArch64</span>
        {flag("N", f.n, "negative")}{flag("Z", f.z, "zero")}{flag("C", f.c, "carry = NOT borrow")}{flag("V", f.v, "signed overflow")}
        <span className="muted" style={{ fontSize: 12, marginLeft: 10 }}>RISC-V: no flags</span>
      </div>
      <div style={{ marginTop: 10 }}>
        <MiniTable
          head={["Branch if", "Taken?", "x86: jcc reads", "AArch64: b.cond reads", "RISC-V branch"]}
          rows={CONDS.map((c) => [
            c.c,
            <b key="t" style={{ color: c.take(a, b) ? "var(--c3)" : "var(--muted)" }}>{c.take(a, b) ? "yes" : "no"}</b>,
            <span key="x" style={{ ...mono, whiteSpace: "nowrap" }}>{c.x86}: {c.x86f}</span>,
            <span key="a" style={{ ...mono, whiteSpace: "nowrap" }}>{c.arm}: {c.armf}</span>,
            <span key="r" style={{ ...mono, whiteSpace: "nowrap" }}>{c.rv}</span>,
          ])}
          highlight={(i) => CONDS[i]!.take(a, b)}
        />
      </div>
      <Banner tone={f.of ? "warn" : "info"} style={{ marginTop: 8 }}>
        {f.of
          ? `The subtraction overflows: ${s8(a)} − ${s8(b)} = ${s8(a) - s8(b)} does not fit in 8 signed bits, so SF alone gives the wrong signed answer. That is why jl reads SF ≠ OF.`
          : f.cf
            ? `a < b as unsigned numbers, so x86 sets CF = 1 (a borrow). Arm sets C = 0 for the same compare: its carry is the opposite of a borrow.`
            : `No overflow and no borrow. Move a to 100 and b to −100 to see a signed overflow.`}
      </Banner>
    </Demo>
  );
}

const STREAM_IDS = ["sum", "max2", "addf", "slen"];

export function IsaDecodeDemo() {
  const [isa, setIsa] = useState<"x86" | "arm">("x86");
  const [start, setStart] = useState(1);
  const bytes = useMemo(() => STREAM_IDS.flatMap((id) => listingById(id)[isa].flatMap((m) => m.bytes)), [isa]);
  const truth = useMemo(() => (isa === "x86" ? decodeStream(bytes) : Array.from({ length: bytes.length / 4 }, (_, i) => ({ start: 4 * i, len: 4, parts: [], name: "", valid: true }))), [isa, bytes]);
  const starts = new Set(truth.map((t) => t.start));
  const aligned = isa === "arm" ? start % 4 === 0 : true;
  const got = isa === "x86" ? decodeStream(bytes, start) : aligned ? truth.filter((t) => t.start >= start) : [];
  const resync = isa === "x86" ? (starts.has(start) ? start : resyncAt(truth, start, bytes)) : start;
  const groupOf = new Map<number, number>();
  got.forEach((g, gi) => { for (let i = g.start; i < g.start + g.len; i++) groupOf.set(i, gi); });
  const wrong = got.filter((g) => g.start < resync).length;
  const bad = got.filter((g) => !g.valid && g.start < resync).length;
  return (
    <Demo
      title="Where does the next instruction start?"
      controls={<>
        <Param spec={range({ label: "Start decoding at byte", min: 0, max: 15, step: 1, default: 1 })} value={start} onChange={(v) => setStart(v as number)} />
        <Param spec={seg("ISA", [["x86", "x86-64"], ["arm", "AArch64"]], "x86")} value={isa} onChange={(v) => setIsa(v as "x86" | "arm")} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>{bytes.length} bytes of code (sum, max2, addf, slen). A dark left edge marks a true instruction start.</SectionLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
        {bytes.map((b, i) => {
          const g = groupOf.get(i);
          const before = i < start;
          const off = g !== undefined && got[g]!.start < resync;
          const color = g === undefined ? undefined : !got[g]!.valid ? "var(--c4)" : off ? "var(--c5)" : g % 2 ? ISA_COLOR[isa] : "var(--c3)";
          return <ByteBox key={i} b={b} color={before ? undefined : color} dim={before} mark={starts.has(i)} title={`byte ${i}`} />;
        })}
      </div>
      <Legend items={[{ label: "decoded, in step", color: isa === "x86" ? "var(--c3)" : "var(--c3)" }, { label: "decoded, out of step", color: "var(--c5)" }, { label: "no valid instruction", color: "var(--c4)" }]} />
      {isa === "x86" ? (
        <MiniTable
          head={["Starts at", "Length", "Decoded as", "True start?"]}
          rows={got.slice(0, 7).map((g) => [g.start, g.len, <span key="n" style={{ ...mono, whiteSpace: "nowrap" }}>{g.valid ? g.name : "(bad)"}</span>, starts.has(g.start) ? "yes" : "no"])}
          highlight={(i) => !starts.has(got[i]!.start)}
        />
      ) : null}
      <Stats items={isa === "x86" ? [
        { label: "Back in step at byte", value: resync < 0 ? "never" : resync },
        { label: "Wrong instructions first", value: wrong },
        { label: "Of them, invalid", value: bad },
      ] : [
        { label: "Instruction starts", value: "every 4th byte" },
        { label: "This start", value: aligned ? "a true start" : "not 4-byte aligned" },
      ]} />
      <Banner tone={isa === "arm" ? (aligned ? "good" : "bad") : resync === start ? "good" : "warn"} style={{ marginTop: 6 }}>
        {isa === "arm"
          ? aligned
            ? `Every AArch64 instruction is 4 bytes, so instruction n starts at byte 4n. A decoder can look at many instructions in parallel without decoding the earlier ones first.`
            : `An AArch64 pc must be a multiple of 4. A fetch from byte ${start} raises a PC alignment fault, so a wrong start cannot happen silently.`
          : resync === start
            ? `Byte ${start} is a true start, so every instruction decodes as the compiler wrote it.`
            : `From byte ${start} the decoder reads ${wrong} instruction(s) that the compiler never wrote${bad ? `, ${bad} of them invalid` : ", all of them valid"}. At byte ${resync} it falls back into step. Only the lengths of the earlier instructions tell where an instruction starts.`}
      </Banner>
    </Demo>
  );
}
