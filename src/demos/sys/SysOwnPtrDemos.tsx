/**
 * Demos for "Smart pointers": the bytes of each handle and of its heap allocation (measured with clang++ + libc++
 * and rustc), an Rc cycle on the memory machine, and the run-time borrow flag of a RefCell.
 */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, MiniTable, Param, SectionLabel, StepButtons, StepSlider, mono, seg, select, useStepper } from "../../kit";
import { T, array, layoutC, ptr, struct, type Type } from "../../sims/sys/mem";
import { SIZES, rcCycle, rcSource, refCellStep, type CellOp, type CellState, type Link } from "../../sims/sys/ownership";
import { StructBytes } from "./SysViews";
import { MemStepper } from "./SysOwnUi";

const sizeSpec = select({ label: "Type", options: SIZES.map((s, i) => ({ value: String(i), label: `${s.lang}: ${s.type}` })), default: "2" });

/** A field type of n bytes: a pointer for 8, else an array of words. */
const ofSize = (n: number, pointer: boolean): Type => (n === 8 ? (pointer ? ptr() : T.u64) : array(T.u64, n / 8));

export function SizesDemo() {
  const [k, setK] = useState("2");
  const row = SIZES[Number(k)]!;
  const handle = useMemo(() => layoutC(struct(row.type, row.words.map((w) => [w, ptr()]))), [row]);
  const parts = (row.block ?? []).map((b) => ({ name: b.replace(/ \(\d+\)$/, ""), size: Number(/\((\d+)\)$/.exec(b)?.[1] ?? 0) })).filter((p) => p.size > 0);
  const block = useMemo(() => (parts.length ? layoutC(struct("heap block", parts.map((p) => [p.name, ofSize(p.size, /pointer/.test(p.name))]))) : undefined), [row]);
  return (
    <Demo title="What a smart pointer costs, in bytes" controls={<Param spec={sizeSpec} value={k} onChange={(v) => setK(v as string)} />}>
      <SectionLabel style={{ marginTop: 0 }}>The handle: {row.handle} bytes ({row.words.join(" + ")})</SectionLabel>
      <StructBytes layout={handle} table={false} caption={`${row.type}: ${row.handle} bytes on the stack or in a field`} />
      <SectionLabel>Heap allocations to make one with a 16-byte Widget</SectionLabel>
      {row.allocs.length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>None: it refers to an allocation that a strong pointer made.</div> : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{row.allocs.map((a, i) => <Chip key={i} color="var(--c3)">allocation {i + 1}: {a} bytes</Chip>)}</div>
      )}
      {block && (
        <div style={{ marginTop: 8 }}>
          <StructBytes layout={block} table={false} caption={`the block that holds the counts: ${block.size} bytes`} />
        </div>
      )}
      <Banner>{row.note}</Banner>
    </Demo>
  );
}

const linkSpec = (label: string, def: Link) => seg<Link>(label, [["none", "None"], ["strong", "Rc"], ["weak", "Weak"]], def);
const abSpec = linkSpec("a.next → b", "strong");
const baSpec = linkSpec("b.next → a", "strong");

export function RcCycleDemo() {
  const [ab, setAb] = useState<Link>("strong");
  const [ba, setBa] = useState<Link>("strong");
  const steps = useMemo(() => rcCycle(ab, ba), [ab, ba]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[Math.min(s.i, steps.length - 1)]!;
  const cell = (n: "a" | "b") => {
    const st = cur[n];
    return [n, String(st.strong), String(st.weak), st.freed ? "freed" : st.value === "dropped" ? "dropped, block kept" : s.i < (n === "a" ? 2 : 3) ? "not yet made" : "live"];
  };
  return (
    <Demo
      title="Two Rc nodes that point at each other"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={abSpec} value={ab} onChange={(v) => { setAb(v as Link); s.reset(); }} />
        <Param spec={baSpec} value={ba} onChange={(v) => { setBa(v as Link); s.reset(); }} />
      </>}
    >
      <MemStepper steps={steps} source={rcSource(ab, ba)} s={s} below={
        <div style={{ marginTop: 8 }}>
          <div style={{ overflowX: "auto" }}>
            <MiniTable head={["node", "strong_count", "weak_count", "value"]} rows={[cell("a"), cell("b")]} />
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, ...mono }}>printed by Drop: {cur.printed.length ? cur.printed.join(", ") : "nothing yet"}</div>
        </div>
      } />
    </Demo>
  );
}

const START: CellState = { flag: 0, guards: [] };

export function RefCellDemo() {
  const [st, setSt] = useState<CellState>(START);
  const [log, setLog] = useState<string[]>([]);
  const act = (op: CellOp) => {
    const n = refCellStep(st, op);
    const name = op === "drop" ? `drop(${st.guards[st.guards.length - 1]?.name ?? "nothing"})` : op === "borrow" ? `let r = c.borrow();` : `let w = c.borrow_mut();`;
    setLog([...log.slice(-7), n.panic ? `${name}  → panic` : `${name}  → flag ${n.flag}`]);
    setSt(n.panic ? { ...st, panic: n.panic } : n);
  };
  const flagText = st.flag === 0 ? "unused" : st.flag > 0 ? `${st.flag} shared borrow${st.flag > 1 ? "s" : ""}` : "one mutable borrow";
  return (
    <Demo title="RefCell: the borrow rules, checked at run time" actions={<ButtonRow><Btn ghost onClick={() => { setSt(START); setLog([]); }}>Reset</Btn></ButtonRow>}>
      <ButtonRow>
        <Btn onClick={() => act("borrow")}>c.borrow()</Btn>
        <Btn onClick={() => act("borrow_mut")}>c.borrow_mut()</Btn>
        <Btn ghost onClick={() => act("drop")} disabled={!st.guards.length}>drop the newest guard</Btn>
      </ButtonRow>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 10 }}>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>The borrow flag (an isize next to the value)</SectionLabel>
          <div style={{ ...mono, fontSize: 26, fontWeight: 600, color: st.flag < 0 ? "var(--c2)" : st.flag > 0 ? "var(--c1)" : "var(--muted)" }}>{st.flag}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{flagText}</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {st.guards.map((g) => <Chip key={g.name} color={g.kind === "Ref" ? "var(--c1)" : "var(--c2)"}>{g.name}: {g.kind}</Chip>)}
          </div>
        </div>
        <div>
          <SectionLabel style={{ marginTop: 0 }}>Calls so far</SectionLabel>
          <div style={{ ...mono, fontSize: 12, lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre" }}>{log.length ? log.join("\n") : "none"}</div>
        </div>
      </div>
      {st.panic && <Banner tone="bad"><span style={mono}>thread 'main' panicked: {st.panic}</span>. The compiler accepted this code; the check ran at run time.</Banner>}
    </Demo>
  );
}
