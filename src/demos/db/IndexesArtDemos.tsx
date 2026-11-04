/** Demos for "Tries and adaptive radix trees": ART builder, key encoding, memory per key. */
import { useMemo, useState } from "react";
import { Demo, Stats, Param, range, Plot, Line, Dots, RuleX, Legend, pct } from "../../kit";
import {
  ART, encodeU32, encodeString, encodeI32, encodeF64, rawI32LE, rawI32BE, concatBytes, compareBytes, hex, artKeys, btreeBytesPerKey, hashBytesPerKey,
  NODE_BYTES, ART_WORDS, type ArtEvent, type ArtInner, type NodeType,
} from "../../sims/db/indexes/art";
import { seg, mono, Note, Caption, fx, int, useChunked, Chip } from "./IndexesUi";

const TYPE_COLOR: Record<NodeType, string> = { 4: "var(--c1)", 16: "var(--c2)", 48: "var(--c5)", 256: "var(--c4)" };


type KeySet = "seq" | "rand" | "words";

function keysFor(set: KeySet, n: number): { bytes: Uint8Array; label: string }[] {
  if (set === "words") return ART_WORDS.slice(0, n).map((w) => ({ bytes: encodeString(w), label: w }));
  return artKeys(n, set === "seq" ? "dense" : "random", 11).map((k) => ({ bytes: encodeU32(k), label: String(k) }));
}

const fmtByte = (b: number, words: boolean) => (words ? (b === 0 ? "∅" : b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(16)) : b.toString(16).toUpperCase().padStart(2, "0"));

function eventText(e: ArtEvent): string {
  switch (e.t) {
    case "new4": return `a leaf met another leaf, so a new Node4 replaced it${e.prefix ? ` with a compressed path of ${e.prefix} byte${e.prefix === 1 ? "" : "s"}` : ""}`;
    case "grow": return `node ${e.id} was full and grew from Node${e.from} to Node${e.to}`;
    case "splitPrefix": return `the key differs inside the compressed path of node ${e.id}, so the path split at byte ${e.at}`;
    case "shrink": return `node ${e.id} shrank from Node${e.from} to Node${e.to}`;
    case "merge": return `node ${e.id} merged into its only child`;
  }
}

export function ArtBuilderDemo() {
  const [n, setN] = useState(20);
  const [set, setSet] = useState<KeySet>("seq");
  const words = set === "words";
  const count = words ? Math.min(n, ART_WORDS.length) : n;
  const built = useMemo(() => {
    const ks = keysFor(set, count);
    const t = new ART<number>();
    ks.slice(0, -1).forEach((k, i) => t.insert(k.bytes, i));
    const evs: ArtEvent[] = [];
    t.listener = (e) => evs.push(e);
    const last = ks[ks.length - 1];
    if (last) t.insert(last.bytes, ks.length - 1);
    t.listener = null;
    return { t, last, evs, path: last ? new Set(t.path(last.bytes)) : new Set<number>() };
  }, [set, count]);
  const { t, last, evs, path } = built;
  const stats = t.stats();
  const nodes = t.innerNodes();
  const shown = nodes.slice(0, 36);
  return (
    <Demo
      title="Adaptive radix tree: nodes grow with their children"
      controls={
        <>
          <Param spec={range({ label: "Keys inserted", min: 1, max: 300, step: 1, default: 20 })} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={seg<KeySet>("Keys", [["seq", "integers 0, 1, 2, …"], ["rand", "random 32-bit integers"], ["words", "words"]], "seq")} value={set} onChange={(v) => setSet(v as KeySet)} />
        </>
      }
    >
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.5 }}>
        {last ? <>Last key <b>{last.label}</b> = <span style={{ color: "var(--c3)" }}>{hex(last.bytes)}</span>. {evs.length ? `On this insert, ${evs.map(eventText).join("; ")}.` : "It went into a free slot of an existing node."}</> : "No keys."}
      </div>
      <Caption>Inner nodes, breadth first{nodes.length > shown.length ? ` (first ${shown.length} of ${nodes.length})` : ""}</Caption>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "flex-start" }}>
        {shown.map(({ node, depth }) => <NodeCard key={node.id} n={node} depth={depth} words={words} onPath={path.has(node.id)} />)}
        {!nodes.length && <span className="muted" style={{ fontSize: 12.5 }}>One key: the root is just a leaf (lazy expansion).</span>}
      </div>
      <div style={{ height: 10 }} />
      <Stats
        items={[
          { label: "keys", value: t.size },
          { label: "Node4 / 16 / 48 / 256", value: `${stats.counts[4]} / ${stats.counts[16]} / ${stats.counts[48]} / ${stats.counts[256]}` },
          { label: "inner node bytes", value: int(stats.bytes) },
          { label: "bytes per key", value: fx(stats.bytesPerKey, 1) },
          { label: "mean depth of a leaf", value: fx(stats.avgDepth, 2) },
        ]}
      />
      <div style={{ marginTop: 6 }}><Legend items={[{ label: "Node4 (52 B)", color: TYPE_COLOR[4] }, { label: "Node16 (160 B)", color: TYPE_COLOR[16] }, { label: "Node48 (656 B)", color: TYPE_COLOR[48] }, { label: "Node256 (2,064 B)", color: TYPE_COLOR[256] }]} /></div>
      <Note>{words ? "Words end with the terminator 00 00 (shown as ∅), so no key is a prefix of another." : "Integers are 4 bytes, most significant byte first."} A filled cell is a child; a ring marks a child that is an inner node, the rest are leaves. The green outline marks the path of the last key.</Note>
    </Demo>
  );
}

