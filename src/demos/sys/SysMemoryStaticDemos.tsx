/**
 * Demos for "Static data and the binary layout" (Systems / memory):
 * - SysMemorySectionsDemo: be the compiler: put each global in a section, then see the file bytes and memory bytes.
 * - SysMemoryLifetimeDemo: a C program with a static counter, a global and a string literal, on the shared machine.
 * - SysMemoryInitOrderDemo: the order in which C++, Go, Rust (LazyLock) and Zig initialize three dependent globals.
 */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, MiniTable, Note, Param, SectionLabel, StackBar, Stats, StepButtons, StepCaption, StepSlider, bytes, int, mono, range, select, tint, toggle, useStepper } from "../../kit";
import { ADDR, hex } from "../../sims/sys/mem";
import {
  fileAndMemory, finalValue, globalsOf, initOrder, LIFETIME_SOURCE, lifetimeScript, runScript, SECTION_TEXT,
  type GLang, type InitLang, type SectionId,
} from "../../sims/sys/memory";
import { AddressSpaceMap, StackView, UbBanner } from "./SysViews";
import { CodeLines } from "./SysMemoryUi";

export const SECTION_COLOR: Record<SectionId, string> = { text: "var(--muted)", rodata: "var(--c5)", data: "var(--c2)", bss: "var(--c1)", tdata: "var(--c3)", tbss: "var(--faint)" };
const ORDER: SectionId[] = ["rodata", "data", "bss", "tdata", "tbss"];

// ---------------------------------------------------------------- sections

const langSpec = select({ label: "Language", options: [{ value: "c", label: "C" }, { value: "rust", label: "Rust" }, { value: "zig", label: "Zig" }, { value: "go", label: "Go" }], default: "c", segmented: true });
const nSpec = range({ label: "Array length N", min: 16, max: 262144, default: 1024, log: true, format: (v) => int(Math.round(v)) });

