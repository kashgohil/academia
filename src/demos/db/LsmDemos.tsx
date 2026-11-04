/** Demos for "Memtables and SSTables": the write/read path stepper, a skip list, and the block format. */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Demo, Stats, Param, Legend, range, toggle, pct, bytes } from "../../kit";
import { mulberry32 } from "../../sims/rng";
import {
  LsmTree, SkipList, expectedSearchCost, averageSearchCost, encodeBlock, layoutTable, stepperSeedTree, blockKeys, avgSeekCost,
  type Entry, type Probe, type GetResult, type SSTable, type Memtable, type KeySet,
} from "../../sims/db/lsm";
import { seg, mono, Note, Caption, Btn, ButtonRow, fx, StackBar } from "./LsmShared";

// ================= the write and read path =================

const FRUIT = ["apple", "banana", "cherry", "date", "fig", "grape", "kiwi", "lemon"] as const;

const VALUES = ["red", "green", "blue", "gold", "pink", "teal"];

type Outcome = Probe["result"] | "idle";
const OUT_STYLE: Record<Outcome, { color: string; label: string }> = {
  idle: { color: "var(--border)", label: "" },
  miss: { color: "var(--c2)", label: "checked: not here" },
  "no-file": { color: "var(--border)", label: "skipped: key out of range" },
  "fence-skip": { color: "var(--border)", label: "skipped: key out of range" },
  "bloom-skip": { color: "var(--c5)", label: "skipped: filter says no" },
  found: { color: "var(--c3)", label: "answer: value" },
  deleted: { color: "var(--c4)", label: "answer: tombstone" },
};

function EntryRows({ entries, hiKey, hiSeq }: { entries: readonly Entry[]; hiKey?: string; hiSeq?: number }) {
  return (
    <div style={{ ...mono, fontSize: 11.5, lineHeight: 1.55 }}>
      {entries.map((e) => {
        const hit = e.key === hiKey;
        const answer = hit && e.seq === hiSeq;
        return (
          <div key={`${e.key}${e.seq}`} style={{ display: "flex", gap: 6, padding: "0 4px", borderRadius: 3, background: answer ? "var(--subtle)" : undefined, fontWeight: answer ? 700 : 400, color: hit ? "var(--fg)" : "var(--muted)" }}>
            <span style={{ minWidth: 46 }}>{e.key}</span>
            <span style={{ flex: 1, color: e.kind === "del" ? "var(--c4)" : undefined }}>{e.kind === "del" ? "✕ delete" : e.value}</span>
            <span className="muted">#{e.seq}</span>
          </div>
        );
      })}
      {entries.length === 0 && <div className="muted" style={{ padding: "0 4px" }}>empty</div>}
    </div>
  );
}

