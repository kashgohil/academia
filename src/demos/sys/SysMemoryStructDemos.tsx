/**
 * Demos for "Struct layout, alignment and padding" (Systems / memory):
 * - SysMemoryReorderDemo: be the compiler's layout pass: reorder fields, switch target and rules, watch the padding.
 * - SysMemoryPackedDemo: a packed array; read a field through the struct, through a pointer, or with memcpy.
 */
import { useState } from "react";
import { Banner, Btn, ButtonRow, Demo, Note, Param, SectionLabel, Stats, mono, range, select } from "../../kit";
import { hex, layoutC, layoutRust, optimalOrder, struct, T, TARGETS, TARGET_IDS, wasted, type TargetId, type Type } from "../../sims/sys/mem";
import { GALLERY, packedAccess, type PackedWay } from "../../sims/sys/memory";
import { fieldColor, StructBytes, UbBanner } from "./SysViews";
import { CodeLines, CompilerBox } from "./SysMemoryUi";

// ---------------------------------------------------------------- reorder fields

const presetSpec = select({ label: "Struct", options: GALLERY.map((g) => ({ value: g.id, label: g.label })), default: "worst" });
const targetSpec = select({ label: "Target", options: TARGET_IDS.map((t) => ({ value: t, label: TARGETS[t].name })), default: "x86_64-linux" });
const rulesSpec = select({ label: "Rules", options: [{ value: "c", label: "C / repr(C)" }, { value: "rust", label: "repr(Rust) model" }], default: "c", segmented: true });

type StructType = Extract<Type, { k: "struct" }>;

export function SysMemoryReorderDemo() {
  const [id, setId] = useState("worst");
  const [target, setTarget] = useState<TargetId>("x86_64-linux");
  const [rules, setRules] = useState("c");
  const [orders, setOrders] = useState<Record<string, number[]>>({});
  const g = GALLERY.find((x) => x.id === id)!;
  const base = g.type(target) as StructType;
  const order = orders[id] ?? base.fields.map((_, i) => i);
  const st: StructType = { ...base, fields: order.map((i) => base.fields[i]!) };
  const lay = rules === "rust" ? layoutRust({ ...st, repr: "Rust" }, target) : layoutC(st, target);
  const best = layoutC({ ...st, fields: optimalOrder(st.fields, target) }, target);
  const move = (k: number, d: number) => {
    const o = [...order];
    const j = k + d;
    if (j < 0 || j >= o.length) return;
    [o[k], o[j]] = [o[j]!, o[k]!];
    setOrders({ ...orders, [id]: o });
  };
  const sortBest = () => {
    const sorted = optimalOrder(st.fields, target);
    setOrders({ ...orders, [id]: sorted.map((f) => base.fields.indexOf(f)) });
  };
  const data = lay.size - wasted(lay);
  return (
    <Demo
      title="Be the layout pass: order the fields"
      actions={<ButtonRow><Btn onClick={sortBest}>Sort by alignment</Btn><Btn ghost onClick={() => setOrders({ ...orders, [id]: base.fields.map((_, i) => i) })}>Reset</Btn></ButtonRow>}
      controls={<>
        <Param spec={presetSpec} value={id} onChange={(v) => setId(v as string)} />
        <Param spec={targetSpec} value={target} onChange={(v) => setTarget(v as TargetId)} />
        <Param spec={rulesSpec} value={rules} onChange={(v) => setRules(v as string)} />
      </>}
    >
      <SectionLabel style={{ marginTop: 0 }}>Declaration order (use the arrows)</SectionLabel>
      <div style={{ display: "grid", gap: 3 }}>
        {st.fields.map((f, k) => {
          const fl = lay.fields.find((x) => x.name === f.name)!;
          return (
            <div key={f.name} style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", gap: 8, alignItems: "center", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 6px", boxShadow: `inset 3px 0 0 ${fieldColor(fl.decl)}` }}>
              <span style={{ display: "flex", gap: 2 }}>
                <button className="btn" style={{ padding: "0 7px" }} disabled={k === 0} onClick={() => move(k, -1)} aria-label={`Move ${f.name} up`}>↑</button>
                <button className="btn" style={{ padding: "0 7px" }} disabled={k === st.fields.length - 1} onClick={() => move(k, 1)} aria-label={`Move ${f.name} down`}>↓</button>
              </span>
              <span style={{ ...mono, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{fl.typeName} {f.name}</span>
              <span className="muted" style={{ ...mono, fontSize: 11.5 }}>size {fl.size}, align {fl.align}</span>
            </div>
          );
        })}
      </div>
      <SectionLabel>Bytes in memory ({rules === "rust" ? "rustc may reorder: memory order differs from declaration order" : "declaration order"})</SectionLabel>
      <StructBytes layout={lay} />
      <Stats items={[
        { label: "size", value: `${lay.size} B` },
        { label: "data bytes", value: `${data} B` },
        { label: "padding", value: `${wasted(lay)} B` },
        { label: "best C order", value: `${best.size} B` },
      ]} />
      <Note>{g.note} Checked with zig cc (and rustc for the Rust sizes); the repr(Rust) offsets are a model of rustc 1.96, not a guarantee.</Note>
    </Demo>
  );
}

