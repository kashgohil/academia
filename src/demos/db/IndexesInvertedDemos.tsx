/** Demos for "Inverted indexes": build and query, posting-list compression, BM25 playground. */
import { useEffect, useMemo, useState } from "react";
import { Demo, Stats, Param, range, Plot, Line, RuleY, Legend, pct } from "../../kit";
import {
  buildIndex, postings, intersectMerge, intersectGallop, phrase, randomPostings, burstyPostings, compressionSizes, deltas, varintEncode,
  bitsFor, BLOCK, bm25Rank, bm25Term, idf, CORPUS, type WalkStep, type Posting,
} from "../../sims/db/indexes/inverted";
import { seg, mono, Note, Caption, fx, int, StepText, StepButtons, useFrames, Chip, Bar } from "./IndexesUi";

const IX = buildIndex(CORPUS);

// ============================================================================
// Build and query
// ============================================================================

type QId = "and" | "or" | "phrase" | "and2";
const QUERIES: Record<QId, { label: string; terms: [string, string]; op: "and" | "or" | "phrase" }> = {
  and: { label: "sorted AND runs", terms: ["sorted", "runs"], op: "and" },
  phrase: { label: "\"sorted runs\"", terms: ["sorted", "runs"], op: "phrase" },
  or: { label: "hash OR lsm", terms: ["hash", "lsm"], op: "or" },
  and2: { label: "index AND inverted", terms: ["index", "inverted"], op: "and" },
};

interface QFrame { i: number; j: number; hit: Set<number>; out: number[]; note: string; posDoc?: number }

function unionTrace(a: number[], b: number[]): QFrame[] {
  const fr: QFrame[] = [];
  let i = 0, j = 0;
  const out: number[] = [];
  while (i < a.length || j < b.length) {
    const x = a[i] ?? Infinity, y = b[j] ?? Infinity;
    const v = Math.min(x, y);
    out.push(v);
    fr.push({ i, j, hit: new Set([v]), out: [...out], note: x === y ? `${v} is in both lists: output it once and move both pointers.` : `${v} is the smaller head: output it and move that pointer.` });
    if (x === y) { i++; j++; } else if (x < y) i++; else j++;
  }
  return fr;
}

