/** Demos for "Bloom filters": a filter you can poke, an FPR sweep, and I/Os per missing-key lookup. */
import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Param, Legend, range, Plot, Line, Dots, RuleX, RuleY, pct, Btn, ButtonRow, Note, fixed, mono, seg } from "../../kit";
import {
  BloomFilter, BlockedBloomFilter, bloomFpr, blockedBloomFpr, bestIntegerK, keySets, measureFpr,
  leveledRunSizes, missLookupIos,
} from "../../sims/db/lsm";

// ================= a small filter =================

export const BLOOM_MEMBERS = ["apple", "banana", "cherry", "date", "fig", "grape", "kiwi", "lemon", "mango", "olive", "peach", "pear"];
const PROBES = ["plum", "lime", "melon", "quince", "guava", "apple", "fig"];

/** The first word "w0", "w1", ... that the filter wrongly answers "maybe" for. */
function findFalsePositive(f: BloomFilter, members: Set<string>): string | null {
  for (let i = 0; i < 5000; i++) {
    const w = `w${i}`;
    if (!members.has(w) && f.mayContain(w)) return w;
  }
  return null;
}

export function BloomPlayDemo() {
  const [m, setM] = useState(32);
  const [k, setK] = useState(3);
  const [n, setN] = useState(5);
  const [query, setQuery] = useState("plum");
  const [custom, setCustom] = useState<string | null>(null);
  const members = BLOOM_MEMBERS.slice(0, n);
  const memberSet = new Set(members);
  const f = useMemo(() => { const x = new BloomFilter(m, k); for (const w of BLOOM_MEMBERS.slice(0, n)) x.add(w); return x; }, [m, k, n]);
  const setters = useMemo(() => {
    const c = new Array<string[]>(m).fill([]).map(() => [] as string[]);
    for (const w of members) for (const p of f.positions(w)) if (!c[p]!.includes(w)) c[p]!.push(w);
    return c;
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const measured = useMemo(() => {
    let fp = 0;
    for (let i = 0; i < 4000; i++) if (f.mayContain(`probe:${i}`)) fp++;
    return fp / 4000;
  }, [f]);
  const q = custom ?? query;
  const qpos = f.positions(q);
  const maybe = f.mayContain(q);
  const isMember = memberSet.has(q);
  const zero = qpos.find((p) => !f.bits[p]);
  const cols = m <= 32 ? 16 : m <= 64 ? 16 : 24;
  const filled = f.bits.reduce((s, b) => s + b, 0);
  return (
    <Demo
      title="A Bloom filter, bit by bit"
      controls={
        <>
          <Param spec={range({ label: "Bits in the filter (m)", min: 16, max: 96, step: 8, default: 32 })} value={m} onChange={(v) => { setM(v as number); setCustom(null); }} />
          <Param spec={range({ label: "Hash functions (k)", min: 1, max: 6, step: 1, default: 3 })} value={k} onChange={(v) => { setK(v as number); setCustom(null); }} />
          <Param spec={range({ label: "Keys inserted (n)", min: 0, max: 12, step: 1, default: 5 })} value={n} onChange={(v) => { setN(v as number); setCustom(null); }} />
          <Param spec={seg("Query", PROBES.map((w) => [w, w] as [string, string]), "plum")} value={custom ? "" : query} onChange={(v) => { setQuery(v as string); setCustom(null); }} />
          <ButtonRow>
            <Btn onClick={() => setCustom(findFalsePositive(f, memberSet) ?? null)}>Find a false positive</Btn>
          </ButtonRow>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Inserted: {members.length ? members.map((w) => `${w} → ${f.positions(w).join(", ")}`).join(";  ") : "nothing yet"}</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 2, ...mono }}>
        {Array.from({ length: m }, (_, i) => {
          const on = f.bits[i] === 1;
          const hit = qpos.includes(i);
          return (
            <div key={i} title={setters[i]!.join(", ") || "never set"} style={{ height: 30, borderRadius: 3, display: "grid", placeItems: "center", alignContent: "center", gap: 2, fontSize: 10, background: on ? "var(--c1)" : "var(--subtle)", color: on ? "#fff" : "var(--faint)", outline: hit ? `2px solid ${on ? "var(--c2)" : "var(--c4)"}` : undefined, outlineOffset: hit ? 1 : 0, opacity: on ? 0.55 + 0.45 * Math.min(1, setters[i]!.length / 2) : 1 }}>
              <span style={{ fontSize: 8, lineHeight: 1, opacity: 0.8 }}>{i}</span>
              <span style={{ lineHeight: 1 }}>{on ? 1 : 0}</span>
            </div>
          );
        })}
      </div>
      <p style={{ fontSize: 13, margin: "10px 0 0", minHeight: 40 }}>
        Query <b>{q}</b>: bits {qpos.join(", ")}.{" "}
        {maybe ? (
          <b style={{ color: isMember ? "var(--c3)" : "var(--c4)" }}>{isMember ? "All set: “maybe”, and it is a member." : "All set: “maybe”, but it was never inserted. A false positive: the engine reads a block for nothing."}</b>
        ) : (
          <b style={{ color: "var(--c3)" }}>Bit {zero} is 0: “definitely not here”. The engine skips this file.</b>
        )}
      </p>
      <Stats
        items={[
          { label: "bits per key (m/n)", value: n ? fixed(m / n, 1) : "–" },
          { label: "bits set: measured (formula)", value: `${filled} (${fixed(m * (1 - Math.exp((-k * n) / m)), 1)})` },
          { label: "FPR formula (1 − e^(−kn/m))^k", value: pct(n ? bloomFpr(m / n, k) : 0) },
          { label: "FPR measured, 4,000 probes", value: pct(measured) },
        ]}
      />
      <div style={{ marginTop: 6 }}><Legend box items={[{ label: "bit = 1", color: "var(--c1)" }, { label: "query bit, set", color: "var(--c2)" }, { label: "query bit, 0", color: "var(--c4)" }]} /></div>
    </Demo>
  );
}

// ================= FPR sweep =================

const BPK = Array.from({ length: 20 }, (_, i) => i + 1);
const SETS = { members: 2000, probes: 50000 };

export function BloomSweepDemo() {
  const [mode, setMode] = useState<"best" | "fixed">("best");
  const [kFixed, setKFixed] = useState(3);
  const kFor = (b: number) => (mode === "best" ? bestIntegerK(b) : kFixed);
  const [meas, setMeas] = useState<{ b: number; plain: number; blocked: number }[]>([]);
  const sets = useMemo(() => keySets(SETS.members, SETS.probes), []);
  useEffect(() => {
    setMeas([]);
    let i = 0, alive = true;
    const tick = () => {
      if (!alive || i >= BPK.length) return;
      const b = BPK[i++]!, k = mode === "best" ? bestIntegerK(b) : kFixed;
      const plain = measureFpr((m, kk) => new BloomFilter(m, kk), b, k, sets);
      const blocked = measureFpr((m, kk) => new BlockedBloomFilter(m, kk), b, k, sets);
      setMeas((x) => [...x, { b, plain, blocked }]);
      setTimeout(tick, 0);
    };
    const id = setTimeout(tick, 30);
    return () => { alive = false; clearTimeout(id); };
  }, [mode, kFixed, sets]);
  const floor = 1 / SETS.probes;
  const clamp = (v: number) => Math.max(floor / 2, v);
  const formula = BPK.map((b) => [b, clamp(bloomFpr(b, kFor(b)))] as const);
  const blockedF = BPK.map((b) => [b, clamp(blockedBloomFpr(b, kFor(b)))] as const);
  const at10 = meas.find((x) => x.b === 10);
  return (
    <Demo
      title="False positive rate against bits per key"
      controls={
        <>
          <Param spec={range({ label: "Fixed k", min: 1, max: 12, step: 1, default: 3 })} value={kFixed} onChange={(v) => { setKFixed(v as number); setMode("fixed"); }} />
          <Param spec={seg<"best" | "fixed">("k", [["best", "best k for each point"], ["fixed", "fixed k (slider)"]], "best")} value={mode} onChange={(v) => setMode(v as "best" | "fixed")} />
        </>
      }
    >
      <Plot x={[1, 20]} y={[floor / 2, 1]} logY height={280} xLabel="bits per key (m/n)" yLabel="false positive rate" yTicks={[1e-4, 1e-3, 1e-2, 1e-1, 1]} yFormat={(v) => (v >= 0.01 ? pct(v, 0) : v >= 0.001 ? pct(v, 1) : pct(v, 2))}>
        <RuleY at={0.01} label="1%" />
        <RuleX at={10} label="10 bits/key" />
        <Line points={formula} color="var(--c1)" />
        <Line points={blockedF} color="var(--c2)" dash="5 4" />
        <Dots points={meas.filter((x) => x.plain > 0).map((x) => [x.b, x.plain] as const)} color="var(--c1)" r={3.5} />
        <Dots points={meas.filter((x) => x.blocked > 0).map((x) => [x.b, x.blocked] as const)} color="var(--c2)" r={3} />
      </Plot>
      <Legend items={[{ label: "standard: formula (line), measured (dots)", color: "var(--c1)" }, { label: "cache-line blocked, 512 bits: formula, measured", color: "var(--c2)" }]} />
      <Stats
        items={[
          { label: "k at 10 bits/key", value: kFor(10) },
          { label: "formula at 10 bits/key", value: pct(bloomFpr(10, kFor(10)), 2) },
          { label: "measured at 10 bits/key", value: at10 ? pct(at10.plain, 2) : "…" },
          { label: "blocked at 10 bits/key", value: `${pct(blockedBloomFpr(10, kFor(10)), 2)}${at10 ? ` (${pct(at10.blocked, 2)})` : ""}` },
        ]}
      />
      <Note>{SETS.members.toLocaleString()} keys inserted, {SETS.probes.toLocaleString()} absent keys queried at each point, so rates below {pct(floor, 3)} read as 0 and are not drawn.</Note>
    </Demo>
  );
}

// ================= I/Os per missing-key lookup =================

export function MissIoDemo() {
  const [levels, setLevels] = useState(4);
  const [bpk, setBpk] = useState(10);
  const [l0, setL0] = useState(4);
  const [T, setT] = useState<"4" | "10">("10");
  const runs = useMemo(() => leveledRunSizes(l0, levels, Number(T)), [l0, levels, T]);
  const r = useMemo(() => missLookupIos(runs.map((x) => x.entries), bpk), [runs, bpk]);
  const maxF = Math.max(...r.uniform, ...r.monkey, 1e-9);
  const total = runs.reduce((s, x) => s + x.entries, 0);
  return (
    <Demo
      title="Block reads for a key that does not exist"
      controls={
        <>
          <Param spec={range({ label: "Filter bits per key (whole tree)", min: 0, max: 16, step: 1, default: 10 })} value={bpk} onChange={(v) => setBpk(v as number)} />
          <Param spec={range({ label: "Levels below L0", min: 1, max: 6, step: 1, default: 4 })} value={levels} onChange={(v) => setLevels(v as number)} />
          <Param spec={range({ label: "Files in L0", min: 0, max: 8, step: 1, default: 4 })} value={l0} onChange={(v) => setL0(v as number)} />
          <Param spec={seg<"4" | "10">("Size ratio T", [["4", "4"], ["10", "10"]], "10")} value={T} onChange={(v) => setT(v as "4" | "10")} />
        </>
      }
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(64px, auto) minmax(0, 1fr) minmax(0, 1fr)", gap: "3px 10px", alignItems: "center", fontSize: 12 }}>
        <span className="muted">run (share of keys)</span>
        <span className="muted">same bits everywhere</span>
        <span className="muted">Monkey: fewer bits for big runs</span>
        {runs.map((x, i) => (
          <Row key={x.name} name={x.name} share={x.entries / total} a={r.uniform[i]!} b={r.monkey[i]!} ab={r.uniformBits[i]!} bb={r.monkeyBits[i]!} max={maxF} filters={bpk > 0} />
        ))}
      </div>
      <Stats
        items={[
          { label: "no filters: one block read per run", value: fixed(r.none, 0) },
          { label: "same bits per key in every run", value: fixed(r.uniformTotal, 4) },
          { label: "Monkey allocation, same memory", value: fixed(r.monkeyTotal, 4) },
          { label: "Monkey saves", value: bpk > 0 ? pct(1 - r.monkeyTotal / r.uniformTotal) : "–" },
        ]}
      />
      <Note>Each bar is the false positive rate of one run: the chance that the lookup reads a block of that run for nothing. The sum is the expected number of wasted block reads.</Note>
    </Demo>
  );
}

function Row({ name, share, a, b, ab, bb, max, filters }: { name: string; share: number; a: number; b: number; ab: number; bb: number; max: number; filters: boolean }) {
  const bar = (v: number, bits: number, color: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <div style={{ flex: 1, height: 12, background: "var(--subtle)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${(100 * v) / max}%`, height: "100%", background: color, transition: "width 0.25s" }} />
      </div>
      <span style={{ ...mono, fontSize: 10.5, minWidth: 74, textAlign: "right" }}>{filters ? `${v < 1e-4 ? v.toExponential(0) : pct(v, v < 0.001 ? 3 : 2)} · ${fixed(bits, 1)}b` : "100%"}</span>
    </div>
  );
  return (
    <>
      <span style={{ ...mono, fontSize: 11 }}>{name} <span className="muted">{pct(share, share < 0.01 ? 2 : 1)}</span></span>
      {bar(a, ab, "var(--c1)")}
      {bar(b, bb, "var(--c3)")}
    </>
  );
}

