/**
 * SysMemPlayground: a reference demo for the shared memory toolkit. A short C program runs line by line on the
 * abstract machine of src/sims/sys/mem; the demo shows the source, the stack, the heap, the bytes of a struct and the
 * UB reports. Each preset is a script: for each step it names a source line and says what that line does to memory.
 */
import { useMemo, useState } from "react";
import { Banner, ButtonRow, Demo, MONO, Param, SectionLabel, StepButtons, StepCaption, StepSlider, select, tint, useStepper } from "../../kit";
import { array, layoutC, Machine, offset, ptr, struct, T, type Ptr, type Snapshot, type UbReport } from "../../sims/sys/mem";
import { HeapBlocks, StackView, StructBytes, UbBanner } from "./SysViews";

interface Step {
  line: number;
  caption: string;
  snap: Snapshot;
  /** UB reports made by this step. */
  ub: UbReport[];
  /** The bytes of the locals named in `bytesOf`, if they exist now. */
  bytes: { name: string; addr: number; layout: ReturnType<typeof layoutC>; peek: { bytes: number[]; init: boolean[] } }[];
}

type Do = (line: number, caption: string, run?: () => void) => void;

interface Preset {
  id: string;
  label: string;
  source: string[];
  bytesOf?: string[];
  script: (m: Machine, step: Do) => void;
}

const intp = ptr(T.int);
const charp = ptr(T.char);

