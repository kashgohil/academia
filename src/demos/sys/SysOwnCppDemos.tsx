/**
 * C++ demos for "RAII in C++" and "Move semantics": stack unwinding with manual cleanup or RAII on the memory machine,
 * the implicit special members (rule of zero, three and five), std::vector growth with and without a noexcept move
 * constructor, C++ move against Rust move in memory, and six ways to return an object. Counts come from cpp.ts,
 * which tests pin against real runs of clang++ 21 with libc++.
 */
import { useMemo, useState } from "react";
import { Banner, Bar, Btn, ButtonRow, Chip, Demo, MiniTable, Param, SectionLabel, Stats, StepButtons, StepSlider, mono, range, seg, select, toggle, useStepper } from "../../kit";
import {
  ELISION, MEMBERS, MEMBER_TEXT, MOVE_SOURCE, UNWIND_SOURCE, moveCompare, specialMembers, unwind, unwindMemory, vectorGrowth,
  type CleanupStyle, type Member, type MemberState, type MoveLang, type ThrowAt,
} from "../../sims/sys/ownership";
import { CodeView, MemStepper } from "./SysOwnUi";

// ---------------------------------------------------------------- unwinding

const styleSpec = seg<CleanupStyle>("Cleanup", [["manual", "Manual"], ["raii", "RAII"]], "manual");
const throwSpec = seg<ThrowAt>("Exception", [["none", "None"], ["new", "In new"], ["fill", "In fill"], ["write", "In write"]], "fill");
const RES_TEXT = { lock: "mutex mu", buffer: "4096-byte buffer", file: "open file" } as const;

export function UnwindDemo() {
  const [style, setStyle] = useState<CleanupStyle>("manual");
  const [at, setAt] = useState<ThrowAt>("fill");
  const steps = useMemo(() => unwindMemory(style, at), [style, at]);
  const run = useMemo(() => unwind(style, at), [style, at]);
  const s = useStepper(steps.length, 1.2);
  // steps: [before, call, ...events, exit]
  const done = run.events.slice(0, Math.max(0, s.i - 1));
  const held = new Set<string>();
  for (const e of done) {
    if (e.kind === "acquire") held.add(/lock/.test(e.text) ? "lock" : /4096|new/.test(e.text) ? "buffer" : "file");
    if (e.kind === "release") held.delete(/unlock/.test(e.text) ? "lock" : /buffer|delete/.test(e.text) ? "buffer" : "file");
  }
  const taken = new Set(done.filter((e) => e.kind === "acquire").map((e) => (/lock/.test(e.text) ? "lock" : /4096|new/.test(e.text) ? "buffer" : "file")));
  return (
    <Demo
      title="An exception leaves the function: what gets released?"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={styleSpec} value={style} onChange={(v) => { setStyle(v as CleanupStyle); s.reset(); }} />
        <Param spec={throwSpec} value={at} onChange={(v) => { setAt(v as ThrowAt); s.reset(); }} />
      </>}
    >
      <MemStepper steps={steps} source={UNWIND_SOURCE[style]} s={s} below={
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8, fontSize: 12.5 }}>
          <span className="muted">Resources:</span>
          {(["lock", "buffer", "file"] as const).map((r) => (
            <Chip key={r} color={held.has(r) ? "var(--c2)" : taken.has(r) ? "var(--c3)" : "var(--faint)"} filled={held.has(r)} faint={!taken.has(r)}>
              {RES_TEXT[r]}: {held.has(r) ? "held" : taken.has(r) ? "released" : "not taken"}
            </Chip>
          ))}
        </div>
      } />
      {s.atEnd && <Banner tone={run.held.length ? "bad" : "good"}>
        {run.held.length ? `After the catch, the program still holds: ${run.held.map((r) => RES_TEXT[r]).join(", ")}. None of the program's own variables refers to them any more.` : "Every resource that the function took was released, in the reverse order of acquisition."}
      </Banner>}
    </Demo>
  );
}

// ---------------------------------------------------------------- rule of zero, three and five