function NodeCard({ n, depth, words, onPath }: { n: ArtInner<number>; depth: number; words: boolean; onPath: boolean }) {
  const kids = ART.children(n);
  const color = TYPE_COLOR[n.type];
  const isInner = new Set(kids.filter(([, c]) => c.kind === "inner").map(([b]) => b));
  const used = new Set(kids.map(([b]) => b));
  return (
    <div style={{ border: `${onPath ? 2 : 1}px solid ${onPath ? "var(--c3)" : "var(--border)"}`, borderRadius: 6, padding: "4px 6px", minWidth: 0, maxWidth: "100%", background: "var(--bg)" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 11.5 }}>
        <b style={{ color }}>Node{n.type}</b>
        <span className="muted" style={mono}>d{depth} · {n.count}/{n.type}</span>
      </div>
      {n.prefix.length > 0 && <div style={{ ...mono, fontSize: 10.5 }} className="muted">prefix {[...n.prefix].map((b) => fmtByte(b, words)).join(words ? "" : " ")}</div>}
      {n.type <= 16 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 3, maxWidth: 16 * 22 }}>
          {kids.map(([b]) => <Chip key={b} color={color} fill={!isInner.has(b)} style={{ fontSize: 10.5, padding: "0 4px" }}>{fmtByte(b, words)}</Chip>)}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 7px)", gap: 1, marginTop: 3 }}>
          {Array.from({ length: 256 }, (_, b) => (
            <span key={b} title={b.toString(16)} style={{ width: 7, height: 7, borderRadius: 1, background: used.has(b) ? (isInner.has(b) ? "var(--bg)" : color) : "var(--subtle)", outline: isInner.has(b) ? `1.5px solid ${color}` : undefined, outlineOffset: -1.5 }} />
          ))}
        </div>
      )}
      <div className="muted" style={{ ...mono, fontSize: 10, marginTop: 2 }}>{NODE_BYTES[n.type]} B{n.type === 48 ? " = 256-byte index + 48 slots" : ""}</div>
    </div>
  );
}

// ============================================================================
// Binary-comparable keys
// ============================================================================

type EncType = "i32" | "f64" | "string" | "composite";
type Rep = "value" | "a" | "b" | "enc";
interface Sample { label: string; cmp: (o: Sample) => number; reps: Record<"a" | "b" | "enc", Uint8Array> }

const f64le = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; };
const f64be = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); return b; };
const utf8 = (s: string) => new TextEncoder().encode(s);
const lenPrefixed = (s: string) => concatBytes(Uint8Array.of(utf8(s).length), utf8(s));

const REP_SHORT: Record<EncType, [string, string, string]> = {
  i32: ["little-endian", "big-endian", "sign flip + BE"],
  f64: ["little-endian", "big-endian", "bit flips + BE"],
  string: ["length first", "no terminator", "terminated"],
  composite: ["LE int", "no terminator", "terminated"],
};
const REP_LABELS: Record<EncType, [string, string, string]> = {
  i32: ["little-endian (memory on x86 and ARM)", "big-endian two's complement", "sign bit flipped, big-endian"],
  f64: ["little-endian IEEE 754", "big-endian IEEE 754", "flip sign bit (positive) or all bits (negative)"],
  string: ["length byte, then UTF-8", "UTF-8, no terminator", "UTF-8, 00 escaped, 00 00 terminator"],
  composite: ["UTF-8 then little-endian int", "UTF-8 then encoded int", "encoded string then encoded int"],
};

