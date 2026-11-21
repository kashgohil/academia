/** Demos for the lesson on TLBs in hardware: array design sweeps, invalidation instructions, stale entries. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Legend, Line, MONO, Note, Param, Plot, RuleX, SectionLabel, Stats, bytes, pct, range, seg, select, tint, toggle, useChunked, useParams } from "../../kit";
import { FENCES, POLICY_NAMES, applyFence, fenceScene, reachBytes, staleTimeline, tlbMissRate, type AccessPattern, type Isa, type Policy, type TEntry } from "../../sims/arch/vm";

// ---------------------------------------------------------------- miss rate of an array design

const PAGES = Array.from({ length: 21 }, (_, i) => Math.round(2 ** (3 + i * 0.6))); // 8 .. ~32k pages

export function ArchVmTlbSweepDemo() {
  const p = useParams("tlbsweep", {
    entries: range({ label: "Entries", min: 16, max: 1024, step: 1, default: 64, log: true, format: (v) => String(2 ** Math.round(Math.log2(v))) }),
    ways: seg<"1" | "2" | "4" | "8" | "full">("Ways", [["1", "1"], ["2", "2"], ["4", "4"], ["8", "8"], ["full", "Full"]], "full"),
    policy: seg<Policy>("Replacement", [["lru", "LRU"], ["plru", "Tree PLRU"], ["fifo", "FIFO"], ["random", "Random"]], "lru"),
    pattern: seg<AccessPattern>("Accesses", [["random", "Random"], ["loop", "Loop over the set"]], "loop"),
    coalesce: seg<"1" | "4" | "16">("One entry maps", [["1", "1 page"], ["4", "4 pages (Zen)"], ["16", "16 pages (Svnapot)"]], "1"),
    at: range({ label: "Working set, pages", min: 8, max: 32768, step: 1, default: 65, log: true, format: (v) => `${Math.round(v)} (${bytes(Math.round(v) * 4096)})` }),
    contig: range({ label: "Groups that are contiguous", min: 0, max: 1, step: 0.05, default: 1, format: (v) => pct(v, 0) }),
  });
  const entries = 2 ** Math.round(Math.log2(p.values.entries));
  const ways = p.values.ways === "full" ? entries : Math.min(entries, Number(p.values.ways));
  const coalesce = Number(p.values.coalesce);
  const cfg = { entries, ways, policy: p.values.policy, coalesce };
  const base = { entries, ways: entries, policy: "lru" as Policy };
  const key = `${entries}:${ways}:${p.values.policy}:${coalesce}:${p.values.contig}:${p.values.pattern}`;
  const jobs = useMemo(() => [
    ...PAGES.map((n) => () => tlbMissRate(cfg, p.values.pattern, n, p.values.contig, 20_000)),
    ...PAGES.map((n) => () => tlbMissRate(base, p.values.pattern, n, 0, 20_000)),
  ], [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const res = useChunked(key, jobs, { keep: true });
  const at = Math.round(p.values.at);
  const atKey = `${key}:${at}`;
  const atJobs = useMemo(() => [() => tlbMissRate(cfg, p.values.pattern, at, p.values.contig, 20_000), () => tlbMissRate(base, p.values.pattern, at, 0, 20_000)], [atKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const atRes = useChunked(atKey, atJobs, { keep: true });
  const pts = (o: number) => PAGES.map((n, i) => [n * 4096, res[o + i]] as const).filter((q): q is readonly [number, number] => q[1] !== undefined).map(([x, y]) => [x, y * 100] as const);
  const reach = reachBytes(entries, 4096, coalesce);
  return (
    <Demo
      title="TLB miss rate as the working set grows"
      controls={<>
        <Param spec={p.schema.entries} value={p.values.entries} onChange={(v) => p.set("entries", v as number)} />
        <Param spec={p.schema.at} value={p.values.at} onChange={(v) => p.set("at", v as number)} />
        <Param spec={p.schema.contig} value={p.values.contig} onChange={(v) => p.set("contig", v as number)} />
        <Param spec={p.schema.ways} value={p.values.ways} onChange={(v) => p.set("ways", v as "full")} />
        <Param spec={p.schema.policy} value={p.values.policy} onChange={(v) => p.set("policy", v as Policy)} />
        <Param spec={p.schema.pattern} value={p.values.pattern} onChange={(v) => p.set("pattern", v as AccessPattern)} />
        <Param spec={p.schema.coalesce} value={p.values.coalesce} onChange={(v) => p.set("coalesce", v as "1")} />
      </>}
    >
      <Plot x={[PAGES[0]! * 4096, PAGES.at(-1)! * 4096]} y={[0, 100]} logX height={240} xLabel="working set (4 KiB pages)" yLabel="miss rate, %" xFormat={(v) => bytes(v)} xTicks={[2 ** 15, 2 ** 18, 2 ** 21, 2 ** 24, 2 ** 27]}>
        <RuleX at={entries * 4096} label="entries × 4 KiB" />
        <RuleX at={at * 4096} color="var(--fg)" />
        {coalesce > 1 && <RuleX at={reach} label="best-case reach" />}
        <Line points={pts(PAGES.length)} color="var(--faint)" dash="5 4" />
        <Line points={pts(0)} color="var(--c1)" />
      </Plot>
      <Legend items={[{ label: `${ways === entries ? "fully associative" : `${ways}-way`}, ${POLICY_NAMES[p.values.policy]}${coalesce > 1 ? `, coalescing ${coalesce}` : ""}`, color: "var(--c1)" }, { label: "fully associative LRU, no coalescing", color: "var(--faint)" }]} />
      <Stats items={[
        { label: `miss rate at ${at} pages`, value: atRes[0] === undefined ? "…" : pct(atRes[0]) },
        { label: "same, fully associative LRU", value: atRes[1] === undefined ? "…" : pct(atRes[1]) },
        { label: "sets × ways", value: `${entries / ways} × ${ways}` },
        { label: "reach with 4 KiB entries", value: bytes(entries * 4096) },
        { label: "reach if every entry coalesces", value: bytes(reach) },
      ]} />
      <Note>Each point runs 20,000 accesses after a warm-up. Contiguous groups are chosen at random with the fraction on the slider; the slider does nothing while one entry maps one page.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- invalidation instructions

const ISA_NAMES: [Isa, string][] = [["riscv", "RISC-V"], ["x86", "x86-64"], ["arm", "AArch64"]];
const VAS = [{ v: "0x10000", n: 0x10000 }, { v: "0x40000", n: 0x40000 }, { v: "0xfff00000", n: 0xfff00000 }];

export function ArchVmFenceDemo() {
  const [isa, setIsa] = useState<Isa>("riscv");
  const ops = FENCES.filter((f) => f.isa === isa);
  const [opText, setOpText] = useState(ops[0]!.text);
  const op = ops.find((o) => o.text === opText) ?? ops[0]!;
  const p = useParams("fence", {
    va: select({ label: "Address operand", options: VAS.map((x) => ({ value: x.v, label: x.v })), default: "0x10000" }),
    asid: seg<"1" | "2">("ASID or PCID operand", [["1", "1"], ["2", "2"]], "1"),
  });
  const [done, setDone] = useState(false);
  const tlbs = useMemo(() => fenceScene(), []);
  const ctx = { va: VAS.find((x) => x.v === p.values.va)!.n, asid: Number(p.values.asid), current: 1 };
  const result = applyFence(tlbs, op, 0, ctx);
  const usesVa = /a0|invlpg|type 0|vae1|vaae1/.test(op.text);
  const usesAsid = /a1|invpcid type [01]|cr3 \(bit 63 = 0\)|vae1is|aside1/.test(op.text);
  const row = (e: TEntry, gone: boolean) => (
    <tr key={e.id} style={{ textDecoration: gone && done ? "line-through" : undefined, color: gone && done ? "var(--c4)" : undefined, background: gone && !done ? tint("var(--c2)", 18) : undefined }}>
      <td style={td}>0x{(e.vpn * 4096).toString(16)}</td>
      <td style={td}>{e.global ? "G" : e.asid}</td>
      <td style={td}>0x{e.pfn.toString(16)}</td>
    </tr>
  );
  return (
    <Demo
      title="What each invalidation removes, and where"
      actions={<><Btn onClick={() => setDone(true)} disabled={done}>Execute on core 0</Btn><Btn ghost onClick={() => setDone(false)} disabled={!done}>Undo</Btn></>}
      controls={<>
        <Param spec={p.schema.va} value={p.values.va} onChange={(v) => { p.set("va", v as string); setDone(false); }} />
        <Param spec={p.schema.asid} value={p.values.asid} onChange={(v) => { p.set("asid", v as "1"); setDone(false); }} />
      </>}
    >
      <ButtonRow>{ISA_NAMES.map(([k, n]) => <Btn key={k} on={k === isa} ghost={k !== isa} onClick={() => { setIsa(k); setOpText(FENCES.find((f) => f.isa === k)!.text); setDone(false); }}>{n}</Btn>)}</ButtonRow>
      <ButtonRow style={{ marginTop: 6 }}>
        {ops.map((o) => <button key={o.text} className="btn" onClick={() => { setOpText(o.text); setDone(false); }} style={{ fontFamily: MONO, fontSize: 12, outline: o.text === op.text ? "2px solid var(--c1)" : undefined, outlineOffset: -2 }}>{o.text}</button>)}
      </ButtonRow>
      <Banner tone="info">
        <span style={{ fontFamily: MONO }}>{op.text}</span>: {op.note}
        {(usesVa || usesAsid) && <span className="muted"> Operands: {[usesVa ? `address ${p.values.va}` : "", usesAsid ? `ASID ${p.values.asid}` : ""].filter(Boolean).join(", ")}.</span>}
      </Banner>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginTop: 10 }}>
        {tlbs.map((t, i) => (
          <div key={i}>
            <SectionLabel>Core {i}{i === 0 ? " (runs ASID 1, executes the instruction)" : ""}</SectionLabel>
            <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: MONO, fontSize: 12 }}>
              <thead><tr><th style={th}>Virtual page</th><th style={th}>ASID</th><th style={th}>Frame</th></tr></thead>
              <tbody>{t.map((e) => row(e, result.removed[i]!.includes(e.id)))}</tbody>
            </table>
            <div style={{ fontSize: 12, marginTop: 3, color: "var(--muted)" }}>{result.removed[i]!.length} entr{result.removed[i]!.length === 1 ? "y" : "ies"} {done ? "removed" : "will go"}</div>
          </div>
        ))}
      </div>
      <Note>Highlighted rows are the ones that the instruction must remove. An implementation may remove more. {op.broadcast ? "This instruction reaches core 1 in hardware." : "Core 1 keeps its entries: the kernel must interrupt it and have it run its own fence."}</Note>
    </Demo>
  );
}

const td = { padding: "2px 6px", borderBottom: "1px solid var(--border)" } as const;
const th = { ...td, color: "var(--muted)", fontWeight: 600, textAlign: "left" } as const;

// ---------------------------------------------------------------- the stale translation

export function ArchVmStaleDemo() {
  const p = useParams("stale", { fence: toggle({ label: "The kernel executes the fence", default: false }) });
  const steps = staleTimeline(p.values.fence);
  const [k, setK] = useState(0);
  const cur = Math.min(k, steps.length - 1);
  return (
    <Demo
      title="Change a PTE, skip the fence"
      actions={<><Btn onClick={() => setK(Math.max(0, cur - 1))} disabled={cur === 0}>Back</Btn><Btn onClick={() => setK(cur + 1)} disabled={cur >= steps.length - 1}>Next</Btn></>}
      controls={<Param spec={p.schema.fence} value={p.values.fence} onChange={(v) => { p.set("fence", v as boolean); setK(0); }} />}
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
        <thead><tr><th style={th}>Step</th><th style={th}>PTE of P in memory</th><th style={th}>TLB entry for P</th></tr></thead>
        <tbody>
          {steps.slice(0, cur + 1).map((s, i) => (
            <tr key={i} style={{ background: i === cur ? "var(--subtle)" : undefined }}>
              <td style={td}>{s.action}{s.result ? <div style={{ color: s.danger ? "var(--c4)" : "var(--muted)" }}>→ {s.result}</div> : null}</td>
              <td style={{ ...td, fontFamily: MONO }}>{s.pte === null ? "V = 0" : `frame 0x${s.pte.toString(16)}`}</td>
              <td style={{ ...td, fontFamily: MONO }}>{s.tlb === null ? "none" : `frame 0x${s.tlb.toString(16)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Banner ok={cur === steps.length - 1 ? !steps[cur]!.danger : undefined}>
        {cur < steps.length - 1 ? "Press Next." : steps[cur]!.danger
          ? "The hardware used a translation that was valid at some time since the last fence. The spec allows this. The bug is in the kernel."
          : "The fence removed the old entry, so the walker read the new PTE and raised a page fault."}
      </Banner>
    </Demo>
  );
}