const STATE_TEXT: Record<MemberState, string> = { user: "you wrote it", defaulted: "implicit (defaulted)", deprecated: "implicit, deprecated", deleted: "deleted", none: "not declared" };
const STATE_COLOR: Record<MemberState, string> = { user: "var(--c1)", defaulted: "var(--c3)", deprecated: "var(--c2)", deleted: "var(--c4)", none: "var(--faint)" };
const PRESETS: [string, Member[]][] = [["Rule of zero", []], ["Rule of three", ["dtor", "copyCtor", "copyAssign"]], ["Rule of five", ["dtor", "copyCtor", "copyAssign", "moveCtor", "moveAssign"]], ["Destructor only", ["dtor"]], ["Move only", ["moveCtor", "moveAssign"]]];

export function RuleOfFiveDemo() {
  const [user, setUser] = useState<Set<Member>>(new Set(["dtor"]));
  const sm = specialMembers(user);
  const flip = (m: Member) => { const n = new Set(user); if (n.has(m)) n.delete(m); else n.add(m); setUser(n); };
  const verdict = (r: "move" | "copy" | "error") => (r === "move" ? "calls the move member" : r === "copy" ? "calls the COPY member: no move exists" : "does not compile");
  return (
    <Demo title="Declare some special members; see what the compiler gives you">
      <SectionLabel style={{ marginTop: 0 }}>Members you declare in class T (click to toggle)</SectionLabel>
      <ButtonRow>{MEMBERS.map((m) => <Btn key={m} on={user.has(m)} ghost={!user.has(m)} onClick={() => flip(m)}><span style={mono}>{MEMBER_TEXT[m]}</span></Btn>)}</ButtonRow>
      <ButtonRow style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Presets:</span>
        {PRESETS.map(([name, ms]) => <Btn key={name} ghost onClick={() => setUser(new Set(ms))}>{name}</Btn>)}
      </ButtonRow>
      <SectionLabel>What T has</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <MiniTable head={["member", "state"]} rows={MEMBERS.map((m) => [
          <span key="m" style={mono}>{MEMBER_TEXT[m]}</span>,
          <span key="s" style={{ color: STATE_COLOR[sm.state[m]], fontWeight: 600 }}>{STATE_TEXT[sm.state[m]]}</span>,
        ])} />
      </div>
      <SectionLabel>Two lines of code</SectionLabel>
      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
        <Banner tone={sm.constructFromRvalue === "move" ? "good" : sm.constructFromRvalue === "copy" ? "warn" : "bad"}><span style={mono}>T b = std::move(a);</span> {verdict(sm.constructFromRvalue)}.</Banner>
        <Banner tone={sm.assignFromRvalue === "move" ? "good" : sm.assignFromRvalue === "copy" ? "warn" : "bad"}><span style={mono}>b = std::move(a);</span> {verdict(sm.assignFromRvalue)}.</Banner>
      </div>
    </Demo>
  );
}

// ---------------------------------------------------------------- vector growth

const vecSchema = {
  n: range({ label: "push_back calls", min: 1, max: 100, step: 1, default: 17 }),
  nx: toggle({ label: "Move constructor is noexcept", default: true }),
  em: toggle({ label: "emplace_back instead", default: false }),
  rs: toggle({ label: "reserve(n) first", default: false }),
};

