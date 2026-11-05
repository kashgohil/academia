/** Lesson: interrupt handling. Stack-level entry stepper, gate encoder and a fault cascade explorer. */
import { useMemo, useState } from "react";
import { Demo, Param, Stats, select, toggle, Banner, IndexButtons, IndexSlider, Note, Panel, SmallLabel, mono, seg, tint } from "../../kit";
import {
  ALL_TRIGGERS, GATE_INTERRUPT, GATE_TRAP, TRIGGER_LABEL, cascade, decodeGate, encodeGate, entrySnaps, hex64,
  type CascadeCfg, type StackRow, type Trigger,
} from "../../sims/os/kernel";
import { BitGrid, Msg, RegCell, RegGrid } from "./KernelUi";

const WHO_COLOR: Record<StackRow["who"], string> = { cpu: "var(--c1)", stub: "var(--c2)", pad: "var(--muted)" };

export function InterruptEntryDemo() {
  const [k, setK] = useState(0);
  const [from, setFrom] = useState<"user" | "kernel">("user");
  const [err, setErr] = useState(true);
  const [gate, setGate] = useState<"interrupt" | "trap">("interrupt");
  const [bug, setBug] = useState(false);
  const snaps = useMemo(() => entrySnaps({ from, errorCode: err, gate, quirkBug: bug }), [from, err, gate, bug]);
  const kk = Math.min(k, snaps.length - 1);
  const s = snaps[kk]!;
  const rows = [...s.stack].reverse();
  return (
    <Demo
      title="One interrupt, at stack level"
      actions={<IndexButtons k={kk} n={snaps.length} set={setK} />}
      controls={<>
        <IndexSlider k={kk} n={snaps.length} set={setK} />
        <Param spec={seg<"user" | "kernel">("Interrupted code", [["user", "ring 3"], ["kernel", "ring 0"]], "user")} value={from} onChange={(v) => setFrom(v as "user" | "kernel")} />
        <Param spec={toggle({ label: "Vector with an error code (#PF)", default: true })} value={err} onChange={(v) => setErr(v as boolean)} />
        <Param spec={seg<"interrupt" | "trap">("Gate type", [["interrupt", "interrupt"], ["trap", "trap"]], "interrupt")} value={gate} onChange={(v) => setGate(v as "interrupt" | "trap")} />
        <Param spec={toggle({ label: "Use the stub of the wrong kind", default: false })} value={bug} onChange={(v) => setBug(v as boolean)} />
      </>}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 2, color: s.bad ? "var(--c4)" : undefined }}>{s.title}</div>
      <Msg warn={s.bad} min={58}>{s.text}</Msg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          <SmallLabel>CPU</SmallLabel>
          <RegGrid min={86}>
            <RegCell name="ring" value={s.ring} />
            <RegCell name="cs" value={s.cs} />
            <RegCell name="IF" value={s.ifFlag ? 1 : 0} />
            <RegCell name="rflags" value={s.rflags} />
          </RegGrid>
          <RegCell name="rip" value={s.rip} style={{ marginTop: 3 }} />
          <RegCell name={`rsp (${s.stackName})`} value={`0x${s.rsp.toString(16)}`} style={{ marginTop: 3 }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11.5, marginTop: 8 }}>
            <span><span style={{ display: "inline-block", width: 9, height: 9, background: WHO_COLOR.cpu, marginRight: 4 }} />pushed by the CPU</span>
            <span><span style={{ display: "inline-block", width: 9, height: 9, background: WHO_COLOR.stub, marginRight: 4 }} />pushed by the stub</span>
          </div>
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <SmallLabel>Kernel stack, newest entry on top: {s.stack.length * 8} bytes</SmallLabel>
          <div style={{ ...mono, fontSize: 10.5, lineHeight: 1.3, border: "1px solid var(--border)", borderRadius: 4, height: 306, overflow: "hidden", padding: 3 }}>
            {rows.length === 0 && <div className="muted" style={{ padding: 3 }}>(nothing pushed)</div>}
            {rows.map((r, i) => (
              <div key={r.addr.toString()} style={{ display: "flex", justifyContent: "space-between", gap: 6, padding: "0 4px", borderLeft: `3px solid ${WHO_COLOR[r.who]}`, background: i === 0 ? tint(WHO_COLOR[r.who], 18) : undefined }}>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>…{r.addr.toString(16).slice(-4)}</span>
                <span style={{ flex: "1 1 auto", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.label}</span>
                <span style={{ whiteSpace: "nowrap" }}>{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- gate encoder

const gateField = (bit: number) => {
  if (bit < 16 || (bit >= 48 && bit < 96)) return "offset";
  if (bit < 32) return "selector";
  if (bit < 35) return "IST";
  if (bit < 40) return "zero";
  if (bit < 44) return "type";
  if (bit === 44) return "zero";
  if (bit < 47) return "DPL";
  if (bit === 47) return "P";
  return "reserved";
};
const GATE_COLOR: Record<string, string> = { offset: "var(--c1)", selector: "var(--c3)", IST: "var(--c2)", type: "var(--c5)", DPL: "var(--c2)", P: "var(--c4)", zero: "var(--faint)", reserved: "var(--faint)" };
const GATE_INFO: Record<string, string> = {
  offset: "The handler address, split in three parts: bits 0 to 15, 48 to 63 and 64 to 95.",
  selector: "The code segment for the handler. It must be a 64-bit ring 0 code segment, such as 0x08.",
  IST: "0 means no stack switch for this reason. 1 to 7 picks a stack from the TSS.",
  type: "0xE is an interrupt gate, which clears IF. 0xF is a trap gate, which leaves IF alone.",
  DPL: "The lowest privilege that may enter with an int n instruction. Hardware interrupts ignore it. Use 3 for int3.",
  P: "Present. If it is 0, using this gate raises #NP.",
  zero: "Must be 0.",
  reserved: "Must be 0.",
};

export function GateEncoderDemo() {
  const [offset, setOffset] = useState(0xffffffff80123456n);
  const [ist, setIst] = useState(0);
  const [trap, setTrap] = useState(false);
  const [dpl3, setDpl3] = useState(false);
  const [present, setPresent] = useState(true);
  const [field, setField] = useState("type");
  const g = { offset, selector: 8, ist, type: trap ? GATE_TRAP : GATE_INTERRUPT, dpl: dpl3 ? 3 : 0, present };
  const { lo, hi } = encodeGate(g);
  const v = (hi << 64n) | lo;
  const dec = decodeGate(lo, hi);
  return (
    <Demo
      title="IDT gate: 16 bytes"
      controls={<>
        <Param spec={seg("IST", [["0", "0"], ["1", "1"], ["2", "2"]], "0")} value={String(ist)} onChange={(x) => setIst(Number(x))} />
        <Param spec={toggle({ label: "Trap gate", default: false })} value={trap} onChange={(x) => setTrap(x as boolean)} />
        <Param spec={toggle({ label: "DPL 3", default: false })} value={dpl3} onChange={(x) => setDpl3(x as boolean)} />
        <Param spec={toggle({ label: "Present", default: true })} value={present} onChange={(x) => setPresent(x as boolean)} />
      </>}
    >
      <BitGrid value={v} bits={128} colorOf={(b) => GATE_COLOR[gateField(b)]!} labelOf={gateField} selected={(b) => gateField(b) === field} onHover={(b) => setField(gateField(b))} onToggle={(b) => {
        const f = gateField(b);
        setField(f);
        if (f === "offset") {
          const shift = b < 16 ? b : b - 32; // bits 48 to 95 hold offset bits 16 to 63
          setOffset(offset ^ (1n << BigInt(shift)));
        }
      }} />
      <Note>Bit 127 is at the top left. Click an offset bit to change the handler address. Field: <b style={{ fontWeight: 600 }}>{field}</b>. {GATE_INFO[field]}</Note>
      <RegGrid min={150}>
        <RegCell name="second word" value={hex64(hi)} />
        <RegCell name="first word" value={hex64(lo)} />
        <RegCell name="handler address" value={`0x${dec.offset.toString(16)}`} />
        <RegCell name="flags byte" value={`0x${((Number((lo >> 40n) & 0xffn))).toString(16).toUpperCase()}`} />
      </RegGrid>
    </Demo>
  );
}

// ---------------------------------------------------------------- cascade

const CFG_FIELDS: [keyof CascadeCfg, string][] = [
  ["idtLoaded", "lidt ran"],
  ["gatePF", "#PF gate"],
  ["gateGP", "#GP and #NP gates"],
  ["gateDF", "#DF gate"],
  ["dfIst", "#DF uses IST1"],
  ["tss", "TSS loaded with ltr"],
];
const CFG_ALL: CascadeCfg = { idtLoaded: true, gatePF: true, gateGP: true, gateDF: true, dfIst: true, tss: true };

export function FaultCascadeDemo() {
  const [cfg, setCfg] = useState<CascadeCfg>(CFG_ALL);
  const [trig, setTrig] = useState<Trigger>("stack-overflow");
  const r = useMemo(() => cascade(cfg, trig), [cfg, trig]);
  const tone = r.outcome === "triple" ? "bad" : r.outcome === "handled" ? "good" : "plain";
  const label = { handled: "Handled. The handler for the original fault ran.", double: "Double fault handled. The kernel can still print a message and stop.", triple: "Triple fault. The CPU enters shutdown, the board resets, and the screen shows only a reboot.", misdiagnosed: "A false alarm. The handler reports a double fault, but this was a timer tick." }[r.outcome];
  return (
    <Demo
      title="Misconfigure it and watch the cascade"
      actions={<button className="btn ghost" onClick={() => setCfg(CFG_ALL)}>All on</button>}
      controls={<>
        <Param spec={select<Trigger>({ label: "What happens", options: ALL_TRIGGERS.map((t) => ({ value: t, label: TRIGGER_LABEL[t] })), default: "stack-overflow" })} value={trig} onChange={(v) => setTrig(v as Trigger)} />
        {CFG_FIELDS.map(([f, l]) => <Param key={f} spec={toggle({ label: l, default: true })} value={cfg[f]} onChange={(v) => setCfg({ ...cfg, [f]: v as boolean })} />)}
      </>}
    >
      <SmallLabel>What the CPU does, in order</SmallLabel>
      <ol style={{ margin: 0, paddingLeft: 22, fontSize: 12.5, lineHeight: 1.5, minHeight: 170 }}>
        {r.events.map((e, i) => <li key={i} style={{ color: e.kind === "shutdown" ? "var(--c4)" : e.bad ? "var(--c2)" : e.kind === "handler" ? "var(--c3)" : undefined, fontWeight: e.kind === "shutdown" || e.kind === "handler" ? 600 : 400 }}>{e.text}</li>)}
      </ol>
      <Banner tone={tone}>{label}</Banner>
      <Stats items={[
        { label: "CPU steps shown", value: r.events.length },
        { label: "handlers that ran", value: r.handlerRuns },
        { label: "nested #PF levels", value: r.deepest },
      ]} />
      <Panel title="The double fault rule" style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, lineHeight: 1.5 }}>A second exception <b style={{ fontWeight: 600 }}>during delivery</b> of the first: contributory after contributory, or page fault or contributory after page fault, gives #DF. A contributory or page fault during #DF delivery gives shutdown. Other pairs run one after the other. A fault after the handler has started is a new exception.</div>
      </Panel>
    </Demo>
  );
}
