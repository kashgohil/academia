/** Lesson: the dynamic loader. Lookup scope and interposition, the GNU hash table, and glibc symbol versions. */
import { useMemo, useState, type ReactNode } from "react";
import { Banner, Chip, Demo, Meter, MiniTable, Note, Param, SectionLabel, SmallLabel, Stats, int, mono, useChunked, range, select, seg, tint, toggle } from "../../kit";
import {
  BLOOM_SHIFT, FUNCTIONS, GLIBCS, OBJECTS, bindAllCost, buildGnuHash, checkRun, fakeLibrary, gnuLookup, runLoader, scopeLookup, type Fix,
} from "../../sims/sys/linking";
import { hx } from "./SysLinkUi";

const OBJ_COLOR: Record<string, string> = {
  app: "var(--c1)", "libtrace.so": "var(--c2)", "libbar.so": "var(--c5)", "libfoo.so": "var(--c3)", "libc.so.6": "var(--muted)", "plugin.so": "var(--c4)", "plugin2.so": "var(--c4)",
};
const FIX_LABEL: Record<Fix, string> = {
  none: "nothing (default)", bsymbolic: "link with -Bsymbolic", hidden: "make fmt hidden", protected: "make fmt protected", "no-semantic-interposition": "-fno-semantic-interposition",
};