function samples(t: EncType, custom: number): Sample[] {
  if (t === "i32") {
    const vs = [...new Set([-1000, -2, -1, 0, 1, 255, 256, 70000, Math.round(custom)])];
    return vs.map((v) => ({ label: String(v), cmp: (o) => v - Number(o.label), reps: { a: rawI32LE(v), b: rawI32BE(v), enc: encodeI32(v) } }));
  }
  if (t === "f64") {
    const vs = [...new Set([-100, -2.5, -0.5, 0, 0.5, 1, 3.75, 1e6, custom / 8])];
    return vs.map((v) => ({ label: String(v), cmp: (o) => v - Number(o.label), reps: { a: f64le(v), b: f64be(v), enc: encodeF64(v) } }));
  }
  if (t === "string") {
    const vs = ["a", "ab", "abc", "b", "ba", "zz", "Z", "é"];
    return vs.map((v) => ({ label: JSON.stringify(v), cmp: (o) => { const w = JSON.parse(o.label) as string; return compareBytes(utf8(v), utf8(w)); }, reps: { a: lenPrefixed(v), b: utf8(v), enc: encodeString(v) } }));
  }
  const vs: [string, number][] = [["ab", 5], ["ab", -3], ["abc", 1], ["a", 100], ["b", 0], ["ab", Math.round(custom)]];
  return [...new Map(vs.map((x) => [x.join("|"), x])).values()].map(([s, v]) => ({
    label: `(${JSON.stringify(s)}, ${v})`,
    cmp: (o) => { const m = /^\("(.*)", (-?\d+)\)$/.exec(o.label)!; const c = compareBytes(utf8(s), utf8(m[1]!)); return c || v - Number(m[2]); },
    reps: { a: concatBytes(utf8(s), rawI32LE(v)), b: concatBytes(utf8(s), encodeI32(v)), enc: concatBytes(encodeString(s), encodeI32(v)) },
  }));
}

export function KeyEncodingDemo() {
  const [t, setT] = useState<EncType>("i32");
  const [rep, setRep] = useState<Rep>("enc");
  const [custom, setCustom] = useState(-7);
  const ss = useMemo(() => samples(t, custom), [t, custom]);
  const trueOrder = [...ss].sort((a, b) => a.cmp(b));
  const rank = new Map(trueOrder.map((s, i) => [s, i]));
  const shown = rep === "value" ? trueOrder : [...ss].sort((a, b) => compareBytes(a.reps[rep], b.reps[rep]));
  const bad = shown.filter((s, i) => rank.get(s) !== i).length;
  const showRep: "a" | "b" | "enc" = rep === "value" ? "enc" : rep;
  const isPrefix = (s: Sample) => ss.some((o) => o !== s && o.reps[showRep].length > s.reps[showRep].length && compareBytes(o.reps[showRep].slice(0, s.reps[showRep].length), s.reps[showRep]) === 0);
  const labels = REP_LABELS[t];
  return (
    <Demo
      title="Make byte order match value order"
      controls={
        <>
          <Param spec={range({ label: t === "f64" ? "Your value" : "Your integer", min: -300, max: 300, step: 1, default: -7, format: (v) => String(t === "f64" ? v / 8 : v) })} value={custom} onChange={(v) => setCustom(v as number)} />
          <Param spec={seg<EncType>("Type", [["i32", "int32"], ["f64", "float64"], ["string", "string"], ["composite", "(string, int32)"]], "i32")} value={t} onChange={(v) => setT(v as EncType)} />
          <Param spec={seg<Rep>("Sort rows by", [["value", "true value"], ["a", REP_SHORT[t][0]], ["b", REP_SHORT[t][1]], ["enc", REP_SHORT[t][2]]], "enc")} value={rep} onChange={(v) => setRep(v as Rep)} />
        </>
      }
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, ...mono }}>
          <thead>
            <tr style={{ color: "var(--muted)", textAlign: "left" }}>
              <th style={{ fontWeight: 500, padding: "2px 6px" }}>value</th>
              <th style={{ fontWeight: 500, padding: "2px 6px" }}>bytes ({rep === "value" ? labels[2] : labels[rep === "a" ? 0 : rep === "b" ? 1 : 2]})</th>
              <th style={{ fontWeight: 500, padding: "2px 6px", textAlign: "right" }}>true rank</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s, i) => {
              const wrong = rank.get(s) !== i;
              return (
                <tr key={s.label} style={{ borderTop: "1px solid var(--border)", color: wrong ? "var(--c4)" : undefined }}>
                  <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>{s.label}</td>
                  <td style={{ padding: "2px 6px", overflowWrap: "anywhere" }}>{hex(s.reps[showRep])}{isPrefix(s) ? <span style={{ color: "var(--c5)" }}> (prefix of another key)</span> : null}</td>
                  <td style={{ padding: "2px 6px", textAlign: "right" }}>{rank.get(s)! + 1}{wrong ? " ✗" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "rows out of order", value: rep === "value" ? "–" : `${bad} of ${ss.length}` },
          { label: "keys that are a prefix of another", value: ss.filter(isPrefix).length },
        ]}
      />
      <Note>A radix tree, a B-tree with memcmp keys, and an LSM tree all compare keys byte by byte. The encoding must make that order equal to the order of the values, and no key may be a prefix of another.</Note>
    </Demo>
  );
}

