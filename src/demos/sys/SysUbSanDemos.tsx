/**
 * Demos for "Sanitizers": ASan's shadow memory (allocate, free, access, and watch the shadow bytes and the inline
 * check), and which tool catches which bug.
 */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, mono, Param, range, SectionLabel, seg, select, tint } from "../../kit";
import { AsanHeap, BUGS, GRANULE, machineReport, SHADOW_LEGEND, SHADOW_OFFSET, shadowAddr, shadowHex, TOOLS, verdict, type BugId, type Verdict } from "../../sims/sys/ub";
import { CodeView } from "./SysUbUi";

// ---------------------------------------------------------------- shadow memory

type Op = { k: "malloc"; v: "a" | "b" | "c"; size: number } | { k: "free"; v: "a" | "b" | "c" };

const hx = (a: number) => "0x" + a.toString(16);

function replay(ops: Op[], qBytes: number) {
  const h = new AsanHeap(qBytes);
  const vars: Partial<Record<"a" | "b" | "c", number>> = {};
  const log: string[] = [];
  let freeErr: string | null = null;
  for (const op of ops) {
    if (op.k === "malloc") {
      const c = h.malloc(op.size, op.v);
      vars[op.v] = c.user;
      log.push(`${op.v} = malloc(${op.size})`);
    } else {
      const p = vars[op.v];
      if (p === undefined) continue;
      const r = h.free(p);
      if (r) freeErr = `AddressSanitizer: ${r.kind === "double-free" ? "attempting double-free" : r.kind} on ${hx(p)}. ${r.where}`;
      log.push(`free(${op.v})`);
    }
  }
  return { h, vars, log, freeErr };
}

function shadowStyle(k: number): { bg: string; fg: string } {
  if (k === 0) return { bg: tint("var(--c3)", 22), fg: "var(--fg)" };
  if (k < 8) return { bg: tint("var(--c2)", 26), fg: "var(--fg)" };
  if (k === 0xfd) return { bg: tint("var(--c4)", 22), fg: "var(--fg)" };
  return { bg: "var(--subtle)", fg: "var(--muted)" };
}

const START: Op[] = [{ k: "malloc", v: "a", size: 40 }, { k: "malloc", v: "b", size: 40 }];
const iSpec = range({ label: "Index i of p[i] (int)", min: -4, max: 20, step: 1, default: 10, format: (v) => `i = ${v}` });
const qSpec = seg("Quarantine", [["64", "64 B"], ["1024", "1 KiB"]], "64");
const sizeSpec = range({ label: "Size of the next malloc", min: 4, max: 48, step: 4, default: 40, format: (v) => `${v} B` });

