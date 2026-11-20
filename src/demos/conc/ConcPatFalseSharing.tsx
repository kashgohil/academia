/** Demos for "false-sharing": place fields in cache lines and watch the line moves; chunk size in a parallel loop. */
import { useMemo, useState } from "react";
import { Banner, Btn, ButtonRow, Chip, Demo, Param, Stats, fixed, int, range, seg, sig, tint, toggle, useParams, MONO } from "../../kit";
import { coherenceRun, runParallelFor, type FsAccess, type FsField } from "../../sims/conc/patterns";
import { ThreadTimeline, threadColor } from "./ConcViews";

const SLOT = 8;
const SLOTS_PER_LINE = 8;
const LINES = 4;

interface Preset { label: string; fields: string[]; threads: FsAccess[][]; place: Record<string, number>; note: string }
const w = (field: string): FsAccess => ({ field, write: true });
const r = (field: string): FsAccess => ({ field, write: false });

const PRESETS: Record<string, Preset> = {
  counters: {
    label: "per-thread counters",
    fields: ["count[0]", "count[1]", "count[2]", "count[3]"],
    threads: [[w("count[0]")], [w("count[1]")], [w("count[2]")], [w("count[3]")]],
    place: { "count[0]": 0, "count[1]": 1, "count[2]": 2, "count[3]": 3 },
    note: "Each thread adds to its own slot of an array: long counts[4]. The four slots fill 32 bytes of one line.",
  },
  stats: {
    label: "config next to stats",
    fields: ["config", "requests", "errors"],
    threads: [[r("config"), w("requests")], [r("config"), w("errors")], [r("config"), r("config")]],
    place: { config: 0, requests: 1, errors: 2 },
    note: "All threads read config on each request. T0 counts requests and T1 counts errors. Nobody writes config.",
  },
  spsc: {
    label: "queue head and tail",
    fields: ["head", "tail"],
    threads: [[w("tail"), r("head")], [w("head"), r("tail")]],
    place: { head: 0, tail: 1 },
    note: "A single-producer, single-consumer ring. T0 (producer) writes tail and reads head. T1 (consumer) writes head and reads tail.",
  },
  lock: {
    label: "lock next to data",
    fields: ["lock", "table", "hits"],
    threads: [[w("lock"), r("table"), w("hits"), r("table")], [w("lock"), r("table"), r("table"), r("table")], [r("table"), r("table"), r("table"), r("table")]],
    place: { lock: 0, table: 1, hits: 2 },
    note: "T0 and T1 take a lock word now and then. All three threads read the table pointer often. Only T0 writes hits.",
  },
};

const LAYOUT = {
  preset: seg("Example", [["stats", "config + stats"], ["counters", "counters"], ["spsc", "queue indices"], ["lock", "lock + data"]], "stats"),
  pair: toggle({ label: "Count 128-byte pairs as one line (adjacent-line prefetch)", default: false }),
};