export function VectorGrowthDemo() {
  const [n, setN] = useState(17);
  const [nx, setNx] = useState(true);
  const [em, setEm] = useState(false);
  const [rs, setRs] = useState(false);
  const r = vectorGrowth(n, { noexceptMove: nx, emplace: em, reserve: rs });
  const maxRel = Math.max(1, ...r.growth.map((g) => g.size));
  return (
    <Demo
      title="std::vector growth: copies or moves?"
      controls={<>
        <Param spec={vecSchema.n} value={n} onChange={(v) => setN(v as number)} />
        <Param spec={vecSchema.nx} value={nx} onChange={(v) => setNx(v as boolean)} />
        <Param spec={vecSchema.em} value={em} onChange={(v) => setEm(v as boolean)} />
        <Param spec={vecSchema.rs} value={rs} onChange={(v) => setRs(v as boolean)} />
      </>}
    >
      <Stats items={[
        { label: "constructor calls", value: r.ctor },
        { label: "copy constructor calls", value: r.copy },
        { label: "move constructor calls", value: r.move },
        { label: "destructor calls (before ~vector)", value: r.dtor },
        { label: "reallocations", value: r.reallocations },
        { label: "final capacity", value: r.capacity },
      ]} />
      <SectionLabel>Each reallocation relocates every element (libc++ doubles the capacity)</SectionLabel>
      {r.growth.length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>No reallocation: the capacity was there from the start.</div> : (
        <div style={{ display: "grid", gap: 3, fontSize: 12, ...mono }}>
          {r.growth.map((g, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "92px minmax(0, 1fr) 72px", gap: 8, alignItems: "center" }}>
              <span className="muted">cap {g.size} → {g.cap}</span>
              <Bar frac={g.size / maxRel} color={nx ? "var(--c3)" : "var(--c4)"} />
              <span>{g.size} {nx ? "moved" : "copied"}</span>
            </div>
          ))}
        </div>
      )}
      <Banner tone={!nx && r.copy > 0 ? "bad" : "good"}>
        {rs ? "reserve(n) allocates once, so no element is ever relocated." : nx
          ? `The move constructor is noexcept, so std::move_if_noexcept moves. ${r.relocated} elements were relocated in total.`
          : `The move constructor can throw, so the vector copies each element to keep its strong exception guarantee: ${r.copy} copies.`}
      </Banner>
    </Demo>
  );
}

// ---------------------------------------------------------------- C++ move and Rust move

const langSpec = seg<MoveLang>("Language", [["cpp", "C++ std::move"], ["rust", "Rust move"]], "cpp");

export function MoveCompareDemo() {
  const [lang, setLang] = useState<MoveLang>("cpp");
  const steps = useMemo(() => moveCompare(lang), [lang]);
  const s = useStepper(steps.length, 1.2);
  const cur = steps[Math.min(s.i, steps.length - 1)]!;
  return (
    <Demo
      title="A move in C++ and in Rust, byte by byte"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={langSpec} value={lang} onChange={(v) => { setLang(v as MoveLang); s.reset(); }} />
      </>}
    >
      <MemStepper steps={steps} source={MOVE_SOURCE[lang]} s={s} movedLabel={lang === "cpp" ? "moved-from, still alive" : "moved: the compiler forgets"} />
      <Stats items={[
        { label: "writes to the source object", value: lang === "cpp" ? 1 : 0 },
        { label: "destructor or drop calls at scope end", value: lang === "cpp" ? 2 : 1 },
        { label: "heap frees", value: cur.snap.heap.filter((b) => b.state === "freed").length },
      ]} />
    </Demo>
  );
}

// ---------------------------------------------------------------- return value optimization

const caseSpec = select({ label: "Return form", options: ELISION.map((e) => ({ value: e.id, label: e.label })), default: "named" });

export function ReturnElisionDemo() {
  const [id, setId] = useState("named");
  const c = ELISION.find((e) => e.id === id)!;
  const row = (name: string, v: [number, number, number, number]) => [name, ...v.map(String)];
  return (
    <Demo title="Return an object: how many constructors run?" controls={<Param spec={caseSpec} value={id} onChange={(v) => setId(v as string)} />}>
      <CodeView lines={[...c.code, "", "T r = make(...);   // in the caller"]} />
      <SectionLabel>Calls for T r = make(...), clang++ -std=c++20</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <MiniTable head={["build", "ctor", "copy", "move", "dtor"]} rows={[row("-O0 or -O2", c.clang), row("-fno-elide-constructors", c.noElide)]} />
      </div>
      <Banner tone={c.clang[1] ? "bad" : c.clang[2] ? "warn" : "good"}>{c.why}</Banner>
    </Demo>
  );
}