export function InvertedQueryDemo() {
  const [qid, setQid] = useState<QId>("and");
  const [algo, setAlgo] = useState<"merge" | "gallop">("merge");
  const q = QUERIES[qid];
  const la = postings(IX, q.terms[0]), lb = postings(IX, q.terms[1]);
  // Galloping walks the shorter list and jumps in the longer one.
  const [A, B, swapped] = algo === "gallop" && la.length > lb.length ? [lb, la, true] : [la, lb, false];
  const ids = (l: Posting[]) => l.map((p) => p.doc);
  const frames = useMemo(() => {
    if (q.op === "or") return unionTrace(ids(A), ids(B));
    const tr: WalkStep[] = [];
    const r = algo === "merge" ? intersectMerge(ids(A), ids(B), tr) : intersectGallop(ids(A), ids(B), tr);
    const fr: QFrame[] = tr.map((s) => ({ i: s.i, j: s.j, hit: new Set(s.cmp === "=" ? [ids(A)[s.i]!] : []), out: s.out, note: s.note }));
    if (q.op === "phrase") {
      const ph = phrase(IX, q.terms);
      for (const d of r.out) {
        const pa = la.find((p) => p.doc === d)!.pos, pb = lb.find((p) => p.doc === d)!.pos;
        const ok = ph.docs.includes(d);
        fr.push({ i: -1, j: -1, hit: new Set([d]), out: ph.docs.filter((x) => x <= d), posDoc: d, note: `Doc ${d}: "${q.terms[0]}" at ${pa.join(", ")}, "${q.terms[1]}" at ${pb.join(", ")}. ${ok ? "A position p is followed by p + 1: the phrase is there." : "No position is followed by the next one: not a phrase match."}` });
      }
    }
    return fr;
  }, [qid, algo]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useFrames<QFrame>(900);
  useEffect(() => { st.start(frames, true); }, [frames]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = st.cur;
  const final = frames[frames.length - 1]?.out ?? [];
  const big = useMemo(() => { const s = randomPostings(10, 1e6, 1), l = randomPostings(10000, 1e6, 2); return { m: intersectMerge(s, l).comparisons, g: intersectGallop(s, l).comparisons }; }, []);
  const comps = q.op === "or" ? frames.length : frames.filter((x) => x.posDoc === undefined).length;
  const terms = [...IX.terms.keys()].sort();
  const row = (label: string, l: Posting[], ptr: number | undefined, color: string) => (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
      <span style={{ ...mono, fontSize: 12, minWidth: 64 }}>{label}</span>
      {l.map((p, k) => {
        const on = ptr === k, hit = f?.hit.has(p.doc) && (on || f.posDoc !== undefined || q.op === "or");
        return <Chip key={p.doc} color={hit ? "var(--c3)" : on ? color : undefined} fill={!!hit} title={`tf ${p.tf}, positions ${p.pos.join(", ")}`}>{p.doc}<span style={{ opacity: 0.7, fontSize: 9.5 }}> ·{p.pos.join(",")}</span></Chip>;
      })}
      {ptr !== undefined && ptr >= l.length && <span className="muted" style={{ fontSize: 11 }}>end</span>}
    </div>
  );
  return (
    <Demo
      title="An inverted index over six short documents"
      controls={
        <>
          <Param spec={seg<QId>("Query", (Object.keys(QUERIES) as QId[]).map((k) => [k, QUERIES[k].label]), "and")} value={qid} onChange={(v) => setQid(v as QId)} />
          <Param spec={seg<"merge" | "gallop">("Intersection", [["merge", "linear merge"], ["gallop", "galloping"]], "merge")} value={algo} onChange={(v) => setAlgo(v as "merge" | "gallop")} />
        </>
      }
    >
      <div style={{ display: "grid", gap: 2 }}>
        {CORPUS.map((d, i) => (
          <div key={i} style={{ fontSize: 12.5, display: "flex", gap: 8, color: final.includes(i) ? "var(--fg)" : "var(--muted)" }}>
            <span style={{ ...mono, color: final.includes(i) ? "var(--c3)" : "var(--faint)", fontWeight: 700 }}>{i}</span>
            <span>{d}</span>
          </div>
        ))}
      </div>
      <Caption>Posting lists: doc id · positions</Caption>
      {row(swapped ? q.terms[1] : q.terms[0], A, f && f.posDoc === undefined ? f.i : undefined, "var(--c1)")}
      {row(swapped ? q.terms[0] : q.terms[1], B, f && f.posDoc === undefined ? f.j : undefined, "var(--c2)")}
      <div style={{ ...mono, fontSize: 12, marginTop: 4 }}>result: [{(f?.out ?? []).join(", ")}]</div>
      <StepText>{f ? f.note : "Pick a query."}</StepText>
      <StepButtons st={st} />
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "terms in the dictionary", value: IX.terms.size },
          { label: q.op === "or" ? "union steps" : "intersection steps", value: comps },
          { label: "result", value: final.length ? `docs ${final.join(", ")}` : "none" },
          { label: "10 × 10,000 ids: merge / gallop comparisons", value: `${int(big.m)} / ${int(big.g)}` },
        ]}
      />
      <details style={{ marginTop: 8, fontSize: 12 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>The whole dictionary (stop words such as "the" and "a" are dropped)</summary>
        <div style={{ ...mono, fontSize: 11, lineHeight: 1.6, marginTop: 4 }}>{terms.map((t) => `${t} → ${ids(postings(IX, t)).join(",")}`).join("   ")}</div>
      </details>
    </Demo>
  );
}

// ============================================================================
// Posting-list compression
// ============================================================================

export function PostingCompressionDemo() {
  const [n, setN] = useState(10000);
  const [dist, setDist] = useState<"uniform" | "bursty">("uniform");
  const count = Math.round(n);
  const ids = useMemo(() => (dist === "uniform" ? randomPostings(count, 1_000_000, 4) : burstyPostings(count, 4)), [count, dist]);
  const sz = useMemo(() => compressionSizes(ids), [ids]);
  const gaps = deltas(ids);
  const first = gaps.slice(0, BLOCK);
  const forW = first.length === BLOCK ? Math.max(...first.map(bitsFor)) : null;
  const sortedW = first.map(bitsFor).sort((a, b) => a - b);
  const pforW = first.length === BLOCK ? sortedW[Math.ceil(0.9 * BLOCK) - 1]! : null;
  const exc = pforW !== null ? first.filter((g) => bitsFor(g) > pforW).length : 0;
  const rows: [string, number, number, string][] = [
    ["raw 32-bit ids", sz.raw, 32, "var(--c4)"],
    ["delta + varint", sz.varint, sz.bitsPerId.varint, "var(--c1)"],
    ["delta + FOR (blocks of 128)", sz.forBytes, sz.bitsPerId.for, "var(--c2)"],
    ["delta + PForDelta", sz.pfor, sz.bitsPerId.pfor, "var(--c3)"],
  ];
  return (
    <Demo
      title="How small can a posting list get?"
      controls={
        <>
          <Param spec={range({ label: "Documents that contain the term", min: 100, max: 100000, log: true, default: 10000, format: (v) => int(v) })} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={seg<"uniform" | "bursty">("Where the term appears", [["uniform", "anywhere in 1 M docs"], ["bursty", "in bursts, with rare big jumps"]], "uniform")} value={dist} onChange={(v) => setDist(v as "uniform" | "bursty")} />
        </>
      }
    >
      {rows.map(([label, bytes, bits, color]) => <Bar key={label} label={label} value={bytes} max={sz.raw} color={color} text={`${int(bytes)} B · ${fx(bits, 1)} bits/id`} />)}
      <Caption>The first ids, their gaps, and the gaps as varint bytes</Caption>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, ...mono, width: "100%" }}>
          <thead><tr className="muted" style={{ textAlign: "right" }}><th style={{ fontWeight: 500 }}>doc id</th><th style={{ fontWeight: 500 }}>gap</th><th style={{ fontWeight: 500, textAlign: "left", paddingLeft: 12 }}>varint bytes (continuation bit in red)</th></tr></thead>
          <tbody>
            {ids.slice(0, 6).map((id, i) => {
              const bs = [...varintEncode([gaps[i]!])];
              return (
                <tr key={i} style={{ borderTop: "1px solid var(--border)", textAlign: "right" }}>
                  <td>{int(id)}</td><td>{int(gaps[i]!)}</td>
                  <td style={{ textAlign: "left", paddingLeft: 12 }}>
                    {bs.map((b, k) => (
                      <span key={k} style={{ marginRight: 8 }}>
                        <span style={{ color: b & 0x80 ? "var(--c4)" : "var(--faint)" }}>{b >> 7}</span>{(b & 0x7f).toString(2).padStart(7, "0")}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ height: 8 }} />
      <Stats
        items={[
          { label: "mean gap", value: int(ids[ids.length - 1]! / ids.length) },
          { label: "first block: FOR width", value: forW === null ? "–" : `${forW} bits` },
          { label: "first block: PFor width, exceptions", value: pforW === null ? "–" : `${pforW} bits, ${exc}` },
          { label: "saved by PForDelta vs raw", value: pct(1 - sz.pfor / sz.raw, 0) },
        ]}
      />
      <Note>FOR packs each block of 128 gaps with the bit width of its largest gap. PForDelta picks a width that fits 90% of the gaps and stores the large ones as exceptions after the block. A last partial block uses varints.</Note>
    </Demo>
  );
}

// ============================================================================
// BM25
// ============================================================================

type BQ = "inverted index" | "sorted runs" | "lsm merges" | "range scan";
const TERM_COLORS = ["var(--c1)", "var(--c2)", "var(--c5)"];

export function Bm25Demo() {
  const [query, setQuery] = useState<BQ>("inverted index");
  const [k1, setK1] = useState(1.2);
  const [b, setB] = useState(0.75);
  const ranked = bm25Rank(IX, query, { k1, b });
  const qterms = [...new Set(query.split(" "))];
  const max = Math.max(...ranked.map((r) => r.score), 1e-9);
  const tfs = Array.from({ length: 41 }, (_, i) => i / 4);
  const curve = (dlRatio: number) => tfs.map((tf) => [tf, bm25Term(tf, dlRatio * IX.avgdl, IX.avgdl, 1, { k1, b })] as const);
  return (
    <Demo
      title="BM25: term frequency, rarity and document length"
      controls={
        <>
          <Param spec={range({ label: "k1 (tf saturation)", min: 0, max: 3, step: 0.1, default: 1.2, format: (v) => fx(v, 1) })} value={k1} onChange={(v) => setK1(v as number)} />
          <Param spec={range({ label: "b (length normalization)", min: 0, max: 1, step: 0.05, default: 0.75, format: (v) => fx(v, 2) })} value={b} onChange={(v) => setB(v as number)} />
          <Param spec={seg<BQ>("Query", [["inverted index", "inverted index"], ["sorted runs", "sorted runs"], ["lsm merges", "lsm merges"], ["range scan", "range scan"]], "inverted index")} value={query} onChange={(v) => setQuery(v as BQ)} />
        </>
      }
    >
      <div style={{ display: "grid", gap: 6 }}>
        {ranked.map((r, i) => (
          <div key={r.doc} style={{ display: "grid", gridTemplateColumns: "1.6em minmax(0, 1fr) 3.4em", gap: 8, alignItems: "center", fontSize: 12.5 }}>
            <b style={{ ...mono, color: i === 0 ? "var(--c3)" : "var(--muted)" }}>{r.doc}</b>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", height: 12, borderRadius: 3, overflow: "hidden", background: "var(--subtle)", border: "1px solid var(--border)" }}>
                {r.parts.map((p) => <div key={p.term} title={`${p.term}: tf ${p.tf}, idf ${fx(p.idf, 2)}, ${fx(p.score, 3)}`} style={{ width: `${(100 * p.score) / max}%`, background: TERM_COLORS[qterms.indexOf(p.term)] ?? "var(--c1)", transition: "width 0.25s" }} />)}
              </div>
              <div className="muted" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{IX.docLen[r.doc]} terms · {r.parts.map((p) => `${p.term} tf ${p.tf}`).join(", ")}</div>
            </div>
            <span style={{ ...mono, textAlign: "right" }}>{fx(r.score, 3)}</span>
          </div>
        ))}
      </div>
      <Legend items={qterms.map((t, i) => ({ label: `${t}: in ${postings(IX, t).length} of ${CORPUS.length} docs, idf ${fx(idf(CORPUS.length, postings(IX, t).length), 2)}`, color: TERM_COLORS[i]! }))} />
      <Caption>One term's score against its frequency in a document (idf = 1)</Caption>
      <Plot x={[0, 10]} y={[0, Math.max(1.2, k1 + 1.2)]} height={190} xLabel="term frequency tf" yLabel="score">
        <RuleY at={k1 + 1} label={`limit k1 + 1 = ${fx(k1 + 1, 1)}`} />
        <Line points={curve(0.5)} color="var(--c3)" />
        <Line points={curve(1)} color="var(--c1)" />
        <Line points={curve(2)} color="var(--c4)" />
      </Plot>
      <Legend items={[{ label: "short doc (half of average length)", color: "var(--c3)" }, { label: "average length", color: "var(--c1)" }, { label: "long doc (twice the average)", color: "var(--c4)" }]} />
      <div style={{ height: 6 }} />
      <Stats items={[{ label: "documents", value: CORPUS.length }, { label: "average length (terms)", value: fx(IX.avgdl, 1) }, { label: "top document", value: ranked[0] ? `doc ${ranked[0].doc}` : "–" }]} />
    </Demo>
  );
}