export function ConcPatLayoutDemo() {
  const P = useParams("conc-fs-layout", LAYOUT);
  const preset = PRESETS[P.values.preset]!;
  const pair = P.values.pair;
  const [placed, setPlaced] = useState<{ preset: string; slots: Record<string, number> }>({ preset: P.values.preset, slots: preset.place });
  const slots = placed.preset === P.values.preset ? placed.slots : preset.place;
  const [pick, setPick] = useState<string | null>(null);
  const lineBytes = pair ? 128 : 64;
  const fields: FsField[] = preset.fields.map((name) => ({ name, offset: slots[name]! * SLOT, bytes: SLOT }));
  const res = useMemo(() => coherenceRun({ fields, threads: preset.threads, lineBytes }), [JSON.stringify(fields), preset, lineBytes]); // eslint-disable-line react-hooks/exhaustive-deps
  const who = (name: string) => preset.threads.flatMap((acc, t) => {
    const mine = acc.filter((a) => a.field === name);
    if (!mine.length) return [];
    return [{ t, write: mine.some((a) => a.write) }];
  });
  const lineState = (l: number) => {
    const li = res.lines.find((x) => x.line === Math.floor((l * 64) / lineBytes));
    if (!li || li.threads.length < 2 || li.writers.length === 0) return "ok";
    // True sharing: one field that a writer and another thread both use. Otherwise false sharing.
    const trueShare = li.fields.some((f) => { const ws = who(f); return ws.length > 1 && ws.some((x) => x.write); });
    return trueShare ? "true" : "false";
  };
  const place = (slot: number) => {
    if (!pick) return;
    const next = { ...slots };
    const there = Object.keys(next).find((k) => next[k] === slot);
    if (there) next[there] = next[pick]!;
    next[pick] = slot;
    setPlaced({ preset: P.values.preset, slots: next });
    setPick(null);
  };
  const padAll = () => {
    setPlaced({ preset: P.values.preset, slots: Object.fromEntries(preset.fields.map((f, i) => [f, (i % LINES) * SLOTS_PER_LINE])) });
    setPick(null);
  };
  const reset = () => { setPlaced({ preset: P.values.preset, slots: preset.place }); setPick(null); };
  const transfersPer1k = (l: number) => {
    const key = Math.floor((l * 64) / lineBytes);
    const n = res.transfers.get(key) ?? 0;
    return pair && l % 2 === 1 ? null : n;
  };
  const totalOps = preset.threads.length * 2_000;
  return (
    <Demo
      title="Place the fields, then count the line moves"
      controls={
        <>
          <Param spec={LAYOUT.preset} value={P.values.preset} onChange={(v) => { P.set("preset", v as "counters"); setPick(null); }} />
          <Param spec={LAYOUT.pair} value={pair} onChange={(v) => P.set("pair", v as boolean)} />
        </>
      }
      actions={
        <ButtonRow>
          <Btn ghost onClick={padAll}>One 64-byte line each</Btn>
          <Btn ghost onClick={reset}>Reset</Btn>
        </ButtonRow>
      }
    >
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{preset.note} Click a field, then click a slot to move it.</div>
      <div style={{ display: "grid", gap: 4 }}>
        {Array.from({ length: LINES }, (_, l) => {
          const st = lineState(l);
          const t1k = transfersPer1k(l);
          const edge = st === "false" ? "var(--c4)" : st === "true" ? "var(--c2)" : "var(--border)";
          return (
            <div key={l} style={{ display: "grid", gridTemplateColumns: "54px 1fr", gap: 6, alignItems: "center" }}>
              <div style={{ fontSize: 11, lineHeight: 1.2 }}>
                <div className="muted">line {l}</div>
                <div style={{ fontFamily: MONO, color: st === "ok" ? "var(--muted)" : edge }}>{t1k === null ? "(pair)" : `${int(t1k)} moves`}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${SLOTS_PER_LINE}, 1fr)`, gap: 2, border: `1.5px solid ${edge}`, borderRadius: 5, padding: 2, background: st === "false" ? tint("var(--c4)", 10) : st === "true" ? tint("var(--c2)", 10) : undefined }}>
                {Array.from({ length: SLOTS_PER_LINE }, (_, s) => {
                  const slot = l * SLOTS_PER_LINE + s;
                  const f = preset.fields.find((name) => slots[name] === slot);
                  const acc = f ? who(f) : [];
                  return (
                    <button
                      key={s}
                      onClick={() => (f && !pick ? setPick(f) : place(slot))}
                      style={{
                        minHeight: 40, minWidth: 0, padding: "2px 1px", borderRadius: 4, cursor: "pointer", fontSize: 10, fontFamily: MONO, overflow: "hidden",
                        border: `1.5px ${f ? "solid" : "dashed"} ${f === pick && f ? "var(--fg)" : f ? "var(--muted)" : "var(--border)"}`,
                        background: f ? "var(--bg)" : "transparent", color: "var(--fg)",
                      }}
                      aria-label={f ? `field ${f}` : `empty slot ${slot}`}
                    >
                      {f && <div style={{ wordBreak: "break-all", lineHeight: 1.1 }}>{f}</div>}
                      {f && (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 1, justifyContent: "center", marginTop: 2 }}>
                          {acc.map((a) => <span key={a.t} style={{ fontSize: 9, padding: "0 2px", borderRadius: 3, background: a.write ? threadColor(a.t) : "transparent", color: a.write ? "var(--bg)" : threadColor(a.t), border: `1px solid ${threadColor(a.t)}` }}>T{a.t}{a.write ? "w" : "r"}</span>)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8, fontSize: 11.5 }} className="muted">
        <Chip color="var(--c4)">false sharing</Chip> different fields, one line, at least one writer
        <Chip color="var(--c2)">true sharing</Chip> the same field, and someone writes it
      </div>
      <Stats items={[
        { label: "accesses that miss", value: `${fixed(res.missRate * 100, 1)}%` },
        { label: "line moves per 1,000 accesses", value: int((1_000 * [...res.transfers.values()].reduce((a, b) => a + b, 0)) / totalOps) },
        { label: "accesses per µs, all threads", value: sig(res.total, 3) },
        { label: "if every access hit", value: sig(res.ideal, 3) },
      ]} />
      <Banner tone={res.total > 0.8 * res.ideal ? "good" : res.total > 0.2 * res.ideal ? "warn" : "bad"}>
        The layout reaches {fixed((100 * res.total) / res.ideal, 0)}% of the hit-only speed. Model inputs: a hit costs 1 ns, a line move 100 ns, 2 ns of other work between accesses, 2,000 accesses per thread.
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- chunk size in a parallel loop

const FOR = {
  chunk: range({ label: "Chunk size", min: 0, max: 7, step: 1, default: 0, format: (v) => `${2 ** v} × 8 B` }),
  threads: range({ label: "Threads", min: 1, max: 8, step: 1, default: 4 }),
  compute: range({ label: "Work per element (model input)", min: 1, max: 100, step: 1, default: 5, format: (v) => `${v} ns` }),
};
const SHOW = 64;

export function ConcPatChunkDemo() {
  const P = useParams("conc-fs-chunk", FOR);
  const { chunk: cExp, threads, compute } = P.values;
  const chunk = 2 ** cExp;
  const res = useMemo(() => runParallelFor({ chunk, threads, computeNs: compute, n: 512 }), [chunk, threads, compute]);
  const big = useMemo(() => runParallelFor({ chunk, threads, computeNs: compute, n: 8_192, record: false }), [chunk, threads, compute]);
  const owner = (i: number) => Math.floor(i / chunk) % threads;
  return (
    <Demo
      title="parallel for: out[i] = f(i), chunks dealt round-robin"
      controls={
        <>
          <Param spec={FOR.chunk} value={cExp} onChange={(v) => P.set("chunk", v as number)} />
          <Param spec={FOR.threads} value={threads} onChange={(v) => P.set("threads", v as number)} />
          <Param spec={FOR.compute} value={compute} onChange={(v) => P.set("compute", v as number)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>The first {SHOW} elements of out (8 bytes each), by the thread that writes them. A box is one 64-byte line.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {Array.from({ length: SHOW / 8 }, (_, l) => {
          const ts = new Set(Array.from({ length: 8 }, (_, k) => owner(l * 8 + k)));
          const shared = ts.size > 1;
          return (
            <div key={l} style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 1, padding: 2, borderRadius: 4, border: `1.5px solid ${shared ? "var(--c4)" : "var(--border)"}` }}>
              {Array.from({ length: 8 }, (_, k) => <div key={k} style={{ height: 14, borderRadius: 2, background: threadColor(owner(l * 8 + k)) }} />)}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <ThreadTimeline result={res.run} by="thread" labels={false} />
      </div>
      <Stats items={[
        { label: "lines written by more than one thread", value: `${int(big.sharedLines)} of ${int(big.lines)}` },
        { label: "line moves", value: int(big.transfers) },
        { label: "speedup over one thread", value: `${fixed(big.speedup, 2)}×` },
        { label: "time", value: `${sig(big.makespan / 1_000, 3)} µs` },
      ]} />
      <Banner tone={big.speedup > threads * 0.8 ? "good" : big.speedup < 1 ? "bad" : "warn"}>
        The timeline shows the first 512 elements; the numbers are for 8,192. Hatched time is a core that stalls until the line arrives (1 ns per write hit, 100 ns per line move: model inputs).
      </Banner>
    </Demo>
  );
}