const PRESETS: Preset[] = [
  {
    id: "local",
    label: "Return a pointer to a local",
    source: [
      "int *make(void) {",
      "    int x = 42;",
      "    return &x;     // address of a local",
      "}",
      "int other(void) {",
      "    int z = 7;",
      "    return z;",
      "}",
      "int main(void) {",
      "    int *p = make();",
      "    int y = *p;    // make's frame is gone",
      "    other();",
      "    y = *p;        // now other's bytes",
      "    return 0;",
      "}",
    ],
    script: (m, step) => {
      let px: Ptr = { addr: 0 };
      step(9, "main starts. Its frame holds p and y; both are uninitialized.", () => m.call("main", [{ name: "p", type: intp }, { name: "y", type: T.int }]));
      step(1, "make gets a frame below main's: a return address, the saved rbp, and x.", () => m.call("make", [{ name: "x", type: T.int }]));
      step(2, "x = 42 writes 4 bytes in make's frame.", () => m.set("x", 42));
      step(3, "make returns. Its frame is free stack now, but its bytes stay. p gets the address of x: a dangling pointer.", () => { px = m.addrOf("x"); m.ret(); m.set("p", px); });
      step(11, "*p reads a dead object. The sanitizer reports it; the hardware just reads the old 42.", () => m.set("y", m.load(m.get("p") as Ptr, T.int)));
      step(5, "other gets a frame at the same addresses as make had.", () => m.call("other", [{ name: "z", type: T.int }]));
      step(6, "z = 7 overwrites the bytes where x was.", () => m.set("z", 7));
      step(7, "other returns.", () => m.ret());
      step(13, "*p reads again: the same address now gives 7. The value of a dangling pointer depends on later calls.", () => m.set("y", m.load(m.get("p") as Ptr, T.int)));
      step(14, "main returns and the program exits.", () => m.exit(0));
    },
  },
  {
    id: "uaf",
    label: "Use after free",
    source: [
      "int main(void) {",
      "    int *a = malloc(4 * sizeof(int));",
      "    a[0] = 1;",
      "    free(a);",
      "    int *b = malloc(16); // same block",
      "    b[0] = 99;",
      "    int v = a[0];  // reads b's data",
      "    free(b);",
      "    return 0;",
      "}",
    ],
    script: (m, step) => {
      step(1, "main starts with three uninitialized locals.", () => m.call("main", [{ name: "a", type: intp }, { name: "b", type: intp }, { name: "v", type: T.int }]));
      step(2, "malloc finds room at the heap start: a 16-byte header, then 16 bytes for a.", () => m.set("a", m.malloc(16)));
      step(3, "a[0] = 1.", () => m.store(m.get("a") as Ptr, T.int, 1));
      step(4, "free gives the block back. a still holds its address: a dangling pointer.", () => m.free(m.get("a") as Ptr));
      step(5, "First fit: the free block is the first one that fits, so b gets the same address.", () => m.set("b", m.malloc(16)));
      step(6, "b[0] = 99 writes the shared bytes.", () => m.store(m.get("b") as Ptr, T.int, 99));
      step(7, "a[0] reads a freed object. Without a sanitizer it returns 99, the data of b.", () => m.set("v", m.load(m.get("a") as Ptr, T.int)));
      step(8, "free(b).", () => m.free(m.get("b") as Ptr));
      step(9, "The program exits with no leaks.", () => m.exit(0));
    },
  },
  {
    id: "obo",
    label: "Off-by-one loop",
    source: [
      "int main(void) {",
      "    int arr[4];",
      "    int sum = 0;",
      "    for (int i = 0; i <= 4; i++)  // bug",
      "        arr[i] = i;",
      "    return sum;    // 4, not 0",
      "}",
    ],
    script: (m, step) => {
      step(1, "main's frame: arr (16 bytes), then sum and i above it.", () => m.call("main", [{ name: "arr", type: array(T.int, 4) }, { name: "sum", type: T.int }, { name: "i", type: T.int }]));
      step(3, "sum = 0.", () => m.set("sum", 0));
      for (let i = 0; i <= 4; i++) {
        step(4, i === 0 ? "i = 0." : `i = ${i}. The test i <= 4 is true.`, () => m.set("i", i));
        step(5, i < 4 ? `arr[${i}] = ${i}.` : "arr[4] is one past the end. The store lands on sum, the next local.", () => m.store(offset(m.addrOf("arr"), 4 * i), T.int, i));
      }
      step(6, "main returns sum, and sum is 4.", () => { m.note(`return ${m.get("sum")}`); m.exit(0); });
    },
  },
  {
    id: "pad",
    label: "Struct padding",
    bytesOf: ["a", "b"],
    source: [
      "struct S { char c; int i; short s; };",
      "int main(void) {",
      "    struct S a;",
      "    a.c = 'A';",
      "    a.i = 7;",
      "    a.s = 3;",
      "    struct S b;",
      "    memcpy(&b, &a, sizeof a);",
      "    char x = ((char *)&a)[1]; // padding",
      "    return 0;",
      "}",
    ],
    script: (m, step) => {
      const S = struct("S", [["c", T.char], ["i", T.int], ["s", T.short]]);
      step(2, "a and b are locals of 12 bytes each. No byte has a value yet.", () => m.call("main", [{ name: "a", type: S }, { name: "b", type: S }, { name: "x", type: T.char }]));
      step(4, "a.c = 'A' writes 1 byte at offset 0.", () => m.store(m.field(m.addrOf("a"), S, "c"), T.char, 65));
      step(5, "a.i = 7 writes offsets 4 to 7. Bytes 1 to 3 are padding: nothing writes them.", () => m.store(m.field(m.addrOf("a"), S, "i"), T.int, 7));
      step(6, "a.s = 3 writes offsets 8 and 9. Bytes 10 and 11 are tail padding.", () => m.store(m.field(m.addrOf("a"), S, "s"), T.short, 3));
      step(8, "memcpy copies all 12 bytes, and the padding stays uninitialized in b.", () => m.memcpy(m.addrOf("b"), m.addrOf("a"), 12));
      step(9, "Reading a padding byte as a value reads uninitialized memory.", () => m.set("x", m.load(offset(m.addrOf("a"), 1), T.char)));
      step(10, "main returns.", () => m.exit(0));
    },
  },
  {
    id: "leak",
    label: "Memory leak",
    source: [
      "char *dup(const char *s) {",
      "    char *d = malloc(strlen(s) + 1);",
      "    strcpy(d, s);",
      "    return d;",
      "}",
      "int main(void) {",
      "    char *a = dup(\"hi\");",
      "    a = dup(\"there\"); // first copy lost",
      "    free(a);",
      "    return 0;      // leak check runs",
      "}",
    ],
    script: (m, step) => {
      step(6, "main starts.", () => m.call("main", [{ name: "a", type: charp }]));
      const dup = (text: string) => {
        step(1, `dup gets s, a pointer to the literal "${text}" in .rodata.`, () => m.call("dup", [{ name: "s", type: charp, value: m.literal(text) }, { name: "d", type: charp }]));
        step(2, `malloc(${text.length + 1}) for the copy and its zero byte.`, () => m.set("d", m.malloc(text.length + 1)));
        step(3, "strcpy copies the bytes.", () => m.store(m.get("d") as Ptr, array(T.char, text.length + 1), [...text].map((c) => c.charCodeAt(0)).concat(0)));
        step(text === "hi" ? 7 : 8, text === "hi" ? "dup returns d, and a holds the block." : "a now holds the new block. No pointer to the first block is left.", () => { const d = m.get("d"); m.ret(); m.set("a", d); });
      };
      dup("hi");
      dup("there");
      step(9, "free(a) frees the second block only.", () => m.free(m.get("a") as Ptr));
      step(10, "At exit, LeakSanitizer looks for blocks that no global reaches.", () => m.exit(0));
    },
  },
];