// ============================================================================
// Memory per key
// ============================================================================

const NS = Array.from({ length: 23 }, (_, i) => Math.round(Math.pow(2, 4 + i * 0.5)));
/** Every key count where the hash table doubles, and the count just before it, for a true sawtooth. */
const HASH_XS = [...new Set(Array.from({ length: 13 }, (_, i) => 16 * 2 ** i).flatMap((s) => [Math.floor(s * 0.875), Math.floor(s * 0.875) + 1]))].filter((x) => x >= 16 && x <= 32768).sort((a, b) => a - b);

export function ArtMemoryDemo() {
  const [logN, setLogN] = useState(12);
  const [fill, setFill] = useState(Math.LN2);
  const n = Math.round(Math.pow(2, logN));
  const dense = useChunked("d", NS.map((x) => () => { const t = new ART<number>(); for (const k of artKeys(x, "dense")) t.insert(encodeU32(k), k); return t.stats().bytesPerKey; }));
  const rand = useChunked("r", NS.map((x) => () => { const t = new ART<number>(); for (const k of artKeys(x, "random")) t.insert(encodeU32(k), k); return t.stats().bytesPerKey; }));
  const here = useMemo(() => {
    const out: Record<"dense" | "random", ReturnType<ART["stats"]>> = {} as never;
    for (const d of ["dense", "random"] as const) { const t = new ART<number>(); for (const k of artKeys(n, d)) t.insert(encodeU32(k), k); out[d] = t.stats(); }
    return out;
  }, [n]);
  const bt = btreeBytesPerKey(4, fill);
  const hs = HASH_XS.map((x) => [x, hashBytesPerKey(x, 4)] as const);
  const pts = (ys: (number | undefined)[]) => NS.flatMap((x, i) => (ys[i] === undefined ? [] : [[x, ys[i]!] as const]));
  return (
    <Demo
      title="Index bytes per key: 32-bit keys"
      controls={
        <>
          <Param spec={range({ label: "Number of keys (marker)", min: 4, max: 15, step: 0.5, default: 12, format: (v) => int(Math.round(Math.pow(2, v))) })} value={logN} onChange={(v) => setLogN(v as number)} />
          <Param spec={range({ label: "B+ tree page fill", min: 0.5, max: 1, step: 0.01, default: Math.LN2, format: (v) => pct(v, 0) })} value={fill} onChange={(v) => setFill(v as number)} />
        </>
      }
    >
      <Plot x={[16, NS[NS.length - 1]!]} y={[0, 40]} logX height={250} xLabel="keys" yLabel="bytes per key" xTicks={[16, 256, 4096, 32768]} xFormat={(v) => int(v)}>
        <RuleX at={n} />
        <Line points={[[16, bt], [NS[NS.length - 1]!, bt]]} color="var(--c2)" />
        <Line points={hs} color="var(--c5)" width={1.4} />
        <Line points={pts(rand)} color="var(--c4)" />
        <Dots points={pts(rand)} color="var(--c4)" r={2.5} />
        <Line points={pts(dense)} color="var(--c1)" />
        <Dots points={pts(dense)} color="var(--c1)" r={2.5} />
      </Plot>
      <Legend items={[{ label: "ART, dense keys 0…n−1", color: "var(--c1)" }, { label: "ART, random keys", color: "var(--c4)" }, { label: "B+ tree: 4-byte key + 8-byte value", color: "var(--c2)" }, { label: "hash table: 12-byte slots, doubles at 87.5% full", color: "var(--c5)" }]} />
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: `ART dense, ${int(n)} keys`, value: `${fx(here.dense.bytesPerKey, 1)} B` },
          { label: "ART random", value: `${fx(here.random.bytesPerKey, 1)} B` },
          { label: "random: Node4 / 16 / 48 / 256", value: `${here.random.counts[4]} / ${here.random.counts[16]} / ${here.random.counts[48]} / ${here.random.counts[256]}` },
          { label: "B+ tree", value: `${fx(bt, 1)} B` },
          { label: "hash table", value: `${fx(hashBytesPerKey(n, 4), 1)} B` },
        ]}
      />
      <Note>ART bytes are inner nodes only: a leaf is a tagged pointer in its parent's slot, and the key is read from the row to confirm a match. The B+ tree and the hash table store a copy of each key and an 8-byte value.</Note>
    </Demo>
  );
}
