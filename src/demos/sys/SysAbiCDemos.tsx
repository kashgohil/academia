/** Demos for "The C ABI as lingua franca": one header change on six platforms, and an old program that meets a new library. */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, MiniTable, Param, SectionLabel, Stats, StepButtons, StepCaption, StepSlider, mono, seg, select, useStepper } from "../../kit";
import { TARGETS } from "../../sims/sys/mem";
import { CHANGES, V1_FIELDS, cfgSource, compareAll, compatSource, compatTrace, type Design, type LibChange } from "../../sims/sys/abi";
import { HeapBlocks, StackView, StructBytes, UbBanner } from "./SysViews";
import { AbiSource } from "./SysAbiUi";

const changeSpec = select({ label: "Change in version 2", options: CHANGES.map((c) => ({ value: c.id, label: c.label })), default: "int64" });
const VERDICT = { same: { text: "compatible", tone: "var(--c3)" }, grows: { text: "grows at the end", tone: "var(--c2)" }, breaks: { text: "breaks", tone: "var(--c4)" } } as const;
const SHORT: Record<string, string> = { "x86_64-linux": "x86-64 Linux", "aarch64-linux": "Arm64 Linux", "x86_64-windows": "x86-64 Windows", "i386-linux": "i386 Linux", "riscv64-linux": "RV64 Linux", "riscv32-linux": "RV32 Linux" };

export function AbiHeaderChangeDemo() {
  const [id, setId] = useState("int64");
  const [tgt, setTgt] = useState(0);
  const change = CHANGES.find((c) => c.id === id)!;
  const diffs = useMemo(() => compareAll(change), [change]);
  const d = diffs[tgt]!;
  const breaks = diffs.filter((x) => x.verdict === "breaks").length;
  return (
    <Demo
      title="One header change, six platforms"
      controls={<>
        <Param spec={changeSpec} value={id} onChange={(v) => setId(v as string)} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Version 1 header</SectionLabel>
          <pre style={{ ...mono, fontSize: 12, margin: 0, padding: 8, border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto" }}>{cfgSource(V1_FIELDS)}</pre>
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>The change</SectionLabel>
          <pre style={{ ...mono, fontSize: 12, margin: 0, padding: 8, border: "1px solid var(--border)", borderRadius: 6, overflowX: "auto" }}>
            {change.diff.split("\n").map((l, i) => <div key={i} style={{ color: l.startsWith("+") ? "var(--c3)" : l.startsWith("-") ? "var(--c4)" : "var(--muted)" }}>{l}</div>)}
          </pre>
        </div>
      </div>
      <SectionLabel>Old layout against new layout (click a row to see its bytes)</SectionLabel>
      <MiniTable
        head={["platform", "size", "verdict", "what moved"]}
        highlight={tgt}
        rows={diffs.map((x, i) => [
          <button key="b" className="btn ghost" style={{ padding: "0 4px", fontSize: 12.5 }} onClick={() => setTgt(i)}>{SHORT[x.target]}</button>,
          <span key="s" style={{ whiteSpace: "nowrap" }}>{x.v1.size}→{x.v2.size}</span>,
          <b key="v" style={{ color: VERDICT[x.verdict].tone }}>{VERDICT[x.verdict].text}</b>,
          <span key="m" style={{ ...mono, fontSize: 11.5 }}>{x.moved.join("; ") || "nothing"}</span>,
        ])}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12, marginTop: 8 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>v1 on {TARGETS[d.target].name}</SectionLabel>
          <StructBytes layout={d.v1} bytesPerRow={8} table={false} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel>v2 on {TARGETS[d.target].name}</SectionLabel>
          <StructBytes layout={d.v2} bytesPerRow={8} table={false} />
        </div>
      </div>
      <Banner tone={breaks ? "bad" : diffs.some((x) => x.verdict === "grows") ? "warn" : "good"}>
        {breaks
          ? `The change breaks the ABI on ${breaks} of 6 platforms. A program built with the old header reads the wrong bytes there, with no error from the compiler, the linker or the loader.`
          : diffs.some((x) => x.verdict === "grows")
            ? "No old field moved, but the struct grew. A caller that allocates or copies the struct with the old sizeof now has too few bytes."
            : "Every field keeps its offset and size on every platform: the ABI is the same. Source code may still need a change (a rename breaks the API, not the ABI)."}
      </Banner>
    </Demo>
  );
}

const designSpec = seg<Design>("API design", [["public", "public struct"], ["sized", "size field"], ["opaque", "opaque handle"]], "public");
const libSpec = seg<LibChange>("Version 2 of the library", [["append", "appends retries"], ["insert", "inserts retries"]], "append");

export function AbiOldProgramDemo() {
  const [design, setDesign] = useState<Design>("public");
  const [lib, setLib] = useState<LibChange>("append");
  const steps = useMemo(() => compatTrace(design, lib), [design, lib]);
  const s = useStepper(steps.length, 1);
  const cur = steps[s.i]!;
  const src = compatSource(design);
  const ubLines = new Set(steps.slice(0, s.i + 1).filter((x) => x.ub).map((x) => x.line));
  const budget = cur.snap.frames.find((f) => f.fn === "main" && f.live)?.slots.find((x) => x.name === "budget")?.text ?? "–";
  return (
    <Demo
      title="An old program meets a new library"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={designSpec} value={design} onChange={(v) => { setDesign(v as Design); s.reset(); }} />
        <Param spec={libSpec} value={lib} onChange={(v) => { setLib(v as LibChange); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>The program (built with the v1 header)</SectionLabel>
          <AbiSource lines={src} current={cur.line} bad={ubLines} />
          <Stats items={[
            { label: "budget (should stay 100)", value: budget },
            { label: "s read by the program", value: cur.read ?? "–" },
            { label: "UB reports", value: cur.snap.ub.length },
          ]} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack, high addresses on top</SectionLabel>
          <StackView frames={cur.snap.frames} />
          {design === "opaque" && <>
            <SectionLabel>Heap</SectionLabel>
            <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} small />
          </>}
        </div>
      </div>
      {cur.bytes && cur.appView && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <SectionLabel>The bytes of c, as the program (v1) sees them</SectionLabel>
              <StructBytes layout={cur.appView} bytes={cur.bytes} bytesPerRow={8} table={false} />
            </div>
            {cur.libView && <div style={{ minWidth: 0 }}>
              <SectionLabel>The layout the library (v2) uses</SectionLabel>
              <StructBytes layout={cur.libView} bytesPerRow={8} table={false} />
            </div>}
          </div>
        </div>
      )}
      <StepCaption label={`step ${s.i + 1}`} tone={cur.ub ? "bad" : s.atEnd ? (cur.snap.ub.length || (cur.read && cur.read !== "1.5") ? "bad" : "good") : null}>{cur.text}</StepCaption>
      {cur.ub && <UbBanner event={cur.ub} />}
    </Demo>
  );
}