export function SysMemorySectionsDemo() {
  const [lang, setLang] = useState<GLang>("c");
  const [n0, setN] = useState(1024);
  const [guess, setGuess] = useState<Record<string, SectionId>>({});
  const n = Math.round(n0);
  const decls = globalsOf(lang);
  const fm = fileAndMemory(decls, n);
  const parts = (file: boolean) => ORDER.filter((s) => !file || (s !== "bss" && s !== "tbss")).map((s) => ({ value: fm.sections[s], color: SECTION_COLOR[s], label: `${SECTION_TEXT[s]}: ${bytes(fm.sections[s])}` }));
  const done = decls.filter((d) => guess[d.id]).length;
  const right = decls.filter((d) => guess[d.id] === d.section).length;
  return (
    <Demo title="Be the compiler: which section does each global go to?" controls={<>
      <Param spec={langSpec} value={lang} onChange={(v) => setLang(v as GLang)} />
      <Param spec={nSpec} value={n0} onChange={(v) => setN(v as number)} />
    </>}>
      <div style={{ display: "grid", gap: 8 }}>
        {decls.map((d) => {
          const g = guess[d.id];
          const ok = g === d.section;
          return (
            <div key={d.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", boxShadow: g ? `inset 3px 0 0 ${ok ? "var(--c3)" : "var(--c4)"}` : undefined }}>
              <div style={{ overflowX: "auto" }}><code style={{ ...mono, fontSize: 12, whiteSpace: "pre" }}>{d.code(n)}</code></div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
                {ORDER.map((s) => (
                  <button key={s} onClick={() => setGuess({ ...guess, [d.id]: s })} style={{
                    fontSize: 11.5, ...mono, padding: "1px 7px", borderRadius: 4, cursor: "pointer", color: "var(--fg)",
                    border: `1px solid ${g === s ? (ok ? "var(--c3)" : "var(--c4)") : g && s === d.section ? "var(--c3)" : "var(--border)"}`,
                    background: g === s ? tint(ok ? "var(--c3)" : "var(--c4)", 22) : g && s === d.section ? tint("var(--c3)", 12) : "transparent",
                  }}>{SECTION_TEXT[s]}</button>
                ))}
              </div>
              {g && (
                <div style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.45 }}>
                  <b style={mono}>{d.exact}</b>{d.extra ? <> + <b style={mono}>{d.extra.exact}</b></> : null} <span className="muted">· {bytes(d.bytes(n))} · {d.tool}</span>
                  <div className="muted">{d.note}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <SectionLabel>Section contents of these globals</SectionLabel>
      <div className="muted" style={{ fontSize: 12, ...mono, marginBottom: 3 }}>in the file: {bytes(fm.file)}</div>
      <StackBar parts={parts(true)} total={Math.max(fm.memory, 1)} />
      <div className="muted" style={{ fontSize: 12, ...mono, margin: "6px 0 3px" }}>in memory: {bytes(fm.memory)}</div>
      <StackBar parts={parts(false)} total={Math.max(fm.memory, 1)} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11.5, marginTop: 6 }}>
        {ORDER.map((s) => <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: SECTION_COLOR[s] }} />{SECTION_TEXT[s]} {bytes(fm.sections[s])}</span>)}
      </div>
      <Stats items={[{ label: "answered", value: `${done} of ${decls.length}` }, { label: "right", value: `${right}` }, { label: "file / memory", value: `${Math.round((100 * fm.file) / Math.max(1, fm.memory))}%` }]} />
      <Note>Contents only: the compiler also adds alignment padding, symbols, relocations and headers. Go's .noptrbss and .noptrdata count as .bss and .data here.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- lifetimes

const sectionOf = (addr: number) => (addr >= ADDR.bss && addr < ADDR.heap ? ".bss" : addr >= ADDR.data ? ".data" : addr >= ADDR.rodata ? ".rodata" : ".text");

export function SysMemoryLifetimeDemo() {
  const steps = useMemo(() => runScript(lifetimeScript).steps, []);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[s.i]!;
  const bad = new Set(steps.slice(1, s.i + 1).filter((x) => x.ub.length).map((x) => x.line));
  return (
    <Demo
      title="Static, automatic and read-only storage"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<StepSlider s={s} />}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>The program</SectionLabel>
          <CodeLines lines={LIFETIME_SOURCE} current={cur.line} bad={bad} />
          <SectionLabel>Globals (static storage duration)</SectionLabel>
          {cur.snap.globals.length ? (
            <MiniTable head={["name", "section", "address", "value"]} rows={cur.snap.globals.map((g) => [g.name, sectionOf(g.addr), hex(g.addr), g.text])} />
          ) : <div className="muted" style={{ fontSize: 12.5 }}>Not loaded yet.</div>}
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack frames (automatic storage)</SectionLabel>
          <StackView frames={cur.snap.frames} empty="No frames: main has not started." />
          <SectionLabel>Address space</SectionLabel>
          <AddressSpaceMap snapshot={cur.snap} />
        </div>
      </div>
      <StepCaption label={cur.line ? `line ${cur.line}` : "start"} tone={cur.ub.length ? "bad" : null}>{cur.caption}</StepCaption>
      {cur.ub.map((r, i) => <UbBanner key={i} event={r} />)}
    </Demo>
  );
}

// ---------------------------------------------------------------- initialization order

const initLangSpec = select({ label: "Language", options: [{ value: "cpp", label: "C++" }, { value: "go", label: "Go" }, { value: "rust", label: "Rust LazyLock" }, { value: "zig", label: "Zig" }], default: "cpp", segmented: true });
const linkSpec = toggle({ label: "Link logger.o before app.o", default: true });
const declSpec = toggle({ label: "In app, declare config before cache", default: true });

function initSource(lang: InitLang, loggerFirst: boolean, configFirst: boolean): { file: string; lines: string[] }[] {
  const app = (a: string, b: string) => (configFirst ? [a, b] : [b, a]);
  if (lang === "cpp") {
    const files = [
      { file: "logger.cpp", lines: ["Logger logger;  // constructor sets prefix = \"[app] \""] },
      { file: "app.cpp", lines: app("Config config;  // n = logger.prefix.size()", "Cache cache;    // bytes = config.n * 1024") },
    ];
    return [...(loggerFirst ? files : [files[1]!, files[0]!]), { file: "link", lines: [`c++ ${loggerFirst ? "logger.o app.o" : "app.o logger.o"} -o prog`] }];
  }
  if (lang === "go") {
    return [
      { file: "app.go", lines: app("var config = Config{N: len(logger.Prefix)}", "var cache = make([]byte, config.N*1024)") },
      { file: "logger.go", lines: ["var logger = Logger{Prefix: \"[app] \"}"] },
    ];
  }
  if (lang === "rust") {
    return [{ file: "main.rs", lines: [
      "static LOGGER: LazyLock<Logger> = LazyLock::new(|| Logger::new(\"[app] \"));",
      "static CONFIG: LazyLock<Config> = LazyLock::new(|| Config { n: LOGGER.prefix.len() });",
      "static CACHE: LazyLock<Vec<u8>> = LazyLock::new(|| vec![0; CONFIG.n * 1024]);",
      "fn main() { println!(\"{}\", CACHE.len()); }",
    ] }];
  }
  return [{ file: "main.zig", lines: [
    "const prefix = \"[app] \";",
    "const config_n = prefix.len;",
    "var cache: [config_n * 1024]u8 = undefined;",
  ] }];
}

export function SysMemoryInitOrderDemo() {
  const [lang, setLang] = useState<InitLang>("cpp");
  const [loggerFirst, setLoggerFirst] = useState(true);
  const [configFirst, setConfigFirst] = useState(true);
  const ev = initOrder(lang, { linkLoggerFirst: loggerFirst, configBeforeCache: configFirst });
  const cache = finalValue(ev, "cache") ?? 0;
  const early = ev.filter((e) => e.early.length);
  const src = initSource(lang, loggerFirst, configFirst);
  return (
    <Demo title="Who runs first? Three globals that depend on each other" controls={<>
      <Param spec={initLangSpec} value={lang} onChange={(v) => setLang(v as InitLang)} />
      {lang === "cpp" && <Param spec={linkSpec} value={loggerFirst} onChange={(v) => setLoggerFirst(v as boolean)} />}
      {(lang === "cpp" || lang === "go") && <Param spec={declSpec} value={configFirst} onChange={(v) => setConfigFirst(v as boolean)} />}
    </>}>
      <div style={{ display: "grid", gap: 6 }}>
        {src.map((f) => (
          <div key={f.file}>
            <div className="muted" style={{ fontSize: 11.5, ...mono }}>{f.file}</div>
            <CodeLines lines={f.lines} />
          </div>
        ))}
      </div>
      <SectionLabel>What runs, in order</SectionLabel>
      <ol style={{ margin: 0, paddingLeft: 22, fontSize: 13, lineHeight: 1.6 }}>
        {ev.map((e, i) => (
          <li key={i} style={{ color: e.early.length ? "var(--c4)" : e.kind === "main" ? "var(--muted)" : "var(--fg)" }}>
            <span style={mono}>{e.kind === "compile" ? "compile time: " : e.kind === "use" ? "first use: " : ""}{e.text}</span>
          </li>
        ))}
      </ol>
      {lang === "rust" && <div className="muted" style={{ fontSize: 12, margin: "4px 0" }}>The list shows the order in which the closures finish. They start in the order CACHE, CONFIG, LOGGER, because each one dereferences the next (checked with rustc 1.96).</div>}
      <Banner tone={early.length ? "bad" : "good"}>
        {early.length
          ? `cache has ${int(cache)} bytes, not 6,144. ${early.length === 1 ? "One initializer" : "Two initializers"} read an object before its constructor ran. That read is undefined behavior; this toolchain happened to see zero bytes.`
          : lang === "cpp" ? "cache has 6,144 bytes, but only because of the file and declaration order. The C++ standard does not order initialization across files."
            : `cache has ${int(cache)} bytes in every order.`}
      </Banner>
    </Demo>
  );
}