function record(p: Preset): Step[] {
  const m = new Machine();
  const steps: Step[] = [{ line: 0, caption: "Before the program starts. Press Step.", snap: m.snapshot(), ub: [], bytes: [] }];
  const step: Do = (line, caption, run) => {
    const before = m.ub.length;
    m.line = line;
    run?.();
    const snap = m.snapshot();
    const live = snap.frames.filter((f) => f.live);
    const bytes = (p.bytesOf ?? []).flatMap((name) => {
      const s = live.flatMap((f) => f.slots).find((x) => x.kind === "local" && x.name === name);
      if (!s?.type) return [];
      const layout = layoutC(s.type);
      return [{ name, addr: s.addr, layout, peek: m.peek(s.addr, layout.size) }];
    });
    steps.push({ line, caption, snap, ub: m.ub.slice(before), bytes });
  };
  p.script(m, step);
  return steps;
}

const presetSpec = select({ label: "Program", options: PRESETS.map((p) => ({ value: p.id, label: p.label })), default: "local" });

function Source({ lines, current, bad }: { lines: string[]; current: number; bad: Set<number> }) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6, fontFamily: MONO, fontSize: 12, lineHeight: 1.55, padding: "4px 0" }}>
      <div style={{ minWidth: "max-content" }}>
        {lines.map((l, i) => {
          const n = i + 1;
          const on = n === current;
          return (
            <div key={i} style={{ display: "flex", gap: 10, padding: "0 10px 0 6px", background: on ? tint("var(--c1)", 20) : undefined, boxShadow: on ? "inset 3px 0 0 var(--c1)" : undefined }}>
              <span style={{ width: 18, textAlign: "right", color: bad.has(n) ? "var(--c4)" : "var(--faint)", fontWeight: bad.has(n) ? 700 : 400 }}>{n}</span>
              <span style={{ whiteSpace: "pre" }}>{l}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** `preset` picks the first program: local, uaf, obo, pad or leak. */
export function SysMemPlayground({ preset: first = "local" }: { preset?: string }) {
  const [id, setId] = useState(first);
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
  const steps = useMemo(() => record(preset), [preset]);
  const s = useStepper(steps.length, 1.5);
  const cur = steps[s.i]!;
  const bad = new Set(steps.slice(1, s.i + 1).filter((x) => x.ub.length).map((x) => x.line));
  const hasHeap = steps.some((x) => x.snap.heap.length > 0);
  const ubSoFar = cur.snap.ub.length;
  return (
    <Demo
      title="Run a C program on the memory model"
      actions={<ButtonRow><StepButtons s={s} /></ButtonRow>}
      controls={<>
        <StepSlider s={s} />
        <Param spec={presetSpec} value={id} onChange={(v) => { setId(v as string); s.reset(); }} />
      </>}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Source (current line highlighted, UB lines in red)</SectionLabel>
          <Source lines={preset.source} current={cur.line} bad={bad} />
        </div>
        <div style={{ minWidth: 0 }}>
          <SectionLabel style={{ marginTop: 0 }}>Stack, high addresses on top</SectionLabel>
          <StackView frames={cur.snap.frames} empty="No frames yet: main has not started." />
        </div>
      </div>
      {cur.bytes.map((b) => (
        <div key={b.name} style={{ marginTop: 10 }}>
          <SectionLabel>Bytes of {b.name} (?? = never written)</SectionLabel>
          <StructBytes layout={b.layout} bytes={b.peek} table={false} />
        </div>
      ))}
      {hasHeap && (
        <div style={{ marginTop: 4 }}>
          <SectionLabel>Heap blocks and the pointers to them</SectionLabel>
          <HeapBlocks blocks={cur.snap.heap} edges={cur.snap.edges} empty="No heap blocks yet." />
        </div>
      )}
      <StepCaption label={cur.line ? `line ${cur.line}` : "start"} tone={cur.ub.length ? "bad" : null}>{cur.caption}</StepCaption>
      {cur.ub.map((r, i) => <UbBanner key={i} event={r} />)}
      {!cur.ub.length && s.atEnd && <Banner tone={ubSoFar ? "warn" : "good"}>{ubSoFar ? `The run made ${ubSoFar} UB report${ubSoFar > 1 ? "s" : ""}. Step back to see each one.` : "No UB in this run."}</Banner>}
    </Demo>
  );
}