export function ScopeDemo() {
  const [preload, setPreload] = useState(false);
  const [withBar, setWithBar] = useState(true);
  const [fix, setFix] = useState<Fix>("none");
  const [pluginGlobal, setPluginGlobal] = useState(false);
  const r = runLoader({ preload, withBar, fix, pluginGlobal });
  const [sel, setSel] = useState(2);
  const b = r.bindings[sel]!;
  return (
    <Demo
      title="Who wins the lookup?"
      controls={<>
        <Param spec={toggle({ label: "LD_PRELOAD=libtrace.so", default: false })} value={preload} onChange={(v) => setPreload(v as boolean)} />
        <Param spec={toggle({ label: "app also links libbar.so (it has an fmt too)", default: true })} value={withBar} onChange={(v) => setWithBar(v as boolean)} />
        <Param spec={select<Fix>({ label: "libfoo.so protects its call to fmt with", options: (Object.keys(FIX_LABEL) as Fix[]).map((f) => ({ value: f, label: FIX_LABEL[f] })), default: "none" })} value={fix} onChange={(v) => setFix(v as Fix)} />
        <Param spec={seg("dlopen(\"plugin.so\", …)", [["local", "RTLD_LOCAL"], ["global", "RTLD_GLOBAL"]], "local")} value={pluginGlobal ? "global" : "local"} onChange={(v) => setPluginGlobal(v === "global")} />
      </>}
    >
      <SmallLabel>Global scope, searched from left to right</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "stretch" }}>
        {r.globalScope.map((o, i) => {
          const searched = b.searched.includes(o);
          const winner = b.to === o;
          const c = OBJ_COLOR[o]!;
          return (
            <div key={o} title={OBJECTS[o]!.role} style={{ border: `1.5px solid ${winner ? "var(--fg)" : c}`, borderRadius: 6, padding: "3px 6px", background: winner ? tint(c, 40) : searched ? tint(c, 12) : undefined, minWidth: 92, flex: "1 1 92px" }}>
              <div style={{ ...mono, fontSize: 11.5, fontWeight: 600 }}><span className="muted">{i + 1}.</span> {o}</div>
              <div style={{ ...mono, fontSize: 10.5 }} className="muted">{(o === "libfoo.so" && fix === "hidden" ? OBJECTS[o]!.exports.filter((x) => x !== "fmt") : OBJECTS[o]!.exports).join(" ") || "exports nothing"}</div>
            </div>
          );
        })}
      </div>
      {!pluginGlobal && (
        <div style={{ marginTop: 6, fontSize: 12 }}>
          <span className="muted">Local scope of plugin.so (RTLD_LOCAL):</span> <Chip color={OBJ_COLOR["plugin.so"]}>plugin.so: plugin_api</Chip>
          <span className="muted"> · plugin2.so searches the global scope, then its own:</span> <Chip color={OBJ_COLOR["plugin2.so"]}>plugin2.so</Chip>
        </div>
      )}
      <SectionLabel>References. Click one.</SectionLabel>
      <div style={{ display: "grid", gap: 3 }}>
        {r.bindings.map((x, i) => {
          const c = x.to ? OBJ_COLOR[x.to]! : "var(--c4)";
          return (
            <div key={i} onClick={() => setSel(i)} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)", gap: 6, alignItems: "center", padding: "3px 6px", borderRadius: 4, cursor: "pointer", border: `1px solid ${i === sel ? "var(--fg)" : "var(--border)"}` }}>
              <span style={{ fontSize: 12 }}><span style={mono}>{x.ref.from}</span> → <b style={mono}>{x.ref.name}</b></span>
              <span style={{ ...mono, fontSize: 11.5, color: x.to ? "var(--fg)" : "var(--c4)", background: tint(c, 18), padding: "1px 6px", borderRadius: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {x.to ? `${x.to}${x.how === "link time" ? " (link time)" : ""}` : "undefined"}
              </span>
            </div>
          );
        })}
      </div>
      <Banner tone={b.how === "error" ? "bad" : b.how === "link time" ? "good" : b.ref.from === "libfoo.so" && b.to !== "libfoo.so" ? "warn" : "info"} label={b.ref.note}>
        {b.how === "error" ? <span style={mono}>{b.text}</span> : b.how === "link time" ? b.text : <>Found in <b style={mono}>{b.to}</b>, after checking {b.searched.length} object{b.searched.length === 1 ? "" : "s"}.{b.ref.from === "libfoo.so" && b.to !== "libfoo.so" ? " libfoo.so calls a function that it did not write." : ""}</>}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- GNU hash lookup

const LIBC_NAMES = ["puts", "printf", "malloc", "free", "memcpy", "strlen", "exit", "fopen", "fclose", "fread", "fwrite", "qsort"];
const TABLE = buildGnuHash(LIBC_NAMES);
const TRY = [...LIBC_NAMES, "strcpy", "pthread_create", "fmt", "main"];

function Bits64({ word, bits }: { word: bigint; bits: [number, number] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(32, 1fr)", gap: 1, maxWidth: 420 }}>
      {Array.from({ length: 64 }, (_, i) => 63 - i).map((bit) => {
        const set = (word >> BigInt(bit)) & 1n;
        const asked = bits.includes(bit);
        return <div key={bit} title={`bit ${bit}`} style={{ height: 12, borderRadius: 2, background: set ? (asked ? "var(--c3)" : "var(--muted)") : asked ? "var(--c4)" : "var(--subtle)", outline: asked ? "1.5px solid var(--fg)" : undefined }} />;
      })}
    </div>
  );
}

export function GnuHashDemo() {
  const [name, setName] = useState("malloc");
  const [libs, setLibs] = useState(20);
  const [perLib, setPerLib] = useState(500);
  const t = gnuLookup(TABLE, name);
  const jobs = useMemo(() => Array.from({ length: libs }, (_, i) => () => { const n = fakeLibrary(i, perLib); return { n, t: buildGnuHash(n) }; }), [libs, perLib]);
  const built = useChunked(`${libs}/${perLib}`, jobs, { keep: true });
  const ready = built.length === libs && built.every((x) => x !== undefined);
  const world = useMemo(() => {
    if (!ready) return null;
    const names = built.map((x) => x!.n), tables = built.map((x) => x!.t);
    return { last: scopeLookup(tables, names[libs - 1]![0]!), cost: bindAllCost(tables, names, 500) };
  }, [ready, built, libs]);
  const word = TABLE.bloom[t.bloomWord]!;
  const other = world ? world.cost.visits - 500 : 0;
  return (
    <Demo
      title="Be ld.so: find a name"
      controls={<>
        <Param spec={select({ label: "Look up", options: TRY.map((x) => ({ value: x, label: x })), default: "malloc" })} value={name} onChange={(v) => setName(v as string)} />
        <Param spec={range({ label: "Libraries in the scope", min: 1, max: 40, step: 1, default: 20 })} value={libs} onChange={(v) => setLibs(v as number)} />
        <Param spec={range({ label: "Exported symbols per library", min: 50, max: 2000, step: 50, default: 500 })} value={perLib} onChange={(v) => setPerLib(v as number)} />
      </>}
    >
      <SmallLabel>One library: 12 names, the .gnu.hash table that ld.lld builds for them</SmallLabel>
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.6 }}>
        <div>1. hash("{name}") = {hx(t.hash)} <span className="muted">(h = h × 33 + c, from 5381)</span></div>
        <div>2. Bloom word = h / 64 mod {TABLE.bloom.length} = <b>{t.bloomWord}</b>; bits {t.bits[0]} (h mod 64) and {t.bits[1]} (h ≫ shift mod 64; this table stores shift {BLOOM_SHIFT})</div>
      </div>
      <Bits64 word={word} bits={t.bits} />
      <div className="muted" style={{ fontSize: 11.5, ...mono }}>bit 63 … bit 0 of bloom[{t.bloomWord}]. Outlined: the two bits for this name. Green: set. Red: not set.</div>
      <div style={{ ...mono, fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>
        {t.bloomPass ? (
          <>
            <div>3. Both bits set: maybe here. Bucket = h mod {TABLE.nbuckets} = <b>{t.bucket}</b>, first index {TABLE.buckets[t.bucket]}</div>
            <div>4. Chain: {t.chain.map((c) => <Chip key={c.index} color={c.hashMatch ? (c.name === name ? "var(--c3)" : "var(--c2)") : "var(--faint)"}>{c.index}:{c.name}</Chip>).reduce<ReactNode[]>((a, x, i) => (i ? [...a, " ", x] : [x]), [])}</div>
          </>
        ) : <div>3. A bit is clear: the name is certainly not here. No bucket, no string compare.</div>}
      </div>
      <Banner tone={t.found ? "good" : "info"}>{t.found ? `Found at .dynsym index ${t.found} with ${t.strcmps} string compare.` : t.bloomPass ? `Not here, after ${t.chain.length} hash compares and ${t.strcmps} string compares: a Bloom false positive.` : "Rejected by the Bloom filter in two memory reads."}</Banner>
      <SectionLabel>A scope of {libs} libraries with {perLib} symbols each</SectionLabel>
      {world ? <>
        <Stats items={[
          { label: "Libraries visited for a name in the last one", value: world.last.visits.length },
          { label: "Bloom rejects on the way", value: world.last.bloomRejects },
          { label: "Binding 500 random names: libraries visited", value: int(world.cost.visits) },
          { label: "string compares", value: int(world.cost.strcmps) },
        ]} />
        <Meter label="Visits that the Bloom filter answers alone" value={world.cost.bloomRejects} max={Math.max(1, other)} color="var(--c3)" text={other ? `${((world.cost.bloomRejects / other) * 100).toFixed(1)}%` : "n/a"} />
        <Meter label="Bloom false positives (bucket walked for nothing)" value={world.cost.falsePositives} max={Math.max(1, other)} color="var(--c2)" text={int(world.cost.falsePositives)} />
      </> : <div className="muted" style={{ fontSize: 12.5, minHeight: 120 }}>Building {libs} hash tables…</div>}
      <Note>The libraries have made-up names. Each lookup walks the scope in order and stops at the first library that defines the name.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------------------- glibc versions

export function VersionDemo() {
  const [built, setBuilt] = useState<string>("2.39");
  const [run, setRun] = useState<string>("2.31");
  const [used, setUsed] = useState<string[]>(["puts", "memcpy"]);
  const r = checkRun(built, run, used);
  const opts = GLIBCS.map((g) => ({ value: g, label: `glibc ${g}` }));
  const toggleFn = (f: string) => setUsed((u) => (u.includes(f) ? u.filter((x) => x !== f) : [...u, f]));
  return (
    <Demo
      title="Build here, run there"
      controls={<>
        <Param spec={select({ label: "Build against", options: opts, default: "2.39" })} value={built} onChange={(v) => setBuilt(v as string)} />
        <Param spec={select({ label: "Run on", options: opts, default: "2.31" })} value={run} onChange={(v) => setRun(v as string)} />
      </>}
    >
      <SmallLabel>The program calls (click to change):</SmallLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
        {FUNCTIONS.filter((f) => f.name !== "__libc_start_main").map((f) => (
          <span key={f.name} onClick={() => toggleFn(f.name)} style={{ cursor: "pointer" }}><Chip color={used.includes(f.name) ? "var(--c1)" : "var(--faint)"} filled={used.includes(f.name)}>{f.name}</Chip></span>
        ))}
      </div>
      {r.compileErrors.length > 0 ? (
        <Banner tone="bad" label="compile">{r.compileErrors.join(", ")} does not exist in glibc {built}. The headers do not declare it, so the program does not compile.</Banner>
      ) : (
        <>
          <MiniTable head={["needs (.dynsym)", "from", `in ${run}?`]} rows={r.needs.map((n) => {
            const ok = !r.missing.includes(n.version!);
            return [<span key="n" style={mono}>{n.fn}@{n.version}</span>, <span key="l" style={mono}>{n.lib}</span>, <span key="o" style={{ color: ok ? "var(--c3)" : "var(--c4)", fontWeight: 600 }}>{ok ? "yes" : "no"}</span>];
          })} />
          {r.error ? <Banner tone="bad" label="ld.so"><span style={{ ...mono, fontSize: 12, overflowWrap: "anywhere" }}>{r.error}</span></Banner>
            : <Banner tone="good" label="ld.so">Every version is there. The program starts.</Banner>}
        </>
      )}
      <Note>Versions as zig cc 0.17.1 records them for each glibc. __libc_start_main comes from the C start-up code, so every program needs it.</Note>
    </Demo>
  );
}