// ---------------------------------------------------------------- packed access

const wayLabel: Record<PackedWay, string> = { field: "h[i].len", pointer: "*(&h[i].len)", memcpy: "memcpy" };
const waySpec = select({ label: "Read h[i].len", options: (["field", "pointer", "memcpy"] as PackedWay[]).map((w) => ({ value: w, label: wayLabel[w] })), default: "pointer", segmented: true });
const langSpec = select({ label: "Language", options: [{ value: "c", label: "C" }, { value: "rust", label: "Rust" }], default: "c", segmented: true });
const iSpec = range({ label: "Index i", min: 0, max: 7, step: 1, default: 0 });

const C_CODE: Record<PackedWay, string[]> = {
  field: ["struct __attribute__((packed)) Header { uint8_t tag; uint32_t len; };", "struct Header h[8];", "uint32_t n = h[i].len;  // the compiler knows: unaligned-safe load"],
  pointer: ["struct __attribute__((packed)) Header { uint8_t tag; uint32_t len; };", "struct Header h[8];", "uint32_t *p = &h[i].len; // warning: -Waddress-of-packed-member", "uint32_t n = *p;         // assumes 4-byte alignment"],
  memcpy: ["struct __attribute__((packed)) Header { uint8_t tag; uint32_t len; };", "struct Header h[8];", "uint32_t n;", "memcpy(&n, &h[i].len, sizeof n);  // bytes: always fine"],
};
const RS_CODE: Record<PackedWay, string[]> = {
  field: ["#[repr(C, packed)]", "struct Header { tag: u8, len: u32 }", "let n = h[i].len; // a copy: fine"],
  pointer: ["#[repr(C, packed)]", "struct Header { tag: u8, len: u32 }", "let r = &h[i].len; // a reference must be aligned"],
  memcpy: ["#[repr(C, packed)]", "struct Header { tag: u8, len: u32 }", "let n = unsafe { std::ptr::read_unaligned(&raw const h[i].len) };"],
};
/** h[0..8] drawn as one packed struct with fields tag0, len0, tag1, ... so that tag and len get their own colors. */
const FLAT = layoutC(struct("h", Array.from({ length: 8 }, (_, k) => [[`tag${k}`, T.u8], [`len${k}`, T.u32]] as [string, Type][]).flat(), { packed: true }));
const E0793 = ["error[E0793]: reference to field of packed struct is unaligned", "  = note: this struct is 1-byte aligned, but the type of this field may require higher alignment", "  = note: creating a misaligned reference is undefined behavior (even if that reference is never dereferenced)"];

export function SysMemoryPackedDemo() {
  const [i, setI] = useState(0);
  const [way, setWay] = useState<PackedWay>("pointer");
  const [lang, setLang] = useState("c");
  const r = packedAccess(i, way);
  const lay = FLAT;
  const rustRefused = lang === "rust" && way === "pointer";
  return (
    <Demo title="A packed array: three ways to read one field" controls={<>
      <Param spec={iSpec} value={i} onChange={(v) => setI(v as number)} />
      <Param spec={waySpec} value={way} onChange={(v) => setWay(v as PackedWay)} />
      <Param spec={langSpec} value={lang} onChange={(v) => setLang(v as string)} />
    </>}>
      <CodeLines lines={lang === "c" ? C_CODE[way] : RS_CODE[way]} />
      <SectionLabel>h: 8 headers of 5 bytes, no padding (h starts at a 16-byte boundary)</SectionLabel>
      <StructBytes layout={lay} highlight={`len${i}`} table={false} bytesPerRow={20} caption={<>sizeof(struct Header) = 5, align 1. h[{i}].len is at byte {5 * i + 1}: address {hex(r.addr)}, {r.addr % 4 === 0 ? "a multiple of 4" : `${r.addr % 4} past a multiple of 4`}.</>} />
      {rustRefused ? (
        <CompilerBox tool="rustc 1.96" tone="error" lines={E0793} />
      ) : r.ub ? (
        <UbBanner event={r.ub} />
      ) : (
        <Banner tone="good">{way === "pointer" ? `This one is aligned (byte ${5 * i + 1} is a multiple of 4 from an aligned start), so the 4-byte load is fine. Change i.` : way === "field" ? "The compiler knows that the field is unaligned. It emits an unaligned-safe load, or byte loads and shifts on a strict target." : "memcpy has no alignment rule. Compilers turn a 4-byte memcpy into one load where the target allows it."}</Banner>
      )}
      <Note>{lang === "c" ? "Only i = 3 and i = 7 put len on a 4-byte boundary. On x86-64 the misaligned load works at run time, but it is still UB in C, and the optimizer may use the alignment it assumes." : "Rust refuses the misaligned reference at compile time. Copies and raw-pointer reads with read_unaligned are the safe ways to get the value."}</Note>
    </Demo>
  );
}