export function UbShadowDemo() {
  const [ops, setOps] = useState<Op[]>(START);
  const [i, setI] = useState(10);
  const [pv, setPv] = useState<"a" | "b" | "c">("a");
  const [q, setQ] = useState("64");
  const [size, setSize] = useState(40);
  const { h, vars, log, freeErr } = useMemo(() => replay(ops, Number(q)), [ops, q]);
  const base = vars[pv];
  const addr = base === undefined ? undefined : base + 4 * i;
  const acc = addr === undefined ? null : h.access(addr, 4);
  const add = (op: Op) => setOps([...ops, op]);
  const live = (v: "a" | "b" | "c") => vars[v] !== undefined;
  const nextVar = (["a", "b", "c"] as const).find((v) => !live(v)) ?? "c";
  // show from the first chunk to 2 granules past the top, 8 granules (64 bytes) per row
  const from = h.chunks.length ? Math.min(...h.chunks.map((c) => c.start)) : h.top;
  const rows = Math.max(1, Math.ceil((h.top - from) / 64) + 1);
  const gs = h.granules(from, rows * 8);
  const hit = (g: number) => addr !== undefined && g <= addr && addr < g + GRANULE;
  const pSpec = select({ label: "Pointer p", options: (["a", "b", "c"] as const).filter(live).map((v) => ({ value: v, label: v })), default: "a" });
  return (
    <Demo
      title="Shadow memory, one byte per 8"
      actions={<ButtonRow>
        <Btn onClick={() => add({ k: "malloc", v: nextVar, size })} disabled={live("a") && live("b") && live("c")}>{`${nextVar} = malloc(${size})`}</Btn>
        {(["a", "b", "c"] as const).filter(live).map((v) => <Btn key={v} ghost onClick={() => add({ k: "free", v })}>free({v})</Btn>)}
        <Btn ghost onClick={() => { setOps(START); setPv("a"); }}>Reset</Btn>
      </ButtonRow>}
      controls={<>
        <Param spec={iSpec} value={i} onChange={(v) => setI(v as number)} />
        {live(pv) && <Param spec={pSpec} value={pv} onChange={(v) => setPv(v as "a" | "b" | "c")} />}
        <Param spec={sizeSpec} value={size} onChange={(v) => setSize(v as number)} />
        <Param spec={qSpec} value={q} onChange={(v) => setQ(v as string)} />
      </>}
    >
      <div className="muted" style={{ fontSize: 12, ...mono, overflowWrap: "anywhere" }}>{log.join("; ")}</div>
      <SectionLabel>Heap granules: the shadow byte of each 8 bytes (model addresses)</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gap: 3, minWidth: 300 }}>
          {Array.from({ length: rows }, (_, r) => (
            <div key={r}>
              <div className="muted" style={{ fontSize: 10.5, ...mono }}>{hx(from + r * 64)} → shadow {hx(shadowAddr(from + r * 64))}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, minmax(0, 1fr))", gap: 3 }}>
                {gs.slice(r * 8, r * 8 + 8).map((g) => {
                  const st = shadowStyle(g.shadow);
                  const c = h.chunks.find((x) => x.id === g.chunk);
                  const first = c && g.addr === c.user;
                  return (
                    <div key={g.addr} title={`${hx(g.addr)}: shadow ${shadowHex(g.shadow)}`} style={{ border: `1px solid ${hit(g.addr) ? "var(--fg)" : "var(--border)"}`, outline: hit(g.addr) ? "2px solid var(--c1)" : undefined, borderRadius: 4, background: st.bg, color: st.fg, textAlign: "center", padding: "2px 0", ...mono }}>
                      <div style={{ fontSize: 10, height: 13, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden" }}>{first ? `${c!.label}` : ""}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{shadowHex(g.shadow)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", fontSize: 11.5, marginTop: 6 }} className="muted">
        {SHADOW_LEGEND.slice(0, 4).map(([k, t]) => <span key={k}><b style={{ ...mono, color: "var(--fg)" }}>{k}</b> {t}</span>)}
      </div>
      {addr !== undefined && acc && (
        <>
          <SectionLabel>The check before the 4-byte load of {pv}[{i}]</SectionLabel>
          <CodeView lines={[
            `addr   = ${hx(addr)}`,
            `shadow = (addr >> 3) + ${hx(SHADOW_OFFSET)} = ${hx(acc.shadowAt)}`,
            `k      = *shadow = 0x${shadowHex(acc.shadowByte)}`,
            { text: `if (k != 0 && ((addr & 7) + 4 - 1 >= (int8_t)k)) report`, mark: acc.report ? "fact" : undefined, note: acc.report ? "true: report" : "false: the load runs" },
          ]} />
          {acc.report
            ? <Banner tone="bad"><div style={{ ...mono, fontSize: 12.5, overflowWrap: "anywhere" }}><b style={{ color: "var(--c4)" }}>AddressSanitizer: {acc.report.kind}</b><div className="muted">{acc.report.access}</div></div><div style={{ fontSize: 12.5, marginTop: 3 }}>{acc.report.where}</div></Banner>
            : <Banner tone={acc.inChunk !== undefined && h.chunks.find((c) => c.id === acc.inChunk)?.user !== base && acc.shadowByte === 0 ? "warn" : "good"}>
                {acc.shadowByte === 0 && base !== undefined && (addr < base || addr >= base + (h.chunks.find((c) => c.user === base)?.size ?? 0))
                  ? `No report, but ${pv}[${i}] is outside ${pv}: it is a valid byte of another block. ASan checks addresses, not where a pointer came from.`
                  : "No report: the bytes are addressable."}
              </Banner>}
        </>
      )}
      {freeErr && <Banner tone="bad"><span style={{ ...mono, fontSize: 12.5 }}>{freeErr}</span></Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- which tool catches which bug

const V_STYLE: Record<Verdict, { c: string; t: string; mark: string }> = {
  yes: { c: "var(--c3)", t: "catches it", mark: "●" },
  partial: { c: "var(--c2)", t: "sometimes", mark: "◐" },
  no: { c: "var(--faint)", t: "misses it", mark: "·" },
};

export function UbToolsDemo() {
  const [bug, setBug] = useState<BugId>("skip");
  const b = BUGS.find((x) => x.id === bug)!;
  const report = useMemo(() => machineReport(bug), [bug]);
  const bugSpec = select({ label: "Bug", options: BUGS.map((x) => ({ value: x.id, label: x.label })), default: "skip" as string });
  return (
    <Demo title="Which tool catches which bug" controls={<Param spec={bugSpec} value={bug} onChange={(v) => setBug(v as BugId)} />}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 420, width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "2px 4px" }} />
              {TOOLS.map((t) => <th key={t.id} style={{ padding: "2px 3px", fontWeight: 600, fontSize: 11 }}>{t.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {BUGS.map((x) => (
              <tr key={x.id} onClick={() => setBug(x.id)} style={{ cursor: "pointer", background: x.id === bug ? tint("var(--c1)", 14) : undefined }}>
                <td style={{ padding: "2px 4px", whiteSpace: "nowrap" }}>{x.label}</td>
                {TOOLS.map((t) => {
                  const v = verdict(x.id, t.id)[0];
                  return <td key={t.id} title={V_STYLE[v].t} style={{ textAlign: "center", color: V_STYLE[v].c, fontSize: 14 }}>{V_STYLE[v].mark}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>● catches it · ◐ sometimes · · misses it. Click a row.</div>
      <CodeView label={b.label} lines={b.code} style={{ marginTop: 10 }} />
      <SectionLabel>The track's memory model checks provenance, like Miri. It reports:</SectionLabel>
      {report ? (
        <Banner tone="bad">
          <div style={{ ...mono, fontSize: 12.5, overflowWrap: "anywhere" }}><b style={{ color: "var(--c4)" }}>{report.kind}</b><div className="muted">{report.access}</div></div>
          <div style={{ fontSize: 12.5, marginTop: 3 }}>{report.note}</div>
        </Banner>
      ) : <Banner>The memory model has no threads and no signed arithmetic, so it does not run this bug.</Banner>}
      <div style={{ display: "grid", gap: 4, marginTop: 8 }}>
        {TOOLS.map((t) => {
          const [v, why] = verdict(bug, t.id);
          return (
            <div key={t.id} style={{ display: "grid", gridTemplateColumns: "78px 1fr", gap: 8, fontSize: 12.5, borderLeft: `3px solid ${V_STYLE[v].c}`, paddingLeft: 8 }}>
              <b>{t.label}</b>
              <span><span style={{ color: V_STYLE[v].c, fontWeight: 600 }}>{V_STYLE[v].t}.</span> {why}</span>
            </div>
          );
        })}
      </div>
    </Demo>
  );
}
