/** Demos for "Compression": an encoding lab, SUM on compressed data, and sort order vs run counts. */
import { useMemo, useRef, useState } from "react";
import { Demo, Stats, Param, Legend, range, useSim, SimButtons, pct, Bar, Note, SectionLabel, fixed, int, mono, seg } from "../../kit";
import {
  dataset, encodeAll, chooseEncoding, plainBytes, runColumn, runsOf, sumDecodeThenAdd, sumOnRuns,
  countEqStrings, countEqDict, COUNTRIES, salesTable, runCounts, SORT_KEYS, SALES_COLUMNS, sortRows, encode,
  type DatasetName, type EncodingName,
} from "../../sims/db/olap";

const ENC_LABEL: Record<EncodingName, string> = {
  plain: "plain", rle: "run-length", dict: "dictionary", for: "frame of reference", delta: "delta", bitpack: "bit-packing", lz4: "LZ4 (general)",
};
const DS_LABEL: [DatasetName, string][] = [["ids", "sorted IDs"], ["timestamps", "timestamps"], ["days", "sorted dates"], ["countries", "countries"], ["prices", "random floats"]];

export function CompressionLabDemo() {
  const [n, setN] = useState(4096);
  const [name, setName] = useState<DatasetName>("ids");
  const ds = useMemo(() => dataset(name, n), [name, n]);
  const results = useMemo(() => encodeAll(ds.type, ds.values), [ds]);
  const best = useMemo(() => chooseEncoding(ds.type, ds.values), [ds]);
  const plain = results.find((r) => r.encoding === "plain")!.bytes;
  const first = ds.values.slice(0, 6).map((v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(4) : String(v)));
  return (
    <Demo
      title="Compression lab: one column, every encoding"
      controls={
        <>
          <Param spec={range({ label: "Values in the column", min: 256, max: 4096, step: 256, default: 4096 })} value={n} onChange={(v) => setN(v as number)} />
          <Param spec={seg<DatasetName>("Column", DS_LABEL, "ids")} value={name} onChange={(v) => setName(v as DatasetName)} />
        </>
      }
    >
      <div style={{ fontSize: 12.5, marginBottom: 2 }}><b>{ds.label}</b>, {int(n)} values</div>
      <div className="muted" style={{ ...mono, fontSize: 11.5, marginBottom: 8, wordBreak: "break-all" }}>{first.join("  ")} …</div>
      <div style={{ display: "grid", gap: 8 }}>
        {results.map((r) => {
          const win = r.encoding === best.encoding;
          return (
            <div key={r.encoding}>
              <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "0 10px", fontSize: 12.5 }}>
                <span style={{ fontWeight: win ? 700 : 500 }}>{ENC_LABEL[r.encoding]}{win ? " · the analyzer picks this" : ""}</span>
                <span style={mono}>{int(r.bytes)} B · {r.ratio >= 10 ? fixed(r.ratio, 1) : fixed(r.ratio, 2)}×</span>
              </div>
              <Bar frac={r.bytes / Math.max(plain, ...results.map((x) => x.bytes))} color={win ? "var(--c3)" : r.ratio < 1 ? "var(--c4)" : "var(--c1)"} />
              <div className="muted" style={{ ...mono, fontSize: 11, marginTop: 2, overflowWrap: "anywhere" }}>{r.preview}</div>
            </div>
          );
        })}
      </div>
      <Legend box items={[{ label: "smallest lightweight encoding", color: "var(--c3)" }, { label: "smaller than plain", color: "var(--c1)" }, { label: "larger than plain", color: "var(--c4)" }]} />
      <Note>Each encoding here writes real bytes, and a decoder reads them back. The tests check every round trip. Ratio = plain size ÷ encoded size.</Note>
    </Demo>
  );
}

// ---------------- SUM on compressed data ----------------

const SUM_N = 256;

