/** Demos for the lesson on address translation in hardware: VIPT geometry, synonyms, and hit timing. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Demo, IndexButtons, MONO, MiniTable, Note, Param, SectionLabel, Stats, bytes, range, seg, tint, useParams } from "../../kit";
import { ALIAS_SCENE, ALIAS_SCRIPT, LATENCY_MODEL, aliasScene, cacheGeometry, hitTiming, type AliasOrg, type Org } from "../../sims/arch/vm";
import { BitStrip } from "./ArchVmUi";

const hex = (v: number) => `0x${v.toString(16)}`;

// ---------------------------------------------------------------- VIPT geometry

const PRESETS = [
  { name: "AMD Zen 3", ways: 8, sets: 64, line: 64, page: "4096" },
  { name: "Intel Sunny Cove", ways: 12, sets: 64, line: 64, page: "4096" },
  { name: "128 KiB, 4 KiB pages", ways: 8, sets: 256, line: 64, page: "4096" },
  { name: "128 KiB, 16 KiB pages", ways: 8, sets: 128, line: 128, page: "16384" },
] as const;

export function ArchVmViptDemo() {
  const p = useParams("vipt", {
    ways: range({ label: "Ways", min: 1, max: 32, step: 1, default: 8 }),
    sets: range({ label: "Sets", min: 16, max: 1024, step: 1, default: 64, log: true, format: (v) => String(2 ** Math.round(Math.log2(v))) }),
    line: seg<"32" | "64" | "128">("Line", [["32", "32 B"], ["64", "64 B"], ["128", "128 B"]], "64"),
    page: seg<"4096" | "16384" | "65536">("Page", [["4096", "4 KiB"], ["16384", "16 KiB"], ["65536", "64 KiB"]], "4096"),
  });
  const sets = 2 ** Math.round(Math.log2(p.values.sets));
  const line = Number(p.values.line);
  const page = Number(p.values.page);
  const ways = p.values.ways;
  const g = cacheGeometry(sets * line * ways, ways, line, page);
  const hi = Math.max(g.offsetBits + g.indexBits, g.pageOffsetBits) + 3;
  const aliasLo = g.pageOffsetBits;
  const fields = [
    { hi: g.offsetBits - 1, lo: 0, label: "line offset", color: "var(--c3)" },
    { hi: Math.min(g.offsetBits + g.indexBits, g.pageOffsetBits) - 1, lo: g.offsetBits, label: "index", color: "var(--c1)" },
    ...(g.aliasBits > 0 ? [{ hi: g.offsetBits + g.indexBits - 1, lo: aliasLo, label: "index from VPN", color: "var(--c4)" }] : []),
  ].filter((f) => f.hi >= f.lo);
  const ok = g.aliasBits === 0;
  return (
    <Demo
      title="Which index bits does the TLB have to translate?"
      controls={<>
        <Param spec={p.schema.ways} value={ways} onChange={(v) => p.set("ways", v as number)} />
        <Param spec={p.schema.sets} value={p.values.sets} onChange={(v) => p.set("sets", v as number)} />
        <Param spec={p.schema.line} value={p.values.line} onChange={(v) => p.set("line", v as "64")} />
        <Param spec={p.schema.page} value={p.values.page} onChange={(v) => p.set("page", v as "4096")} />
      </>}
    >
      <ButtonRow style={{ marginBottom: 10 }}>
        {PRESETS.map((x) => <Btn key={x.name} ghost onClick={() => { p.set("ways", x.ways); p.set("sets", x.sets); p.set("line", String(x.line) as "64"); p.set("page", x.page); }}>{x.name}</Btn>)}
      </ButtonRow>
      <SectionLabel>Low bits of the address</SectionLabel>
      <BitStrip hi={hi} fields={fields} marks={[{ after: g.pageOffsetBits, label: "page offset ends" }]} />
      <Note>Bits to the right of the black rule are the page offset. The TLB does not change them, so the cache can use them before translation ends.</Note>
      <Banner ok={ok}>
        {ok
          ? <>All {g.indexBits} index bits sit inside the page offset. The set read and the TLB lookup can run at the same time, and no alias is possible.</>
          : <>{g.aliasBits} index bit{g.aliasBits > 1 ? "s come" : " comes"} from the virtual page number. One physical line can sit in {g.colors} different sets: {g.colors} page colors. Two virtual names for one frame can then hold two different copies.</>}
      </Banner>
      <Stats items={[
        { label: "cache size", value: bytes(g.sizeBytes) },
        { label: "one way (sets × line)", value: bytes(g.wayBytes) },
        { label: "largest alias-free size, ways × page", value: bytes(g.maxAliasFreeBytes) },
        { label: "ways that this size needs", value: g.minWaysAliasFree },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- synonyms, step by step

const ORGS: [AliasOrg, string][] = [["vipt", "VIPT"], ["vipt-probe", "VIPT + alias probe"], ["pipt", "PIPT"]];

export function ArchVmSynonymDemo() {
  const p = useParams("synonym", {
    org: seg<AliasOrg>("Cache", ORGS, "vipt"),
    color: seg<"other" | "same">("Second name", [["other", "Other color"], ["same", "Same color"]], "other"),
  });
  const [k, setK] = useState(0);
  const run = useMemo(() => {
    const { cache, vaA, vaB, pa } = aliasScene(p.values.org, p.values.color === "same");
    const ops = ALIAS_SCRIPT(vaA, vaB);
    const frames = [{ lines: cache.lines.map((s) => s.map((l) => ({ ...l }))), mem: cache.memory.get(pa) ?? 0, r: null as ReturnType<typeof cache.run> | null }];
    for (const op of ops) {
      const r = cache.run(op);
      frames.push({ lines: cache.lines.map((s) => s.map((l) => ({ ...l }))), mem: cache.memory.get(pa) ?? 0, r });
    }
    return { frames, vaA, vaB, pa, cache, ops };
  }, [p.values.org, p.values.color]);
  const f = run.frames[Math.min(k, run.frames.length - 1)]!;
  const setA = run.cache.setOf(p.values.org === "pipt" ? run.pa : run.vaA);
  const setB = run.cache.setOf(p.values.org === "pipt" ? run.pa : run.vaB);
  const shown = [...new Set([setA, setB, ...run.cache.colorSets(setA)])].sort((a, b) => a - b);
  const label = (op: { kind: string; va?: number; value?: number }) => op.kind === "store" ? `store ${op.value} through ${op.va === run.vaA ? "A" : "B"}` : `load through ${op.va === run.vaA ? "A" : "B"}`;
  const colorOf = (va: number) => (va >> 12) & 1;
  return (
    <Demo
      title="Two virtual names for one frame"
      actions={<IndexButtons k={k} n={run.frames.length} set={setK} />}
      controls={<>
        <Param spec={p.schema.org} value={p.values.org} onChange={(v) => { p.set("org", v as AliasOrg); setK(0); }} />
        <Param spec={p.schema.color} value={p.values.color} onChange={(v) => { p.set("color", v as "same"); setK(0); }} />
      </>}
    >
      <MiniTable
        head={["Name", "Virtual address", "Color (bit 12)", "Physical address"]}
        rows={[
          ["A", <code key="a">{hex(run.vaA)}</code>, colorOf(run.vaA), <code key="pa">{hex(run.pa)}</code>],
          ["B", <code key="b">{hex(run.vaB)}</code>, colorOf(run.vaB), <code key="pb">{hex(run.pa)}</code>],
        ]}
      />
      <Note>{bytes(ALIAS_SCENE.sizeBytes)}, {ALIAS_SCENE.ways}-way, {ALIAS_SCENE.lineBytes}-byte lines, 4 KiB pages. One way is 8 KiB, so index bit 12 comes from the page number.</Note>
      <SectionLabel>Program</SectionLabel>
      <ol style={{ margin: "0 0 6px", paddingLeft: 22, fontFamily: MONO, fontSize: 12.5 }}>
        {run.ops.map((op, i) => <li key={i} style={{ fontWeight: i === k - 1 ? 700 : 400, color: i < k ? "var(--fg)" : "var(--muted)" }}>{label(op)}</li>)}
      </ol>
      <SectionLabel>Cache sets that this frame can use</SectionLabel>
      <div style={{ display: "grid", gap: 4 }}>
        {shown.map((s) => (
          <div key={s} style={{ display: "grid", gridTemplateColumns: "64px repeat(2, minmax(0, 1fr))", gap: 4, alignItems: "stretch" }}>
            <div style={{ fontSize: 12, fontFamily: MONO, alignSelf: "center", fontWeight: f.r?.set === s ? 700 : 400 }}>set {s}</div>
            {f.lines[s]!.map((l, w) => (
              <div key={w} style={{ border: `1px solid ${f.r?.set === s ? "var(--fg)" : "var(--border)"}`, borderRadius: 4, padding: "3px 6px", fontFamily: MONO, fontSize: 12, background: l.valid && l.tag * 64 === run.pa ? tint("var(--c1)", 18) : undefined, minHeight: 22 }}>
                {l.valid ? <>pa {hex(l.tag * 64)} = <b>{l.value}</b>{l.dirty ? " dirty" : ""}</> : <span className="muted">empty</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12.5, marginTop: 6, fontFamily: MONO }}>memory[{hex(run.pa)}] = {f.mem}</div>
      <Banner ok={f.r ? (f.r.op.kind === "load" ? !f.r.stale : true) : undefined}>
        {f.r ? f.r.note : "Press Next to run the program one access at a time."}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- hit timing

const ORG_LABEL: Record<Org, string> = { pipt: "PIPT", vipt: "VIPT", vivt: "VIVT" };
const PART_COLOR = { "TLB": "var(--c2)", "Read the set": "var(--c1)", "Compare tags": "var(--c3)" } as const;

export function ArchVmHitTimingDemo() {
  const p = useParams("hittime", {
    tlb: range({ label: "TLB lookup, cycles", min: 1, max: 4, step: 1, default: LATENCY_MODEL.tlb }),
    index: range({ label: "Set read, cycles", min: 1, max: 4, step: 1, default: LATENCY_MODEL.index }),
  });
  const m = { tlb: p.values.tlb, index: p.values.index, compare: LATENCY_MODEL.compare };
  const rows = (["pipt", "vipt", "vivt"] as Org[]).map((o) => hitTiming(o, m));
  const max = Math.max(...rows.map((r) => r.total));
  const unit = 100 / max;
  return (
    <Demo title="Cycles for an L1 hit" controls={<><Param spec={p.schema.tlb} value={p.values.tlb} onChange={(v) => p.set("tlb", v as number)} /><Param spec={p.schema.index} value={p.values.index} onChange={(v) => p.set("index", v as number)} /></>}>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.org} style={{ display: "grid", gridTemplateColumns: "48px minmax(0, 1fr) 64px", gap: 8, alignItems: "center" }}>
            <b style={{ fontSize: 13 }}>{ORG_LABEL[r.org]}</b>
            <div style={{ position: "relative", height: 38, background: "var(--subtle)", borderRadius: 4 }}>
              {r.parts.map((x, i) => (
                <div key={i} title={x.name} style={{ position: "absolute", left: `${x.start * unit}%`, width: `${(x.end - x.start) * unit}%`, top: x.name === "TLB" ? 2 : x.name === "Read the set" ? 13 : 24, height: 11, background: PART_COLOR[x.name], borderRadius: 2, transition: "all 0.2s" }} />
              ))}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 12.5 }}>{r.total} cycles</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, marginTop: 8 }}>
        {Object.entries(PART_COLOR).map(([k, c]) => <span key={k}><span style={{ display: "inline-block", width: 10, height: 10, background: c, borderRadius: 2, marginRight: 4 }} />{k}</span>)}
      </div>
      <Note>Model inputs, not a real core: the compare takes {LATENCY_MODEL.compare} cycle. VIPT costs the same as VIVT while the TLB is not slower than the set read.</Note>
    </Demo>
  );
}