function Card({ title, sub, outcome, children, width = 150 }: { title: string; sub?: string; outcome: Outcome; children: React.ReactNode; width?: number }) {
  const o = OUT_STYLE[outcome];
  const strong = outcome === "found" || outcome === "deleted" || outcome === "miss" || outcome === "bloom-skip";
  return (
    <div style={{ flex: `0 1 ${width}px`, minWidth: 142, border: `${strong ? 2 : 1}px solid ${o.color}`, borderRadius: 6, padding: "4px 2px 5px", background: "var(--bg)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "0 6px", padding: "0 4px 2px", fontSize: 11.5, fontWeight: 600 }}>
        <span>{title}</span>
        {sub && <span className="muted" style={{ fontWeight: 400 }}>{sub}</span>}
      </div>
      {children}
      {outcome !== "idle" && <div style={{ fontSize: 10.5, padding: "3px 4px 0", color: o.color === "var(--border)" ? "var(--muted)" : o.color, fontWeight: 600 }}>{o.label}</div>}
    </div>
  );
}

const memEntries = (m: Memtable) => [...m.list.entries()].map(([e]) => e);
const fileRange = (f: SSTable) => `${f.minKey}…${f.maxKey}`;

export function LsmStepperDemo() {
  const [limit, setLimit] = useState(4);
  const [k, setK] = useState<string>("cherry");
  const [atSnap, setAtSnap] = useState(false);
  const [, force] = useState(0);
  const tree = useRef<LsmTree | null>(null);
  if (!tree.current) tree.current = stepperSeedTree();
  const t = tree.current;
  const [snap, setSnap] = useState<number | null>(null);
  const [last, setLast] = useState<{ key: string; res: GetResult } | null>(null);
  const [msg, setMsg] = useState("Pick a key, then press Get to see the read path, or Put and Delete to see the write path.");
  const redraw = () => force((x) => x + 1);

  const afterWrite = (what: string) => {
    let extra = "";
    if (t.mem.entries >= limit) {
      t.rotate();
      extra = " The memtable is full, so it becomes immutable and a new memtable starts.";
      if (t.imm.length > 2) { t.flushOldest(); extra += " Two memtables already wait, so the oldest one is flushed now (a write stall in a real engine)."; }
    }
    setLast(null);
    setMsg(`${what}${extra}`);
    redraw();
  };
  const doPut = () => { const v = VALUES[t.seq % VALUES.length]!; const e = t.put(k, v); afterWrite(`put(${k}, ${v}): WAL record #${e.seq} appended, then inserted into the memtable.`); };
  const doDel = () => { const e = t.del(k); afterWrite(`delete(${k}): a tombstone #${e.seq} goes to the WAL and the memtable. Nothing on disk changes.`); };
  const doGet = () => {
    const res = t.get(k, atSnap && snap !== null ? snap : Infinity);
    const ans = res.entry ? (res.entry.kind === "put" ? `"${res.value}" (#${res.entry.seq})` : `not found: tombstone #${res.entry.seq}`) : "not found";
    setLast({ key: k, res });
    setMsg(`get(${k})${atSnap && snap !== null ? ` at snapshot #${snap}` : ""} → ${ans}. It checked ${res.probes.length} place${res.probes.length > 1 ? "s" : ""} and read ${res.ios} data block${res.ios === 1 ? "" : "s"}.`);
    redraw();
  };
  const doFlush = () => {
    const ev = t.flush();
    setLast(null);
    setMsg(ev.length ? `Flush: ${ev.length} memtable${ev.length > 1 ? "s" : ""} written as new L0 file${ev.length > 1 ? "s" : ""} (sorted, with a Bloom filter). Their WAL records are deleted.` : "Nothing to flush.");
    redraw();
  };
  const doCompact = () => {
    const ev = t.compactLevel(0);
    setLast(null);
    setMsg(ev ? `Compaction: ${ev.inputs.length} files merged into L1. ${ev.droppedVersions} old version${ev.droppedVersions === 1 ? "" : "s"} and ${ev.droppedTombstones} tombstone${ev.droppedTombstones === 1 ? "" : "s"} dropped, because no reader can see them.` : "L0 is empty: nothing to compact.");
    redraw();
  };
  const doSnap = () => { const s = t.snapshot(); setSnap(s); setMsg(`Snapshot at #${s}: reads at this snapshot ignore every entry with a larger sequence number. Compaction now keeps the versions that it needs.`); redraw(); };
  const reset = () => { tree.current = stepperSeedTree(); setLast(null); setSnap(null); setAtSnap(false); setMsg("Reset."); redraw(); };

  const probe = (p: (x: Probe) => boolean): Outcome => (last ? last.res.probes.find(p)?.result ?? "idle" : "idle");
  const hiKey = last?.key;
  const hiSeq = last?.res.entry?.seq;
  const l0 = t.levels[0]!.runs;
  const l1 = t.levels[1]!.runs[0]?.files ?? [];
  const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" };

  return (
    <Demo
      title="The write path and the read path of an LSM tree"
      controls={
        <>
          <Param spec={range({ label: "Memtable holds (entries)", min: 2, max: 8, step: 1, default: 4 })} value={limit} onChange={(v) => setLimit(v as number)} />
          <Param spec={seg("Key", FRUIT.map((f) => [f, f] as [string, string]), "cherry")} value={k} onChange={(v) => setK(v as string)} />
          <ButtonRow>
            <Btn onClick={doGet}>Get</Btn>
            <Btn onClick={doPut}>Put</Btn>
            <Btn onClick={doDel}>Delete</Btn>
            <Btn onClick={doFlush}>Flush</Btn>
            <Btn onClick={doCompact}>Compact L0 → L1</Btn>
            <Btn onClick={doSnap}>Snapshot</Btn>
            <Btn ghost onClick={reset}>Reset</Btn>
          </ButtonRow>
          {snap !== null && <Param spec={toggle({ label: `Read at snapshot #${snap}`, default: false })} value={atSnap} onChange={(v) => setAtSnap(v as boolean)} />}
        </>
      }
    >
      <p style={{ fontSize: 13, margin: "0 0 6px", minHeight: 38 }}>{msg}</p>
      <Caption>WAL on disk: append only, one segment per memtable ({t.wal.length} records)</Caption>
      <div style={{ ...mono, fontSize: 11, display: "flex", flexWrap: "wrap", gap: 4 }}>
        {t.wal.slice(-10).map((r) => (
          <span key={r.entry.seq} style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", color: r.entry.kind === "del" ? "var(--c4)" : "var(--fg)" }}>
            #{r.entry.seq} {r.entry.kind === "del" ? `del ${r.entry.key}` : `put ${r.entry.key}`}
          </span>
        ))}
        {t.wal.length === 0 && <span className="muted">empty: every write is in an SSTable</span>}
      </div>
      <Caption>Memory: memtable (skip list, sorted) and immutable memtables</Caption>
      <div style={row}>
        <Card title="memtable" sub={`${t.mem.entries}/${limit}`} outcome={probe((p) => p.source === "memtable")}>
          <EntryRows entries={memEntries(t.mem)} hiKey={hiKey} hiSeq={hiSeq} />
        </Card>
        {t.imm.map((m, i) => (
          <Card key={m.id} title={`immutable ${i + 1}`} sub="waits for flush" outcome={probe((p) => p.source === "immutable" && p.run === i + 1)}>
            <EntryRows entries={memEntries(m)} hiKey={hiKey} hiSeq={hiSeq} />
          </Card>
        ))}
      </div>
      <Caption>Disk, L0: one file per flush, newest first; files can overlap</Caption>
      <div style={row}>
        {l0.map((r, i) => {
          const f = r.files[0]!;
          return (
            <Card key={f.id} title={`file ${f.id}`} sub={fileRange(f)} outcome={probe((p) => p.level === 0 && p.run === i)}>
              <EntryRows entries={f.entries} hiKey={hiKey} hiSeq={hiSeq} />
            </Card>
          );
        })}
        {l0.length === 0 && <span className="muted" style={{ fontSize: 12 }}>no files</span>}
      </div>
      <Caption>Disk, L1: one sorted run; file ranges do not overlap</Caption>
      <div style={row}>
        {l1.map((f) => (
          <Card key={f.id} title={`file ${f.id}`} sub={fileRange(f)} outcome={probe((p) => p.level === 1 && p.fileId === f.id)}>
            <EntryRows entries={f.entries} hiKey={hiKey} hiSeq={hiSeq} />
          </Card>
        ))}
        {l1.length === 0 && <span className="muted" style={{ fontSize: 12 }}>no files yet: press Compact</span>}
      </div>
      <Stats
        items={[
          { label: "next sequence number", value: `#${t.seq + 1}` },
          { label: "places a get may check", value: t.sortedRuns() },
          { label: "blocks read by the last get", value: last ? last.res.ios : "–" },
          { label: "WAL bytes written", value: bytes(t.stats.walBytes) },
        ]}
      />
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: "answer: value", color: "var(--c3)" }, { label: "answer: tombstone", color: "var(--c4)" }, { label: "read, not here", color: "var(--c2)" }, { label: "filter says no", color: "var(--c5)" }]} />
      </div>
    </Demo>
  );
}