export function CompressedSumDemo() {
  const [meanRun, setMeanRun] = useState(8);
  const [needle, setNeedle] = useState<string>("FR");
  const col = useMemo(() => runColumn(SUM_N, meanRun), [meanRun]);
  const runs = useMemo(() => runsOf(col), [col]);
  const dec = useMemo(() => sumDecodeThenAdd(runs), [runs]);
  const rle = useMemo(() => sumOnRuns(runs), [runs]);
  const ops = useRef(0);
  const sim = useSim({ step: () => { ops.current = Math.min(dec.ops, ops.current + 2); }, reset: () => { ops.current = 0; }, dt: 1 / 60 });
  const o = ops.current;
  const decValues = Math.min(SUM_N, Math.floor(o / 2));
  const rleRuns = Math.min(runs.length, Math.floor(o / 2));
  const rleValues = runs.slice(0, rleRuns).reduce((s, r) => s + r.length, 0);
  const partial = (k: number) => col.slice(0, k).reduce((s, v) => s + v, 0);
  // Run boundaries for drawing.
  const starts: number[] = [];
  runs.reduce((s, r) => { starts.push(s); return s + r.length; }, 0);
  const cw = 100 / SUM_N;
  const strip = (filled: number, color: string) => (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" style={{ width: "100%", height: 34, display: "block", borderBottom: "1px solid var(--border)" }}>
      {runs.map((r, i) => {
        const h = (20 * (r.value as number)) / 100;
        const on = starts[i]! < filled;
        return <rect key={i} x={starts[i]! * cw} y={20 - h} width={Math.max(0.05, r.length * cw - 0.25)} height={h} fill={on ? color : "var(--border)"} />;
      })}
    </svg>
  );
  const countries = useMemo(() => dataset("countries").values as string[], []);
  const str = useMemo(() => countEqStrings(countries, needle), [countries, needle]);
  const dct = useMemo(() => countEqDict(countries, needle), [countries, needle]);
  return (
    <Demo
      title="Run a query on compressed data"
      actions={<SimButtons sim={sim} />}
      controls={
        <>
          <Param spec={range({ label: "Average run length", min: 1, max: 64, step: 1, default: 8 })} value={meanRun} onChange={(v) => { setMeanRun(v as number); ops.current = 0; }} />
          <Param spec={seg("WHERE country =", [...COUNTRIES.slice(0, 4), "XX"].map((c) => [c, `'${c}'`] as [string, string]), "FR")} value={needle} onChange={(v) => setNeedle(v as string)} />
        </>
      }
    >
      <SectionLabel>SUM over {SUM_N} values stored as {runs.length} runs</SectionLabel>
      <div className="muted" style={{ fontSize: 12 }}>Each bar is one run: its width is the run length and its height is the value. Both workers do 2 operations per tick.</div>
      <div style={{ fontSize: 12.5, margin: "6px 0 3px" }}>Decode, then add: {int(decValues)} of {SUM_N} values · partial sum {int(partial(decValues))}</div>
      {strip(decValues, "var(--c2)")}
      <div style={{ fontSize: 12.5, margin: "8px 0 3px" }}>Add on runs (value × length): {rleRuns} of {runs.length} runs · partial sum {int(partial(rleValues))}</div>
      {strip(rleValues, "var(--c1)")}
      <Stats
        items={[
          { label: "operations, decode then add", value: int(dec.ops) },
          { label: "operations, on runs", value: int(rle.ops) },
          { label: "fewer operations", value: `${fixed(dec.ops / rle.ops, 1)}×` },
          { label: "both sums", value: dec.result === rle.result ? `${int(rle.result)} = ${int(dec.result)}` : "differ" },
        ]}
      />
      <SectionLabel style={{ marginTop: 16 }}>COUNT(*) WHERE country = '{needle}' over {int(countries.length)} rows</SectionLabel>
      <Stats
        items={[
          { label: "plain strings: byte comparisons", value: int(str.byteCompares) },
          { label: "dictionary: string comparisons", value: dct.dictCompares },
          { label: "dictionary: integer code comparisons", value: int(dct.codeCompares) },
          { label: "rows found", value: dct.count === str.count ? int(dct.count) : "differ" },
        ]}
      />
      <Note>{dct.code >= 0 ? `The engine finds '${needle}' once in the dictionary: code ${dct.code}. Then it compares 3-bit codes, never strings.` : `'${needle}' is not in the dictionary, so the engine answers 0 rows without reading a single code.`}</Note>
    </Demo>
  );
}

// ---------------- sort order vs runs ----------------

export function SortOrderDemo() {
  const [rows, setRows] = useState(4096);
  const [key, setKey] = useState("none");
  const table = useMemo(() => salesTable(rows), [rows]);
  const def = SORT_KEYS.find((k) => k.id === key)!;
  const counts = useMemo(() => runCounts(table, def.key), [table, def]);
  const base = useMemo(() => runCounts(table, []), [table]);
  const sizes = useMemo(() => {
    const s = sortRows(table, def.key);
    let rle = 0, plain = 0;
    for (const c of SALES_COLUMNS) {
      const vals = s.map((r) => r[c]);
      const type = typeof vals[0] === "number" ? "int32" : "string";
      rle += encode(type, vals, "rle").bytes.length;
      plain += plainBytes(type, vals).length;
    }
    return { rle, plain };
  }, [table, def]);
  const total = SALES_COLUMNS.reduce((s, c) => s + counts[c], 0);
  const distinct: Record<string, number> = { status: 3, region: 4, country: 17, day: 30, customer: 1000 };
  return (
    <Demo
      title="Sort order decides the run lengths"
      controls={
        <>
          <Param spec={range({ label: "Rows", min: 512, max: 4096, step: 512, default: 4096 })} value={rows} onChange={(v) => setRows(v as number)} />
          <Param spec={seg("Sort by", SORT_KEYS.map((k) => [k.id, k.label] as [string, string]), "none")} value={key} onChange={(v) => setKey(v as string)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>A sales table. The bar shows the runs in each column after the sort, out of {int(rows)} rows (log scale).</div>
      <div style={{ display: "grid", gap: 6 }}>
        {SALES_COLUMNS.map((c) => {
          const inKey = def.key.indexOf(c);
          return (
            <div key={c} style={{ display: "grid", gridTemplateColumns: "minmax(84px, 120px) 1fr minmax(64px, auto)", gap: 8, alignItems: "center", fontSize: 12.5 }}>
              <span>{c} <span className="muted">({distinct[c]})</span>{inKey >= 0 && <b style={{ color: "var(--c3)" }}> #{inKey + 1}</b>}</span>
              <Bar frac={Math.log(counts[c]) / Math.log(rows)} color={inKey >= 0 ? "var(--c3)" : "var(--c1)"} height={12} />
              <span style={{ ...mono, textAlign: "right" }}>{int(counts[c])}</span>
            </div>
          );
        })}
      </div>
      <Stats
        items={[
          { label: "runs in all 5 columns", value: int(total) },
          { label: "unsorted", value: int(SALES_COLUMNS.reduce((s, c) => s + base[c], 0)) },
          { label: "RLE size of the table", value: `${int(sizes.rle)} B` },
          { label: "RLE size ÷ plain size", value: pct(sizes.rle / sizes.plain, 0) },
        ]}
      />
      <Note>Numbers in brackets are distinct values. The mark #k shows the k-th sort key.</Note>
    </Demo>
  );
}