// ================= skip list =================

function buildList(n: number, p: number, seed: number) {
  const rng = mulberry32(seed * 101 + n);
  const keys = new Set<number>();
  while (keys.size < n) keys.add(1 + Math.floor(rng() * 99));
  const list = new SkipList<number, null>((a, b) => a - b, { p, seed: seed * 31 + 7 });
  for (const k of keys) list.insert(k, null);
  return list;
}

export function SkipListDemo() {
  const [n, setN] = useState(16);
  const [pStr, setP] = useState<"2" | "4">("2");
  const [seed, setSeed] = useState(1);
  const [target, setTarget] = useState(50);
  const [extra, setExtra] = useState<{ key: number; flips: boolean[]; height: number } | null>(null);
  const p = pStr === "2" ? 0.5 : 0.25;
  const list = useMemo(() => buildList(n, p, seed), [n, p, seed]);
  const [ver, setVer] = useState(0);
  const nodes = useMemo(() => list.nodes(), [list, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const search = useMemo(() => list.search(target), [list, target, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const avg = useMemo(() => averageSearchCost(list), [list, ver]); // eslint-disable-line react-hooks/exhaustive-deps

  const insertOne = () => {
    const have = new Set(nodes.map((x) => x.key));
    const free = Array.from({ length: 99 }, (_, i) => i + 1).filter((x) => !have.has(x));
    if (!free.length) return;
    const key = free[Math.floor(mulberry32(seed * 7 + nodes.length)() * free.length)]!;
    const r = list.insert(key, null);
    setExtra({ key, flips: r.flips, height: r.height });
    setTarget(key);
    setVer((v) => v + 1);
  };

  const H = Math.min(10, Math.max(...nodes.map((x) => x.height), 1));
  const colW = 30, rowH = 20, top = 8;
  const W = (nodes.length + 2) * colW, Ht = top + H * rowH + 22;
  const col = new Map(nodes.map((x, i) => [x.key, i + 1]));
  const cx = (c: number) => c * colW + colW / 2;
  const cy = (lvl: number) => top + (H - 1 - lvl) * rowH + rowH / 2;
  // Walk the path to get the drawn moves.
  const moves: { lvl: number; from: number; to: number }[] = [];
  const rejected: { lvl: number; c: number }[] = [];
  let cur = 0;
  for (const s of search.path) {
    const c = s.key === null ? nodes.length + 1 : col.get(s.key)!;
    if (s.dir === "right") { moves.push({ lvl: s.level, from: cur, to: c }); cur = c; }
    else rejected.push({ lvl: s.level, c });
  }
  const visitedCols = new Set([0, ...moves.map((m) => m.to)]);
  return (
    <Demo
      title="A skip list: search path and node heights"
      controls={
        <>
          <Param spec={range({ label: "Keys in the list", min: 4, max: 40, step: 1, default: 16 })} value={n} onChange={(v) => { setN(v as number); setExtra(null); }} />
          <Param spec={range({ label: "Search for key", min: 1, max: 99, step: 1, default: 50 })} value={target} onChange={(v) => setTarget(v as number)} />
          <Param spec={seg("P(heads) = p", [["2", "1/2"], ["4", "1/4 (LevelDB)"]], "2")} value={pStr} onChange={(v) => { setP(v as "2" | "4"); setExtra(null); }} />
          <ButtonRow>
            <Btn onClick={insertOne}>Insert a random key</Btn>
            <Btn ghost onClick={() => { setSeed((s) => s + 1); setExtra(null); }}>New coin flips</Btn>
          </ButtonRow>
        </>
      }
    >
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <svg viewBox={`0 0 ${W} ${Ht}`} style={{ width: "100%", minWidth: W * 0.75, height: "auto", display: "block", maxHeight: 300 }}>
        {Array.from({ length: H }, (_, lvl) => {
          // Links at this level: from each node of height > lvl to the next such node.
          const owners = [0, ...nodes.map((x, i) => (x.height > lvl ? i + 1 : -1)).filter((c) => c > 0), nodes.length + 1];
          return owners.slice(0, -1).map((a, i) => {
            const b = owners[i + 1]!;
            const on = moves.some((m) => m.lvl === lvl && m.from === a && m.to === b);
            return <line key={`${lvl}-${a}`} x1={cx(a) + 9} x2={cx(b) - 9} y1={cy(lvl)} y2={cy(lvl)} stroke={on ? "var(--c1)" : "var(--border)"} strokeWidth={on ? 2.5 : 1} />;
          });
        })}
        {/* head and NIL columns */}
        {Array.from({ length: H }, (_, lvl) => (
          <g key={`h${lvl}`}>
            <rect x={cx(0) - 9} y={cy(lvl) - 7} width={18} height={14} rx={3} fill="var(--subtle)" stroke="var(--muted)" />
            <rect x={cx(nodes.length + 1) - 9} y={cy(lvl) - 7} width={18} height={14} rx={3} fill="none" stroke="var(--border)" strokeDasharray="2 2" />
          </g>
        ))}
        <text x={cx(0)} y={Ht - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">head</text>
        <text x={cx(nodes.length + 1)} y={Ht - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">nil</text>
        {nodes.map((x, i) => {
          const c = i + 1;
          const isTarget = x.key === target && search.found;
          const isNew = extra?.key === x.key;
          return (
            <g key={x.key}>
              {Array.from({ length: Math.min(x.height, H) }, (_, lvl) => {
                const rej = rejected.some((r) => r.lvl === lvl && r.c === c);
                return <rect key={lvl} x={cx(c) - 9} y={cy(lvl) - 7} width={18} height={14} rx={3} fill={isTarget ? "var(--c3)" : visitedCols.has(c) && moves.some((m) => m.to === c && m.lvl === lvl) ? "var(--c1)" : "var(--subtle)"} stroke={rej ? "var(--c2)" : isNew ? "var(--fg)" : "var(--muted)"} strokeWidth={rej || isNew ? 2 : 1} />;
              })}
              <text x={cx(c)} y={Ht - 6} textAnchor="middle" fontSize={10.5} fill={isTarget ? "var(--c3)" : "var(--fg)"} fontWeight={isTarget ? 700 : 400}>{x.key}</text>
            </g>
          );
        })}
      </svg>
      </div>
      <p style={{ fontSize: 13, margin: "8px 0 0", minHeight: 20 }}>
        Search for {target}: <b style={{ color: search.found ? "var(--c3)" : "var(--c2)" }}>{search.found ? "found" : "not in the list"}</b> after {search.comparisons} key comparisons.
        {extra && <> Insert of {extra.key}: coin flips {extra.flips.map((f) => (f ? "heads" : "tails")).join(", ")} → height {extra.height}.</>}
      </p>
      <Stats
        items={[
          { label: "comparisons, this search", value: search.comparisons },
          { label: "average over all keys", value: fx(avg, 1) },
          { label: "formula log₁/ₚ(n) / p", value: fx(expectedSearchCost(nodes.length, p), 1) },
          { label: "pointers per node (expected 1/(1−p))", value: `${fx(nodes.reduce((s, x) => s + x.height, 0) / nodes.length, 2)} (${fx(1 / (1 - p), 2)})` },
        ]}
      />
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: "move right", color: "var(--c1)" }, { label: "compared, too big: go down", color: "var(--c2)" }, { label: "found", color: "var(--c3)" }]} />
      </div>
    </Demo>
  );
}

// ================= block format =================

export function BlockLayoutDemo() {
  const [ri, setRi] = useState(16);
  const [set, setSet] = useState<KeySet>("user");
  const kvs = useMemo(() => blockKeys(set), [set]);
  const b = useMemo(() => encodeBlock(kvs, ri), [kvs, ri]);
  const plain = useMemo(() => encodeBlock(kvs, ri, false), [kvs, ri]);
  const seek = useMemo(() => avgSeekCost(b.bytes, kvs), [b, kvs]);
  const table = useMemo(() => layoutTable(blockKeys(set, 1000), 4096, ri, 10), [set, ri]);
  const show = b.layout.slice(0, 18);
  const maxBytes = Math.max(...show.map((e) => e.shared + e.bytes));
  const C = { shared: "var(--subtle)", head: "var(--c5)", key: "var(--c1)", val: "var(--c3)" };
  return (
    <Demo
      title="Inside a data block: prefix compression and restart points"
      controls={
        <>
          <Param spec={range({ label: "Restart interval (entries)", min: 1, max: 32, step: 1, default: 16 })} value={ri} onChange={(v) => setRi(v as number)} />
          <Param spec={seg<KeySet>("Keys", [["user", "user:id:field"], ["url", "URLs"], ["hex", "random hex"]], "user")} value={set} onChange={(v) => setSet(v as KeySet)} />
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>The first 18 of {kvs.length} entries. Grey = prefix shared with the previous key: it is not stored.</div>
      <div style={{ display: "grid", gap: 2 }}>
        {show.map((e) => (
          <div key={e.key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)", gap: 8, alignItems: "center" }}>
            <div style={{ ...mono, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              <span style={{ color: e.restart ? "var(--c2)" : "var(--faint)", fontWeight: 700, marginRight: 4 }}>{e.restart ? "R" : "·"}</span>
              <span style={{ color: "var(--faint)" }}>{e.key.slice(0, e.shared)}</span>
              <span>{e.key.slice(e.shared)}</span>
            </div>
            <div style={{ display: "flex", height: 13 }}>
              {[
                [e.shared, C.shared],
                [e.headerBytes, C.head],
                [e.nonShared, C.key],
                [e.valueLen, C.val],
              ].map(([w, c], i) => (
                <div key={i} style={{ width: `${(100 * (w as number)) / maxBytes}%`, background: c as string, border: i === 0 && (w as number) > 0 ? "1px dashed var(--border)" : undefined, boxSizing: "border-box" }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6 }}>
        <Legend box items={[{ label: "shared (not stored)", color: C.shared }, { label: "3 varints", color: C.head }, { label: "key suffix", color: C.key }, { label: "value", color: C.val }]} />
      </div>
      <Stats
        items={[
          { label: "block, prefix compression", value: `${b.bytes.length} B` },
          { label: "block, full keys", value: `${plain.bytes.length} B` },
          { label: "saved", value: pct(1 - b.bytes.length / plain.bytes.length) },
          { label: `restart array (${b.restarts.length} points)`, value: `${b.trailerBytes} B` },
          { label: "seek: binary-search steps + entries scanned", value: `${fx(seek.probes, 1)} + ${fx(seek.scanned, 1)}` },
        ]}
      />
      <Caption style={{ marginTop: 14 }}>A whole SSTable of 1,000 such entries, 4 KiB blocks</Caption>
      <StackBar
        height={22}
        parts={[
          { value: table.dataBytes, color: "var(--c1)", label: "data blocks" },
          { value: table.filterBytes, color: "var(--c5)", label: "filter" },
          { value: table.metaindexBytes, color: "var(--c4)", label: "metaindex" },
          { value: table.indexBytes, color: "var(--c2)", label: "index" },
          { value: table.footerBytes, color: "var(--fg)", label: "footer" },
        ]}
      />
      <div className="muted" style={{ ...mono, fontSize: 11.5, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "2px 14px" }}>
        <span><b style={{ color: "var(--c1)" }}>■</b> {table.dataBlocks.length} data blocks {bytes(table.dataBytes)}</span>
        <span><b style={{ color: "var(--c5)" }}>■</b> filter {table.filterBytes} B</span>
        <span><b style={{ color: "var(--c4)" }}>■</b> metaindex {table.metaindexBytes} B</span>
        <span><b style={{ color: "var(--c2)" }}>■</b> index {table.indexBytes} B</span>
        <span>■ footer {table.footerBytes} B</span>
      </div>
      <Note>Index keys are short separators, not full keys. The first two are “{table.indexKeys[0]}” and “{table.indexKeys[1]}”.</Note>
    </Demo>
  );
}
